# Main metadata backup and restore

> [!WARNING]
> **Legacy prototype only.** This document covers the retained Main metadata store; current
> OpenDelegate keeps every Hermes home and runtime state Device-local and does not create this Main
> database. Read [`CONTEXT.md`](../CONTEXT.md) for the current boundary.

OpenDelegate backups are explicit, owner-controlled snapshots of Main metadata.
They are not a replication or failover mechanism and they never move a Worker's
Device-local Knowledge.

## Included data

A backup contains:

- the validated Main configuration, which stores only a canonical
  `secret://main/ALIAS` reference rather than a database URI;
- every enabled secret-free Discord, Artifact, and Device-channel composition,
  including the Device enrollment listener and managed Secret Store backend
  references in `device-enrollment.json`;
- the fixed Main Agent provider selection, when bootstrap has successfully selected
  one, so restore cannot silently switch existing Task sessions to another provider;
- the complete embedded SQLite database or a PostgreSQL custom-format dump; and
- a checksum manifest bound to the Main instance ID, Device ID, database adapter,
  creation time, filenames, sizes, and SHA-256 digests.

The database snapshot is expected to contain durable Tasks, owner-auth records,
session references, Device metadata, orchestration state, audit records, and
Artifact metadata once those services are composed into Main.

The backup deliberately excludes:

- managed OS Secret Store values, provider credentials, Discord tokens, private
  keys, and raw enrollment grants;
- every Worker's Markdown Knowledge, filenames, links, index, and graph;
- generated Artifact bytes;
- logs and diagnostic bundles; and
- release executables and Admin assets.

Back up credentials and Artifact bytes through their own owner-approved mechanisms.
Never place a backup inside the source checkout or the live runtime home.

> [!WARNING]
> A Main backup is sensitive even though OpenDelegate does not intentionally copy
> managed Secret Store values into it. It can
> include password and recovery-code verifiers, browser-session records, Device
> public identity material, Task content, private Artifact metadata, and network
> configuration. Restrict it like the live Main database, encrypt it at rest with an
> owner-controlled mechanism, and never attach it to public release evidence.

## Commands

The packaged CLI exposes:

```text
opendelegate backup create --destination ABSOLUTE_PATH [--home PATH]
opendelegate backup verify --source ABSOLUTE_PATH
opendelegate backup restore --source ABSOLUTE_PATH --home NEW_ABSOLUTE_PATH
  [--admin-root PATH]
  [--secret-backend-config ABSOLUTE_JSON_PATH]
  [--database-uri-ref secret://main/ALIAS
    [--database-uri-stdin] [--database-schema NAME]]
```

`create` refuses an existing destination and commits a completed backup by atomic
directory rename. SQLite uses its online backup API and validates both the source
and snapshot with `quick_check`. PostgreSQL uses `pg_dump` in custom format.
PostgreSQL connection data is resolved from the managed Main Secret Store. The
PostgreSQL child receives only an owner-only temporary libpq service-file path and
service name, never the URI in its arguments or environment. OpenDelegate removes
the temporary service file after the tool exits.

`verify` checks every manifest field, regular-file boundary, byte count, digest,
configuration identity, and database adapter before reporting success. It also runs
SQLite `quick_check` or parses the PostgreSQL custom archive with
`pg_restore --list`; matching checksums alone are not treated as a usable database
snapshot.

`restore` is intentionally non-destructive: the target runtime home must not exist.
SQLite is restored into a temporary sibling directory, checked, and atomically
renamed. Before invoking `pg_restore`, PostgreSQL preflights the target and refuses
an existing named schema or any user-defined object in an unscoped target database.
It then uses `pg_restore` without `--clean`. Use a newly provisioned database with
the same archived schema name; for a schema-scoped backup, that schema must not
already exist. The baseline restore does not remap schemas. The target URI remains
outside the restored configuration, which contains only the canonical Secret
reference. The URI is either pre-provisioned under that reference or read once from
bounded, non-interactive stdin with `--database-uri-stdin`, provisioned into the
selected managed Secret Store backend, zeroed from memory, and never written to
backup metadata.

## Restore procedure

1. Stop the Main service and retain the original runtime home and database.
2. Verify the backup independently.
3. Provision a new empty target home. For PostgreSQL, provision a new empty database
   or schema. Choose a new `secret://main/ALIAS` reference and either pre-provision
   it in the managed Main Secret Store or prepare a bounded non-interactive stdin
   provider.
4. Restore the snapshot. If the Admin assets moved, pass the reviewed new
   `--admin-root`.
5. Start the restored Main with the exact compatible OpenDelegate bundle.
6. Re-provision or verify every referenced managed Secret Store value and TLS
   private key. The secret-free listener/backend configuration is restored, but
   credentials and private keys are deliberately not copied.
7. Complete owner login/recovery, database readiness, Task projection, Device,
   Discord, lease, outbox, Artifact metadata, and audit reconciliation checks before
   dispatching new work.
8. Advance every external monotonic singleton or Computer Use authority required by
   the release procedure. A restored database alone must never revive stale desktop
   input authority.
9. Keep the original state until the restored instance passes the complete
   acceptance checklist.

The fixed-Main rule still applies: restoring a snapshot on another Device is a
deliberate disaster-recovery operation, not automatic Main migration or failover.

## PostgreSQL tool requirements

`pg_dump` and `pg_restore` must be installed from the same major PostgreSQL tool
line as, or a line compatible with, the server. The command fails closed if the tool
is unavailable or exits unsuccessfully. OpenDelegate never falls back to copying a
PostgreSQL data directory.

## Evidence

A release-valid backup/restore proof records:

- the audited source commit and bundle checksum;
- exact OS, architecture, database engine and tool versions;
- the backup manifest digest;
- successful independent verification;
- restore into a new target;
- complete reconciliation before dispatch;
- negative tests for tampering, existing-target overwrite, missing tools, missing
  Secret references, unavailable managed Secret Store backends, and rejected
  legacy environment-based credential options; and
- confirmation that no Secret value or Device Knowledge appeared in the snapshot
  or evidence.

Do not publish a real backup or any private restore output as public release
evidence.
