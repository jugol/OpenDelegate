# ADR-0056: Authority-reducing Work Order default

Status: **Accepted**

Date: **2026-08-10**

## Context

The Main Agent returns a strict Work Order protocol document. A Work Order must
declare `requiredSecretRefs` even when it needs no credential. During live alpha.18
Discord QA, the Agent produced a correct two-Device plan with every execution and
safety field present but omitted that empty array. The authoritative validator
correctly rejected the incomplete protocol document before dispatch.

Retrying the model is wasteful and nondeterministic for an omission whose only safe
meaning is zero credential authority. Broad schema repair would be unsafe: inventing
dependencies, constraints, Capabilities, input selection, placement, or Secret
references can change ordering, eligibility, side effects, or authority.

## Decision

Planning prompts state that every Work Order must include `requiredSecretRefs` and
use `[]` when no credential is needed. Before durable Work Order ID scoping, Main
performs one narrow canonicalization: when the property is absent, it inserts an
empty array.

This repair is intentionally authority-reducing. It cannot select, expose, or inject
a Secret. If the property is present, Main preserves it exactly for authoritative
protocol validation. `null`, a scalar, malformed identifiers, and duplicate values
remain invalid. No other mandatory Work Order property receives a default.

## Consequences

- A harmless Agent omission does not fail an otherwise valid owner turn.
- OpenDelegate never guesses which credential a Task needs.
- The scheduler and Worker receive the same complete strict protocol they already
  validate.
- Ordering, constraints, input selection, capability requirements, placement, and
  all explicit Secret authority remain fail-closed.

## Verification

- A planning result without `requiredSecretRefs` becomes exactly
  `requiredSecretRefs: []`.
- The planning prompt explicitly requires the field and explains the empty value.
- Existing explicit arrays pass through unchanged.
- Ordinary protocol validation still rejects an explicit malformed value and every
  other invalid Work Order field.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-7
- [`../DECISIONS.md`](../DECISIONS.md), D-027, D-066, and D-104
- [`0055-owner-cycle-scoped-work-order-ids.md`](0055-owner-cycle-scoped-work-order-ids.md)
