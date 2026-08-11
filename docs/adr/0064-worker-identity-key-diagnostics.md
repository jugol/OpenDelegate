# ADR-0064: Worker identity-key diagnostics prove readability and certificate binding

- Status: Accepted
- Date: 2026-08-11

## Context

A live macOS Worker remained enrolled after Main restarted, and its TCP route,
clock, Device certificate, certificate authority, durable registration, generation,
and public-key fingerprint all remained valid. The foreground Worker nevertheless
could not reconnect because the background process could see the login-Keychain item
but could not read it. `worker diagnose` checked only item existence and reported
`identityKeyReady: true`. The reconnect boundary then collapsed the local Keychain
failure into `TRANSPORT_BOUNDARY_ERROR`, while the CLI incorrectly told the owner
that Main had rejected the credential.

This is especially misleading on macOS, where D-119 deliberately separates a
signed-in owner's login-Keychain foreground binding from the still-unimplemented
persistent System-Keychain service binding.

## Decision

1. `worker diagnose` must execute a bounded Secret read, derive only the public SPKI
   from the private key, and compare it with the enrolled Device certificate. It
   reports `ready`, `unavailable`, `invalid`, or `mismatch`; private bytes never leave
   the Secret callback or enter logs, state, or Agent context.
2. Worker channel composition must preserve an error raised by the channel executor
   outside the Secret callback so a managed Secret Store cannot relabel a network or
   protocol failure as a Secret-executor failure.
3. A local Secret read failure uses the bounded owner-safe route code
   `LOCAL_SECRET_UNAVAILABLE`. A malformed or certificate-mismatched key uses
   `IDENTITY_KEY_INVALID`. These codes may cross the existing redacted route-incident
   boundary but carry no path, alias, key identifier, certificate, or native error.
4. CLI remedies must describe the actual boundary. A generic transport failure must
   never claim that Main rejected a credential. On macOS, the local-Secret remedy
   names the signed-in desktop/login-Keychain requirement without weakening it.
5. `LOCAL_SECRET_UNAVAILABLE` remains retryable because unlocking or restoring the
   configured store can recover it. `IDENTITY_KEY_INVALID` is blocking because
   retries cannot make unrelated key material match a certificate.

## Consequences

An enrolled Device can no longer look healthy merely because its key item exists.
Owners receive an actionable local remedy instead of being sent to Main or told to
re-enroll unnecessarily. The existing fail-closed macOS service boundary remains in
force: this ADR improves diagnosis and reconnect behavior but does not claim that a
foreground login-Keychain Worker is a persistent daemon.

Focused tests cover safe classification, retry behavior, and the four identity-key
states. Live evidence on macOS verifies the motivating `unavailable` state without
exporting private key material.
