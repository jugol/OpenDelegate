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

## D-040 — Isolated bundle assembly

**Decision:** Every platform bundle, including an unsupported internal preview,
requires a clean committed checkout and is assembled from an external disposable
snapshot with a frozen dependency install. Production deployment never runs against
the live source checkout. A minimal launcher exports the captured commit, and the
release logic and evidence auditor are re-executed from that immutable tool snapshot.
Snapshot bootstrap uses a separately downloaded, streaming-size-bounded pnpm archive
with a pinned SHA-512 rather than executable code from the checkout's ignored
dependency tree.

**Rationale:** pnpm's legacy deploy mode can rewrite ignored workspace state, and
live ignored, untracked, environment, or dependency files are not trustworthy
release inputs. A concurrent clean checkout transition must not let code from one
tree label a bundle as another tree.

**Consequence:** Local changes must be committed or removed before packaging.
Candidate-only A-to-B attestation restrictions still apply only to a supported
release candidate; an incomplete preview remains explicitly unsupported.

## D-041 — Explicit owner-facing localization

**Decision:** English remains the canonical repository, product, API, log, protocol,
and UI-default language. Admin Web and README documentation also provide Korean,
Japanese, French, Spanish, and Simplified Chinese presentation translations. With no
stored owner choice, Admin Web starts in English; it does not silently replace the
product default from browser preferences. A selector remains available before and
after authentication, and an explicit choice is persisted locally.

Admin Web translates deterministic product chrome, built-in state labels,
accessibility names, tooltips, metadata, and locale-sensitive dates at render time.
It does not machine-translate Device names, custom Roles, Task objectives, completion
criteria, constraints, or historical owner and Agent messages. Domain codes, API
fields, schemas, durable events, source identifiers, and logs stay English.

**Rationale:** Personal operation benefits from a familiar interface, while an
English canonical source keeps open-source collaboration and machine contracts
stable. Keeping dynamic content verbatim prevents semantic drift, cross-Task
contamination, and false claims that Agent output was authored in another language.

**Consequence:** Every supported locale must satisfy the complete English catalog,
language switching must update already-loaded views without a refetch or reload, and
desktop/mobile browser tests must cover text expansion, CJK typography,
accessibility, persistence, and owner-content preservation.

## D-042 — Provider-native sessions through programmatic adapters

**Decision:** Codex App Server and Claude Agent SDK are the first-class session
surfaces. Each Task workstream keeps its own provider-native session, while
OpenDelegate remains authoritative for durable state, capabilities, action Policy,
and execution lifecycle. CLI adapters are reduced-capability fallbacks, not the
source of truth.

Main coordinator turns are reasoning-only. Worker turns may use explicitly composed
tools, but protected provider actions cross an exact, durable OpenDelegate
authorization boundary immediately before execution. Device-local Knowledge calls
remain inside the Device capability boundary and never require their inputs to be
presented to Main.

**Rationale:** Native sessions preserve useful provider context without merging
unrelated Tasks or surrendering orchestration and permission enforcement to a
vendor UI.

**Consequence:** Provider compatibility is version-pinned and fail-closed.
The owner's existing provider home is the default under D-076; an explicitly
selected home follows D-049 and D-052, and an OpenDelegate-owned home remains
available for owners who want provider settings isolated.
Native Windows Claude SDK execution is not advertised until its required sandbox is
enforceable; Codex, WSL2, or a configured container is used instead.

## D-043 — Asymmetric trust between core and owner-session helper

**Decision:** ADR-0011 production IPC uses separate Ed25519 identities for the core
service and logged-in owner helper. Each private key remains in that plane's
OS-scoped Secret Store; configuration pins only the peer SPKI and key ID. Both sides
sign a nonce-, transcript-, release-, session-, and service-epoch-bound handshake,
and every capability frame is independently signed and sequenced. Legacy
single-Secret `helperIpc` configuration fails closed.

**Rationale:** A shared HMAC key would need to be readable by two intentionally
separate OS identities. Compromise of either plane would therefore disclose the
other plane's bearer authenticator and undermine the two-plane boundary.

**Consequence:** Enrollment and rotation provision two keys and explicitly update
peer pins. OS endpoint ACLs remain defense in depth, while signature verification is
the application authentication decision. A missing helper key removes graphical
readiness without taking down the headless core.

## D-044 — Durable Main-authoritative Worker Run lease renewal

**Decision:** A current Worker Run may extend its lease only through an exact,
durable renewal command decided by Main. The command binds the complete Task, Work
Order, Device, Worker, route, Run, lease, fencing token, renewal ID, and prior
expiry. Exact replay returns the recorded outcome; concurrent, stale, late,
mismatched, or terminal renewal attempts are rejected and cannot resurrect a Run.
Main's clock is authoritative for the decision and every successful renewal grants
one configured lease duration from the decision time.

Worker calibrates Main wall time during every Device-channel handshake, converts
Main expiries to conservative monotonic deadlines, and renews before
`max(30 seconds, 20% of the lease duration)`. The calibration rejects handshake RTT
above 5 seconds or absolute clock uncertainty above 60 seconds. Renewal retry is
bounded exponential backoff with jitter and never crosses the current conservative
deadline. A wall-clock jump or regression beyond the calibrated threshold fails
closed. Disconnect does not revoke a still-current local lease, but prevents
renewal; reconnect requires fresh calibration before dispatch or a durable renewal
response is applied.

**Rationale:** Fixed five-minute Run authority interrupts valid long-running work,
while trusting Worker wall time, refreshing implicitly on heartbeat, or treating a
reconnect as authority can extend stale execution or create split-brain side
effects.

**Consequence:** Artifact, device-local Knowledge, platform mutation, Computer Use,
and protected action authorization resolve the current lease dynamically while
preserving immutable Run identity and fencing. A capability claimed before renewal
may continue under the renewed expiry, but any identity change, expiry regression,
Main rejection, or conservative deadline loss revokes it fail-closed.

## D-045 — Security-current macOS release target

**Decision:** The first-milestone Apple-silicon target advances from macOS Tahoe
26.5.1 to 26.5.2, the current generally available security release when the
release-readiness audit was performed. Prior fixture or hosted-CI results remain
engineering evidence only and do not carry live support proof to the new patch.

**Rationale:** The support matrix must not direct owners to validate a superseded
security patch when no release-bound live evidence has yet been collected.

**Consequence:** The macOS platform lab, signing/notarization run, native service
lifecycle, provider, networking, and Computer Use evidence must all record 26.5.2
and its exact build. A later patch requires the same explicit matrix decision and
fresh affected evidence.

## D-046 — Immutable Worker Agent requirements and safe session observations

**Decision:** A Work Order may require one Agent provider and may additionally name
an exact adapter ID and a non-empty allowed compatibility set. Main copies that
requirement into the immutable Worker Run assignment and preserves it through
dispatch retry and restart. Device-level Auto selection is used only when the
assignment has no Agent requirement. A required binding that is absent, unready,
incompatible with the assignment policy, or blocked by stricter Device policy fails
closed; Worker never substitutes another provider or adapter.

Terminal Worker events may carry a safe actual session observation consisting of
provider, adapter ID and version, native session ID, workstream ID, Workspace ID,
and lineage. Main validates it against the assignment and persists it in the
accepted event and authoritative report. Device-local cwd, worktree path, and
session key never cross this boundary.

**Rationale:** Capability-only scheduling cannot prove which installed native
provider actually executed a Work Order, and Device Auto could otherwise silently
change provider context. Durable, bounded lineage is also required for trustworthy
restart replay and future checkpoint continuation without uploading local execution
paths.

**Consequence:** Omitting an allowed compatibility set means tested-only. Allowing
compatible or untested versions is explicit in the assignment and remains subject
to stricter Device policy. A successful provider-bound Run without a matching safe
session observation is invalid.

**Amendment (2026-07-29):** D-067 refines the assignment shape without mutating the
Work Order. Main preserves the Work Order's original hard Agent requirement inside
the assignment and records a separate exact effective binding that satisfies and may
narrow it. Device-level `Auto` applies only when that original requirement is absent;
retry and restart preserve both values.

## D-047 — Immutable candidates and externally trusted release promotion

**Decision:** Platform-native code signing occurs before candidate integrity
manifests are generated. The candidate payload, archive, acceptance ledger, and
enclosed `release-candidate` identity are never rewritten during promotion. The
exact final macOS archive is notarized only after its manifests and detached
publisher attestation exist; the accepted notarization result remains an external
sidecar and is not stapled into the candidate.

One detached publisher attestation authenticates each target candidate. A separate
cross-platform promotion attestation and supported-channel release receipt are
verified through a distinct external promotion trust root. Before that receipt is
created, exactly three target-scoped remote read-back observations—one per supported
target—must verify as signed envelopes against a separately provisioned observer
trust root. The observer authority is distinct from all publisher and
promotion/uploader authorities and has its own revocation set. The read-back plan
binds its uploader authorization to the promotion key ID rather than inventing a
fourth release-signing role. `released` is the effective result of that complete
external trust calculation, never a filename, embedded field, environment
variable, Git tag, or self-signature.

**Rationale:** Native signatures mutate executable bytes, while support eligibility
depends on one immutable candidate set and the complete three-platform evidence
matrix. Separate publisher and promotion authorities prevent a valid per-bundle
signature from silently becoming a support claim. Independently signed read-back
observations prevent the publishing authority from self-asserting that all target
bytes were retrieved unchanged.

**Consequence:** Previews and CI self-signatures are never support eligible.
Credential-bearing signing, notarization, promotion, and publication tools run only
from clean committed, hash-pinned runners. Actual platform identities, Devices,
Discord and provider credentials, notarization, and live proof remain external
release blockers until their exact evidence is recorded. Configured release policy
can revoke observer identities independently of publisher and promotion keys,
platform identities, and promotion or receipt statement IDs.

## D-048 — Live Discord binding replacement under owner Approval

**Decision:** Discord binding is a nullable, Main-scoped Configuration value named
`discord.binding`. It contains only the bot-token alias and the complete non-secret
Forum binding; the credential remains in Main's managed Secret Store. After
bootstrap, durable Configuration is authoritative and the owner may add, extend,
replace, or disable the binding through Configuration Chat and the normal protected
Approval flow without re-running `init`.

Main owns exactly one serialized Discord Gateway lifecycle. Before committing an
approved change, it validates the candidate value, verifies that its credential
alias carries an explicit Discord-bot-token capability and is currently available,
and composes the candidate runtime. It then closes the previous Gateway, activates
the candidate, and commits the matching durable Configuration while holding the
lifecycle lock. A new candidate must complete `start()` and still report Discord
`READY` within a bounded activation window; a stale ready observation or merely
entering a starting or reconnecting state is not enough. Candidate activation or
Configuration commit failure restores the previous binding. A disabled binding is
represented by explicit `null`, never an unset key or a second runtime mode.
Initial durable Configuration always records an explicit binding or `null`, so
the first-init alias capability is recorded once in the durable secure-ingest
ledger and later bootstrap-file edits cannot authorize another alias or bypass
Approval. The activation bound covers capability lookup, runtime composition,
`start()`, and current `READY`; a runtime factory that resolves after cancellation
must be closed before shutdown can report success. Main rechecks `READY` after the
durable apply and before finalizing the prepared lifecycle transition; losing it
causes durable compensation and runtime rollback. Authoritative startup and
rollback retain a retry runtime through temporary Discord or Secret Store
unavailability, while shutdown or singleton-ownership loss cancels startup,
restoration, and queued replacement work before control-plane drain. Aborted
prepared transitions release their lifecycle lock and reject any late commit.
Discord binding Approvals are high-risk Main-targeted actions.

**Rationale:** Treating Discord as first-init-only makes an ordinary token, bot,
Guild, or Forum change require reinitializing the fixed Main Device. Starting old
and new Gateways concurrently risks duplicate ingestion, while committing the new
binding before it can run can strand the owner without the primary Task surface.

**Consequence:** Existing Tasks, event history, Work Orders, and provider-native
sessions survive a binding change because Main remains authoritative. External
Discord thread identifiers are not silently migrated across Forums; new posts
create new Tasks under the new binding. Failed candidates leave the prior
credential and binding available for rollback, and Configuration Chat never
receives or persists the raw bot token.

## D-049 — Explicit shared Codex home

**Decision:** *Superseded in part by [D-076](#d-076--the-owners-existing-provider-home-is-the-default),
which makes the owner's existing home the default; the mechanism below is unchanged.*
Main and Worker accept an existing absolute local Codex home through `--codex-home`. OpenDelegate persists that exact path as non-secret configuration,
passes it as `CODEX_HOME`, and never discovers, copies, or silently inherits a
global home.

Codex does not expose a separate authentication-home selector. Selecting an
external home therefore shares its authentication, settings, plugins, caches, and
provider-native session storage with other local Codex consumers. OpenDelegate
still keys every Task workstream to its own native session and remains authoritative
for Task state, permissions, leases, and lifecycle.

**Rationale:** A personal Device may already maintain one intentional Codex source
of truth for services such as an Agent gateway. Requiring another interactive login
creates independent refresh state and avoidable credential drift. Implicit ambient
inheritance would be surprising and would silently import provider behavior, so
sharing must be explicit and durable.

**Consequence:** The external home becomes trusted Device configuration and must be
an owner-restricted local directory outside the source checkout. Logging out,
rotating authentication, or changing Codex configuration affects every local
consumer of that home. Owners who want stronger settings and session isolation keep
the default managed home. Claude follows the same default.

## D-050 — Ten-character owner passphrase floor

**Decision:** Initial owner claim, normal Admin login, and recovery accept an owner
passphrase containing at least 10 Unicode code points, including at least one
non-whitespace code point, and at most 1024 UTF-8 bytes. The auth module is the
authoritative validator; user-facing forms do not substitute UTF-16 browser length
rules for that boundary.

**Rationale:** OpenDelegate is a personal local-first system, and the Owner chose a
more accommodating minimum while retaining Argon2id hashing, rate limiting, local
claim, independent recovery codes, and the option to use a longer generated
passphrase.

**Consequence:** A non-blank 10-code-point passphrase is valid for claim, login, and
recovery; nine or fewer code points fail before password hashing.

## D-051 — Deterministic local Device assessment before configuration advice

**Decision:** Admin Web exposes an authenticated, on-demand assessment for the fixed
Main Device. Main probes both supported local Agent Adapters, browser automation,
Computer Use readiness, and local Knowledge health without invoking an LLM. The
bounded result is stored as an attributable, idempotency-bound event in Main's
existing event store and is restored across restart. It does not masquerade as a
Worker heartbeat or replace Worker runtime/load state. Configuration Chat receives
a non-secret projection of that observation as authoritative context, but has no
assessment tool and must not claim that it ran the probes.

Worker capability assessment continues through the authenticated Worker heartbeat;
Main does not pretend that a local button can execute arbitrary probes on a remote
Worker. Provider authentication remains Device-local. Admin guidance names the
selected-init-provider boundary, explicit shared Codex and Claude home options,
their managed-profile alternatives, and the prohibition on pasting provider
credentials into chat.

**Rationale:** Asking an LLM to guess installed tools wastes context and can produce
false capability claims. The previous unassessed chat copy also implied an action
the Configuration Agent could not perform. A deterministic probe is cheaper,
durable, and auditable, while the Agent remains useful for explaining the result
and proposing Roles or Instructions.

**Consequence:** The local Main assessment is explicit and refreshable; failed probes
do not erase the last durable observation. Browser automation and Computer Use
remain unavailable until an authenticated Worker observation or an equally strong
explicit probe proves them. No Knowledge content, credential, provider output, or
local path enters Main metadata or Configuration Chat.

## D-052 — Explicit shared Claude home

**Decision:** *Superseded in part by [D-076](#d-076--the-owners-existing-provider-home-is-the-default),
which makes the owner's existing home the default; the mechanism below is unchanged.*
Main may receive an existing absolute local Claude configuration
directory through `--claude-home`. OpenDelegate persists only that path, supplies it
as `CLAUDE_CONFIG_DIR`, and uses it for both the Claude Adapter and deterministic
Device assessment. It never copies, links, discovers, or stores Claude credentials.
The shared Claude home may be configured while Codex remains the selected Main
Agent so that both installed Adapters are assessed accurately.

If `claude auth status --json` is not ready in that exact directory, setup instructs
the Owner to run `claude auth login` with the same `CLAUDE_CONFIG_DIR` and reassess.
The default is the owner's existing home per D-076; the managed home remains the
fallback when no owner home can be resolved.

**Rationale:** A personal NAS may intentionally maintain one Claude authentication
source of truth. Probing an unrelated managed home incorrectly reports a healthy
local Claude installation as degraded and creates unnecessary duplicate login
state.

**Consequence:** Authentication rotation, logout, settings, hooks, plugins, caches,
and provider-native sessions in that external directory are shared with its other
local consumers. The directory must be owner-restricted and outside the source
checkout. OpenDelegate still owns Task isolation, policy, session leases, and
orchestration state.

## D-053 — Non-disruptive bundle verification and supervisor-owned activation

**Decision:** Bundle assembly and bundle activation are separate operations.
Packaged smoke must use temporary state and an isolated dynamically selected
adjacent loopback listener pair, with bounded fresh-pair retry if another local
process claims the pair during startup handoff. It must not claim the configured
Main listener, stop or restart an installed Main, edit its service definition, or
change its active release pointer.

An assembled bundle becomes active only through an explicit foreground launch or
the native service lifecycle. Persistent installations use journaled
`service install` or `service upgrade` with the exact active version, a
caller-stable command ID, bounded health verification, and rollback. A transient
supervisor invocation is a validation wrapper, not an installed service; stopping
it may remove the supervisor registration as well as the process.

**Rationale:** Release construction must be safe on the fixed Main Device while it
is serving Admin, Worker, and orchestration traffic. Fixed smoke ports previously
forced an operator to stop Main, and a transient systemd unit then disappeared
when stopped. Conflating construction, process supervision, and activation turns a
recoverable validation step into an avoidable outage.

**Consequence:** A release build must coexist with an already occupied default Main
and claim-listener pair. Build failure leaves the installed version and supervisor
untouched. Agents must inspect the existing lifecycle before activation, use the
packaged structured CLI rather than interpolated remote shell mutations, and
describe foreground or transient preview runs as non-persistent validation only.

## D-054 — Contextual guided setup before secure credential intake

**Decision:** Configuration Chat does not render a generic credential chooser or a
database URI field when it opens. On the fixed Main Device it first presents explicit
guided setup goals. Embedded SQLite is described as the already-active default that
needs no URI. External PostgreSQL is an owner-selected advanced path, and its secure
URI form appears only after that selection.

The Discord goal asks the Configuration Agent to inspect the current binding before
guiding the owner through the Discord Developer Portal, bot, Community Server,
Forum, intents, permissions, and missing non-secret identifiers. The raw bot token
is accepted only by Main's secure intake form. The Agent then uses the existing typed
configuration proposal, protected Approval, live activation validation, and rollback
flow. Browser-only Discord actions remain explicit owner actions. The guide assumes
no previous bot setup experience, explains the Forum-post-to-Task result and Discord
terms before raw fields, and covers only missing stages, including installation into
the selected server and Forum-access verification. It presents a brief roadmap, then
names where to go, what to do, why it is needed, how to verify completion, and what
non-secret value to return only for the current stage. It waits for owner confirmation
before advancing and keeps one clear next action visible.

**Rationale:** An unsolicited `Database URI` password field made the embedded
database look incomplete and separated credentials from the reason they were
needed. A generic secret form also failed to teach the owner which Discord-side
dependencies precede a token or which steps OpenDelegate can complete itself.

**Consequence:** Worker-specific Configuration Chats never offer Main-service
credentials. Selecting a goal may create an ordinary, localized owner message in
that Device's dedicated configuration session, but secret material still bypasses
the transcript and only an opaque reference reaches the Agent. Storing a PostgreSQL
URI or proposing database configuration does not claim to migrate the live database;
the supported backup/restore and service reconfiguration path remains required.

## D-055 — Agent-returned setup actions belong to their conversation message

**Decision:** D-054's fixed guided-goal surface is superseded. Configuration Chat
does not render a persistent setup menu below the transcript. A Configuration Agent
final response may attach up to four unique actions from a closed protocol allowlist:
guide Discord, guide external PostgreSQL, ingest a Discord bot token securely, or
ingest a database URI securely. Admin Web renders those actions inside the exact
Agent message that returned them.

Guide actions create an ordinary localized owner message in the same Device
configuration session. A secure-ingest action reveals its form inline only after the
Agent has explained why that credential is the next missing value. The resulting raw
Secret still bypasses the transcript, SQL, and Agent context; only its opaque managed
reference continues through the conversation. Suggested actions are presentation
metadata, not executable configuration, mutation evidence, or durable receipts.

**Rationale:** A fixed setup panel looked like disconnected application chrome and
made options appear before the Agent had assessed the owner's intent or current
state. Returning a narrow UI suggestion with the Agent's response preserves
conversational context without allowing arbitrary Agent-authored components, URLs,
commands, or actions.

**Consequence:** Existing persisted Configuration Agent responses without
suggestions remain valid. Unknown, duplicate, or excessive actions fail closed at
the protocol and browser boundaries. Main-service actions are never offered in a
Worker Configuration Chat. Discord prerequisites, SQLite-as-default guidance,
protected Approval, live activation validation, and rollback retain the behavior
defined by D-054.

## D-056 — First-time Discord guidance starts from exact runtime state

**Decision:** When Main's public runtime feature reports the exact
`DISCORD_NOT_CONFIGURED` code and the Configuration Agent is ready, the first opening
of the Main Device's Configuration Chat in a browser session automatically submits
the localized Discord guided-setup request to that Device's existing configuration
session. The transcript first shows a deterministic Agent-status message explaining
that OpenDelegate is inspecting the current binding. The actual guidance and any
typed action suggestions are returned by the Configuration Agent and rendered inside
its response as required by D-055.

The browser records a successful onboarding turn in session storage, scoped to the
Main Device, so closing, reopening, or reloading the same browser session does not
spend another Agent turn. A failed turn is not recorded as complete. This marker is
presentation state only; Main's runtime code remains authoritative.

**Rationale:** A new owner should not need to guess the first prompt or already know
that Discord Forum is the intended Task inbox. Triggering from an exact deterministic
runtime state provides discoverability without restoring a permanent setup menu or
asking an LLM to infer whether Discord is configured.

**Consequence:** A configured Discord runtime that is starting, reconnecting,
degraded, stopped, or unavailable never receives first-time onboarding merely because
its status is not ready. Workers never initiate this Main-service flow. Raw tokens
still enter only through secure intake after the Agent identifies them as the next
missing value.

## D-057 — Readable Configuration Agent responses and transient unread state

**Decision:** Configuration Chat preserves Agent-authored paragraph boundaries and
converts line-oriented numbered or bulleted steps into semantic lists. It does not
interpret arbitrary HTML or provide a general Agent-authored component surface.
The active Device conversation remains mounted while the owner navigates between
Admin sections so an in-flight response is not discarded merely because its drawer
closed.

When an Agent response or bounded system failure arrives while Configuration Chat is
closed or the Admin page is hidden, Admin Web records a transient unread count. The
closed launcher exposes that state through a numeric badge, a localized visible
summary, and an accessible live status. Opening the chat marks the count read; a
visible open chat is already the notification surface. Unread state is browser
presentation state, not durable configuration or orchestration state.

While a native Configuration Agent turn is pending, the transcript renders a
localized Agent activity message in the same visual position where the response will
arrive. Animated dots supplement visible text and respect reduced-motion policy.
Secret intake does not claim that the Agent is responding until secure storage has
completed and the follow-up Agent turn actually begins.

**Rationale:** Collapsing line breaks turns a detailed onboarding response into one
dense paragraph. A long native Agent turn can also finish after the owner closes the
drawer or moves to another Admin section, where a silent launcher gives no indication
that guidance is ready.

**Consequence:** Agent content remains plain, safely escaped React text while gaining
paragraph and list structure. Unread presentation never creates a Task event, sends
an external notification, or changes Agent session semantics. Switching or reloading
Devices may reset this transient indicator. Completed Device-scoped conversation
history is durable Main state and is independent from the transient unread count.

## D-058 — Configuration continuation before tool execution

**Partially superseded by D-071:** the fail-closed boundary now distinguishes
read-only tools from mutation-capable tools.

**Decision:** If the initial native resume for one Configuration Agent request fails
with the public unavailable condition before any typed configuration tool for that
request has executed, Main retries that same complete current prompt by starting a
fresh native session. The new native reference is appended to the existing
Device-scoped configuration-session lineage. Main does not perform this automatic
continuation after the request has reached a typed tool. Before executing the first
typed tool, Main writes a durable request-bound attempt marker. If that request has no
final response after interruption, later replay fails closed, including after Main
restart. Configuration Chat is not a Task, so FR-9's Task Brief and Work Order
checkpoint package does not apply; the recovered Agent discloses that chat-only
or interrupted in-flight context may be missing, receives a bounded excerpt of
completed durable Device-scoped exchanges, re-inspects durable configuration, and
re-confirms any required value or choice absent from that excerpt before proposing a
change.

**Rationale:** A provider process can be interrupted while its native thread still
appears resumable but refuses the next turn. Failing every later Configuration Chat
message leaves deterministic configuration intact but makes recovery impossible.
Before the first tool request, replaying the current prompt cannot duplicate a
configuration mutation; after a tool request, that guarantee no longer holds. The
durable boundary prevents a process restart from accidentally resetting this safety
decision.

**Consequence:** The owner may lose detail held only in the unavailable provider
session or an interrupted unfinished turn. Completed visible exchanges survive Main
restart, restore in Admin Web, and enter a bounded recovery excerpt alongside the
complete current owner request, current Device observation, configuration protocol,
and safety rules. Durable configuration and receipts remain authoritative. A failure
after the durable tool boundary stays failed and requires a new owner request after
inspecting current configuration; the interrupted request itself is never replayed.

## D-059 — Outcome-oriented orchestration and bounded Owner Handoff

**Decision:** OpenDelegate accepts Tasks as desired outcomes, not placement plans.
Main infers capability and operating-system requirements, decomposes work across
heterogeneous Devices when useful, and delegates actual Device and route selection to
deterministic eligibility and scheduling. Main does not ask the owner to choose a
Device, OS, Transport Profile, Agent provider, or multi-Device split unless that
choice changes the intended outcome or cannot be derived from durable owner
configuration. Actual assignments remain visible in Admin Web and audit.

Results may be returned as Discord-native text or attachments, files, Artifacts,
hosted views, or Git references, but every completion claim remains grounded in an
authoritative Worker report. If login, MFA, CAPTCHA, legal confirmation, OS
permission, or another irreducibly human step blocks work, the current Task enters
`waiting_user` and may expose one Main-mediated Owner Handoff. A handoff uses an
isolated interactive Artifact or configured remote-session gateway, follows an
explicit exposure policy, is time-bounded, revocable, and audited, and contains no
credential or raw Worker VNC/browser-debug endpoint in Discord or Agent context.
After the owner returns control in the same Task, OpenDelegate resumes durable
execution and the existing native-session lineage where possible.

**Rationale:** The product's value is freedom from physical placement, not a prettier
way to remote-control several computers. Requiring the owner to plan Windows,
macOS, Linux, provider, or network handoffs would merely move orchestration into
Discord. Some identity, consent, legal, and operating-system boundaries still require
a person; making that pause explicit preserves security while keeping the Task
continuous.

**Consequence:** Device placement is observable output rather than routine user
input. A fixed Main must still remain online; this decision does not add Main
failover. The existing isolated interactive Artifact path is the first handoff
surface. A VNC-like or browser-session gateway is an adapter behind Main and is not
claimed as implemented until its expiry, revocation, audit, secret-isolation, and
cross-network acceptance evidence passes. ADR-0023 defines the explicit Task record,
trust, return, and gateway extension boundary; interactive presentation alone is not
a Handoff.

## D-060 — Placement questions are semantic, not lexically forbidden

**Decision:** Device placement remains an internal orchestration choice by default,
but Main may ask when placement changes privacy, data locality, cost, physical or
interactive access, licensed-software availability, where a result may remain, or
another owner-visible outcome that durable configuration cannot decide. Result
validation enforces the shape and bound of one owner question; it does not reject
sentences merely because they mention a Device, OS, or Worker.

**Rationale:** A multilingual word-pattern filter cannot distinguish orchestration
avoidance from a legitimate outcome choice. Prompt policy and durable owner
preferences carry that semantic rule more accurately than a lexical parser.

**Consequence:** Routine scheduling stays invisible to the owner, while a legitimate
placement-dependent decision is not accidentally suppressed. Audit and Agent
evaluation should flag repeated unnecessary placement questions as a quality issue,
not misclassify them as a malformed protocol response.

## D-061 — Configuration Approval execution and conversation recovery are deterministic

**Decision:** Completed Configuration Chat exchanges are durable, Device-and-Adapter-
scoped Main events and are restored independently of the provider-native session.
Applying a
protected proposal uses one durable Approval request identity derived from the target
Device plus immutable proposal ID, while each chat tool execution keeps its
request-bound replay identity. Owner approval executes the exact protected operation
immediately; a follow-up chat request for the same proposal observes the existing
Approval instead of requesting another one.

**Rationale:** Provider sessions can disappear across process failure, while chat
message idempotency keys necessarily change for each owner message. Basing protected
operation identity on the chat turn caused “approval complete” follow-ups to create
an endless sequence of new Approval IDs even though every one described the same
proposal.

**Consequence:** Main can recover completed conversational context without replaying
provider-hidden work, and one target Device plus immutable proposal has one Approval
record even when later chat messages use new tool operation IDs. The Agent inspects
durable configuration after approval. An Approval whose execution failed remains
visible as failed and is diagnosed; it is not silently replaced with a fresh Approval
or confused with a compensated historical receipt.

## D-062 — Proactive signals enter the ordinary Task path

**Decision:** A proactive category inherits its profile or explicitly selects
disabled, propose, or execute. A bounded monitor or system-incident signal under
propose creates one idempotent manual-review Task; execute creates one idempotent auto
Task. Existing Task coordination processes it. When Discord is ready, Main creates
one bot-authored post in the first configured Forum, durably binds it to the Task, and
uses the normal Forum projection thereafter. An uncertain Forum-create result is
reconciled from deterministic Task markers across active and archived posts before
retry.

FR-4's bounded, tool-denied, Task-independent diagnostic Agent remains an explicit
read-only exception after deterministic transport recovery is exhausted. Its result
may be the system-incident signal for an ordinary recovery Task; it cannot perform
the repair outside that Task.

**Rationale:** A direct monitor-to-Agent repair path would create hidden mutation with
different authorization and accounting. Treating remedial work as an ordinary Task
preserves the same observable unit the owner already understands. An internally
originated Task also needs an outbound Forum binding because Discord can project only
Tasks already associated with a thread.

**Consequence:** Deterministic monitoring spends no continuous LLM context and
remedial work never bypasses Policy, approvals, budgets, locks, audit, Secret
boundaries, or Task session isolation. The narrow FR-4 diagnostic may spend one
bounded read-only Agent turn before Task origin. Discord automatically presents
originated work when a Forum binding is ready; Admin remains authoritative when
Discord is unavailable. The first configured Forum is the deterministic default
until explicit category routing is added.

## D-063 — Accepted Configuration messages survive an in-flight reload

**Decision:** Main records an owner Configuration Chat message as a durable,
Device-and-Adapter-scoped event before it starts or resumes the corresponding native
Agent turn. The eventual Agent response is a separate terminal event correlated by
the immutable request operation key. Conversation projection supports both these
events and the legacy completed-exchange event without duplicating messages.

While the original Main process still owns the request, the history projection marks
the accepted owner message as pending. Admin Web restores it after reload, renders
the ordinary Agent activity state, and polls the bounded history endpoint until the
terminal response appears. An accepted message with no terminal response and no live
request owner is rendered as interrupted rather than remaining pending forever.

**Rationale:** Persisting the owner message only after a potentially long Agent turn
made a reload look like data loss. The message disappeared until the Agent completed,
and a failed or interrupted turn could erase the only visible copy entirely.
Optimistic browser state is not an acceptable durability boundary.

**Consequence:** A browser disconnect cannot erase an accepted message. Agent failure
does not remove the owner's context, and a later recovery can include that visible
owner message without treating an unfinished response as a verified completion.
Secrets remain subject to pre-acceptance rejection and secure intake, and the first
typed-tool marker remains the mutation replay boundary defined by D-058.

## D-064 — Discord workflow state is bot-owned and current feedback is chronological

**Decision:** An owner-created post in an approved Discord Forum starts exactly one
Task without an owner-applied Intake tag. Workflow tags are bot-owned projections.
Discord may omit `applied_tags` entirely for a thread with no tags; the wire boundary
normalizes only that absent field to an empty tag set while continuing to reject
null, malformed, oversized, or non-Snowflake tag data.
Discord REST message responses may likewise omit their otherwise-known `guild_id`.
The HTTP port supplies its configured Guild ID only when that field is absent and
rejects any present mismatched or malformed Guild ID; Gateway messages remain
self-identifying.
When Gateway events arrive before a new thread or starter message is readable over
Discord HTTP, the Adapter does not advance its durable or in-connection processed
cursor. Gateway Resume replays the dispatch under bounded reconnect backoff, while
the ordinary reconnect reconciliation path provides a second idempotent recovery
surface.

Each accepted owner message enqueues one idempotent ordinary working acknowledgement
near the latest conversation position with applicable Task controls. A failure
update preserves its owner-safe concrete cause or exhausted resource and places the
Retry control on that chronological failure message. The stable starter status panel
remains a compact dashboard, but it is not the sole actionable surface. Interactions
from these chronological messages are accepted only when the authoritative Discord
interaction payload identifies the configured bot as the source message author.

**Rationale:** Requiring a manually applied Intake tag inverted the projection model
and made a valid post appear inert. Editing only the starter panel hid activity and
recovery controls above long conversations. Replacing concrete scheduling or
executor evidence with a generic attention sentence made failures impossible to
diagnose. Restricting interactions to one stored panel message prevented safe
controls on later bot-authored updates.

**Consequence:** Normal Forum use requires no tag knowledge. Transient Discord
resource-visibility races recover without a continuous full reconciliation scan.
Owners receive one durable acknowledgement per accepted message rather than
heartbeat spam, and actionable failures stay next to their explanation. Forged
controls on owner or webhook messages remain inert, while controls on any message
authored by the configured bot can use the existing idempotent command path.

The ordinary working-card portion of this decision is superseded by D-065. The
tagless intake, visibility-race recovery, concrete failure, and bot-authored control
decisions remain current.

## D-065 — One Discord owner message has one visible turn lifecycle

**Decision:** One accepted owner message is acknowledged on that exact Discord
message with a best-effort `👀` reaction and typing refreshed while work remains
active. Once a durable question, result, or failure is delivered, that exact message
transitions to `✅` or `❌`. It does not create a generic ordinary working card. The
stable Task panel is a neutral dashboard projection: it shows state and durable
references but does not repeat the Forum title, the chronological owner-question
body, or mutable Task controls. Questions, decisions, failures, and final results
remain single ordinary replies at their chronological point, keyed by immutable
Task source-event identity. An owner answer edits the existing question message into
a control-free receipt before Task continuation.
Existing full-projection outbox identities are adopted as aliases for the matching
Task source event during upgrade. If a prior interrupted upgrade already produced
multiple copies of that event's question, one accepted answer resolves every copy
rather than leaving an older prompt active.

The semantic plan identity is the owner-input execution-cycle identity, not the
automatic-attempt identity. Deterministic Worker/resource retries in that cycle load
the first durable plan instead of asking the Main Agent to reinterpret the same
owner turn. A new accepted owner input creates a new cycle and may legitimately
produce a new plan.

**Rationale:** A generic working card, the stable panel, and a chronological question
were three independent delivery paths rendering one turn. Attempt-scoped planning
then allowed a transient Worker-selection failure to re-enter the native Agent
session and recover an older question. The combined behavior produced the duplicate
cards and repeated question visible to the owner.

**Consequence:** Immediate activity remains visible beside the newest owner message
without growing the transcript, and stale `👀` or question controls do not survive a
terminal turn. The status panel and the conversation no longer compete as copies of
one prompt. Restart and retry preserve one interpretation of an owner turn, while
significant results and actionable failures remain durable and near the bottom of a
long Forum post.

## D-066 — Main may answer bounded read-only orchestration questions directly

**Decision:** Before semantic planning, deterministic Main code may recognize a
deliberately narrow Device-directory question and read an owner-safe projection of
Main-owned Device state containing identity, display name, OS family,
runtime/connection state, service supervision mode, last observation time, Roles,
verified capability names, route health, and bounded capacity. The narrow grammar
includes fleet-list questions, uniquely matched named-Device reachability questions,
and a registered-route follow-up for that named Device. It excludes Secrets, Device
Instructions, Knowledge, private
transcripts, local paths, Policy internals, and unverified capability claims.

The deterministic path formats the answer without an LLM and mints authority for
that exact decision, Task, and planning key. The authoritative executor rejects a
planner's `completed` decision unless the trusted direct-completion authorizer
recognizes it. A requested action, compound side-effect objective, selected external
input, external lookup, file or system change, browser operation, or claim of
execution must still become one or more Work Orders and can complete only from
authoritative Worker evidence.

The bounded generic-objective allowlist supports accepted locale code switching,
including Korean-English test placeholders, before applying an exact latest owner
query. A trusted deterministic answer is evaluated before a cached semantic plan so
an upgraded classifier can recover a previously misplanned read-only Task through
Retry. When the deterministic path does not mint an answer, the cached owner-cycle
plan remains unchanged and retry-stable.

**Rationale:** Asking which Devices are currently reachable is a query against state
Main already owns. Dispatching an invented `device_inventory_read` Work Order to an
offline Worker both wastes a Run and can fail to answer the very availability
question being asked.

**Consequence:** A routine Device availability question consumes neither a model
turn nor a Worker Run. Main coordinator turns remain tool-denied under D-042.
Side-effect authority, Worker leases, Policy, and evidence requirements are
unchanged, and custom planners cannot forge the read-only exception by echoing a
schema or completion criteria.

## D-067 — Agent Adapter and exact model selection are typed Device profiles

**Decision:** OpenDelegate represents an execution choice as an Agent Binding:
provider, exact adapter identity when required, exact provider-native model ID, and
optional provider tuning. Every Worker-capable Device, including Main's co-located
Worker, owns a Worker Agent Execution Profile. Main separately owns a Coordinator
profile. Profiles support `Auto`, `Prefer`, and `Pinned`. `Prefer` may use only its
explicit fallback chain; `Pinned` fails closed.

The Coordinator profile resolves exact models only against the authenticated Main
Agent Adapter composed for the running service. A profile that names another provider
or adapter fails closed. Provider/adapter replacement remains the existing explicit,
authenticated Main Agent reconfiguration and service-restart lifecycle; a profile
write alone never claims to hot-swap that runtime.

The Worker reports a bounded verified model catalog from each ready first-class
adapter. Human-friendly names in Configuration Chat and Admin Web are resolved
against that target Device's catalog and the exact native ID is persisted. Main
copies the effective binding into the immutable Run assignment. Native sessions
retain their original binding; profile changes affect new Task or workstream
sessions. A checkpoint continuation created for an existing session retains that
session's recorded binding rather than re-resolving the current profile.

Main's planning prompt receives a compact Device directory containing ready adapter
identities and the effective Worker profile, not every model in every catalog.
Workers receive the exact effective binding in their immutable assignment and prompt,
plus the assigned Work Order and selective local Knowledge; they do not need the
fleet profile or catalog. This keeps placement semantics available without spending
routine context on transport or provider catalogs.

**Rationale:** A Device's role describes what work fits there; it does not prove
which local runner and model will execute it. Provider-only selection still allows
silent model drift, while fleet-wide catalog injection wastes context. Separating
typed durable selection from compact planning context makes execution reproducible
and owner-visible.

**Consequence:** On each target Device page, an owner can request “use Opus on this
NAS” or “use GPT on this Mac Studio” through its Device-scoped Configuration Chat,
or make the same exact choice in Admin Web. Only verified target-local choices are
applied. Task-specific hard requirements are intersected with the Device profile and
fail closed on conflict.

## D-068 — Codex and Claude updates start with non-mutating release discovery

**Decision:** OpenDelegate source provides a deterministic, discovery-only comparison
for its first-class provider package and CLI targets. Dependency automation may
propose an exact SDK change, but neither mechanism edits an installed Device or
changes a running provider. A target may enter an explicitly unsupported internal
preview after provider schema and adapter conformance checks; this `tested` adapter
compatibility label is not a supported-platform claim. Authentication-safe live
start/resume/cancel checks and applicable platform release gates remain mandatory
before supported release promotion. A rollback-capable Device maintenance monitor
and its `disabled`, `propose`, or verified-automation policy remain Phase 12 work and
are not exposed as inert configuration today.

**Rationale:** Provider CLIs and SDKs change independently and can break session or
tool semantics even when installation succeeds. Blind latest-version upgrades would
violate deterministic execution and make an always-on personal system fragile.

**Consequence:** Maintainers can run `corepack pnpm providers:check`, and weekly
dependency automation can surface an SDK candidate without silently upgrading an
owner's fleet. Owners continue to update installed release bundles explicitly.
Runtime automatic provider upgrades are unavailable until the durable verification,
rollback, and audit lifecycle is implemented.

## D-069 — Wake target readiness and automatic wake readiness are separate

See [ADR-0029](adr/0029-wake-on-lan-readiness-evidence.md).

**Decision:** Every Worker may publish one bounded read-only Wake-on-LAN target
observation: `enabled`, `disabled`, `unsupported`, or `unknown`, plus its source and
observation time. The observation contains no interface name, MAC address, SecureOn
value, raw probe output, or other local network identifier. Main retains the latest
authenticated observation in the existing durable Device observation store so it
remains visible after the Worker is offline.

An enabled target is not an automatic-wake claim. Automatic wake becomes `ready`
only after a separate wake-path adapter proves an online Main-local or Worker relay
on the target broadcast domain, keeps the exact wake target outside Agent context,
emits a bounded and rate-limited magic packet under Policy and audit, and observes
the authenticated Worker return. Until that lifecycle exists, Main and Admin report
`relay-required`. Ordinary routed connectivity, Omada or Tailscale membership, and
subnet routing do not satisfy this proof.

**Rationale:** The powered-down target cannot report current state or run its own
Tailscale client, and IP reachability does not transport the Layer-2 wake packet.
Treating an OS setting as end-to-end readiness would make the UI promise a recovery
path that may not exist. Persisting the last authenticated target observation still
gives the owner useful setup evidence without exporting a hardware address.

**Consequence:** Device details can truthfully show that Windows, macOS, or Linux was
armed for magic-packet wake before it went offline and can separately show why
automatic wake is not yet ready. The compact Main Device directory may include these
two bounded states, but it never includes the wake target or raw probe evidence.

## D-070 — Repository validation is tiered by purpose

**Amended by D-087:** the tier boundaries and required check names remain accepted;
the Ubuntu job now scopes package types, tests, builds, and Admin Web browser work to
the changed workspace graph instead of executing every suite for every pull request.

**Decision:** A routine pull request has one required Ubuntu validation job covering
canonical documents, architecture, formatting, lint, types, deterministic tests,
builds, and the Admin Web browser harness. Secret scanning and dependency review are
the only additional required pull-request checks. The same commit is not
automatically retested after merge.

The complete macOS, Windows, Linux, PostgreSQL, Node compatibility, native helper,
browser, and packaged-bundle matrix is an explicitly dispatched Release validation
workflow. CodeQL and dependency audits run weekly or by manual request. Supported
release promotion still requires every automated, live-provider, native-service,
Computer Use, and platform-lab proof named by the specification.

**Rationale:** Repeating the complete TypeScript suite, application build, browser
harness, package assembly, and static analysis across every operating system on
every pull request spent tens of runner-minutes while providing mostly duplicate
evidence. It also repeated the already-validated merge commit immediately after
merge. A fast required gate gives contributors prompt feedback; expensive evidence
belongs to platform-sensitive or release work.

**Consequence:** Branch protection requires `Validate pull request`, `Secret scan`,
and `Dependency review`. A green ordinary pull request is engineering evidence, not
a supported-release claim. Maintainers explicitly invoke the full matrix whenever
the affected platform boundary or release candidate requires it.

## D-071 — Read-only Configuration turns recover once

See [ADR-0031](adr/0031-configuration-read-only-turn-recovery.md).

**Decision:** A Configuration Agent request may start one fresh native continuation
when its provider session becomes unavailable after only `inspect`, `validate`, or
`diff`. Those tools are read-only and their results are not mutation receipts. The
continuation receives the complete current owner request plus the bounded durable
visible conversation, discloses the native-session recovery, and re-inspects current
configuration.

`propose`, `apply`, and `rollback` are mutation-capable for replay safety. Main
durably records the first tool attempt under the version 2 recovery protocol and
appends a request-bound mutation boundary before the first of those tools executes.
Legacy version 1 records remain fail-closed because they cannot prove whether a later
mutation ran. Before starting a recovery session, Main durably reserves the request's
sole continuation. Once a mutation boundary or continuation reservation exists, an
interrupted request never starts another continuation or replays, including after
restart.

**Rationale:** A real Configuration turn inspected the current Device successfully,
then lost its Codex session before returning the result. Treating the read-only
inspection as an unknown mutation produced a generic failure even though repeating
inspection is safe. Removing the boundary entirely would make a later proposal or
apply eligible for unsafe replay.

**Consequence:** Transient provider loss after inspection no longer strands ordinary
configuration guidance. Durable proposals and configuration changes retain the
existing fail-closed boundary and cannot be duplicated by automatic recovery.

## D-072 — Configuration change turns finish the Approval handoff deterministically

See [ADR-0032](adr/0032-configuration-chat-locale-and-approval-handoff.md).

**Decision:** The Admin-selected presentation locale is bounded request metadata for
each new Configuration Agent turn and is authoritative for newly generated
owner-visible prose. It does not translate canonical identifiers, provider-native
model IDs, configuration values, or stored conversation history. The normalized
locale is part of the durable request idempotency identity; changing it while
reusing the same key is a conflict rather than a different continuation of the turn.

Configuration Chat treats a successful `propose` tool call as entry into the normal
change flow. Main does not accept a terminal Agent response until that same turn has
attempted `apply` for the proposal. Policy may apply an unprotected proposal
immediately or return a broker-issued Approval ID for a protected proposal. That ID
is authoritative typed response metadata; Admin Web renders a localized action in
the originating message and opens the exact Approval. Explicit draft-only work uses
`validate` and does not create a durable proposal.

Configuration Chat may hydrate its durable history while closed. Each closed-to-open
transition positions the viewport at the newest restored message while retaining all
older messages above it.

**Rationale:** A live Agent created a proposal and told the owner to approve it even
though it had never called `apply`, so no Approval existed and no setting could
change. The same turn answered in English because an English UI-generated
instruction outweighed the Korean Admin locale, and background hydration left the
closed transcript at its oldest message. These are deterministic product boundaries,
not facts that should be inferred from Agent prose.

**Consequence:** An owner who requests a change receives either a verified apply
receipt or a real, directly reachable Approval—not an orphan proposal. Newly
generated Configuration responses follow the chosen Admin language, and reopening
the chat starts at the current end of the durable conversation.

## D-073 — Windows service Secret sealing degrades to the machine on a workgroup host

**Decision:** Staging a Secret for the Windows service identity seals it with a
DPAPI-NG `SID=` protection descriptor whenever the host can, restricting decryption
to the service account. A host without a domain KDS root key cannot create that
descriptor, so staging falls back to a `LOCAL=machine` descriptor rather than
failing. The handoff directory ACL is unchanged and remains the boundary in both
cases: it breaks inheritance and admits only the staging account and the service
account, and staging fails closed if any other allow rule survives.

The descriptor actually used is reported. `stage` returns it, Windows service Secret
preparation reports the weakest descriptor used across every staged alias, and the
`windows-service-secret-stage` command prints it with an explicit notice when the
machine descriptor was used. Preparation that stages nothing because the backend was
already prepared reports no descriptor at all, because the stored blob does not
record which one sealed it and a guess would be worse than silence.

**Rationale:** `SID=` sealing needs a domain Key Distribution Service. A workgroup
Windows PC has none, so `NCryptCreateProtectionDescriptor` returns
`NTE_ENCRYPTION_FAILURE` and native service installation was impossible on exactly
the hosts this product targets. Invariant 17 makes OpenDelegate personal-first,
invariant 5 requires always-on execution without a visible Agent window, and
invariant 19 puts Windows in the first milestone; requiring domain membership
contradicts all three. The security loss is bounded because the descriptor was never
the only boundary — an attacker still needs to read a directory that admits two SIDs,
and an account able to bypass that ACL can generally impersonate the service account
anyway.

**Consequence:** A workgroup Windows host can install and run the Worker as a native
service and survive reboot. On such a host any process that can read the handoff
directory can decrypt the staged blob, so the owner is told which descriptor was used
and that joining a domain restores service-account sealing. Unsealing is unchanged:
`NCryptUnprotectSecret` resolves the descriptor recorded in the blob, so entries
sealed either way continue to open without migration.

## D-074 — An enrollment grant states whether it enrolls or re-credentials a Device

**Decision:** Every Enrollment Grant carries an explicit `intent` of `enroll` or
`recredential`, fixed when the owner issues it and persisted with the grant.
`enroll` refuses a Device ID that already exists, as before. `recredential`
requires an existing, non-revoked Device and issues its next certificate
generation, keeping the Device's identity, creation time, and history while
revoking every earlier certificate. The default is `enroll`, so re-credentialing
is never reached by omission.

**Rationale:** Device certificates live 24 hours. Rotation refuses a certificate
that has already expired, enrollment refuses a Device ID that already exists, and
revocation keeps the Device row, so a Device ID is never released for reuse. A
Device that slept past its certificate was therefore unrecoverable under its own
name: the only exit was to abandon the identity and enrol the same machine under a
new one, losing its Knowledge association and its history. FR-2.7 requires Device
credentials to rotate without changing Task identity, and invariant 5 requires
always-on execution; a personal Device that is switched off overnight must be able
to come back as itself.

Intent is stored rather than inferred from whether the Device happens to exist at
consumption time. A grant issued to enrol `Windows_5090` must not silently
re-credential a `Windows_5090` that came into existence in between, which
invariant 27 forbids.

**Consequence:** Re-credentialing revokes the previous certificate rather than
letting it expire, so a lost or exposed key cannot keep working next to the
credential the owner just authorized. The Worker reconnects at a higher
certificate generation, which the channel already treats as a reason to clear
per-generation state. Migration 0013 adds the column and the
`device.recredentialed` audit event; grants issued before it carry `enroll`.

This is recovery, not renewal. An online Device should still rotate before its
certificate expires; that path remains unimplemented and is tracked separately.

## D-075 — Device certificates renew over the authenticated channel

**Decision:** A Worker renews its own Device certificate over the mutual-TLS
Device channel. It offers a certificate request signed by a freshly generated
key; Main issues a pending certificate that authenticates nothing until the
Worker returns it with a signature proving possession of the new key. Only then
does Main promote the new generation and give the old one a bounded overlap. The
Worker rewrites its configuration after Main confirms, and deletes the superseded
private key only once that rewrite is durable.

Renewal begins halfway through the validity window. The remaining half is the
retry budget, so a Worker that is briefly offline or unable to reach Main still
has many attempts before it locks itself out.

**Rationale:** Device certificates live 24 hours, which is only safe if something
renews them. `DeviceIdentityAuthority` has implemented and tested the whole
rotation exchange since Phase 4, but no wire protocol reached it, so FR-2.7 was
unimplemented and every enrolled Device expired after a day. The channel is the
right carrier because the connection is itself the proof that the Worker still
holds the current key — no second credential, no new listener, and no window in
which an unauthenticated caller could ask for a certificate.

The Worker generates a new key for every renewal rather than re-certifying the
existing one, so a compromised key cannot survive its own rotation. The response
is durable and keyed by the request, so a Worker that reconnects mid-exchange
replays the same answer instead of asking the authority to start a second
rotation it would refuse as already pending.

**Consequence:** An online Device no longer expires. A Device that was switched
off past its expiry still cannot renew — an expired certificate cannot authorize
its own replacement — and is recovered by the owner-issued re-credentialing grant
in [D-074](#d-074--an-enrollment-grant-states-whether-it-enrolls-or-re-credentials-a-device).
Renewal failures are reported and retried on the next heartbeat rather than
ending the connection loop, because the current certificate remains usable until
its deadline.

## D-076 — The owner's existing provider home is the default

**Decision:** When no provider home is configured, Main and Worker use the home the
owner already authenticated on that Device: `CODEX_HOME` if set, otherwise
`~/.codex`; `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`. A Device that
exposes no usable home directory, or whose resolved home would fall inside the
source checkout, keeps the OpenDelegate-managed home. `--codex-home` and
`--claude-home` still pin any absolute path, including a managed one, for an owner
who wants provider state isolated.

This supersedes the defaults in [D-049](#d-049--explicit-shared-codex-home) and
[D-052](#d-052--explicit-shared-claude-home). Their mechanism is unchanged: the
path is still persisted as non-secret configuration, still passed as the provider's
own home variable, and credentials are still never read, copied, or stored.

**Rationale:** Codex and Claude each keep authentication in one directory and expose
no separate credential selector, so a home OpenDelegate invents is a home the owner
must log into a second time — and nothing told them so. On this owner's Windows
Device every adapter reported `not_ready` while `codex login status` succeeded in
`~/.codex`, because the Worker probed an empty managed home it had created and never
authenticated. D-049 rejected ambient inheritance as surprising, but the surprise it
actually produced was a Device that looked broken while its provider was signed in.
Invariant 17 makes OpenDelegate personal-first; on a personal Device one login is
the expected number.

**Consequence:** Logging out, rotating authentication, or changing provider settings
in that home affects OpenDelegate along with every other local consumer, which is
what sharing one home means. The resolved directory is reported by `worker diagnose`
next to each adapter's authentication state, so the home in use is never a guess.
Owners who want isolation pass an explicit path.

## D-077 — The owner updates an Agent provider from Admin Web

**Decision:** When an Agent adapter reports a version outside its pin, Admin Web
offers an update naming the exact target, and applying it installs that version on
the Device. Main names only the adapter; the package and the version come from
that adapter's own constants on the Worker, so nothing installable crosses the
wire. The Worker refuses any remedy that is not a plain package name and an exact
semantic version, runs the install through its own Node against npm's entry script
rather than a shell wrapper, and re-probes afterwards — a command that exits zero
without changing the installed version is reported as a failure.

The request is accepted, not awaited: the Device applies the upgrade and reports
through its own channel, and the owner sees the result on the next Device refresh.

**Rationale:** A pinned provider version is a fail-closed safety property — an
untested adapter refuses every Run — but it was also a dead end. The adapter said
`untested` and nothing said which package, which version, or where from. That is a
support burden for every owner on every Device, not a property of one machine.

The existing platform-mutation capability cannot serve this. It does not exist
unless the owner has already configured absolute executable paths, which is the
manual setup an owner-facing update exists to remove. A narrow operation whose
package and version are both product constants is a far smaller trust surface than
a general package install, and it is the only one that works on a Device the owner
has not prepared.

Main is not a peer on its own Device channel, so a command addressed to it has
nowhere to arrive. Main runs the same narrow upgrade in process instead, through
the adapters it already composes for its own assessment. A Device that is
neither Main nor a connected channel peer is refused with a stated reason rather
than a generic failure.

**Consequence:** The install writes to the Device's global npm prefix, so it
affects every local consumer of that provider — the same sharing the owner already
accepted for provider homes in [D-076](#d-076--the-owners-existing-provider-home-is-the-default).
A Device without npm reports that rather than guessing at an installer. Adapters
that ship no npm package, such as the Claude Agent SDK on native Windows, offer no
update, because a remedy that cannot name its target is worse than none.

## D-078 — Durable owner input resets idle time before execution resumes

**Decision:** Persisting an owner input through the Task coordinator records one
idempotent Task Budget activity mutation before the resumed execution is queued. The
mutation identity is derived from the same Task, principal, and input idempotency key
as the durable conversation event. It may recover an already-observed idle overage;
it does not extend wall time, turns, retries, tokens, cost, or any other hard limit.

**Rationale:** `waiting_user` deliberately stops automatic execution, often because
the owner must return hours later. Checking the old idle timestamp before recording
that owner's answer made the answer reject itself and produced another Budget prompt
instead of resuming the Task. Discord then appeared to ignore a perfectly durable
message. Owner input is Task activity by definition, while wall time remains the
bounded cumulative automatic execution time of the Task.

**Consequence:** A late reply can continue the same Task and native conversation
without an owner-authorized idle extension. Replayed Discord ingress records the
same activity operation and cannot double-apply or conflict. A genuinely exhausted
wall-time or finite usage Budget still pauses new work through the existing approval
flow.

## D-079 — Discord outbound delivery never blocks Gateway intake

**Decision:** After an authorized Discord dispatch has durably updated Task and
cursor state, outbox delivery starts in the background and is not awaited by the
serialized Gateway receipt loop. Every projection also requests the same single
flight drain. A live approved `THREAD_CREATE` payload is retained and reused when
its starter `MESSAGE_CREATE` arrives. A cache-only thread event does not advance the
durable Resume cursor; reconciliation remains responsible for fetching a starter
that was missed across a disconnect.

**Rationale:** Discord REST calls can take tens of seconds under network delay or
rate pressure. Awaiting reactions, tags, cards, and replies inside the Gateway
callback caused head-of-line blocking: one old Task delayed a new Forum Post for
more than a minute, so the owner saw neither `👀` nor typing despite a healthy Main.
Refetching a thread immediately after Discord supplied that same thread payload
added another avoidable request on the latency-critical path.

**Consequence:** Different Forum Posts continue entering durable intake while an
earlier outbound request is slow. One adapter still owns one ordered outbox drain,
delivery remains idempotent and restart-safe, and the Gateway cursor advances only
after the inbound state change is durable. Tests that need a settled external
projection explicitly await `flushOutbox()`; live receipt does not.

## D-080 — A refused Main connection remains inside the Worker reconnect loop

**Decision:** The Worker Device-channel client creates its welcome waiter only after
the TLS socket has opened. A pre-open socket error therefore has one awaited owner:
the connection attempt. The Worker transport resolver classifies that bounded
failure, and the daemon retries it without exiting.

**Rationale:** Creating both the socket-open waiter and the welcome waiter before a
connection existed made `ECONNREFUSED` reject both promises. The transport resolver
correctly handled the socket-open rejection, but the unused welcome rejection was
unhandled and Node terminated the otherwise healthy Worker. Restarting Main could
therefore leave every Worker offline until another process supervisor happened to
restart it.

**Consequence:** A Main restart, listener startup gap, or temporarily unreachable
route no longer kills the Worker process. Authentication rejection and exhausted
routes keep their existing diagnostics, while ordinary unavailability follows the
bounded reconnect backoff. The mTLS integration test exercises a refused endpoint
before the successful channel exchange so a duplicate rejection cannot regress.

## D-081 — Worker reconnect replay advances at durable acknowledgment boundaries

**Decision:** After the fresh welcome is committed, a Worker replays each durable
non-acknowledgment frame and waits for Main's cumulative acknowledgment before
sending the next one. `worker.ack` frames remain non-recursive: they are sent without
waiting and are covered by the next cumulative acknowledgment of an ordinary frame.
The channel is not reported ready until this replay completes.

**Rationale:** A Worker can retain many heartbeat and acknowledgment frames while
Main is unavailable. Sending the whole durable outbox synchronously filled the
WebSocket buffer past its 2 MiB bound, closed the connection, and started another
replay that also added a welcome acknowledgment. The Device appeared intermittently
online while its backlog grew instead of recovering.

**Consequence:** Reconnection applies natural backpressure at the same durable seam
that already protects idempotency. A large backlog takes bounded round trips to
drain but cannot overwhelm the socket, and failed Main effects are retried before
the Worker advertises readiness. Integration coverage queues 96 heartbeats before
connection and requires every one to be durably acknowledged before `connect()`
returns.

## D-082 — Main honors the Worker hello resume cursor before replay

**Decision:** After authenticating a Worker hello, Main applies its
`acknowledgedMainSequence` to the durable Main outbox before constructing or sending
the reconnect replay. Main derives the corresponding message IDs from its own
contiguous outbox and subjects the cursor to the existing acknowledgment validation.
Receipt of the fresh welcome confirms that cursor to the Worker, so the next normal
`worker.ack` starts after the prefix already accepted by Main.

**Rationale:** A Worker may durably handle Main frames immediately before a channel
closes, without getting a chance to transmit the normal `worker.ack`. The next hello
already carries the Worker's safe handled prefix. Ignoring that cursor caused Main to
replay the same growing backlog before the new welcome; sufficiently large backlogs
prevented the welcome from arriving before the connection timeout.

**Consequence:** A reconnect retires work the authenticated Worker has already
handled, replays only the remaining Main suffix, and then sends the current welcome.
An invalid or non-contiguous cursor still fails closed through the repository's
normal acknowledgment checks.

## D-083 — Explicit owner continuation resets idle time before execution

**Decision:** After durably accepting an owner-authenticated Task approval, `Retry`,
or `Resume`, the execution coordinator records one idempotent Task Budget activity
mutation before it queues execution. The mutation identity is derived from the same
durable owner action identity. It resets only idle time; wall time, retries, turns,
tokens, cost, and every other finite limit remain intact.

**Rationale:** A Task may remain failed or paused while its owner is away. The
owner's explicit decision to approve or continue is current Task activity, just like
a new answer. Checking the old idle timestamp first caused a valid Discord Retry
button press to pause immediately behind an irrelevant Budget-extension prompt.

**Consequence:** An owner can approve, retry, or resume an old Task without extending
its idle Budget. Replayed Discord interactions repair or reuse the same activity
mutation and remain idempotent. A genuinely exhausted cumulative Budget still uses
the normal owner approval flow.

## D-084 — Channel closure releases every in-flight Worker request

**Decision:** Every Worker Device-channel client rejects and clears its pending
event, Artifact, identity, authorization, and Run-lease response waiters when the
underlying socket closes, whether closure is intentional or unexpected. The daemon
then observes renewal or heartbeat failure and returns to its deterministic reconnect
loop.

**Rationale:** Certificate renewal sends an authenticated rotation request before
the next heartbeat. If the socket disappeared after that send but before Main's
reply, the identity response Promise previously had no timeout or close rejection.
The process remained alive without a socket or heartbeat for twelve hours, then its
24-hour certificate expired and required manual re-credentialing.

**Consequence:** Interrupted request/response operations fail promptly and retain
their durable outbound frame for replay after reconnect. A transient disconnect can
no longer strand a healthy Worker until its credential lapses; normal orderly close
keeps the same bounded cleanup behavior.

## D-085 — Stale Discord controls are terminal owner feedback, not transport retries

**Decision:** The Discord-to-Task port maps deterministic Task refusals such as an
invalid current-state transition, missing Task, or idempotency conflict into a typed
non-retryable callback result. The Discord outbox completes that action after
editing the already-deferred interaction with an owner-safe explanation. Only
storage, connectivity, rate-limit, and unknown transient failures retain durable
retry behavior.

**Rationale:** Chronological failure messages intentionally keep a nearby Retry
button, but that message can outlive the Task state for which Retry was valid. Main
correctly rejected one such stale command with `TRANSITION_INVALID`; the Adapter
then classified every non-Discord exception as `TASK_CALLBACK_FAILED` and retried
the same impossible command indefinitely without telling the owner.

**Consequence:** Clicking an older control is harmless and receives a clear “no
longer available” response directing the owner to the latest Task update or a new
message. The durable outbox does not accumulate deterministic failures, while true
delivery or concurrency failures remain recoverable.

## D-086 — Wall Budget measures active execution, not Task age

**Decision:** Task `wallTimeMs` is the cumulative union of intervals in which at
least one Task execution guard is open. Parallel Task work therefore spends wall
time once, not once per concurrent branch. Work Order `wallTimeMs` is the cumulative
duration of its active Runs. Main persists ordinary Budget mutations while execution
is active at a maximum checkpoint interval of 60 seconds and again when activity or
guard closure reaches the Budget service. Waiting, paused, offline, and otherwise
inactive calendar time spends no wall Budget.

**Rationale:** A Discord Forum Post is both a durable Task surface and the boundary
of its native Agent sessions. The owner may return to one Task over days or months.
Measuring `now - createdAt` made an old but mostly inactive Task appear to have used
almost 24 hours of automatic work, then demanded a Budget extension before the
Agent could process a new message. It also turned a runaway-control limit into a
retention limit, which is not the product intent.

**Consequence:** Requested Tasks can preserve conversation and native-session
continuity for arbitrary calendar time. Their default 21-hour soft and 24-hour hard
limits still bound cumulative automatic execution; autonomous Tasks retain their
shorter finite active-work defaults. Existing event histories remain readable:
calendar age is no longer inferred, and only durable wall-usage mutations contribute
to the new total. A sudden Main process failure can omit at most the current
60-second Task checkpoint interval; active Work Order Runs remain reconstructible
from their durable start events.

## D-087 — Routine pull requests validate the changed workspace graph

See [ADR-0039](adr/0039-change-scoped-pull-request-validation.md).

**Decision:** The required Ubuntu pull-request job always runs repository-wide
document, release-ledger, architecture, formatting, lint, and tooling checks. It runs
types, deterministic package tests, and builds only for workspace packages changed
from the pull request's immutable base SHA and their dependents. The root recursive
test command is excluded from that selection. The Admin Web browser harness runs only
for Admin Web or dependency-manifest changes. Check names, Secret scan, Dependency
review, the 15-minute timeout, and the explicit Release validation matrix remain
unchanged.

**Rationale:** D-070 removed duplicated platform matrices but still made a Worker,
documentation, or backend-only pull request execute every unrelated package and
install Chromium. The workspace graph provides a deterministic, conservative affected
set while common manifests still expand to broad validation.

**Consequence:** Ordinary changes receive materially faster feedback and consume less
hosted-runner quota. Shared-package changes retain dependent coverage; release owners
still run the complete local and platform validation commands before promotion.

## D-088 — Windows service staging preserves a public two-plane binding

Implementation detail: [ADR-0040](adr/0040-windows-worker-service-preparation-binding.md).

**Decision:** Before Windows staging removes core-owned Secrets from the owner's
DPAPI vault, it durably records only the core and owner-session helper public IPC
pins, effective non-secret sealing strength, and existing owner-helper vault
location in Worker configuration. The
owner-helper vault remains outside every service-owned root. `worker
service-document` consumes that binding after staging and writes one create-new,
strictly validated install document; it never reopens service-account-sealed
material, copies a helper private key, overwrites install input, elevates, or
registers a service.

The staging configuration switch is committed after the service handoff is complete
and before owner-vault core copies are deleted. Replay with that binding finishes
only the bounded deletion. A legacy staged Worker without the binding must use
`windows-service-secret-restore` when the handoff is owner-restorable, or a new
owner-approved re-credentialing Grant when service-account sealing prevents that
restore, and then stage again. OpenDelegate does not guess lost public pins.

**Rationale:** The first Worker service-document implementation attempted to read
both plane keys from the service store after staging. That sequence cannot work:
the core handoff may be sealed to the SCM identity, while the helper key intentionally
never leaves the owner store. Keeping the helper vault under service-owned state
would also collapse the ownership boundary the two-plane design is meant to protect.

**Consequence:** Windows can compose deterministic service input from local durable
facts without Secret transcription and can recover a crash around staging. As
amended by D-089, macOS and graphical Linux remain fail-closed until they have an
equivalent explicit core-service and owner-session Secret migration; a syntactically
valid document is not treated as a working persistent installation.

## D-089 — Headless Linux is an explicit core-only service shape

Implementation detail: [ADR-0041](adr/0041-headless-linux-worker-service-preparation.md).

**Decision:** A Linux Device with no graphical-session capability does not install
or claim an owner-session helper. Enrollment runs under the eventual non-login
systemd identity with the final encrypted credential mapping and durably records
the core IPC public pin plus that exact non-root identity. Its create-new service
document sets the helper binding to `null` and omits the helper pin, Secret
reference, user unit, supervisor commands, health step, and Computer Use claim.
Graphical Linux continues to require two distinct plane-local keys and Secret
authorities.

**Rationale:** Requiring Secret Service, an unlocked graphical keyring, and a second
private key on a headless NAS creates a permanently failing helper rather than a
security boundary. The systemd-enrolled core already owns its final encrypted vault,
so copying that private material through an owner session would add risk without a
migration need.

**Consequence:** Headless Linux can be persistently useful for non-graphical work
without desktop packages or fabricated IPC identity. Enabling Computer Use later is
an explicit graphical service re-preparation; OpenDelegate never places the helper
key in the core vault or silently widens a core-only installation. D-088's statement
that all Linux service documents remain blocked is superseded only for this
headless core-only shape; macOS and graphical Linux remain blocked.

## D-090 — Headless Linux Main reuses its co-located Worker's prepared service facts

Implementation detail: [ADR-0042](adr/0042-headless-linux-main-service-composition.md).

**Decision:** A headless Linux Main service document is derived from the strictly
validated core-only document produced for Main's co-located Worker. Composition
requires the durable Main and Worker Instance ID, Device ID, state root, and named
systemd credential to match, and rejects any helper authority. It changes the role
to `main`, resolves the durable Admin auto-open preference, and writes a create-new
document. Headless auto-open must remain disabled because no login helper exists.

**Rationale:** Main is a normal Device and the native core already supervises Main
plus its local Worker as one workload. A second hand-authored topology would
duplicate security-sensitive facts and permit drift without creating a useful new
privilege boundary.

**Consequence:** A NAS Main can use one reviewed systemd core definition and one
encrypted credential mapping for both local roles. The command does not install or
elevate, and clean-host restart, reboot, credential, network, upgrade, rollback, and
uninstall evidence remains required before support promotion.

## D-091 — A current Worker lease renewal resets only the idle Budget

Implementation detail:
[ADR-0043](adr/0043-current-worker-lease-renewal-is-budget-activity.md).

**Decision:** After an exact Worker Run lease renewal is durably accepted as
`renewed`, and while that renewed lease remains current, Main records one
retry-stable Task-and-Work-Order Budget activity mutation derived from the renewal
ID. Rejected, expired, mismatched, not-due, or stale renewals do not record activity.

**Rationale:** A long provider turn or tool operation may be quiet for longer than
the default idle window while the authenticated Worker is still renewing its exact
lease. The authoritative renewal is a bounded liveness proof; generic heartbeats or
stale packets are not.

**Consequence:** Legitimate long Runs do not fail as idle merely because they emit
no intermediate result, exact replay repairs an interrupted activity write, and the
finite active wall, token, cost, retry, and turn Budgets remain unchanged.

## D-092 — Resource waits resume from material availability signals

Implementation detail:
[ADR-0044](adr/0044-resource-waits-resume-on-availability-change.md).

**Decision:** `waiting_resource` is a durable dormant Task state. Main does not poll
it on a fixed retry timer or charge execution-failure attempts. Startup
reconciliation and material Worker, Secret, Configuration, route, or lock
availability changes trigger deduplicated re-evaluation. A signal racing the first
durable wait is retained. Genuine retryable execution failures remain `queued` and
bounded by the normal failure retry policy.

**Rationale:** Resource absence is not execution failure. Fixed-delay probing could
exhaust all retries before a normal Worker heartbeat, waste capacity while nothing
changed, and strand the Task after the Worker returned.

**Consequence:** A Task may wait for a Device for hours or days and continue when the
resource becomes eligible, without an owner message or retry-Budget extension.
Eligibility, Policy, locks, Budgets, leases, and fencing are still revalidated at
dispatch; older already-terminal Tasks require one explicit owner Retry.

## D-093 — Native child Agents are bounded inside one Worker Run

Implementation detail:
[ADR-0045](adr/0045-bounded-provider-native-child-agents.md).

**Decision:** A bridged Codex App Server or Claude Agent SDK Worker Run may use
provider-native child Agents for independent local work. One Run is limited to four
children and one nesting level. Children inherit the exact parent Task, Work Order,
Device, Workspace, sandbox, provider session, and Policy callback. Main remains the
only component that creates cross-Device Work Orders. OpenDelegate advertises a
verified `native-subagents` Capability only when a supported bridged adapter is
ready, observes bounded lifecycle and aggregate status, and withholds child prompts,
provider thread IDs, and native paths.

**Rationale:** Provider-native delegation can reduce completion time and context
pressure on a capable Device, but treating it as a second scheduler would bypass
Main's durable placement, leases, Budgets, and audit model. Leaving provider defaults
unbounded also recreates the runaway child-session behavior the owner observed.

**Consequence:** Workers can safely parallelize local investigation and editing while
all consequential child actions still cross executable Policy. CLI fallbacks remain
tool-less, a fifth observable child fails the Run closed, and a child cannot pretend
to use another Device; it reports that dependency to Main for an ordinary Work
Order.

## D-094 — Worker identity is scoped by Device

Implementation detail:
[ADR-0046](adr/0046-device-scoped-worker-identity.md).

**Decision:** A Worker ID identifies a Worker within one Device. Durable Run,
dispatch, authorization, lease, and audit references use the `(Device ID, Worker
ID)` pair. Different Devices may use the same local Worker ID, including the default
`worker-primary`. Scheduler input still rejects duplicate Device candidates.

**Rationale:** Each Device owns its Worker runtime and local configuration. Requiring
an Instance-global Worker name adds no authority boundary, makes ordinary generated
defaults collide across Devices, and contradicts protocol records that already carry
both identities.

**Consequence:** A multi-Device fleet can use consistent local service defaults
without becoming unschedulable. Candidate corruption is reported as invalid state
rather than being mislabeled as an offline Worker.

## D-095 — Windows core services use a network-compatible virtual-service SID

Implementation detail:
[ADR-0047](adr/0047-windows-virtual-service-sid-network-compatibility.md).

**Decision:** A Windows OpenDelegate core continues to run as its exact non-admin
`NT SERVICE\OpenDelegate-<instance>` account, but SCM configures that service SID
as `UNRESTRICTED` rather than placing it in the token's restricted SID list. The
explicit required-privilege list, service-scoped filesystem and Secret ACLs,
Firewall, provider sandbox, and Action Policy remain unchanged.

**Rationale:** Live installed-service testing proved that the restricted token could
reach Main's fixed Worker endpoint but could not provide ordinary provider DNS/HTTPS
to a child Agent process; the identical executable and request succeeded in the
owner token. In SCM terminology `UNRESTRICTED` controls token placement, not network
or administrator authority, and Microsoft recommends it for service-SID use unless
the product owns a complete restricted-resource policy.

**Consequence:** Windows Workers retain a distinct least-privilege virtual account
while Codex and other authenticated providers can run headlessly. Install and
upgrade repair the SID type deterministically, and the Windows release lab must test
provider traffic from the installed service rather than only an owner terminal.

## D-096 — Linux Claude readiness proves the nested sandbox primitive

Implementation detail:
[ADR-0048](adr/0048-linux-claude-nested-sandbox-readiness.md).

**Decision:** A Linux Claude Agent SDK adapter is ready only when its required
`bubblewrap` and `socat` executables exist and a bounded, read-only nested
user-namespace smoke test succeeds. Failure marks the adapter incompatible before a
Run starts. A Prefer profile may then use only its explicitly configured fallback;
OpenDelegate never enables Claude's weaker nested sandbox or modifies host security
policy implicitly.

**Rationale:** Live native-child-Agent testing on Ubuntu showed that the packaged
AppArmor profile allowed the first `bubblewrap` namespace but removed the capability
needed by the nested sandbox. Executable-only probing advertised Claude as ready,
then left the provider turn alive after its child tool failed.

**Consequence:** Tasks fail closed or route through an explicit fallback without
waiting for the first Bash tool to expose host incompatibility. Owners may still
make an audited Device-policy change separately, but adapter selection never treats
that security weakening as installation repair.
