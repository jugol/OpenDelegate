# Architecture Decision Records

Architecture Decision Records capture implementation-level choices that refine the
approved product specification.

## Rules

- Product decisions remain in `docs/DECISIONS.md`.
- Add an ADR before encoding a technical choice that materially affects security,
  persistence, protocols, platform support, or extensibility.
- An ADR may refine but must not contradict the approved specification.
- Superseded ADRs remain in history and link to their replacement.
- Use the template in this directory.

## Status vocabulary

- `Proposed`
- `Accepted`
- `Superseded by ADR-NNNN`
- `Rejected`

## Accepted foundation ADRs

1. [`0001-foundational-runtime-boundaries.md`](0001-foundational-runtime-boundaries.md)
2. [`0002-development-runtime-and-monorepo.md`](0002-development-runtime-and-monorepo.md)
3. [`0003-phase-zero-module-map.md`](0003-phase-zero-module-map.md)

## Initial required ADRs

The implementation plan requires ADRs for:

1. SQL portability and lease semantics.
2. Release packaging and service supervision.
3. Local daemon-to-desktop-helper IPC.
4. Computer Use backend and permissions for each OS family.
5. Owner authentication.
6. Device application identity and channel authentication.
