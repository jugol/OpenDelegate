# `@opendelegate/run-capability-broker`

Local, one-time capability transport for exact OpenDelegate Worker Runs.

The broker listens only on a platform-local endpoint: a Windows named pipe or a
Unix-domain socket. `register()` binds one opaque capability to the complete Task,
Work Order, Run, Device, lease ID, fencing token, and lease expiry. It writes a
single-use descriptor outside the source checkout with owner-only permissions on
Unix. The descriptor contains an opaque random token and local endpoint, never the
backing resource's path, content, credential, or executable authority.

`consumeRunCapabilityFile()` verifies file ownership/mode where supported, rejects
symlinks and oversized or malformed descriptors, deletes the file, authenticates
once, and returns one multiplexed local request connection. A second claim fails.

The broker checks the dynamic `currentBinding()` result and its
`isExecutionCurrent()` decision before claim and before every request. A durable
Main renewal may advance only the expiry of the same exact Run, lease, and fence;
any identity replacement or expiry regression fails closed. Disposing a lease,
replacing the Run lease/fence, cancelling the Run, or closing/restarting the broker
removes any unconsumed file, closes active sockets, and makes later requests fail
closed. Request frames, sequences, concurrency, and payload bytes are bounded;
cancellation is propagated as an `AbortSignal` to the registered handler.

The broker is transport, not policy. It observes a renewal already authorized by
Main; it cannot schedule or renew a Run, grant Computer Use, browse Device
Knowledge, or authorize a mutation. The registered Worker handler remains
responsible for validating its capability's domain-specific inputs and rechecking
any narrower authority immediately before a side effect.
