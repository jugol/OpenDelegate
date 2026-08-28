# Contributing to OpenDelegate

OpenDelegate welcomes focused issues and pull requests that preserve its SSH-first Hermes Device
federation model.

The current product is the Agent procedure, project skills, templates, and documentation described
in `CONTEXT.md`. The TypeScript applications, packages, Admin Web, enrollment system, and release
builder are a retained legacy prototype. Do not extend or present that prototype as the current
owner workflow unless the owner explicitly requests legacy work.

## Read the product contract first

Read these files before planning or implementing a current OpenDelegate change:

1. [`AGENTS.md`](AGENTS.md)
2. [`CONTEXT.md`](CONTEXT.md)
3. [`README.md`](README.md)
4. The applicable skill under [`.agents/skills`](.agents/skills)
5. Relevant primary-source material under [`docs/research`](docs/research)

`CONTEXT.md` is the current product contract. `docs/PRODUCT_SPEC.md`, `docs/IMPLEMENTATION_PLAN.md`,
`docs/DECISIONS.md`, `apps/`, `packages/`, and release tooling describe the legacy Admin Web
prototype. Their historical approval status does not override `CONTEXT.md`.

## Current SSH-first work

End users do not need the legacy TypeScript runtime. Contributors use the pinned Node.js and pnpm
toolchain only to run repository policy checks for documentation, project-skill, template, and
routing changes:

Install Node.js 24.18.0 from `.node-version`, then activate the repository's pinned pnpm and install
the frozen workspace before running any pnpm command. If your Node distribution does not include
Corepack, install Corepack by following the official pnpm installation guide first.

```sh
corepack enable
corepack prepare pnpm@11.15.1 --activate
pnpm install --frozen-lockfile
```

Run the focused checks:

```sh
pnpm docs:check
pnpm test:tooling
```

The repository's required pull-request checks remain the final integration gate.

## Legacy prototype development environment

Use this section only when the owner explicitly asks to maintain the retained TypeScript prototype.

Release bundles require exactly **Node.js 24.18.0**, as recorded in `.node-version`. The contributor
engine also accepts Node.js 22 from 22.14.0 onward, but release-builder and release-proof work must
use the pinned Node 24.18.0 runtime. The repository pins pnpm 11.15.1.

```sh
pnpm install --frozen-lockfile
pnpm setup:browser
pnpm check
pnpm build
pnpm test:browser
```

`pnpm check` validates canonical documents and release evidence, architecture boundaries,
formatting, lint, types, tooling tests, and package tests. A blocked release ledger is expected
during development; an invalid ledger is not.

`pnpm setup:browser` installs Chromium for the Admin Web browser suite. On Linux, Playwright may
also request operating-system packages.

Useful focused commands include:

```sh
pnpm test:tooling
pnpm --filter @opendelegate/domain test
pnpm --filter @opendelegate/storage-sql test
pnpm --filter @opendelegate/admin-web test
pnpm dev:admin
```

Use test-driven development for public behavior: add a failing test at the narrowest stable seam,
implement the smallest coherent behavior, and refactor while the suite stays green. Contract changes
should exercise duplicate delivery, denial, restart, cancellation, and partial failure wherever
those conditions apply.

## Legacy release evidence and internal previews

The commands in this section concern the retained Admin Web prototype. They do not build or release
the current SSH-first OpenDelegate workflow.

Run:

```sh
pnpm release:status
```

The output separates implementation status from required live proof for all 36 first-milestone
criteria. Hosted CI, fake adapters, WSL, and contract tests cannot substitute for owner-controlled
platform-lab evidence where the specification requires real macOS, Windows, Linux, Discord,
provider, reboot, or desktop behavior.

The legacy bundle builder is retired and direct invocation fails closed. Do not bypass that guard,
publish an old internal preview, or describe a contract fixture as current platform proof. See
[`docs/release/README.md`](docs/release/README.md) and
[`docs/release/PLATFORM_LAB.md`](docs/release/PLATFORM_LAB.md).

## Pull requests

- Keep one coherent concern per pull request.
- Explain macOS, Windows, Linux, Secret, Policy, local Knowledge, Artifact, and upgrade impact where
  relevant.
- Include automated evidence and identify every manual or live proof that remains unrun.
- Update the release ledger only with durable evidence, never a prose assertion.
- Keep schemas, state transitions, and adapter contracts vendor-neutral at their shared boundaries.
- Preserve application authentication on private networks; network reachability is not identity.
- Keep runtime state, databases, logs, generated Artifacts, provider transcripts, credentials,
  recovery data, and Device Knowledge outside the checkout.
- Never commit private chain-of-thought or rely on it as durable Task state.

### Validation cadence

Every pull request runs one Ubuntu validation job. Documents, release evidence, architecture,
formatting, lint, and tooling remain repository-wide checks. Types, deterministic package tests, and
builds follow the changed workspace packages plus their dependents. The Admin Web browser harness
runs only for Admin Web or dependency-manifest changes. Secret scanning and dependency review are
the only additional required checks.

Do not rerun the same full suite on every operating system for ordinary pull requests. The manually
dispatched **Legacy prototype validation** workflow exists only for explicitly requested maintenance
of the retained prototype across macOS, Windows, Linux, PostgreSQL, Node compatibility, and native
helpers. It no longer builds or uploads bundles. CodeQL and dependency audits run weekly or on
explicit manual request.

## Issues and security

Use the Bug report form for reproducible behavior and the Product or implementation proposal form
for new work. Architecture and threat-model changes have dedicated forms.

Never disclose vulnerability details in a public issue. Follow [SECURITY.md](SECURITY.md) and use
GitHub's verified **Report a vulnerability** form, which creates a private draft security advisory
for this repository.
