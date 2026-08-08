---
name: opendelegate-join
description:
  Enroll or repair the current macOS, Windows, or Linux Device as an outbound-only OpenDelegate
  Worker for a fixed Main. Use when the owner supplies a single-use enrollment grant, asks to add
  this computer or NAS, rotate or recover its Device identity, configure its ordered Main routes,
  install its Worker service, or diagnose a failed join without exposing credentials.
---

# Join an OpenDelegate Device

Keep the join deterministic. The Agent guides and diagnoses; the packaged Worker owns key
generation, pinned enrollment, certificate storage, and channel validation.

## Owner outcome

Turn this computer into one outbound Worker for the owner's fixed Main without asking the owner to
design a Device-to-Device mesh or decide which future Tasks belong here. Detect this Device's OS,
Workspaces, Agent Adapters, routes, and verified Capabilities; enroll them so Main can place work
automatically. The owner should later state outcomes in Discord while OpenDelegate decides whether
this Worker, another Worker, or several OS families are required.

If the owner gave you only the repository URL or a verified bundle plus a short-lived grant,
identify the installation input below and complete the join journey. Ask only for an owner choice
that changes their intent or Policy. Never ask for another Device's local path, credential,
Knowledge, or SSH trust.

## 1. Verify the installation input

Accept either:

- a packaged bundle containing `release-metadata.json`, `SHA256SUMS`, `runtime`, and the platform
  launcher; or
- the OpenDelegate source checkout containing `CONTEXT.md`, the canonical documents, and the locked
  workspace.

For a bundle, verify every checksum before invoking a launcher and read `docs/release/README.md`.
Treat `internal-preview-*` as unsupported validation software.

For source, read the canonical files in `AGENTS.md` order, run `pnpm release:status`, and use an
integrity-checked bundle built with exact Node `24.18.0`. Do not install a service from a dirty
checkout or call a TypeScript source entrypoint as the production Worker.

Keep Worker state outside the checkout, bundle, Git repositories, and Device Knowledge. Use the
platform default unless the owner selected an absolute `OPENDELEGATE_WORKER_HOME`.

## 2. Handle the grant without exposing it

Require a short-lived, single-use grant file or another local OS-secure handoff. Never ask the owner
to paste the raw grant into chat, Discord, a command argument, an environment variable, a log, or a
diagnostic.

The normal Main-side source is:

```text
opendelegate device grant --device-id DEVICE_ID --output ABSOLUTE_LOCAL_PATH
```

This command prints only the Grant ID, Device ID, expiry, and file path. Treat the file itself as a
credential even though its CA certificate and endpoints are public. Do not open it with an Agent,
render it in a terminal, or copy it through a Task.

Pass only the grant file path to the packaged join command. The command must open one stable regular
file without following links, validate restrictive permissions where the OS supports them, consume
the secret through a bounded callback, and persist no raw token. If that interface is unavailable,
stop and report that enrollment is not implemented in this build.

Do not derive a Device identity from a VPN address, hostname, SSH key, or shared API key. Tailscale,
Omada, LAN, and tunnels provide reachability only.

## 3. Inspect before mutation

Detect without prompting:

- OS, architecture, service manager, and graphical-session availability;
- an existing Worker identity and certificate status;
- the configured ordered Main endpoints and CA/SPKI pin;
- service and user-helper state;
- Codex, Claude, Git, browser, container, and Computer Use readiness; and
- whether the Device is headless.

Probe only endpoints already present in the grant or owner-approved configuration. Do not scan a
subnet, open a firewall, install a VPN, add a package source, or create pairwise SSH trust.

## 4. Enroll

Inspect the packaged launcher help first. Use its supported equivalent of:

```text
opendelegate worker join --grant-file ABSOLUTE_LOCAL_PATH \
  [--agent auto|codex|claude] [--codex-home ABSOLUTE_LOCAL_PATH] \
  [--claude-home ABSOLUTE_LOCAL_PATH] \
  [--claude-network-domain APPROVED_DNS_NAME ...]
```

`Auto` is the provider default. Codex and Claude each use a separate OpenDelegate-controlled home
below Worker state unless an external absolute home is supplied. Authenticate those exact homes
through the provider's normal owner-interactive login before expecting a probe to become ready.
Never copy a global provider home, credential file, or login token into the controlled home, chat,
argv, environment, checkout, or configuration. Claude SDK ignores ambient settings and starts with
no extra network domains. Add only domains already required by owner-approved, configured package
sources. Native Windows Claude SDK is unavailable until its required sandbox can be enforced; select
Codex or use an explicitly configured WSL2/container Worker there.

On a headless systemd Linux Device, do not rely on `Auto` and do not create a plaintext key file.
First use the packaged deterministic boundary:

```text
opendelegate worker secret-backend-provision \
  --secret-backend-config /etc/opendelegate/worker-secret-backend.json \
  --encrypted-credential-file /etc/credstore.encrypted/opendelegate-vault-key.cred \
  --vault-root /var/lib/opendelegate-runtime/state/secrets/systemd-vault
```

It may run only in an already authorized administrative context; never invoke `sudo` or another
elevation mechanism autonomously. Before enrollment, verify that the eventual `opendelegate`
non-login account and primary group already exist with `/nonexistent` as home and `nologin` (or
`/bin/false`) as shell. If they are absent, prepare them with fixed-argv native account tools only
inside the owner's authorized administrative boundary; do not let a model invent a shell command or
silently reuse an interactive account. Then run `worker join` through an owner-reviewed transient
systemd unit with
`LoadCredentialEncrypted=opendelegate-vault-key:/etc/credstore.encrypted/opendelegate-vault-key.cred`,
`StateDirectory=opendelegate-runtime`, the eventual non-login Worker identity, the descriptor path,
and `/var/lib/opendelegate-runtime/state` as Worker home. Only encrypted-credential and descriptor
paths may appear in argv. The plaintext key must exist only in bounded stdin and the systemd runtime
credential directory. Join records the exact non-root service identity and core IPC public pin;
later service composition must consume those facts instead of asking a model to guess them.

That transient unit is a disposable enrollment boundary, not the installed Worker service. Do not
reuse its name for restart, persistence, or upgrade, and do not infer that stopping it leaves a
restartable unit definition behind.

On macOS, prefer to run `worker join` from the signed-in owner's Terminal.app session. An SSH or
background shell may pass a read-only Keychain check while still being unable to write required
Secrets. OpenDelegate must prove stable core Secret writes before submitting the one-use Grant to
Main. A failure in that preflight leaves the Grant reusable until expiry and may recommend the
desktop session without claiming that SSH caused every Keychain failure. If an enrollment request
may have reached Main, never replay the retained Grant: inspect Main first and issue a fresh Grant
only when recovery requires it. Do not weaken the Keychain backend or copy a key into a file.

The deterministic implementation must:

1. generate a Device-local non-exported or restrictively stored ECDSA P-256 key;
2. pin the enrollment TLS connection to the grant's expected Main identity;
3. send only the CSR and bounded discovery bootstrap with the single-use grant;
4. verify the returned certificate chain, Device URI SAN, public-key match, validity, and protocol
   range;
5. store the private key in the OS Secret Store or documented headless credential-backed vault, and
   keep the public certificate and instance chain in the restricted Worker configuration;
6. reconnect on the normal mutual-TLS WSS channel before declaring success; and
7. confirm that Main reports the same immutable Device ID and active certificate generation.

A rejected, expired, replayed, differently scoped, or already consumed grant fails closed. Do not
retry it by copying or editing the file. Ask Main to issue a new grant.

## 5. Configure runtime surfaces

Keep the Worker outbound-only. It receives versioned Work Orders and control messages, never Main
database credentials, a generic shell endpoint, or arbitrary remote paths.

Register local Workspaces explicitly. Main may receive their bounded scheduling metadata, but local
paths and Device Knowledge stay on this Device. Configure `opendelegate-worktree` only for a real
Git Workspace with the managed worktree lifecycle enabled.

Use the packaged deterministic boundary rather than editing Worker configuration:

```text
opendelegate worker workspace-register --workspace-id ID --alias NAME \
  --type directory|git|mounted-storage --path ABSOLUTE_PATH \
  --isolation none|agent-native-worktree [--capability NAME ...]
opendelegate worker workspace-list
```

The register command may show the canonical path locally. Do not copy that path into Main, Discord,
or cross-Device prompts. The list command is the scheduling-safe handoff surface and omits it.

Install the native core service only when the bundle exposes verified service commands and the owner
approved persistent startup. Configure the graphical helper separately at user login. Headless Linux
must remain healthy with desktop and Computer Use reported unavailable.

For headless systemd, copy the descriptor's `credentialName` and `encryptedCredentialFile` into the
service configuration's `systemdCredential` mapping. Do this through the packaged
`worker service-document` command, not by writing JSON. The generated unit must contain
`LoadCredentialEncrypted=` and the Worker must see the matching runtime `CREDENTIALS_DIRECTORY`. It
must set `helperSecretBinding` to `null` and contain no helper pin, helper Secret reference, user
unit, helper command, helper health check, or Computer Use readiness claim.

On Windows, an ordinary foreground join intentionally creates an owner-bound DPAPI record. Before
installing the Worker service, invoke the packaged one-way encrypted staging boundary:

```text
opendelegate worker windows-service-secret-stage \
  --instance-id INSTANCE_ID \
  --handoff-root ABSOLUTE_STATE_PATH\secrets\handoff \
  --vault-root ABSOLUTE_STATE_PATH\secrets\service \
  --home ABSOLUTE_WORKER_HOME
```

Use the emitted non-secret backend, service name, SID, handoff root, and vault root as the native
service configuration's `serviceSecretBinding`. The command also persists the public core/helper IPC
pins and the original owner-helper vault before deleting core-owned source copies. Never transcribe
or request private-key bytes.

Generate the install input from the staged Device rather than writing JSON by hand:

```text
opendelegate worker service-document --output ABSOLUTE_NEW_PATH \
  --bundle ABSOLUTE_VERIFIED_BUNDLE --install-root ABSOLUTE_INSTALL_ROOT \
  --data-root ABSOLUTE_DATA_ROOT --health-port PORT --instance-id INSTANCE_ID \
  --home ABSOLUTE_WORKER_HOME
opendelegate service plan install --config ABSOLUTE_NEW_PATH
```

For an explicitly headless systemd Worker, provide the installation owner's exact Unix identity; the
service account is read from the durable enrollment binding and must not be transcribed:

```text
opendelegate worker service-document --output ABSOLUTE_NEW_PATH \
  --bundle ABSOLUTE_VERIFIED_BUNDLE --install-root /opt/opendelegate \
  --data-root /var/lib/opendelegate-runtime --health-port PORT \
  --instance-id INSTANCE_ID --home /var/lib/opendelegate-runtime/state \
  --owner-user OWNER --owner-uid OWNER_UID --owner-home /home/OWNER
opendelegate service plan install --config ABSOLUTE_NEW_PATH
```

If this enrolled Device is also the fixed Main, do not install the Worker document. Feed it to
`opendelegate service document --worker-config ABSOLUTE_NEW_PATH --output NEW_MAIN_PATH --home MAIN_HOME`
while the same systemd credential is loaded, review the Main install plan, and install only that
Main document. The resulting core service starts Main and this local Worker together.

The output is create-new and contains no Secret values. Review the plan, then run the separately
elevated `service install` with a caller-stable command ID. The installer independently verifies the
SID before mutation; the service imports the SID-protected handoff into its own CurrentUser DPAPI
profile. A pre-existing staged Worker without the durable public preparation binding must use
`windows-service-secret-restore` when its handoff is owner-restorable, or a new owner-approved
re-credentialing Grant when service-account sealing prevents that restore, and then stage again. Do
not guess the missing pins.

The current `service-document` path intentionally refuses macOS and graphical Linux until their
core-service and owner-session Secret stores have an equally explicit migration. Explicitly headless
Linux uses only the core plane and must not fabricate the absent graphical plane. Do not hand-author
a document or weaken the two-plane identity boundary to bypass either blocker. Do not claim
persistent Windows or headless Linux support until their respective clean-host restart, reboot,
credential, ownership, networking, and lifecycle evidence is recorded.

Network, firewall, driver, kernel, new package-source, and remote-installer changes still require
owner approval. Installing packages from already configured official sources may use the accepted
automatic default.

## 6. Verify and hand off

Run the packaged Worker status and diagnostics interfaces. Report, without secrets:

- immutable Device ID and certificate generation;
- selected endpoint and bounded fallback trace;
- daemon, user-session helper, desktop, and permission readiness separately;
- registered Workspace aliases and scheduling capabilities, never local paths;
- Codex and Claude compatibility/auth states;
- Computer Use availability or the exact missing permission/helper;
- Worker service state; and
- every unrun or externally blocked release proof.

Force one reconnect and confirm ordered outbox replay is idempotent before calling the join healthy.
If a private key is lost, use a new owner-approved recovery enrollment. Never recreate the old key
or silently replace native-session lineage.

Call the outcome a joined validation Worker when the bundle is an internal preview. Call it a
supported Worker only after the exact bundle has passed the documented release and platform gates.
