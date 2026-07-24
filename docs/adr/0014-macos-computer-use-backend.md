# ADR-0014: macOS Computer Use backend and permissions

Status: **Proposed**

Date: **2026-07-24**

## Context

A macOS LaunchDaemon has no WindowServer session and cannot own desktop automation.
An interactive helper must run as the logged-in owner, while macOS Transparency,
Consent, and Control (TCC) separately governs Accessibility and screen recording.
OpenDelegate must surface those grants as owner setup, not attempt to bypass or
silently infer them.

This proposal selects the native interfaces to implement and validate. No production
macOS native driver or complete live TCC evidence exists yet, so this ADR does not
declare macOS Computer Use supported.

## Proposed decision

1. The initial candidate target is a macOS graphical Aqua session. Exact macOS
   versions and architectures become supported only when named in a target bundle
   and recorded in the release ledger.
2. The core runs outside the graphical session and communicates through ADR-0011's
   authenticated Unix-domain-socket protocol with a per-owner LaunchAgent helper.
   The helper is unavailable when no matching Aqua session is active.
3. The helper uses **AXUIElement** as the primary structured observation and semantic
   action surface. Accessibility readiness requires the TCC grant and a successful
   query/action against the deterministic fixture, not only a cached preference.
4. The helper uses **ScreenCaptureKit** as the primary screen-observation and
   evidence path. It calls `CGPreflightScreenCaptureAccess` as a non-mutating
   readiness probe and verifies readiness with an actual bounded capture. Missing
   permission is surfaced as an owner-guided Privacy & Security setup step.
5. The helper uses **CGEvent** for pointer and keyboard input after the exact
   ADR-0012 authorization and authority checks. It does not synthesize events while
   the session is locked, the helper is outside the active owner session, required
   Accessibility/Input Monitoring authority is unavailable, or macOS secure-input
   behavior prevents a safe target.
6. Accessibility, capture, input, active Aqua session, unlocked state, helper
   authentication, and display fingerprint remain independent readiness evidence.
   Revocation or a failed native probe withdraws only the affected graphical
   capability.
7. Display reconfiguration, sleep/wake, Fast User Switching, helper replacement,
   permission change, or lost ScreenCaptureKit stream invalidates the controller
   until readiness and authority are re-established.
8. The native driver implements ADR-0012's exact lease, fence, Policy, service-epoch,
   cancellation, timeout, and emergency-stop behavior. It never attempts to modify
   TCC databases, bypass privacy prompts, unlock the Mac, or act across user
   sessions.

## Alternatives considered

### Let the LaunchDaemon call accessibility and capture APIs

Rejected because it does not own the logged-in WindowServer/Aqua session and would
collapse daemon health into desktop readiness.

### Use screenshots and CGEvent without AXUIElement

Rejected because it loses accessible roles, labels, bounds, and semantic actions
that make deterministic control more reliable.

### Modify or pre-seed the TCC database

Rejected because permission is an OS- and owner-controlled boundary. OpenDelegate
must guide and detect rather than bypass it.

### Infer permission solely from preflight

Rejected because a preflight result can become stale; the driver also needs a real
capture and accessibility operation in the current helper session.

## Consequences

- Onboarding must explain and verify separate Accessibility and screen-recording
  permissions without placing private TCC state in Task context.
- A healthy core can remain online while the LaunchAgent or one TCC grant is absent.
- Code signing and bundle identity may affect stable TCC behavior; signing remains a
  gated release operation under ADR-0010 and must be included in live evidence.
- Multiple displays, Retina scaling, Space changes, sleep/wake, Fast User Switching,
  and secure input require explicit platform-lab cases before being advertised.
- This ADR remains Proposed, and macOS Computer Use remains a release blocker, until
  the native helper and real-host proof exist.

## Verification required for acceptance

- A clean candidate macOS host installs the daemon and LaunchAgent and survives
  reboot, login/logout, lock/unlock, sleep/wake, helper restart, and service restart.
- With grants present, AXUIElement finds and activates the fixture's labeled controls,
  ScreenCaptureKit returns current frames, CGEvent supplies authorized pointer and
  keyboard input, and the visible success state produces screenshot evidence.
- Denied/revoked Accessibility, denied/revoked screen recording, no Aqua session,
  locked session, secure input, helper crash, display change, and stream loss fail
  safely and produce actionable redacted diagnostics.
- A second Run waits on the capacity-one desktop lock; cancellation and emergency
  stop prevent further input.
- The live result and exact macOS version, architecture, signing state, and permission
  setup are linked in the canonical release ledger.

## References

- `docs/PRODUCT_SPEC.md`, FR-12 and Worker deployment
- `docs/IMPLEMENTATION_PLAN.md`, Spikes C and D and Phase 11
- [`ADR-0010`](0010-reproducible-platform-bundles-and-provenance.md)
- [`ADR-0011`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [`ADR-0012`](0012-computer-use-native-driver-authority-and-readiness.md)
- [Apple: Designing Daemons and Services](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html)
- [AXUIElement](https://developer.apple.com/documentation/applicationservices/axuielement)
- [ScreenCaptureKit](https://developer.apple.com/documentation/ScreenCaptureKit)
- [CGPreflightScreenCaptureAccess](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess)
- [Apple: Accessibility access](https://support.apple.com/guide/mac-help/mh43185/mac)
- [Apple: Privacy & Security settings](https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac)
