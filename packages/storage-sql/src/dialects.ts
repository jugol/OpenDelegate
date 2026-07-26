import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import Database from "better-sqlite3";
import {
  Kysely,
  PostgresDialect,
  SqliteDialect,
  sql,
  type DatabaseIntrospector,
  type DatabaseMetadataOptions,
  type Dialect,
  type SchemaMetadata,
  type TableMetadata,
} from "kysely";
import type { PostgresDialectConfig } from "kysely";
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

  const dialect =
    options.schema === undefined
      ? new PostgresDialect({ pool })
      : new SchemaScopedPostgresDialect({ pool }, options.schema);

  return createContext("postgres", dialect, undefined, undefined, options.schema);
}

/**
 * Kysely's stock PostgreSQL introspector traverses every schema the database
 * role can access. Besides doing unnecessary work, its catalog query can race
 * an unrelated schema being dropped and make this schema's migration fail.
 * Repository connections are deliberately schema-bound, so their introspection
 * boundary must be schema-bound as well.
 */
class SchemaScopedPostgresDialect extends PostgresDialect {
  readonly #schema: string;

  public constructor(config: PostgresDialectConfig, schema: string) {
    super(config);
    this.#schema = schema;
  }

  public override createIntrospector(database: Kysely<unknown>): DatabaseIntrospector {
    return new SchemaScopedPostgresIntrospector(database, this.#schema);
  }
}

interface PostgresSchemaRow {
  readonly name: string;
}

interface PostgresColumnMetadataRow {
  readonly auto_incrementing: string | null;
  readonly column: string;
  readonly column_description: string | null;
  readonly has_default: boolean;
  readonly not_null: boolean;
  readonly schema: string;
  readonly table: string;
  readonly table_type: "f" | "p" | "r" | "v";
  readonly type: string;
  readonly type_schema: string;
}

class SchemaScopedPostgresIntrospector implements DatabaseIntrospector {
  readonly #database: Kysely<unknown>;
  readonly #schema: string;

  public constructor(database: Kysely<unknown>, schema: string) {
    this.#database = database;
    this.#schema = schema;
  }

  public async getSchemas(): Promise<SchemaMetadata[]> {
    const result = await sql<PostgresSchemaRow>`
      SELECT nspname AS name
      FROM pg_catalog.pg_namespace
      WHERE nspname = ${this.#schema}
    `.execute(this.#database);
    return result.rows.map((row) => ({ name: row.name }));
  }

  public async getTables(options?: DatabaseMetadataOptions): Promise<TableMetadata[]> {
    const result = await sql<PostgresColumnMetadataRow>`
      SELECT
        a.attname AS column,
        a.attnotnull AS not_null,
        a.atthasdef AS has_default,
        c.relname AS table,
        c.relkind AS table_type,
        ns.nspname AS schema,
        typ.typname AS type,
        dtns.nspname AS type_schema,
        col_description(a.attrelid, a.attnum) AS column_description,
        pg_get_serial_sequence(
          quote_ident(ns.nspname) || '.' || quote_ident(c.relname),
          a.attname
        ) AS auto_incrementing
      FROM pg_catalog.pg_attribute AS a
      INNER JOIN pg_catalog.pg_class AS c ON a.attrelid = c.oid
      INNER JOIN pg_catalog.pg_namespace AS ns ON c.relnamespace = ns.oid
      INNER JOIN pg_catalog.pg_type AS typ ON a.atttypid = typ.oid
      INNER JOIN pg_catalog.pg_namespace AS dtns ON typ.typnamespace = dtns.oid
      WHERE c.relkind IN ('r', 'v', 'p', 'f')
        AND ns.nspname = ${this.#schema}
        AND a.attnum >= 0
        AND a.attisdropped <> TRUE
      ORDER BY c.relname, a.attnum
    `.execute(this.#database);

    const tables = new Map<string, TableMetadata>();
    for (const row of result.rows) {
      if (
        options?.withInternalKyselyTables !== true &&
        (row.table === "kysely_migration" || row.table === "kysely_migration_lock")
      ) {
        continue;
      }

      let table = tables.get(row.table);
      if (table === undefined) {
        table = {
          columns: [],
          isForeign: row.table_type === "f",
          isView: row.table_type === "v",
          name: row.table,
          schema: row.schema,
        };
        tables.set(row.table, table);
      }
      table.columns.push({
        ...(row.column_description === null ? {} : { comment: row.column_description }),
        dataType: row.type,
        dataTypeSchema: row.type_schema,
        hasDefaultValue: row.has_default,
        isAutoIncrementing: row.auto_incrementing !== null,
        isNullable: !row.not_null,
        name: row.column,
      });
    }
    return [...tables.values()];
  }
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
