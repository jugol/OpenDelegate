# ADR-0039: Pull-request validation follows the changed workspace graph

Status: **Accepted**

Date: **2026-08-08**

## Context

ADR-0030 removed the cross-platform release matrix from ordinary pull requests, but
the remaining Ubuntu job still ran every package test, every package build, and the
Admin Web browser harness for every documentation, Worker, or backend-only change.
The same deterministic coverage remains useful; running unrelated suites on every
change is not. It delays feedback and consumes hosted-runner quota without exercising
the modified boundary.

The pnpm workspace graph already knows both the packages changed since the pull
request base and their dependents. Repository-wide policy checks and tooling tests
remain cheap and can continue to run unconditionally.

## Decision

The required `Validate pull request` job keeps one Ubuntu runner and a 15-minute hard
timeout. It always runs canonical-document, release-ledger, architecture, formatting,
lint, and tooling checks. Typechecks, deterministic package tests, and builds run for
the changed workspace packages and their dependents, excluding the root command that
would recursively select the entire repository again.

The Admin Web browser harness runs only when the Admin Web tree or dependency manifests
change. The checkout fetches full Git history so the immutable pull-request base SHA
can define the affected set. Secret scanning and dependency review remain required for
every pull request. Release validation remains explicit and unchanged.

## Consequences

Worker-only changes no longer install Chromium or execute unrelated package suites.
Shared-package changes still test their dependent applications through the workspace
graph, and manifest changes conservatively exercise every affected package plus the
browser harness. A green pull request remains engineering evidence rather than a
supported-release claim.

Maintainers still run `pnpm check`, `pnpm build`, `pnpm test:browser`, and the manual
release matrix when preparing a release or when risk warrants repository-wide evidence.

## Verification

- The workflow uses the event's exact base SHA and pnpm's changed-package/dependent
  selector.
- The root recursive test command is excluded from the affected package invocation.
- Admin Web and dependency-manifest changes install Chromium and run Playwright.
- A Worker-only change skips Playwright while testing Worker and its dependents.
- Branch protection check names and the manual release-validation matrix do not change.

## References

- [`0030-tiered-repository-validation.md`](0030-tiered-repository-validation.md)
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), CI validation strategy
- [`../DECISIONS.md`](../DECISIONS.md), D-070 and D-087
