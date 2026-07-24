# ADR-0015: Ubuntu 24.04 GNOME Wayland Computer Use backend and permissions

Status: **Proposed**

Date: **2026-07-24**

## Context

Graphical Linux is not one uniform automation platform. Wayland intentionally routes
screen sharing and remote input through compositor- and user-mediated interfaces,
while AT-SPI exposes application accessibility semantics. The first milestone needs
one precise candidate graphical environment rather than an unbounded promise across
distributions, desktops, display servers, and headless hosts.

This proposal selects Ubuntu 24.04 with GNOME on Wayland as that environment. No
production Linux native driver or complete live portal evidence exists yet, so this
ADR does not declare graphical Linux Computer Use supported.

## Proposed decision

1. The first graphical Linux target is **Ubuntu 24.04 LTS, GNOME, Wayland**, in one
   active local owner session. X11, other distributions, other compositors, remote
   seats, and headless sessions are not implicitly supported.
2. The core runs as a system service and communicates through ADR-0011's authenticated
   Unix-domain-socket protocol with a graphical systemd user helper in the active
   owner session.
3. The helper uses **AT-SPI2** as the primary structured accessibility tree and
   semantic-action surface. Accessibility readiness requires a live session bus and
   successful fixture query/action; AT-SPI presence alone is not sufficient.
4. Screen evidence uses
   **`org.freedesktop.portal.ScreenCast`** and the PipeWire stream returned by the
   portal. The user selects the permitted source through the portal UI. Stream
   identity, logical size, mapping, and display fingerprint are revalidated when
   monitors, resolution, suspend/resume, or session state changes.
5. Pointer and keyboard input use
   **`org.freedesktop.portal.RemoteDesktop`** within the user-approved session.
   When the portal advertises `ConnectToEIS`, the helper may use the returned libei
   connection; otherwise it uses only the RemoteDesktop methods exposed by the
   accepted portal version. It never falls back to an undocumented compositor
   bypass.
6. Portal dialogs and user-selected devices/sources are required consent, not an
   error to automate away. A restore token may be used only as documented, is stored
   locally as sensitive helper state, is never sent to Main or an LLM, and is
   replaced after single-use restoration. A failed restore returns to the ordinary
   user prompt.
7. Active graphical session, unlocked state, helper authentication, AT-SPI,
   ScreenCast, RemoteDesktop input, PipeWire frame flow, portal consent, and display
   fingerprint are separate readiness evidence. Logout, lock, helper loss, portal
   close, or session revocation withdraws Computer Use promptly.
8. A headless Ubuntu or NAS-style Linux Device reports Computer Use unavailable and
   remains fully usable for independently verified shell, storage, container, and
   agent Capabilities. OpenDelegate does not start a virtual desktop to turn
   headless into graphical readiness.
9. The native driver implements ADR-0012's exact lease, fence, Policy, service-epoch,
   cancellation, timeout, and emergency-stop behavior. It does not use XTest,
   `/dev/uinput`, elevated device injection, or compositor-specific private APIs to
   bypass Wayland/portal consent in this target.

## Alternatives considered

### Claim generic Linux desktop support

Rejected because desktop environment, compositor, portal version, accessibility
stack, and session manager materially change behavior.

### Use X11/XTest as the first target

Rejected because it would not prove the declared modern GNOME Wayland environment
and could encourage input paths outside portal consent.

### Create a hidden virtual desktop on headless Devices

Rejected because product requirements explicitly allow honest Computer Use
unavailability on headless NAS Devices; synthesizing a desktop would add a different
security and operations model.

### Use AT-SPI without the portals

Rejected because accessibility does not provide the complete consented screen stream
and general pointer/keyboard control required by Computer Use.

### Persist a portal restore token on Main

Rejected because it is session permission material local to the Device and is not
needed for scheduling or Task context.

## Consequences

- The candidate Linux support scope is intentionally narrow and testable.
- Initial use and some recovery paths require the owner to complete a GNOME portal
  dialog in the active session.
- Portal and PipeWire version compatibility become declared capability evidence,
  not assumptions derived from distribution name.
- Monitor changes, suspend/resume, portal restoration, locked sessions, and
  accessibility bus failure need real fixtures.
- This ADR remains Proposed, and graphical Linux Computer Use remains a release
  blocker, until the native helper and real-host proof exist. Headless unavailable
  behavior remains an independently required acceptance case.

## Verification required for acceptance

- A clean Ubuntu 24.04 GNOME Wayland host installs the system and user services and
  survives reboot, login/logout, lock/unlock, suspend/resume, helper restart, and
  core restart.
- AT-SPI finds and activates the fixture's labeled controls, ScreenCast provides a
  valid PipeWire frame, RemoteDesktop supplies authorized pointer and keyboard
  input, and the visible success state produces screenshot evidence.
- Portal cancellation/revocation, invalid restore token, no graphical session,
  locked session, helper crash, AT-SPI loss, PipeWire/portal close, and monitor change
  fail safely with actionable redacted diagnostics.
- A second Run waits on the capacity-one desktop lock; cancellation and emergency
  stop prevent further input.
- A headless Ubuntu/NAS fixture continues non-graphical work and reports Computer Use
  unavailable.
- The live result and exact GNOME, Wayland, portal, PipeWire, AT-SPI, OS, and
  architecture versions are linked in the canonical release ledger.

## References

- `docs/PRODUCT_SPEC.md`, FR-12 and Worker deployment
- `docs/IMPLEMENTATION_PLAN.md`, Spikes C and D and Phase 11
- [`ADR-0011`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [`ADR-0012`](0012-computer-use-native-driver-authority-and-readiness.md)
- [systemd overview](https://systemd.io/)
- [AT-SPI2 documentation](https://gnome.pages.gitlab.gnome.org/at-spi2-core/devel-docs/)
- [XDG Desktop Portal ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [XDG Desktop Portal RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
