# ADR-0065: Main installation includes Artifact delivery by default

- Status: Accepted
- Date: 2026-08-11

## Context

The product contract makes Artifact output first-class and places the Artifact
Gateway on the fixed Main Device. A live co-located Linux Worker nevertheless
completed its native Agent turn, wrote two Run-scoped files, and committed the
manifest four times without delivering either file. Main had been initialized
without an `artifacts` section, so it never composed the Gateway or the Device
channel's Artifact-prepare service. The Worker then reduced the resulting
Artifact-stage failure to `WORKER_BOUNDARY_ERROR`, hiding both the failing stage
and whether retry was safe.

This was not merely a host-specific omission. The normal CLI made Artifact setup
optional even though the owner-facing product promise includes file and hosted
result delivery.

## Decision

1. A new `opendelegate init` enables a private, authenticated, loopback-only
   Artifact Gateway by default. It derives the Artifact Secret Store descriptor
   from the same Device-local Main Secret backend without copying Secret material.
2. An owner may explicitly opt out with `--artifacts disabled` or provide a complete
   custom configuration with `--artifact-config ABSOLUTE_PATH`. A non-loopback
   Artifact origin remains explicit and requires HTTPS plus the existing
   reverse-proxy verification boundary.
3. Re-running `init` without an Artifact option preserves an existing Main exactly.
   An explicit Artifact option may atomically add, replace, or remove only the
   top-level Artifact configuration; unrelated bootstrap drift still fails closed.
4. `windows-service-dpapi` is a valid Artifact Secret backend so a Main promoted to
   the SCM service identity does not lose the Gateway's signing and access Secrets.
5. Worker diagnostics preserve only the allowlisted `artifact` stage and
   `ARTIFACT_EGRESS_DENIED` or `ARTIFACT_PROMOTION_FAILED` codes. A safe own
   `retryable` value from Main's delivery refusal is retained without invoking
   getters; unknown transport failures remain retryable and policy or validation
   refusals remain terminal.

## Consequences

New ordinary installations can return local Worker files without a hidden optional
step, while old installations are not silently mutated during restart. An existing
Main must receive an explicit Artifact option once before the Gateway is added.

The default listener pair is intentionally loopback-only. It supports the Main's
co-located Worker and local owner access, but it does not claim that a remote Worker
can upload across Tailscale, Omada, LAN, or the public Internet. That requires an
owner-selected private HTTPS route or verified reverse proxy and remains a separate
network mutation. Discord now receives an actionable, localized delivery-stage
failure instead of an opaque Worker boundary error when that route is absent.
