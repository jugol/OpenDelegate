# First-milestone target and support matrix

OpenDelegate does not use an unbounded “macOS, Windows, and Linux” support claim.
The first milestone targets the exact platform families and architectures below.
They remain **release targets, not supported platforms**, until the 36-criterion
ledger is complete and the corresponding owner-controlled lab evidence is bound to
the release candidate.

## Target Devices

| Role and capability | First-milestone target | Architecture | Required candidate evidence |
| --- | --- | --- | --- |
| Main and Worker on macOS | macOS Tahoe 26.5.2 | Apple silicon (`arm64`) | Pre-manifest Developer ID signatures; exact-archive publisher attestation and external accepted notarization receipt; install, reboot, login/logout, upgrade/rollback, Codex and Claude, routes, and owner recovery |
| Main and Worker on Windows | Windows 11 25H2, build 26200.8875 | `x64` | Pre-manifest Authenticode signatures and trusted timestamps; exact-archive publisher attestation; SCM and user-helper lifecycle; reboot, login/logout, upgrade/rollback, Codex and Claude, routes, and owner recovery |
| Main and headless Worker on Linux | Ubuntu Server 24.04.4 LTS | `x64` | Exact-archive publisher attestation; systemd and foreground-fallback lifecycle; reboot, upgrade/rollback, Codex and Claude, routes, and explicit Computer Use unavailability |
| Graphical Worker on Linux | Ubuntu Desktop 24.04.4 LTS, GNOME on Wayland | `x64` | Exact-archive publisher attestation; system and user-helper lifecycle; login/lock/logout; portal permission handling; Codex and Claude; and real Computer Use |

The release evidence must record the complete OS build, kernel, desktop/session
type, architecture, OpenDelegate bundle checksum, Node runtime checksum, Agent
versions, service configuration, and relevant permission state observed during the
run. A later OS patch, different Linux distribution or desktop, Intel Mac,
Windows-on-Arm Device, or Arm Linux Device is not silently covered by this matrix.
It requires an explicit compatibility entry and matching evidence.

OpenDelegate's internal-preview builder can assemble additional host tuples. The
ability to assemble a preview is not a support declaration.

## Computer Use

The first milestone requires a real reference workflow on all three graphical
targets:

- macOS Tahoe 26.5.2 on Apple silicon;
- Windows 11 25H2 build 26200.8875 on x64; and
- Ubuntu Desktop 24.04.4 LTS with GNOME on Wayland on x64.

Headless Ubuntu remains a fully useful non-graphical Worker and must report
Computer Use as unavailable. WSL, WSLg, X11, alternative Wayland compositors,
remote-desktop-only sessions, and fixture drivers do not substitute for these live
gates.

## Hosted CI compatibility matrix

Hosted CI is pinned to named images so the tested OS family cannot move when a
provider changes a `*-latest` alias:

| Job | GitHub-hosted image | Purpose |
| --- | --- | --- |
| Linux verification | `ubuntu-24.04` | Source, package, browser, and platform-bundle compatibility |
| Windows verification | `windows-2025` | Source, package, browser, and platform-bundle compatibility |
| macOS verification | `macos-26` | Apple-silicon source, package, browser, and platform-bundle compatibility |
| Persistence verification | `ubuntu-24.04` with PostgreSQL 17 | SQLite/PostgreSQL domain-contract equivalence and Main composition |

These hosted images are engineering evidence only. Windows Server is not the
declared Windows 11 desktop target, and hosted runners do not prove privileged
service installation, reboot persistence, interactive permissions, private
networking, live providers, Discord, signing, or Computer Use.
The hosted persistence job currently proves PostgreSQL 17 only. Other PostgreSQL
major versions are not covered by the first-milestone automated evidence and must
not be inferred from the generic external-URI configuration surface.

## Release authenticity and support eligibility

All four target entries are promoted as one complete support set. Platform-native
signing, a working archive, or a passing hosted job for one tuple never promotes
that tuple independently.

ADR-0021 requires macOS and Windows executable signatures to be applied and verified
before payload integrity manifests are generated. Linux has no additional
first-milestone platform-native signature requirement, but every target requires an
exact-archive Ed25519 publisher attestation. The exact final macOS archive is
notarized only after its manifests and publisher attestation exist; the accepted
result stays outside the archive so no manifest-bound byte is stapled or rewritten.

One cross-platform promotion attestation then binds the complete target set, native
authenticity records, notarization receipt, publisher attestations, ledger, and live
evidence. Exactly three independently signed observer envelopes—one per supported
target archive—prove remote digest read-back before a supported-channel release
receipt can bind them. Publisher, promotion, and observer trust roots are mutually
distinct and provisioned independently; the promotion key ID is also the read-back
plan's uploader authorization, not a separate uploader signing role. The configured
policy revokes observer keys independently. Effective `released` is computed from
those external records and trust roots while the enclosed payload remains
`release-candidate`. Main and Admin expose the enclosed `declaredReleaseChannel`
separately from effective `releaseChannel` and a sanitized verification status.
Absent, invalid, incomplete, promotion-invalid, or revoked external authority never
upgrades the effective channel beyond `release-candidate`.

Internal previews, ad-hoc or self-signed native binaries, CI-generated Ed25519 keys,
and a public key distributed only beside its own signature are not support eligible.
All credential-bearing tools run on clean committed, hash-pinned target runners.
The actual Developer ID and Authenticode identities, notarization account,
owner-controlled Devices, Discord and provider credentials, and live matrix remain
external blockers.

## Automatic package installation

The production automatic project-install boundary currently supports npm only. It
uses an isolated credential-free home, the official npm registry, scripts disabled,
sealed staging below private Worker state, and validated promotion. Windows invokes
the pinned `node.exe` and `npm-cli.js` pair directly without `cmd.exe` or a shell.

The production composition also accepts install-only requests through an exact
owner-configured system manager: `apt`, `apt-get`, `dnf`, `yum`, or `zypper` on
Linux; `brew` on macOS; and `winget` or `choco` on Windows. Worker pins the
canonical executable identity and SHA-256 for its process lifetime and
revalidates it immediately before use. Package names cannot inject source flags;
source additions remain a distinct protected action. This is implementation
evidence, not a supported-manager claim: clean-host install, privilege, and
existing-source behavior still require target-platform lab proof before release.

## Runtime and integration pins

| Integration | First-milestone pin |
| --- | --- |
| Bundled Node.js | 24.18.0, verified against the repository-pinned official archive digest |
| pnpm | 11.15.1 |
| Codex CLI fallback | 0.145.0 |
| Claude Code CLI fallback | 2.1.205 |
| Discord API | v10 |
| Graphical Linux reference | Ubuntu 24.04.4 LTS, GNOME, Wayland |

Provider versions outside their tested compatibility set fail closed unless the
owner explicitly allows an untested version. Candidate evidence must name the
exact versions actually exercised.

## Updating the matrix

Changing a target version or architecture is a product and release decision, not a
documentation-only refresh. Update the relevant platform ADR, this matrix, CI or
lab configuration, compatibility probes, and the release ledger together. Do not
carry forward prior live evidence to a new target without rerunning the affected
gates.

Primary platform references:

- [GitHub Actions runner images](https://github.com/actions/runner-images)
- [Apple security releases](https://support.apple.com/100100)
- [Microsoft Windows 11 release information](https://learn.microsoft.com/windows/release-health/windows11-release-information)
- [Ubuntu 24.04.4 release](https://releases.ubuntu.com/noble/)
