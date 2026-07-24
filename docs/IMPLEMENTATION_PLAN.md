# OpenDelegate Implementation Plan

Status: **Approved — implementation authorized 2026-07-24**

Target: **First complete cross-platform milestone**

Required platforms: **macOS, Windows, Linux**

Required graphical capability: **Computer Use on all three supported desktop
families**

## Purpose

This plan turns the product specification into an executable sequence of internal
phases. The phases are engineering checkpoints, not reduced product milestones. The
first milestone is not complete until every release gate in the product specification
passes.

Agents implementing this plan must preserve the domain terms and invariants in
`CONTEXT.md`. If a technical spike invalidates an implementation decision, record an
ADR and update the specification before proceeding.

## Delivery strategy

Build one end-to-end seam early and deepen it without replacing it:

`approved input → Task → coordinator → Work Order → Worker Run → report → Artifact`

The first version of this seam uses deterministic fake adapters. Every later phase
plugs a real boundary into the same seam. This prevents a collection of individually
working services from reaching the end without a working product.

### Rules for every phase

1. Keep the product runnable through the current end-to-end seam.
2. Add contract tests before adding a second implementation of an adapter.
3. Add observability and audit with the behavior, not in a later cleanup.
4. Keep schema migrations forward-testable from the first persisted schema.
5. Avoid provider or OS details in the domain layer.
6. Treat restart, duplicate delivery, cancellation, and partial failure as normal
   behavior.
7. Do not store credentials, private chain-of-thought, or Worker Knowledge in Main.
8. Do not declare an OS supported from compilation alone; run its acceptance suite.
9. Do not declare Computer Use supported from screenshot capture alone; prove
   controlled interaction, exclusive locking, cancellation, and permission failure.
10. Update the canonical documents when a product decision changes.

## Planned module boundaries

Names here describe responsibilities, not mandatory source-directory names.

### Domain

Pure entities, value objects, state transitions, domain events, policy inputs, lease
rules, scheduling eligibility, and artifact exposure precedence. It has no Discord,
SQL, HTTP, provider SDK, or OS service dependency.

### Protocol

Versioned schemas for Main–Worker messages, API requests, event envelopes, adapter
events, configuration patches, diagnostics, and Artifact metadata.

### Control Plane

Application services for enrollment, Device profiles, Task lifecycle, Work Orders,
Run dispatch, deterministic scheduling, native-session registry, approvals, audit,
Discord projection, Artifact metadata, and configuration.

### Worker Core

Device identity, discovery probes, transport client, durable outbox, Run supervision,
local resource locks, local Knowledge service, Secret injection, Agent Adapter host,
Artifact upload, and diagnostics.

### User Session Helper

Per-logged-in-user process for graphical-session discovery, Computer Use, screen
capture, and desktop-session locking. It is separate from the always-on service on
Windows, macOS, and graphical Linux.

### Agent Adapters

Codex, Claude, and generic-command implementations of one conformance contract.

### Channel Adapters

Discord Forum implementation behind a channel-neutral Task input and projection
contract.

### Admin Web

Owner-only Device, Task, Run, policy, approval, Artifact, audit, and configuration
interface with a Configuration Chat drawer.

### Storage

SQLite and PostgreSQL metadata implementations, local and S3-compatible Artifact
stores, OS Secret Stores, and Worker-local Knowledge indexes.

### Bootstrap and Service Management

Agent-facing init and join skills, deterministic CLI operations, release installation,
OS service registration, upgrade, diagnostics, and uninstall.

### Acceptance Harness

Fake adapters, network fault injection, deterministic clock and IDs, test desktop
fixture, provider smoke tests, three-OS service tests, and the canonical Task journey.

## Technical spikes

These spikes resolve implementation facts. They do not reopen settled product
requirements.

### Spike A — SQL portability and lease semantics

**Questions**

- Which TypeScript SQL and migration layer provides predictable SQLite and
  PostgreSQL transactions without two divergent domain implementations?
- How will SQLite serialize lease and outbox mutations under concurrent Worker
  traffic?
- Which PostgreSQL primitives are used without making SQLite behavior weaker?

**Required proof**

- The same Task transition, idempotent event ingestion, transactional outbox, Run
  claim, lock fencing, and migration suite passes against both databases.
- No Worker process has a database credential.

**Decision output**

An ADR selecting the library, transaction conventions, migration ownership, and
database support policy.

### Spike B — Release packaging and service supervision

**Questions**

- Will releases bundle a Node runtime, use platform packages, or require an installed
  active-LTS Node runtime managed by the bootstrap?
- How will upgrades preserve service paths and rollback after a failed health check?
- Which operations require administrator privilege on each OS?

**Required proof**

- Clean install, service start, restart, upgrade, failed-upgrade rollback,
  diagnostics, and uninstall on Windows, macOS, and Linux.
- The owner-facing path begins with the init skill and never requires a development
  start command.

**Preferred direction**

Ship reproducible platform release bundles with a pinned runtime rather than rely on
an arbitrary global Node installation. The skills call the same deterministic CLI
used by tests and support tooling.

### Spike C — Two-plane Device runtime

**Questions**

- What authenticated local IPC connects the always-on daemon and the user-session
  helper?
- How are multiple logged-in users represented on a personal Device?
- What proves that a desktop is present, unlocked, and permission-ready?

**Required proof**

- The always-on daemon remains healthy with no logged-in user.
- Computer Use appears and disappears as session readiness changes.
- A compromised unprivileged helper cannot acquire broader daemon authority than its
  declared capability.

### Spike D — Computer Use backend matrix

**Questions**

- Which supported agent or automation backend supplies screen observation and input
  on Windows, macOS, and Linux?
- What is the declared Linux desktop/backend combination for the first milestone?
- How are macOS Accessibility and Screen Recording, Windows interactive-session
  restrictions, Linux display-server permissions, locked sessions, and emergency
  stop handled?
- When should structured browser automation replace desktop control?

**Required proof**

- A deterministic graphical fixture application launches, receives clicks and text,
  changes visible state, and produces screenshot evidence on all three OS families.
- A second Computer Use Run waits for the first desktop-session lock.
- Cancellation stops input promptly.
- Missing OS permission and a locked or logged-out session produce a clear unavailable
  or waiting state, not random failure.
- Headless Linux continues to execute non-graphical Work Orders.

**Decision output**

One ADR per OS family documenting the backend, permissions, supported environments,
and known limitations.

### Spike E — Codex adapter

**Direction**

Use the supported TypeScript SDK for automation and a local App Server or
non-interactive CLI path as needed. Prefer local stdio for deep integration; do not
expose the experimental App Server WebSocket as an OpenDelegate network endpoint.

**Required proof**

- Detect and report installed version and auth readiness.
- Start a Task session and capture the native session ID.
- Stream normalized public messages, command or tool outcomes, approvals, and final
  state.
- Resume by ID in the same Device and working directory.
- Cancel a running turn.
- Convert provider approval requests into OpenDelegate Policy decisions.
- Survive process restart and create a checkpoint continuation after native-session
  loss.
- Pin tested provider versions and generate or validate matching schemas in CI.

### Spike F — Claude adapter

**Direction**

Use the Agent SDK as the primary path and headless CLI as fallback. Use supported
session APIs; never parse the internal transcript JSONL format.

**Required proof**

- Detect and report installed version and auth readiness.
- Start, stream, capture `session_id`, resume, fork when explicitly requested, and
  cancel.
- Preserve the exact working directory or worktree required by session resume.
- Enforce one active writer per native session while allowing independent parallel
  sessions.
- Route `canUseTool` and hook decisions through OpenDelegate Policy.
- Handle default provider transcript cleanup by continuing from an OpenDelegate
  checkpoint.
- Own safe cleanup of agent-created worktrees after verifying uncommitted, untracked,
  and unpushed work.

### Spike G — Discord Forum laboratory

**Required proof**

- Create and bind a Forum in a dedicated test server after checking the Community
  prerequisite.
- Ingest the paired thread/starter-message events idempotently despite ordering.
- Receive ordinary owner replies through Gateway with required intents.
- Reconcile missed messages and archived threads through HTTP.
- Apply exactly one workflow-status tag while respecting the 20-tag forum and
  five-tag post constraints.
- Post a normal starter message for system-created posts, then add a Components v2
  status panel.
- Complete approval interaction acknowledgment within Discord's deadline and finish
  asynchronously.
- Refresh expiring attachment references through message identity rather than persist
  signed CDN URLs.

### Spike H — Generated HTML isolation

**Required proof**

- Static HTML has scripts disabled and cannot read Admin Web origin data.
- Interactive mode runs on a separate origin and cannot access Admin cookies,
  local storage, service workers, or privileged APIs.
- Signed-link, authenticated, private-network, public, and custom modes have explicit
  precedence and audit.
- Malicious HTML, SVG, filename, archive, and path traversal fixtures remain
  contained.

### Spike I — Owner authentication

**Questions**

- Which local-first authentication mechanism provides strong owner login from a
  laptop or phone without making Discord the recovery authority?
- How are initial claim, passkeys or credentials, recovery codes, session revocation,
  CSRF, and optional reverse-proxy identity handled?

**Required proof**

- Initial owner claim is impossible away from the local Main bootstrap channel.
- Admin sessions remain authenticated on LAN, Tailscale, Omada, tunnel, and public
  routes.
- Discord outage does not prevent Admin recovery.
- Stolen browser state can be revoked, and recovery does not reveal Device Secrets.

## Phase 0 — Specification approval and repository foundation

### Objective

Turn the approved specification into an enforceable project baseline.

### Work

- Preserve the recorded owner approval of the primary test seam and canonical
  documents.
- Initialize Git and add the Apache-2.0 license.
- Establish the TypeScript monorepo, active-LTS runtime policy, package manager,
  formatter, linter, unit runner, browser runner, changelog policy, and CI skeleton.
- Create the module boundaries listed above without business behavior.
- Add architecture decision and threat-model templates.
- Add a documentation check ensuring required planning documents remain linked.
- Configure dependency and secret scanning.

### Exit gate

- Clean install and base checks work on macOS, Windows, and Linux CI.
- A no-op acceptance harness runs on all three.
- No production behavior exists that contradicts the approved specification.

## Phase 1 — Domain kernel and simulated vertical seam

### Objective

Prove the complete product flow in one process with deterministic fake boundaries.

### Work

- Implement identifiers, event envelopes, idempotency, clocks, and protocol versions.
- Implement Instance, Owner, Device Profile, Capability, Task, Work Order, Run,
  Agent Session, Workspace, Budget, Approval, Policy, Resource Lock, Artifact, and
  audit domain models.
- Implement Task, Work Order, Run, Device health, approval, and lock state machines.
- Implement deterministic scheduling filters and score explanations.
- Define the semantic planning request and response schemas used by Main Agent.
- Implement fake channel, Main Agent, Worker Agent, transport, Knowledge, Artifact,
  Secret, and Computer Use adapters.
- Drive one Task through intake, clarification, parallel dispatch, Worker reports,
  synthesis, review, completion, and Artifact presentation.
- Add deterministic restart and duplicate-event simulation.

### Exit gate

- The canonical Task journey passes entirely through public contracts.
- Invalid transitions, duplicate deliveries, expired or replaced Worker
  completions, stale fences, and policy bypass fail in tests.
- The simulator can replay a recorded event sequence to the same final state.

## Phase 2 — Persistence, Control Plane, and local API

### Objective

Make the simulated domain durable and observable on one Main.

### Work

- Complete Spike A and record the database ADR.
- Implement SQLite and PostgreSQL storage contracts.
- Add schema migration and compatibility checks.
- Implement append-only domain events plus transactional materialized state.
- Implement transactional outbox and inbox/idempotency records.
- Persist Resource Lock and Computer Use state in one monotonic generation and
  enforce latest-generation compare-and-set restore semantics.
- Persist idempotent acquire and renewal command outcomes so duplicate delivery
  cannot issue or extend authority twice.
- Implement the Control Plane API and local health endpoints.
- Implement owner identity, audit, structured logs, correlation IDs, and redaction.
- Complete Spike I and implement local owner claim, strong Admin authentication,
  recovery, browser-session revocation, and optional authentication-adapter seams.
- Implement the Policy Engine and normalized approval scopes.
- Implement Task and Autonomous-work budget enforcement.
- Implement local Artifact metadata and placeholder byte storage.
- Implement configuration scopes and effective-value resolution.
- Add backup/restore documentation for Main metadata without Worker Knowledge or
  Secrets.

### Exit gate

- The Phase 1 seam runs unchanged on SQLite and PostgreSQL.
- Forced Main restart at every significant state reconciles to a valid outcome.
- A coherent stale persistence generation is rejected while the latest generation
  restores, including after lease expiry during downtime.
- Schema migration tests pass from the first schema.
- Secret and Knowledge fields cannot be persisted through domain or API schemas.

## Phase 3 — Enrollment, Worker Core, and Transport

### Objective

Move execution onto authenticated remote Devices without adding real LLM providers.

### Work

- Implement single-use enrollment grants, local Device key generation, Main identity
  verification, rotation, revocation, and replay protection.
- Implement Worker configuration, local durable outbox, and supervised Run host.
- Implement versioned Main–Worker protocol over outbound secure connections.
- Implement heartbeat, health, backpressure, Work Order claim, lease, fencing,
  cancellation, and artifact-upload authorization.
- Implement Transport Profiles with ordered endpoints, probes, retry, and fallback.
- Add LAN and generic HTTPS/WSS transports; treat Omada and Tailscale as configured
  network paths rather than embedded dependencies.
- Add optional deterministic Tailscale diagnostic probes when the CLI is present.
- Implement sanitized diagnostic bundles and Agent escalation only after route
  exhaustion.
- Implement Device drain, disable, revoke, and offline behavior.

### Exit gate

- One Main coordinates three fake-agent Workers across macOS, Windows, and Linux.
- Each Worker uses an independent Device identity and may use a different route
  profile.
- Main never initiates SSH and Workers never receive database credentials.
- Route failover, disconnect buffering, replay, revocation, and Main restart pass.

## Phase 4 — Cross-platform service and user-session runtime

### Objective

Make Main and Worker roles truly persistent on all target operating systems.

### Work

- Complete Spikes B and C.
- Implement Windows SCM service plus per-user session helper.
- Implement macOS launchd daemon/service plus logged-in LaunchAgent helper.
- Implement Linux systemd system service plus graphical user service/helper where
  available.
- Provide a supervised foreground fallback for Linux without systemd.
- Implement authenticated local IPC between daemon and user-session helper.
- Report service, logged-in session, desktop unlocked state, and OS permissions
  separately.
- Implement install, start, stop, restart, upgrade, rollback, diagnostics, and
  uninstall operations.
- Build release bundles and smoke them on clean hosts.

### Exit gate

- Main and Worker roles install and survive expected restart behavior on all three
  OS families.
- The core daemon remains available while no user is logged in.
- User-session helper loss removes graphical Capabilities without dropping headless
  work.
- Failed upgrades roll back to a healthy version.

## Phase 5 — Device discovery, profile evolution, and resource control

### Objective

Give Main reliable knowledge of what every Device can do.

### Work

- Implement OS, hardware, executable, service, container, browser, GPU, and desktop
  probes with evidence and timestamps.
- Implement Device-local Workspace registration, aliases, path resolution,
  capabilities, and isolation metadata.
- Implement Capability states: detected, verification pending, verified, degraded,
  unavailable, and disabled.
- Add safe verification probes for agent runners and desktop readiness.
- Implement Device Profile patch proposals.
- Implement Main-controlled automatic Role and Instruction updates with audit and
  rollback.
- Implement Package and provisioning classifications.
- Implement local resource registry, capacities, leases, fencing, and
  `desktop-session`.
- Implement exclusive per-Device service ownership and a helper or Main-side
  monotonic desktop-authority watermark outside restorable application snapshots.
- Integrate adapter-reported worktree or sandbox isolation.
- Add Device load and capacity reporting.

### Exit gate

- Scheduling decisions explain every exclusion and selected capability.
- A Worker cannot directly persist its Role, Instructions, or relaxed Policy.
- Independent Agent Runs execute in parallel.
- Two Computer Use claims cannot hold the same desktop-session lock.
- A stale coherent Worker snapshot cannot reclaim desktop input authority.

## Phase 6 — Codex, Claude, and generic Agent Adapters

### Objective

Replace fake agents with resumable, observable first-class providers.

### Work

- Complete Spikes E and F.
- Finalize the common Agent Adapter contract.
- Implement Codex SDK adapter and CLI fallback.
- Implement Claude Agent SDK adapter and CLI fallback.
- Implement generic command adapter with explicit lifecycle and output schema.
- Add adapter version pinning, compatibility probes, capability degradation, and
  diagnostics.
- Map provider events into normalized public messages, tool/action requests, progress,
  usage, and completion.
- Route provider approval mechanisms through OpenDelegate Policy.
- Implement native-session registry with Device, provider, session ID, Workspace,
  working directory/worktree, adapter version, single-writer lease, and lineage.
- Implement Task checkpoint and native continuation packages.
- Add safe worktree lifecycle and garbage collection.

### Exit gate

- Both first-class providers start, stream, resume, cancel, request approval, and
  continue after Main process restart.
- Two unrelated Tasks never share a native session.
- Related Worker follow-up resumes the correct native session.
- Coordinator provider remains pinned while another provider participates as Worker.
- Simulated session deletion continues from checkpoint with an explicit lineage
  change.

## Phase 7 — Discord Forum control surface

### Objective

Make Discord the complete primary Task interface.

### Work

- Complete Spike G.
- Implement Discord Application configuration, token handling, required intent and
  permission verification, owner allowlist, and Forum binding.
- Implement Gateway session management, heartbeat, resume, and thread/message events.
- Implement HTTP reconciliation for missed messages and archived threads.
- Map Forum post to internal Task and make ingestion idempotent.
- Implement Task status projection with one workflow tag and a stable Components v2
  status panel.
- Implement concise progress, targeted questions, final result, file/media, and
  Artifact link presentation.
- Implement pause, resume, cancel, retry, approval, denial, and inspect interactions.
- Implement system incident and recommendation post creation.
- Handle archive, lock, reopen, delete, permission loss, rate limit, and reconnect.

### Exit gate

- The owner completes the canonical Task journey from desktop and mobile Discord.
- A second Forum post remains context-isolated.
- Main outage and Gateway reconnect reconcile without missing or duplicating work.
- Unauthorized messages never reach an Agent.
- A locked or deleted post degrades to Admin Web without losing Task state.

## Phase 8 — Admin Web and Configuration Agent

### Objective

Deliver the required visual setup, Device specification, and operational surface.

### Work

- Implement owner authentication and secure browser sessions.
- Implement first-run shell with one current Device and left-side Device navigation.
- Implement Device Facts, Capabilities, Roles, Instructions, Policies, routes, Agent
  Adapters, locks, health, load, and Runs.
- Implement Task, Work Order, Run, session lineage, event, approval, Artifact, error,
  and audit inspectors.
- Implement emergency Task creation, pause, cancel, retry, drain, revoke, and stale
  lock recovery controls.
- Implement structured configuration forms and effective-value explanations.
- Implement bottom-right Configuration Chat in a separate native Agent Session.
- Give the Configuration Agent typed inspect, propose, validate, diff, apply, and
  rollback tools.
- Implement onboarding guidance for database, Discord, Agent Adapters, service
  persistence, Admin auto-open, transports, Autonomy Profiles, Artifact exposure,
  and Device join.
- Add responsive layouts and keyboard accessibility.

### Exit gate

- A new owner completes setup through the init skill and Admin Web without reading
  source code.
- The required Device UI matches the product specification.
- A configuration change can be proposed conversationally, previewed, policy-checked,
  applied, audited, and rolled back.
- Discord outage still permits inspection and emergency control.

## Phase 9 — Local Markdown Knowledge

### Objective

Make every Device progressively better without creating shared context.

### Work

- Implement local Knowledge directory discovery and validation.
- Implement Markdown parsing, wiki-link extraction, full-text index, and rebuild.
- Implement bounded search, candidate previews, explicit open, and context budget.
- Integrate Work Order start retrieval and on-demand retrieval into Agent Adapters.
- Implement qualifying Knowledge create/update operations from the current Worker.
- Add admission checks for Device specificity, rediscovery cost, reuse likelihood,
  concision, and actionability.
- Exclude credentials, raw transcripts, raw logs, temporary Task state, and common
  facts.
- Report only local Knowledge service health to Main.
- Provide owner-readable diagnostics and rebuild on the local Device.

### Exit gate

- A Worker uses the correct linked Markdown to avoid repeated discovery.
- Retrieval stays within its configured context budget.
- A qualifying lesson becomes an ordinary linked Markdown update.
- Packet capture and Main database inspection prove no filenames, titles, snippets,
  graph, index, or content leave the Device.
- Deleting the Device's Knowledge proves that the system tolerates its intentional
  non-backed-up nature.

## Phase 10 — Artifact Gateway and rich results

### Objective

Turn Worker output into durable, useful, safely viewable results.

### Work

- Implement local Main Artifact Store and optional S3-compatible adapter.
- Implement resumable authenticated upload, checksum, provenance, retention, and
  cleanup.
- Implement presentation selection for Discord text, Components v2, media, files, and
  external reports.
- Implement Markdown, image, PDF, log bundle, patch, and static-site viewers.
- Complete Spike H.
- Implement viewer access profiles and Artifact exposure precedence.
- Implement private-network, authenticated, signed-link, public, and custom modes.
- Implement isolated static and interactive HTML origins.
- Add Artifact pin, revoke, expire, and audit.

### Exit gate

- An Artifact generated on an Omada-reachable Worker uploads to Main and opens from a
  Tailscale-reachable laptop without direct Worker access.
- Discord shows a useful native summary and Open Report button.
- Every exposure mode passes authorization and audit tests.
- Malicious generated content cannot cross the Artifact security boundary.

## Phase 11 — Computer Use

### Objective

Ship Computer Use as a real, schedulable, cross-platform Capability.

### Work

- Complete Spike D and the OS ADRs.
- Implement capability detection and permission-readiness probes for each OS.
- Implement the backend adapter contract for observe, act, capture, cancel, and
  emergency stop.
- Integrate with the user-session helper and desktop-session lock.
- Bind the desktop helper to the exclusive Device-service epoch and fail closed when
  its monotonic authority cannot verify the current persistence generation.
- Add structured browser automation preference for browser-only work.
- Build a deterministic graphical acceptance fixture available on all three OSes.
- Capture screenshots and an action summary as Task Artifacts.
- Implement locked, logged-out, permission-denied, helper-crashed, display-changed,
  and timeout behavior.
- Add an owner-visible active Computer Use indicator and kill control.

### Exit gate

- The reference interaction succeeds on macOS, Windows, and supported graphical
  Linux.
- Two Computer Use Runs serialize while unrelated agents remain parallel.
- Coherent rollback and cloned-service fixtures cannot create two input-capable
  controllers, even when each local snapshot is internally valid.
- Permission failure is actionable and does not trigger unsafe bypass attempts.
- Emergency stop prevents further input.
- A headless NAS-style Linux Device remains healthy and accurately lacks the
  capability.

## Phase 12 — Proactivity, diagnostics, and operational hardening

### Objective

Make the system useful over time, not only during a happy-path demo.

### Work

- Implement deterministic monitors for service, transport, database, Discord,
  provider, Artifact Store, lock, lease, and disk conditions.
- Implement Reactive, Assisted, and Autonomous behavior by category.
- Create system incident and recommendation Tasks.
- Implement diagnostics escalation packages and guided configuration repair.
- Add retention and cleanup jobs with dry-run and audit.
- Add provider usage and cost metrics where available.
- Implement owner export of a redacted support bundle.
- Add upgrade compatibility windows and rolling Worker upgrade behavior.
- Add rate limiting, circuit breakers, overload handling, and resource ceilings.

### Exit gate

- Normal monitoring uses no continuous LLM loop.
- Assisted mode automatically handles safe recovery and proposes non-incident
  improvements.
- Autonomous mode cannot exceed Action Policy.
- Fault injection produces useful incidents rather than silent degradation.

## Phase 13 — Full-system validation and first milestone release

### Objective

Prove the complete product on real target systems and publish it responsibly.

### Work

- Run every automated suite in the product specification.
- Run the real three-Device scenario with macOS, Windows, and Linux simultaneously.
- Run Main-role tests on each OS family, not only Worker-role tests.
- Run Codex and Claude live smoke tests with pinned versions.
- Run Computer Use real-desktop tests on all three supported graphical environments.
- Run headless Linux NAS tests.
- Test Omada-like routed private networking and Tailscale paths separately and
  together through configured Transport Profiles.
- Test private and externally exposed Artifact policies.
- Perform threat-model review and security regression.
- Perform upgrade from the earliest internal persisted schema and service bundle.
- Complete installation, onboarding, configuration, policy, transport, Discord,
  backup, recovery, troubleshooting, and contributor documentation.
- Add Apache-2.0 notices and third-party attribution.
- Tag only after all first-milestone acceptance criteria have evidence.

### Exit gate

Every item under **First Milestone Acceptance Criteria** in the product specification
has a linked automated result, recorded manual proof, or both. There are no waived
platform or Computer Use gates.

## Test infrastructure

### Continuous integration

Run on hosted macOS, Windows, and Linux runners:

- format, lint, type, dependency, and schema checks;
- domain, protocol, policy, and scheduler tests;
- SQLite and PostgreSQL integration tests;
- fake-adapter canonical journey;
- Admin Web browser tests;
- build and packaging smoke tests; and
- adapter fixture and compatibility tests.

### Self-hosted platform lab

Use owner-controlled machines or disposable test hosts for:

- service installation requiring privileged integration;
- reboot and login/logout behavior;
- macOS privacy permissions;
- Windows SCM and interactive-session helper behavior;
- Linux graphical-session and headless NAS behavior;
- real Tailscale and routed private-network tests;
- live Codex and Claude smoke tests; and
- Computer Use reference workflows.

### Discord laboratory

Maintain a private Community-enabled test server and Forum Channel. Tests must clean
up their own posts where safe but retain failed fixtures long enough for diagnosis.
Live tests use a dedicated bot and least-privilege permissions.

### Deterministic desktop fixture

Provide one cross-platform graphical test application with:

- a visible run identifier;
- text input;
- buttons and a selectable option;
- a deterministic success state;
- a generated local result file;
- no hidden keyboard shortcuts required; and
- accessibility labels where the OS exposes them.

The Computer Use agent must navigate it through observation and input, not a private
test API. A separate structured test verifies that the backend cannot acquire a
second desktop-session lock.

## Definition of Done for any work item

A work item is done only when:

- behavior matches the approved specification;
- externally visible contracts are documented;
- automated tests cover success, denial, restart, and relevant failure;
- logs and audit events are structured and redacted;
- configuration has a default, scope, precedence, and validation;
- migrations are included when persistence changes;
- macOS, Windows, and Linux impact is assessed;
- security and Secret boundaries are reviewed;
- Admin or Discord observability exists for operational behavior;
- no Draft decision is silently encoded as permanent architecture; and
- canonical documents are updated if behavior changed.

## Risk register

| Risk | Impact | Mitigation and proof |
| --- | --- | --- |
| Provider SDK or CLI behavior changes | Session loss or adapter breakage | Pin tested versions, capability probe, generated schemas where available, conformance suite, checkpoint continuation |
| Native session is local or expires | Lost context | Store Device/cwd/version lineage, single-writer lease, rolling Task checkpoint, continuation session |
| Discord Gateway misses or reorders events | Lost or duplicate commands | Internal IDs, idempotent ingestion, persisted cursor, HTTP reconciliation, archived-thread scan |
| Discord Forum UI limits state projection | Misleading dashboard | One status tag, compact status panel, database authoritative |
| Pairwise network complexity leaks into prompts | Token waste and brittle routing | Ordered Transport Profiles and deterministic resolver |
| Main outage stops orchestration | Expected availability gap | Explicit fixed-Main behavior, Worker outbox, restart reconciliation, no false failover promise |
| Generated HTML compromises Admin | Credential or owner-session theft | Separate origin, CSP, script-off default, malicious fixture suite |
| Automatic package installation is abused | Supply-chain compromise | Existing trusted sources only, protect repository addition/remote scripts/drivers, audit |
| Agent bypasses permission text | Unauthorized system change | Policy Engine and executor enforcement outside LLM, normalized approvals |
| Parallel agents modify same workspace | Corruption | Native worktrees/sandboxes, per-session single writer, optional workspace locks, artifacted diffs |
| Two Computer Use agents conflict | Uncontrolled desktop | Device-wide desktop-session lock and emergency stop |
| Coherent Worker rollback recreates an old controller | Duplicate desktop input under a repeated fence | Transactional generation CAS, exclusive Device service, external monotonic desktop-authority proof, stale-restore fixture |
| Service daemon cannot access desktop | Missing Computer Use | Separate user-session helper on every OS and explicit readiness |
| Linux desktop diversity | Unbounded compatibility | Declare and prove a supported first-milestone environment; adapters advertise exact backend constraints |
| Knowledge grows into context bloat | Higher cost and worse reasoning | Admission rules, bounded search/open budget, no global injection, local inspection |
| Knowledge accidentally syncs to Main | Violates core boundary | No protocol schema for content, packet-level negative test, no Main table |
| Secrets leak through diagnostics | Credential compromise | Device-local stores, narrow injection, redaction, adversarial log tests |
| SQLite and PostgreSQL semantics diverge | Deployment-specific bugs | Shared contract suite and early SQL spike |
| Artifact routes work only from one network | Unusable reports | Viewer access profiles, multiple base URLs, cross-network acceptance scenario |
| Remote Admin endpoint is claimed or hijacked | Full control-plane compromise | Local-only initial claim, independent strong auth, revocation, CSRF and session tests |
| Autonomous work loops or overspends | Resource and financial loss | Hierarchical finite budgets, hard-stop enforcement, owner-scoped extension |
| Native session resumes in the wrong directory | Wrong files changed or context corruption | Workspace registry, cwd binding, resume validation, checkpoint continuation |
| First milestone scope expands indefinitely | No usable release | Fixed acceptance list, internal phases, no new first-milestone feature without replacing an existing requirement |

## Dependency order

The critical path is:

1. Specification approval.
2. Domain and protocol contracts.
3. Persistence and simulated journey.
4. Enrollment, Worker protocol, and OS services.
5. Provider adapters and sessions.
6. Discord and Admin surfaces.
7. Knowledge and Artifacts.
8. Computer Use and platform helpers.
9. Full fault, policy, and release proof.

Work can proceed in parallel only after the contract it consumes is stable. In
particular:

- Discord, Admin Web, and agent adapters may develop in parallel after Task and
  approval schemas stabilize.
- OS service integrations may develop in parallel after the Worker lifecycle and IPC
  contracts stabilize.
- Computer Use backends may develop in parallel after the user-session helper and
  resource-lock contracts stabilize.
- SQLite and PostgreSQL implementations may develop in parallel against one storage
  contract.

## Explicitly deferred after the first milestone

- Main migration and high availability.
- Team and tenant models.
- Built-in relay or hosted control plane.
- Additional chat channels.
- Cross-Device Knowledge.
- Central Secret distribution or ephemeral credential broker.
- Native mobile applications.
- A public Artifact CDN.
- Fleet scale beyond personal-device assumptions.
- General workflow marketplace.

These are not architectural dead ends: adapter and domain seams should permit later
work, but no first-milestone code is justified solely by a deferred feature.
