export interface OwnerAuthClock {
  now(): number;
}

export interface SecureRandomSource {
  bytes(length: number): Uint8Array;
}

export interface PasswordHasher {
  hash(passphrase: string): Promise<string>;
  verify(encodedPhc: string, passphrase: string): Promise<boolean>;
  needsRehash(encodedPhc: string): boolean;
}

export type LocalClaimChannel = "local-bootstrap" | "external-admin";

export interface PersistedInitialClaim {
  readonly tokenDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface PersistedOwnerCredential {
  readonly ownerId: string;
  readonly passwordPhc: string;
  readonly credentialVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PersistedRecoveryCode {
  readonly codeId: string;
  readonly digest: string;
  readonly credentialVersion: number;
  readonly createdAt: number;
  readonly consumedAt?: number;
}

export interface PersistedSession {
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly ownerId: string;
  readonly credentialVersion: number;
  readonly createdAt: number;
  readonly authenticatedAt: number;
  readonly lastUsedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly revokedAt?: number;
}

export interface PersistedRecoveryState {
  readonly stateId: string;
  readonly tokenDigest: string;
  readonly ownerId: string;
  readonly credentialVersion: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt?: number;
}

export interface PersistedLoginAttempts {
  readonly key: string;
  readonly attemptedAt: readonly number[];
}

export type OwnerAuthAuditEventName =
  | "owner.auth.claim-issued"
  | "owner.auth.claim-replaced"
  | "owner.auth.claimed"
  | "owner.auth.login-succeeded"
  | "owner.auth.reauthenticated"
  | "owner.auth.recovery-begun"
  | "owner.auth.recovered"
  | "owner.auth.session-revoked"
  | "owner.auth.session-logged-out";

export interface OwnerAuthAuditRecord {
  readonly auditId: string;
  readonly event: OwnerAuthAuditEventName;
  readonly occurredAt: number;
  readonly ownerId?: string;
  readonly sessionId?: string;
  readonly targetSessionId?: string;
}

export interface OwnerAuthTransaction {
  getInitialClaim(): Promise<PersistedInitialClaim | null>;
  setInitialClaim(claim: PersistedInitialClaim | null): Promise<void>;
  getOwner(): Promise<PersistedOwnerCredential | null>;
  setOwner(owner: PersistedOwnerCredential): Promise<void>;
  listRecoveryCodes(): Promise<readonly PersistedRecoveryCode[]>;
  setRecoveryCodes(codes: readonly PersistedRecoveryCode[]): Promise<void>;
  findRecoveryCodeByDigest(digest: string): Promise<PersistedRecoveryCode | null>;
  saveRecoveryCode(code: PersistedRecoveryCode): Promise<void>;
  findRecoveryStateByDigest(digest: string): Promise<PersistedRecoveryState | null>;
  saveRecoveryState(state: PersistedRecoveryState): Promise<void>;
  findSessionByTokenDigest(digest: string): Promise<PersistedSession | null>;
  findSessionById(sessionId: string): Promise<PersistedSession | null>;
  listSessions(): Promise<readonly PersistedSession[]>;
  saveSession(session: PersistedSession): Promise<void>;
  getLoginAttempts(key: string): Promise<PersistedLoginAttempts | null>;
  setLoginAttempts(attempts: PersistedLoginAttempts): Promise<void>;
  deleteLoginAttempts(key: string): Promise<void>;
  appendAuditRecord(record: OwnerAuthAuditRecord): Promise<void>;
  listAuditRecords(): Promise<readonly OwnerAuthAuditRecord[]>;
}

export interface OwnerAuthRepository {
  transaction<TResult>(
    operation: (transaction: OwnerAuthTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}

export interface OwnerAuthRepositorySnapshot {
  readonly claim: PersistedInitialClaim | null;
  readonly owner: PersistedOwnerCredential | null;
  readonly recoveryCodes: readonly PersistedRecoveryCode[];
  readonly recoveryStates: readonly PersistedRecoveryState[];
  readonly sessions: readonly PersistedSession[];
  readonly loginAttempts: readonly PersistedLoginAttempts[];
  readonly auditRecords: readonly OwnerAuthAuditRecord[];
}
