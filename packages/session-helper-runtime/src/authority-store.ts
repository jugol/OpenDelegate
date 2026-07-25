import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  DesktopAuthorityPort,
  DesktopAuthorityRequest,
  DesktopAuthorityResult,
} from "@opendelegate/computer-use-os";

const RECORD_FILENAME = "desktop-authority.json";
const LOCK_FILENAME = "desktop-authority.lock";
const MAX_RECORD_BYTES = 64 * 1024;

export interface AuthoritySigningKeyProvider {
  executeWithKey<T>(operation: (key: Buffer) => Promise<T> | T): Promise<T>;
}

export interface PersistentDesktopAuthorityStoreOptions {
  readonly authorityRoot: string;
  readonly sourceCheckoutRoot: string;
  readonly deviceId: string;
  readonly instanceId: string;
  readonly releaseVersion: string;
  readonly keys: AuthoritySigningKeyProvider;
  readonly clock?: () => number;
  readonly processId?: number;
  readonly processIsAlive?: (processId: number) => boolean | Promise<boolean>;
}

type ResolvedAuthorityOptions = Omit<
  PersistentDesktopAuthorityStoreOptions,
  "clock" | "processId" | "processIsAlive"
> & {
  readonly clock: () => number;
  readonly processId: number;
  readonly processIsAlive: (processId: number) => boolean | Promise<boolean>;
};

interface AuthorityPayload {
  readonly schemaVersion: 1;
  readonly authorityRoot: string;
  readonly deviceId: string;
  readonly instanceId: string;
  readonly releaseVersion: string;
  readonly serviceEpoch: number;
  readonly persistenceGeneration: number;
  readonly activeHelper: {
    readonly helperInstanceId: string;
    readonly sessionId: string;
  } | null;
  readonly updatedAtMs: number;
}

interface AuthorityEnvelope {
  readonly payload: AuthorityPayload;
  readonly mac: string;
}

interface AuthorityLock {
  readonly schemaVersion: 1;
  readonly authorityRoot: string;
  readonly deviceId: string;
  readonly instanceId: string;
  readonly processId: number;
  readonly nonce: string;
}

export class PersistentDesktopAuthorityStore implements DesktopAuthorityPort {
  readonly #options: ResolvedAuthorityOptions;
  readonly #recordPath: string;
  readonly #lockPath: string;
  readonly #lock: AuthorityLock;
  #payload: AuthorityPayload;
  #closed = false;

  private constructor(
    options: ResolvedAuthorityOptions,
    lock: AuthorityLock,
    payload: AuthorityPayload,
  ) {
    this.#options = options;
    this.#recordPath = join(options.authorityRoot, RECORD_FILENAME);
    this.#lockPath = join(options.authorityRoot, LOCK_FILENAME);
    this.#lock = lock;
    this.#payload = payload;
  }

  public static async openCore(
    input: PersistentDesktopAuthorityStoreOptions,
  ): Promise<PersistentDesktopAuthorityStore> {
    const options = await validateOptions(input);
    await mkdir(options.authorityRoot, { recursive: true, mode: 0o700 });
    const lockPath = join(options.authorityRoot, LOCK_FILENAME);
    const lock = await acquireLock(options, lockPath);
    try {
      const prior = await readAuthority(options, join(options.authorityRoot, RECORD_FILENAME));
      const payload: AuthorityPayload = Object.freeze({
        schemaVersion: 1,
        authorityRoot: options.authorityRoot,
        deviceId: options.deviceId,
        instanceId: options.instanceId,
        releaseVersion: options.releaseVersion,
        serviceEpoch: checkedIncrement(prior?.serviceEpoch ?? 0),
        persistenceGeneration: checkedIncrement(prior?.persistenceGeneration ?? 0),
        activeHelper: null,
        updatedAtMs: options.clock(),
      });
      await writeAuthority(options, join(options.authorityRoot, RECORD_FILENAME), payload);
      return new PersistentDesktopAuthorityStore(options, lock, payload);
    } catch (error: unknown) {
      await removeOwnedLock(lockPath, lock);
      throw authorityFailure(error);
    }
  }

  public get serviceEpoch(): number {
    return this.#payload.serviceEpoch;
  }

  public get persistenceGeneration(): number {
    return this.#payload.persistenceGeneration;
  }

  public async activateHelper(input: {
    readonly helperInstanceId: string;
    readonly sessionId: string;
  }): Promise<{ readonly serviceEpoch: number; readonly persistenceGeneration: number }> {
    this.#assertOpen();
    requireIdentifier(input.helperInstanceId, "helper instance ID");
    requireIdentifier(input.sessionId, "session ID");
    const payload = Object.freeze({
      ...this.#payload,
      persistenceGeneration: checkedIncrement(this.#payload.persistenceGeneration),
      activeHelper: Object.freeze({ ...input }),
      updatedAtMs: this.#options.clock(),
    });
    await writeAuthority(this.#options, this.#recordPath, payload);
    this.#payload = payload;
    return Object.freeze({
      serviceEpoch: payload.serviceEpoch,
      persistenceGeneration: payload.persistenceGeneration,
    });
  }

  public async withdrawHelper(helperInstanceId: string): Promise<void> {
    this.#assertOpen();
    if (this.#payload.activeHelper?.helperInstanceId !== helperInstanceId) {
      return;
    }
    const payload = Object.freeze({
      ...this.#payload,
      persistenceGeneration: checkedIncrement(this.#payload.persistenceGeneration),
      activeHelper: null,
      updatedAtMs: this.#options.clock(),
    });
    await writeAuthority(this.#options, this.#recordPath, payload);
    this.#payload = payload;
  }

  public async verify(request: DesktopAuthorityRequest): Promise<DesktopAuthorityResult> {
    const verifiedAtMs = this.#options.clock();
    try {
      const payload = await readAuthority(this.#options, this.#recordPath);
      if (
        payload === null ||
        payload.deviceId !== request.deviceId ||
        payload.serviceEpoch !== request.serviceEpoch ||
        payload.persistenceGeneration !== request.persistenceGeneration ||
        payload.activeHelper?.helperInstanceId !== request.helperInstanceId
      ) {
        return Object.freeze({
          status: "stale",
          reason: "The exact persisted desktop authority is no longer current.",
          verifiedAtMs,
        });
      }
      return Object.freeze({
        status: "current",
        helperInstanceId: request.helperInstanceId,
        serviceEpoch: request.serviceEpoch,
        persistenceGeneration: request.persistenceGeneration,
        verifiedAtMs,
      });
    } catch {
      return Object.freeze({
        status: "unavailable",
        reason: "The persisted desktop authority could not be verified.",
        verifiedAtMs,
      });
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      const payload = Object.freeze({
        ...this.#payload,
        persistenceGeneration: checkedIncrement(this.#payload.persistenceGeneration),
        activeHelper: null,
        updatedAtMs: this.#options.clock(),
      });
      await writeAuthority(this.#options, this.#recordPath, payload);
      this.#payload = payload;
    } finally {
      await removeOwnedLock(this.#lockPath, this.#lock);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("The desktop authority owner is closed.");
    }
  }
}

async function validateOptions(
  input: PersistentDesktopAuthorityStoreOptions,
): Promise<ResolvedAuthorityOptions> {
  requireIdentifier(input.deviceId, "device ID");
  requireIdentifier(input.instanceId, "instance ID");
  requireIdentifier(input.releaseVersion, "release version");
  if (!isAbsolute(input.authorityRoot) || !isAbsolute(input.sourceCheckoutRoot)) {
    throw new TypeError("Desktop authority paths must be absolute.");
  }
  const authorityRoot = resolve(input.authorityRoot);
  const sourceCheckoutRoot = await canonicalExistingDirectory(input.sourceCheckoutRoot);
  if (containsPath(sourceCheckoutRoot, authorityRoot)) {
    throw new TypeError("Desktop authority state must remain outside the source checkout.");
  }
  const processId = input.processId ?? process.pid;
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new TypeError("The authority owner process ID is invalid.");
  }
  return {
    ...input,
    authorityRoot,
    sourceCheckoutRoot,
    clock: input.clock ?? Date.now,
    processId,
    processIsAlive: input.processIsAlive ?? defaultProcessIsAlive,
  };
}

async function acquireLock(
  options: ResolvedAuthorityOptions,
  lockPath: string,
): Promise<AuthorityLock> {
  const lock: AuthorityLock = Object.freeze({
    schemaVersion: 1,
    authorityRoot: options.authorityRoot,
    deviceId: options.deviceId,
    instanceId: options.instanceId,
    processId: options.processId,
    nonce: randomUUID(),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(lock), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return lock;
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST") || attempt > 0) {
        throw error;
      }
      const existing = parseLock(await readBounded(lockPath));
      if (
        existing.authorityRoot !== options.authorityRoot ||
        existing.deviceId !== options.deviceId ||
        existing.instanceId !== options.instanceId ||
        (await options.processIsAlive(existing.processId))
      ) {
        throw new Error("Desktop authority is already owned or its lock is invalid.", {
          cause: error,
        });
      }
      const stalePath = `${lockPath}.stale.${randomUUID()}`;
      await rename(lockPath, stalePath);
      await rm(stalePath, { force: true });
    }
  }
  throw new Error("Desktop authority lock could not be acquired.");
}

async function removeOwnedLock(lockPath: string, expected: AuthorityLock): Promise<void> {
  try {
    const actual = parseLock(await readBounded(lockPath));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return;
    }
    await rm(lockPath);
  } catch {
    // Never delete a lock that cannot be proven to belong to this process.
  }
}

async function readAuthority(
  options: ResolvedAuthorityOptions,
  path: string,
): Promise<AuthorityPayload | null> {
  try {
    const envelope = parseEnvelope(await readBounded(path));
    const valid = await options.keys.executeWithKey((key) => {
      const expected = createHmac("sha256", key)
        .update(canonicalPayload(envelope.payload))
        .digest();
      const actual = Buffer.from(envelope.mac, "base64url");
      const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
      expected.fill(0);
      actual.fill(0);
      return matches;
    });
    if (
      !valid ||
      envelope.payload.authorityRoot !== options.authorityRoot ||
      envelope.payload.deviceId !== options.deviceId ||
      envelope.payload.instanceId !== options.instanceId
    ) {
      throw new Error("Desktop authority signature or root binding is invalid.");
    }
    return envelope.payload;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function writeAuthority(
  options: ResolvedAuthorityOptions,
  path: string,
  payload: AuthorityPayload,
): Promise<void> {
  const mac = await options.keys.executeWithKey((key) =>
    createHmac("sha256", key).update(canonicalPayload(payload)).digest("base64url"),
  );
  const temporaryPath = join(dirname(path), `.${RECORD_FILENAME}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ payload, mac }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function parseEnvelope(value: string): AuthorityEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Desktop authority record is corrupt.");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["payload", "mac"]) ||
    typeof parsed.mac !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(parsed.mac)
  ) {
    throw new Error("Desktop authority record is invalid.");
  }
  return {
    payload: parsePayload(parsed.payload),
    mac: parsed.mac,
  };
}

function parsePayload(value: unknown): AuthorityPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "authorityRoot",
      "deviceId",
      "instanceId",
      "releaseVersion",
      "serviceEpoch",
      "persistenceGeneration",
      "activeHelper",
      "updatedAtMs",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.authorityRoot !== "string" ||
    !isAbsolute(value.authorityRoot) ||
    !isIdentifier(value.deviceId) ||
    !isIdentifier(value.instanceId) ||
    !isIdentifier(value.releaseVersion) ||
    !isPositiveInteger(value.serviceEpoch) ||
    !isPositiveInteger(value.persistenceGeneration) ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    typeof value.updatedAtMs !== "number" ||
    value.updatedAtMs < 0
  ) {
    throw new Error("Desktop authority payload is invalid.");
  }
  let activeHelper: AuthorityPayload["activeHelper"] = null;
  if (value.activeHelper !== null) {
    if (
      !isRecord(value.activeHelper) ||
      !hasExactKeys(value.activeHelper, ["helperInstanceId", "sessionId"]) ||
      !isIdentifier(value.activeHelper.helperInstanceId) ||
      !isIdentifier(value.activeHelper.sessionId)
    ) {
      throw new Error("Desktop authority helper binding is invalid.");
    }
    activeHelper = Object.freeze({
      helperInstanceId: value.activeHelper.helperInstanceId,
      sessionId: value.activeHelper.sessionId,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    authorityRoot: resolve(value.authorityRoot),
    deviceId: value.deviceId,
    instanceId: value.instanceId,
    releaseVersion: value.releaseVersion,
    serviceEpoch: value.serviceEpoch,
    persistenceGeneration: value.persistenceGeneration,
    activeHelper,
    updatedAtMs: value.updatedAtMs,
  });
}

function parseLock(value: string): AuthorityLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Desktop authority lock is corrupt.");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "schemaVersion",
      "authorityRoot",
      "deviceId",
      "instanceId",
      "processId",
      "nonce",
    ]) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.authorityRoot !== "string" ||
    !isAbsolute(parsed.authorityRoot) ||
    !isIdentifier(parsed.deviceId) ||
    !isIdentifier(parsed.instanceId) ||
    !isPositiveInteger(parsed.processId) ||
    !isIdentifier(parsed.nonce)
  ) {
    throw new Error("Desktop authority lock is invalid.");
  }
  return {
    schemaVersion: 1,
    authorityRoot: resolve(parsed.authorityRoot),
    deviceId: parsed.deviceId,
    instanceId: parsed.instanceId,
    processId: parsed.processId,
    nonce: parsed.nonce,
  };
}

async function readBounded(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
      throw new Error("Desktop authority state has an invalid size.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function canonicalPayload(payload: AuthorityPayload): string {
  return JSON.stringify(payload);
}

function checkedIncrement(value: number): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next) || next <= 0) {
    throw new Error("Desktop authority counter is exhausted.");
  }
  return next;
}

function containsPath(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function canonicalExistingDirectory(path: string): Promise<string> {
  await access(path, constants.R_OK);
  return await realpath(path);
}

function defaultProcessIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return !isNodeError(error, "ESRCH");
  }
}

function authorityFailure(error: unknown): Error {
  if (error instanceof Error && /authority/u.test(error.message)) {
    return error;
  }
  return new Error("Desktop authority could not be opened.");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  );
}

function requireIdentifier(value: unknown, name: string): asserts value is string {
  if (!isIdentifier(value)) {
    throw new TypeError(`The ${name} is invalid.`);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
