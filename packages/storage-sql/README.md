# SQL storage

`@opendelegate/storage-sql` is the Main-only SQLite and PostgreSQL implementation
for OpenDelegate's durable repositories. It currently provides the event store,
owner authentication repository, Device identity repository, Device channel
repository, Discord state repository, Configuration repository, and Approval
repository, plus the Worker action-authorization ledger, over one ordered migration
manifest.

## Owner authentication repository

`SqlOwnerAuthRepository` stores owner credentials, one-time recovery state,
hash-only browser sessions, login throttles, and append-only authentication audit.
Migration `0012_owner_claim_replacement_audit` expands the audit constraint on both
SQLite and PostgreSQL so an exclusively owned local bootstrap process can record
replacement of an unreachable pre-owner claim after a crash. The migration
preserves existing audit rows and their append-only enforcement; it does not add a
remote claim path or any raw token column.

## Device observation repository

`SqlDeviceObservationRepository` stores only authenticated, schema-validated
Worker heartbeats in the selected Main database. Migration
`0011_device_observations` creates an append-only observation event journal and a
materialized latest-observation pointer for each Device. Equal-time exact replay is
idempotent, equal-time changed content fails closed, and an older observation cannot
replace the latest snapshot.

The payload contract is bounded to scheduling-safe heartbeat data. Hardware evidence
contains descriptive CPU, memory, and GPU fields with source, observation time, and
verification state; local paths, serial numbers, raw probe output, Knowledge, and
Secret values have no schema fields. Main uses the durable snapshot for historical
Facts after restart while treating the Device as live only after a heartbeat has
arrived in the current process.

## Artifact index repository

`SqlArtifactIndexRepository` implements the Artifact Store's monotonic
compare-and-set index in the selected Main database. Migration
`0010_artifact_index_state` stores the complete SHA-256-protected metadata,
signed-link, and Artifact audit snapshot. The generation column must agree with the
embedded generation, stale writers cannot replace a newer snapshot, and migration
`0010` seeds the one valid generation-zero record. A missing or corrupt singleton
blocks startup rather than silently resetting Artifact history.

Artifact bytes are intentionally absent from the SQL schema and remain in Main's
configured content-addressed Artifact Store. Production composition injects this
repository into `LocalArtifactStore`; the local `index.json` path is a standalone
compatibility fallback, not a PostgreSQL-mode metadata store.

## Worker action-authorization repository

`SqlActionAuthorizationRepository` stores exact Worker action requests and their
authorization, revocation, approval-execution, and once-consumption state in the
selected Main database. Migration `0009_action_authorizations` uses the same
portable write gate as every other correctness-sensitive repository. Its
`transact` callback reads and conditionally replaces one authorization under a
single SQLite write transaction or PostgreSQL serializable transaction, so two
connections cannot both consume one permit.

Every record binds the authorization request ID, request digest, authorization ID,
Policy fingerprint, bounded canonical state, checksum, and update time. Integrity
or column/state disagreement fails closed. Main owns the repository lifecycle;
normal startup never falls back to a private SQLite file when PostgreSQL was
selected.

## Approval repository

`SqlApprovalRepository` persists exact normalized action fingerprints, bounded
owner-facing evidence, expirations, owner decisions, scoped grants, once-grant
consumption, execution outcomes, idempotency receipts, and audit history. Migration
`0008_approval_state` seeds one canonical, SHA-256-verified snapshot under the shared
write gate. Its strict decoder rejects unknown fields, impossible request/decision/
execution combinations, mismatched grants, invalid receipt links, inconsistent
audit transitions, Secret-shaped values, and checksum or revision disagreement.

The owner decision and once-grant consumption commit atomically before the
executable boundary is called. A restart therefore replays only the same stable
execution operation, and an expired or consumed grant cannot be reconstructed from
an Admin preview.

## Configuration repository

`SqlConfigurationRepository` persists the complete typed Configuration state,
including effective-value entries, proposals, change sets, audit records, and
idempotent Agent tool receipts. Migration `0007_configuration_state` stores one
canonical, SHA-256-verified snapshot under the shared write gate. Configuration
revision, snapshot schema, reference integrity, identifier uniqueness, and receipt
commit links are checked at startup. A corrupt or non-canonical snapshot blocks
normal startup; the migration seeds the singleton, so a missing row is corruption
rather than an implicit reset.

The repository implements the same synchronous transaction callback contract as
`@opendelegate/configuration`: a mutation and its receipt are serialized together or
both roll back. Independent SQLite and PostgreSQL connections therefore replay one
receipt for an exact operation ID instead of applying a second mutation.

## Device channel repository

`SqlDeviceChannelRepository` gives the Main channel equivalent SQLite and
PostgreSQL sequence, inbox, outbox, command-replay, and application-effect
semantics. Migration `0006_device_channel_inbound_effect` adds the
`received`/`processing`/`handled` journal and backfills pre-journal inbox rows as
handled so an upgrade does not repeat already accepted application work. Startup
releases interrupted processing claims; acknowledged Worker progress advances only
through the contiguous handled prefix.

## Discord state repository

`SqlDiscordStateRepository` persists the Gateway Resume cursor, digest-idempotent
inbox, one-to-one Forum Task bindings, and ordered leased outbox. SQLite claims are
serialized through the shared write gate; PostgreSQL claims use serializable
transactions with `FOR UPDATE SKIP LOCKED`. Cursor and message progress are
monotonic, Task deletion is terminal, and retry/completion acknowledgements are
exact-replay idempotent across process restart.

Migration `0004_discord_state` contains no token, credential, or secret column.
Interaction work may store only a validated `discord-interaction-ref:*` reference;
raw Discord bot and interaction credentials remain in the Device-local Secret
Store or injected interaction-token vault.

## Device identity repository

`SqlDeviceIdentityRepository` implements the DOM-free
`@opendelegate/device-identity/repository` contract:

```ts
const repository = await SqlDeviceIdentityRepository.openSqlite({
  filename: absoluteRuntimeDatabasePath,
  migrationMode: "apply",
});
```

Normal service startup uses `migrationMode: "verify"`. Only an explicit migration
workflow uses `apply`. PostgreSQL accepts the equivalent `connectionString` and
optional isolated `schema`.

Each repository transaction acquires the portable write gate before correctness
reads. SQLite serializes writers with WAL, `synchronous=FULL`, and bounded busy
retry; PostgreSQL uses serializable transactions and the same bounded retry
contract. Enrollment Grant consumption, Device and certificate updates, and
append-only audit records therefore commit or roll back together across process
restart.

The Device identity schema stores only:

- instance CA public certificate metadata and a local Secret Store key reference;
- SHA-256 Enrollment Grant digests, never raw grant bearers;
- public Device identities and certificates;
- rotation, overlap, retirement, and revocation metadata; and
- append-only identity audit records.

It has no column or DTO for a CA private key, Device private key, or raw Enrollment
Grant secret. Runtime decoders reject non-canonical JSON, unsafe integers, unknown
states, incomplete lifecycle metadata, and malformed durable identifiers as
corruption.

The SQLite contract runs in the default test suite. Set
`OPENDELEGATE_TEST_POSTGRES_URI` to run the identical Discord state, Device
identity, owner-auth, event-store, and Configuration contracts against a real
PostgreSQL service. The same environment variable also enables the Approval
and Worker action-authorization repository contracts.
It also enables the Artifact index repository contract, including restart,
integrity-corruption, signed-token replay, audit, and local-byte/SQL-metadata
separation.
The Device observation contract also runs on both backends, including restart,
stale replay, equal-time conflict, append-only enforcement, and schema egress
rejection.
