# ADR-0058: Discord presents one localized current Task surface

Status: **Accepted**

Date: **2026-08-10**

## Context

Live Forum QA rendered a starter-adjacent running panel, a cancelled result with an
active Retry button, and a newer running activity at the same time. The individual
events were durable, but the combined transcript suggested mutually incompatible
states. Deterministic Discord headings and controls also remained English for an
owner operating the binding in Korean.

## Decision

Treat the status panel as a bootstrap fallback only. An active live surface or any
chronological Task update deletes it idempotently. Persist a cancellation result in
the existing durable Retry-surface slot used by failures. A newer attempt edits the
exact cancellation message into a historical retry receipt and removes its controls.
The next cancellation may then own the slot.

Add a non-secret, optional `presentationLocale` to the Discord Forum binding. The
default is English. Presentation translates only OpenDelegate's closed deterministic
vocabulary; owner and Agent prose, model identifiers, Device identifiers, and durable
configuration fields remain unchanged.

When the one current surface is a deterministic status projection, it retains the
controls valid for that state. In particular, a resource-wait surface keeps Pause and
Cancel visible, while question, failure, and final fallback panels continue to defer
to their chronological surface instead of duplicating controls. Closed resource-wait
explanations are localized with the rest of the deterministic chrome.

## Alternatives considered

### Keep both the fixed panel and live activity

This preserves an always-visible dashboard near the starter, but it makes a long
conversation show two current states and keeps controls far from the latest turn.

### Delete cancellation history after retry

This is visually simple but removes useful evidence. Editing the exact message keeps
history while making its non-authoritative state explicit.

### Ask an LLM to translate every Discord message

This consumes context, can rewrite identifiers, and makes deterministic controls
depend on model availability. A bounded presentation catalog is predictable.

## Consequences

The transcript has one current action surface, while resolved history remains
readable. Existing stored status-panel IDs may refer to a deleted message; a later
bootstrap-only state can safely recreate the fallback through the existing
not-found recovery path. The historical `failureSurface` storage name now includes
cancelled Retry surfaces for schema compatibility.

## Verification

Adapter tests prove that a bootstrap panel is deleted before chronological work,
that a Korean cancellation Retry becomes a Korean control-free historical receipt,
and that the one live activity surface carries Korean phase, milestone, and control
labels, and that a Korean resource-wait surface retains localized Pause and Cancel
controls. SQLite contract coverage proves the cancellation resolution survives a
restart.

## References

- [Product specification FR-5](../PRODUCT_SPEC.md#fr-5--discord-forum-integration)
- [ADR-0050](0050-discord-bounded-live-task-activity.md)
- [ADR-0054](0054-discord-retry-resolves-prior-failure.md)
