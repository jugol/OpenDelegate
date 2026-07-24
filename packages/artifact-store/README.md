# `@opendelegate/artifact-store`

Backend-neutral Artifact Store contracts and the first Main-local, content-addressed
adapter.

The local adapter publishes complete in-memory byte payloads atomically. It does not
claim resumable upload, S3 compatibility, archive expansion, or distributed cleanup;
those remain separate adapters behind the same storage boundary.

Runtime data must be configured outside the source checkout. The stored index never
contains raw signed-link bearers or the instance signing key.

Expiration and revocation make bytes unreachable but do not physically reclaim
content-addressed objects in this slice. A later retention worker must add bounded,
audited garbage collection without weakening pin semantics.
