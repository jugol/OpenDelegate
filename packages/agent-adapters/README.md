# Agent Adapters

`@opendelegate/agent-adapters` is the Device-local execution boundary for native
agent sessions. It provides:

- one strict `AgentAdapter` contract;
- first-class Codex App Server and Claude Agent SDK adapters;
- executable Codex CLI and Claude CLI fallbacks;
- a versioned generic command/JSONL adapter;
- normalized public messages, tool outcomes, approval requests, progress, usage,
  diagnostics, and completion events;
- exact Device, Task, workstream, Workspace, cwd, worktree, provider-version, and
  lineage bindings in `NativeSessionReference`;
- a bounded event stream with stdout backpressure;
- wall and idle timeouts, cooperative cancellation with forced-process escalation,
  output-size limits, and malformed-output rejection;
- exact active-Run live steering for Codex App Server and Claude Agent SDK, with an
  explicit audited next-resume fallback for reduced-capability adapters;
- process-local and file-backed single-writer session leases with fencing; and
- an explicit non-secret environment channel plus a separate secret channel for
  generic adapters that explicitly own that contract.

The package depends on the exact-pinned Claude Agent SDK and otherwise stays below
the OpenDelegate domain, protocol, Worker, storage, and HTTP layers.

## Provider compatibility

The contract-tested fallback versions for this source revision are:

| Adapter | Tested version | Non-interactive surface |
| --- | --- | --- |
| `CodexAppServerAdapter` | `codex-cli 0.146.0` | App Server JSONL over stdio |
| `ClaudeAgentSdkAdapter` | SDK `0.3.220` / Claude Code `2.1.220` | SDK `query()` async stream |
| `CodexCliAdapter` | `codex-cli 0.146.0` | `codex exec --json` and `codex exec resume` |
| `ClaudeCliAdapter` | Claude Code `2.1.220` | `claude -p --output-format stream-json` |

`probe()` runs version and authentication-status commands only. It does not submit a
model turn. An installed version outside the configured tested set is reported as
`untested` and execution fails closed unless the owner explicitly configures
`allowUntestedVersion`.

Repository maintainers can run `corepack pnpm providers:check` to compare all three
provider pins with the package registry. The command only discovers candidates; it
does not edit dependencies or an installed Device. Dependabot checks the exact
Claude SDK pin weekly. Codex and Claude CLI candidates still require schema review
where available, adapter conformance, and the affected release gates before their
tested-version constants may change.

Before promoting a Codex version, install that exact candidate and run
`corepack pnpm providers:verify-codex-protocol`. The verifier generates the App
Server TypeScript protocol into a temporary directory and requires its complete
notification catalog to match the adapter exactly. This catches benign provider
additions before they can invalidate an otherwise completed Worker Run while still
failing closed for genuinely unreviewed protocol drift.

CLI bindings reuse their provider's authenticated programmatic model-catalog
discovery, so an exact model is verified before CLI execution instead of being
accepted as an unchecked string.

Every first-class Codex and Claude adapter uses an absolute, explicitly configured
provider home and rejects ambient or per-Run attempts to override it. The default
Device paths are `state/providers/codex` and `state/providers/claude`. Existing
authentication is never copied. An owner may explicitly select an existing local
Codex home as the Device's shared source of truth. Persistent Windows services use a
separate managed execution home whose exact `auth.json` links to that SSOT; session
and sandbox state remain service-local. Other managed homes use the provider's normal
interactive login. Keep every provider home outside the checkout and restrict it to
the runtime identity.

Claude SDK also ignores ambient settings, skills, and plugins and requires its
fail-closed sandbox. Native Windows Claude SDK execution is reported incompatible
until that sandbox is available; use Codex, WSL2, or an explicitly configured
container.

The CLI adapters pass prompts through stdin, never a command-line argument. Child
processes always use `shell: false`. Only a narrow OS environment allowlist is
inherited. First-class provider Runs reject `secretEnvironment`; provider
authentication belongs in the configured home, while future Task credentials must
cross a typed, exact Run-scoped Secret helper. The generic adapter may accept an
explicit secret environment when its caller deliberately composes that separate
contract, and known values and common encoded forms are redacted from normalized
output and diagnostics.

## Native session bindings

A native session reference is not portable by ID alone. Resume validates all of:

- provider and adapter ID;
- Task, workstream, and stable session key;
- Device;
- Workspace;
- canonical realpath of the working directory;
- canonical worktree path, when present; and
- the opaque native session ID.

Checkpoint continuation is a new native session with a new lineage ID. It requires
an explicit reason and records the parent native session ID. The parent must belong
to the same Task workstream. Provider-private transcripts and hidden reasoning are
never parsed.

The caller must durably persist every returned `NativeSessionReference`. The caller
must also consume `AgentRunHandle.events`; bounded streaming intentionally applies
backpressure when the consumer stops.

## Live steering

`probe().capabilities.steering` is `true` only for the pinned programmatic
integrations:

- Codex App Server `0.146.0` sends stable `turn/steer` with the exact active
  `threadId` and `expectedTurnId`.
- Claude Agent SDK `0.3.220` keeps one streaming-input channel open and sends an
  `SDKUserMessage` with `priority: "now"` to the exact active Query.

Those adapters expose `AgentRunHandle.steer`. CLI and generic-command handles do
not, and their probes continue to report `steering: false`.

Every steering request binds provider, adapter, Run, Task, workstream, Device,
Workspace, Device-local session key, and native session ID. A mismatch fails before
provider input. A new request after provider completion fails, while an exact replay
of an already accepted request returns the original receipt as `already-accepted`;
reusing its request ID with different text or scope fails closed. Accepted requests
emit a normalized `steering_accepted` event without copying the instruction into
audit output.

Call `selectAgentSteeringDisposition()` before dispatch. For a reduced-capability
adapter it returns:

- `delivery: "next-resume"`;
- stable reason `ADAPTER_LIVE_STEERING_UNAVAILABLE`;
- a bounded safe audit projection; and
- the exact instruction to persist as an input to the next native-session resume.

This function does not create a new turn itself. The coordinator remains responsible
for durably recording the audit projection and supplying that instruction on the
next `resume()`. A capability/handle disagreement is treated as an adapter contract
failure rather than silently falling back.

## Single-writer leases

The default store is one process-wide `InMemorySessionLeaseStore`, shared by all
default adapter instances. Production Worker processes should inject a
`FileSessionLeaseStore` rooted in the Device runtime-data directory, outside the
source checkout:

```ts
const leaseStore = new FileSessionLeaseStore({
  statePath: "C:/ProgramData/OpenDelegate/native-session-leases.json",
});

const adapter = new CodexAppServerAdapter({
  codexHome: "C:/ProgramData/OpenDelegate/providers/codex",
  leaseStore,
});
```

Main-owned coordinator/configuration workspaces may intentionally live outside a Git
repository. Their programmatic turns use reasoning-only deny mode and a read-only
sandbox.

The file store:

- hashes session keys before persistence;
- serializes mutations with a host-local exclusive lock;
- commits state by same-directory atomic rename;
- preserves monotonically increasing fencing values across process restart;
- renews live writers without issuing a new fence;
- rejects corruption, clock regression, symlinked state paths, and concurrent
  writers; and
- permits a new writer only after release or lease expiry.

All adapter instances on one Device must use the same store. This store is a
host-local session guard, not a distributed consensus system or an anti-rollback
root for cloned Device state.

The state and lock files must be on a local filesystem that provides reliable
exclusive create and same-directory atomic rename semantics (for example, NTFS,
APFS, or ext4). SMB, NFS, network shares, cloud-synchronized folders, cloned
runtime directories, and containers that do not share the host PID namespace are
unsupported. Restrict the runtime-data directory to the Worker service account;
the Device threat boundary does not include a hostile same-privilege process.

Lock recovery is deliberately fail-closed. One recovery leader may remove a
well-formed primary lock only after its owning PID is conclusively absent. A
malformed primary lock or an orphaned recovery-leader lock requires manual
recovery: stop every Worker and adapter process using the store, preserve the lock
files for diagnosis, remove only the confirmed orphan, and then restart the
service. Never remove either lock while an adapter process may still be running.

## Permission inputs

Every turn declares a sandbox and permission mode.

- Codex App Server supports reasoning-only deny mode and Worker allow-listed mode.
  Worker shell, file, and permission callbacks are released only after Main's exact
  action decision is durably consumed. Ambient MCP, skills, hooks, browser, desktop,
  and dynamic-install integrations are disabled.
- Claude Agent SDK supports reasoning-only deny mode and Worker allow-listed mode.
  Every Worker callback crosses the same exact-action bridge except Device-local
  Knowledge tools, whose one-use capability is independently enforced on the
  Device. Settings sources are empty, MCP is strict, and filesystem/network
  sandbox startup fails closed. On Linux, readiness verifies both the `bwrap` and
  `socat` executables and a bounded nested user-namespace smoke test. A host AppArmor,
  container, or kernel policy that rejects that smoke is reported incompatible before
  dispatch; OpenDelegate never silently enables the SDK's weaker nested sandbox.
- Codex CLI supports `provider-default`, `read-only`, `workspace-write`, and
  `danger-full-access`. The fallback supports deny or an exact Task-scoped dangerous
  bypass. Deny mode disables the shell tool; every mode ignores ambient user
  configuration and rules and disables unrelated built-in integrations, hooks,
  plugins, dynamic dependency installation, MCP elicitation, browser, and Computer
  Use surfaces. It does not claim an interactive approval bridge.
- Claude CLI supports `provider-default`. Deny mode disables tools; allow-listed
  mode exposes only the declared tools; dangerous bypass requires an exact
  Task-scoped owner or Policy grant. Every turn uses safe mode, strict empty MCP
  configuration, no Chrome integration, and no slash-command discovery. The fallback
  does not claim a `canUseTool` callback.
- The generic runner receives the exact normalized sandbox and permission fields in
  its input envelope and can emit normalized approval requests.

The deterministic OpenDelegate Policy Engine remains authoritative immediately
before external action. Provider permission flags do not replace it.

## Generic command protocol

The executable and arguments are static configuration; no template or shell
interpolation occurs. One input object is written to stdin:

```json
{
  "protocol": "opendelegate.agent-command.v1",
  "operation": "start",
  "requestId": "request-1",
  "runId": "run-1",
  "taskId": "task-1",
  "workstreamId": "worker-code",
  "sessionKey": "task-1/worker-code",
  "deviceId": "device-1",
  "prompt": "Implement the accepted change.",
  "workspace": {
    "workspaceId": "workspace-1",
    "cwd": "/canonical/worktree",
    "isolation": "custom"
  },
  "execution": {
    "sandbox": "custom",
    "permissions": {
      "mode": "allow-listed",
      "allowedTools": ["repo.read", "repo.write"]
    }
  }
}
```

Resume additionally includes the durable `session` object. Continuation includes a
`continuation` object with the parent reference and reason. Secret environment
values are never included in the envelope.

The runner emits one JSON object per line. Every object must contain
`"protocol":"opendelegate.agent-event.v1"` and one supported type:

- `session` — `{ "sessionId": "opaque-id" }`
- `message` or `message_delta` — `{ "text": "..." }`
- `tool_request` — `{ "toolName": "...", "input": {} }`
- `tool_result` — `{ "toolName": "...", "status": "succeeded|failed" }`
- `approval_request` — request ID, action type, summary, and optional structured scope
- `progress` — `{ "message": "..." }`
- `usage` — optional token and USD fields
- `diagnostic` — level, stable code, and message
- `result` — `succeeded` or `failed`, optional final text, and structured failure

Unknown types, invalid versions, malformed JSON, oversized lines, missing sessions,
and missing terminal results fail closed.

## Programmatic seam and current limitations

The App Server and SDK ports are injectable for deterministic conformance tests.
Programmatic turns provide bounded streaming, cancellation, native-session fencing,
strict MCP composition, and provider approval callbacks. Current limits are:

- CLI fallbacks truthfully report `approvalBridge: false`;
- CLI and generic fallbacks cannot steer a live turn and require the explicit
  `next-resume` disposition described above;
- provider-created worktree cleanup remains the Worker/Workspace lifecycle owner's
  responsibility;
- native Windows Claude SDK execution is disabled because its required sandbox is
  unavailable there; and
- authenticated or paid live-provider turns are release-lab evidence and are not
  performed by the default test suite.

The deterministic fixture suite executes real child processes and covers probe,
start, resume, checkpoint lineage, cancellation, timeout, backpressure, secret
redaction, malformed and oversized output, concurrent writer rejection, lease
renewal, and file-store restart behavior on Node.js 22 and 24.
