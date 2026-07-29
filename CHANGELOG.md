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
