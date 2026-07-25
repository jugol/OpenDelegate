# Worker Runtime

`@opendelegate/worker-runtime` is the deterministic, provider-neutral core of an
OpenDelegate Worker daemon.

It owns:

- strict local Worker configuration with Secret references, never Main database
  credentials;
- an outbound-only connection to Main through an ordered Transport Profile;
- a crash-safe SQLite state repository using WAL, full synchronous durability, a
  checksummed document, and generation compare-and-swap;
- idempotent dispatch intake and one local process start for one Run assignment;
- lease and fencing validation, cooperative cancellation, and bounded forced
  termination;
- a sequenced durable outbox whose events remain until Main acknowledges an ordered
  prefix;
- explicit backpressure that reserves one terminal-event slot for every active Run;
- independent daemon, user-session, desktop, and permission readiness in heartbeats;
- bounded scheduling-safe CPU, memory, and GPU observations with explicit evidence
  source, observation time, and verification state;
- active, draining, disabled, revoked, online, and offline behavior;
- a deterministic `RunProcessFactory` bridge to Codex, Claude, and generic
  `AgentAdapter` implementations;
- Task/workstream-scoped native session start and resume with exact Device,
  Workspace, provider, and adapter bindings;
- durable exact-scope steering with live delivery where the active adapter
  supports it and one-shot next-resume queueing where it does not;
- immutable per-assignment provider requirements with optional exact adapter and
  compatibility gates; Device Auto is used only when no requirement exists;
- safe terminal provider/adapter/native-session lineage observations that omit
  Device-local paths and session keys;
- bounded, Secret-redacted collection of public agent messages and final text; and
- a provider-neutral Artifact lifecycle barrier that can declare output locations
  before launch and return only fully promoted Artifact IDs after a successful turn.

Provider-specific process and SDK behavior remains in
`@opendelegate/agent-adapters`. This package does not contain enrollment key
material, OS service registration, a desktop helper, Knowledge, or Secret values.

## Runtime state location

The default repository accepts only an absolute database filename. Production
composition must also pass `sourceCheckoutDirectory`; the repository refuses a
filename within that checkout. Init and join flows should choose the platform
application-data directory before constructing the repository.

`SqliteNativeSessionReferenceStore` applies the same production boundary more
strictly: both an absolute database filename and an absolute, existing
`sourceCheckoutDirectory` are required. It rejects a state file inside the checkout,
symlinked state files, checksum corruption, binding changes, and native-session
replacement without explicit checkpoint-continuation lineage. It may share the
Worker SQLite database filename because it owns a separate table.

## Workspace registry

`SqliteWorkspaceRegistry` is the Device-local source of truth for execution
directories. A Workspace must be explicitly registered with a stable ID, owner-facing
alias, type, isolation mode, and scheduling capabilities before a Work Order may use
it. Main receives only bounded scheduling metadata; the canonical local path remains
on the Worker.

The registry:

- stores its checksummed, revisioned SQLite state outside the source checkout;
- accepts only existing real directories and rejects symlink or junction roots;
- records the filesystem identity at registration and fails closed if a path is
  replaced, moved, or becomes unavailable;
- prevents duplicate aliases and roots;
- uses compare-and-swap for metadata changes; and
- requires an explicit Workspace on each assignment unless the owner configured a
  deliberate default.

The packaged Worker exposes this registry through deterministic local commands
rather than requiring an Agent to edit `worker.json`:

```text
opendelegate worker workspace-register --workspace-id ID --alias NAME \
  --type directory|git|mounted-storage --path ABSOLUTE_PATH \
  --isolation none|agent-native-worktree [--capability NAME ...]
opendelegate worker workspace-list
```

Registration is idempotent only for the exact same path identity and metadata.
`workspace-list` returns scheduling metadata without the Device-local path.

`RegisteredWorkerWorkspaceResolver` turns one active registration into the exact
`WorkspaceBinding` consumed by the Agent Run bridge. For
`opendelegate-worktree` isolation it composes `ManagedGitWorktreeManager` and derives
a stable, opaque worktree identity from Task, workstream, and Workspace. Follow-up
Runs therefore reuse the same worktree while unrelated workstreams remain isolated.

The manager creates detached worktrees from the registered repository's current
commit with bounded, non-shell Git subprocesses. Its checksummed local journal
recovers interrupted creation, pins the repository and filesystem identities, and
never removes a directory directly. Cleanup inspects tracked changes, untracked
files, and commits made after the base commit. Any such work is preserved unless the
owner explicitly approves `discard`; `preserve` records the decision and leaves the
worktree intact. Removed identities remain tombstoned so a stale native session
cannot silently reuse them.

## Agent Run bridge

Production composition injects five deterministic boundaries:

```ts
const processFactory = new AgentRunProcessFactory({
  adapters: [codexAdapter, claudeAdapter, customAdapter],
  sessionStore: new SqliteNativeSessionReferenceStore({
    filename: "/var/lib/opendelegate/worker.sqlite",
    sourceCheckoutDirectory: "/opt/opendelegate/current",
  }),
  workspaceResolver: {
    resolve: async ({ workspaceId, assignment }) =>
      workspaceRegistry.resolve({
        deviceId: assignment.deviceId,
        workspaceId,
      }),
  },
  executionPlanResolver: {
    resolve: async ({ assignment }) => ({
      provider: "codex",
      adapterId: "codex-cli",
      workstreamId: "repository-implementation",
      prompt: createBoundedWorkOrderPrompt(assignment.workOrder),
      sandbox: "workspace-write",
      permissions: await policyInputsFor(assignment),
      limits: agentLimitsFor(assignment),
    }),
  },
  artifactLifecycle: fileManifestArtifactLifecycle,
});
```

The execution-plan resolver first chooses an already configured adapter and a stable
workstream ID; Workspace resolution then uses that ID to select any managed
worktree. It does not receive another Task's history. A native session key is
derived from Task, workstream, Device, provider, adapter, and Workspace, so related
follow-up Work Orders resume while unrelated Tasks cannot collide. A declared
Work Order `workspaceId` must exactly match the resolved Workspace. The adapter
performs the final canonical cwd/worktree validation.

Sandbox, permission, provider limits, and ordinary environment are explicit inputs.
A bypass permission is rejected unless it carries an exact grant for the assigned
Task. The first-class Codex and Claude adapters authenticate through their
Device-local controlled provider homes and reject per-Run credential environments.
Generic adapters that explicitly own a secret-environment contract still register
those values with the Run egress guard; literal, JSON-escaped, percent-encoded, and
base64 forms cannot enter the Worker report.

The bridge drains adapter events to preserve bounded-stream backpressure. Only
complete public assistant messages and terminal public text contribute to the
Worker report; message deltas, tool inputs, approval scopes, and provider-private
state do not. Message count, prompt bytes, and UTF-8 report bytes are bounded.
Native session references are persisted as soon as a `session_started` event is
observed and again at terminal completion. The terminal Run outcome exposes only
the safe provider, adapter identity/version, native session ID, workstream,
Workspace ID, and lineage needed by Main for durable replay and checkpoint
packaging; `cwd`, `worktreePath`, and `sessionKey` remain Device-local.

An authenticated steering command is accepted only for the current Task, Work
Order, Device, Worker, route, Run, lease, fence, and safe active native-session
observation. Worker writes a `delivering` audit intent before calling the provider.
Exact replay returns the stored receipt; changed reuse fails closed. If Worker
restarts while the provider outcome is unknowable, it records
`STEERING_OUTCOME_UNKNOWN` and never resends the instruction.

Adapters without genuine live steering do not simulate it by starting an unrelated
turn. The exact instruction is queued in the Device-local native-session store and
added once to the next related resume prompt. Queue identity and content survive
restart, remain bound to the same Task/workstream/Device/Workspace/session lineage,
and are marked dispatched before later resumes can inject them again. Main sees
only the safe queued receipt; the local session key never leaves Worker.

If a persisted provider-native session can no longer resume, the bridge starts an
explicit continuation only when the immutable Run assignment carries Main's
versioned, hash-verified Task checkpoint. The checkpoint must bind the exact Task
and current Work Order and is capped at 64 KiB with strict per-section item limits.
The continuation prompt discards the original local prompt and contains only that
public checkpoint plus a bounded Work Order projection. It cannot carry Knowledge,
raw transcripts, Secret references, local paths, scheduling hints, routes, leases,
or fencing state.

`LocalKnowledgeInitialContextProvider` is an optional Device-only boundary. For a
new native session it deterministically searches the local Markdown index from the
Work Order, opens only the selected notes under one total character budget, and
adds their title and content as explicitly non-authoritative reference material.
Candidate previews and local note IDs are not added. Once a native session exists,
the Agent Run bridge does not call the provider again, so follow-up turns resume the
provider session without repeatedly consuming Knowledge context. No Knowledge
field exists in the Worker outbound report or Main protocol.

Worker execution authority is checked before plan resolution, before provider
launch, periodically while the turn runs, and immediately before accepting the
terminal result. When an Artifact lifecycle is configured, the bridge also computes
an exact assignment fingerprint, reserves the Artifact output environment, appends
a provider-neutral manifest contract to the prompt, and waits for promotion after a
successful provider result. Authority is checked throughout that promotion and once
more before the terminal result is accepted. Only confirmed Artifact IDs are
returned. Lease loss cancels the adapter or rejects the promotion and returns a
failed Run. Worker cancel and forced-termination requests both delegate to
`AgentRunHandle.cancel`; the adapter owns its provider-process grace timer and
forced-process escalation.

### Current integration limits

- Artifact declaration and promotion are an injected lifecycle; the runtime never
  parses provider-private transcripts or treats arbitrary adapter output as an
  upload.
- A persisted reference that the provider can no longer resume fails closed unless
  both the adapter supports explicit checkpoint continuation and Main supplied a
  valid Task-and-Work-Order-bound checkpoint. The bridge never silently discards
  session state or reuses the original Knowledge-bearing prompt.
- Provider-native approval callbacks and live SDK behavior remain capabilities of
  the selected adapter. This package does not turn a CLI fallback into an approval
  bridge.
- Deterministic tests use contract fakes. They do not constitute live Codex or
  Claude provider proof.

## Delivery contract

Each outbound event has a stable message ID and sequence. A Main connection may
acknowledge only a unique ordered prefix of the batch it received. If delivery fails
after Main has persisted a batch but before the acknowledgement reaches Worker, the
same events replay with the same IDs and Main's inbox makes that replay idempotent.

Worker dispatch replay is independently idempotent: the durable inbox records the
dispatch message ID, idempotency key, and assignment fingerprint before the child
Run starts. Conflicting reuse fails closed, and an exact replay never starts another
child process.
