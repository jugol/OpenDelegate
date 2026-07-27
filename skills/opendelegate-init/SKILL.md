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

Before the first deterministic `init`, read `release-metadata.json`, select the path for its exact
`supportStatus`, and ask whether Discord should be configured now, deferred until after owner claim,
or kept disabled.

When the owner selected Discord for an internal preview whose status begins with `internal-preview`,
complete the manual App, Community Forum, intent, permission, workflow-tag ID, owner allowlist, and
secret-safe token prerequisites in `docs/DISCORD_SETUP.md`. The owner may include a complete
non-secret binding in first initialization or defer it. After claim, use the authenticated
Configuration Chat lifecycle to add, replace, extend, or disable `discord.binding`. The internal
preview remains unsupported even when that lifecycle succeeds.

When the owner selected Discord for release-candidate bytes, including the exact same bytes after a
verified external promotion, record that intent, initialize and claim Main, then require the
verified Configuration Chat Discord path in section 6. If that selected path is unavailable or
cannot complete and validate the binding, the candidate is invalid: stop, keep the release
unsupported, and report the missing capability as a release blocker.

When the owner declined Discord, record the Discord-disabled intent, initialize Main without a
Discord binding, and continue. Do not reject the installation or imply that Discord is mandatory. If
the owner changes the choice later, resume at `docs/DISCORD_SETUP.md` and use the same authenticated
Configuration Chat path without re-running `init`.

### Bootstrap the Main Configuration Agent

Do this before the first Main `init` so Configuration Chat never depends on a provider login that
only the unavailable chat could perform.

Read the bundle's `supportStatus` before choosing the provider path.

For release-candidate bytes, including the exact bytes after external promotion, inspect the
packaged launcher for a verified provider login and probe boundary. That boundary must:

1. use the same resolver as foreground and service Main to choose one canonical executable and
   prefix;
2. authenticate the exact configured home through owner-interactive stdio without exposing a token;
3. persist the provider, canonical command identity, and tested version; and
4. revalidate that identity and version on every foreground and service start.

If a candidate lacks a packaged provider login and probe boundary with those properties, stop and
reject it. Do not substitute direct `codex` or `claude` commands, ambient `PATH`, or the external
init Agent's own executable resolution, and do not represent the candidate as supported.

The current internal preview does not expose that boundary. It may use this foreground-only
best-effort flow, but it does not prove a pinned executable identity or service readiness:

1. Resolve one exact absolute `MAIN_HOME` and reuse it for every command. Honor an explicit
   owner-selected home first; otherwise use the packaged runtime's platform default. Managed
   provider homes are `MAIN_HOME/state/providers/codex` and `MAIN_HOME/state/providers/claude`. An
   owner may explicitly select an existing absolute local Codex home as a shared source of truth;
   retain that exact path for `--codex-home`.
2. Select only a Main provider supported on this host and verify the installed version against
   `docs/release/SUPPORT_MATRIX.md`. `Auto` means choose a provider that passes the preview checks;
   it does not mean accepting an installed but unauthenticated CLI. Native Windows must not select
   Claude until the required fail-closed sandbox exists; use Codex or an explicitly configured
   WSL2/container execution path.
3. For a managed provider home, create only the selected directory through an owner-restricted
   filesystem boundary. For an explicit external Codex home, inspect the existing directory without
   copying it. Reject a link, path alias, non-directory, checkout path, or path that resolves
   somewhere else. Never discover or inherit an ambient global provider home.
4. In the same owner environment that will keep the preview Main in the foreground:
   - Codex: set the non-secret `CODEX_HOME` selector to the selected Codex home. Run `codex login`
     only when the explicit status check is not ready, then require `codex login status` to pass.
   - Claude: set the non-secret `CLAUDE_CONFIG_DIR` selector to the controlled Claude home, run
     `claude auth login`, and require `claude auth status --json` to report ready.
5. Never accept a provider token in an Agent prompt, argv, a temporary file, a log, or an unrelated
   environment variable. The provider's own owner-interactive login flow writes directly into the
   configured home.
6. Include the selected `--agent codex` or `--agent claude` option only after the preview version
   and authentication checks pass. Include `--codex-home ABSOLUTE_PATH` only for an owner-selected
   external Codex home. Start Main in that same foreground environment and continue to local owner
   claim. Do not call the authenticated runtime-feature endpoint before an owner session exists or
   imply that this preview path is deterministic.

### Initialize Main

1. Prefer SQLite. Use `init --database sqlite` unless the owner selects PostgreSQL. Main persists
   one top-level, non-secret `secretBackend` descriptor. Windows and macOS, plus Linux graphical
   sessions with Secret Service, receive a platform default. Headless Linux has no implicit
   fallback: write an absolute-path backend document selecting `linux-systemd-credential-vault` and
   pass it with `--secret-backend-config ABSOLUTE_PATH`. The systemd unit must supply the named
   vault key through `CREDENTIALS_DIRECTORY`.

   For a new PostgreSQL Main, choose an opaque alias such as `database-primary`, construct the
   canonical reference `secret://main/database-primary`, and invoke:

   ```text
   opendelegate init --database postgresql \
     --database-uri-ref secret://main/database-primary \
     --database-uri-stdin [--secret-backend-config ABSOLUTE_PATH]
   ```

   Write the URI bytes directly to the child process's bounded stdin and close stdin. Do not use a
   shell `echo`, argv, a process environment variable, a temporary plaintext file, or an Agent
   prompt. Only one stdin Secret may be provisioned per init invocation. Re-running `init` with the
   same bootstrap configuration and stdin flag rotates that alias safely. A pre-provisioned alias
   may omit `--database-uri-stdin`.

2. Keep Main loopback-only unless the owner selects a private-network or custom listener. Require
   HTTPS and an exact allowed origin for any non-loopback listener. Configure it with the complete
   `--listen-host`, `--listen-port`, `--listen-origin`, `--tls-certificate`, and `--tls-private-key`
   set.
3. Create a secret-free Device channel configuration outside the checkout. It must define separate
   enrollment HTTPS and Worker mutual-TLS WSS listener addresses, exact advertised URLs, TLS
   certificate/private-key paths outside the checkout, and one managed Main identity Secret Store
   backend. Supported backend selectors are `windows-dpapi`, `macos-keychain`,
   `linux-secret-service`, and `linux-systemd-credential-vault`. For the systemd backend, the
   service must supply the declared credential through `CREDENTIALS_DIRECTORY`; never put its value
   in JSON, argv, or an environment variable. The exact source shape is:

   ```json
   {
     "schemaVersion": 1,
     "enabled": true,
     "enrollment": {
       "advertisedUrl": "https://main.example.test:45443/api/v1/device/enroll",
       "host": "0.0.0.0",
       "port": 45443,
       "tlsCertificatePath": "/absolute/runtime/tls/main-certificate.pem",
       "tlsPrivateKeyPath": "/absolute/runtime/tls/main-private-key.pem"
     },
     "workerChannel": {
       "advertisedUrl": "wss://main.example.test:45444/api/v1/device/channel",
       "host": "0.0.0.0",
       "port": 45444,
       "path": "/api/v1/device/channel",
       "tlsCertificatePath": "/absolute/runtime/tls/main-certificate.pem",
       "tlsPrivateKeyPath": "/absolute/runtime/tls/main-private-key.pem"
     },
     "secretBackend": {
       "backend": "windows-dpapi",
       "vaultRoot": "/absolute/runtime/secrets/main-identity"
     }
   }
   ```

   On Windows use native absolute paths in the actual JSON. Do not create a self-signed listener
   certificate manually. Pass the file with `init --device-channel-config ABSOLUTE_PATH`;
   OpenDelegate bootstraps the Instance CA key in the selected managed Secret Store and idempotently
   provisions or renews its CA-chained listener identity. It refuses to overwrite an unowned TLS
   identity.

4. Initialize Main and start the separate loopback-only claim listener. If the owner opted into
   opening Admin after login, pass `--admin-auto-open enabled`; otherwise omit the option or pass
   `--admin-auto-open disabled`. The default is disabled. This seeds the typed Main setting rather
   than adding a second preference to `main.json`.
5. Open the local claim page when requested. Never print, log, or relay the claim token.
6. Have the owner create the passphrase and save the ten one-time recovery codes. Confirm recovery
   works independently of Discord, then complete normal owner login.
7. From the authenticated owner session, read `GET /api/v1/runtime/features` and require
   `configurationAgent.status` to be `ready`. If the pinned version, authentication, capabilities,
   or feature probe fails, return to the provider bootstrap above and leave an exact resumable
   checklist. Do not enter Configuration Chat, simulate a Configuration Agent, or call the
   first-milestone setup complete.
8. Enroll the fixed Main computer as its own co-located Worker before installing a persistent
   service. Main is a Device and must remain eligible for normal headless, Agent, Knowledge, and
   Computer Use work; do not model it as a control-only exception.

   - Keep a foreground Main runtime serving while this local enrollment runs, and wait for its
     Device enrollment and Worker-channel listeners to become ready.
   - Read the existing Main Device ID deterministically from local status/configuration. Issue a
     short-lived single-use grant for that exact Device ID with the `worker` bootstrap Role into a
     new restrictive temporary file outside the checkout.
   - Invoke the packaged
     `opendelegate worker join --home MAIN_HOME --grant-file GRANT_FILE --agent auto` boundary on
     the same computer. Main and its local Worker deliberately share the installation home, but use
     separate `main.json`/`worker.json` documents and distinct durable state files underneath it.
   - Let the join verify the loopback mutual-TLS Worker channel, then run
     `opendelegate worker status --home MAIN_HOME`. Do not install or start the core service unless
     it reports the same `deviceId` and `mainDeviceId` as the fixed Main.
   - The grant is consumed by the Worker command. Never open it, route it through an Agent prompt,
     or reuse it.

   A persistent Main service starts both the Main control plane and this co-located Worker under one
   lifecycle. A missing or invalid local Worker enrollment is a startup failure, not an optional
   degraded mode.

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

Persist the last choice through the typed Main setting `admin.open-on-login`; its default is
`false`. Configuration Chat can inspect, propose, and apply this Main-scoped boolean. Every Main
service command must receive `--home MAIN_HOME`; the CLI reads the effective durable value,
overrides stale template state, and renders the canonical local Admin origin for `true` or only
`{ "enabled": false }` for `false`. Never infer opt-in from browser presence. A Worker service
cannot enable this setting.

After Configuration Chat applies or rolls back the setting on an installed Main, run the narrow
privileged update explicitly:

```text
opendelegate service reconfigure --home MAIN_HOME --config MAIN_TEMPLATE.json \
  --active-version VERSION --command-id UNIQUE_ID
```

The operation verifies all installed definitions before mutation, atomically replaces only the
runtime configuration, restarts and health-checks only the owner-session helper, and rolls back on
failure while the core stays running. Configuration Chat never elevates or launches this command
itself.

Use the native, two-plane service package:

- Windows: SCM core plus per-user helper;
- macOS: LaunchDaemon plus LaunchAgent; or
- Linux: systemd system unit plus graphical user unit, with the documented foreground fallback when
  systemd is unavailable.

On Windows, run the packaged `worker windows-service-secret-stage` command against `MAIN_HOME`
before installing either a Main or Worker core service. Main also hosts a local Worker, so both
roles require the explicit `windows-service-dpapi` binding for the SCM virtual service identity. The
logged-in helper key remains in the owner DPAPI vault; never copy it into the service vault.

Stage upgrades, verify health, and roll back on failure. A healthy core must not be reported as
Computer Use ready when the helper, desktop, or permissions are absent. Network and firewall
mutations still require explicit owner approval.

## 6. Finish conversational setup

From an authenticated owner session, read `GET /api/v1/runtime/features` before presenting
conversational setup. When `configurationAgent.status` is `unavailable`, explain that Configuration
Chat is read-only in this build, leave the deterministic checklist below as resumable work, and
return to the provider bootstrap in section 4. Do not attempt a provider login inside the
unavailable chat, invite the owner to type into it, or simulate an Agent response locally.

Only after the Configuration Agent feature reports `ready`, continue in Admin Configuration Chat,
not a Task conversation:

1. verify the current Device Facts and capabilities;
2. propose Roles and Instructions with an exact diff;
3. confirm the bootstrapped Main Adapter remains ready, then configure additional Worker or generic
   adapters without exposing credentials. Authenticate each additional managed Codex/Claude provider
   home through the same owner-interactive rule. Preserve an explicitly selected external Codex home
   by reference instead of copying it, and never inherit an ambient provider home;
4. handle Discord according to the owner's current choice:
   - When the owner declined Discord, preserve the explicit Discord-disabled state and continue. Do
     not reject the installation or present Discord as required.
   - When first init already seeded the owner's intended Discord binding and provisioned its token,
     inspect the effective value, confirm every ID, and require `ready / DISCORD_READY`. Do not
     upload a duplicate token or submit an identical no-op proposal.
   - For deferred, new, or changed Discord setup, run the Configuration Chat path in
     `docs/DISCORD_SETUP.md`. Put the raw token only into the secure credential panel, pass only its
     opaque reference to the Agent, and propose the exact Main-scoped `discord.binding`. Review and
     approve the protected mutation, then require `ready / DISCORD_READY`.
   - Adding a Forum preserves existing `forumBindings`; replacing the bot, guild, or Forum proposes
     the complete new object; disabling sets the value to `null`. Never edit `main.json` or re-run
     `init` with different settings. Main preserves durable Tasks and native sessions but does not
     silently migrate old Discord thread identities.
   - On any candidate activation or Configuration commit failure, require the previous binding to be
     restored. For release-candidate bytes, an unavailable path or failed validation is a release
     blocker. For internal-preview bytes, report the failure without claiming support.
5. configure ordered routes per Device;
6. enroll each additional Worker with a short-lived single-use grant (the fixed Main was already
   enrolled locally in section 4); and
7. configure Artifact exposure and retention.

Issue each grant through the packaged deterministic boundary:

```text
opendelegate device grant --device-id DEVICE_ID \
  --output ABSOLUTE_LOCAL_PATH [--expires-seconds 30..1800] [--role ROLE ...]
```

The default lifetime is five minutes and the default bootstrap Role is `worker`. The output path
must not already exist and must remain outside the checkout. The CLI creates exactly one
restrictively permissioned file, prints only redacted metadata, and never accepts the token through
argv or an environment variable. Transfer that unopened file through an owner-controlled local or
OS-secure handoff, then hand enrollment to `skills/opendelegate-join/SKILL.md`. Do not read, paste,
attach, or summarize the file in Configuration Chat, Discord, logs, or an Agent prompt. If it
expires or is consumed, delete any retained handoff copy and issue a fresh grant rather than editing
it.

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
