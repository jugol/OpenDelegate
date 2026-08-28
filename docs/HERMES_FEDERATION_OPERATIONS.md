# Hermes Device Federation operations

This guide records the operating contract for a current Hermes-only Device Agent fleet. It does not claim that Hermes is an OpenDelegate runtime Agent Adapter. OpenDelegate's durable Task, Work Order, Worker Run, lease, outbox, and result-reconciliation model remains the target architecture.

Use this together with [Hermes setup Agent onboarding](HERMES_SETUP_AGENT.md) and the owner-facing [Korean fleet guide](../README.ko.md#hermes-device-agent-운영-가이드).

## Incident pattern

A remote Worker can finish even after the Origin stops waiting:

1. The Origin sends a synchronous `hermes peer dm` request.
2. The remote API accepts the turn and continues executing it.
3. A local terminal or tool-executor deadline expires before the remote reply arrives.
4. The Origin retries with an untracked background shell process.
5. A Gateway restart kills that local waiter because it belongs to the Gateway service cgroup.
6. The remote Bot Chat stores a valid `PEER_RESULT`, but no collector remains to attach it to the originating Discord thread.

The broken component is result collection, not necessarily the Worker. A timeout at the waiting layer must not be reported as Worker failure.

`hermes peer dm` does not enforce idempotency or persist a durable request ledger. A `request_id` in a
`PEER_REQUEST` body is an operator convention used for correlation; the transport does not reject a
second message with the same ID or prove that the prior objective will not run again. The procedures
below reduce ambiguity but do not claim exactly-once Hermes peer execution.

## Timeout hierarchy

Timeouts must be ordered by responsibility rather than copied from one arbitrary number:

| Layer | Purpose | Recommended Hermes-only fleet policy |
| --- | --- | --- |
| Health probe | Determine whether dispatch may start | 5–10 seconds; no Agent turn |
| Foreground terminal / peer transport | Bound one synchronous observation | Up to 600 seconds |
| Agent tool guard | Prevent a wedged tool from blocking the turn | Greater than the transport bound; 900 seconds is a practical coordinator value |
| Gateway turn | Bound the complete reasoning and tool cycle | Greater than the tool guard; 3600 seconds for an always-on coordinator |
| Durable Worker Run | Bound actual work by Task budget, lease, progress, and policy | No arbitrary short shell timeout; use durable state and explicit cancellation |

A foreground wait timeout is an observation result: `delivery_unknown` or `completion_unknown`. It is not proof that the remote turn stopped. Increasing every timeout without preserving identity and recovery only delays the same data-loss bug.

For a current Hermes coordinator profile, this is a reasonable starting point:

```sh
hermes config set terminal.timeout 600
hermes config set terminal.lifetime_seconds 3600
hermes config set timeouts.tools.sequential_call 900
hermes config set timeouts.tools.concurrent_batch 900
hermes config set agent.gateway_timeout 3600
hermes config set agent.restart_after_turn_timeout 3600
```

Keep non-secret timeout policy in `config.yaml`, not legacy `TERMINAL_TIMEOUT` environment entries. A foreground operation that legitimately exceeds the terminal ceiling should move to a durable execution surface rather than raising the ceiling indefinitely.

## Durable completion contract

Before dispatch, the Origin should write an operator-managed local recovery record containing:

- the unique `request_id`;
- the target Device and peer profile;
- the originating Task or Discord chat/thread binding;
- the completion criteria and safety constraints;
- the current delivery state.

This record is recovery evidence for the operator; it is not a Hermes peer transport ledger and does
not authorize automatic redispatch.

The Origin may promise a later reply only when it has a durable completion handle whose owner survives the current Agent turn. An untracked background shell process is not such a handle.

For short, bounded requests, a foreground `hermes peer dm <device> < request.txt` call is acceptable when the timeout hierarchy above is aligned. For unknown or long work:

- prefer a durable OpenDelegate Worker Run when that runtime is available;
- do not use a one-shot Hermes cron as a long peer collector: its default three-minute cron interrupt
  is shorter than the 600-second peer wait;
- if OpenDelegate is unavailable, use only an explicitly installed OS-supervised collector outside the
  Gateway cgroup, with persistent request state and an exact delivery target;
- if no such collector exists, keep work within the bounded foreground path or report that durable
  long-run collection is unavailable;
- do not tell the owner that a result "will return" merely because a shell process was started.

If waiting times out or the Gateway restarts, reuse the same `request_id` only as a correlation key.
Inspect the peer's canonical Bot Chat or request history through a read-only operator path and recover
an already stored `PEER_RESULT`; do not resend the original objective. If no stored result is visible,
report `completion_unknown` and require an explicit decision before any retry. A second peer message,
even with the same ID, is not an idempotent retry and can duplicate file edits, purchases, messages, or
other side effects.

A collected result is complete only when:

- the `request_id` matches;
- `device` is the assigned Device;
- `status` is one of `completed`, `partial`, `blocked`, or `failed`;
- `summary`, `shared_outputs`, and `unresolved` are present;
- the result is delivered to the original Task/thread exactly once.

## Gateway restart fencing

Before a Gateway update, model-change restart, profile migration, or service restart:

1. List active background processes, peer requests, Routines/cron executions, and Agent turns.
2. If in-flight peer work exists, defer the restart until its completion is collected.
3. If the restart is unavoidable, persist every pending `request_id` and origin binding first, mark the wait interrupted, and notify the owner that reconciliation is required.
4. After startup, reconcile pending peer work before accepting unrelated new work or claiming the interrupted Task is complete.

A Gateway process exit can kill its local waiter without cancelling the remote Agent turn. Therefore service shutdown is not remote cancellation evidence.

## Recovery playbook

When the Worker appears finished but the Origin has no result:

1. Probe the registered peer `/health` endpoint without starting an Agent turn.
2. Search the Origin session for the dispatch `request_id` and determine whether a matching `PEER_RESULT` was persisted.
3. Inspect the remote canonical Bot Chat or session history through read-only operator tooling for the same correlation ID.
4. If the remote result exists, recover it without sending the objective again.
5. Validate the complete envelope and deliver it once to the original Task or Discord thread.
6. If the remote state is ambiguous, report `completion_unknown`; do not invent failure or success.
7. Do not automatically retry. Because `hermes peer dm` lacks transport-level idempotency, a retry requires
   an explicit owner or policy decision after assessing whether the earlier turn can still produce side effects.

## Why OpenDelegate uses durable Runs

OpenDelegate's product contract deliberately separates Task lifetime from terminal, Gateway, and provider-process lifetime. Main owns durable Task state; Workers keep a durable outbox; Run completion carries lease and fencing identities; restart reconciliation restores pending dispatch and Discord delivery. The Hermes-only procedures above are compatibility workarounds until that durable control-plane path is the active runtime.
