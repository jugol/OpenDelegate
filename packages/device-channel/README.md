# Device Channel

`@opendelegate/device-channel` owns OpenDelegate's authenticated Main–Worker
transport boundary.

It provides:

- strict, bounded v1 protocol frames with authenticated sender coupling;
- single-use Enrollment Grant file handling and pinned TLS 1.3 enrollment;
- a TLS 1.3 mutual-authentication WebSocket server and outbound Worker client;
- certificate status and generation revalidation through the Device Identity
  authority;
- durable inbox, outbox, sequence, acknowledgement, replay, application-effect, and
  connection state;
- Main-authoritative, idempotent Run lease renewal;
- exact-scope Run steering commands with durable Worker receipts; and
- explicit heartbeat, dispatch, control, backpressure, reconnect, and revocation
  behavior.

The channel is hub-and-spoke. Workers connect to Main; this package never creates
Worker-to-Worker trust, distributes database credentials, or exposes a generic
remote shell.

## Persistence

The package's standalone repository is SQLite and requires an absolute path outside
the source checkout. Production Main instead injects
`@opendelegate/storage-sql`'s equivalent SQLite or PostgreSQL Device-channel
repository, so channel state follows the owner-selected Main database without
exposing that database to Workers. Acknowledged outbound frames are pruned
transactionally. Inbound identities remain durable so exact replay is idempotent
and changed reuse fails closed.

Inbound delivery has a separate durable application-effect journal. Receiving a
frame records `received`; one connection may claim it as `processing`; a successful
handler records `handled` before the peer's acknowledged prefix advances. A thrown
handler releases the claim for reconnect retry, while a replay of `handled` work is
acknowledged without invoking the callback again. Interrupted `processing` claims
return to `received` when the exclusive channel service restarts. Handlers that
commit effects in another store must still use the frame idempotency key in that
store, because the channel transaction cannot atomically commit an unrelated
external side effect.

Each connection handshake captures bounded Main receive/send times. Worker rejects
excessive round-trip time or clock uncertainty, converts Main lease expiries to a
conservative monotonic deadline, and recalibrates before applying dispatch or
renewal responses after reconnect. Main durably decides an exact
`worker.run.renew` command and sends the resulting `main.run.lease` response before
acknowledging that command. Exact replay returns the original decision; stale,
mismatched, late, or terminal renewals cannot resurrect a Run.

`main.run.steer` is a dedicated command rather than a generic control payload. It
binds the Task, Work Order, Device, Worker, route, Run, lease, fence, and the safe
Main-visible native-session observation. Device-local session keys and paths have
no protocol fields. Worker persists the command effect before invoking the Run,
then emits a durable `worker.run.steering` receipt that records live acceptance,
next-resume queueing, rejection, or an unknowable provider outcome. The receipt is
itself handled through the Main inbound-effect journal, so an audit callback may
fail and retry without accepting a changed result.

Production Main composition must provide a dedicated Device endpoint with a server
certificate issued by the OpenDelegate instance CA. Enrollment remains a separate
HTTPS endpoint because it intentionally has no Worker client certificate yet.

## Security boundary

The Worker private key is supplied only through a callback-scoped secret lease and
is cleared after the TLS context is created. Main validates the peer certificate,
URI Device ID, serial status, generation, and envelope sender before accepting
frames, and repeats application-level validation during a live connection.

Large Artifact bytes, database access, arbitrary paths, and provider-private Agent
events do not belong on this control channel.
