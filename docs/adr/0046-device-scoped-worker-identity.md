# ADR-0046: Device-scoped Worker identity

Status: **Accepted — 2026-08-09**

## Context

Every Device owns its Worker runtime, and generated service configurations normally
name that local runtime `worker-primary`. Run assignments and authenticated protocol
records already carry both `deviceId` and `workerId`. Treating `workerId` as globally
unique made a normal NAS plus Windows fleet fail scheduler validation even though
both Devices were online and eligible. The higher layer then mislabeled that invalid
input as `WORKER_OFFLINE`.

## Decision

`workerId` is unique only within its Device. The canonical Worker reference is the
pair `(deviceId, workerId)`. Scheduling rejects duplicate Device candidates but
allows different Devices to advertise the same local Worker ID. Scheduler input
errors remain distinct from ordinary no-eligible-Device results.

## Consequences

- Generated Workers on different Devices may all use `worker-primary`.
- Run assignments, leases, authorization, and audit continue to persist both IDs.
- Actual offline or ineligible fleets retain resource-wait behavior.
- Malformed candidate state fails explicitly instead of prompting endless offline
  retries.
