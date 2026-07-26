import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ManagedSecretStore } from "@opendelegate/secrets";
import Database from "better-sqlite3";
import { Client } from "pg";

import { executeWithPostgresUri } from "./database-secret.ts";

const SQLITE_OWNERSHIP_FILENAME = "main-singleton-ownership.sqlite3";
const DEFAULT_POSTGRES_HEARTBEAT_INTERVAL_MS = 1_000;
const MINIMUM_POSTGRES_HEARTBEAT_INTERVAL_MS = 100;
const MAXIMUM_POSTGRES_HEARTBEAT_INTERVAL_MS = 60_000;
const POSTGRES_TRY_LOCK_SQL = "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired";
const POSTGRES_UNLOCK_SQL = "SELECT pg_advisory_unlock($1::integer, $2::integer) AS released";
const POSTGRES_HEARTBEAT_SQL = "SELECT TRUE AS alive";

export type MainSingletonOwnershipErrorCode =
  "MAIN_ALREADY_RUNNING" | "MAIN_OWNERSHIP_LOST" | "MAIN_OWNERSHIP_UNAVAILABLE";

export class MainSingletonOwnershipError extends Error {
  public readonly code: MainSingletonOwnershipErrorCode;

  public constructor(
    code: MainSingletonOwnershipErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MainSingletonOwnershipError";
    this.code = code;
  }
}

export type MainSingletonOwnershipDatabase =
  | {
      readonly adapter: "sqlite";
    }
  | {
      readonly adapter: "postgresql";
      readonly uriRef: string;
      readonly schema?: string;
    };

export interface AcquireMainSingletonOwnershipInput {
  readonly database: MainSingletonOwnershipDatabase;
  readonly stateDirectory: string;
  readonly secretStore?: ManagedSecretStore;
}

export interface MainSingletonOwnership {
  readonly backend: "sqlite" | "postgresql";
  assertCurrent(): void;
  onLost(listener: (error: MainSingletonOwnershipError) => void): () => void;
  release(): Promise<void>;
}

export type MainSingletonOwnershipFactory = (
  input: AcquireMainSingletonOwnershipInput,
) => Promise<MainSingletonOwnership>;

export interface PostgreSqlOwnershipClient {
  connect(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "end", listener: () => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  off(event: "end", listener: () => void): void;
}

export interface MainSingletonOwnershipDependencies {
  readonly sqliteFactory?: (filename: string) => Database.Database;
  readonly postgresClientFactory?: (connectionString: string) => PostgreSqlOwnershipClient;
  readonly postgresHeartbeatIntervalMs?: number;
}

/**
 * Acquires one process-lifetime Main authority before reconciliation or listener
 * startup. SQLite uses a dedicated lock database so its lifetime transaction
 * never blocks application writes. PostgreSQL uses a session advisory lock scoped
 * to the configured schema; the server releases it when that dedicated session
 * ends or the process crashes.
 */
export async function acquireMainSingletonOwnership(
  input: AcquireMainSingletonOwnershipInput,
  dependencies: MainSingletonOwnershipDependencies = {},
): Promise<MainSingletonOwnership> {
  const stateDirectory = validateStateDirectory(input.stateDirectory);
  if (input.database.adapter === "sqlite") {
    return acquireSqliteOwnership(
      join(stateDirectory, SQLITE_OWNERSHIP_FILENAME),
      dependencies.sqliteFactory ?? ((filename) => new Database(filename, { timeout: 1 })),
    );
  }
  if (input.secretStore === undefined) {
    throw ownershipUnavailable("The Main database Secret Store is unavailable.");
  }
  return acquirePostgresOwnership(
    {
      database: input.database,
      stateDirectory,
      secretStore: input.secretStore,
    },
    dependencies,
  );
}

abstract class LossAwareOwnership implements MainSingletonOwnership {
  public abstract readonly backend: "sqlite" | "postgresql";

  readonly #listeners = new Set<(error: MainSingletonOwnershipError) => void>();
  #state: "active" | "lost" | "released" | "releasing" = "active";
  #loss: MainSingletonOwnershipError | undefined;

  public assertCurrent(): void {
    if (this.#state !== "active") {
      throw (
        this.#loss ??
        new MainSingletonOwnershipError(
          "MAIN_OWNERSHIP_LOST",
          "This process no longer owns the Main singleton authority.",
        )
      );
    }
  }

  public onLost(listener: (error: MainSingletonOwnershipError) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("The Main ownership loss listener is invalid.");
    }
    this.#listeners.add(listener);
    const loss = this.#loss;
    if (loss !== undefined) {
      queueMicrotask(() => {
        if (this.#listeners.has(listener)) {
          safelyNotify(listener, loss);
        }
      });
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  protected beginRelease(): "already-released" | "lost" | "release" {
    if (this.#state === "released" || this.#state === "releasing") {
      return "already-released";
    }
    if (this.#state === "lost") {
      this.#state = "releasing";
      return "lost";
    }
    this.#state = "releasing";
    return "release";
  }

  protected finishRelease(): void {
    this.#state = "released";
    this.#listeners.clear();
  }

  protected markLost(cause?: unknown): void {
    if (this.#state !== "active") {
      return;
    }
    const loss = new MainSingletonOwnershipError(
      "MAIN_OWNERSHIP_LOST",
      "The process lost its exclusive Main singleton authority and must stop.",
      cause === undefined ? undefined : { cause },
    );
    this.#state = "lost";
    this.#loss = loss;
    for (const listener of this.#listeners) {
      safelyNotify(listener, loss);
    }
  }

  public abstract release(): Promise<void>;
}

class SqliteMainSingletonOwnership extends LossAwareOwnership {
  public readonly backend = "sqlite" as const;

  readonly #database: Database.Database;
  #releasePromise: Promise<void> | undefined;

  public constructor(database: Database.Database) {
    super();
    this.#database = database;
  }

  public release(): Promise<void> {
    this.#releasePromise ??= this.#release();
    return this.#releasePromise;
  }

  async #release(): Promise<void> {
    const disposition = this.beginRelease();
    if (disposition === "already-released") {
      return;
    }
    try {
      if (this.#database.open && this.#database.inTransaction) {
        this.#database.exec("ROLLBACK");
      }
    } catch (error) {
      throw ownershipUnavailable("The SQLite Main ownership lock could not be released.", error);
    } finally {
      if (this.#database.open) {
        this.#database.close();
      }
      this.finishRelease();
    }
  }
}

class PostgresMainSingletonOwnership extends LossAwareOwnership {
  public readonly backend = "postgresql" as const;

  readonly #client: PostgreSqlOwnershipClient;
  readonly #keys: readonly [number, number];
  readonly #heartbeatIntervalMs: number;
  readonly #onClientError: (error: Error) => void;
  readonly #onClientEnd: () => void;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #heartbeatInFlight = false;
  #releasePromise: Promise<void> | undefined;

  public constructor(
    client: PostgreSqlOwnershipClient,
    keys: readonly [number, number],
    heartbeatIntervalMs: number,
  ) {
    super();
    this.#client = client;
    this.#keys = keys;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#onClientError = (error) => {
      this.#stopHeartbeat();
      this.markLost(error);
    };
    this.#onClientEnd = () => {
      this.#stopHeartbeat();
      this.markLost(new Error("The PostgreSQL Main ownership session ended."));
    };
    client.on("error", this.#onClientError);
    client.on("end", this.#onClientEnd);
    this.#heartbeat = setInterval(() => {
      void this.#verifySession();
    }, this.#heartbeatIntervalMs);
    this.#heartbeat.unref();
  }

  public release(): Promise<void> {
    this.#releasePromise ??= this.#release();
    return this.#releasePromise;
  }

  async #release(): Promise<void> {
    const disposition = this.beginRelease();
    if (disposition === "already-released") {
      return;
    }
    this.#stopHeartbeat();
    this.#client.off("error", this.#onClientError);
    this.#client.off("end", this.#onClientEnd);
    let failure: unknown;
    try {
      if (disposition === "release") {
        const result = await this.#client.query(POSTGRES_UNLOCK_SQL, this.#keys);
        if (!readSingleBoolean(result.rows, "released")) {
          throw new Error("The PostgreSQL advisory lock was no longer held.");
        }
      }
    } catch (error) {
      failure = error;
    }
    try {
      await this.#client.end();
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], "The Main ownership session could not close.");
    } finally {
      this.finishRelease();
    }
    if (failure !== undefined) {
      throw ownershipUnavailable(
        "The PostgreSQL Main ownership session could not be released cleanly.",
        failure,
      );
    }
  }

  async #verifySession(): Promise<void> {
    if (this.#heartbeatInFlight) {
      return;
    }
    try {
      this.assertCurrent();
    } catch {
      return;
    }
    this.#heartbeatInFlight = true;
    try {
      const result = await this.#client.query(POSTGRES_HEARTBEAT_SQL);
      if (!readSingleBoolean(result.rows, "alive")) {
        throw new Error("The PostgreSQL Main ownership heartbeat was invalid.");
      }
    } catch (error) {
      this.#stopHeartbeat();
      this.markLost(error);
    } finally {
      this.#heartbeatInFlight = false;
    }
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }
}

async function acquireSqliteOwnership(
  filename: string,
  factory: (filename: string) => Database.Database,
): Promise<MainSingletonOwnership> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  let database: Database.Database | undefined;
  try {
    database = factory(filename);
    database.pragma("busy_timeout = 1");
    database.pragma("journal_mode = DELETE");
    database.pragma("synchronous = FULL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS main_singleton_identity (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1)
      ) STRICT;
      INSERT OR IGNORE INTO main_singleton_identity (singleton_id, schema_version)
      VALUES (1, 1);
    `);
    await chmod(filename, 0o600);
    database.exec("BEGIN EXCLUSIVE");
    return new SqliteMainSingletonOwnership(database);
  } catch (error) {
    if (database?.open) {
      database.close();
    }
    if (isSqliteBusy(error)) {
      throw new MainSingletonOwnershipError(
        "MAIN_ALREADY_RUNNING",
        "Another Main process already owns this installation.",
      );
    }
    throw ownershipUnavailable("The SQLite Main ownership lock could not be acquired.", error);
  }
}

async function acquirePostgresOwnership(
  input: AcquireMainSingletonOwnershipInput & {
    readonly database: Extract<MainSingletonOwnershipDatabase, { readonly adapter: "postgresql" }>;
    readonly secretStore: ManagedSecretStore;
  },
  dependencies: MainSingletonOwnershipDependencies,
): Promise<MainSingletonOwnership> {
  const heartbeatIntervalMs = validateHeartbeatInterval(
    dependencies.postgresHeartbeatIntervalMs ?? DEFAULT_POSTGRES_HEARTBEAT_INTERVAL_MS,
  );
  const clientFactory =
    dependencies.postgresClientFactory ??
    ((connectionString: string) => new NodePostgreSqlOwnershipClient(connectionString));
  const keys = postgresLockKeys(input.database.schema);
  let ownership: MainSingletonOwnership | undefined;
  let acquisitionError: unknown;
  try {
    await executeWithPostgresUri(input.secretStore, input.database.uriRef, async (uri) => {
      let client: PostgreSqlOwnershipClient | undefined;
      let earlyError: unknown;
      let earlyEnd = false;
      const onEarlyError = (error: Error): void => {
        earlyError = error;
      };
      const onEarlyEnd = (): void => {
        earlyEnd = true;
      };
      try {
        client = clientFactory(uri);
        client.on("error", onEarlyError);
        client.on("end", onEarlyEnd);
        await client.connect();
        const result = await client.query(POSTGRES_TRY_LOCK_SQL, keys);
        if (earlyError !== undefined || earlyEnd) {
          throw earlyError ?? new Error("The PostgreSQL ownership session ended during startup.");
        }
        if (!readSingleBoolean(result.rows, "acquired")) {
          acquisitionError = new MainSingletonOwnershipError(
            "MAIN_ALREADY_RUNNING",
            "Another Main process already owns this PostgreSQL installation.",
          );
          return;
        }
        const acquired = new PostgresMainSingletonOwnership(client, keys, heartbeatIntervalMs);
        client.off("error", onEarlyError);
        client.off("end", onEarlyEnd);
        if (earlyError !== undefined || earlyEnd) {
          await acquired.release().catch(() => undefined);
          throw earlyError ?? new Error("The PostgreSQL ownership session ended during startup.");
        }
        ownership = acquired;
        client = undefined;
      } catch (error) {
        acquisitionError ??= error;
      } finally {
        if (client !== undefined) {
          client.off("error", onEarlyError);
          client.off("end", onEarlyEnd);
          await client.end().catch(() => undefined);
        }
      }
    });
  } catch (error) {
    acquisitionError ??= error;
  }
  if (acquisitionError !== undefined) {
    if (acquisitionError instanceof MainSingletonOwnershipError) {
      throw acquisitionError;
    }
    throw ownershipUnavailable(
      "The PostgreSQL Main ownership session could not be acquired.",
      acquisitionError,
    );
  }
  if (ownership === undefined) {
    throw ownershipUnavailable("The PostgreSQL Main ownership session returned no authority.");
  }
  return ownership;
}

class NodePostgreSqlOwnershipClient implements PostgreSqlOwnershipClient {
  readonly #client: Client;

  public constructor(connectionString: string) {
    this.#client = new Client({
      connectionString,
      application_name: "opendelegate-main-ownership",
      keepAlive: true,
      keepAliveInitialDelayMillis: 1_000,
    });
  }

  public async connect(): Promise<void> {
    await this.#client.connect();
  }

  public async query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[] }> {
    const result = await this.#client.query(text, values === undefined ? undefined : [...values]);
    return { rows: result.rows as readonly Readonly<Record<string, unknown>>[] };
  }

  public end(): Promise<void> {
    return this.#client.end();
  }

  public on(event: "error", listener: (error: Error) => void): void;
  public on(event: "end", listener: () => void): void;
  public on(event: "error" | "end", listener: ((error: Error) => void) | (() => void)): void {
    this.#client.on(event, listener);
  }

  public off(event: "error", listener: (error: Error) => void): void;
  public off(event: "end", listener: () => void): void;
  public off(event: "error" | "end", listener: ((error: Error) => void) | (() => void)): void {
    this.#client.off(event, listener);
  }
}

function validateStateDirectory(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError("The Main ownership state directory must be absolute.");
  }
  return resolve(value);
}

function validateHeartbeatInterval(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_POSTGRES_HEARTBEAT_INTERVAL_MS ||
    value > MAXIMUM_POSTGRES_HEARTBEAT_INTERVAL_MS
  ) {
    throw new TypeError("The PostgreSQL Main ownership heartbeat interval is invalid.");
  }
  return value;
}

function postgresLockKeys(schema: string | undefined): readonly [number, number] {
  const digest = createHash("sha256")
    .update("opendelegate-main-singleton-ownership-v1\0", "utf8")
    .update(schema ?? "<connection-default-schema>", "utf8")
    .digest();
  return Object.freeze([digest.readInt32BE(0), digest.readInt32BE(4)]);
}

function readSingleBoolean(
  rows: readonly Readonly<Record<string, unknown>>[],
  key: string,
): boolean {
  return rows.length === 1 && rows[0]?.[key] === true;
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    ("code" in error || "name" in error) &&
    (Reflect.get(error, "code") === "SQLITE_BUSY" || Reflect.get(error, "code") === "SQLITE_LOCKED")
  );
}

function ownershipUnavailable(message: string, cause?: unknown): MainSingletonOwnershipError {
  return new MainSingletonOwnershipError(
    "MAIN_OWNERSHIP_UNAVAILABLE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function safelyNotify(
  listener: (error: MainSingletonOwnershipError) => void,
  error: MainSingletonOwnershipError,
): void {
  try {
    listener(error);
  } catch {
    // Ownership loss must continue closing the runtime even when one observer is faulty.
  }
}
