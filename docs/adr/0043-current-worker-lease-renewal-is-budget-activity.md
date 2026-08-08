# ADR-0043: A current Worker lease renewal is Budget activity

Status: **Accepted**

Date: **2026-08-09**

## Context

A legitimate Worker Run can spend longer than the requested Task's 30-minute idle
limit inside one provider turn, build, test, or other quiet tool operation. The
Worker already proves liveness and continuing authority by renewing its exact Run
lease, but Main previously persisted that renewal only in the Run journal. Budget
activity advanced on claim and terminal Worker events, not on the intervening
renewals. A healthy long Run could therefore be aborted as idle even while its
Device, lease, fencing token, and Work Order remained current.

Treating every heartbeat or stale packet as activity would be unsafe. Only the
durable, authoritative renewal decision proves that this exact Run is still allowed
to continue.

## Decision

After Main durably decides an exact Worker Run lease renewal as `renewed`, and while
the renewed lease is still current, it records one Task-and-Work-Order Budget
activity mutation. The activity operation ID is derived from the renewal ID. An
exact request replay therefore returns the durable renewal decision and repairs a
missing activity mutation without applying it twice.

Rejected, late, mismatched, not-due, expired, or no-longer-active renewal requests
do not record activity. Replaying a formerly successful decision after that
decision's renewed lease has expired also does not revive the idle window.

The mutation resets only `idleTimeMs`. It does not reduce cumulative wall time,
retries, turns, tokens, cost, child Work Orders, or any other Budget usage. Active
wall time continues to be measured by ADR-0038.

## Consequences

- A responsive Worker can continue one quiet, long-running Run across many lease
  windows without a false idle-Budget pause.
- A disconnected, wedged, stale, or unauthorized Worker cannot keep a Task alive by
  sending generic traffic.
- Main can recover from a process failure between the Run-journal decision and the
  Budget mutation through the Worker's exact renewal replay.
- The finite wall Budget remains the upper bound on genuinely long automatic work.

## Verification

- Two accepted renewals across a duration longer than one idle window reset both
  Task and Work Order idle usage.
- A rejected renewal leaves the last activity and idle usage unchanged.
- Exact renewal replay is idempotent, and an expired successful replay cannot revive
  activity.

## References

- [`0019-durable-run-lease-renewal-and-clock-calibration.md`](0019-durable-run-lease-renewal-and-clock-calibration.md)
- [`0033-owner-input-idle-budget-resumption.md`](0033-owner-input-idle-budget-resumption.md)
- [`0038-active-execution-wall-budget.md`](0038-active-execution-wall-budget.md)
- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-23
- [`../DECISIONS.md`](../DECISIONS.md), D-091
