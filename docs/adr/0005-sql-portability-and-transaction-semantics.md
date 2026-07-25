# ADR-0005: SQL portability and transaction semantics

Status: **Accepted**

Date: **2026-07-24**

## Context

OpenDelegate must provide embedded SQLite as its zero-administration default and
PostgreSQL for owners who supply an external database URI. The two deployments must
run one domain implementation and pass the same persistence contract. Correctness
depends on more than storing Task rows: event append, materialized state, inbox
deduplication, transactional outbox publication, lease and fencing allocation, and
audit records must commit atomically.

SQLite and PostgreSQL have materially different writer and locking behavior. Kysely
starts SQLite transactions in deferred mode, while PostgreSQL can provide
serializable transactions, row locks, and queue-oriented `SKIP LOCKED` claims.
OpenDelegate cannot let those differences create weaker behavior on the default
database or leak database-specific behavior into the domain.

The Phase 2 spike compared a shared typed SQL layer with separate handwritten
adapters and with Node.js built-in SQLite. The built-in module remains below the
stability level selected for the Node.js 24 release baseline, and separate SQL
implementations would duplicate the highest-risk state transitions.

## Decision

### Libraries and ownership

1. Use `kysely@0.29.4` as the private typed SQL and migration layer in the Storage
   workspace.
2. Use Kysely's official `SqliteDialect` with `better-sqlite3@13.0.1` and
   `PostgresDialect` with `pg@8.22.0`.
3. Expose only asynchronous, backend-neutral storage ports to application modules.
   Kysely, driver objects, SQL errors, and database credentials never cross the
   Storage boundary. Worker processes never receive database credentials.
4. Keep one ordered, append-only migration set in source control. Kysely `Migrator`
   owns application migrations with unordered migration execution disabled.
   Released migrations are immutable.
5. Record a SHA-256 checksum for every migration in an OpenDelegate migration
   manifest. Normal service startup refuses a database with an unknown, changed,
   failed, or pending migration. The explicit migrate and restore workflows are the
   only paths that may advance schema state.

### Portable representation

1. Store domain identifiers, RFC 3339 instants, canonical JSON, and hashes as text.
   Store booleans and monotonic counters as constrained integers where required for
   SQLite parity.
2. Generate domain identifiers and accepted timestamps in the application. Database
   clocks, sequences, and dialect-specific UUID functions are not domain authority.
3. Enforce unique `event_id`, unique `(stream_id, stream_version)`, and unique
   `(sender_id, idempotency_key)` constraints as final correctness guards.
4. Never persist Worker Knowledge content, Knowledge indexes, or Device Secret
   values. Discord bot and interaction tokens are also excluded: Discord outbox
   actions may retain only an opaque Device-local token-vault reference. Storage DTO
   validation rejects those fields before a transaction begins.

### Unit of work

Every durable state transition runs in one short database transaction that:

1. records or verifies its inbox/idempotency command;
2. appends immutable domain events;
3. updates materialized state with an expected-version predicate;
4. writes audit records;
5. creates any resulting outbox messages; and
6. allocates or compares the current lease, fence, and persistence generation when
   the transition owns those resources.

Transactions never include network, provider, Discord, filesystem, or LLM calls.
After commit, outbox dispatch performs those effects and records their idempotent
acknowledgment in a later unit of work.

### SQLite convention

1. Enable `foreign_keys=ON`, WAL journal mode, `synchronous=FULL`, and a bounded
   `busy_timeout` on every connection.
2. Serialize write units of work inside the fixed Main process.
3. Because the Kysely SQLite driver opens a deferred transaction, make the first
   statement update the singleton `od_write_gate` row. This acquires SQLite's single
   writer before any correctness read, providing the required immediate-writer
   behavior without a second transaction implementation.
4. Retry only `SQLITE_BUSY`/`SQLITE_LOCKED` failures with a bounded attempt count and
   injected deterministic backoff. Exhaustion is an observable unavailable result,
   never an unbounded wait.

### PostgreSQL convention

1. Run state-changing units of work at `SERIALIZABLE` isolation.
2. Use row version compare-and-set and `FOR UPDATE` for owned aggregate or lease
   rows. Use `FOR UPDATE SKIP LOCKED` only to claim independent queue-like outbox
   records.
3. Retry SQLSTATE `40001` serialization failures and `40P01` deadlocks with the same
   bounded retry policy exposed by the storage contract.
4. PostgreSQL-only primitives may improve concurrency but may not create a domain
   outcome that SQLite cannot produce.

### Lease, fence, and generation safety

Lease allocation, renewal command outcome, fencing-token increment, and latest
persistence-generation compare-and-set occur in the same unit of work. Duplicate
command delivery returns the original durable outcome and cannot extend authority a
second time. Restore accepts only the latest externally authorized generation; a
coherent but stale snapshot remains rejected.

## Alternatives considered

### Node.js built-in SQLite plus `pg`

Rejected for the first release because the Node.js 24 SQLite API has not reached the
project's selected stable dependency threshold and would still require a second SQL
and migration implementation.

### Handwritten SQL per database

Rejected because duplicated transition and migration code would make semantic drift
most likely around inbox, outbox, leases, and restore fencing.

### Drizzle ORM

Not selected because the spike favored Kysely's thin query-builder and explicit
transaction model for an event-oriented storage port. OpenDelegate does not need an
active-record or generated domain model.

### PostgreSQL-only first release

Rejected because embedded SQLite is an approved first-milestone requirement, not a
later convenience.

### Weaken PostgreSQL to SQLite's default deferred behavior

Rejected. SQLite's write-gate convention and PostgreSQL serializable transactions
instead provide the same observable contract with backend-appropriate mechanics.

## Consequences

- The application and acceptance harness exercise one asynchronous storage contract.
- SQLite remains easy to operate while PostgreSQL supports higher-concurrency outbox
  work without changing domain behavior.
- `better-sqlite3` is a native dependency and release bundles must contain a tested
  binary for every supported OS and architecture.
- Database writes are intentionally short and may retry; callers must provide
  idempotency identifiers and tolerate a bounded transient-unavailable response.
- Migration checksum enforcement makes accidental edits fail fast but requires an
  explicit repair procedure for an operator who has manually changed schema state.
- Backup and restore tooling must coordinate WAL checkpoints, migration
  compatibility, and the external anti-rollback generation authority.

## Verification

- One contract suite runs unchanged against temporary SQLite and a real PostgreSQL
  service.
- The canonical Phase 1 Task journey produces the same events and projection on both
  databases and survives process recreation.
- Concurrent append, duplicate inbox, outbox claim, Run claim, lock fencing, lease
  renewal replay, busy/serialization retry, and migration-from-v1 fixtures pass on
  both databases.
- The Discord state contract additionally proves monotonic Gateway cursors,
  digest-idempotent inbox completion, one-to-one Forum bindings, terminal deletion,
  restart-safe outbox leases, and exact replay of retry/completion acknowledgements.
- A stale stream writer and a stale persistence generation fail closed.
- Packet capture, schema inspection, logs, and diagnostics contain no Worker
  Knowledge, Knowledge index, Device Secret, or database credential outside Main.

## References

- `docs/PRODUCT_SPEC.md`, FR-19 and the persistence test decisions
- `docs/IMPLEMENTATION_PLAN.md`, Spike A and Phase 2
- `docs/DECISIONS.md`, D-005, D-027, D-038, and D-039
- [Kysely migrations](https://kysely.dev/docs/migrations)
- [Kysely SQLite dialect API](https://kysely-org.github.io/kysely-apidoc/classes/SqliteDialect.html)
- [Kysely PostgreSQL dialect API](https://kysely-org.github.io/kysely-apidoc/classes/PostgresDialect.html)
- [SQLite write-ahead logging](https://www.sqlite.org/wal.html)
- [SQLite PRAGMA reference](https://www.sqlite.org/pragma.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
