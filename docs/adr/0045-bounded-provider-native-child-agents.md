# ADR-0045: Bound provider-native child Agents inside one Worker Run

Status: **Accepted**

Date: **2026-08-09**

## Context

Main already decomposes a Task into durable Work Orders and schedules those Work
Orders across authenticated Devices. Modern Codex and Claude runtimes can also spawn
provider-native child Agents inside one native session. That local facility is useful
for independent research, review, or implementation on one Device, but it does not
have Main's Device directory, transport authority, Work Order journal, or scheduler
leases.

OpenDelegate previously disabled Codex multi-Agent support explicitly. Claude's SDK
could expose `Task` or `Agent`, but delegated calls were classified like arbitrary
sandbox escalation and could enter an unnecessary approval loop. Neither adapter
reported child lifecycle through the normalized event stream. Enabling provider
defaults without an OpenDelegate boundary could create an unbounded number of native
threads and make failures invisible.

## Decision

A Worker may expose provider-native child Agents only through a ready first-class
adapter with an exact approval bridge:

- Codex App Server enables the stable `multi_agent` feature only for an
  allow-listed Worker request containing `Agent` or `Task`. Its per-session config
  permits the root plus four child threads and a maximum depth of one.
- Claude Agent SDK permits allow-listed `Agent` or `Task` delegation without a
  separate owner approval because delegation adds no authority. The adapter allows
  at most four distinct child tool-use identities per Run.
- Main reasoning-only sessions, CLI fallbacks, and generic adapters do not enable or
  advertise this facility.

Every child remains inside the parent Run's Task, Work Order, Device, Workspace,
sandbox, model binding, and provider session. It receives no route to another
Device. Its consequential tool calls continue through the parent SDK/App Server
sandbox and exact-action Policy bridge. Main alone creates cross-Device Work Orders.

The Worker prompt states those boundaries and makes the parent responsible for
collecting child results and satisfying completion criteria. The Device inventory
advertises `native-subagents` only when a supported bridged adapter is ready.
Adapters normalize child tool lifecycle and aggregate state but never emit child
prompts, native thread IDs, Agent paths, or hidden reasoning. If Codex observably
creates more than four distinct child threads, the adapter fails the Run closed.
Per-thread provider usage is summed so local parallelism cannot under-report Run or
Task Budget consumption.

## Consequences

- One Device can use bounded local parallelism without involving the owner in the
  mechanics.
- Local child Agents cannot bypass Device selection, Work Order leases, Policy, or
  Workspace isolation.
- A provider may use fewer children or none; delegation is an optimization, not a
  completion requirement.
- A Work Order that needs another OS or Device reports that dependency to Main for
  durable decomposition.
- Provider upgrade validation must retain the config keys, lifecycle item shapes,
  action callback inheritance, and bounds before promotion.

## Verification

- A reasoning-only Main request still starts Codex with `multi_agent` disabled.
- A bridged Worker request enables Codex with root-plus-four concurrency and depth
  one, redacts native child identifiers, and fails on a fifth observed child.
- Claude allows four distinct child delegations, denies the fifth, and does not call
  external authorization for delegation itself.
- Child task notifications become bounded generic progress without provider task IDs
  or descriptions.
- Worker inventory reports `native-subagents` only from a ready bridged SDK/App
  Server adapter.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-9
- [`../DECISIONS.md`](../DECISIONS.md), D-093
- [`0018-programmatic-agent-adapters-and-action-authorization.md`](0018-programmatic-agent-adapters-and-action-authorization.md)
