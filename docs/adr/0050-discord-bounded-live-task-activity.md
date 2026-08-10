# ADR-0050: Discord bounded live Task activity

Status: **Accepted**

Date: **2026-08-10**

## Context

Discord already acknowledges the exact owner message with `👀`, refreshes typing,
and leaves questions, failures, and results as chronological replies. That lifecycle
removes the earlier duplicate “working” cards, but it does not explain what a long
multi-Device Task is doing between intake and completion. The stable Task panel is
normally near the Forum starter and editing it does not provide a useful current
conversation surface.

Provider streams contain token deltas, tool arguments, local paths, hidden provider
details, and high-frequency events that must not be copied into Discord. They also
contain normalized, owner-safe progress signals such as a native child Agent starting
or a Device-local operation remaining active. OpenDelegate needs the useful signals
without turning one long Task into a message flood or making progress prose part of
the Task's durable Agent context.

The comparative messaging review in
[`../research/messaging-agent-conversation-ux.md`](../research/messaging-agent-conversation-ux.md)
recommends one mutable activity message per active owner-input cycle, edited only on
meaningful change or a throttled heartbeat.

## Decision

OpenDelegate maintains at most one live Task-activity message for the current
owner-input cycle in each bound Discord Forum post. It is distinct from the stable
Task panel and from significant chronological replies. It summarizes Main planning,
dispatch, bounded Worker progress, Work Order completion, and final verification in
a short rolling list. It may include the currently relevant Pause and Cancel
controls so recovery controls are not available only near the Forum starter.
When an owner pauses, the running activity cycle is superseded by one bounded
paused recovery surface at the latest conversation position. That surface exposes
Resume and Cancel, starts no work, and remains idempotent across reconciliation or
Main restart. Resuming replaces it with the next running cycle for the same Task.
Every unfinished Work Order whose prior Run was retired by Pause receives a new
higher fencing token; the intentional retirement is never surfaced as a resumed
Task failure, and late events from that older Run remain stale.

Worker Agent bridges classify provider progress into a closed owner-safe vocabulary:
working, using Device-local tools, verifying, consulting Device-local Knowledge,
coordinating child Agents, or waiting for owner approval. The Worker runtime owns the public wording and accepts no
free-form progress text at its durable outbox boundary. Token deltas, hidden
reasoning, raw tool inputs, private provider messages, native session identifiers,
credentials, and local paths therefore have no representation in progress events.
Identical reports are deduplicated, reports are rate-limited, and each Run has a hard
report count bound. Claimed, completed, and verification phase changes bypass the
display throttle because they are low-frequency orchestration facts.

The Worker records one generic `working` milestone only after the Run is durably in
the running state. This covers quiet provider reasoning and early provider events
that can precede that transition. Subsequent provider tool requests and explicit
progress signals are collapsed into the same closed categories; message deltas,
tool arguments, and tool results are never streamed. An activity revision also
wakes the Discord projector immediately. The existing periodic reconciliation loop
remains the crash and transient-failure repair path, so presentation delivery cannot
become execution authority.

Main accepts progress only for the exact current, unexpired Run lease and fencing
token. A progress event is non-terminal: it does not complete a Run, renew a lease,
reset a Budget, enter Task conversation history, or become Agent checkpoint context.
Main combines current Work Order state and the latest bounded Worker reports into a
transient activity snapshot.

The Discord Adapter persists the activity surface identity and revision with the
Task binding. Newer revisions edit the existing message; stale queued revisions are
ignored. Closing the cycle marks it closed before deleting or compacting the surface,
so a delayed outbox item cannot recreate stale progress. A new owner-input cycle gets
a new surface. Pause closes the running cycle only after its paused recovery surface
is durable. Questions, decisions, failures, cancellation, review, and final results
close the current surface after their authoritative reply or state projection is
durable.

## Consequences

An owner can see that Main is planning, which Device is working, which Work Orders
finished, and whether verification is running without receiving one Discord message
per token, tool call, child Agent, or heartbeat. Multi-Device work reads as one
coherent Task rather than separate bots reporting directly to Discord.
An intentionally paused Task remains recoverable beside the latest turn instead of
requiring the owner to find an old status panel or know a textual command.

Progress remains deliberately lossy and presentation-only. Main restart reconstructs
or replaces it from current orchestration state; the Task, Run journals, results,
approvals, and Artifacts remain the durable source of truth. Failure diagnosis still
comes from the ordinary owner-safe failure reply and inspection surfaces.

## Verification

- Repeated normalized progress for one Run produces at most one bounded Worker event
  per throttle window, and an arbitrary path or provider identifier cannot enter the
  closed progress vocabulary or durable outbox.
- Main accepts a current progress event without changing Run state and rejects a
  stale lease, fence, Device, or terminal Run event.
- Planning, two concurrent Worker Runs, Work Order completion, and verification
  produce one bounded aggregate activity snapshot.
- Repeated Discord projections create one live message and edit it; they do not add
  messages to the thread.
- An older queued revision cannot overwrite a newer revision or recreate a closed
  cycle after terminal delivery.
- A new owner-input cycle creates a new live surface, while a question, failure, or
  result closes the prior one.
- Pause replaces the running surface with exactly one restart-stable paused surface
  containing Resume and Cancel; Resume continues the same Task and opens one new
  running cycle.
- Progress content is absent from Task conversation messages and continuation
  checkpoints.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-5 and FR-9
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 7
- [`0027-discord-single-turn-lifecycle-and-retry-stable-planning.md`](0027-discord-single-turn-lifecycle-and-retry-stable-planning.md)
- [`../research/messaging-agent-conversation-ux.md`](../research/messaging-agent-conversation-ux.md)
- [`0053-discord-worker-action-approval.md`](0053-discord-worker-action-approval.md)
