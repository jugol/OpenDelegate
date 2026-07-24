import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AgentAdapterError,
  GenericCommandAdapter,
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

test("generic command runner uses the strict stdin/JSONL lifecycle and resumes by durable reference", async () => {
  const cwd = await realpath(process.cwd());
  const adapter = new GenericCommandAdapter({
    adapterId: "generic-fixture",
    executable: process.execPath,
    args: [fixturePath, "generic", "fixed-arg"],
    versionArgs: [fixturePath, "generic", "--version"],
    testedVersions: ["3.4.5"],
    lineageId: () => "lineage-generic",
  });
  const base = {
    requestId: "request-generic-start",
    runId: "run-generic-start",
    taskId: "task-generic",
    workstreamId: "custom-runner",
    sessionKey: "task-generic/custom-runner",
    deviceId: "device-linux",
    prompt: "render a report",
    workspace: {
      workspaceId: "workspace-reports",
      cwd,
      isolation: "custom" as const,
    },
    sandbox: "container" as const,
    permissions: {
      mode: "allow-listed" as const,
      allowedTools: ["artifact.write"],
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
  assert.equal(first.session?.nativeSessionId, "generic-session-1");
  assert.equal(first.session?.adapterId, "generic-fixture");
  assert.equal(first.session?.adapterVersion, "3.4.5");
  assert.equal(first.session?.lineage.lineageId, "lineage-generic");
  assert.ok(
    events.some((event) => event.type === "progress" && event.message === "start:container:true"),
  );
  assert.ok(
    events.some(
      (event) => event.type === "approval_request" && event.actionType === "package.install",
    ),
  );

  assert.ok(first.session);
  const resumed = await adapter.resume({
    operation: "resume",
    ...base,
    requestId: "request-generic-resume",
    runId: "run-generic-resume",
    prompt: "continue",
    session: first.session,
  });
  for await (const event of resumed.events) {
    void event;
    // Drain the stream.
  }
  const second = await resumed.result;

  assert.equal(second.status, "succeeded");
  assert.equal(second.session?.nativeSessionId, first.session.nativeSessionId);
});

test("generic command probe reports authentication as not required when no auth command exists", async () => {
  const adapter = new GenericCommandAdapter({
    adapterId: "generic-fixture",
    executable: process.execPath,
    args: [fixturePath, "generic"],
    versionArgs: [fixturePath, "generic", "--version"],
    testedVersions: ["3.4.5"],
  });

  const probe = await adapter.probe();

  assert.equal(probe.version, "3.4.5");
  assert.equal(probe.compatibility, "tested");
  assert.equal(probe.auth.state, "not_required");
  assert.equal(probe.capabilities.approvalBridge, true);
});

test("an installed but untested runner degrades and is blocked by default", async () => {
  const cwd = await realpath(process.cwd());
  const adapter = new GenericCommandAdapter({
    adapterId: "generic-untested",
    executable: process.execPath,
    args: [fixturePath, "generic"],
    versionArgs: [fixturePath, "generic", "--version"],
    testedVersions: ["9.9.9"],
  });

  const probe = await adapter.probe();
  assert.equal(probe.installed, true);
  assert.equal(probe.version, "3.4.5");
  assert.equal(probe.compatibility, "untested");

  await assert.rejects(
    adapter.start({
      operation: "start",
      requestId: "request-untested",
      runId: "run-untested",
      taskId: "task-untested",
      workstreamId: "worker",
      sessionKey: "task-untested/worker",
      deviceId: "device-linux",
      prompt: "do not run",
      workspace: {
        workspaceId: "workspace-open-delegate",
        cwd,
        isolation: "custom",
      },
      sandbox: "custom",
      permissions: { mode: "deny" },
      limits,
    }),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "ADAPTER_VERSION_UNSUPPORTED",
  );
});

test("checkpoint continuation creates explicit lineage and resume rejects worktree drift", async () => {
  const cwd = await realpath(process.cwd());
  const lineageIds = ["lineage-original", "lineage-continuation"];
  const adapter = new GenericCommandAdapter({
    adapterId: "generic-continuation",
    executable: process.execPath,
    args: [fixturePath, "generic"],
    versionArgs: [fixturePath, "generic", "--version"],
    testedVersions: ["3.4.5"],
    lineageId: () => lineageIds.shift() ?? "unexpected-lineage",
  });
  const base = {
    requestId: "request-original",
    runId: "run-original",
    taskId: "task-continuation",
    workstreamId: "coordinator",
    sessionKey: "task-continuation/coordinator",
    deviceId: "device-main",
    prompt: "original",
    workspace: {
      workspaceId: "workspace-open-delegate",
      cwd,
      worktreePath: cwd,
      isolation: "agent-native-worktree" as const,
    },
    sandbox: "custom" as const,
    permissions: { mode: "deny" as const },
    limits,
  };
  const originalHandle = await adapter.start({ operation: "start", ...base });
  for await (const event of originalHandle.events) {
    void event;
  }
  const original = await originalHandle.result;
  assert.ok(original.session);

  const continuationHandle = await adapter.start({
    operation: "start",
    ...base,
    requestId: "request-continuation",
    runId: "run-continuation",
    prompt: "checkpoint package",
    continuationOf: original.session,
    continuationReason: "native session was deleted",
  });
  for await (const event of continuationHandle.events) {
    void event;
  }
  const continuation = await continuationHandle.result;

  assert.equal(continuation.session?.nativeSessionId, "generic-session-continuation");
  assert.equal(continuation.session?.lineage.lineageId, "lineage-continuation");
  assert.equal(
    continuation.session?.lineage.parentNativeSessionId,
    original.session.nativeSessionId,
  );
  assert.equal(continuation.session?.lineage.continuationReason, "native session was deleted");

  assert.ok(continuation.session);
  await assert.rejects(
    adapter.resume({
      operation: "resume",
      ...base,
      requestId: "request-drift",
      runId: "run-drift",
      workspace: {
        workspaceId: base.workspace.workspaceId,
        cwd: base.workspace.cwd,
        isolation: base.workspace.isolation,
      },
      session: continuation.session,
    }),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "NATIVE_SESSION_BINDING_MISMATCH",
  );
});
