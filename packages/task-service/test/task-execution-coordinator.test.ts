import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventStore } from "@opendelegate/event-store";

import {
  DurableTaskBudgetEnforcer,
  TaskExecutionCoordinator,
  TaskExecutionCoordinatorError,
  TaskExecutorError,
  TaskService,
  type TaskExecutionRequest,
  type TaskExecutor,
} from "../src/index.ts";

const clock = {
  now: () => "2026-07-25T12:00:00.000Z",
};

test("one deep Task interface persists intake, executes it, and records verified completion", async () => {
  const taskService = fixture();
  const requests: TaskExecutionRequest[] = [];
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    executor: {
      async execute(request) {
        requests.push(request);
        return {
          state: "completed",
          verifiedCompletionCriteria: [...request.task.completionCriteria],
        };
      },
    },
    retryDelayMs: 0,
  });

  const created = await coordinator.create(taskInput("complete", "Complete"));
  assert.equal(created.state, "intake");
  await coordinator.waitForIdle();

  const completed = await coordinator.get(created.taskId);
  assert.equal(completed.state, "completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.task.taskId, created.taskId);
  assert.equal(requests[0]?.attempt, 1);
  await coordinator.close();
});

test("a manual Task remains visible in intake without invoking its executor", async () => {
  const taskService = fixture();
  let executionCount = 0;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    executor: {
      async execute(request) {
        executionCount += 1;
        return {
          state: "completed",
          verifiedCompletionCriteria: [...request.task.completionCriteria],
        };
      },
    },
    retryDelayMs: 0,
  });

  const created = await coordinator.create({
    ...taskInput("manual", "Manual"),
    mode: "manual",
  });
  await coordinator.waitForIdle();

  assert.equal(executionCount, 0);
  assert.equal((await coordinator.get(created.taskId)).state, "intake");
  assert.equal((await coordinator.get(created.taskId)).mode, "manual");
  await coordinator.close();
});

test("startup reconciliation resumes a Task left running by an interrupted process", async () => {
  const eventStore = new InMemoryEventStore({ clock });
  const taskService = new TaskService({ clock, eventStore });
  const task = await taskService.create(taskInput("restart", "Restart"));
  await taskService.recordExecution({
    taskId: task.taskId,
    idempotencyKey: "interrupted-running",
    state: "running",
  });

  let executionCount = 0;
  const restarted = new TaskExecutionCoordinator({
    taskService: new TaskService({ clock, eventStore }),
    executor: {
      async execute(request) {
        executionCount += 1;
        return {
          state: "completed",
          verifiedCompletionCriteria: [...request.task.completionCriteria],
        };
      },
    },
    retryDelayMs: 0,
  });
  await restarted.start();
  await restarted.waitForIdle();

  assert.equal(executionCount, 1);
  assert.equal((await restarted.get(task.taskId)).state, "completed");
  await restarted.close();
});

test("a startup gate durably accepts ingress without dispatching until reconciliation completes", async () => {
  const taskService = fixture();
  const requests: TaskExecutionRequest[] = [];
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    executor: {
      async execute(request) {
        requests.push(request);
        return {
          state: "completed",
          verifiedCompletionCriteria: [...request.task.completionCriteria],
        };
      },
    },
    deferExecutionUntilStart: true,
    retryDelayMs: 0,
  });

  const created = await coordinator.create(taskInput("startup-gate", "Startup gate"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
  assert.equal((await coordinator.get(created.taskId)).state, "intake");

  await coordinator.start();
  await coordinator.waitForIdle();
  assert.equal(requests.length, 1);
  assert.equal((await coordinator.get(created.taskId)).state, "completed");
  await coordinator.close();
});

test("retryable execution failure is bounded durably and cannot run away", async () => {
  const taskService = fixture();
  let attempts = 0;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    executor: {
      async execute() {
        attempts += 1;
        throw new TaskExecutorError("WORKER_OFFLINE", "No eligible Worker is online.", true);
      },
    },
    maximumAutomaticAttempts: 3,
    retryDelayMs: 0,
  });

  const task = await coordinator.create(taskInput("bounded-retry", "Bounded retry"));
  await coordinator.waitForIdle();
  const failed = await coordinator.get(task.taskId);

  assert.equal(attempts, 3);
  assert.equal(failed.state, "failed");
  assert.equal(failed.events.filter((event) => event.type === "task.execution-recorded").length, 6);
  assert.match(failed.messages.at(-1)?.content ?? "", /No eligible Worker is online/);
  assert.match(failed.messages.at(-1)?.content ?? "", /WORKER_OFFLINE/);
  await coordinator.close();
});

test("a structured resource wait stays durable without consuming failure attempts", async () => {
  const taskService = fixture();
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    executor: {
      async execute() {
        return {
          state: "waiting_resource",
          publicMessage: "No enrolled Device currently satisfies this Work Order.",
        };
      },
    },
    maximumAutomaticAttempts: 1,
    retryDelayMs: 0,
  });

  const task = await coordinator.create(taskInput("resource-explanation", "Need a capable Device"));
  await coordinator.waitForIdle();
  const waiting = await coordinator.get(task.taskId);

  assert.equal(waiting.state, "waiting_resource");
  assert.match(
    waiting.messages.at(-1)?.content ?? "",
    /No enrolled Device currently satisfies this Work Order/u,
  );
  assert.match(waiting.messages.at(-1)?.content ?? "", /continue automatically/u);
  await coordinator.close();
});

test("a resource availability signal resumes the same attempt without retry Budget usage", async () => {
  const eventStore = new InMemoryEventStore({ clock });
  const taskService = new TaskService({ clock, eventStore });
  let budgetNow = Date.parse(clock.now());
  const limits = {
    wallTimeMs: { hard: 60_000 },
    idleTimeMs: { hard: 30_000 },
    retries: { hard: 1 },
    childWorkOrders: { hard: 4 },
    concurrentRuns: { hard: 2 },
    nativeTurns: { hard: 8 },
    tokens: { hard: 100_000 },
    costUsdMicros: { hard: 1_000_000 },
  } as const;
  const budget = new DurableTaskBudgetEnforcer({
    eventStore,
    clock: { now: () => budgetNow },
    instanceLimits: limits,
    requestedTaskDefaults: limits,
    autonomousTaskDefaults: limits,
    usageProxy: {
      tokensPerNativeTurn: 1_000,
      costUsdMicrosPerNativeTurn: 10_000,
    },
  });
  const requests: TaskExecutionRequest[] = [];
  let workerAvailable = false;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    budget,
    executor: {
      async execute(request) {
        requests.push(request);
        if (!workerAvailable) {
          throw new TaskExecutorError("WORKER_OFFLINE", "No eligible Worker is online.", true, {
            retryKind: "resource",
          });
        }
        return {
          state: "completed",
          verifiedCompletionCriteria: [...request.task.completionCriteria],
        };
      },
    },
    retryDelayMs: 0,
  });

  const task = await coordinator.create(taskInput("resource-signal", "Resume on availability"));
  await coordinator.waitForIdle();
  assert.equal((await coordinator.get(task.taskId)).state, "waiting_resource");

  budgetNow += 31_000;
  workerAvailable = true;
  coordinator.notifyResourceAvailabilityChanged();
  await coordinator.waitForIdle();

  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  assert.deepEqual(
    requests.map(({ attempt }) => attempt),
    [1, 1],
  );
  assert.match(requests[1]?.executionKey ?? "", /:attempt:1:resource:1$/u);
  assert.equal((await budget.snapshot(task.taskId)).usage.retries ?? 0, 0);
  await coordinator.close();
});

test("a resource change racing the first wait cannot be lost", async () => {
  const taskService = fixture();
  let executionCount = 0;
  let markFirstStarted: (() => void) | undefined;
  let releaseFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    executor: {
      async execute(request) {
        executionCount += 1;
        if (executionCount === 1) {
          markFirstStarted?.();
          await firstReleased;
          return { state: "waiting_resource" };
        }
        return {
          state: "completed",
          verifiedCompletionCriteria: [...request.task.completionCriteria],
        };
      },
    },
  });

  const task = await coordinator.create(taskInput("resource-race", "Do not lose wakeup"));
  await firstStarted;
  coordinator.notifyResourceAvailabilityChanged();
  releaseFirst?.();
  await coordinator.waitForIdle();

  assert.equal(executionCount, 2);
  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  await coordinator.close();
});

test("a failed executor result cannot omit its owner-visible diagnostic", async () => {
  const taskService = fixture();
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    executor: {
      async execute() {
        return { state: "failed" };
      },
    },
    retryDelayMs: 0,
  });

  const task = await coordinator.create(taskInput("failed-without-message", "Explain failure"));
  await coordinator.waitForIdle();
  const failed = await coordinator.get(task.taskId);

  assert.equal(failed.state, "failed");
  assert.match(failed.messages.at(-1)?.content ?? "", /without an owner-safe explanation/u);
  assert.match(failed.messages.at(-1)?.content ?? "", /Task Runs/u);
  await coordinator.close();
});

test("the automatic retry budget survives a coordinator process restart", async () => {
  const eventStore = new InMemoryEventStore({ clock });
  const taskService = new TaskService({ clock, eventStore });
  let attempts = 0;
  const firstProcess = new TaskExecutionCoordinator({
    taskService,
    executor: {
      async execute() {
        attempts += 1;
        throw new TaskExecutorError("WORKER_OFFLINE", "Worker is unavailable.", true);
      },
    },
    maximumAutomaticAttempts: 3,
    retryDelayMs: 60_000,
  });
  const task = await firstProcess.create(taskInput("restart-budget", "Restart budget"));
  await eventually(async () => (await firstProcess.get(task.taskId)).state === "queued");
  await firstProcess.close();

  const restarted = new TaskExecutionCoordinator({
    taskService: new TaskService({ clock, eventStore }),
    executor: {
      async execute() {
        attempts += 1;
        throw new TaskExecutorError("WORKER_OFFLINE", "Worker is unavailable.", true);
      },
    },
    maximumAutomaticAttempts: 3,
    retryDelayMs: 0,
  });
  await restarted.start();
  await restarted.waitForIdle();

  assert.equal(attempts, 3);
  assert.equal((await restarted.get(task.taskId)).state, "failed");
  await restarted.close();
});

test("durable hard Budget exhaustion pauses automatic retry before another Agent turn", async () => {
  let now = Date.parse("2026-07-25T12:00:00.000Z");
  const budgetClock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const taskService = new TaskService({
    clock: { now: () => new Date(now).toISOString() },
    eventStore,
  });
  const completeLimits = {
    wallTimeMs: { hard: 60_000 },
    idleTimeMs: { hard: 30_000 },
    retries: { hard: 1 },
    childWorkOrders: { hard: 4 },
    concurrentRuns: { hard: 2 },
    nativeTurns: { hard: 8 },
    tokens: { hard: 100_000 },
    costUsdMicros: { hard: 1_000_000 },
  } as const;
  const budget = new DurableTaskBudgetEnforcer({
    eventStore,
    clock: budgetClock,
    instanceLimits: completeLimits,
    requestedTaskDefaults: completeLimits,
    autonomousTaskDefaults: completeLimits,
    usageProxy: {
      tokensPerNativeTurn: 1_000,
      costUsdMicrosPerNativeTurn: 10_000,
    },
  });
  let attempts = 0;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    budget,
    executor: {
      async execute() {
        attempts += 1;
        now += 1;
        throw new TaskExecutorError("WORKER_OFFLINE", "Worker is unavailable.", true);
      },
    },
    maximumAutomaticAttempts: 3,
    retryDelayMs: 0,
  });

  const task = await coordinator.create(taskInput("durable-budget", "Durable Budget"));
  await coordinator.waitForIdle();

  const waiting = await coordinator.get(task.taskId);
  assert.equal(attempts, 2);
  assert.equal(waiting.state, "waiting_user");
  assert.match(waiting.messages.at(-1)?.content ?? "", /Budget/);
  assert.equal((await budget.snapshot(task.taskId)).usage.retries, 1);
  await coordinator.close();

  const restarted = new TaskExecutionCoordinator({
    taskService: new TaskService({
      clock: { now: () => new Date(now).toISOString() },
      eventStore,
    }),
    budget: new DurableTaskBudgetEnforcer({
      eventStore,
      clock: budgetClock,
      instanceLimits: completeLimits,
      requestedTaskDefaults: completeLimits,
      autonomousTaskDefaults: completeLimits,
      usageProxy: {
        tokensPerNativeTurn: 1_000,
        costUsdMicrosPerNativeTurn: 10_000,
      },
    }),
    executor: {
      async execute() {
        attempts += 1;
        return { state: "failed" };
      },
    },
    retryDelayMs: 0,
  });
  await restarted.start();
  await restarted.waitForIdle();
  assert.equal(attempts, 2);
  await restarted.close();
});

test("active Budget exhaustion aborts and cancels authoritative work before pausing", async () => {
  let now = Date.parse("2026-07-25T12:30:00.000Z");
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const taskService = new TaskService({
    clock: { now: () => new Date(now).toISOString() },
    eventStore,
  });
  const completeLimits = {
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
    clock: { now: () => now },
    instanceLimits: completeLimits,
    requestedTaskDefaults: completeLimits,
    autonomousTaskDefaults: completeLimits,
    usageProxy: {
      tokensPerNativeTurn: 1_000,
      costUsdMicrosPerNativeTurn: 10_000,
    },
  });
  const cancellations: Array<{ readonly taskId: string; readonly reason: string }> = [];
  const executor: TaskExecutor = {
    async execute(request) {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        state: "completed",
        verifiedCompletionCriteria: [...request.task.completionCriteria],
      };
    },
    async cancel(request) {
      cancellations.push({
        taskId: request.taskId,
        reason: request.reason,
      });
    },
  };
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    budget,
    executor,
    retryDelayMs: 0,
  });
  const task = await coordinator.create(taskInput("active-budget", "Active Budget"));
  await eventually(async () => (await coordinator.get(task.taskId)).state === "running");

  now += 11;
  await budget.recordActivity({
    taskId: task.taskId,
    operationId: "active-budget-clock-tick",
    source: "worker-progress",
  });
  await coordinator.waitForIdle();

  const paused = await coordinator.get(task.taskId);
  assert.equal(paused.state, "waiting_user");
  assert.match(paused.messages.at(-1)?.content ?? "", /active automatic-execution limit/iu);
  assert.match(paused.messages.at(-1)?.content ?? "", /Waiting, paused, offline/iu);
  assert.doesNotMatch(paused.messages.at(-1)?.content ?? "", /wallTimeMs/u);
  assert.deepEqual(cancellations, [{ taskId: task.taskId, reason: "paused" }]);
  await coordinator.close();
});

test("idle exhaustion explains that owner continuation restarts the window", async () => {
  let now = Date.parse("2026-07-25T12:30:00.000Z");
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const taskService = new TaskService({
    clock: { now: () => new Date(now).toISOString() },
    eventStore,
  });
  const completeLimits = {
    wallTimeMs: { hard: 60_000 },
    idleTimeMs: { hard: 10 },
    retries: { hard: 1 },
    childWorkOrders: { hard: 4 },
    concurrentRuns: { hard: 2 },
    nativeTurns: { hard: 8 },
    tokens: { hard: 100_000 },
    costUsdMicros: { hard: 1_000_000 },
  } as const;
  const budget = new DurableTaskBudgetEnforcer({
    eventStore,
    clock: { now: () => now },
    instanceLimits: completeLimits,
    requestedTaskDefaults: completeLimits,
    autonomousTaskDefaults: completeLimits,
    usageProxy: {
      tokensPerNativeTurn: 1_000,
      costUsdMicrosPerNativeTurn: 10_000,
    },
  });
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    budget,
    executor: {
      async execute(request) {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { state: "failed" };
      },
    },
    retryDelayMs: 0,
  });
  const task = await coordinator.create(taskInput("idle-budget-message", "Idle Budget message"));
  await eventually(async () => (await coordinator.get(task.taskId)).state === "running");

  now += 11;
  await eventually(async () => (await coordinator.get(task.taskId)).state === "waiting_user");
  await coordinator.waitForIdle();

  const paused = await coordinator.get(task.taskId);
  const message = paused.messages.at(-1)?.content ?? "";
  assert.match(message, /without verified activity/iu);
  assert.match(message, /new message.*Retry\/Resume/iu);
  assert.match(message, /does not require a Budget extension/iu);
  assert.doesNotMatch(message, /idleTimeMs/u);
  await coordinator.close();
});

test("pause aborts active execution and a delayed completion cannot overwrite the durable pause", async () => {
  const taskService = fixture();
  let release: (() => void) | undefined;
  let observedAbort = false;
  const executor: TaskExecutor = {
    async execute(request) {
      await new Promise<void>((resolve) => {
        release = resolve;
        request.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true },
        );
      });
      return {
        state: "completed",
        verifiedCompletionCriteria: [...request.task.completionCriteria],
      };
    },
  };
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    executor,
    retryDelayMs: 0,
  });
  const task = await coordinator.create(taskInput("pause", "Pause"));
  await eventually(async () => (await coordinator.get(task.taskId)).state === "running");

  const paused = await coordinator.command({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "pause-command",
    command: "pause",
  });
  assert.equal(paused.state, "paused");
  release?.();
  await coordinator.waitForIdle();

  assert.equal(observedAbort, true);
  assert.equal((await coordinator.get(task.taskId)).state, "paused");
  await coordinator.close();
});

test("a reply through the same interface resumes waiting execution exactly once", async () => {
  const taskService = fixture();
  let calls = 0;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    executor: {
      async execute(request) {
        calls += 1;
        return calls === 1
          ? { state: "waiting_user" }
          : {
              state: "completed",
              verifiedCompletionCriteria: [...request.task.completionCriteria],
            };
      },
    },
    retryDelayMs: 0,
  });
  const task = await coordinator.create(taskInput("reply", "Reply"));
  await coordinator.waitForIdle();
  assert.equal((await coordinator.get(task.taskId)).state, "waiting_user");

  await coordinator.appendInput({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "reply-1",
    message: "Proceed with the private route.",
    selectedInputRefs: [],
  });
  await coordinator.waitForIdle();

  assert.equal(calls, 2);
  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  await coordinator.close();
});

test("an owner reply resets an expired idle Budget before resuming execution", async () => {
  let now = Date.parse("2026-07-25T12:00:00.000Z");
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const taskService = new TaskService({
    clock: { now: () => new Date(now).toISOString() },
    eventStore,
  });
  const completeLimits = {
    wallTimeMs: { hard: 120_000 },
    idleTimeMs: { hard: 30_000 },
    retries: { hard: 4 },
    childWorkOrders: { hard: 4 },
    concurrentRuns: { hard: 2 },
    nativeTurns: { hard: 8 },
    tokens: { hard: 100_000 },
    costUsdMicros: { hard: 1_000_000 },
  } as const;
  const budget = new DurableTaskBudgetEnforcer({
    eventStore,
    clock: { now: () => now },
    instanceLimits: completeLimits,
    requestedTaskDefaults: completeLimits,
    autonomousTaskDefaults: completeLimits,
    usageProxy: {
      tokensPerNativeTurn: 1_000,
      costUsdMicrosPerNativeTurn: 10_000,
    },
  });
  let calls = 0;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    budget,
    executor: {
      async execute(request) {
        calls += 1;
        return calls === 1
          ? {
              state: "waiting_user",
              publicMessage: "Which route should I use?",
            }
          : {
              state: "completed",
              verifiedCompletionCriteria: [...request.task.completionCriteria],
            };
      },
    },
    retryDelayMs: 0,
  });
  const task = await coordinator.create(taskInput("idle-owner-reply", "Idle owner reply"));
  await coordinator.waitForIdle();
  assert.equal((await coordinator.get(task.taskId)).state, "waiting_user");

  now += 30_001;
  await coordinator.appendInput({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "idle-owner-reply-answer",
    message: "Use the registered route.",
    selectedInputRefs: [],
  });
  await coordinator.waitForIdle();

  assert.equal(calls, 2);
  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  assert.equal((await budget.snapshot(task.taskId)).usage.idleTimeMs, 0);
  await coordinator.close();
});

test("an owner retry resets an expired idle Budget before starting a new execution cycle", async () => {
  let now = Date.parse("2026-07-25T12:00:00.000Z");
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const taskService = new TaskService({
    clock: { now: () => new Date(now).toISOString() },
    eventStore,
  });
  const completeLimits = {
    wallTimeMs: { hard: 120_000 },
    idleTimeMs: { hard: 30_000 },
    retries: { hard: 4 },
    childWorkOrders: { hard: 4 },
    concurrentRuns: { hard: 2 },
    nativeTurns: { hard: 8 },
    tokens: { hard: 100_000 },
    costUsdMicros: { hard: 1_000_000 },
  } as const;
  const budget = new DurableTaskBudgetEnforcer({
    eventStore,
    clock: { now: () => now },
    instanceLimits: completeLimits,
    requestedTaskDefaults: completeLimits,
    autonomousTaskDefaults: completeLimits,
    usageProxy: {
      tokensPerNativeTurn: 1_000,
      costUsdMicrosPerNativeTurn: 10_000,
    },
  });
  let calls = 0;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    budget,
    executor: {
      async execute(request) {
        calls += 1;
        return calls === 1
          ? {
              state: "failed",
              publicMessage: "The Worker was temporarily unavailable.",
            }
          : {
              state: "completed",
              verifiedCompletionCriteria: [...request.task.completionCriteria],
            };
      },
    },
    retryDelayMs: 0,
  });
  const task = await coordinator.create(taskInput("idle-owner-retry", "Idle owner retry"));
  await coordinator.waitForIdle();
  assert.equal((await coordinator.get(task.taskId)).state, "failed");

  now += 30_001;
  await coordinator.command({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "idle-owner-retry-command",
    command: "retry",
  });
  await coordinator.waitForIdle();

  assert.equal(calls, 2);
  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  assert.equal((await budget.snapshot(task.taskId)).usage.idleTimeMs, 0);
  await coordinator.close();
});

test("an owner approval resets an expired idle Budget before execution resumes", async () => {
  let now = Date.parse("2026-07-25T12:00:00.000Z");
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const taskService = new TaskService({
    clock: { now: () => new Date(now).toISOString() },
    eventStore,
  });
  const completeLimits = {
    wallTimeMs: { hard: 120_000 },
    idleTimeMs: { hard: 30_000 },
    retries: { hard: 4 },
    childWorkOrders: { hard: 4 },
    concurrentRuns: { hard: 2 },
    nativeTurns: { hard: 8 },
    tokens: { hard: 100_000 },
    costUsdMicros: { hard: 1_000_000 },
  } as const;
  const budget = new DurableTaskBudgetEnforcer({
    eventStore,
    clock: { now: () => now },
    instanceLimits: completeLimits,
    requestedTaskDefaults: completeLimits,
    autonomousTaskDefaults: completeLimits,
    usageProxy: {
      tokensPerNativeTurn: 1_000,
      costUsdMicrosPerNativeTurn: 10_000,
    },
  });
  let calls = 0;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    budget,
    executor: {
      async execute(request) {
        calls += 1;
        return calls === 1
          ? {
              state: "waiting_user",
              publicMessage: "Approve this action before continuing.",
            }
          : {
              state: "completed",
              verifiedCompletionCriteria: [...request.task.completionCriteria],
            };
      },
    },
    retryDelayMs: 0,
  });
  const task = await coordinator.create(taskInput("idle-owner-approval", "Idle owner approval"));
  await coordinator.waitForIdle();
  assert.equal((await coordinator.get(task.taskId)).state, "waiting_user");

  now += 30_001;
  await coordinator.resolveApproval({
    taskId: task.taskId,
    approvalId: "approval-after-idle",
    principalId: "owner-1",
    idempotencyKey: "idle-owner-approval-command",
    decision: "approve",
  });
  await coordinator.waitForIdle();

  assert.equal(calls, 2);
  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  assert.equal((await budget.snapshot(task.taskId)).usage.idleTimeMs, 0);
  await coordinator.close();
});

test("execution concurrency is bounded while independent Tasks still run in parallel", async () => {
  const taskService = fixture();
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    maximumConcurrentTasks: 2,
    executor: {
      async execute(request) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return {
          state: "completed",
          verifiedCompletionCriteria: [...request.task.completionCriteria],
        };
      },
    },
    retryDelayMs: 0,
  });

  await Promise.all([
    coordinator.create(taskInput("parallel-1", "Parallel one")),
    coordinator.create(taskInput("parallel-2", "Parallel two")),
    coordinator.create(taskInput("parallel-3", "Parallel three")),
  ]);
  await eventually(() => Promise.resolve(releases.length === 2));
  releases.splice(0).forEach((release) => release());
  await eventually(() => Promise.resolve(releases.length === 1));
  releases.splice(0).forEach((release) => release());
  await coordinator.waitForIdle();

  assert.equal(maximumActive, 2);
  await coordinator.close();
});

test("user-answer turns do not consume the bounded automatic retry budget", async () => {
  const taskService = fixture();
  let calls = 0;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    maximumAutomaticAttempts: 2,
    retryDelayMs: 0,
    executor: {
      async execute(request) {
        calls += 1;
        return calls < 5
          ? { state: "waiting_user" }
          : {
              state: "completed",
              verifiedCompletionCriteria: [...request.task.completionCriteria],
            };
      },
    },
  });
  const task = await coordinator.create(taskInput("long-conversation", "Long conversation"));

  for (let reply = 1; reply <= 4; reply += 1) {
    await coordinator.waitForIdle();
    assert.equal((await coordinator.get(task.taskId)).state, "waiting_user");
    await coordinator.appendInput({
      taskId: task.taskId,
      principalId: "owner-1",
      idempotencyKey: `long-conversation-reply-${reply}`,
      message: `Owner answer ${reply}.`,
      selectedInputRefs: [],
    });
  }
  await coordinator.waitForIdle();

  assert.equal(calls, 5);
  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  await coordinator.close();
});

test("an explicit retry starts a fresh execution cycle with a distinct execution key", async () => {
  const taskService = fixture();
  const executionKeys: string[] = [];
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    maximumAutomaticAttempts: 1,
    retryDelayMs: 0,
    executor: {
      async execute(request) {
        executionKeys.push(request.executionKey);
        return executionKeys.length === 1
          ? { state: "failed" }
          : {
              state: "completed",
              verifiedCompletionCriteria: [...request.task.completionCriteria],
            };
      },
    },
  });
  const task = await coordinator.create(taskInput("explicit-retry", "Explicit retry"));
  await coordinator.waitForIdle();
  assert.equal((await coordinator.get(task.taskId)).state, "failed");

  await coordinator.command({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "explicit-retry-command",
    command: "retry",
  });
  await coordinator.waitForIdle();

  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  assert.equal(executionKeys.length, 2);
  assert.notEqual(executionKeys[0], executionKeys[1]);
  await coordinator.close();
});

test("new Task input fences a stale in-flight result and executes the new conversation turn", async () => {
  const taskService = fixture();
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  const coordinator = new TaskExecutionCoordinator({
    taskService,
    retryDelayMs: 0,
    executor: {
      async execute(request) {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {
          state: "completed",
          verifiedCompletionCriteria: [...request.task.completionCriteria],
        };
      },
    },
  });
  const task = await coordinator.create(taskInput("fenced-input", "Fenced input"));
  await eventually(async () => (await coordinator.get(task.taskId)).state === "running");

  await coordinator.appendInput({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "fenced-input-reply",
    message: "Use the newly selected input instead.",
    selectedInputRefs: ["artifact-new-input"],
  });
  releaseFirst?.();
  await coordinator.waitForIdle();

  assert.equal(calls, 2);
  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  await coordinator.close();
});

test("input arriving before the running record supersedes only that attempt, not the pipeline", async () => {
  const taskService = fixture();
  let enterExecutionCycle: (() => void) | undefined;
  let releaseExecutionCycle: (() => void) | undefined;
  let blockFirstCycle = true;
  const executionCycleEntered = new Promise<void>((resolve) => {
    enterExecutionCycle = resolve;
  });
  const executionCycleReleased = new Promise<void>((resolve) => {
    releaseExecutionCycle = resolve;
  });
  const requests: TaskExecutionRequest[] = [];
  const coordinator = new TaskExecutionCoordinator({
    taskService: {
      create: taskService.create.bind(taskService),
      get: taskService.get.bind(taskService),
      list: taskService.list.bind(taskService),
      command: taskService.command.bind(taskService),
      appendInput: taskService.appendInput.bind(taskService),
      resolveApproval: taskService.resolveApproval.bind(taskService),
      executionHistory: taskService.executionHistory.bind(taskService),
      async executionCycle(taskId) {
        if (blockFirstCycle) {
          blockFirstCycle = false;
          enterExecutionCycle?.();
          await executionCycleReleased;
        }
        return taskService.executionCycle(taskId);
      },
      recordExecution: taskService.recordExecution.bind(taskService),
    },
    executor: {
      async execute(request) {
        requests.push(request);
        return {
          state: "completed",
          verifiedCompletionCriteria: [...request.task.completionCriteria],
        };
      },
    },
    retryDelayMs: 0,
  });
  const task = await coordinator.create(taskInput("pre-running-input", "Pre-running input"));
  await executionCycleEntered;

  await coordinator.appendInput({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "pre-running-reply",
    message: "Use the newest owner instruction.",
    selectedInputRefs: [],
  });
  releaseExecutionCycle?.();
  await coordinator.waitForIdle();

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.task.messages.at(-1)?.content, "Use the newest owner instruction.");
  assert.equal((await coordinator.get(task.taskId)).state, "completed");
  await coordinator.close();
});

test("a Task-state persistence failure is surfaced without an unhandled execution promise", async () => {
  const taskService = fixture();
  const coordinator = new TaskExecutionCoordinator({
    taskService: {
      create: taskService.create.bind(taskService),
      get: taskService.get.bind(taskService),
      list: taskService.list.bind(taskService),
      command: taskService.command.bind(taskService),
      appendInput: taskService.appendInput.bind(taskService),
      resolveApproval: taskService.resolveApproval.bind(taskService),
      executionHistory: taskService.executionHistory.bind(taskService),
      executionCycle: taskService.executionCycle.bind(taskService),
      async recordExecution() {
        throw new Error("simulated database outage");
      },
    },
    executor: {
      async execute() {
        return { state: "failed" };
      },
    },
    retryDelayMs: 0,
  });
  await coordinator.create(taskInput("persistence-failure", "Persistence failure"));

  await assert.rejects(
    coordinator.waitForIdle(),
    (error: unknown) =>
      error instanceof TaskExecutionCoordinatorError && error.code === "EXECUTION_PIPELINE_FAILED",
  );
  assert.equal((await coordinator.list()).length, 1);
  await coordinator.close();
});

function fixture(): TaskService {
  return new TaskService({
    clock,
    eventStore: new InMemoryEventStore({ clock }),
  });
}

function taskInput(key: string, objective: string) {
  return {
    principalId: "owner-1",
    idempotencyKey: key,
    objective,
    completionCriteria: [`${objective} is complete.`],
    constraints: [],
    selectedInputRefs: [],
  };
}

async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Condition did not become true.");
}
