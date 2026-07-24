# OS Computer Use boundary

`@opendelegate/computer-use-os` is the Phase 11 enforcement seam between
OpenDelegate's deterministic Worker runtime and a logged-in user's native desktop
helper. It is intentionally separate from the Phase 1 fake backend in
`@opendelegate/computer-use`.

## What this package proves

- Windows, macOS, and Linux backends share one injected native-driver contract for
  readiness, observation, PNG capture, input, cancellation, and emergency stop.
- Readiness reports interactive session, unlocked state, screen capture,
  accessibility, input, helper authentication, and current exclusive service epoch
  as separate checks.
- Linux's declared graphical conformance target is
  `ubuntu-24.04-gnome-wayland`. A headless Linux driver reports Computer Use
  unavailable while leaving non-graphical Worker capabilities outside this package
  unaffected.
- Every controller is bound to an exact Task, Device, Run, capacity-one
  `desktop-session` lease, fencing token, helper identity, service epoch, and
  persistence generation.
- Start replay returns the same live handle. A durable replay after process restart
  fails closed when the original in-memory controller cannot be recovered.
- Input authorization receives a Task-scoped SHA-256 fingerprint. Typed text is
  represented by its digest and length; it never enters authorization requests,
  structured logs, or action summaries.
- Authority and the exact lease/fence are checked again after authorization and
  immediately before native mutation.
- Stale authority, stale leases, display changes, helper crashes, lock state,
  permission loss, session deadlines, and native operation timeouts stop the
  controller locally and invoke the native emergency-stop boundary.
- The deterministic fixture exposes accessible controls, reaches a visible success
  state, generates a result file, and returns actual PNG bytes. The exported
  conformance laboratory also proves cancellation and emergency-stop rejection.

## What this package does not prove

Injected fixture drivers are not live OS automation. This package does **not** make
the first-milestone Computer Use release claim by itself.

- Windows has a safe read-only current-session probe. On the development host it can
  establish an interactive process session and report whether LogonUI is visible,
  but absence of LogonUI remains insufficient to prove an unlocked desktop. It
  deliberately leaves capture, accessibility, and input unverified and fails
  helper-authentication and service-epoch checks. It never injects input.
- A real Windows UI Automation/capture/input helper and platform-lab evidence are
  still required.
- A real macOS helper, Accessibility and Screen Recording onboarding, native driver,
  and platform-lab evidence are still required.
- A real Ubuntu 24.04 GNOME Wayland helper/driver and platform-lab evidence are still
  required.
- The OS-specific backend choice, permissions, supported versions, and known
  limitations still require one accepted ADR per OS family as required by Spike D.

Until those live proofs exist, macOS, graphical Linux, and active Windows input
remain release blockers. A headless Linux Device is expected to remain unavailable
for Computer Use.

## Integration ports

Production composition must inject:

1. a `NativeComputerUseDriver` owned by the authenticated per-user helper;
2. a `DesktopAuthorityPort` backed by the exclusive Device-service epoch and an
   external monotonic authority outside restorable application snapshots;
3. a `DesktopLeasePort` backed by the current capacity-one Resource Lock and fence;
4. a durable `ComputerUseStartHistory`;
5. the executable Policy authorizer; and
6. a redacted structured logger.

The native driver receives raw text only at the final input boundary and must not
log or persist it. It must atomically reject a changed display fingerprint and honor
the provided abort signal. Resource-lock acquisition and release remain owned by the
Worker/runtime integration; this package verifies, but does not mint, a lease.

## Conformance

Run:

```sh
pnpm --filter @opendelegate/computer-use-os typecheck
pnpm --filter @opendelegate/computer-use-os test
```

`runNativeDriverConformanceLab` is suitable for a real driver only when the
deterministic fixture application is visible on that OS. Passing it with the bundled
fixture driver is contract proof, not platform proof.

## Dependency graph

This package has zero workspace dependencies and zero third-party runtime
dependencies. It uses only Node.js built-ins. The intended graph is:

```text
worker/helper composition
  -> @opendelegate/computer-use-os
       -> injected policy, lease, authority, and native-driver ports
```
