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

## Release and path contract

Configuration accepts normalized absolute paths for the source checkout, bundle, installation,
persistent state, runtime sockets, and logs. Installation, state, runtime, log, and bundle paths
must remain outside the source checkout. Plans never put runtime state, credentials, or generated
service files into the repository.

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
- macOS and Linux core services use a dedicated non-root, non-login account.
- The configured owner is the only user granted access needed by the session helper.
- Directory plans carry explicit deny-unlisted access policies; release directories stay
  installer-owned and executable, not service-writable.
- Supervisor actions are argv arrays with allowlisted native executables. Shells and `secret://`
  arguments are rejected.
- Configuration accepts opaque `secret://` references only. Secret values are never accepted,
  rendered, logged, or included in diagnostics.
- Core/helper IPC is a named pipe on Windows and a mode `0660` Unix-domain socket on macOS/Linux.
  The contract requires a challenge-response HMAC credential reference and restricts expected peers
  to the service identity and configured owner.
- Core status, login state, lock state, helper process state, and desktop permission readiness
  remain separate. Logging out or locking the desktop removes Computer Use while leaving headless
  work available.

Privileged filesystem and supervisor effects are behind `PlanExecutionAdapter` and
`SupervisorSubprocessRunner`. Production composition must implement those adapters with a durable
operation journal and platform elevation boundary. Tests use injected fakes and never mutate host
services.

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
units; tests deterministic output, privilege invariants, lifecycle coverage, failed-health rollback,
rollback failure, state-preserving uninstall, logged-out/locked readiness, Secret exclusion, and
injected supervisor behavior.

This package does not by itself constitute macOS, Linux, or Windows service acceptance. Clean-host
install, reboot, login/logout, upgrade, and rollback proof remain self-hosted platform-lab gates,
and macOS/Linux live execution is not claimed from Windows-side rendering tests.
