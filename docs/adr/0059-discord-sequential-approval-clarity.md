# ADR-0059: Discord sequential Approvals stay distinct and quiet

Status: **Accepted**

Date: **2026-08-11**

Decision: **D-121**

## Context

Live Windows file-delivery QA produced several distinct provider command Approvals
inside one native turn. The Worker correctly resumed after each approve-once
decision, but every request rendered the same English sentence and the generic
`Approve` label. Each successful click also left a private confirmation card in the
transcript. The result looked like one ignored Approval repeated many times even
though Main had durably consumed each exact grant and moved to the next protected
action.

## Decision

Keep Discord's authority narrow: it still offers only approve-once or reject, and
broader grants remain on Admin Web. Give the projected Approval a deterministic
ordinal among Worker-action Approvals for that Task plus closed structured fields
for Device label, normalized action category, risk, and additional pending count.
Discord renders those fields in the binding's presentation locale, labels the
positive control `Approve once`, and explicitly says that a later protected action
may need a separate decision. Raw command text, paths, fingerprints, request IDs,
and provider prose remain excluded.

After a successful approve or reject callback, delete the deferred private response
instead of replacing it with another confirmation card. The one durable live Task
surface advances to the next Approval or subsequent Task state. Rejected,
unauthorized, stale, or failed interactions still retain their bounded private error
response.

## Consequences

Sequential exact-action review remains fail-closed and at-most-once, while the owner
can distinguish “the ninth protected action” from a failed replay of the first. A
long native turn no longer leaves a stack of private success cards. Presentation
localization remains deterministic and does not consume Agent context.

## Verification

- Main projection tests prove that a later pending action has a stable Task-local
  ordinal and structured owner-safe metadata.
- Korean and English presentation tests prove localized action/risk text and the
  explicit approve-once label.
- Adapter tests prove that a successful Approval decision dismisses its deferred
  interaction while the durable Task surface remains authoritative.

## References

- [ADR-0053](0053-discord-worker-action-approval.md)
- [ADR-0058](0058-discord-single-current-localized-surface.md)
- [Product specification FR-16](../PRODUCT_SPEC.md#fr-16--policy-and-approvals)
