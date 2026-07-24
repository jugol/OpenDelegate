# ADR-0006: Owner authentication and local claim

Status: **Accepted**

Date: **2026-07-24**

## Context

Admin Web can be exposed through LAN, Tailscale, Omada, a reverse proxy, or an
intentional public route. Network membership is therefore not owner identity.
Discord also cannot be the sole login or recovery authority. The first owner must be
claimed only from Main's local bootstrap path, after which browser sessions need
immediate revocation, CSRF protection, and independent recovery.

OpenDelegate is a personal, single-owner system in the first milestone. A broad
multi-tenant identity framework would add schema, migration, token, and account
states that the product does not expose, while a home-grown password primitive would
be unsafe. The selected design keeps the application state small and uses a reviewed
Argon2id implementation plus Node.js cryptographic primitives.

## Decision

### Authentication boundary

1. Implement one `OwnerAuth` application module behind backend-neutral persistence
   and secret-key ports. It supports exactly one active owner in the first milestone.
   Public sign-up, account enumeration, and remote initial claim do not exist.
2. Use `@node-rs/argon2@2.0.2` in Argon2id mode for the owner passphrase. Persist
   only its encoded PHC string. New hashes use at least 64 MiB memory, three
   iterations, parallelism four, a 16-byte random salt, and a 32-byte result. Login
   transparently rehashes after a successful check when the configured floor rises.
3. Password, session, claim-token, and recovery-code values are accepted only by the
   auth module and are redacted structurally from logs, audit payloads, errors, and
   API response schemas.
4. Apply bounded per-source and per-account login rate limits. Authentication
   responses do not reveal whether the owner exists or which credential check
   failed.

### Local initial claim

1. `opendelegate init` starts or contacts Main through the local bootstrap channel.
   Main creates a 256-bit random, single-use claim token with a ten-minute expiry and
   persists only its SHA-256 digest and expiry.
2. The claim endpoint is mounted only on a separate loopback listener. The external
   Admin listener never registers a claim route. Main also rejects any request whose
   observed peer is not loopback, even if a proxy supplies forwarding headers.
3. The bootstrap CLI passes the token to the local browser in the URL fragment or
   submits it over the local channel; it never places the token in a query string,
   log, process title, analytics event, or durable browser storage.
4. Owner creation, claim consumption, passphrase hash creation, and recovery-code
   hash creation commit atomically. A replay, expired token, pre-existing owner, or
   remote request fails closed.
5. Main removes the loopback claim listener after successful claim. Creating a new
   claim after initialization requires an explicit local recovery command and does
   not erase the existing owner automatically.

### Sessions and CSRF

1. A successful login creates a 256-bit random opaque session token. The database
   stores only `SHA-256(token)` with owner ID, creation, idle and absolute expiry,
   bounded last-use time, revocation, and credential version. The default idle
   lifetime is 24 hours and the absolute lifetime is 30 days.
2. The browser receives the token only in
   `__Host-opendelegate_session`, with `Secure`, `HttpOnly`, `SameSite=Lax`,
   `Path=/`, and no `Domain`. Non-loopback Admin access therefore requires HTTPS.
3. Unsafe routes accept JSON only, require an exact configured `Origin`, reject
   `Sec-Fetch-Site: cross-site`, and require a per-session token in
   `X-OpenDelegate-CSRF`. The server derives this token with domain-separated
   HMAC-SHA-256 keyed by the raw session cookie, compares it in constant time, and
   can reissue it from an authenticated same-origin session endpoint. No CSRF bearer
   value is durable.
4. Session lookup checks expiry and revocation on every authenticated request. There
   is no stateless JWT session, bearer token in browser storage, or positive session
   cache that can outlive revocation.
5. Logout revokes the current session. Admin can list and revoke other browser
   sessions. Passphrase reset, recovery, or local owner reset revokes every existing
   session in the same transaction.
6. Credential, recovery, durable Policy, Device-revocation, and Artifact-exposure
   changes require authentication no older than five minutes. Reauthentication
   rotates the session token rather than elevating an old bearer in place.

### Recovery

1. Initial claim produces ten independent 128-bit recovery codes. They are displayed
   exactly once and never returned by an ordinary API.
2. Persist only a versioned SHA-256 digest of each high-entropy code. Consuming a code
   and creating a short-lived recovery state are atomic; replay fails.
3. Recovery requires choosing a new passphrase, rotates all remaining recovery
   codes, revokes all sessions, and records a non-secret audit event.
4. Discord availability, Device credentials, Worker Secrets, and database access
   from a Worker are never recovery prerequisites.
5. Recovery completion validates the hashed recovery bearer and active recovery
   state before starting Argon2. Passphrase hashing runs through a small
   process-wide concurrency gate, then the transaction compares the same state,
   credential version, and expiry again before consuming it. Invalid or replayed
   bearers therefore cannot trigger memory-hard password hashing.

### Optional adapters

The auth module exposes a future external-identity adapter seam, but no adapter may
disable the local owner credential and recovery path. A reverse-proxy adapter must
trust identity headers only from explicitly configured proxy peers and must still
produce a normal revocable OpenDelegate session.

## Alternatives considered

### Discord OAuth as owner identity

Rejected because a Discord outage or account problem would remove Admin recovery,
contradicting the approved source-of-truth boundary.

### VPN membership without application login

Rejected because route access is not application identity and VPN configuration is
explicitly flexible.

### Better Auth

Not selected for the first milestone. Its general account, schema, migration, and
session lifecycle would create a parallel persistence domain, and its default
session-token persistence does not satisfy OpenDelegate's hash-only bearer-token
contract without a substantial custom adapter. This decision can be revisited if a
future multi-owner milestone needs federation.

### Passkeys as the only first-release credential

Deferred. Passkeys are a valuable future option, but cross-platform enrollment and
recovery still need an independent local bootstrap path. Argon2id passphrase plus
high-entropy recovery codes provides the complete first-release path without
outsourcing recovery.

### JWT browser sessions

Rejected because immediate per-session revocation and recovery-wide invalidation are
required.

## Consequences

- The authentication surface remains small enough to audit and matches the
  single-owner product boundary.
- A stolen database does not contain reusable browser, claim, or recovery bearer
  tokens; passphrases remain protected by Argon2id.
- The native Argon2 dependency and its parameters must be tested in every release
  bundle.
- Remote Admin routes require TLS. Setup must generate or configure a trusted route
  instead of silently weakening the cookie.
- Losing both the passphrase and all recovery codes requires a local Main recovery
  action. Documentation must make that operational consequence explicit.
- Optional passkey and identity-provider support remains additive rather than a
  prerequisite for the first milestone.

## Verification

- Remote listeners have no claim route, and forwarded headers cannot turn a remote
  peer into loopback.
- Concurrent or replayed claim and recovery requests produce exactly one winner.
- Database inspection finds only password PHC strings and token/code digests.
- Origin, content type, cookie flags, CSRF, expiry, rate-limit, logout, individual
  revocation, and revoke-all contract tests pass.
- Invalid recovery bearers never invoke Argon2; concurrent valid completion has
  exactly one winner and remains bounded by the hashing gate and recovery-specific
  HTTP rate limit.
- Admin remains usable and recoverable with Discord disabled.
- Structured log, audit, API, diagnostic, and Artifact leak fixtures contain none of
  the supplied credential values.

## References

- `docs/PRODUCT_SPEC.md`, FR-15 and Spike I
- `docs/DECISIONS.md`, D-016 and D-034
- [RFC 9106: Argon2 Memory-Hard Function](https://www.rfc-editor.org/rfc/rfc9106.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Cookie `__Host-` prefix requirements](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes)
- [`@node-rs/argon2`](https://github.com/napi-rs/node-rs/tree/main/packages/argon2)
