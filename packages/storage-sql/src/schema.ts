import type { ColumnType } from "kysely";

type SqlInteger = ColumnType<number | string | bigint, number, number>;

export interface EventStreamsTable {
  readonly stream_id: string;
  readonly version: SqlInteger;
}

export interface EventsTable {
  readonly event_id: string;
  readonly stream_id: string;
  readonly stream_version: SqlInteger;
  readonly global_position: SqlInteger;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly payload_json: string;
}

export interface MigrationManifestTable {
  readonly migration_name: string;
  readonly checksum_sha256: string;
}

export interface WriteGateTable {
  readonly singleton_id: number;
  readonly revision: SqlInteger;
  readonly next_global_position: SqlInteger;
}

export interface OwnerClaimTable {
  readonly singleton_id: number;
  readonly bearer_digest: string;
  readonly created_at_ms: SqlInteger;
  readonly expires_at_ms: SqlInteger;
}

export interface OwnerCredentialTable {
  readonly singleton_id: number;
  readonly owner_id: string;
  readonly password_phc: string;
  readonly credential_version: SqlInteger;
  readonly created_at_ms: SqlInteger;
  readonly updated_at_ms: SqlInteger;
}

export interface OwnerRecoveryCredentialsTable {
  readonly recovery_id: string;
  readonly bearer_digest: string;
  readonly owner_id: string;
  readonly credential_version: SqlInteger;
  readonly created_at_ms: SqlInteger;
  readonly consumed_at_ms: SqlInteger | null;
}

export interface OwnerRecoveryStatesTable {
  readonly state_id: string;
  readonly bearer_digest: string;
  readonly owner_id: string;
  readonly credential_version: SqlInteger;
  readonly created_at_ms: SqlInteger;
  readonly expires_at_ms: SqlInteger;
  readonly consumed_at_ms: SqlInteger | null;
}

export interface OwnerSessionsTable {
  readonly session_id: string;
  readonly bearer_digest: string;
  readonly owner_id: string;
  readonly credential_version: SqlInteger;
  readonly created_at_ms: SqlInteger;
  readonly authenticated_at_ms: SqlInteger;
  readonly last_used_at_ms: SqlInteger;
  readonly idle_expires_at_ms: SqlInteger;
  readonly absolute_expires_at_ms: SqlInteger;
  readonly revoked_at_ms: SqlInteger | null;
}

export interface OwnerLoginAttemptsTable {
  readonly limiter_key: string;
  readonly attempt_sequence: SqlInteger;
  readonly attempted_at_ms: SqlInteger;
}

export interface OwnerAuthAuditTable {
  readonly audit_id: string;
  readonly event_name: string;
  readonly occurred_at_ms: SqlInteger;
  readonly owner_id: string | null;
  readonly session_id: string | null;
  readonly target_session_id: string | null;
}

export interface KyselyMigrationTable {
  readonly name: string;
  readonly timestamp: string;
}

export interface SqlStorageSchema {
  readonly od_event_streams: EventStreamsTable;
  readonly od_events: EventsTable;
  readonly od_migration_manifest: MigrationManifestTable;
  readonly od_owner_auth_audit: OwnerAuthAuditTable;
  readonly od_owner_claim: OwnerClaimTable;
  readonly od_owner_credential: OwnerCredentialTable;
  readonly od_owner_login_attempts: OwnerLoginAttemptsTable;
  readonly od_owner_recovery_credentials: OwnerRecoveryCredentialsTable;
  readonly od_owner_recovery_states: OwnerRecoveryStatesTable;
  readonly od_owner_sessions: OwnerSessionsTable;
  readonly od_write_gate: WriteGateTable;
  readonly od_kysely_migration: KyselyMigrationTable;
}

export type SqlBackend = "postgres" | "sqlite";
