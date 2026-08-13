# ADR-0068: Windows Codex service home

- Status: Accepted
- Date: 2026-08-12
- Decision: D-142

## Context

OpenDelegate's persistent Windows core runs as an instance-specific virtual-service
identity, while the owner also runs Codex interactively. Earlier releases used the
owner's existing Codex home for both callers and tried to reassert Full Control on its
single `.sandbox-bin` before each lifecycle start.

Live execution disproved that design. Codex sandbox setup owns its helper DACL and
rewrites it during initialization. The rewrite preserves the directory owner but
does not preserve OpenDelegate's extra service ACE. When the interactive owner owns
the helper, the service is subsequently left with Modify rather than `WRITE_DAC`, so
the next setup refresh fails before a harmless workspace read. Sharing the helper
therefore makes correctness depend on which caller ran Codex most recently.

The owner also requires one provider login SSOT. Copying `auth.json` into a service
home would drift on refresh or logout and would duplicate credential material.

## Decision

Every persistent Windows service document records:

1. the canonical owner Codex home used as the authentication source;
2. a canonical OpenDelegate-managed Codex service home below the instance state root;
3. the exact Claude home, which continues to use its provider-supported shared-home
   behavior.

Lifecycle preparation creates the managed Codex home and its `.sandbox-bin`. The
instance virtual-service identity owns both directories; Administrators and SYSTEM
retain Full Control. The interactive owner does not use this helper. The managed
home's exact `auth.json` path is a file symbolic link to the exact `auth.json` child
of the declared owner Codex home. Link creation happens only in the elevated,
journaled lifecycle executor. It accepts an existing link only when its textual and
resolved target is exact, and rejects every regular-file occupant, alternate target,
link or special parent, noncanonical path, and replacement race. Credential bytes are
never read or copied by lifecycle code.

The service host sets `CODEX_HOME` to the managed service home. Worker adapter
composition treats that signed service binding as authoritative only in explicit
`system-service` mode; foreground execution continues to honor the owner's configured
home. Codex sessions and sandbox helpers are service-local, while authentication and
provider token refresh follow the one owner file.

Upgrade admits one finite predecessor: the otherwise exact installed runtime
configuration without the managed service-home field. That migration composes with
the previously accepted Windows credential migration and rejects any unrelated byte
drift. D-142 supersedes the shared owner `.sandbox-bin` portions of D-140 and D-141.

## Alternatives considered

### Keep repairing the shared helper ACL

Rejected because Codex legitimately rewrites that DACL after lifecycle preparation.
An additive service ACE cannot remain an invariant, and a non-owner service caller
cannot perform the next DACL refresh once `WRITE_DAC` is removed.

### Run Codex with the unelevated Windows sandbox

Rejected because live probes allowed simple shell writes but rejected `apply_patch`.
It is not an adequate general development execution boundary.

### Copy the owner authentication file

Rejected because refresh, logout, and account changes would create two credential
truths and leave stale secret bytes in service state.

### Run the service as the interactive owner

Rejected because it would collapse the service, owner-session, and Computer Use trust
planes and weaken existing least-privilege invariants.

## Consequences

- Interactive and service Codex executions cannot overwrite each other's helper ACL.
- The service identity remains directory owner after Codex rewrites its helper DACL,
  so later setup refreshes retain owner-level DACL repair rights.
- Provider-native session state is service-local and survives service restart.
- Owner login and token refresh remain one SSOT without credential copying.
- Windows service documents and guarded upgrades gain one exact non-secret path field
  and one exact symbolic-link lifecycle action.

## Verification

- Configuration tests reject a service home outside the exact managed provider root,
  overlap with the owner home, aliases, links, roots, or protected paths.
- Plan and executor tests prove the managed home precedes the sandbox and auth link,
  the service identity owns both directories, and a wrong link target fails closed.
- Migration tests cover the field-only predecessor, its composition with D-118, and
  rejection of an additional unrelated difference.
- A live Windows service probe performs at least two Codex sandbox initializations
  under the service identity without ACL failure.
- Release QA creates or modifies a file on Windows through a Discord Task, uploads it
  through Main, downloads it from Discord, and compares exact bytes and SHA-256.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-3 and FR-16
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 4
- [`../DECISIONS.md`](../DECISIONS.md), D-076, D-100, D-118, D-140, D-141, and D-142
- [`0052-windows-codex-service-sandbox-directory.md`](0052-windows-codex-service-sandbox-directory.md)
- [`0067-windows-owner-agent-launcher-path.md`](0067-windows-owner-agent-launcher-path.md)
