# ADR-0041: Headless Linux Workers install an explicit core-only service

Status: **Accepted**

Date: **2026-08-08**

## Context

OpenDelegate previously required every Linux service document to contain a
graphical user-service, a Secret Service binding, and a second IPC signing key.
That is correct for a graphical Linux Device, but it makes a headless NAS claim a
session helper it cannot run. Secret Service requires a logged-in D-Bus session and
an unlocked collection; neither exists on a genuinely headless host.

The core identity is already prepared differently from Windows. The packaged
headless enrollment command runs inside a transient systemd unit under the same
non-login account as the eventual service, with the same
`LoadCredentialEncrypted=` mapping. Its Device identity, desktop authority, and
core IPC key are therefore created directly in the final service-account vault;
there is no owner-to-service private-key handoff to perform.

## Decision

A Linux service document has one of two explicit shapes:

- **graphical two-plane**: the core and owner-session helper each have a distinct
  private key in their own Secret Store, and both public pins are present; or
- **headless core-only**: `helperSecretBinding` is `null`, the helper public pin and
  Secret reference are absent, and no user unit, helper command, helper health
  check, or Computer Use readiness claim is generated.

`worker join` captures the core Ed25519 public pin and exact non-root service
identity while it can prove access to the systemd credential vault and stores them
in the versioned `servicePreparation` binding. `worker service-document` accepts that binding only
for `linux-systemd-credential-vault`, carries the existing encrypted credential
source into the systemd unit, uses the service identity captured during join, and
requires an explicit installation-owner identity. Optional service-account CLI input
is only an exact-match assertion. It never opens or copies a private key, invents a
helper key, probes a graphical session, elevates, or registers a service.

The owner identity remains in the service document for filesystem access and
ownership policy. It does not imply that an owner-session helper exists. A later
transition from headless to graphical Linux is an explicit service re-preparation:
the owner-session key must first be provisioned in Secret Service, both public pins
must be reviewed in a new create-only document, and the helper unit may then be
installed. OpenDelegate does not silently turn a core-only document into a
graphical one.

## Consequences

- A headless NAS can remain connected and execute shell, storage, container, build,
  and Agent work after logout without installing desktop packages or a phantom user
  service.
- Diagnostics can state that Computer Use is unavailable by configuration rather
  than presenting a repeatedly failing helper.
- Graphical Linux retains ADR-0011's asymmetric two-plane trust boundary; this
  decision is not permission to place the owner key in the system service vault.
- Losing the systemd credential or its encrypted vault still requires explicit
  re-enrollment, consistent with Device-local Secret ownership.
- macOS and graphical Linux service preparation remain first-milestone blockers
  until their separate owner-session migrations are implemented and proven.

## Verification

- Headless join persists the validated core public pin and non-root service identity
  alongside the existing non-secret systemd backend descriptor.
- A headless document has no helper binding, helper pin, helper Secret reference,
  helper manifest, helper supervisor command, or helper health step.
- The core unit retains `LoadCredentialEncrypted=` and starts under the configured
  non-root service identity.
- Runtime parsing rejects a disabled helper on Windows or macOS, and rejects a
  Linux document whose helper binding and IPC shape disagree.
- Graphical Windows, macOS, and Linux rendering continues to require two distinct
  Ed25519 identities.

This is deterministic contract evidence only. A clean-host systemd install,
restart, reboot, credential decryption, service-account ownership, network
reconnect, upgrade, rollback, diagnostics, and uninstall run is still required
before release promotion records headless Linux as support-eligible.

## References

- [`0011-native-two-plane-service-supervision-and-authenticated-ipc.md`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [`0017-device-local-secret-store-backends.md`](0017-device-local-secret-store-backends.md)
- [`0040-windows-worker-service-preparation-binding.md`](0040-windows-worker-service-preparation-binding.md)
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 4
- [`../DECISIONS.md`](../DECISIONS.md), D-089
