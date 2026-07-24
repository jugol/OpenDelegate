# First-milestone platform lab

This document records the non-secret prerequisites and procedure for OpenDelegate's live release
gate. It does not grant access and must never contain passwords, private keys, bot tokens, recovery
codes, enrollment grants, private network addresses, private hostnames, or private Task content.

Rendered service definitions, read-only probes, simulated adapters, WSL/WSLg, and hosted CI are
engineering inputs. They do not count as live first-milestone proof.

## Current inventory

Audited on 2026-07-24:

| Target                          | Current reachability                                                                             | Repository assets now available                                                                                                                                                          | Missing release proof                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Main/Worker             | One owner-controlled Windows host is available for local engineering; no release run is recorded | Bundled Main/Control Plane path; authenticated Admin Task surface; Windows SCM and user-helper plans; read-only host validation; Codex/Claude/generic adapters; Computer Use OS contract | Build with pinned Node 24.18.0, native service installation, helper IPC, reboot/login/logout, upgrade rollback, signing policy, and real Computer Use backend                                                    |
| macOS Main/Worker               | Owner-controlled hardware is identified; no approved public lab session is recorded              | macOS launchd/LaunchAgent plans and readiness contracts                                                                                                                                  | Approved local or remote lab access, macOS bundle, service/helper execution, logged-in test session, TCC grants, restart/upgrade proof, real Computer Use backend, and Developer ID signing/notarization identity |
| Headless Linux Worker           | An owner-controlled headless target is identified; no approved public lab session is recorded    | systemd and foreground-fallback plans; headless readiness contract                                                                                                                       | Least-privilege lab access, distro/architecture/service-manager record, Linux bundle, service install/reboot/upgrade proof, Worker enrollment, route proof, and explicit Computer Use `unavailable` evidence     |
| Graphical Linux Worker          | Not provisioned; WSLg is available only for engineering fixtures                                 | Linux graphical-helper and Computer Use driver contracts                                                                                                                                 | A separate real graphical Ubuntu-class Device or VM with a declared desktop/session/backend and login, lock, logout, reboot, cancellation, permission-denial, and screenshot proof                               |
| Discord                         | No dedicated release laboratory is connected                                                     | Durable Forum authorization, Task mapping, reconciliation, projection, and control contracts                                                                                             | Community-enabled test server, Forum, dedicated bot, token, intents, least-privilege permissions, owner allowlist, production HTTP/Gateway driver, and desktop/mobile canonical journey                          |
| Codex                           | A local engineering installation was observed; no pinned public lab attestation exists           | Codex CLI lifecycle adapter and fixtures                                                                                                                                                 | Pinned compatibility decision and live start/stream/resume/cancel/approval/restart/checkpoint tests on participating Devices                                                                                     |
| Claude                          | A local engineering installation was observed; authentication has no public lab attestation      | Claude CLI lifecycle adapter and fixtures                                                                                                                                                | Owner authentication and live start/stream/resume/cancel/approval/restart/checkpoint tests on participating Devices                                                                                              |
| Network routes                  | Candidate private-network profiles are identified; no sanitized mixed-route proof exists         | Ordered Transport Profile and deterministic fallback contracts                                                                                                                           | One real mixed-route scenario, route failure/fallback evidence, and an Omada or equivalent routed private profile if selected                                                                                    |
| Release inputs                  | No supported release has been built or published                                                 | Internal-preview builder, pinned-runtime policy, metadata, notices, checksums, and smoke harness                                                                                         | Platform bundles on all targets, clean provenance, signing/notarization policy and identities, publication path, and successful 36-criterion gate                                                                |
| Private vulnerability reporting | GitHub's private reporting route was enabled and verified on 2026-07-24                           | Private draft security-advisory intake documented in `SECURITY.md`                                                                                                                      | Reverify the route and repository access immediately before any supported public release                                                                                                                          |

The current default development shell may use a supported contributor Node 22 runtime. Release
bundle construction is separate and requires exactly Node.js 24.18.0.

## What existing packages do and do not prove

- `packages/platform-services` proves service configuration, lifecycle planning, readiness parsing,
  upgrade/rollback planning, and selected read-only validation seams. It has not installed a
  privileged native service on all three OS families.
- `packages/agent-adapters` proves normalized Codex CLI, Claude CLI, and generic command lifecycle
  behavior against deterministic subprocess fixtures. It does not prove authenticated provider
  compatibility or native-session recovery.
- `packages/discord-adapter` proves durable Forum-domain behavior. It does not prove a production
  Gateway session, HTTP reconciliation, live interactions, intents, permissions, or rate-limit
  behavior.
- `packages/computer-use-os` and `packages/computer-use` prove contracts, readiness/permission
  classification, locks, cancellation, and deterministic drivers. They do not prove real
  pointer/keyboard input on any OS.
- `tooling/build-release.mjs` creates and smokes a platform-specific marked internal preview. That
  smoke does not prove service persistence, Worker orchestration, live providers, Discord, or
  Computer Use.

## Safe owner preparation

Perform these actions only when the corresponding implementation is ready to test. Never paste a
credential into chat, Discord, source control, Task context, a public log, or the evidence ledger.

### macOS

1. Enable **Remote Login** only for the intended least-privilege lab account, or install the bundle
   locally.
2. Add only the lab controller's public SSH key to that account. Do not copy a private key or
   password between Devices.
3. Keep the test user logged in and unlocked only during the Computer Use run.
4. Launch the signed user-session helper and grant Accessibility, Screen Recording, and Input
   Monitoring only when macOS presents the expected system prompt.
5. Provide an Apple Developer ID signing and notarization workflow before distributing a
   downloadable macOS bundle. TCC behavior cannot be proven through headless SSH.

### Headless Linux NAS

1. Create a least-privilege OpenDelegate lab account.
2. Authorize the lab controller's public SSH key.
3. Grant narrow elevation only for the documented install and service commands; do not enable root
   SSH.
4. Record distribution, version, CPU architecture, service manager, and selected route in private
   lab configuration.
5. Keep the Device headless. Its required graphical result is explicit `unavailable` capability
   while non-desktop Work Orders remain functional.

### Graphical Linux

Provision a separate supported graphical Device or VM. The Computer Use ADR must declare one exact
distribution, desktop, display/session protocol, and backend combination before the run can count.
The fixture must prove login, unlock, lock, logout, restart, permission denial, desktop-lock
serialization, cancellation, emergency stop, and screenshot evidence.

WSL and WSLg do not count as the separate Linux Device, system service/reboot proof, or required
graphical Linux release target.

### Discord

1. Create a dedicated Community-enabled test server and Forum Channel.
2. Create a dedicated bot instead of reusing a personal automation token.
3. Enable only the required intents: guilds, guild messages, and message content.
4. Grant only the permissions used by the adapter: view channel, read message history, send
   messages, send in threads, attach files, and manage threads. Add broader channel management only
   when the owner deliberately enables automated provisioning.
5. Store the bot token in Main's local Secret Store. Configuration records only non-secret guild,
   Forum, owner, and workflow-tag identifiers.

### Providers and network

- Authenticate Codex or Claude locally on each Device that advertises that provider. Provider
  credentials remain Device-local.
- Configure Tailscale, Omada, direct, or tunnel profiles with the least network ACL required for
  OpenDelegate listeners.
- Do not make SSH a runtime requirement. It is only an optional lab/bootstrap access path; the
  OpenDelegate Device channel retains its own scoped identity and encryption.
- Keep database URIs, private endpoints, and route diagnostics out of Agent prompts and public
  evidence.

## Lab execution order

Run the following sequence separately on every declared OS/architecture combination:

1. Use exactly Node.js 24.18.0 to build an internal preview outside the checkout:

   ```sh
   pnpm release:build --destination ABSOLUTE_PATH --internal-preview
   ```

2. Verify `SHA256SUMS`, `release-metadata.json`, notices, and `smoke-evidence.json`.
3. Install Main and Worker roles through the native service executor when that executor is
   available; do not treat a rendered plan as installation.
4. Prove start, stop, process restart, host reboot, login/logout, helper loss, diagnostics, upgrade,
   failed-upgrade rollback, and uninstall.
5. Claim the owner locally, verify authenticated remote Admin access, revoke a browser session, and
   recover without Discord.
6. Exercise SQLite and PostgreSQL composition without exposing the PostgreSQL URI.
7. Bind the dedicated Discord Forum and enroll all Devices with single-use grants.
8. Run the canonical mixed-OS Task through at least two Workers and both required provider families.
9. Run real Computer Use and the headless-Linux negative case.
10. Upload a Worker Artifact through Main and exercise private-network, authenticated, signed-link,
    and intentional public exposure.
11. Inject route, Worker, Main, Discord, provider, service, database, and Artifact failures, then
    verify deterministic reconciliation and no duplicate work.

An internal-preview lab run may produce evidence, but it remains unsupported until all criteria pass
together at one immutable source revision. After the complete matrix is linked, rerun
`pnpm release:gate` from a clean checkout before building a production candidate without
`--internal-preview`.

## Required live evidence

Each platform run records:

- immutable source commit, bundle version, build ID, manifest, checksum, signature where applicable,
  and provenance;
- OS, architecture, service/helper/backend/provider versions;
- install, start, stop, restart, host reboot, login/logout, upgrade, failed-upgrade rollback,
  diagnostics, and uninstall outcomes;
- sanitized structured logs and separately protected redacted diagnostic bundles;
- permission state, session state, lease/fence identities, cancellation latency, emergency-stop
  behavior, and before/after screenshots for Computer Use;
- Discord post/message/tag/component identifiers without private message content;
- transport profile and fallback outcome without credentials or sensitive topology; and
- matching criterion IDs from `acceptance-evidence.json`.

Failed fixtures may be retained in the private lab for diagnosis. Public evidence must be sanitized
and must not reveal Device Knowledge, Secret values, credentials, private Task content, private
hostnames, or private network topology.
