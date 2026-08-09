# ADR-0053: Discord Worker action Approval

- Status: accepted
- Date: 2026-08-10
- Decision: D-101

## Context

A protected provider action already creates one durable Main Approval and the Worker
correctly waits for its decision. Discord previously received neither that Approval
projection nor a bounded approval-wait progress category. The owner therefore saw a
generic running Task while the native Agent was blocked. Posting another attention
message would duplicate controls and make a long multi-Device Task noisy.

## Decision

Provider approval requests map to the closed owner-safe `waiting-approval` progress
category. For a running Discord Task, Main selects the oldest pending Approval whose
Task matches and whose execution kind is `worker-action.authorize`. The existing
live activity message is edited to show a friendly Device label, normalized action,
risk, safe current-Run evidence, and approve-once/reject controls. Raw provider
summary, command arguments, paths, fingerprints, and identifiers are excluded.

The Discord callback decides the same Approval Service record used by Admin Web.
Approve always grants the exact action once; broader Task, Device, and Policy grants
remain available through the complete Admin surface. Rejection records an explicit
owner denial. Multiple pending actions are shown serially. Presentation wakeups are
best effort and the existing periodic Discord reconciliation remains authoritative
repair.

The Worker retains its durable wait for the Approval TTL and continues the same
native session after a decision. OpenDelegate does not impose a short elapsed-time
failure merely because the owner has not answered yet.

## Consequences

The latest Discord turn remains both concise and actionable during long delegated
work. There is one Approval authority, one current activity message, and at-most-once
protected execution under interaction replay. Admin Web remains the recovery and
full-detail surface.

## Verification

- A pending Worker action appears only on its bound Task and exposes no private
  presentation fields.
- The activity message contains Approval controls instead of Pause and edits in
  place on the next meaningful activity revision.
- Discord approval executes once under an idempotent interaction replay; wrong-Task
  and stale decisions fail closed.
- Configuration Approvals are not projected through this Worker-action bridge.
- The waiting Worker resumes after the durable decision without a new Task or native
  session.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-5 and FR-16
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 7
- [`0050-discord-bounded-live-task-activity.md`](0050-discord-bounded-live-task-activity.md)
