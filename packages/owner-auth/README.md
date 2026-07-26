# Owner authentication core

`@opendelegate/owner-auth` owns the backend-neutral application contract selected in
ADR-0006. It deliberately contains no HTTP route or SQL adapter.

The public `OwnerAuth` service provides:

- loopback-channel-only, ten-minute, single-use initial owner claims;
- fail-closed pre-owner crash recovery that lets an exclusively owned local
  bootstrap runtime invalidate an unreachable claim and issue a replacement;
- Argon2id passphrase login with repository-backed source and account throttles;
- hash-only opaque sessions with bounded idle and absolute expiry;
- HMAC-derived CSRF tokens, trusted-origin validation, and fresh-auth bearer
  rotation;
- session inspection, revocation, and logout;
- one-time recovery states, recovery-code rotation, and session revoke-all; and
- structural credential redaction.

Every successful auth mutation appends a non-secret `OwnerAuthAuditRecord` through
the same `OwnerAuthRepository.transaction` that changes auth state. The future SQL
adapter must preserve that transaction boundary when it maps records into the
Control Plane's durable audit/outbox model. HTTP is still responsible for exposing
the claim route only on its loopback listener, deriving the trusted request channel
from the observed peer rather than forwarding headers, and setting the exact secure
cookie attributes from ADR-0006.

Recovery codes, claim tokens, session tokens, CSRF values, and source identifiers are
never durable in raw form. `InMemoryOwnerAuthRepository.snapshot()` exists for
contract tests and exposes only PHC strings, digests, safe metadata, and non-secret
audit records.
