# `@opendelegate/artifact-store`

Backend-neutral Artifact Store contracts and the first Main-local, content-addressed
adapter.

The local adapter accepts either bounded in-memory bytes or an asynchronous byte
stream. Stream publication stages bytes in the managed store, verifies the declared
size and SHA-256 before metadata publication, and atomically promotes a
content-addressed object.

`LocalArtifactAccessBroker` adds the Main-local transfer seam. It persists
short-lived, hash-only Worker upload grants, durable byte offsets, chunk
idempotency outcomes, one-time browser grants, and short Artifact-scoped browser
sessions. Worker uploads can resume after a process restart and exact chunk replay
does not append bytes twice. If Main committed the Artifact but the Worker lost the
completion response, a fresh grant for the same immutable publication recovers
idempotently; the timestamp of the first committed publication remains canonical.
The broker is not a general credential service and does not accept Device-local
Knowledge or Secret values.

Runtime data must be configured outside the source checkout. Stored indexes never
contain raw signed-link, upload, browser-grant, or browser-session credentials, nor
the instance signing key.

Production Main injects an `ArtifactIndexRepository`. That compare-and-set record
holds Artifact metadata, hash-only signed-link records, Artifact audit history, and
one monotonic generation in Main's configured SQLite or PostgreSQL database. The
content-addressed bytes remain under Main's local `objects/` directory. A legacy
`index.json` is imported through compare-and-set only while the database snapshot is
the pristine generation-zero seed; afterward the database is authoritative. A
missing or corrupt SQL singleton fails startup instead of resetting metadata.
Omitting the repository retains the safe local-file index only for standalone use
and backward-compatible focused tests.

S3 compatibility and archive expansion remain separate adapters behind the storage
seam.

Expiration and revocation make bytes unreachable but do not physically reclaim
content-addressed objects in this slice. A later retention worker must add bounded,
audited garbage collection without weakening pin semantics.
