import { createHash } from "node:crypto";

import { sql, type Kysely, type Selectable } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";

import { SqlStorageError } from "./errors.ts";
import type { MigrationManifestTable, SqlBackend, SqlStorageSchema } from "./schema.ts";

const MIGRATION_TABLE_NAME = "od_kysely_migration";
const MIGRATION_LOCK_TABLE_NAME = "od_kysely_migration_lock";
const MIGRATION_0001_NAME = "0001_event_store";
const MIGRATION_0002_NAME = "0002_owner_auth";
const MIGRATION_0003_NAME = "0003_device_identity";
const MIGRATION_0004_NAME = "0004_discord_state";
const MIGRATION_0005_NAME = "0005_device_channel";
const MIGRATION_0006_NAME = "0006_device_channel_inbound_effect";
const MIGRATION_0007_NAME = "0007_configuration_state";
const MIGRATION_0008_NAME = "0008_approval_state";
const MIGRATION_0009_NAME = "0009_action_authorizations";
const MIGRATION_0010_NAME = "0010_artifact_index_state";
const MIGRATION_0011_NAME = "0011_device_observations";
const MIGRATION_0012_NAME = "0012_owner_claim_replacement_audit";

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

const MIGRATION_0003_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_device_certificate_authority (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      instance_id TEXT NOT NULL UNIQUE
        CHECK (length(instance_id) BETWEEN 1 AND 128 AND instance_id = trim(instance_id)),
      key_id TEXT NOT NULL UNIQUE
        CHECK (length(key_id) BETWEEN 1 AND 200 AND key_id = trim(key_id)),
      certificate_pem TEXT NOT NULL
        CHECK (
          length(certificate_pem) BETWEEN 1 AND 65536
          AND substr(certificate_pem, 1, 27) = '-----BEGIN CERTIFICATE-----'
          AND instr(certificate_pem, 'PRIVATE KEY') = 0
        ),
      spki_sha256 TEXT NOT NULL
        CHECK (
          length(spki_sha256) = 50
          AND substr(spki_sha256, 1, 7) = 'sha256:'
          AND substr(spki_sha256, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
      status TEXT NOT NULL CHECK (status = 'active'),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      not_before_ms INTEGER NOT NULL CHECK (not_before_ms <= created_at_ms),
      not_after_ms INTEGER NOT NULL CHECK (not_after_ms > created_at_ms)
    ) STRICT`,
    `CREATE TABLE od_device_identities (
      device_id TEXT PRIMARY KEY
        CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id = trim(device_id)),
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      identity_generation INTEGER NOT NULL CHECK (identity_generation > 0),
      allowed_bootstrap_roles_json TEXT NOT NULL
        CHECK (length(allowed_bootstrap_roles_json) BETWEEN 2 AND 8192),
      os_family TEXT NOT NULL CHECK (os_family IN ('linux', 'macos', 'windows')),
      architecture TEXT NOT NULL
        CHECK (length(architecture) BETWEEN 1 AND 128 AND architecture = trim(architecture)),
      hostname TEXT NOT NULL
        CHECK (length(hostname) BETWEEN 1 AND 128 AND hostname = trim(hostname)),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      revoked_at_ms INTEGER,
      CHECK (
        (status = 'active' AND revoked_at_ms IS NULL)
        OR (status = 'revoked' AND revoked_at_ms >= created_at_ms)
      )
    ) STRICT`,
    `CREATE TABLE od_device_certificates (
      serial_number TEXT PRIMARY KEY
        CHECK (
          length(serial_number) = 32
          AND serial_number NOT GLOB '*[^0-9a-f]*'
        ),
      device_id TEXT NOT NULL
        REFERENCES od_device_identities(device_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      generation INTEGER NOT NULL CHECK (generation > 0),
      certificate_pem TEXT NOT NULL
        CHECK (
          length(certificate_pem) BETWEEN 1 AND 65536
          AND substr(certificate_pem, 1, 27) = '-----BEGIN CERTIFICATE-----'
          AND instr(certificate_pem, 'PRIVATE KEY') = 0
        ),
      public_key_spki_sha256 TEXT NOT NULL
        CHECK (
          length(public_key_spki_sha256) = 50
          AND substr(public_key_spki_sha256, 1, 7) = 'sha256:'
          AND substr(public_key_spki_sha256, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
      status TEXT NOT NULL
        CHECK (status IN ('active', 'overlap', 'pending', 'retired', 'revoked')),
      not_before_ms INTEGER NOT NULL CHECK (not_before_ms <= issued_at_ms),
      not_after_ms INTEGER NOT NULL CHECK (not_after_ms > issued_at_ms),
      issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= 0),
      activation_challenge_digest TEXT
        CHECK (
          activation_challenge_digest IS NULL
          OR (
            length(activation_challenge_digest) = 64
            AND activation_challenge_digest NOT GLOB '*[^0-9a-f]*'
          )
        ),
      activation_expires_at_ms INTEGER,
      overlap_ends_at_ms INTEGER,
      retired_at_ms INTEGER,
      revoked_at_ms INTEGER,
      CHECK (
        (activation_challenge_digest IS NULL AND activation_expires_at_ms IS NULL)
        OR (
          activation_challenge_digest IS NOT NULL
          AND activation_expires_at_ms > issued_at_ms
        )
      ),
      CHECK (status <> 'pending' OR activation_challenge_digest IS NOT NULL),
      CHECK (status <> 'overlap' OR overlap_ends_at_ms > issued_at_ms),
      CHECK (status <> 'retired' OR retired_at_ms >= issued_at_ms),
      CHECK (status <> 'revoked' OR revoked_at_ms >= issued_at_ms)
    ) STRICT`,
    `CREATE INDEX od_device_certificates_device_generation
      ON od_device_certificates (device_id, generation)`,
    `CREATE TABLE od_device_enrollment_grants (
      grant_id TEXT PRIMARY KEY
        CHECK (
          length(grant_id) = 28
          AND substr(grant_id, 1, 6) = 'grant_'
          AND substr(grant_id, 7) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
      token_digest TEXT NOT NULL UNIQUE
        CHECK (
          length(token_digest) = 64
          AND token_digest NOT GLOB '*[^0-9a-f]*'
        ),
      device_id TEXT NOT NULL
        CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id = trim(device_id)),
      allowed_bootstrap_roles_json TEXT NOT NULL
        CHECK (length(allowed_bootstrap_roles_json) BETWEEN 2 AND 8192),
      protocol_minimum INTEGER NOT NULL
        CHECK (protocol_minimum BETWEEN 1 AND 65535),
      protocol_maximum INTEGER NOT NULL
        CHECK (protocol_maximum BETWEEN protocol_minimum AND 65535),
      status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
      consumed_at_ms INTEGER,
      issued_certificate_serial TEXT
        REFERENCES od_device_certificates(serial_number)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK (
        (
          status = 'consumed'
          AND consumed_at_ms >= created_at_ms
          AND consumed_at_ms < expires_at_ms
          AND issued_certificate_serial IS NOT NULL
        )
        OR (
          status <> 'consumed'
          AND consumed_at_ms IS NULL
          AND issued_certificate_serial IS NULL
        )
      )
    ) STRICT`,
    `CREATE INDEX od_device_enrollment_grants_device
      ON od_device_enrollment_grants (device_id, created_at_ms, grant_id)`,
    `CREATE TABLE od_device_identity_audit (
      audit_id TEXT PRIMARY KEY
        CHECK (length(audit_id) BETWEEN 1 AND 200 AND audit_id = trim(audit_id)),
      event_name TEXT NOT NULL CHECK (
        event_name IN (
          'device.enrolled',
          'device.enrollment-grant-issued',
          'device.enrollment-rejected',
          'device.revoked',
          'device.rotation-confirmed',
          'device.rotation-issued'
        )
      ),
      occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
      device_id TEXT NOT NULL
        CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id = trim(device_id)),
      grant_id TEXT,
      certificate_serial TEXT,
      certificate_generation INTEGER CHECK (
        certificate_generation IS NULL OR certificate_generation > 0
      ),
      rejection_code TEXT CHECK (
        rejection_code IS NULL
        OR (
          length(rejection_code) BETWEEN 1 AND 128
          AND rejection_code = trim(rejection_code)
        )
      )
    ) STRICT`,
    `CREATE INDEX od_device_identity_audit_order
      ON od_device_identity_audit (occurred_at_ms, audit_id)`,
    `CREATE TRIGGER od_device_identity_audit_no_update
      BEFORE UPDATE ON od_device_identity_audit
      BEGIN
        SELECT RAISE(ABORT, 'device identity audit is append-only');
      END`,
    `CREATE TRIGGER od_device_identity_audit_no_delete
      BEFORE DELETE ON od_device_identity_audit
      BEGIN
        SELECT RAISE(ABORT, 'device identity audit is append-only');
      END`,
  ],
  postgres: [
    `CREATE TABLE od_device_certificate_authority (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      instance_id TEXT NOT NULL UNIQUE
        CHECK (length(instance_id) BETWEEN 1 AND 128 AND instance_id = btrim(instance_id)),
      key_id TEXT NOT NULL UNIQUE
        CHECK (length(key_id) BETWEEN 1 AND 200 AND key_id = btrim(key_id)),
      certificate_pem TEXT NOT NULL
        CHECK (
          length(certificate_pem) BETWEEN 1 AND 65536
          AND certificate_pem LIKE '-----BEGIN CERTIFICATE-----%'
          AND position('PRIVATE KEY' IN certificate_pem) = 0
        ),
      spki_sha256 TEXT NOT NULL
        CHECK (spki_sha256 ~ '^sha256:[A-Za-z0-9_-]{43}$'),
      status TEXT NOT NULL CHECK (status = 'active'),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      not_before_ms BIGINT NOT NULL CHECK (not_before_ms <= created_at_ms),
      not_after_ms BIGINT NOT NULL CHECK (not_after_ms > created_at_ms)
    )`,
    `CREATE TABLE od_device_identities (
      device_id TEXT PRIMARY KEY
        CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id = btrim(device_id)),
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      identity_generation BIGINT NOT NULL CHECK (identity_generation > 0),
      allowed_bootstrap_roles_json TEXT NOT NULL
        CHECK (length(allowed_bootstrap_roles_json) BETWEEN 2 AND 8192),
      os_family TEXT NOT NULL CHECK (os_family IN ('linux', 'macos', 'windows')),
      architecture TEXT NOT NULL
        CHECK (length(architecture) BETWEEN 1 AND 128 AND architecture = btrim(architecture)),
      hostname TEXT NOT NULL
        CHECK (length(hostname) BETWEEN 1 AND 128 AND hostname = btrim(hostname)),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      revoked_at_ms BIGINT,
      CHECK (
        (status = 'active' AND revoked_at_ms IS NULL)
        OR (status = 'revoked' AND revoked_at_ms >= created_at_ms)
      )
    )`,
    `CREATE TABLE od_device_certificates (
      serial_number TEXT PRIMARY KEY CHECK (serial_number ~ '^[0-9a-f]{32}$'),
      device_id TEXT NOT NULL
        REFERENCES od_device_identities(device_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      generation BIGINT NOT NULL CHECK (generation > 0),
      certificate_pem TEXT NOT NULL
        CHECK (
          length(certificate_pem) BETWEEN 1 AND 65536
          AND certificate_pem LIKE '-----BEGIN CERTIFICATE-----%'
          AND position('PRIVATE KEY' IN certificate_pem) = 0
        ),
      public_key_spki_sha256 TEXT NOT NULL
        CHECK (public_key_spki_sha256 ~ '^sha256:[A-Za-z0-9_-]{43}$'),
      status TEXT NOT NULL
        CHECK (status IN ('active', 'overlap', 'pending', 'retired', 'revoked')),
      not_before_ms BIGINT NOT NULL CHECK (not_before_ms <= issued_at_ms),
      not_after_ms BIGINT NOT NULL CHECK (not_after_ms > issued_at_ms),
      issued_at_ms BIGINT NOT NULL CHECK (issued_at_ms >= 0),
      activation_challenge_digest TEXT
        CHECK (
          activation_challenge_digest IS NULL
          OR activation_challenge_digest ~ '^[0-9a-f]{64}$'
        ),
      activation_expires_at_ms BIGINT,
      overlap_ends_at_ms BIGINT,
      retired_at_ms BIGINT,
      revoked_at_ms BIGINT,
      CHECK (
        (activation_challenge_digest IS NULL AND activation_expires_at_ms IS NULL)
        OR (
          activation_challenge_digest IS NOT NULL
          AND activation_expires_at_ms > issued_at_ms
        )
      ),
      CHECK (status <> 'pending' OR activation_challenge_digest IS NOT NULL),
      CHECK (status <> 'overlap' OR overlap_ends_at_ms > issued_at_ms),
      CHECK (status <> 'retired' OR retired_at_ms >= issued_at_ms),
      CHECK (status <> 'revoked' OR revoked_at_ms >= issued_at_ms)
    )`,
    `CREATE INDEX od_device_certificates_device_generation
      ON od_device_certificates (device_id, generation)`,
    `CREATE TABLE od_device_enrollment_grants (
      grant_id TEXT PRIMARY KEY CHECK (grant_id ~ '^grant_[A-Za-z0-9_-]{22}$'),
      token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
      device_id TEXT NOT NULL
        CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id = btrim(device_id)),
      allowed_bootstrap_roles_json TEXT NOT NULL
        CHECK (length(allowed_bootstrap_roles_json) BETWEEN 2 AND 8192),
      protocol_minimum BIGINT NOT NULL CHECK (protocol_minimum BETWEEN 1 AND 65535),
      protocol_maximum BIGINT NOT NULL
        CHECK (protocol_maximum BETWEEN protocol_minimum AND 65535),
      status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms),
      consumed_at_ms BIGINT,
      issued_certificate_serial TEXT
        REFERENCES od_device_certificates(serial_number)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK (
        (
          status = 'consumed'
          AND consumed_at_ms >= created_at_ms
          AND consumed_at_ms < expires_at_ms
          AND issued_certificate_serial IS NOT NULL
        )
        OR (
          status <> 'consumed'
          AND consumed_at_ms IS NULL
          AND issued_certificate_serial IS NULL
        )
      )
    )`,
    `CREATE INDEX od_device_enrollment_grants_device
      ON od_device_enrollment_grants (device_id, created_at_ms, grant_id)`,
    `CREATE TABLE od_device_identity_audit (
      audit_id TEXT PRIMARY KEY
        CHECK (length(audit_id) BETWEEN 1 AND 200 AND audit_id = btrim(audit_id)),
      event_name TEXT NOT NULL CHECK (
        event_name IN (
          'device.enrolled',
          'device.enrollment-grant-issued',
          'device.enrollment-rejected',
          'device.revoked',
          'device.rotation-confirmed',
          'device.rotation-issued'
        )
      ),
      occurred_at_ms BIGINT NOT NULL CHECK (occurred_at_ms >= 0),
      device_id TEXT NOT NULL
        CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id = btrim(device_id)),
      grant_id TEXT,
      certificate_serial TEXT,
      certificate_generation BIGINT CHECK (
        certificate_generation IS NULL OR certificate_generation > 0
      ),
      rejection_code TEXT CHECK (
        rejection_code IS NULL
        OR (
          length(rejection_code) BETWEEN 1 AND 128
          AND rejection_code = btrim(rejection_code)
        )
      )
    )`,
    `CREATE INDEX od_device_identity_audit_order
      ON od_device_identity_audit (occurred_at_ms, audit_id)`,
    `CREATE FUNCTION od_device_identity_audit_append_only()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'device identity audit is append-only';
      END;
      $$`,
    `CREATE TRIGGER od_device_identity_audit_no_mutation
      BEFORE UPDATE OR DELETE ON od_device_identity_audit
      FOR EACH ROW
      EXECUTE FUNCTION od_device_identity_audit_append_only()`,
  ],
};

const MIGRATION_0003_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0003_NAME,
      sql: MIGRATION_0003_SQL,
    }),
  )
  .digest("hex");

const MIGRATION_0004_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_discord_gateway_cursor (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      session_id TEXT NOT NULL
        CHECK (length(session_id) BETWEEN 1 AND 512 AND instr(session_id, char(0)) = 0),
      resume_gateway_url TEXT NOT NULL
        CHECK (
          length(resume_gateway_url) BETWEEN 7 AND 2048
          AND substr(resume_gateway_url, 1, 6) = 'wss://'
        ),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    ) STRICT`,
    `CREATE TABLE od_discord_inbound (
      inbound_key TEXT PRIMARY KEY
        CHECK (length(inbound_key) BETWEEN 1 AND 512 AND instr(inbound_key, char(0)) = 0),
      digest TEXT NOT NULL
        CHECK (
          length(digest) = 71
          AND substr(digest, 1, 7) = 'sha256:'
          AND substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
      acknowledged INTEGER NOT NULL CHECK (acknowledged IN (0, 1)),
      response_ref TEXT
        CHECK (
          response_ref IS NULL
          OR (
            length(response_ref) BETWEEN 25 AND 160
            AND substr(response_ref, 1, 24) = 'discord-interaction-ref:'
          )
        ),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
      CHECK (
        (acknowledged = 0 AND response_ref IS NULL)
        OR (acknowledged = 1 AND response_ref IS NOT NULL)
      )
    ) STRICT`,
    `CREATE TABLE od_discord_task_bindings (
      thread_id TEXT PRIMARY KEY CHECK (length(thread_id) BETWEEN 17 AND 20),
      guild_id TEXT NOT NULL CHECK (length(guild_id) BETWEEN 17 AND 20),
      forum_channel_id TEXT NOT NULL CHECK (length(forum_channel_id) BETWEEN 17 AND 20),
      starter_message_id TEXT NOT NULL CHECK (length(starter_message_id) BETWEEN 17 AND 20),
      task_id TEXT NOT NULL UNIQUE
        CHECK (length(task_id) BETWEEN 1 AND 512 AND instr(task_id, char(0)) = 0),
      status_panel_message_id TEXT
        CHECK (status_panel_message_id IS NULL OR length(status_panel_message_id) BETWEEN 17 AND 20),
      last_reconciled_message_id TEXT
        CHECK (
          last_reconciled_message_id IS NULL
          OR length(last_reconciled_message_id) BETWEEN 17 AND 20
        ),
      external_state TEXT NOT NULL
        CHECK (external_state IN ('available', 'deleted', 'inaccessible')),
      archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
      locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
      revision INTEGER NOT NULL CHECK (revision > 0)
    ) STRICT`,
    `CREATE INDEX od_discord_bindings_forum_thread
      ON od_discord_task_bindings (guild_id, forum_channel_id, thread_id)`,
    `CREATE TABLE od_discord_outbox (
      outbox_id TEXT PRIMARY KEY
        CHECK (length(outbox_id) BETWEEN 1 AND 512 AND instr(outbox_id, char(0)) = 0),
      action_json TEXT NOT NULL CHECK (length(action_json) BETWEEN 2 AND 1048576),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      not_before_ms INTEGER NOT NULL CHECK (not_before_ms >= 0),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      delivered INTEGER NOT NULL CHECK (delivered IN (0, 1)),
      lease_owner TEXT
        CHECK (
          lease_owner IS NULL
          OR (length(lease_owner) BETWEEN 1 AND 512 AND instr(lease_owner, char(0)) = 0)
        ),
      lease_expires_at_ms INTEGER
        CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
      last_error_code TEXT
        CHECK (
          last_error_code IS NULL
          OR (
            length(last_error_code) BETWEEN 1 AND 512
            AND instr(last_error_code, char(0)) = 0
          )
        ),
      last_transition_kind TEXT
        CHECK (last_transition_kind IS NULL OR last_transition_kind IN ('complete', 'retry')),
      last_transition_owner TEXT
        CHECK (
          last_transition_owner IS NULL
          OR (
            length(last_transition_owner) BETWEEN 1 AND 512
            AND instr(last_transition_owner, char(0)) = 0
          )
        ),
      last_transition_not_before_ms INTEGER
        CHECK (
          last_transition_not_before_ms IS NULL
          OR last_transition_not_before_ms >= 0
        ),
      last_transition_error_code TEXT
        CHECK (
          last_transition_error_code IS NULL
          OR (
            length(last_transition_error_code) BETWEEN 1 AND 512
            AND instr(last_transition_error_code, char(0)) = 0
          )
        ),
      CHECK (
        (lease_owner IS NULL AND lease_expires_at_ms IS NULL)
        OR (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
      ),
      CHECK (
        (last_transition_kind IS NULL AND last_transition_owner IS NULL)
        OR (last_transition_kind IS NOT NULL AND last_transition_owner IS NOT NULL)
      ),
      CHECK (delivered = 0 OR lease_owner IS NULL)
    ) STRICT`,
    `CREATE INDEX od_discord_outbox_ready
      ON od_discord_outbox (delivered, not_before_ms, lease_expires_at_ms, created_at_ms, outbox_id)`,
  ],
  postgres: [
    `CREATE TABLE od_discord_gateway_cursor (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
      resume_gateway_url TEXT NOT NULL
        CHECK (
          length(resume_gateway_url) BETWEEN 7 AND 2048
          AND substr(resume_gateway_url, 1, 6) = 'wss://'
        ),
      sequence BIGINT NOT NULL CHECK (sequence >= 0),
      updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= 0)
    )`,
    `CREATE TABLE od_discord_inbound (
      inbound_key TEXT PRIMARY KEY CHECK (length(inbound_key) BETWEEN 1 AND 512),
      digest TEXT NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
      acknowledged BOOLEAN NOT NULL,
      response_ref TEXT
        CHECK (
          response_ref IS NULL
          OR response_ref ~ '^discord-interaction-ref:[A-Za-z0-9_-]{1,128}$'
        ),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= created_at_ms),
      CHECK (
        (acknowledged = FALSE AND response_ref IS NULL)
        OR (acknowledged = TRUE AND response_ref IS NOT NULL)
      )
    )`,
    `CREATE TABLE od_discord_task_bindings (
      thread_id TEXT PRIMARY KEY CHECK (thread_id ~ '^[0-9]{17,20}$'),
      guild_id TEXT NOT NULL CHECK (guild_id ~ '^[0-9]{17,20}$'),
      forum_channel_id TEXT NOT NULL CHECK (forum_channel_id ~ '^[0-9]{17,20}$'),
      starter_message_id TEXT NOT NULL CHECK (starter_message_id ~ '^[0-9]{17,20}$'),
      task_id TEXT NOT NULL UNIQUE CHECK (length(task_id) BETWEEN 1 AND 512),
      status_panel_message_id TEXT
        CHECK (
          status_panel_message_id IS NULL
          OR status_panel_message_id ~ '^[0-9]{17,20}$'
        ),
      last_reconciled_message_id TEXT
        CHECK (
          last_reconciled_message_id IS NULL
          OR last_reconciled_message_id ~ '^[0-9]{17,20}$'
        ),
      external_state TEXT NOT NULL
        CHECK (external_state IN ('available', 'deleted', 'inaccessible')),
      archived BOOLEAN NOT NULL,
      locked BOOLEAN NOT NULL,
      revision BIGINT NOT NULL CHECK (revision > 0)
    )`,
    `CREATE INDEX od_discord_bindings_forum_thread
      ON od_discord_task_bindings (guild_id, forum_channel_id, thread_id)`,
    `CREATE TABLE od_discord_outbox (
      outbox_id TEXT PRIMARY KEY CHECK (length(outbox_id) BETWEEN 1 AND 512),
      action_json TEXT NOT NULL CHECK (length(action_json) BETWEEN 2 AND 1048576),
      created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
      not_before_ms BIGINT NOT NULL CHECK (not_before_ms >= 0),
      attempts BIGINT NOT NULL CHECK (attempts >= 0),
      delivered BOOLEAN NOT NULL,
      lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 512),
      lease_expires_at_ms BIGINT
        CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
      last_error_code TEXT
        CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 512),
      last_transition_kind TEXT
        CHECK (last_transition_kind IS NULL OR last_transition_kind IN ('complete', 'retry')),
      last_transition_owner TEXT
        CHECK (
          last_transition_owner IS NULL
          OR length(last_transition_owner) BETWEEN 1 AND 512
        ),
      last_transition_not_before_ms BIGINT
        CHECK (
          last_transition_not_before_ms IS NULL
          OR last_transition_not_before_ms >= 0
        ),
      last_transition_error_code TEXT
        CHECK (
          last_transition_error_code IS NULL
          OR length(last_transition_error_code) BETWEEN 1 AND 512
        ),
      CHECK (
        (lease_owner IS NULL AND lease_expires_at_ms IS NULL)
        OR (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
      ),
      CHECK (
        (last_transition_kind IS NULL AND last_transition_owner IS NULL)
        OR (last_transition_kind IS NOT NULL AND last_transition_owner IS NOT NULL)
      ),
      CHECK (delivered = FALSE OR lease_owner IS NULL)
    )`,
    `CREATE INDEX od_discord_outbox_ready
      ON od_discord_outbox (delivered, not_before_ms, lease_expires_at_ms, created_at_ms, outbox_id)`,
  ],
};

const MIGRATION_0004_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0004_NAME,
      sql: MIGRATION_0004_SQL,
    }),
  )
  .digest("hex");

const MIGRATION_0005_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_device_channel_state (
      device_id TEXT PRIMARY KEY
        CHECK (
          length(device_id) BETWEEN 1 AND 128
          AND device_id NOT GLOB '*[^A-Za-z0-9._-]*'
          AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
        ),
      certificate_generation INTEGER NOT NULL CHECK (certificate_generation > 0),
      last_worker_sequence INTEGER NOT NULL CHECK (last_worker_sequence >= 0),
      acknowledged_main_sequence INTEGER NOT NULL CHECK (acknowledged_main_sequence >= 0),
      next_main_sequence INTEGER NOT NULL CHECK (next_main_sequence > 0),
      CHECK (acknowledged_main_sequence < next_main_sequence)
    ) STRICT`,
    `CREATE TABLE od_device_channel_inbox (
      device_id TEXT NOT NULL
        REFERENCES od_device_channel_state(device_id) ON DELETE RESTRICT,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      message_id TEXT NOT NULL
        CHECK (length(message_id) BETWEEN 1 AND 256 AND instr(message_id, char(0)) = 0),
      idempotency_key TEXT NOT NULL
        CHECK (
          length(idempotency_key) BETWEEN 1 AND 256
          AND instr(idempotency_key, char(0)) = 0
        ),
      fingerprint TEXT NOT NULL
        CHECK (
          length(fingerprint) = 64
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
      frame_json TEXT NOT NULL
        CHECK (length(frame_json) BETWEEN 2 AND 1048576),
      PRIMARY KEY (device_id, sequence),
      UNIQUE (device_id, message_id),
      UNIQUE (device_id, idempotency_key)
    ) STRICT`,
    `CREATE TABLE od_device_channel_outbox (
      device_id TEXT NOT NULL
        REFERENCES od_device_channel_state(device_id) ON DELETE RESTRICT,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      message_id TEXT NOT NULL
        CHECK (length(message_id) BETWEEN 1 AND 256 AND instr(message_id, char(0)) = 0),
      idempotency_key TEXT NOT NULL
        CHECK (
          length(idempotency_key) BETWEEN 1 AND 256
          AND instr(idempotency_key, char(0)) = 0
        ),
      frame_json TEXT NOT NULL
        CHECK (length(frame_json) BETWEEN 2 AND 1048576),
      PRIMARY KEY (device_id, sequence),
      UNIQUE (device_id, message_id),
      UNIQUE (device_id, idempotency_key)
    ) STRICT`,
  ],
  postgres: [
    `CREATE TABLE od_device_channel_state (
      device_id TEXT PRIMARY KEY
        CHECK (device_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
      certificate_generation BIGINT NOT NULL CHECK (certificate_generation > 0),
      last_worker_sequence BIGINT NOT NULL CHECK (last_worker_sequence >= 0),
      acknowledged_main_sequence BIGINT NOT NULL CHECK (acknowledged_main_sequence >= 0),
      next_main_sequence BIGINT NOT NULL CHECK (next_main_sequence > 0),
      CHECK (acknowledged_main_sequence < next_main_sequence)
    )`,
    `CREATE TABLE od_device_channel_inbox (
      device_id TEXT NOT NULL
        REFERENCES od_device_channel_state(device_id) ON DELETE RESTRICT,
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
      fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
      frame_json TEXT NOT NULL CHECK (length(frame_json) BETWEEN 2 AND 1048576),
      PRIMARY KEY (device_id, sequence),
      UNIQUE (device_id, message_id),
      UNIQUE (device_id, idempotency_key)
    )`,
    `CREATE TABLE od_device_channel_outbox (
      device_id TEXT NOT NULL
        REFERENCES od_device_channel_state(device_id) ON DELETE RESTRICT,
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
      frame_json TEXT NOT NULL CHECK (length(frame_json) BETWEEN 2 AND 1048576),
      PRIMARY KEY (device_id, sequence),
      UNIQUE (device_id, message_id),
      UNIQUE (device_id, idempotency_key)
    )`,
  ],
};

const MIGRATION_0005_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0005_NAME,
      sql: MIGRATION_0005_SQL,
    }),
  )
  .digest("hex");

const MIGRATION_0006_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_device_channel_inbound_effect (
      device_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'handled')),
      claim_id TEXT,
      PRIMARY KEY (device_id, sequence),
      FOREIGN KEY (device_id, sequence)
        REFERENCES od_device_channel_inbox(device_id, sequence) ON DELETE RESTRICT,
      CHECK (
        (status = 'processing' AND claim_id IS NOT NULL)
        OR (status <> 'processing' AND claim_id IS NULL)
      )
    ) STRICT`,
    `INSERT INTO od_device_channel_inbound_effect (device_id, sequence, status, claim_id)
      SELECT device_id, sequence, 'handled', NULL
      FROM od_device_channel_inbox`,
  ],
  postgres: [
    `CREATE TABLE od_device_channel_inbound_effect (
      device_id TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'handled')),
      claim_id TEXT,
      PRIMARY KEY (device_id, sequence),
      FOREIGN KEY (device_id, sequence)
        REFERENCES od_device_channel_inbox(device_id, sequence) ON DELETE RESTRICT,
      CHECK (
        (status = 'processing' AND claim_id IS NOT NULL)
        OR (status <> 'processing' AND claim_id IS NULL)
      )
    )`,
    `INSERT INTO od_device_channel_inbound_effect (device_id, sequence, status, claim_id)
      SELECT device_id, sequence, 'handled', NULL
      FROM od_device_channel_inbox`,
  ],
};

const MIGRATION_0006_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0006_NAME,
      sql: MIGRATION_0006_SQL,
    }),
  )
  .digest("hex");

const EMPTY_CONFIGURATION_STATE_JSON =
  '{"audits":[],"changeSets":[],"entries":[],"proposals":[],"revision":0,"schemaVersion":1,"toolReceipts":[]}';
const EMPTY_CONFIGURATION_STATE_SHA256 = createHash("sha256")
  .update(EMPTY_CONFIGURATION_STATE_JSON, "utf8")
  .digest("hex");

const MIGRATION_0007_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_configuration_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 16777216),
      state_sha256 TEXT NOT NULL
        CHECK (
          length(state_sha256) = 64
          AND state_sha256 NOT GLOB '*[^0-9a-f]*'
        )
    ) STRICT`,
    `INSERT INTO od_configuration_state (
      singleton_id, schema_version, revision, state_json, state_sha256
    ) VALUES (
      1, 1, 0, '${EMPTY_CONFIGURATION_STATE_JSON}', '${EMPTY_CONFIGURATION_STATE_SHA256}'
    )`,
  ],
  postgres: [
    `CREATE TABLE od_configuration_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision BIGINT NOT NULL CHECK (revision >= 0),
      state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 16777216),
      state_sha256 TEXT NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$')
    )`,
    `INSERT INTO od_configuration_state (
      singleton_id, schema_version, revision, state_json, state_sha256
    ) VALUES (
      1, 1, 0, '${EMPTY_CONFIGURATION_STATE_JSON}', '${EMPTY_CONFIGURATION_STATE_SHA256}'
    )`,
  ],
};

const MIGRATION_0007_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0007_NAME,
      sql: MIGRATION_0007_SQL,
    }),
  )
  .digest("hex");

const EMPTY_APPROVAL_STATE_JSON =
  '{"audits":[],"decisionReceipts":[],"requestReceipts":[],"requests":[],"revision":0,"schemaVersion":1}';
const EMPTY_APPROVAL_STATE_SHA256 = createHash("sha256")
  .update(EMPTY_APPROVAL_STATE_JSON, "utf8")
  .digest("hex");

const MIGRATION_0008_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_approval_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 16777216),
      state_sha256 TEXT NOT NULL
        CHECK (
          length(state_sha256) = 64
          AND state_sha256 NOT GLOB '*[^0-9a-f]*'
        )
    ) STRICT`,
    `INSERT INTO od_approval_state (
      singleton_id, schema_version, revision, state_json, state_sha256
    ) VALUES (
      1, 1, 0, '${EMPTY_APPROVAL_STATE_JSON}', '${EMPTY_APPROVAL_STATE_SHA256}'
    )`,
  ],
  postgres: [
    `CREATE TABLE od_approval_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision BIGINT NOT NULL CHECK (revision >= 0),
      state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 16777216),
      state_sha256 TEXT NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$')
    )`,
    `INSERT INTO od_approval_state (
      singleton_id, schema_version, revision, state_json, state_sha256
    ) VALUES (
      1, 1, 0, '${EMPTY_APPROVAL_STATE_JSON}', '${EMPTY_APPROVAL_STATE_SHA256}'
    )`,
  ],
};

const MIGRATION_0008_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0008_NAME,
      sql: MIGRATION_0008_SQL,
    }),
  )
  .digest("hex");

const MIGRATION_0009_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_action_authorizations (
      authorization_request_id TEXT PRIMARY KEY
        CHECK (
          length(trim(authorization_request_id)) > 0
          AND length(authorization_request_id) <= 512
        ),
      request_digest TEXT NOT NULL
        CHECK (
          length(request_digest) = 64
          AND request_digest NOT GLOB '*[^0-9a-f]*'
        ),
      authorization_id TEXT NOT NULL UNIQUE
        CHECK (
          length(authorization_id) = 78
          AND substr(authorization_id, 1, 14) = 'authorization:'
          AND substr(authorization_id, 15) NOT GLOB '*[^0-9a-f]*'
        ),
      policy_fingerprint TEXT NOT NULL
        CHECK (
          length(policy_fingerprint) = 71
          AND substr(policy_fingerprint, 1, 7) = 'sha256:'
          AND substr(policy_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
        ),
      state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 524288),
      state_sha256 TEXT NOT NULL
        CHECK (
          length(state_sha256) = 64
          AND state_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    ) STRICT`,
    `CREATE INDEX od_action_authorizations_updated
      ON od_action_authorizations (updated_at_ms, authorization_request_id)`,
  ],
  postgres: [
    `CREATE TABLE od_action_authorizations (
      authorization_request_id TEXT PRIMARY KEY
        CHECK (
          length(btrim(authorization_request_id)) > 0
          AND length(authorization_request_id) <= 512
        ),
      request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
      authorization_id TEXT NOT NULL UNIQUE
        CHECK (authorization_id ~ '^authorization:[0-9a-f]{64}$'),
      policy_fingerprint TEXT NOT NULL
        CHECK (policy_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
      state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 524288),
      state_sha256 TEXT NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
      updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= 0)
    )`,
    `CREATE INDEX od_action_authorizations_updated
      ON od_action_authorizations (updated_at_ms, authorization_request_id)`,
  ],
};

const MIGRATION_0009_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0009_NAME,
      sql: MIGRATION_0009_SQL,
    }),
  )
  .digest("hex");

const MIGRATION_0010_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_artifact_index_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      state_json TEXT NOT NULL CHECK (length(state_json) >= 2),
      state_sha256 TEXT NOT NULL
        CHECK (
          length(state_sha256) = 64
          AND state_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ) STRICT`,
    `INSERT INTO od_artifact_index_state (
      singleton_id,
      schema_version,
      generation,
      state_json,
      state_sha256
    ) VALUES (
      1,
      1,
      0,
      '{"schemaVersion":1,"generation":0,"artifacts":{},"signedTokens":{},"auditEvents":[],"nextAuditSequence":1}',
      '3bc8c38ec389ae238588408df30beb9450feac6d28bc795630b5d03e1b9f0ffc'
    )`,
  ],
  postgres: [
    `CREATE TABLE od_artifact_index_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      generation BIGINT NOT NULL CHECK (generation >= 0),
      state_json TEXT NOT NULL CHECK (length(state_json) >= 2),
      state_sha256 TEXT NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$')
    )`,
    `INSERT INTO od_artifact_index_state (
      singleton_id,
      schema_version,
      generation,
      state_json,
      state_sha256
    ) VALUES (
      1,
      1,
      0,
      '{"schemaVersion":1,"generation":0,"artifacts":{},"signedTokens":{},"auditEvents":[],"nextAuditSequence":1}',
      '3bc8c38ec389ae238588408df30beb9450feac6d28bc795630b5d03e1b9f0ffc'
    )`,
  ],
};

const MIGRATION_0010_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0010_NAME,
      sql: MIGRATION_0010_SQL,
    }),
  )
  .digest("hex");

const MIGRATION_0011_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `CREATE TABLE od_device_observation_events (
      device_id TEXT NOT NULL CHECK (length(trim(device_id)) BETWEEN 1 AND 128),
      observation_sequence INTEGER NOT NULL CHECK (observation_sequence > 0),
      observed_at_ms INTEGER NOT NULL
        CHECK (observed_at_ms BETWEEN 0 AND 8640000000000000),
      accepted_at_ms INTEGER NOT NULL
        CHECK (accepted_at_ms BETWEEN 0 AND 8640000000000000),
      payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 1048576),
      payload_sha256 TEXT NOT NULL
        CHECK (
          length(payload_sha256) = 64
          AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      PRIMARY KEY (device_id, observation_sequence),
      UNIQUE (device_id, observed_at_ms)
    ) STRICT`,
    `CREATE TABLE od_device_observation_latest (
      device_id TEXT PRIMARY KEY CHECK (length(trim(device_id)) BETWEEN 1 AND 128),
      observation_sequence INTEGER NOT NULL CHECK (observation_sequence > 0),
      FOREIGN KEY (device_id, observation_sequence)
        REFERENCES od_device_observation_events (device_id, observation_sequence)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TRIGGER od_device_observation_events_no_update
      BEFORE UPDATE ON od_device_observation_events
      BEGIN
        SELECT RAISE(ABORT, 'Device observation events are append-only');
      END`,
    `CREATE TRIGGER od_device_observation_events_no_delete
      BEFORE DELETE ON od_device_observation_events
      BEGIN
        SELECT RAISE(ABORT, 'Device observation events are append-only');
      END`,
  ],
  postgres: [
    `CREATE TABLE od_device_observation_events (
      device_id TEXT NOT NULL CHECK (length(trim(device_id)) BETWEEN 1 AND 128),
      observation_sequence BIGINT NOT NULL CHECK (observation_sequence > 0),
      observed_at_ms BIGINT NOT NULL
        CHECK (observed_at_ms BETWEEN 0 AND 8640000000000000),
      accepted_at_ms BIGINT NOT NULL
        CHECK (accepted_at_ms BETWEEN 0 AND 8640000000000000),
      payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 1048576),
      payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      PRIMARY KEY (device_id, observation_sequence),
      UNIQUE (device_id, observed_at_ms)
    )`,
    `CREATE TABLE od_device_observation_latest (
      device_id TEXT PRIMARY KEY CHECK (length(trim(device_id)) BETWEEN 1 AND 128),
      observation_sequence BIGINT NOT NULL CHECK (observation_sequence > 0),
      FOREIGN KEY (device_id, observation_sequence)
        REFERENCES od_device_observation_events (device_id, observation_sequence)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    )`,
    `CREATE FUNCTION od_reject_device_observation_event_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Device observation events are append-only';
      END;
      $$`,
    `CREATE TRIGGER od_device_observation_events_no_update
      BEFORE UPDATE ON od_device_observation_events
      FOR EACH ROW EXECUTE FUNCTION od_reject_device_observation_event_mutation()`,
    `CREATE TRIGGER od_device_observation_events_no_delete
      BEFORE DELETE ON od_device_observation_events
      FOR EACH ROW EXECUTE FUNCTION od_reject_device_observation_event_mutation()`,
  ],
};

const MIGRATION_0011_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0011_NAME,
      sql: MIGRATION_0011_SQL,
    }),
  )
  .digest("hex");

const MIGRATION_0012_SQL: Readonly<Record<SqlBackend, readonly string[]>> = {
  sqlite: [
    `DROP TRIGGER od_owner_auth_audit_no_update`,
    `DROP TRIGGER od_owner_auth_audit_no_delete`,
    `DROP INDEX od_owner_auth_audit_order`,
    `ALTER TABLE od_owner_auth_audit
      RENAME TO od_owner_auth_audit_0012_previous`,
    `CREATE TABLE od_owner_auth_audit (
      audit_id TEXT PRIMARY KEY
        CHECK (length(trim(audit_id)) > 0 AND length(audit_id) <= 200),
      event_name TEXT NOT NULL CHECK (
        event_name IN (
          'owner.auth.claim-issued',
          'owner.auth.claim-replaced',
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
    `INSERT INTO od_owner_auth_audit (
      audit_id,
      event_name,
      occurred_at_ms,
      owner_id,
      session_id,
      target_session_id
    )
    SELECT
      audit_id,
      event_name,
      occurred_at_ms,
      owner_id,
      session_id,
      target_session_id
    FROM od_owner_auth_audit_0012_previous`,
    `DROP TABLE od_owner_auth_audit_0012_previous`,
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
    `ALTER TABLE od_owner_auth_audit
      DROP CONSTRAINT od_owner_auth_audit_event_name_check`,
    `ALTER TABLE od_owner_auth_audit
      ADD CONSTRAINT od_owner_auth_audit_event_name_check CHECK (
        event_name IN (
          'owner.auth.claim-issued',
          'owner.auth.claim-replaced',
          'owner.auth.claimed',
          'owner.auth.login-succeeded',
          'owner.auth.reauthenticated',
          'owner.auth.recovery-begun',
          'owner.auth.recovered',
          'owner.auth.session-revoked',
          'owner.auth.session-logged-out'
        )
      )`,
  ],
};

const MIGRATION_0012_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      name: MIGRATION_0012_NAME,
      sql: MIGRATION_0012_SQL,
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
  Object.freeze({
    name: MIGRATION_0003_NAME,
    checksum: MIGRATION_0003_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0004_NAME,
    checksum: MIGRATION_0004_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0005_NAME,
    checksum: MIGRATION_0005_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0006_NAME,
    checksum: MIGRATION_0006_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0007_NAME,
    checksum: MIGRATION_0007_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0008_NAME,
    checksum: MIGRATION_0008_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0009_NAME,
    checksum: MIGRATION_0009_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0010_NAME,
    checksum: MIGRATION_0010_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0011_NAME,
    checksum: MIGRATION_0011_CHECKSUM,
  }),
  Object.freeze({
    name: MIGRATION_0012_NAME,
    checksum: MIGRATION_0012_CHECKSUM,
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
      [MIGRATION_0003_NAME]: createMigration0003(backend),
      [MIGRATION_0004_NAME]: createMigration0004(backend),
      [MIGRATION_0005_NAME]: createMigration0005(backend),
      [MIGRATION_0006_NAME]: createMigration0006(backend),
      [MIGRATION_0007_NAME]: createMigration0007(backend),
      [MIGRATION_0008_NAME]: createMigration0008(backend),
      [MIGRATION_0009_NAME]: createMigration0009(backend),
      [MIGRATION_0010_NAME]: createMigration0010(backend),
      [MIGRATION_0011_NAME]: createMigration0011(backend),
      [MIGRATION_0012_NAME]: createMigration0012(backend),
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

function createMigration0003(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0003_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0003_CHECKSUM,
          migration_name: MIGRATION_0003_NAME,
        })
        .execute();
    },
  };
}

function createMigration0004(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0004_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0004_CHECKSUM,
          migration_name: MIGRATION_0004_NAME,
        })
        .execute();
    },
  };
}

function createMigration0005(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0005_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0005_CHECKSUM,
          migration_name: MIGRATION_0005_NAME,
        })
        .execute();
    },
  };
}

function createMigration0006(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0006_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0006_CHECKSUM,
          migration_name: MIGRATION_0006_NAME,
        })
        .execute();
    },
  };
}

function createMigration0007(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0007_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0007_CHECKSUM,
          migration_name: MIGRATION_0007_NAME,
        })
        .execute();
    },
  };
}

function createMigration0008(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0008_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0008_CHECKSUM,
          migration_name: MIGRATION_0008_NAME,
        })
        .execute();
    },
  };
}

function createMigration0009(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0009_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0009_CHECKSUM,
          migration_name: MIGRATION_0009_NAME,
        })
        .execute();
    },
  };
}

function createMigration0010(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0010_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0010_CHECKSUM,
          migration_name: MIGRATION_0010_NAME,
        })
        .execute();
    },
  };
}

function createMigration0011(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0011_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0011_CHECKSUM,
          migration_name: MIGRATION_0011_NAME,
        })
        .execute();
    },
  };
}

function createMigration0012(backend: SqlBackend): Migration {
  return {
    up: async (database) => {
      for (const statement of MIGRATION_0012_SQL[backend]) {
        await sql.raw(statement).execute(database);
      }
      await database
        .insertInto("od_migration_manifest")
        .values({
          checksum_sha256: MIGRATION_0012_CHECKSUM,
          migration_name: MIGRATION_0012_NAME,
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
