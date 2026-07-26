import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";

import { AgentAdapterError } from "./errors.ts";

export interface SessionLease {
  readonly sessionKeyHash: string;
  readonly holderId: string;
  readonly fence: number;
  readonly expiresAt: number;
}

export interface SessionLeaseStore {
  acquire(sessionKey: string, holderId: string, ttlMs: number, now: number): Promise<SessionLease>;
  renew(lease: SessionLease, ttlMs: number, now: number): Promise<SessionLease>;
  release(lease: SessionLease): Promise<void>;
}

interface LeaseRecord {
  fence: number;
  lastObservedAt: number;
  active?: SessionLease;
}

export function hashSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

export class InMemorySessionLeaseStore implements SessionLeaseStore {
  readonly #records = new Map<string, LeaseRecord>();

  async acquire(
    sessionKey: string,
    holderId: string,
    ttlMs: number,
    now: number,
  ): Promise<SessionLease> {
    validateLeaseInput(sessionKey, holderId, ttlMs, now);
    const sessionKeyHash = hashSessionKey(sessionKey);
    const record = this.#records.get(sessionKeyHash) ?? { fence: 0, lastObservedAt: now };
    rejectClockRegression(record.lastObservedAt, now);
    const active = record.active;
    if (active !== undefined && active.expiresAt > now) {
      if (active.holderId === holderId) {
        return active;
      }
      throw new AgentAdapterError(
        "NATIVE_SESSION_BUSY",
        "The native session already has an active writer.",
        true,
      );
    }
    const lease: SessionLease = {
      sessionKeyHash,
      holderId,
      fence: record.fence + 1,
      expiresAt: now + ttlMs,
    };
    this.#records.set(sessionKeyHash, {
      fence: lease.fence,
      lastObservedAt: now,
      active: lease,
    });
    return lease;
  }

  async renew(lease: SessionLease, ttlMs: number, now: number): Promise<SessionLease> {
    validateLeaseInput(lease.sessionKeyHash, lease.holderId, ttlMs, now);
    const record = this.#records.get(lease.sessionKeyHash);
    if (record !== undefined) {
      rejectClockRegression(record.lastObservedAt, now);
    }
    if (
      record?.active === undefined ||
      record.active.holderId !== lease.holderId ||
      record.active.fence !== lease.fence ||
      record.active.expiresAt <= now
    ) {
      throw new AgentAdapterError(
        "NATIVE_SESSION_LEASE_LOST",
        "The native session writer lease is no longer current.",
      );
    }
    const renewed: SessionLease = { ...lease, expiresAt: now + ttlMs };
    record.active = renewed;
    record.lastObservedAt = now;
    return renewed;
  }

  async release(lease: SessionLease): Promise<void> {
    const record = this.#records.get(lease.sessionKeyHash);
    if (
      record?.active !== undefined &&
      record.active.holderId === lease.holderId &&
      record.active.fence === lease.fence
    ) {
      delete record.active;
    }
  }
}

export const processSessionLeaseStore: SessionLeaseStore = new InMemorySessionLeaseStore();

interface FileLeaseState {
  readonly schemaVersion: 1;
  readonly records: Map<string, LeaseRecord>;
}

interface MutationLockMetadata {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
}

interface OwnedMutationLock {
  readonly handle: Awaited<ReturnType<typeof open>>;
}

interface ObservedMutationLock {
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly information: BigIntStats;
  readonly metadata?: MutationLockMetadata;
}

export interface FileSessionLeaseStoreOptions {
  readonly statePath: string;
  readonly mutationTimeoutMs?: number;
  readonly staleMutationLockMs?: number;
}

export class FileSessionLeaseStore implements SessionLeaseStore {
  readonly #statePath: string;
  readonly #lockPath: string;
  readonly #recoveryPath: string;
  readonly #mutationTimeoutMs: number;
  readonly #staleMutationLockMs: number;

  constructor(options: FileSessionLeaseStoreOptions) {
    if (!isAbsolute(options.statePath)) {
      throw new AgentAdapterError(
        "INVALID_LEASE_STORE_PATH",
        "File session lease state path must be absolute.",
      );
    }
    this.#statePath = resolve(options.statePath);
    this.#lockPath = `${this.#statePath}.mutation.lock`;
    this.#recoveryPath = `${this.#lockPath}.recovery`;
    this.#mutationTimeoutMs = options.mutationTimeoutMs ?? 5_000;
    this.#staleMutationLockMs = options.staleMutationLockMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#mutationTimeoutMs) ||
      this.#mutationTimeoutMs < 1 ||
      !Number.isSafeInteger(this.#staleMutationLockMs) ||
      this.#staleMutationLockMs < 1
    ) {
      throw new AgentAdapterError(
        "INVALID_LEASE_STORE_OPTIONS",
        "File lease store timeouts must be positive integers.",
      );
    }
  }

  async acquire(
    sessionKey: string,
    holderId: string,
    ttlMs: number,
    now: number,
  ): Promise<SessionLease> {
    validateLeaseInput(sessionKey, holderId, ttlMs, now);
    const sessionKeyHash = hashSessionKey(sessionKey);
    return await this.#mutate((state) => {
      const record = state.records.get(sessionKeyHash) ?? {
        fence: 0,
        lastObservedAt: now,
      };
      rejectClockRegression(record.lastObservedAt, now);
      const active = record.active;
      if (active !== undefined && active.expiresAt > now) {
        if (active.holderId === holderId) {
          return { value: active, changed: false };
        }
        throw new AgentAdapterError(
          "NATIVE_SESSION_BUSY",
          "The native session already has an active writer.",
          true,
        );
      }
      const lease: SessionLease = {
        sessionKeyHash,
        holderId,
        fence: record.fence + 1,
        expiresAt: now + ttlMs,
      };
      state.records.set(sessionKeyHash, {
        fence: lease.fence,
        lastObservedAt: now,
        active: lease,
      });
      return { value: lease, changed: true };
    });
  }

  async renew(lease: SessionLease, ttlMs: number, now: number): Promise<SessionLease> {
    validateLeaseInput(lease.sessionKeyHash, lease.holderId, ttlMs, now);
    return await this.#mutate((state) => {
      const record = state.records.get(lease.sessionKeyHash);
      if (record !== undefined) {
        rejectClockRegression(record.lastObservedAt, now);
      }
      if (
        record?.active === undefined ||
        record.active.holderId !== lease.holderId ||
        record.active.fence !== lease.fence ||
        record.active.expiresAt <= now
      ) {
        throw new AgentAdapterError(
          "NATIVE_SESSION_LEASE_LOST",
          "The native session writer lease is no longer current.",
        );
      }
      const renewed: SessionLease = { ...lease, expiresAt: now + ttlMs };
      record.active = renewed;
      record.lastObservedAt = now;
      return { value: renewed, changed: true };
    });
  }

  async release(lease: SessionLease): Promise<void> {
    await this.#mutate((state) => {
      const record = state.records.get(lease.sessionKeyHash);
      if (
        record?.active === undefined ||
        record.active.holderId !== lease.holderId ||
        record.active.fence !== lease.fence
      ) {
        return { value: undefined, changed: false };
      }
      delete record.active;
      return { value: undefined, changed: true };
    });
  }

  async #mutate<T>(
    mutation: (state: FileLeaseState) => { readonly value: T; readonly changed: boolean },
  ): Promise<T> {
    await mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 });
    const lock = await this.#acquireMutationLock();
    return await withOwnedMutationLock(this.#lockPath, lock, async () => {
      await rejectSymlink(this.#statePath);
      const state = await readState(this.#statePath);
      const outcome = mutation(state);
      if (outcome.changed) {
        await writeStateAtomically(this.#statePath, state);
      }
      return outcome.value;
    });
  }

  async #acquireMutationLock(): Promise<OwnedMutationLock> {
    const startedAt = Date.now();
    for (;;) {
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(this.#lockPath, "wx", 0o600);
      } catch (error) {
        const existingLock = isErrno(error, "EEXIST");
        const transientWindowsContention = await isTransientWindowsLockOpenContention(
          this.#lockPath,
          error,
        );
        if (!existingLock && !transientWindowsContention) {
          throw createMutationLockAcquisitionError();
        }
        if (existingLock) {
          await this.#attemptAbandonedLockRecovery();
        }
        if (Date.now() - startedAt >= this.#mutationTimeoutMs) {
          if (transientWindowsContention) {
            throw createMutationLockAcquisitionError();
          }
          throw new AgentAdapterError(
            "SESSION_LEASE_STORE_BUSY",
            "File lease store is busy with another mutation.",
            true,
          );
        }
        await delay(10);
        continue;
      }

      try {
        return await initializeOwnedMutationLock(this.#lockPath, handle);
      } catch {
        throw new AgentAdapterError(
          "SESSION_LEASE_STORE_LOCK_FAILED",
          "File lease store mutation lock could not be initialized.",
          true,
        );
      }
    }
  }

  async #attemptAbandonedLockRecovery(): Promise<void> {
    let recoveryHandle: Awaited<ReturnType<typeof open>>;
    try {
      recoveryHandle = await open(this.#recoveryPath, "wx", 0o600);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        await rejectUnsafeExistingLockPath(this.#recoveryPath);
        return;
      }
      if (await isTransientWindowsLockOpenContention(this.#recoveryPath, error)) {
        return;
      }
      throw new AgentAdapterError(
        "SESSION_LEASE_STORE_LOCK_FAILED",
        "File lease store recovery leadership could not be acquired.",
        true,
      );
    }

    let recovery: OwnedMutationLock;
    try {
      recovery = await initializeOwnedMutationLock(this.#recoveryPath, recoveryHandle);
    } catch {
      throw new AgentAdapterError(
        "SESSION_LEASE_STORE_LOCK_FAILED",
        "File lease store recovery leadership could not be initialized.",
        true,
      );
    }
    await withOwnedMutationLock(this.#recoveryPath, recovery, async () => {
      await this.#removeAbandonedLockUnderRecovery();
    });
  }

  async #removeAbandonedLockUnderRecovery(): Promise<void> {
    const observed = await readMutationLock(this.#lockPath);
    if (observed === undefined) {
      return;
    }
    try {
      if (observed.metadata === undefined) {
        if (Date.now() - Number(observed.information.mtimeMs) < this.#staleMutationLockMs) {
          return;
        }
        throw new AgentAdapterError(
          "SESSION_LEASE_STORE_LOCK_CORRUPT",
          "File lease store mutation lock is malformed and requires manual recovery.",
        );
      }
      if (probeProcessLiveness(observed.metadata.pid) !== "dead") {
        return;
      }
      const current = await lstat(this.#lockPath, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        !sameFile(current, observed.information)
      ) {
        return;
      }
      // Once the observed owner is conclusively absent and this recovery leader
      // still sees the same inode, no compliant participant can replace the path:
      // the owner cannot release it, and every competing reaper is excluded.
      await unlink(this.#lockPath);
    } catch (error) {
      if (error instanceof AgentAdapterError) {
        throw error;
      }
      throw new AgentAdapterError(
        "SESSION_LEASE_STORE_LOCK_FAILED",
        "The abandoned file lease store mutation lock could not be removed safely.",
        true,
      );
    } finally {
      await observed.handle.close().catch(() => undefined);
    }
  }
}

async function readState(statePath: string): Promise<FileLeaseState> {
  let text: string;
  try {
    text = await readFile(statePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { schemaVersion: 1, records: new Map() };
    }
    throw new AgentAdapterError(
      "SESSION_LEASE_STORE_READ_FAILED",
      "File session lease state could not be read.",
      true,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw corruptState();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("records" in value) ||
    typeof value.records !== "object" ||
    value.records === null ||
    Array.isArray(value.records)
  ) {
    throw corruptState();
  }
  const records = new Map<string, LeaseRecord>();
  for (const [key, candidate] of Object.entries(value.records)) {
    if (
      !/^[a-f0-9]{64}$/u.test(key) ||
      typeof candidate !== "object" ||
      candidate === null ||
      !("fence" in candidate) ||
      !Number.isSafeInteger(candidate.fence) ||
      typeof candidate.fence !== "number" ||
      candidate.fence < 0 ||
      !("lastObservedAt" in candidate) ||
      typeof candidate.lastObservedAt !== "number" ||
      !Number.isSafeInteger(candidate.lastObservedAt) ||
      candidate.lastObservedAt < 0
    ) {
      throw corruptState();
    }
    let active: SessionLease | undefined;
    if ("active" in candidate && candidate.active !== undefined) {
      const activeCandidate = candidate.active;
      if (
        typeof activeCandidate !== "object" ||
        activeCandidate === null ||
        !("holderId" in activeCandidate) ||
        typeof activeCandidate.holderId !== "string" ||
        activeCandidate.holderId.length === 0 ||
        !("fence" in activeCandidate) ||
        activeCandidate.fence !== candidate.fence ||
        !("expiresAt" in activeCandidate) ||
        typeof activeCandidate.expiresAt !== "number" ||
        !Number.isSafeInteger(activeCandidate.expiresAt) ||
        activeCandidate.expiresAt < 0
      ) {
        throw corruptState();
      }
      active = {
        sessionKeyHash: key,
        holderId: activeCandidate.holderId,
        fence: candidate.fence,
        expiresAt: activeCandidate.expiresAt,
      };
    }
    records.set(key, {
      fence: candidate.fence,
      lastObservedAt: candidate.lastObservedAt,
      ...(active === undefined ? {} : { active }),
    });
  }
  return { schemaVersion: 1, records };
}

async function writeStateAtomically(statePath: string, state: FileLeaseState): Promise<void> {
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    const orderedRecords = Object.fromEntries(
      [...state.records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, record]) => [
          key,
          {
            fence: record.fence,
            lastObservedAt: record.lastObservedAt,
            ...(record.active === undefined
              ? {}
              : {
                  active: {
                    holderId: record.active.holderId,
                    fence: record.active.fence,
                    expiresAt: record.active.expiresAt,
                  },
                }),
          },
        ]),
    );
    await handle.writeFile(
      `${JSON.stringify({ schemaVersion: 1, records: orderedRecords })}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, statePath);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new AgentAdapterError(
      "SESSION_LEASE_STORE_WRITE_FAILED",
      "File session lease state could not be committed atomically.",
      true,
    );
  }
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new AgentAdapterError(
        "UNSAFE_LEASE_STORE_PATH",
        "File session lease paths may not be symbolic links.",
      );
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

async function rejectUnsafeExistingLockPath(path: string): Promise<void> {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new AgentAdapterError(
        "UNSAFE_LEASE_STORE_PATH",
        "File session lease lock paths must be regular files.",
      );
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

async function readMutationLock(path: string): Promise<ObservedMutationLock | undefined> {
  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fileConstants.O_NONBLOCK ?? 0;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fileConstants.O_RDONLY | noFollow | nonBlocking);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    if (isErrno(error, "ELOOP")) {
      throw new AgentAdapterError(
        "UNSAFE_LEASE_STORE_PATH",
        "File session lease lock paths may not be symbolic links.",
      );
    }
    throw error;
  }

  let retained = false;
  try {
    const opened = await handle.stat({ bigint: true });
    let openedPath: BigIntStats;
    try {
      openedPath = await lstat(path, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
    if (
      !opened.isFile() ||
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      !sameFile(opened, openedPath)
    ) {
      throw new AgentAdapterError(
        "UNSAFE_LEASE_STORE_PATH",
        "File session lease lock paths must remain stable regular files.",
      );
    }

    const maximumMetadataBytes = 4 * 1024;
    if (opened.size > BigInt(maximumMetadataBytes)) {
      retained = true;
      return { handle, information: opened };
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        return undefined;
      }
      offset += result.bytesRead;
    }
    const overflowProbe = Buffer.alloc(1);
    if ((await handle.read(overflowProbe, 0, 1, offset)).bytesRead !== 0) {
      return undefined;
    }

    const afterRead = await handle.stat({ bigint: true });
    let afterReadPath: BigIntStats;
    try {
      afterReadPath = await lstat(path, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
    if (
      afterReadPath.isSymbolicLink() ||
      !sameSnapshot(opened, afterRead) ||
      !sameSnapshot(afterRead, afterReadPath)
    ) {
      return undefined;
    }

    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      value = undefined;
    }
    const metadata = parseMutationLockMetadata(value);
    retained = true;
    return {
      handle,
      information: afterRead,
      ...(metadata === undefined ? {} : { metadata }),
    };
  } finally {
    if (!retained) {
      await handle.close();
    }
  }
}

async function initializeOwnedMutationLock(
  path: string,
  handle: Awaited<ReturnType<typeof open>>,
): Promise<OwnedMutationLock> {
  try {
    const metadata: MutationLockMetadata = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
    };
    await handle.writeFile(JSON.stringify(metadata), "utf8");
    await handle.sync();
    return { handle };
  } catch {
    await releaseOwnedMutationLock(path, { handle }).catch(() => undefined);
    throw new AgentAdapterError(
      "SESSION_LEASE_STORE_LOCK_FAILED",
      "File lease store lock initialization failed and was rolled back.",
      true,
    );
  }
}

async function withOwnedMutationLock<T>(
  path: string,
  lock: OwnedMutationLock,
  operation: () => Promise<T>,
): Promise<T> {
  let outcome:
    | { readonly status: "fulfilled"; readonly value: T }
    | { readonly status: "rejected"; readonly error: unknown };
  try {
    outcome = { status: "fulfilled", value: await operation() };
  } catch (error) {
    outcome = { status: "rejected", error };
  }

  try {
    await releaseOwnedMutationLock(path, lock);
  } catch (releaseError) {
    if (outcome.status === "rejected") {
      throw new AggregateError(
        [outcome.error, releaseError],
        "File lease store mutation and lock release both failed.",
        { cause: releaseError },
      );
    }
    throw releaseError;
  }
  if (outcome.status === "rejected") {
    throw outcome.error;
  }
  return outcome.value;
}

async function releaseOwnedMutationLock(path: string, lock: OwnedMutationLock): Promise<void> {
  let unlinkFailure: unknown;
  try {
    await unlink(path);
  } catch (error) {
    unlinkFailure = error;
  }
  let closeFailure: unknown;
  try {
    await lock.handle.close();
  } catch (error) {
    closeFailure = error;
  }
  if (unlinkFailure !== undefined) {
    const ownershipLost = isErrno(unlinkFailure, "ENOENT");
    throw new AgentAdapterError(
      ownershipLost
        ? "SESSION_LEASE_STORE_LOCK_OWNERSHIP_LOST"
        : "SESSION_LEASE_STORE_LOCK_RELEASE_FAILED",
      ownershipLost
        ? "File lease store lock ownership was lost before release."
        : "File lease store lock could not be released.",
    );
  }
  if (closeFailure !== undefined) {
    throw new AgentAdapterError(
      "SESSION_LEASE_STORE_LOCK_RELEASE_FAILED",
      "File lease store lock handle could not be closed after release.",
      true,
    );
  }
}

function parseMutationLockMetadata(value: unknown): MutationLockMetadata | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "createdAt,pid,token" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.token) ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    return undefined;
  }
  return {
    pid: value.pid,
    token: value.token,
    createdAt: value.createdAt,
  };
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino === right.ino &&
    (left.dev === right.dev ||
      (process.platform === "win32" &&
        (left.dev === 0n || right.dev === 0n) &&
        left.birthtimeNs === right.birthtimeNs))
  );
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function corruptState(): AgentAdapterError {
  return new AgentAdapterError(
    "SESSION_LEASE_STORE_CORRUPT",
    "File session lease state is malformed and was rejected.",
  );
}

function rejectClockRegression(lastObservedAt: number, now: number): void {
  if (now < lastObservedAt) {
    throw new AgentAdapterError(
      "LEASE_CLOCK_REGRESSION",
      "Session lease clock moved backward; authority was rejected.",
    );
  }
}

function probeProcessLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return isErrno(error, "ESRCH") ? "dead" : "unknown";
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function createMutationLockAcquisitionError(): AgentAdapterError {
  return new AgentAdapterError(
    "SESSION_LEASE_STORE_LOCK_FAILED",
    "File lease store mutation lock could not be acquired.",
    true,
  );
}

async function isTransientWindowsLockOpenContention(
  path: string,
  error: unknown,
): Promise<boolean> {
  // libuv reports EPERM when an exclusive create races a Windows path that has
  // been unlinked but is still completing deletion. Retry only when a no-follow
  // path inspection proves that the name disappeared or still identifies a
  // regular lock file. Persistent access denial and unsafe path types remain
  // fail-closed.
  if (process.platform !== "win32" || !isErrno(error, "EPERM")) {
    return false;
  }
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new AgentAdapterError(
        "UNSAFE_LEASE_STORE_PATH",
        "File session lease lock paths must be regular files.",
      );
    }
    return true;
  } catch (inspectionError) {
    if (isErrno(inspectionError, "ENOENT")) {
      return true;
    }
    if (inspectionError instanceof AgentAdapterError) {
      throw inspectionError;
    }
    return false;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function validateLeaseInput(
  sessionKey: string,
  holderId: string,
  ttlMs: number,
  now: number,
): void {
  if (sessionKey.length === 0 || holderId.length === 0) {
    throw new AgentAdapterError("INVALID_LEASE_INPUT", "Session and holder IDs are required.");
  }
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    !Number.isSafeInteger(now + ttlMs)
  ) {
    throw new AgentAdapterError(
      "INVALID_LEASE_INPUT",
      "Lease timing must use positive safe-integer milliseconds.",
    );
  }
}
