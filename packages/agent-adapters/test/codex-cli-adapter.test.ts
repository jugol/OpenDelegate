import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AgentAdapterError,
  CodexCliAdapter,
  InMemorySessionLeaseStore,
  type AgentRunLimits,
  type NormalizedAgentEvent,
} from "../src/index.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/fake-provider.mjs", import.meta.url));
const limits: AgentRunLimits = {
  wallTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  cancellationGraceMs: 100,
  leaseTtlMs: 1_000,
  leaseRenewIntervalMs: 250,
  maxBufferedEvents: 8,
  maxLineBytes: 64 * 1024,
  maxDiagnosticBytes: 64 * 1024,
};

test("Codex CLI starts through JSONL, streams public output, and returns a durable session reference", async () => {
  const cwd = await realpath(process.cwd());
  const adapter = new CodexCliAdapter({
    executable: process.execPath,
    prefixArgs: [fixturePath, "codex"],
    leaseStore: new InMemorySessionLeaseStore(),
  });

  const handle = await adapter.start({
    operation: "start",
    requestId: "request-1",
    runId: "run-1",
    taskId: "task-1",
    workstreamId: "coordinator",
    sessionKey: "task-1/coordinator",
    deviceId: "device-main",
    prompt: "prepare the release",
    workspace: {
      workspaceId: "workspace-open-delegate",
      cwd,
      isolation: "agent-native-worktree",
    },
    sandbox: "workspace-write",
    permissions: { mode: "deny" },
    limits,
  });

  const events: NormalizedAgentEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  const result = await handle.result;

  assert.equal(result.status, "succeeded");
  assert.equal(result.session?.nativeSessionId, "codex-session-1");
  assert.equal(result.session?.provider, "codex");
  assert.equal(result.session?.deviceId, "device-main");
  assert.equal(result.session?.workspaceId, "workspace-open-delegate");
  assert.equal(result.session?.cwd, cwd);
  assert.equal(result.session?.taskId, "task-1");
  assert.equal(result.session?.workstreamId, "coordinator");
  assert.equal(result.session?.adapterVersion, "0.145.0");
  assert.ok(events.some((event) => event.type === "public_message"));
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 7,
    cachedInputTokens: 2,
  });
});

test("Codex CLI probes installed version and authentication without running a model turn", async () => {
  const adapter = new CodexCliAdapter({
    executable: process.execPath,
    prefixArgs: [fixturePath, "codex"],
  });

  const probe = await adapter.probe();

  assert.equal(probe.installed, true);
  assert.equal(probe.version, "0.145.0");
  assert.equal(probe.compatibility, "tested");
  assert.equal(probe.auth.state, "ready");
  assert.equal(probe.capabilities.approvalBridge, false);
});

test("Codex CLI resumes only the exact Task, Device, Workspace, and cwd binding", async () => {
  const cwd = await realpath(process.cwd());
  const adapter = new CodexCliAdapter({
    executable: process.execPath,
    prefixArgs: [fixturePath, "codex"],
  });
  const base = {
    requestId: "request-start",
    runId: "run-start",
    taskId: "task-resume",
    workstreamId: "worker-code",
    sessionKey: "task-resume/worker-code",
    deviceId: "device-worker",
    prompt: "first turn",
    workspace: {
      workspaceId: "workspace-open-delegate",
      cwd,
      isolation: "agent-native-worktree" as const,
    },
    sandbox: "workspace-write" as const,
    permissions: { mode: "deny" as const },
    limits,
  };
  const started = await adapter.start({ operation: "start", ...base });
  for await (const event of started.events) {
    void event;
    // Drain the event stream before reusing the native session.
  }
  const first = await started.result;
  assert.ok(first.session);

  const resumed = await adapter.resume({
    operation: "resume",
    ...base,
    requestId: "request-resume",
    runId: "run-resume",
    prompt: "follow-up turn",
    session: first.session,
  });
  for await (const event of resumed.events) {
    void event;
    // Drain the event stream.
  }
  const second = await resumed.result;

  assert.equal(second.status, "succeeded");
  assert.equal(second.session?.nativeSessionId, first.session.nativeSessionId);
  assert.equal(second.session?.lineage.lineageId, first.session.lineage.lineageId);
  assert.equal(second.session?.createdAt, first.session.createdAt);

  await assert.rejects(
    adapter.resume({
      operation: "resume",
      ...base,
      requestId: "request-wrong-device",
      runId: "run-wrong-device",
      deviceId: "different-device",
      session: first.session,
    }),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "NATIVE_SESSION_BINDING_MISMATCH",
  );
});
