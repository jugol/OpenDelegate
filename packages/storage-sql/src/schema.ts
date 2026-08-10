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

export interface ConfigurationStateTable {
  readonly singleton_id: number;
  readonly schema_version: number;
  readonly revision: SqlInteger;
  readonly state_json: string;
  readonly state_sha256: string;
}

export interface ApprovalStateTable {
  readonly singleton_id: number;
  readonly schema_version: number;
  readonly revision: SqlInteger;
  readonly state_json: string;
  readonly state_sha256: string;
}

export interface ActionAuthorizationTable {
  readonly authorization_request_id: string;
  readonly request_digest: string;
  readonly authorization_id: string;
  readonly policy_fingerprint: string;
  readonly state_json: string;
  readonly state_sha256: string;
  readonly updated_at_ms: SqlInteger;
}

export interface ArtifactIndexStateTable {
  readonly singleton_id: number;
  readonly schema_version: number;
  readonly generation: SqlInteger;
  readonly state_json: string;
  readonly state_sha256: string;
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

export interface DeviceCertificateAuthorityTable {
  readonly singleton_id: number;
  readonly instance_id: string;
  readonly key_id: string;
  readonly certificate_pem: string;
  readonly spki_sha256: string;
  readonly status: string;
  readonly created_at_ms: SqlInteger;
  readonly not_before_ms: SqlInteger;
  readonly not_after_ms: SqlInteger;
}

export interface DeviceIdentitiesTable {
  readonly device_id: string;
  readonly status: string;
  readonly identity_generation: SqlInteger;
  readonly allowed_bootstrap_roles_json: string;
  readonly os_family: string;
  readonly architecture: string;
  readonly hostname: string;
  readonly created_at_ms: SqlInteger;
  readonly revoked_at_ms: SqlInteger | null;
}

export interface DeviceCertificatesTable {
  readonly serial_number: string;
  readonly device_id: string;
  readonly generation: SqlInteger;
  readonly certificate_pem: string;
  readonly public_key_spki_sha256: string;
  readonly status: string;
  readonly not_before_ms: SqlInteger;
  readonly not_after_ms: SqlInteger;
  readonly issued_at_ms: SqlInteger;
  readonly activation_challenge_digest: string | null;
  readonly activation_expires_at_ms: SqlInteger | null;
  readonly overlap_ends_at_ms: SqlInteger | null;
  readonly retired_at_ms: SqlInteger | null;
  readonly revoked_at_ms: SqlInteger | null;
}

export interface DeviceEnrollmentGrantsTable {
  readonly grant_id: string;
  readonly token_digest: string;
  readonly device_id: string;
  readonly intent: string;
  readonly allowed_bootstrap_roles_json: string;
  readonly protocol_minimum: SqlInteger;
  readonly protocol_maximum: SqlInteger;
  readonly status: string;
  readonly created_at_ms: SqlInteger;
  readonly expires_at_ms: SqlInteger;
  readonly consumed_at_ms: SqlInteger | null;
  readonly issued_certificate_serial: string | null;
}

export interface DeviceIdentityAuditTable {
  readonly audit_id: string;
  readonly event_name: string;
  readonly occurred_at_ms: SqlInteger;
  readonly device_id: string;
  readonly grant_id: string | null;
  readonly certificate_serial: string | null;
  readonly certificate_generation: SqlInteger | null;
  readonly rejection_code: string | null;
}

export interface DiscordGatewayCursorTable {
  readonly singleton_id: number;
  readonly session_id: string;
  readonly resume_gateway_url: string;
  readonly sequence: SqlInteger;
  readonly updated_at_ms: SqlInteger;
}

export interface DiscordInboundTable {
  readonly inbound_key: string;
  readonly digest: string;
  readonly state: string;
  readonly acknowledged: boolean | number;
  readonly response_ref: string | null;
  readonly created_at_ms: SqlInteger;
  readonly updated_at_ms: SqlInteger;
}

export interface DiscordTaskBindingsTable {
  readonly thread_id: string;
  readonly guild_id: string;
  readonly forum_channel_id: string;
  readonly starter_message_id: string;
  readonly task_id: string;
  readonly status_panel_message_id: string | null;
  readonly activity_surface_json: string | null;
  readonly failure_surface_json: string | null;
  readonly owner_prompt_surface_json: string | null;
  readonly last_reconciled_message_id: string | null;
  readonly external_state: string;
  readonly archived: boolean | number;
  readonly locked: boolean | number;
  readonly revision: SqlInteger;
}

export interface DiscordOutboxTable {
  readonly outbox_id: string;
  readonly action_json: string;
  readonly created_at_ms: SqlInteger;
  readonly not_before_ms: SqlInteger;
  readonly attempts: SqlInteger;
  readonly delivered: boolean | number;
  readonly lease_owner: string | null;
  readonly lease_expires_at_ms: SqlInteger | null;
  readonly last_error_code: string | null;
  readonly last_transition_kind: string | null;
  readonly last_transition_owner: string | null;
  readonly last_transition_not_before_ms: SqlInteger | null;
  readonly last_transition_error_code: string | null;
}

export interface DeviceChannelStateTable {
  readonly device_id: string;
  readonly certificate_generation: SqlInteger;
  readonly last_worker_sequence: SqlInteger;
  readonly acknowledged_main_sequence: SqlInteger;
  readonly next_main_sequence: SqlInteger;
}

export interface DeviceChannelInboxTable {
  readonly device_id: string;
  readonly sequence: SqlInteger;
  readonly message_id: string;
  readonly idempotency_key: string;
  readonly fingerprint: string;
  readonly frame_json: string;
}

export interface DeviceChannelInboundEffectTable {
  readonly device_id: string;
  readonly sequence: SqlInteger;
  readonly status: string;
  readonly claim_id: string | null;
}

export interface DeviceChannelOutboxTable {
  readonly device_id: string;
  readonly sequence: SqlInteger;
  readonly message_id: string;
  readonly idempotency_key: string;
  readonly frame_json: string;
}

export interface DeviceObservationEventTable {
  readonly device_id: string;
  readonly observation_sequence: SqlInteger;
  readonly observed_at_ms: SqlInteger;
  readonly accepted_at_ms: SqlInteger;
  readonly payload_json: string;
  readonly payload_sha256: string;
}

export interface DeviceObservationLatestTable {
  readonly device_id: string;
  readonly observation_sequence: SqlInteger;
}

export interface KyselyMigrationTable {
  readonly name: string;
  readonly timestamp: string;
}

export interface SqlStorageSchema {
  readonly od_action_authorizations: ActionAuthorizationTable;
  readonly od_approval_state: ApprovalStateTable;
  readonly od_artifact_index_state: ArtifactIndexStateTable;
  readonly od_configuration_state: ConfigurationStateTable;
  readonly od_device_certificate_authority: DeviceCertificateAuthorityTable;
  readonly od_device_certificates: DeviceCertificatesTable;
  readonly od_device_channel_inbox: DeviceChannelInboxTable;
  readonly od_device_channel_inbound_effect: DeviceChannelInboundEffectTable;
  readonly od_device_channel_outbox: DeviceChannelOutboxTable;
  readonly od_device_channel_state: DeviceChannelStateTable;
  readonly od_device_observation_events: DeviceObservationEventTable;
  readonly od_device_observation_latest: DeviceObservationLatestTable;
  readonly od_device_enrollment_grants: DeviceEnrollmentGrantsTable;
  readonly od_device_identities: DeviceIdentitiesTable;
  readonly od_device_identity_audit: DeviceIdentityAuditTable;
  readonly od_discord_gateway_cursor: DiscordGatewayCursorTable;
  readonly od_discord_inbound: DiscordInboundTable;
  readonly od_discord_outbox: DiscordOutboxTable;
  readonly od_discord_task_bindings: DiscordTaskBindingsTable;
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
