# ADR-0055: Owner-cycle-scoped Work Order IDs

Status: **Accepted**

Date: **2026-08-10**

## Context

A Discord Forum post is one durable Task and may receive many owner-input cycles.
The Main Agent emits a Work Order plan for each new cycle. Native Agents naturally
reuse short labels such as `wo-01`; however, the orchestration journal treats a Work
Order ID as durable within its Task and correctly rejects different content under an
existing ID.

Live follow-up QA reproduced that boundary: a harmless repeated Device-directory
question fell through to semantic planning, the Agent reused the earlier label, and
the Task failed with `WORK_ORDER_ID_CONFLICT` before any Worker side effect. Asking a
model to remember all historical IDs is neither deterministic nor restart-safe.

## Decision

Agent-authored `workOrderId` values are plan-local labels. After parsing a ready Main
Agent plan and before authoritative persistence, Main derives a bounded namespace
from the stable semantic planning key. It replaces each label with a deterministic
opaque ID containing that namespace and the Work Order ordinal, and remaps all
`dependsOn` references through the same label-to-ID map.

The planning key is stable across automatic retries in one owner-input cycle, so a
retried plan retains exactly the same Work Order IDs. A new owner-input cycle has a
new planning key and therefore a distinct namespace. Duplicate plan-local labels,
invalid Work Orders, and dependencies that do not name a Work Order in the same plan
remain invalid and fail closed in the existing authoritative validator.

## Consequences

- A native Agent may use concise labels without controlling durable identity.
- Retry-stable semantic plans remain idempotent across restart and resource recovery.
- Different owner turns cannot collide merely because their plans use the same
  label.
- Dependency topology is preserved exactly after deterministic remapping.
- Titles, briefs, and journal evidence remain the human-readable debugging surface;
  durable IDs are intentionally opaque.

## Verification

- Repeating the same plan and planning key yields the same durable Work Order ID.
- The same plan-local label under a different owner-cycle planning key yields a
  different durable ID.
- A multi-Work-Order plan remaps every dependency to the corresponding durable ID.
- A same-Task, multi-message bounded Device-directory follow-up completes directly
  and creates neither a model turn nor a Work Order.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-6 and FR-7
- [`../DECISIONS.md`](../DECISIONS.md), D-027, D-066, and D-103
- [`0027-discord-single-turn-lifecycle-and-retry-stable-planning.md`](0027-discord-single-turn-lifecycle-and-retry-stable-planning.md)
