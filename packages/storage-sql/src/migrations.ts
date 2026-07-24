import { createHash } from "node:crypto";

import { sql, type Kysely, type Selectable } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";

import { SqlStorageError } from "./errors.ts";
import type { MigrationManifestTable, SqlBackend, SqlStorageSchema } from "./schema.ts";

const MIGRATION_TABLE_NAME = "od_kysely_migration";
const MIGRATION_LOCK_TABLE_NAME = "od_kysely_migration_lock";
const MIGRATION_0001_NAME = "0001_event_store";
const MIGRATION_0002_NAME = "0002_owner_auth";

const MIGRATION_0001_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_write_gate (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      next_global_position INTEGER NOT NULL CHECK (next_global_position > 0)
    ) STRICT`,
    `INSERT INTO od_write_gate (singleton_id, revision, next_global_position)
      VALUES (1, 0, 1)`,
    `CREATE TABLE od_event_streams (
      stream_id TEXT PRIMARY KEY CHECK (length(trim(stream_id)) > 0),
      version INTEGER NOT NULL CHECK (version >= 0)
    ) STRICT`,
    `CREATE TABLE od_events (
      event_id TEXT PRIMARY KEY CHECK (length(trim(event_id)) > 0),
      stream_id TEXT NOT NULL REFERENCES od_event_streams(stream_id) ON DELETE RESTRICT,
      stream_version INTEGER NOT NULL CHECK (stream_version > 0),
      global_position INTEGER NOT NULL UNIQUE CHECK (global_position > 0),
      event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (stream_id, stream_version)
    ) STRICT`,
    `CREATE INDEX od_events_stream_order
      ON od_events (stream_id, stream_version)`,
    `CREATE TABLE od_migration_manifest (
      migration_name TEXT PRIMARY KEY,
      checksum_sha256 TEXT NOT NULL
        CHECK (length(checksum_sha256) = 64)
    ) STRICT`,
  ],
  postgres: [
    `CREATE TABLE od_write_gate (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      revision BIGINT NOT NULL CHECK (revision >= 0),
      next_global_position BIGINT NOT NULL CHECK (next_global_position > 0)
    )`,
    `INSERT INTO od_write_gate (singleton_id, revision, next_global_position)
      VALUES (1, 0, 1)`,
    `CREATE TABLE od_event_streams (
      stream_id TEXT PRIMARY KEY CHECK (length(btrim(stream_id)) > 0),
      version BIGINT NOT NULL CHECK (version >= 0)
    )`,
    `CREATE TABLE od_events (
      event_id TEXT PRIMARY KEY CHECK (length(btrim(event_id)) > 0),
      stream_id TEXT NOT NULL REFERENCES od_event_streams(stream_id) ON DELETE RESTRICT,
      stream_version BIGINT NOT NULL CHECK (stream_version > 0),
      global_position BIGINT NOT NULL UNIQUE CHECK (global_position > 0),
      event_type TEXT NOT NULL CHECK (length(btrim(event_type)) > 0),
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (stream_id, stream_version)
    )`,
    `CREATE INDEX od_events_stream_order
      ON od_events (stream_id, stream_version)`,
    `CREATE TABLE od_migration_manifest (
      migration_name TEXT PRIMARY KEY,
      checksum_sha256 TEXT NOT NULL
        CHECK (length(checksum_sha256) = 64)
    )`,
  ],
};

const MIGRATION_0001_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0001_NAME,
      sql: MIGRATION_0001_SQL,
    }),
  )
  .digest("hex");

const MIGRATION_0002_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_owner_claim (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      bearer_digest TEXT NOT NULL UNIQUE
        CHECK (
          length(bearer_digest) = 71
          AND substr(bearer_digest, 1, 7) = 'sha256:'
          AND substr(bearer_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms)
    ) STRICT`,
    `CREATE TABLE od_owner_credential (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      owner_id TEXT NOT NULL UNIQUE
        CHECK (length(trim(owner_id)) > 0 AND length(owner_id) <= 200),
      password_phc TEXT NOT NULL
        CHECK (
          length(password_phc) > 1
          AND length(password_phc) <= 2048
          AND substr(password_phc, 1, 1) = '$'
        ),
      credential_version INTEGER NOT NULL CHECK (credential_version > 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
    ) STRICT`,
    `CREATE TABLE od_owner_recovery_credentials (
      recovery_id TEXT PRIMARY KEY
        CHECK (length(trim(recovery_id)) > 0 AND length(recovery_id) <= 200),
      bearer_digest TEXT NOT NULL UNIQUE
        CHECK (
          length(bearer_digest) = 74
          AND substr(bearer_digest, 1, 10) = 'v1:sha256:'
          AND substr(bearer_digest, 11) NOT GLOB '*[^0-9a-f]*'
        ),
      owner_id TEXT NOT NULL
        REFERENCES od_owner_credential(owner_id) ON DELETE RESTRICT,
      credential_version INTEGER NOT NULL CHECK (credential_version > 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      consumed_at_ms INTEGER
        CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
    ) STRICT`,
    `CREATE INDEX od_owner_recovery_credentials_version
      ON od_owner_recovery_credentials (owner_id, credential_version)`,
    `CREATE TABLE od_owner_recovery_states (
      state_id TEXT PRIMARY KEY
        CHECK (length(trim(state_id)) > 0 AND length(state_id) <= 200),
      bearer_digest TEXT NOT NULL UNIQUE
        CHECK (
          length(bearer_digest) = 71
          AND substr(bearer_digest, 1, 7) = 'sha256:'
          AND substr(bearer_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
      owner_id TEXT NOT NULL
        REFERENCES od_owner_credential(owner_id) ON DELETE RESTRICT,
      credential_version INTEGER NOT NULL CHECK (credential_version > 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
      consumed_at_ms INTEGER
        CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
    ) STRICT`,
    `CREATE INDEX od_owner_recovery_states_version
      ON od_owner_recovery_states (owner_id, credential_version)`,
    `CREATE TABLE od_owner_sessions (
      session_id TEXT PRIMARY KEY
        CHECK (length(trim(session_id)) > 0 AND length(session_id) <= 200),
      bearer_digest TEXT NOT NULL UNIQUE
        CHECK (
          length(bearer_digest) = 71
          AND substr(bearer_digest, 1, 7) = 'sha256:'
          AND substr(bearer_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
      owner_id TEXT NOT NULL
        REFERENCES od_owner_credential(owner_id) ON DELETE RESTRICT,
      credential_version INTEGER NOT NULL CHECK (credential_version > 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      authenticated_at_ms INTEGER NOT NULL CHECK (authenticated_at_ms >= created_at_ms),
      last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= created_at_ms),
      idle_expires_at_ms INTEGER NOT NULL CHECK (idle_expires_at_ms > last_used_at_ms),
      absolute_expires_at_ms INTEGER NOT NULL
        CHECK (
          absolute_expires_at_ms > created_at_ms
          AND idle_expires_at_ms <= absolute_expires_at_ms
        ),
      revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms)
    ) STRICT`,
    `CREATE INDEX od_owner_sessions_owner_created
      ON od_owner_sessions (owner_id, created_at_ms, session_id)`,
    `CREATE TABLE od_owner_login_attempts (
      limiter_key TEXT NOT NULL
        CHECK (
          limiter_key = 'account:owner'
          OR (
            length(limiter_key) = 78
            AND substr(limiter_key, 1, 14) = 'source:sha256:'
            AND substr(limiter_key, 15) NOT GLOB '*[^0-9a-f]*'
          )
        ),
      attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence >= 0),
      attempted_at_ms INTEGER NOT NULL CHECK (attempted_at_ms >= 0),
      PRIMARY KEY (limiter_key, attempt_sequence)
    ) STRICT`,
    `CREATE TABLE od_owner_auth_audit (
      audit_id TEXT PRIMARY KEY
        CHECK (length(trim(audit_id)) > 0 AND length(audit_id) <= 200),
      event_name TEXT NOT NULL CHECK (
        event_name IN (
          'owner.auth.claim-issued',
          'owner.auth.claimed',
          'owner.auth.login-succeeded',
          'owner.auth.reauthenticated',
          'owner.auth.recovery-begun',
          'owner.auth.recovered',
          'owner.auth.session-revoked',
          'owner.auth.session-logged-out'
        )
      ),
      occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
      owner_id TEXT CHECK (owner_id IS NULL OR length(trim(owner_id)) > 0),
      session_id TEXT CHECK (session_id IS NULL OR length(trim(session_id)) > 0),
      target_session_id TEXT
        CHECK (target_session_id IS NULL OR length(trim(target_session_id)) > 0)
    ) STRICT`,
    `CREATE INDEX od_owner_auth_audit_order
      ON od_owner_auth_audit (occurred_at_ms, audit_id)`,
    `CREATE TRIGGER od_owner_auth_audit_no_update
      BEFORE UPDATE ON od_owner_auth_audit
      BEGIN
        SELECT RAISE(ABORT, 'owner auth audit is append-only');
      END`,
    `CREATE TRIGGER od_owner_auth_audit_no_delete
      BEFORE DELETE ON od_owner_auth_audit
      BEGIN
        SELECT RAISE(ABORT, 'owner auth audit is append-only');
      END`,
  ],
  postgres: [
    `CREATE TABLE od_owner_claim (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      bearer_digest TEXT NOT NULL UNIQUE
        CHECK (bearer_digest ~ '^sha256:[0-9a-f]{64}$'),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms)
    )`,
    `CREATE TABLE od_owner_credential (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      owner_id TEXT NOT NULL UNIQUE
        CHECK (length(btrim(owner_id)) > 0 AND length(owner_id) <= 200),
      password_phc TEXT NOT NULL
        CHECK (
          length(password_phc) > 1
          AND length(password_phc) <= 2048
          AND substr(password_phc, 1, 1) = '$'
        ),
      credential_version BIGINT NOT NULL CHECK (credential_version > 0),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= created_at_ms)
    )`,
    `CREATE TABLE od_owner_recovery_credentials (
      recovery_id TEXT PRIMARY KEY
        CHECK (length(btrim(recovery_id)) > 0 AND length(recovery_id) <= 200),
      bearer_digest TEXT NOT NULL UNIQUE
        CHECK (bearer_digest ~ '^v1:sha256:[0-9a-f]{64}$'),
      owner_id TEXT NOT NULL
        REFERENCES od_owner_credential(owner_id) ON DELETE RESTRICT,
      credential_version BIGINT NOT NULL CHECK (credential_version > 0),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      consumed_at_ms BIGINT
        CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
    )`,
    `CREATE INDEX od_owner_recovery_credentials_version
      ON od_owner_recovery_credentials (owner_id, credential_version)`,
    `CREATE TABLE od_owner_recovery_states (
      state_id TEXT PRIMARY KEY
        CHECK (length(btrim(state_id)) > 0 AND length(state_id) <= 200),
      bearer_digest TEXT NOT NULL UNIQUE
        CHECK (bearer_digest ~ '^sha256:[0-9a-f]{64}$'),
      owner_id TEXT NOT NULL
        REFERENCES od_owner_credential(owner_id) ON DELETE RESTRICT,
      credential_version BIGINT NOT NULL CHECK (credential_version > 0),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms),
      consumed_at_ms BIGINT
        CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
    )`,
    `CREATE INDEX od_owner_recovery_states_version
      ON od_owner_recovery_states (owner_id, credential_version)`,
    `CREATE TABLE od_owner_sessions (
      session_id TEXT PRIMARY KEY
        CHECK (length(btrim(session_id)) > 0 AND length(session_id) <= 200),
      bearer_digest TEXT NOT NULL UNIQUE
        CHECK (bearer_digest ~ '^sha256:[0-9a-f]{64}$'),
      owner_id TEXT NOT NULL
        REFERENCES od_owner_credential(owner_id) ON DELETE RESTRICT,
      credential_version BIGINT NOT NULL CHECK (credential_version > 0),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      authenticated_at_ms BIGINT NOT NULL CHECK (authenticated_at_ms >= created_at_ms),
      last_used_at_ms BIGINT NOT NULL CHECK (last_used_at_ms >= created_at_ms),
      idle_expires_at_ms BIGINT NOT NULL CHECK (idle_expires_at_ms > last_used_at_ms),
      absolute_expires_at_ms BIGINT NOT NULL
        CHECK (
          absolute_expires_at_ms > created_at_ms
          AND idle_expires_at_ms <= absolute_expires_at_ms
        ),
      revoked_at_ms BIGINT CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms)
    )`,
    `CREATE INDEX od_owner_sessions_owner_created
      ON od_owner_sessions (owner_id, created_at_ms, session_id)`,
    `CREATE TABLE od_owner_login_attempts (
      limiter_key TEXT NOT NULL CHECK (
        limiter_key = 'account:owner'
        OR limiter_key ~ '^source:sha256:[0-9a-f]{64}$'
      ),
      attempt_sequence BIGINT NOT NULL CHECK (attempt_sequence >= 0),
      attempted_at_ms BIGINT NOT NULL CHECK (attempted_at_ms >= 0),
      PRIMARY KEY (limiter_key, attempt_sequence)
    )`,
    `CREATE TABLE od_owner_auth_audit (
      audit_id TEXT PRIMARY KEY
        CHECK (length(btrim(audit_id)) > 0 AND length(audit_id) <= 200),
      event_name TEXT NOT NULL CHECK (
        event_name IN (
          'owner.auth.claim-issued',
          'owner.auth.claimed',
          'owner.auth.login-succeeded',
          'owner.auth.reauthenticated',
          'owner.auth.recovery-begun',
          'owner.auth.recovered',
          'owner.auth.session-revoked',
          'owner.auth.session-logged-out'
        )
      ),
      occurred_at_ms BIGINT NOT NULL CHECK (occurred_at_ms >= 0),
      owner_id TEXT CHECK (owner_id IS NULL OR length(btrim(owner_id)) > 0),
      session_id TEXT CHECK (session_id IS NULL OR length(btrim(session_id)) > 0),
      target_session_id TEXT
        CHECK (target_session_id IS NULL OR length(btrim(target_session_id)) > 0)
    )`,
    `CREATE INDEX od_owner_auth_audit_order
      ON od_owner_auth_audit (occurred_at_ms, audit_id)`,
    `CREATE FUNCTION od_owner_auth_audit_append_only()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'owner auth audit is append-only';
      END;
      $$`,
    `CREATE TRIGGER od_owner_auth_audit_no_mutation
      BEFORE UPDATE OR DELETE ON od_owner_auth_audit
      FOR EACH ROW
      EXECUTE FUNCTION od_owner_auth_audit_append_only()`,
  ],
};

const MIGRATION_0002_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0002_NAME,
      sql: MIGRATION_0002_SQL,
    }),
  )
  .digest("hex");

const MIGRATION_MANIFEST = Object.freeze([
  Object.freeze({
    name: MIGRATION_0001_NAME,
    checksum: MIGRATION_0001_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0002_NAME,
    checksum: MIGRATION_0002_CHECKSUM,
  }),
]);

export async function applySqlMigrations(
  database: Kysely<SqlStorageSchema>,
  backend: SqlBackend,
  migrationTableSchema?: string,
): Promise<void> {
  const migrator = createMigrator(database, backend, migrationTableSchema);
  const result = await migrator.migrateToLatest();

  if (result.error !== undefined) {
    throw new SqlStorageError(
      "MIGRATION_FAILED",
      "The SQL schema migration failed; normal service startup remains disabled.",
      { cause: result.error },
    );
  }

  await verifySqlMigrations(database);
}

export async function verifySqlMigrations(database: Kysely<SqlStorageSchema>): Promise<void> {
  let executedRows: readonly { name: string }[];
  let manifestRows: readonly Selectable<MigrationManifestTable>[];

  try {
    [executedRows, manifestRows] = await Promise.all([
      database.selectFrom(MIGRATION_TABLE_NAME).select("name").orderBy("name").execute(),
      database
        .selectFrom("od_migration_manifest")
        .select(["migration_name", "checksum_sha256"])
        .orderBy("migration_name")
        .execute(),
    ]);
  } catch (error) {
    if (isMissingTableError(error)) {
      throw new SqlStorageError(
        "MIGRATION_PENDING",
        "The SQL schema has pending migration 0001; run the explicit migrate workflow.",
        { cause: error },
      );
    }
    throw new SqlStorageError(
      "MIGRATION_FAILED",
      "The SQL migration state could not be inspected.",
      { cause: error },
    );
  }

  const knownNames = new Set<string>(MIGRATION_MANIFEST.map((migration) => migration.name));
  const unknownName = executedRows.find((row) => !knownNames.has(row.name))?.name;
  const unknownManifestName = manifestRows.find(
    (row) => !knownNames.has(row.migration_name),
  )?.migration_name;
  if (unknownName !== undefined || unknownManifestName !== undefined) {
    throw new SqlStorageError(
      "MIGRATION_UNKNOWN",
      `The database contains unknown migration ${unknownName ?? unknownManifestName}.`,
    );
  }

  if (
    executedRows.length !== MIGRATION_MANIFEST.length ||
    manifestRows.length !== MIGRATION_MANIFEST.length
  ) {
    throw new SqlStorageError(
      "MIGRATION_PENDING",
      "The SQL schema does not contain the complete ordered migration manifest.",
    );
  }

  for (let index = 0; index < MIGRATION_MANIFEST.length; index += 1) {
    const expected = MIGRATION_MANIFEST[index];
    const executed = executedRows[index];
    const recorded = manifestRows[index];

    if (
      expected === undefined ||
      executed?.name !== expected.name ||
      recorded?.migration_name !== expected.name
    ) {
      throw new SqlStorageError(
        "MIGRATION_UNKNOWN",
        "The database migration order does not match the released manifest.",
      );
    }
    if (recorded.checksum_sha256 !== expected.checksum) {
      throw new SqlStorageError(
        "MIGRATION_CHECKSUM_MISMATCH",
        `Migration ${expected.name} does not match its released SHA-256 checksum.`,
      );
    }
  }
}

function createMigrator(
  database: Kysely<SqlStorageSchema>,
  backend: SqlBackend,
  migrationTableSchema?: string,
): Migrator {
  const provider: MigrationProvider = {
    getMigrations: async () => ({
      [MIGRATION_0001_NAME]: createMigration0001(backend),
      [MIGRATION_0002_NAME]: createMigration0002(backend),
    }),
  };

  return new Migrator({
    allowUnorderedMigrations: false,
    db: database,
    migrationLockTableName: MIGRATION_LOCK_TABLE_NAME,
    ...(migrationTableSchema === undefined ? {} : { migrationTableSchema }),
    migrationTableName: MIGRATION_TABLE_NAME,
    provider,
  });
}

function createMigration0001(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0001_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0001_CHECKSUM,
          migration_name: MIGRATION_0001_NAME,
        })
        .execute();
    },
  };
}

function createMigration0002(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0002_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0002_CHECKSUM,
          migration_name: MIGRATION_0002_NAME,
        })
        .execute();
    },
  };
}

function isMissingTableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code = Reflect.get(error, "code");
  return code === "SQLITE_ERROR" || code === "42P01";
}
