# ADR-0023: Task-scoped Owner Handoff

Status: **Accepted**

Date: **2026-07-28**

## Context

Some Tasks reach a boundary that an Agent must not bypass: login, MFA, CAPTCHA,
legal confirmation, payment confirmation, an operating-system permission prompt, or
another action that requires the owner. Discord text alone cannot safely carry an
interactive browser or desktop, and posting credentials or a raw Worker VNC,
browser-debug, or local-server endpoint would break the existing Device, Secret,
network, and Artifact trust boundaries.

OpenDelegate already has durable Task state, `waiting_user`, revocable Artifact
metadata, isolated interactive HTML, and credential-free Admin deep links. An
interactive Artifact is also useful as an ordinary result, so presentation mode
alone cannot prove that an owner action is required. A future remote browser or
desktop gateway must refine these boundaries rather than make network location or a
Worker URL into authority.

## Decision

### Explicit Task record

1. Owner Handoff is an explicit Main-owned, Task-scoped record. It is never inferred
   from `interactive-html`, an Agent-authored URL, or a Worker's local listener.
2. The record binds an opaque Handoff ID to exactly one Task, requesting Run,
   bounded owner-visible action, interactive Artifact or session-gateway reference,
   created time, expiry, exposure policy, state, and audit identity.
3. Valid states are `offered`, `opened`, `returned`, `expired`, `revoked`, and
   `failed`. Main may present an `offered` Handoff only while the same Task is
   `waiting_user`. Completion, cancellation, expiry, or revocation prevents future
   opening.
4. The owner returns or aborts control through an authenticated, CSRF-protected Main
   action. That action appends a durable Task event and resumes the existing
   coordinator lineage where possible. Merely opening or closing a browser does not
   prove completion.

### Access and mediation

1. Discord receives a credential-free Main or Admin action URL. It never receives an
   Artifact bearer, Admin session, remote desktop password, Worker address, browser
   debugging URL, or provider credential.
2. Main resolves the current Handoff record at open time and applies its explicit
   exposure policy. Application authentication remains required where configured;
   VPN membership alone is not identity.
3. Handoffs have a finite lifetime, may be revoked immediately, and emit audit
   records for offer, open, return, expiry, revocation, and denied access.
4. Interactive content stays on the isolated Artifact origin defined by ADR-0009. A
   remote browser or desktop implementation is a separate gateway adapter behind
   Main, uses an authenticated Main-to-Worker channel, and reveals neither the raw
   Worker endpoint nor Admin authority to the remote session.
5. The remote gateway grants only the Task-scoped session and action class. It does
   not create general-purpose Device access, an NxN remote-control mesh, or a route
   around the Device-wide Computer Use lock.

### Credentials and retained authorization

1. The owner enters credentials only into the target service or OS surface. Agent
   prompts, Discord, Task events, Handoff records, diagnostics, and Artifacts do not
   receive the value.
2. A provider token or authenticated browser profile may remain only in the relevant
   Device Secret Store or provider-controlled credential home under Policy. Main
   receives at most a non-secret Capability or Secret reference.
3. The owner-visible request states the one action needed and what reply returns
   control. It does not promise that OpenDelegate can retain a token when the target
   service or owner Policy forbids it.

### Incremental implementation

The existing `Open interactive result` Discord label identifies an interactive
Artifact, not an Owner Handoff. No VNC-like or browser-session gateway is considered
implemented until the explicit record, Task-state coupling, return action, expiry,
revocation, audit, secret isolation, and cross-network proof above exist. This ADR
defines the compatible extension boundary for that work.

## Alternatives considered

### Treat every interactive Artifact as a Handoff

Rejected because dashboards and interactive reports do not require owner action.
Inference would attach unrelated content to `waiting_user` and could resume a Task
without a deliberate owner return.

### Post a Worker VNC or browser-debug URL in Discord

Rejected because it exposes topology and often carries ambient or bearer authority,
bypasses Main revocation and audit, and gives the Worker a public delivery role.

### Ask the owner to paste credentials into Discord

Rejected because Discord and Agent transcripts are not Secret Stores and credentials
would cross Device and model-context boundaries.

### Mark the Task resumed when the URL is opened

Rejected because opening a page does not prove that login, consent, or another
requested action completed.

## Consequences

- A Handoff is durable and resumable without becoming a second Task or a separate
  general-purpose chat.
- Main must add a small state machine and authenticated return endpoint before
  claiming the workflow complete.
- Remote browser and desktop providers remain replaceable adapters.
- Ordinary interactive Artifacts keep their existing result behavior and cannot
  accidentally gain owner-action authority.
- The fixed Main remains required and becomes the mediation and recovery point; this
  decision does not add Main failover.

## Verification

- Contract tests reject a Handoff inferred only from Artifact presentation metadata.
- Discord projection exposes an owner-action button only for an unexpired `offered`
  record on the same `waiting_user` Task and contains no bearer or Worker endpoint.
- Open, return, expiry, revocation, duplicate return, Task cancellation, Main
  restart, and Worker disconnect tests preserve one durable outcome.
- Artifact and gateway tests prove origin isolation, exposure authorization, audit,
  and enumeration resistance.
- A live cross-network flow lets the owner act through Main, returns the same Task,
  and shows no credential in Task state, logs, prompts, diagnostics, or Artifacts.

## References

- `CONTEXT.md`, invariants 1, 11, 12, 16, 24, and 25
- `docs/PRODUCT_SPEC.md`, FR-7, FR-12, FR-14, and FR-17
- `docs/DECISIONS.md`, D-059
- `docs/IMPLEMENTATION_PLAN.md`, Phases 7, 10, and 11
- [`ADR-0007`](0007-control-plane-http-contract.md)
- [`ADR-0009`](0009-artifact-origin-and-content-isolation.md)
- [`ADR-0012`](0012-computer-use-native-driver-authority-and-readiness.md)
