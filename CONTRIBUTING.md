# Contributing to OpenDelegate

OpenDelegate welcomes focused issues and pull requests that preserve its personal-first security
model and fixed-Main architecture.

The repository is pre-release. A passing local build is useful engineering evidence, but it does not
make a change release-ready or make an operating system, provider, Discord integration, or Computer
Use backend supported.

## Read the product contract first

Read [`AGENTS.md`](AGENTS.md), then read these files in order before planning or implementing a
change:

1. [`CONTEXT.md`](CONTEXT.md)
2. [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md)
3. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
4. [`docs/DECISIONS.md`](docs/DECISIONS.md)
5. Relevant primary-source material under [`docs/research`](docs/research)

These documents are the canonical product contract. Do not weaken an accepted invariant for
implementation convenience. Material changes to persistence, protocols, security, platform support,
release packaging, or extension boundaries require an ADR under [`docs/adr`](docs/adr) and any
corresponding canonical-document update before behavior changes.

## Development environment

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

## Release evidence and internal previews

Run:

```sh
pnpm release:status
```

The output separates implementation status from required live proof for all 36 first-milestone
criteria. Hosted CI, fake adapters, WSL, and contract tests cannot substitute for owner-controlled
platform-lab evidence where the specification requires real macOS, Windows, Linux, Discord,
provider, reboot, or desktop behavior.

An unsupported, platform-specific validation bundle may be built on Node 24.18.0:

```sh
pnpm release:build --destination ABSOLUTE_PATH --internal-preview
```

The destination must be absent, absolute, and outside the checkout. Never commit the bundle, runtime
state, or generated evidence back into the source tree.

The production command intentionally fails until every criterion has complete evidence:

```sh
pnpm release:gate
pnpm release:build --destination ABSOLUTE_PATH
```

Do not bypass the gate, remove the internal-preview marker, publish an unsupported bundle under a
release tag, or describe a contract fixture as live platform proof. See
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

Do not rerun the same full suite on every operating system for ordinary pull requests. Use the
manually dispatched **Release validation** workflow when a release candidate or a platform-sensitive
change needs the macOS, Windows, Linux, PostgreSQL, Node compatibility, native helper, and
packaged-bundle matrix. CodeQL and dependency audits run weekly or on explicit manual request.

## Issues and security

Use the Bug report form for reproducible behavior and the Product or implementation proposal form
for new work. Architecture and threat-model changes have dedicated forms.

Never disclose vulnerability details in a public issue. Follow [SECURITY.md](SECURITY.md) and use
GitHub's verified **Report a vulnerability** form, which creates a private draft security advisory
for this repository.
