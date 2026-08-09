# ADR-0054: Discord retry resolves the prior failure in place

Status: **Accepted**

Date: **2026-08-10**

## Context

Chronological failure replies intentionally keep the concrete owner-safe reason and
a nearby Retry button. During live alpha.14 QA, retrying a failed Device-directory
Task correctly moved the stable panel to Done and posted one final result, but the
older failure reply still displayed its active Retry control. The control was safe
under ADR-0037, yet the transcript visually advertised two incompatible current
states.

The Discord outbox already persists the idempotency request key used to create each
significant update. Calling the idempotent create operation with that key recovers
the original Discord message identity even though the binding does not store every
chronological message ID.

## Decision

When a Task projection enters `running`, the Adapter finds delivered failure updates
for that Task that do not yet have a durable resolution action. For each one it
enqueues a `resolve-task-failure` action keyed by the Task and original failure
request key. Delivery reconciles the original message identity and edits that same
message into a blue historical receipt containing the prior safe explanation,
“Retry started,” and no controls.

The action is part of the typed Discord outbox contract and is validated and stored
identically by SQLite and PostgreSQL. Repeated projections, process restart, and
transport replay reuse the same resolution action. Resolution never changes Task
state or authorizes work. A missing externally deleted message records a bounded
diagnostic and does not mark the whole Forum binding deleted.

## Consequences

The transcript retains useful failure history without leaving a stale actionable
button above a newer run or result. The stable status panel and latest chronological
reply remain authoritative. ADR-0037 remains the safety fallback for legacy controls
that predate this lifecycle or for edits Discord could not deliver.

## Verification

- A delivered failed update initially contains exactly one Retry control.
- Publishing the same Task as running creates one durable resolution action, edits
  the original failure message, renders “Retry started,” and removes the custom ID.
- Replaying the running projection does not create a second resolution or message.
- SQLite persists and restores the exact typed resolution action across restart.
- A missing historical message records a diagnostic while current Task projection
  continues.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-5
- [`../DECISIONS.md`](../DECISIONS.md), D-085 and D-102
- [`0026-discord-chronological-controls-and-race-reconciliation.md`](0026-discord-chronological-controls-and-race-reconciliation.md)
- [`0037-discord-terminal-control-refusal.md`](0037-discord-terminal-control-refusal.md)
