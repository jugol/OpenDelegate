# First-milestone platform lab

This document records the non-secret prerequisites and procedure for OpenDelegate's live release
gate. It does not grant access and must never contain passwords, private keys, bot tokens, recovery
codes, enrollment grants, private network addresses, private hostnames, or private Task content.

Rendered service definitions, read-only probes, simulated adapters, WSL/WSLg, and hosted CI are
engineering inputs. They do not count as live first-milestone proof.

The exact OS families, versions, architectures, runtime pins, and hosted CI
compatibility images are declared in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).
Evidence from a different target does not silently satisfy this checklist.

## Current inventory

Audited on 2026-07-26:

| Target                          | Current reachability                                                                             | Repository assets now available                                                                                                                                                          | Missing release proof                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Main/Worker             | One owner-controlled Windows host is available for local engineering; one nonrelease direct-fixture Computer Use run passed, but no release run is recorded | Bundled Main plus co-located Worker; authenticated Admin operations; SCM core and owner-helper executors; controlled provider homes; native UI Automation, Windows.Graphics.Capture, SendInput, authenticated named-pipe, and Win32 fixture candidates | Authenticode-sign the exact native staging tree before manifests; freeze and publisher-attest the candidate; install the real service/helper; prove owner-picker consent, reboot/login/logout, upgrade/rollback, lock/session/UAC/UIPI failure behavior, and the complete Windows Computer Use matrix |
| macOS Main/Worker               | Owner-controlled hardware is identified; no approved public lab session is recorded              | Bundled Main/Worker composition; launchd/LaunchAgent executors; authenticated-helper/native-driver seam; Swift ScreenCaptureKit, AXUIElement, and CGEvent candidate; deterministic AppKit fixture; macOS CI compile path | Final-commit compile; Developer ID signing before manifests; exact-archive publisher attestation and external notarization receipt without post-manifest stapling; stable TCC grants, clean-host lifecycle, and real Computer Use proof |
| Headless Linux Worker           | An owner-controlled headless target is identified; no approved public lab session is recorded    | systemd and foreground-fallback executors; systemd credential-vault path; headless readiness contract; outbound enrolled Worker composition | Least-privilege lab access, distro/architecture/service-manager record, Linux bundle, service install/reboot/upgrade proof, Worker enrollment, route proof, and explicit Computer Use `unavailable` evidence |
| Graphical Linux Worker          | Not provisioned; WSLg is available only for engineering fixtures                                 | Ubuntu 24.04 GNOME Wayland AT-SPI/RemoteDesktop/ScreenCast/PipeWire candidate, private-child boundary, GTK fixture, authenticated helper seam, and Worker readiness composition | Build the immutable Linux bundle, then use a separate real graphical Ubuntu Device or VM for login, lock, logout, reboot, portal revocation, monitor/suspend recovery, cancellation, permission-denial, and screenshot proof |
| Discord                         | No dedicated release laboratory is connected                                                     | Production-composed HTTP and Gateway drivers; durable Forum authorization, Task mapping, reconciliation, projection, controls, restart state, and redaction contracts | Community-enabled test server, Forum, dedicated bot, token, intents, least-privilege permissions, owner allowlist, reconnect/rate-limit proof, and desktop/mobile canonical journey |
| Codex                           | A local engineering installation was observed; no pinned public lab attestation exists           | First-class Codex App Server plus capability-reduced CLI fallback, explicit configured home, exact action authorization, native-session persistence, and deterministic fixtures | Authenticate the exact configured home at the pinned version and run live start/stream/resume/cancel/approval/restart/checkpoint tests on participating Devices |
| Claude                          | A local engineering installation was observed; authentication has no public lab attestation      | First-class Claude Agent SDK plus capability-reduced CLI fallback, controlled home, fail-closed sandbox contract, exact action authorization, native-session persistence, and deterministic fixtures | Authenticate the exact configured home at the pinned version and run live start/stream/resume/cancel/approval/restart/checkpoint tests on supported participating Devices |
| Network routes                  | Candidate private-network profiles are identified; no sanitized mixed-route proof exists         | Ordered Transport Profile and deterministic fallback contracts                                                                                                                           | One real mixed-route scenario, route failure/fallback evidence, and an Omada or equivalent routed private profile if selected                                                                                    |
| Release inputs                  | No supported release has been built or published                                                 | Internal-preview builder; candidate finalizer; pinned runner/signing policies; native-authenticity and immutable archive checks; candidate/promotion/observer-read-back/receipt verifier; digest-addressed configured authority; declared/effective Main projection; sanitized Admin status; and accepted ADR-0021 contract | Real target-native signing identities; independently provisioned publisher/promotion/observer authorities; credentialed finalization, notarization, promotion, and publication; exactly three signed remote read-back observations; exact candidates on every target; and successful 36-criterion proof |
| Private vulnerability reporting | GitHub's private reporting route was enabled and verified on 2026-07-24                           | Private draft security-advisory intake documented in `SECURITY.md`                                                                                                                      | Reverify the route and repository access immediately before any supported public release                                                                                                                          |

The current default development shell may use a supported contributor Node 22 runtime. Release
bundle construction is separate and requires exactly Node.js 24.18.0.

## What existing packages do and do not prove

- `packages/platform-services` and `apps/service-host` prove service configuration, journaled
  lifecycle execution, exact-identity health checking, upgrade/rollback behavior, core and
  owner-session process hosting, and Admin auto-open fixtures. They have not installed a privileged
  native service on all three OS families.
- `packages/agent-adapters` proves Codex App Server, Claude Agent SDK, Codex/Claude CLI fallback, and
  generic-command lifecycle behavior against deterministic fixtures, including controlled provider
  homes, exact action authorization, native-session binding, exact steering, and checkpoint
  continuation. It does not prove authenticated live-provider compatibility or recovery at the
  pinned versions.
- `packages/discord-adapter` and Main composition prove durable Forum behavior plus production HTTP
  and Gateway driver seams. They do not prove a credentialed Gateway session, live interactions,
  intents, permissions, reconnect, mobile presentation, or real rate-limit behavior.
- `packages/computer-use-os` and `packages/computer-use` prove contracts, readiness/permission
  classification, locks, cancellation, deterministic drivers, and strict native candidate
  boundaries. The Windows candidate uses UI Automation, Windows.Graphics.Capture, guarded
  `SendInput`, and authenticated local IPC; the macOS candidate uses ScreenCaptureKit,
  AXUIElement, and CGEvent. Candidate source, compilation, and nonrelease fixture runs do not prove
  signed clean-host service lifecycle, owner permission behavior, or a supported release.
- `tooling/build-release.mjs` creates and smokes a platform-specific marked internal preview,
  including Main, its co-located Worker command surface, Admin, owner claim/login, and clean
  shutdown. That smoke does not prove privileged service persistence, enrolled remote Workers, live
  providers, Discord, mixed routes, or Computer Use.

## Safe owner preparation

Perform these actions only when the corresponding implementation is ready to test. Never paste a
credential into chat, Discord, source control, Task context, a public log, or the evidence ledger.

### Windows

1. Use the exact Windows 11 25H2 build 26200.8875 `x64` target in
   [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), not WSL, Windows Server, a hosted runner, or a
   remote-desktop-only substitute.
2. Install only the publisher-signed immutable release candidate through the production
   service/helper lifecycle. Do not run the user-session helper elevated and do not enable
   interactive-services compatibility.
3. Keep the owner session visible and unlocked only for the Computer Use run. Select the intended
   fixture through the Windows capture picker; do not replace owner consent with the direct-window
   engineering flag.
4. Run higher-integrity and UAC secure-desktop cases only against disposable lab fixtures. The
   expected result is fail-closed unavailability, never elevation or bypass.

### Windows Computer Use candidate run

Follow
[`packages/computer-use-os/native/windows/README.md`](../../packages/computer-use-os/native/windows/README.md)
for build prerequisites, authenticated helper boundaries, and the external evidence command.

1. Build the exact final-commit `x64` helper and fixture with pinned Node 24.18.0 and the declared
   Visual Studio/Windows SDK toolchain. Authenticode-sign and verify those exact PE bytes before
   payload manifests are generated, then freeze, archive, and publisher-attest the candidate.
2. Launch the core through the SCM service and the owner-session helper through the production
   interactive-session launcher. Verify their separate OS-scoped Ed25519 identities, pinned peer
   SPKIs/key IDs, signed session/release/service-epoch handshake, and configured service-account
   SID. The owner-session helper then launches its one-process native Computer Use child and passes
   that narrower child bootstrap Secret only through inherited descriptor 3; it is not the
   core/helper plane credential.
3. Through the system capture picker, select the signed deterministic fixture and prove separate
   readiness for the active/unlocked session, current frame, UI Automation controls,
   same-or-lower-integrity input, local emergency stop, and authenticated helper.
4. Complete the shared text/radio/submit workflow, record bounded PNG and result-file hashes, and
   prove cancellation, emergency stop, and capacity-one desktop-lock contention.
5. Repeat with picker cancellation and consent withdrawal; lock/unlock; login/logout; reboot;
   service/helper restart and replacement; Fast User Switching; a higher-integrity target; UAC
   secure desktop; partial `SendInput`; display/monitor/DPI changes; frame timeout; and helper
   crash. During an active provider/tool fixture, force the service host to terminate and prove
   its Windows Job Object removes the complete descendant process tree before any Workspace or
   desktop side effect can continue.
6. Inspect sanitized diagnostics to prove raw typed text, IPC keys, pipe identifiers, screenshots,
   and native failure details did not enter logs, errors, audit, Discord, Admin, or the release
   ledger.

The explicit `--nonrelease-direct-fixture-capture` path is implementation evidence only. Its
`supportClaim: false` record can never replace signed owner-picker or lifecycle proof.

### macOS

1. Enable **Remote Login** only for the intended least-privilege lab account, or install the bundle
   locally.
2. Add only the lab controller's public SSH key to that account. Do not copy a private key or
   password between Devices.
3. Keep the test user logged in and unlocked only during the Computer Use run.
4. Launch the signed user-session helper and grant Accessibility, Screen Recording, and Input
   Monitoring only when macOS presents the expected system prompt.
5. Provide the external Apple Developer ID signing and notarization identities before producing a
   downloadable candidate. Native signing occurs before payload manifests; the exact final archive
   is notarized afterward and its accepted result remains an external sidecar. TCC behavior cannot
   be proven through headless SSH.

### macOS Computer Use candidate run

Follow
[`packages/computer-use-os/native/macos/README.md`](../../packages/computer-use-os/native/macos/README.md)
for external-scratch build commands, explicit permission-status/request commands, fixture
identifiers, and the evidence boundary.

1. Build both Swift products on the exact declared macOS version and architecture with SwiftPM
   scratch output outside the checkout. Record the final-commit CI job and the local build identity
   separately.
2. Sign the helper, fixture, and every containing native bundle inside-out with the approved
   Developer ID identity before payload manifests exist. Freeze and archive those exact bytes,
   create the detached publisher attestation, and submit that exact final archive for notarization.
   Retain the accepted result as an external sidecar and do not staple or otherwise rewrite the
   archive. Verify the signature, notarization identity, archive digest, and Gatekeeper result
   before requesting TCC. An ad-hoc build or a different path/signature does not establish the
   release candidate's TCC state.
3. From the visible owner Aqua session, run the signed helper's non-mutating
   `--permission-status`. Use `--request-permissions` only as an explicit owner onboarding action;
   never edit or pre-seed the TCC database.
4. Start the signed fixture with a unique safe `--run-id` and an empty result directory outside the
   checkout. Do not launch the helper's `--stdio-child` mode manually: only the already
   ADR-0011-authenticated owner session helper may own that private child.
5. Through the production composition, prove a real bounded ScreenCaptureKit PNG, live
   AXUIElement discovery of all fixture identifiers, authorized CGEvent text/radio/click actions,
   the visible success state, and the matching atomic run-scoped JSON result.
6. Repeat with Accessibility, Screen Recording, and input access denied and revoked; the session
   locked; loginwindow/no Aqua session; Fast User Switching; sleep/wake; Secure Event Input;
   display reconfiguration; helper replacement/crash; cancellation; emergency stop; and two Runs
   contending for the capacity-one desktop lease. Force the LaunchDaemon and LaunchAgent to
   terminate while a child tree is active and prove no descendant escapes the configured process
   group; `AbandonProcessGroup=false` is not by itself live containment proof.
7. Inspect sanitized diagnostics to prove raw typed text and native stderr did not enter logs,
   errors, audit, Discord, Admin, Artifacts, or the evidence ledger.

A successful Swift build, simulated transport test, permission preflight, or hosted CI run is
partial engineering evidence. None may change criterion 19 or ADR-0014 to complete/accepted without
the clean-host signed lifecycle and live fixture matrix.

### Headless Linux NAS

1. Create a least-privilege OpenDelegate lab account.
2. Authorize the lab controller's public SSH key.
3. Grant narrow elevation only for the documented install and service commands; do not enable root
   SSH.
4. Record distribution, version, CPU architecture, service manager, and selected route in private
   lab configuration.
5. Keep the Device headless. Its required graphical result is explicit `unavailable` capability
   while non-desktop Work Orders remain functional.
6. Kill the systemd service during an active bounded child fixture and prove
   `KillMode=control-group` removes every descendant. If foreground fallback is selected, record
   the external supervisor and prove that it supplies the equivalent process-tree containment;
   foreground mode alone makes no such claim.

### Graphical Linux

Provision a separate supported graphical Device or VM. The Computer Use ADR must declare one exact
distribution, desktop, display/session protocol, and backend combination before the run can count.
The fixture must prove login, unlock, lock, logout, restart, permission denial, desktop-lock
serialization, cancellation, emergency stop, and screenshot evidence.

WSL and WSLg do not count as the separate Linux Device, system service/reboot proof, or required
graphical Linux release target.

For the graphical systemd core and user helper, also terminate each supervisor
during a bounded child fixture and prove no descendant survives its control group.

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
4. Prove start, stop, process restart, complete descendant-tree termination, host reboot,
   login/logout, helper loss, diagnostics, upgrade, failed-upgrade rollback, and uninstall. For a
   Main role, also prove the typed Admin auto-open preference disabled and enabled, exact canonical
   origin selection, once-per-login launch, and rollback after a failed helper health check.
5. Claim the owner locally, verify authenticated remote Admin access, revoke a browser session, and
   recover without Discord.
6. Exercise SQLite and PostgreSQL composition without exposing the PostgreSQL URI.
7. Bind the dedicated Discord Forum and enroll all Devices with single-use grants.
8. Run the canonical mixed-OS Task through at least two Workers and both required provider families.
9. Run real Computer Use and the headless-Linux negative case.
10. Upload a Worker Artifact through Main and exercise private-network, authenticated, signed-link,
    and intentional public exposure.
11. Prove npm project installation only through the sealed official-registry path. For every system
    package manager proposed for support, record the existing source and privilege state, pin and
    revalidate the exact configured manager executable, prove the manager-specific install-only
    argument boundary, and show that repository additions and remote installers still require
    approval. Do not claim candidate-source verification unless the target-platform evidence
    independently proves it.
12. Inject route, Worker, Main, Discord, provider, service, database, and Artifact failures, then
    verify deterministic reconciliation and no duplicate work.

An internal-preview lab run may produce evidence, but it remains unsupported until all criteria pass
together at one immutable source revision. After the complete matrix is linked, rerun
`pnpm release:gate` from a clean checkout before building a production candidate without
`--internal-preview`.

## Supported candidate and promotion order

The internal-preview sequence above gathers engineering and live-lab evidence. It does not grant a
signing or publication credential. After the ledger is complete, the supported candidate follows
ADR-0021 without changing that ledger:

1. Run the production gate at clean attestation commit B for audited source commit A.
2. On each clean committed, hash-pinned target runner, assemble the staging tree and apply required
   Developer ID or Authenticode signatures before generating any integrity manifest.
3. Freeze the signed payload; generate metadata and checksum manifests; run packaged smoke; create
   the deterministic final archive; and create its detached publisher attestation.
4. Submit only the exact final macOS archive for notarization. Retain the accepted result and log
   identities as external evidence; never staple or rewrite the candidate.
5. Execute the required clean-host matrix against those exact candidate digests. If any byte must
   change, discard the candidate and restart at native staging/signing.
6. After every declared target and criterion verifies, create one cross-platform promotion
   attestation under a promotion key distinct from every publisher key.
7. Publish only the attested assets. Read back each of the three target archives and obtain exactly
   one independently observer-signed envelope per target against a distinct observer trust root.
   The read-back plan names the promotion key ID as uploader authorization. Create the signed
   supported-channel release receipt only after all three observations verify. Effective
   `released` begins only when the complete publisher, platform, promotion, observer, receipt, and
   revocation-policy chain verifies.
8. Install strict digest-addressed `release-verification.json` and its distinct bounded evidence
   beneath
   `STATE_ROOT/trust/releases/<version>/<platform>-<architecture>/<checksumManifestSha256>/`.
   Prove `absent`, malformed, promotion-invalid, revoked, publisher-only, and fully released
   outcomes against the exact installed bytes. A receipt or filename without this independently
   provisioned and verified authority is insufficient.

Credential-bearing signing, timestamping, notarization, publisher, promotion, observer, and
publication tools receive private material only through the approved external credential
boundary. Their runner image and executable versions are hash-pinned, and sanitized evidence
records the public identity plus input and output digests. A CI self-signature, ad-hoc certificate,
key emitted beside its signature, dirty checkout, or unpinned helper is never support eligible.

## Required live evidence

Each platform run records:

- immutable source commit, bundle version, build ID, manifest, checksum, final archive digest,
  native-signing identity and verification where applicable, publisher-attestation digest, and
  provenance;
- clean/hash-pinned credential runner identity and tool hashes; the external macOS notarization
  submission and accepted receipt; and the cross-platform promotion attestation and supported
  channel receipt when promotion is exercised;
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
