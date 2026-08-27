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

## Installation request routing

When the owner asks to install, initialize, repair, or join OpenDelegate, identify
whether the input is a source checkout or a verified release bundle before planning:

- Main installation or recovery uses `.agents/skills/opendelegate-init/SKILL.md` from
  source or `skills/opendelegate-init/SKILL.md` from a bundle.
- Worker or Device join uses `.agents/skills/opendelegate-join/SKILL.md` from source or
  `skills/opendelegate-join/SKILL.md` from a bundle.

Read the selected skill completely and preserve its support-status, credential,
runtime-state, approval, and rollback boundaries. Report the support status exactly
as the release evidence describes it. A local harness used as the setup Agent does
not become an OpenDelegate runtime Agent Adapter; runtime support requires product
code and the documented conformance evidence.

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
