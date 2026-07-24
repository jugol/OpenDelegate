import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect, type Dialect } from "kysely";
import { Pool } from "pg";

import { SqlStorageError } from "./errors.ts";
import type { SqlBackend, SqlStorageSchema } from "./schema.ts";

export interface SqlitePragmas {
  readonly busyTimeoutMs: number;
  readonly foreignKeys: boolean;
  readonly journalMode: string;
  readonly synchronous: number;
}

export interface SqlDatabaseContext {
  readonly backend: SqlBackend;
  readonly database: Kysely<SqlStorageSchema>;
  readonly migrationTableSchema?: string;
  close(): Promise<void>;
  inspectSqlitePragmas?(): SqlitePragmas;
}

export interface SqliteDialectOptions {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
}

export interface PostgresDialectOptions {
  readonly connectionString: string;
  readonly maximumPoolSize?: number;
  readonly schema?: string;
}

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export async function createSqliteDatabase(
  options: SqliteDialectOptions,
): Promise<SqlDatabaseContext> {
  if (!isAbsolute(options.filename)) {
    throw new SqlStorageError(
      "STORAGE_CONFIGURATION_INVALID",
      "The SQLite database filename must be absolute; runtime state belongs outside the source checkout.",
    );
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw new SqlStorageError(
      "STORAGE_CONFIGURATION_INVALID",
      "SQLite busyTimeoutMs must be an integer between 1 and 60000.",
    );
  }

  await mkdir(dirname(options.filename), { recursive: true });
  const sqlite = new Database(options.filename);

  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = FULL");
    sqlite.pragma(`busy_timeout = ${busyTimeoutMs}`);
  } catch (error) {
    sqlite.close();
    throw new SqlStorageError(
      "STORAGE_UNAVAILABLE",
      "SQLite could not apply its required durability settings.",
      { cause: error },
    );
  }

  return createContext(
    "sqlite",
    new SqliteDialect({ database: sqlite }),
    () => ({
      busyTimeoutMs: readNumericPragma(sqlite, "busy_timeout"),
      foreignKeys: readNumericPragma(sqlite, "foreign_keys") === 1,
      journalMode: readStringPragma(sqlite, "journal_mode"),
      synchronous: readNumericPragma(sqlite, "synchronous"),
    }),
    async () => {
      if (sqlite.open) {
        sqlite.close();
      }
    },
  );
}

export async function createPostgresDatabase(
  options: PostgresDialectOptions,
): Promise<SqlDatabaseContext> {
  if (!/^postgres(?:ql)?:\/\//u.test(options.connectionString)) {
    throw new SqlStorageError(
      "STORAGE_CONFIGURATION_INVALID",
      "The PostgreSQL connection string must use the postgres or postgresql scheme.",
    );
  }

  const maximumPoolSize = options.maximumPoolSize ?? 10;
  if (!Number.isSafeInteger(maximumPoolSize) || maximumPoolSize < 1 || maximumPoolSize > 50) {
    throw new SqlStorageError(
      "STORAGE_CONFIGURATION_INVALID",
      "PostgreSQL maximumPoolSize must be an integer between 1 and 50.",
    );
  }

  if (options.schema !== undefined && !/^[a-z][a-z0-9_]{0,62}$/u.test(options.schema)) {
    throw new SqlStorageError(
      "STORAGE_CONFIGURATION_INVALID",
      "PostgreSQL schema must be a lowercase SQL identifier.",
    );
  }

  const pool = new Pool({
    connectionString: options.connectionString,
    max: maximumPoolSize,
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema}` }),
  });

  return createContext(
    "postgres",
    new PostgresDialect({ pool }),
    undefined,
    undefined,
    options.schema,
  );
}

function createContext(
  backend: SqlBackend,
  dialect: Dialect,
  inspectSqlitePragmas?: () => SqlitePragmas,
  closeUnusedDriver?: () => Promise<void>,
  migrationTableSchema?: string,
): SqlDatabaseContext {
  const database = new Kysely<SqlStorageSchema>({ dialect });
  let closed = false;

  return {
    backend,
    database,
    ...(migrationTableSchema === undefined ? {} : { migrationTableSchema }),
    ...(inspectSqlitePragmas === undefined ? {} : { inspectSqlitePragmas }),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await database.destroy();
      await closeUnusedDriver?.();
    },
  };
}

function readNumericPragma(sqlite: Database.Database, name: string): number {
  const value = sqlite.pragma(name, { simple: true });
  if (typeof value !== "number") {
    throw new SqlStorageError(
      "STORAGE_UNAVAILABLE",
      `SQLite returned an invalid ${name} PRAGMA value.`,
    );
  }
  return value;
}

function readStringPragma(sqlite: Database.Database, name: string): string {
  const value = sqlite.pragma(name, { simple: true });
  if (typeof value !== "string") {
    throw new SqlStorageError(
      "STORAGE_UNAVAILABLE",
      `SQLite returned an invalid ${name} PRAGMA value.`,
    );
  }
  return value;
}
