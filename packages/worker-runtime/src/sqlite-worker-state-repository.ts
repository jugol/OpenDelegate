import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  WorkerRuntimeError,
  configurationFingerprint,
  validateWorkerConfiguration,
} from "./contracts.ts";
import {
  cloneWorkerState,
  type PersistedWorkerState,
  type WorkerStateRepository,
} from "./state-repository.ts";

export interface SqliteWorkerStateRepositoryOptions {
  readonly filename: string;
  readonly sourceCheckoutDirectory?: string;
}

interface StateRow {
  readonly generation: number;
  readonly document: string;
  readonly checksum: string;
}

export class SqliteWorkerStateRepository implements WorkerStateRepository {
  private readonly database: Database.Database;
  private closed = false;

  public constructor(options: SqliteWorkerStateRepositoryOptions) {
    const filename = validateRuntimePath(options);
    mkdirSync(dirname(filename), { recursive: true });
    this.database = new Database(filename);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("wal_autocheckpoint = 1000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS worker_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        document TEXT NOT NULL,
        checksum TEXT NOT NULL
      ) STRICT
    `);
  }

  public async initialize(initialState: PersistedWorkerState): Promise<PersistedWorkerState> {
    this.assertOpen();
    const transaction = this.database.transaction(() => {
      const state = cloneWorkerState(initialState);
      const document = JSON.stringify(state);
      this.database
        .prepare(
          `INSERT OR IGNORE INTO worker_state (singleton, generation, document, checksum)
           VALUES (1, ?, ?, ?)`,
        )
        .run(state.generation, document, checksum(document));
      const stored = this.selectRow();
      if (stored === undefined) {
        throw new WorkerRuntimeError("STATE_CORRUPT", "Worker state could not be initialized.");
      }
      return decodeState(stored);
    });
    return cloneWorkerState(transaction());
  }

  public async read(): Promise<PersistedWorkerState> {
    this.assertOpen();
    const row = this.selectRow();
    if (row === undefined) {
      throw new WorkerRuntimeError("STATE_CORRUPT", "Worker state has not been initialized.");
    }
    return cloneWorkerState(decodeState(row));
  }

  public async compareAndSwap(
    expectedGeneration: number,
    nextState: PersistedWorkerState,
  ): Promise<boolean> {
    this.assertOpen();
    const transaction = this.database.transaction(() => {
      const current = this.selectRow();
      if (current === undefined) {
        throw new WorkerRuntimeError("STATE_CORRUPT", "Worker state has not been initialized.");
      }
      if (current.generation !== expectedGeneration) {
        return false;
      }
      if (nextState.generation !== expectedGeneration + 1) {
        throw new WorkerRuntimeError(
          "STATE_CORRUPT",
          "Worker state generation must advance exactly once.",
        );
      }
      const document = JSON.stringify(nextState);
      const result = this.database
        .prepare(
          `UPDATE worker_state
           SET generation = ?, document = ?, checksum = ?
           WHERE singleton = 1 AND generation = ?`,
        )
        .run(nextState.generation, document, checksum(document), expectedGeneration);
      return result.changes === 1;
    });
    return transaction();
  }

  public close(): void {
    if (!this.closed) {
      this.closed = true;
      this.database.close();
    }
  }

  private selectRow(): StateRow | undefined {
    return this.database
      .prepare("SELECT generation, document, checksum FROM worker_state WHERE singleton = 1")
      .get() as StateRow | undefined;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WorkerRuntimeError("REPOSITORY_CLOSED", "Worker state repository is closed.");
    }
  }
}

export function createSqliteWorkerStateRepository(
  options: SqliteWorkerStateRepositoryOptions,
): SqliteWorkerStateRepository {
  return new SqliteWorkerStateRepository(options);
}

function validateRuntimePath(options: SqliteWorkerStateRepositoryOptions): string {
  if (
    typeof options.filename !== "string" ||
    options.filename.length === 0 ||
    !isAbsolute(options.filename)
  ) {
    throw new WorkerRuntimeError(
      "INVALID_RUNTIME_PATH",
      "Worker runtime database path must be absolute.",
    );
  }
  const filename = resolve(options.filename);
  if (options.sourceCheckoutDirectory !== undefined) {
    if (!isAbsolute(options.sourceCheckoutDirectory)) {
      throw new WorkerRuntimeError(
        "INVALID_RUNTIME_PATH",
        "Source checkout path must be absolute when supplied.",
      );
    }
    const checkout = resolve(options.sourceCheckoutDirectory);
    const pathFromCheckout = relative(checkout, filename);
    if (
      pathFromCheckout === "" ||
      (!pathFromCheckout.startsWith("..") && !isAbsolute(pathFromCheckout))
    ) {
      throw new WorkerRuntimeError(
        "INVALID_RUNTIME_PATH",
        "Worker runtime state must remain outside the source checkout.",
      );
    }
  }
  return filename;
}

function decodeState(row: StateRow): PersistedWorkerState {
  if (checksum(row.document) !== row.checksum) {
    throw new WorkerRuntimeError("STATE_CORRUPT", "Worker state checksum does not match.");
  }
  let state: unknown;
  try {
    state = JSON.parse(row.document);
  } catch {
    throw new WorkerRuntimeError("STATE_CORRUPT", "Worker state is not valid JSON.");
  }
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw corruptState();
  }
  const record = state as Record<string, unknown>;
  if (
    record["schemaVersion"] !== 1 ||
    record["generation"] !== row.generation ||
    !Number.isSafeInteger(record["generation"]) ||
    (record["generation"] as number) < 0 ||
    !Number.isSafeInteger(record["lastObservedAtMs"]) ||
    (record["lastObservedAtMs"] as number) < 0 ||
    !isOperationalState(record["operationalState"]) ||
    !Array.isArray(record["inbox"]) ||
    !Array.isArray(record["runs"]) ||
    !Array.isArray(record["outbox"]) ||
    !Number.isSafeInteger(record["nextOutboxSequence"]) ||
    (record["nextOutboxSequence"] as number) <= 0
  ) {
    throw corruptState();
  }
  let configuration;
  try {
    configuration = validateWorkerConfiguration(
      record["configuration"] as PersistedWorkerState["configuration"],
    );
  } catch {
    throw corruptState();
  }
  if (
    record["configurationFingerprint"] !== configurationFingerprint(configuration) ||
    record["outbox"].length > configuration.maxOutboxEntries
  ) {
    throw corruptState();
  }

  let priorSequence = 0;
  const messageIds = new Set<string>();
  for (const value of record["outbox"]) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw corruptState();
    }
    const entry = value as Record<string, unknown>;
    const event = entry["event"];
    if (
      !Number.isSafeInteger(entry["sequence"]) ||
      (entry["sequence"] as number) <= priorSequence ||
      event === null ||
      typeof event !== "object" ||
      Array.isArray(event)
    ) {
      throw corruptState();
    }
    const messageId = (event as Record<string, unknown>)["messageId"];
    if (typeof messageId !== "string" || messageIds.has(messageId)) {
      throw corruptState();
    }
    messageIds.add(messageId);
    priorSequence = entry["sequence"] as number;
  }
  if ((record["nextOutboxSequence"] as number) <= priorSequence) {
    throw corruptState();
  }

  return record as unknown as PersistedWorkerState;
}

function checksum(document: string): string {
  return createHash("sha256").update(document).digest("hex");
}

function isOperationalState(value: unknown): boolean {
  return value === "active" || value === "disabled" || value === "draining" || value === "revoked";
}

function corruptState(): WorkerRuntimeError {
  return new WorkerRuntimeError(
    "STATE_CORRUPT",
    "Worker state is incompatible or structurally invalid.",
  );
}
