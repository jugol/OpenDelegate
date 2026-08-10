import { sql, type Kysely, type Transaction } from "kysely";

import { SqlStorageError } from "./errors.ts";
import type { SqlBackend, SqlStorageSchema } from "./schema.ts";

export interface SqlRetryPolicy {
  readonly maximumAttempts: number;
  backoff(attempt: number): Promise<void>;
}

export const DEFAULT_SQL_RETRY_POLICY: SqlRetryPolicy = Object.freeze({
  maximumAttempts: 3,
  backoff: async (attempt: number) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, attempt * 25);
    });
  },
});

export type SqlWriteOperation<TResult> = (
  transaction: Transaction<SqlStorageSchema>,
) => Promise<TResult>;

export interface SqlWriteCoordinator {
  run<TResult>(operation: () => Promise<TResult>): Promise<TResult>;
}

interface SharedSqlWriteCoordinator {
  readonly coordinator: SqlWriteCoordinator;
  references: number;
}

const sharedSqliteWriteCoordinators = new Map<string, SharedSqlWriteCoordinator>();

export function acquireSqliteWriteCoordinator(key: string): {
  readonly coordinator: SqlWriteCoordinator;
  release(): void;
} {
  let shared = sharedSqliteWriteCoordinators.get(key);
  if (shared === undefined) {
    shared = { coordinator: new AsyncMutex(), references: 0 };
    sharedSqliteWriteCoordinators.set(key, shared);
  }
  shared.references += 1;
  let released = false;
  return {
    coordinator: shared.coordinator,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = sharedSqliteWriteCoordinators.get(key);
      if (current !== shared) {
        return;
      }
      current.references -= 1;
      if (current.references === 0) {
        sharedSqliteWriteCoordinators.delete(key);
      }
    },
  };
}

export class SqlTransactionRunner {
  private readonly backend: SqlBackend;
  private readonly database: Kysely<SqlStorageSchema>;
  private readonly mutex: SqlWriteCoordinator;
  private readonly retryPolicy: SqlRetryPolicy;

  public constructor(
    database: Kysely<SqlStorageSchema>,
    backend: SqlBackend,
    retryPolicy: SqlRetryPolicy,
    coordinator?: SqlWriteCoordinator,
  ) {
    assertRetryPolicy(retryPolicy);
    this.database = database;
    this.backend = backend;
    this.retryPolicy = retryPolicy;
    this.mutex = coordinator ?? new AsyncMutex();
  }

  public async write<TResult>(operation: SqlWriteOperation<TResult>): Promise<TResult> {
    if (this.backend === "sqlite") {
      return this.mutex.run(() => this.runWithRetry(operation));
    }
    return this.runWithRetry(operation);
  }

  private async runWithRetry<TResult>(operation: SqlWriteOperation<TResult>): Promise<TResult> {
    return executeWithSqlRetry(this.backend, this.retryPolicy, async () => {
      const transaction =
        this.backend === "postgres"
          ? this.database.transaction().setIsolationLevel("serializable")
          : this.database.transaction();

      return await transaction.execute(async (trx) => {
        const result = await trx
          .updateTable("od_write_gate")
          .set({ revision: sql<number>`revision + 1` })
          .where("singleton_id", "=", 1)
          .executeTakeFirst();

        if (result.numUpdatedRows !== 1n) {
          throw new SqlStorageError("DATA_CORRUPT", "The singleton SQL write gate is missing.");
        }

        return operation(trx);
      });
    });
  }
}

export async function executeWithSqlRetry<TResult>(
  backend: SqlBackend,
  retryPolicy: SqlRetryPolicy,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  assertRetryPolicy(retryPolicy);

  for (let attempt = 1; attempt <= retryPolicy.maximumAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionError(error, backend)) {
        throw error;
      }
      if (attempt === retryPolicy.maximumAttempts) {
        throw new SqlStorageError(
          "STORAGE_UNAVAILABLE",
          "The SQL write transaction exhausted its bounded retry policy.",
          { cause: error },
        );
      }
      await retryPolicy.backoff(attempt);
    }
  }

  throw new SqlStorageError(
    "STORAGE_UNAVAILABLE",
    "The SQL write transaction did not produce a result.",
  );
}

export function isRetryableTransactionError(error: unknown, backend: SqlBackend): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = Reflect.get(error, "code");
  if (typeof code !== "string") {
    return false;
  }

  return backend === "sqlite"
    ? code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    : code === "40001" || code === "40P01";
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  public async run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => current);

    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function assertRetryPolicy(policy: SqlRetryPolicy): void {
  if (
    !Number.isSafeInteger(policy.maximumAttempts) ||
    policy.maximumAttempts < 1 ||
    policy.maximumAttempts > 10
  ) {
    throw new SqlStorageError(
      "STORAGE_CONFIGURATION_INVALID",
      "SQL retry maximumAttempts must be an integer between 1 and 10.",
    );
  }
}
