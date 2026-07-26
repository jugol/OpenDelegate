# macOS native Computer Use candidate

This Swift package contains OpenDelegate's target-native macOS Computer Use
candidate:

- `opendelegate-macos-computer-use` performs bounded ScreenCaptureKit capture,
  AXUIElement observation and targeting, and CGEvent pointer/keyboard input;
- `opendelegate-computer-use-fixture` exposes deterministic visible and accessible
  controls and writes one run-scoped JSON result; and
- `OpenDelegateMacComputerUseProtocol` owns the bounded, strictly sequenced private
  wire contract and sticky cancellation/emergency-stop state.

The helper is a **private child** of an already authenticated logged-in Aqua
session helper. It accepts inherited stdin/stdout pipes only. It is not the
ADR-0011 Unix-domain-socket server, must not be launched as an independently
reachable service, and does not mint leases, fencing tokens, Policy decisions, or
service epochs.

Production composition passes the canonical executable path inside the immutable
root-owned versioned release, not the mutable staging directory or `current`
symlink. The TypeScript launcher rejects symlinks, multi-linked or mutable files,
non-root-owned/writable ancestors, digest mismatch, and invalid code signatures
before spawning the child.

## Current evidence boundary

Source and protocol tests exist. The protocol tests have run with Swift 6.2.4 on a
Windows contributor host by using a scratch directory outside the checkout. That
run does not compile Apple framework branches or prove macOS behavior.

The repository's macOS CI lane compiles both executables and runs the Swift tests.
A green CI job is code/build evidence only. macOS Computer Use remains unsupported
until a clean owner-controlled Mac proves the signed/notarized bundle, stable TCC
identity, authenticated core-to-session-helper composition, real fixture actions,
lock and permission failures, cancellation, emergency stop, and lifecycle cases in
[`docs/release/PLATFORM_LAB.md`](../../../../docs/release/PLATFORM_LAB.md).

The `adr-0011-ed25519-v2` binding carried into this child is receipt metadata, not
standalone authentication performed by Swift. The production session helper must
construct it only after mutual Ed25519 authentication and must close the child when
that outer channel, helper identity, owner session, release, or epoch changes. Until
that composition exists and is tested, the candidate must report unavailable.

## Build and test on macOS

Keep SwiftPM output outside the source checkout:

```sh
SWIFT_SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SWIFT_SCRATCH"' EXIT

swift test \
  --package-path packages/computer-use-os/native/macos \
  --scratch-path "$SWIFT_SCRATCH/tests"

swift build \
  --configuration release \
  --package-path packages/computer-use-os/native/macos \
  --scratch-path "$SWIFT_SCRATCH/release" \
  --product opendelegate-macos-computer-use

swift build \
  --configuration release \
  --package-path packages/computer-use-os/native/macos \
  --scratch-path "$SWIFT_SCRATCH/release" \
  --product opendelegate-computer-use-fixture
```

These commands establish compilation and unit-test status on the Mac where they
actually run. They do not establish signing, notarization, TCC, installation, or
live Computer Use status.

## Permission onboarding

The helper never edits or pre-seeds the TCC database. The non-mutating status
command is:

```sh
/absolute/path/opendelegate-macos-computer-use --permission-status
```

Only an explicit owner onboarding action may request the system prompts:

```sh
/absolute/path/opendelegate-macos-computer-use --request-permissions
```

Both commands report separate `accessibility`, `screenCapture`, and `input`
booleans. A successful preflight is not live proof: readiness also requires a real
ScreenCaptureKit frame, a live AXUIElement query, an active unlocked owner Aqua
session, inactive Secure Event Input, the authenticated helper binding, and the
current service epoch.

TCC grants attach to the distributed signed identity. Rebuilding, relocating, or
ad-hoc signing a helper can change macOS consent behavior. The release lab must
record the exact bundle, signature, notarization, OS version, architecture, and
permission setup without publishing private owner data.

## Deterministic fixture

Create a result directory outside the checkout and launch the fixture in the test
user's visible Aqua session:

```sh
FIXTURE_RESULTS="$(mktemp -d)"
/absolute/path/opendelegate-computer-use-fixture \
  --run-id run-2026_07_25 \
  --result-directory "$FIXTURE_RESULTS"
```

The native driver must discover and use these accessibility identifiers:

| Identifier       | Purpose                          |
| ---------------- | -------------------------------- |
| `fixture-run-id` | Immutable run identifier         |
| `task-text`      | Text input                       |
| `option-alpha`   | Alpha radio option               |
| `option-beta`    | Beta radio option                |
| `submit`         | Visible submit button            |
| `fixture-status` | Editing/success state            |

The fixture has no automation shortcut. A successful visible submit writes
`fixture-result-<run-id>.json` atomically. The driver reads that bounded regular
file only from the explicitly configured result directory.

## Safety properties to verify live

- Lock, logout, Fast User Switching, loginwindow, sleep, Space changes, helper
  replacement, display reconfiguration, missing/revoked TCC, and Secure Event Input
  all prevent further input.
- Cancellation and emergency stop become sticky for the execution handle. The
  TypeScript parent also closes the private pipes, sends `SIGTERM`, and uses a
  bounded `SIGKILL` fallback.
- The display fingerprint is checked before and during input and after capture.
- The candidate captures the current main display while fingerprinting the complete
  online-display layout. Multiple-display targeting and evidence coverage remain a
  mandatory live-lab case and are not claimed from this source alone.
- Raw typed text crosses only the final private action boundary. Neither Swift
  failure frames nor TypeScript native errors include child stderr or typed text.
- The private child verifies its parent PID continuously. The authenticated outer
  helper must bind helper identity, owner OS session, release, and service epoch
  through ADR-0011 before constructing this child.

Do not mark ADR-0014 accepted or criterion 19 complete from a build or simulated
fixture run.
