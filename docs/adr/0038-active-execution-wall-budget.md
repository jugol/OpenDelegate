# ADR-0038: Wall Budget follows active execution

Status: **Accepted**

Date: **2026-08-08**

## Context

A Discord Forum Post can remain one durable Task for days or months while its owner
returns to the same conversation and provider-native sessions. The original Budget
projection calculated Task and Work Order wall usage from their creation timestamp.
Inactive owner waits, pauses, offline Devices, and resource waits therefore consumed
the same Budget as active Agent execution. An old Task could exhaust its 24-hour
requested-Task limit before doing meaningful work.

The Budget event schema already permits durable `wallTimeMs` usage mutations. Task
execution guards and Worker Run start/finish mutations also provide deterministic
boundaries without coupling Budget semantics to a Task state label.

## Decision

Task wall usage is the cumulative union of time covered by one or more active Task
execution guards. Multiple parallel guards share one accounting window. The Budget
service persists elapsed wall time on activity and guard closure, and while work is
continuously active at intervals no longer than 60 seconds.

Work Order wall usage is the cumulative duration of its active Runs. A Run start's
durable event timestamp reconstructs live usage, and Run finish transfers that
duration into the Work Order's persisted usage. Existing version-one Budget events
remain unchanged; active time is recorded through their ordinary usage delta.

Task or Work Order age is never synthesized into wall usage. Waiting, paused,
offline, and otherwise unguarded time consumes zero wall Budget.

## Consequences

A Task can retain its Discord conversation and native sessions indefinitely while
inactive, then resume without a wall-Budget extension. Finite limits still stop
genuinely long automatic execution. Parallel Task branches do not multiply Task wall
usage, while each Work Order accounts for its own active Run duration.

No data migration is required. Earlier histories that contain no explicit wall
usage begin at zero under the corrected meaning; their audit events remain intact.
A sudden Main failure may lose up to one 60-second Task checkpoint, while active Work
Order duration is reconstructed from the Run start event.

## Verification

- A requested Task can remain inactive for seven days, execute for six milliseconds,
  remain inactive for another seven days, and report exactly six milliseconds of
  wall usage.
- A second Budget-service projection observes an execution checkpoint from the
  durable event history rather than Task age.
- Work Order wall limits cross soft and hard thresholds from active Run duration,
  not time since Work Order registration.
- Active Task and Work Order hard deadlines still abort guarded execution.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-23
- [`../DECISIONS.md`](../DECISIONS.md), D-086
- [`0033-owner-input-idle-budget-resumption.md`](0033-owner-input-idle-budget-resumption.md)
- [`0035-owner-continuation-idle-budget-resumption.md`](0035-owner-continuation-idle-budget-resumption.md)
