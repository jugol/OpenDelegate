# ADR-0062: Device-channel prefix acknowledgement is bounded

Status: **Accepted**

Date: **2026-08-11**

Decision: **D-124**

## Context

A personal Main retained more than fifty thousand authenticated Worker frames after
normal heartbeat operation. Computing the cumulative Worker acknowledgement loaded
every historic inbox/effect row into JavaScript for each new frame. The result was
quadratic process work, hundreds of megabytes of transient allocations, sustained
Main-thread CPU load, multi-second health latency, and missed Discord interaction
deadlines even though every individual database write remained correct.

## Decision

The SQL Device-channel repository derives the handled prefix with one bounded
aggregate result. SQL verifies the durable inbox count, matching effect count,
minimum and maximum sequence, and first unhandled sequence. JavaScript receives one
summary row rather than materializing the per-generation history.

The externally visible protocol is unchanged: acknowledgements remain cumulative,
strictly contiguous, generation-scoped, and fail closed when the inbox/effect
journal or sequence checkpoint disagrees. This optimization does not authorize
history deletion; retention and audited compaction remain separate lifecycle work.

## Consequences

Normal heartbeat history no longer makes each subsequent frame increasingly
expensive or blocks unrelated owner controls behind large JavaScript allocations.
SQLite and PostgreSQL retain the same repository contract and corruption checks at
the durable sequence boundary.

## Verification

- Existing SQLite and optional PostgreSQL Device-channel repository contracts cover
  duplicate frames, sequence gaps, interrupted effects, completion, restart, and
  generation reset.
- Live Main verification compares process CPU, health latency, and Discord
  acknowledgement behavior against the retained production-sized channel history.

## References

- [ADR-0061](0061-discord-interactions-ack-before-thread-work.md)
- [Decision D-081](../DECISIONS.md#d-081--worker-reconnect-replay-advances-at-durable-acknowledgment-boundaries)
- [Implementation plan](../IMPLEMENTATION_PLAN.md)
