# Release signer broker protocol

Status: **implemented client boundary; production broker provisioning and credentials remain
external release prerequisites**

OpenDelegate never launches a publisher or promotion signing helper in a production release flow.
It connects to a separately installed local signer broker over an operating-system local IPC
endpoint. The broker owns the credential boundary: release private keys remain in its protected
service, HSM, keychain, or workload identity and never enter the source checkout, command line,
environment, logs, runner record, candidate, or Agent context.

This protocol does not turn a test fixture into a trusted signer. A production broker must be
installed and updated independently of attestation commit B, run as an OS-managed service from an
administrator-owned read-only location, authenticate and authorize its local caller, enforce the
statement grammar below, and access signing credentials without spawning mutable provider helpers.

## Policy

The SHA-256-pinned canonical policy uses schema version 2:

```json
{"schemaVersion":2,"product":"OpenDelegate","role":"publisher","publicKey":{"path":"ABSOLUTE_RELEASE_PUBLIC_KEY_PEM","sha256":"LOWERCASE_SHA256"},"broker":{"protocol":"opendelegate.release.signer-broker.v1","endpoint":"LOCAL_IPC_ENDPOINT","transportPublicKey":{"path":"ABSOLUTE_TRANSPORT_PUBLIC_KEY_PEM","sha256":"LOWERCASE_SHA256"},"timeoutMs":30000}}
```

`role` is `publisher` or `promotion`. The release-signing key and broker-transport key must be
distinct Ed25519 authorities. Both public-key files and the policy are stable regular files outside
the checkout, candidate, and output roots. The transport key authenticates the broker session; the
release key signs only the authorized release statement.

On macOS and Linux, `endpoint` is a bounded absolute Unix-domain socket path. On Windows it is a
local `\\.\pipe\...` name. TCP, remote named pipes, relative paths, helper executables, invocation
scripts, and automatic fallback transports are rejected.

## Same-session authorization

Signing is a two-phase exchange on one accepted local IPC connection. A capability is neither a
portable bearer token nor permission to reconnect. Closing either side invalidates it.

The client first sends an `authorize-request` as compact canonical JSON followed by LF. Fields are
in this exact order:

1. `schemaVersion`: `1`
2. `protocol`: `opendelegate.release.signer-broker.v1`
3. `type`: `authorize-request`
4. `requestId`: a fresh UUID
5. `clientNonce`: 32 random bytes encoded as unpadded base64url
6. `role`
7. `domain`
8. `releaseKeyId`
9. `transportKeyId`
10. `policySha256`
11. `endpointSha256`: SHA-256 of the exact UTF-8 endpoint
12. `authorization`
13. `authorizationSha256`
14. `inputSha256`
15. `inputSize`

`authorization` is the short-lived result of complete precredential revalidation:

```json
{"authorizationId":"BASE64URL_32_BYTES","role":"publisher","domain":"publisher-attestation-v2","inputSha256":"LOWERCASE_SHA256","snapshotSha256":"LOWERCASE_SHA256","authorizedAt":"CANONICAL_ISO_8601","expiresAt":"CANONICAL_ISO_8601"}
```

`authorizationSha256` is SHA-256 over recursively key-sorted, compact UTF-8 JSON for the exact
authorization object, with no trailing LF. The authorization lifetime is at most 15 seconds. Its
sanitized snapshot binds the pinned source, runner, Git/tool, policy, candidate, evidence,
revocation, and output-absence identities applicable to that operation.

The request is an assertion from the authenticated runner, not proof by itself. The broker must
authenticate the socket peer and immutable runner identity, select an independent approval record
for that peer, and compare the approved `inputSha256` and `snapshotSha256` with the request. Values
copied from the untrusted request are not independent approval. The broker recomputes
`authorizationSha256`, validates the fresh authorization ID and time window, and binds that digest
to its session state. It also compares `endpointSha256` with its own exact listener identity and
maps the configured policy, role, domain, release key, and transport key without request-controlled
fallbacks.

If authorization succeeds, the broker returns a transport-signed `authorize-response` on the same
connection. Its exact fields are:

1. `schemaVersion`: `1`
2. `protocol`: `opendelegate.release.signer-broker.v1`
3. `type`: `authorize-response`
4. the original `requestId` and `clientNonce`
5. `brokerNonce`: 32 fresh random bytes encoded as unpadded base64url
6. `capabilityId`: at least 256 random bits encoded as unpadded base64url
7. echoed `role`, `domain`, `releaseKeyId`, `transportKeyId`, `policySha256`,
   `endpointSha256`, `authorizationSha256`, `inputSha256`, and `inputSize`
8. `expiresAt`: no later than both the credential authorization and 15 seconds after issue
9. `transportSignature`

The authorization response transport signature is Ed25519 over:

```text
OpenDelegate release signer broker authorization v1\n
SHA256_OF_EXACT_AUTHORIZE_REQUEST_BYTES\n
CANONICAL_AUTHORIZE_RESPONSE_WITHOUT_transportSignature\n
```

The broker records capability issue and expiry against a monotonic clock, the accepted socket,
authenticated peer and runner, both nonces, endpoint and policy, both authority keys, exact
role/domain, authorization and snapshot digests, and input digest and size. Wall-clock timestamps
are wire evidence only and cannot extend that monotonic lifetime.

After authenticating this response, the OpenDelegate client reruns the complete local
precredential callback and all pinned policy-file checks. It consumes the opaque local
authorization only if those checks still match. A failed or changed revalidation closes the
connection without sending signing bytes. The broker can trust its authenticated runner assertion
and approval record; it must not claim that the wire protocol proves which JavaScript callback ran.

Allowed role and wire-domain pairs are:

| Role        | Wire domain                    | Exact statement prefix                                  | Embedded statement domain                                      |
| ----------- | ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------- |
| `publisher` | `publisher-attestation-v2`     | `OpenDelegate publisher attestation v2\n`               | `opendelegate.release.publisher-attestation.v2`                 |
| `promotion` | `promotion-authorization-v1`   | `OpenDelegate promotion authorization v1\n`             | `opendelegate.release.promotion-authorization.v1`               |
| `promotion` | `supported-channel-receipt-v2` | `OpenDelegate supported channel receipt v2\n`           | `opendelegate.release.supported-channel-receipt.v2`             |

Bytes after the prefix are canonical two-space-indented JSON plus LF. The broker independently
parses the exact nested schema for the selected domain, checks `product: "OpenDelegate"`, verifies
all policy and revocation constraints, and refuses arbitrary bytes even when their role and domain
strings are otherwise allowed. A top-level shape check is insufficient. The broker must use the
pinned release-integrity statement grammar and must not be a generic signing oracle.

## Sign request and response

Only after post-capability revalidation does the client send `sign-request` on the same connection:

1. `schemaVersion`: `1`
2. `protocol`: `opendelegate.release.signer-broker.v1`
3. `type`: `sign-request`
4. a fresh `requestId`
5. the authorized `clientNonce`, `brokerNonce`, and `capabilityId`
6. the authorized `role`, `domain`, `releaseKeyId`, `transportKeyId`, `policySha256`,
   `endpointSha256`, `authorizationSha256`, `inputSha256`, and `inputSize`
7. `signingBytes`: unpadded base64url

Before touching the release key, the broker must atomically consume the one-shot capability from
its same-session state. It then verifies the exact decoded size and digest, parses the entire
domain-specific statement again, and applies current key and policy revocation. A malformed,
expired, disconnected, direct-sign, cross-session, or reused request consumes or invalidates the
capability and performs zero release-key operations.

The broker returns a compact canonical `sign-response` followed by LF:

1. `schemaVersion`: `1`
2. `protocol`: `opendelegate.release.signer-broker.v1`
3. `type`: `sign-response`
4. the sign `requestId`
5. the authorized `clientNonce`, `brokerNonce`, and `capabilityId`
6. echoed `role`, `domain`, `releaseKeyId`, `transportKeyId`, and `inputSha256`
7. `releaseSignature`
8. `transportSignature`

`releaseSignature` is Ed25519 over the exact decoded `signingBytes`. `transportSignature` is
Ed25519 under the distinct transport key over:

```text
OpenDelegate release signer broker response v1\n
SHA256_OF_EXACT_SIGN_REQUEST_BYTES\n
CANONICAL_SIGN_RESPONSE_WITHOUT_transportSignature\n
```

The client checks every echoed request field before verifying the transport signature, then
verifies the release signature and authorization expiry. The two distinct response domains and
exact request digests bind endpoint identity, policy, one-time authorization, source snapshot, both
nonces, capability, role/domain, input hash, and exact bytes. An endpoint squatter cannot
authenticate, and a response from another phase, session, or request cannot be replayed.

If the response is lost after release-key use, the broker must retain a bounded idempotent terminal
outcome keyed by its authenticated session/request identity. It must never treat a retry as new
permission or perform the release-key operation twice.

## Broker deployment requirements

- Run the broker under a dedicated OS service identity and expose only a restrictive Unix socket or
  named-pipe ACL.
- Authenticate the peer (`SO_PEERCRED`/`getpeereid` or Windows client token/PID) and authorize the
  exact release role and immutable runner identity. Resolve approved input and snapshot digests
  from broker-controlled state; never manufacture approval by echoing request fields. Peer checks
  supplement, rather than replace, the transport-key handshake.
- Make the service binary and configuration administrator-owned and non-writable by the release
  account or untrusted local users. Record their independently approved digests in external runner
  evidence.
- Map each `releaseKeyId` to an exact role, domain, policy, and revocation state. Use monotonic
  same-session capability expiry, atomic one-shot consumption, and request ID idempotency before
  invoking an HSM, keychain, or provider.
- Keep private-key operations inside the protected broker/provider boundary. Do not spawn a mutable
  script or helper after validation.
- Bound request, response, execution time, and diagnostics. Never return credential, provider,
  environment, or filesystem details.

The repository's broker fixtures use ephemeral keys and local endpoints only to prove protocol
mechanics. Their precomputed approval sets and output are engineering evidence, not production
trust sources, and are never support eligible. Actual broker installation, public trust roots,
credentials, peer-authorization configuration, and service proof are recorded in the platform lab
before a supported release.
