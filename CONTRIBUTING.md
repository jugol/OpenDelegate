# Contributing to OpenDelegate

OpenDelegate welcomes focused issues and pull requests that preserve its personal-first, local-first
security boundaries.

## Before changing code

Read, in order:

1. [`CONTEXT.md`](CONTEXT.md)
2. [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md)
3. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
4. [`docs/DECISIONS.md`](docs/DECISIONS.md)
5. [`AGENTS.md`](AGENTS.md)

Material changes to persistence, protocols, security, platform support, or extension boundaries
require an ADR under [`docs/adr`](docs/adr).

## Development

The release baseline is Node.js 24 LTS and pnpm 9.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:browser
```

Use test-driven development for public behavior. Add a failing test at the narrowest stable seam,
implement the smallest coherent behavior, then refactor only while the suite stays green.

## Pull requests

- Keep one concern per pull request.
- Explain macOS, Windows, Linux, Secret, Policy, and local Knowledge impact.
- Include test evidence and any manual platform proof.
- Do not weaken a canonical invariant to make an adapter easier to implement.
- Never commit credentials, native provider transcripts, private chain-of-thought, local Worker
  Knowledge, or runtime databases.
