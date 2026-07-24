# ADR-0004: Task journal and scheduling contract authority

Status: **Accepted**

Date: **2026-07-24**

## Context

OpenDelegate receives owner intent through external channels but must preserve that
intent independently of any channel or provider. The approved specification states
that a Forum post maps one-to-one to a durable Task, while Discord and provider
identifiers remain external bindings rather than aggregate identities. It also
requires replay to fail closed when durable state is internally inconsistent.

The Phase 1 orchestration seam needs one authority for:

- the event stream that owns a Task lifecycle;
- integrity fingerprints written with Work Orders and Artifacts;
- provider-neutral Work Order and Worker Report validation; and
- the boundary between deterministic Device eligibility and semantic selection.

Leaving these choices implicit would allow a channel identifier to leak into storage
identity, let callers persist unverifiable fingerprints, or let separate
orchestrators disagree about which Devices an Agent may consider.

## Decision

1. The immutable internal `TaskId` owns the Task aggregate and its journal stream.
   A Forum post identifier is a unique external binding that resolves to that Task;
   it is not the stream identifier. Every intake, plan, Run, result, synthesis,
   review, and completion event for a Task stays in the same Task stream.
2. The journal owns integrity fingerprints for durable orchestration data. It
   calculates the Work Order plan fingerprint from the normalized planned Work Order
   and the Artifact content fingerprint from the normalized Artifact. Callers cannot
   provide either value. Replay recalculates each fingerprint from the durable
   payload and fails closed on a mismatch.
3. Protocol owns the runtime-validated, provider-neutral v1 contracts for complete
   Work Orders, Worker Reports, Artifacts, semantic planning requests, and bounded
   semantic Device-selection requests and responses. Every semantic-selection
   response must echo the exact protocol version, `TaskId`, and `WorkOrderId` from
   its request before its preferred Device can be considered.
4. Scheduler owns mechanical candidate normalization, hard eligibility filters,
   preference and fallback behavior, deterministic scoring, and the selected
   Device/route. Coordinator reasoning is allowed only when Scheduler returns two or
   more mechanically indistinguishable eligible candidates, and it receives only
   that bounded candidate set.
5. A durable lookup projection may optimize external-binding-to-Task resolution,
   but it must be rebuildable from Task binding events and must preserve the same
   one-to-one conflict checks.
6. In the current in-memory seam, semantic tie selection is side-effect-free and is
   followed immediately by durable Run assignment. A process failure between those
   operations may repeat the selection call after restart, but cannot duplicate
   external Worker execution. If selection cost, auditability, or cross-process
   consistency makes that retry window material, the persistent Control Plane must
   add a journaled selection-decision event before dispatch.

## Alternatives considered

### Use the Forum post identifier as the Task stream identifier

Rejected because it couples durable identity to one channel, conflicts with the
specified external-binding model, and makes channel deletion or future adapters
affect aggregate identity.

### Accept caller-supplied fingerprints

Rejected because callers could accidentally or maliciously persist a fingerprint
that does not describe the stored payload. Integrity metadata is meaningful only
when the persistence authority derives and verifies it.

### Keep contract enrichment and scheduling adapters in the acceptance harness

Rejected because tests would own product behavior that production entrypoints could
bypass or reimplement differently.

### Ask the Coordinator to choose from every discovered Device

Rejected because health, capability, policy, route, resource, and preference checks
are deterministic mechanics. Sending ineligible Devices to an LLM spends context
and weakens policy enforcement.

### Journal semantic tie selection before the Run assignment in Phase 1

Deferred because the current coordinator call has no external side effects and the
Control Plane is still an in-memory seam. The persistent Control Plane must revisit
this before the retry window can cause material cost or inconsistent audit history.

## Consequences

- Channel adapters can be replaced without changing Task history identity.
- A complete Task lifecycle can be replayed from one ordered stream.
- Work Order and Artifact tampering is detected from durable content rather than
  trusted caller metadata.
- Protocol and Scheduler expose reusable seams for the future Main service,
  Discord adapter, SQL journal, and acceptance harness.
- Coordinator context contains only semantically relevant, already eligible
  candidates.
- Binding lookup needs a projection or index as storage grows.
- Semantic tie selection can be repeated only in the explicitly documented
  pre-assignment failure window until a durable selection event is introduced.

## Verification

- Journal contract tests reject Task bindings written to a Forum-named or mismatched
  stream and reject more than one Forum binding per Task or Task per Forum post.
- Replay tests reject changed Work Order content, Work Order fingerprints, Artifact
  content, and Artifact fingerprints.
- Protocol tests reject incomplete or malformed Work Orders, Worker Reports,
  Artifacts, and semantic-selection payloads.
- Orchestrator boundary tests reject semantic Device selections with a mismatched
  protocol version, `TaskId`, `WorkOrderId`, or preferred Device outside the
  mechanically eligible set.
- Scheduler tests prove hard eligibility, preferred-Device fallback, stable scoring,
  bounded tie exposure without an LLM call, and fail-closed validation of complete
  Device snapshots and scheduling requests.
- Orchestrator and acceptance tests prove deterministic selection when one winner
  exists and Coordinator selection only among the tied eligible candidates.

## References

- `CONTEXT.md`
- `docs/PRODUCT_SPEC.md`, especially FR-5 and the persistence model
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/DECISIONS.md`, especially D-007
- [`ADR-0003`](0003-phase-zero-module-map.md)
