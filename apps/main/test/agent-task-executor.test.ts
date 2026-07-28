import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";

import {
  type AgentAdapter,
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentStartRequest,
  type NativeSessionReference,
  type NormalizedAgentEvent,
} from "@opendelegate/agent-adapters";
import { InMemoryEventStore } from "@opendelegate/event-store";
import {
  createTaskContinuationCheckpoint,
  type TaskContinuationCheckpointV1,
} from "@opendelegate/protocol";
import type { TaskExecutionRequest } from "@opendelegate/task-service";

import {
  AgentBackedTaskExecutor,
  EventStoreMainNativeSessionRepository,
} from "../src/agent-task-executor.ts";

const NOW = "2026-07-25T12:00:00.000Z";
const limits = {
  wallTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  cancellationGraceMs: 100,
  leaseTtlMs: 1_000,
  leaseRenewIntervalMs: 250,
  maxBufferedEvents: 8,
  maxLineBytes: 64 * 1024,
  maxDiagnosticBytes: 64 * 1024,
};

test("Main Agent starts once per Task, resumes its exact native session, and parses public results", async () => {
  const adapter = new FakeAgentAdapter();
  const repository = new EventStoreMainNativeSessionRepository(
    new InMemoryEventStore({ clock: { now: () => NOW } }),
  );
  const executor = new AgentBackedTaskExecutor({
    adapter,
    sessionRepository: repository,
    checkpoints: checkpointProvider(),
    deviceId: "device_main",
    workspace: {
      workspaceId: "workspace_main_coordinator",
      cwd: await realpath("."),
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });

  const first = await executor.execute(request(1));
  const second = await executor.execute(request(2, "Use the owner follow-up."));

  assert.deepEqual(first, {
    state: "waiting_user",
    publicMessage: "Which release channel should I use?",
  });
  assert.deepEqual(second, {
    state: "review",
    publicMessage: "The release evidence is verified.",
  });
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.resumes.length, 1);
  assert.equal(adapter.resumes[0]?.session.nativeSessionId, "native-task-session");
  assert.equal(adapter.starts[0]?.taskId, "task_release");
  assert.equal(adapter.starts[0]?.workstreamId, "coordinator");
  assert.match(adapter.resumes[0]?.prompt ?? "", /\[owner\] Use the owner follow-up\./);
  assert.doesNotMatch(adapter.resumes[0]?.prompt ?? "", /OLD_NATIVE_CONTEXT_SENTINEL/);
  assert.doesNotMatch(adapter.resumes[0]?.prompt ?? "", /task_unrelated/);
  assert.doesNotMatch(adapter.resumes[0]?.prompt ?? "", /verifiedCompletionCriteria/);
  assert.match(
    adapter.resumes[0]?.prompt ?? "",
    /Worker Run reports are the only authority for execution side effects/,
  );
});

test("Main Agent cannot self-authorize Task completion and preserves Task isolation", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const repository = new EventStoreMainNativeSessionRepository(eventStore);
  const adapter = new FakeAgentAdapter("invalid-completion");
  const executor = new AgentBackedTaskExecutor({
    adapter,
    sessionRepository: repository,
    checkpoints: checkpointProvider(),
    deviceId: "device_main",
    workspace: {
      workspaceId: "workspace_main_coordinator",
      cwd: await realpath("."),
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });

  await assert.rejects(executor.execute(request(1)), {
    code: "COORDINATOR_RESULT_INVALID",
  });

  const firstSession = await repository.load("task:task_release:coordinator:fixture-main-agent");
  assert.equal(firstSession?.taskId, "task_release");
  assert.equal(
    await repository.load("task:task_unrelated:coordinator:fixture-main-agent"),
    undefined,
  );
});

test("Main Agent must ask exactly one targeted owner question", async () => {
  const executor = new AgentBackedTaskExecutor({
    adapter: new FakeAgentAdapter("multiple-questions"),
    sessionRepository: new EventStoreMainNativeSessionRepository(
      new InMemoryEventStore({ clock: { now: () => NOW } }),
    ),
    checkpoints: checkpointProvider(),
    deviceId: "device_main",
    workspace: {
      workspaceId: "workspace_main_coordinator",
      cwd: await realpath("."),
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });

  await assert.rejects(executor.execute(request(1)), {
    code: "COORDINATOR_RESULT_INVALID",
  });
});

test("Main Agent result parsing does not guess intent from Device words", async () => {
  const executor = new AgentBackedTaskExecutor({
    adapter: new FakeAgentAdapter("placement-question"),
    sessionRepository: new EventStoreMainNativeSessionRepository(
      new InMemoryEventStore({ clock: { now: () => NOW } }),
    ),
    checkpoints: checkpointProvider(),
    deviceId: "device_main",
    workspace: {
      workspaceId: "workspace_main_coordinator",
      cwd: await realpath("."),
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });

  assert.deepEqual(await executor.execute(request(1)), {
    state: "waiting_user",
    publicMessage: "Would you like this built by the Mac or Windows worker?",
  });
});

test("Main Agent may clarify an OS requirement that changes the requested outcome", async () => {
  const executor = new AgentBackedTaskExecutor({
    adapter: new FakeAgentAdapter("outcome-platform-question"),
    sessionRepository: new EventStoreMainNativeSessionRepository(
      new InMemoryEventStore({ clock: { now: () => NOW } }),
    ),
    checkpoints: checkpointProvider(),
    deviceId: "device_main",
    workspace: {
      workspaceId: "workspace_main_coordinator",
      cwd: await realpath("."),
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });

  assert.deepEqual(await executor.execute(request(1)), {
    state: "waiting_user",
    publicMessage: "Which operating systems must the release support?",
  });
});

test("Main Agent creates an explicit checkpoint continuation when resume is deterministically unavailable", async () => {
  const adapter = new FakeAgentAdapter();
  const repository = new EventStoreMainNativeSessionRepository(
    new InMemoryEventStore({ clock: { now: () => NOW } }),
  );
  const executor = new AgentBackedTaskExecutor({
    adapter,
    sessionRepository: repository,
    checkpoints: checkpointProvider("Continue from the durable checkpoint."),
    deviceId: "device_main",
    workspace: {
      workspaceId: "workspace_main_coordinator",
      cwd: await realpath("."),
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });

  await executor.execute(request(1));
  adapter.resumeAvailable = false;
  const restarted = new AgentBackedTaskExecutor({
    adapter,
    sessionRepository: repository,
    checkpoints: checkpointProvider("Continue from the durable checkpoint."),
    deviceId: "device_main",
    workspace: {
      workspaceId: "workspace_main_coordinator",
      cwd: await realpath("."),
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });
  await restarted.execute(request(2, "THIS-REQUEST-OBJECT-MUST-NOT-BE-THE-CHECKPOINT"));

  assert.equal(adapter.resumes.length, 0);
  assert.equal(adapter.starts.length, 2);
  const continuation = adapter.starts[1];
  assert.equal(continuation?.continuationOf?.nativeSessionId, "native-task-session");
  assert.equal(continuation?.continuationReason, "native-session-resume-unavailable");
  assert.match(continuation?.prompt ?? "", /Durable checkpoint continuation package/u);
  assert.match(continuation?.prompt ?? "", /Continue from the durable checkpoint\./u);
  assert.match(
    continuation?.prompt ?? "",
    /The owner specifies the outcome, not Device placement/u,
  );
  assert.match(continuation?.prompt ?? "", /never invent a handoff URL/u);
  assert.doesNotMatch(
    continuation?.prompt ?? "",
    /THIS-REQUEST-OBJECT-MUST-NOT-BE-THE-CHECKPOINT/u,
  );
  assert.match(continuation?.prompt ?? "", /"checkpointHash":"sha256:[0-9a-f]{64}"/u);

  const stored = await repository.load("task:task_release:coordinator:fixture-main-agent");
  assert.equal(stored?.nativeSessionId, "native-task-session-continuation");
  assert.equal(stored?.lineage.parentNativeSessionId, "native-task-session");
  assert.equal(stored?.lineage.continuationReason, "native-session-resume-unavailable");
});

test("outcome-first rules survive planning and verification checkpoint continuation", async () => {
  for (const turn of ["planning", "verification"] as const) {
    const adapter = new FakeAgentAdapter("outcome-continuation");
    adapter.resumeAvailable = false;
    const repository = new EventStoreMainNativeSessionRepository(
      new InMemoryEventStore({ clock: { now: () => NOW } }),
    );
    const cwd = await realpath(".");
    await repository.save(persistedCoordinatorSession(cwd));
    const executor = new AgentBackedTaskExecutor({
      adapter,
      sessionRepository: repository,
      checkpoints: checkpointProvider("Continue from the durable checkpoint."),
      deviceId: "device_main",
      workspace: {
        workspaceId: "workspace_main_coordinator",
        cwd,
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: { mode: "deny" },
      limits,
    });
    const task = request(2).task;
    const controller = new AbortController();

    if (turn === "planning") {
      const decision = await executor.plan({
        task,
        attempt: 2,
        executionKey: "task-execution:task_release:attempt:2",
        signal: controller.signal,
      });
      assert.equal(decision.state, "ready");
    } else {
      const result = await executor.verify({
        task,
        workOrders: [releaseWorkOrder()],
        reports: [releaseWorkerReport()],
        signal: controller.signal,
      });
      assert.equal(result.state, "completed");
    }

    const prompt = adapter.starts[0]?.prompt ?? "";
    assert.match(prompt, new RegExp(`continuing ${turn}`, "u"));
    assert.match(prompt, /The owner specifies the outcome, not Device placement/u);
    assert.match(prompt, /never invent a handoff URL/u);
    assert.equal(adapter.starts[0]?.continuationReason, "native-session-resume-unavailable");
  }
});

test("Main Agent plans Work Orders and verifies completion only from authoritative Worker reports", async () => {
  const adapter = new FakeAgentAdapter("orchestration");
  const reasoner = new AgentBackedTaskExecutor({
    adapter,
    sessionRepository: new EventStoreMainNativeSessionRepository(
      new InMemoryEventStore({ clock: { now: () => NOW } }),
    ),
    checkpoints: checkpointProvider(),
    deviceId: "device_main",
    workspace: {
      workspaceId: "workspace_main_coordinator",
      cwd: await realpath("."),
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
  });
  const task = request(1).task;
  const controller = new AbortController();

  const planned = await reasoner.plan({
    task,
    attempt: 1,
    executionKey: "task-execution:task_release:attempt:1",
    signal: controller.signal,
  });
  assert.equal(planned.state, "ready");
  if (planned.state !== "ready") {
    assert.fail("Expected a ready Work Order plan.");
  }
  assert.equal(planned.plan.taskId, task.taskId);
  assert.equal(planned.plan.workOrders[0]?.workOrderId, "work_release_build");
  assert.match(adapter.starts[0]?.prompt ?? "", /Return a bounded Work Order plan/u);
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /The owner specifies the outcome, not Device placement/u,
  );
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /Treat Device, OS, route, Agent provider, and multi-Device selection as internal orchestration/u,
  );
  assert.match(adapter.starts[0]?.prompt ?? "", /privacy or data locality.*physical/isu);
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /login, MFA, CAPTCHA, legal confirmation, or OS permission/u,
  );
  assert.match(adapter.starts[0]?.prompt ?? "", /never invent a handoff URL/u);

  const verified = await reasoner.verify({
    task,
    workOrders: planned.plan.workOrders,
    reports: [releaseWorkerReport()],
    signal: controller.signal,
  });
  assert.deepEqual(verified, {
    state: "completed",
    publicMessage: "The authoritative Worker evidence satisfies the Task.",
    verifiedCompletionCriteria: ["Every release gate is verified."],
  });
  assert.equal(adapter.resumes.length, 1);
  assert.match(
    adapter.resumes[0]?.prompt ?? "",
    /The Worker built the release and attached the test evidence\./u,
  );
  assert.match(adapter.resumes[0]?.prompt ?? "", /run_release_build/u);
  assert.match(
    adapter.resumes[0]?.prompt ?? "",
    /You cannot manufacture, alter, or infer execution evidence/u,
  );
  assert.match(
    adapter.resumes[0]?.prompt ?? "",
    /Discord summary, file, Artifact, hosted result, or Git reference/u,
  );
});

function request(attempt: number, ownerMessage?: string): TaskExecutionRequest {
  const controller = new AbortController();
  return {
    attempt,
    executionKey: `task-execution:task_release:attempt:${attempt}`,
    signal: controller.signal,
    task: {
      taskId: "task_release",
      state: "running",
      mode: "auto",
      objective: "Prepare the release.",
      createdAt: NOW,
      updatedAt: NOW,
      version: attempt,
      completionCriteria: ["Every release gate is verified."],
      constraints: ["Do not waive external evidence."],
      selectedInputRefs: [],
      messages:
        ownerMessage === undefined
          ? []
          : [
              {
                messageId: `message_agent_${attempt}`,
                role: "agent",
                content: "OLD_NATIVE_CONTEXT_SENTINEL",
                occurredAt: NOW,
              },
              {
                messageId: `message_${attempt}`,
                role: "owner",
                content: ownerMessage,
                occurredAt: NOW,
              },
            ],
      events: [],
    },
  };
}

function checkpointProvider(latestMessage?: string): {
  build(taskId: string): Promise<TaskContinuationCheckpointV1>;
} {
  return {
    async build(taskId) {
      return createTaskContinuationCheckpoint({
        schemaVersion: 1,
        taskId,
        taskVersion: 2,
        summary: {
          state: "running",
          mode: "auto",
          objective: "Prepare the release.",
          rollingSummary: "The durable release Task is in progress.",
          completionCriteria: ["Every release gate is verified."],
          constraints: ["Do not waive external evidence."],
        },
        decisions: [],
        pendingWorkOrders: [],
        artifacts: [],
        messages:
          latestMessage === undefined
            ? []
            : [
                {
                  messageId: "message-checkpoint-owner",
                  role: "owner",
                  content: latestMessage,
                  occurredAt: NOW,
                },
              ],
        sessions: [],
        omitted: {
          completionCriteria: 0,
          constraints: 0,
          decisions: 0,
          pendingWorkOrders: 0,
          artifacts: 0,
          messages: 0,
          sessions: 0,
        },
      });
    },
  };
}

function releaseWorkOrder() {
  return {
    protocolVersion: "v1" as const,
    taskId: "task_release",
    workOrderId: "work_release_build",
    title: "Build the release",
    brief: "Build and test the requested release.",
    completionCriteria: ["The release build and tests succeed."],
    constraints: ["Do not waive release evidence."],
    selectedInputIds: [],
    dependsOn: [],
    schedulingHints: {
      preferredDeviceIds: [],
      preferredRoles: ["development"],
    },
    requiredCapabilities: ["codex"],
    requiredSecretRefs: [],
  };
}

function releaseWorkerReport() {
  return {
    taskId: "task_release",
    workOrderId: "work_release_build",
    deviceId: "device_worker",
    workerId: "worker_primary",
    routeId: "route_private",
    runId: "run_release_build",
    leaseId: "lease_release_build",
    fencingToken: 7,
    report: "The Worker built the release and attached the test evidence.",
    artifactIds: ["artifact_release_evidence"],
    acceptedAtMs: Date.parse(NOW),
  };
}

function persistedCoordinatorSession(cwd: string): NativeSessionReference {
  return {
    schemaVersion: 1,
    provider: "generic",
    adapterId: "fixture-main-agent",
    adapterVersion: "1.0.0",
    nativeSessionId: "native-task-session",
    sessionKey: "task:task_release:coordinator:fixture-main-agent",
    taskId: "task_release",
    workstreamId: "coordinator",
    deviceId: "device_main",
    workspaceId: "workspace_main_coordinator",
    cwd,
    lineage: { lineageId: "lineage-task-release" },
    createdAt: NOW,
  };
}

type FakeAgentMode =
  | "normal"
  | "invalid-completion"
  | "multiple-questions"
  | "placement-question"
  | "outcome-platform-question"
  | "orchestration"
  | "outcome-continuation";

class FakeAgentAdapter implements AgentAdapter {
  readonly adapterId = "fixture-main-agent";
  readonly provider = "generic" as const;
  readonly starts: AgentStartRequest[] = [];
  readonly resumes: AgentResumeRequest[] = [];
  readonly #mode: FakeAgentMode;
  resumeAvailable = true;

  constructor(mode: FakeAgentMode = "normal") {
    this.#mode = mode;
  }

  async probe() {
    return {
      contractVersion: 1 as const,
      adapterId: this.adapterId,
      provider: this.provider,
      installed: true,
      version: "1.0.0",
      compatibility: "tested" as const,
      auth: { state: "ready" as const },
      capabilities: {
        start: true,
        resume: this.resumeAvailable,
        streaming: true,
        cancellation: true,
        approvalBridge: true,
        steering: false,
        checkpointContinuation: true,
        workspaceIsolation: ["none" as const],
      },
      diagnostics: [],
    };
  }

  async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    if (this.#mode === "outcome-continuation") {
      const result = input.prompt.includes("continuing planning")
        ? {
            schemaVersion: 1,
            state: "ready",
            plan: {
              protocolVersion: "v1",
              taskId: input.taskId,
              workOrders: [releaseWorkOrder()],
            },
          }
        : input.prompt.includes("continuing verification")
          ? {
              schemaVersion: 1,
              state: "completed",
              publicMessage: "The authoritative Worker evidence satisfies the Task.",
              verifiedCompletionCriteria: ["Every release gate is verified."],
            }
          : {
              schemaVersion: 1,
              state: "waiting_user",
              ownerQuestion: "Which release channel should I use?",
            };
      return handle(session(input), result);
    }
    return handle(
      session(input),
      this.#mode === "invalid-completion"
        ? {
            schemaVersion: 1,
            state: "completed",
            publicMessage: "Trust me.",
            verifiedCompletionCriteria: ["Every release gate is verified."],
          }
        : this.#mode === "multiple-questions"
          ? {
              schemaVersion: 1,
              state: "waiting_user",
              ownerQuestion: "Which release channel should I use? Should it be signed?",
            }
          : this.#mode === "placement-question"
            ? {
                schemaVersion: 1,
                state: "waiting_user",
                ownerQuestion: "Would you like this built by the Mac or Windows worker?",
              }
            : this.#mode === "outcome-platform-question"
              ? {
                  schemaVersion: 1,
                  state: "waiting_user",
                  ownerQuestion: "Which operating systems must the release support?",
                }
              : this.#mode === "orchestration"
                ? {
                    schemaVersion: 1,
                    state: "ready",
                    plan: {
                      protocolVersion: "v1",
                      taskId: input.taskId,
                      workOrders: [
                        {
                          protocolVersion: "v1",
                          workOrderId: "work_release_build",
                          title: "Build the release",
                          brief: "Build and test the requested release.",
                          completionCriteria: ["The release build and tests succeed."],
                          constraints: ["Do not waive release evidence."],
                          selectedInputIds: [],
                          dependsOn: [],
                          schedulingHints: {
                            preferredDeviceIds: [],
                            preferredRoles: ["development"],
                          },
                          requiredCapabilities: ["codex"],
                          requiredSecretRefs: [],
                        },
                      ],
                    },
                  }
                : {
                    schemaVersion: 1,
                    state: "waiting_user",
                    ownerQuestion: "Which release channel should I use?",
                  },
    );
  }

  async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    return handle(
      input.session,
      this.#mode === "orchestration"
        ? {
            schemaVersion: 1,
            state: "completed",
            publicMessage: "The authoritative Worker evidence satisfies the Task.",
            verifiedCompletionCriteria: ["Every release gate is verified."],
          }
        : {
            schemaVersion: 1,
            state: "review",
            publicMessage: "The release evidence is verified.",
          },
    );
  }
}

function session(input: AgentStartRequest): NativeSessionReference {
  const continuation = input.continuationOf;
  if (continuation !== undefined && input.continuationReason === undefined) {
    throw new Error("The continuation fixture requires an explicit reason.");
  }
  return {
    schemaVersion: 1,
    provider: "generic",
    adapterId: "fixture-main-agent",
    adapterVersion: "1.0.0",
    nativeSessionId:
      continuation === undefined ? "native-task-session" : "native-task-session-continuation",
    sessionKey: input.sessionKey,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    deviceId: input.deviceId,
    workspaceId: input.workspace.workspaceId,
    cwd: input.workspace.cwd,
    lineage:
      continuation === undefined
        ? { lineageId: "lineage-task-release" }
        : {
            lineageId: "lineage-task-release-continuation",
            parentNativeSessionId: continuation.nativeSessionId,
            continuationReason: input.continuationReason ?? "unreachable",
          },
    createdAt: NOW,
  };
}

function handle(reference: NativeSessionReference, result: object): AgentRunHandle {
  const events: readonly NormalizedAgentEvent[] = [
    {
      sequence: 1,
      observedAt: NOW,
      type: "session_started",
      session: reference,
    },
  ];
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    result: Promise.resolve({
      status: "succeeded" as const,
      session: reference,
      finalText: JSON.stringify(result),
    }),
    async cancel() {
      return undefined;
    },
  };
}
