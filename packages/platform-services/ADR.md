# Package decision: reproducible bundles and native two-plane supervision

Status: **Accepted for the platform-services implementation**

Date: **2026-07-24**

## Context

OpenDelegate must remain available without a developer shell or global Node.js installation. Its
always-on daemon cannot safely impersonate a logged-in desktop on Windows, macOS, or Linux. Upgrades
must not strand a Device, and runtime data must remain outside the source checkout.

This decision implements approved D-030 and the direction in Implementation Plan Spikes B and C. It
does not change product behavior.

## Decision

1. Release artifacts are reproducible bundles containing the pinned runtime and native service
   hosts.
2. Every Device has two supervisor identities: an always-on core and a per-owner graphical session
   helper.
3. Windows uses SCM plus an interactive least-privilege logon task; macOS uses a LaunchDaemon plus
   Aqua LaunchAgent; systemd Linux uses a system unit plus graphical user unit.
4. Native definitions use one stable absolute `current` path. Versioned bundles are staged and
   verified on the installation volume before atomic promotion and activation.
5. Post-activation core health is mandatory. Failure triggers deterministic reverse rollback to the
   previous version. Helper unavailability is acceptable only when the owner is logged out; it never
   implies that core health failed.
6. The active release and a bounded number of previous healthy releases are retained. Pruning occurs
   only after health succeeds.
7. Uninstall preserves state and logs unless an explicit purge is requested.
8. Privileged filesystem and supervisor mutations live behind injected adapters. Plans contain argv
   arrays and normalized actions, never shell programs.
9. The core/helper local channel uses a platform-local endpoint plus an opaque Secret reference for
   challenge-response authentication. Network location and OS user presence alone are not
   authentication.
10. Live platform support is recorded only by the external acceptance ledger after clean-host,
    reboot, login/logout, and failed-upgrade proof.

## Consequences

- Service paths remain stable across upgrades, and an arbitrary global Node version cannot alter
  runtime behavior.
- A healthy headless daemon remains schedulable while Computer Use truthfully becomes unavailable
  after logout, lock, permission denial, or helper failure.
- Installer adapters need same-volume atomic rename/link replacement and a durable operation
  journal. Filesystem implementations must make exact re-execution idempotent.
- macOS TCC, Windows interactive-session behavior, and Linux graphical-session behavior remain
  platform-lab concerns rather than assumptions encoded by the renderer.
- A non-systemd Linux foreground command is available for an owner-selected external supervisor, but
  it is not called a completed persistent installation without live supervisor proof.

## Rejected alternatives

### Use a global Node.js installation

Rejected because host updates would silently change the tested runtime and make rollback incomplete.

### Run the core as root, LocalSystem, or the desktop owner

Rejected because the core does not need broad system or interactive authority.

### Let the boot daemon control the desktop

Rejected because native service isolation and locked-session boundaries make that unsafe and
unreliable.

### Replace binaries in place

Rejected because partial writes and files held open by running processes make health-check rollback
unreliable.

### Delete state on ordinary uninstall

Rejected because reinstall and recovery should not destroy durable Task, Device, or Worker state
without an explicit purge request.

## Verification

- Strict parser tests validate every rendered native definition.
- Command validation rejects non-native shells, malformed argv, and Secret references.
- Injected plan and subprocess fakes prove success, logged-out deferral, failed-health rollback, and
  rollback failure diagnostics.
- A Windows-only read-only probe verifies that SCM and Task Scheduler are present without changing
  host state.
- Node.js 22 and 24 run the same package contract suite.
