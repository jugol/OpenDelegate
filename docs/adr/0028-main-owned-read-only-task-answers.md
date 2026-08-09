# ADR-0028: Main-owned read-only Task answers

Status: **Accepted**

Date: **2026-07-29**

## Context

The Main Agent planned a Worker capability named `device_inventory_read` when the
owner asked which Devices were currently reachable. No Worker advertised that
invented capability, so target selection failed even though Main already held the
authoritative Device directory and heartbeat projection needed to answer.

Treating every natural-language turn as executable Worker work makes control-plane
questions less reliable than the Admin API and encourages capability invention.
Allowing unrestricted Main completion, however, would let reasoning claim side
effects without Worker evidence.

## Decision

Before an Agent planning turn, deterministic Main code recognizes a deliberately
narrow set of natural-language Device-directory queries. It reads a bounded
owner-safe Device projection, formats the answer without invoking an LLM, and marks
the exact returned decision as authorized for that one Task and planning key. The
projection contains only identity, display name, OS, connection/runtime state, Roles,
service supervision mode, last observation time, verified capability names, route
health, and bounded capacity. It excludes Secrets, Instructions, Knowledge, private
transcript, local paths, Policy internals, and every unverified capability claim.

The bounded grammar includes fleet-list questions, uniquely matched named-Device
reachability questions, and a route follow-up such as whether SSH is registered for
the Device named by the Task objective. A target alias must resolve to exactly one
Device; an absent or ambiguous match falls through to semantic planning rather than
guessing.

Fleet-list questions may ask for bounded owner-safe details already present in the
projection, including OS family, verified capability names, current capacity, and
whether a Device is accepting work. A separate trailing sentence that only forbids
file, service, account, permission, configuration, network, or external-system
mutation may be discarded as a safety guard before classification. A trailing
affirmative action is never discarded, so a compound query still requires Worker
planning and evidence. A bounded repeat modifier such as Korean `다시` does not turn
an otherwise exact fleet-list follow-up into semantic planning.

The authoritative executor rejects `completed` from a planner unless the injected
direct-completion authorizer recognizes that exact deterministic decision. Copying
completion criteria or returning the right JSON shape is not authority. Queries with
selected external inputs, compound side-effect objectives, or language outside the
narrow recognized query grammar proceed through ordinary semantic planning and
Worker evidence instead.

A strict allowlist also recognizes bounded generic test or untitled objectives,
including supported Korean-English code switching such as `test 를 위한 task`, so a
later exact owner query can clarify an otherwise content-free Forum starter. The
deterministic path runs before loading a cached semantic plan. This lets a safe
classifier improvement recover a previously misplanned query on Retry without
reinvoking an LLM; if no direct answer is minted, the original retry-stable semantic
plan remains authoritative.

## Consequences

Supported Device availability questions can be answered without an artificial
Worker Run or an avoidable model turn. Main remains tool-denied. Worker assignment,
Action Policy, leases, fencing, and evidence requirements for side effects are
unchanged.

If the Main-owned directory cannot be read, planning fails as a retryable context
error rather than silently answering from stale model memory. Custom/injected
planners cannot use direct completion merely by returning the same shape;
composition must explicitly provide a trusted deterministic authorizer.

An existing failed Task whose exact query was previously converted into an
artificial Work Order can recover through its ordinary Retry control after upgrade.
It does not require another owner message merely to invalidate that stale plan.

## Verification

- Ordinary planning context includes online/offline Device facts and verified
  capability names but excludes Device Instructions and unverified capabilities.
- A context-backed read-only answer completes with the exact Task criteria and
  creates no Agent turn, Worker target resolution, dispatch, or verification call;
  its visible rows include only verified capability names and bounded current
  capacity.
- A named-Device answer reports current connection/runtime, service mode, last
  observation, and registered route health without exposing Device Instructions.
- A forged `completed` planner decision and a compound side-effect request fail
  closed without Worker evidence.
- A natural Forum starter that asks which online Devices can accept work, requests
  OS and verified capabilities, and adds a non-mutation guard completes directly;
  replacing the guard with an affirmative file action falls through to semantic
  planning.
- A same-Task owner follow-up asking for the Device list `다시` completes from the
  authoritative directory without resuming a native Agent session.
- A code-switched generic test objective plus one exact Device question completes
  directly, and the same trusted decision supersedes a stale cached Work Order on
  Retry without semantic replanning or Worker selection.
- Directory outage and pre-query cancellation fail closed without answering from
  model memory.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-6 and FR-7
- [`../DECISIONS.md`](../DECISIONS.md), D-042 and D-066
