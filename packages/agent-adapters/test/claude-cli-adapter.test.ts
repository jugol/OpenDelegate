import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ClaudeCliAdapter, type AgentRunLimits, type NormalizedAgentEvent } from "../src/index.ts";

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

test("Claude CLI starts, streams public/tool events, and resumes the exact native session", async () => {
  const cwd = await realpath(process.cwd());
  const adapter = new ClaudeCliAdapter({
    executable: process.execPath,
    prefixArgs: [fixturePath, "claude"],
    lineageId: () => "lineage-claude",
  });
  const base = {
    requestId: "request-claude-start",
    runId: "run-claude-start",
    taskId: "task-claude",
    workstreamId: "research",
    sessionKey: "task-claude/research",
    deviceId: "device-mac",
    prompt: "inspect the product",
    workspace: {
      workspaceId: "workspace-open-delegate",
      cwd,
      isolation: "agent-native-worktree" as const,
    },
    sandbox: "provider-default" as const,
    permissions: {
      mode: "allow-listed" as const,
      allowedTools: ["Read"],
      deniedTools: ["Bash"],
    },
    limits,
  };

  const started = await adapter.start({ operation: "start", ...base });
  const events: NormalizedAgentEvent[] = [];
  for await (const event of started.events) {
    events.push(event);
  }
  const first = await started.result;

  assert.equal(first.status, "succeeded");
  assert.equal(first.session?.nativeSessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(first.session?.provider, "claude");
  assert.equal(first.session?.adapterVersion, "2.1.205");
  assert.equal(first.session?.lineage.lineageId, "lineage-claude");
  assert.ok(events.some((event) => event.type === "message_delta"));
  assert.ok(events.some((event) => event.type === "tool_request" && event.toolName === "Read"));
  assert.deepEqual(first.usage, {
    inputTokens: 20,
    outputTokens: 9,
    cachedInputTokens: 3,
    costUsd: 0.0042,
  });

  assert.ok(first.session);
  const resumed = await adapter.resume({
    operation: "resume",
    ...base,
    requestId: "request-claude-resume",
    runId: "run-claude-resume",
    prompt: "continue",
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
});

test("Claude CLI reports version/auth compatibility without a provider turn", async () => {
  const adapter = new ClaudeCliAdapter({
    executable: process.execPath,
    prefixArgs: [fixturePath, "claude"],
  });

  const probe = await adapter.probe();

  assert.equal(probe.installed, true);
  assert.equal(probe.version, "2.1.205");
  assert.equal(probe.compatibility, "tested");
  assert.equal(probe.auth.state, "ready");
  assert.equal(probe.capabilities.approvalBridge, false);

  const signedOut = await adapter.probe({
    environment: { FIXTURE_SIGNED_OUT: "1" },
  });
  assert.equal(signedOut.auth.state, "not_ready");
  assert.deepEqual(signedOut.diagnostics, [
    {
      code: "AUTH_NOT_READY",
      message: "Claude CLI authentication is not ready.",
    },
  ]);
});
