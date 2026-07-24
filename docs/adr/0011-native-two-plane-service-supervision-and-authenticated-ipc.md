# ADR-0011: Native two-plane service supervision and authenticated IPC

Status: **Accepted**

Date: **2026-07-24**

## Context

OpenDelegate needs an always-on Device daemon even when no owner is logged in, while
Computer Use needs the authority and graphical resources of an interactive user
session. Native service managers deliberately separate these contexts. Treating a
boot service as a desktop process would be unreliable and would grant the daemon
unnecessary authority.

The two processes must exchange readiness and bounded Computer Use commands without
trusting endpoint locality, process name, or OS user presence as sufficient
authentication. Upgrade and rollback must keep both planes on one compatible
release without deleting runtime state.

This ADR is the canonical consolidation of the implementation note in
`packages/platform-services/ADR.md`. It selects the service and IPC architecture; it
does not claim that clean-host service, reboot, login/logout, permission, or rollback
acceptance has passed on any OS.

## Decision

### Two supervised identities

1. Every graphical-capable Device has two distinct runtime identities:
   - the **core daemon**, which owns Device identity, Main transport, local durable
     state, agent execution, leases, policy enforcement, diagnostics, and Artifact
     transfer; and
   - the **user-session helper**, which owns only the currently logged-in graphical
     session, permission/readiness probes, observation, capture, and authorized
     Computer Use input.
2. The core remains healthy and schedulable for non-graphical work while no helper is
   connected. Helper loss immediately withdraws graphical readiness; it does not
   make the Device or core unhealthy.
3. The native supervision mapping is:
   - Windows: an SCM-managed core service and a least-privilege per-owner interactive
     logon helper;
   - macOS: a LaunchDaemon for the core and an Aqua LaunchAgent for the helper; and
   - systemd Linux: a system service for the core and a graphical user service for
     the helper.
4. Linux without systemd may run the core through an explicit supervised-foreground
   command. That fallback is not a completed persistent installation until the
   selected external supervisor has live acceptance evidence.
5. Neither the core nor its supervisor impersonates a logged-in user or controls the
   desktop directly. A helper is scoped to one authenticated owner session and
   advertises that session separately if multiple sessions exist.

### Installation, upgrade, and rollback

1. Native service definitions point to one stable absolute `current` path. Release
   payloads are installed into immutable versioned directories on the same volume.
2. Upgrade stages and verifies a complete target-specific bundle before atomically
   promoting the stable path. Core health under the new version is mandatory before
   the previous healthy version is pruned.
3. A failed activation deterministically restores the previous path and service
   definitions. Helper absence is an acceptable readiness state only when the owner
   is logged out; it is not allowed to conceal core health failure or protocol
   incompatibility.
4. Installer and supervisor mutations are idempotent, use structured executable and
   argument arrays rather than shell programs, and are journaled for diagnostics and
   retry.
5. Ordinary uninstall removes executable and supervisor registration but preserves
   Device state, logs, owner configuration, and Secrets. Destructive purge is a
   separate explicit operation.
6. Privileged operations are minimized to installation paths and supervisor
   registration. Runtime services use the least-privilege account compatible with
   their plane.

### Authenticated local IPC

1. Windows uses a local named pipe; macOS and Linux use a local Unix-domain socket.
   Endpoint ACLs limit who can connect, but ACLs are defense in depth rather than the
   application authentication decision.
2. Core and helper perform a versioned, mutually authenticated HMAC-SHA-256
   challenge-response handshake using a 256-bit per-installation local IPC key
   obtained by opaque Secret reference. The key value is never written into a
   service definition, command line, log, Task event, diagnostic bundle, or LLM
   context.
3. The handshake binds fresh nonces from both peers, protocol version, Device ID,
   helper identity, OS session identity, core service epoch, and current release
   version. Direction-specific labels prevent replaying a helper proof as a core
   proof.
4. The peers derive direction-specific connection keys from the authenticated
   transcript with HKDF-SHA-256. Every subsequent frame is length-bounded,
   schema-validated, sequence-numbered, and authenticated with HMAC-SHA-256. A
   duplicate, gap, invalid MAC, stale epoch, unsupported version, or changed session
   closes the channel and withdraws helper readiness.
5. IPC exposes a narrow capability protocol: readiness snapshots, capture/observe,
   exact authorized input, cancellation, emergency stop, and bounded diagnostics.
   It is not a shell, arbitrary filesystem proxy, database channel, or general agent
   transport.
6. A connected helper does not mint authority. The core supplies an exact Task,
   Run, helper, service-epoch, persistence-generation, desktop-session lease, and
   fencing identity. Policy, lease, and monotonic desktop authority are revalidated
   at the execution boundary described by ADR-0012.
7. Key rotation requires overlap bounded to one explicit migration handshake.
   Failure to retrieve, authenticate, or rotate the IPC key fails Computer Use
   closed while preserving non-graphical daemon work.

## Alternatives considered

### Let the boot daemon interact with the desktop

Rejected because Windows services, macOS LaunchDaemons, and Linux system services are
not equivalent to an unlocked interactive user session. It also expands daemon
authority unnecessarily.

### Run the entire Worker only as the logged-in owner

Rejected because transport, headless agent work, and durable event delivery must
remain available after logout and on headless NAS Devices.

### Trust a local endpoint and OS ACL alone

Rejected because endpoint squatting, configuration mistakes, inherited handles, and
session confusion can cross the intended capability boundary. Protocol
authentication and service-epoch binding are still required.

### Put the IPC Secret in the service definition

Rejected because service definitions and process command lines are commonly
inspectable and included in diagnostics.

### Replace the active release in place

Rejected because partial writes and open binaries make rollback and compatibility
diagnosis unreliable.

## Consequences

- Core health, logged-in state, unlocked state, helper authentication, OS
  permissions, capture, accessibility, and input readiness are independent fields.
- The service package can render and validate native plans without claiming a live
  platform has passed its service acceptance gate.
- Helper and core versions need an explicit IPC compatibility window; an
  incompatible helper is unavailable rather than silently partially functional.
- Installers need same-volume atomic promotion, a durable operation journal, and a
  bounded set of previous healthy bundles.
- A compromised helper receives only the narrow capability and exact execution
  authority delivered over its authenticated session.

## Verification

- Plan and parser tests cover native definitions, stable paths, least-privilege
  identities, idempotent install/uninstall, upgrade health, rollback, and
  state-preserving uninstall.
- IPC contract tests cover mutual proof, nonce replay, wrong Device/session/epoch,
  version mismatch, frame tampering, sequence replay, size bounds, key rotation, and
  Secret redaction.
- On each real OS, clean-host install, process restart, reboot, login/logout, locked
  session, helper crash/restart, failed upgrade, rollback, diagnostics, and uninstall
  must pass before that OS is recorded as supported.
- The daemon remains connected and performs a non-graphical Work Order while the
  helper is absent and Computer Use is unavailable.

## References

- `docs/PRODUCT_SPEC.md`, FR-12, Worker deployment, and Implementation Decisions
- `docs/IMPLEMENTATION_PLAN.md`, Spikes B and C and Phase 4
- `docs/DECISIONS.md`, D-030 and D-039
- [`ADR-0010`](0010-reproducible-platform-bundles-and-provenance.md)
- [`ADR-0012`](0012-computer-use-native-driver-authority-and-readiness.md)
- [Microsoft: About Services](https://learn.microsoft.com/en-us/windows/win32/services/about-services)
- [Microsoft: Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)
- [Apple: Designing Daemons and Services](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html)
- [systemd overview](https://systemd.io/)
- [systemd architecture](https://systemd.io/ARCHITECTURE/)
