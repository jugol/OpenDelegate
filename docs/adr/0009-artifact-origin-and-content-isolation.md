# ADR-0009: Artifact origin and content isolation

Status: **Accepted**

Date: **2026-07-24**

## Context

Artifacts are produced by agents and Workers, so their filenames, media types, and
bytes are untrusted even when the producing Device is enrolled. Reports must be
openable from private networks and deliberately public routes without letting
generated HTML inherit Admin Web credentials or origin authority. Time-limited links
must be revocable, and losing the metadata database must not turn opaque bytes into
public content.

The first local vertical slice needs a durable Main-owned byte store and browser
gateway. S3-compatible storage, resumable Worker upload, archive expansion, and
Discord presentation are later adapters; this slice must not imply that they already
exist.

## Decision

### Local Artifact Store

1. Store Artifact bytes under an absolute Main runtime directory, outside the source
   checkout at composition time. User-controlled identifiers and filenames never
   become path components.
2. Address local objects by lowercase SHA-256 digest below an opaque, fixed directory
   layout. Persist Artifact metadata separately and treat the metadata record as the
   authority that maps an Artifact ID to one object digest.
3. Copy and hash the complete local-slice upload before publication, enforce a
   configured byte limit, compare the caller's expected SHA-256 checksum, write a
   private temporary file, sync it, and atomically rename it. A crash may leave an
   unreferenced object but may not publish metadata before durable bytes exist.
4. Reject path separators, controls, unsafe basenames, malformed media types, and
   invalid retention, exposure, provenance, or rendering metadata. Every managed
   directory and file opened by the store must be a regular non-symbolic-link entry.
5. The local metadata index uses a versioned, validated, atomically replaced JSON
   format. One in-process write gate serializes metadata and token changes. This is a
   local adapter, not the long-term Main SQL Artifact metadata implementation.
6. Static HTML is the default for `text/html`. SVG is always downloaded in this
   slice. Interactive HTML must be selected explicitly and is recorded as a distinct
   presentation mode.
7. Pin, revoke, due-expiration, token issuance/revocation, and access decisions emit
   non-secret Artifact audit records. Revoked and expired Artifacts are not served.

### Signed links

1. A signed-link bearer is `v1.<token-id>.<random-secret>.<HMAC>`. Its HMAC binds the
   version, token ID, Artifact ID, expiry, and random secret to an instance-local
   signing key supplied through a secret boundary.
2. Durable state contains only the token ID, Artifact binding, expiry, revocation and
   usage metadata, and SHA-256 digest of the complete bearer. It never stores the raw
   bearer, random secret, HMAC, or signing key.
3. Validation checks structure, Artifact binding, digest, HMAC, Artifact state,
   expiry, and revocation in constant time where secret material is compared.
   Signed-link bearers are intentionally reusable until expiry or revocation because
   a report page and its viewer may issue repeated requests. Every accepted use is
   audited; a bearer cannot be replayed for a different Artifact.
4. Key rotation invalidates existing links unless an explicit future key-ring
   adapter is configured. Raw bearer values are accepted only by the Gateway and are
   never placed in audit details or error messages.

### Artifact Gateway

1. Artifact Gateway is a separate Fastify application and origin. It does not
   register Admin plugins, accept Admin cookies as authority, enable CORS, or render
   Artifact HTML inside Admin Web.
2. Composition supplies static, interactive, and Admin origins with distinct
   hostnames, not merely distinct ports. Browser cookies are host-scoped and would
   otherwise cross the intended authority boundary. Startup fails on an origin or
   cookie-host collision. External origins require HTTPS; loopback HTTP is allowed
   for local operation and tests.
3. Exposure modes are enforced deterministically:
   - `public` needs no credential;
   - `signed-link` needs the Artifact-scoped query bearer;
   - `authenticated` delegates either an explicit authorization-header bearer or a
     Gateway-scoped `__Host-opendelegate_artifact_session` cookie to an
     owner-authorization port. The Artifact cookie represents only Artifact access
     and is not the Admin session cookie. Its provisioning flow must set `Secure`,
     `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain`;
   - `private-network` delegates the observed direct peer to a configured network
     authorization port; and
   - `custom` delegates the recorded Policy ID to a custom authorization port.
   Network position and forwarded headers never imply authority by themselves.
4. Static and interactive HTML run on separate listener applications. Static HTML
   receives a CSP sandbox without `allow-scripts`. Interactive HTML is served only
   by the interactive listener, receives `sandbox allow-scripts` without
   `allow-same-origin`, and has no network, form, framing, object, or privileged
   origin access.
5. Every Artifact response sets `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, same-origin resource isolation, a restrictive
   permissions policy, and `Cache-Control: private, no-store`. The latter is required
   for bearer-authorized responses and is applied uniformly to avoid accidental
   cache-policy drift.
6. SVG and explicitly downloadable content receive attachment disposition with a
   sanitized fallback filename and RFC 5987 UTF-8 filename. Byte ranges support one
   satisfiable range; malformed or multiple ranges are rejected.
7. Missing, unauthorized, expired, and revoked Artifacts return one
   enumeration-resistant not-found response. No response or log contains a bearer,
   storage path, stack, or Admin credential.

## Alternatives considered

### Serve generated HTML from Admin Web

Rejected because CSP mistakes, same-origin storage, cookies, service workers, and
future privileged APIs would turn a generated report into an Admin credential
boundary.

### Sanitize HTML and trust the result

Rejected as the primary boundary. Sanitization can improve presentation later, but
origin separation and browser sandboxing remain necessary for novel markup and
parser behavior.

### Stateless signed URLs

Rejected because immediate per-link revocation and access audit are required.

### Store original filenames in the object path

Rejected because filenames are untrusted presentation metadata, create traversal and
normalization hazards, and leak Task content into filesystem layout.

### Make every signed link one-time

Rejected because ordinary report navigation, reload, and subresource retrieval are
legitimate replays. Expiry, Artifact binding, and explicit revocation provide the
required control.

## Consequences

- Identical bytes can share one immutable local object without sharing exposure or
  retention metadata.
- The local JSON index is a deliberate vertical-slice persistence seam, not a claim
  of SQL, S3, resumable upload, or distributed garbage-collection completion.
- Interactive reports can execute their own scripts but receive an opaque sandbox
  origin and no Admin authority.
- Browser-authenticated viewing requires a separate Artifact-scoped session
  provisioning or exchange flow; this Gateway slice validates that credential but
  does not mint it from an Admin session.
- Deployments must provision two Artifact origins when interactive reports are
  enabled and keep the signing key in Main's Secret Store.
- A later byte-store adapter can implement the same Artifact Store port without
  changing Gateway authorization or browser-isolation rules.

## Verification

- Store contract tests cover checksum mismatch, size limits, malicious identifiers
  and filenames, symlink substitution, atomic restart recovery, retention state,
  audit, and hash-only token persistence.
- Gateway injection tests cover all five exposure modes, owner-cookie rejection,
  token binding/replay/revocation/expiry, range and attachment behavior, origin
  validation, and non-disclosure responses.
- Malicious HTML and SVG fixtures remain byte-for-byte untrusted while their response
  headers prove scripts, origin access, framing, sniffing, referrers, and cross-origin
  reads are contained according to the selected mode.

## References

- `docs/PRODUCT_SPEC.md`, FR-14 and Artifact security model
- `docs/IMPLEMENTATION_PLAN.md`, Spike H and Phase 10
- [`ADR-0006`](0006-owner-authentication-and-local-claim.md)
- [`ADR-0007`](0007-control-plane-http-contract.md)
