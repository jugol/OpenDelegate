import type {
  OwnerAuthAuditRecord,
  OwnerAuthRepository,
  OwnerAuthRepositorySnapshot,
  OwnerAuthTransaction,
  PersistedInitialClaim,
  PersistedLoginAttempts,
  PersistedOwnerCredential,
  PersistedRecoveryCode,
  PersistedRecoveryState,
  PersistedSession,
} from "@opendelegate/owner-auth";
import type { Selectable, Transaction } from "kysely";

import { deepFreeze, parseSafeNonNegativeInteger } from "./codecs.ts";
import {
  createPostgresDatabase,
  createSqliteDatabase,
  type PostgresDialectOptions,
  type SqlDatabaseContext,
  type SqliteDialectOptions,
} from "./dialects.ts";
import { SqlStorageError } from "./errors.ts";
import { applySqlMigrations, verifySqlMigrations } from "./migrations.ts";
import type {
  OwnerAuthAuditTable,
  OwnerClaimTable,
  OwnerCredentialTable,
  OwnerLoginAttemptsTable,
  OwnerRecoveryCredentialsTable,
  OwnerRecoveryStatesTable,
  OwnerSessionsTable,
  SqlStorageSchema,
} from "./schema.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";
import type { SqlMigrationMode } from "./sql-event-store.ts";

interface SqlOwnerAuthRepositoryOptions {
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteOwnerAuthRepositoryOptions
  extends SqlOwnerAuthRepositoryOptions, SqliteDialectOptions {}

export interface OpenPostgresOwnerAuthRepositoryOptions
  extends SqlOwnerAuthRepositoryOptions, PostgresDialectOptions {}

export class SqlOwnerAuthRepository implements OwnerAuthRepository {
  private readonly context: SqlDatabaseContext;
  private readonly transactionRunner: SqlTransactionRunner;

  private constructor(context: SqlDatabaseContext, retryPolicy: SqlRetryPolicy) {
    this.context = context;
    this.transactionRunner = new SqlTransactionRunner(
      context.database,
      context.backend,
      retryPolicy,
    );
  }

  public static async openSqlite(
    options: OpenSqliteOwnerAuthRepositoryOptions,
  ): Promise<SqlOwnerAuthRepository> {
    const context = await createSqliteDatabase(options);
    return this.open(context, options);
  }

  public static async openPostgres(
    options: OpenPostgresOwnerAuthRepositoryOptions,
  ): Promise<SqlOwnerAuthRepository> {
    const context = await createPostgresDatabase(options);
    return this.open(context, options);
  }

  public async transaction<TResult>(
    operation: (transaction: OwnerAuthTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return this.transactionRunner.write((transaction) =>
      operation(new SqlOwnerAuthTransaction(transaction)),
    );
  }

  public async snapshot(): Promise<OwnerAuthRepositorySnapshot> {
    return this.transactionRunner.write(async (transaction) => {
      return new SqlOwnerAuthTransaction(transaction).snapshot();
    });
  }

  public async listAuditRecords(): Promise<readonly OwnerAuthAuditRecord[]> {
    return this.transactionRunner.write(async (transaction) => {
      return new SqlOwnerAuthTransaction(transaction).listAuditRecords();
    });
  }

  public async close(): Promise<void> {
    await this.context.close();
  }

  private static async open(
    context: SqlDatabaseContext,
    options: SqlOwnerAuthRepositoryOptions,
  ): Promise<SqlOwnerAuthRepository> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      return new SqlOwnerAuthRepository(context, options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY);
    } catch (error) {
      await context.close();
      throw error;
    }
  }
}

class SqlOwnerAuthTransaction implements OwnerAuthTransaction {
  private readonly transaction: Transaction<SqlStorageSchema>;

  public constructor(transaction: Transaction<SqlStorageSchema>) {
    this.transaction = transaction;
  }

  public async getInitialClaim(): Promise<PersistedInitialClaim | null> {
    const row = await this.transaction
      .selectFrom("od_owner_claim")
      .selectAll()
      .where("singleton_id", "=", 1)
      .executeTakeFirst();
    return row === undefined ? null : decodeInitialClaim(row);
  }

  public async setInitialClaim(claim: PersistedInitialClaim | null): Promise<void> {
    if (claim === null) {
      await this.transaction.deleteFrom("od_owner_claim").where("singleton_id", "=", 1).execute();
      return;
    }

    await this.transaction
      .insertInto("od_owner_claim")
      .values({
        bearer_digest: claim.tokenDigest,
        created_at_ms: claim.createdAt,
        expires_at_ms: claim.expiresAt,
        singleton_id: 1,
      })
      .onConflict((conflict) =>
        conflict.column("singleton_id").doUpdateSet({
          bearer_digest: claim.tokenDigest,
          created_at_ms: claim.createdAt,
          expires_at_ms: claim.expiresAt,
        }),
      )
      .execute();
  }

  public async getOwner(): Promise<PersistedOwnerCredential | null> {
    const row = await this.transaction
      .selectFrom("od_owner_credential")
      .selectAll()
      .where("singleton_id", "=", 1)
      .executeTakeFirst();
    return row === undefined ? null : decodeOwner(row);
  }

  public async setOwner(owner: PersistedOwnerCredential): Promise<void> {
    await this.transaction
      .insertInto("od_owner_credential")
      .values({
        created_at_ms: owner.createdAt,
        credential_version: owner.credentialVersion,
        owner_id: owner.ownerId,
        password_phc: owner.passwordPhc,
        singleton_id: 1,
        updated_at_ms: owner.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("singleton_id").doUpdateSet({
          credential_version: owner.credentialVersion,
          owner_id: owner.ownerId,
          password_phc: owner.passwordPhc,
          updated_at_ms: owner.updatedAt,
        }),
      )
      .execute();
  }

  public async listRecoveryCodes(): Promise<readonly PersistedRecoveryCode[]> {
    const rows = await this.transaction
      .selectFrom("od_owner_recovery_credentials")
      .selectAll()
      .orderBy("recovery_id")
      .execute();
    return Object.freeze(rows.map(decodeRecoveryCode));
  }

  public async setRecoveryCodes(codes: readonly PersistedRecoveryCode[]): Promise<void> {
    await this.transaction.deleteFrom("od_owner_recovery_credentials").execute();
    if (codes.length === 0) {
      return;
    }
    const owner = await this.requireOwner();
    await this.transaction
      .insertInto("od_owner_recovery_credentials")
      .values(
        codes.map((code) => ({
          bearer_digest: code.digest,
          consumed_at_ms: code.consumedAt ?? null,
          created_at_ms: code.createdAt,
          credential_version: code.credentialVersion,
          owner_id: owner.ownerId,
          recovery_id: code.codeId,
        })),
      )
      .execute();
  }

  public async findRecoveryCodeByDigest(digest: string): Promise<PersistedRecoveryCode | null> {
    const row = await this.transaction
      .selectFrom("od_owner_recovery_credentials")
      .selectAll()
      .where("bearer_digest", "=", digest)
      .executeTakeFirst();
    return row === undefined ? null : decodeRecoveryCode(row);
  }

  public async saveRecoveryCode(code: PersistedRecoveryCode): Promise<void> {
    const owner = await this.requireOwner();
    await this.transaction
      .insertInto("od_owner_recovery_credentials")
      .values({
        bearer_digest: code.digest,
        consumed_at_ms: code.consumedAt ?? null,
        created_at_ms: code.createdAt,
        credential_version: code.credentialVersion,
        owner_id: owner.ownerId,
        recovery_id: code.codeId,
      })
      .onConflict((conflict) =>
        conflict.column("recovery_id").doUpdateSet({
          bearer_digest: code.digest,
          consumed_at_ms: code.consumedAt ?? null,
          credential_version: code.credentialVersion,
        }),
      )
      .execute();
  }

  public async findRecoveryStateByDigest(digest: string): Promise<PersistedRecoveryState | null> {
    const row = await this.transaction
      .selectFrom("od_owner_recovery_states")
      .selectAll()
      .where("bearer_digest", "=", digest)
      .executeTakeFirst();
    return row === undefined ? null : decodeRecoveryState(row);
  }

  public async saveRecoveryState(state: PersistedRecoveryState): Promise<void> {
    await this.transaction
      .insertInto("od_owner_recovery_states")
      .values({
        bearer_digest: state.tokenDigest,
        consumed_at_ms: state.consumedAt ?? null,
        created_at_ms: state.createdAt,
        credential_version: state.credentialVersion,
        expires_at_ms: state.expiresAt,
        owner_id: state.ownerId,
        state_id: state.stateId,
      })
      .onConflict((conflict) =>
        conflict.column("state_id").doUpdateSet({
          bearer_digest: state.tokenDigest,
          consumed_at_ms: state.consumedAt ?? null,
          credential_version: state.credentialVersion,
          expires_at_ms: state.expiresAt,
          owner_id: state.ownerId,
        }),
      )
      .execute();
  }

  public async findSessionByTokenDigest(digest: string): Promise<PersistedSession | null> {
    const row = await this.transaction
      .selectFrom("od_owner_sessions")
      .selectAll()
      .where("bearer_digest", "=", digest)
      .executeTakeFirst();
    return row === undefined ? null : decodeSession(row);
  }

  public async findSessionById(sessionId: string): Promise<PersistedSession | null> {
    const row = await this.transaction
      .selectFrom("od_owner_sessions")
      .selectAll()
      .where("session_id", "=", sessionId)
      .executeTakeFirst();
    return row === undefined ? null : decodeSession(row);
  }

  public async listSessions(): Promise<readonly PersistedSession[]> {
    const rows = await this.transaction
      .selectFrom("od_owner_sessions")
      .selectAll()
      .orderBy("session_id")
      .execute();
    return Object.freeze(rows.map(decodeSession));
  }

  public async saveSession(session: PersistedSession): Promise<void> {
    await this.transaction
      .insertInto("od_owner_sessions")
      .values({
        absolute_expires_at_ms: session.absoluteExpiresAt,
        authenticated_at_ms: session.authenticatedAt,
        bearer_digest: session.tokenDigest,
        created_at_ms: session.createdAt,
        credential_version: session.credentialVersion,
        idle_expires_at_ms: session.idleExpiresAt,
        last_used_at_ms: session.lastUsedAt,
        owner_id: session.ownerId,
        revoked_at_ms: session.revokedAt ?? null,
        session_id: session.sessionId,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          absolute_expires_at_ms: session.absoluteExpiresAt,
          authenticated_at_ms: session.authenticatedAt,
          bearer_digest: session.tokenDigest,
          credential_version: session.credentialVersion,
          idle_expires_at_ms: session.idleExpiresAt,
          last_used_at_ms: session.lastUsedAt,
          owner_id: session.ownerId,
          revoked_at_ms: session.revokedAt ?? null,
        }),
      )
      .execute();
  }

  public async getLoginAttempts(key: string): Promise<PersistedLoginAttempts | null> {
    const rows = await this.transaction
      .selectFrom("od_owner_login_attempts")
      .selectAll()
      .where("limiter_key", "=", key)
      .orderBy("attempt_sequence")
      .execute();
    if (rows.length === 0) {
      return null;
    }
    return decodeLoginAttempts(rows);
  }

  public async setLoginAttempts(attempts: PersistedLoginAttempts): Promise<void> {
    await this.deleteLoginAttempts(attempts.key);
    if (attempts.attemptedAt.length === 0) {
      return;
    }
    await this.transaction
      .insertInto("od_owner_login_attempts")
      .values(
        attempts.attemptedAt.map((attemptedAt, attemptSequence) => ({
          attempt_sequence: attemptSequence,
          attempted_at_ms: attemptedAt,
          limiter_key: attempts.key,
        })),
      )
      .execute();
  }

  public async deleteLoginAttempts(key: string): Promise<void> {
    await this.transaction
      .deleteFrom("od_owner_login_attempts")
      .where("limiter_key", "=", key)
      .execute();
  }

  public async appendAuditRecord(record: OwnerAuthAuditRecord): Promise<void> {
    await this.transaction
      .insertInto("od_owner_auth_audit")
      .values({
        audit_id: record.auditId,
        event_name: record.event,
        occurred_at_ms: record.occurredAt,
        owner_id: record.ownerId ?? null,
        session_id: record.sessionId ?? null,
        target_session_id: record.targetSessionId ?? null,
      })
      .execute();
  }

  public async listAuditRecords(): Promise<readonly OwnerAuthAuditRecord[]> {
    const rows = await this.transaction
      .selectFrom("od_owner_auth_audit")
      .selectAll()
      .orderBy("audit_id")
      .execute();
    return Object.freeze(rows.map(decodeAuditRecord));
  }

  public async snapshot(): Promise<OwnerAuthRepositorySnapshot> {
    const [claim, owner, recoveryCodes, recoveryStates, sessions, loginAttempts, auditRecords] =
      await Promise.all([
        this.getInitialClaim(),
        this.getOwner(),
        this.listRecoveryCodes(),
        this.listRecoveryStates(),
        this.listSessions(),
        this.listAllLoginAttempts(),
        this.listAuditRecords(),
      ]);
    return deepFreeze({
      auditRecords,
      claim,
      loginAttempts,
      owner,
      recoveryCodes,
      recoveryStates,
      sessions,
    });
  }

  private async requireOwner(): Promise<PersistedOwnerCredential> {
    const owner = await this.getOwner();
    if (owner === null) {
      throw new SqlStorageError(
        "DATA_CORRUPT",
        "Owner authentication storage requires an owner credential.",
      );
    }
    return owner;
  }

  private async listRecoveryStates(): Promise<readonly PersistedRecoveryState[]> {
    const rows = await this.transaction
      .selectFrom("od_owner_recovery_states")
      .selectAll()
      .orderBy("state_id")
      .execute();
    return Object.freeze(rows.map(decodeRecoveryState));
  }

  private async listAllLoginAttempts(): Promise<readonly PersistedLoginAttempts[]> {
    const rows = await this.transaction
      .selectFrom("od_owner_login_attempts")
      .selectAll()
      .orderBy("limiter_key")
      .orderBy("attempt_sequence")
      .execute();
    const groups = new Map<string, Selectable<OwnerLoginAttemptsTable>[]>();
    for (const row of rows) {
      const group = groups.get(row.limiter_key) ?? [];
      group.push(row);
      groups.set(row.limiter_key, group);
    }
    return Object.freeze([...groups.values()].map(decodeLoginAttempts));
  }
}

function decodeInitialClaim(row: Selectable<OwnerClaimTable>): PersistedInitialClaim {
  return deepFreeze({
    tokenDigest: row.bearer_digest,
    createdAt: parseInstant(row.created_at_ms, "Owner claim creation time"),
    expiresAt: parseInstant(row.expires_at_ms, "Owner claim expiry"),
  });
}

function decodeOwner(row: Selectable<OwnerCredentialTable>): PersistedOwnerCredential {
  return deepFreeze({
    ownerId: row.owner_id,
    passwordPhc: row.password_phc,
    credentialVersion: parsePositiveInteger(row.credential_version, "Owner credential version"),
    createdAt: parseInstant(row.created_at_ms, "Owner creation time"),
    updatedAt: parseInstant(row.updated_at_ms, "Owner credential update time"),
  });
}

function decodeRecoveryCode(row: Selectable<OwnerRecoveryCredentialsTable>): PersistedRecoveryCode {
  const consumedAt = parseOptionalInstant(
    row.consumed_at_ms,
    "Recovery credential consumption time",
  );
  return deepFreeze({
    codeId: row.recovery_id,
    digest: row.bearer_digest,
    credentialVersion: parsePositiveInteger(row.credential_version, "Recovery credential version"),
    createdAt: parseInstant(row.created_at_ms, "Recovery credential creation time"),
    ...(consumedAt === undefined ? {} : { consumedAt }),
  });
}

function decodeRecoveryState(row: Selectable<OwnerRecoveryStatesTable>): PersistedRecoveryState {
  const consumedAt = parseOptionalInstant(row.consumed_at_ms, "Recovery state consumption time");
  return deepFreeze({
    stateId: row.state_id,
    tokenDigest: row.bearer_digest,
    ownerId: row.owner_id,
    credentialVersion: parsePositiveInteger(
      row.credential_version,
      "Recovery state credential version",
    ),
    createdAt: parseInstant(row.created_at_ms, "Recovery state creation time"),
    expiresAt: parseInstant(row.expires_at_ms, "Recovery state expiry"),
    ...(consumedAt === undefined ? {} : { consumedAt }),
  });
}

function decodeSession(row: Selectable<OwnerSessionsTable>): PersistedSession {
  const revokedAt = parseOptionalInstant(row.revoked_at_ms, "Session revocation time");
  return deepFreeze({
    sessionId: row.session_id,
    tokenDigest: row.bearer_digest,
    ownerId: row.owner_id,
    credentialVersion: parsePositiveInteger(row.credential_version, "Session credential version"),
    createdAt: parseInstant(row.created_at_ms, "Session creation time"),
    authenticatedAt: parseInstant(row.authenticated_at_ms, "Session authentication time"),
    lastUsedAt: parseInstant(row.last_used_at_ms, "Session last-use time"),
    idleExpiresAt: parseInstant(row.idle_expires_at_ms, "Session idle expiry"),
    absoluteExpiresAt: parseInstant(row.absolute_expires_at_ms, "Session absolute expiry"),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  });
}

function decodeLoginAttempts(
  rows: readonly Selectable<OwnerLoginAttemptsTable>[],
): PersistedLoginAttempts {
  const first = rows[0];
  if (first === undefined) {
    throw new SqlStorageError("DATA_CORRUPT", "A login-attempt record requires at least one row.");
  }
  return deepFreeze({
    key: first.limiter_key,
    attemptedAt: rows.map((row, index) => {
      const sequence = parseSafeNonNegativeInteger(row.attempt_sequence, "Login attempt sequence");
      if (row.limiter_key !== first.limiter_key || sequence !== index) {
        throw new SqlStorageError(
          "DATA_CORRUPT",
          "The durable login-attempt sequence is inconsistent.",
        );
      }
      return parseInstant(row.attempted_at_ms, "Login attempt time");
    }),
  });
}

function decodeAuditRecord(row: Selectable<OwnerAuthAuditTable>): OwnerAuthAuditRecord {
  return deepFreeze({
    auditId: row.audit_id,
    event: row.event_name as OwnerAuthAuditRecord["event"],
    occurredAt: parseInstant(row.occurred_at_ms, "Owner-auth audit time"),
    ...(row.owner_id === null ? {} : { ownerId: row.owner_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.target_session_id === null ? {} : { targetSessionId: row.target_session_id }),
  });
}

function parseInstant(value: number | string | bigint, label: string): number {
  return parseSafeNonNegativeInteger(value, label);
}

function parsePositiveInteger(value: number | string | bigint, label: string): number {
  const parsed = parseSafeNonNegativeInteger(value, label);
  if (parsed === 0) {
    throw new SqlStorageError("DATA_CORRUPT", `${label} must be greater than zero.`);
  }
  return parsed;
}

function parseOptionalInstant(
  value: number | string | bigint | null,
  label: string,
): number | undefined {
  return value === null ? undefined : parseInstant(value, label);
}
