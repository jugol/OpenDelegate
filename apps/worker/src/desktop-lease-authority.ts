import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type {
  DesktopLease,
  DesktopLeasePort,
  DesktopLeaseRequest,
  DesktopLeaseResult,
} from "@opendelegate/computer-use-os";
import Database from "better-sqlite3";

const MAXIMUM_IDENTIFIER_BYTES = 512;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;

export interface WorkerDesktopLeaseAuthorityClock {
  now(): number;
}

export interface WorkerDesktopLeaseAuthorityIdSource {
  nextLeaseId(): string;
}

export interface SqliteWorkerDesktopLeaseAuthorityOptions {
  readonly filename: string;
  readonly sourceCheckoutDirectory: string;
  readonly clock?: WorkerDesktopLeaseAuthorityClock;
  readonly idSource?: WorkerDesktopLeaseAuthorityIdSource;
}

export interface WorkerDesktopLeaseClaimInput {
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly runLeaseId: string;
  readonly runFencingToken: number;
  readonly runLeaseExpiresAtMs: number;
}

export type WorkerDesktopLeaseClaim =
  | {
      readonly disposition: "acquired" | "current";
      readonly lease: DesktopLease;
    }
  | {
      readonly disposition: "busy";
      readonly retryAfterMs: number;
    };

export type WorkerDesktopLeaseReleaseDisposition = "released" | "stale";
export type WorkerDesktopLeaseRenewDisposition =
  | { readonly disposition: "renewed"; readonly lease: DesktopLease }
  | { readonly disposition: "stale" };

export interface WorkerDesktopResourceLockProjection {
  readonly resourceName: "desktop-session";
  readonly capacity: 1;
  readonly holders: readonly {
    readonly taskId: string;
    readonly runId: string;
    readonly expiresAtMs: number;
  }[];
}

interface DesktopAuthorityRow {
  readonly last_observed_at_ms: number;
  readonly last_fencing_token: number;
  readonly task_id: string | null;
  readonly device_id: string | null;
  readonly run_id: string | null;
  readonly run_lease_id: string | null;
  readonly run_fencing_token: number | null;
  readonly desktop_lease_id: string | null;
  readonly desktop_expires_at_ms: number | null;
}

export class WorkerDesktopLeaseAuthorityError extends Error {
  public readonly code:
    | "AUTHORITY_CLOSED"
    | "CLOCK_ROLLBACK"
    | "INVALID_INPUT"
    | "INVALID_RUNTIME_PATH"
    | "STATE_CORRUPT";

  public constructor(code: WorkerDesktopLeaseAuthorityError["code"], message: string) {
    super(message);
    this.name = "WorkerDesktopLeaseAuthorityError";
    this.code = code;
  }
}

/**
 * Device-local, capacity-one desktop authority.
 *
 * The Main Run lease bounds every desktop claim, while this SQLite journal is the
 * deterministic arbiter when multiple Worker Runs on one Device compete for the
 * interactive session. Its fencing counter survives process restarts.
 */
export class SqliteWorkerDesktopLeaseAuthority implements DesktopLeasePort {
  readonly #database: Database.Database;
  readonly #clock: WorkerDesktopLeaseAuthorityClock;
  readonly #idSource: WorkerDesktopLeaseAuthorityIdSource;
  #closed = false;

  public constructor(options: SqliteWorkerDesktopLeaseAuthorityOptions) {
    const filename = validateRuntimePath(options);
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#idSource = options.idSource ?? { nextLeaseId: () => randomUUID() };
    this.#database = new Database(filename);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = FULL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS worker_desktop_authority (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
        last_fencing_token INTEGER NOT NULL CHECK (last_fencing_token >= 0),
        task_id TEXT,
        device_id TEXT,
        run_id TEXT,
        run_lease_id TEXT,
        run_fencing_token INTEGER CHECK (run_fencing_token IS NULL OR run_fencing_token > 0),
        desktop_lease_id TEXT,
        desktop_expires_at_ms INTEGER
          CHECK (desktop_expires_at_ms IS NULL OR desktop_expires_at_ms >= 0),
        CHECK (
          (
            task_id IS NULL
            AND device_id IS NULL
            AND run_id IS NULL
            AND run_lease_id IS NULL
            AND run_fencing_token IS NULL
            AND desktop_lease_id IS NULL
            AND desktop_expires_at_ms IS NULL
          )
          OR
          (
            task_id IS NOT NULL
            AND device_id IS NOT NULL
            AND run_id IS NOT NULL
            AND run_lease_id IS NOT NULL
            AND run_fencing_token IS NOT NULL
            AND desktop_lease_id IS NOT NULL
            AND desktop_expires_at_ms IS NOT NULL
          )
        )
      ) STRICT;
      INSERT OR IGNORE INTO worker_desktop_authority (
        singleton,
        last_observed_at_ms,
        last_fencing_token
      ) VALUES (1, 0, 0);
    `);
  }

  public async claim(input: WorkerDesktopLeaseClaimInput): Promise<WorkerDesktopLeaseClaim> {
    this.#assertOpen();
    const now = this.#readClock();
    const normalized = validateClaimInput(input, now);
    const transaction = this.#database.transaction((): WorkerDesktopLeaseClaim => {
      const row = this.#readRow();
      this.#assertMonotonicClock(row, now);
      if (hasActiveLease(row) && row.desktop_expires_at_ms > now) {
        this.#observe(now);
        if (matchesClaim(row, normalized)) {
          return Object.freeze({
            disposition: "current" as const,
            lease: leaseFromRow(row),
          });
        }
        return Object.freeze({
          disposition: "busy" as const,
          retryAfterMs: row.desktop_expires_at_ms - now,
        });
      }

      const leaseId = validateIdentifier(this.#idSource.nextLeaseId(), "desktop lease ID");
      const nextFencingToken = row.last_fencing_token + 1;
      if (!Number.isSafeInteger(nextFencingToken)) {
        throw stateCorrupt();
      }
      this.#database
        .prepare(
          `UPDATE worker_desktop_authority
           SET last_observed_at_ms = ?,
               last_fencing_token = ?,
               task_id = ?,
               device_id = ?,
               run_id = ?,
               run_lease_id = ?,
               run_fencing_token = ?,
               desktop_lease_id = ?,
               desktop_expires_at_ms = ?
           WHERE singleton = 1`,
        )
        .run(
          now,
          nextFencingToken,
          normalized.taskId,
          normalized.deviceId,
          normalized.runId,
          normalized.runLeaseId,
          normalized.runFencingToken,
          leaseId,
          normalized.runLeaseExpiresAtMs,
        );
      return Object.freeze({
        disposition: "acquired" as const,
        lease: Object.freeze({
          resourceName: "desktop-session" as const,
          capacity: 1 as const,
          leaseId,
          fencingToken: nextFencingToken,
          expiresAtMs: normalized.runLeaseExpiresAtMs,
        }),
      });
    });
    return transaction.immediate();
  }

  /**
   * Returns the bounded scheduling projection allowed to leave this Device.
   * Lease IDs, fencing tokens, local database details, and helper credentials
   * deliberately remain inside the desktop authority.
   */
  public async resourceLockProjection(): Promise<WorkerDesktopResourceLockProjection> {
    this.#assertOpen();
    const now = this.#readClock();
    const transaction = this.#database.transaction((): WorkerDesktopResourceLockProjection => {
      const row = this.#readRow();
      this.#assertMonotonicClock(row, now);
      if (!hasActiveLease(row) || row.desktop_expires_at_ms <= now) {
        this.#expireOrObserve(row, now);
        return Object.freeze({
          resourceName: "desktop-session" as const,
          capacity: 1 as const,
          holders: Object.freeze([]),
        });
      }
      this.#observe(now);
      return Object.freeze({
        resourceName: "desktop-session" as const,
        capacity: 1 as const,
        holders: Object.freeze([
          Object.freeze({
            taskId: row.task_id,
            runId: row.run_id,
            expiresAtMs: row.desktop_expires_at_ms,
          }),
        ]),
      });
    });
    return transaction.immediate();
  }

  public async verify(request: DesktopLeaseRequest): Promise<DesktopLeaseResult> {
    this.#assertOpen();
    const normalized = validateDesktopLeaseRequest(request);
    const now = this.#readClock();
    const transaction = this.#database.transaction((): DesktopLeaseResult => {
      const row = this.#readRow();
      if (now < row.last_observed_at_ms) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "The desktop authority clock moved backwards.",
          verifiedAtMs: now,
        });
      }
      if (
        hasActiveLease(row) &&
        row.desktop_expires_at_ms > now &&
        matchesDesktopLeaseRequest(row, normalized)
      ) {
        this.#observe(now);
        return Object.freeze({
          status: "current" as const,
          leaseId: row.desktop_lease_id,
          fencingToken: row.last_fencing_token,
          verifiedAtMs: now,
        });
      }
      this.#expireOrObserve(row, now);
      return Object.freeze({
        status: "stale" as const,
        reason: "The desktop lease is not the current Device-wide owner.",
        verifiedAtMs: now,
      });
    });
    return transaction.immediate();
  }

  /**
   * Extends only the still-live exact desktop owner after its enclosing Main
   * Run lease advances. An elapsed/reassigned row is never resurrected.
   */
  public async renew(
    request: DesktopLeaseRequest,
    run: Pick<
      WorkerDesktopLeaseClaimInput,
      "runLeaseId" | "runFencingToken" | "runLeaseExpiresAtMs"
    >,
  ): Promise<WorkerDesktopLeaseRenewDisposition> {
    this.#assertOpen();
    const normalized = validateDesktopLeaseRequest(request);
    const renewedRun = validateRunLeaseRenewal(run);
    const now = this.#readClock();
    const transaction = this.#database.transaction((): WorkerDesktopLeaseRenewDisposition => {
      const row = this.#readRow();
      this.#assertMonotonicClock(row, now);
      if (
        !hasActiveLease(row) ||
        row.desktop_expires_at_ms <= now ||
        !matchesDesktopLeaseRequest(row, normalized) ||
        row.run_lease_id !== renewedRun.runLeaseId ||
        row.run_fencing_token !== renewedRun.runFencingToken ||
        renewedRun.runLeaseExpiresAtMs < row.desktop_expires_at_ms
      ) {
        this.#expireOrObserve(row, now);
        return Object.freeze({ disposition: "stale" as const });
      }
      if (renewedRun.runLeaseExpiresAtMs > row.desktop_expires_at_ms) {
        this.#database
          .prepare(
            `UPDATE worker_desktop_authority
             SET last_observed_at_ms = ?, desktop_expires_at_ms = ?
             WHERE singleton = 1`,
          )
          .run(now, renewedRun.runLeaseExpiresAtMs);
      } else {
        this.#observe(now);
      }
      return Object.freeze({
        disposition: "renewed" as const,
        lease: Object.freeze({
          ...normalized.lease,
          expiresAtMs: renewedRun.runLeaseExpiresAtMs,
        }),
      });
    });
    return transaction.immediate();
  }

  public async release(
    request: DesktopLeaseRequest,
  ): Promise<WorkerDesktopLeaseReleaseDisposition> {
    this.#assertOpen();
    const normalized = validateDesktopLeaseRequest(request);
    const now = this.#readClock();
    const transaction = this.#database.transaction((): WorkerDesktopLeaseReleaseDisposition => {
      const row = this.#readRow();
      this.#assertMonotonicClock(row, now);
      if (!hasActiveLease(row) || !matchesDesktopLeaseRequest(row, normalized)) {
        this.#expireOrObserve(row, now);
        return "stale";
      }
      this.#clearActiveLease(now);
      return "released";
    });
    return transaction.immediate();
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database.close();
  }

  #readRow(): DesktopAuthorityRow {
    const row = this.#database
      .prepare(
        `SELECT
           last_observed_at_ms,
           last_fencing_token,
           task_id,
           device_id,
           run_id,
           run_lease_id,
           run_fencing_token,
           desktop_lease_id,
           desktop_expires_at_ms
         FROM worker_desktop_authority
         WHERE singleton = 1`,
      )
      .get() as DesktopAuthorityRow | undefined;
    if (row === undefined || !validRow(row)) {
      throw stateCorrupt();
    }
    return row;
  }

  #observe(now: number): void {
    this.#database
      .prepare(
        `UPDATE worker_desktop_authority
         SET last_observed_at_ms = ?
         WHERE singleton = 1`,
      )
      .run(now);
  }

  #expireOrObserve(row: DesktopAuthorityRow, now: number): void {
    if (hasActiveLease(row) && row.desktop_expires_at_ms <= now) {
      this.#clearActiveLease(now);
      return;
    }
    this.#observe(now);
  }

  #clearActiveLease(now: number): void {
    this.#database
      .prepare(
        `UPDATE worker_desktop_authority
         SET last_observed_at_ms = ?,
             task_id = NULL,
             device_id = NULL,
             run_id = NULL,
             run_lease_id = NULL,
             run_fencing_token = NULL,
             desktop_lease_id = NULL,
             desktop_expires_at_ms = NULL
         WHERE singleton = 1`,
      )
      .run(now);
  }

  #assertMonotonicClock(row: DesktopAuthorityRow, now: number): void {
    if (now < row.last_observed_at_ms) {
      throw new WorkerDesktopLeaseAuthorityError(
        "CLOCK_ROLLBACK",
        "The desktop authority clock moved backwards.",
      );
    }
  }

  #readClock(): number {
    const now = this.#clock.now();
    if (!validTimestamp(now)) {
      throw new WorkerDesktopLeaseAuthorityError(
        "INVALID_INPUT",
        "The desktop authority clock returned an invalid timestamp.",
      );
    }
    return now;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WorkerDesktopLeaseAuthorityError(
        "AUTHORITY_CLOSED",
        "The desktop lease authority is closed.",
      );
    }
  }
}

function validateRuntimePath(options: SqliteWorkerDesktopLeaseAuthorityOptions): string {
  if (
    typeof options.filename !== "string" ||
    !isAbsolute(options.filename) ||
    typeof options.sourceCheckoutDirectory !== "string" ||
    !isAbsolute(options.sourceCheckoutDirectory)
  ) {
    throw new WorkerDesktopLeaseAuthorityError(
      "INVALID_RUNTIME_PATH",
      "Desktop authority paths must be absolute.",
    );
  }
  const filename = resolve(options.filename);
  const checkout = resolve(options.sourceCheckoutDirectory);
  if (isWithin(checkout, filename)) {
    throw new WorkerDesktopLeaseAuthorityError(
      "INVALID_RUNTIME_PATH",
      "Desktop authority state must remain outside the source checkout.",
    );
  }
  mkdirSync(dirname(filename), { recursive: true });
  if (existsSync(filename)) {
    const metadata = lstatSync(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new WorkerDesktopLeaseAuthorityError(
        "INVALID_RUNTIME_PATH",
        "The desktop authority database must be a regular non-symbolic-link file.",
      );
    }
  }
  const realParent = realpathSync(dirname(filename));
  const realCheckout = realpathSync(checkout);
  if (isWithin(realCheckout, realParent)) {
    throw new WorkerDesktopLeaseAuthorityError(
      "INVALID_RUNTIME_PATH",
      "Desktop authority state must remain outside the source checkout.",
    );
  }
  return filename;
}

function validateClaimInput(
  input: WorkerDesktopLeaseClaimInput,
  now: number,
): WorkerDesktopLeaseClaimInput {
  const normalized = Object.freeze({
    taskId: validateIdentifier(input.taskId, "Task ID"),
    deviceId: validateIdentifier(input.deviceId, "Device ID"),
    runId: validateIdentifier(input.runId, "Run ID"),
    runLeaseId: validateIdentifier(input.runLeaseId, "Run lease ID"),
    runFencingToken: input.runFencingToken,
    runLeaseExpiresAtMs: input.runLeaseExpiresAtMs,
  });
  if (!Number.isSafeInteger(normalized.runFencingToken) || normalized.runFencingToken <= 0) {
    throw new WorkerDesktopLeaseAuthorityError(
      "INVALID_INPUT",
      "Run fencing token must be a positive safe integer.",
    );
  }
  if (!validTimestamp(normalized.runLeaseExpiresAtMs) || normalized.runLeaseExpiresAtMs <= now) {
    throw new WorkerDesktopLeaseAuthorityError(
      "INVALID_INPUT",
      "Run lease must remain current when the desktop is claimed.",
    );
  }
  return normalized;
}

function validateRunLeaseRenewal(
  input: Pick<
    WorkerDesktopLeaseClaimInput,
    "runLeaseId" | "runFencingToken" | "runLeaseExpiresAtMs"
  >,
) {
  const normalized = Object.freeze({
    runLeaseId: validateIdentifier(input.runLeaseId, "Run lease ID"),
    runFencingToken: input.runFencingToken,
    runLeaseExpiresAtMs: input.runLeaseExpiresAtMs,
  });
  if (
    !Number.isSafeInteger(normalized.runFencingToken) ||
    normalized.runFencingToken <= 0 ||
    !validTimestamp(normalized.runLeaseExpiresAtMs)
  ) {
    throw new WorkerDesktopLeaseAuthorityError(
      "INVALID_INPUT",
      "The renewed Run lease is invalid.",
    );
  }
  return normalized;
}

function validateDesktopLeaseRequest(request: DesktopLeaseRequest): DesktopLeaseRequest {
  const normalized = Object.freeze({
    taskId: validateIdentifier(request.taskId, "Task ID"),
    deviceId: validateIdentifier(request.deviceId, "Device ID"),
    runId: validateIdentifier(request.runId, "Run ID"),
    lease: Object.freeze({
      resourceName: request.lease.resourceName,
      capacity: request.lease.capacity,
      leaseId: validateIdentifier(request.lease.leaseId, "desktop lease ID"),
      fencingToken: request.lease.fencingToken,
      expiresAtMs: request.lease.expiresAtMs,
    }),
  });
  if (
    normalized.lease.resourceName !== "desktop-session" ||
    normalized.lease.capacity !== 1 ||
    !Number.isSafeInteger(normalized.lease.fencingToken) ||
    normalized.lease.fencingToken <= 0 ||
    !validTimestamp(normalized.lease.expiresAtMs)
  ) {
    throw new WorkerDesktopLeaseAuthorityError(
      "INVALID_INPUT",
      "The desktop lease request is invalid.",
    );
  }
  return normalized;
}

function validRow(row: DesktopAuthorityRow): boolean {
  if (
    !validTimestamp(row.last_observed_at_ms) ||
    !Number.isSafeInteger(row.last_fencing_token) ||
    row.last_fencing_token < 0
  ) {
    return false;
  }
  const values = [
    row.task_id,
    row.device_id,
    row.run_id,
    row.run_lease_id,
    row.run_fencing_token,
    row.desktop_lease_id,
    row.desktop_expires_at_ms,
  ];
  if (values.every((value) => value === null)) {
    return true;
  }
  if (values.some((value) => value === null)) {
    return false;
  }
  try {
    validateIdentifier(row.task_id, "Task ID");
    validateIdentifier(row.device_id, "Device ID");
    validateIdentifier(row.run_id, "Run ID");
    validateIdentifier(row.run_lease_id, "Run lease ID");
    validateIdentifier(row.desktop_lease_id, "desktop lease ID");
  } catch {
    return false;
  }
  return (
    Number.isSafeInteger(row.run_fencing_token) &&
    Number(row.run_fencing_token) > 0 &&
    validTimestamp(row.desktop_expires_at_ms) &&
    row.last_fencing_token > 0
  );
}

function hasActiveLease(row: DesktopAuthorityRow): row is DesktopAuthorityRow & {
  readonly task_id: string;
  readonly device_id: string;
  readonly run_id: string;
  readonly run_lease_id: string;
  readonly run_fencing_token: number;
  readonly desktop_lease_id: string;
  readonly desktop_expires_at_ms: number;
} {
  return row.task_id !== null;
}

function matchesClaim(
  row: DesktopAuthorityRow & {
    readonly task_id: string;
    readonly device_id: string;
    readonly run_id: string;
    readonly run_lease_id: string;
    readonly run_fencing_token: number;
    readonly desktop_lease_id: string;
    readonly desktop_expires_at_ms: number;
  },
  input: WorkerDesktopLeaseClaimInput,
): boolean {
  return (
    row.task_id === input.taskId &&
    row.device_id === input.deviceId &&
    row.run_id === input.runId &&
    row.run_lease_id === input.runLeaseId &&
    row.run_fencing_token === input.runFencingToken &&
    row.desktop_expires_at_ms === input.runLeaseExpiresAtMs
  );
}

function matchesDesktopLeaseRequest(
  row: DesktopAuthorityRow & {
    readonly task_id: string;
    readonly device_id: string;
    readonly run_id: string;
    readonly run_lease_id: string;
    readonly run_fencing_token: number;
    readonly desktop_lease_id: string;
    readonly desktop_expires_at_ms: number;
  },
  request: DesktopLeaseRequest,
): boolean {
  return (
    row.task_id === request.taskId &&
    row.device_id === request.deviceId &&
    row.run_id === request.runId &&
    row.desktop_lease_id === request.lease.leaseId &&
    row.last_fencing_token === request.lease.fencingToken &&
    row.desktop_expires_at_ms === request.lease.expiresAtMs
  );
}

function leaseFromRow(
  row: DesktopAuthorityRow & {
    readonly desktop_lease_id: string;
    readonly desktop_expires_at_ms: number;
  },
): DesktopLease {
  return Object.freeze({
    resourceName: "desktop-session",
    capacity: 1,
    leaseId: row.desktop_lease_id,
    fencingToken: row.last_fencing_token,
    expiresAtMs: row.desktop_expires_at_ms,
  });
}

function validateIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_IDENTIFIER_BYTES
  ) {
    throw new WorkerDesktopLeaseAuthorityError(
      "INVALID_INPUT",
      `${label} must be a bounded non-blank identifier.`,
    );
  }
  return value;
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAXIMUM_TIMESTAMP_MS;
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function stateCorrupt(): WorkerDesktopLeaseAuthorityError {
  return new WorkerDesktopLeaseAuthorityError(
    "STATE_CORRUPT",
    "The desktop authority state is corrupt.",
  );
}
