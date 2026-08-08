# ADR-0037: Stale Discord controls resolve without durable retry

Status: **Accepted**

Date: **2026-08-08**

## Context

OpenDelegate places recovery controls beside chronological Discord failure messages
so they remain visible in long Forum Tasks. A later owner message or state
transition can make one of those older controls invalid. Task authority correctly
rejects that command, but the Discord Adapter previously treated every non-Discord
exception as a transient callback failure. It retried the deterministic refusal
forever and never delivered the deferred interaction result.

## Decision

The Discord Task port translates known terminal Task-service errors into a typed
non-retryable refusal. Invalid transitions identify a stale control or approval;
missing Tasks and invalid or conflicting request identities are also terminal. The
Adapter resolves the deferred interaction with fixed owner-safe guidance, records a
diagnostic, and completes the outbox item. Storage, configuration, transport,
rate-limit, and unknown failures keep their existing retry path.

## Consequences

Historical controls remain safe even when Discord cannot remove them from an old
message. The owner learns to use the latest Task update or send a new message, and
the outbox does not accumulate impossible commands. Successful commands retain
their idempotent replay boundary, and transient failures remain durable.

## Verification

- A stale Retry that receives `TRANSITION_INVALID` produces exactly one Task command
  call and one unsuccessful deferred interaction result.
- Advancing the outbox clock beyond every normal retry interval does not execute the
  command again, and the outbox item is complete.
- The production Task port maps stale command and approval transitions to distinct
  terminal refusal codes.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-5
- [`../DECISIONS.md`](../DECISIONS.md), D-085
- [`0026-discord-chronological-controls-and-race-reconciliation.md`](0026-discord-chronological-controls-and-race-reconciliation.md)
