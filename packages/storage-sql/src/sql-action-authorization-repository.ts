import { createHash } from "node:crypto";

import type { Kysely, Selectable, Transaction } from "kysely";

import {
  createPostgresDatabase,
  createSqliteDatabase,
  type PostgresDialectOptions,
  type SqlDatabaseContext,
  type SqliteDialectOptions,
} from "./dialects.ts";
import { SqlStorageError } from "./errors.ts";
import { applySqlMigrations, verifySqlMigrations } from "./migrations.ts";
import type { ActionAuthorizationTable, SqlStorageSchema } from "./schema.ts";
import type { SqlMigrationMode } from "./sql-event-store.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";

const MAXIMUM_IDENTIFIER_BYTES = 512;
const MAXIMUM_STATE_BYTES = 512 * 1024;

export interface ActionAuthorizationRecord {
  readonly authorizationRequestId: string;
  readonly requestDigest: string;
  readonly authorizationId: string;
  readonly policyFingerprint: string;
  readonly stateJson: string;
  readonly stateSha256: string;
  readonly updatedAtMs: number;
}

export interface ActionAuthorizationRepositoryMutation<TResult> {
  readonly result: TResult;
  /**
   * Supplying next atomically replaces the record read by the callback. Omitting
   * it performs a read-only decision inside the same serialized transaction.
   */
  readonly next?: ActionAuthorizationRecord;
}

export interface ActionAuthorizationRepository {
  read(authorizationRequestId: string): Promise<ActionAuthorizationRecord | undefined>;
  list(): Promise<readonly ActionAuthorizationRecord[]>;
  write(record: ActionAuthorizationRecord): Promise<void>;
  transact<TResult>(
    authorizationRequestId: string,
    operation: (
      current: ActionAuthorizationRecord | undefined,
    ) => ActionAuthorizationRepositoryMutation<TResult>,
  ): Promise<TResult>;
  close(): Promise<void>;
}

interface SqlActionAuthorizationRepositoryOptions {
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteActionAuthorizationRepositoryOptions
  extends SqlActionAuthorizationRepositoryOptions, SqliteDialectOptions {}

export interface OpenPostgresActionAuthorizationRepositoryOptions
  extends SqlActionAuthorizationRepositoryOptions, PostgresDialectOptions {}

export class SqlActionAuthorizationRepository implements ActionAuthorizationRepository {
  readonly #context: SqlDatabaseContext;
  readonly #transactionRunner: SqlTransactionRunner;

  private constructor(context: SqlDatabaseContext, retryPolicy: SqlRetryPolicy) {
    this.#context = context;
    this.#transactionRunner = new SqlTransactionRunner(
      context.database,
      context.backend,
      retryPolicy,
      context.writeCoordinator,
    );
  }

  public static async openSqlite(
    options: OpenSqliteActionAuthorizationRepositoryOptions,
  ): Promise<SqlActionAuthorizationRepository> {
    const context = await createSqliteDatabase(options);
    return await this.#open(context, options);
  }

  public static async openPostgres(
    options: OpenPostgresActionAuthorizationRepositoryOptions,
  ): Promise<SqlActionAuthorizationRepository> {
    const context = await createPostgresDatabase(options);
    return await this.#open(context, options);
  }

  public async read(
    authorizationRequestId: string,
  ): Promise<ActionAuthorizationRecord | undefined> {
    const requestId = validateIdentifier(authorizationRequestId, "authorization request ID");
    return await loadRecord(this.#context.database, requestId);
  }

  public async list(): Promise<readonly ActionAuthorizationRecord[]> {
    const rows = await this.#context.database
      .selectFrom("od_action_authorizations")
      .selectAll()
      .orderBy("updated_at_ms", "desc")
      .orderBy("authorization_request_id")
      .execute();
    return Object.freeze(rows.map(decodeRecord));
  }

  public async write(record: ActionAuthorizationRecord): Promise<void> {
    const validated = validateRecord(record);
    await this.transact(validated.authorizationRequestId, () => ({
      result: undefined,
      next: validated,
    }));
  }

  public async transact<TResult>(
    authorizationRequestId: string,
    operation: (
      current: ActionAuthorizationRecord | undefined,
    ) => ActionAuthorizationRepositoryMutation<TResult>,
  ): Promise<TResult> {
    const requestId = validateIdentifier(authorizationRequestId, "authorization request ID");
    if (typeof operation !== "function") {
      throw invalidInput("An action authorization transaction callback is required.");
    }
    return await this.#transactionRunner.write(async (transaction) => {
      const current = await loadRecord(transaction, requestId);
      const mutation = operation(current);
      if (
        mutation === null ||
        typeof mutation !== "object" ||
        Array.isArray(mutation) ||
        !Object.prototype.hasOwnProperty.call(mutation, "result") ||
        Object.keys(mutation).some((key) => key !== "result" && key !== "next")
      ) {
        throw invalidInput("The action authorization transaction result is invalid.");
      }
      if (mutation.next !== undefined) {
        const next = validateRecord(mutation.next);
        if (next.authorizationRequestId !== requestId) {
          throw invalidInput("An action authorization transaction cannot replace another request.");
        }
        await upsertRecord(transaction, next);
      }
      return mutation.result;
    });
  }

  public async close(): Promise<void> {
    await this.#context.close();
  }

  static async #open(
    context: SqlDatabaseContext,
    options: SqlActionAuthorizationRepositoryOptions,
  ): Promise<SqlActionAuthorizationRepository> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      return new SqlActionAuthorizationRepository(
        context,
        options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY,
      );
    } catch (error) {
      await context.close();
      throw error;
    }
  }
}

type RecordReader = Kysely<SqlStorageSchema> | Transaction<SqlStorageSchema>;

async function loadRecord(
  database: RecordReader,
  authorizationRequestId: string,
): Promise<ActionAuthorizationRecord | undefined> {
  const row = await database
    .selectFrom("od_action_authorizations")
    .selectAll()
    .where("authorization_request_id", "=", authorizationRequestId)
    .executeTakeFirst();
  return row === undefined ? undefined : decodeRecord(row);
}

async function upsertRecord(
  transaction: Transaction<SqlStorageSchema>,
  record: ActionAuthorizationRecord,
): Promise<void> {
  await transaction
    .insertInto("od_action_authorizations")
    .values({
      authorization_id: record.authorizationId,
      authorization_request_id: record.authorizationRequestId,
      policy_fingerprint: record.policyFingerprint,
      request_digest: record.requestDigest,
      state_json: record.stateJson,
      state_sha256: record.stateSha256,
      updated_at_ms: record.updatedAtMs,
    })
    .onConflict((conflict) =>
      conflict.column("authorization_request_id").doUpdateSet({
        authorization_id: record.authorizationId,
        policy_fingerprint: record.policyFingerprint,
        request_digest: record.requestDigest,
        state_json: record.stateJson,
        state_sha256: record.stateSha256,
        updated_at_ms: record.updatedAtMs,
      }),
    )
    .execute();
}

function decodeRecord(row: Selectable<ActionAuthorizationTable>): ActionAuthorizationRecord {
  try {
    return validateRecord({
      authorizationId: row.authorization_id,
      authorizationRequestId: row.authorization_request_id,
      policyFingerprint: row.policy_fingerprint,
      requestDigest: row.request_digest,
      stateJson: row.state_json,
      stateSha256: row.state_sha256,
      updatedAtMs: parseStoredInteger(row.updated_at_ms),
    });
  } catch (error) {
    if (error instanceof SqlStorageError && error.code === "DATA_CORRUPT") {
      throw error;
    }
    throw dataCorrupt("The stored action authorization record is invalid.", error);
  }
}

function validateRecord(record: ActionAuthorizationRecord): ActionAuthorizationRecord {
  if (
    record === null ||
    typeof record !== "object" ||
    !hasExactKeys(record as unknown as Readonly<Record<string, unknown>>, [
      "authorizationRequestId",
      "requestDigest",
      "authorizationId",
      "policyFingerprint",
      "stateJson",
      "stateSha256",
      "updatedAtMs",
    ])
  ) {
    throw invalidInput("The action authorization record is invalid.");
  }
  const authorizationRequestId = validateIdentifier(
    record.authorizationRequestId,
    "authorization request ID",
  );
  if (
    !/^[a-f0-9]{64}$/u.test(record.requestDigest) ||
    !/^authorization:[a-f0-9]{64}$/u.test(record.authorizationId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.policyFingerprint) ||
    !/^[a-f0-9]{64}$/u.test(record.stateSha256) ||
    typeof record.stateJson !== "string" ||
    Buffer.byteLength(record.stateJson, "utf8") > MAXIMUM_STATE_BYTES ||
    createHash("sha256").update(record.stateJson, "utf8").digest("hex") !== record.stateSha256 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < 0
  ) {
    throw invalidInput("The action authorization record is outside its durable contract.");
  }
  return Object.freeze({
    authorizationRequestId,
    requestDigest: record.requestDigest,
    authorizationId: record.authorizationId,
    policyFingerprint: record.policyFingerprint,
    stateJson: record.stateJson,
    stateSha256: record.stateSha256,
    updatedAtMs: record.updatedAtMs,
  });
}

function parseStoredInteger(value: number | string | bigint): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : /^(?:0|[1-9][0-9]*)$/u.test(value)
          ? Number(value)
          : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw dataCorrupt("The action authorization timestamp is invalid.");
  }
  return parsed;
}

function validateIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_IDENTIFIER_BYTES
  ) {
    throw invalidInput(`The ${label} is invalid.`);
  }
  return value;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === keys.length && actual.every((key, index) => key === expected[index]);
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
