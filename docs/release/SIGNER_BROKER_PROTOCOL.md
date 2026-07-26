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

## Request

The client sends one compact canonical JSON object followed by LF. Fields are in this exact order:

1. `schemaVersion`: `1`
2. `protocol`: `opendelegate.release.signer-broker.v1`
3. `type`: `sign-request`
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
16. `signingBytes`: unpadded base64url

`authorization` is the one-shot, short-lived result of complete precredential revalidation:

```json
{"authorizationId":"BASE64URL_32_BYTES","role":"publisher","domain":"publisher-attestation-v2","inputSha256":"LOWERCASE_SHA256","snapshotSha256":"LOWERCASE_SHA256","authorizedAt":"CANONICAL_ISO_8601","expiresAt":"CANONICAL_ISO_8601"}
```

The authorization lifetime is at most 15 seconds. Its sanitized snapshot binds the pinned source,
runner, Git/tool, policy, candidate, evidence, revocation, and output-absence identities applicable
to that operation. The broker must reject an expired, reused, unknown, mismatched, or
policy-incompatible authorization before release-key access.

Allowed role and wire-domain pairs are:

| Role        | Wire domain                    | Exact statement prefix                                  | Embedded statement domain                                      |
| ----------- | ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------- |
| `publisher` | `publisher-attestation-v2`     | `OpenDelegate publisher attestation v2\n`               | `opendelegate.release.publisher-attestation.v2`                 |
| `promotion` | `promotion-authorization-v1`   | `OpenDelegate promotion authorization v1\n`             | `opendelegate.release.promotion-authorization.v1`               |
| `promotion` | `supported-channel-receipt-v2` | `OpenDelegate supported channel receipt v2\n`           | `opendelegate.release.supported-channel-receipt.v2`             |

Bytes after the prefix are canonical two-space-indented JSON plus LF. The broker independently
parses the exact schema for the selected domain, checks `product: "OpenDelegate"`, verifies all
policy and revocation constraints, and refuses arbitrary bytes even when their role and domain
strings are otherwise allowed. The broker must not be a generic signing oracle.

## Response and transcript

The broker returns one compact canonical JSON object followed by LF, then closes the response side.
Fields are in this exact order:

1. `schemaVersion`: `1`
2. `protocol`: `opendelegate.release.signer-broker.v1`
3. `type`: `sign-response`
4. `requestId`
5. `clientNonce`
6. `brokerNonce`: 32 fresh random bytes encoded as unpadded base64url
7. `role`
8. `domain`
9. `releaseKeyId`
10. `transportKeyId`
11. `inputSha256`
12. `releaseSignature`
13. `transportSignature`

`releaseSignature` is Ed25519 over the exact decoded `signingBytes`. `transportSignature` is
Ed25519 under the distinct transport key over:

```text
OpenDelegate release signer broker response v1\n
SHA256_OF_EXACT_CANONICAL_REQUEST_BYTES\n
CANONICAL_RESPONSE_WITHOUT_transportSignature\n
```

The client checks every echoed request field before verifying the transport signature, then verifies
the release signature and authorization expiry. The request digest binds the endpoint identity,
policy, one-time authorization, source snapshot, nonces, role/domain, input hash, and exact bytes.
An endpoint squatter cannot authenticate, and a response from another request cannot be replayed.

## Broker deployment requirements

- Run the broker under a dedicated OS service identity and expose only a restrictive Unix socket or
  named-pipe ACL.
- Authenticate the peer (`SO_PEERCRED`/`getpeereid` or Windows client token/PID) and authorize the
  exact release role and runner identity. Peer checks supplement, rather than replace, the
  transport-key handshake.
- Make the service binary and configuration administrator-owned and non-writable by the release
  account or untrusted local users. Record their independently approved digests in external runner
  evidence.
- Map each `releaseKeyId` to an exact role, domain, policy, and revocation state. Enforce request ID
  idempotency and authorization expiry before invoking an HSM, keychain, or provider.
- Keep private-key operations inside the protected broker/provider boundary. Do not spawn a mutable
  script or helper after validation.
- Bound request, response, execution time, and diagnostics. Never return credential, provider,
  environment, or filesystem details.

The repository's broker fixtures use ephemeral keys and local endpoints only to prove protocol
mechanics. Their output is engineering evidence and is never support eligible. Actual broker
installation, public trust roots, credentials, and service proof are recorded in the platform lab
before a supported release.
