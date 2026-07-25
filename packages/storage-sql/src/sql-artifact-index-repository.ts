import { createHash } from "node:crypto";

import type { ArtifactIndexRepository, ArtifactIndexSnapshot } from "@opendelegate/artifact-store";
import type { Kysely, Selectable, Transaction } from "kysely";

import { parseSafeNonNegativeInteger } from "./codecs.ts";
import {
  createPostgresDatabase,
  createSqliteDatabase,
  type PostgresDialectOptions,
  type SqlDatabaseContext,
  type SqliteDialectOptions,
} from "./dialects.ts";
import { SqlStorageError } from "./errors.ts";
import { applySqlMigrations, verifySqlMigrations } from "./migrations.ts";
import type { ArtifactIndexStateTable, SqlStorageSchema } from "./schema.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";
import type { SqlMigrationMode } from "./sql-event-store.ts";

interface SqlArtifactIndexRepositoryOptions {
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteArtifactIndexRepositoryOptions
  extends SqlArtifactIndexRepositoryOptions, SqliteDialectOptions {}

export interface OpenPostgresArtifactIndexRepositoryOptions
  extends SqlArtifactIndexRepositoryOptions, PostgresDialectOptions {}

type StateReader = Kysely<SqlStorageSchema> | Transaction<SqlStorageSchema>;

export class SqlArtifactIndexRepository implements ArtifactIndexRepository {
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

  public static async openSqlite(
    options: OpenSqliteArtifactIndexRepositoryOptions,
  ): Promise<SqlArtifactIndexRepository> {
    const context = await createSqliteDatabase(options);
    return this.#open(context, options);
  }

  public static async openPostgres(
    options: OpenPostgresArtifactIndexRepositoryOptions,
  ): Promise<SqlArtifactIndexRepository> {
    const context = await createPostgresDatabase(options);
    return this.#open(context, options);
  }

  public async load(): Promise<ArtifactIndexSnapshot | undefined> {
    return loadSnapshot(this.#context.database);
  }

  public async initialize(initial: ArtifactIndexSnapshot): Promise<ArtifactIndexSnapshot> {
    const snapshot = validateSnapshot(initial, "initial Artifact index");
    return this.#transactionRunner.write(async (transaction) => {
      await transaction
        .insertInto("od_artifact_index_state")
        .values(toRow(snapshot))
        .onConflict((conflict) => conflict.column("singleton_id").doNothing())
        .execute();
      const winner = await loadSnapshot(transaction);
      if (winner === undefined) {
        throw dataCorrupt("The singleton Artifact index was not initialized.");
      }
      return winner;
    });
  }

  public async compareAndSet(
    expectedGeneration: number,
    next: ArtifactIndexSnapshot,
  ): Promise<boolean> {
    if (!isNonNegativeSafeInteger(expectedGeneration)) {
      throw invalidInput("Artifact index expected generation is invalid.");
    }
    const snapshot = validateSnapshot(next, "next Artifact index");
    if (snapshot.generation !== expectedGeneration + 1) {
      throw invalidInput("Artifact index commits must advance exactly one generation.");
    }
    return this.#transactionRunner.write(async (transaction) => {
      const result = await transaction
        .updateTable("od_artifact_index_state")
        .set({
          generation: snapshot.generation,
          schema_version: 1,
          state_json: snapshot.stateJson,
          state_sha256: snapshot.stateSha256,
        })
        .where("singleton_id", "=", 1)
        .where("generation", "=", expectedGeneration)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    });
  }

  public async close(): Promise<void> {
    await this.#context.close();
  }

  static async #open(
    context: SqlDatabaseContext,
    options: SqlArtifactIndexRepositoryOptions,
  ): Promise<SqlArtifactIndexRepository> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      const repository = new SqlArtifactIndexRepository(
        context,
        options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY,
      );
      if ((await repository.load()) === undefined) {
        throw dataCorrupt("The singleton Artifact index is missing.");
      }
      return repository;
    } catch (error) {
      await context.close();
      throw error;
    }
  }
}

async function loadSnapshot(database: StateReader): Promise<ArtifactIndexSnapshot | undefined> {
  const row = await database
    .selectFrom("od_artifact_index_state")
    .selectAll()
    .where("singleton_id", "=", 1)
    .executeTakeFirst();
  return row === undefined ? undefined : decodeRow(row);
}

function toRow(snapshot: ArtifactIndexSnapshot): {
  readonly singleton_id: 1;
  readonly schema_version: 1;
  readonly generation: number;
  readonly state_json: string;
  readonly state_sha256: string;
} {
  return {
    singleton_id: 1,
    schema_version: 1,
    generation: snapshot.generation,
    state_json: snapshot.stateJson,
    state_sha256: snapshot.stateSha256,
  };
}

function decodeRow(row: Selectable<ArtifactIndexStateTable>): ArtifactIndexSnapshot {
  try {
    if (row.singleton_id !== 1 || row.schema_version !== 1) {
      throw dataCorrupt("The Artifact index schema marker is invalid.");
    }
    const generation = parseSafeNonNegativeInteger(row.generation, "Artifact index generation");
    return validateSnapshot(
      {
        schemaVersion: 1,
        generation,
        stateJson: row.state_json,
        stateSha256: row.state_sha256,
      },
      "stored Artifact index",
      true,
    );
  } catch (error) {
    if (error instanceof SqlStorageError && error.code === "DATA_CORRUPT") {
      throw error;
    }
    throw dataCorrupt("The stored Artifact index is invalid.", error);
  }
}

function validateSnapshot(
  value: ArtifactIndexSnapshot,
  label: string,
  stored = false,
): ArtifactIndexSnapshot {
  const fail = (message: string, cause?: unknown): never => {
    if (stored) {
      throw dataCorrupt(message, cause);
    }
    throw invalidInput(message, cause);
  };
  if (!isRecord(value)) {
    return fail(`${label} must be a plain object.`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !keys.includes("schemaVersion") ||
    !keys.includes("generation") ||
    !keys.includes("stateJson") ||
    !keys.includes("stateSha256") ||
    value["schemaVersion"] !== 1 ||
    !isNonNegativeSafeInteger(value["generation"]) ||
    typeof value["stateJson"] !== "string" ||
    typeof value["stateSha256"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value["stateSha256"]) ||
    digest(value["stateJson"]) !== value["stateSha256"]
  ) {
    return fail(`${label} failed envelope or integrity validation.`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value["stateJson"]);
  } catch (error) {
    return fail(`${label} is not valid JSON.`, error);
  }
  if (
    !isRecord(decoded) ||
    decoded["schemaVersion"] !== 1 ||
    decoded["generation"] !== value["generation"]
  ) {
    return fail(`${label} disagrees with its embedded generation.`);
  }
  return Object.freeze({
    schemaVersion: 1,
    generation: value["generation"],
    stateJson: value["stateJson"],
    stateSha256: value["stateSha256"],
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalidInput(message: string, cause?: unknown): SqlStorageError {
  return new SqlStorageError("STORAGE_CONFIGURATION_INVALID", message, { cause });
}

function dataCorrupt(message: string, cause?: unknown): SqlStorageError {
  return new SqlStorageError("DATA_CORRUPT", message, { cause });
}
