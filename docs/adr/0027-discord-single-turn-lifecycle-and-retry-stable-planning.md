# ADR-0027: Discord single-turn lifecycle and retry-stable planning

Status: **Accepted**

Date: **2026-07-29**

## Context

One owner reply was independently rendered as a generic working card, a stable Task
panel update, and a chronological owner-question reply. The panel repeated the Forum
title and question, while both surfaces carried controls. A deterministic
Worker-selection failure then incremented the automatic attempt and invoked semantic
planning again. The resumed native session could return the Task's earlier question,
so one answered prompt appeared again as if it were new.

Hermes Agent and OpenClaw converge on a smaller conversation contract: acknowledge
the inbound message in place, keep transient activity near it, maintain at most one
current progress surface, and leave only significant questions, failures, and
results as durable conversation messages. The comparative primary-source review is
recorded in
[`../research/messaging-agent-conversation-ux.md`](../research/messaging-agent-conversation-ux.md).

The source-event delivery key supersedes an earlier full-projection digest. Existing
installations can therefore already contain a delivered question or result under
the older key when they upgrade.

## Decision

For every accepted Discord owner message, OpenDelegate enqueues one deterministic
in-place acknowledgement. The HTTP adapter adds a best-effort `👀` reaction to the
exact owner message and triggers Discord typing. Main's synchronization loop refreshes
typing while the turn remains active. After the durable question, result, or failure
reply is delivered, the same owner message moves from `👀` to `✅` or `❌`. Missing
optional reaction permission or a deleted message degrades the acknowledgement
without blocking Task ingestion; transport and rate-limit failures continue through
the durable outbox retry path. Reaction removal and terminal-reaction addition for
one message execute sequentially because Discord assigns them to the same
rate-limit bucket. A short, bounded `retry_after` is retried inside only the failed
individual request; an exhausted or long rate limit returns to the durable outbox.

The stable Components v2 Task panel shows the workflow state, bounded progress, and
durable reference links. It does not repeat the Forum title or chronological
question, and it does not carry mutable Task controls. Significant questions,
decisions, failures, and final results remain ordinary chronological replies. Their
delivery identity is the immutable Task source-event ID, not a digest of mutable
Artifact or inspection links. An owner answer resolves the existing question
message in place and removes its controls before the same Task resumes.
Before enqueuing a source-event delivery, the Adapter adopts any existing legacy
outbox item carrying that Task and source-event identity. If an interrupted upgrade
has already delivered duplicate copies of one question, the first eligible owner
answer resolves every copy of that same source event so no stale prompt remains
actionable.

Task execution gives semantic planning a stable key derived from the first attempt
of one owner-input cycle. Automatic attempts retain their own execution keys for
Run, budget, and failure accounting but load the same durable semantic plan. A new
owner input starts a new cycle and therefore receives a new planning key.

## Consequences

An ordinary owner reply adds no bot-authored working card. The exact owner message
shows acceptance, the Task panel remains a compact dashboard, and one significant
reply owns the substantive content. A transient Worker or route problem cannot send
the Main Agent back to a previously answered question. Long turns keep a native
typing signal alive without adding heartbeat messages, and terminal reactions close
instead of leaving stale `👀` markers.

The initial planning-key shape intentionally matches the first-attempt execution key
used by earlier builds, so an upgrade can reuse an already-recorded first-attempt
plan. Discord installations without reaction permission still process Tasks and
record a bounded diagnostic.

## Verification

- Duplicate delivery of one owner message creates one acknowledgement outbox item
  and no generic working message.
- A waiting projection renders the full question only in the chronological update;
  the stable panel contains neither the objective nor question text or Task command
  custom IDs.
- Answer ingestion and prompt editing survive an outbox restart; replay recovers the
  same nonce-bound Discord message and never appends a second question.
- Artifact enrichment of one terminal source event updates the stable panel without
  posting another chronological result.
- Upgrade from a full-projection delivery key adopts the delivered legacy item
  without sending the source event again; duplicate copies left by an interrupted
  upgrade are all resolved by one owner answer.
- A deterministic retry after Worker unavailability invokes planning once for the
  owner-input cycle and reuses the original Work Order plan.
- Reaction/typing HTTP calls are bounded and authenticated; typing refresh and
  `👀`-to-`✅`/`❌` closure are verified, and optional permission failure does not
  reject Task ingestion.
- The terminal reaction is not requested until acknowledgement removal finishes;
  a one-request rate limit repeats only that request instead of replaying both halves
  of the transition.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-5 and FR-6
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 7
- [`0026-discord-chronological-controls-and-race-reconciliation.md`](0026-discord-chronological-controls-and-race-reconciliation.md)
- [`../research/messaging-agent-conversation-ux.md`](../research/messaging-agent-conversation-ux.md)
