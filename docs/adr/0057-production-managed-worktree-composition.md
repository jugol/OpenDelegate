# ADR-0057: Production-managed Worktree Composition

- Status: accepted
- Date: 2026-08-10
- Decision: D-105

## Context

The Workspace registry and `ManagedGitWorktreeManager` already implemented a safe,
durable Git worktree lifecycle. Production Worker composition did not instantiate
the manager, and packaged Workspace commands could not select its isolation mode.
Consequently, a service-hosted Codex Run used an owner-owned repository directly.
Codex sandbox preparation failed before a read-only command and surfaced an
unrelated permission-escalation Approval.

Granting a shared provider sandbox group broad write access to the original
repository would make the immediate read succeed, but would weaken isolation for
every later Run. Transparently treating `agent-native-worktree` as
OpenDelegate-managed would also make scheduling metadata untrue.

## Decision

The production Worker owns one `ManagedGitWorktreeManager` alongside its Workspace
registry. Its checksummed journal and managed roots live under Worker state. A
registered Git Workspace whose explicit isolation is `opendelegate-worktree`
resolves to a stable worktree derived from Task, workstream, and Workspace identity.
The exact path is passed to the selected provider and recorded only in Device-local
native-session state.

The packaged CLI accepts `opendelegate-worktree` at registration and exposes
`workspace-set-isolation` for a narrow revisioned metadata change. The command
preserves alias, capabilities, path identity, and state; registry validation rejects
the managed mode for non-Git roots. Existing `agent-native-worktree` registrations
are not migrated implicitly.

## Consequences

- Service identities can prepare provider sandboxes inside service-owned runtime
  state without changing ACLs on the owner's original checkout.
- Retry and follow-up Runs for one workstream reuse their files and native session.
- Separate Tasks or workstreams receive distinct worktrees.
- Worktree cleanup remains subject to the existing dirty/untracked/unpushed checks.
- Owners can deliberately retain native provider isolation or no isolation where
  those modes are appropriate.
