# Worker Runtime

`@opendelegate/worker-runtime` is the deterministic, provider-neutral core of an
OpenDelegate Worker daemon.

It owns:

- strict local Worker configuration with Secret references, never Main database
  credentials;
- an outbound-only connection to Main through an ordered Transport Profile;
- a crash-safe SQLite state repository using WAL, full synchronous durability, a
  checksummed document, and generation compare-and-swap;
- idempotent dispatch intake and one local process start for one Run assignment;
- lease and fencing validation, cooperative cancellation, and bounded forced
  termination;
- a sequenced durable outbox whose events remain until Main acknowledges an ordered
  prefix;
- explicit backpressure that reserves one terminal-event slot for every active Run;
- independent daemon, user-session, desktop, and permission readiness in heartbeats;
  and
- active, draining, disabled, revoked, online, and offline behavior.

The package deliberately does not launch Codex, Claude, or another real provider.
Those integrations implement `RunProcessFactory` in the Agent Adapter phase. It also
does not contain enrollment key material, OS service registration, a desktop helper,
Knowledge, or Secret values.

## Runtime state location

The default repository accepts only an absolute database filename. Production
composition must also pass `sourceCheckoutDirectory`; the repository refuses a
filename within that checkout. Init and join flows should choose the platform
application-data directory before constructing the repository.

## Delivery contract

Each outbound event has a stable message ID and sequence. A Main connection may
acknowledge only a unique ordered prefix of the batch it received. If delivery fails
after Main has persisted a batch but before the acknowledgement reaches Worker, the
same events replay with the same IDs and Main's inbox makes that replay idempotent.

Worker dispatch replay is independently idempotent: the durable inbox records the
dispatch message ID, idempotency key, and assignment fingerprint before the child
Run starts. Conflicting reuse fails closed, and an exact replay never starts another
child process.
