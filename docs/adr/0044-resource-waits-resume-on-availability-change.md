# ADR-0044: Resource waits resume on availability changes

Status: **Accepted**

Date: **2026-08-09**

## Context

Main previously treated `waiting_resource` like a transient execution failure. It
retried after a short fixed delay, counted each probe as another automatic attempt,
and failed the Task after the third probe. A Worker that was offline for only a few
seconds could therefore exhaust the retry Budget before its next authenticated
heartbeat. When the Worker later returned, the terminal Task no longer resumed.

Polling more slowly would only change the race window while continuing to spend
Agent, database, Discord, and Budget capacity on unchanged state. Resource absence
is not evidence that execution failed.

## Decision

`waiting_resource` is a durable dormant state. Main does not schedule a fixed-delay
retry and does not increment the automatic execution-failure attempt or retry
Budget while a Task remains there. A retryable executor failure remains distinct:
it records `queued`, uses the bounded retry timer, and consumes one failure attempt.

Main re-evaluates dormant resource waits after startup reconciliation or a material
availability signal. First-milestone signals include:

- an authenticated Worker heartbeat whose scheduling projection changed, excluding
  observation and lease timestamps that do not change eligibility;
- successful Main Secret ingest; and
- a successfully committed Configuration change, including an approved apply.

The coordinator deduplicates queued and active Task IDs. It also advances an
in-memory resource revision so a signal racing the first durable wait cannot be
lost. Repeated unchanged heartbeats do not create probes.

Execution failure attempt IDs remain compatible with existing durable plans.
Re-evaluation after resource wait retains the same failure attempt and first plan
key, while adding a resource-dispatch suffix to the execution key. This gives each
new dispatch unique fencing and idempotency without asking Main Agent to reinterpret
the owner's turn.

Before a dormant wait resumes, Main records retry-stable Task Budget activity from
the durable wait event. The authoritative Worker executor records corresponding
Work Order activity before dispatch. These mutations restart only idle windows;
they do not reduce wall time, turns, tokens, cost, or any other usage.

Terminal Tasks created by an older release are not silently reopened. The owner may
Retry one of those Tasks once; subsequent resource waits use this decision.

## Consequences

- A Device may remain offline for hours or days without converting resource absence
  into an execution failure or exhausting retries.
- Worker return, adapter/catalog change, Secret availability, and Configuration
  apply can resume affected Tasks without another owner message.
- Genuine transient executor failures remain bounded and cannot spin indefinitely.
- Availability signals are hints, not authority: deterministic eligibility, Policy,
  locks, Budgets, and Worker fencing are checked again before work starts.
- A new resource type must emit a material availability signal before it can promise
  automatic wake-up from `waiting_resource`.

## Verification

- A resource wait remains `waiting_resource` after the old maximum-attempt count.
- A material availability signal resumes it with attempt `1`, a distinct resource
  execution key, and zero retry usage.
- A signal racing the first wait causes one deduplicated re-evaluation.
- Timestamp-only heartbeats do not signal, while accepting-work changes do.
- Generic retryable failures still stop at the configured failure-attempt limit.

## References

- [`0027-discord-single-turn-lifecycle-and-retry-stable-planning.md`](0027-discord-single-turn-lifecycle-and-retry-stable-planning.md)
- [`0033-owner-input-idle-budget-resumption.md`](0033-owner-input-idle-budget-resumption.md)
- [`0038-active-execution-wall-budget.md`](0038-active-execution-wall-budget.md)
- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-6 and FR-23
- [`../DECISIONS.md`](../DECISIONS.md), D-092
