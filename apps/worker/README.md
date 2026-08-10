# OpenDelegate Worker

`@opendelegate/worker` is the runnable outbound-only Worker daemon and CLI for
macOS, Windows, and Linux.

The packaged entrypoint is:

```text
opendelegate worker help
```

Enrollment accepts only a protected local grant file:

```text
opendelegate worker join --grant-file ABSOLUTE_LOCAL_PATH \
  [--agent auto|codex|claude] \
  [--codex-executable ABSOLUTE_NATIVE_EXECUTABLE] [--codex-home ABSOLUTE_LOCAL_PATH] \
  [--claude-executable ABSOLUTE_NATIVE_EXECUTABLE] [--claude-home ABSOLUTE_LOCAL_PATH] \
  [--claude-network-domain APPROVED_DNS_NAME ...]
```

The command generates the Device key locally, performs pinned TLS enrollment,
persists the private key through the selected OS-managed Secret Store, writes only
public identity and runtime configuration outside the installation, and verifies a
normal mutual-TLS WSS connection before reporting success. If enrollment succeeds
but that first channel check fails, the retained identity can be inspected with
`worker status` and `worker diagnose`; the command does not falsely report a joined
Worker.

`Auto` selects Windows DPAPI, the signed macOS Keychain helper, or Linux Secret
Service when the current session can actually use it. A headless Linux host must
select the systemd credential-backed vault explicitly; `Auto` never invents or
persists a plaintext fallback key.

### Re-credential an existing Worker

Use re-credentialing only to recover the same Device from an expired credential or
an unrecoverable per-generation channel mismatch. On Main, issue a short-lived grant
with the existing Device ID and `--recredential`. Never open or paste that file.

Stop an installed Worker service before running `worker join` with the same Worker
home. A successful replacement must have a newer certificate generation and keeps
the existing Agent, platform-mutation, Workspace, and creation metadata. On Windows,
`join` first binds the new Secrets to the owner account; run
`windows-service-secret-stage` with the existing instance, handoff root, vault root,
and Worker home before restarting the service. The staging command replaces the old
handoff only after the new owner-bound records are durable. If any step after Main
accepts the grant is uncertain, do not replay it—inspect `worker status` and Main's
Device record before issuing another grant.

On macOS, prefer to execute `worker join` from Terminal.app in the signed-in desktop
session. An SSH or background process can pass a read-only Keychain health check while
still being unable to write the required Secrets. OpenDelegate proves the stable core
Secret writes before submitting the one-use Grant to Main. A failure in that preflight
leaves the Grant reusable until expiry and suggests Terminal.app as one possible remedy;
it does not assume that every Keychain failure is caused by SSH. Once an enrollment
request may have reached Main, the CLI says not to replay the retained Grant and directs
the owner to inspect Main before issuing a fresh one. Never replace this boundary with a
plaintext key.

### Headless systemd Linux

Provision the encrypted master credential and a non-secret backend descriptor
without putting key material in argv or the environment:

```text
opendelegate worker secret-backend-provision \
  --secret-backend-config /etc/opendelegate/worker-secret-backend.json \
  --encrypted-credential-file /etc/credstore.encrypted/opendelegate-vault-key.cred \
  --vault-root /var/lib/opendelegate-runtime/state/secrets/systemd-vault
```

The command generates 32 random bytes in-process, sends them only to
`systemd-creds encrypt` over stdin, zeroes the buffer, and writes only the encrypted
credential plus descriptor. It refuses to overwrite either file.

Run enrollment inside a transient systemd unit that decrypts the credential for the
same non-login identity that will run the Worker:

```text
systemd-run --wait --pipe --collect --uid=opendelegate \
  --property=StateDirectory=opendelegate-runtime \
  --property=LoadCredentialEncrypted=opendelegate-vault-key:/etc/credstore.encrypted/opendelegate-vault-key.cred \
  /opt/opendelegate/current/bin/opendelegate worker join \
  --grant-file ABSOLUTE_LOCAL_PATH \
  --secret-backend-config /etc/opendelegate/worker-secret-backend.json \
  --home /var/lib/opendelegate-runtime/state
```

Join records the core IPC public pin and exact non-root service identity after
proving that identity can open and write the final vault. Compose a create-new
headless service document from that durable binding:

```text
opendelegate worker service-document \
  --output /tmp/opendelegate-worker.json \
  --bundle /opt/opendelegate-candidate \
  --install-root /opt/opendelegate \
  --data-root /var/lib/opendelegate-runtime \
  --health-port 43190 --instance-id personal \
  --home /var/lib/opendelegate-runtime/state \
  --owner-user OWNER --owner-uid OWNER_UID --owner-home /home/OWNER
opendelegate service plan install --config /tmp/opendelegate-worker.json
```

The document carries the same non-secret mapping:

```json
{
  "systemdCredential": {
    "credentialName": "opendelegate-vault-key",
    "encryptedSourcePath": "/etc/credstore.encrypted/opendelegate-vault-key.cred"
  }
}
```

It explicitly sets `helperSecretBinding` to `null` and emits no helper key, user
unit, supervisor command, or helper health check. That is the correct shape for a
headless NAS: non-graphical work stays available and Computer Use is unavailable by
configuration. Graphical Linux still requires a separate owner-session Secret
Service key and two-plane preparation; never place that helper key in the systemd
core vault.

## Local state

The default home is platform-specific and always outside the release/source tree.
An owner may set an absolute `OPENDELEGATE_WORKER_HOME` or pass `--home`.
Configuration, durable channel state, Worker runtime state, native session
references, Workspace registrations, and Device-local Knowledge remain under that
home. Knowledge is queried only for bounded initial context when a new native
session starts; it is neither sent to Main nor injected again on resumed turns.

Every ready Worker Run also receives a separate, one-time local Knowledge MCP
capability. Its strict stdio server supports repeated bounded search, open,
relationship, and qualifying upsert calls within cumulative candidate, opened-text,
and context budgets. The capability is bound to the exact Task, Work Order, Run,
Device, lease, and fencing token and is revoked with the Run. It carries no
Computer Use authority. Provider-normalized events retain only the Knowledge tool
name and success/failure status; queries, note IDs, titles, previews, links, content,
and results do not enter reports, Artifacts, diagnostics, Main, or Admin Web.

## Runtime

The daemon deterministically selects configured Main routes, resumes durable
channel state, and dispatches bounded Work Orders to a compatible Codex or Claude
native session. Local Workspaces must be explicitly registered in Worker
configuration. Main receives scheduling metadata, never their canonical local
paths.

Heartbeat inventory includes bounded descriptive hardware evidence. Node's OS
surface supplies the CPU model, logical core count, and total memory. GPU evidence
is `not-observed` unless an explicit platform probe supplies a bounded model, vendor,
and memory projection. Raw command output, bus identifiers, serial numbers, driver
paths, and local filesystem paths never cross the Device channel.

When Main includes an Agent requirement in a Run, Worker requires that provider and
optionally the exact adapter and allowed compatibility set. It does not fall back to
another provider. Device `auto` selection applies only when the Run omits this
requirement. Terminal events return a safe actual provider/adapter/native-session
lineage observation to Main, but never the local cwd, worktree path, or session key.

Long-running Runs renew only their exact Main-issued lease identity. Each fresh
Device-channel handshake calibrates Main wall time against Worker monotonic time;
the Worker retries one durable renewal command only before its conservative
deadline. A disconnect preserves existing authority until that deadline but cannot
extend it. Reconnect recalibrates before applying dispatch or a durable renewal
response. Artifact, Knowledge, platform mutation, Computer Use, and protected
action capabilities follow an advanced expiry without changing Run identity or
fence and fail closed on expiry, clock discontinuity, rejection, or mismatch.
Main sends the durable renewal response before acknowledging the Worker command,
and the Worker applies those ordered frames serially. If the Worker process itself
restarts, it does not reconstruct that in-memory execution authority: every
interrupted Run is reported failed and Main must issue a distinct higher-fenced Run
for retry.

Agent Runs may declare result files through the provider-neutral
`manifest.v1.json` contract under their per-assignment Artifact output directory:

```json
{
  "schemaVersion": 1,
  "assignmentFingerprint": "<64-lowercase-hex-digest>",
  "artifacts": [
    {
      "relativePath": "reports/summary.md",
      "mediaType": "text/markdown",
      "originalFilename": "summary.md",
      "requestedPresentation": "inline"
    }
  ]
}
```

The Worker supplies the output directory, manifest path, and assignment fingerprint
to the selected adapter in reserved environment variables and a bounded prompt
contract. The staging directory is under Worker runtime state, never the source
checkout. Files must be regular, non-symlink descendants of that directory.
Manifest size, Artifact count, individual size, and aggregate size are bounded.
Unsafe paths, unsupported presentation choices, a stale assignment fingerprint, or
content that changes during validation fail the Run.

`FileManifestWorkerArtifactLifecycle` validates every declaration before transfer,
then derives stable Artifact IDs from the exact assignment binding, normalized
metadata, size, and content digest. `WorkerArtifactUploader` obtains a Main-issued,
short-lived upload grant over the authenticated Device channel, verifies the grant,
probes Main's durable offset, and sends bounded chunks with stable idempotency keys.
A lost HTTP response or Worker restart resumes from Main's offset rather than
exposing a local web server or replaying completed bytes. Run lease and fence
authority are rechecked before prepare, before upload, and after upload. Terminal
Run success is not emitted until every declared upload is confirmed complete; only
those completed Artifact IDs enter the terminal event. Credentials and Artifact
content are never written to the Worker Run journal or logs.

Production prefers Codex App Server and Claude Agent SDK. Their native session IDs
are durable per Task workstream, and Worker-native actions use a Device-local bridge
to Main's exact Policy and Approval boundary. The full action input is fingerprinted
on the Device; only the fingerprint and bounded presentation metadata cross the
channel. A durable allow is consumed only after a final Run lease and fencing check.
Device-local Knowledge calls stay entirely inside their separate one-use capability
boundary.

All four production adapters share one file-backed native-session writer lease
store under private Worker state. Independent Worker processes therefore cannot
append to the same Task/workstream session concurrently, and a restart preserves
the active lease until its bounded expiry rather than resetting the fence in
memory. Release proof still requires live concurrent Codex and Claude append
attempts across a forced Worker restart.

### Platform mutation capability

Platform mutation is disabled until setup records absolute, verified executable
paths in the Worker configuration. For example, a Linux Worker may include:

```json
{
  "platformMutation": {
    "executables": {
      "npm": "/usr/bin/npm",
      "apt-get": "/usr/bin/apt-get",
      "tailscale": "/usr/bin/tailscale",
      "ufw": "/usr/sbin/ufw"
    }
  }
}
```

Production automatic project installation currently supports **npm only**. It uses
a fresh credential-free npm home, the official npm registry, scripts disabled,
sealed staging below private Worker state, and validation before promoting the
result into the exact canonical Workspace or managed worktree. On Windows, the
boundary resolves and pins `node.exe` plus `npm-cli.js` from the configured
`npm.cmd` installation and launches that typed pair directly; it never invokes
`cmd.exe` or a shell. The Agent tool cannot supply a working directory. The
one-use capability pins the directory chain and filesystem identity and checks it
again after Policy authorization immediately before process spawn. Sibling paths,
symlinks, junctions, reparse-point aliases, and a replaced Workspace fail closed.

System installation supports only owner-configured platform managers: `apt`,
`apt-get`, `dnf`, `yum`, or `zypper` on Linux; `brew` on macOS; and `winget` or
`choco` on Windows. Worker pins the exact canonical executable identity and
SHA-256 for its process lifetime, revalidates it immediately before execution,
and accepts only the manager-specific install form built from bounded package
names. A changed manager binary fails closed until Worker restart. Adding or
changing a package source is never folded into this path and remains a protected
action. Clean-host installation and privilege proof for each advertised target
manager is still a release gate.

Repository additions, remote installer scripts, untrusted installers, driver or
kernel changes, and OS network, VPN, or firewall changes always cross Main's exact
Policy and Approval boundary. Every invocation uses a configured executable and an
argv array with `shell: false`; command output and the executable path do not enter
the capability, Run journal, or public report. Completion is durably journaled so
an uncertain in-progress command is never retried automatically.

The Worker never self-elevates. A system mutation succeeds only when the service
identity has been granted the required narrow OS permission or an explicitly
configured privileged boundary supplies it. Clean-host proof of that delegation
remains a platform release gate.

CLI adapters remain capability-reduced fallbacks. They receive `permissions: deny`
for provider-native tools; explicitly composed OpenDelegate MCP capabilities retain
their own independent authorization. Native Windows Claude SDK execution is
reported incompatible because its required sandbox is unavailable there. Codex and
Claude each use a separate OpenDelegate-controlled provider home below Worker state
unless the owner supplies an external absolute path. Authenticate those exact homes
explicitly; an existing login from the user's global provider home is intentionally
not copied or inherited. Provider credentials are never accepted through a Run
environment or written into the checkout. Claude network access is limited to the
DNS names recorded at join.

On Linux, a present `bubblewrap` executable is not sufficient readiness evidence.
The Worker also proves that the nested user namespace required by Claude's fail-closed
sandbox can start. If AppArmor, a container policy, or the kernel blocks it, the
adapter is reported `platform-incompatible` so a declared Prefer fallback can be
selected. OpenDelegate does not weaken the Device sandbox automatically.

The effective provider, adapter, model, and optional effort are part of the native
session binding. Worker validation, durable session keys, resume, and owner-safe Run
observations preserve that exact binding; a later turn cannot silently inherit a
different model or tuning value.

An always-on service often has a smaller `PATH` than the owner's terminal. Use
`--codex-executable` or `--claude-executable` at join when the provider is installed
outside that service path. Windows requires a native `.exe`; `.cmd` and `.bat`
wrappers stay rejected because Worker never invokes a shell. If an external provider
home belongs to the owner, grant only the exact OpenDelegate service identity the
access that provider needs, or keep the provider home service-local and authenticate
it separately.

The core daemon does not assume a graphical session. Native service and
user-session helper installation are separate platform operations exposed by the
release service lifecycle.

### Windows SCM Secret staging

Windows join first creates an owner-bound `windows-dpapi` record. Before installing
the Worker as `NT SERVICE\OpenDelegate-<instance>`, move that identity through the
packaged encrypted staging boundary:

```text
opendelegate worker windows-service-secret-stage \
  --instance-id personal \
  --handoff-root C:\ProgramData\OpenDelegate\state\secrets\handoff \
  --vault-root C:\ProgramData\OpenDelegate\state\secrets\service \
  --home ABSOLUTE_WORKER_HOME
```

The command resolves the SCM virtual-service SID, creates only a SID-protected
DPAPI-NG handoff, deletes the owner DPAPI record after the handoff is durable, and
updates Worker configuration to `windows-service-dpapi`. Before deleting the core
copies, it durably records only their public IPC pins and the separate owner-helper
vault location. A crash after that configuration switch resumes deletion without
reopening service-account-sealed material. Install preflight verifies the SID again.
An interrupted retry resumes from the encrypted handoff. While the owner record
still exists it remains authoritative and replaces any stale handoff before
deletion.

Compose the complete, create-new service document from those durable local facts;
do not transcribe keys, SIDs, or bundle checksums:

```text
opendelegate worker service-document \
  --output ABSOLUTE_NEW_SERVICE_JSON \
  --bundle ABSOLUTE_VERIFIED_BUNDLE \
  --install-root "C:\Program Files\OpenDelegate" \
  --data-root "C:\ProgramData\OpenDelegate" \
  --health-port 43190 --instance-id personal \
  --home "C:\ProgramData\OpenDelegate\state"
opendelegate service plan install --config ABSOLUTE_NEW_SERVICE_JSON
```

Review the plan, then run the separately elevated `service install` command with a
caller-stable command ID. `service-document` never overwrites an existing file and
does not elevate or register a service.

The current command deliberately refuses macOS and graphical Linux rather than
producing a document whose core service and owner-session helper point at the same
Secret authority. Their separate service-account migration remains a release
blocker. Explicitly headless Linux follows the core-only path above.

The service consumes the handoff only when its current identity matches, then stores
the Device identity with `CurrentUser` DPAPI under that service profile. No Secret
is accepted in argv or environment. Clean-host SCM, restart, reboot, ACL, and DPAPI
proof remains a live platform gate and is not implied by the injected tests.
