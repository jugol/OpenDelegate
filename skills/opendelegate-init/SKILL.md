---
name: opendelegate-init
description:
  Initialize or repair a personal OpenDelegate installation from its repository or release bundle.
  Use when the owner asks to set up OpenDelegate, make this Device the fixed Main, choose SQLite or
  PostgreSQL, configure startup or Admin auto-open behavior, claim owner access, enroll Devices,
  bind Discord Forum, detect Codex or Claude, or resume an interrupted first-run setup.
---

# Initialize OpenDelegate

Treat this skill as the owner-facing installer. Do not require the owner to know development
commands.

## 1. Establish the installation boundary

First determine which of these two installation inputs you have:

- **Packaged bundle** — the same directory contains `release-metadata.json`, `SHA256SUMS`, a
  `runtime` directory, and `opendelegate` or `opendelegate.cmd`.
- **Source checkout** — the directory contains `AGENTS.md`, `package.json`, `pnpm-lock.yaml`,
  `CONTEXT.md`, and `docs/IMPLEMENTATION_PLAN.md`.

For a packaged bundle:

1. Parse `release-metadata.json` and read `INTERNAL_PREVIEW.md` when present.
2. Verify every entry in `SHA256SUMS` with the host checksum utility before invoking the launcher.
   This detects payload inconsistency after acquisition; it does not authenticate a manifest that
   arrived with the same bundle. Do not use pnpm, a global Node runtime, or source-only scripts.
3. Read the bundled `CONTEXT.md`, `docs/release/README.md`, and `docs/release/PLATFORM_LAB.md`.
   Treat every `supportStatus` beginning with `internal-preview-` as an unsupported validation
   build, even when the ledger and all local smoke checks pass.

For a source checkout:

1. Read the canonical documents in the order required by `AGENTS.md`.
2. Run `pnpm release:status` and parse the JSON. A zero process exit does not mean the release is
   complete. If `complete` is false, state that this is an internal build.
3. Follow the source preparation flow in section 3 to produce a marked bundle outside the checkout.

Internal-preview consent permits a marked test bundle; it does not authorize persistent service
registration. Do not label a preview supported or install it unattended until the production gate,
signed bundle, service executor, health check, and rollback path all exist and pass.

Keep runtime state outside both the checkout and packaged bundle. Use `OPENDELEGATE_HOME` only when
the owner wants a non-default absolute path.

Never copy Device Knowledge, credentials, generated Artifacts, databases, or logs into the
repository.

## 2. Inspect before changing

Detect without an LLM loop:

- OS, architecture, service manager, graphical login session, and permissions;
- Node and pnpm compatibility;
- existing Main configuration and service state;
- Codex, Claude, browser, container, GPU, and supported Computer Use backends; and
- configured LAN, Omada, Tailscale, HTTPS, or WSS route profiles.

Do not scan subnets or infer a usable route from interface presence. Route probes must be redacted,
read-only, and limited to endpoints already configured by the owner.

Present only choices that affect owner intent. Use these accepted defaults when the owner has not
expressed a preference:

- one fixed Main Device;
- embedded SQLite;
- Task mode `Auto`;
- Assisted autonomy;
- package installation from existing official sources allowed;
- network, firewall, new package-source, remote-script, driver, and kernel changes require approval;
- static HTML reports with scripts disabled;
- private-network Artifact exposure; and
- deterministic route exhaustion before Agent diagnosis.

Do not ask about decisions already established by the repository or obvious from the host.

## 3. Prepare the integrity-checked build

Skip directly to step 5 when section 1 identified a packaged bundle.

1. In a source checkout, Node `>=22.14.0 <23` or `>=24 <25` and pnpm `>=11.15.1 <12` may run
   contributor checks.
2. Install the locked dependency graph with `pnpm install --frozen-lockfile`.
3. Run `pnpm check`, `pnpm build`, and the Admin browser suite before first service installation.
   Stop on a failure; do not waive a platform or Computer Use gate.
4. Before any bundle build, switch to and verify exactly Node `24.18.0`; contributor-compatible Node
   22 and other Node 24 versions cannot run the release builder. For an approved internal preview,
   build outside the checkout with
   `pnpm release:build --destination ABSOLUTE_PATH --internal-preview`. The builder downloads the
   pinned official Node archive, verifies its audited SHA-256, refuses to overwrite an existing
   path, requires `internal-preview` in the destination name, marks the exact evidence state in
   metadata, writes checksums, and smokes Main, Admin, local claim, owner login, and clean shutdown.
5. Invoke the packaged `opendelegate` or `opendelegate.cmd`; do not depend on a globally installed
   Node runtime. Use a repository TypeScript entrypoint only to diagnose the builder itself.

Never use `npm run start`, a Vite development server, or a visible Codex/Claude desktop window as
the runtime source of truth.

## 4. Configure Main

1. Prefer SQLite. Use `init --database sqlite` unless the owner selects PostgreSQL. For PostgreSQL,
   set the URI only in a local environment or Secret Store and pass its name through
   `--database postgresql --database-uri-environment ENV_NAME`; never persist or echo the URI.
2. Keep Main loopback-only unless the owner selects a private-network or custom listener. Require
   HTTPS and an exact allowed origin for any non-loopback listener. Configure it with the complete
   `--listen-host`, `--listen-port`, `--listen-origin`, `--tls-certificate`, and `--tls-private-key`
   set.
3. Initialize Main and start the separate loopback-only claim listener.
4. Open the local claim page when requested. Never print, log, or relay the claim token.
5. Have the owner create the passphrase and save the ten one-time recovery codes. Confirm recovery
   works independently of Discord.

If an owner already exists, preserve it and continue with normal authenticated setup. Never create a
second owner.

## 5. Install persistent services

First inspect the packaged CLI. If it has no verified service install/upgrade/ diagnostics commands,
report persistent installation as unavailable and leave the tested foreground Main running only when
the owner asked for it. A service plan, manifest, or fixture is not an installed service.

Once the executor and platform proof are present, offer these choices separately:

- start the core service at boot;
- start the graphical helper at user login; and
- open Admin after user login.

Use the native, two-plane service package:

- Windows: SCM core plus per-user helper;
- macOS: LaunchDaemon plus LaunchAgent; or
- Linux: systemd system unit plus graphical user unit, with the documented foreground fallback when
  systemd is unavailable.

Stage upgrades, verify health, and roll back on failure. A healthy core must not be reported as
Computer Use ready when the helper, desktop, or permissions are absent. Network and firewall
mutations still require explicit owner approval.

## 6. Finish conversational setup

Read `GET /api/v1/runtime/features` before presenting conversational setup. When
`configurationAgent.status` is `unavailable`, explain that Configuration Chat is read-only in this
build, leave the deterministic checklist below as resumable work, and do not invite the owner to
type into it. Never simulate an Agent response locally.

Only after the Configuration Agent feature reports `ready`, continue in Admin Configuration Chat,
not a Task conversation:

1. verify the current Device Facts and capabilities;
2. propose Roles and Instructions with an exact diff;
3. configure Codex, Claude, or generic adapters without exposing credentials;
4. bind approved Discord owner identities and Forum Channels;
5. configure ordered routes per Device;
6. enroll each Worker with a short-lived single-use grant; and
7. configure Artifact exposure and retention.

Workers connect outbound to Main. Never build pairwise SSH trust or give a Worker database
credentials. Main may see only local Knowledge health, never its names, links, index, snippets, or
content.

## 7. Prove and hand off

Run status and the available smoke checks. Report:

- Main origin and service state;
- owner claim or recovery state without secrets;
- database adapter;
- Discord binding health;
- each Device's daemon, helper, route, and capability state;
- Codex/Claude compatibility status;
- Artifact origin isolation; and
- every unrun or externally blocked release proof.

Distinguish three outcomes:

- **Internal preview initialized:** the marked bundle and the requested local foreground surfaces
  work, but unsupported gates remain.
- **Release candidate assembled:** proofs and the hashed evidence ledger bind audited source commit
  A. The completed ledger and its SHA-bound attestations live in a distinct, restricted descendant
  commit B. Run `pnpm release:gate` and assemble the candidate only from a clean checkout of B; its
  metadata records both commits and the allowed A-to-B attestation paths.
- **First milestone released:** a separately verified immutable promotion attestation publishes the
  exact candidate bytes through a supported channel. Candidate assembly alone never establishes this
  outcome.

Never call the first outcome a completed installation or supported release. If credentials,
owner-controlled Devices, reboot/login actions, privacy permissions, or a Discord laboratory are
missing, leave an exact resumable checklist and keep the release status blocked.
