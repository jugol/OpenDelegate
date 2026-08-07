# ADR-0034: Discord Gateway intake does not await outbound delivery

Status: **Accepted**

Date: **2026-08-07**

## Context

The Discord Gateway processes dispatches in sequence so its Resume cursor never
skips an unprocessed event. The Forum adapter previously kept that serialized path
open while it drained every pending REST action. A slow reaction, tag update, panel,
or chronological reply therefore delayed later dispatches from unrelated threads.
In a production trace, a reply in an old Task blocked a new Forum Post long enough
that its first visible response arrived 80 seconds after the Post was created.

Live `THREAD_CREATE` was also followed by an immediate REST request for the starter
message. Discord subsequently delivered the starter through `MESSAGE_CREATE`, so
the request added latency and rate pressure without adding information.

## Decision

The adapter completes the durable inbound mutation and saves the Gateway cursor,
then starts its single-flight outbox drain without awaiting it in the Gateway
callback. Task projections request that same drain as soon as their actions are
durable. The outbox remains the source of delivery ordering, leases, retry state,
and idempotency; this change does not make Discord writes fire-and-forget.

An approved live thread payload is retained in memory. Its starter message uses the
payload directly and does not call `getThread` or refetch the starter. Reconciliation
still fetches and ingests a missing starter when a reconnect occurred between the
thread and message dispatches. Until the starter durably binds a Task, the
cache-only thread dispatch deliberately leaves the persisted Resume cursor behind
so a crash cannot make that memory-only observation authoritative.

## Consequences

A slow outbound Discord request cannot head-of-line block intake from another Forum
Post. The owner acknowledgement can begin as soon as the new input is durable, and
redundant REST traffic is removed from the normal new-Post path. A crash may replay
an already-saved dispatch or an already-attempted outbound action, but inbound keys,
Discord nonces, and outbox transitions keep both paths idempotent.

## Verification

- A `THREAD_CREATE` followed by its starter `MESSAGE_CREATE` creates and binds one
  Task even when starter REST lookup is forced to fail.
- A blocked acknowledgement delivery for one Post does not prevent a second Post
  from reaching the Task port or advancing its Gateway cursor.
- Explicit outbox drains retain outage, restart, prompt-resolution, and exactly-once
  behavior.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-5
- [`../DECISIONS.md`](../DECISIONS.md), D-079
- [`0027-discord-single-turn-lifecycle-and-retry-stable-planning.md`](0027-discord-single-turn-lifecycle-and-retry-stable-planning.md)
