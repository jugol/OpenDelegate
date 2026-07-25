# Platform Services

`@opendelegate/platform-services` is the deterministic Phase 4 boundary for installing and
supervising OpenDelegate's two Device runtime planes:

- an always-on, least-privilege core service; and
- a per-owner login-session helper that alone represents graphical desktop readiness.

The package renders platform-native definitions, builds auditable lifecycle plans, executes plans
through injected privileged adapters, and produces redacted diagnostics. It does not ask an LLM to
choose commands or service paths.

## Supported definitions

| Platform | Core plane                                                       | Session plane                                         | Persistence                  |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| Windows  | SCM automatic service under a restricted virtual service account | Least-privilege interactive Task Scheduler logon task | boot / owner login           |
| macOS    | system LaunchDaemon under a dedicated non-login account          | owner LaunchAgent limited to the Aqua session         | boot / owner login           |
| Linux    | hardened systemd system unit under a dedicated non-login account | systemd graphical user unit                           | boot / graphical owner login |

Linux also exposes a foreground invocation for owners of non-systemd machines. That invocation
explicitly requires an external supervisor and is not represented as equivalent to systemd
persistence.

Every platform configuration records the owner login preference explicitly:

```json
{
  "ownerSession": {
    "userName": "owner",
    "stableUserId": "1000",
    "uid": 1000,
    "homeDirectory": "/home/owner",
    "adminAutoOpen": {
      "enabled": true,
      "url": "http://127.0.0.1:43180/"
    }
  }
}
```

`admin.open-on-login` is the durable typed Main setting and defaults to `false`.
The service renderer copies its effective value and the canonical Admin origin
into the exact owner-session configuration. Enabled auto-open is rejected for a
Worker service. The session helper—not the core daemon—polls the structured
loopback core health contract for up to two minutes, creates one atomic claim for
the exact native login session, and invokes the platform URL opener with fixed
argv and no shell. A helper restart in the same login session therefore does not
open another tab. Windows uses its logon LUID, macOS its audit session ID, and
Linux its `XDG_SESSION_ID`; if the native launcher cannot establish an exact login
session identity, convenience auto-open stays unavailable while normal helper and
headless work continue.

A Linux configuration may include one non-secret `systemdCredential` mapping with
`credentialName` and an absolute external `encryptedSourcePath`. The core unit then
renders `LoadCredentialEncrypted=` and `PrivateMounts=yes`; plaintext credential
bytes never enter service configuration, argv, logs, or diagnostics.

Windows installation and upgrade require a non-secret `serviceSecretBinding`
produced by the packaged local-Worker staging flow. Main hosts a co-located Worker,
so this requirement applies to both Main and Worker roles. Preflight
derives the configured SCM service SID through fixed `sc.exe showsid` argv and
rejects a missing or mismatched binding before the command journal is claimed.
The Secret package owns the SID-protected DPAPI-NG handoff and final service-profile
DPAPI import; service configuration never contains Secret material.

## Release and path contract

Configuration accepts normalized absolute paths for the source checkout, bundle, installation,
persistent state, runtime sockets, and logs. Installation, state, runtime, log, and bundle paths
must remain outside the source checkout and must be mutually disjoint. Mutation paths must use
their link-free canonical spelling (for example `/private/var/...`, not macOS's `/var` compatibility
symlink). Plans never put runtime state, credentials, or generated service files into the
repository.

A release bundle includes its pinned runtime and service hosts:

```text
<install-root>/
  current -> releases/<active-version>
  releases/<version>/
  .staging/<version>-<checksum-prefix>/
```

Install and upgrade copy into `.staging`, verify the release checksum, signed manifest, and bundled
runtime, atomically promote the version directory, then atomically replace `current`. Service
manifests refer only to `current`, so their paths do not change during upgrade.

After activation, required core health is checked. The helper health check may defer only when the
owner is logged out. A failure unwinds completed steps in reverse, stops the new processes, restores
the prior `current` target, restarts the prior version, and returns a structured rollback
diagnostic. Old releases are pruned only after health succeeds; the active version plus the
configured one-to-five previous versions are retained.

Uninstall removes supervisor registration, manifests, binaries, and ephemeral runtime files.
Persistent state and logs are preserved by default. They are removed only when `purgeState: true` is
explicit.

## Security boundaries

- Windows does not use `LocalSystem`; the core uses its restricted service SID.
- Every Windows install/upgrade requires and verifies the local Worker's staged
  virtual-service Secret binding before the command journal is claimed or any host
  mutation occurs, including a Main with its co-located Worker.
- macOS and Linux core services use a dedicated non-root, non-login account.
- The configured owner is the only user granted access needed by the session helper.
- Directory plans carry explicit deny-unlisted access policies; release directories stay
  installer-owned and executable, not service-writable.
- Supervisor actions are argv arrays with allowlisted native executables. Shells and `secret://`
  arguments are rejected.
- Configuration accepts opaque `secret://` references only. Secret values are never accepted,
  rendered, logged, or included in diagnostics.
- Core/helper IPC is a named pipe on Windows and a mode `0660` Unix-domain socket on macOS/Linux.
  Protocol v2 requires separate core/helper Ed25519 private-key references, pins
  both SPKI public keys, signs the mutual handshake and every bounded frame, and
  restricts expected peers to the service identity and configured owner. Legacy
  shared `helperIpc` configuration is rejected.
- Core status, login state, lock state, helper process state, and desktop permission readiness
  remain separate. Logging out or locking the desktop removes Computer Use while leaving headless
  work available.

Privileged filesystem and supervisor effects are behind injected filesystem, process, privilege,
clock, HTTP, and owner-session boundaries. The production composition supplies native Windows,
macOS, and Linux adapters plus a durable external-state command journal. Tests replace every host
boundary and never mutate native services.

## Agent-requested platform mutations

The package also owns the shell-free executor used by the Worker platform mutation
capability. It can represent existing-source system packages and project
dependencies as manager-specific fixed argv. Production composes npm project
dependencies plus owner-configured `apt`, `apt-get`, `dnf`, `yum`, `zypper`, `brew`,
`winget`, and `choco` executables for install-only requests against their existing
sources. Worker pins each configured canonical executable's file identity and SHA-256
at startup and revalidates both immediately before execution; replacement fails
closed until restart. This boundary does not independently attest remote candidate
provenance, so supported automatic installation still requires the clean-host release
evidence documented in the acceptance ledger. Package specs cannot begin with an
option or contain a URL or shell syntax. Repository changes, remote scripts,
untrusted installers, drivers, kernel extensions, network routes, VPN state, and
firewall state use category-specific executable allowlists and require Main's
exact-action Policy decision immediately before process execution.

The executor accepts only configured absolute executable paths, never performs
command discovery, and spawns with `shell: false` and no output capture. Its durable
external-state journal binds a stable command ID to the exact platform, category,
executable, argv, and working directory. Completed replays are side-effect free;
conflicting or in-progress commands fail closed. Production callers must provide a
sanitized environment and a Workspace-bound process runner. The Worker composition
pins the authoritative Run Workspace and revalidates its canonical path and
filesystem identity after Policy consumption at the final process boundary.

This executor runs as the current service identity and does not invent elevation.
Required OS privilege must come from a separately configured narrow delegation and
still requires clean-host platform evidence.

## Owner-facing lifecycle CLI

`apps/main` exposes these contracts without duplicating the service model:

```text
opendelegate service render --config PATH [--home MAIN_HOME]
opendelegate service plan OPERATION --config PATH [--home MAIN_HOME] [--active-version VERSION]
opendelegate service install --config PATH [--home MAIN_HOME] --command-id ID
opendelegate service reconfigure --config PATH --home MAIN_HOME --active-version VERSION --command-id ID
opendelegate service start|stop|restart --config PATH [--home MAIN_HOME] --active-version VERSION --command-id ID
opendelegate service upgrade --config NEW_BUNDLE_PATH --active-version CURRENT_VERSION --command-id ID
opendelegate service status|diagnose --config PATH
opendelegate service uninstall --config PATH --active-version VERSION --command-id ID
```

`--home` is required whenever the template role is Main. The owner CLI reads
`admin.open-on-login` from Main's durable Configuration state and replaces stale
template preference data before rendering, inspection, planning, or mutation.
`reconfigure` accepts only that preference change, atomically rewrites the exact
runtime configuration, and restarts and health-checks only the owner-session helper
with rollback while the core stays running.

Every mutating command is bound to a caller-stable command ID through
`executeIdempotentServicePlan`. A durable journal atomically claims the ID, returns the same report
for exact completed replay, rejects conflicting reuse, and fails closed on an in-progress or
uncertain operation. `createServicePlanRunner` routes structured filesystem/release, account,
supervisor, and health actions through separate injected adapters with deterministic action IDs.
Adapters distinguish changed from already-satisfied steps. Fresh install fails closed on an
existing definition or supervisor registration instead of adopting or force-overwriting it.
Upgrade requires the supplied configuration to reproduce the installed definitions exactly before
new release bytes are introduced.

The default CLI composes the native current-host implementation. Before claiming a durable command
or mutating the host, it verifies elevation, fixed native tools, safe link-free path topology,
canonical plan identity, and same-volume activation. Install and upgrade additionally verify every
payload digest, the two executable native service hosts, and a detached Ed25519 publisher
attestation rooted outside the payload. Publisher authentication occurs before untrusted payload
traversal; ordinary lifecycle recovery does not depend on the original bundle source
remaining mounted. Missing authority
or trust returns `SERVICE_COMMAND_PREFLIGHT_FAILED` with `mutationMayHaveOccurred: false`; the CLI
never elevates itself. Status and diagnose use conservative native inspection and never infer
Computer Use from core health. See
[`docs/SERVICE_LIFECYCLE.md`](../../docs/SERVICE_LIFECYCLE.md) for the owner contract and exact
failure behavior.

Current target-native preview builds include both self-tested service-host executables. They remain
unsupported until a clean build has a detached publication attestation, the platform-specific
signature or notarization required by the support matrix, and clean-host lifecycle evidence. An
unsigned preview therefore intentionally fails production install preflight. The native
implementation does not change the release ledger and does not replace clean-host, reboot/login,
or rollback evidence.

Once a target bundle contains both hosts and has passed packaged smoke,
`pnpm release:sign` revalidates the complete manifest-bound payload and creates the detached
Ed25519 publisher attestation plus a separately provisioned public trust root. Signing never
changes `internal-preview-*` or `release-candidate` support status and is not release-channel
promotion. See [`docs/release/README.md`](../../docs/release/README.md#publisher-attestation-for-service-installation).

## Windows read-only validation

On Windows, this command locates SCM and Task Scheduler and performs only `query` operations:

```powershell
pnpm --filter @opendelegate/platform-services validate:windows-host
```

The report contains availability booleans and no command output. It never calls create, delete, run,
start, stop, or change operations.

## Verification

```powershell
pnpm --filter @opendelegate/platform-services typecheck
pnpm --filter @opendelegate/platform-services test
npx --yes node@24 --experimental-strip-types --test packages/platform-services/test
```

The contract suite strictly parses generated Task Scheduler XML, launchd property lists, and systemd
units; tests deterministic output, privilege and tool preflight, link/path attacks, complete payload
and publisher-signature verification, lifecycle coverage, partial-supervisor compensation,
failed-health rollback, rollback failure, state-preserving uninstall, durable
replay/conflict/in-progress behavior, logged-out readiness, Secret exclusion, and injected
filesystem/supervisor behavior. Auto-open tests additionally cover disabled and
Worker states, structured Main readiness, same-session replay, a distinct login
session, bounded failure, and shell-free Windows/macOS/Linux browser commands.

This package does not by itself constitute macOS, Linux, or Windows service acceptance. Clean-host
install, reboot, login/logout, upgrade, and rollback proof remain self-hosted platform-lab gates,
and macOS/Linux live execution is not claimed from Windows-side rendering tests.
