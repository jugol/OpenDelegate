# ADR-0051: Scheduling metadata and singleton Workspace defaults

- Status: accepted
- Date: 2026-08-10
- Decision: D-099

## Context

Live alpha.11 Discord QA selected the Linux NAS correctly but the Worker could not
start its Run. The Device had one active Workspace in the durable Workspace registry,
yet its older `worker.json` had no configured default. In the same Task, Windows was
incorrectly excluded because the Worker heartbeat carried `xhigh` support for the
selected Codex model but the Main scheduling projection dropped `supportedEfforts`.
The remaining eligible set then made the Task look as though its Windows Worker were
offline.

The registry may contain several Workspaces, so choosing an arbitrary first row would
silently move work into the wrong repository or storage root. Conversely, requiring
legacy owners to restate the sole registered Workspace after every upgrade provides
no useful authority boundary.

## Decision

Main preserves model effort support through the Worker candidate projection and
includes only opaque Workspace IDs in the bounded planning snapshot. Production
Worker composition resolves a missing configured default to the registry only when
there is exactly one active registered Workspace. The composition resolves this
singleton at Run time so a long-lived Worker observes a newly registered first
Workspace without restarting. It does not persist or rewrite the Device
configuration.

The generic Workspace resolver continues to require an explicit or injected default.
If the registry contains zero or multiple active Workspaces and the Work Order omits
`workspaceId`, Run startup fails closed with the allowlisted
`WORKSPACE_RESOLUTION_FAILED` diagnostic.

## Consequences

- Existing and newly registered single-Workspace installations recover without a
  service restart after upgrade.
- Exact effort-bound Device profiles no longer become false scheduling negatives.
- Main can name a Workspace explicitly when a Device advertises several.
- Paths, repository names, credentials, and native provider state do not enter the
  planning context or Worker diagnostic.
- Ambiguous Workspace selection remains a configuration or planning error rather
  than a heuristic choice.
