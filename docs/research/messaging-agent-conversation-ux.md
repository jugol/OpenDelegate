# Messaging Agent Conversation UX

Research snapshot: 2026-07-29

Scope: official Hermes Agent and OpenClaw documentation and source code only

This report compares how the two projects present an agent turn in Telegram,
Discord, and Slack. It does not treat either project's product model as an
OpenDelegate requirement. Observed behavior and OpenDelegate recommendations are
separated explicitly.

The source snapshots are:

- Hermes Agent commit
  [`76b0ea5118ca11373e49234cd8bdd608848e423f`](https://github.com/NousResearch/hermes-agent/tree/76b0ea5118ca11373e49234cd8bdd608848e423f)
- OpenClaw commit
  [`f78ba091207b33c3bb79f1bd9879d0e56be91a16`](https://github.com/openclaw/openclaw/tree/f78ba091207b33c3bb79f1bd9879d0e56be91a16)

## Executive finding

The strongest shared pattern is **one inbound owner message, one visible turn
lifecycle**:

1. acknowledge the exact owner message immediately;
2. keep typing or a native activity indicator alive;
3. update at most one transient progress surface;
4. if input is required, show one canonical question and consume its answer once;
5. finish with one durable result, or one actionable failure.

Neither reference supports posting a generic work card, a second task-state card,
and a third copy of the same owner question for one turn. Hermes Discord instead
uses a reaction lifecycle on the owner's message, persistent typing, and one
clarification embed whose controls are disabled by editing that same embed after
answering. [Hermes Discord reactions](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/plugins/platforms/discord/adapter.py#L2836-L2889)
[Hermes Discord typing](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/plugins/platforms/discord/adapter.py#L5015-L5077)
[Hermes Discord clarification](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/plugins/platforms/discord/adapter.py#L8999-L9118)

OpenDelegate still needs its own durable Task status projection for the Forum
dashboard. That projection and the chronological turn UX are different concerns:
the Task projection may show `Working` or `Waiting`, but it must not repeat the
full question or carry stale turn controls.

## Observed patterns

| Concern | Hermes Agent | OpenClaw | Product implication |
| --- | --- | --- | --- |
| Immediate acknowledgement | Discord and Slack move a reaction from `👀` to `✅` or `❌`; Discord also maintains typing while work runs. [Hermes Discord](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/website/docs/user-guide/messaging/discord.md#L405-L422) [Hermes Slack](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/plugins/platforms/slack/adapter.py#L3742-L3778) | Typing timing is configurable and refreshed every six seconds by default; acknowledgement reactions are separately configurable. [OpenClaw typing](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/concepts/typing-indicators.md#L8-L28) [OpenClaw Discord acknowledgement](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/channels/discord.md#L934-L953) | React to the exact owner message and show typing. Do not require the owner to find an older card to know the newest message was accepted. |
| Long-running progress | One editable progress bubble is the default grouping; successful final delivery can remove temporary progress, while failure preserves it. [Hermes progress grouping](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/gateway/run.py#L20688-L20695) [Hermes final cleanup](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/gateway/run.py#L23909-L23953) | `progress` mode keeps one editable status draft. Discord deletes the draft after a successful final and can retain a failed-turn record; tool activity is folded into the same bounded preview. [OpenClaw channel streaming](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/concepts/streaming.md#L217-L270) [OpenClaw progress bounds](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/concepts/streaming.md#L293-L346) | Maintain one mutable chronological activity message per active turn. Edit it only on a meaningful state change or a throttled long-running heartbeat. |
| Owner input | Discord presents one embed with choices and `Other`; a choice edits the same embed, disables its buttons, and records who answered. Open-ended clarification captures the next message in that session. [Hermes clarification send](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/plugins/platforms/discord/adapter.py#L6929-L6955) [Hermes clarification resolve](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/plugins/platforms/discord/adapter.py#L8999-L9118) | `ask_user` prefers one question, provides native buttons for a single choice, always permits free text, and continues with best judgment after timeout. Duplicate or stale actions resolve as already terminal. [OpenClaw `ask_user`](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/tools/ask-user.md#L15-L53) [OpenClaw question resolution](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/src/infra/question-gateway-resolver.ts#L75-L113) | Store one unresolved prompt object. Render it once, atomically bind one owner answer to it, edit that same message to its terminal state, and resume the same Run. |
| Busy follow-ups | The owner can select interrupt, queue, or steer behavior; hard stop is separate. [Hermes busy behavior](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/website/docs/user-guide/messaging/index.md#L355-L379) | Runs are serialized per session while separate sessions can run in parallel. The default `steer` mode injects follow-ups at the next model boundary without aborting an in-flight tool batch. [OpenClaw queue](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/concepts/queue.md#L9-L42) [OpenClaw steering](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/concepts/queue-steering.md#L11-L48) | If no owner prompt is pending, handle a new post as explicit steering, follow-up, or interruption according to policy. If a prompt is pending, first attempt to consume the message as its answer instead of starting a duplicate turn. |
| Session boundary | Discord threads, Telegram topics, and Slack threads are isolated conversation surfaces. [Hermes sessions](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/website/docs/user-guide/sessions.md) | Discord threads do not copy the parent transcript by default, Telegram topic IDs participate in the session key, and Slack thread replies share the root thread session. [OpenClaw Discord threads](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/channels/discord.md#L750-L766) [OpenClaw Telegram topics](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/channels/telegram.md#L550-L577) | One Discord Forum post remains one OpenDelegate Task and one native-agent session lineage. Another post must not inherit its conversational transcript merely because it shares a Forum. |
| Duplicate delivery and restart | Hermes deduplicates transcript turns by session and platform message ID. Its Discord recovery ledger does not mistake an acknowledgement emoji for proof that a substantive reply was delivered. [Hermes transcript deduplication test](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/tests/gateway/test_dedupe_user_turns.py#L65-L107) [Hermes Discord completion proof](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/plugins/platforms/discord/adapter.py#L2352-L2412) | Inbound deduplication uses provider message ID plus route and agent scope, but the default cache is process-local with a 20-minute TTL. The question manager is also process-local. [OpenClaw inbound deduplication](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/src/auto-reply/reply/inbound-dedupe.ts#L13-L28) [OpenClaw question manager](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/src/gateway/question-manager.ts#L1-L16) | Adopt the identities and UX, not the transient storage. OpenDelegate must persist ingestion, prompt, projection, delivery, and attempt state in its database across Main restart. |
| Failure and retry | Hermes distinguishes context overflow, interruption, and other bounded errors and tells the owner how to recover instead of posting only a generic failure label. [Hermes error presentation](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/gateway/run.py#L3114-L3194) | Provider retry preserves ordering, retries only the current request, honors rate limits, and never repeats completed steps of a composite flow. [OpenClaw retry policy](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/concepts/retry.md#L10-L41) [OpenClaw composite retry](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/concepts/retry.md#L68-L74) | A failed Task message must contain the concrete category, a safe reason, the failed stage, and the valid recovery action. Retry must create a linked attempt without appending the same owner turn twice. |

## Platform-specific presentation

### Discord

Hermes uses the owner's message as the anchor: `👀` means accepted, persistent
typing means the run is alive, and `✅` or `❌` closes the reaction lifecycle.
Clarification uses exactly one interactive message. Discord reconnect recovery
tracks processing and response state durably and requires a bot reply reference,
not a success emoji alone, before it considers an input answered.
[Hermes recovery ledger](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/plugins/platforms/discord/adapter.py#L2439-L2595)

OpenClaw's Discord `progress` mode keeps one edited status draft and removes it
after final delivery. It also treats native approval buttons as the primary UX,
with a textual command only as fallback.
[OpenClaw Discord progress](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/channels/discord.md#L720-L738)
[OpenClaw Discord approvals](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/channels/discord.md#L1133-L1150)

**OpenDelegate inference:** keep the Forum starter or one bot-owned summary as the
Task-level dashboard projection, but use a newer chronological activity message
for the current turn. Do not put the only `Retry`, `Cancel`, or owner-question
control on the old starter message at the top of a long thread.

### Telegram

Hermes can stream by editing one preview and finalize rich output into that same
message. Clarification uses one inline keyboard, and progress notifications can
remain silent while final results and approvals notify normally.
[Hermes Telegram streaming](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/website/docs/user-guide/messaging/telegram.md#L928-L962)
[Hermes Telegram clarification and notification policy](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/website/docs/user-guide/messaging/telegram.md#L1197-L1224)

OpenClaw likewise sends and edits one preview, reuses it for the first final chunk,
and falls back to normal final delivery plus stale-preview cleanup if a final edit
fails.
[OpenClaw Telegram streaming](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/channels/telegram.md#L296-L365)

**OpenDelegate inference:** if Telegram is added later, use quiet progress edits and
notify on owner decisions, actionable failures, and final results, not on every
tool event.

### Slack

Hermes uses Slack's ephemeral assistant status under the composer for thinking,
tool activity, and elapsed work, leaving no progress chatter in message history.
Its clarification prompt is one Block Kit message that is updated in place and
loses its controls after resolution.
[Hermes Slack work status](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/website/docs/user-guide/messaging/slack.md#L467-L519)
[Hermes Slack clarification](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/website/docs/user-guide/messaging/slack.md#L344-L355)

OpenClaw either uses Slack native streaming or edits a draft post and suppresses a
second delivery path for that turn.
[OpenClaw Slack streaming](https://github.com/openclaw/openclaw/blob/f78ba091207b33c3bb79f1bd9879d0e56be91a16/docs/concepts/streaming.md#L263-L284)

**OpenDelegate inference:** prefer a platform-native ephemeral work indicator where
one exists. Discord does not offer the same assistant-status surface, so its
equivalent is reaction plus typing plus one edited activity message.

## Recommended OpenDelegate conversation contract

### Separate Task state from turn presentation

OpenDelegate should maintain two projections with different identities:

- **Task projection:** one durable summary per Forum post. It contains Task state,
  current stage, assigned Device, and last meaningful update time. It never copies
  the owner-question body and never owns the sole active controls.
- **Turn projection:** one chronological lifecycle associated with one inbound owner
  message and one Run attempt. It owns acknowledgement, activity, owner input, and
  terminal presentation.

This separation prevents the screenshot's duplicate `Waiting` Task card and
`Owner input needed` card from rendering the same question.

### Deterministic lifecycle

For an accepted owner message:

1. Persist the inbound event before invoking an agent.
2. Add `👀` and begin typing.
3. Create at most one activity message for the turn. Its first text can be
   `Received — working on it.` and later edits must reuse its Discord message ID.
4. Edit only on a stage change, a meaningful agent update, or a throttled
   long-running heartbeat. Never append generic heartbeat cards.
5. On successful final delivery, change `👀` to `✅`, stop typing, and remove or
   compact the temporary activity message.
6. On failure, change `👀` to `❌`, stop typing, retain the activity surface as the
   failure receipt, and expose a current `Retry` action there.

The activity surface may expose `Cancel` while an active Run can still be
cancelled. `Pause` should appear only if OpenDelegate can durably enter and resume
a real paused state. Neither reference provides evidence for duplicating
`Pause`/`Cancel` controls on every update.

### One canonical owner prompt

An owner prompt needs a durable identity such as
`(task_id, run_id, agent_request_id)`, not an identity derived only from localized
question text.

- Creating the same prompt identity twice returns the existing prompt and existing
  platform message ID.
- The Task projection changes to `Waiting`, but displays only a compact summary
  such as `Waiting for owner input`; the full question exists only in the prompt
  message.
- A button click or eligible next owner message atomically changes
  `pending -> answered` and records the answer's provider event ID.
- The same transaction enqueues one resume action for the same Run and native
  session lineage.
- The platform message is edited to show the selected answer and has all active
  controls removed or disabled.
- Repeated clicks, Gateway redelivery, refresh, and restart return the existing
  terminal result and never create a new prompt.
- The agent may ask the same words again only with a new upstream request identity
  after the prior answer has been delivered to the resumed agent session.

If a prompt is open and the owner posts ordinary text, OpenDelegate should treat it
as the answer by default. Explicit control commands such as cancel remain controls,
not answers.

### Durable idempotency

Persist at least these unique identities:

- inbound event:
  `(binding_id, provider_channel_id, provider_thread_id, provider_message_id)`;
- owner turn:
  `(task_id, provider_message_id)`;
- agent attempt:
  `(run_id, attempt_number)`;
- Task projection:
  `(task_id, projection_kind)`;
- turn activity projection:
  `(run_id, inbound_event_id, projection_kind)`;
- owner prompt:
  `(task_id, run_id, agent_request_id)`;
- prompt answer:
  `(owner_prompt_id, provider_interaction_or_message_id)`;
- outbound logical delivery:
  `(task_id, run_id, delivery_kind, logical_sequence)`.

Store the provider message ID after delivery. On an ambiguous network result,
reconcile before sending again; if duplication cannot be excluded, label a
recovered reply rather than presenting both copies as independent agent turns.
Hermes applies this principle to its at-least-once delivery ledger.
[Hermes delivery recovery](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/website/docs/user-guide/messaging/index.md#L212-L235)

### Actionable terminal messages

A failure should say:

- what failed: routing, Device connection, agent launch, approval, tool, timeout,
  output delivery, or internal invariant;
- where it failed: Device and stage when safe to disclose;
- what OpenDelegate will do automatically;
- what the owner can do now;
- a correlation or Run ID for diagnostics.

`Task needs attention` may be a heading, but it is not sufficient body text.
`Retry` retries the failed stage or starts a linked attempt according to failure
semantics; it must not ingest the original owner message as a new conversational
turn.

## Required QA scenarios

The following are behavioral acceptance tests, not a requirement to maximize test
count. Each case should assert database state and the observable Discord transcript.

1. A normal message produces one acknowledgement lifecycle and one final result.
2. A long Run edits one activity message; no heartbeat message count grows with
   time.
3. One agent clarification produces one prompt message and a compact Task
   `Waiting` projection without duplicated question text.
4. A free-text answer resumes the same Run and native session exactly once.
5. Double-clicked, stale, unauthorized, and Gateway-redelivered prompt actions do
   not resume twice.
6. Refresh and Main restart preserve the prompt, answer, conversation history,
   projection IDs, and active controls.
7. Crash after posting a prompt but before recording its provider message ID
   reconciles instead of posting the prompt again.
8. Crash after accepting an answer but before agent resume enqueues one recovery
   resume and does not ask again.
9. Two ordinary owner messages during active work follow the configured steering
   policy in arrival order; a pending prompt answer takes precedence over steering.
10. Discord Gateway resume and duplicated `MESSAGE_CREATE` ingest one owner turn.
11. Rate limiting, timeout, and uncertain send or edit results do not create two
    activity, question, or final messages.
12. Deleting the transient activity message recreates at most one current surface;
    deleting the whole Forum post tombstones or removes the Task according to the
    accepted OpenDelegate deletion policy.
13. A failed final edit falls back to one normal final and cleans stale progress.
14. A failed Run leaves the concrete cause and current recovery control in the
    newest chronological message, not only on the Forum starter.
15. Successful, failed, cancelled, and answered terminal messages expose no stale
    actionable buttons.
16. Every supported locale preserves paragraph breaks, control meaning, and the
    uniqueness rules above.

## Boundaries and non-findings

- Hermes supports Discord Forum channels as thread surfaces, but an outbound send
  to a Forum creates a new thread per call. It is not a Forum-tag Task board and
  provides no Intake-tag state model.
  [Hermes Discord Forum behavior](https://github.com/NousResearch/hermes-agent/blob/76b0ea5118ca11373e49234cd8bdd608848e423f/website/docs/user-guide/messaging/discord.md#L772-L779)
- Neither reference is evidence that every active turn should have persistent
  `Pause` and `Cancel` cards. Their ordinary controls are commands, reactions,
  queue modes, or a single current action surface.
- OpenClaw's in-process question and inbound-deduplication lifetimes are not strong
  enough for OpenDelegate's Main-restart requirements. Only the interaction design
  should be borrowed.
- Hermes documentation describes pinning an inbound Telegram message during a
  turn, but no matching adapter implementation was found at the pinned commit. This
  report therefore does not rely on that behavior.
