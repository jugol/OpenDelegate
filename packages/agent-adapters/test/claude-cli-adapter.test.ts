import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

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
const temporaryClaudeHomes: string[] = [];

async function createClaudeHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-claude-cli-home-")));
  temporaryClaudeHomes.push(home);
  return home;
}

after(async () => {
  await Promise.all(temporaryClaudeHomes.map((home) => rm(home, { force: true, recursive: true })));
});

test("Claude CLI starts, streams public/tool events, and resumes the exact native session", async () => {
  const cwd = await realpath(process.cwd());
  const claudeHome = await createClaudeHome();
  const adapter = new ClaudeCliAdapter({
    claudeHome,
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
    toolServers: [
      {
        serverName: "opendelegate",
        command: process.execPath,
        args: [fixturePath, "mcp-bridge", "--capability-file", "/runtime/grant.json"],
        enabledTools: ["computer_use_capture", "computer_use_click"],
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 30_000,
      },
    ],
    limits,
    environment: {
      CLAUDE_CONFIG_DIR: "ambient-home-must-not-win",
      FIXTURE_EXPECT_CLAUDE_HOME: claudeHome,
      FIXTURE_REQUIRE_CLAUDE_ISOLATION: "1",
      FIXTURE_REQUIRE_CLAUDE_TOOL_SERVER: "1",
    },
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
  assert.equal(first.session?.adapterVersion, "2.1.220");
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
  const claudeHome = await createClaudeHome();
  const adapter = new ClaudeCliAdapter({
    claudeHome,
    executable: process.execPath,
    prefixArgs: [fixturePath, "claude"],
  });

  const probe = await adapter.probe({
    environment: {
      CLAUDE_CONFIG_DIR: "ambient-home-must-not-win",
      FIXTURE_EXPECT_CLAUDE_HOME: claudeHome,
    },
  });

  assert.equal(probe.installed, true);
  assert.equal(probe.version, "2.1.220");
  assert.equal(probe.compatibility, "tested");
  assert.equal(probe.auth.state, "ready");
  assert.equal(probe.capabilities.approvalBridge, false);
  assert.equal(probe.capabilities.steering, false);

  const signedOut = await adapter.probe({
    environment: { FIXTURE_SIGNED_OUT: "1" },
  });
  assert.equal(signedOut.auth.state, "not_ready");
  assert.equal(signedOut.diagnostics.length, 1);
  assert.equal(signedOut.diagnostics[0]?.code, "AUTH_NOT_READY");
  // This home is not the one bare `claude` would reach, so the remedy has to name it:
  // a provider keeps one credential per home and signing in to the wrong one changes nothing.
  const remedy = signedOut.diagnostics[0]?.message ?? "";
  assert.match(remedy, /Run claude with CLAUDE_CONFIG_DIR=/u);
  assert.ok(remedy.includes(claudeHome));
  // An owner looking at a signed-in desktop app reads "not signed in" as a false
  // report, so the remedy says which session does not count.
  assert.match(remedy, /desktop app holds its own session/u);
});

test("Claude CLI reuses the Agent SDK model catalog from the same controlled home", async () => {
  const claudeHome = await createClaudeHome();
  let closed = false;
  const adapter = new ClaudeCliAdapter({
    claudeHome,
    executable: process.execPath,
    prefixArgs: [fixturePath, "claude"],
    modelCatalogSdk: {
      query: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true, value: undefined }),
          };
        },
        async supportedModels() {
          return [
            {
              value: "claude-opus-5",
              displayName: "Claude Opus 5",
              description: "Fixture model",
            },
          ];
        },
        close() {
          closed = true;
        },
      }),
    },
  });

  const catalog = await adapter.listModels({
    environment: {
      FIXTURE_EXPECT_CLAUDE_HOME: claudeHome,
    },
  });

  assert.deepEqual(catalog.models, [
    {
      modelId: "claude-opus-5",
      displayName: "Claude Opus 5",
    },
  ]);
  assert.equal(closed, true);
});

test("Claude exposes only the Run-scoped Knowledge server and redacts local tool data", async () => {
  const cwd = await realpath(process.cwd());
  const claudeHome = await createClaudeHome();
  const adapter = new ClaudeCliAdapter({
    claudeHome,
    executable: process.execPath,
    prefixArgs: [fixturePath, "claude"],
  });
  const handle = await adapter.start({
    operation: "start",
    requestId: "request-claude-knowledge",
    runId: "run-claude-knowledge",
    taskId: "task-claude-knowledge",
    workstreamId: "implementation",
    sessionKey: "task-claude-knowledge/implementation",
    deviceId: "device-worker",
    prompt: "inspect local guidance",
    workspace: {
      workspaceId: "workspace-open-delegate",
      cwd,
      isolation: "agent-native-worktree",
    },
    sandbox: "provider-default",
    permissions: { mode: "deny" },
    toolServers: [
      {
        serverName: "opendelegate-knowledge",
        command: process.execPath,
        args: [
          fixturePath,
          "knowledge-mcp-bridge",
          "--capability-file",
          "/runtime/knowledge-capability.json",
        ],
        enabledTools: [
          "knowledge_search",
          "knowledge_open",
          "knowledge_relationships",
          "knowledge_upsert",
        ],
        startupTimeoutMs: 15_000,
        toolTimeoutMs: 30_000,
      },
    ],
    limits,
    environment: {
      FIXTURE_REQUIRE_CLAUDE_ISOLATION: "1",
      FIXTURE_REQUIRE_CLAUDE_KNOWLEDGE_TOOL_SERVER: "1",
      FIXTURE_EMIT_KNOWLEDGE_TOOL_EVENTS: "1",
    },
  });

  const events: NormalizedAgentEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  assert.equal((await handle.result).status, "succeeded");
  const request = events.find(
    (event) =>
      event.type === "tool_request" &&
      event.toolName === "mcp__opendelegate-knowledge__knowledge_search",
  );
  const result = events.find(
    (event) =>
      event.type === "tool_result" &&
      event.toolName === "mcp__opendelegate-knowledge__knowledge_search",
  );
  assert.ok(request);
  assert.equal("input" in request, false);
  assert.ok(result);
  assert.equal("summary" in result, false);
  const normalized = JSON.stringify(events);
  for (const privateValue of [
    "private-query",
    "private-note.md",
    "private-Knowledge-content",
    "private-Knowledge-result",
  ]) {
    assert.equal(normalized.includes(privateValue), false);
  }
});
