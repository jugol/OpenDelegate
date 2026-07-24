# Agent Adapters

`@opendelegate/agent-adapters` is the Device-local execution boundary for native
agent sessions. It provides:

- one strict `AgentAdapter` contract;
- executable Codex CLI and Claude CLI fallbacks;
- a versioned generic command/JSONL adapter;
- normalized public messages, tool outcomes, approval requests, progress, usage,
  diagnostics, and completion events;
- exact Device, Task, workstream, Workspace, cwd, worktree, provider-version, and
  lineage bindings in `NativeSessionReference`;
- a bounded event stream with stdout backpressure;
- wall and idle timeouts, cooperative cancellation with forced-process escalation,
  output-size limits, and malformed-output rejection;
- process-local and file-backed single-writer session leases with fencing; and
- explicit non-secret and secret environment channels with output redaction.

The package uses only Node.js built-ins. It has no dependency on the OpenDelegate
domain, protocol, Worker, storage, HTTP, or provider SDK packages.

## Provider compatibility

The contract-tested fallback versions for this source revision are:

| Adapter | Tested executable version | Non-interactive surface |
| --- | --- | --- |
| `CodexCliAdapter` | `codex-cli 0.145.0` | `codex exec --json` and `codex exec resume` |
| `ClaudeCliAdapter` | Claude Code `2.1.205` | `claude -p --output-format stream-json` |

`probe()` runs version and authentication-status commands only. It does not submit a
model turn. An installed version outside the configured tested set is reported as
`untested` and execution fails closed unless the owner explicitly configures
`allowUntestedVersion`.

The CLI adapters pass prompts through stdin, never a command-line argument. Child
processes always use `shell: false`. Only a narrow OS environment allowlist is
inherited. API keys and other credential variables must be supplied through
`secretEnvironment`; known secret values and their common encoded forms are redacted
from normalized output and diagnostics.

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

## Single-writer leases

The default store is one process-wide `InMemorySessionLeaseStore`, shared by all
default adapter instances. Production Worker processes should inject a
`FileSessionLeaseStore` rooted in the Device runtime-data directory, outside the
source checkout:

```ts
const leaseStore = new FileSessionLeaseStore({
  statePath: "C:/ProgramData/OpenDelegate/native-session-leases.json",
});

const adapter = new CodexCliAdapter({ leaseStore });
```

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

## Permission inputs

Every turn declares a sandbox and permission mode.

- Codex CLI supports `provider-default`, `read-only`, `workspace-write`, and
  `danger-full-access`. The fallback supports deny or an exact Task-scoped dangerous
  bypass. It does not claim an interactive approval bridge.
- Claude CLI supports `provider-default`. Deny mode disables tools; allow-listed
  mode exposes only the declared tools; dangerous bypass requires an exact
  Task-scoped owner or Policy grant. The fallback does not claim a `canUseTool`
  callback.
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

## SDK seam and current limitations

`AgentSdkDriver` is the injectable seam for the Codex SDK/App Server and Claude Agent
SDK. This package revision does not bundle either provider SDK and does not claim an
SDK-native live run. Consequently:

- CLI fallbacks cannot pause on provider-native approval callbacks; their probe
  truthfully reports `approvalBridge: false`;
- live steering is not exposed by the fallback adapters;
- provider-created worktree cleanup remains the Worker/Workspace lifecycle owner's
  responsibility;
- cancellation terminates the provider runner process, but cleanup of arbitrary
  grandchildren still depends on the provider CLI's process handling; and
- no authenticated or paid live-provider model smoke is part of the default test
  suite.

The deterministic fixture suite executes real child processes and covers probe,
start, resume, checkpoint lineage, cancellation, timeout, backpressure, secret
redaction, malformed and oversized output, concurrent writer rejection, lease
renewal, and file-store restart behavior on Node.js 22 and 24.
