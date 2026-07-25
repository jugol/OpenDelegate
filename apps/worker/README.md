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
  [--agent auto|codex|claude] [--codex-home ABSOLUTE_LOCAL_PATH] \
  [--claude-home ABSOLUTE_LOCAL_PATH] \
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

### Headless systemd Linux

Provision the encrypted master credential and a non-secret backend descriptor
without putting key material in argv or the environment:

```text
opendelegate worker secret-backend-provision \
  --secret-backend-config /etc/opendelegate/worker-secret-backend.json \
  --encrypted-credential-file /etc/credstore.encrypted/opendelegate-vault-key.cred \
  --vault-root /var/lib/opendelegate/secrets/systemd-vault
```

The command generates 32 random bytes in-process, sends them only to
`systemd-creds encrypt` over stdin, zeroes the buffer, and writes only the encrypted
credential plus descriptor. It refuses to overwrite either file.

Run enrollment inside a transient systemd unit that decrypts the credential for the
same non-login identity that will run the Worker:

```text
systemd-run --wait --pipe --collect --uid=opendelegate \
  --property=StateDirectory=opendelegate \
  --property=LoadCredentialEncrypted=opendelegate-vault-key:/etc/credstore.encrypted/opendelegate-vault-key.cred \
  /opt/opendelegate/current/bin/opendelegate worker join \
  --grant-file ABSOLUTE_LOCAL_PATH \
  --secret-backend-config /etc/opendelegate/worker-secret-backend.json \
  --home /var/lib/opendelegate/worker
```

The native Linux service configuration must carry the same non-secret mapping:

```json
{
  "systemdCredential": {
    "credentialName": "opendelegate-vault-key",
    "encryptedSourcePath": "/etc/credstore.encrypted/opendelegate-vault-key.cred"
  }
}
```

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
updates Worker configuration to `windows-service-dpapi`. Copy the emitted
non-secret service name, SID, handoff root, and vault root into the native service
configuration's `serviceSecretBinding`. Install preflight verifies the SID again.
An interrupted retry resumes from the encrypted handoff. While the owner record
still exists it remains authoritative and replaces any stale handoff before
deletion.

The service consumes the handoff only when its current identity matches, then stores
the Device identity with `CurrentUser` DPAPI under that service profile. No Secret
is accepted in argv or environment. Clean-host SCM, restart, reboot, ACL, and DPAPI
proof remains a live platform gate and is not implied by the injected tests.
