import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

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
const temporaryCodexHomes: string[] = [];

async function createCodexHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-codex-cli-home-")));
  temporaryCodexHomes.push(home);
  return home;
}

after(async () => {
  await Promise.all(temporaryCodexHomes.map((home) => rm(home, { force: true, recursive: true })));
});

test("Codex CLI starts through JSONL, streams public output, and returns a durable session reference", async () => {
  const cwd = await realpath(process.cwd());
  const codexHome = await createCodexHome();
  const adapter = new CodexCliAdapter({
    codexHome,
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
    toolServers: [
      {
        serverName: "opendelegate",
        command: process.execPath,
        args: [fixturePath, "mcp-bridge", "--capability-file", "C:\\runtime\\grant.json"],
        enabledTools: ["computer_use_capture", "computer_use_click"],
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 30_000,
      },
    ],
    limits,
    environment: {
      CODEX_HOME: "ambient-home-must-not-win",
      FIXTURE_EXPECT_CODEX_HOME: codexHome,
      FIXTURE_REQUIRE_CODEX_TOOL_SERVER: "1",
    },
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
  assert.equal(result.session?.adapterVersion, "0.146.0");
  assert.ok(events.some((event) => event.type === "public_message"));
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 7,
    cachedInputTokens: 2,
  });
});

test("Codex CLI probes installed version and authentication without running a model turn", async () => {
  const codexHome = await createCodexHome();
  const adapter = new CodexCliAdapter({
    codexHome,
    executable: process.execPath,
    prefixArgs: [fixturePath, "codex"],
  });

  const probe = await adapter.probe({
    environment: {
      CODEX_HOME: "ambient-home-must-not-win",
      FIXTURE_EXPECT_CODEX_HOME: codexHome,
    },
  });

  assert.equal(probe.installed, true);
  assert.equal(probe.version, "0.146.0");
  assert.equal(probe.compatibility, "tested");
  assert.equal(probe.auth.state, "ready");
  assert.equal(probe.capabilities.approvalBridge, false);
  assert.equal(probe.capabilities.steering, false);
});

test("Codex CLI reuses the App Server model catalog from the same controlled home", async () => {
  const codexHome = await createCodexHome();
  const adapter = new CodexCliAdapter({
    codexHome,
    executable: process.execPath,
    prefixArgs: [fixturePath, "codex"],
  });

  const catalog = await adapter.listModels({
    environment: {
      FIXTURE_EXPECT_CODEX_HOME: codexHome,
    },
  });

  assert.deepEqual(
    catalog.models.map((model) => model.modelId),
    ["gpt-5.6-sol"],
  );
});

test("Codex exposes only the Run-scoped Knowledge server and never normalizes local payloads", async () => {
  const cwd = await realpath(process.cwd());
  const codexHome = await createCodexHome();
  const adapter = new CodexCliAdapter({
    codexHome,
    executable: process.execPath,
    prefixArgs: [fixturePath, "codex"],
    leaseStore: new InMemorySessionLeaseStore(),
  });
  const handle = await adapter.start({
    operation: "start",
    requestId: "request-codex-knowledge",
    runId: "run-codex-knowledge",
    taskId: "task-codex-knowledge",
    workstreamId: "implementation",
    sessionKey: "task-codex-knowledge/implementation",
    deviceId: "device-worker",
    prompt: "inspect local guidance",
    workspace: {
      workspaceId: "workspace-open-delegate",
      cwd,
      isolation: "agent-native-worktree",
    },
    sandbox: "workspace-write",
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
      FIXTURE_REQUIRE_CODEX_KNOWLEDGE_TOOL_SERVER: "1",
      FIXTURE_EMIT_KNOWLEDGE_TOOL_EVENTS: "1",
    },
  });

  const events: NormalizedAgentEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  assert.equal((await handle.result).status, "succeeded");
  assert.ok(
    events.some(
      (event) =>
        event.type === "tool_result" &&
        event.toolName === "knowledge_search" &&
        event.status === "succeeded",
    ),
  );
  const normalized = JSON.stringify(events);
  for (const privateValue of ["private-query", "private-note.md", "private-Knowledge-content"]) {
    assert.equal(normalized.includes(privateValue), false);
  }
});

test("Codex CLI can explicitly allow a coordinator workspace outside Git", async () => {
  const cwd = await realpath(process.cwd());
  const codexHome = await createCodexHome();
  const adapter = new CodexCliAdapter({
    codexHome,
    executable: process.execPath,
    prefixArgs: [fixturePath, "codex"],
    skipGitRepositoryCheck: true,
    leaseStore: new InMemorySessionLeaseStore(),
  });

  const handle = await adapter.start({
    operation: "start",
    requestId: "request-non-git",
    runId: "run-non-git",
    taskId: "task-non-git",
    workstreamId: "coordinator",
    sessionKey: "task-non-git/coordinator",
    deviceId: "device-main",
    prompt: "inspect configuration",
    workspace: {
      workspaceId: "workspace-main-runtime",
      cwd,
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
    environment: {
      PATH: process.env.PATH ?? "",
      FIXTURE_REQUIRE_DENY_ISOLATION: "1",
      FIXTURE_REQUIRE_SKIP_GIT: "1",
    },
  });
  for await (const event of handle.events) {
    void event;
  }
  assert.equal((await handle.result).status, "succeeded");
});

test("Codex CLI resumes only the exact Task, Device, Workspace, and cwd binding", async () => {
  const cwd = await realpath(process.cwd());
  const codexHome = await createCodexHome();
  const adapter = new CodexCliAdapter({
    codexHome,
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
