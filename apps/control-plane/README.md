# Control Plane HTTP composition

`@opendelegate/control-plane` is the Phase 2 Fastify composition boundary selected
by ADR-0007. It exposes injectable application factories; it does not bind a
production socket or install a service.

`createMainControlPlaneApp` contains:

- detail-free `GET /health/live`;
- owner-authenticated `GET /api/v1/readiness`;
- owner login, session, reauthentication, session listing, revocation, and logout;
  and
- independent recovery-code begin and complete operations.

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

The composition currently consumes `OwnerAuth` through its backend-neutral
contract. SQL persistence and production listener/service supervision remain
separate Phase 2 and Phase 4 composition work.
