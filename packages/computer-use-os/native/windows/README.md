# Windows native Computer Use candidate

This directory contains the Windows 11 native candidate described by
[ADR-0013](../../../../docs/adr/0013-windows-computer-use-backend.md). It does not
make Windows Computer Use a supported release claim. ADR-0013 remains Proposed
until the signed, packaged candidate passes the complete clean-host matrix.

## Components

- `OpenDelegate.WindowsComputerUseHelper.vcxproj` builds the least-privilege,
  interactive-session helper. It uses Windows UI Automation for structured
  observation and semantic actions, Windows.Graphics.Capture for PNG evidence, and
  `SendInput` only as a same-or-lower-integrity fallback.
- `OpenDelegate.WindowsComputerUseFixture.vcxproj` builds the deterministic Win32
  fixture used by the shared native-driver conformance laboratory.
- `../../src/windows-helper-ipc.ts` is the owner-session helper's authenticated
  named-pipe port for its one-process native child. The native child and the port
  mutually prove a 32-byte bootstrap Secret, derive directional keys, authenticate
  every bounded frame, and bind the helper instance, service epoch, session identity,
  Device, and release version. This child boundary is nested behind the separate
  Ed25519-authenticated core/owner-session helper plane from ADR-0011 and D-043.
- `../../src/windows-native-driver.ts` maps the authenticated helper into the shared
  `NativeComputerUseDriver` contract without minting Policy, lease, or fencing
  authority.

The owner-session helper must supply this child-only bootstrap Secret through
inherited descriptor 3 and identify its exact process through `--parent-process-id`.
It is not the service-plane IPC credential and is never shared with the core
service. The pipe DACL is owner-only, and every production connection must
additionally report that exact client PID. `--lab-allow-owner-client` remains
restricted to focused authentication tests. The conformance harness keeps the
production parent-PID check and uses the separate `--lab-fixture-capture` switch
only for its deterministic non-release window.
The helper rejects remote pipe clients and independently verifies the connected
client process SID. Secrets are never accepted through argv or environment
variables.

The candidate reserves `Ctrl+Alt+Pause` as its Device-local emergency stop. Hotkey
registration is a separate readiness fact: if another application owns that chord,
the helper reports input unavailable instead of claiming an emergency boundary it
does not have.

## Build

Prerequisites are Windows 11, Visual Studio 2022 Build Tools with the Desktop
development with C++ workload, and a Windows 10/11 SDK.

From the repository root:

```powershell
pnpm --filter @opendelegate/computer-use-os native:windows:build
```

The script builds the host architecture (`x64` or `ARM64`) in Release mode, runs the
helper's deterministic protocol-crypto self-test, and prints the absolute external
scratch path containing the binaries. Generated MSBuild output never belongs in the
source checkout. Release packaging must rebuild the selected target architecture in
the immutable release pipeline; these temporary outputs are not publishable
artifacts.

## Local engineering conformance

Evidence must be written to an absolute directory outside the source checkout:

```powershell
pnpm --filter @opendelegate/computer-use-os native:windows:conformance -- `
  --evidence-directory C:\absolute\external\evidence
```

The default path opens the Windows capture picker. The owner must select the
deterministic fixture. For isolated implementation diagnostics only, direct fixture
window capture can be enabled explicitly:

```powershell
pnpm --filter @opendelegate/computer-use-os native:windows:conformance -- `
  --evidence-directory C:\absolute\external\engineering-evidence `
  --nonrelease-direct-fixture-capture
```

Both modes label their output `supportClaim: false`. The direct mode additionally
uses a public fixed IPC test vector and can never be promoted as owner-consent or
release evidence. Neither mode writes screenshots, typed fixture text, IPC keys, or
pipe identifiers into the evidence record; it records bounded hashes and readiness
outcomes.

## Remaining release gates

Before ADR-0013 can be accepted, the exact final-commit binaries must be packaged and
publisher-signed, installed on clean declared Windows 11 hosts, and linked to the
release ledger. The owner-controlled lab must cover:

- system-picker selection, cancellation, and consent withdrawal;
- service and helper restart, reboot, login/logout, lock/unlock, session switch, and
  helper replacement;
- capacity-one desktop locking, cancellation, and emergency stop;
- a higher-integrity target, UAC secure desktop, UIPI denial, and partial
  `SendInput`;
- display, monitor, and DPI changes plus helper crash and frame timeout; and
- the declared Windows 11 25H2 build 26200.8875 on `x64`.

The helper deliberately never elevates, unlocks the workstation, dismisses UAC,
enables interactive-services compatibility, or injects into another user's session.
