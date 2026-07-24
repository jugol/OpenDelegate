import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
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
  readonly records: Record<string, LeaseRecord>;
}

export interface FileSessionLeaseStoreOptions {
  readonly statePath: string;
  readonly mutationTimeoutMs?: number;
  readonly staleMutationLockMs?: number;
}

export class FileSessionLeaseStore implements SessionLeaseStore {
  readonly #statePath: string;
  readonly #lockPath: string;
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
      const record = state.records[sessionKeyHash] ?? {
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
      state.records[sessionKeyHash] = {
        fence: lease.fence,
        lastObservedAt: now,
        active: lease,
      };
      return { value: lease, changed: true };
    });
  }

  async renew(lease: SessionLease, ttlMs: number, now: number): Promise<SessionLease> {
    validateLeaseInput(lease.sessionKeyHash, lease.holderId, ttlMs, now);
    return await this.#mutate((state) => {
      const record = state.records[lease.sessionKeyHash];
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
      const record = state.records[lease.sessionKeyHash];
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
    try {
      await rejectSymlink(this.#statePath);
      const state = await readState(this.#statePath);
      const outcome = mutation(state);
      if (outcome.changed) {
        await writeStateAtomically(this.#statePath, state);
      }
      return outcome.value;
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(this.#lockPath).catch(() => undefined);
    }
  }

  async #acquireMutationLock(): Promise<Awaited<ReturnType<typeof open>>> {
    const startedAt = Date.now();
    for (;;) {
      try {
        const handle = await open(this.#lockPath, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
            "utf8",
          );
          await handle.sync();
          return handle;
        } catch {
          await handle.close().catch(() => undefined);
          await unlink(this.#lockPath).catch(() => undefined);
          throw new AgentAdapterError(
            "SESSION_LEASE_STORE_LOCK_FAILED",
            "File lease store mutation lock could not be initialized.",
            true,
          );
        }
      } catch (error) {
        if (!isErrno(error, "EEXIST")) {
          throw new AgentAdapterError(
            "SESSION_LEASE_STORE_LOCK_FAILED",
            "File lease store mutation lock could not be acquired.",
            true,
          );
        }
        await rejectSymlink(this.#lockPath);
        await this.#removeAbandonedLock();
        if (Date.now() - startedAt >= this.#mutationTimeoutMs) {
          throw new AgentAdapterError(
            "SESSION_LEASE_STORE_BUSY",
            "File lease store is busy with another mutation.",
            true,
          );
        }
        await delay(10);
      }
    }
  }

  async #removeAbandonedLock(): Promise<void> {
    try {
      const information = await stat(this.#lockPath);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(this.#lockPath, "utf8")) as unknown;
      } catch {
        value = undefined;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        "pid" in value &&
        typeof value.pid === "number" &&
        Number.isSafeInteger(value.pid)
      ) {
        if (isProcessAlive(value.pid)) {
          return;
        }
        await unlink(this.#lockPath);
        return;
      }
      if (Date.now() - information.mtimeMs >= this.#staleMutationLockMs) {
        await unlink(this.#lockPath);
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        return;
      }
    }
  }
}

async function readState(statePath: string): Promise<FileLeaseState> {
  let text: string;
  try {
    text = await readFile(statePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { schemaVersion: 1, records: {} };
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
  const records: Record<string, LeaseRecord> = {};
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
    records[key] = {
      fence: candidate.fence,
      lastObservedAt: candidate.lastObservedAt,
      ...(active === undefined ? {} : { active }),
    };
  }
  return { schemaVersion: 1, records };
}

async function writeStateAtomically(statePath: string, state: FileLeaseState): Promise<void> {
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    const orderedRecords = Object.fromEntries(
      Object.entries(state.records)
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
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
