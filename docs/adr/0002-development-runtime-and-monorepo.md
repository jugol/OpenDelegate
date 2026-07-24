# ADR-0002: Development runtime and monorepo foundation

Status: **Accepted**

Date: **2026-07-24**

## Context

OpenDelegate must build and test on macOS, Windows, and Linux, while later release
bundles need a reproducible runtime independent of an arbitrary global Node.js
installation. Domain, protocol, adapters, platform services, and the Admin Web also
need independently testable boundaries without becoming separate repositories.

## Decision

1. Use a pnpm workspace with `apps/*`, `packages/*`, and `tooling/*`.
2. Use strict TypeScript with ESM and NodeNext resolution.
3. Use Node.js 24 LTS as the CI and release-bundle baseline.
4. Keep a temporary Node.js 22 compatibility floor while that release line remains
   supported, so contributors can run the dependency-light kernel during transition.
5. Pin pnpm 9 and exact dependency versions in the lockfile.
6. Run every package's own public-seam test command from the root rather than import
   native `node:test` files through another test runner.
7. Validate on GitHub-hosted macOS, Windows, and Linux runners; privileged service,
   desktop, and network proof remains in the self-hosted platform lab.

## Alternatives considered

### One root package

Rejected because it would blur domain, Worker, OS-helper, provider, transport, and UI
dependency boundaries and make cross-platform contract tests harder to isolate.

### Multiple repositories

Rejected for the first milestone because protocol changes and three-OS acceptance
evidence must move atomically.

### Node.js 26 Current

Rejected for production use until it reaches LTS. OpenDelegate release bundles target
an LTS line.

### Node.js built-in SQLite as an immediate persistence decision

Deferred to the SQL spike. In Node.js 24 the module is still marked release
candidate, and storage portability requires proof against PostgreSQL before it is
encoded as a permanent dependency.

## Consequences

- Workspace package contracts stay explicit and testable.
- CI uses the current LTS runtime while local kernel work remains possible on the
  owner's present Node.js 22 installation.
- Release packaging must bundle the tested runtime and may later narrow the
  contributor compatibility range.
- Test scripts must propagate package runner failures; a green wrapper with failed
  nested TAP output is not acceptable.

## Verification

- Frozen workspace install succeeds.
- Formatting, lint, strict typecheck, package tests, and document checks run from
  `pnpm check`.
- The CI matrix runs the same check on Ubuntu, Windows, and macOS with Node.js 24.
- A separate Ubuntu job runs checks and builds on the temporary Node.js 22.14 floor.
- A deliberately failing package test makes the root test command fail.

## References

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [Node.js 24 SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- `docs/IMPLEMENTATION_PLAN.md`
