import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";

import {
  InMemorySessionLeaseStore,
  startProgrammaticTurn,
  type AgentRunLimits,
  type AgentStartRequest,
  type NativeSessionReference,
  type NormalizedAgentEvent,
} from "../src/index.ts";

const limits: AgentRunLimits = {
  wallTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  cancellationGraceMs: 50,
  leaseTtlMs: 500,
  leaseRenewIntervalMs: 100,
  maxBufferedEvents: 8,
  maxLineBytes: 64 * 1024,
  maxDiagnosticBytes: 4 * 1024,
};

async function request(overrides: Partial<AgentStartRequest> = {}): Promise<AgentStartRequest> {
  const cwd = await realpath(process.cwd());
  return {
    operation: "start",
    requestId: "request-sdk",
    runId: "run-sdk",
    taskId: "task-sdk",
    workstreamId: "implementation",
    sessionKey: "task-sdk/implementation",
    deviceId: "device-sdk",
    prompt: "Implement the task.",
    workspace: {
      workspaceId: "workspace-sdk",
      cwd,
      isolation: "none",
    },
    sandbox: "workspace-write",
    permissions: { mode: "allow-listed", allowedTools: ["Read", "Edit"] },
    limits,
    ...overrides,
  };
}

function session(nativeSessionId: string, input: AgentStartRequest): NativeSessionReference {
  return {
    schemaVersion: 1,
    provider: "codex",
    adapterId: "codex-app-server",
    adapterVersion: "0.145.0",
    nativeSessionId,
    sessionKey: input.sessionKey,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    deviceId: input.deviceId,
    workspaceId: input.workspace.workspaceId,
    cwd: input.workspace.cwd,
    lineage: { lineageId: "lineage-sdk" },
    createdAt: "2026-07-25T00:00:00.000Z",
  };
}

async function drain(
  handle: Awaited<ReturnType<typeof startProgrammaticTurn>>,
): Promise<NormalizedAgentEvent[]> {
  const events: NormalizedAgentEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  return events;
}

test("programmatic lifecycle fences a session and normalizes a successful streamed turn", async () => {
  const input = await request();
  const handle = await startProgrammaticTurn({
    request: input,
    leaseStore: new InMemorySessionLeaseStore(),
    now: () => Date.parse("2026-07-25T00:00:00.000Z"),
    createSession: (nativeSessionId) => session(nativeSessionId, input),
    run: async ({ emit }) => {
      await emit({ kind: "session", nativeSessionId: "thread-sdk" });
      await emit({ kind: "message_delta", text: "Working" });
      await emit({ kind: "public_message", text: "Done" });
      return {
        status: "succeeded",
        nativeSessionId: "thread-sdk",
        finalText: "Done",
      };
    },
  });
  const events = await drain(handle);
  const result = await handle.result;

  assert.equal(result.status, "succeeded");
  assert.equal(result.session?.nativeSessionId, "thread-sdk");
  assert.equal(result.finalText, "Done");
  assert.deepEqual(
    events.map((event) => event.type),
    ["session_started", "message_delta", "public_message", "completed"],
  );
});

test("programmatic lifecycle aborts the provider and reports owner cancellation", async () => {
  const input = await request({ runId: "run-cancel" });
  const handle = await startProgrammaticTurn({
    request: input,
    leaseStore: new InMemorySessionLeaseStore(),
    now: Date.now,
    createSession: (nativeSessionId) => session(nativeSessionId, input),
    run: async ({ emit, signal }) => {
      await emit({ kind: "session", nativeSessionId: "thread-cancel" });
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw signal.reason;
    },
  });
  const eventsPromise = drain(handle);
  await handle.cancel("owner cancelled");
  const events = await eventsPromise;
  const result = await handle.result;

  assert.equal(result.status, "cancelled");
  assert.equal(result.error?.code, "ADAPTER_CANCELLED");
  assert.ok(events.some((event) => event.type === "completed" && event.status === "cancelled"));
});
