# `@opendelegate/run-capability-broker`

Local, bounded capability transport for exact OpenDelegate Worker Runs.

The broker listens only on a platform-local endpoint: a Windows named pipe or a
Unix-domain socket. `register()` binds one opaque capability to the complete Task,
Work Order, Run, Device, lease ID, fencing token, and lease expiry. It writes a
bounded descriptor outside the source checkout with owner-only permissions on
Unix. The descriptor contains an opaque random token and local endpoint, never the
backing resource's path, content, credential, or executable authority.

On Unix, descriptor files and sockets use the configured protected Worker state
directory whenever its endpoint fits the platform socket-path limit. For a longer
normal macOS or Linux Worker home, only the socket falls back to a short, per-broker
`0700` directory under the canonical system temporary root. The socket is `0600`,
its fallback directory name retains 96 bits from the broker's random endpoint ID,
a collision fails without deleting the existing path, and normal shutdown removes
only the endpoint created by that broker.

`consumeRunCapabilityFile()` verifies file ownership/mode where supported and
rejects symlinks and oversized or malformed descriptors. Registrations accept one
connection by default; that single-use descriptor is deleted before its claim.
An explicitly bridged provider-native Agent Run may instead retain the descriptor
for at most the root plus four simultaneous authenticated connections. Capacity is
reserved before asynchronous authority checks, and an excess claim fails closed.
The bearer still conveys only the same exact Run authority.

The broker checks the dynamic `currentBinding()` result and its
`isExecutionCurrent()` decision before claim and before every request. A durable
Main renewal may advance only the expiry of the same exact Run, lease, and fence;
any identity replacement or expiry regression fails closed. Disposing a lease,
replacing the Run lease/fence, cancelling the Run, or closing/restarting the broker
removes the descriptor, closes every active socket, and makes later requests fail
closed. Request frames, sequences, concurrency, and payload bytes are bounded;
cancellation is propagated as an `AbortSignal` to the registered handler.

The broker is transport, not policy. It observes a renewal already authorized by
Main; it cannot schedule or renew a Run, grant Computer Use, browse Device
Knowledge, or authorize a mutation. The registered Worker handler remains
responsible for validating its capability's domain-specific inputs and rechecking
any narrower authority immediately before a side effect.
