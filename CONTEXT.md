# OpenDelegate Domain Context

Status: **Approved — 2026-07-24**

This is the compact recovery document for agents whose conversation context has been
compacted or lost. It is not a substitute for the full product specification.

## Product in one paragraph

OpenDelegate is a personal, self-hosted intent-to-outcome control plane that runs
continuously on one fixed Main Device. An approved owner states the desired outcome
primarily through a Discord Forum post; the owner does not choose a Device, operating
system, route, Agent provider, or multi-Device split unless that choice materially
changes the requested outcome. A Main Agent keeps one coordinator session per Task,
decomposes work, and launches configured Codex, Claude, or custom agent adapters on
eligible Devices. Deterministic software handles identity, health, routing, leases,
policy, retries, persistence, and presentation. Workers report observable progress
and artifacts to Main, which continues the Task and returns the outcome as a Discord
result, file, Artifact, hosted view, Git reference, or bounded Owner Handoff. Each
Device also owns a strictly local, Obsidian-style directory of linked Markdown
Knowledge files used only as selective context for agents running on that Device.

## Non-negotiable invariants

1. **One fixed Main.** The Main role does not move automatically or manually in the
   first release. There is no leader election or failover. If Main is offline, new
   orchestration pauses.
2. **Hub-and-spoke application topology.** Devices do not form an NxN SSH mesh.
   Worker connections are logically between one Device and Main.
3. **No direct Worker database access.** Only the Main Control Plane reads or writes
   the shared database. Workers use authenticated APIs and durable event delivery.
4. **Agent-agnostic orchestration.** Codex and Claude are first-class adapters, not
   hard-coded product identities. Generic adapters remain possible.
5. **Always-on execution.** A visible Codex or Claude window is not required. The
   daemon can start or resume configured agent runners in the background.
6. **One Forum post equals one Task.** Context from unrelated Forum posts never
   enters the Task unless the owner explicitly links an artifact or source.
7. **Sticky coordinator.** The Task's initially selected coordinator provider remains
   its coordinator. Other providers can join as Workers. Replacement happens only
   after failure or an explicit owner request.
8. **Native sessions are preferred but not canonical.** OpenDelegate resumes native
   Codex and Claude sessions while healthy. Durable Task events, summaries,
   decisions, and artifacts allow recovery or provider migration.
9. **Knowledge is Device-local Markdown.** Main and other Devices never receive its
   files, titles, index, or graph. There is no automatic backup, replication, or
   synchronization. Device loss may destroy Knowledge.
10. **Knowledge is selectively retrieved.** The complete Knowledge directory is
    never injected into context. Search finds a small candidate set, and the local
    Worker opens only what it needs.
11. **Secrets remain local.** Main keeps only Main secrets; each Worker keeps its own
    agent and service credentials. Secret values are neither copied between Devices
    nor placed in LLM context.
12. **Policy is enforced in code.** An LLM may propose an action but cannot bypass
    the executable policy decision made immediately before the action.
13. **Safe clear work starts automatically.** `Auto` is the default Task mode.
    Ambiguity, unavailable authority, or a protected action causes a pause.
    Computer Use input requires an exact Task-scoped owner grant or configured
    Policy grant; observation-only evidence is classified separately.
14. **Parallel agents are allowed.** General Worker Runs may execute concurrently.
    Resource locks, not a blanket one-run limit, prevent conflicts. Computer Use
    holds a Device-wide desktop-session lock.
15. **Discord is the primary work surface.** Admin Web is for setup, observability,
    approval, and emergency control, not a second full chat product.
16. **Artifacts are first-class.** Native Discord presentation is preferred; rich or
    long results are served through an Artifact Gateway with configurable exposure.
17. **Personal-first.** One owner and one trust domain per instance. Multi-tenancy is
    out of scope.
18. **No built-in network overlay or relay in the first release.** LAN, Omada,
    Tailscale, Headscale, tunnels, or custom networking may be configured through
    transport profiles.
19. **The first milestone is cross-platform.** It is not complete until the agreed
    end-to-end behavior works across macOS, Windows, and Linux and Computer Use works
    on supported graphical sessions.
20. **English is the default.** Repository content, domain terms, APIs, logs, and UI
    defaults are English. Owner-facing Admin Web chrome and README documentation may
    provide explicit, persisted translations without translating owner-authored Task
    content, Agent conversation history, protocol values, or durable state.
21. **Desktop control is a separate runtime plane.** The always-on daemon does not
    impersonate a logged-in desktop. A per-user session helper advertises and owns
    Computer Use readiness.
22. **One writer per native session.** Independent native sessions may run in
    parallel, but one Codex or Claude session cannot receive concurrent turns.
23. **Automatic work is bounded.** Auto and Autonomous modes still obey configurable
    time, retry, Work Order, token, and cost budgets.
24. **The owner specifies outcomes, not placement.** Main infers capability and OS
    requirements, may decompose one Task across heterogeneous Devices, and leaves
    actual placement and route selection to deterministic eligibility and scheduling.
    Placement remains observable in Admin and audit, but is not routine Task input.
25. **Human intervention is bounded and resumable.** Login, MFA, CAPTCHA, legal
    confirmation, OS permission, or another irreducibly human step pauses the same
    Task and uses a Main-mediated Owner Handoff when available. Handoff access is
    authenticated or explicitly exposed, time-bounded, revocable, and audited. Raw
    Worker desktop endpoints and credentials are never placed in Discord or Agent
    context by default.

## Core domain terms

### Instance

One personal OpenDelegate installation owned by one person. It contains one Main
Device and zero or more Worker-capable Devices.

### Owner

The person authorized to configure the Instance, enroll or revoke Devices, approve
protected actions, and bind Discord identities. Additional Discord identities may be
allowlisted, but they do not create separate tenants.

### Main Device

The fixed computer that runs the Control Plane, scheduler, Discord adapter, Admin
Web, Artifact Gateway, Main Agent adapter, and database access layer.

### Device

An enrolled macOS, Windows, or Linux computer running an OpenDelegate daemon. Main is
also a Device and may execute work.

### Device Profile

The durable specification Main uses when considering a Device. It has distinct
sections:

- **Facts** — observed OS, hardware, installed software, and environment facts.
- **Capabilities** — verified actions the Device can perform.
- **Roles** — semantic scheduling preferences.
- **Instructions** — persistent guidance for agents working on the Device.
- **Policies** — machine-enforced action permissions.
- **Runtime Status** — health, load, active Runs, locks, and connection state.

Workers may update observations and propose Role or Instruction changes. Main may
accept and persist those changes autonomously with an audit record. Workers cannot
change their own durable semantic profile directly. Policy relaxation requires the
Owner.

### Capability

A verified, machine-readable ability such as `codex`, `claude-code`,
`computer-use`, `browser-automation`, `docker`, `gpu-compute`, or
`artifact-rendering`. Capabilities include evidence, health, version, constraints,
and resource requirements.

### Transport Profile

An ordered set of ways a Device can maintain its logical connection to Main. Entries
can represent LAN, Omada VPN, Tailscale, HTTPS tunnel, or a custom transport. Normal
selection, probing, retry, and fallback are deterministic and consume no LLM
context.

### Task

The durable unit of user intent. A Discord Forum post maps one-to-one to a Task.
Tasks own conversation events, coordinator state, decisions, Work Orders, Runs,
artifacts, approvals, and summaries.

### Coordinator Session

The Task-specific native session used by the Main Agent. It is pinned to the
initially chosen provider and resumed across Forum replies and Worker reports.

### Work Order

A scoped assignment created by Main for one outcome. Work Orders contain an explicit
brief, completion criteria, selected inputs, constraints, and eligible capability
requirements. They may also require one Agent provider, an exact adapter, and a
bounded compatibility set; Main pins that requirement into every resulting Run. A
Task may have many Work Orders.

### Workspace

A Device-local registered execution root such as a Git repository, worktree-capable
project, file collection, or mounted storage location. Main schedules against a
stable Workspace reference and metadata; the Worker resolves it to the local path and
owns isolation.

### Worker Run

One execution attempt of a Work Order on one Device through one Agent Adapter. A
retry is a new Run. A related follow-up may resume that Device and adapter's existing
Worker Session.

### Agent Adapter

The integration boundary for detecting, starting, resuming, steering, cancelling,
and observing an agent runner. First-class adapters target Codex and Claude; a
generic command adapter supports extension.

### Resource Lock

A deterministic concurrency lease for a scarce or exclusive Device resource.
`desktop-session` has capacity one and is required by Computer Use.

### Knowledge

A Device-local directory of ordinary Markdown files connected by wiki-style
references. Markdown is canonical; full-text, link-graph, or vector indexes are
disposable derived data. Knowledge contains expensive-to-rediscover, repeatedly
useful, Device-specific operational memory.

### Artifact

A durable Task result such as Markdown, an image, a PDF, a log bundle, a patch, or a
static HTML report. Artifact metadata lives in Main's database; bytes live in a
configured artifact store.

### Owner Handoff

A Task-scoped pause in which the owner performs an irreducibly human action through a
Main-mediated interactive Artifact or configured session gateway, then replies in
the same Task so the existing coordinator can continue. It is not a raw Worker VNC
address, a credential-sharing channel, or a new Task.

### Exposure Policy

The rule that determines how an Artifact can be opened:
`private-network`, `authenticated`, `signed-link`, `public`, or `custom`.

### Policy Engine

The deterministic gate that decides whether a requested action is allowed,
requires approval, or is denied. It runs outside the LLM and records its decision.

### Autonomy Profile

Per-instance and per-category proactive behavior:

- `Reactive` — respond to requests and incidents only.
- `Assisted` — recover incidents automatically and propose improvements.
- `Autonomous` — create and execute permitted improvement work.

The default is `Assisted`.

## Canonical flow

1. The Owner creates or replies to a post in an approved Discord Forum.
2. The Discord Adapter persists the message as an idempotent Task event.
3. Main resumes the Task's Coordinator Session.
4. Main asks for clarification only when intent or completion criteria are
   materially ambiguous.
5. The scheduler deterministically filters offline, incapable, unauthorized, locked,
   or unreachable Devices.
6. Main makes only the remaining semantic allocation or decomposition decisions.
7. The selected Worker claims a Work Order through an authenticated, leased channel.
8. The Worker resolves any Workspace reference, retrieves a small amount of relevant
   local Knowledge, then starts or resumes its native Agent Session.
9. The Worker streams observable status and produces artifacts. Hidden reasoning is
   neither required nor persisted.
10. Main incorporates the report into the Coordinator Session and decides whether to
    finish, request review, clarify, retry, or create more Work Orders.
11. Discord shows a concise native result and controls. Rich output is opened through
    the Artifact Gateway.

## Failure rules

- A disconnected Worker continues an already-running safe Run when possible and
  stores outbound events in a local durable outbox.
- Main does not assign new work to an offline Device.
- Duplicate messages, Run events, and retries are safe through idempotency keys.
- Resource Lock snapshots retain completed acquire-command outcomes, idempotent
  renewal-command outcomes, complete lease-renewal chains, live leases, and fencing
  counters. Incomplete, clock-regressing, or provably over-capacity histories cannot
  be restored, and every active lease must exactly match its latest durable
  acquire-or-renew outcome.
- Snapshot validation does not provide its own anti-rollback root. Production may
  restore only the latest transactionally committed generation, while one exclusive
  Device service and a monotonic authority outside the restored snapshot prevent a
  coherent stale copy from creating a second desktop controller. The current
  in-memory seam does not yet prove this requirement.
- A Worker completion must echo its full Run, lease, and fencing identity; Main
  rejects it when the durable assignment was replaced or its lease expired at the
  monotonic journal acceptance instant, and replay preserves that original time.
- Main durably retires a current Run that is expired or no longer executable on its
  assigned Worker or route before a later retry may create a higher-fenced Run.
  Malformed or incorrectly scoped assignment state fails closed instead of being
  silently replaced.
- Route failure triggers deterministic probing and fallback first.
- Exhausted deterministic recovery creates a diagnostic bundle for Agent analysis.
- Main outage pauses new orchestration. Workers buffer results until Main returns.
- No Main failover or split-brain prevention protocol is required in the first
  release because Main is fixed.

## Read next

For full requirements and architecture, read `docs/PRODUCT_SPEC.md`. For sequencing
and release proof, read `docs/IMPLEMENTATION_PLAN.md`. For the rationale behind
these invariants, read `docs/DECISIONS.md`.
