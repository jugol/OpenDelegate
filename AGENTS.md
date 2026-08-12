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

### Runtime delegation fast path

The required-context preflight above applies to planning, implementing, reviewing,
or diagnosing OpenDelegate source and product behavior. It does not apply merely
because an ordinary owner-assigned runtime Task happens to use the OpenDelegate
repository as its registered Workspace.

- For file authoring, Artifact creation, builds, reports, or other explicitly scoped
  runtime work, read only the files needed to perform that Task. Do not inventory or
  read the canonical planning documents, research corpus, repository history, or
  unrelated source before starting.
- Do not run repository-wide tests, status surveys, or documentation audits for a
  runtime Task unless its requested outcome actually changes or reviews source.
- If the Task does ask to modify, review, or diagnose OpenDelegate itself, follow the
  full required-context preflight before making that source change.

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

## Operator-safe diagnostics

- Never load, replay, summarize, or parse an entire archived Codex rollout or prior
  large Task transcript. Continue from a curated checkpoint and the canonical
  repository documents. If a missing fact must be recovered, query one exact file
  for one exact pattern, cap the displayed result at 20 concise matches, and do not
  resume the archived Task.
- Keep interactive diagnostic output bounded. Filter at the source and emit at most
  20 concise records or a short aggregate; never stream an unbounded log, process
  list, event log, database dump, or recursive search into the desktop client.
- When more evidence is required, write the full sanitized capture outside the
  source checkout and show only its path, record count, and the few lines carrying
  the signal. Redact credentials and private owner data before any display or saved
  capture.
- Prefer one narrow query per hypothesis. Check the projected row count or byte size
  before display, and tighten the query when it can exceed the interactive bound.

## Product boundary

OpenDelegate owns deterministic orchestration, durable task state, policy
enforcement, transport selection, and agent adapter lifecycle. It does not implement
a new general-purpose LLM or rely on one vendor's desktop UI as its source of truth.
