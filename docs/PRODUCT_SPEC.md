# OpenDelegate Product and Architecture Specification

Status: **Approved — 2026-07-24**

Intended license: **Apache License 2.0**

Default product and repository language: **English**

Last updated: **2026-07-28**

## Document contract

This document is the canonical product specification for the first OpenDelegate
milestone. It captures the product interview and converts it into behavior that can
be implemented and tested without relying on the original conversation.

The implementation must not silently weaken a requirement to make an early demo
easier. Internal checkpoints may be narrower, but the first milestone is accepted
only when the complete release gate in this document and the implementation plan is
satisfied.

`CONTEXT.md` is the compact recovery summary. `docs/DECISIONS.md` records rationale.
`docs/IMPLEMENTATION_PLAN.md` defines delivery order and proof. If these documents
appear to conflict, this specification owns user-visible behavior and an ADR must
resolve the conflict before implementation continues.

## Problem Statement

A single person may own several computers with materially different operating
systems, hardware, installed tools, network reachability, and useful capabilities.
Today, AI agent sessions on those computers are isolated. The user has to remember
which machine can do what, manually reach it, open the right agent, restate context,
coordinate parallel work, collect results, and recover from failures. Moving between
a phone, laptop, and desktop fragments the conversation further.

Existing agent products can reason and use tools, but they do not provide a durable,
personal control plane across all of the owner's Devices. A naïve solution based on
pairwise SSH and shared database credentials creates an unsafe NxN trust mesh. A
solution that asks an LLM to remember every IP address, route, health state, retry
rule, and permission wastes context and behaves unpredictably. A central shared
memory also leaks Device-specific operational detail into unrelated Tasks.

The owner needs one system where they describe the result and do not have to care
which physical computer, operating system, route, or agent performs each step. That
system must:

- receives work from an interface available on a phone or laptop;
- preserves a separate durable context for every Task;
- decides which capable Device and agent should perform each part;
- starts those agents in the background;
- coordinates parallel work and follow-up work;
- presents useful results without being confined to plain chat;
- stores operational state centrally without giving every Worker database access;
- keeps Device-specific long-term memory local and context-efficient;
- uses deterministic software for networking, health, leases, policy, and retries;
- invokes LLM reasoning only where semantic judgment or diagnosis is valuable; and
- remains open, self-hostable, extensible, and understandable.

## Solution

OpenDelegate is a personal, self-hosted, agent-agnostic orchestration control plane.
One fixed Main Device runs the durable coordination services. Every enrolled Device,
including Main, runs a daemon that discovers local capabilities, maintains an
authenticated logical connection with Main, launches configured agent adapters, and
reports observable work.

Discord Forum Channels are the primary Task surface. A Forum post is one Task and one
context boundary. Replies continue the Task. The Forum list becomes a familiar
dashboard through status tags and concise status cards. The Main Agent retains a
provider-native Coordinator Session for the Task, decomposes work, and creates
Work Orders. Workers use their own Task-specific native sessions and may execute in
parallel. The database and event log make the Task recoverable when a native session
cannot be resumed.

The Admin Web application handles onboarding, configuration, Device profiles,
connections, policies, approvals, audit, Task inspection, and emergency controls. A
configuration-focused chat assistant helps the owner progressively configure the
system, proposes settings based on detected facts, and applies structured changes
through the same Policy Engine used by every other actor.

Long, visual, or interactive results become Artifacts. OpenDelegate uses
Discord-native components, images, and files where they fit and serves Markdown,
PDF, images, logs, static HTML, or an isolated interactive view through a Main-hosted
Artifact Gateway. When login, MFA, CAPTCHA, legal confirmation, or an OS permission
requires a human, the same Task may pause with a bounded Owner Handoff and continue
after the owner returns control.

### Product promise

The owner can tell OpenDelegate the desired outcome from Discord on a phone or
computer, then disconnect that client. A fixed always-on Main chooses eligible
resources, hides routine Device, OS, route, and multi-Device placement decisions,
continues native agent sessions, coordinates work, preserves Task context, and
returns a useful result as a Discord response, file, Artifact, hosted view, or Git
reference. If a step truly requires the owner, OpenDelegate asks for that one action
through a secure handoff and resumes the same Task afterward.

### Design principles

1. **Deterministic mechanics, semantic agents.** Code owns identity, policy, state
   transitions, leases, routing, retries, indexing, and rendering. Agents own
   decomposition, semantic scheduling choices, diagnosis, and work.
2. **Explicit trust boundaries.** Network location does not grant application trust.
   Device identity and action policy apply on LAN and private VPNs too.
3. **Durable outside, selective inside.** Task history is recoverable, but only
   bounded relevant context is sent to an agent turn.
4. **Local knowledge stays local.** Device-specific memory helps the local Worker and
   does not become global context.
5. **Native capability before reinvention.** Reuse agent-native sessions, worktrees,
   sandboxes, and SDKs behind adapters.
6. **Observable automation.** Every meaningful state change, policy decision,
   assignment, failure, and external side effect is attributable and inspectable.
7. **Safe defaults without artificial lock-in.** Defaults are private and cautious,
   but an informed owner may configure more permissive behavior.
8. **Personal-first simplicity.** Solve one owner's multi-Device workflow before
   introducing organizations, tenants, billing, or shared ownership.
9. **Outcome over placement.** The Task states what success means. OpenDelegate
   exposes actual placement for observability but does not make the owner plan the
   Device, OS, route, provider, or cross-Device workflow.
10. **Humans only where necessary.** Automation pauses for irreducible identity,
    consent, legal, or OS-security boundaries and resumes from the same durable Task
    after a bounded Owner Handoff.

## Actors

- **Owner** — configures the Instance, binds Discord, enrolls Devices, approves
  protected actions, and consumes results.
- **Main Agent** — the semantic coordinator running on Main through a configured
  Agent Adapter.
- **Worker Agent** — an agent runner executing one Work Order on one Device.
- **Control Plane** — deterministic Main services that own APIs, persistence,
  scheduling mechanics, policy, Discord synchronization, and artifacts.
- **Worker Daemon** — deterministic Device service that owns local discovery,
  execution, resource locks, Knowledge retrieval, Secret injection, and event
  delivery.
- **Configuration Agent** — a separate persistent agent session scoped to explaining
  and changing OpenDelegate configuration.
- **Discord Adapter** — maps approved Forum activity and interactions to Task events
  and projects canonical state back to Discord.
- **External provider** — Codex, Claude, a custom runner, a VPN, an object store, or
  another adapter-owned service.

## User Stories

1. As an owner, I want to start setup by invoking an agent skill, so that I do not
   need to understand development commands or manually assemble services.
2. As an owner, I want setup to detect the current operating system and installed
   agent tools, so that configuration starts from facts instead of a questionnaire.
3. As an owner, I want the setup agent to explain each consequential choice, so that
   I can configure a complex system conversationally.
4. As an owner, I want setup to offer an embedded local database or accept an
   external database URI, so that I can choose low friction or external durability.
5. As an owner, I want setup to ask whether the Main service starts at login or boot,
   so that background orchestration matches my operating habits.
6. As an owner, I want setup to ask whether Admin Web opens automatically, so that I
   can choose convenience without being forced to keep a browser window open.
7. As an owner, I want the first Admin Web view to show only the current Device, so
   that the initial state is clear rather than full of placeholders.
8. As an owner, I want a one-time enrollment flow for additional Devices, so that I
   can add machines without exchanging permanent credentials manually.
9. As an owner, I want to complete setup on a headless Linux NAS, so that a graphical
   desktop is not required for Worker participation.
10. As an owner, I want all default terminology and documentation in English, with
    optional Korean, Japanese, French, Spanish, and Simplified Chinese translations
    for the README and owner-facing Admin Web chrome, so that the repository remains
    broadly accessible without forcing one language on personal operation.
11. As an owner, I want to give every Device a memorable name, so that assignments
    and reports are understandable.
12. As an owner, I want to see each Device's OS and observed hardware, so that I can
    verify discovery.
13. As an owner, I want installed Codex, Claude, browser, container, GPU, and desktop
    tooling to become evidence-backed Capabilities, so that scheduling does not rely
    on vague claims.
14. As an owner, I want the system to distinguish Facts, Capabilities, Roles,
    Instructions, Policies, and Runtime Status, so that guidance and enforcement are
    not mixed together.
15. As an owner, I want the Main Agent to recommend useful Roles from detected
    capabilities, so that a Device becomes useful without exhaustive manual setup.
16. As an owner, I want a Worker to propose durable profile improvements after it
    learns something, so that Device specifications improve through use.
17. As an owner, I want Main to accept sensible Role and Instruction updates
    autonomously, so that routine profile maintenance does not interrupt me.
18. As an owner, I want every semantic profile change to be visible and reversible,
    so that bad inferred guidance is not permanent.
19. As an owner, I want only myself to relax an enforced Policy, so that a Worker
    cannot grant itself more authority.
20. As an owner, I want Device health, current load, active Runs, and exclusive locks
    to be visible, so that I understand why scheduling decisions were made.
21. As an owner, I want a Device to be drained or disabled without deleting it, so
    that I can perform maintenance safely.
22. As an owner, I want to revoke a lost Device, so that its identity can no longer
    connect or receive work.
23. As an owner, I want connectivity to be described separately for every Device, so
    that a laptop may use Tailscale while another computer uses Omada VPN.
24. As an owner, I want transport selection and fallback to happen without an LLM,
    so that routine networking consumes no tokens and remains predictable.
25. As an owner, I want a Discord Forum post to create exactly one Task, so that the
    Forum list is a work dashboard.
26. As an owner, I want replies in that post to resume the same Task, so that follow-
    up instructions retain context.
27. As an owner, I want a new Forum post to start with clean context, so that an
    unrelated Task cannot contaminate it.
28. As an owner, I want clear and safe Tasks to start automatically, so that I do not
    approve a plan for routine work.
29. As an owner, I want the Main Agent to ask a targeted question when the objective
    or completion criteria are materially ambiguous, so that it does not guess an
    important product decision.
30. As an owner, I want Discord tags to show a compact Task state, so that I can scan
    work without opening every post.
31. As an owner, I want a stable status card rather than a flood of progress
    messages, so that Task conversations remain readable.
32. As an owner, I want significant progress and failures reported in the Task, so
    that I can follow work from a phone.
33. As an owner, I want to pause, cancel, retry, and approve from Discord controls,
    so that common operations do not require Admin Web.
34. As an owner, I want a completed Forum post to be resumable later, so that a
    follow-up does not become a contextless new job.
35. As an owner, I want Discord messages created while Main is offline to be
    reconciled after restart, so that commands are not silently lost.
36. As an owner, I want a deleted or inaccessible Discord thread to leave its Task
    record available in Admin Web, so that Discord is not the only copy.
37. As an owner, I want only allowlisted Discord identities or roles to create work,
    so that other server members cannot execute commands on my computers.
38. As an owner, I want system incidents to appear as dedicated Forum posts, so that
    operational failures are handled in the same familiar interface.
39. As an owner, I want recommendations to appear separately from requested work, so
    that optional improvements do not obscure active Tasks.
40. As an owner, I want proactive behavior configurable by category, so that the
    system matches my tolerance for autonomy.
41. As an owner, I want the default proactive mode to fix safe incidents and propose
    general improvements, so that the system helps without inventing expensive work.
42. As an owner, I want emergency Task creation from Admin Web when Discord is
    unavailable, so that Discord failure cannot make the system uncontrollable.
43. As an owner, I want Main to filter ineligible Devices deterministically, so that
    an LLM never assigns work to an offline, incapable, or unauthorized Device.
44. As an owner, I want Main to use semantic judgment among eligible Devices, so that
    Roles and task meaning influence assignments.
45. As an owner, I want one Task to use several Devices, so that research, coding,
    testing, rendering, and Computer Use can proceed in parallel.
46. As an owner, I want Main to replace a failed Worker without losing the parent
    Task, so that a Device failure does not erase the objective.
47. As an owner, I want Work Orders to contain explicit completion criteria, so that
    Workers return actionable results rather than vague updates.
48. As an owner, I want general agents to run concurrently on a powerful Device, so
    that artificial serialization does not waste hardware.
49. As an owner, I want Computer Use limited to one active Run per Device desktop,
    so that two agents cannot fight over the pointer and keyboard.
50. As an owner, I want agent-native worktrees and sandboxes reused, so that parallel
    code work stays isolated without duplicating mature functionality.
51. As an owner, I want a Task's Coordinator Agent to keep its native session, so
    that follow-up turns preserve provider context and cache value.
52. As an owner, I want a related Worker follow-up to resume that Worker's native
    session, so that it does not repeat discovery.
53. As an owner, I want session checkpoints when a native context becomes unhealthy
    or full, so that OpenDelegate can continue in a new session.
54. As an owner, I want Codex and Claude to participate in the same Task without
    silently replacing the coordinator, so that I gain specialization without losing
    continuity.
55. As an owner, I want every Device to maintain linked local Markdown Knowledge, so
    that its agents remember expensive Device-specific lessons.
56. As an owner, I want Knowledge files editable with ordinary Markdown or Obsidian,
    so that the memory is transparent and portable within the Device.
57. As an owner, I want a derived index to find relevant Knowledge quickly, so that
    agents do not repeatedly search the entire Device or re-learn procedures.
58. As an owner, I want only a small relevant set of Knowledge opened for a Task, so
    that memory does not consume the context window by default.
59. As an owner, I want Workers to record high-value Knowledge automatically, so that
    repeated work becomes more efficient without a separate remember command.
60. As an owner, I want raw transcripts, logs, and easy-to-rediscover facts excluded
    from Knowledge, so that it remains concise.
61. As an owner, I want Main and other Devices unable to browse local Knowledge, so
    that Device-specific memory does not become shared orchestration context.
62. As an owner, I want concise results rendered directly in Discord, so that I can
    consume common outcomes on a phone.
63. As an owner, I want images, screenshots, files, and structured controls presented
    using Discord-native UI, so that results feel integrated.
64. As an owner, I want long reports and prototypes available through an Open Report
    link, so that Discord's layout limits do not constrain useful output.
65. As an owner, I want artifacts generated on any Worker uploaded to Main, so that I
    do not need direct browser access to every Device.
66. As an owner, I want an Omada-connected Worker result viewable from a
    Tailscale-connected laptop through Main, so that the application bridges results
    without bridging the two private networks at the packet layer.
67. As an owner, I want report exposure configurable as private, authenticated,
    signed, public, or custom, so that I can choose convenience and risk.
68. As an owner, I want generated HTML isolated from the Admin application, so that
    an agent-created report cannot inherit Admin privileges.
69. As an owner, I want credentials stored on the Device that uses them, so that one
    compromised Worker does not expose all credentials.
70. As an owner, I want agents to know that a credential-backed Capability is
    available without reading the credential, so that routing works without secret
    leakage.
71. As an owner, I want protected actions intercepted by deterministic policy, so
    that prompt injection cannot bypass my rules.
72. As an owner, I want safe observations, retries, and OpenDelegate service recovery
    to happen automatically, so that routine incidents do not interrupt me.
73. As an owner, I want OS networking, VPN, and firewall changes to request approval,
    so that connectivity repair cannot unexpectedly reconfigure my environment.
74. As an owner, I want normal project dependencies and official package-manager
    packages install automatically, so that Workers can acquire ordinary tools.
75. As an owner, I want new package repositories, remote installer scripts, drivers,
    and kernel extensions to request approval, so that automatic installation has a
    clear supply-chain boundary.
76. As an owner, I want approval choices scoped to once, Task, Device, or durable
    Policy, so that repeated safe work can become less interactive.
77. As an owner, I want an audit trail for actions, assignments, approvals, profile
    changes, and failures, so that automation remains explainable.
78. As an owner, I want a disconnected Worker to buffer progress and results, so that
    a temporary route failure does not discard completed work.
79. As an owner, I want deterministic retries exhausted before an Agent diagnoses
    connectivity, so that LLM involvement is reserved for difficult failures.
80. As an owner, I want a failed diagnosis to produce a clear question and evidence,
    so that I can help without reconstructing the incident.
81. As an owner, I want the Main Device to remain the only coordinator, so that I do
    not risk two Agents assigning conflicting work.
82. As an owner, I want local and external database options to preserve identical
    behavior, so that deployment choice does not change product semantics.
83. As an owner, I want Codex and Claude adapters to use their supported programmatic
    session interfaces, so that automation does not depend on brittle UI control.
84. As an owner, I want a generic Agent Adapter contract, so that another runner can
    be added without changing the Task model.
85. As an owner, I want a generic Transport Adapter contract, so that a future
    network method can be configured without teaching the LLM new routing commands.
86. As an owner, I want Admin Web to expose configuration and operational truth, so
    that I can recover even if the conversational layer is confused.
87. As an owner, I want the first milestone proven on macOS, Windows, and Linux, so
    that the repository starts as the multi-platform product it claims to be.
88. As an owner, I want Computer Use proven on supported graphical environments in
    that first milestone, so that it is a real Capability rather than roadmap text.
89. As an owner, I want repositories and storage roots registered as stable
    Workspaces, so that Main can assign work without reasoning about local paths.
90. As an owner, I want native Agent Sessions bound to their Device and Workspace, so
    that resume uses the correct files and worktree.
91. As an owner, I want only one active writer per native Agent Session, so that
    concurrent turns cannot interleave one transcript.
92. As an owner, I want automatic work bounded by time, retries, Work Orders, and
    provider usage, so that a mistake cannot consume resources indefinitely.
93. As an owner, I want to extend a Task budget explicitly, so that valuable long
    work can continue without disabling global safety.
94. As an owner, I want Admin Web authentication independent of Discord, so that I
    can recover the system during a Discord outage.
95. As an owner, I want the initial Admin owner claim restricted to the Main machine,
    so that an unclaimed public endpoint cannot be taken over remotely.
96. As an owner, I want OpenDelegate upgrades verified and recoverable, so that an
    automatic service update cannot strand every Device.
97. As an owner, I want to describe only the result in Discord, so that I do not have
    to choose a Device, operating system, route, or Agent provider.
98. As an owner, I want one Task to span Windows development, macOS build or signing,
    and Linux deployment when needed, so that I do not have to coordinate the
    handoffs myself.
99. As an owner, I want the result delivered in the most useful form—Discord, file,
    Artifact, hosted view, or Git reference—so that chat is not an output-format
    limitation.
100. As an owner, I want a secure, temporary handoff when login, MFA, CAPTCHA, legal
     confirmation, or OS permission requires me, so that I can act and let the same
     Task continue without sending credentials through chat.
101. As an owner, I want an offline Worker Device to show whether magic-packet wake
     is enabled and whether OpenDelegate has a usable wake path, so that I can tell
     whether the Device can be brought back without physically visiting it.

## Functional Requirements

### FR-1 — Agent-first bootstrap

1. The documented owner workflow begins inside a supported Codex or Claude
   environment by invoking the OpenDelegate initialization skill.
2. The skill may call a deterministic bootstrap CLI internally. The owner is not
   required to run a development command such as `npm run start`.
3. The bootstrap detects OS, architecture, service-manager availability, installed
   agent runners, browser availability, likely GUI capability, and existing
   OpenDelegate state.
4. Bootstrap creates one personal Instance and makes the current Device its fixed
   Main Device.
5. Bootstrap installs and starts the appropriate background service with explicit
   owner consent for persistence at login or boot.
6. Bootstrap asks whether Admin Web should open automatically and records the choice.
7. Bootstrap offers embedded local storage or validates a supplied external database
   URI without exposing it to an LLM transcript.
8. Bootstrap guides Discord Application, bot, Community Server, Forum Channel, and
   owner-identity binding.
9. Bootstrap configures an initial Main Agent Adapter and verifies that it can start,
   return structured status, and resume a session.
10. Every bootstrap step is resumable and idempotent. A failed step must not require
    deleting the Instance and starting over.
11. The repository and release documentation supports an owner giving the repository
    URL or verified bundle to a capable local Agent and asking it to install
    OpenDelegate. The Agent discovers the init skill and explains only choices that
    affect owner intent.
12. The init and join skills give separate, complete Main and Worker procedures so
    the owner does not need to translate a control-plane topology into manual
    commands.

### FR-2 — Device enrollment and identity

1. Admin Web generates a single-use, short-lived enrollment grant.
2. The owner invokes the join skill on the target Device and supplies or opens the
   enrollment grant.
3. The target generates its Device key material locally.
4. Main records a revocable Device identity and returns only credentials scoped to
   that Device.
5. Enrollment verifies the expected Main identity to resist accidental pairing with
   another service.
6. Reusing, replaying, or using an expired grant fails safely and is audited.
7. Device credentials rotate without changing Task identity.
8. Revocation prevents new connections and Work Order claims immediately.
9. Re-enrollment never silently merges two Devices or transfers local Knowledge.

### FR-3 — Device discovery and specification

1. Workers run non-destructive probes on enrollment and periodically thereafter.
2. Every observed Fact includes source, observed time, and confidence or verification
   state.
3. Capability detection is evidence-based. An installed executable alone may produce
   `detected`; a safe smoke test produces `verified`.
4. Main scheduling uses verified Capabilities by default and may use detected
   Capabilities only when a Policy permits a provisioning or verification attempt.
5. The Main Agent may recommend a Role or Capability setup based on combinations of
   facts, such as a supported agent plus an interactive desktop.
6. A Worker may submit a structured profile patch proposal with evidence.
7. Main may automatically apply Role and Instruction changes and records old and new
   values for rollback.
8. A Worker or Main Agent cannot automatically relax executable Policy.
9. Every ready first-class Agent Adapter reports a bounded verified catalog of
   provider-native model IDs and display metadata. Catalog discovery is deterministic
   operational state and is not injected wholesale into normal Task context.
10. Every Worker-capable Device has a typed Worker Agent Execution Profile. Main has
    a separate Coordinator profile so its planning runner and co-located Worker can
    use different bindings. A Coordinator model on the active authenticated adapter
    is a normal profile change; replacing the composed Coordinator provider or
    adapter remains an explicit authenticated Main Agent reconfiguration and service
    restart rather than an in-process profile mutation.
11. Agent Execution Profile modes are `Auto`, `Prefer`, and `Pinned`. Prefer uses
    only an explicit fallback chain. Pinned fails closed when its exact adapter or
    model is unavailable.
12. Owner aliases and display names are resolved against the target Device's current
    verified catalog. Durable configuration stores the exact provider-native model
    ID, never an unresolved alias.
13. Windows, macOS, and Linux Workers run a bounded read-only Wake-on-LAN target
    probe. It reports `enabled`, `disabled`, `unsupported`, or `unknown`, its source,
    and observation time without exporting an interface name, MAC address, SecureOn
    value, raw command output, or another local network identifier.
14. Main retains the last authenticated Wake-on-LAN target observation when a Worker
    goes offline and marks it as historical rather than treating an absent heartbeat
    as proof that the setting changed.
15. Wake target readiness and orchestration readiness are separate. An enabled target
    still requires an online Main-local or Worker relay on the target broadcast
    domain plus a securely stored exact wake target. Routed IP reachability,
    Tailscale membership, or a subnet route alone does not prove that path.
16. Until the relay, target-secret boundary, magic-packet delivery, boot observation,
    throttling, Policy, and audit lifecycle is implemented and verified, Admin Web
    reports `relay required` instead of claiming that OpenDelegate can wake the
    Device.

### FR-4 — Connectivity and transport profiles

1. Application topology is Main-to-Device, not Device-to-Device.
2. A Transport Profile contains ordered endpoints, transport type, health probe,
   retry policy, timeout, cost or preference, capability constraints, and Secret
   references.
3. The profile can represent LAN, Omada VPN, Tailscale, Headscale, an authenticated
   HTTPS tunnel, or a custom adapter without special LLM prompting.
4. Workers normally establish an outbound authenticated HTTPS, WebSocket, or polling
   connection to a Main endpoint.
5. One established Worker connection is logically bidirectional for Work Orders,
   control messages, progress, and artifact upload.
6. Network reachability never replaces Device authentication.
7. Deterministic code selects, probes, retries, and falls back between configured
   entries.
8. All transport attempts produce redacted diagnostics suitable for audit and later
   Agent troubleshooting.
9. After deterministic recovery is exhausted, Main may invoke a diagnostic Agent
   with the Task-independent incident context.
10. Any proposed VPN, firewall, route, or OS network mutation passes Policy.

### FR-5 — Discord Forum integration

1. One or more approved Discord Forum Channels may be bound to the Instance, while
   remaining in one personal trust domain.
2. A new approved Forum post creates a Task with an immutable Task ID and stores the
   Discord channel, thread, post, and message identifiers as external bindings.
   Thread and starter-message events may share an external identifier and arrive in
   either order; ingestion remains idempotent. The owner never has to apply an
   Intake or other workflow-status tag to start work. Workflow tags are projections
   that the bot applies after binding the Task.
3. A reply creates an idempotent Task event and resumes the Task's Coordinator
   Session when appropriate.
4. The Discord Adapter reconciles messages after reconnect using persisted cursors
   and Discord identifiers rather than assuming Gateway delivery is durable.
5. The bot ignores or rejects unauthorized authors before an LLM sees their content.
6. Exactly one workflow-status Forum tag projects states such as Intake, Running,
   Waiting, Review, Done, and Failed. Remaining tag capacity is reserved for facets
   such as priority or category. The database is authoritative when Discord's
   20-available-tag and five-applied-tag limits cannot represent internal state.
7. The bot maintains a concise status surface and edits it instead of posting a new
   message for every heartbeat. The surface shows Task state and references but does
   not repeat the Forum title, the current owner question, or mutable Task controls.
   Each accepted owner message receives one idempotent in-place acknowledgement on
   that exact message: a best-effort `👀` reaction plus Discord's typing indicator.
    Typing is refreshed while the turn remains active; after a durable question,
    result, or failure is delivered, the same message transitions to `✅` or `❌`.
    OpenDelegate does not post a second generic working card for the same input.
    Durable outbound delivery runs outside the serialized Gateway receipt path, so
    a slow reaction or reply in one thread cannot delay intake of another Forum
    post. A live `THREAD_CREATE` payload is reused for its starter message instead
    of requiring a redundant channel lookup before acknowledgement.
8. Significant decisions, questions, failures, and final results remain ordinary
   replies exactly once in chronological order, keyed by their immutable Task source
   event rather than mutable Artifact or link enrichment. The full owner question
   exists only in its chronological reply, while the status surface says only that
   input is needed. The first eligible owner answer resolves that same question
   message in place, removes its controls, and resumes the Task once. A failure reply
   includes the owner-safe concrete reason or exhausted resource and the applicable
   recovery control, such as Retry; the owner is never left with only a generic
   attention notice.
9. Buttons and menus offer pause, cancel, retry, approve, reject, inspect Runs, and
   open Artifact actions where Discord permits.
10. Closed or auto-archived posts do not complete or delete Tasks. New activity may
    resume the Task and reopen the external conversation when permitted.
11. If the external post is deleted, Task data remains in Main and the binding is
    marked broken.
12. System incidents and recommendations may create their own Forum posts according
    to the Autonomy Profile.
13. After bootstrap, the owner may add, extend, replace, or disable the Main-scoped
    Discord binding through Configuration Chat and protected Approval. A replacement
    becomes durable only after the candidate Gateway proves `READY`; failure restores
    the prior binding without changing Task or native-session identity.

### FR-6 — Task intake and lifecycle

1. A Task is a durable aggregate with an append-only observable event history and a
   materialized current state.
2. New Tasks default to Auto mode.
3. Main produces or updates a compact Task Brief containing objective, completion
   criteria, constraints, known inputs, decisions, and open questions.
4. Main asks one targeted question at a time when a user decision is required.
5. Main may create any number of Work Orders under one Task.
6. Work Orders may declare dependencies or run in parallel.
7. A Task never receives unrelated Task conversation implicitly.
8. Explicit user links, attachments, repository content, and Artifact references may
   be selected as inputs.
9. The owner may pause, resume, cancel, reopen, or archive a Task.
10. Completion requires Main to reconcile every required Work Order and verify the
    Task completion criteria, not merely receive one successful Worker response.
11. A narrowly recognized read-only Device-directory question that is fully
    answerable from a bounded, owner-safe, Main-owned orchestration snapshot may
    complete through deterministic Main code before an Agent turn. Unverified
    capabilities are excluded. A planner-supplied `completed` shape is not authority;
    the authoritative executor accepts only the exact decision minted by the trusted
    deterministic query path. This exception cannot authorize or claim a file,
    system, network, browser, or other external side effect; execution still
    requires authoritative Worker evidence.
12. Deterministic retries within one owner-input cycle reuse the first durable
    semantic plan. The trusted Main-owned direct-query fast path is checked first so
    an upgraded deterministic classifier may replace a stale artificial Work Order
    without an LLM turn. Otherwise, a retry never asks the Main Agent to reinterpret
    the same owner turn merely because Worker selection, dispatch, or another
    deterministic resource stage failed.

#### Canonical Task states

| State | Meaning | Typical Discord projection |
| --- | --- | --- |
| `intake` | Persisting and understanding new intent | Intake |
| `queued` | Ready but waiting for eligible capacity | Queued or Running |
| `running` | Coordinator or at least one required Run is active | Running |
| `waiting_user` | A material user answer or approval is required | Waiting |
| `waiting_resource` | No eligible Device, route, Secret, or lock is available | Waiting |
| `review` | Work is complete enough for owner or coordinator review | Review |
| `completed` | Completion criteria are satisfied | Done |
| `failed` | The Task cannot proceed under current policy or resources | Failed |
| `paused` | Owner or policy intentionally suspended work | Waiting |
| `cancelled` | Owner terminated the Task | Closed |

State transitions are validated in deterministic code and written as events. An Agent
may request a transition but cannot manufacture a state outside the transition rules.

### FR-7 — Work Orders, Runs, and scheduling

1. Each Work Order has a stable ID, explicit brief, completion criteria, constraints,
   selected inputs, required Capabilities, scheduling hints, and an optional Agent
   requirement naming a provider plus an optional exact adapter, exact model, and
   allowed compatibility set.
2. A deterministic eligibility stage filters Devices by health, connection, Policy,
   Capability, Secret availability, resource capacity, and hard Task constraints.
3. A deterministic score may rank workload, route cost, artifact locality, session
   affinity, and owner preferences.
4. Main uses semantic reasoning only when choosing or decomposing among eligible
   options is not mechanically determined.
5. A dispatch creates a leased Worker Run with a unique idempotency key.
6. Claim, heartbeat, timeout, cancellation, and retry behavior does not require an
   LLM.
7. A retry creates a new Run linked to the previous attempt.
8. When a current durable Run is expired or its assigned Worker or route is no
   longer eligible, Main records that Run as failed before a later retry can create
   a new, higher-fenced assignment. Structurally invalid or incorrectly scoped
   journal state fails closed and is not automatically discarded.
9. The Worker keeps a durable local outbox for Run events that Main has not
   acknowledged.
10. Duplicate claims and events do not duplicate external side effects.
11. Main may steer, cancel, replace, or add Workers while retaining the parent Task.
12. Observable Run statuses include created, dispatched, claimed, running, blocked,
    succeeded, failed, lost, and cancelled.
13. Every Worker completion echoes the Task, Work Order, Device, Worker, route, Run,
    lease, and fencing identities it actually executed. Main accepts the result only
    when that envelope exactly matches the current durable assignment and its lease
    is still live at the authoritative, monotonically non-decreasing journal
    acceptance instant; an expired or replaced Run cannot be credited with
    completion. Replay preserves and revalidates that original event instant.
14. The immutable Run assignment retains the original Work Order, including any hard
    Agent requirement, unchanged. Its separate effective Agent binding is resolved
    from the selected Device's profile and current verified catalog. With no hard
    requirement the profile decides the binding; with one, the binding must refine
    and satisfy it without widening provider, adapter, model, or allowed
    compatibility. Retry and restart replay preserve both the original requirement
    and that exact effective binding.
15. A terminal Worker event may return the actual provider, adapter ID and version,
    native session ID, Workspace ID, workstream ID, and session lineage. This safe
    observation excludes Device-local paths, worktree paths, and session keys and is
    durably preserved by Main.
16. Normal Task intake does not ask the owner to select a Device, OS family, route,
    Agent provider, or multi-Device split when the objective, registered Workspaces,
    verified Capabilities, Policy, and deterministic eligibility can decide.
17. Main may decompose one Task into ordered or parallel Work Orders across different
    OS families. The owner observes assignments and rationale through Admin and audit
    but does not manually coordinate the handoffs.
18. Main asks about placement only when the choice changes the intended outcome or an
    owner preference cannot be derived from durable configuration.
19. Main Agent instructions treat a direct routine placement question as a planning
    defect, but structural result validation does not infer intent from Device words
    or reject a question lexically. Placement questions remain valid when privacy,
    data locality, cost, physical or interactive access, licensed software, result
    location, compatibility, legal, Policy, or another owner-visible outcome changes.
20. Scheduling intersects Task hard requirements with the Device Agent Execution
    Profile. A conflict excludes the Device with an owner-visible reason instead of
    silently widening either requirement.

### FR-8 — Concurrency and resource locks

1. Devices may execute multiple general Agent Runs concurrently.
2. Every Agent Adapter declares its concurrency and workspace-isolation support.
3. OpenDelegate reuses agent-native worktrees, sandboxes, or isolated working
   directories when available.
4. A Resource Lock has a named resource, capacity, holder, lease, and fencing value.
5. Computer Use requires exactly one `desktop-session` Resource with capacity one
   per interactive Device session. A missing or differently sized Resource fails
   closed.
6. Other resources such as GPU memory, camera, microphone, a package manager, or a
   named account may declare capacities without changing scheduling architecture.
7. A lost lease prevents a stale Run from continuing protected external actions.
8. A duplicate Computer Use start command resolves to the same execution handle or
   fails closed; after restart its durable command history rejects replay when the
   original in-memory handle cannot be recovered. It never creates a second
   controller under an idempotently reused lease.
9. Active input revalidates the exact desktop lease and fencing identity after
   authorization and immediately before the protected mutation.
10. Resource Lock persistence includes completed acquire-command outcomes, complete
    lease-renewal chains, live leases, and fencing counters. Restore rejects
    incomplete, discontinuous, clock-regressing, or provably over-capacity
    histories, and every active lease must exactly match its latest recorded
    acquire-or-renew outcome. Command replay cannot issue a new lease after restart.
    Every renewal has a durable command identity; exact replay returns its original
    outcome without extending authority again, while conflicting reuse fails closed.
11. Resource Lock and Computer Use executor state are committed as one monotonic
    persistence generation. Restore accepts only the latest committed generation
    through compare-and-set validation; an internally coherent stale prefix is not
    treated as current authority.
12. One exclusive Device service owns the desktop helper. A monotonic authority
    outside the application snapshot prevents a restored stale copy from accepting
    input. If that authority cannot be verified, Computer Use fails closed and
    requires the explicit recovery flow.

### FR-9 — Agent adapters and native sessions

1. The common Agent Adapter contract supports detection, version inspection, auth
   readiness, start, resume, steer when supported, cancel, event streaming, final
   result, diagnostics, session cleanup, and bounded model-catalog discovery for
   first-class providers.
2. Codex and Claude are first-class adapters through their supported programmatic
   interfaces.
3. CLI non-interactive execution and resume provide fallback paths where an SDK
   cannot be used.
4. A generic command adapter supports locally defined runners but must implement the
   same observable lifecycle contract.
5. Every Task has one Coordinator Session on Main.
6. The initially selected coordinator provider remains pinned for the Task.
7. Every Device/provider/workstream combination may hold a Worker Session that
   resumes for related follow-up work.
8. Independent native sessions may run in parallel, but a single-writer lease
   prevents two Runs from appending concurrently to the same native session.
9. Native session identifiers are opaque adapter data. OpenDelegate does not parse
   private chain-of-thought or depend on undocumented transcript internals.
10. OpenDelegate stores public agent messages, tool outcomes exposed by the adapter,
   file or command results relevant to the Task, decisions, approvals, and Artifacts.
11. It does not require hidden reasoning, internal model state, or an exact visual
    mirror of a vendor's Desktop conversation.
12. For Task Coordinator and Worker sessions, context pressure, provider compaction,
    retention expiry, corruption, or Device loss triggers a checkpoint and
    continuation session. Configuration Chat follows its separate recovery contract
    in FR-15 because it is not a Task and does not own a Task Brief or Work Orders.
13. A Task or Worker continuation receives a bounded package: Task Brief, rolling
    summary, decisions, pending Work Orders, selected Artifact index, relevant current
    messages, and explicit constraints.
14. A Worker uses Device-level automatic adapter selection only when its Run has no
    Agent requirement or resolved Device profile binding. When a requirement exists,
    the provider is mandatory, the exact adapter, exact model, and compatibility set
    are enforced when present, and an unavailable binding fails closed without
    silently substituting another provider or model. Omitting the compatibility set
    means tested-only.
15. A successful provider-bound Run reports a safe native-session observation whose
    provider, exact adapter, and exact model, when required, match the durable
    assignment.

### FR-10 — Context isolation and compaction

1. The complete Task event history is durable but is not automatically included in
   every model request.
2. A rolling Task summary is versioned and linked to the event range it summarizes.
3. Decisions and completion criteria remain separately addressable and cannot be
   lost merely because chat was compacted.
4. Artifact contents are referenced and opened only when required.
5. Worker prompts receive a Work Order package, not the entire Coordinator
   conversation. The package includes the exact immutable Agent Binding selected for
   the Run.
6. Cross-Task retrieval is disabled by default.
7. An explicit owner link or Main-created dependency names exactly which external
   information becomes input.
8. No component stores or requests private chain-of-thought as a recovery mechanism.

### FR-11 — Device-local Knowledge

1. Knowledge is stored only on the Device to which it belongs.
2. Canonical content is ordinary Markdown and ordinary wiki-style links. No custom
   graph database is required.
3. The owner can browse and edit the directory with normal file tools or Obsidian.
4. A derived full-text index and link graph are rebuildable from Markdown.
5. Optional semantic indexing may be added behind a local index adapter, but baseline
   retrieval cannot require an external service.
6. At Work Order start, the Worker searches with the Task or Work Order brief and
   returns a small candidate list.
7. The Worker opens only the files or sections it needs and obeys a configurable
   retrieval context budget.
8. The agent may search again explicitly during execution.
9. The Worker may create or edit Knowledge when a discovery is Device-specific,
   repeatedly useful, expensive to rediscover, concise, and actionable.
10. Raw transcripts, raw logs, temporary Task state, credentials, and easily
    rediscovered facts are rejected as Knowledge.
11. Index updates are deterministic after Markdown changes and do not invoke a
    separate curation LLM by default.
12. Main may know only whether the local Knowledge service is healthy; it receives no
    filenames, titles, snippets, links, index, or content.
13. There is no automatic backup, synchronization, replication, or migration.

### FR-12 — Computer Use

1. Computer Use is a pluggable verified Capability, not an assumption made from OS
   name alone.
2. Detection verifies an interactive graphical session, a supported automation
   backend or agent tool, required screen and accessibility permissions, and capture
   ability.
3. The first milestone proves the capability on macOS, Windows, and at least one
   supported graphical Linux environment.
4. A headless Linux Device, including a NAS without a graphical session, reports the
   Capability as unavailable without degrading its other Worker functions.
5. Every Computer Use Run acquires the Device-wide `desktop-session` lock.
6. A Run exposes live status, emergency stop, timeout, and screenshot evidence.
7. Screen capture and input events are treated as sensitive Task data and follow
   Artifact and retention policy.
8. OS permission prompts that cannot be automated become explicit owner setup steps.
9. Computer Use cannot bypass UAC, macOS permission boundaries, locked sessions, or
   equivalent OS security controls.
10. Browser-only work should prefer structured browser automation when it is more
    reliable than pixel-level desktop control.
11. Login, MFA, CAPTCHA, legal confirmation, and other human-only interactions pause
    the current Task rather than inviting the Agent to bypass the boundary.
12. When an eligible interactive surface exists, Main presents a bounded Owner
    Handoff. After the owner returns control through the same Task, execution resumes
    from durable state and the existing session lineage where possible.

### FR-13 — Knowledge-aware capability development

1. When no Device satisfies a Work Order, Main distinguishes unavailable,
   unconfigured, and provisionable Capabilities.
2. Main may recommend or initiate provisioning according to Package and Action
   Policy.
3. Official packages and already configured repositories may be used automatically.
4. New repositories, remote scripts, unsigned installers, drivers, and kernel
   extensions require approval.
5. Successful provisioning updates Capability evidence and may update Role or
   Instructions.
6. Failed provisioning produces deterministic diagnostics before agent analysis.

### FR-14 — Artifacts and rich result presentation

1. Artifact metadata includes owner Task, producing Run, media type, size, checksum,
   created time, retention policy, exposure policy, and provenance.
2. Default storage is local to Main; an S3-compatible or custom store may be
   configured.
3. Workers upload through authenticated resumable transfer and never expose a local
   web server as the default delivery mechanism.
4. Small text, image, and file results use Discord-native presentation when
   practical.
5. Long Markdown, PDF, log bundles, code review reports, and static sites use the
   Artifact Gateway.
6. An Artifact can have multiple viewer base URLs or access routes so Main can
   generate a URL suitable for a Tailscale, Omada, LAN, tunnel, or public viewer.
7. Exposure modes are `private-network`, `authenticated`, `signed-link`, `public`,
   and `custom`.
8. Instance, Device, Task, and individual Artifact defaults may be overridden in a
   clear precedence order.
9. Public and long-lived signed exposure is explicit and audited.
10. Agent-generated HTML is served from an isolated origin with a restrictive Content
    Security Policy. Script execution is disabled by default.
11. Interactive HTML is an explicit, more permissive Artifact mode and cannot share
    Admin Web cookies or origin authority.
12. Temporary Artifacts expire according to policy; the owner may pin an Artifact.
13. Final presentation may be a Discord-native response or attachment, downloadable
    file, Artifact, hosted result, or Git reference proven by an authoritative Worker
    report.
14. An Owner Handoff is Task-scoped and Main-mediated. It may use an isolated
    interactive Artifact or a configured remote-session gateway, but raw Worker VNC
    or browser-debug endpoints are not exposed to Discord by default.
15. Owner Handoff access follows an explicit exposure policy, is time-bounded,
    revocable, and audited, and carries no credential in its Discord URL or Agent
    prompt.
16. The handoff asks the owner for one clear action, never requests a credential in
    chat, and preserves the Task context boundary while waiting.
17. Credentials or provider tokens retained after owner authorization remain in the
    relevant Device Secret Store under Policy; only a non-secret capability
    reference may enter Task state.

### FR-15 — Admin Web

1. Admin Web is hosted by Main and is accessible through configured owner routes.
2. Admin Web requires application authentication even on a private network.
3. Initial owner claim is available only through a local bootstrap channel on Main
   and produces independent recovery credentials.
4. The first milestone provides a local owner passphrase protected by Argon2id.
   Owner creation and recovery accept 10 or more Unicode code points including at
   least one non-whitespace code point, up to 1024 UTF-8 bytes. Optional
   reverse-proxy or identity-provider adapters may be added, and Discord identity
   alone is not the only Admin recovery method.
5. Initial navigation shows the current Device and expands to a left-side Device list
   as more Devices enroll.
6. Device detail includes name, OS, health, Facts, Capabilities, Roles, Instructions,
   Policies, connections, Agent Adapters, their verified model catalogs, the effective
   Worker Agent Execution Profile, Wake-on-LAN target and orchestration readiness for
   Worker Devices, locks, load, and current Runs. A Worker with no authenticated
   Wake-on-LAN observation shows an explicit `not assessed`/`unknown` state instead
   of omitting the section.
7. Knowledge content is never proxied to Admin Web. At most, local service health is
   shown.
8. Task inspection shows the Task state, event timeline, Coordinator Session lineage,
   Work Orders, Runs, approvals, errors, and Artifacts.
9. Emergency controls include pause, resume, cancel, retry, drain Device, revoke
   Device, release a confirmed stale lock, and create a minimal Task.
10. Configuration pages cover database, Discord, owner identity, Agent Adapters,
   transports, artifacts, Autonomy Profiles, action Policies, retention, and
   service startup.
11. A bottom-right Configuration Chat opens a dedicated configuration session.
12. The Configuration Agent uses structured read, validate, propose, diff, apply, and
   rollback tools rather than editing opaque settings text.
13. The Agent may recommend settings from observed facts, explain consequences, and
    ask for values that cannot be discovered.
14. Admin Web exposes an explicit deterministic assessment for the local Main Device.
    It probes local Codex and Claude adapters, browser automation, Computer Use
    readiness, and local Knowledge health without spending LLM context. The bounded,
    non-secret result is durable in Main metadata and is supplied to Configuration
    Chat as authoritative context. Configuration Chat cannot claim that it ran the
    assessment. An Owner may explicitly bind existing Device-local Codex and Claude
    configuration homes by absolute path; assessment and execution use those same
    homes without copying or discovering credentials.
15. Protected configuration changes use the same Policy and approval mechanisms as
    Task work. Admin Web can select `Auto`, `Prefer`, or `Pinned` from target-local
    verified adapters and model IDs. Configuration Chat can propose the same typed
    change in natural language, including distinct Coordinator and co-located Worker
    profiles for Main. Both surfaces read and write the same profile source of truth.
    They explain that selecting a Coordinator binding on a different provider or
    adapter does not replace the running Main Agent; the authenticated Main Agent
    reconfiguration and restart must complete first.
16. Admin Web does not attempt to reproduce the complete Discord Task chat in the
    first release.
17. English is the canonical fallback and the initial locale when no explicit owner
    choice has been stored. Admin Web exposes a language selector before and after
    authentication for Korean, Japanese, French, Spanish, and Simplified Chinese.
18. The explicit locale choice persists locally, updates the document language,
    accessibility names, tooltips, status labels, and locale-sensitive dates without
    requiring a reload, and is included as `Accept-Language` on Admin requests.
19. Owner-authored Device names, Roles, Task objectives, criteria, constraints, and
    historical owner or Agent conversation content are never machine-translated.
    Stable product chrome and deterministic built-in state labels are translated at
    render time.
20. Domain codes, API fields, durable events, schemas, logs, and source defaults
    remain English regardless of the selected presentation locale.
21. Configuration Chat does not pin a generic setup menu or credential form below
    the conversation. A Configuration Agent final response may attach only bounded,
    typed, allowlisted setup suggestions. Admin Web renders each suggestion inside
    the Agent message that produced it, preserving the conversational reason for the
    next action.
22. Main-service credential intake appears only after the Configuration Agent
    explicitly identifies that credential as the next missing value. Embedded SQLite
    is the already-active default and needs no URI. Raw Secret material goes only to
    Main's secure intake form, never to the transcript or Agent context; only the
    resulting opaque reference continues through Configuration Chat.
23. Discord guided setup inspects the current binding first, explains the remaining
    Developer Portal, Community Server, Forum, intent, and permission steps, asks only
    for missing non-secret identifiers, and then offers secure bot-token intake when
    it is actually required. It uses the typed proposal and protected Approval
    lifecycle and never claims that browser-only Discord actions were completed by
    OpenDelegate. The guide assumes no prior bot experience, first explains how one
    Forum post maps to one Task, defines unfamiliar Discord terms, and walks through
    only the missing stages, including installing the configured bot into the selected
    server and verifying its Forum access. It gives a brief roadmap, then explains
    only the current stage in detail: where to go, what to do, why it is required,
    how to verify completion, and what non-secret value, if any, to return. It waits
    for owner confirmation before advancing, presenting a single clear next action
    instead of an unexplained identifier dump or a full manual in one response.
24. When Main reports the exact `DISCORD_NOT_CONFIGURED` runtime state, the first
    opening of Main's Configuration Chat in a browser session transparently starts
    one Agent-guided Discord onboarding turn. A deterministic in-chat status explains
    that the current binding is being inspected; the resulting guidance and actions
    still come from the Agent response. Degraded or reconnecting Discord states do not
    masquerade as first-time setup.
25. Configuration Chat preserves Agent-authored paragraph breaks and renders
    line-oriented numbered or bulleted steps as readable semantic lists without
    accepting arbitrary Agent-authored HTML. If an Agent response arrives while the
    chat is closed or the Admin page is hidden, Admin Web retains the conversation
    across section navigation and exposes a localized unread badge, visible summary,
    and accessible live notification. Opening the chat marks those responses read.
    While an Agent turn is in flight, the transcript itself shows a localized
    Agent-authored-position activity message; a disabled composer placeholder is not
    the only progress indication.
26. If a Configuration Agent native session becomes unavailable before any
    mutation-capable tool for that request has executed, Main starts one fresh native
    continuation with the complete current prompt and records the new lineage. Main
    durably reserves that one continuation before invoking it, so Main restart or an
    ambiguous start failure cannot produce a second continuation. This
    recovery may follow only read-only `inspect`, `validate`, or `diff` calls; the
    continuation re-inspects durable configuration rather than treating their prior
    results as mutation receipts. It does not automatically restart after `propose`,
    `apply`, or `rollback`, because replay could duplicate durable proposal state,
    duplicate a mutation, or misrepresent a receipt. The continuation tells the owner
    that provider-private or interrupted in-flight context may be unavailable,
    receives a bounded excerpt of completed Device-scoped Configuration Chat
    exchanges, and re-confirms any required value or choice that is absent from the
    excerpt before proposing a change. Main durably records the first tool attempt and
    upgrades that request-bound boundary before the first mutation-capable tool.
    Legacy boundaries that did not record later tools remain fail-closed. An
    interrupted request with a mutation-capable boundary and no final response fails
    closed across restart instead of replaying.
27. Main durably records an accepted owner Configuration Chat message before starting
    or resuming its Agent turn. Admin Web restores that message immediately after
    reload, shows whether its response is still pending or was interrupted, and
    reconciles the eventual Agent response without requiring another reload.
    Completed owner and Agent exchanges remain stored per target Device and Adapter
    across Main restart. They remain separate from Task conversations and never
    include provider-hidden reasoning or raw Secret material. Enter sends a message,
    while Shift+Enter inserts a newline in the multiline composer.
28. Approving a protected Configuration proposal atomically executes that exact
    proposal through the Approval service. A follow-up chat message never creates a
    second Approval for the same target Device and proposal: the durable Approval
    request identity is derived from that immutable pair, while each chat tool
    execution retains its own replay boundary. After the owner reports approval, the
    Agent inspects current durable configuration instead of blindly applying again.
29. The selected Admin presentation locale is attached to each newly accepted
    Configuration Agent turn as bounded request metadata. It controls newly generated
    owner-visible prose even when a deterministic UI action supplied an English
    configuration instruction. Identifiers, provider-native model IDs, commands,
    configuration keys, raw values, and previously stored conversation content remain
    unchanged.
30. Configuration Chat may hydrate while closed, but each transition from closed to
    open positions the transcript at its newest restored message. Older messages
    remain available by scrolling upward; opening the chat does not replay, truncate,
    translate, or rewrite them.
31. Creating a durable proposal is not an Approval request. Once a turn invokes
    `propose`, Main rejects a terminal response until the same turn has attempted
    `apply` for that proposal. A protected apply result creates the durable Approval
    and returns its exact ID as authoritative response metadata. Admin Web renders a
    localized action in the originating Agent message and opens that exact Approval.
    An explicitly requested draft or preview uses `validate` without creating a
    proposal. No setting changes until either an unprotected apply succeeds or the
    owner approves the protected action.

### FR-16 — Policy and approvals

1. Every executable action has an action type, target Device, requested scope,
   requesting Task or system incident, adapter identity, and risk metadata.
2. Policy evaluates immediately before execution using current state.
3. Outcomes are allow, require approval, or deny.
4. Default automatic actions include non-destructive inspection, health checks, log
   collection, route fallback, bounded retries, and restarting OpenDelegate-owned
   services.
5. Official package installation from existing sources is automatic.
6. Default protected actions include OS networking, VPN configuration, firewall
   changes, new package sources, remote installer scripts, untrusted installers,
   drivers, kernel extensions, and durable Policy relaxation.
7. Computer Use input must carry an exact Task-scoped owner grant or a configured
   Policy grant; otherwise it requires approval. Observation-only desktop evidence
   remains separately classifiable from input.
8. Approval may be granted once, for the Task, for a Device and action pattern, or as
   a durable Policy update.
9. An approval contains an expiration and exact normalized action scope. Human text
   alone does not define executable scope.
10. A once grant is atomically consumed by the executable enforcement boundary before
    the action. Stateless preview or evaluation cannot authorize it, and a consumed
    or replayed grant fails closed across process restart.
11. Discord and Admin Web show the proposed action, reason, target, risk, and evidence.
12. The executor rejects actions outside the approved scope even if an Agent claims
    approval exists.
13. More permissive owner configuration is supported and clearly surfaced.

### FR-17 — Secret management

1. Main stores Discord, database, Main Agent, and Main-local service credentials in
   the Main OS Secret Store or an owner-configured local vault.
2. Each Worker stores only credentials used on that Worker.
3. The shared database contains opaque Secret references and non-sensitive
   availability metadata, never Secret values.
4. Agent prompts receive capability availability, not credentials.
5. The Worker injects a credential only into the minimal child process or credential
   helper scope that needs it.
6. Logs, diagnostics, events, Task summaries, and Artifacts redact known Secret
   values and common credential forms.
7. Main does not automatically distribute or copy a Secret to another Device.
8. If no eligible Device has a required credential, Main selects another Device or
   asks the owner to configure the target locally.

### FR-18 — Autonomy and proactive behavior

1. The Instance supports Reactive, Assisted, and Autonomous profiles.
2. Profiles are independently configurable for incident recovery, maintenance,
   Capability expansion, cleanup, cost-incurring work, and general improvements.
3. Assisted is the default.
4. Deterministic monitors run without a continuous LLM loop.
5. A meaningful event may trigger an Agent only when a semantic diagnosis,
   recommendation, or plan is useful.
6. Incident recovery remains constrained by Action Policy regardless of Autonomy
   Profile.
7. Autonomous work creates an ordinary auditable Task and does not operate outside
   Task accounting.
8. Each proactive category may inherit its profile or explicitly select disabled,
   propose, or execute. A bounded monitor or system-incident signal with propose
   authority creates a manual-review Task; execute creates an auto Task. Both enter
   the ordinary Task coordinator, Policy, approval, budget, lock, and audit paths
   rather than a privileged monitor-only execution path. When Discord is ready, Main
   creates and durably binds one bot-authored post in the configured Forum before
   using the ordinary Task projection. FR-4's bounded read-only diagnostic Agent may
   produce the incident signal, but it cannot perform remedial work outside the Task.

### FR-19 — Persistence

1. Main supports embedded SQLite as the zero-administration default and PostgreSQL
   through a supplied external URI.
2. Both backends implement the same domain transactions, state transitions,
   idempotency, lease, and migration semantics.
3. Main is the only database client.
4. Durable concepts include Instance, owner bindings, Devices, profiles, transport
   metadata, Agent Adapter metadata, Tasks, Task events, Work Orders, Runs, session
   references, exact Agent Bindings, model-catalog observations, approvals, policies,
   locks, Artifacts, audit events, and settings.
5. Knowledge and Secret values are explicitly excluded.
6. Artifact bytes are stored separately from relational metadata.
7. Database migrations are transactional where supported, restart-safe, and tested
   from every released schema.
8. Backup configuration for Main data may be added as an operational feature, but it
   never includes Worker Knowledge or Worker Secret values.

### FR-20 — Audit and observability

1. Structured logs use stable event names, correlation IDs, Task IDs, Run IDs, Device
   IDs, and redacted fields.
2. Audit records cover enrollment, revocation, profile changes, Policy changes,
   approvals, assignment decisions, action execution, external messages, Artifact
   exposure, and administrative controls.
3. Scheduling explanations show hard exclusions, deterministic scores, and the
   semantic rationale without requesting private chain-of-thought.
4. Health includes Control Plane, database, Discord, Artifact Store, each Device,
   each Agent Adapter, local Knowledge indexing, and configured transports.
5. An owner-facing incident bundle is exportable without Secret values.
6. Token, cost, duration, and retry metrics are tracked when the provider exposes
   them.
7. Deterministic release tooling compares the exact Codex and Claude source targets
   with registry candidates without editing source or an installed Device. Scheduled
   repository dependency automation may propose a candidate. A future Device
   maintenance monitor may expose `disabled`, `propose`, and rollback-capable
   verified automation only after Phase 12 implements its durable lifecycle.
   Discovery never proves a supported release or bypasses applicable Agent and
   platform gates.

### FR-21 — Failure and recovery

1. Main restart restores Tasks, session references, leases, Discord cursors, and
   pending dispatch from durable state.
2. Worker restart restores its identity, local configuration, Knowledge, resource
   locks that can be proven live, native session references, and unacknowledged
   outbox events.
3. Stale locks and leases use fencing and cannot be silently reused by an old process.
4. Main outage does not cause another Device to become Main.
5. Running Workers may complete safe local work during a Main outage and report when
   Main returns.
6. Main reconciles state before issuing new work after restart.
7. Provider session loss creates a continuation session from an OpenDelegate
   checkpoint.
8. Transport failure uses deterministic retry and fallback before Agent diagnosis.
9. Exhausted repair either moves the Work Order, waits for a resource, or asks the
   owner with evidence.
10. Cancellation is cooperative first and escalates according to adapter and Policy;
    it must never imply that an already completed external side effect was reversed.

### FR-22 — Workspaces

1. A Workspace is registered on one Device with a stable ID, human alias, local type,
   capability metadata, and local path mapping.
2. Supported baseline types include Git repository, ordinary directory, and mounted
   storage.
3. Main stores the reference and scheduling metadata required for assignment. The
   Worker resolves the actual local path.
4. A Work Order that mutates files identifies its Workspace explicitly or enters
   intake until one is selected.
5. Agent Sessions record their Device, Workspace, working directory or worktree, and
   adapter version.
6. Resuming a native session on a different Workspace is prohibited unless the
   adapter explicitly forks or the coordinator creates a checkpoint continuation.
7. Workspace isolation advertises none, agent-native worktree, OpenDelegate-managed
   worktree, container, or custom.
8. Cleanup cannot delete a workspace or worktree with uncommitted, untracked, or
   unpushed work without an approved disposition.
9. Main may know repository or Workspace identity for scheduling but does not need
   absolute paths in ordinary LLM context.

### FR-23 — Budgets and runaway control

1. Instance and Task defaults bound wall time, idle time, retries, child Work Orders,
   concurrent Runs, native turns, tokens, and monetary cost where measurable.
2. Provider adapters report usage and cost evidence when exposed; otherwise
   OpenDelegate enforces time, turn, and retry proxies.
3. A Work Order may request a smaller budget but cannot silently exceed its parent
   Task budget.
4. Approaching a soft limit produces a concise warning and allows Main to prioritize
   completion.
5. Reaching a hard limit pauses or fails new work deterministically.
6. The owner may extend a Task budget once, for the Task, or through a durable default
   change.
7. Autonomous proactive Tasks always have finite defaults even if requested Tasks
   have a more permissive profile.
8. Budget changes and limit events are audited and visible in Discord and Admin Web.
9. Idle time measures the absence of Task activity. A durable owner input records
   activity before its resumed execution is budget-checked, so time spent waiting
   for the owner does not make that answer reject itself. Wall-time and every
   finite usage limit remain enforced.

## Implementation Decisions

### Architecture

The implementation is a modular control plane with seven major runtime boundaries:

1. **Main Control Plane** — APIs, domain services, scheduling mechanics, state,
   policy, Discord, Admin Web backend, and Artifact Gateway.
2. **Worker Daemon** — discovery, local identity, transport client, Run supervisor,
   resource locks, Agent Adapters, Knowledge retrieval, Secret injection, and durable
   outbox.
3. **User Session Helper** — logged-in desktop readiness, screen observation, input,
   Computer Use, and the desktop-session lock.
4. **Admin Web** — owner-only browser interface.
5. **Agent Adapters** — provider-specific programmatic execution.
6. **Channel Adapters** — Discord first; interfaces do not hard-code Task semantics
   into Discord.
7. **Storage Adapters** — SQLite/PostgreSQL metadata, local/S3-compatible artifacts,
   OS-specific Secret Stores, and local Knowledge indexing.

The Main and Worker may share a codebase and domain contracts, but they remain
separate runtime roles with separate authority.

### Technology direction

- Use a TypeScript-first monorepo because the first-class Codex and Claude
  programmatic integrations, Discord integration, Control Plane, and Admin Web can
  share types and schemas.
- Target the active Node.js LTS line and strict TypeScript.
- Use a schema-first boundary for HTTP, WebSocket, persisted events, adapter events,
  and configuration. Generate validation and documentation from the same schemas.
- Keep the domain layer independent of the web framework, Discord library, SQL
  library, and provider SDKs.
- Use React for Admin Web and end-to-end browser testing. The component system may be
  selected during the UI foundation phase but must support keyboard accessibility,
  compact operational data, and a persistent configuration-chat drawer.
- Use a SQL migration layer that can prove equivalent behavior on SQLite and
  PostgreSQL. A short technical spike chooses the exact library before domain tables
  are committed.
- Avoid Redis, a separate message broker, a vector database, Kubernetes, and a
  hosted relay in the first release. The fixed Main and personal scale do not justify
  them.
- Use the database-backed event/outbox/lease model for Main coordination and a small
  local durable outbox for each Worker.
- Package the product so the agent-facing init and join skills call stable CLI
  operations. Development tooling is not the owner onboarding surface.

### Main deployment

- Main is one logical process group on one fixed Device.
- The Control Plane owns database migrations and refuses to start normal work after a
  failed or incompatible migration.
- Bundle assembly and packaged smoke use temporary state and dynamically selected
  loopback listeners. They never stop, restart, reconfigure, or activate the
  installed Main.
- Main may expose several authenticated listener URLs through LAN or configured
  private/tunnel networks.
- Admin Web and Artifact Gateway have separate authorization and origin boundaries.
- Main can execute Worker Runs locally but does not bypass Device policy or resource
  locks.

### Worker deployment

- Windows integrates with the Windows service model.
- macOS integrates with launchd using an appropriate per-user or system scope chosen
  during setup.
- Linux integrates with systemd where available and provides a supervised foreground
  fallback for environments without systemd.
- Service installation, upgrade, restart, uninstall, and diagnostics are idempotent.
- Bundle activation is owned by the native service lifecycle, including exact
  active-version verification, bounded health checks, and failed-upgrade rollback;
  constructing a bundle never changes the active version.
- An interactive per-user helper may be distinct from a boot service where Computer
  Use requires access to the logged-in desktop.
- The headless daemon never assumes that a desktop session exists.

### Application protocol

- Every request and event has a protocol version, message ID, sender Device ID,
  correlation ID, creation time, and idempotency key where side effects are possible.
- The Worker authenticates to Main with a Device-scoped credential established during
  enrollment. Mutual TLS or an equivalent proof-of-possession channel is preferred.
- Protocol authorization is capability- and action-based, not a generic remote shell.
- Backpressure is explicit. Main may stop dispatching to a Worker whose event or Run
  capacity is saturated.
- Large Artifact bytes use a dedicated upload flow rather than the control event
  stream.
- Version negotiation permits rolling Worker upgrades within a documented
  compatibility window.

### Event and state model

- Observable domain events are append-only.
- Current aggregate state is materialized transactionally for efficient reads.
- Outbox records are committed with state changes and delivered asynchronously.
- External Discord and provider identifiers are bindings, not aggregate identities.
- State machines reject invalid transitions regardless of the requesting Agent.
- Lease fencing values are included in protected Run and lock mutations.

### Scheduling split

The scheduler intentionally has two stages:

1. **Mechanical eligibility and scoring** — deterministic, fast, testable, and
   independent of an LLM.
2. **Semantic planning and selection** — Main Agent chooses decomposition or a
   candidate when Task meaning, qualitative Role fit, or strategic tradeoffs matter.

When one candidate clearly remains after deterministic processing, no additional LLM
selection call is required.

### Configuration model

- Structured settings have explicit scopes: Instance, Main, Device, Agent Adapter,
  Transport, Channel binding, Task default, and Artifact.
- Precedence is deterministic and visible in Admin Web.
- The Configuration Agent reads effective values and proposes typed patches.
- Applying a patch validates schema, runs Policy, commits atomically, and emits audit.
- Network and Agent diagnostics may include detailed configuration only when needed;
  routine Task context does not carry it.
- `agent.worker-profile` is Device-scoped and `agent.coordinator-profile` is
  Main-scoped. Profile values use exact provider-native IDs resolved from verified
  catalogs.

### Artifact security model

- Admin Web never renders agent HTML in its own origin.
- Static reports default to no script execution.
- Interactive reports use an isolated origin, sandbox, and an explicit exposure mode.
- Signed links are scoped to one Artifact, expire, and can be revoked.
- Public mode is supported intentionally but is never inferred from a network failure
  or an Agent request alone.

### Source-of-truth boundaries

| Concern | Canonical owner |
| --- | --- |
| Task intent, state, decisions, Work Orders, Runs | Main database |
| Discord messages and presentation | Discord, mirrored as Task events/bindings |
| Native agent conversation | Provider-local session, referenced by Main |
| Recovery summary and session lineage | Main database |
| Device facts and runtime probes | Worker observation, accepted by Main |
| Roles and Instructions | Main Device Profile |
| Worker and Coordinator Agent Execution Profiles | Main typed configuration |
| Installed and verified adapter/model catalogs | Worker observation accepted by Main |
| Executable Policy | Main policy configuration enforced again by Worker |
| Secret values | Relevant Device Secret Store |
| Knowledge Markdown and index | Relevant Worker Device |
| Workspace path and isolation state | Relevant Worker Device |
| Workspace reference and scheduling metadata | Main database |
| Artifact metadata | Main database |
| Artifact bytes | Configured Main Artifact Store |
| Unacknowledged Worker events | Worker local outbox |

## Testing Decisions

### Primary test seam

The highest-value seam is a black-box Task journey:

> An approved Forum-like input creates one Task, Main plans it, deterministic
> scheduling dispatches one or more Work Orders to real or simulated Workers, agent
> events return, Main continues the Coordinator Session, and the owner receives a
> final Discord projection plus an openable Artifact.

Most behavior should be proven through this seam using replaceable external adapters.
The same acceptance suite runs first against deterministic fake channel, agent,
transport, and Computer Use adapters, then against platform-specific real adapters.

### Test principles

- Test externally observable state, contracts, and side effects rather than private
  class layout.
- Make time, random IDs, retry schedules, and health probes controllable.
- Treat duplicate delivery, reordering, restart, and partial failure as ordinary test
  cases.
- Run contract suites against every implementation of an adapter interface.
- Never require live paid model calls for the default unit and integration suite.
- Maintain a small, separately gated live-provider smoke suite.
- Prove security invariants with negative tests, not only successful flows.
- Every production incident must add a regression at the highest reproducible seam.

### Required suites

1. **Domain state-machine tests** — Task, Work Order, Run, approval, Device, transport,
   and resource-lock transitions.
2. **Policy decision tests** — allow, approval, deny, scope normalization, expiry,
   replay, and attempted Agent bypass.
3. **Scheduler tests** — hard filters, deterministic scoring, session affinity,
   resource capacity, and semantic handoff packages.
4. **Protocol contract tests** — versioning, auth, idempotency, backpressure, outbox,
   duplicate events, and fencing.
5. **Persistence tests** — equivalent SQLite and PostgreSQL behavior, migrations,
   restart recovery, and transactional outbox.
6. **Agent Adapter contract tests** — detect, start, stream, resume, cancel, fail,
   checkpoint, and continuation for Codex, Claude, and generic adapters.
7. **Discord Adapter tests** — Forum binding, authorization, message reconciliation,
   tag projection, component actions, archive/reopen, and deletion.
8. **Knowledge tests** — Markdown discovery, wiki-link graph, index rebuild,
   bounded retrieval, automatic high-value update, and proof that content never
   reaches Main.
9. **Artifact tests** — upload, checksum, resume, native presentation selection,
   exposure precedence, signed-link expiry, public mode, isolated HTML, and cleanup.
10. **Admin Web tests** — onboarding, Device navigation, profile diffs, configuration
    chat proposals, approval, Task inspection, emergency controls, complete six-locale
    catalog coverage, persisted switching, translated accessibility names and dates,
    untranslated owner content, and responsive no-overflow browser proof.
11. **Failure tests** — Main restart, Worker restart, route loss, duplicate dispatch,
    provider session loss, stale lock, Discord outage, database outage, and Artifact
    Store outage, plus Workspace mismatch, unsafe worktree cleanup, concurrent native
    session writers, and hard-budget exhaustion.
12. **Security tests** — unauthorized Discord author, enrollment replay, revoked
    Device, secret redaction, generated-HTML XSS, approval widening, path traversal,
    malicious Task content, remote initial-owner claim, Admin session theft, and
    recovery while Discord is unavailable.
13. **Cross-platform service tests** — install, start, restart, upgrade, diagnose, and
    remove on macOS, Windows, and Linux.
14. **Computer Use acceptance tests** — one real graphical workflow on each supported
    OS family, exclusive desktop locking, screenshot evidence, cancellation, and
    permission failure.

### Cross-platform release matrix

The first milestone must prove:

- Main and Worker roles on macOS;
- Main and Worker roles on Windows;
- Main and Worker roles on Linux;
- service persistence and recovery on all three;
- Codex and Claude adapter compatibility wherever the upstream runner supports that
  OS;
- generic adapter behavior on all three;
- Computer Use on macOS, Windows, and a supported graphical Linux environment;
- correct `unavailable` capability behavior on a headless Linux Device; and
- at least one end-to-end three-Device Task that uses more than one OS.

## First Milestone Acceptance Criteria

The milestone is accepted only when all of the following are demonstrated:

1. Starting from an unconfigured checkout or release, the owner gives the repository
   or verified bundle to a capable Agent, which discovers the init skill and reaches
   a running Main service and Admin Web without requiring the owner to use a
   development start command.
2. The current Device appears as the only initial Device.
3. The owner configures an embedded database and can alternatively validate and use
   an external PostgreSQL URI.
4. The owner binds an approved Discord Community Server and Forum Channel.
5. The owner enrolls macOS, Windows, and Linux Devices through single-use grants.
6. Every OS service survives process restart and expected host restart behavior.
7. Device facts, verified Capabilities, Roles, Instructions, Policies, routes, health,
   current Runs, and Worker Wake-on-LAN target and automatic-path readiness appear
   correctly, including the last authenticated target observation while offline.
8. Different Devices use different configured connection methods without exposing
   route mechanics to the Main Agent prompt, and routed or Tailscale reachability is
   never presented as a verified Wake-on-LAN path.
9. A Forum post creates exactly one Task and a reply resumes it.
10. A different Forum post creates a context-isolated Task.
11. A clear Task starts automatically and an ambiguous Task asks one useful question.
12. Main decomposes one outcome-only Task into parallel Work Orders on at least two
    OS families without asking the owner to choose placement, then synthesizes the
    reports and leaves the assignments inspectable.
13. General Agent Runs execute concurrently while Computer Use is limited by the
    desktop-session lock.
14. Codex and Claude start through programmatic adapters, return observable events,
    and resume native sessions by Task or workstream.
15. Coordinator provider pinning and Worker provider participation behave as
    specified: Main preserves each Work Order's hard requirement unchanged, records
    one exact effective binding that satisfies it, and Worker never silently
    substitutes either. Safe actual provider/adapter/model/native-session lineage
    survives Main and Worker restart replay. Every Worker-capable Device, including
    Main, exposes target-local verified adapter/model choices; Auto, Prefer, and
    Pinned produce the specified immutable Run binding, a pinned unavailable model
    fails closed, and changing a profile does not rewrite an existing native
    session's binding.
16. A forced native-session loss continues from a durable checkpoint.
17. A Worker uses relevant local Markdown Knowledge without uploading Knowledge
    content or index data to Main.
18. A Worker records a qualifying new Knowledge file or update and deterministically
    rebuilds its index.
19. Computer Use completes the reference interaction on macOS, Windows, and supported
    graphical Linux, produces screenshot evidence, honors cancellation, and pauses
    and resumes the same Task through a bounded Owner Handoff for the reference
    human-only step.
20. A headless NAS-style Linux Worker remains fully usable for non-desktop
    Capabilities and reports Computer Use unavailable.
21. Worker-generated outcomes are shown as a concise Discord result and the useful
    available form—file, Artifact, hosted result, or verified Git reference—and an
    interactive result uses a credential-free Owner Handoff link when required.
22. At least private-network, authenticated, signed-link, and intentionally public
    Artifact modes are proven.
23. Agent-generated HTML cannot access Admin Web credentials or execute scripts in
    the default static mode.
24. An official package installs automatically, while a new repository or remote
    installer prompts for approval.
25. A network or firewall mutation prompts for approval and cannot bypass denial.
26. Device-local Secret values do not appear in database records, prompts, logs,
    events, diagnostics, or Artifacts.
27. Route failure performs deterministic fallback before invoking Agent diagnosis.
28. Worker disconnection buffers events and resynchronizes without duplicate work.
29. Main restart reconciles Discord, Runs, leases, and pending events without
    activating a second coordinator.
30. Admin Web can inspect and control the Task during a Discord outage.
31. Audit records explain enrollment, scheduling, profile changes, approvals,
    actions, Artifact exposure, and failures.
32. The full automated acceptance suite and live smoke matrix pass on the declared
    supported OS versions.
33. A code or file Task targets a registered Workspace, preserves its isolation, and
    resumes the native session in the correct working directory.
34. Two attempts to append concurrently to the same native session serialize or one
    is rejected without transcript interleaving.
35. A deliberately runaway fake Agent stops at its configured hard budget and cannot
    create unbounded child work.
36. Admin owner claim cannot be completed remotely before local initialization, and
    Admin remains recoverable while Discord is unavailable.

## Out of Scope

- Moving, electing, or automatically failing over the Main role.
- Active-active Main, distributed consensus, or split-brain recovery.
- Team accounts, organizations, tenant isolation, billing, or shared ownership.
- A hosted OpenDelegate SaaS, managed relay, managed VPN, or mandatory cloud account.
- NxN Device SSH configuration as the orchestration substrate.
- Giving Workers direct database access.
- Automatic Secret distribution from Main to Workers.
- Cross-Device Knowledge search, central Knowledge, Knowledge synchronization,
  Knowledge backup, or Knowledge migration.
- Persisting or reconstructing private model chain-of-thought.
- Reproducing an exact Codex Desktop or Claude Desktop visual transcript.
- Depending on Desktop UI automation for core Codex or Claude execution.
- A complete second Task chat product in Admin Web.
- Native mobile applications.
- First-class Slack, Teams, email, or other channel implementations in the first
  milestone; the Channel Adapter seam remains extensible.
- Building a custom VPN, NAT traversal network, or public Artifact CDN.
- Bypassing OS permission boundaries, locked desktops, UAC, or equivalent controls.
- Guaranteeing Computer Use on a headless Device.
- Arbitrary distributed file-system semantics between Devices.
- Automatic rollback of external side effects that are not inherently reversible.
- Unlimited native session context or indefinite provider-side transcript retention.

## Further Notes

### Configurability is not an excuse for undefined behavior

OpenDelegate deliberately exposes choices for transport, artifact exposure,
proactivity, and action authority. Every option still needs a documented default,
effective-value view, precedence order, audit event, and test. “Configurable” must
never mean that an Agent improvises a mechanism in context.

### LLM involvement budget

The following normally require no LLM:

- heartbeat and health state;
- route selection, probe, retry, and fallback;
- Task and Run state transitions;
- leases, locks, and idempotency;
- Discord event reconciliation and tag projection;
- package-source classification when mechanically known;
- Policy decisions;
- narrowly recognized read-only Device-directory query rendering from bounded
  Main-owned state;
- Markdown indexing and graph extraction;
- Artifact upload, serving, and retention; and
- service supervision.

The following are appropriate LLM work:

- understanding and clarifying user intent;
- decomposing a Task into Work Orders;
- choosing among semantically suitable Devices;
- performing the assigned work;
- synthesizing Worker reports;
- recommending Device Roles and Instructions;
- deciding whether a discovery deserves local Knowledge;
- diagnosing failures after deterministic recovery is exhausted; and
- explaining configuration tradeoffs.

### Research dependency

Current provider, Discord, networking, and OS capabilities are summarized in the
primary-source research note. Adapter implementations must pin and contract-test
specific supported versions rather than assume all documented behavior is permanent.

### Approval before implementation

The owner approved the primary end-to-end test seam and these planning documents on
2026-07-24. Implementation is authorized and must continue to use this specification
as its product contract.
