import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AgentAdapterError,
  CodexAppServerAdapter,
  type AgentActionAuthorizationRequest,
  type AgentRunLimits,
  type NormalizedAgentEvent,
} from "../src/index.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/fake-provider.mjs", import.meta.url));
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

test("Codex App Server ignores benign status and goal notifications across native threads", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-codex-app-server-")));
  try {
    const cwd = await realpath(process.cwd());
    const authorizations: AgentActionAuthorizationRequest[] = [];
    const adapter = new CodexAppServerAdapter({
      codexHome: join(root, "codex-home"),
      executable: process.execPath,
      prefixArgs: [fixturePath, "codex-app-server"],
      lineageId: () => "lineage-app-server",
    });
    const probe = await adapter.probe();
    assert.equal(probe.version, "0.146.0");
    assert.equal(probe.auth.state, "ready");
    assert.equal(probe.capabilities.approvalBridge, true);
    const catalog = await adapter.listModels();
    assert.deepEqual(catalog, {
      observedAt: catalog.observedAt,
      models: [
        {
          modelId: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          isDefault: true,
          supportedEfforts: ["high", "xhigh"],
        },
      ],
    });
    await assert.rejects(
      adapter.listModels({
        environment: {
          FIXTURE_REPEAT_MODEL_CURSOR: "1",
        },
      }),
      (error: unknown) =>
        error instanceof AgentAdapterError && error.code === "MALFORMED_PROVIDER_OUTPUT",
    );
    await assert.rejects(
      adapter.probe({ secretEnvironment: { CODEX_HOME: "must-not-override" } }),
      (error: unknown) =>
        error instanceof AgentAdapterError && error.code === "CONTROLLED_PROVIDER_HOME_OVERRIDE",
    );

    const base = {
      requestId: "request-app-server",
      runId: "run-app-server",
      taskId: "task-app-server",
      workstreamId: "implementation",
      sessionKey: "task-app-server/implementation",
      deviceId: "device-windows",
      modelId: "gpt-5.6-sol",
      prompt: "Install dependencies and continue.",
      workspace: {
        workspaceId: "workspace-app-server",
        cwd,
        isolation: "none" as const,
      },
      sandbox: "workspace-write" as const,
      permissions: {
        mode: "allow-listed" as const,
        allowedTools: ["shell", "file-change"],
        actionAuthorization: {
          authorizeAndConsume: async (request: AgentActionAuthorizationRequest) => {
            authorizations.push(request);
            return { decision: "allow" as const, reasonCode: "POLICY_TRUSTED_PACKAGE_INSTALL" };
          },
        },
      },
      environment: {
        FIXTURE_EXPECT_MODEL: "gpt-5.6-sol",
        FIXTURE_EMIT_REMOTE_CONTROL_STATUS: "1",
        FIXTURE_EMIT_THREAD_GOAL_CLEARED: "1",
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
    assert.equal(first.session?.nativeSessionId, "019abcdef-app-server-thread");
    assert.equal(first.session?.modelId, "gpt-5.6-sol");
    assert.equal(first.finalText, "Finished through App Server");
    assert.equal(first.usage?.inputTokens, 10);
    assert.equal(authorizations.length, 1);
    assert.equal(authorizations[0]?.actionCategory, "sandbox-boundary-escalation");
    assert.match(authorizations[0]?.actionFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.ok(
      events.some(
        (event) =>
          event.type === "approval_request" &&
          event.scope !== undefined &&
          JSON.stringify(event.scope).includes("sandbox-boundary-escalation"),
      ),
    );
    assert.ok(events.some((event) => event.type === "tool_result" && event.toolName === "shell"));

    assert.ok(first.session);
    const resumed = await adapter.resume({
      operation: "resume",
      ...base,
      requestId: "request-app-server-resume",
      runId: "run-app-server-resume",
      prompt: "Continue the same task.",
      session: first.session,
    });
    for await (const event of resumed.events) {
      void event;
    }
    const second = await resumed.result;
    assert.equal(second.status, "succeeded");
    assert.equal(second.session?.nativeSessionId, first.session.nativeSessionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex App Server fails before launch without the exact action authorization port", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-codex-app-server-")));
  try {
    const adapter = new CodexAppServerAdapter({
      codexHome: join(root, "codex-home"),
      executable: process.execPath,
      prefixArgs: [fixturePath, "codex-app-server"],
    });
    const cwd = await realpath(process.cwd());
    await assert.rejects(
      adapter.start({
        operation: "start",
        requestId: "request-missing-auth",
        runId: "run-missing-auth",
        taskId: "task-missing-auth",
        workstreamId: "implementation",
        sessionKey: "task-missing-auth/implementation",
        deviceId: "device-windows",
        prompt: "Do work.",
        workspace: {
          workspaceId: "workspace-app-server",
          cwd,
          isolation: "none",
        },
        sandbox: "workspace-write",
        permissions: { mode: "allow-listed", allowedTools: ["shell"] },
        limits,
      }),
      { code: "ACTION_AUTHORIZATION_REQUIRED" },
    );

    const reasoningOnly = await adapter.start({
      operation: "start",
      requestId: "request-deny-mode",
      runId: "run-deny-mode",
      taskId: "task-deny-mode",
      workstreamId: "coordinator",
      sessionKey: "task-deny-mode/coordinator",
      deviceId: "device-windows",
      prompt: "Return a plan without tools.",
      workspace: {
        workspaceId: "workspace-app-server",
        cwd,
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: { mode: "deny" },
      limits,
    });
    for await (const event of reasoningOnly.events) {
      void event;
    }
    assert.equal((await reasoningOnly.result).status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex App Server reconciles a persisted completed turn when the terminal notification is lost", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-codex-app-server-")));
  try {
    const cwd = await realpath(process.cwd());
    const adapter = new CodexAppServerAdapter({
      codexHome: join(root, "codex-home"),
      executable: process.execPath,
      prefixArgs: [fixturePath, "codex-app-server"],
    });
    const handle = await adapter.start({
      operation: "start",
      requestId: "request-lost-terminal",
      runId: "run-lost-terminal",
      taskId: "task-lost-terminal",
      workstreamId: "configuration",
      sessionKey: "task-lost-terminal/configuration",
      deviceId: "device-main",
      prompt: "Inspect configuration without changing it.",
      workspace: {
        workspaceId: "workspace-app-server",
        cwd,
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: {
        mode: "allow-listed",
        allowedTools: ["shell"],
        actionAuthorization: {
          authorizeAndConsume: async () => ({
            decision: "allow",
            reasonCode: "POLICY_TEST",
          }),
        },
      },
      environment: {
        FIXTURE_CODEX_CLOSE_BEFORE_TURN_COMPLETED: "1",
      },
      limits,
    });
    const events: NormalizedAgentEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    const result = await handle.result;

    assert.equal(result.status, "succeeded");
    assert.equal(result.finalText, "Finished through App Server");
    assert.ok(
      events.some((event) => event.type === "diagnostic" && event.code === "CODEX_TURN_RECONCILED"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex App Server fails closed when persisted state cannot prove terminal completion", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-codex-app-server-")));
  try {
    const cwd = await realpath(process.cwd());
    const adapter = new CodexAppServerAdapter({
      codexHome: join(root, "codex-home"),
      executable: process.execPath,
      prefixArgs: [fixturePath, "codex-app-server"],
    });
    const handle = await adapter.start({
      operation: "start",
      requestId: "request-unknown-terminal",
      runId: "run-unknown-terminal",
      taskId: "task-unknown-terminal",
      workstreamId: "configuration",
      sessionKey: "task-unknown-terminal/configuration",
      deviceId: "device-main",
      prompt: "Inspect configuration without changing it.",
      workspace: {
        workspaceId: "workspace-app-server",
        cwd,
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: {
        mode: "allow-listed",
        allowedTools: ["shell"],
        actionAuthorization: {
          authorizeAndConsume: async () => ({
            decision: "allow",
            reasonCode: "POLICY_TEST",
          }),
        },
      },
      environment: {
        FIXTURE_CODEX_CLOSE_BEFORE_TURN_COMPLETED: "1",
        FIXTURE_CODEX_RECONCILED_TURN_STATUS: "inProgress",
      },
      limits,
    });
    const events: NormalizedAgentEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    const result = await handle.result;

    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "PROVIDER_CONNECTION_CLOSED");
    assert.equal(
      events.some((event) => event.type === "diagnostic" && event.code === "CODEX_TURN_RECONCILED"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex App Server never masks a protocol violation with persisted turn reconciliation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-codex-app-server-")));
  try {
    const cwd = await realpath(process.cwd());
    const adapter = new CodexAppServerAdapter({
      codexHome: join(root, "codex-home"),
      executable: process.execPath,
      prefixArgs: [fixturePath, "codex-app-server"],
    });
    const handle = await adapter.start({
      operation: "start",
      requestId: "request-protocol-violation",
      runId: "run-protocol-violation",
      taskId: "task-protocol-violation",
      workstreamId: "configuration",
      sessionKey: "task-protocol-violation/configuration",
      deviceId: "device-main",
      prompt: "Inspect configuration without changing it.",
      workspace: {
        workspaceId: "workspace-app-server",
        cwd,
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: {
        mode: "allow-listed",
        allowedTools: ["shell"],
        actionAuthorization: {
          authorizeAndConsume: async () => ({
            decision: "allow",
            reasonCode: "POLICY_TEST",
          }),
        },
      },
      environment: {
        FIXTURE_CODEX_EMIT_UNSUPPORTED_AFTER_TURN_STARTED: "1",
      },
      limits,
    });
    const events: NormalizedAgentEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    const result = await handle.result;

    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "UNKNOWN_PROVIDER_MESSAGE");
    assert.equal(
      events.some((event) => event.type === "diagnostic" && event.code === "CODEX_TURN_RECONCILED"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex App Server steers only the exact active Run and idempotently binds expectedTurnId", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "opendelegate-codex-app-server-steer-")),
  );
  try {
    const adapter = new CodexAppServerAdapter({
      codexHome: join(root, "codex-home"),
      executable: process.execPath,
      prefixArgs: [fixturePath, "codex-app-server"],
      now: () => Date.parse("2026-07-25T00:00:00.000Z"),
    });
    const probe = await adapter.probe();
    assert.equal(probe.capabilities.steering, true);
    const cwd = await realpath(process.cwd());
    const handle = await adapter.start({
      operation: "start",
      requestId: "request-codex-steer-run",
      runId: "run-codex-steer",
      taskId: "task-codex-steer",
      workstreamId: "implementation",
      sessionKey: "task-codex-steer/implementation",
      deviceId: "device-windows",
      prompt: "Begin the implementation.",
      workspace: {
        workspaceId: "workspace-codex-steer",
        cwd,
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: { mode: "deny" },
      limits,
      environment: { FIXTURE_CODEX_WAIT_FOR_STEER: "1" },
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
    assert.ok(nativeSessionId);
    const request = {
      schemaVersion: 1 as const,
      requestId: "steer-codex-1",
      scope: {
        provider: "codex" as const,
        adapterId: "codex-app-server",
        runId: "run-codex-steer",
        taskId: "task-codex-steer",
        workstreamId: "implementation",
        sessionKey: "task-codex-steer/implementation",
        deviceId: "device-windows",
        workspaceId: "workspace-codex-steer",
        nativeSessionId,
      },
      instruction: "Prioritize the release-blocking test.",
      requestedBy: "main-agent" as const,
    };
    await assert.rejects(
      handle.steer!({
        ...request,
        requestId: "steer-wrong-task",
        scope: { ...request.scope, taskId: "task-other" },
      }),
      (error: unknown) =>
        error instanceof AgentAdapterError && error.code === "STEERING_SCOPE_MISMATCH",
    );

    const receipt = await handle.steer!(request);
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      requestId: "steer-codex-1",
      delivery: "live",
      status: "accepted",
      acceptedAt: "2026-07-25T00:00:00.000Z",
      providerTurnId: "019abcdef-app-server-turn",
    });
    assert.equal((await handle.steer!(request)).status, "already-accepted");
    await assert.rejects(
      handle.steer!({ ...request, instruction: "Conflicting replay." }),
      (error: unknown) =>
        error instanceof AgentAdapterError && error.code === "STEERING_REQUEST_REPLAY_CONFLICT",
    );

    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      observed.push(next.value);
    }
    const result = await handle.result;
    assert.equal(result.status, "succeeded");
    assert.equal(result.finalText, "Steered once: Prioritize the release-blocking test.");
    assert.ok(
      observed.some(
        (event) =>
          event.type === "steering_accepted" &&
          event.requestId === "steer-codex-1" &&
          event.requestedBy === "main-agent",
      ),
    );
    await assert.rejects(
      handle.steer!({ ...request, requestId: "steer-after-completion" }),
      (error: unknown) =>
        error instanceof AgentAdapterError && error.code === "STEERING_TURN_COMPLETED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex App Server sends reasoning effort on the turn and records it on the session", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-codex-effort-")));
  try {
    const cwd = await realpath(process.cwd());
    const adapter = new CodexAppServerAdapter({
      codexHome: join(root, "codex-home"),
      executable: process.execPath,
      prefixArgs: [fixturePath, "codex-app-server"],
      lineageId: () => "lineage-effort",
    });
    const base = {
      requestId: "request-effort",
      runId: "run-effort",
      taskId: "task-effort",
      workstreamId: "implementation",
      sessionKey: "task-effort/implementation",
      deviceId: "device-linux",
      modelId: "gpt-5.6-sol",
      prompt: "Summarize the change.",
      workspace: {
        workspaceId: "workspace-effort",
        cwd,
        isolation: "none" as const,
      },
      sandbox: "workspace-write" as const,
      permissions: {
        mode: "allow-listed" as const,
        allowedTools: ["shell", "file-change"],
        actionAuthorization: {
          authorizeAndConsume: async () => ({
            decision: "allow" as const,
            reasonCode: "POLICY_TRUSTED_PACKAGE_INSTALL",
          }),
        },
      },
      limits,
    };

    // The fixture rejects the turn unless params.effort matches exactly.
    const withEffort = await adapter.start({
      operation: "start",
      ...base,
      effort: "xhigh",
      environment: {
        FIXTURE_EXPECT_MODEL: "gpt-5.6-sol",
        FIXTURE_EXPECT_EFFORT: "xhigh",
      },
    });
    for await (const event of withEffort.events) {
      void event; // Drain so the run can reach its terminal result.
    }
    const result = await withEffort.result;
    assert.equal(result.status, "succeeded");
    // Invariant 27: the effective binding is copied into the session lineage.
    assert.equal(result.session?.effort, "xhigh");
    assert.equal(result.session?.modelId, "gpt-5.6-sol");

    // Omitting effort must not invent one; the fixture rejects any effort key.
    const withoutEffort = await adapter.start({
      operation: "start",
      ...base,
      requestId: "request-no-effort",
      runId: "run-no-effort",
      taskId: "task-no-effort",
      sessionKey: "task-no-effort/implementation",
      environment: {
        FIXTURE_EXPECT_MODEL: "gpt-5.6-sol",
        FIXTURE_EXPECT_NO_EFFORT: "1",
      },
    });
    for await (const event of withoutEffort.events) {
      void event; // Drain so the run can reach its terminal result.
    }
    const plain = await withoutEffort.result;
    assert.equal(plain.status, "succeeded");
    assert.equal(plain.session?.effort, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
