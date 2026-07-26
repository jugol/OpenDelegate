# `@opendelegate/artifact-gateway`

The isolated HTTP viewer for Main-owned Artifacts.

Static and interactive HTML use distinct application instances and configured
origins. Neither instance registers Admin routes, enables CORS, nor accepts an Admin
cookie as authority.

Authenticated browser viewing can exchange a one-time, Artifact-scoped grant by
cross-origin top-level `POST`. The response places a short-lived
`__Host-opendelegate_artifact_session` credential in a Secure, HttpOnly,
SameSite=Strict cookie and redirects to the exact Artifact. No long-lived
credential is placed in a URL.

The static plane also exposes the dedicated resumable Worker upload route. Upload
credentials travel only in the Authorization header; every chunk carries a durable
offset and idempotency key and is bounded by configuration.

For an external HTTPS origin, Main must configure an explicit reverse-proxy trust
CIDR. The gateway accepts forwarded client and scheme information only from that
source. Main separately performs a live external HTTPS health verification before
declaring the route ready; this package does not pretend that binding a loopback
HTTP listener terminates TLS.
