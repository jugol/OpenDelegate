# Discord Forum adapter

`@opendelegate/discord-adapter` is the channel boundary that turns an approved Discord Forum post
into one durable OpenDelegate Task and projects canonical Task state back into Discord.

The package deliberately does not depend on Discord-specific Task semantics or expose a bot token
to the orchestration layer. It targets Discord API v10 and the current Gateway intent model through
injectable, standards-shaped HTTP and Gateway ports. A deployment can implement those ports with an
officially supported Discord client or a reviewed `fetch`/WebSocket driver without changing this
package's Task or persistence contracts.

## Trust and source-of-truth boundaries

- Exactly the configured guild, Forum channel, owner user IDs, or explicitly allowed role IDs may
  create work. Authorization happens before message content reaches the Task callback.
- Discord thread, message, and attachment identifiers are bindings. The OpenDelegate Task ID and
  database remain authoritative.
- Attachment CDN URLs and interaction tokens are never persisted. Attachments become stable
  `discord-attachment:<snowflake>` input references; the HTTP port consumes an interaction token and
  returns an opaque local response reference.
- The `DiscordApiPort` and `DiscordGatewayPort` own bot credential access. Adapter configuration has
  no token field, and diagnostic text is redacted.
- `DiscordStateRepository` is the production persistence contract for Gateway cursors, inbox
  claims, Task bindings, and leased outbox work. A production implementation must commit those
  records atomically in Main's database. `InMemoryDiscordStateRepository` is a deterministic lab
  implementation with a versioned snapshot used to prove restart behavior; it is not the production
  database adapter.

## Delivery behavior

- Thread and starter-message events may arrive in either order. The shared Discord message
  idempotency key makes both paths converge on one Task.
- Gateway sequence cursors are monotonic per session, but they are never used as an
  event-deduplication substitute. A lower reordered dispatch can still be consumed if its own inbox
  key is new.
- Startup supplies the persisted Resume cursor to the Gateway port and then reconciles active and
  paginated archived threads over HTTP. The Gateway port owns HELLO, heartbeat/ACK, Identify/Resume,
  reconnect backoff, compression, and bot credential handling.
- Discord controls are deferred before Task work is queued. Pause, resume, cancel, retry, approve,
  and reject execute from the durable outbox with channel-neutral idempotency keys.
- Task state is rendered as exactly one workflow tag while preserving at most four non-workflow
  facet tags. A stable Components v2 status panel is edited in place; significant questions,
  decisions, failures, and results remain chronological replies. Artifact and Admin inspection
  links use link buttons.
- Discord outages retain outbox work. `OFFLINE` and rate-limit failures retry with bounded backoff.
  A deleted or inaccessible post marks only its external binding; the Task remains intact for Admin
  Web recovery.

The host should call `flushOutbox()` from its supervised dispatcher and after connectivity recovery.
It should call `reconcile()` after every non-resumable reconnect even when the Gateway port reports a
successful new session.

## Verification

```sh
pnpm --filter @opendelegate/discord-adapter test
pnpm --filter @opendelegate/discord-adapter typecheck
```

The deterministic lab covers authorization, paired-event ordering, duplicate delivery, Task context
isolation, cursor monotonicity, active and archived HTTP reconciliation, status tags, stable
Components v2 presentation, Artifact links, interaction deferral, every control family, deletion,
permission loss, restart, offline outbox recovery, and credential redaction.

A live Discord smoke test is intentionally not claimed: this checkout has no dedicated Community
test guild, Forum, bot token, or owner binding. Release evidence must remain blocked until the
private Discord laboratory proves real Gateway resume, HTTP reconciliation, permissions, rate
limits, mobile controls, and Components v2 rendering.
