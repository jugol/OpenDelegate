import { createHash } from "node:crypto";

import {
  ApprovalServiceError,
  exportApprovalRepositorySnapshot,
  importApprovalRepositorySnapshot,
  type ApprovalRepository,
  type ApprovalRepositoryState,
  type ReadonlyApprovalRepositoryState,
} from "@opendelegate/policy";
import type { Kysely, Selectable, Transaction } from "kysely";

import { decodeCanonicalJson, encodeCanonicalJson, parseSafeNonNegativeInteger } from "./codecs.ts";
import {
  createPostgresDatabase,
  createSqliteDatabase,
  type PostgresDialectOptions,
  type SqlDatabaseContext,
  type SqliteDialectOptions,
} from "./dialects.ts";
import { SqlStorageError } from "./errors.ts";
import { applySqlMigrations, verifySqlMigrations } from "./migrations.ts";
import type { ApprovalStateTable, SqlStorageSchema } from "./schema.ts";
import type { SqlMigrationMode } from "./sql-event-store.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";

interface SqlApprovalRepositoryOptions {
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteApprovalRepositoryOptions
  extends SqlApprovalRepositoryOptions, SqliteDialectOptions {}

export interface OpenPostgresApprovalRepositoryOptions
  extends SqlApprovalRepositoryOptions, PostgresDialectOptions {}

const MAXIMUM_STATE_BYTES = 16 * 1024 * 1024;

export class SqlApprovalRepository implements ApprovalRepository {
  readonly #context: SqlDatabaseContext;
  readonly #transactionRunner: SqlTransactionRunner;

  private constructor(context: SqlDatabaseContext, retryPolicy: SqlRetryPolicy) {
    this.#context = context;
    this.#transactionRunner = new SqlTransactionRunner(
      context.database,
      context.backend,
      retryPolicy,
    );
  }

  static async openSqlite(
    options: OpenSqliteApprovalRepositoryOptions,
  ): Promise<SqlApprovalRepository> {
    const context = await createSqliteDatabase(options);
    return this.#open(context, options);
  }

  static async openPostgres(
    options: OpenPostgresApprovalRepositoryOptions,
  ): Promise<SqlApprovalRepository> {
    const context = await createPostgresDatabase(options);
    return this.#open(context, options);
  }

  async read<T>(operation: (state: ReadonlyApprovalRepositoryState) => T): Promise<T> {
    if (typeof operation !== "function") {
      throw invalidInput("An Approval repository read callback is required.");
    }
    return operation(await loadState(this.#context.database));
  }

  async transact<T>(operation: (state: ApprovalRepositoryState) => T): Promise<T> {
    if (typeof operation !== "function") {
      throw invalidInput("An Approval repository transaction callback is required.");
    }
    return this.#transactionRunner.write(async (transaction) => {
      const state = await loadState(transaction);
      const result = operation(state);
      const encoded = encodeState(state);
      await transaction
        .updateTable("od_approval_state")
        .set({
          revision: state.revision,
          schema_version: 1,
          state_json: encoded.json,
          state_sha256: encoded.sha256,
        })
        .where("singleton_id", "=", 1)
        .executeTakeFirstOrThrow();
      return result;
    });
  }

  async close(): Promise<void> {
    await this.#context.close();
  }

  static async #open(
    context: SqlDatabaseContext,
    options: SqlApprovalRepositoryOptions,
  ): Promise<SqlApprovalRepository> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      const repository = new SqlApprovalRepository(
        context,
        options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY,
      );
      await repository.read(() => undefined);
      return repository;
    } catch (error) {
      await context.close();
      throw error;
    }
  }
}

type StateReader = Kysely<SqlStorageSchema> | Transaction<SqlStorageSchema>;

async function loadState(database: StateReader): Promise<ApprovalRepositoryState> {
  const row = await database
    .selectFrom("od_approval_state")
    .selectAll()
    .where("singleton_id", "=", 1)
    .executeTakeFirst();
  if (row === undefined) {
    throw dataCorrupt("The singleton Approval state is missing.");
  }
  return decodeState(row);
}

function encodeState(state: ApprovalRepositoryState): {
  readonly json: string;
  readonly sha256: string;
} {
  let json: string;
  try {
    json = encodeCanonicalJson(exportApprovalRepositorySnapshot(state));
  } catch (error) {
    throw invalidInput("Approval state is outside the durable repository contract.", error);
  }
  if (Buffer.byteLength(json, "utf8") > MAXIMUM_STATE_BYTES) {
    throw invalidInput("Approval state exceeds the 16 MiB durable snapshot limit.");
  }
  return {
    json,
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

function decodeState(row: Selectable<ApprovalStateTable>): ApprovalRepositoryState {
  try {
    if (row.singleton_id !== 1 || row.schema_version !== 1) {
      throw dataCorrupt("The Approval state schema marker is invalid.");
    }
    const revision = parseSafeNonNegativeInteger(row.revision, "Approval state revision");
    if (
      !/^[a-f0-9]{64}$/u.test(row.state_sha256) ||
      createHash("sha256").update(row.state_json, "utf8").digest("hex") !== row.state_sha256
    ) {
      throw dataCorrupt("The Approval state checksum does not match its durable payload.");
    }
    if (Buffer.byteLength(row.state_json, "utf8") > MAXIMUM_STATE_BYTES) {
      throw dataCorrupt("The Approval state exceeds its durable size limit.");
    }
    const snapshot = decodeCanonicalJson(row.state_json);
    const state = importApprovalRepositorySnapshot(snapshot);
    if (state.revision !== revision) {
      throw dataCorrupt("The Approval state revision columns disagree.");
    }
    return state;
  } catch (error) {
    if (error instanceof SqlStorageError) {
      throw error;
    }
    if (error instanceof ApprovalServiceError) {
      throw dataCorrupt("The Approval state failed semantic validation.", error);
    }
    throw dataCorrupt("The Approval state could not be decoded safely.", error);
  }
}

function invalidInput(message: string, cause?: unknown): SqlStorageError {
  return new SqlStorageError(
    "STORAGE_CONFIGURATION_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function dataCorrupt(message: string, cause?: unknown): SqlStorageError {
  return new SqlStorageError("DATA_CORRUPT", message, cause === undefined ? undefined : { cause });
}
