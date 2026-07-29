# ADR-0024: Configuration Chat history and Approval correlation

- Status: Accepted
- Date: 2026-07-28
- Refines: D-057, D-058, D-061, FR-15, FR-16, ADR-0005, ADR-0007

## Context

Configuration Chat previously relied on one provider-native session for conversational
continuity. Admin reloads could not restore completed exchanges, and a failed native
resume started a new provider session without the earlier visible conversation.
Protected Configuration apply attempts also used chat-request operation identity when
requesting Approval. A follow-up such as “approval complete” therefore produced a new
Approval even when it referred to the same immutable proposal.

The fix must preserve the fail-closed tool boundary: an interrupted in-flight tool
turn cannot be reconstructed or replayed safely. Raw Secrets and provider-hidden
reasoning must never enter the visible history.

## Decision

1. Main appends each completed owner/Agent exchange to an event stream keyed by target
   Device and Adapter. The existing per-request response stream remains an idempotent
   lookup, while the conversation stream is the recoverable visible transcript.
2. The authenticated history GET is a durable read and remains available when native
   Agent messaging is degraded. Admin hydrates it before enabling send or automatic
   Discord onboarding, then renders it independently of provider readiness.
3. A fresh pre-tool native continuation receives a bounded recent excerpt of completed
   visible exchanges. Provider-private and interrupted unfinished context remains
   unavailable. Post-tool interruption still fails closed.
4. A protected apply Approval is correlated by target Device plus immutable proposal
   ID and exact action fingerprint. Existing legacy Approval records are matched by
   that exact action before a new semantic idempotency record is created. Approval
   executes the stored operation immediately.
5. Chat tool operation identity remains request-bound. It is not widened across later
   messages, because a historical receipt may have been compensated by a later
   runtime rollback and must not be presented as current state.

## Alternatives considered

### Trust only the provider-native session

Rejected because provider restart would continue losing visible owner context.

### Reuse one apply operation ID for every message mentioning the same proposal

Rejected because an apply receipt can be historical after activation compensation.
Replaying it in a later chat turn could misstate the effective configuration.

### Persist incomplete owner turns and provider-hidden traces

Rejected because their effect outcome may be unknown and hidden reasoning is not
product state.

## Consequences

Completed exchanges survive Main and browser restart, but an interrupted unfinished
owner turn is not automatically replayed. History is isolated per Device and Adapter.
One exact proposal action reuses one Approval even across pre-upgrade request-key
formats. Existing duplicate legacy Approvals remain auditable; the succeeded exact
match takes precedence and no additional duplicate is created.

## Verification

- Configuration Agent restart and fresh-continuation tests restore the visible
  Device transcript.
- Control Plane tests read history while native messaging reports unavailable.
- Admin tests gate automatic onboarding until hydration completes.
- Configuration Approval tests retry the same proposal under a different chat
  operation and observe one Approval ID and one executable action.

## References

- `docs/PRODUCT_SPEC.md` FR-15 and FR-16
- `docs/DECISIONS.md` D-057, D-058, and D-061
- `docs/THREAT_MODEL.md`

