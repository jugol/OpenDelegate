# ADR-0030: Tiered repository validation

Status: **Accepted**

Date: **2026-07-30**

## Context

Routine pull requests were running the same broad platform, compatibility,
persistence, packaging, and CodeQL checks that are useful for release confidence.
That duplicated work after merges, consumed hosted-runner quota, and made ordinary
changes wait on unrelated operating systems.

OpenDelegate still needs release evidence for Windows, macOS, Linux, Node.js 22,
PostgreSQL, native packages, and security analysis. Those requirements do not imply
that every pull request must regenerate every piece of evidence.

## Decision

Repository validation is split into three tiers:

1. Every pull request must pass `Validate pull request`, `Secret scan`, and
   `Dependency review`. The validation job runs the canonical checks, build, and
   Admin Web browser harness once on Ubuntu with a 15-minute timeout.
2. `Release validation` is manually dispatched before a supported release and after
   changes that can affect platform-native behavior, packaging, Node.js 22
   compatibility, or PostgreSQL persistence. It owns the Windows, macOS, Linux,
   compatibility, persistence, and bundle matrix.
3. CodeQL and dependency audit run weekly and on demand. Secret scanning and
   dependency review remain pull-request gates.

Branch protection requires exactly the three pull-request checks above. Routine
workflows do not rerun solely because a pull request was merged to `main`.

## Alternatives considered

### Run the full matrix on every pull request and merge

Rejected because it repeats high-cost validation without producing proportionate
evidence for most changes.

### Remove cross-platform and security validation

Rejected because supported releases still require platform, packaging, persistence,
compatibility, and security evidence.

### Make all validation manual

Rejected because pull requests still need a fast deterministic quality and security
gate before merge.

## Consequences

Ordinary pull requests have three bounded required checks and avoid a duplicate
post-merge run. Release owners must explicitly run the full validation workflow when
release or platform evidence can change. Weekly CodeQL and dependency audits provide
ongoing repository-wide analysis, while pull requests retain immediate secret and
dependency-change protection.

## Verification

- Branch protection reports only the three required pull-request check contexts.
- A pull request starts the lean validation and security workflows, but not release
  validation or CodeQL.
- Merging to `main` does not start a duplicate routine validation run.
- A manual release-validation dispatch retains all supported-platform,
  compatibility, persistence, and bundle jobs.
- Scheduled and manual security workflows retain CodeQL and dependency audit.

## References

- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), CI validation strategy
- [`../DECISIONS.md`](../DECISIONS.md), D-070
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md), validation cadence

