# Control Plane HTTP composition

`@opendelegate/control-plane` is the Phase 2 Fastify composition boundary selected
by ADR-0007. It exposes injectable application factories; it does not bind a
production socket or install a service.

`createMainControlPlaneApp` contains:

- detail-free `GET /health/live`;
- owner-authenticated readiness, runtime-feature, and Device projections. Runtime features keep
  enclosed `declaredReleaseChannel`, effective `releaseChannel`, and sanitized
  `releaseVerification` separate; the response schema rejects impossible combinations;
- owner login, session, reauthentication, session listing, revocation, and logout;
- independent recovery-code begin and complete operations;
- Discord-independent Task creation, inspection, pause, resume, cancel, and retry;
- Device-scoped Configuration Agent messages and bounded secure Secret ingest;
- Approval inspection and decisions;
- Device enrollment overview and single-use grant issuance;
- Artifact metadata and open instructions; and
- bounded, redacted Audit and diagnostic projections.

Every operational surface is an injected port. Production Main composes those ports
with its SQLite or PostgreSQL repositories, Agent and Device-channel runtimes,
Artifact isolation boundary, and OS-managed Secret Store. This package owns HTTP
validation and browser security, not domain persistence or native service
supervision.

`createLocalClaimApp` is a separate temporary loopback application. It registers
only `POST /api/v1/auth/claim`; the normal Main application never registers or
forwards that route. The caller remains responsible for binding this application to
a loopback socket and closing it only after the successful claim response has been
delivered.

Both factories keep proxy trust disabled, require canonical configured hosts and
origins, reject cross-site or non-JSON mutations, apply Helmet and ingress rate
limits, use a 256 KiB JSON body ceiling, and return sanitized RFC 9457 problems.
Every `/api/v1` response is marked `Cache-Control: no-store`, including claim,
session, recovery, and error responses.
Browser bearer tokens are sent only through
`__Host-opendelegate_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`,
and no `Domain`.

The composition consumes `OwnerAuth` and every operational capability through
backend-neutral contracts. `apps/main` owns production TLS listener binding and SQL
composition; `@opendelegate/platform-services` owns native service planning and
supervision. Neither concern is inferred inside the HTTP adapter.
