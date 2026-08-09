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

An initial repair tried to call Discord's create-message endpoint again with the
same nonce and `enforce_nonce`. Live alpha.15 QA showed that an aged nonce is not a
durable address: Discord created and edited a second “Retry started” message while
the original Retry remained active. The exact message ID therefore has to cross the
successful delivery boundary into durable Main state.

## Decision

When a chronological failure is delivered, the Adapter records one typed failure
surface on the Task binding: request key, source event ID, exact Discord message ID,
outbox creation time, and open state. SQL migration 0015 stores the surface as
canonical JSON in SQLite or PostgreSQL. When that Task projection later enters
`running`, the Adapter finds the matching delivered failure action and enqueues one
`resolve-task-failure` action. Delivery PATCHes the stored message ID directly into
a blue historical receipt containing the prior safe explanation, “Retry started,”
and no controls, then marks the surface resolved.

The surface and action are typed, bounded, and validated identically by SQLite and
PostgreSQL. Repeated projections, process restart, and transport replay reuse the
same surface and resolution action. A Discord nonce remains a bounded duplicate-send
guard only. Resolution never changes Task state or authorizes work. A missing
externally deleted message records a bounded diagnostic and does not mark the whole
Forum binding deleted.

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
- Expiring the fake Discord nonce cache before Retry still edits the stored original
  message ID and creates no second chronological message.
- SQLite persists and restores the exact typed failure surface and resolution action
  across restart.
- A missing historical message records a diagnostic while current Task projection
  continues.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-5
- [`../DECISIONS.md`](../DECISIONS.md), D-085 and D-102
- [`0026-discord-chronological-controls-and-race-reconciliation.md`](0026-discord-chronological-controls-and-race-reconciliation.md)
- [`0037-discord-terminal-control-refusal.md`](0037-discord-terminal-control-refusal.md)
