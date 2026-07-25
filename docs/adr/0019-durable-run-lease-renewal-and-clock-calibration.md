# ADR 0019 — Durable Run lease renewal and calibrated Worker deadlines

Status: Accepted

Date: 2026-07-25

## Context

Worker Runs can legitimately outlive the initial lease while provider-native
sessions, package installation, Artifact production, and Computer Use remain
active. A fixed expiry would interrupt that work. Extending authority from a
heartbeat, Worker-local wall clock, reconnect, or capability access would instead
let stale execution survive Main retirement and would make exact replay
unverifiable.

The Main and Worker clocks can differ, wall clocks can be corrected while a Run is
active, and a renewal response can be delayed or replayed after reconnect. A safe
design therefore needs one durable authority decision and a conservative
Worker-local deadline that does not assume synchronized clocks.

## Decision

1. Main owns Run time and the only renewal decision. A renewal request includes the
   complete immutable Run scope, its current fencing token, a unique renewal ID,
   and the exact prior lease expiry.
2. Main appends a `task.worker-run-lease-renewal-decided` event before responding.
   Its projection applies a successful expiry during replay. Exact command replay
   returns the recorded decision; conflicting reuse and stale, late, mismatched,
   expired, or terminal requests are rejected without recreating Run authority.
3. One successful renewal sets expiry to Main decision time plus the configured
   lease duration. Renewal never changes the duration or derives a new expiry from
   an untrusted Worker timestamp.
4. `worker.hello` carries Worker wall send time. `main.welcome` echoes it and adds
   Main receive/send times plus the accepted maximum handshake RTT and absolute
   clock-skew thresholds. Defaults are 5,000 ms and 60,000 ms respectively.
5. Worker records wall and monotonic send/receive times, calculates RTT, an offset
   interval, and uncertainty, and maps Main expiries to a conservative monotonic
   deadline. A renewal response deadline subtracts the full measured request RTT.
   RTT or uncertainty outside the accepted bounds fails the connection closed.
6. Renewal lead is `max(30,000 ms, leaseDuration × 0.2)`. Exact durable request
   retries use bounded exponential backoff with jitter, never run beyond the
   current conservative deadline, and never mint a replacement renewal identity.
7. Worker continuously compares wall elapsed time with monotonic elapsed time.
   Regression or a jump beyond the accepted clock-skew threshold retires local
   authority fail-closed.
8. Disconnect preserves the already-issued lease only until its conservative
   monotonic deadline and cannot renew it. Reconnect performs a fresh calibration.
   Dispatch and durable `main.run.lease` frames received before the matching fresh
   welcome are deferred, sequence-ordered, and applied only after calibration.
9. Artifact, Knowledge, platform mutation, Computer Use, and action-authorization
   boundaries read a dynamic lease authority. Task/Work Order/Device/Worker/route/
   Run/lease/fence identity remains immutable, expiry may only advance, and a
   claimed capability cannot outlive the authority's conservative deadline.
10. Computer Use's capacity-one desktop lease follows the same renewed Run expiry
    through its own exact persisted renewal. Verification is serialized so
    concurrent native operations cannot falsely stale one another while that local
    lease advances.
11. Main persists and sends `main.run.lease` before the later `main.ack`. Worker
    processes those ordered frames serially, so it applies the response before the
    acknowledgment may remove the matching outbound renewal command. A disconnect
    before Worker acknowledgment leaves the durable Main response replayable.
    Worker process restart is a different boundary: every interrupted active Run,
    including a renewed one, is durably failed as `WORKER_RESTARTED`; Main may retry
    only with a distinct Run and higher fence. Renewed in-memory authority is never
    reconstructed to resurrect that interrupted process.

## Consequences

- Runs longer than five minutes can cross multiple renewal windows and survive a
  Main restart without changing native provider session or capability identity.
  A Worker process restart deliberately retires the interrupted Run instead.
- Late or replayed traffic cannot revive an expired, superseded, or fenced Run.
- A network outage can finish work only while the existing conservative lease is
  still valid; it cannot silently extend authority.
- Clock correction, excessive latency, and unverifiable reconnect ordering trade
  availability for deterministic fail-closed behavior.
- Protocol and persistence compatibility now includes calibration fields,
  `worker.run.renew`, `main.run.lease`, and the durable renewal-decision event.
