# ADR-0012: Computer Use native-driver authority and readiness boundary

Status: **Accepted**

Date: **2026-07-24**

## Context

Computer Use must expose one schedulable contract across Windows, macOS, and the
declared graphical Linux environment without pretending that the OS APIs and
permission models are interchangeable. Input can mutate arbitrary application
state, so a screenshot-capable helper or an injected test driver cannot acquire
input authority merely by declaring itself ready.

The shared boundary also has to survive duplicate start delivery, authorization
latency, lease expiry, display changes, helper failure, process restart, and a
coherently rolled-back local snapshot. The fake backend and deterministic fixture
are valuable conformance tools, but they are not live OS support evidence.

## Decision

### Shared native-driver contract

1. The authenticated user-session helper supplies a platform-specific
   `NativeComputerUseDriver` behind one shared contract for:
   - readiness and display identity;
   - structured observation where available;
   - PNG screen capture;
   - pointer, keyboard, and accessibility actions;
   - cancellation and timeout;
   - emergency stop; and
   - redacted diagnostics.
2. Readiness reports separate evidence for an interactive session, unlocked state,
   helper authentication, current service epoch, screen capture, accessibility,
   input permission, and a stable display fingerprint. OS name, an installed
   executable, or one successful screenshot never implies full readiness.
3. A headless or logged-out Device reports Computer Use unavailable while remaining
   eligible for its independently verified non-graphical Capabilities.
4. Each OS driver implements the shared contract but preserves native permission,
   session, and display semantics. The shared layer does not emulate or bypass an OS
   security boundary.

### Authority and lifecycle

1. A controller is bound to one exact Task, Device, Run, authenticated helper,
   service epoch, persistence generation, capacity-one `desktop-session` lease, and
   fencing token.
2. The native driver does not acquire a Resource Lock, approve an action, advance a
   service epoch, or mint a persistence generation. Those authorities are supplied
   by separate deterministic ports owned by the Worker composition.
3. Starting one exact command twice in a live process returns the same live handle.
   A durable replay after restart fails closed if the original native controller
   cannot be recovered. It never creates a second controller under a reused lease.
4. Observation and capture validate helper, service, display, deadline, and
   cancellation state. Active input additionally requires an executable Policy
   authorization whose normalized fingerprint is scoped to the exact Task, Run,
   Device, action type, and target.
5. After authorization returns and immediately before native mutation, the executor
   revalidates the exact lease and fence, external desktop authority, helper/session
   identity, service epoch, persistence generation, display fingerprint, and
   deadline. Any change fails closed and invokes native emergency stop.
6. Text supplied for input reaches only the final native mutation boundary.
   Authorization, logs, audit, and action summaries contain its SHA-256 digest and
   length rather than its plaintext.
7. Cancellation stops future input promptly. Emergency stop is a local, non-LLM
   boundary that rejects later mutation even if a delayed command, approval, or
   native callback arrives.
8. Captures and action summaries are sensitive Task evidence and follow Artifact
   access, retention, provenance, and redaction policy.

### Support-claim boundary

1. The shared conformance suite may use an injected deterministic driver and fixture
   application to prove lifecycle, authority, locking, cancellation, evidence, and
   failure behavior.
2. Passing that suite proves only the shared contract. It does not prove a live
   Windows, macOS, or Linux driver, native permission onboarding, desktop-session
   behavior, or supported release.
3. An OS becomes a supported Computer Use target only after:
   - its OS-specific ADR is Accepted;
   - its real native driver and session helper pass the same conformance suite;
   - permission denial, lock/logout, display change, cancellation, emergency stop,
     and screenshot evidence pass on a clean real host; and
   - the result is linked in the canonical release ledger.
4. The currently Proposed OS ADRs and fixture drivers therefore leave all
   first-milestone live Computer Use gates open.

## Alternatives considered

### Let each OS backend own policy and locking

Rejected because safety and idempotency would diverge across platforms and an OS
driver could accidentally mint authority it is supposed to consume.

### Treat capture readiness as Computer Use readiness

Rejected because screen observation does not prove accessibility, input permission,
an unlocked session, or a current exclusive lease.

### Persist and reconstruct a native controller after restart

Rejected because an OS automation session and its consent can be process- and
session-local. Durable history prevents replay; it does not fabricate a recoverable
native handle.

### Log plaintext typed input for diagnosis

Rejected because typed data may include credentials or private Task content and is
not required to correlate authorization or failure.

### Count fixture conformance as platform support

Rejected because injected drivers do not exercise TCC, UIPI, portals, native capture,
real input, logged-out behavior, or OS permission denial.

## Consequences

- Shared orchestration code has one authority model while OS helpers remain free to
  implement native APIs correctly.
- Readiness is more conservative than a best-effort automation script; ambiguous
  state becomes unavailable or waiting rather than attempted input.
- Every real driver needs an emergency-stop implementation that does not depend on
  Main, Discord, or an LLM round trip.
- The external monotonic authority required by D-039 remains a release dependency;
  an internally valid snapshot cannot establish current desktop authority alone.
- The deterministic fixture is reusable on every platform but cannot close any live
  acceptance ledger entry.

## Verification

- Contract tests cover readiness decomposition, capacity-one lease enforcement,
  exact start replay, restart replay rejection, policy denial, delayed authorization,
  stale fence, stale epoch/generation, changed display, timeout, cancellation,
  helper crash, emergency stop, plaintext redaction, and valid PNG evidence.
- A shared graphical fixture exposes accessibility labels, pointer and keyboard
  targets, a visible success state, and a generated result file.
- Each accepted native driver must run the contract against that real fixture and
  attach OS-versioned evidence to the release ledger.

## References

- `docs/PRODUCT_SPEC.md`, FR-8, FR-12, FR-16, and First Milestone Acceptance
  Criteria 13, 19, and 20
- `docs/IMPLEMENTATION_PLAN.md`, Spike D and Phase 11
- `docs/DECISIONS.md`, D-020, D-035, D-037, and D-039
- [`ADR-0011`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [`ADR-0013`](0013-windows-computer-use-backend.md)
- [`ADR-0014`](0014-macos-computer-use-backend.md)
- [`ADR-0015`](0015-ubuntu-gnome-wayland-computer-use-backend.md)
