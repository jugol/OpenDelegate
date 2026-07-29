# ADR-0032: Configuration Chat locale and Approval handoff

Status: **Accepted**

Date: **2026-07-30**

## Context

Admin Web already sent its selected locale in `Accept-Language`, but the control
plane discarded that header before invoking the Configuration Agent. An
English UI-generated profile instruction could therefore produce an English answer
inside a Korean Admin session.

A second failure occurred after the Agent successfully called `propose`. It returned
a final message telling the owner to approve the proposal without calling `apply`.
The Approval broker is intentionally entered only by a policy-checked apply attempt,
so no Approval existed and the proposed setting could not change. Agent prose alone
could not safely create or identify an Approval.

Configuration history also hydrated while the drawer was closed. The message-count
scroll effect consumed that update while the drawer was hidden, so opening it later
showed the oldest message.

## Decision

The control plane normalizes the Admin `Accept-Language` header to one of the six
supported presentation locales and passes it as bounded Configuration Agent request
metadata. The prompt requires newly generated owner-visible prose in that locale,
including when the owner message or deterministic UI instruction uses another
language. Canonical IDs, model IDs, commands, keys, values, and stored history are
never translated. The normalized response locale is part of the request's durable
idempotency identity, so an interrupted request cannot be resumed under the same
idempotency key with different presentation semantics.

Within one Configuration Agent request:

- `validate` is the preview-only path and creates no durable proposal;
- a successful `propose` starts the normal change flow;
- Main refuses a terminal response while a proposal from that turn has no matching
  apply attempt;
- Main instructs the native session to inspect the diff and call `apply` exactly
  once;
- an unprotected apply may return a verified mutation receipt;
- a protected apply creates or reuses one durable Approval through the existing
  target-Device-plus-proposal idempotency key and returns its exact ID.

The broker-issued pending Approval ID is added to the typed Configuration Agent
response and durable conversation exchange. Admin Web renders a localized
owner-review action in that Agent message. The action switches to Approvals and
focuses the exact request. Agent-authored URLs or parsed prose never select the
Approval.

The chat scroll effect separately observes a closed-to-open transition. It positions
the already-hydrated transcript at its current end even when the message count did
not change during that transition.

## Alternatives considered

### Treat every proposal as an Approval

Rejected because proposal creation is non-executable and has not passed the
just-in-time mutation policy boundary.

### Parse a proposal or Approval ID from Agent prose

Rejected because owner-visible text is not an authoritative executable protocol and
may be malformed, stale, or fabricated.

### Automatically translate stored responses

Rejected because it would rewrite durable owner/Agent history and could corrupt
identifiers or configuration values.

### Load Configuration history only after opening

Rejected as the sole fix because background hydration is useful and the viewport
position is an independent presentation concern.

## Consequences

Configuration changes now reach either a verified immediate apply or a real owner
Approval in one Agent turn. The Admin locale controls future Agent prose without
altering history. Restored conversations open at the newest message, and pending
Approvals remain directly reachable after restart.

## Verification

- A Korean `Accept-Language` request produces a Korean response instruction even for
  an English configuration message.
- Reusing one durable request idempotency key with a different response locale is
  rejected after restart.
- An Agent that tries to finish after `propose` receives a bounded correction and
  must attempt `apply`.
- A protected apply returns its broker-issued Approval ID in the response and restored
  conversation.
- The in-message action opens that exact Approval.
- A chat hydrated while closed scrolls to its newest message when opened.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-15
- [`../DECISIONS.md`](../DECISIONS.md), D-041, D-061, and D-072
- [`0024-configuration-chat-history-and-approval-correlation.md`](0024-configuration-chat-history-and-approval-correlation.md)
