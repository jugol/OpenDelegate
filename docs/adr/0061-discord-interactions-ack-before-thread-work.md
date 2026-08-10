# ADR-0061: Discord interactions acknowledge before thread work

Status: **Accepted**

Date: **2026-08-11**

Decision: **D-123**

## Context

Live sequential-Approval QA showed a correctly rendered `Approve once` control
failing with Discord's “application did not respond” notice. Main had durably
claimed the interaction but had not acknowledged it or decided the Approval. The
interaction handler was waiting behind an unrelated in-place activity update on the
same Forum thread, so the safe per-thread serialization also delayed Discord's
three-second acknowledgement deadline.

## Decision

Main claims and ephemerally defers an authorized-looking Discord interaction before
it waits for earlier work on that Forum thread. Only after the acknowledgement and
its opaque response reference are durable does the handler enter the existing
per-thread serialization boundary to validate the binding, parse the control, and
enqueue the idempotent Task command or Approval decision.

If an unacknowledged interaction is already more than 2.5 seconds old when Main can
inspect it, Main records a bounded late-ack diagnostic, completes that inbound
identity without executing its control, and advances the Gateway cursor. The owner
can use the still-authoritative current button to submit a fresh interaction. Main
never performs a control whose acknowledgement outcome is unknown.

## Consequences

Slow progress-card edits can no longer consume the interaction response window.
Task and Approval mutation remains serialized, durable, idempotent, and fail-closed.
A replayed expired interaction cannot wedge Gateway progress or unexpectedly execute
after Discord has told the owner it failed.

## Verification

- Adapter tests hold earlier work on one thread and prove a later interaction is
  deferred before that lock is released.
- Adapter tests prove an already-late interaction is completed without acknowledgement
  or Task command execution, and exact replay remains inert.

## References

- [ADR-0053](0053-discord-worker-action-approval.md)
- [ADR-0059](0059-discord-sequential-approval-clarity.md)
- [Product specification FR-5](../PRODUCT_SPEC.md#fr-5--discord-forum-integration)
