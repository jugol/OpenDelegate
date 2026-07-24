# OpenDelegate Decision Log

Status: **Accepted; specification approved 2026-07-24**

This log captures durable decisions that must survive conversation compaction.
Changing an accepted decision requires an explicit replacement entry and, once
implementation begins, an ADR.

## D-001 — Product boundary

**Decision:** OpenDelegate is an agent-agnostic orchestration control plane, not a
new general-purpose LLM runtime.

**Rationale:** Existing agents already own reasoning and tool use. OpenDelegate adds
the missing durable multi-Device harness: state, scheduling, transport, policy,
sessions, and presentation.

**Consequence:** The core must remain usable with interchangeable Codex, Claude, and
custom adapters.

## D-002 — Background agent execution

**Decision:** OpenDelegate can start and resume configured agent runners even when no
visible Codex or Claude window is open.

**Rationale:** Commands issued from a phone through Discord must work without a user
preparing a terminal session.

## D-003 — Fixed Main Device

**Decision:** The first release has exactly one fixed Main Device. Main migration,
leader election, and automatic failover are out of scope.

**Rationale:** The Owner does not need a moving Main, and avoiding multiple active
coordinators eliminates split-brain risk and substantial complexity.

**Consequence:** A Main outage intentionally pauses new orchestration.

## D-004 — Hub-and-spoke connectivity

**Decision:** OpenDelegate does not require an NxN SSH mesh. Each Device has one
logical relationship with Main.

**Rationale:** Pairwise credentials and permissions scale poorly and create excessive
blast radius.

**Consequence:** SSH may exist as an explicit Device capability but is not the
control-plane protocol.

## D-005 — Main-only database access

**Decision:** Only the Main Control Plane connects to the shared database. Workers
use authenticated APIs.

**Rationale:** This keeps database credentials off Workers, centralizes validation,
and prevents schema coupling.

## D-006 — Pluggable network transports

**Decision:** Connection methods are configured per Main–Device relationship as
ordered Transport Profiles. LAN, Omada VPN, Tailscale, Headscale, tunnels, and custom
networking are supported concepts. OpenDelegate will not build a relay or VPN in the
first release.

**Rationale:** The Owner may reach different Devices through different existing
private networks. Route selection should be deterministic and invisible to the LLM.

## D-007 — Discord Forum task identity

**Decision:** One approved Discord Forum post maps to one durable Task and context
boundary.

**Rationale:** Forum posts provide a natural task dashboard while replies provide a
familiar chat interface.

**Consequence:** Discord is a projection of Task state; the database remains
canonical.

## D-008 — Parent Task with multiple Workers

**Decision:** A Task is not pinned to one Device. Main may add, replace, and run
multiple Devices and agents in parallel while retaining one parent Task context.

## D-009 — Auto execution default

**Decision:** Clear, policy-compliant Tasks begin automatically. Planning approval is
not required for every Task.

**Consequence:** Main pauses only for material ambiguity, unavailable authority, or a
protected action.

## D-010 — Sticky coordinator provider

**Decision:** Each Task keeps the provider selected for its Coordinator Session.
Other providers join as Workers. Coordinator replacement occurs only after failure
or an explicit Owner request.

**Rationale:** Native session continuity is valuable for context and consistency.

## D-011 — Native session preference with durable fallback

**Decision:** Codex and Claude native sessions are resumed per Task or workstream
whenever available, but they are not the system of record.

**Rationale:** Provider sessions can expire, compact, become corrupt, or remain local
to one Device.

**Consequence:** OpenDelegate persists observable events, summaries, decisions,
pending work, session lineage, and artifacts.

## D-012 — Device Profile authority

**Decision:** Workers automatically update observed Facts and Capability evidence and
may propose Role or Instruction changes. Main may accept those semantic changes
autonomously. Workers cannot directly rewrite their durable Role or Instructions.
Only the Owner may relax Policy.

## D-013 — Device-local Knowledge

**Decision:** Knowledge is an ordinary local directory of linked Markdown files. It
is not a central graph database.

**Rationale:** It exists to make expensive-to-rediscover Device-specific information
available selectively to local agents without consuming context on every run.

**Consequence:** Main and other Devices do not receive Knowledge content or index
data.

## D-014 — Knowledge loss is acceptable

**Decision:** Knowledge is not automatically backed up, synchronized, or replicated.
Device failure may destroy it.

## D-015 — Autonomous Knowledge maintenance

**Decision:** A Worker may create or update Knowledge Markdown without a separate
user request when it learns durable, repeatedly useful, Device-specific information
that is expensive to rediscover.

**Consequence:** Transcripts, raw logs, and easily rediscovered facts do not qualify.
Index rebuilding is deterministic and does not require a separate LLM curation run.

## D-016 — Personal-first trust model

**Decision:** One Owner and one trust domain exist per Instance. Team multi-tenancy is
out of scope.

## D-017 — Device-local secrets

**Decision:** Credentials stay in the Secret Store of the Device that uses them. Main
knows only capability and availability metadata and does not distribute Secret
values.

## D-018 — Executable policy enforcement

**Decision:** Permission checks are implemented in deterministic code immediately
before execution, not only as agent instructions.

**Default automatic actions:** observation, logs, health checks, safe route fallback,
and restart of OpenDelegate-owned processes.

**Default protected actions:** OS network changes, VPN changes, firewall changes, and
Policy relaxation.

## D-019 — Package installation policy

**Decision:** Project dependencies and packages from already configured official
package managers may install automatically. Adding a repository, executing a remote
installer script, or installing an untrusted installer, driver, or kernel extension
requires approval.

## D-020 — Parallelism through resource locks

**Decision:** General agents may run in parallel. OpenDelegate does not impose a
global one-Run-per-Device rule.

**Consequence:** Agent-native worktree or sandbox isolation is reused where
available. `computer-use` requires a Device-wide `desktop-session` lock with capacity
one.

## D-021 — Artifact presentation and exposure

**Decision:** Results use native Discord UI when practical and an Artifact Gateway
when richer presentation is needed. Exposure is configurable as private-network,
authenticated, time-limited signed link, public, or custom.

**Default:** Private network plus authentication.

## D-022 — Admin Web scope

**Decision:** Discord is the primary Task conversation interface. Admin Web provides
configuration, Device and Run inspection, approvals, audit, artifacts, and emergency
controls. It is not a second complete chat product.

## D-023 — Configurable proactivity

**Decision:** Proactive behavior is configured by category through Reactive,
Assisted, and Autonomous profiles. The default is Assisted.

## D-024 — First-class agent adapters

**Decision:** Codex SDK and Claude Agent SDK are first-class programmatic adapters,
with their CLIs as fallback paths. A generic command adapter is an extension point.
Desktop apps are optional Computer Use capabilities, not core runner APIs.

## D-025 — First milestone breadth

**Decision:** The first milestone is not accepted as a narrow proof of concept. It
must satisfy the full end-to-end flow on macOS, Windows, and Linux and include
Computer Use on supported graphical sessions.

**Clarification:** A headless Linux NAS is allowed to report Computer Use as
unavailable; Linux support must still include a verified graphical Linux environment
for the Computer Use acceptance test.

## D-026 — Admin and report access flexibility

**Decision:** Network and artifact exposure mechanisms are harnessed as policies and
adapters rather than hard-coded. Owners may deliberately choose permissive exposure.

## D-027 — Database deployment

**Decision:** Main supports a zero-administration local database and a user-supplied
external database URI. Workers remain unaware of the selected database.

**Planned default:** Embedded SQLite for local personal use; PostgreSQL for an
external deployment. The implementation must prove equivalent domain behavior on
both.

## D-028 — Repository language and license

**Decision:** English is the default repository and UI language. The intended license
is Apache License 2.0.

## D-029 — Specification before implementation

**Decision:** Implementation does not begin until the detailed specification is
saved, reviewed, and explicitly approved. Future agents must read the canonical
documents so context compaction cannot erase decisions.

## D-030 — Separate daemon and desktop-helper planes

**Decision:** Each OS has an always-on daemon for control-plane work and a separate
logged-in user-session helper for Computer Use.

**Rationale:** Native Windows, macOS, and Linux service models do not make a boot
daemon equivalent to an interactive graphical session.

**Consequence:** Device health and desktop readiness are separate, and a headless or
logged-out Device remains useful for non-graphical work.

## D-031 — Single writer per native agent session

**Decision:** Many independent native sessions may run concurrently, but only one Run
may append to a particular Codex or Claude native session at a time.

**Rationale:** Concurrent resume can interleave provider transcript state and destroy
Task ordering.

## D-032 — Registered Device-local Workspaces

**Decision:** Code and file Work Orders target stable Workspace references. The
Worker resolves those references to local paths and owns worktree or sandbox
isolation.

**Rationale:** Absolute paths and workspace mechanics should not be improvised in
Main Agent context, and native session resume depends on a stable working directory.

## D-033 — Bounded automation

**Decision:** Auto Task execution and Autonomous proactive work remain bounded by
configurable duration, retry, Work Order, token, and cost limits.

**Rationale:** Automatic permission is not permission for unbounded loops or spend.

**Consequence:** Crossing a hard budget pauses or fails predictably and may request an
owner-approved extension.

## D-034 — Independent Admin authentication

**Decision:** Admin Web requires application authentication even on a private
network. Initial owner claim is local and external access cannot depend exclusively
on Discord availability.

**Rationale:** VPN membership is not sufficient application identity, and Discord
must not be a single recovery dependency.

## D-035 — Computer Use input authorization

**Decision:** Observation-only desktop evidence and active Computer Use input are
different executable action categories. Input requires an exact Task-scoped owner
grant or configured Policy grant; otherwise it pauses for approval.

**Rationale:** A click or keystroke can mutate arbitrary application state and must
not inherit the automatic allowance intended for read-only inspection.

**Consequence:** Owners may configure a more permissive durable Policy, but the
executor still matches the normalized action fingerprint immediately before input.
Once-scoped grants authorize execution only through an atomic consumption store;
stateless evaluation treats them as unavailable, and consumption state is durable
across restart.

## D-036 — Durable Run retirement

**Decision:** Main records an otherwise valid current Run as failed when its lease
has expired or its assigned Worker or route is no longer eligible. A later retry
must receive a distinct Run, lease, idempotency key, and higher fencing token.
Malformed, incorrectly scoped, or globally unverifiable orchestration state fails
closed without automatically retiring the assignment.

**Rationale:** Reusing a stale durable assignment can permanently wedge a Task, while
blanket retirement on internal validation failure could hide corruption or create
duplicate execution.

## D-037 — Idempotent Computer Use controller

**Decision:** Replaying one exact Computer Use start command returns the same
execution handle in one live backend; after restart, durable start history rejects
replay when that handle cannot be recovered. Missing or mismatched history fails
closed. It cannot construct an independent controller under the reused desktop
lease. Every mutating input revalidates the exact lease and fence after authorization
immediately before mutation.

**Rationale:** Lock idempotency alone does not make executor construction
idempotent, and authorization work may outlive or replace the lease it initially
checked.

## D-038 — Durable Resource Lock command outcomes

**Decision:** Resource Lock snapshots include the complete acquire-command ledger
and lease-renewal chains alongside active leases and per-resource fencing counters.
Restore rejects histories whose unique command outcomes do not cover every issued
fence, whose renewal chain is discontinuous, or whose active lease does not exactly
match the latest acquire-or-renew outcome. Each renewal has a durable command ID;
exact replay returns the recorded outcome and conflicting reuse is rejected.
Acquire time cannot move backward as fences increase. Restore derives the minimum
continuous occupancy proven by renewal and active-lease evidence, then rejects any
history in which a later acquire necessarily exceeded the configured capacity.

**Rationale:** Restoring only live leases allows a released or expired acquire
command to be mistaken for new work and issue a second lease after restart.
Comparing only to the initial acquire outcome also rejects legitimate renewals, while
trusting an unproven changed expiry can revive stale authority. Without an
idempotent renewal identity, a delayed duplicate heartbeat can silently extend
authority a second time.

## D-039 — External anti-rollback authority for Device resources

**Decision:** Resource Lock and Computer Use state are persisted in one
transactional record with a monotonically increasing generation. Restore uses
compare-and-set validation and accepts only the latest committed generation. One
exclusive Device service owns the desktop helper, and a helper or Main-side
high-watermark outside the application snapshot prevents an older coherent copy
from regaining input authority. Unverifiable authority fails closed; disaster
recovery explicitly advances the epoch before new Computer Use.

**Rationale:** Internal hashes can reject malformed or inconsistently paired
snapshots, but no self-contained snapshot can detect that every local record was
coherently rolled back. A non-rollback root and exclusive executor ownership are
therefore part of the safety boundary rather than optional operational hardening.

**Foundation status:** The in-memory Phase 1 seam validates internal histories,
mixed snapshot pairs, expiry across downtime, and exclusive capacity. It does not
provide the external monotonic store or OS service singleton, so coherent rollback
resistance remains unproven until the persistence and platform phases.
