# Architecture Decision Records

Architecture Decision Records capture implementation-level choices that refine the
approved product specification.

## Rules

- Product decisions remain in `docs/DECISIONS.md`.
- Add an ADR before encoding a technical choice that materially affects security,
  persistence, protocols, platform support, or extensibility.
- An ADR may refine but must not contradict the approved specification.
- Superseded ADRs remain in history and link to their replacement.
- Use the template in this directory.

## Status vocabulary

- `Proposed`
- `Accepted`
- `Superseded by ADR-NNNN`
- `Rejected`

## Accepted ADRs

1. [`0001-foundational-runtime-boundaries.md`](0001-foundational-runtime-boundaries.md)
2. [`0002-development-runtime-and-monorepo.md`](0002-development-runtime-and-monorepo.md)
3. [`0003-phase-zero-module-map.md`](0003-phase-zero-module-map.md)
4. [`0004-task-journal-and-scheduling-contracts.md`](0004-task-journal-and-scheduling-contracts.md)
5. [`0005-sql-portability-and-transaction-semantics.md`](0005-sql-portability-and-transaction-semantics.md)
6. [`0006-owner-authentication-and-local-claim.md`](0006-owner-authentication-and-local-claim.md)
7. [`0007-control-plane-http-contract.md`](0007-control-plane-http-contract.md)
8. [`0008-device-identity-enrollment-and-channel-authentication.md`](0008-device-identity-enrollment-and-channel-authentication.md)
9. [`0009-artifact-origin-and-content-isolation.md`](0009-artifact-origin-and-content-isolation.md)
10. [`0010-reproducible-platform-bundles-and-provenance.md`](0010-reproducible-platform-bundles-and-provenance.md)
11. [`0011-native-two-plane-service-supervision-and-authenticated-ipc.md`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
12. [`0012-computer-use-native-driver-authority-and-readiness.md`](0012-computer-use-native-driver-authority-and-readiness.md)
13. [`0016-pnpm-toolchain-security-upgrade.md`](0016-pnpm-toolchain-security-upgrade.md)

## Proposed ADRs

These choices still require native implementation and live platform evidence before
acceptance:

1. [`0013-windows-computer-use-backend.md`](0013-windows-computer-use-backend.md)
2. [`0014-macos-computer-use-backend.md`](0014-macos-computer-use-backend.md)
3. [`0015-ubuntu-gnome-wayland-computer-use-backend.md`](0015-ubuntu-gnome-wayland-computer-use-backend.md)
