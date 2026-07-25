# ADR-0017: Device-local Secret Store backends

Status: **Accepted**

Date: **2026-07-25**

## Context

OpenDelegate requires Main and every Worker to keep credentials on the Device that
uses them. Main may persist only opaque references and readiness metadata. Agent
prompts, database records, command metadata, logs, diagnostics, events, and
Artifacts must not receive Secret values.

The required hosts do not share one safe credential facility. Windows services can
bind encrypted data to their service identity with DPAPI. A macOS process can use
Keychain Services, but the `security` command-line write interface would place a
password in argv unless an interactive terminal mediates it. A graphical Ubuntu
user session can use Secret Service, while a headless systemd service normally has
neither that D-Bus session nor an unlocked collection. Device identity also needs
binary P-256 private-key persistence across process restart, not only UTF-8 tokens.

An unsafe common denominator such as a mode-0600 plaintext file, environment
variable, service-unit literal, or database column would violate FR-17. A backend
that silently falls back when its native facility is unavailable would make
capability metadata untrustworthy.

## Decision

### Common managed contract

1. `packages/secrets` owns a binary `ManagedSecretStore` contract with readiness,
   create, rotate, idempotent delete, and callback-scoped access operations.
2. The contract returns only backend, Device, alias, status, and stable reason-code
   metadata. It has no public raw-value getter.
3. Callback return values are discarded. Store-owned plaintext buffers are zeroed
   after the callback. Callback or backend failures are replaced with stable,
   Secret-free errors.
4. Native helpers receive Secret bytes only through bounded stdin/stdout. Commands
   use absolute executables, argument arrays, `shell: false`, a platform-specific
   environment allowlist, output limits, and timeouts. Native stderr is never
   returned or logged.
5. Persistent filesystem paths are absolute, disjoint from the source checkout,
   link-rejecting, restrictive, and bounded. A non-secret namespace marker claims
   the dedicated vault root before any platform ACL mutation, so a configuration
   mistake cannot repurpose a non-empty unrelated directory. Secret filenames are
   stable hashes of Device identity and alias, not of the active immutable release
   path.

### Windows

Use DPAPI `ProtectedData` with `CurrentUser` scope under the fixed least-privilege
OpenDelegate service identity. DPAPI receives a deterministic Device-and-alias
entropy binding and binary Secret input over PowerShell stdin. Only DPAPI ciphertext
is persisted in the Device runtime home.

Before use, a fixed PowerShell ACL operation disables inheritance on the vault and
grants the current service identity only. The PowerShell source is a fixed package
constant and never includes dynamic Secret text. Failure to initialize DPAPI, the
service profile, PowerShell, the restrictive ACL, or the vault makes the backend
unavailable.

Foreground enrollment and SCM execution use different Windows identities, so they
are separate declared backends. `windows-dpapi` belongs to the invoking foreground
owner. Before native Worker installation, the packaged staging command resolves the
deterministic `NT SERVICE\OpenDelegate-<instance>` SID through fixed `sc.exe
showsid` argv and creates a one-time DPAPI-NG envelope protected to that exact SID.
The envelope contains only encrypted Secret material, is kept in a dedicated
link-rejecting handoff vault, and has inheritance disabled with access limited to
the staging owner and target service SID.

The durable Worker configuration then selects `windows-service-dpapi`, including
only the non-secret service name, SID, handoff root, and final vault root. The owner
record is deleted after the encrypted handoff is durable. At service startup the
backend verifies that the process's current SID exactly equals the configured
virtual-service SID before touching the final vault. It unwraps the SID-protected
handoff, immediately re-protects the material with `ProtectedData CurrentUser`,
persists only that ciphertext under a service-only ACL, and deletes the handoff.
Restart is fail-closed and idempotent: a completed destination record wins and a
leftover handoff is removed only after that destination has been decrypted
successfully; a missing, malformed, mismatched, or undecryptable record cannot
create a new identity. If owner-side staging resumes while the source record still
exists, that source is authoritative and atomically replaces a stale handoff before
the owner record is deleted.

Native service preflight requires the corresponding non-secret binding for a
Windows Worker install or upgrade and independently compares it with `sc.exe
showsid` before the operation journal is claimed or any host mutation occurs.

### macOS

Use a small native Swift helper that calls Keychain Services directly. It exchanges
raw Secret bytes only through standard streams and implements atomic create,
rotate, read, availability, and delete operations.

The TypeScript adapter requires an absolute regular single-link executable, a
release-manifest SHA-256 match, and successful `codesign --verify --strict` before
every Keychain operation. The release pipeline must compile, sign, bundle, and
notarize this helper. An unsigned, replaced, unpinned, missing, or unlaunchable
helper fails closed.

Items use the data-protection Keychain and
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. They neither synchronize nor
migrate to another Device and remain unavailable until the first unlock after a
restart.

### Graphical Linux

Use Secret Service through the installed absolute `secret-tool` binary in the
logged-in user session. Binary material is wrapped in a versioned base64 payload
that travels only on stdin/stdout. Device and alias attributes are hashes; the
human-visible label is fixed and non-sensitive.

Only D-Bus/XDG runtime location and locale variables are admitted to the helper
environment. Missing `secret-tool`, D-Bus, an unlocked collection, or the graphical
session makes this backend unavailable. It is not selected as a headless fallback.

### Headless systemd Linux

Use an authenticated encrypted local vault whose 256-bit master key arrives as a
systemd runtime credential. `SystemdCredentialKeyProvider` accepts one restrictive,
regular, single-link 32-byte credential file in the configured service credential
directory. `SystemdCredentialVaultSecretStore` encrypts every record independently
with AES-256-GCM and Device-and-alias associated data.

The owner provisions the master key using `systemd-creds` and
`LoadCredentialEncrypted=` with the desired TPM2, host-key, or combined policy.
systemd decrypts it into the kernel-restricted service credential directory at
activation. If that exact credential is absent, insecure, malformed, or cannot
decrypt the vault, OpenDelegate reports unavailable. It never creates a persistent
plaintext key or plaintext Secret fallback.

The packaged Worker exposes `secret-backend-provision` as the deterministic
provisioning boundary. It generates the 32-byte master key in-process, sends it only
to `systemd-creds encrypt` over bounded stdin, zeroes the buffer, and atomically
creates an exclusive, non-overwriting encrypted credential plus a non-secret
descriptor.
`worker join --secret-backend-config` must run inside a transient unit carrying the
same `LoadCredentialEncrypted=` mapping and eventual service identity. The native
Linux service renderer preserves that mapping for boot.

### Device identity bridge

`ManagedDeviceIdentitySecretStore` structurally satisfies the enrollment
`DeviceIdentitySecretStore` without reversing workspace dependencies. It briefly
exports a newly generated P-256 private key as PKCS#8 for managed storage, zeros
that representation, and imports stored bytes as a non-extractable Web Crypto key.
Signing occurs while the stored bytes remain inside scoped access. PKCS#8 and JWK
material never becomes readiness metadata.

## Alternatives considered

### Plaintext files protected only by mode or ACL

Rejected. Filesystem permissions are defense in depth, not encryption, and a
plaintext fallback would silently weaken headless Linux and service-account
deployments.

### Machine-scoped DPAPI as the Windows service handoff

Rejected. `LocalMachine` would let any process that obtained the ciphertext ask
DPAPI to decrypt it. The transition envelope instead uses DPAPI-NG with a protection
descriptor for the exact virtual-service SID, while the final record remains
`CurrentUser` DPAPI under that service identity.

### Secrets in environment variables

Rejected. Environments propagate to child processes and commonly appear in support
tools and crash diagnostics. Native child environments contain only explicit
non-secret route/locale values.

### Secrets in command arguments

Rejected. Process arguments are inspectable and routinely captured by diagnostics.
This rules out using `security add-generic-password -w <password>` on macOS.

### One JavaScript encrypted vault on every OS

Rejected as the default. It would require OpenDelegate to invent and provision a
portable root-key lifecycle even where DPAPI or Keychain already owns that problem.
The systemd vault is retained only for the headless case and anchors its key in
systemd's encrypted credential facility.

### Secret Service for every Linux service

Rejected. A boot/system daemon cannot assume a logged-in graphical D-Bus session or
an unlocked keyring. Graphical Secret Service and headless systemd credentials are
different declared configurations.

### `/usr/bin/security` without a native helper

Rejected. Its non-interactive password write interface would expose the value in
argv. The safe result is a narrowly scoped, pinned, signed helper; until that helper
is built and proven on a real release host, macOS Secret support remains gated.

### OS-native non-exportable P-256 keys only

Deferred as an optimization. A future identity-specific native key adapter may keep
the private key permanently inside DPAPI/CNG, Keychain/Secure Enclave, or a Linux
provider. The accepted first contract stores encrypted PKCS#8 locally and imports it
as non-extractable for use. It does not expose or distribute the raw representation.

## Consequences

- Linux backend choice is explicit. Headless failure cannot silently switch to a
  plaintext file or an unrelated graphical user's keyring.
- Windows foreground and service backends are explicit and cannot be interchanged.
  Moving an enrolled identity into SCM is a one-way encrypted staging operation;
  failure after the owner record is retired may require retrying the same handoff or
  re-enrolling the Device.
- macOS release bundles gain a small native signed/notarized compatibility surface.
- Device service identity changes can make DPAPI or Keychain items unavailable and
  require an explicit recovery or reconfiguration flow.
- Main backup excludes these local stores. Losing the Device or systemd vault key
  may permanently lose its credentials, consistent with Device-local ownership.
- JavaScript zeroing reduces accidental retention but is not a secure-memory
  primitive. The trusted callback and Node process remain inside the Device trust
  boundary.
- A long-lived client may need credential material beyond the Secret Store callback.
  In particular, the PostgreSQL driver parses the URI while the callback is active
  and may retain connection configuration inside its trusted Main-process pool
  until that pool closes. OpenDelegate prevents that value from entering argv,
  child environments, configuration, logs, diagnostics, or Agent context; it does
  not claim to erase every immutable string held internally by the database client.
- Readiness can be scheduled without copying a value to Main. A full cross-surface
  negative inspection is still required before criterion 26 is verified.

## Verification

Automated implementation evidence covers:

- create, rotate, delete, availability, and callback-scoped binary access;
- ciphertext-only systemd vault persistence and authenticated corruption rejection;
- persistence across immutable release-path changes;
- restrictive path and link rejection;
- exact 32-byte systemd runtime credential access and post-callback zeroing;
- stdin-only `systemd-creds` provisioning, encrypted-output bounds,
  non-overwriting descriptor creation, and runtime `LoadCredentialEncrypted=`
  rendering;
- native argument, environment, stdin, stdout, timeout, and hostile-output behavior;
- Windows DPAPI command shape plus a real current-Windows lifecycle;
- Windows virtual-service SID resolution, DPAPI-NG handoff command shape,
  foreground-record retirement, service-identity verification, restart-safe import,
  and pre-mutation native-service binding checks;
- macOS signed-helper path/hash/command contracts and tamper rejection;
- graphical Linux Secret Service command/environment contracts;
- registered-value encoding and common credential-form redaction; and
- P-256 create, restart, non-extractable import, and signing continuity.

These tests do not claim the required clean-host macOS Keychain, Ubuntu GNOME
Secret Service, headless systemd encrypted-credential reboot, service-account,
signing/notarization, or full three-Device leakage proof. The acceptance ledger must
remain incomplete until those live results exist.

## References

- `CONTEXT.md`, invariants 9 through 11
- `docs/PRODUCT_SPEC.md`, FR-17 and FR-19
- `docs/DECISIONS.md`, D-017
- [`ADR-0008`](0008-device-identity-enrollment-and-channel-authentication.md)
- [`ADR-0011`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [Microsoft `ProtectedData`](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata)
- [Apple `SecItemAdd`](https://developer.apple.com/documentation/security/secitemadd(_:_:))
- [Apple Keychain item accessibility](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly)
- [systemd service credentials](https://systemd.io/CREDENTIALS/)
- [`secret-tool`](https://manpages.ubuntu.com/manpages/noble/man1/secret-tool.1.html)
