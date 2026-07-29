import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventStore } from "@opendelegate/event-store";
import type { SequencedWorkerEventV1, WorkerRunAssignmentV1 } from "@opendelegate/protocol";
import {
  PROTOCOL_VERSION,
  createTaskContinuationCheckpoint,
  type WorkOrderV1,
} from "@opendelegate/protocol";

import {
  AuthoritativeWorkerTaskExecutor,
  DurableTaskBudgetEnforcer,
  TaskExecutionCoordinator,
  TaskExecutorError,
  TaskService,
  type AuthoritativeWorkerReport,
  type TaskExecutionRequest,
  type WorkerRunDispatchPort,
} from "../src/index.ts";

const NOW_MS = Date.parse("2026-07-25T12:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();

test("only current leased Worker reports can authorize Task completion", async () => {
  const clock = mutableClock(NOW_MS);
  const dispatch = new RecordingDispatchPort();
  const verificationInputs: AuthoritativeWorkerReport[][] = [];
  const executor = new AuthoritativeWorkerTaskExecutor({
    clock,
    eventStore: new InMemoryEventStore({
      clock: { now: () => new Date(clock.now()).toISOString() },
    }),
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    checkpoints: {
      async build(taskId) {
        return checkpoint(taskId, "work-order-build");
      },
    },
    planner: {
      async plan(input) {
        return {
          state: "ready",
          plan: {
            protocolVersion: PROTOCOL_VERSION,
            taskId: input.task.taskId,
            workOrders: [workOrder("work-order-build")],
          },
        };
      },
    },
    targetResolver: {
      async resolve() {
        return {
          deviceId: "device-worker-1",
          workerId: "worker-1",
          routeId: "route-private-1",
        };
      },
    },
    dispatch,
    verifier: {
      async verify(input) {
        verificationInputs.push([...input.reports]);
        return {
          state: "completed",
          publicMessage: "The durable Worker evidence satisfies the Task.",
          verifiedCompletionCriteria: [...input.task.completionCriteria],
        };
      },
    },
  });

  const execution = executor.execute(request("attempt-1", 1));
  const assignment = await dispatch.nextAssignment();
  assert.equal(assignment.continuationCheckpoint?.taskId, assignment.taskId);
  assert.equal(
    assignment.continuationCheckpoint?.pendingWorkOrders[0]?.workOrderId,
    assignment.workOrder.workOrderId,
  );
  assert.equal(await isSettled(execution), false);
  assert.deepEqual(
    await executor.authorizeWorkerArtifactRun("device-worker-1", artifactRunScope(assignment)),
    {
      authorized: true,
      leaseExpiresAtMs: assignment.leaseExpiresAtMs,
    },
  );
  assert.deepEqual(
    await executor.authorizeWorkerActionRun("device-worker-1", artifactRunScope(assignment)),
    {
      authorized: true,
      leaseExpiresAtMs: assignment.leaseExpiresAtMs,
    },
  );
  assert.deepEqual(
    await executor.authorizeWorkerArtifactRun("device-worker-2", artifactRunScope(assignment)),
    { authorized: false },
  );

  assert.deepEqual(
    await executor.acceptWorkerEvents("device-worker-1", [
      {
        ...workerEvent(assignment, 1, "worker.run.claimed"),
        createdAt: "2026-07-25T21:00:00+09:00",
      },
      workerEvent(assignment, 2, "worker.run.succeeded", {
        artifactIds: ["artifact-release-report"],
        report: "Build and tests completed on the assigned Worker.",
      }),
    ]),
    [
      { disposition: "accepted", messageId: `${assignment.runId}:claimed` },
      { disposition: "accepted", messageId: `${assignment.runId}:succeeded` },
    ],
  );

  assert.deepEqual(await execution, {
    state: "completed",
    publicMessage: "The durable Worker evidence satisfies the Task.",
    verifiedCompletionCriteria: ["The requested result is proven."],
  });
  assert.equal(verificationInputs.length, 1);
  assert.equal(verificationInputs[0]?.[0]?.runId, assignment.runId);
  assert.equal(verificationInputs[0]?.[0]?.acceptedAtMs, NOW_MS);
  assert.deepEqual(
    await executor.authorizeWorkerArtifactRun("device-worker-1", artifactRunScope(assignment)),
    { authorized: false },
  );
});

test("a Main-owned read-only planning answer completes without inventing a Worker Run", async () => {
  let targetResolutionCalls = 0;
  let verificationCalls = 0;
  const dispatch = new RecordingDispatchPort();
  const authorizedDecisions = new WeakSet<object>();
  const executor = new AuthoritativeWorkerTaskExecutor({
    clock: mutableClock(NOW_MS),
    eventStore: new InMemoryEventStore({ clock: { now: () => NOW } }),
    idSource: sequentialIds(),
    planner: {
      async plan(input) {
        const decision = {
          state: "completed",
          publicMessage: "NAS Main is online. Mac Studio is currently offline.",
          verifiedCompletionCriteria: [...input.task.completionCriteria],
        } as const;
        authorizedDecisions.add(decision);
        return decision;
      },
    },
    directCompletionAuthorizer: {
      authorize: ({ decision }) => authorizedDecisions.has(decision),
    },
    targetResolver: {
      async resolve() {
        targetResolutionCalls += 1;
        return {
          deviceId: "device-worker-1",
          workerId: "worker-1",
          routeId: "route-private-1",
        };
      },
    },
    dispatch,
    verifier: {
      async verify(input) {
        verificationCalls += 1;
        return {
          state: "completed",
          verifiedCompletionCriteria: [...input.task.completionCriteria],
        };
      },
    },
  });

  assert.deepEqual(await executor.execute(request("device-directory", 1)), {
    state: "completed",
    publicMessage: "NAS Main is online. Mac Studio is currently offline.",
    verifiedCompletionCriteria: ["The requested result is proven."],
  });
  assert.equal(targetResolutionCalls, 0);
  assert.equal(verificationCalls, 0);
  assert.equal(dispatch.records.length, 0);
});

test("an upgraded deterministic read-only answer supersedes a stale semantic plan on retry", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const firstRequest = request("device-query-attempt-1", 1);
  const stalePlanner = new AuthoritativeWorkerTaskExecutor({
    clock: mutableClock(NOW_MS),
    eventStore,
    idSource: sequentialIds(),
    planner: fixedPlanner(),
    targetResolver: {
      async resolve() {
        throw new TaskExecutorError(
          "WORKER_OFFLINE",
          "No eligible Worker is online for this Work Order.",
          true,
        );
      },
    },
    dispatch: new RecordingDispatchPort(),
    verifier: fixedVerifier(),
  });
  await assert.rejects(stalePlanner.execute(firstRequest), { code: "WORKER_OFFLINE" });

  const authorizedDecisions = new WeakSet<object>();
  let semanticPlanningCalls = 0;
  let targetResolutionCalls = 0;
  const upgraded = new AuthoritativeWorkerTaskExecutor({
    clock: mutableClock(NOW_MS),
    eventStore,
    idSource: sequentialIds(),
    planner: {
      async planDeterministically(input) {
        const decision = {
          state: "completed",
          publicMessage: "NAS Main is online. Mac Studio is currently offline.",
          verifiedCompletionCriteria: [...input.task.completionCriteria],
        } as const;
        authorizedDecisions.add(decision);
        return decision;
      },
      async plan() {
        semanticPlanningCalls += 1;
        throw new Error("Semantic planning must not run for the upgraded direct query.");
      },
    },
    directCompletionAuthorizer: {
      authorize: ({ decision }) => authorizedDecisions.has(decision),
    },
    targetResolver: {
      async resolve() {
        targetResolutionCalls += 1;
        throw new Error("A direct read-only answer must not select a Worker.");
      },
    },
    dispatch: new RecordingDispatchPort(),
    verifier: fixedVerifier(),
  });
  const retryRequest = {
    ...request("device-query-attempt-2", 2),
    planningKey: firstRequest.planningKey,
  };

  assert.deepEqual(await upgraded.execute(retryRequest), {
    state: "completed",
    publicMessage: "NAS Main is online. Mac Studio is currently offline.",
    verifiedCompletionCriteria: ["The requested result is proven."],
  });
  assert.equal(semanticPlanningCalls, 0);
  assert.equal(targetResolutionCalls, 0);
});

test("an untrusted planner cannot complete side-effect work without Worker evidence", async () => {
  const executor = new AuthoritativeWorkerTaskExecutor({
    clock: mutableClock(NOW_MS),
    eventStore: new InMemoryEventStore({ clock: { now: () => NOW } }),
    idSource: sequentialIds(),
    planner: {
      async plan(input) {
        return {
          state: "completed" as const,
          publicMessage: "The requested files were deleted.",
          verifiedCompletionCriteria: [...input.task.completionCriteria],
        };
      },
    },
    targetResolver: fixedTargetResolver(),
    dispatch: new RecordingDispatchPort(),
    verifier: fixedVerifier(),
  });

  await assert.rejects(executor.execute(request("untrusted-direct-completion", 1)), {
    code: "WORK_PLAN_INVALID",
  });
});

function checkpoint(taskId: string, workOrderId: string) {
  return createTaskContinuationCheckpoint({
    schemaVersion: 1,
    taskId,
    taskVersion: 1,
    summary: {
      state: "running",
      mode: "auto",
      objective: "Prove the requested result.",
      rollingSummary: "The authoritative Worker Run is pending.",
      completionCriteria: ["The requested result is proven."],
      constraints: [],
    },
    decisions: [],
    pendingWorkOrders: [
      {
        workOrderId,
        title: "Build the result",
        brief: "Build and verify the requested result.",
        completionCriteria: ["The result is verified."],
        constraints: [],
        dependsOn: [],
        requiredCapabilities: [],
        omitted: {
          completionCriteria: 0,
          constraints: 0,
          dependsOn: 0,
          requiredCapabilities: 0,
        },
      },
    ],
    artifacts: [],
    messages: [],
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
}

test("retry uses a higher fence and rejects a late completion from the replaced Run", async () => {
  const clock = mutableClock(NOW_MS);
  const dispatch = new RecordingDispatchPort();
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(clock.now()).toISOString() },
  });
  const options = {
    clock,
    eventStore,
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    planner: fixedPlanner(),
    targetResolver: fixedTargetResolver(),
    dispatch,
    verifier: fixedVerifier(),
  } as const;
  const executor = new AuthoritativeWorkerTaskExecutor(options);

  const firstExecution = executor.execute(request("attempt-1", 1));
  const firstRun = await dispatch.nextAssignment();
  await executor.acceptWorkerEvents("device-worker-1", [
    workerEvent(firstRun, 1, "worker.run.claimed"),
    workerEvent(firstRun, 2, "worker.run.failed", {
      report: "The provider process exited before producing the requested result.",
      diagnostic: { code: "PROCESS_FAILED", retryable: true },
    }),
  ]);
  assert.deepEqual(await firstExecution, {
    state: "waiting_resource",
    publicMessage: "The provider process exited before producing the requested result.",
  });

  const secondExecution = executor.execute(request("attempt-2", 2));
  const secondRun = await dispatch.nextAssignment();
  assert.equal(secondRun.fencingToken, firstRun.fencingToken + 1);
  assert.notEqual(secondRun.runId, firstRun.runId);
  const staleResult = workerEvent(firstRun, 3, "worker.run.succeeded", {
    artifactIds: [],
    report: "Late stale result.",
  });
  const currentClaimed = workerEvent(secondRun, 1, "worker.run.claimed");
  const currentSucceeded = workerEvent(secondRun, 2, "worker.run.succeeded", {
    artifactIds: [],
    report: "The retry completed.",
  });
  assert.deepEqual(
    await executor.acceptWorkerEvents("device-worker-1", [
      staleResult,
      currentClaimed,
      currentSucceeded,
    ]),
    [
      { disposition: "rejected-stale", messageId: `${firstRun.runId}:succeeded` },
      { disposition: "accepted", messageId: `${secondRun.runId}:claimed` },
      { disposition: "accepted", messageId: `${secondRun.runId}:succeeded` },
    ],
  );
  assert.deepEqual(await executor.acceptWorkerEvents("device-worker-1", [staleResult]), [
    { disposition: "rejected-stale", messageId: `${firstRun.runId}:succeeded` },
  ]);

  assert.deepEqual(await executor.acceptWorkerEvents("device-worker-1", [currentSucceeded]), [
    { disposition: "duplicate", messageId: `${secondRun.runId}:succeeded` },
  ]);
  assert.equal((await secondExecution).state, "completed");
  const restarted = new AuthoritativeWorkerTaskExecutor(options);
  assert.deepEqual(await restarted.acceptWorkerEvents("device-worker-1", [staleResult]), [
    { disposition: "rejected-stale", messageId: `${firstRun.runId}:succeeded` },
  ]);
  assert.equal(
    (await eventStore.readAll()).filter(
      (event) => event.type === "task.worker-event-rejected-stale",
    ).length,
    1,
  );
  const neverAssigned = {
    ...firstRun,
    runId: "run-never-assigned",
    leaseId: "lease-never-assigned",
    fencingToken: secondRun.fencingToken + 100,
  } satisfies WorkerRunAssignmentV1;
  await assert.rejects(
    restarted.acceptWorkerEvents("device-worker-1", [
      workerEvent(neverAssigned, 4, "worker.run.failed", {
        report: "An authenticated Worker cannot invent a stale Run identity.",
        diagnostic: { code: "UNTRUSTED_RUN", retryable: false },
      }),
    ]),
    { code: "WORKER_EVENT_INVALID" },
  );
  assert.equal(
    (await eventStore.readAll()).filter(
      (event) => event.type === "task.worker-event-rejected-stale",
    ).length,
    1,
  );
});

test("an automatic Worker retry reuses the owner-turn plan instead of asking an old question again", async () => {
  const clock = mutableClock(NOW_MS);
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(clock.now()).toISOString() },
  });
  let planningTurns = 0;
  const repeatedQuestion = "What exact work and result should this test produce?";
  const executor = new AuthoritativeWorkerTaskExecutor({
    clock,
    eventStore,
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    planner: {
      async plan(input) {
        planningTurns += 1;
        if (planningTurns === 1) {
          return {
            state: "waiting_user" as const,
            publicMessage: repeatedQuestion,
          };
        }
        if (planningTurns === 2) {
          return {
            state: "ready" as const,
            plan: {
              protocolVersion: PROTOCOL_VERSION,
              taskId: input.task.taskId,
              workOrders: [workOrder("work-order-device-inventory")],
            },
          };
        }
        return {
          state: "waiting_user" as const,
          publicMessage: repeatedQuestion,
        };
      },
    },
    targetResolver: {
      async resolve() {
        throw new TaskExecutorError(
          "WORKER_OFFLINE",
          "No eligible Worker is online for this Work Order.",
          true,
        );
      },
    },
    dispatch: new RecordingDispatchPort(),
    verifier: fixedVerifier(),
  });
  const tasks = new TaskService({
    clock: { now: () => new Date(clock.now()).toISOString() },
    eventStore,
  });
  const coordinator = new TaskExecutionCoordinator({
    taskService: tasks,
    executor,
    maximumAutomaticAttempts: 2,
    retryDelayMs: 0,
  });

  const task = await coordinator.create({
    principalId: "owner-conversation",
    idempotencyKey: "conversation-task",
    objective: "A test Task",
    completionCriteria: ["Complete the requested work and report the observable result."],
    constraints: [],
    selectedInputRefs: [],
  });
  await coordinator.waitForIdle();
  assert.equal((await coordinator.get(task.taskId)).state, "waiting_user");

  await coordinator.appendInput({
    taskId: task.taskId,
    principalId: "owner-conversation",
    idempotencyKey: "conversation-device-question",
    message: "Which Devices are currently reachable?",
    selectedInputRefs: [],
  });
  await coordinator.waitForIdle();

  const result = await coordinator.get(task.taskId);
  assert.equal(planningTurns, 2);
  assert.equal(result.state, "failed");
  assert.match(result.messages.at(-1)?.content ?? "", /WORKER_OFFLINE/u);
  assert.notEqual(result.messages.at(-1)?.content, repeatedQuestion);
  await coordinator.close();
});

test("a Main restart reuses the first owner-cycle plan for a later automatic attempt", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  let planningTurns = 0;
  const options = {
    clock: mutableClock(NOW_MS),
    eventStore,
    idSource: sequentialIds(),
    planner: {
      async plan(input: { readonly task: TaskExecutionRequest["task"] }) {
        planningTurns += 1;
        return {
          state: "ready" as const,
          plan: {
            protocolVersion: PROTOCOL_VERSION,
            taskId: input.task.taskId,
            workOrders: [workOrder("work-order-restart-plan")],
          },
        };
      },
    },
    targetResolver: {
      async resolve() {
        throw new TaskExecutorError(
          "WORKER_OFFLINE",
          "No eligible Worker is online for this Work Order.",
          true,
        );
      },
    },
    dispatch: new RecordingDispatchPort(),
    verifier: fixedVerifier(),
  } as const;
  const first = new AuthoritativeWorkerTaskExecutor(options);
  await assert.rejects(first.execute(request("owner-cycle-attempt-1", 1)), {
    code: "WORKER_OFFLINE",
  });

  const restarted = new AuthoritativeWorkerTaskExecutor({
    ...options,
    planner: {
      async plan() {
        throw new Error("The persisted semantic plan must be reused after restart.");
      },
    },
  });
  await assert.rejects(
    restarted.execute({
      ...request("owner-cycle-attempt-2", 2),
      planningKey: "owner-cycle-attempt-1",
    }),
    { code: "WORKER_OFFLINE" },
  );
  assert.equal(planningTurns, 1);
});

test("an expired Worker event is durably rejected without becoming Run evidence", async () => {
  const clock = mutableClock(NOW_MS);
  const dispatch = new RecordingDispatchPort();
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(clock.now()).toISOString() },
  });
  const options = {
    clock,
    eventStore,
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    planner: fixedPlanner(),
    targetResolver: fixedTargetResolver(),
    dispatch,
    verifier: fixedVerifier(),
  } as const;
  const executor = new AuthoritativeWorkerTaskExecutor(options);
  const execution = executor.execute(request("expired-worker-event", 1));
  const run = await dispatch.nextAssignment();
  await executor.acceptWorkerEvents(run.deviceId, [workerEvent(run, 1, "worker.run.claimed")]);
  clock.set(run.leaseExpiresAtMs);
  const terminal = workerEvent(run, 2, "worker.run.succeeded", {
    artifactIds: [],
    report: "This result arrived after authority expired.",
  });

  assert.deepEqual(await executor.acceptWorkerEvents(run.deviceId, [terminal]), [
    { disposition: "rejected-stale", messageId: `${run.runId}:succeeded` },
  ]);
  const rejection = (await eventStore.readAll()).find(
    (event) => event.type === "task.worker-event-rejected-stale",
  );
  assert.equal(
    (rejection?.payload as { reasonCode?: unknown } | undefined)?.reasonCode,
    "RUN_LEASE_EXPIRED",
  );

  const restarted = new AuthoritativeWorkerTaskExecutor(options);
  assert.deepEqual(await restarted.acceptWorkerEvents(run.deviceId, [terminal]), [
    { disposition: "rejected-stale", messageId: `${run.runId}:succeeded` },
  ]);
  await executor.cancel({
    taskId: run.taskId,
    executionKey: "expired-worker-event",
    reason: "cancelled",
  });
  await assert.rejects(execution, { code: "EXECUTION_CANCELLED" });
});

test("restart repeats the exact durable dispatch identity instead of creating another Run", async () => {
  const clock = mutableClock(NOW_MS);
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(clock.now()).toISOString() },
  });
  const ids = sequentialIds();
  const firstDispatch = new RecordingDispatchPort();
  const shared = {
    clock,
    eventStore,
    idSource: ids,
    leaseDurationMs: 60_000,
    planner: fixedPlanner(),
    targetResolver: fixedTargetResolver(),
    verifier: fixedVerifier(),
  } as const;
  const first = new AuthoritativeWorkerTaskExecutor({
    ...shared,
    dispatch: firstDispatch,
  });
  const firstExecution = first.execute(request("restart-attempt", 1));
  const original = await firstDispatch.nextAssignment();
  await first.cancel({
    taskId: "task-release",
    executionKey: "restart-attempt",
    reason: "coordinator-closed",
  });
  await assert.rejects(firstExecution, { code: "EXECUTION_CANCELLED" });

  const restartedDispatch = new RecordingDispatchPort();
  const restarted = new AuthoritativeWorkerTaskExecutor({
    ...shared,
    dispatch: restartedDispatch,
  });
  const resumedExecution = restarted.execute(request("restart-attempt", 1));
  const replayed = await restartedDispatch.nextAssignment();
  assert.deepEqual(replayed, original);
  assert.equal(restartedDispatch.records[0]?.idempotencyKey, `dispatch:${original.runId}`);

  await restarted.acceptWorkerEvents("device-worker-1", [
    workerEvent(replayed, 1, "worker.run.claimed"),
    workerEvent(replayed, 2, "worker.run.succeeded", {
      artifactIds: [],
      report: "Recovered dispatch completed once.",
    }),
  ]);
  assert.equal((await resumedExecution).state, "completed");
});

test("Main preserves a required Agent binding and safe native-session lineage across restart", async () => {
  const clock = mutableClock(NOW_MS);
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(clock.now()).toISOString() },
  });
  const requiredAgent = {
    provider: "claude" as const,
    adapterId: "claude-agent-sdk",
    allowedCompatibilities: ["tested"] as const,
  };
  const reports: AuthoritativeWorkerReport[] = [];
  const shared = {
    clock,
    eventStore,
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    planner: {
      async plan(input: { readonly task: TaskExecutionRequest["task"] }) {
        return {
          state: "ready" as const,
          plan: {
            protocolVersion: PROTOCOL_VERSION,
            taskId: input.task.taskId,
            workOrders: [
              {
                ...workOrder("work-order-provider-bound"),
                requiredAgent,
              },
            ],
          },
        };
      },
    },
    targetResolver: fixedTargetResolver(),
    verifier: {
      async verify(input: {
        readonly task: TaskExecutionRequest["task"];
        readonly reports: readonly AuthoritativeWorkerReport[];
      }) {
        reports.push(...input.reports);
        return {
          state: "completed" as const,
          verifiedCompletionCriteria: [...input.task.completionCriteria],
        };
      },
    },
  } as const;
  const firstDispatch = new RecordingDispatchPort();
  const first = new AuthoritativeWorkerTaskExecutor({ ...shared, dispatch: firstDispatch });
  const firstExecution = first.execute(request("provider-bound-restart", 1));
  const original = await firstDispatch.nextAssignment();
  assert.deepEqual(original.agentRequirement, requiredAgent);
  await first.cancel({
    taskId: "task-release",
    executionKey: "provider-bound-restart",
    reason: "coordinator-closed",
  });
  await assert.rejects(firstExecution, { code: "EXECUTION_CANCELLED" });

  const restartedDispatch = new RecordingDispatchPort();
  const restarted = new AuthoritativeWorkerTaskExecutor({
    ...shared,
    dispatch: restartedDispatch,
  });
  const resumed = restarted.execute(request("provider-bound-restart", 1));
  const replayed = await restartedDispatch.nextAssignment();
  assert.deepEqual(replayed, original);
  const agentSession = {
    provider: "claude" as const,
    adapterId: "claude-agent-sdk",
    adapterVersion: "0.2.1",
    nativeSessionId: "native-session-provider-bound",
    workstreamId: "work-order-provider-bound",
    workspaceId: "workspace-release",
    lineage: {
      lineageId: "lineage-task-release",
    },
  };
  const terminal = workerEvent(replayed, 2, "worker.run.succeeded", {
    artifactIds: [],
    report: "The provider-bound Run completed.",
    agentSession,
  });
  await restarted.acceptWorkerEvents("device-worker-1", [
    workerEvent(replayed, 1, "worker.run.claimed"),
    terminal,
  ]);
  assert.equal((await resumed).state, "completed");
  assert.deepEqual(reports[0]?.agentSession, agentSession);
  assert.equal(JSON.stringify(reports[0]).includes("sessionKey"), false);
  assert.deepEqual(await restarted.acceptWorkerEvents("device-worker-1", [terminal]), [
    { disposition: "duplicate", messageId: `${replayed.runId}:succeeded` },
  ]);
  await assert.rejects(
    restarted.acceptWorkerEvents("device-worker-1", [
      {
        ...terminal,
        payload: {
          ...terminal.payload,
          agentSession: {
            ...agentSession,
            nativeSessionId: "native-session-conflict",
          },
        },
      },
    ]),
    { code: "WORKER_EVENT_IDEMPOTENCY_CONFLICT" },
  );
});

test("a long Worker Run survives multiple durable lease renewals and exact replay after Main restart", async () => {
  const clock = mutableClock(NOW_MS);
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(clock.now()).toISOString() },
  });
  const shared = {
    clock,
    eventStore,
    idSource: sequentialIds(),
    leaseDurationMs: 300_000,
    planner: fixedPlanner(),
    targetResolver: fixedTargetResolver(),
    verifier: fixedVerifier(),
  } as const;
  const firstDispatch = new RecordingDispatchPort();
  const first = new AuthoritativeWorkerTaskExecutor({
    ...shared,
    dispatch: firstDispatch,
  });
  const execution = first.execute(request("renewed-attempt", 1));
  const assignment = await firstDispatch.nextAssignment();
  await first.acceptWorkerEvents("device-worker-1", [
    workerEvent(assignment, 1, "worker.run.claimed"),
  ]);

  clock.set(NOW_MS + 240_000);
  const firstRenewal = await first.renewWorkerRunLease(
    "device-worker-1",
    renewalRequest(assignment, "renewal-1", assignment.leaseExpiresAtMs),
  );
  assert.deepEqual(firstRenewal, {
    status: "renewed",
    renewalId: "renewal-1",
    renewedAtMs: NOW_MS + 240_000,
    priorLeaseExpiresAtMs: NOW_MS + 300_000,
    leaseExpiresAtMs: NOW_MS + 540_000,
  });

  clock.set(NOW_MS + 480_000);
  const secondRenewal = await first.renewWorkerRunLease(
    "device-worker-1",
    renewalRequest(assignment, "renewal-2", firstRenewal.leaseExpiresAtMs),
  );
  assert.equal(secondRenewal.status, "renewed");
  assert.equal(secondRenewal.leaseExpiresAtMs, NOW_MS + 780_000);

  await first.cancel({
    taskId: "task-release",
    executionKey: "renewed-attempt",
    reason: "coordinator-closed",
  });
  await assert.rejects(execution, { code: "EXECUTION_CANCELLED" });

  const restartedDispatch = new RecordingDispatchPort();
  const restarted = new AuthoritativeWorkerTaskExecutor({
    ...shared,
    dispatch: restartedDispatch,
  });
  assert.deepEqual(
    await restarted.renewWorkerRunLease(
      "device-worker-1",
      renewalRequest(assignment, "renewal-1", assignment.leaseExpiresAtMs),
    ),
    firstRenewal,
  );
  const resumed = restarted.execute(request("renewed-attempt", 1));
  await restartedDispatch.nextAssignment();
  clock.set(NOW_MS + 610_000);
  await restarted.acceptWorkerEvents("device-worker-1", [
    workerEvent(assignment, 2, "worker.run.succeeded", {
      artifactIds: [],
      report: "The Run completed after more than two original lease windows.",
    }),
  ]);
  assert.equal((await resumed).state, "completed");
});

test("lease renewal rejects stale, late, mismatched, and concurrent prior-expiry commands without resurrection", async () => {
  const clock = mutableClock(NOW_MS);
  const dispatch = new RecordingDispatchPort();
  const executor = new AuthoritativeWorkerTaskExecutor({
    clock,
    eventStore: new InMemoryEventStore({
      clock: { now: () => new Date(clock.now()).toISOString() },
    }),
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    planner: fixedPlanner(),
    targetResolver: fixedTargetResolver(),
    dispatch,
    verifier: fixedVerifier(),
  });
  const execution = executor.execute(request("renewal-fail-closed", 1));
  const assignment = await dispatch.nextAssignment();
  await executor.acceptWorkerEvents("device-worker-1", [
    workerEvent(assignment, 1, "worker.run.claimed"),
  ]);

  clock.set(NOW_MS + 30_000);
  const concurrent = await Promise.all([
    executor.renewWorkerRunLease(
      "device-worker-1",
      renewalRequest(assignment, "renewal-concurrent-a", assignment.leaseExpiresAtMs),
    ),
    executor.renewWorkerRunLease(
      "device-worker-1",
      renewalRequest(assignment, "renewal-concurrent-b", assignment.leaseExpiresAtMs),
    ),
  ]);
  assert.equal(concurrent.filter((outcome) => outcome.status === "renewed").length, 1);
  assert.equal(concurrent.filter((outcome) => outcome.status === "rejected").length, 1);
  const renewed = concurrent.find((outcome) => outcome.status === "renewed");
  assert.ok(renewed !== undefined);

  const wrongDevice = await executor.renewWorkerRunLease(
    "device-worker-2",
    renewalRequest(assignment, "renewal-wrong-device", renewed.leaseExpiresAtMs),
  );
  assert.equal(wrongDevice.status, "rejected");
  assert.equal(wrongDevice.status === "rejected" && wrongDevice.reasonCode, "RUN_SCOPE_MISMATCH");
  const wrongFence = await executor.renewWorkerRunLease("device-worker-1", {
    ...renewalRequest(assignment, "renewal-wrong-fence", renewed.leaseExpiresAtMs),
    fencingToken: assignment.fencingToken + 1,
  });
  assert.equal(wrongFence.status, "rejected");
  assert.equal(wrongFence.status === "rejected" && wrongFence.reasonCode, "RUN_SCOPE_MISMATCH");

  clock.set(renewed.leaseExpiresAtMs);
  const late = await executor.renewWorkerRunLease(
    "device-worker-1",
    renewalRequest(assignment, "renewal-late", renewed.leaseExpiresAtMs),
  );
  assert.equal(late.status, "rejected");
  assert.equal(late.status === "rejected" && late.reasonCode, "RUN_LEASE_EXPIRED");
  assert.deepEqual(await execution, {
    state: "waiting_resource",
    publicMessage: "The Worker Run lease expired before an authoritative completion arrived.",
  });
  const retired = await executor.renewWorkerRunLease(
    "device-worker-1",
    renewalRequest(assignment, "renewal-after-retirement", renewed.leaseExpiresAtMs),
  );
  assert.equal(retired.status, "rejected");
  assert.equal(retired.status === "rejected" && retired.reasonCode, "RUN_NOT_ACTIVE");

  const missing = await executor.renewWorkerRunLease("device-worker-1", {
    ...renewalRequest(assignment, "renewal-missing", renewed.leaseExpiresAtMs),
    taskId: "task-missing",
    workOrderId: "work-order-missing",
  });
  assert.equal(missing.status, "rejected");
  assert.equal(missing.status === "rejected" && missing.reasonCode, "RUN_NOT_ACTIVE");
  clock.set(clock.now() + 10_000);
  const missingReplay = await executor.renewWorkerRunLease("device-worker-1", {
    ...renewalRequest(assignment, "renewal-missing", renewed.leaseExpiresAtMs),
    taskId: "task-missing",
    workOrderId: "work-order-missing",
  });
  assert.deepEqual(missingReplay, missing);
});

test("a durable pre-Run renewal rejection does not poison a later valid assignment", async () => {
  const clock = mutableClock(NOW_MS);
  const dispatch = new RecordingDispatchPort();
  const executor = new AuthoritativeWorkerTaskExecutor({
    clock,
    eventStore: new InMemoryEventStore({
      clock: { now: () => new Date(clock.now()).toISOString() },
    }),
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    planner: fixedPlanner(),
    targetResolver: fixedTargetResolver(),
    dispatch,
    verifier: fixedVerifier(),
  });
  const premature = {
    taskId: "task-release",
    workOrderId: "work-order-build",
    deviceId: "device-worker-1",
    workerId: "worker-1",
    routeId: "route-private-1",
    runId: "run-not-issued",
    leaseId: "lease-not-issued",
    fencingToken: 1,
    renewalId: "renewal-before-assignment",
    priorLeaseExpiresAtMs: NOW_MS + 60_000,
  };
  const rejected = await executor.renewWorkerRunLease("device-worker-1", premature);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.status === "rejected" && rejected.reasonCode, "RUN_NOT_ACTIVE");

  clock.set(NOW_MS + 10_000);
  assert.deepEqual(await executor.renewWorkerRunLease("device-worker-1", premature), rejected);
  const execution = executor.execute(request("after-premature-renewal", 1));
  const assigned = await dispatch.nextAssignment();
  assert.equal(assigned.fencingToken, 1);
  await executor.acceptWorkerEvents("device-worker-1", [
    workerEvent(assigned, 1, "worker.run.claimed"),
    workerEvent(assigned, 2, "worker.run.succeeded", {
      artifactIds: [],
      report: "The later valid Run completed.",
    }),
  ]);
  assert.equal((await execution).state, "completed");
});

test("supersession durably fences the current Run before dispatching its replacement", async () => {
  const clock = mutableClock(NOW_MS);
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(clock.now()).toISOString() },
  });
  const dispatch = new RecordingDispatchPort();
  const executor = new AuthoritativeWorkerTaskExecutor({
    clock,
    eventStore,
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    planner: fixedPlanner(),
    targetResolver: fixedTargetResolver(),
    dispatch,
    verifier: fixedVerifier(),
  });

  const firstExecution = executor.execute(request("attempt-before-input", 1));
  const replacedRun = await dispatch.nextAssignment();
  await assert.rejects(
    executor.cancel({
      taskId: "another-task",
      executionKey: "attempt-before-input",
      reason: "superseded",
    }),
    { code: "CANCELLATION_SCOPE_INVALID" },
  );
  await executor.cancel({
    taskId: "task-release",
    executionKey: "attempt-before-input",
    reason: "superseded",
  });
  await assert.rejects(firstExecution, { code: "EXECUTION_CANCELLED" });
  assert.deepEqual(
    dispatch.cancellations.map((cancellation) => ({
      runId: cancellation.assignment.runId,
      reason: cancellation.reason,
    })),
    [{ runId: replacedRun.runId, reason: "superseded" }],
  );

  const replacementExecution = executor.execute(request("attempt-after-input", 2));
  const replacementRun = await dispatch.nextAssignment();
  assert.notEqual(replacementRun.runId, replacedRun.runId);
  assert.equal(replacementRun.fencingToken, replacedRun.fencingToken + 1);
  assert.deepEqual(
    await executor.acceptWorkerEvents("device-worker-1", [
      workerEvent(replacedRun, 1, "worker.run.succeeded", {
        artifactIds: [],
        report: "A late result from the superseded Task turn.",
      }),
    ]),
    [{ disposition: "rejected-stale", messageId: `${replacedRun.runId}:succeeded` }],
  );

  await executor.acceptWorkerEvents("device-worker-1", [
    workerEvent(replacementRun, 1, "worker.run.claimed"),
    workerEvent(replacementRun, 2, "worker.run.succeeded", {
      artifactIds: [],
      report: "The replacement Run completed.",
    }),
  ]);
  assert.equal((await replacementExecution).state, "completed");
});

test("active Budget exhaustion retires and cancels a Worker Run before execution tracking closes", async () => {
  const clock = mutableClock(NOW_MS);
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(clock.now()).toISOString() },
  });
  const limits = {
    wallTimeMs: { hard: 10 },
    idleTimeMs: { hard: 1_000 },
    retries: { hard: 1 },
    childWorkOrders: { hard: 4 },
    concurrentRuns: { hard: 2 },
    nativeTurns: { hard: 8 },
    tokens: { hard: 100_000 },
    costUsdMicros: { hard: 1_000_000 },
  } as const;
  const budget = new DurableTaskBudgetEnforcer({
    eventStore,
    clock,
    instanceLimits: limits,
    requestedTaskDefaults: limits,
    autonomousTaskDefaults: limits,
    usageProxy: {
      tokensPerNativeTurn: 1_000,
      costUsdMicrosPerNativeTurn: 10_000,
    },
  });
  const dispatch = new RecordingDispatchPort();
  const executor = new AuthoritativeWorkerTaskExecutor({
    clock,
    eventStore,
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    planner: fixedPlanner(),
    targetResolver: fixedTargetResolver(),
    dispatch,
    verifier: fixedVerifier(),
    budget,
  });
  const tasks = new TaskService({
    clock: { now: () => new Date(clock.now()).toISOString() },
    eventStore,
  });
  const coordinator = new TaskExecutionCoordinator({
    taskService: tasks,
    executor,
    budget,
    retryDelayMs: 0,
  });

  const task = await coordinator.create({
    principalId: "owner-budget-race",
    idempotencyKey: "active-worker-budget-race",
    objective: "Stop a Worker Run immediately when its hard Budget is exhausted.",
    completionCriteria: ["The Worker Run is durably retired and cancelled."],
    constraints: [],
    selectedInputRefs: [],
  });
  const assignment = await dispatch.nextAssignment();
  assert.deepEqual(
    await executor.authorizeWorkerArtifactRun(assignment.deviceId, artifactRunScope(assignment)),
    {
      authorized: true,
      leaseExpiresAtMs: assignment.leaseExpiresAtMs,
    },
  );

  clock.set(NOW_MS + 11);
  await budget.recordActivity({
    taskId: task.taskId,
    operationId: "active-worker-budget-clock-tick",
    source: "worker-progress",
  });
  await coordinator.waitForIdle();

  assert.equal((await coordinator.get(task.taskId)).state, "waiting_user");
  assert.deepEqual(
    dispatch.cancellations.map((cancellation) => ({
      idempotencyKey: cancellation.idempotencyKey,
      reason: cancellation.reason,
      runId: cancellation.assignment.runId,
    })),
    [
      {
        idempotencyKey: `cancel:${assignment.runId}:${String(assignment.fencingToken)}`,
        reason: "paused",
        runId: assignment.runId,
      },
    ],
  );
  assert.deepEqual(
    await executor.authorizeWorkerArtifactRun(assignment.deviceId, artifactRunScope(assignment)),
    { authorized: false },
  );
  assert.deepEqual(
    await executor.acceptWorkerEvents(assignment.deviceId, [
      workerEvent(assignment, 1, "worker.run.succeeded", {
        artifactIds: [],
        report: "A late result after Budget cancellation.",
      }),
    ]),
    [{ disposition: "rejected-stale", messageId: `${assignment.runId}:succeeded` }],
  );
  assert.deepEqual((await budget.snapshot(task.taskId)).activeRunIds, []);
  await coordinator.close();
});

test("authoritative planning, Worker Runs, provider usage, and verification share one durable Task Budget", async () => {
  const clock = mutableClock(NOW_MS);
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(clock.now()).toISOString() },
  });
  const completeLimits = {
    wallTimeMs: { hard: 60_000 },
    idleTimeMs: { hard: 30_000 },
    retries: { hard: 2 },
    childWorkOrders: { hard: 1 },
    concurrentRuns: { hard: 1 },
    nativeTurns: { hard: 3 },
    tokens: { hard: 500 },
    costUsdMicros: { hard: 4_000 },
  } as const;
  const budget = new DurableTaskBudgetEnforcer({
    eventStore,
    clock,
    instanceLimits: completeLimits,
    requestedTaskDefaults: completeLimits,
    autonomousTaskDefaults: completeLimits,
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  });
  await budget.ensureTask({ taskId: "task-release", kind: "requested" });
  const dispatch = new RecordingDispatchPort();
  const executor = new AuthoritativeWorkerTaskExecutor({
    clock,
    eventStore,
    idSource: sequentialIds(),
    leaseDurationMs: 60_000,
    planner: fixedPlanner(),
    targetResolver: fixedTargetResolver(),
    dispatch,
    verifier: fixedVerifier(),
    budget,
  });

  const execution = executor.execute(request("budget-attempt-1", 1));
  const assignment = await dispatch.nextAssignment();
  await executor.acceptWorkerEvents("device-worker-1", [
    workerEvent(assignment, 1, "worker.run.claimed"),
    workerEvent(assignment, 2, "worker.run.succeeded", {
      artifactIds: [],
      report: "The bounded Worker Run completed.",
      usage: {
        inputTokens: 150,
        outputTokens: 100,
        costUsdMicros: 1_500,
      },
    }),
  ]);
  assert.equal((await execution).state, "completed");

  const snapshot = await budget.snapshot("task-release");
  assert.equal(snapshot.usage.childWorkOrders, 1);
  assert.equal(snapshot.usage.concurrentRuns, 0);
  assert.equal(snapshot.usage.nativeTurns, 3);
  assert.equal(snapshot.usage.tokens, 450);
  assert.equal(snapshot.usage.costUsdMicros, 3_500);
  assert.deepEqual(snapshot.activeRunIds, []);

  await assert.rejects(
    executor.execute(request("budget-attempt-2", 2)),
    (error: unknown) =>
      error instanceof Error && "metric" in error && error.metric === "nativeTurns",
  );
  assert.equal(dispatch.records.length, 1);
});

function request(executionKey: string, attempt: number): TaskExecutionRequest {
  return {
    attempt,
    executionKey,
    planningKey: executionKey,
    signal: new AbortController().signal,
    task: {
      taskId: "task-release",
      state: "running",
      mode: "auto",
      objective: "Produce the requested result.",
      createdAt: NOW,
      updatedAt: NOW,
      version: attempt,
      completionCriteria: ["The requested result is proven."],
      constraints: [],
      selectedInputRefs: [],
      messages: [],
      events: [],
    },
  };
}

function workOrder(workOrderId: string): WorkOrderV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    workOrderId,
    title: "Build and verify",
    brief: "Produce observable evidence for the requested result.",
    completionCriteria: ["Build and tests finish with an observable report."],
    constraints: [],
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

function fixedPlanner() {
  return {
    async plan(input: { readonly task: TaskExecutionRequest["task"] }) {
      return {
        state: "ready" as const,
        plan: {
          protocolVersion: PROTOCOL_VERSION,
          taskId: input.task.taskId,
          workOrders: [workOrder("work-order-build")],
        },
      };
    },
  };
}

function fixedTargetResolver() {
  return {
    async resolve() {
      return {
        deviceId: "device-worker-1",
        workerId: "worker-1",
        routeId: "route-private-1",
      };
    },
  };
}

function fixedVerifier() {
  return {
    async verify(input: { readonly task: TaskExecutionRequest["task"] }) {
      return {
        state: "completed" as const,
        publicMessage: "Verified from durable Worker evidence.",
        verifiedCompletionCriteria: [...input.task.completionCriteria],
      };
    },
  };
}

function workerEvent(
  assignment: WorkerRunAssignmentV1,
  sequence: number,
  type: SequencedWorkerEventV1["type"],
  result: {
    readonly report?: string;
    readonly artifactIds?: readonly string[];
    readonly diagnostic?: SequencedWorkerEventV1["payload"]["diagnostic"];
    readonly usage?: SequencedWorkerEventV1["payload"]["usage"];
    readonly agentSession?: SequencedWorkerEventV1["payload"]["agentSession"];
  } = {},
): SequencedWorkerEventV1 {
  const suffix = type.slice("worker.run.".length);
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `${assignment.runId}:${suffix}`,
    senderDeviceId: assignment.deviceId,
    correlationId: assignment.taskId,
    createdAt: NOW,
    idempotencyKey: `${assignment.runId}:${assignment.leaseId}:${assignment.fencingToken}:${suffix}`,
    sequence,
    type,
    payload: {
      taskId: assignment.taskId,
      workOrderId: assignment.workOrder.workOrderId,
      deviceId: assignment.deviceId,
      workerId: assignment.workerId,
      routeId: assignment.routeId,
      runId: assignment.runId,
      leaseId: assignment.leaseId,
      fencingToken: assignment.fencingToken,
      ...(result.report === undefined ? {} : { report: result.report }),
      ...(result.artifactIds === undefined ? {} : { artifactIds: result.artifactIds }),
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.agentSession === undefined ? {} : { agentSession: result.agentSession }),
    },
  };
}

function artifactRunScope(assignment: WorkerRunAssignmentV1) {
  return {
    taskId: assignment.taskId,
    workOrderId: assignment.workOrder.workOrderId,
    deviceId: assignment.deviceId,
    workerId: assignment.workerId,
    routeId: assignment.routeId,
    runId: assignment.runId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
  };
}

function renewalRequest(
  assignment: WorkerRunAssignmentV1,
  renewalId: string,
  priorLeaseExpiresAtMs: number,
) {
  return {
    ...artifactRunScope(assignment),
    renewalId,
    priorLeaseExpiresAtMs,
  };
}

class RecordingDispatchPort implements WorkerRunDispatchPort {
  readonly records: Array<{
    readonly idempotencyKey: string;
    readonly assignment: WorkerRunAssignmentV1;
  }> = [];
  readonly cancellations: Array<{
    readonly idempotencyKey: string;
    readonly assignment: WorkerRunAssignmentV1;
    readonly reason: "cancelled" | "coordinator-closed" | "paused" | "superseded";
  }> = [];
  readonly #waiters: Array<(assignment: WorkerRunAssignmentV1) => void> = [];
  #readIndex = 0;

  async enqueue(input: {
    readonly idempotencyKey: string;
    readonly assignment: WorkerRunAssignmentV1;
  }): Promise<void> {
    this.records.push(structuredClone(input));
    this.#waiters.shift()?.(structuredClone(input.assignment));
  }

  nextAssignment(): Promise<WorkerRunAssignmentV1> {
    const existing = this.records[this.#readIndex]?.assignment;
    if (existing !== undefined) {
      this.#readIndex += 1;
      return Promise.resolve(structuredClone(existing));
    }
    return new Promise((resolve) =>
      this.#waiters.push((assignment) => {
        this.#readIndex += 1;
        resolve(assignment);
      }),
    );
  }

  async cancel(input: {
    readonly idempotencyKey: string;
    readonly assignment: WorkerRunAssignmentV1;
    readonly reason: "cancelled" | "coordinator-closed" | "paused" | "superseded";
  }): Promise<void> {
    this.cancellations.push(structuredClone(input));
  }
}

function sequentialIds() {
  let value = 0;
  return {
    nextId(kind: "lease" | "run"): string {
      value += 1;
      return `${kind}-${String(value)}`;
    },
  };
}

function mutableClock(initial: number) {
  let value = initial;
  return {
    now: () => value,
    set(next: number) {
      value = next;
    },
  };
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const marker = {};
  return (await Promise.race([promise, Promise.resolve(marker)])) !== marker;
}
