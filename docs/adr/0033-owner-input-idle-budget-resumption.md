# ADR-0033: Owner input resumes an idle Task

Status: **Accepted**

Date: **2026-08-07**

## Context

A requested Task may wait for owner clarification longer than its idle Budget. The
owner's Discord reply is persisted as Task input, but execution previously checked
the earlier activity timestamp first. The Task therefore returned another hard-idle
Budget message without giving the Agent the reply. Repeating the message could not
recover the conversation.

Waiting for the owner is intentionally inactive work. Cumulative automatic execution
and finite resource consumption still need hard bounds, but an owner response is
itself new activity and must not be rejected as proof that no activity occurred.

## Decision

The Task execution coordinator records a durable Budget activity mutation immediately
after durable owner input and before queuing the resumed execution. Its operation ID
is derived from the Task ID, principal ID, and input idempotency key, matching the
conversation event's identity. The activity mutation is allowed to observe and reset
an expired idle interval.

Only idle time resets. Wall time, retry count, native turns, child Work Orders,
concurrency, tokens, cost, and child Budgets keep their existing limits. The next
execution begins through the ordinary Budget guard and fails closed if any of those
limits is exhausted.

## Consequences

An owner can answer a clarification later and continue the same durable Task and
native session. Retried Discord delivery is idempotent and cannot create a second
activity mutation. If persistence fails between the Task event and Budget event, the
same ingress retry repairs the missing activity before execution is queued.

## Verification

- A Task enters `waiting_user`, advances beyond its hard idle interval, accepts an
  owner reply, and completes its next execution without a Budget extension.
- The resulting Budget snapshot has the owner input as its latest activity.
- Wall-time and finite usage exhaustion remain blocked by their existing tests.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-23
- [`../DECISIONS.md`](../DECISIONS.md), D-078
- [`0027-discord-single-turn-lifecycle-and-retry-stable-planning.md`](0027-discord-single-turn-lifecycle-and-retry-stable-planning.md)
- [`0038-active-execution-wall-budget.md`](0038-active-execution-wall-budget.md)
