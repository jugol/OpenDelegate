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
OpenDelegate-owned provider homes and strict settings isolation are the default;
an explicitly selected external Codex home follows D-049.
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

**Decision:** Main and Worker use Device-local, OpenDelegate-managed provider homes
by default. An owner may instead supply an existing absolute local Codex home with
`--codex-home`. OpenDelegate persists that exact path as non-secret configuration,
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
the default managed home. Claude remains managed unless an existing explicit
Worker configuration selects an external Claude home.

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

**Decision:** Main may receive an existing absolute local Claude configuration
directory through `--claude-home`. OpenDelegate persists only that path, supplies it
as `CLAUDE_CONFIG_DIR`, and uses it for both the Claude Adapter and deterministic
Device assessment. It never copies, links, discovers, or stores Claude credentials.
The shared Claude home may be configured while Codex remains the selected Main
Agent so that both installed Adapters are assessed accurately.

If `claude auth status --json` is not ready in that exact directory, setup instructs
the Owner to run `claude auth login` with the same `CLAUDE_CONFIG_DIR` and reassess.
The default remains the Device-local managed home when no explicit path is supplied.

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
flow. Browser-only Discord actions remain explicit owner actions.

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
