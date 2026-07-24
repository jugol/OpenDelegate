# ADR-0016: pnpm toolchain security upgrade

Status: **Accepted**

Date: **2026-07-24**

## Context

ADR-0002 pinned pnpm 9.15.4 when the workspace foundation was created. The package
manager later accumulated multiple high-severity advisories affecting lockfile
interpretation, environment substitution, patch handling, path containment, and
repository-controlled installation behavior. The public repository's dependency
audit therefore fails before it evaluates application dependencies.

OpenDelegate treats the package manager as part of its build and release supply
chain. A known-vulnerable pin cannot remain merely to avoid a major-version upgrade.

## Decision

1. Replace ADR-0002 decision 5 with an exact pnpm 11.15.1 pin.
2. Require pnpm `>=11.15.1 <12` for source-checkout workflows.
3. Keep Node.js `>=22.14.0 <23` and `>=24 <25` compatibility; pnpm 11.15.1 supports
   those floors.
4. Continue committing a frozen lockfile and exact dependency versions.
5. Enforce a strict 24-hour minimum release age for every direct and transitive
   package, fail when registry publication time is absent, and revalidate rather
   than implicitly trusting a submitted lockfile.
6. Permit install scripts only for the exact reviewed `better-sqlite3` and `esbuild`
   versions. New or changed lifecycle scripts fail installation until reviewed.
7. Block exotic transitive sources and pin the last mature compatible release when
   a transitive range would otherwise select a package inside the release-age hold.
8. Run `pnpm audit --audit-level high` in the hosted Security workflow.
9. Treat future high-severity package-manager advisories as release-blocking
   supply-chain findings.

## Consequences

- Contributors and hosted workflows must use the new pinned pnpm major version.
- The lockfile may receive a mechanical format update even when resolved application
  dependency versions remain unchanged.
- Urgent dependency patches published inside the hold require an explicit,
  version-specific review instead of a broad policy exception.
- Installation, full checks, both Node compatibility lanes, bundle assembly, and
  dependency audit must pass after the upgrade.

## Verification

- `pnpm install --frozen-lockfile` succeeds with pnpm 11.15.1.
- The frozen install passes release-age, lockfile, source, and exact lifecycle-script
  policies.
- `pnpm check`, `pnpm build`, and `pnpm test:browser` pass on Node.js 24.18.0.
- `pnpm check` and `pnpm build` pass on Node.js 22.14.0.
- `pnpm audit --audit-level high` reports no high-severity findings.
- The internal-preview builder records pnpm 11.15.1 in its legal and provenance
  inventory.

## References

- [`ADR-0002`](0002-development-runtime-and-monorepo.md)
- [GitHub Advisory Database](https://github.com/advisories)
