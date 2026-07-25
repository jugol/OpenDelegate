# Device-local Secret Stores

`@opendelegate/secrets` owns the local credential boundary required by
`CONTEXT.md` invariant 11 and `PRODUCT_SPEC.md` FR-17. A Device exposes only an
alias and readiness. Secret values remain on the Device that uses them.

## Public contract

`ManagedSecretStore` supports binary Secret material so provider tokens, IPC keys,
and PKCS#8 Device identity keys use one boundary:

- `health()` and `availability(alias)` return non-sensitive readiness metadata;
- `store(alias, bytes)` creates an alias and rejects an existing alias;
- `rotate(alias, bytes)` replaces an existing alias and rejects a missing alias;
- `delete(alias)` is idempotent; and
- `executeWithSecretBytes(alias, callback)` makes one zeroed copy available only
  for the callback and discards the callback result.

The contract intentionally has no `get()` method. JavaScript cannot stop a hostile
callback from copying bytes, so callers remain part of the trusted Device runtime.
The store zeros its own scoped buffers after the callback and wraps callback,
native-process, and backend failures in stable messages that do not include native
stderr or Secret values.

`ManagedDeviceIdentitySecretStore` structurally implements the
`DeviceIdentitySecretStore` contract without introducing a workspace dependency
cycle. It exports a newly generated P-256 private key only long enough to store its
PKCS#8 bytes, then imports stored bytes into Web Crypto as a non-extractable
`CryptoKey`. Signing happens inside the scoped callback. Raw PKCS#8 or JWK material
is never returned as metadata.

All native processes are launched with `shell: false`, an absolute executable,
structured arguments, a small environment allowlist, bounded stdin/stdout/stderr,
and a timeout. Secret bytes use stdin and are never placed in argv or environment.

## Backend matrix

| Device context | Backend | Persistent representation | Fail-closed condition |
| --- | --- | --- | --- |
| Windows foreground owner | `windows-dpapi` | Current-user DPAPI ciphertext in a Device-local ACL-restricted vault | DPAPI, PowerShell, ACL hardening, or the owner profile is unavailable |
| Windows SCM virtual service | `windows-service-dpapi` | Current-user DPAPI ciphertext under the exact service identity | SID-bound handoff, service identity, DPAPI, service profile, or ACL hardening is unavailable |
| macOS signed release helper | `macos-keychain` | Device-only generic-password item in the data-protection Keychain | helper path, SHA-256, code signature, Keychain, or first-unlock state is unavailable |
| Ubuntu graphical user session | `linux-secret-service` | Secret Service item addressed by hashed Device and alias attributes | `secret-tool`, D-Bus session, collection unlock, or Secret Service is unavailable |
| Headless systemd service | `linux-systemd-credential-vault` | AES-256-GCM ciphertext under the runtime home; the vault key is a systemd runtime credential | the exact 32-byte runtime credential or restrictive vault path is unavailable |

There is no plaintext file fallback. Linux setup must choose Secret Service for a
logged-in graphical user process or explicitly provision the systemd
credential-backed vault for a system/headless service.

## Windows DPAPI

`WindowsDpapiSecretStore` uses `ProtectedData` with `CurrentUser` scope. The
OpenDelegate service must keep the same least-privilege Windows identity across
restart and upgrade. Its configured vault must be outside the source checkout.
The vault claims a dedicated root with a non-secret namespace marker and refuses a
path that overlaps the checkout or already contains unrelated data. Initialization
then removes inherited ACLs and grants the current service identity only; DPAPI
remains the cryptographic boundary if another administrator can inspect the
ciphertext.

The PowerShell program is fixed source owned by this package. It receives a
Device-and-alias binding plus Secret bytes on stdin and emits only DPAPI ciphertext
or scoped plaintext on stdout. Native stderr is bounded and discarded.

The Windows-only test performs a real DPAPI create/read/rotate/delete lifecycle on
the current host. That is implementation evidence, not the clean-host Windows 11
service, reboot, upgrade, and recovery proof required by the release ledger.

Worker join initially uses the foreground owner backend. Before SCM installation,
`worker windows-service-secret-stage` resolves the exact virtual-service SID with
fixed `sc.exe showsid` argv, wraps the Device identity in a DPAPI-NG envelope
protected to that SID, persists only ciphertext in a restrictive handoff vault, and
retires the owner-bound record. The durable Worker configuration then selects
`windows-service-dpapi`.

At core startup, the service backend verifies its current SID before touching the
destination vault, consumes the SID-protected envelope, re-protects it with
`ProtectedData CurrentUser` under the service profile, and deletes the handoff.
Restart verifies an existing destination before removing a stale handoff, and
owner-side retry replaces a stale handoff while the owner source remains
authoritative. Missing or mismatched identities and interrupted or corrupted
transfers fail closed. Native service preflight separately verifies that its non-secret
`serviceSecretBinding` names the same service and SID.

These command-shape and injected lifecycle tests still do not prove a clean-host
SCM profile, ACL, DPAPI-NG, restart, or reboot path. The Windows platform-lab gate
remains open until that evidence is recorded.

## macOS Keychain helper

The Keychain adapter does not use `/usr/bin/security -w` because that interface
would place the Secret in process arguments. Instead, the repository includes
[`opendelegate-keychain-helper.swift`](native/macos/opendelegate-keychain-helper.swift).
It uses the Security framework directly and reads/writes raw bytes only through
standard streams.

A release pipeline must compile the helper, sign it with the release identity,
include it in the signed/notarized bundle, and put its manifest SHA-256 into local
configuration. The adapter checks all of the following before every operation:

1. the helper is an absolute, regular, single-link executable rather than a symlink;
2. its bytes match `expectedHelperSha256`; and
3. `/usr/bin/codesign --verify --strict` succeeds.

The helper stores items with `kSecUseDataProtectionKeychain` and
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. They do not synchronize or
migrate to a different Device and remain unavailable until the first owner unlock
after a restart. Missing signing/notarization or real-host Keychain evidence keeps
macOS release support blocked; the TypeScript command-shape tests do not claim that
proof.

## Graphical Linux Secret Service

`LinuxSecretServiceSecretStore` uses the installed absolute `secret-tool` binary.
The item payload is a versioned base64 encoding because Secret Service stores a
password string while `ManagedSecretStore` is binary. The encoding travels only on
stdin/stdout. Device and alias attributes are SHA-256 identifiers, and the label is
fixed non-sensitive text.

Only `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `LANG`, and `LC_ALL` may enter
the child environment. This backend belongs in the logged-in graphical user
session. A headless system service without a working Secret Service session reports
unavailable and must use the systemd backend instead.

`secret-tool store` updates matching attributes, so OpenDelegate first enforces
create-versus-rotate semantics and relies on ADR-0011's single exclusive Device
service for the local writer boundary. Real Ubuntu GNOME Keyring lock/unlock,
logout, and reboot behavior remains a platform-lab gate.

## Headless systemd credential-backed vault

`SystemdCredentialKeyProvider` reads one exact 32-byte key from the service's
kernel-restricted runtime credential directory. `SystemdCredentialVaultSecretStore`
uses that key only inside a callback to encrypt and authenticate each record with
AES-256-GCM. The persistent vault contains only ciphertext; its filenames are stable
Device-and-alias hashes and do not depend on an immutable release path.

Provision the key as an encrypted systemd credential. One representative owner
flow is:

```text
head -c 32 /dev/urandom | systemd-creds encrypt \
  --name=opendelegate-vault-key \
  - /etc/credstore.encrypted/opendelegate-vault-key.cred
```

The packaged owner boundary is `opendelegate worker
secret-backend-provision`. It generates the key internally, sends it only to
`systemd-creds encrypt` over stdin, writes an encrypted credential and non-secret
descriptor without overwriting existing files, and never accepts raw key material
through argv or environment variables. `worker join --secret-backend-config` then
runs inside a transient systemd unit carrying the same encrypted credential.

Then configure the native unit with an absolute source and service sandboxing:

```ini
[Service]
LoadCredentialEncrypted=opendelegate-vault-key:/etc/credstore.encrypted/opendelegate-vault-key.cred
PrivateMounts=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/opendelegate/secrets
```

The service composition passes the non-secret credential directory path and
credential name to `SystemdCredentialKeyProvider`. It must not hard-code a path
when the service manager supplies `CREDENTIALS_DIRECTORY`; user services can use a
different runtime root. `systemd-creds` may bind encrypted credentials to TPM2, the
host key, or both according to the owner's provisioning choice. OpenDelegate never
generates or persists a plaintext fallback key.

See [systemd service credentials](https://systemd.io/CREDENTIALS/) for the runtime
credential guarantees, [Apple Keychain item accessibility](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly),
and the [`secret-tool` manual](https://manpages.ubuntu.com/manpages/noble/man1/secret-tool.1.html).

## Release-proof status

The default automated suite proves lifecycle semantics, binary identity-key
persistence, path/link rejection, authenticated corruption rejection, hostile native
output redaction, platform command shapes, and an actual DPAPI lifecycle on Windows.
It does not replace:

- a signed and notarized macOS helper build plus real Keychain lifecycle;
- Ubuntu GNOME Secret Service lock/logout/reboot proof;
- headless Ubuntu systemd encrypted-credential service/reboot proof; or
- database, prompt, log, event, diagnostic, Artifact, and child-process inspection
  across the complete three-Device scenario.

Those remain required before acceptance criterion 26 or the platform release matrix
can be marked verified.
