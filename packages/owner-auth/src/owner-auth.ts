import {
  constantTimeTextEqual,
  deriveCsrfToken,
  randomToken,
  sha256Digest,
  versionedRecoveryDigest,
} from "./crypto.ts";
import { OwnerAuthError } from "./error.ts";
import type {
  LocalClaimChannel,
  OwnerAuthClock,
  OwnerAuthAuditEventName,
  OwnerAuthAuditRecord,
  OwnerAuthRepository,
  PasswordHasher,
  PersistedOwnerCredential,
  PersistedRecoveryCode,
  PersistedSession,
  SecureRandomSource,
} from "./contracts.ts";

const CLAIM_TTL_MS = 10 * 60_000;
const RECOVERY_CODE_COUNT = 10;
const SESSION_IDLE_TTL_MS = 24 * 60 * 60_000;
const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_ATTEMPT_LIMIT = 5;
const LAST_USE_UPDATE_INTERVAL_MS = 5 * 60_000;
const FRESH_AUTH_TTL_MS = 5 * 60_000;
const RECOVERY_STATE_TTL_MS = 10 * 60_000;
const MAX_CONCURRENT_PASSPHRASE_HASHES = 2;

export interface OwnerAuthOptions {
  readonly allowedOrigins: readonly string[];
  readonly clock: OwnerAuthClock;
  readonly passwordHasher: PasswordHasher;
  readonly random: SecureRandomSource;
  readonly repository: OwnerAuthRepository;
}

export interface IssuedInitialClaim {
  readonly claimToken: string;
  readonly expiresAt: number;
}

export interface ClaimedOwner {
  readonly ownerId: string;
  readonly recoveryCodes: readonly string[];
}

export interface BrowserSession {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly authenticatedAt: number;
  readonly lastUsedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface OwnerLogin {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly session: BrowserSession;
}

export interface UnsafeOwnerRequest {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly origin: string;
  readonly contentType: string;
  readonly secFetchSite?: string;
}

export interface BrowserSessionSummary extends BrowserSession {
  readonly current: boolean;
  readonly expired: boolean;
  readonly revokedAt?: number;
}

export interface RecoveryChallenge {
  readonly recoveryToken: string;
  readonly expiresAt: number;
}

export interface CompletedRecovery {
  readonly ownerId: string;
  readonly recoveryCodes: readonly string[];
}

export class OwnerAuth {
  private readonly clock: OwnerAuthClock;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly passwordHasher: PasswordHasher;
  private readonly random: SecureRandomSource;
  private readonly repository: OwnerAuthRepository;
  private readonly passphraseHashGate = new AsyncPermitGate(MAX_CONCURRENT_PASSPHRASE_HASHES);

  public constructor(options: OwnerAuthOptions) {
    this.allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
    this.clock = options.clock;
    this.passwordHasher = options.passwordHasher;
    this.random = options.random;
    this.repository = options.repository;
  }

  public async issueInitialClaim(input: {
    readonly channel: LocalClaimChannel;
  }): Promise<IssuedInitialClaim> {
    return this.createInitialClaim(input.channel, false);
  }

  /**
   * Replaces an unconsumed claim after the caller has proved exclusive ownership
   * of the local bootstrap runtime. This is only for pre-owner crash recovery:
   * it never resets an existing owner.
   */
  public async replaceInitialClaim(input: {
    readonly channel: LocalClaimChannel;
  }): Promise<IssuedInitialClaim> {
    return this.createInitialClaim(input.channel, true);
  }

  private async createInitialClaim(
    channel: LocalClaimChannel,
    replaceExisting: boolean,
  ): Promise<IssuedInitialClaim> {
    assertLocalClaimChannel(channel);
    const claimToken = randomToken(this.random, 32);

    const claim = await this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      if ((await transaction.getOwner()) !== null) {
        throw claimInvalid();
      }
      const current = await transaction.getInitialClaim();
      const currentIsActive = current !== null && current.expiresAt > acceptedAt;
      if (currentIsActive && !replaceExisting) {
        throw new OwnerAuthError(
          "CLAIM_ALREADY_ACTIVE",
          "An unexpired local owner claim is already active.",
        );
      }
      if (replaceExisting && current === null) {
        throw claimInvalid();
      }
      const nextClaim = {
        tokenDigest: sha256Digest(claimToken),
        createdAt: acceptedAt,
        expiresAt: acceptedAt + CLAIM_TTL_MS,
      };
      await transaction.setInitialClaim(nextClaim);
      await transaction.appendAuditRecord(
        this.auditRecord(
          replaceExisting ? "owner.auth.claim-replaced" : "owner.auth.claim-issued",
          acceptedAt,
        ),
      );
      return nextClaim;
    });

    return Object.freeze({
      claimToken,
      expiresAt: claim.expiresAt,
    });
  }

  public async claimOwner(input: {
    readonly channel: LocalClaimChannel;
    readonly claimToken: string;
    readonly passphrase: string;
  }): Promise<ClaimedOwner> {
    assertLocalClaimChannel(input.channel);
    assertPassphrase(input.passphrase);
    const passwordPhc = await this.hashPassphrase(input.passphrase);
    const ownerId = `owner_${randomToken(this.random, 16)}`;
    const recoveryCodes = Object.freeze(
      Array.from({ length: RECOVERY_CODE_COUNT }, () => `odr_${randomToken(this.random, 16)}`),
    );
    const claimDigest = sha256Digest(input.claimToken);

    await this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      const [owner, claim] = await Promise.all([
        transaction.getOwner(),
        transaction.getInitialClaim(),
      ]);
      if (
        owner !== null ||
        claim === null ||
        claim.createdAt > acceptedAt ||
        claim.expiresAt <= acceptedAt ||
        claim.tokenDigest !== claimDigest
      ) {
        throw claimInvalid();
      }

      const recoveryRecords: readonly PersistedRecoveryCode[] = recoveryCodes.map(
        (recoveryCode, index) => ({
          codeId: `recovery_${index + 1}_${randomToken(this.random, 8)}`,
          digest: versionedRecoveryDigest(recoveryCode),
          credentialVersion: 1,
          createdAt: acceptedAt,
        }),
      );
      await transaction.setOwner({
        ownerId,
        passwordPhc,
        credentialVersion: 1,
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      });
      await transaction.setRecoveryCodes(recoveryRecords);
      await transaction.setInitialClaim(null);
      await transaction.appendAuditRecord(
        this.auditRecord("owner.auth.claimed", acceptedAt, { ownerId }),
      );
    });

    return Object.freeze({
      ownerId,
      recoveryCodes,
    });
  }

  public async login(input: {
    readonly passphrase: string;
    readonly sourceKey: string;
  }): Promise<OwnerLogin> {
    assertPassphrase(input.passphrase);
    assertSourceKey(input.sourceKey);
    const rateLimitKeys = rateLimitKeysFor(input.sourceKey);
    const owner = await this.reserveLoginAttempt(rateLimitKeys);

    if (owner === null) {
      await this.hashPassphrase(input.passphrase);
      throw authenticationFailed();
    }

    const valid = await this.verifyPassphrase(owner.passwordPhc, input.passphrase);
    if (!valid) {
      throw authenticationFailed();
    }

    let replacementPhc: string | undefined;
    try {
      if (this.passwordHasher.needsRehash(owner.passwordPhc)) {
        replacementPhc = await this.hashPassphrase(input.passphrase);
      }
    } catch (error) {
      if (error instanceof OwnerAuthError) {
        throw error;
      }
      throw authenticationUnavailable();
    }

    const sessionToken = randomToken(this.random, 32);
    const sessionId = `session_${randomToken(this.random, 16)}`;

    const session = await this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      const currentOwner = await transaction.getOwner();
      if (
        currentOwner === null ||
        currentOwner.ownerId !== owner.ownerId ||
        currentOwner.credentialVersion !== owner.credentialVersion ||
        currentOwner.passwordPhc !== owner.passwordPhc
      ) {
        throw authenticationFailed();
      }

      if (replacementPhc !== undefined) {
        await transaction.setOwner({
          ...currentOwner,
          passwordPhc: replacementPhc,
          updatedAt: acceptedAt,
        });
      }
      const newSession: PersistedSession = {
        sessionId,
        tokenDigest: sha256Digest(sessionToken),
        ownerId: owner.ownerId,
        credentialVersion: owner.credentialVersion,
        createdAt: acceptedAt,
        authenticatedAt: acceptedAt,
        lastUsedAt: acceptedAt,
        idleExpiresAt: acceptedAt + SESSION_IDLE_TTL_MS,
        absoluteExpiresAt: acceptedAt + SESSION_ABSOLUTE_TTL_MS,
      };
      await transaction.saveSession(newSession);
      await transaction.appendAuditRecord(
        this.auditRecord("owner.auth.login-succeeded", acceptedAt, {
          ownerId: owner.ownerId,
          sessionId: newSession.sessionId,
        }),
      );
      for (const key of rateLimitKeys) {
        await transaction.deleteLoginAttempts(key);
      }
      return newSession;
    });

    return freezeLogin(sessionToken, session);
  }

  public async validateSession(sessionToken: string): Promise<BrowserSession> {
    const session = await this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      const [owner, current] = await Promise.all([
        transaction.getOwner(),
        transaction.findSessionByTokenDigest(sha256Digest(sessionToken)),
      ]);
      if (!isActiveSession(current, owner, acceptedAt)) {
        throw sessionInvalid();
      }

      if (acceptedAt - current.lastUsedAt < LAST_USE_UPDATE_INTERVAL_MS) {
        return current;
      }

      const updated = {
        ...current,
        lastUsedAt: acceptedAt,
        idleExpiresAt: Math.min(acceptedAt + SESSION_IDLE_TTL_MS, current.absoluteExpiresAt),
      };
      await transaction.saveSession(updated);
      return updated;
    });

    return publicSession(session);
  }

  public async issueCsrfToken(sessionToken: string): Promise<string> {
    await this.validateSession(sessionToken);
    return deriveCsrfToken(sessionToken);
  }

  public async validateUnsafeRequest(input: UnsafeOwnerRequest): Promise<BrowserSession> {
    const session = await this.validateSession(input.sessionToken);
    const expectedCsrf = deriveCsrfToken(input.sessionToken);
    if (
      !this.isAllowedOrigin(input.origin) ||
      !isJsonContentType(input.contentType) ||
      input.secFetchSite?.trim().toLowerCase() === "cross-site" ||
      !constantTimeTextEqual(expectedCsrf, input.csrfToken)
    ) {
      throw new OwnerAuthError(
        "CSRF_INVALID",
        "The unsafe Admin request did not satisfy same-origin CSRF requirements.",
      );
    }
    return session;
  }

  private isAllowedOrigin(origin: string): boolean {
    try {
      return this.allowedOrigins.has(normalizeOrigin(origin, false));
    } catch {
      return false;
    }
  }

  public async requireFreshAuthentication(sessionToken: string): Promise<BrowserSession> {
    const session = await this.validateSession(sessionToken);
    if (this.now() - session.authenticatedAt > FRESH_AUTH_TTL_MS) {
      throw new OwnerAuthError(
        "AUTHENTICATION_STALE",
        "Fresh owner authentication is required for this change.",
      );
    }
    return session;
  }

  public async reauthenticate(input: {
    readonly sessionToken: string;
    readonly passphrase: string;
    readonly sourceKey: string;
  }): Promise<OwnerLogin> {
    assertPassphrase(input.passphrase);
    assertSourceKey(input.sourceKey);
    await this.validateSession(input.sessionToken);
    const rateLimitKeys = rateLimitKeysFor(input.sourceKey);
    const owner = await this.reserveLoginAttempt(rateLimitKeys);
    if (owner === null || !(await this.verifyPassphrase(owner.passwordPhc, input.passphrase))) {
      throw authenticationFailed();
    }

    let replacementPhc: string | undefined;
    try {
      if (this.passwordHasher.needsRehash(owner.passwordPhc)) {
        replacementPhc = await this.hashPassphrase(input.passphrase);
      }
    } catch (error) {
      if (error instanceof OwnerAuthError) {
        throw error;
      }
      throw authenticationUnavailable();
    }

    const oldDigest = sha256Digest(input.sessionToken);
    const newSessionToken = randomToken(this.random, 32);
    const newSessionId = `session_${randomToken(this.random, 16)}`;

    const newSession = await this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      const [currentOwner, previousSession] = await Promise.all([
        transaction.getOwner(),
        transaction.findSessionByTokenDigest(oldDigest),
      ]);
      if (
        currentOwner === null ||
        currentOwner.ownerId !== owner.ownerId ||
        currentOwner.credentialVersion !== owner.credentialVersion ||
        currentOwner.passwordPhc !== owner.passwordPhc ||
        !isActiveSession(previousSession, currentOwner, acceptedAt)
      ) {
        throw authenticationFailed();
      }

      await transaction.saveSession({
        ...previousSession,
        revokedAt: acceptedAt,
      });
      if (replacementPhc !== undefined) {
        await transaction.setOwner({
          ...currentOwner,
          passwordPhc: replacementPhc,
          updatedAt: acceptedAt,
        });
      }
      const replacementSession: PersistedSession = {
        sessionId: newSessionId,
        tokenDigest: sha256Digest(newSessionToken),
        ownerId: owner.ownerId,
        credentialVersion: owner.credentialVersion,
        createdAt: acceptedAt,
        authenticatedAt: acceptedAt,
        lastUsedAt: acceptedAt,
        idleExpiresAt: acceptedAt + SESSION_IDLE_TTL_MS,
        absoluteExpiresAt: acceptedAt + SESSION_ABSOLUTE_TTL_MS,
      };
      await transaction.saveSession(replacementSession);
      await transaction.appendAuditRecord(
        this.auditRecord("owner.auth.reauthenticated", acceptedAt, {
          ownerId: owner.ownerId,
          sessionId: replacementSession.sessionId,
          targetSessionId: previousSession.sessionId,
        }),
      );
      for (const key of rateLimitKeys) {
        await transaction.deleteLoginAttempts(key);
      }
      return replacementSession;
    });

    return freezeLogin(newSessionToken, newSession);
  }

  public async listSessions(sessionToken: string): Promise<readonly BrowserSessionSummary[]> {
    const current = await this.validateSession(sessionToken);
    return this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      return Object.freeze(
        (await transaction.listSessions()).map((session) =>
          Object.freeze({
            ...publicSession(session),
            current: session.sessionId === current.sessionId,
            expired:
              session.createdAt > acceptedAt ||
              session.idleExpiresAt <= acceptedAt ||
              session.absoluteExpiresAt <= acceptedAt,
            ...(session.revokedAt === undefined ? {} : { revokedAt: session.revokedAt }),
          }),
        ),
      );
    });
  }

  public async revokeSession(input: {
    readonly sessionToken: string;
    readonly sessionId: string;
  }): Promise<void> {
    const actor = await this.validateSession(input.sessionToken);
    const actorDigest = sha256Digest(input.sessionToken);

    await this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      const [owner, currentActor, target] = await Promise.all([
        transaction.getOwner(),
        transaction.findSessionByTokenDigest(actorDigest),
        transaction.findSessionById(input.sessionId),
      ]);
      if (
        !isActiveSession(currentActor, owner, acceptedAt) ||
        target === null ||
        target.ownerId !== actor.ownerId
      ) {
        throw sessionInvalid();
      }
      if (target.revokedAt === undefined) {
        await transaction.saveSession({ ...target, revokedAt: acceptedAt });
        await transaction.appendAuditRecord(
          this.auditRecord("owner.auth.session-revoked", acceptedAt, {
            ownerId: actor.ownerId,
            sessionId: currentActor.sessionId,
            targetSessionId: target.sessionId,
          }),
        );
      }
    });
  }

  public async logout(sessionToken: string): Promise<void> {
    const digest = sha256Digest(sessionToken);
    await this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      const [owner, session] = await Promise.all([
        transaction.getOwner(),
        transaction.findSessionByTokenDigest(digest),
      ]);
      if (!isActiveSession(session, owner, acceptedAt)) {
        throw sessionInvalid();
      }
      await transaction.saveSession({ ...session, revokedAt: acceptedAt });
      await transaction.appendAuditRecord(
        this.auditRecord("owner.auth.session-logged-out", acceptedAt, {
          ownerId: session.ownerId,
          sessionId: session.sessionId,
        }),
      );
    });
  }

  public async beginRecovery(input: { readonly recoveryCode: string }): Promise<RecoveryChallenge> {
    assertRecoveryBearer(input.recoveryCode);
    const recoveryToken = randomToken(this.random, 32);
    const recoveryDigest = versionedRecoveryDigest(input.recoveryCode);
    const stateId = `recovery-state_${randomToken(this.random, 16)}`;

    const state = await this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      const [owner, recoveryCode] = await Promise.all([
        transaction.getOwner(),
        transaction.findRecoveryCodeByDigest(recoveryDigest),
      ]);
      if (
        owner === null ||
        recoveryCode === null ||
        recoveryCode.consumedAt !== undefined ||
        recoveryCode.credentialVersion !== owner.credentialVersion
      ) {
        throw recoveryInvalid();
      }

      await transaction.saveRecoveryCode({
        ...recoveryCode,
        consumedAt: acceptedAt,
      });
      const recoveryState = {
        stateId,
        tokenDigest: sha256Digest(recoveryToken),
        ownerId: owner.ownerId,
        credentialVersion: owner.credentialVersion,
        createdAt: acceptedAt,
        expiresAt: acceptedAt + RECOVERY_STATE_TTL_MS,
      };
      await transaction.saveRecoveryState(recoveryState);
      await transaction.appendAuditRecord(
        this.auditRecord("owner.auth.recovery-begun", acceptedAt, {
          ownerId: owner.ownerId,
        }),
      );
      return recoveryState;
    });

    return Object.freeze({
      recoveryToken,
      expiresAt: state.expiresAt,
    });
  }

  public async completeRecovery(input: {
    readonly recoveryToken: string;
    readonly newPassphrase: string;
  }): Promise<CompletedRecovery> {
    assertRecoveryBearer(input.recoveryToken);
    assertPassphrase(input.newPassphrase);
    const recoveryTokenDigest = sha256Digest(input.recoveryToken);
    return this.passphraseHashGate.run(async () => {
      const expected = await this.requireActiveRecoveryState(recoveryTokenDigest);
      const passwordPhc = await this.hashPassphraseWithoutGate(input.newPassphrase);
      const rawRecoveryCodes = Object.freeze(
        Array.from({ length: RECOVERY_CODE_COUNT }, () => `odr_${randomToken(this.random, 16)}`),
      );
      const ownerId = await this.repository.transaction(async (transaction) => {
        const acceptedAt = this.now();
        const [owner, recoveryState] = await Promise.all([
          transaction.getOwner(),
          transaction.findRecoveryStateByDigest(recoveryTokenDigest),
        ]);
        if (
          owner === null ||
          recoveryState === null ||
          recoveryState.stateId !== expected.stateId ||
          recoveryState.ownerId !== expected.ownerId ||
          recoveryState.credentialVersion !== expected.credentialVersion ||
          recoveryState.ownerId !== owner.ownerId ||
          recoveryState.credentialVersion !== owner.credentialVersion ||
          recoveryState.consumedAt !== undefined ||
          recoveryState.createdAt > acceptedAt ||
          recoveryState.expiresAt <= acceptedAt
        ) {
          throw recoveryInvalid();
        }

        const nextCredentialVersion = owner.credentialVersion + 1;
        const replacementCodes: readonly PersistedRecoveryCode[] = rawRecoveryCodes.map(
          (recoveryCode, index) => ({
            codeId: `recovery_${index + 1}_${randomToken(this.random, 8)}`,
            digest: versionedRecoveryDigest(recoveryCode),
            credentialVersion: nextCredentialVersion,
            createdAt: acceptedAt,
          }),
        );
        const sessions = await transaction.listSessions();

        await transaction.setOwner({
          ...owner,
          passwordPhc,
          credentialVersion: nextCredentialVersion,
          updatedAt: acceptedAt,
        });
        await transaction.setRecoveryCodes(replacementCodes);
        await transaction.saveRecoveryState({
          ...recoveryState,
          consumedAt: acceptedAt,
        });
        for (const session of sessions) {
          if (session.revokedAt === undefined) {
            await transaction.saveSession({ ...session, revokedAt: acceptedAt });
          }
        }
        await transaction.appendAuditRecord(
          this.auditRecord("owner.auth.recovered", acceptedAt, {
            ownerId: owner.ownerId,
          }),
        );
        return owner.ownerId;
      });

      return Object.freeze({
        ownerId,
        recoveryCodes: rawRecoveryCodes,
      });
    });
  }

  private async requireActiveRecoveryState(recoveryTokenDigest: string): Promise<{
    readonly stateId: string;
    readonly ownerId: string;
    readonly credentialVersion: number;
  }> {
    return this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      const [owner, recoveryState] = await Promise.all([
        transaction.getOwner(),
        transaction.findRecoveryStateByDigest(recoveryTokenDigest),
      ]);
      if (
        owner === null ||
        recoveryState === null ||
        recoveryState.ownerId !== owner.ownerId ||
        recoveryState.credentialVersion !== owner.credentialVersion ||
        recoveryState.consumedAt !== undefined ||
        recoveryState.createdAt > acceptedAt ||
        recoveryState.expiresAt <= acceptedAt
      ) {
        throw recoveryInvalid();
      }
      return {
        stateId: recoveryState.stateId,
        ownerId: recoveryState.ownerId,
        credentialVersion: recoveryState.credentialVersion,
      };
    });
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new OwnerAuthError(
        "AUTHENTICATION_UNAVAILABLE",
        "The owner authentication clock returned an invalid instant.",
      );
    }
    return now;
  }

  private async hashPassphrase(passphrase: string): Promise<string> {
    return this.passphraseHashGate.run(() => this.hashPassphraseWithoutGate(passphrase));
  }

  private async hashPassphraseWithoutGate(passphrase: string): Promise<string> {
    try {
      const encodedPhc = await this.passwordHasher.hash(passphrase);
      if (typeof encodedPhc !== "string" || encodedPhc.length === 0) {
        throw new Error("empty password hash");
      }
      return encodedPhc;
    } catch {
      throw new OwnerAuthError(
        "AUTHENTICATION_UNAVAILABLE",
        "Owner authentication is temporarily unavailable.",
      );
    }
  }

  private async verifyPassphrase(encodedPhc: string, passphrase: string): Promise<boolean> {
    try {
      return await this.passwordHasher.verify(encodedPhc, passphrase);
    } catch {
      throw authenticationUnavailable();
    }
  }

  private async reserveLoginAttempt(
    keys: readonly string[],
  ): Promise<PersistedOwnerCredential | null> {
    return this.repository.transaction(async (transaction) => {
      const acceptedAt = this.now();
      const pending = [];
      for (const key of keys) {
        const record = await transaction.getLoginAttempts(key);
        const recent = (record?.attemptedAt ?? []).filter(
          (attemptedAt) => attemptedAt > acceptedAt - LOGIN_WINDOW_MS,
        );
        if (recent.length >= LOGIN_ATTEMPT_LIMIT) {
          throw new OwnerAuthError(
            "RATE_LIMITED",
            "Owner authentication is temporarily unavailable.",
          );
        }
        pending.push({
          key,
          attemptedAt: Object.freeze([...recent, acceptedAt]),
        });
      }
      for (const record of pending) {
        await transaction.setLoginAttempts(record);
      }
      return transaction.getOwner();
    });
  }

  private auditRecord(
    event: OwnerAuthAuditEventName,
    occurredAt: number,
    details: Pick<OwnerAuthAuditRecord, "ownerId" | "sessionId" | "targetSessionId"> = {},
  ): OwnerAuthAuditRecord {
    return Object.freeze({
      auditId: `owner-auth-audit_${randomToken(this.random, 12)}`,
      event,
      occurredAt,
      ...details,
    });
  }
}

class AsyncPermitGate {
  private active = 0;
  private readonly capacity: number;
  private readonly waiters: Array<() => void> = [];

  public constructor(capacity: number) {
    this.capacity = capacity;
  }

  public async run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolvePromise) => {
      this.waiters.push(resolvePromise);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.active -= 1;
    } else {
      next();
    }
  }
}

function assertLocalClaimChannel(channel: LocalClaimChannel): void {
  if (channel !== "local-bootstrap") {
    throw new OwnerAuthError(
      "LOCAL_ACCESS_REQUIRED",
      "Initial owner claim is available only through the local bootstrap channel.",
    );
  }
}

function assertPassphrase(passphrase: string): void {
  if (
    typeof passphrase !== "string" ||
    !/\P{White_Space}/u.test(passphrase) ||
    [...passphrase].length < 10 ||
    Buffer.byteLength(passphrase, "utf8") > 1024
  ) {
    throw new OwnerAuthError(
      "PASSPHRASE_INVALID",
      "The owner passphrase must contain at least 10 Unicode code points, including at least one non-whitespace code point, and at most 1024 UTF-8 bytes.",
    );
  }
}

function assertSourceKey(sourceKey: string): void {
  if (
    typeof sourceKey !== "string" ||
    sourceKey.trim().length === 0 ||
    Buffer.byteLength(sourceKey, "utf8") > 512
  ) {
    throw authenticationFailed();
  }
}

function assertRecoveryBearer(value: string): void {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256) {
    throw recoveryInvalid();
  }
}

function rateLimitKeysFor(sourceKey: string): readonly string[] {
  return Object.freeze([`account:owner`, `source:${sha256Digest(sourceKey)}`]);
}

function freezeLogin(sessionToken: string, session: PersistedSession): OwnerLogin {
  return Object.freeze({
    sessionToken,
    csrfToken: deriveCsrfToken(sessionToken),
    session: publicSession(session),
  });
}

function publicSession(session: PersistedSession): BrowserSession {
  return Object.freeze({
    sessionId: session.sessionId,
    ownerId: session.ownerId,
    createdAt: session.createdAt,
    authenticatedAt: session.authenticatedAt,
    lastUsedAt: session.lastUsedAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
  });
}

function isActiveSession(
  session: PersistedSession | null,
  owner: PersistedOwnerCredential | null,
  now: number,
): session is PersistedSession {
  return (
    session !== null &&
    owner !== null &&
    session.ownerId === owner.ownerId &&
    session.credentialVersion === owner.credentialVersion &&
    session.revokedAt === undefined &&
    session.createdAt <= now &&
    session.authenticatedAt <= now &&
    session.lastUsedAt <= now &&
    session.idleExpiresAt > now &&
    session.absoluteExpiresAt > now
  );
}

function isJsonContentType(contentType: string): boolean {
  return /^application\/json(?:\s*;.*)?$/i.test(contentType.trim());
}

function normalizeAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw authenticationUnavailable();
  }
  return new Set(origins.map((origin) => normalizeOrigin(origin, true)));
}

function normalizeOrigin(value: string, allowTrailingSlash: boolean): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw authenticationUnavailable();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw authenticationUnavailable();
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol === "http:" && !isLoopbackHostname(url.hostname))
  ) {
    throw authenticationUnavailable();
  }
  if (!allowTrailingSlash && value !== url.origin) {
    throw authenticationUnavailable();
  }
  return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function claimInvalid(): OwnerAuthError {
  return new OwnerAuthError("CLAIM_INVALID", "The local owner claim is invalid or expired.");
}

function sessionInvalid(): OwnerAuthError {
  return new OwnerAuthError("SESSION_INVALID", "The owner session is invalid or expired.");
}

function recoveryInvalid(): OwnerAuthError {
  return new OwnerAuthError(
    "RECOVERY_INVALID",
    "The owner recovery credential is invalid or expired.",
  );
}

function authenticationFailed(): OwnerAuthError {
  return new OwnerAuthError(
    "AUTHENTICATION_FAILED",
    "The owner credentials are invalid or unavailable.",
  );
}

function authenticationUnavailable(): OwnerAuthError {
  return new OwnerAuthError(
    "AUTHENTICATION_UNAVAILABLE",
    "Owner authentication is temporarily unavailable.",
  );
}
