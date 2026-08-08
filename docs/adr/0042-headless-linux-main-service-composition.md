# ADR-0042: Headless Linux Main derives its service document from the co-located Worker

Status: **Accepted**

Date: **2026-08-09**

## Context

A fixed Main computer is also an ordinary Worker Device. The native core service
already starts the Main control plane and that co-located Worker as one readiness
boundary. ADR-0041 now gives an explicitly headless Linux Worker a durable,
core-only service document, but Main has no deterministic command that turns those
same Device-local facts into install input. Asking an Agent to hand-author a second
document would duplicate the service identity, bundle seal, paths, encrypted
credential mapping, and IPC pin and allow the two local roles to drift.

Main and its local Worker run under the same non-login service identity and receive
the same named systemd runtime credential. Their managed Secret records may share
one encrypted vault because record identity and associated data remain scoped by
Device and alias; no plaintext key or Secret value is copied into either
configuration.

## Decision

The packaged Main CLI exposes a create-new `service document` command for an
explicitly headless Linux Main. It consumes:

- the already generated, strictly validated core-only Worker service document;
- the initialized Main home; and
- a new output path.

Composition succeeds only when the Worker document is Linux, role `worker`, has no
helper binding or helper authority, carries an encrypted systemd credential, and
matches Main's durable Instance ID, Device ID, state root, and systemd credential
name. Main's Secret backend may also record the non-secret encrypted credential
source; when present it must match the Worker document exactly.

The resulting document changes only the role to `main` and resolves the durable
`admin.open-on-login` preference through the existing Configuration boundary. A
headless document rejects an enabled auto-open preference because there is no owner
login helper that could honor it. The command writes with create-new semantics,
never elevates, installs, overwrites reviewed input, reads a Secret value, or
hand-authors a second native topology.

The headless provisioning descriptor produced for Worker may also be supplied to
Main init. Main accepts its optional `encryptedCredentialFile` public field while
continuing to load only the named runtime credential from
`CREDENTIALS_DIRECTORY`.

## Consequences

- A NAS can run the fixed Main and its local Worker persistently under one systemd
  core service without installing a phantom graphical helper.
- Worker and Main cannot silently select different bundles, service accounts,
  state roots, public pins, or systemd credential sources.
- The owner or setup Agent still reviews one final Main document and one lifecycle
  plan before an elevated install.
- Losing the systemd credential or local Worker preparation still requires
  explicit re-enrollment; Main does not reconstruct those facts.
- macOS, graphical Linux, and all unproven clean-host lifecycle evidence remain
  first-milestone blockers.

## Verification

- Composition accepts a matching core-only Worker document and changes only the
  runtime role plus the effective Main login preference.
- A Device, Instance, state-root, credential-name, encrypted-source, helper, or
  platform mismatch fails before output is created.
- Existing output is never replaced.
- Service rendering contains one systemd core unit, starts both Main and the local
  Worker, and makes no Computer Use readiness claim.

## References

- [`0011-native-two-plane-service-supervision-and-authenticated-ipc.md`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [`0017-device-local-secret-store-backends.md`](0017-device-local-secret-store-backends.md)
- [`0041-headless-linux-worker-service-preparation.md`](0041-headless-linux-worker-service-preparation.md)
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 4
- [`../DECISIONS.md`](../DECISIONS.md), D-090
