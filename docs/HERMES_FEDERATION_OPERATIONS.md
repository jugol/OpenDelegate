# Hermes Device Federation operations

This guide covers timeout, restart, and result-recovery behavior for a Hermes Device Agent fleet.

## Core rule

A remote Worker may continue after the Origin stops waiting. A timeout in a terminal, HTTP client, or
Agent tool guard is not proof that the Worker failed or stopped.

## Incident pattern

1. The Origin starts a synchronous peer request.
2. The remote API accepts and executes the turn.
3. A local wait deadline expires.
4. The remote Agent later stores a valid result.
5. The Origin has no collector left to return it to the owner.

A Gateway restart can make this worse by killing child processes in its service cgroup while the remote
turn continues.

## Hermes peer limitation

`hermes peer dm` is synchronous. A request ID inside the message is an operator correlation value, not
a transport-enforced idempotency key. Re-sending the same request ID can still execute the objective
again and duplicate side effects.

Do not promise exactly-once behavior from raw peer messaging.

## Timeout hierarchy

| Layer | Purpose | Typical policy |
| --- | --- | --- |
| Health probe | decide whether dispatch may start | short, usually 5–10 seconds |
| Foreground peer wait | observe one bounded remote turn | up to the supported peer limit |
| Tool guard | detect a wedged local tool | longer than the peer wait |
| Gateway turn | bound the complete reasoning cycle | longer than the tool guard |
| Durable Run | own unknown-duration work | Task budget, progress, cancellation, and durable state |

A longer timeout does not replace durable state.

## Short work

For a bounded, read-only request expected to fit inside the peer wait:

1. probe `/health`;
2. save the request envelope privately;
3. send through stdin, not shell interpolation;
4. validate the complete result;
5. relay it to the original conversation.

## Long or unknown work

Use a durable orchestrator or an explicitly installed OS-supervised collector outside the Gateway
cgroup. It must own:

- persistent request state;
- the target Device;
- the original owner conversation;
- progress and cancellation;
- result validation;
- exactly-once owner delivery.

An untracked background shell process is not durable. A one-shot Hermes cron with a shorter run limit
than the peer wait is not a valid long-work collector.

If no durable path exists, state that limitation instead of promising a later result.

## Restart fencing

Before restarting a Gateway:

1. list active peer work and background processes;
2. defer restart while peer work is in flight;
3. if restart is unavoidable, record the pending correlation IDs and owner destinations;
4. notify the owner that collection is interrupted;
5. reconcile after startup.

A local process exit is not remote cancellation evidence.

## Recovery after an ambiguous wait

When the Worker appears finished but the Origin has no result:

1. probe peer health;
2. search the Origin transcript for the request correlation ID;
3. inspect the remote canonical Bot Chat or session history through a read-only operator path;
4. if a complete result already exists, validate and deliver it once;
5. if no result is visible, report `completion_unknown`;
6. do not automatically resend the original objective;
7. require an explicit owner or policy decision before a retry that could duplicate side effects.

## Result envelope

Use [`templates/PEER_RESULT.txt`](../templates/PEER_RESULT.txt). A result is complete only when its ID,
Device, status, summary, outputs, and unresolved fields are present and match the dispatch.

## Operational checklist

- Health before Agent turn
- Stable Device identity
- Request through stdin
- No secret values in prompts or logs
- Origin retains final-answer responsibility
- Restart deferred during active work
- Timeout reported as unknown observation
- Durable path for unknown-duration work
- Exact owner destination retained
- Rollback documented
