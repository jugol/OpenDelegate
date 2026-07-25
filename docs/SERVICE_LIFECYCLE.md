# Native service lifecycle CLI

Status: **native adapters implemented and composed; signed installable bundles and
live privileged host proof remain required**

OpenDelegate exposes its existing `@opendelegate/platform-services` definitions and
plans through one owner-facing CLI surface. The CLI does not turn a rendered
manifest into evidence that a service is installed, and it never treats core health
as Computer Use readiness.

## Configuration

Every command receives a strict JSON `PlatformServiceConfiguration` through
`--config PATH`. The file selects one platform (`windows`, `macos`, or `linux`), the
Main or Worker role, an external signed release bundle, external installation/state/
runtime/log paths, the owner-session identity, opaque `secret://` references, the
loopback core health endpoint, and the prior-version retention count.

For a Main template, every command also requires `--home MAIN_HOME`. The CLI opens
Main's durable Configuration repository, ignores any `adminAutoOpen` value copied
into the template, and renders the effective `admin.open-on-login` value with
Main's canonical Admin origin. Worker templates do not read Main state and do not
accept enabled Admin auto-open.

Unknown fields, raw Secret values, relative or source-checkout runtime paths,
untrusted health endpoints, malformed identities, unstable files, and files larger
than 256 KiB fail validation. Reading and validation do not write any service file.
All mutation roots must be disjoint and use a link-free canonical path. On macOS,
for example, configure `/private/var/...` rather than the `/var` compatibility
symlink.

The configured `ownerSession` also contains the persisted Admin login preference.
It is explicit even when disabled:

```json
{
  "adminAutoOpen": {
    "enabled": false
  }
}
```

When the owner enables the durable Main setting `admin.open-on-login`, render it
with the canonical Admin origin:

```json
{
  "adminAutoOpen": {
    "enabled": true,
    "url": "http://127.0.0.1:43180/"
  }
}
```

Only a Main configuration may enable this preference. The URL must be a canonical
HTTPS origin or a loopback HTTP origin and cannot contain credentials, a path,
query, or fragment.

Headless Linux may include one non-secret encrypted credential source:

```json
{
  "systemdCredential": {
    "credentialName": "opendelegate-vault-key",
    "encryptedSourcePath": "/etc/credstore.encrypted/opendelegate-vault-key.cred"
  }
}
```

The renderer emits `LoadCredentialEncrypted=` and `PrivateMounts=yes`. The source
must be absolute and outside the checkout; the configuration never accepts the
plaintext key. Use the packaged Worker `secret-backend-provision` boundary and the
join skill rather than manually creating a plaintext credential.

A Windows Main or Worker install or upgrade includes the non-secret binding emitted
by `worker windows-service-secret-stage`. Main stages the same binding because its
service hosts a co-located local Worker:

```json
{
  "serviceSecretBinding": {
    "backend": "windows-service-dpapi",
    "serviceName": "OpenDelegate-personal",
    "serviceSid": "S-1-5-80-...",
    "handoffRoot": "C:\\ProgramData\\OpenDelegate\\state\\secrets\\handoff",
    "vaultRoot": "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service"
  }
}
```

Both roots must be disjoint strict descendants of `stateRoot`. The values are
non-secret; preflight still resolves the SCM SID independently and refuses a
mismatch.

## Read-only commands

```text
opendelegate service render --config MAIN_TEMPLATE.json --home MAIN_HOME
opendelegate service plan install --config MAIN_TEMPLATE.json --home MAIN_HOME
opendelegate service plan restart --config MAIN_TEMPLATE.json --home MAIN_HOME \
  --active-version 1.2.3
opendelegate service status --config MAIN_TEMPLATE.json --home MAIN_HOME
opendelegate service diagnose --config MAIN_TEMPLATE.json --home MAIN_HOME
```

`render` returns the deterministic SCM/Task Scheduler, launchd, or systemd artifacts
and structured argv. `plan` returns the ordered, reversible operation plan and marks
that elevation is required. Other plan operations are `start`, `stop`, `upgrade`,
`reconfigure`, and `uninstall`. `render` and `plan` may prepare another platform's
artifacts. Mutation and inspection commands reject a configuration whose platform
does not match the current host.

`status` and `diagnose` use a native read-only inspector on Windows, macOS, and Linux.
It queries the native supervisor, the stable release pointer, retained release
directories, the loopback core health endpoint, and owner-session availability.
Unknown or locale-dependent host output remains `unknown`; it is never promoted to
`running`. In particular, a running daemon or installed helper definition never
implies Computer Use readiness. Until authenticated helper IPC supplies unlocked
desktop and permission evidence, Computer Use remains `unavailable`.

## Mutating commands

```text
opendelegate service install --config PATH --command-id service-install-0001
opendelegate service start --config PATH --active-version 1.2.3 \
  --command-id service-start-0001
opendelegate service stop --config PATH --active-version 1.2.3 \
  --command-id service-stop-0001
opendelegate service restart --config PATH --active-version 1.2.3 \
  --command-id service-restart-0001
opendelegate service reconfigure --home MAIN_HOME --config MAIN_TEMPLATE.json \
  --active-version 1.2.3 --command-id service-reconfigure-0001
opendelegate service upgrade --config NEW-BUNDLE.json --active-version 1.2.3 \
  --command-id service-upgrade-0001
opendelegate service uninstall --config PATH --active-version 1.2.3 \
  --command-id service-uninstall-0001
```

Each mutation requires a caller-stable command ID. The platform executor atomically
claims that ID in a durable operation journal below
`STATE_ROOT.service-operations-INSTANCE_ID/platform-services/`. The journal is a
deliberate sibling of the runtime state root so an explicit state purge can finish
and record its terminal outcome before the owner separately disposes of that
minimal operation history. Exact completed replay returns the prior terminal report
without a second mutation. Reusing the ID for
different intent fails. An in-progress or interrupted command fails closed as
uncertain until the platform recovery path inspects it.

The journal uses an exclusive cross-process lock and same-directory write, sync, and
rename. It strictly validates bounded UTF-8 JSON, rejects secret-shaped diagnostic
material, and never evicts replay history to make room. A lock left after a process
crash is not stolen automatically; the owner must inspect the host and the
in-progress journal entry before recovery.

The executor boundary routes structured account, filesystem/release, native
supervisor, and health actions to separate injected adapters. Native supervisor
commands remain validated argv arrays and never pass through a shell. Every action
receives a deterministic action ID, while the command journal owns durable replay.
Adapters report whether a step changed the host or was already satisfied. Fresh
install never adopts or overwrites an existing service definition or registration;
the owner must inspect and recover that collision explicitly.

`reconfigure` is deliberately narrow. It accepts only a Main configuration whose
effective and alternate documents differ solely in `admin.open-on-login`. Before
claiming the command, it verifies every installed definition byte-for-byte and
accepts the runtime configuration only in the exact prior or already-effective
state. It stops the owner-session helper, atomically replaces that one runtime
configuration with rollback bytes, restarts and health-checks the helper, and
leaves the core running. Any unrelated drift fails before mutation.

The default CLI now composes the current-host native adapter. It performs every
preflight before creating the command journal or entering a host mutation:

- the plan must exactly equal the canonical plan derived from the strict
  configuration;
- the configured OS must match the current host;
- Windows Main and Worker install and upgrade require a staged local-Worker service
  Secret binding and
  verify its service name and SID independently through fixed `sc.exe showsid`
  argv;
- the process must already be elevated; OpenDelegate never launches an elevation
  prompt or retries itself through `sudo`;
- every fixed native executable and owner-session wrapper must exist;
- mutation paths and their existing ancestors must be free of symbolic links,
  junctions and special files, and fresh-install service definition paths must be
  unoccupied;
- upgrade configuration must reproduce every installed supervisor, runtime, and
  Secret-reference definition byte for byte; bundle version, source, and checksum
  may change; Admin auto-open changes use the narrow `reconfigure` operation;
- staging, versioned releases, and `current` must share one volume;
- for install or upgrade, the detached Ed25519 publisher attestation must verify
  before untrusted payload traversal, the complete bundle manifest and every
  payload byte must then verify, and both native service hosts must be present and
  executable.

Reconfigure, start, stop, restart, status, diagnose, and uninstall do not depend on the original
release source still being mounted. They validate the installed topology and native
tools but reserve bundle trust checks for operations that introduce new bytes.

The external trust root is
`STATE_ROOT/trust/publisher-ed25519.pem`. The detached strict JSON attestation is
`BUNDLE_SOURCE.publisher-attestation.json`; it binds the SHA-256 of
`SHA256SUMS`, and `bundle.checksum` must contain that same digest as
`sha256:...`. Keeping both files outside the payload prevents a bundle from
authenticating a replacement key for itself.

Create these detached files only after the complete bundle has passed packaged
smoke:

```sh
pnpm release:sign --bundle ABSOLUTE_BUNDLE_PATH \
  --private-key ABSOLUTE_PRIVATE_KEY_PEM \
  --public-key-destination ABSOLUTE_NEW_PUBLIC_KEY_PEM
```

The signer revalidates every manifest-bound byte, both native service hosts, target
metadata, smoke evidence, and candidate completeness. Unsupported lab previews
require `--allow-unsupported-preview`; their signed support status remains
unsupported. Copy the emitted public key to the external trust-root path through an
owner-controlled channel. The signer never installs trust or changes a support
channel.

A preflight failure returns, without a host mutation:

```json
{
  "level": "error",
  "code": "SERVICE_COMMAND_PREFLIGHT_FAILED",
  "message": "The failed privilege, tool, path, bundle, or publisher-trust requirement.",
  "mutationMayHaveOccurred": false,
  "requiresElevation": true
}
```

Current unsupported preview bundles do not yet ship the two native service host
executables or a detached publisher attestation. Therefore the production executor
correctly refuses to install those previews. Rendering and planning remain
available for implementation and platform-lab preparation; this refusal must not be
weakened into a support claim.

After preflight, the filesystem adapter stages a link-free regular-file tree,
re-verifies it, promotes it by same-volume rename, atomically swaps the `current`
directory link, writes definitions atomically, applies least-privilege ownership,
and prunes only bounded semantic-version release directories after health succeeds.
Windows ACL changes use fixed `icacls.exe` argv. Linux creates a non-login system
account through fixed `groupadd`/`useradd`/`usermod` argv. macOS creates and validates
a hidden `/var/empty`, `/usr/bin/false` account through fixed `dscl` and
`dseditgroup` argv. No operation uses a shell.

Windows supervisor calls map only to System32 SCM and Task Scheduler executables.
Fresh install rejects an existing SCM service, and Task Scheduler creation omits
the force-overwrite switch.
macOS uses `launchctl`, including `asuser` for the configured LaunchAgent. Linux uses
system `systemctl` and invokes user-systemd through fixed `runuser` argv and the
configured owner's runtime bus. Linux performs the filesystem-only user-unit
enable/disable while the owner is logged out, but defers manager reload and process
start until a user manager exists. A partially completed multi-command supervisor
step is compensated before the plan-level rollback proceeds.

Ordinary uninstall preserves persistent state and logs. Purge additionally requires
`--purge-state --confirm-purge INSTANCE_ID`; a plan may preview purge without the
confirmation because planning is read-only.

## Two runtime planes

Every plan keeps these states separate:

- **core** — boot-persistent Main or Worker daemon for headless orchestration;
- **session helper** — owner-login process that reports graphical readiness.

The session helper also owns optional Admin auto-open. It waits for the exact
structured Main core health response, then atomically claims the current native
login session before invoking the OS URL opener. It never opens from the core
daemon, never uses a shell, never retries the browser in the same login session,
and gives up without affecting helper health when Main is not ready within the
bounded wait. Native launchers bind the claim to a Windows logon LUID, macOS audit
session ID, or Linux `XDG_SESSION_ID`. If that exact identity is unavailable, the
helper skips auto-open rather than weakening the once-per-session guarantee.

Only an authenticated helper observation can report Computer Use ready. A running
core, successful loopback health check, installed helper manifest, or logged-in user
alone is insufficient. Status and diagnostics preserve `core`, `helper`, and
`readiness` as separate fields.

## Remaining platform gate

The CLI, strict configuration reader, deterministic rendering/planning, durable
journal, native preflight, filesystem/account/supervisor/health adapters, rollback,
and read-only inspection have injected automated coverage. Tests do not mutate the
test host's native services.

A supported release still requires the bundle builder and promotion channel to
produce the required native hosts and detached publisher attestation, followed by
clean-host install, restart, reboot, login/logout, failed-upgrade rollback,
diagnostics, and uninstall proof on Windows, macOS, and Linux. Native account tools,
Windows locale behavior, launchd user domains, systemd user buses, ACLs, atomic
`current` replacement, and reboot persistence must all be observed on the declared
host versions. Computer Use additionally requires its separate real graphical
acceptance matrix. None of those live gates is implied by the injected tests.
