# Contributing to OpenDelegate

OpenDelegate welcomes focused issues and pull requests that preserve its personal-first, local-first
security boundaries.

## Before changing code

Read [`AGENTS.md`](AGENTS.md) first. It requires the following context in this exact order:

1. [`CONTEXT.md`](CONTEXT.md)
2. [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md)
3. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
4. [`docs/DECISIONS.md`](docs/DECISIONS.md)
5. Relevant primary-source material under [`docs/research`](docs/research)

These documents are the product contract. Material changes to persistence, protocols, security,
platform support, or extension boundaries require an ADR under [`docs/adr`](docs/adr) before
behavior changes.

## Development

The release baseline is Node.js 24 LTS and pnpm 9. Node.js 22.14 remains a temporary compatibility
floor.

```sh
pnpm install --frozen-lockfile
pnpm setup:browser
pnpm check
pnpm build
pnpm test:browser
```

`pnpm setup:browser` installs Chromium for the Admin Web browser suite. On Linux, Playwright may
also request system packages; follow its printed dependency command or use the
environment-appropriate `playwright install --with-deps chromium` invocation.

Useful focused commands:

```sh
pnpm test:tooling
pnpm --filter @opendelegate/domain test
pnpm --filter @opendelegate/admin-web test
pnpm dev:admin
```

Use test-driven development for public behavior. Add a failing test at the narrowest stable seam,
implement the smallest coherent behavior, then refactor only while the suite stays green.

## Issues and security

Use the Bug report form for reproducible behavior, the Product or implementation proposal form for
new work, and the dedicated architecture or threat-model forms for their named review boundaries.
State whether a request concerns the current foundation, a planned implementation phase, or the
first-milestone release gate.

Never disclose vulnerability details in a public issue. Follow [`SECURITY.md`](SECURITY.md); until a
verified private route exists, use only the detail-free Private security channel request form.

## Pull requests

- Keep one concern per pull request.
- Explain macOS, Windows, Linux, Secret, Policy, and local Knowledge impact.
- Include test evidence and any manual platform proof.
- Do not weaken a canonical invariant to make an adapter easier to implement.
- Never commit credentials, native provider transcripts, private chain-of-thought, local Worker
  Knowledge, runtime databases, or generated Artifacts.
