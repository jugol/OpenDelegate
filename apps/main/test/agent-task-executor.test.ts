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
  type DeviceSummaryV1,
  type TaskContinuationCheckpointV1,
} from "@opendelegate/protocol";
import { TaskExecutorError, type TaskExecutionRequest } from "@opendelegate/task-service";
import type { AgentExecutionProfile } from "@opendelegate/configuration";

import {
  AgentBackedTaskExecutor,
  EventStoreMainNativeSessionRepository,
} from "../src/agent-task-executor.ts";
import { resolveCoordinatorSessionBinding } from "../src/coordinator-agent-profile.ts";

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

test("Coordinator profile pins an exact model for a new Task while its existing session retains that model", async () => {
  const adapter = new FakeAgentAdapter();
  let profile: AgentExecutionProfile = {
    schemaVersion: 1,
    mode: "pinned",
    primary: {
      provider: "generic",
      adapterId: "fixture-main-agent",
      modelId: "fixture-opus",
    },
  };
  let resolutions = 0;
  const executor = new AgentBackedTaskExecutor({
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
    resolveNewSessionBinding: async () => {
      resolutions += 1;
      return resolveCoordinatorSessionBinding(profile, adapter);
    },
  });

  await executor.execute(request(1));
  profile = {
    schemaVersion: 1,
    mode: "pinned",
    primary: {
      provider: "generic",
      adapterId: "fixture-main-agent",
      modelId: "fixture-sonnet",
    },
  };
  await executor.execute(request(2, "Continue the existing Task."));

  assert.equal(resolutions, 1);
  assert.equal(adapter.starts[0]?.modelId, "fixture-opus");
  assert.equal(adapter.resumes[0]?.modelId, "fixture-opus");
  assert.equal(adapter.resumes[0]?.session.modelId, "fixture-opus");
});

test("Coordinator profile fails closed when it selects a different active adapter", async () => {
  const adapter = new FakeAgentAdapter();
  const profile: AgentExecutionProfile = {
    schemaVersion: 1,
    mode: "pinned",
    primary: {
      provider: "codex",
      adapterId: "codex-app-server",
      modelId: "gpt-5.6-sol",
    },
  };

  await assert.rejects(resolveCoordinatorSessionBinding(profile, adapter), {
    code: "MAIN_AGENT_PROFILE_UNAVAILABLE",
    retryable: true,
    retryKind: "resource",
  });
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
  const plannedWorkOrderId = planned.plan.workOrders[0]?.workOrderId;
  assert.match(plannedWorkOrderId ?? "", /^work_[0-9a-f]{16}_001$/u);
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
    reports: [{ ...releaseWorkerReport(), workOrderId: plannedWorkOrderId ?? "missing" }],
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

test("Main Agent scopes repeated plan-local Work Order labels to the owner-input cycle", async () => {
  const planId = async (planningKey: string): Promise<string> => {
    const reasoner = new AgentBackedTaskExecutor({
      adapter: new FakeAgentAdapter("orchestration"),
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
    const decision = await reasoner.plan({
      task: request(1).task,
      attempt: 1,
      executionKey: planningKey,
      signal: new AbortController().signal,
    });
    assert.equal(decision.state, "ready");
    if (decision.state !== "ready") {
      assert.fail("Expected a ready Work Order plan.");
    }
    return decision.plan.workOrders[0]?.workOrderId ?? "missing";
  };

  const firstCycle = await planId("task-execution:task_release:cycle:cycle_1:attempt:1");
  const repeatedFirstCycle = await planId("task-execution:task_release:cycle:cycle_1:attempt:1");
  const secondCycle = await planId("task-execution:task_release:cycle:cycle_2:attempt:1");

  assert.equal(repeatedFirstCycle, firstCycle);
  assert.notEqual(secondCycle, firstCycle);

  const dependencyReasoner = new AgentBackedTaskExecutor({
    adapter: new FakeAgentAdapter("orchestration-dependencies"),
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
  const dependencyPlan = await dependencyReasoner.plan({
    task: request(1).task,
    attempt: 1,
    executionKey: "task-execution:task_release:cycle:cycle_dependencies:attempt:1",
    signal: new AbortController().signal,
  });
  assert.equal(dependencyPlan.state, "ready");
  if (dependencyPlan.state !== "ready") {
    assert.fail("Expected a ready dependency plan.");
  }
  assert.deepEqual(dependencyPlan.plan.workOrders[1]?.dependsOn, [
    dependencyPlan.plan.workOrders[0]?.workOrderId,
  ]);
});

test("Main Agent answers read-only Device questions from the bounded Main-owned directory", async () => {
  const adapter = new FakeAgentAdapter("device-directory-answer");
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
    deviceDirectory: {
      list: async () => [
        {
          deviceId: "device_main",
          name: "NAS Main",
          osFamily: "linux",
          platformRelease: "26",
          architecture: "x64",
          role: "main",
          connection: "online",
          runtime: "healthy",
          serviceMode: "system-service",
          roles: ["main-coordinator"],
          capabilities: [
            { name: "codex", verification: "verified" },
            { name: "UNVERIFIED_CAPABILITY_SENTINEL", verification: "detected" },
          ],
          instructions: ["PRIVATE_DEVICE_INSTRUCTION_SENTINEL"],
          routes: [
            {
              routeId: "main-local:device_main",
              label: "Main-local",
              priority: 0,
              health: "healthy",
            },
          ],
          knowledgeHealth: "healthy",
        },
        {
          deviceId: "device_mac",
          name: "Mac Studio",
          osFamily: "macos",
          platformRelease: "26",
          architecture: "arm64",
          role: "worker",
          connection: "offline",
          runtime: "unavailable",
          serviceMode: "user-service",
          roles: ["build"],
          knowledgeHealth: "unknown",
        },
      ],
    },
  });
  const controller = new AbortController();
  const baseTask = request(1).task;
  const task = {
    ...baseTask,
    objective: "test 를 위한 task",
    completionCriteria: ["The current Device availability is reported."],
    constraints: [],
    messages: [
      {
        messageId: "message_device_question",
        role: "owner" as const,
        content: "지금 접속 가능한 디바이스가 뭐뭐가 있어?",
        occurredAt: NOW,
      },
    ],
  };

  const result = await reasoner.plan({
    task,
    attempt: 1,
    executionKey: "task-execution:task_release:cycle:cycle_1:attempt:1",
    signal: controller.signal,
  });

  assert.equal(result.state, "completed");
  if (result.state !== "completed") {
    throw new Error("The deterministic Device query did not complete.");
  }
  assert.match(result.publicMessage, /현재 등록된 기기 2대 중 1대/u);
  assert.match(result.publicMessage, /NAS Main — 접속 가능/u);
  assert.match(result.publicMessage, /Mac Studio — 오프라인/u);
  assert.doesNotMatch(result.publicMessage, /PRIVATE_DEVICE_INSTRUCTION_SENTINEL/u);
  assert.deepEqual(result.verifiedCompletionCriteria, [
    "The current Device availability is reported.",
  ]);
  assert.equal(adapter.starts.length, 0);
  assert.equal(
    reasoner.authorize({
      task,
      executionKey: "task-execution:task_release:cycle:cycle_1:attempt:1",
      decision: result,
    }),
    true,
  );

  const liveForumResult = await reasoner.plan({
    task: {
      ...task,
      objective:
        "현재 온라인이고 작업을 받을 수 있는 장치들을 OS와 검증된 주요 capability만 간단히 알려줘. 파일, 서비스, 계정, 권한, 설정, 네트워크 또는 외부 시스템은 변경하지 마.",
      completionCriteria: ["Complete the requested work and report the observable result."],
      messages: [],
    },
    attempt: 1,
    executionKey: "task-execution:task_release:cycle:cycle_live_forum:attempt:1",
    signal: controller.signal,
  });

  assert.equal(liveForumResult.state, "completed");
  assert.match(
    liveForumResult.state === "completed" ? liveForumResult.publicMessage : "",
    /현재 등록된 기기 2대 중 1대/u,
  );
  assert.match(
    liveForumResult.state === "completed" ? liveForumResult.publicMessage : "",
    /codex/u,
  );
  assert.doesNotMatch(
    liveForumResult.state === "completed" ? liveForumResult.publicMessage : "",
    /UNVERIFIED_CAPABILITY_SENTINEL/u,
  );
  assert.equal(adapter.starts.length, 0);

  const liveForumFollowUp = await reasoner.plan({
    task: {
      ...task,
      objective:
        "현재 온라인이고 작업을 받을 수 있는 장치들을 OS와 검증된 주요 capability만 간단히 알려줘. 파일, 서비스, 계정, 권한, 설정, 네트워크 또는 외부 시스템은 변경하지 마.",
      completionCriteria: ["Complete the requested work and report the observable result."],
      messages: [
        {
          messageId: "message_live_forum_starter",
          role: "owner" as const,
          content:
            "현재 온라인이고 작업을 받을 수 있는 장치들을 OS와 검증된 주요 capability만 간단히 알려줘. 파일, 서비스, 계정, 권한, 설정, 네트워크 또는 외부 시스템은 변경하지 마.",
          occurredAt: NOW,
        },
        {
          messageId: "message_live_forum_first_follow_up",
          role: "owner" as const,
          content: "지금 접속 가능한 장치 목록을 다시 알려줘.",
          occurredAt: NOW,
        },
        {
          messageId: "message_live_forum_latest_follow_up",
          role: "owner" as const,
          content:
            "지금 접속 가능한 장치 목록을 다시 알려줘. 파일, 서비스, 계정, 권한, 설정, 네트워크 또는 외부 시스템은 변경하지 마.",
          occurredAt: NOW,
        },
      ],
    },
    attempt: 1,
    executionKey: "task-execution:task_release:cycle:cycle_live_forum_follow_up:attempt:1",
    signal: controller.signal,
  });

  assert.equal(liveForumFollowUp.state, "completed");
  assert.match(
    liveForumFollowUp.state === "completed" ? liveForumFollowUp.publicMessage : "",
    /현재 등록된 기기 2대 중 1대/u,
  );
  assert.equal(adapter.starts.length, 0);

  await assert.rejects(
    reasoner.plan({
      task: {
        ...task,
        objective: "현재 온라인이고 작업을 받을 수 있는 장치들을 알려줘. 그리고 파일을 삭제해줘.",
        completionCriteria: ["Complete the requested work and report the observable result."],
        messages: [],
      },
      attempt: 1,
      executionKey: "task-execution:task_release:cycle:cycle_compound_forum:attempt:1",
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof TaskExecutorError && error.code === "WORK_PLAN_INVALID",
  );
  assert.equal(adapter.starts.length, 1);
});

test("Main Agent answers a named Device reachability question without spending an Agent turn", async () => {
  const adapter = new FakeAgentAdapter("device-directory-answer");
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
    deviceDirectory: {
      list: async () => [
        {
          deviceId: "Windows_5090",
          name: "5090White",
          osFamily: "windows",
          platformRelease: "10.0.26100",
          architecture: "x64",
          role: "worker",
          connection: "offline",
          runtime: "unavailable",
          serviceMode: "foreground",
          lastObservation: {
            observedAtMs: Date.parse("2026-08-02T21:57:21.440Z"),
            acceptedAtMs: Date.parse("2026-08-02T21:57:21.440Z"),
            source: "authenticated-heartbeat",
          },
          routes: [
            {
              routeId: "worker-wss:Windows_5090",
              label: "Worker WSS",
              priority: 0,
              health: "unhealthy",
            },
          ],
          knowledgeHealth: "unknown",
        },
      ],
    },
  });
  const baseTask = request(1).task;
  const task = {
    ...baseTask,
    objective: "지금 5090에 연결 가능한가?",
    completionCriteria: ["The named Device reachability is reported."],
    constraints: [],
    messages: [],
  };

  const result = await reasoner.plan({
    task,
    attempt: 1,
    executionKey: "task-execution:task_release:cycle:cycle_named:attempt:1",
    signal: new AbortController().signal,
  });

  assert.equal(result.state, "completed");
  if (result.state !== "completed") {
    throw new Error("The named Device query did not complete deterministically.");
  }
  assert.match(result.publicMessage, /5090White에는 현재 OpenDelegate로 접속할 수 없습니다/u);
  assert.match(result.publicMessage, /foreground/u);
  assert.match(result.publicMessage, /2026-08-02T21:57:21.440Z/u);
  assert.match(result.publicMessage, /Worker WSS — unhealthy/u);
  assert.equal(adapter.starts.length, 0);

  const routeResult = await reasoner.plan({
    task: {
      ...task,
      messages: [
        {
          messageId: "message_named_device_route_question",
          role: "owner",
          content: "ssh로도 연결안돼?",
          occurredAt: NOW,
        },
      ],
    },
    attempt: 1,
    executionKey: "task-execution:task_release:cycle:cycle_route:attempt:1",
    signal: new AbortController().signal,
  });
  assert.equal(routeResult.state, "completed");
  if (routeResult.state !== "completed") {
    throw new Error("The named Device route follow-up did not complete deterministically.");
  }
  assert.match(routeResult.publicMessage, /등록된 SSH 실행 경로는 없습니다/u);
  assert.equal(adapter.starts.length, 0);

  await assert.rejects(
    reasoner.plan({
      task: {
        ...task,
        objective: "Delete production files after checking the Device.",
        messages: [
          {
            messageId: "message_compound_named_device_question",
            role: "owner",
            content: "지금 5090에 연결 가능한가?",
            occurredAt: NOW,
          },
        ],
      },
      attempt: 1,
      executionKey: "task-execution:task_release:cycle:cycle_compound:attempt:1",
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof TaskExecutorError && error.code === "WORK_PLAN_INVALID",
  );
  assert.equal(adapter.starts.length, 1);
});

test("Main planning exposes only verified capabilities and never Device instructions", async () => {
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
    deviceDirectory: {
      list: async () => [
        {
          deviceId: "device_worker",
          name: "Build Worker",
          osFamily: "windows",
          platformRelease: "26",
          architecture: "x64",
          role: "worker",
          connection: "online",
          runtime: "healthy",
          serviceMode: "system-service",
          instructions: ["PRIVATE_DEVICE_INSTRUCTION_SENTINEL"],
          capabilities: [
            { name: "codex", verification: "verified" },
            { name: "UNVERIFIED_CAPABILITY_SENTINEL", verification: "detected" },
            { name: "DEGRADED_CAPABILITY_SENTINEL", verification: "degraded" },
          ],
          workspaceIds: ["workspace-build"],
          wakeOnLan: {
            targetState: "enabled",
            automaticWakeState: "relay-required",
            source: "windows-netadapter-power",
            observedAtMs: 9_900,
          },
          knowledgeHealth: "healthy",
        },
      ],
    },
  });

  const planned = await reasoner.plan({
    task: request(1).task,
    attempt: 1,
    executionKey: "verified-capability-planning",
    signal: new AbortController().signal,
  });

  assert.equal(planned.state, "ready");
  const prompt = adapter.starts[0]?.prompt ?? "";
  assert.match(prompt, /"capabilities":\["codex"\]/u);
  assert.match(prompt, /"workspaceIds":\["workspace-build"\]/u);
  assert.match(prompt, /multiple Workspaces require an explicit choice/u);
  assert.match(
    prompt,
    /"wakeOnLan":\{"targetState":"enabled","automaticWakeState":"relay-required","observedAtMs":9900\}/u,
  );
  assert.match(prompt, /must not claim that it can wake the Device/u);
  assert.doesNotMatch(prompt, /UNVERIFIED_CAPABILITY_SENTINEL/u);
  assert.doesNotMatch(prompt, /DEGRADED_CAPABILITY_SENTINEL/u);
  assert.doesNotMatch(prompt, /PRIVATE_DEVICE_INSTRUCTION_SENTINEL/u);
});

test("Main Device queries fail closed when their directory is unavailable or already cancelled", async () => {
  let directoryCalls = 0;
  const createReasoner = (list: () => Promise<readonly DeviceSummaryV1[]>) =>
    new AgentBackedTaskExecutor({
      adapter: new FakeAgentAdapter(),
      sessionRepository: new EventStoreMainNativeSessionRepository(
        new InMemoryEventStore({ clock: { now: () => NOW } }),
      ),
      checkpoints: checkpointProvider(),
      deviceId: "device_main",
      workspace: {
        workspaceId: "workspace_main_coordinator",
        cwd: process.cwd(),
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: { mode: "deny" },
      limits,
      deviceDirectory: { list },
    });
  const baseTask = request(1).task;
  const queryTask = {
    ...baseTask,
    objective: "Which Devices are reachable now?",
    constraints: [],
    messages: [
      {
        messageId: "message_device_query",
        role: "owner" as const,
        content: "Which Devices are reachable now?",
        occurredAt: NOW,
      },
    ],
  };
  const unavailable = createReasoner(async () => {
    directoryCalls += 1;
    throw new Error("private backend detail");
  });
  await assert.rejects(
    unavailable.plan({
      task: queryTask,
      attempt: 1,
      executionKey: "unavailable-device-directory",
      signal: new AbortController().signal,
    }),
    { code: "MAIN_CONTEXT_UNAVAILABLE" },
  );

  const controller = new AbortController();
  controller.abort("owner-cancelled");
  const cancelled = createReasoner(async () => {
    directoryCalls += 1;
    return [];
  });
  await assert.rejects(
    cancelled.plan({
      task: queryTask,
      attempt: 1,
      executionKey: "cancelled-device-directory",
      signal: controller.signal,
    }),
    { code: "EXECUTION_CANCELLED" },
  );
  const compound = createReasoner(async () => {
    directoryCalls += 1;
    return [];
  });
  assert.equal(
    await compound.planDeterministically({
      task: {
        ...queryTask,
        objective: "Prepare and deploy the release.",
      },
      attempt: 1,
      executionKey: "compound-side-effect-device-query",
      signal: new AbortController().signal,
    }),
    undefined,
  );
  assert.equal(directoryCalls, 1);
});

function request(attempt: number, ownerMessage?: string): TaskExecutionRequest {
  const controller = new AbortController();
  return {
    attempt,
    executionKey: `task-execution:task_release:attempt:${attempt}`,
    planningKey: "task-execution:task_release:attempt:1",
    resourceResume: false,
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
  | "orchestration-dependencies"
  | "device-directory-answer"
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

  async listModels() {
    return {
      observedAt: NOW,
      models: [
        {
          modelId: "fixture-opus",
          displayName: "Fixture Opus",
          isDefault: true,
          supportedEfforts: ["medium", "high"],
        },
        { modelId: "fixture-sonnet", displayName: "Fixture Sonnet" },
      ],
    };
  }

  async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    if (this.#mode === "orchestration-dependencies") {
      return handle(session(input), {
        schemaVersion: 1,
        state: "ready",
        plan: {
          protocolVersion: "v1",
          taskId: input.taskId,
          workOrders: [
            releaseWorkOrder(),
            {
              ...releaseWorkOrder(),
              workOrderId: "work_release_report",
              title: "Report the release",
              dependsOn: ["work_release_build"],
            },
          ],
        },
      });
    }
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
              : this.#mode === "device-directory-answer"
                ? {
                    schemaVersion: 1,
                    state: "completed",
                    publicMessage: "NAS Main is online. Mac Studio is currently offline.",
                    verifiedCompletionCriteria: ["The current Device availability is reported."],
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
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
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

test("Coordinator profile resolves an advertised effort and fails closed on one that is not", async () => {
  const adapter = new FakeAgentAdapter();

  const pinnedWithEffort = await resolveCoordinatorSessionBinding(
    {
      schemaVersion: 1,
      mode: "pinned",
      primary: {
        provider: "generic",
        adapterId: "fixture-main-agent",
        modelId: "fixture-opus",
        effort: "high",
      },
    },
    adapter,
  );
  assert.deepEqual(pinnedWithEffort, { modelId: "fixture-opus", effort: "high" });

  // Auto leaves tuning to the provider rather than inventing one.
  assert.deepEqual(
    await resolveCoordinatorSessionBinding({ schemaVersion: 1, mode: "auto" }, adapter),
    {
      modelId: "fixture-opus",
    },
  );

  // Prefer skips a binding whose effort the model does not advertise.
  const preferred = await resolveCoordinatorSessionBinding(
    {
      schemaVersion: 1,
      mode: "prefer",
      primary: {
        provider: "generic",
        adapterId: "fixture-main-agent",
        modelId: "fixture-opus",
        effort: "ultra",
      },
      fallbacks: [
        {
          provider: "generic",
          adapterId: "fixture-main-agent",
          modelId: "fixture-opus",
          effort: "medium",
        },
      ],
    },
    adapter,
  );
  assert.deepEqual(preferred, { modelId: "fixture-opus", effort: "medium" });

  // Pinned to an unadvertised effort stops instead of dropping the tuning.
  await assert.rejects(
    resolveCoordinatorSessionBinding(
      {
        schemaVersion: 1,
        mode: "pinned",
        primary: {
          provider: "generic",
          adapterId: "fixture-main-agent",
          modelId: "fixture-opus",
          effort: "ultra",
        },
      },
      adapter,
    ),
    { code: "MAIN_AGENT_PROFILE_UNAVAILABLE" },
  );
});
