# `@opendelegate/session-helper-ipc`

This package owns the authenticated local protocol between OpenDelegate's
always-on core daemon and one logged-in user-session helper. It implements the
ADR-0011 protocol seam; it does not install a service, create an OS login item, or
claim live Computer Use support on any platform.

## Security contract

- Windows uses a local named pipe. macOS and Linux use a local Unix-domain socket.
  The included Node 24 transport uses a four-byte big-endian length prefix and
  rejects a length before allocating its payload.
- Both peers must pass an injected `SessionHelperIpcPeerAuthorizer` for every
  connection. Endpoint ACLs and transport-observed peer identity are defense in
  depth only: protocol-v2 signature verification is still mandatory.
- Core and helper each contribute a fresh 32-byte nonce. The authenticated
  transcript binds protocol version, Device ID, helper ID, OS session ID, service
  epoch, release version, both key IDs, and both nonces.
- Core and helper use different Ed25519 private keys. Each side accepts only a
  pinned RFC 8410 SPKI public key and validates that its key ID is the lowercase
  SHA-256 digest of the exact SPKI bytes.
- Separate Ed25519 signature labels prove the helper and core handshake directions.
- Every application frame has a direction, unsigned 64-bit monotonic sequence,
  bounded payload length, service epoch, transcript digest, signer key ID, and an
  Ed25519 signature.
- A duplicate nonce, reflected direction, sequence replay or gap, malformed or
  oversized frame, invalid signature, stale binding, changed peer pin, or disconnect
  closes the channel.
- Errors contain only stable codes and fixed English messages. Raw transport,
  Secret-provider, peer-authorizer, and helper errors are never attached as
  `cause`.

The signed protocol authenticates local frames; it does not add encryption. OS
endpoint ACLs must therefore restrict access to the intended service and owner
session. The platform installer is responsible for those ACLs and for supplying a
`PeerAuthorizer` backed by the strongest peer identity available on that OS.

## Capability protocol

Only these exact request kinds are accepted:

- `readiness`
- `capture`
- `observe`
- `exact_input`
- `cancel`
- `emergency_stop`
- `diagnostics`

Every envelope and nested payload uses an exact-key schema. `exact_input` carries
the exact Task, Run, persistence generation, desktop lease, fencing token, Policy
fingerprint, deadline, display fingerprint, and one bounded pointer, keyboard, or
accessibility action. Diagnostics are limited to a fixed code vocabulary, severity,
timestamp, 100 entries, and 64 KiB. There is no shell, path, filesystem, database,
process, or general proxy message.

This protocol does not mint Computer Use authority. The Worker-side execution
composition must still revalidate Policy, the capacity-one desktop lease and fence,
the external service/persistence epoch, helper/session identity, display identity,
deadline, and cancellation immediately before native input as required by
ADR-0012.

## Signing-key and rotation seam

`SessionHelperSigningKeyProvider` receives an opaque private-key reference, expected
key ID, and bounded message bytes. It returns only a 64-byte Ed25519 signature. A
provider must keep the PKCS#8 private key in its plane-local Secret Store and zero
disposable copies after signing.

Each peer accepts its active peer public key and, optionally, one explicit migration
pin. A migration pin has an atomic consume callback and is consumed only after the
complete mutual handshake succeeds; a second overlap handshake fails closed.

Private-key bytes and key references are never included in protocol errors, logs,
diagnostics, command-line arguments, or process metadata by this package.

## Interfaces

Create role-specific authenticators with:

- `createSignedCoreSessionHelperIpc(options).connect(...)`
- `createSignedHelperSessionHelperIpc(options).accept(...)`

The resulting role-specific channels expose only `send`, `receive`, `close`,
`isClosed`, and their immutable authenticated binding. Tests and native
compositions can inject any framed `SessionHelperIpcConnection`. Production
composition can use `createNodeSessionHelperIpcTransport()` for a Node `net`
named-pipe or Unix-socket listener/dialer.

A transport's `writeFrame` promise means the implementation no longer retains the
provided Buffer; the protocol zeroes its frame after that promise resolves. A
transport must return a fresh Buffer from `readFrame`.

The legacy `createCoreSessionHelperIpc`/`createHelperSessionHelperIpc` shared-HMAC
API remains only as an isolated compatibility seam. Rendered service configuration
and production service hosts reject it.

The signed protocol's nonce replay guard is a bounded process-local default. A platform
composition may inject a stronger guard at the same seam when it needs replay
memory across helper restarts. Fresh challenge-response still requires both peers'
nonces for every connection.

## Support boundary

The package's tests prove protocol authentication, framing, schema, redaction, and
failure-close behavior with injected duplex connections and the host-native Node
transport. They do not prove:

- endpoint ACL configuration or OS peer credential extraction;
- Windows SCM, macOS launchd, or Linux systemd supervision;
- login, logout, lock-screen, reboot, helper-crash, or upgrade behavior;
- live native Computer Use permissions or input; or
- any first-milestone platform support claim.

Those remain platform-lab and release-ledger gates.
