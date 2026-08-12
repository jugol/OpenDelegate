# Changelog

All notable OpenDelegate source changes are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Released versions will
follow Semantic Versioning once a public API is tagged. Nothing listed under **Unreleased**
represents a supported release or completed first milestone.

## [Unreleased]

### Added

- Approved product, architecture, threat-model, implementation, decision, and cross-platform release
  contracts.
- A TypeScript monorepo with architecture-boundary checks, deterministic test seams, browser
  testing, dependency and secret scanning, and hosted macOS, Windows, and Linux CI workflows.
- A deterministic canonical Task journey covering Task identity, context isolation, clarification,
  scheduling, parallel Work Orders, Worker reports, synthesis, Artifact publication, restart,
  duplicate delivery, policy, budgets, and resource locks.
- SQLite and PostgreSQL storage adapters for events, idempotency, materialized state, transactional
  outbox data, and owner authentication, with shared contract tests.
- A runnable Main composition with `init`, `serve`, and `status` CLI commands, embedded SQLite by
  default, PostgreSQL URI-reference configuration, Control Plane health, and authenticated Task
  inspection and emergency-control APIs.
- Loopback-only initial owner claim, passphrase authentication, one-time recovery codes, session
  revocation, CSRF protection, and SQL-backed owner state.
- Authenticated Admin Web login and recovery; durable Task, Approval, Artifact, enrollment, audit,
  and diagnostic operations; and responsive Device Configuration Chat in English, Korean, Japanese,
  French, Spanish, and Simplified Chinese.
- An authenticated, six-locale Task Budget inspector and exact owner extension flow with durable
  revision checks, Instance ceilings, limit-event history, and fail-closed conflict handling.
- Production Main-to-Worker enrollment HTTPS and mutual-TLS WSS composition, durable inbox/outbox
  replay, exact Run dispatch and action authorization, Worker supervision, Device discovery, ordered
  Transport Profiles, and a local-only Knowledge MCP boundary for linked Markdown.
- SQLite and PostgreSQL repositories for authoritative Artifact metadata and append-only Device
  observations, with bounded Admin projections that keep Device Knowledge and local paths outside
  Main.
- Local Artifact Store and isolated Artifact Gateway packages with exposure-policy, traversal, and
  hostile generated-content coverage.
- Programmatic Codex App Server and Claude Agent SDK adapters, bounded CLI fallbacks, normalized
  lifecycle, exact provider-tool authorization, cancellation, native-session affinity, checkpoint
  continuation, and single-writer contract tests.
- Provider-native steering with exact Task, Run, Device, turn, and native-session binding; durable
  intent-before-send replay rules; and authenticated Main–Worker request and receipt delivery.
- A production-composed Discord Forum adapter covering Device-local bot credentials, Gateway and
  HTTP drivers, durable authorization, one-post/one-Task mapping, idempotent ingestion,
  reconciliation, status projection, controls, archive/reopen, deletion, and redaction behavior.
- Windows SCM, macOS launchd, and Linux systemd service plans plus a journaled native executor,
  signed-bundle preflight, health-gated install/upgrade/rollback/uninstall, separate core and owner
  session-helper hosts, and role-agnostic helper lifecycle.
- A typed Main-scoped `admin.open-on-login` preference, one-shot health-gated browser launch from
  the owner-session helper, and an explicit service reconfiguration flow that rolls back on failed
  helper health.
- Authenticated, signed Computer Use IPC; OS-neutral locking and authorization; native Windows,
  macOS, and GNOME Wayland candidates; local emergency stop; and deterministic conformance fixtures
  for capture, input, cancellation, permission failure, and evidence.
- A fail-closed, journaled platform-mutation executor for existing official package sources, project
  dependencies, protected package-source, installer, driver, kernel, network, VPN, and firewall
  changes.
- An agent-facing `opendelegate-init` skill that preserves release gating and keeps runtime state
  outside the checkout.
- An agent-first owner Quick Start in all six README languages, a complete Getting Started journey,
  and a least-privilege Discord Forum setup guide carried into every platform bundle.
- A platform-specific internal-preview bundle builder that downloads and verifies the exact official
  Node.js 24.18.0 archive, bundles Main and Admin, writes source/runtime/lockfile provenance, a
  package-instance legal inventory with retained runtime and compiled Admin production-dependency
  terms, plus checksums, and smokes CLI help, clean-home initialization, Main health, Admin serving,
  owner claim/login, cookie round-trip, and clean shutdown.
- A machine-readable 36-criterion acceptance ledger that separates implementation status from live
  platform-lab proof.

### Changed

- Preserved an authorized Discord button decision when Gateway head-of-line delay makes the
  interaction too old for Discord's private acknowledgement. The exact idempotent Task command or
  Approval now still crosses the durable authority boundary once, and the refreshed public Task
  surface confirms the result instead of silently discarding the owner's click.
- Made a new owner message on a Task in `review` durably queue a fresh execution cycle. Review
  remains dormant across ordinary Main restarts, but an explicit Discord follow-up now reaches the
  Coordinator and can create new owner-cycle-scoped Work Orders instead of merely reprojecting the
  old review card.
- Projected each ready Worker adapter's executable tool-authority class into Main planning and
  prevented Auto or Prefer dispatch from silently falling through to a tool-less provider CLI. File,
  shell, Artifact, network, native-child-Agent, package, and Computer Use work now stays on an
  adapter with an OpenDelegate Policy callback unless the owner explicitly pins a text-only adapter.
- Kept Windows provider-home access repair ahead of restart/upgrade downtime and limited routine
  lifecycle repair to the canonical provider roots. Initial installation remains recursive, while
  subsequent starts, restarts, and upgrades refresh inheritable access without rewalking entire
  Codex and Claude state trees.
- Allowed an immutable Run assignment to add the exact adapter model or effort selected by Main
  while still proving that every Work Order Agent constraint is preserved and its compatibility
  allowance is only narrowed. This prevents a valid resolved binding from poisoning durable Worker
  channel replay after reconnect.
- Added an explicit, durable `--codex-home` Main option so an owner can share one existing local
  Codex home as a Device SSOT while managed provider homes remain the default.
- Made the fixed Main computer a normal co-located Worker Device under the same service lifecycle
  and Device policy instead of a control-only scheduling exception.
- Replaced the Admin design-only fixture path with authenticated Task operations and explicit
  degraded behavior when Discord is not configured.
- Unified Work Order and Worker Report validation in Protocol and moved deterministic eligibility,
  preference fallback, and bounded tie exposure into Scheduler.
- Made the orchestration journal own Task-stream identity and Work Order/Artifact fingerprints, with
  fail-closed replay-tamper coverage.
- Made the bundled Main runtime the internal-preview validation path instead of a development server
  or visible provider desktop application.
- Bound native service health to the exact configured product, runtime plane, Instance, Device,
  role, and release identity so a healthy response from the wrong process cannot satisfy
  installation or upgrade readiness.
- Pinned release construction to Node.js 24.18.0 while retaining Node.js 22.14 and later in the Node
  22 line as a contributor compatibility target.
- Replaced the vulnerable pnpm 9 toolchain pin with pnpm 11.15.1 while preserving the exact frozen
  dependency graph and Node.js compatibility floors.
- Required production release construction to fail until all 36 implementation and live-evidence
  gates pass with no platform or Computer Use waiver.
- Bound every verified release criterion to a full source commit, immutable attestation identifier,
  and hashed in-repository evidence; production candidates use a clean descendant attestation commit
  whose diff from the audited source commit is restricted to the ledger and SHA-bound regular
  evidence files, revalidated before and after assembly without honoring Git replacement refs, and
  assembled from a committed snapshot that excludes ignored or untracked checkout inputs.
- Isolated unsupported preview assembly in the same disposable committed-snapshot model, removed
  package-manager executable shims without deleting package-owned `.bin` data, and kept the live
  checkout's dependency state unchanged on both successful and failed packaging.
- Re-executed release assembly from the captured commit's disposable tool snapshot and bootstrapped
  pnpm from its separately downloaded, streaming-size-bounded, SHA-512-pinned official archive
  instead of trusting ignored checkout dependencies or a global executable.
- Canonicalized parsed X.509 certificate serials before durable lookup and rotation proof
  verification so valid 128-bit serials with DER-trimmed leading zeroes remain stable across
  platforms.
- Overrode the Claude SDK's transitive Hono Node adapter to the compatible patched 2.0.10 release
  and made dependency review and audit reject every moderate-or-higher advisory.
- Sealed OpenDelegate-controlled provider homes at their owner-only root while treating their
  provider-owned contents as opaque, so supported Codex temporary executable links no longer make an
  otherwise safe Linux Main fail runtime-path validation.

### Fixed

- Kept Windows login and background capability inventory silent: the session-helper and native
  Computer Use child are packaged without console windows, the login Task is explicitly hidden, and
  OS capture/permission interaction is deferred until an owner-requested Computer Use Run instead of
  running during heartbeat probes. Existing installations accept only the exact prior Task manifest
  missing that one hidden flag during upgrade, then atomically persist and force-refresh the native
  Task registration before restarting either service plane.
- Made the Windows virtual-service Secret vault reboot-stable by using its profile-independent
  DPAPI-NG sealing and service-only ACL through the already trusted native service host instead of
  starting Windows PowerShell inside the background service, with a bounded one-time migration from
  legacy CurrentUser DPAPI records when that older profile is available.
- Kept a native Worker service alive when Main or its VPN route is temporarily unavailable: an
  active bounded reconnect loop now satisfies local service readiness, while Main continues to mark
  the Device offline until its next authenticated heartbeat. Non-retryable identity failures still
  fail startup closed.

- Distinguished the Worker Agent's pre-promotion report from deterministic post-turn Artifact
  evidence, so a successfully promoted file can complete its Task and be presented by Discord
  instead of waiting for the Worker to observe a boundary that deliberately runs after its turn.
- Localized the deterministic resource-wait suffix when it follows a Korean Agent explanation,
  avoiding an English orchestration footer inside an otherwise Korean Discord status card.
- Enabled a private loopback Artifact Gateway during ordinary new-Main initialization, added an
  explicit enable/disable or custom reconfiguration boundary for existing Mains, and retained the
  Windows service Secret backend so file delivery cannot disappear after service promotion.
- Preserved bounded Artifact-stage Worker diagnostics and Main's explicit retry decision through
  promotion and Discord localization, preventing terminal delivery refusals from becoming opaque
  `WORKER_BOUNDARY_ERROR` retries.
- Replaced noisy per-step Discord replies with one editable live Task-activity surface that
  aggregates Main planning, multi-Device dispatch, egress-inspected Worker milestones, Work Order
  completion, and verification. Terminal replies close it through a durable cross-cycle tombstone,
  so offline or stale outbox work cannot recreate old progress after a result.
- Routed bundled Worker Run-tool subprocesses through the release launcher so Knowledge, Artifact,
  platform-mutation, and Computer Use MCP bridges execute their CLI command instead of silently
  exiting from a library bundle.
- Accepted Claude Agent SDK `command_lifecycle` events during native child-Agent execution,
  preserved an authoritative terminal result when SDK transport cleanup throws, and reported missing
  Linux `bubblewrap`/`socat` sandbox prerequisites before dispatch. Linux readiness now also proves
  bounded nested user-namespace creation, so AppArmor, container, or kernel incompatibility routes
  to an explicitly configured Prefer fallback instead of hanging the first native child Agent.
- Kept Windows core services on their exact non-admin virtual account while using SCM SID type
  `UNRESTRICTED`, so headless provider DNS/HTTPS is available without moving Agent execution into
  the interactive owner session.
- Preserved an exact Agent model and optional effort through Worker session validation, durable
  session keying, storage, resume checks, and owner-safe Run observations, so a successful pinned or
  Prefer-selected provider turn is not discarded after completion.
- Recovered certificate rotation after prior failed rotations and owner-authorized recredentialing
  by selecting the active current-generation certificate, and discarded key-bound rotation requests
  replayed from an earlier Worker process session.
- Started a fresh durable Main/Worker transport epoch exactly once after owner-authorized Device
  recredentialing, preventing retained sequence checkpoints from rejecting the replacement identity
  while routine certificate rotation continues to preserve queued delivery.
- Migrated the Windows owner-session helper signing Secret into an owner-local DPAPI vault outside
  native service state during service staging, including crash-safe replay for Workers already
  staged by an older build, so secure service-document composition can complete without weakening
  the core/owner runtime boundary, and taught the elevated Worker upgrade to accept only that safe
  vault move plus a coherent staged core IPC public-key transition while rejecting unrelated drift.
- Allowed native service upgrades to validate the installed topology against the actual active
  version, and atomically advance or roll back the durable runtime configuration with the release
  pointer.
- Accepted the exact private `0550` directory and `0440` file modes emitted by current systemd
  credential mounts, allowing headless Linux vaults to become ready without permitting general
  group-readable credential paths.

### Security

- Kept owner claim on a separate loopback-only listener and excluded claim tokens, database URIs,
  and recovery material from routine logs and configuration.
- Added generated HTML isolation, restrictive static defaults, path containment, Secret redaction,
  enrollment replay protection, normalized approval scopes, and durable lease/fencing negative
  tests.
- Rejected runtime-home symlinks and reparse points, enforced POSIX owner-only modes and Windows
  owner-plus-`SYSTEM` ACLs, and prevalidated recovery state before bounded Argon2 hashing.
- Enabled and verified GitHub Private Vulnerability Reporting, secret scanning with push protection,
  Dependabot vulnerability alerts, and Dependabot security updates for the public repository.
- Upgraded to the patched pnpm 11 toolchain, enforced a strict dependency release-age hold, blocked
  exotic transitive sources, allowlisted only exact reviewed native build scripts, and removed all
  currently reported dependency advisories.
- Prevented an approved action whose execution outcome became failed or unknown from retaining a
  consumable Worker authorization after restart.
- Added per-peer Artifact lookup and authorization rate limiting, replaced the Windows Task XML
  regular-expression scan with a bounded linear parser, and moved file-backed session lease keys to
  a `Map` so persisted input cannot reach prototype setters.

### Known release blockers

- No release-valid Discord Community Server, Forum, bot credentials, HTTP/Gateway integration run,
  or mobile/desktop canonical journey has been completed.
- Real Codex and Claude compatibility, authentication, resume, cancellation, and
  checkpoint-continuation smokes remain incomplete.
- Native service installation, reboot/login/logout recovery, upgrade rollback, and
  signing/notarization remain unproven across macOS, Windows, and Linux.
- A non-release Windows direct-fixture run passed real capture, input, cancellation, and emergency
  stop through exact parent-process authentication. Release-valid owner-picker, signed-service, and
  clean-host proof is still missing on Windows, and real Computer Use remains unproven on macOS and
  the supported graphical Linux target.
- The owner-controlled three-Device, mixed-OS, mixed-route, and Artifact exposure acceptance
  scenarios have not run.
