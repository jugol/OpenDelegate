# ADR-0020: Main singleton ownership before reconciliation

- Status: Accepted
- Date: 2026-07-25
- Refines: D-003, ADR-0005, ADR-0007, FR-21

## Context

The first milestone has one fixed Main Device and deliberately has no leader
election or automatic failover. That product decision does not by itself prevent
an operator, service-manager race, or failed upgrade from starting two Main
processes against the same durable state. Both processes could reconcile pending
work, consume Discord events, dispatch Worker Runs, or expose administrative
listeners. Database transaction isolation protects individual writes but does not
make either process the sole coordinator.

The ownership mechanism must work with embedded SQLite and external PostgreSQL,
must be acquired before any reconciliation or listener startup, and must recover
after process crash without an owner deleting an arbitrary stale PID file.

## Decision

1. Main acquires one process-lifetime singleton authority after storage migration
   and compatibility verification but before approval recovery, route diagnosis,
   Task reconciliation, Discord, Device-channel, Artifact, or Admin listener
   startup.
2. SQLite uses a dedicated ownership database under Main's external state
   directory. One connection holds `BEGIN EXCLUSIVE` for the lifetime of Main. The
   ownership transaction never uses the application database and therefore cannot
   block normal OpenDelegate writes. SQLite's native cross-process file lock is
   released by the operating system when the connection or process ends.
3. PostgreSQL uses a dedicated session-level advisory lock. The lock key is a
   stable OpenDelegate namespace plus the configured schema; an unspecified schema
   conservatively owns the connection's default-schema deployment. Advisory locks
   are scoped by the PostgreSQL database, so unrelated databases do not conflict.
4. The PostgreSQL ownership connection is not pooled or used for application
   queries. A bounded heartbeat detects a lost or ended session. Ownership loss
   marks Main not ready and initiates shutdown; the process may not continue
   coordinating while attempting to reacquire.
5. A second contender fails closed with `MAIN_ALREADY_RUNNING`. Connection,
   locking, or ownership-verification uncertainty fails with
   `MAIN_OWNERSHIP_UNAVAILABLE`; loss after acquisition uses
   `MAIN_OWNERSHIP_LOST`.
6. Normal shutdown closes intake and runtime resources before releasing ownership.
   If a still-authoritative Main cannot close its runtime resources safely, it
   retains ownership rather than allowing a second coordinator to overlap the
   uncertain first process.
7. PostgreSQL server session cleanup and SQLite operating-system lock cleanup are
   the crash-recovery mechanisms. There is no stale timestamp takeover, PID-file
   deletion, lease TTL, leader election, migration to another Device, or automatic
   failover in the first milestone.

## Consequences

- Restart is immediately possible after a clean close or confirmed process death.
- A PostgreSQL network partition favors safety: a replacement cannot acquire the
  server-held lock until PostgreSQL has ended the old session, while the disconnected
  Main shuts down after ownership verification fails.
- The small SQLite ownership database is runtime coordination state, not backup
  authority and not part of a restored application snapshot.
- Native service supervision remains useful for restart and boot persistence, but
  is not trusted as the only singleton boundary.

## Verification

- A real second Node process cannot acquire the same SQLite ownership database.
- Clean release permits an immediate restart, and duplicate release is idempotent.
- PostgreSQL contract tests cover acquisition, an existing holder, explicit
  unlock, session error/end, and heartbeat loss through an injected client.
- Main composition tests prove the gate precedes reconciliation and listener
  startup, ownership loss closes the runtime, and `listenMainRuntime` rechecks
  authority.
- Final release evidence must repeat the second-process, crash, and service-restart
  journeys on the declared Windows, macOS, Linux, SQLite, and PostgreSQL targets.
