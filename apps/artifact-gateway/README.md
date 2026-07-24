# `@opendelegate/artifact-gateway`

The isolated HTTP viewer for Main-owned Artifacts.

Static and interactive HTML use distinct application instances and configured
origins. Neither instance registers Admin routes, enables CORS, nor accepts an Admin
cookie as authority.

Authenticated browser viewing uses a separately provisioned
`__Host-opendelegate_artifact_session` credential. This package validates it through
the owner-authorization port; it does not mint or exchange Admin sessions.
