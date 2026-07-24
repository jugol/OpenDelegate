# ADR-0008: Device identity, enrollment, and channel authentication

Status: **Accepted**

Date: **2026-07-24**

## Context

OpenDelegate uses a fixed Main with any number of Worker Devices. Requiring every
pair of Devices to trust SSH keys would create an N-by-N administration problem and
would make route membership look like application identity. The approved topology is
hub-and-spoke: every Worker needs one authenticated relationship with Main, while
Tailscale, Omada, direct LAN, SSH tunnels, and future transports only determine how
bytes reach that relationship.

Workers cannot receive database credentials or a generic remote-shell authority.
Enrollment must be single-use, Device credentials must prove possession of a
Device-local key, and revocation must take effect at the application boundary even
when a TLS session or route is otherwise valid.

## Decision

### Device public-key infrastructure

1. Main creates one OpenDelegate instance certificate authority during local
   bootstrap. Use `@peculiar/x509@2.0.0` with Node.js Web Crypto to issue ECDSA P-256
   X.509 certificates. The CA and Device certificates use SHA-256 signatures.
2. Store the encrypted CA private key in Main's local Secret Store outside the
   database and source checkout. The database stores only the CA public certificate,
   key identifier, and lifecycle metadata.
3. Every Worker generates its own non-exported or restrictively stored ECDSA P-256
   private key. Main never receives that key. The Worker sends a signed certificate
   request containing its immutable Device ID.
4. A Device certificate has a random 128-bit serial, a short bounded lifetime, client
   authentication usage, and a URI subject alternative name of
   `urn:opendelegate:device:<DeviceId>`. Main records its public-key fingerprint,
   serial, validity, generation, and status.
5. Main's dedicated Device endpoint presents a server certificate chained to the
   same instance CA. Enrollment grants carry the expected CA/SPKI fingerprint, so
   the first connection is pinned rather than trust-on-first-use.

### Single-use enrollment

1. An authenticated owner creates an Enrollment Grant scoped to one intended Device
   record, allowed role bootstrap, expiry, and protocol compatibility range. The
   grant contains a 256-bit random bearer token; Main stores only its SHA-256 digest.
2. The owner transfers the grant through the `join` skill, a local file with
   restrictive permissions, or a QR/deep-link representation. Raw grants never
   enter logs, Task context, Discord, diagnostics, or the database.
3. The uncredentialed enrollment endpoint is separate from the normal Device
   channel. It accepts only a pinned-TLS connection, a live grant, a certificate
   request, and a bounded discovery bootstrap payload.
4. Token consumption, Device identity creation, certificate registration, initial
   profile event, and audit append commit atomically. Concurrent, expired, replayed,
   differently scoped, or already consumed grants fail closed.
5. Main returns the signed Device certificate and public instance chain. The Worker
   persists them outside the install directory and reconnects through the normal
   mutual-TLS channel. It does not perform work on the enrollment connection.

### Authenticated Device channel

1. Use `ws@8.21.1` over TLS 1.3 with mutual certificate authentication for the
   default persistent Device channel. Transport profiles may create the underlying
   route or tunnel, but mutual TLS and application authorization remain unchanged.
2. Main validates the certificate chain, time, key usage, serial status, generation,
   and URI Device ID on every connection. Each protocol envelope's sender Device ID
   must match that authenticated identity.
3. The channel accepts only versioned, runtime-validated OpenDelegate message types.
   There is no generic command, shell, database, arbitrary path, or opaque Agent
   instruction endpoint.
4. Durable inbox/outbox identities, acknowledgments, sequence high-watermarks, lease
   fences, and explicit capacity provide at-least-once delivery with backpressure.
   Reconnection resumes from durable acknowledgment state and cannot repeat an
   already committed command outcome.
5. Route selection and deterministic fallback occur before channel establishment and
   remain outside Agent prompts. Exhausted mechanical routes may produce a bounded
   diagnostic packet for Agent or owner intervention.

### Rotation and revocation

1. An authenticated live Device rotates by generating a new key and certificate
   request. Main issues a higher certificate generation with a short overlap, and
   the Worker proves the new channel before the old certificate retires.
2. Owner revocation marks the Device and every certificate generation revoked in the
   database, closes active channels, cancels or retires dispatch as Policy permits,
   and rejects later TLS sessions at the application check.
3. A Device that lost its private key cannot rotate with the old identity. It
   requires a new owner-approved single-use recovery enrollment and produces an
   auditable identity generation.
4. Certificate status in Main, not a route ACL or long-lived TLS session alone, is
   revocation authority. Main checks status again before dispatching protected work.

### Topology

Workers connect only to Main. Worker-to-Worker work moves through Task references,
Artifact transfer, and Main-authorized Work Orders; it does not require pairwise SSH,
VPN credentials, or direct application trust. A Worker may still use SSH or another
tool inside an explicitly authorized Task, but that is an executable action governed
by Policy rather than OpenDelegate's control topology.

## Alternatives considered

### Pairwise SSH trust

Rejected because it scales as N-by-N configuration, couples identity to one route,
and grants a shell-shaped authority broader than the application protocol.

### VPN identity

Rejected because Tailscale, Omada, LAN, and tunnel membership determines reachability
but does not prove the OpenDelegate Device or its current revocation state.

### Shared instance API key

Rejected because one compromised Worker could impersonate every Device and rotation
or revocation would disrupt the whole instance.

### Bearer token on every Worker request

Rejected because a copied token proves possession only of the token and is more
likely to leak through process, configuration, or diagnostic surfaces than a
Device-local private key.

### Public certificate authority for Device certificates

Rejected because private Device identities and short-lived client certificates do
not need public Web PKI. The instance CA also supports pinned enrollment across
private routes.

### gRPC

Deferred. HTTP/2 RPC would be viable, but WebSocket framing plus the existing
versioned protocol is smaller for the first persistent channel and works across the
required tunnels. The application protocol remains transport-neutral.

## Consequences

- Adding Devices is O(N): each Device establishes one trust relationship with Main.
- Route profiles can vary per Device without weakening or changing identity.
- Main must protect and back up its instance CA key separately from database
  metadata; recovery and CA rotation require an explicit operator workflow.
- TLS certificate validation is necessary but not sufficient. Every command still
  passes application authorization, Policy, idempotency, lease, and fencing checks.
- X.509 generation and WebSocket packages become pinned compatibility surfaces in
  three-OS release bundles.
- Clock skew diagnostics are required because short-lived certificate checks depend
  on usable host time.

## Verification

- Concurrent use of one Enrollment Grant creates exactly one Device identity and one
  certificate; replay, expiry, scope mismatch, changed CSR, and wrong server pin
  fail.
- A Worker proves private-key possession without its key or database credentials
  appearing on Main.
- Certificate Device ID and envelope sender mismatch, revoked serial, stale
  generation, wrong CA, invalid usage, expiry, and future validity fail before
  command handling.
- Revocation closes a live connection and blocks reconnect and dispatch.
- Device event buffering, reconnect, duplicate delivery, capacity backpressure, and
  rolling version negotiation pass through forced process and network interruption.
- Two Workers using different route profiles communicate with Main without any
  Worker-to-Worker trust configuration or route description in Coordinator context.

## References

- `docs/PRODUCT_SPEC.md`, FR-2, FR-4, and Application protocol
- `docs/DECISIONS.md`, D-004 through D-006
- `docs/THREAT_MODEL.md`, Main-to-Worker boundary
- [RFC 5280: Internet X.509 PKI Certificate Profile](https://www.rfc-editor.org/rfc/rfc5280.html)
- [TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html)
- [`@peculiar/x509`](https://github.com/PeculiarVentures/x509)
- [`ws`](https://github.com/websockets/ws)
