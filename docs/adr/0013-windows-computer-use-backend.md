# ADR-0013: Windows Computer Use backend and permissions

Status: **Proposed**

Date: **2026-07-24**

## Context

Windows services cannot directly provide reliable interaction with the logged-in
desktop. Windows also separates structured accessibility, screen capture, and
synthetic input, and User Interface Privilege Isolation (UIPI) prevents ordinary
processes from injecting input into higher-integrity applications. OpenDelegate must
not bypass UAC, the secure desktop, a locked session, or user capture consent.

This proposal selects the native stack to implement and validate. A native candidate
and authenticated driver seam now exist under `packages/computer-use-os`, but they
have not been composed into the signed service/helper bundle or passed the complete
clean-host platform matrix. This ADR therefore does not declare Windows Computer Use
supported.

## Proposed decision

1. The initial candidate target is a Windows 11 interactive owner session. Exact OS
   builds and architectures become supported only when named in a target bundle and
   recorded in the release ledger.
2. An SCM-managed core communicates through ADR-0011's authenticated named-pipe
   protocol with a least-privilege helper launched in the owner's interactive
   session. The service never enables interactive-services compatibility or changes
   the helper's integrity level to reach a target.
3. The helper uses **Windows UI Automation** as the primary structured observation
   and semantic-action surface. It reports accessibility ready only after it can
   enumerate and invoke the deterministic fixture through the native automation
   tree.
4. The helper uses **Windows.Graphics.Capture** for screen evidence. Onboarding uses
   the system capture picker and treats the user's selected window or display as the
   granted scope. `GraphicsCaptureSession.IsSupported`, a selected
   `GraphicsCaptureItem`, and receipt of a valid frame are separate readiness
   checks.
5. The helper uses UI Automation patterns when they express the requested action and
   **SendInput** for general pointer or keyboard input within the same or a lower
   integrity level. A zero/partial SendInput result, suspected UIPI block,
   higher-integrity foreground target, UAC secure desktop, locked desktop, or
   session switch stops input and reports unavailable or waiting with redacted
   evidence.
6. Capture consent is never inferred from a stored path, process identity, or prior
   screenshot. If the capture item becomes invalid, the display changes, consent is
   withdrawn, or no new frame arrives within the bound, readiness is withdrawn.
7. The helper positively proves the active interactive session and fixture
   visibility. Merely failing to observe LogonUI is not accepted as proof that the
   desktop is unlocked.
8. The driver implements ADR-0012's exact lease, fence, Policy, service-epoch,
   display, cancellation, and emergency-stop checks. It never attempts to elevate,
   dismiss UAC, unlock the workstation, or inject into another user's session.

## Alternatives considered

### Use image matching and SendInput for everything

Rejected because it discards UI Automation's semantic controls and still cannot
cross UIPI or the secure desktop safely.

### Run the helper elevated

Rejected because it would broaden every action's integrity and would not make secure
desktop or consent bypass an acceptable product behavior.

### Capture through an undocumented desktop-duplication shortcut

Rejected as the baseline because Windows.Graphics.Capture exposes a documented
support check and owner selection flow. Additional capture adapters may be proposed
later without weakening consent.

### Treat absence of the lock-screen process as an unlocked proof

Rejected because a negative process observation does not establish that the current
helper owns an input-ready desktop.

## Consequences

- Owner setup includes a visible Windows capture-selection step.
- Applications running at higher integrity than the helper are intentionally outside
  automatic input reach; OpenDelegate reports the boundary instead of escalating.
- UI Automation and captured pixels can disagree during transitions, so the driver
  must bind both to one display/session fingerprint and fail closed on change.
- Remote desktop, Fast User Switching, HDR capture, multiple displays, and DPI
  scaling need explicit fixtures before their behavior can be advertised.
- This ADR remains Proposed, and Windows Computer Use remains a release blocker,
  until the final packaged helper and complete real-host proof exist.

## Candidate implementation status

As of 2026-07-25, the repository contains:

- a warnings-as-errors C++ helper using Windows UI Automation,
  Windows.Graphics.Capture, guarded `SendInput`, positive input-desktop checks, and
  higher-integrity rejection;
- a deterministic Win32 graphical fixture;
- a mutually authenticated, bounded named-pipe protocol whose bootstrap Secret is
  inherited rather than accepted through argv or environment variables; and
- a TypeScript native-driver adapter plus a local engineering conformance command.

An explicit nonrelease direct-fixture run has exercised the candidate end to end on
one development host. Its output is intentionally labeled `supportClaim: false`.
Publisher signing, immutable bundle composition, the owner capture picker, service
and helper lifecycle, negative security cases, clean declared Windows builds, and
release-ledger linkage remain required.

## Verification required for acceptance

- A clean Windows 11 host installs the core and helper and survives reboot,
  login/logout, helper restart, lock/unlock, and service restart.
- The native driver uses UI Automation to find the labeled fixture controls, captures
  a valid Windows.Graphics.Capture frame, injects pointer and keyboard input, reaches
  the visible success state, and produces screenshot evidence.
- A second Run waits on the capacity-one desktop lock; cancellation and emergency
  stop prevent further input.
- Capture cancellation/withdrawal, session switch, locked desktop, helper crash,
  display/DPI change, partial SendInput, a higher-integrity target, and UAC secure
  desktop fail safely with actionable diagnostics.
- The live result and declared Windows build/architecture are linked in the canonical
  release ledger.

## References

- `docs/PRODUCT_SPEC.md`, FR-12 and Worker deployment
- `docs/IMPLEMENTATION_PLAN.md`, Spikes C and D and Phase 11
- [`ADR-0011`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [`ADR-0012`](0012-computer-use-native-driver-authority-and-readiness.md)
- [Microsoft: Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)
- [Windows UI Automation namespace](https://learn.microsoft.com/en-us/uwp/api/windows.ui.uiautomation)
- [Windows screen capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
