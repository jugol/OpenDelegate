# OpenDelegate

OpenDelegate is a personal, self-hosted orchestration control plane for coordinating
AI agents across a fixed main computer and multiple macOS, Windows, and Linux
devices.

The product specification was approved on 2026-07-24. Implementation follows the
canonical phased plan below.

## Canonical planning documents

Read these documents before implementing or changing the product:

1. [`CONTEXT.md`](CONTEXT.md) — compact domain model, vocabulary, and non-negotiable
   invariants.
2. [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — complete product and architecture
   specification.
3. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — phased delivery,
   test seams, and release gates.
4. [`docs/DECISIONS.md`](docs/DECISIONS.md) — accepted decisions and their rationale.
5. [`docs/research/platform-capabilities.md`](docs/research/platform-capabilities.md)
   — primary-source platform research.

OpenDelegate is licensed under the Apache License 2.0. The repository and all
product-facing terminology use English by default.

## Project status

The repository currently contains the Phase 0 foundation and a deterministic Phase 1
simulation seam. It is **not** the first OpenDelegate milestone: real Discord,
SQLite/PostgreSQL, enrolled Worker services, native Agent adapters, and real
cross-platform Computer Use still belong to later implementation phases.
The in-memory snapshot seam rejects malformed and inconsistently paired lock state,
but it does not yet prove resistance to a coherent rollback of all durable state.

The first milestone remains gated on one real end-to-end system working across
macOS, Windows, and Linux, including Computer Use on supported graphical sessions.
See the acceptance list in
[`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md#first-milestone-acceptance-criteria).

## Development baseline

OpenDelegate's release and CI baseline is Node.js 24 LTS with pnpm 9. A temporary
Node.js 22 compatibility floor is retained for contributors while that release line
remains supported; release bundles will pin their own tested runtime.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:browser
```

There is intentionally no production `start` command yet. Bootstrap and the
Agent-driven `init` experience are delivered only after their runtime dependencies
and recovery paths exist.
