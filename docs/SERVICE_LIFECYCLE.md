# Native service lifecycle CLI

Status: **native adapters and release-authority verification implemented; real support-eligible
native signing, provisioned promotion evidence, and live privileged host proof remain required**

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
accept enabled Admin auto-open. Current-host mutation, status, and diagnosis require
the canonical `MAIN_HOME` to equal the template's `paths.stateRoot`, because the
installed service launches Main from that exact root. Cross-target `render` and
`plan` remain read-only and may intentionally describe a different target root.

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
join skill rather than manually creating a plaintext credential. That join must run
under the same non-login identity as the eventual service; it records that identity
and the core IPC public pin after proving access to the final vault.

For a genuinely headless Device, compose a core-only document after enrollment:

```text
opendelegate worker service-document --output /tmp/opendelegate-worker.json \
  --bundle /opt/opendelegate-candidate --install-root /opt/opendelegate \
  --data-root /var/lib/opendelegate-runtime --health-port 43190 \
  --instance-id personal --home /var/lib/opendelegate-runtime/state \
  --owner-user OWNER --owner-uid OWNER_UID --owner-home /home/OWNER
opendelegate service plan install --config /tmp/opendelegate-worker.json
```

The resulting document has `helperSecretBinding: null` and contains no helper pin,
Secret reference, user unit, supervisor action, or helper health check. It therefore
reports Computer Use as unavailable by configuration instead of repeatedly failing
a graphical service. Enabling a graphical helper later requires an explicit new
two-plane preparation and service document.

When this Device is also the fixed Main, do not install the Worker document. While
running under the same named systemd credential, derive one create-new Main document:

```text
opendelegate service document \
  --worker-config /tmp/opendelegate-worker.json \
  --output /tmp/opendelegate-main.json \
  --home /var/lib/opendelegate-runtime/state
opendelegate service plan install \
  --config /tmp/opendelegate-main.json \
  --home /var/lib/opendelegate-runtime/state
```

The first command proves that the initialized Main and local Worker use the same
Instance, Device, state root, and systemd credential mapping, while carrying forward
the Worker's already reviewed service identity. It changes only the runtime role and
effective Main preference. Run both commands in a
credential-bearing transient unit when Main uses
`linux-systemd-credential-vault`; PostgreSQL and protected Configuration inspection
must never receive a credential through argv or the environment. A headless Main
must keep `admin.open-on-login` disabled because it has no login helper.

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

The logged-in helper's `windows-dpapi` vault is different: it remains under the
owner-selected Worker home and must be disjoint from the checkout, bundle, install,
service-state, authority, runtime, log, handoff, and service vault roots. Staging
records that location plus the two public IPC pins before it removes core-owned
copies from the owner vault. It never copies the helper private key to the service.

After staging, compose a create-new Worker document from the Device itself:

```text
opendelegate worker service-document --output ABSOLUTE_NEW_PATH \
  --bundle ABSOLUTE_VERIFIED_BUNDLE --install-root ABSOLUTE_INSTALL_ROOT \
  --data-root ABSOLUTE_DATA_ROOT --health-port PORT --instance-id INSTANCE_ID \
  --home ABSOLUTE_WORKER_HOME
opendelegate service plan install --config ABSOLUTE_NEW_PATH
```

On macOS, first run the owner-session preparation from Terminal.app while the login
Keychain is unlocked; `sudo` may request the owner's password:

```text
opendelegate worker macos-service-secret-stage --home ABSOLUTE_WORKER_HOME \
  --binding-path "/Library/Application Support/OpenDelegate/INSTANCE/system-keychain-binding.json" \
  --system-helper "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-INSTANCE" \
  --service-user _opendelegate --service-group _opendelegate
```

When an already-enrolled owner Worker is migrated into `DATA_ROOT/state`, the
ordering is security-sensitive:

1. Run `macos-service-secret-stage` from the signed-in owner session.
2. Copy the complete Worker home to `DATA_ROOT/state` while it is still readable by
   the process that will compose the document.
3. Compose the create-new service document before recursively adopting the copied
   tree for the service identity. If the tree is already service-private, run only
   `worker service-document` from an elevated shell; it reads public configuration
   and writes no Secret values.
4. Make both `DATA_ROOT` traversable by the service identity and the copied state
   tree owned by that identity before launchd starts it. The owner remains a member
   of the service group for bounded read access.
5. Place the internal-preview publisher key at the verifier's canonical
   `STATE_ROOT/trust/publisher-ed25519.pem` path. `DATA_ROOT/trust` is not used.
6. Review `service plan install`, then run the elevated install with a stable
   command ID.

Automation must not change ownership first and then invoke `service-document` as
the unprivileged owner. An unreadable configuration is reported as
`CONFIG_PATH_UNSAFE`, not as a missing enrollment, and must be recovered in place;
it is never a reason to issue a new Enrollment Grant.

This production-shaped path is wired for staged Windows, prepared two-plane macOS,
explicitly headless systemd Linux Workers, and a headless Main derived from its
co-located Worker. macOS composition refuses an unprepared login-Keychain Worker or
a target bundle whose helper digest differs from the prepared stable helper.
Graphical Linux still fails closed until its separate service-account and
owner-session Secret migration is implemented; a hand-authored document is not a
substitute.

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

## Bundle assembly is not activation

`pnpm release:build` verifies a new bundle with temporary state and an isolated,
dynamically selected adjacent loopback listener pair. It does not use the configured
Main listeners, mutate the stable release pointer, or stop, restart, install, or
upgrade a service. A build on the fixed Main Device must therefore coexist with the
currently active version.

Activate persistent bytes only with the mutating commands below after the exact
bundle and external authority pass preflight. Never stop Main to make room for
packaged smoke, and never replace a journaled upgrade with a remote shell one-liner.
A process launched through `systemd-run` or another transient wrapper may be useful
for bounded internal-preview validation, but stopping it can remove the transient
unit itself. It is not a persistent installation and must not be used as upgrade,
restart, reboot, or release evidence.

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
  may change; the sole legacy exception is an otherwise byte-exact Windows core
  manifest whose SID type is `RESTRICTED`, which the canonical upgrade stops,
  changes to `UNRESTRICTED` in SCM, and rewrites before restart; any additional
  drift still fails before mutation; Admin auto-open changes use the narrow
  `reconfigure` operation;
- staging, versioned releases, and `current` must share one volume;
- install and upgrade select exactly one explicit release track. A legacy
  `INTERNAL_PREVIEW.md` payload must verify its detached Ed25519 preview attestation before
  untrusted traversal. A candidate-v2 payload must pass enclosed candidate inspection and the
  configured digest-addressed external release authority. Missing, invalid, promotion-invalid, or
  revoked authority prevents candidate installation; publisher-verified candidates may install
  only with effective `release-candidate`. Both tracks then verify every payload byte and both
  executable native service hosts.

Start, restart, and reconfigure do not depend on the original release source still being mounted.
Before mutation they revalidate the installed payload, native hosts, persisted release-verification
seal, and current external authority. Stop, status, diagnose, and uninstall retain their narrower
read-only or removal boundaries.

Publisher authentication by itself does not establish support promotion. The candidate resolver
keeps declared and effective channel separate: publisher-only authority authorizes an unpromoted
candidate installation, while only the complete platform-authenticity, promotion,
observer-read-back, supported-channel, and revocation-policy chain can authorize effective
`released`.

For the legacy unsupported-preview track, the external trust root is
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
  --public-key-destination ABSOLUTE_NEW_PUBLIC_KEY_PEM \
  --allow-unsupported-preview
```

The signer revalidates every manifest-bound byte, both native service hosts, target
metadata, and smoke evidence. It rejects candidates and requires
`--allow-unsupported-preview`; the signed support status remains unsupported. Copy the emitted
public key to the external trust-root path through an owner-controlled channel. The signer never
installs trust or changes a support channel.

Candidate-v2 authority is configured at:

```text
STATE_ROOT/trust/releases/<version>/<platform>-<architecture>/<checksumManifestSha256>/release-verification.json
```

Its strictly parsed external files bind the exact target archive, publisher attestation,
native-authenticity record, ledger, support matrix, 36 live-evidence records, notarization result,
promotion attestation, exactly three target-scoped observer-signed read-back envelopes,
supported-channel receipt, independently provisioned publisher, promotion, and observer trust
roots, and revocation policy. The read-back plan binds uploader authorization to the promotion key
ID while the distinct observer key proves the returned remote bytes and remains independently
revocable. Nothing inside the candidate can provision those authorities. The runtime keeps the
enclosed `release-candidate` identity and reports `released` only as the verified effective status.

A preflight failure returns, without a host mutation:

```json
{
  "level": "error",
  "code": "SERVICE_COMMAND_PREFLIGHT_FAILED",
  "message": "The failed privilege, tool, path, candidate-integrity, configured-authority, staging, or verification-seal requirement.",
  "mutationMayHaveOccurred": false,
  "requiresElevation": true
}
```

Current unsupported preview bundles include both native service host executables,
but they do not include a detached publisher attestation by default. The production
executor correctly refuses an unsigned preview. After the publisher explicitly
signs it with `--allow-unsupported-preview`, the bundle may be installed only for
unsupported platform-lab work; neither signing nor installation is support proof or
permission to publish it as a supported release.

Support-eligible macOS and Windows native code signatures must already be present
before `payload-manifest.json` and `SHA256SUMS` are generated. The native service
executor never signs, notarizes, staples, or rewrites a staged payload. For macOS,
the accepted notarization result for the exact final archive remains an external
sidecar verified by the promotion path.

After preflight, the filesystem adapter stages a link-free regular-file tree, re-inspects those
copied bytes, verifies the native hosts, promotes by same-volume rename, and writes a bounded
sanitized seal to `STATE_ROOT/release-verification/<version>.json`. It recomputes the current
external authority and compares the seal immediately before atomically switching `current`, then
writes definitions atomically, applies least-privilege ownership, and prunes only bounded
semantic-version release directories after health succeeds. Activation failure removes only the
new release and seal while preserving the prior active release and its seal.
Upgrade rollback switches only release bytes, service definitions, and the active
pointer. It must never replace the live runtime home or database with a backup: doing
so can rewind Device-channel sequences, Task state, leases, and other monotonic
authorities while Workers continue forward. Main backup restore is a separate,
stopped disaster-recovery procedure with the reconciliation requirements in
[`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md).
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

A supported release still requires real target-native signatures before manifests,
credentialed publisher finalization of exact archives, the external macOS notarization receipt,
independently provisioned publisher, promotion, and observer roots, a credentialed cross-platform
promotion run, immutable remote publication, exactly three observer-signed target read-back
envelopes, and a supported-channel receipt. The finalizer, verifier, and deterministic
promotion/receipt composition boundaries are implemented; every credential-bearing production run
must still execute from its clean committed, hash-pinned runner.

Those trust artifacts must then be followed by clean-host install, restart, reboot,
login/logout, failed-upgrade rollback, diagnostics, and uninstall proof on Windows,
macOS, and Linux. Native account tools, Windows locale behavior, launchd user
domains, systemd user buses, ACLs, atomic `current` replacement, and reboot
persistence must all be observed on the declared host versions. Computer Use
additionally requires its separate real graphical acceptance matrix. None of those
live gates is implied by the injected tests or a CI/self-signed preview.
