import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  AgentAdapterError,
  ClaudeAgentSdkAdapter,
  type AgentActionAuthorizationRequest,
  type AgentRunLimits,
  type ClaudeAgentSdkPort,
  type ClaudeAgentSdkUserMessage,
  type NormalizedAgentEvent,
} from "../src/index.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/fake-provider.mjs", import.meta.url));
const sessionId = "11111111-1111-4111-8111-111111111111";
const limits: AgentRunLimits = {
  wallTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  cancellationGraceMs: 50,
  leaseTtlMs: 1_000,
  leaseRenewIntervalMs: 250,
  maxBufferedEvents: 32,
  maxLineBytes: 64 * 1024,
  maxDiagnosticBytes: 4 * 1024,
};
const temporaryClaudeHomes: string[] = [];

async function createClaudeHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-claude-sdk-home-")));
  temporaryClaudeHomes.push(home);
  return home;
}

after(async () => {
  await Promise.all(temporaryClaudeHomes.map((home) => rm(home, { force: true, recursive: true })));
});

test("Claude provider home rejects relative paths, links, and secret-channel override", async () => {
  assert.throws(
    () =>
      new ClaudeAgentSdkAdapter({
        claudeHome: "relative-claude-home",
        hostPlatform: "linux",
        sdk: { query: () => ({ async *[Symbol.asyncIterator]() {} }) },
      }),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "CONTROLLED_PROVIDER_HOME_REQUIRED",
  );

  const root = await createClaudeHome();
  const target = join(root, "target");
  const linked = join(root, "linked");
  await mkdir(target);
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  const linkedAdapter = new ClaudeAgentSdkAdapter({
    claudeHome: linked,
    hostPlatform: "linux",
    sdk: { query: () => ({ async *[Symbol.asyncIterator]() {} }) },
  });
  await assert.rejects(
    linkedAdapter.probe({
      secretEnvironment: { ANTHROPIC_API_KEY: "fixture-api-key" },
    }),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "CONTROLLED_PROVIDER_HOME_UNSAFE",
  );

  const safeAdapter = new ClaudeAgentSdkAdapter({
    claudeHome: await createClaudeHome(),
    hostPlatform: "linux",
    sdk: { query: () => ({ async *[Symbol.asyncIterator]() {} }) },
  });
  await assert.rejects(
    safeAdapter.probe({
      secretEnvironment: {
        ANTHROPIC_API_KEY: "fixture-api-key",
        CLAUDE_CONFIG_DIR: "must-not-override",
      },
    }),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "CONTROLLED_PROVIDER_HOME_OVERRIDE",
  );
});

test("Claude Agent SDK uses isolated settings, fail-closed sandbox, exact authorization, and resume", async () => {
  const claudeHome = await createClaudeHome();
  const capturedOptions: Readonly<Record<string, unknown>>[] = [];
  const sdk: ClaudeAgentSdkPort = {
    query(input) {
      capturedOptions.push(input.options);
      return {
        async *[Symbol.asyncIterator]() {
          const canUseTool = input.options["canUseTool"] as (
            name: string,
            toolInput: Readonly<Record<string, unknown>>,
            options: Readonly<Record<string, unknown>>,
          ) => Promise<{ readonly behavior: string }>;
          const permission = await canUseTool(
            "Bash",
            { command: "pnpm install" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-install",
              requestId: "request-install",
              title: "Install project dependencies",
              decisionReason: "The command needs package-registry access.",
            },
          );
          assert.equal(permission.behavior, "allow");
          const knowledgePermission = await canUseTool(
            "mcp__opendelegate-knowledge__knowledge_search",
            {
              query: "private-query",
              filename: "private-note.md",
              snippet: "private-Knowledge-content",
            },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-knowledge",
              requestId: "request-knowledge",
            },
          );
          assert.equal(knowledgePermission.behavior, "allow");
          const platformMutationPermission = await canUseTool(
            "mcp__opendelegate-platform-mutation__platform_mutation_execute",
            {
              kind: "package-install",
              commandId: "command-install-0001",
              manager: "npm",
              scope: "project",
              packages: ["typescript"],
            },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-platform-mutation",
              requestId: "request-platform-mutation",
            },
          );
          assert.equal(platformMutationPermission.behavior, "allow");
          const artifactWritePermission = await canUseTool(
            "mcp__opendelegate-artifact__artifact_write_chunk",
            {
              commandId: "artifact-command-0001",
              relativePath: "report.html",
              offset: 0,
              contentBase64: "PGh0bWw+PC9odG1sPg==",
            },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-artifact-write",
              requestId: "request-artifact-write",
            },
          );
          assert.equal(artifactWritePermission.behavior, "allow");
          const artifactCommitPermission = await canUseTool(
            "mcp__opendelegate-artifact__artifact_commit",
            {
              commandId: "artifact-command-0002",
              artifacts: [
                {
                  relativePath: "report.html",
                  mediaType: "text/html",
                  originalFilename: "report.html",
                },
              ],
            },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-artifact-commit",
              requestId: "request-artifact-commit",
            },
          );
          assert.equal(artifactCommitPermission.behavior, "allow");
          const computerUsePermission = await canUseTool(
            "mcp__opendelegate-computer-use__computer_use_click",
            { controlId: "button-save" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-computer-use-click",
              requestId: "request-computer-use-click",
            },
          );
          assert.equal(computerUsePermission.behavior, "allow");
          const artifactLookalikePermission = await canUseTool(
            "mcp__opendelegate-artifact__artifact_write_chunk_lookalike",
            {},
            {
              signal: new AbortController().signal,
              toolUseID: "tool-artifact-lookalike",
              requestId: "request-artifact-lookalike",
            },
          );
          assert.equal(artifactLookalikePermission.behavior, "deny");
          const computerUseLookalikePermission = await canUseTool(
            "mcp__opendelegate-computer-use__computer_use_click_lookalike",
            {},
            {
              signal: new AbortController().signal,
              toolUseID: "tool-computer-use-lookalike",
              requestId: "request-computer-use-lookalike",
            },
          );
          assert.equal(computerUseLookalikePermission.behavior, "deny");
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionId,
          };
          yield {
            type: "stream_event",
            session_id: sessionId,
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Working" },
            },
          };
          yield {
            type: "assistant",
            session_id: sessionId,
            message: {
              content: [
                { type: "text", text: "Finished with SDK" },
                {
                  type: "tool_use",
                  id: "knowledge-1",
                  name: "mcp__opendelegate-knowledge__knowledge_search",
                  input: {
                    query: "private-query",
                    filename: "private-note.md",
                    snippet: "private-Knowledge-content",
                  },
                },
              ],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sessionId,
            result: "Finished with SDK",
            total_cost_usd: 0.004,
            usage: {
              input_tokens: 20,
              output_tokens: 9,
              cache_read_input_tokens: 3,
            },
          };
        },
        close() {},
      };
    },
  };
  const authorizations: AgentActionAuthorizationRequest[] = [];
  const adapter = new ClaudeAgentSdkAdapter({
    claudeHome,
    sdk,
    hostPlatform: "linux",
    authExecutable: process.execPath,
    authPrefixArgs: [fixturePath, "claude"],
    allowedNetworkDomains: ["registry.npmjs.org"],
    lineageId: () => "lineage-claude-sdk",
  });
  const cwd = await realpath(process.cwd());
  const base = {
    requestId: "request-claude-sdk",
    runId: "run-claude-sdk",
    taskId: "task-claude-sdk",
    workstreamId: "implementation",
    sessionKey: "task-claude-sdk/implementation",
    deviceId: "device-linux",
    modelId: "claude-opus-5",
    prompt: "Implement the task.",
    workspace: {
      workspaceId: "workspace-claude-sdk",
      cwd,
      isolation: "none" as const,
    },
    sandbox: "workspace-write" as const,
    permissions: {
      mode: "allow-listed" as const,
      allowedTools: [
        "Read",
        "Edit",
        "Bash",
        "mcp__opendelegate-knowledge__knowledge_search",
        "mcp__opendelegate-platform-mutation__platform_mutation_execute",
        "mcp__opendelegate-artifact__artifact_write_chunk",
        "mcp__opendelegate-artifact__artifact_commit",
        "mcp__opendelegate-computer-use__computer_use_click",
        "mcp__opendelegate-artifact__artifact_write_chunk_lookalike",
        "mcp__opendelegate-computer-use__computer_use_click_lookalike",
      ],
      actionAuthorization: {
        authorizeAndConsume: async (request: AgentActionAuthorizationRequest) => {
          authorizations.push(request);
          return request.actionType.endsWith("_lookalike")
            ? {
                decision: "deny" as const,
                reasonCode: "POLICY_TOOL_LOOKALIKE_REJECTED",
              }
            : {
                decision: "allow" as const,
                reasonCode: "POLICY_TRUSTED_PACKAGE_INSTALL",
              };
        },
      },
    },
    limits,
    toolServers: [
      {
        serverName: "opendelegate-knowledge",
        command: process.execPath,
        args: [fixturePath, "knowledge-mcp"],
        enabledTools: [
          "knowledge_search",
          "knowledge_open",
          "knowledge_relationships",
          "knowledge_upsert",
        ],
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 30_000,
      },
      {
        serverName: "opendelegate-platform-mutation",
        command: process.execPath,
        args: [fixturePath, "platform-mutation-mcp"],
        enabledTools: ["platform_mutation_execute"],
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 30_000,
      },
      {
        serverName: "opendelegate-artifact",
        command: process.execPath,
        args: [fixturePath, "artifact-mcp"],
        enabledTools: ["artifact_write_chunk", "artifact_commit"],
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 30_000,
      },
      {
        serverName: "opendelegate-computer-use",
        command: process.execPath,
        args: [fixturePath, "computer-use-mcp"],
        enabledTools: ["computer_use_click"],
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 30_000,
      },
    ],
    environment: { CLAUDE_CONFIG_DIR: "ambient-home-must-not-win" },
  };
  await assert.rejects(
    adapter.start({
      operation: "start",
      ...base,
      secretEnvironment: { ANTHROPIC_API_KEY: "must-use-controlled-home" },
    }),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "SECRET_ENVIRONMENT_SCOPE_UNSAFE",
  );
  const started = await adapter.start({ operation: "start", ...base });
  const events: NormalizedAgentEvent[] = [];
  for await (const event of started.events) {
    events.push(event);
  }
  const first = await started.result;

  assert.equal(first.status, "succeeded");
  assert.equal(first.session?.nativeSessionId, sessionId);
  assert.equal(first.session?.adapterVersion, "0.3.220");
  assert.equal(first.session?.modelId, "claude-opus-5");
  assert.equal(first.finalText, "Finished with SDK");
  assert.equal(first.usage?.cachedInputTokens, 3);
  assert.equal(authorizations.length, 3);
  assert.equal(authorizations[0]?.actionCategory, "sandbox-boundary-escalation");
  assert.equal(
    authorizations[1]?.actionType,
    "mcp__opendelegate-artifact__artifact_write_chunk_lookalike",
  );
  assert.equal(
    authorizations[2]?.actionType,
    "mcp__opendelegate-computer-use__computer_use_click_lookalike",
  );
  assert.deepEqual(capturedOptions[0]?.["settingSources"], []);
  assert.equal(capturedOptions[0]?.["model"], "claude-opus-5");
  assert.equal(capturedOptions[0]?.["strictMcpConfig"], true);
  const providerEnvironment = capturedOptions[0]?.["env"] as Readonly<Record<string, unknown>>;
  assert.equal(providerEnvironment["CLAUDE_CONFIG_DIR"], claudeHome);
  const sandbox = capturedOptions[0]?.["sandbox"] as Readonly<Record<string, unknown>>;
  assert.equal(sandbox["enabled"], true);
  assert.equal(sandbox["failIfUnavailable"], true);
  assert.equal(sandbox["allowUnsandboxedCommands"], false);
  const network = sandbox["network"] as Readonly<Record<string, unknown>>;
  assert.deepEqual(network["allowedDomains"], ["registry.npmjs.org"]);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("private-query"), false);
  assert.equal(serialized.includes("private-note.md"), false);
  assert.equal(serialized.includes("private-Knowledge-content"), false);

  assert.ok(first.session);
  const resumed = await adapter.resume({
    operation: "resume",
    ...base,
    requestId: "request-claude-sdk-resume",
    runId: "run-claude-sdk-resume",
    prompt: "Continue.",
    session: first.session,
  });
  for await (const event of resumed.events) {
    void event;
  }
  assert.equal((await resumed.result).status, "succeeded");
  assert.equal(capturedOptions[1]?.["resume"], sessionId);
});

test("Claude Agent SDK bounds local child Agents without granting their actions extra authority", async () => {
  const claudeHome = await createClaudeHome();
  const decisions: string[] = [];
  const sdk: ClaudeAgentSdkPort = {
    query(input) {
      return {
        async *[Symbol.asyncIterator]() {
          const canUseTool = input.options["canUseTool"] as (
            name: string,
            toolInput: Readonly<Record<string, unknown>>,
            options: Readonly<Record<string, unknown>>,
          ) => Promise<{ readonly behavior: string }>;
          for (let index = 0; index < 5; index += 1) {
            const decision = await canUseTool(
              index % 2 === 0 ? "Agent" : "Task",
              { description: `private-child-${index + 1}` },
              {
                signal: new AbortController().signal,
                toolUseID: `native-child-${index + 1}`,
              },
            );
            decisions.push(decision.behavior);
          }
          yield { type: "system", subtype: "init", session_id: sessionId };
          yield {
            type: "command_lifecycle",
            session_id: sessionId,
            command_id: "private-provider-command-id",
            status: "started",
          };
          yield {
            type: "task_started",
            session_id: sessionId,
            task_id: "private-provider-task-id",
            description: "private child description",
          };
          yield {
            type: "task_updated",
            session_id: sessionId,
            task_id: "private-provider-task-id",
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sessionId,
            result: "Finished bounded delegation.",
          };
        },
      };
    },
  };
  const adapter = new ClaudeAgentSdkAdapter({
    claudeHome,
    sdk,
    hostPlatform: "linux",
    authExecutable: process.execPath,
    authPrefixArgs: [fixturePath, "claude"],
  });
  const cwd = await realpath(process.cwd());
  const handle = await adapter.start({
    operation: "start",
    requestId: "request-claude-native-subagents",
    runId: "run-claude-native-subagents",
    taskId: "task-claude-native-subagents",
    workstreamId: "implementation",
    sessionKey: "task-claude-native-subagents/implementation",
    deviceId: "device-linux",
    prompt: "Delegate independent local checks.",
    workspace: {
      workspaceId: "workspace-claude-native-subagents",
      cwd,
      isolation: "none",
    },
    sandbox: "workspace-write",
    permissions: {
      mode: "allow-listed",
      allowedTools: ["Agent", "Task"],
      actionAuthorization: {
        authorizeAndConsume: async () => {
          throw new Error("Delegation itself must not request expanded authority.");
        },
      },
    },
    limits,
  });
  const events: NormalizedAgentEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  const result = await handle.result;

  assert.equal(result.status, "succeeded");
  assert.deepEqual(decisions, ["allow", "allow", "allow", "allow", "deny"]);
  assert.ok(events.some((event) => event.type === "progress" && event.message.includes("(4/4)")));
  assert.equal(JSON.stringify(events).includes("private child description"), false);
  assert.equal(JSON.stringify(events).includes("private-provider-task-id"), false);
});

test("Claude Agent SDK preserves a terminal failure when transport cleanup throws", async () => {
  const claudeHome = await createClaudeHome();
  const adapter = new ClaudeAgentSdkAdapter({
    claudeHome,
    hostPlatform: "linux",
    authExecutable: process.execPath,
    authPrefixArgs: [fixturePath, "claude"],
    sdk: {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            try {
              yield {
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                session_id: sessionId,
                errors: ["Sandbox required but unavailable."],
              };
            } finally {
              throw new Error("SDK transport closed after the terminal result.");
            }
          },
        };
      },
    },
  });
  const cwd = await realpath(process.cwd());
  const handle = await adapter.start({
    operation: "start",
    requestId: "request-claude-terminal-cleanup",
    runId: "run-claude-terminal-cleanup",
    taskId: "task-claude-terminal-cleanup",
    workstreamId: "implementation",
    sessionKey: "task-claude-terminal-cleanup/implementation",
    deviceId: "device-linux",
    prompt: "Check runtime readiness.",
    workspace: {
      workspaceId: "workspace-claude-terminal-cleanup",
      cwd,
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });
  for await (const event of handle.events) {
    void event;
  }
  const result = await handle.result;

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "CLAUDE_TURN_FAILED");
  assert.equal(result.error?.message, "Sandbox required but unavailable.");
});

test("Claude Agent SDK supports reasoning-only turns by denying every native tool", async () => {
  const claudeHome = await createClaudeHome();
  let observedTools: unknown;
  const sdk: ClaudeAgentSdkPort = {
    query(input) {
      observedTools = input.options["tools"];
      return {
        async *[Symbol.asyncIterator]() {
          const canUseTool = input.options["canUseTool"] as (
            name: string,
            toolInput: Readonly<Record<string, unknown>>,
            options: Readonly<Record<string, unknown>>,
          ) => Promise<{ readonly behavior: string }>;
          const permission = await canUseTool(
            "Read",
            { file_path: "README.md" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-denied",
            },
          );
          assert.equal(permission.behavior, "deny");
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sessionId,
            result: "Reasoning completed without tools.",
          };
        },
      };
    },
  };
  const adapter = new ClaudeAgentSdkAdapter({
    claudeHome,
    sdk,
    hostPlatform: "linux",
    authExecutable: process.execPath,
    authPrefixArgs: [fixturePath, "claude"],
  });
  const cwd = await realpath(process.cwd());
  const handle = await adapter.start({
    operation: "start",
    requestId: "request-claude-deny",
    runId: "run-claude-deny",
    taskId: "task-claude-deny",
    workstreamId: "coordinator",
    sessionKey: "task-claude-deny/coordinator",
    deviceId: "device-linux",
    prompt: "Plan this task without tools.",
    workspace: {
      workspaceId: "workspace-claude-sdk",
      cwd,
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });
  for await (const event of handle.events) {
    void event;
  }
  assert.equal((await handle.result).status, "succeeded");
  assert.deepEqual(observedTools, []);
});

test("Claude Agent SDK refuses native Windows because its required sandbox cannot start", async () => {
  const claudeHome = await createClaudeHome();
  const adapter = new ClaudeAgentSdkAdapter({
    claudeHome,
    hostPlatform: "win32",
    sdk: {
      query() {
        throw new Error("query must not start");
      },
    },
    authExecutable: process.execPath,
    authPrefixArgs: [fixturePath, "claude"],
  });
  const probe = await adapter.probe({
    secretEnvironment: { ANTHROPIC_API_KEY: "fixture-api-key" },
  });
  assert.equal(probe.compatibility, "incompatible");
  assert.ok(
    probe.diagnostics.some(
      (diagnostic) => diagnostic.code === "CLAUDE_SANDBOX_UNAVAILABLE_NATIVE_WINDOWS",
    ),
  );
  // No version and no sign-in changes this, so the adapter asks not to be advertised
  // rather than occupy a row that can only ever read "incompatible".
  assert.equal(probe.unsupportedOnDevice, true);
});

test("Claude Agent SDK reports missing Linux sandbox executables before a Run starts", async () => {
  const adapter = new ClaudeAgentSdkAdapter({
    claudeHome: await createClaudeHome(),
    hostPlatform: "linux",
    sdk: { query: () => ({ async *[Symbol.asyncIterator]() {} }) },
    authExecutable: process.execPath,
    authPrefixArgs: [fixturePath, "claude"],
    sandboxDependencyProbe: async () => ["socat"],
  });
  const probe = await adapter.probe();

  assert.equal(probe.installed, true);
  assert.equal(probe.compatibility, "incompatible");
  assert.ok(
    probe.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "CLAUDE_SANDBOX_DEPENDENCY_UNAVAILABLE" &&
        diagnostic.message.includes("bubblewrap and socat"),
    ),
  );
});

test("Claude Agent SDK stays advertisable off native Windows even when the package is missing", async () => {
  // A missing package has a remedy, so hiding the adapter would hide the remedy too.
  const claudeHome = await createClaudeHome();
  const probe = await new ClaudeAgentSdkAdapter({
    claudeHome,
    hostPlatform: "linux",
    sdk: {
      query() {
        throw new Error("query must not start");
      },
    },
    authExecutable: process.execPath,
    authPrefixArgs: [fixturePath, "claude"],
  }).probe({ secretEnvironment: { ANTHROPIC_API_KEY: "fixture-api-key" } });

  assert.equal(probe.unsupportedOnDevice, undefined);
});

test("Claude Agent SDK consumes priority-now steering only for the exact active Run", async () => {
  const claudeHome = await createClaudeHome();
  const receivedInput: ClaudeAgentSdkUserMessage[] = [];
  let resolveSteering!: () => void;
  const steeringReceived = new Promise<void>((resolve) => {
    resolveSteering = resolve;
  });
  const sdk: ClaudeAgentSdkPort = {
    query(input) {
      assert.notEqual(typeof input.prompt, "string");
      const prompt = input.prompt as AsyncIterable<ClaudeAgentSdkUserMessage>;
      void (async () => {
        const iterator = prompt[Symbol.asyncIterator]();
        const initial = await iterator.next();
        assert.equal(initial.done, false);
        if (!initial.done) {
          receivedInput.push(initial.value);
        }
        const steering = await iterator.next();
        assert.equal(steering.done, false);
        if (!steering.done) {
          receivedInput.push(steering.value);
        }
        resolveSteering();
      })();
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionId,
          };
          yield {
            type: "stream_event",
            session_id: sessionId,
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Working" },
            },
          };
          await steeringReceived;
          yield {
            type: "assistant",
            session_id: sessionId,
            message: { content: [{ type: "text", text: "Applied the steering instruction." }] },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sessionId,
            result: "Applied the steering instruction.",
          };
        },
        close() {},
      };
    },
  };
  const adapter = new ClaudeAgentSdkAdapter({
    claudeHome,
    sdk,
    hostPlatform: "linux",
    authExecutable: process.execPath,
    authPrefixArgs: [fixturePath, "claude"],
    now: () => Date.parse("2026-07-25T01:00:00.000Z"),
  });
  const probe = await adapter.probe();
  assert.equal(probe.capabilities.steering, true);
  const cwd = await realpath(process.cwd());
  const handle = await adapter.start({
    operation: "start",
    requestId: "request-claude-steer-run",
    runId: "run-claude-steer",
    taskId: "task-claude-steer",
    workstreamId: "implementation",
    sessionKey: "task-claude-steer/implementation",
    deviceId: "device-linux",
    prompt: "Begin the implementation.",
    workspace: {
      workspaceId: "workspace-claude-steer",
      cwd,
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });
  assert.equal(typeof handle.steer, "function");

  const iterator = handle.events[Symbol.asyncIterator]();
  const observed: NormalizedAgentEvent[] = [];
  let nativeSessionId: string | undefined;
  while (!observed.some((event) => event.type === "message_delta")) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (!next.done) {
      observed.push(next.value);
      if (next.value.type === "session_started") {
        nativeSessionId = next.value.session.nativeSessionId;
      }
    }
  }
  assert.equal(nativeSessionId, sessionId);
  const request = {
    schemaVersion: 1 as const,
    requestId: "steer-claude-1",
    scope: {
      provider: "claude" as const,
      adapterId: "claude-agent-sdk",
      runId: "run-claude-steer",
      taskId: "task-claude-steer",
      workstreamId: "implementation",
      sessionKey: "task-claude-steer/implementation",
      deviceId: "device-linux",
      workspaceId: "workspace-claude-steer",
      nativeSessionId,
    },
    instruction: "Stop exploring and finish the focused regression.",
    requestedBy: "owner" as const,
  };
  await assert.rejects(
    handle.steer!({
      ...request,
      requestId: "steer-claude-wrong-device",
      scope: { ...request.scope, deviceId: "device-other" },
    }),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "STEERING_SCOPE_MISMATCH",
  );
  const receipt = await handle.steer!(request);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    requestId: "steer-claude-1",
    delivery: "live",
    status: "accepted",
    acceptedAt: "2026-07-25T01:00:00.000Z",
  });
  assert.equal((await handle.steer!(request)).status, "already-accepted");

  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    observed.push(next.value);
  }
  assert.equal((await handle.result).status, "succeeded");
  assert.equal(receivedInput[0]?.message.content, "Begin the implementation.");
  assert.equal(receivedInput[0]?.priority, "now");
  assert.equal(receivedInput[1]?.message.content, request.instruction);
  assert.equal(receivedInput[1]?.priority, "now");
  assert.equal(receivedInput[1]?.session_id, sessionId);
  assert.ok(
    observed.some(
      (event) =>
        event.type === "steering_accepted" &&
        event.requestId === "steer-claude-1" &&
        event.requestedBy === "owner",
    ),
  );
  await assert.rejects(
    handle.steer!({ ...request, requestId: "steer-claude-after-completion" }),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "STEERING_TURN_COMPLETED",
  );
});
