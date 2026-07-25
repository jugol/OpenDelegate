# Ubuntu GNOME Wayland native Computer Use candidate

This directory contains the production candidate selected by
[ADR-0015](../../../../docs/adr/0015-ubuntu-gnome-wayland-computer-use-backend.md).
It does not make graphical Linux a supported release claim. ADR-0015 remains
Proposed until the clean-host live matrix and immutable release-ledger evidence
pass.

The helper is a private child of the ADR-0011 authenticated graphical user-session
helper. It accepts bounded JSONL only through inherited stdin/stdout and opens no
socket, pipe, TCP port, shell, or filesystem proxy. The outer helper identity,
GNOME session identity, release, and service epoch are bound into every request and
response. The TypeScript parent verifies a pinned SHA-256 digest, an executable
regular file, root-or-current-owner ownership, and no group/world write permission
before launch.

The implementation uses:

- AT-SPI2 for bounded structured observation and semantic control actions;
- `org.freedesktop.portal.RemoteDesktop` version 2 for owner-consented keyboard and
  pointer authority;
- `org.freedesktop.portal.ScreenCast` plus its PipeWire remote for current PNG
  evidence;
- the GNOME screen-lock service for positive unlocked-state evidence; and
- a private runtime `flock` plus OpenDelegate's capacity-one `desktop-session`
  lease/fence enforcement.

It never uses XTest, `/dev/uinput`, direct compositor APIs, a virtual desktop, or
portal-dialog automation. A portal cancellation, missing positive lock evidence,
closed session, missing PipeWire frame, changed stream fingerprint, unavailable
AT-SPI tree, helper replacement, or second local controller fails closed.

## Declared host

- Ubuntu 24.04 LTS
- GNOME on Wayland
- one active local owner session

Install distribution packages from Ubuntu's configured repositories:

```sh
sudo apt-get install \
  python3-gi gir1.2-atspi-2.0 gir1.2-gtk-4.0 gir1.2-gstreamer-1.0 \
  gstreamer1.0-pipewire gstreamer1.0-plugins-good \
  xdg-desktop-portal xdg-desktop-portal-gnome pipewire
```

Official-package installation may be automated under the accepted product policy.
Adding package sources, remote installer scripts, or weakening portal permissions
remains protected.

## Evidence boundary

The GTK fixture is only for a visible, owner-observed platform lab. Live evidence
must be written outside the checkout and must record the exact immutable commit,
Ubuntu/GNOME/portal/PipeWire/AT-SPI versions, architecture, portal consent behavior,
PNG digest, cancellation, emergency stop, lock/logout, helper crash, portal
revocation, monitor change, suspend/resume, and headless-unavailable cases.

Source presence, Python bytecode compilation, injected transport tests, or a local
developer run never closes the release ledger. Do not copy portal restore tokens,
screen bytes, AT-SPI labels, or typed text to Main, logs, or an LLM prompt.
