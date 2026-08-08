# ADR-0040: Preserve the Windows Worker two-plane binding during service staging

Status: **Accepted**

Date: **2026-08-08**

## Context

A Windows Worker enrolls while the owner is logged in, then moves its core-owned
Secrets into a handoff sealed for the SCM service identity. The logged-in session
helper intentionally keeps a different signing key in the owner's DPAPI vault.

The first service-document composer tried to read both public IPC pins after that
move. This cannot work when the core handoff is sealed to the service account, and
putting the owner vault under service-owned state would collapse the two privilege
planes. The old staging order also deleted owner copies before persisting enough
non-secret recovery information to compose the install document after a restart.

## Decision

Before staging removes any core-owned owner-vault copy, Worker configuration stores
one versioned, non-secret service-preparation binding containing:

- the core and owner-session helper Ed25519 public IPC pins;
- the effective service-account or machine sealing strength; and
- the existing owner-helper DPAPI vault location.

The owner-helper vault remains disjoint from the source or packaged input, release
bundle, install root, and every service-owned mutable root. The helper private key
never enters the handoff. Staging first completes every encrypted core handoff,
then commits the public binding and service backend, and only then deletes the
core-owned owner-vault copies. A replay after that commit performs only bounded,
idempotent cleanup after verifying that every handoff entry exists.

`worker service-document` reads this durable public binding and candidate bundle
metadata to create a new install document. It never reopens staged Secret material,
overwrites an existing document, elevates, or registers a service. The separately
elevated installer still performs the authoritative bundle and service-SID
verification. A legacy staged Worker without the binding must use an
owner-restorable handoff or a new owner-approved re-credentialing Grant; public pins
are never guessed.

macOS and graphical Linux service-document composition remains fail-closed until
each platform has an equivalent explicit migration between its core-service and
owner-session Secret authorities. ADR-0041 separately defines headless Linux, where
no graphical helper or owner-session key exists to migrate.

## Consequences

Windows service installation can be composed after staging or restart without
crossing the two-plane Secret boundary. A crash after the durable configuration
switch is recoverable by exact replay. Owner-session credentials remain unavailable
to the core service even though their public identity is part of the shared runtime
configuration. Machine-level fallback sealing remains visible on replay and in
Worker diagnostics instead of depending on one staging process's stdout.

This is contract and test evidence only. Windows support still requires clean-host
SCM, restart, reboot, ACL, DPAPI-NG, and owner-session evidence before release
promotion. macOS and graphical Linux remain explicit first-milestone blockers
rather than receiving a syntactically valid but unusable service document; headless
Linux follows ADR-0041's separate core-only acceptance path.

## Verification

- Windows staging records canonical Ed25519 public pins before deleting core copies.
- Replay verifies every handoff entry and removes only lingering core-owned copies.
- Service composition succeeds without opening either private signing key.
- Bundle metadata reads require stable regular-file snapshots and remain size-bounded
  before composition.
- Restore requires every core Secret and accepts only the owner vault that retained
  the session-helper key.
- The owner-helper vault is rejected when it overlaps immutable input, a service
  root, or a service log path.
- macOS and graphical Linux service-document requests fail before writing install
  input; headless Linux requires ADR-0041's durable core-only binding.

## References

- [`0011-native-two-plane-service-supervision-and-authenticated-ipc.md`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [`0017-device-local-secret-store-backends.md`](0017-device-local-secret-store-backends.md)
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 4
- [`../DECISIONS.md`](../DECISIONS.md), D-088
