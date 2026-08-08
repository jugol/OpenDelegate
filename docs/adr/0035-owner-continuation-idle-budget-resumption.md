# ADR-0035: Owner continuation restarts the idle window

Status: **Accepted**

Date: **2026-08-07**

## Context

A requested Task can remain waiting for approval, failed, or paused longer than its idle Budget
while the owner is away. Discord durably accepted an owner Retry interaction, but
the Task execution coordinator immediately checked the old activity timestamp. The
retry therefore produced an idle-Budget extension prompt without attempting work.
An approval or resume used the same unsafe ordering.

These actions are explicit, authenticated owner intent to continue. Treating that
intent as inactivity is both semantically wrong and a dead end in the recovery flow.

## Decision

After an approval, `Retry`, or `Resume` is durably accepted, the coordinator records
a durable Budget activity mutation before queuing execution. Its operation identity
is derived from the durable owner action identity, so an ingress replay is safe and
can repair a partially persisted operation.

Only idle time resets. Wall time, retry count, native turns, child Work Orders,
concurrency, tokens, cost, and child Budgets retain their current values and limits.
`Pause`, `Cancel`, and approval rejection do not queue work and do not reset activity.

## Consequences

An owner can approve, retry, or resume an old Task without first extending a Budget
whose only exhausted metric is inactivity. Genuinely exhausted cumulative Budgets
continue to pause through the existing owner-approval flow.

## Verification

- A failed Task advances beyond its hard idle interval, accepts an owner Retry, and
  completes a new execution cycle without an idle-Budget extension.
- A Task waiting for approval behaves the same after a late owner approval.
- Resulting Budget snapshots record zero idle time at the restarted execution.
- Existing hard wall-time and finite-usage tests remain authoritative.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-23
- [`../DECISIONS.md`](../DECISIONS.md), D-083
- [`0033-owner-input-idle-budget-resumption.md`](0033-owner-input-idle-budget-resumption.md)
