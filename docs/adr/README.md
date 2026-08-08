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
14. [`0017-device-local-secret-store-backends.md`](0017-device-local-secret-store-backends.md)
15. [`0018-programmatic-agent-adapters-and-action-authorization.md`](0018-programmatic-agent-adapters-and-action-authorization.md)
16. [`0019-durable-run-lease-renewal-and-clock-calibration.md`](0019-durable-run-lease-renewal-and-clock-calibration.md)
17. [`0020-main-singleton-ownership.md`](0020-main-singleton-ownership.md)
18. [`0021-supported-release-promotion-and-native-authenticity.md`](0021-supported-release-promotion-and-native-authenticity.md)
19. [`0022-live-discord-binding-reconfiguration.md`](0022-live-discord-binding-reconfiguration.md)
20. [`0023-task-scoped-owner-handoff.md`](0023-task-scoped-owner-handoff.md)
21. [`0024-configuration-chat-history-and-approval-correlation.md`](0024-configuration-chat-history-and-approval-correlation.md)
22. [`0025-proactive-task-and-discord-forum-origin.md`](0025-proactive-task-and-discord-forum-origin.md)
23. [`0026-discord-chronological-controls-and-race-reconciliation.md`](0026-discord-chronological-controls-and-race-reconciliation.md)
24. [`0027-discord-single-turn-lifecycle-and-retry-stable-planning.md`](0027-discord-single-turn-lifecycle-and-retry-stable-planning.md)
25. [`0028-main-owned-read-only-task-answers.md`](0028-main-owned-read-only-task-answers.md)
26. [`0029-wake-on-lan-readiness-evidence.md`](0029-wake-on-lan-readiness-evidence.md)
27. [`0030-tiered-repository-validation.md`](0030-tiered-repository-validation.md)
28. [`0031-configuration-read-only-turn-recovery.md`](0031-configuration-read-only-turn-recovery.md)
29. [`0032-configuration-chat-locale-and-approval-handoff.md`](0032-configuration-chat-locale-and-approval-handoff.md)
30. [`0033-owner-input-idle-budget-resumption.md`](0033-owner-input-idle-budget-resumption.md)
31. [`0034-discord-nonblocking-gateway-intake.md`](0034-discord-nonblocking-gateway-intake.md)
32. [`0035-owner-continuation-idle-budget-resumption.md`](0035-owner-continuation-idle-budget-resumption.md)
33. [`0036-worker-channel-waiter-release.md`](0036-worker-channel-waiter-release.md)
34. [`0037-discord-terminal-control-refusal.md`](0037-discord-terminal-control-refusal.md)
35. [`0038-active-execution-wall-budget.md`](0038-active-execution-wall-budget.md)
36. [`0039-change-scoped-pull-request-validation.md`](0039-change-scoped-pull-request-validation.md)

## Proposed ADRs

These choices still require native implementation and live platform evidence before
acceptance:

1. [`0013-windows-computer-use-backend.md`](0013-windows-computer-use-backend.md)
2. [`0014-macos-computer-use-backend.md`](0014-macos-computer-use-backend.md)
3. [`0015-ubuntu-gnome-wayland-computer-use-backend.md`](0015-ubuntu-gnome-wayland-computer-use-backend.md)
