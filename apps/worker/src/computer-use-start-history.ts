import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type {
  ComputerUseStartClaim,
  ComputerUseStartHistory,
  ComputerUseStartRecord,
} from "@opendelegate/computer-use-os";
import Database from "better-sqlite3";

const MAXIMUM_IDENTIFIER_BYTES = 512;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface SqliteComputerUseStartHistoryOptions {
  readonly filename: string;
  readonly sourceCheckoutDirectory: string;
}

export class SqliteComputerUseStartHistoryError extends Error {
  public readonly code:
    "HISTORY_CLOSED" | "INVALID_INPUT" | "INVALID_RUNTIME_PATH" | "STATE_CORRUPT";

  public constructor(code: SqliteComputerUseStartHistoryError["code"]) {
    super(
      code === "HISTORY_CLOSED"
        ? "The Computer Use start history is closed."
        : code === "INVALID_INPUT"
          ? "The Computer Use start record is invalid."
          : code === "INVALID_RUNTIME_PATH"
            ? "The Computer Use start history path is unsafe."
            : "The Computer Use start history is corrupt.",
    );
    this.name = "SqliteComputerUseStartHistoryError";
    this.code = code;
  }
}

/**
 * Durable replay barrier for native Computer Use controller creation.
 *
 * A command ID is never reusable after this transaction commits. An exact
 * replay therefore tells the OS backend to fail closed after process restart;
 * only a fresh Main command and Run/fence may create another controller.
 */
export class SqliteComputerUseStartHistory implements ComputerUseStartHistory {
  readonly #database: Database.Database;
  #closed = false;

  public constructor(options: SqliteComputerUseStartHistoryOptions) {
    const filename = validateRuntimePath(options);
    let database: Database.Database | undefined;
    try {
      database = new Database(filename);
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.pragma("busy_timeout = 5000");
      const quickCheck = database.pragma("quick_check") as readonly {
        readonly quick_check?: unknown;
      }[];
      if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
        throw new SqliteComputerUseStartHistoryError("STATE_CORRUPT");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS computer_use_start_history (
          command_id TEXT PRIMARY KEY,
          start_fingerprint TEXT NOT NULL,
          execution_handle_id TEXT NOT NULL,
          recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
        ) STRICT;
      `);
      this.#database = database;
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Best-effort cleanup after SQLite rejected corrupt state.
      }
      throw error instanceof SqliteComputerUseStartHistoryError
        ? error
        : new SqliteComputerUseStartHistoryError("STATE_CORRUPT");
    }
  }

  public async claim(input: ComputerUseStartRecord): Promise<ComputerUseStartClaim> {
    this.#assertOpen();
    const record = validateRecord(input);
    try {
      const transaction = this.#database.transaction((): ComputerUseStartClaim => {
        const insert = this.#database
          .prepare(
            `INSERT OR IGNORE INTO computer_use_start_history (
               command_id,
               start_fingerprint,
               execution_handle_id,
               recorded_at_ms
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            record.commandId,
            record.startFingerprint,
            record.executionHandleId,
            record.recordedAtMs,
          );
        const stored = readRecord(this.#database, record.commandId);
        if (insert.changes === 1) {
          return Object.freeze({ disposition: "created" as const, record: stored });
        }
        const disposition =
          stored.startFingerprint === record.startFingerprint &&
          stored.executionHandleId === record.executionHandleId
            ? ("replay" as const)
            : ("conflict" as const);
        return Object.freeze({ disposition, record: stored });
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof SqliteComputerUseStartHistoryError) {
        throw error;
      }
      throw new SqliteComputerUseStartHistoryError("STATE_CORRUPT");
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SqliteComputerUseStartHistoryError("HISTORY_CLOSED");
    }
  }
}

function readRecord(database: Database.Database, commandId: string): ComputerUseStartRecord {
  const row = database
    .prepare(
      `SELECT command_id, start_fingerprint, execution_handle_id, recorded_at_ms
       FROM computer_use_start_history
       WHERE command_id = ?`,
    )
    .get(commandId) as
    | {
        readonly command_id: unknown;
        readonly start_fingerprint: unknown;
        readonly execution_handle_id: unknown;
        readonly recorded_at_ms: unknown;
      }
    | undefined;
  if (row === undefined) {
    throw new SqliteComputerUseStartHistoryError("STATE_CORRUPT");
  }
  try {
    return validateRecord({
      commandId: row.command_id as string,
      startFingerprint: row.start_fingerprint as `sha256:${string}`,
      executionHandleId: row.execution_handle_id as string,
      recordedAtMs: row.recorded_at_ms as number,
    });
  } catch {
    throw new SqliteComputerUseStartHistoryError("STATE_CORRUPT");
  }
}

function validateRecord(input: ComputerUseStartRecord): ComputerUseStartRecord {
  if (
    !validIdentifier(input.commandId) ||
    !validIdentifier(input.executionHandleId) ||
    typeof input.startFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(input.startFingerprint) ||
    !Number.isSafeInteger(input.recordedAtMs) ||
    input.recordedAtMs < 0 ||
    input.recordedAtMs > MAXIMUM_TIMESTAMP_MS
  ) {
    throw new SqliteComputerUseStartHistoryError("INVALID_INPUT");
  }
  return Object.freeze({
    commandId: input.commandId,
    startFingerprint: input.startFingerprint,
    executionHandleId: input.executionHandleId,
    recordedAtMs: input.recordedAtMs,
  });
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_IDENTIFIER_BYTES
  );
}

function validateRuntimePath(options: SqliteComputerUseStartHistoryOptions): string {
  if (!isAbsolute(options.filename) || !isAbsolute(options.sourceCheckoutDirectory)) {
    throw new SqliteComputerUseStartHistoryError("INVALID_RUNTIME_PATH");
  }
  const filename = resolve(options.filename);
  const checkout = resolve(options.sourceCheckoutDirectory);
  if (isWithin(checkout, filename)) {
    throw new SqliteComputerUseStartHistoryError("INVALID_RUNTIME_PATH");
  }
  mkdirSync(dirname(filename), { recursive: true });
  if (existsSync(filename)) {
    const metadata = lstatSync(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new SqliteComputerUseStartHistoryError("INVALID_RUNTIME_PATH");
    }
  }
  const realParent = realpathSync(dirname(filename));
  const realCheckout = realpathSync(checkout);
  if (isWithin(realCheckout, realParent)) {
    throw new SqliteComputerUseStartHistoryError("INVALID_RUNTIME_PATH");
  }
  return filename;
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}
