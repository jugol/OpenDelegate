# ADR-0063: Codex App Server notification catalog

- Status: accepted
- Date: 2026-08-11
- Decision: D-125

## Context

Live Windows Artifact delivery reached a contradictory terminal state: the native
Codex session durably recorded a completed turn and committed two Run-scoped files,
while OpenDelegate reported the Worker Run as failed and therefore never entered the
success-only Artifact promotion boundary. The adapter's notification allowlist had
not kept pace with the tested Codex App Server version. A normal lifecycle,
filesystem, hook, naming, or transient provider-retry notification was treated as an
unknown protocol violation even though the same App Server later persisted a
completed turn.

Blindly ignoring every unknown notification would conceal real protocol drift.
Treating a provider `error` notification as terminal is also incorrect because the
notification explicitly says whether Codex is retrying and `turn/completed` remains
the authoritative outcome.

## Decision

The Codex App Server adapter keeps an exact supported notification catalog equal to
the generated experimental notification union of its pinned, tested Codex version.
Catalogued notifications are advisory unless OpenDelegate has explicit projection
logic for them. Provider `error` and realtime-error notifications produce bounded,
generic diagnostics without copying provider-private details; the adapter continues
until the exact turn has an authoritative terminal result. A method absent from the
catalog still fails closed as `UNKNOWN_PROVIDER_MESSAGE`.

Every Codex version promotion must run
`pnpm providers:verify-codex-protocol`. The command invokes the installed pinned
binary's TypeScript protocol generator in a temporary directory and requires exact
set equality between `ServerNotificationEnvelope` and OpenDelegate's catalog. A
different installed version, missing method, or stale method fails verification.

## Consequences

A normal App Server notification can no longer turn a successfully persisted native
turn into a failed Worker Run, so success-only Artifact promotion is reached when the
provider actually completes. Transient provider retries remain visible as safe
diagnostics without leaking raw errors. The adapter remains strict toward genuinely
new protocol messages, and a provider upgrade cannot be called tested until its
generated notification contract is reviewed and synchronized.

This does not promote files from an actually failed or indeterminate provider turn,
does not weaken Artifact egress checks, and does not reinterpret arbitrary persisted
state after a real protocol violation.

## Verification

- A fixture emits current lifecycle, naming, filesystem, hook, and retry-error
  notifications before completing the exact turn; the adapter succeeds and omits the
  private provider error text.
- The existing unknown-method fixture still fails with
  `UNKNOWN_PROVIDER_MESSAGE` and is not reconciled as success.
- The local protocol verifier generates the pinned 0.146.0 schema and proves exact
  equality for all 72 notifications.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-3 and FR-14
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phases 6 and 9
- [`0044-worker-artifact-output-capability.md`](0044-worker-artifact-output-capability.md)
- [`0052-windows-codex-service-sandbox-directory.md`](0052-windows-codex-service-sandbox-directory.md)
