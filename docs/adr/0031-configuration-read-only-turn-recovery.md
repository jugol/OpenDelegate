# ADR-0031: Configuration read-only turn recovery

Status: **Accepted**

Date: **2026-07-30**

## Context

A live Configuration Chat request successfully executed `inspect`, then its Codex
native session became unavailable before it returned an owner-visible response.
Main had durably recorded the tool attempt, but the recovery policy treated every
typed tool as a possible mutation. It refused a fresh continuation and showed a
generic interrupted-agent failure even though no proposal or configuration change
had occurred.

Simply permitting every post-tool continuation would be unsafe. A single request may
inspect first and later propose or apply a change, so recording only its first tool
does not prove that the entire request remained read-only.

## Decision

Configuration tools have an explicit replay-safety boundary:

- `inspect`, `validate`, and `diff` are read-only;
- `propose`, `apply`, and `rollback` are mutation-capable.

Main durably records the first tool attempt for the request using the version 2
boundary protocol. If a later tool is mutation-capable, Main appends a
mutation-capable boundary before executing it. Tool attempt history is
request-digest-bound, ordered, and validated on restore. Legacy version 1 records
remain fail-closed because the earlier implementation did not record tools after the
first attempt, so an inspect-first record cannot prove that no later mutation ran.

When a native session becomes unavailable and only read-only tools have run, Main may
start exactly one fresh continuation. Before invoking it, Main durably reserves the
request's sole continuation; a restart or ambiguous failure after that reservation
cannot start another. The continuation uses the complete current request and a
bounded durable visible-conversation excerpt, identifies the unavailable prior
session in lineage, and instructs the Agent to re-inspect durable configuration. It
does not treat a prior read-only result as proof of a mutation.

If a mutation-capable boundary exists, automatic continuation and replay remain
forbidden, including after Main restart.

## Alternatives considered

### Fail after every typed tool

Rejected because deterministic read-only inspection is safe to repeat and should not
turn transient provider loss into a permanent conversational failure.

### Continue after every typed tool

Rejected because a proposal or configuration mutation may already have occurred and
could be duplicated or misreported.

### Trust only the first tool name

Rejected because one request may inspect first and execute a mutation-capable tool
later.

## Consequences

Configuration guidance recovers automatically from one interrupted read-only native
turn. Proposal, apply, and rollback interruptions continue to fail closed. Existing
version 2 single-event read-only histories become recoverable, while legacy version 1
and mutation-capable histories remain blocked.

## Verification

- An inspect result followed by native-session loss starts one continuation and
  completes one owner response.
- Inspect followed by propose and native-session loss does not continue.
- A continuation that fails after its durable reservation is not started again after
  Main restart.
- A legacy version 1 inspect-first boundary remains fail-closed after upgrade.
- Replaying the completed recovered request returns its stored response without a
  second tool call.
- Restart replay rejects a request whose durable history contains a
  mutation-capable boundary.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-15
- [`../DECISIONS.md`](../DECISIONS.md), D-058 and D-071
- [`0024-configuration-chat-history-and-approval-correlation.md`](0024-configuration-chat-history-and-approval-correlation.md)
