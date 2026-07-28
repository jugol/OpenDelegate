# ADR-0026: Discord chronological controls and race reconciliation

Status: **Accepted**

Date: **2026-07-29**

## Context

FR-5 defines one approved Discord Forum post as one Task and workflow tags as a
projection of authoritative Task state. In practice, a new Forum thread and its
starter message can be announced over the Gateway before both resources are readable
through Discord HTTP. Treating that transient `404` as final left tagless posts
unbound and made owners believe an Intake tag was a trigger.

The stable Components v2 status panel is intentionally edited in place to avoid
heartbeat noise, but it remains at the beginning of a long conversation. Current
activity and Retry therefore became invisible near the newest owner message.
Coordinator terminal records also discarded the last owner-safe resource or executor
explanation, leaving only a generic attention notice.

## Decision

The Discord Adapter treats a supported `404` while resolving a just-announced thread
or starter message as an unprocessed Gateway dispatch. It neither persists nor
advances the dispatch sequence. The Gateway reconnects with bounded exponential
backoff and Resume replays the event from the prior cursor; the ordinary reconnect
reconciliation remains an idempotent second recovery surface. Task creation remains
independent of owner-applied workflow tags, and the Adapter projects Intake after the
binding exists.

Discord's HTTP and Gateway thread payloads may omit `applied_tags` when no tag is
applied. The shared wire mapper treats only an absent field as an empty tag set. A
present value must still be a bounded array of valid Snowflake IDs.

Discord REST message endpoints may omit `guild_id` even though the request is for a
thread already resolved inside the configured Guild. The HTTP port passes that
configured Guild ID to the shared message mapper as an absent-field fallback. A
present Guild ID must be valid and equal the configured Guild; Gateway messages do
not receive this fallback.

For every accepted owner message, the Adapter enqueues one deterministic
`post-task-update` outbox record whose idempotency key derives from that inbound
message. The resulting ordinary reply acknowledges current work and carries controls
appropriate to the projected state. It is a conversation event, not a recurring
heartbeat.

A chronological failed update carries Retry and the Task Coordinator persists the
latest owner-safe public message across bounded retries and terminal
`waiting_resource` results. When no specific explanation exists, it emits a bounded
exhaustion explanation naming the classes of resource the owner should inspect.

An interaction is authorized for these controls only when its authoritative Discord
message payload names the configured bot as message author. Task binding, owner and
role allowlists, custom-ID validation, and idempotent command handling still apply.

## Alternatives considered

### Require owners to apply Intake

Rejected because a workflow-status tag is a projection, not an intake command, and
undocumented tag knowledge violates the natural Forum workflow.

### Reconcile every Forum on every Main synchronization cycle

Rejected because it converts a transient creation race into permanent Discord HTTP
load. Cursor-preserving Gateway replay gives durable recovery without a two-second
full scan.

### Keep all controls only on the starter status panel

Rejected because controls scroll out of view and no longer communicate current work
in a long Task conversation.

### Accept controls from any message carrying a valid custom ID

Rejected because an untrusted message could reproduce a custom ID. Authoritative bot
message authorship is required before the normal owner and Task command checks.

## Consequences

Forum posts start without manual tags and creation-order races self-heal without
acknowledging an event that was not ingested. Each accepted owner message creates one
additional durable acknowledgement, while heartbeats continue to edit the compact
status surface without generating messages. Failed updates expose their real
recoverable cause and a nearby Retry button.

The Discord wire contract now includes the source message author ID for component
interactions. Older internal interaction producers must populate this field, and
messages not authored by the configured bot cannot invoke controls.

## Verification

- A starter/thread event race that initially returns `404` leaves the dispatch cursor
  unchanged, then replay creates exactly one Task and projects Intake after the
  resources become visible.
- A live tagless thread whose payload omits `applied_tags` is ingested with an empty
  tag set; malformed present tag data is rejected.
- A REST starter message with no `guild_id` inherits the configured Guild, while a
  present mismatched Guild is rejected.
- Duplicate delivery of an owner message creates exactly one chronological working
  acknowledgement with running controls.
- A chronological failed update contains Retry.
- Bounded resource and executor failures retain an owner-safe explanation and code.
- A bot-authored control executes idempotently; an owner-authored forged control is
  inert.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-5 and FR-21
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 7
- [`0022-live-discord-binding-reconfiguration.md`](0022-live-discord-binding-reconfiguration.md)
