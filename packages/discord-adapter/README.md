# Discord Forum adapter

`@opendelegate/discord-adapter` is the channel boundary that turns an approved Discord Forum post
into one durable OpenDelegate Task and projects canonical Task state back into Discord.

The package deliberately does not depend on Discord-specific Task semantics or expose a bot token
to the orchestration layer. `FetchDiscordApiPort` and `WsDiscordGatewayPort` are the production
Discord API v10 drivers; both retain injectable transport, credential, clock, random, scheduler,
and token-vault seams for deterministic tests and platform composition. `ws@8.21.1` is pinned, JSON
Gateway frames are bounded, and transport compression is disabled.

## Trust and source-of-truth boundaries

- Exactly the configured guild, Forum channel, owner user IDs, or explicitly allowed role IDs may
  create work. Authorization happens before message content reaches the Task callback.
- Discord thread, message, and attachment identifiers are bindings. The OpenDelegate Task ID and
  database remain authoritative.
- Attachment CDN URLs and interaction tokens are never persisted. Attachments become stable
  `discord-attachment:<snowflake>` input references; the HTTP port consumes an interaction token and
  returns an opaque local response reference.
- The `DiscordApiPort` and `DiscordGatewayPort` obtain the bot credential only inside an injected
  callback. Adapter configuration, process arguments, environment variables, SQL, return values,
  diagnostics, and thrown messages have no token field or token value.
- Interaction callbacks are deferred immediately. The raw interaction token is retained only by an
  injected Device-local vault for Discord's bounded follow-up lifetime; durable work contains a
  `discord-interaction-ref:*` opaque reference.
- `DiscordStateRepository` is the production persistence contract for Gateway cursors, inbox
  claims, Task bindings, and leased outbox work. `SqlDiscordStateRepository` in
  `@opendelegate/storage-sql` commits those records atomically in Main's SQLite or PostgreSQL
  database. It rejects credential-shaped work and has no token, credential, or secret column.
  `InMemoryDiscordStateRepository` remains a deterministic lab implementation.

## Delivery behavior

- Thread and starter-message events may arrive in either order. The shared Discord message
  idempotency key makes both paths converge on one Task.
- Gateway sequence cursors are monotonic per session, but they are never used as an
  event-deduplication substitute. A lower reordered dispatch can still be consumed if its own inbox
  key is new.
- Startup supplies the persisted Resume cursor to the Gateway port and then reconciles active and
  paginated archived threads over HTTP. The production Gateway driver owns HELLO jitter,
  heartbeat/ACK timeout, Identify/Resume, Invalid Session handling, close-code classification,
  bounded reconnect backoff, JSON-only framing, and credential handling.
- Discord controls are deferred before Task work is queued. Pause, resume, cancel, retry, approve,
  and reject execute from the durable outbox with channel-neutral idempotency keys.
- Task state is rendered as exactly one workflow tag while preserving at most four non-workflow
  facet tags. A stable Components v2 status panel is edited in place; significant questions,
  decisions, failures, and results remain chronological replies. Artifact and Admin inspection
  links use link buttons. If an owner deletes only the status-panel message, the next projection
  recreates it with the same durable request key instead of marking the underlying Task or thread
  deleted.
- Discord outages retain outbox work. `OFFLINE` and rate-limit failures retry with bounded backoff.
  A deleted or inaccessible post marks only its external binding; the Task remains intact for Admin
  Web recovery.

`apps/main` owns the supervised dispatcher, startup/retry/shutdown lifecycle, SQL repository,
Device-local bot credential provider, restart-spanning interaction-token vault, and Task projection
loop. The Gateway requests reconciliation after every non-resumable reconnect, and Main exposes a
bounded unavailable status without taking Admin Web down.

## Verification

```sh
pnpm --filter @opendelegate/discord-adapter test
pnpm --filter @opendelegate/discord-adapter typecheck
```

The deterministic lab covers authorization, paired-event ordering, duplicate delivery, Task context
isolation, cursor monotonicity, active and archived HTTP reconciliation, status tags, stable
Components v2 presentation, Artifact links, interaction deferral, every control family, deletion,
permission loss, restart, offline outbox recovery, HTTP rate limits and timeouts, Gateway
heartbeat/Resume behavior, bounded frames and bodies, and credential redaction. The SQL package
runs the same Discord state contract against SQLite by default and PostgreSQL when
`OPENDELEGATE_TEST_POSTGRES_URI` is available.

A live Discord smoke test is intentionally not claimed: this checkout has no dedicated Community
test guild, Forum, bot token, or owner binding. Main composition is covered by deterministic tests,
but release evidence remains blocked until the private Discord laboratory proves real Gateway
resume, HTTP reconciliation, permissions, rate limits, mobile controls, and Components v2
rendering.

## Protocol references

- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Gateway events](https://docs.discord.com/developers/events/gateway-events)
- [Opcodes and close codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes)
- [HTTP rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Channel and Forum resources](https://docs.discord.com/developers/resources/channel)
- [Message resources](https://docs.discord.com/developers/resources/message)
- [Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Permissions](https://docs.discord.com/developers/topics/permissions)
