# OpenDelegate agent instructions

## Required context

Before planning or implementing any OpenDelegate work, read the following files in
order:

1. `CONTEXT.md`
2. `docs/PRODUCT_SPEC.md`
3. `docs/IMPLEMENTATION_PLAN.md`
4. `docs/DECISIONS.md`
5. Relevant material under `docs/research/`

These documents are the canonical source of truth. Do not infer a conflicting
product behavior from an earlier chat summary or from implementation convenience.

## Change discipline

- The owner approved the specification and authorized implementation on 2026-07-24.
  Implement work in the order and at the test seams defined by the canonical plan.
- Preserve every invariant marked **Non-negotiable** in `CONTEXT.md`.
- If implementation reveals a conflict, stop and update the specification or add an
  ADR before changing behavior.
- Record changes to accepted product decisions in `docs/DECISIONS.md`.
- Keep runtime state, credentials, generated artifacts, and device Knowledge outside
  the source checkout.
- Use English for source code, canonical product and contributor documentation, UI
  defaults, API fields, schemas, logs, and domain terms. Owner-facing README and
  Admin Web translations explicitly accepted by `CONTEXT.md` invariant 20 and
  D-041 are the only first-milestone documentation/UI exceptions.
- Do not reduce the first milestone to a two-device or single-platform prototype. Its
  release gate includes macOS, Windows, Linux, and Computer Use support as defined in
  the implementation plan.

## Product boundary

OpenDelegate owns deterministic orchestration, durable task state, policy
enforcement, transport selection, and agent adapter lifecycle. It does not implement
a new general-purpose LLM or rely on one vendor's desktop UI as its source of truth.
