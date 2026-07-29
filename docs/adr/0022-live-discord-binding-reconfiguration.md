# ADR-0022: Live Discord binding reconfiguration

- Status: Accepted
- Date: 2026-07-27
- Refines: D-048, ADR-0005, ADR-0006, FR-5, FR-14

## Context

Discord is the primary Task surface, but a bot token, Application, Guild, owner
allowlist, or Forum binding can change during the lifetime of the fixed Main
Device. Treating those values as immutable bootstrap input would make routine
maintenance require reinitialization. Conversely, committing an unproven
replacement can strand the owner, and running old and new Gateway sessions
together can duplicate event ingestion.

The raw bot token must remain in Main's Device-local managed Secret Store.
Durable Configuration, Approval, Gateway lifecycle, restart recovery, and SQL
failure handling therefore need one explicit transaction boundary without
turning Discord into Task authority.

## Decision

1. `discord.binding` is a nullable, Main-scoped durable Configuration value. A
   non-null value contains the complete non-secret Forum configuration and one
   opaque managed-Secret alias authorized specifically for Discord bot-token
   use. A first-init alias receives that capability through one durable,
   write-once secure-ingest ledger record before the initial Configuration
   commit; later bootstrap edits cannot replace that record. Later aliases
   receive the capability only through Discord-token secure intake. `null`
   means disabled, and the key cannot be unset.
2. Initial Configuration seeding always writes an explicit `discord.binding`
   candidate, including `null`. An older pre-dynamic Configuration database with
   no candidate is migrated once to explicit `null`; Main does not re-import a
   subsequently edited bootstrap file as an approved live binding.
3. Adding, extending, replacing, or disabling a binding uses Configuration Chat,
   the normal protected owner Approval, and the existing durable Configuration
   audit. Secure intake returns a reference to the Agent, but only its validated
   alias enters `discord.binding`.
4. Main serializes all Discord transitions and owns at most one Gateway runtime.
   A replacement verifies its credential alias and composes before disrupting
   the current binding. Main then closes the current runtime, starts the
   candidate, and waits up to 60 seconds across credential capability lookup,
   runtime composition, `start()`, and readiness. The latest status when
   activation completes must still be Discord `READY`; an earlier stale
   observation is insufficient. Main checks `READY` again after the durable SQL
   apply and immediately before finalizing the prepared lifecycle transition, so
   readiness lost in that interval triggers durable compensation and runtime
   rollback. A factory that resolves after cancellation is boundedly closed, and
   Main cannot report a clean shutdown while that cleanup remains unconfirmed.
5. Candidate unavailability, terminal Gateway failure, activation timeout, or
   durable Configuration failure closes the candidate and restores the previous
   binding while the lifecycle lock remains held. A post-apply lifecycle commit
   failure also compensates the Configuration change before restoring runtime
   state. If either Gateway cannot confirm shutdown, the lifecycle faults closed,
   starts no possibly overlapping Gateway, and requires a Main restart.
6. Startup and rollback of an already-authoritative binding may remain alive in
   its deterministic retry loop while Discord or the platform Secret Store is
   unavailable. Purpose authorization remains mandatory, but temporary Secret
   availability does not prevent composing that authoritative retry runtime.
   That recovery behavior does not qualify a new replacement for commit; a
   replacement must first prove `READY`.
7. Binding changes do not rewrite Task IDs, Task history, Work Orders, native
   Agent sessions, or existing Discord external identifiers. New Forum posts use
   the effective binding; broken or old external bindings remain observable.
8. Main shutdown or singleton-ownership loss cancels authoritative startup,
   rollback restoration, and in-flight replacement before draining the control
   plane. The candidate is closed, queued transitions reject, and any
   unconfirmed or late runtime close faults the lifecycle without starting
   another Gateway. An aborted prepared transition releases the lifecycle lock
   even if its SQL caller has not settled; a later commit attempt fails closed
   and follows the Configuration compensation path. Discord binding Approvals
   are presented as high risk and target the Main Device even when Configuration
   Chat was opened from a Worker tab.

## Alternatives considered

### Keep Discord bootstrap-only

This avoids a live lifecycle transaction but turns routine credential and Forum
maintenance into reinitialization and encourages direct file edits outside the
Approval and audit model.

### Commit Configuration before starting the candidate

This makes SQL simple but can leave the durable source of truth pointing at a
credential or Discord installation that never became usable.

### Run old and new Gateways concurrently during validation

This reduces switchover downtime but violates the single-ingestion authority and
can duplicate commands or race projections.

## Consequences

- A successful replacement has a short interval with no active Gateway while the
  new session reaches `READY`.
- A candidate that cannot prove readiness within the fixed bound is rejected even
  if its later retry might have succeeded; the owner can diagnose and retry.
- Main's Configuration apply lifecycle is now an explicit extension boundary for
  resources whose live state must match an approved durable mutation.
- Pre-dynamic development installations must approve a new Discord binding after
  upgrade instead of trusting an unversioned bootstrap-file edit.
- Discord remains a replaceable channel adapter. Task and session durability stay
  in Main.

## Verification

- Controller tests cover credential purpose and availability, current strict
  `READY`, loss of `READY` after preparation, the complete
  composition-and-activation timeout, late-factory drain, startup and
  restoration cancellation, abandoned prepared-transition shutdown, terminal
  failure, explicit-null disable, rollback ordering, uncertain shutdown, and
  restoration of an unavailable authoritative binding's retry loop.
- Approval tests cover stale durable commit after runtime preparation and prove
  both the live binding and Configuration value return to the prior state.
- Main composition tests approve a replacement through the authenticated public
  API, prove duplicate Approval replay does not open another Gateway, close Main,
  restart from SQL, recover the replacement binding, and close an in-flight
  Discord startup immediately after singleton ownership is lost.
- Release evidence must repeat add, extend, replace, disable, failure recovery,
  and restart journeys against a real Discord Community Server.

## References

- [`../DECISIONS.md`](../DECISIONS.md)
- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md)
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md)
- [`0005-sql-portability-and-transaction-semantics.md`](0005-sql-portability-and-transaction-semantics.md)
- [`0006-owner-authentication-and-local-claim.md`](0006-owner-authentication-and-local-claim.md)
