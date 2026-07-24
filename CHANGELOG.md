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
- Authenticated Admin Web login and recovery, durable Task inspection and pause/cancel emergency
  controls, plus responsive Device and read-only Configuration Chat surfaces. Execution-starting
  controls fail closed until their production runtime is connected.
- Device identity and single-use enrollment contracts, Worker durable inbox/outbox and Run
  supervision contracts, Device discovery, ordered Transport Profiles, and Device-local linked
  Markdown Knowledge.
- Local Artifact Store and isolated Artifact Gateway packages with exposure-policy, traversal, and
  hostile generated-content coverage.
- Codex CLI, Claude CLI, and generic command Agent Adapter packages with normalized lifecycle,
  cancellation, session affinity, and single-writer contract tests.
- A durable Discord Forum adapter core covering authorization, one-post/one-Task mapping, idempotent
  ingestion, reconciliation, status projection, controls, archive/reopen, deletion, and redaction
  behavior.
- Windows SCM, macOS launchd, and Linux systemd service plans, renderers, readiness contracts,
  upgrade/rollback planning, and read-only validation seams.
- OS-neutral Computer Use contracts plus OS-driver/readiness seams and deterministic conformance
  fixtures for locking, cancellation, permission failure, and evidence.
- An agent-facing `opendelegate-init` skill that preserves release gating and keeps runtime state
  outside the checkout.
- A platform-specific internal-preview bundle builder that downloads and verifies the exact official
  Node.js 24.18.0 archive, bundles Main and Admin, writes source/runtime/lockfile provenance, a
  package-instance legal inventory with retained runtime and compiled Admin production-dependency
  terms, plus checksums, and smokes CLI help, clean-home initialization, Main health, Admin serving,
  owner claim/login, cookie round-trip, and clean shutdown.
- A machine-readable 36-criterion acceptance ledger that separates implementation status from live
  platform-lab proof.

### Changed

- Replaced the Admin design-only fixture path with authenticated Task operations and explicit
  degraded behavior when Discord is not configured.
- Unified Work Order and Worker Report validation in Protocol and moved deterministic eligibility,
  preference fallback, and bounded tie exposure into Scheduler.
- Made the orchestration journal own Task-stream identity and Work Order/Artifact fingerprints, with
  fail-closed replay-tamper coverage.
- Made the bundled Main runtime the internal-preview validation path instead of a development server
  or visible provider desktop application.
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
  known dependency advisories.
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
- Real Computer Use input and cancellation have not passed on macOS, Windows, or a supported
  graphical Linux environment.
- The owner-controlled three-Device, mixed-OS, mixed-route, and Artifact exposure acceptance
  scenarios have not run.
