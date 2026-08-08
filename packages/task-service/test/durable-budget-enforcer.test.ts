import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetLimits } from "@opendelegate/domain";
import { InMemoryEventStore } from "@opendelegate/event-store";
import { PROTOCOL_VERSION, type WorkOrderV1 } from "@opendelegate/protocol";

import { BudgetHardLimitError, DurableTaskBudgetEnforcer } from "../src/durable-budget-enforcer.ts";

const limits = (overrides: BudgetLimits = {}): BudgetLimits => ({
  wallTimeMs: { soft: 50_000, hard: 60_000 },
  idleTimeMs: { soft: 5_000, hard: 10_000 },
  retries: { soft: 1, hard: 2 },
  childWorkOrders: { soft: 1, hard: 2 },
  concurrentRuns: { soft: 1, hard: 2 },
  nativeTurns: { soft: 3, hard: 4 },
  tokens: { soft: 800, hard: 1_000 },
  costUsdMicros: { soft: 8_000, hard: 10_000 },
  ...overrides,
});

const workOrder = (workOrderId: string, budgetLimits?: BudgetLimits): WorkOrderV1 => ({
  protocolVersion: PROTOCOL_VERSION,
  workOrderId,
  title: `Work ${workOrderId}`,
  brief: `Complete ${workOrderId}.`,
  completionCriteria: [`Return ${workOrderId}.`],
  constraints: [],
  selectedInputIds: [],
  dependsOn: [],
  schedulingHints: {
    preferredDeviceIds: [],
    preferredRoles: [],
  },
  requiredCapabilities: [],
  requiredSecretRefs: [],
  ...(budgetLimits === undefined ? {} : { budgetLimits }),
});

const waitUntil = async (condition: () => boolean | Promise<boolean>, failure: string) => {
  const deadline = Date.now() + 500;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(failure);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

test("a runaway plan cannot create unbounded child work or regain budget after restart", async () => {
  let now = 1_000;
  const clock = {
    now: () => now,
  };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const options = {
    eventStore,
    clock,
    instanceLimits: limits({ childWorkOrders: { soft: 2, hard: 3 } }),
    requestedTaskDefaults: limits(),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  } as const;
  const firstProcess = new DurableTaskBudgetEnforcer(options);

  await firstProcess.ensureTask({ taskId: "task-runaway", kind: "requested" });
  await firstProcess.registerWorkOrders({
    taskId: "task-runaway",
    operationId: "plan-1",
    workOrders: [workOrder("work-1"), workOrder("work-2")],
  });
  await firstProcess.registerWorkOrders({
    taskId: "task-runaway",
    operationId: "plan-1",
    workOrders: [workOrder("work-1"), workOrder("work-2")],
  });

  await assert.rejects(
    firstProcess.registerWorkOrders({
      taskId: "task-runaway",
      operationId: "plan-2",
      workOrders: [workOrder("work-1"), workOrder("work-2"), workOrder("work-3")],
    }),
    (error: unknown) =>
      error instanceof BudgetHardLimitError &&
      error.metric === "childWorkOrders" &&
      error.code === "BUDGET_HARD_LIMIT_REACHED",
  );

  now += 1;
  const restarted = new DurableTaskBudgetEnforcer(options);
  const restored = await restarted.snapshot("task-runaway");
  assert.equal(restored.usage.childWorkOrders, 2);
  assert.deepEqual(
    restored.workOrders.map((entry) => entry.workOrderId),
    ["work-1", "work-2"],
  );
  assert.equal(
    restored.limitEvents.some(
      (event) => event.metric === "childWorkOrders" && event.state === "hard-limit",
    ),
    true,
  );

  await assert.rejects(
    restarted.extendTask({
      taskId: "task-runaway",
      operationId: "agent-extension",
      baseRevision: restored.revision,
      authority: { kind: "main-agent", authorityId: "main-agent" },
      limits: limits({ childWorkOrders: { hard: 3 } }),
    }),
    /Only the Owner/,
  );

  const extended = await restarted.extendTask({
    taskId: "task-runaway",
    operationId: "owner-extension",
    baseRevision: restored.revision,
    authority: { kind: "owner", authorityId: "owner-personal" },
    limits: { childWorkOrders: { soft: 2, hard: 3 } },
  });
  assert.equal(extended.revision, restored.revision + 1);
  assert.deepEqual(
    await restarted.extendTask({
      taskId: "task-runaway",
      operationId: "owner-extension",
      baseRevision: restored.revision,
      authority: { kind: "owner", authorityId: "owner-personal" },
      limits: { childWorkOrders: { soft: 2, hard: 3 } },
    }),
    extended,
  );
  assert.deepEqual(extended.extensions, [
    {
      eventId: extended.extensions[0]?.eventId,
      baseRevision: restored.revision,
      revision: extended.revision,
      occurredAtMs: now,
      ownerId: "owner-personal",
      limits: extended.limits,
    },
  ]);
  await assert.rejects(
    restarted.extendTask({
      taskId: "task-runaway",
      operationId: "owner-extension",
      baseRevision: restored.revision,
      authority: { kind: "owner", authorityId: "owner-personal" },
      limits: { childWorkOrders: { soft: 1, hard: 3 } },
    }),
    /operation identity was reused/u,
  );
  await restarted.registerWorkOrders({
    taskId: "task-runaway",
    operationId: "plan-2-after-owner-extension",
    workOrders: [workOrder("work-1"), workOrder("work-2"), workOrder("work-3")],
  });
  assert.equal((await restarted.snapshot("task-runaway")).usage.childWorkOrders, 3);
  const afterExtensionRestart = new DurableTaskBudgetEnforcer(options);
  assert.equal(
    (
      await afterExtensionRestart.ensureTask({
        taskId: "task-runaway",
        kind: "requested",
      })
    ).revision,
    2,
  );
});

test("an exact owner extension replay remains idempotent after a later revision", async () => {
  let now = 5_000;
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const options = {
    eventStore,
    clock: { now: () => now },
    instanceLimits: limits({ childWorkOrders: { soft: 2, hard: 3 } }),
    requestedTaskDefaults: limits(),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  } as const;
  const authority = new DurableTaskBudgetEnforcer(options);
  const initial = await authority.ensureTask({
    taskId: "task-extension-replay",
    kind: "requested",
  });

  now += 1;
  const first = await authority.extendTask({
    taskId: initial.taskId,
    operationId: "owner-extension-a",
    baseRevision: initial.revision,
    authority: { kind: "owner", authorityId: "owner-personal" },
    limits: { childWorkOrders: { soft: 2, hard: 2 } },
  });
  now += 1;
  const second = await authority.extendTask({
    taskId: initial.taskId,
    operationId: "owner-extension-b",
    baseRevision: first.revision,
    authority: { kind: "owner", authorityId: "owner-personal" },
    limits: { childWorkOrders: { soft: 2, hard: 3 } },
  });

  now += 1;
  const restarted = new DurableTaskBudgetEnforcer(options);
  const replayed = await restarted.extendTask({
    taskId: initial.taskId,
    operationId: "owner-extension-a",
    baseRevision: initial.revision,
    authority: { kind: "owner", authorityId: "owner-personal" },
    limits: { childWorkOrders: { soft: 2, hard: 2 } },
  });
  assert.equal(replayed.revision, second.revision);
  assert.deepEqual(replayed.limits, second.limits);
  assert.deepEqual(replayed.extensions, second.extensions);
  assert.equal(second.extensions.length, 2);
  await assert.rejects(
    restarted.extendTask({
      taskId: initial.taskId,
      operationId: "owner-extension-a",
      baseRevision: initial.revision,
      authority: { kind: "owner", authorityId: "owner-personal" },
      limits: { childWorkOrders: { soft: 1, hard: 2 } },
    }),
    /operation identity was reused/u,
  );
});

test("a Work Order budget is bounded by its Task and provider usage replaces only missing proxy evidence", async () => {
  let now = 10_000;
  const clock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const enforcer = new DurableTaskBudgetEnforcer({
    eventStore,
    clock,
    instanceLimits: limits(),
    requestedTaskDefaults: limits({
      concurrentRuns: { hard: 1 },
      nativeTurns: { hard: 3 },
      tokens: { hard: 250 },
      costUsdMicros: { hard: 5_000 },
    }),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  });
  await enforcer.ensureTask({ taskId: "task-provider-usage", kind: "requested" });

  await assert.rejects(
    enforcer.registerWorkOrders({
      taskId: "task-provider-usage",
      operationId: "oversized-child",
      workOrders: [
        workOrder("work-too-large", {
          tokens: { hard: 251 },
        }),
      ],
    }),
    /cannot exceed its parent Task Budget/,
  );

  await enforcer.registerWorkOrders({
    taskId: "task-provider-usage",
    operationId: "bounded-child",
    workOrders: [
      workOrder("work-bounded", {
        nativeTurns: { hard: 2 },
        tokens: { hard: 250 },
        costUsdMicros: { hard: 5_000 },
      }),
    ],
  });
  await enforcer.beginWorkerRun({
    taskId: "task-provider-usage",
    workOrderId: "work-bounded",
    runId: "run-1",
    attempt: 1,
  });
  now += 1;
  await new DurableTaskBudgetEnforcer({
    eventStore,
    clock,
    instanceLimits: limits(),
    requestedTaskDefaults: limits({
      concurrentRuns: { hard: 1 },
      nativeTurns: { hard: 3 },
      tokens: { hard: 250 },
      costUsdMicros: { hard: 5_000 },
    }),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  }).beginWorkerRun({
    taskId: "task-provider-usage",
    workOrderId: "work-bounded",
    runId: "run-1",
    attempt: 1,
  });
  await assert.rejects(
    enforcer.beginWorkerRun({
      taskId: "task-provider-usage",
      workOrderId: "work-bounded",
      runId: "run-concurrent",
      attempt: 1,
    }),
    (error: unknown) => error instanceof BudgetHardLimitError && error.metric === "concurrentRuns",
  );

  now += 1;
  await enforcer.finishWorkerRun({
    taskId: "task-provider-usage",
    workOrderId: "work-bounded",
    runId: "run-1",
    usage: {
      inputTokens: 120,
      outputTokens: 80,
      costUsdMicros: 1_500,
    },
  });
  const afterUsage = await enforcer.snapshot("task-provider-usage");
  assert.equal(afterUsage.usage.concurrentRuns, 0);
  assert.equal(afterUsage.usage.nativeTurns, 1);
  assert.equal(afterUsage.usage.tokens, 200);
  assert.equal(afterUsage.usage.costUsdMicros, 1_500);

  const restartedWithUnsafeLowerProxy = new DurableTaskBudgetEnforcer({
    eventStore,
    clock,
    instanceLimits: limits(),
    requestedTaskDefaults: limits({
      concurrentRuns: { hard: 1 },
      nativeTurns: { hard: 3 },
      tokens: { hard: 250 },
      costUsdMicros: { hard: 5_000 },
    }),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 1,
      costUsdMicrosPerNativeTurn: 1,
    },
  });
  await assert.rejects(
    restartedWithUnsafeLowerProxy.beginWorkerRun({
      taskId: "task-provider-usage",
      workOrderId: "work-bounded",
      runId: "run-2",
      attempt: 2,
    }),
    (error: unknown) =>
      error instanceof BudgetHardLimitError && error.metric === "tokens" && error.current === 200,
  );
  assert.equal((await enforcer.snapshot("task-provider-usage")).usage.concurrentRuns, 0);
});

test("a smaller Work Order retry Budget survives restart and blocks a replacement Run", async () => {
  let now = 40_000;
  const clock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const options = {
    eventStore,
    clock,
    instanceLimits: limits(),
    requestedTaskDefaults: limits(),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  } as const;
  const enforcer = new DurableTaskBudgetEnforcer(options);
  await enforcer.ensureTask({ taskId: "task-child-retries", kind: "requested" });
  await enforcer.registerWorkOrders({
    taskId: "task-child-retries",
    operationId: "child-retry-plan",
    workOrders: [
      workOrder("work-no-retries", {
        retries: { hard: 0 },
      }),
    ],
  });
  await enforcer.beginWorkerRun({
    taskId: "task-child-retries",
    workOrderId: "work-no-retries",
    runId: "run-first",
    attempt: 1,
  });
  now += 1;
  await enforcer.finishWorkerRun({
    taskId: "task-child-retries",
    workOrderId: "work-no-retries",
    runId: "run-first",
  });

  const restarted = new DurableTaskBudgetEnforcer(options);
  await assert.rejects(
    restarted.beginWorkerRun({
      taskId: "task-child-retries",
      workOrderId: "work-no-retries",
      runId: "run-replacement",
      attempt: 2,
    }),
    (error: unknown) =>
      error instanceof BudgetHardLimitError &&
      error.metric === "retries" &&
      error.workOrderId === "work-no-retries",
  );
  const child = (await restarted.snapshot("task-child-retries")).workOrders[0];
  assert.equal(child?.usage.retries ?? 0, 0);
});

test("calendar age does not spend a requested Task wall Budget", async () => {
  let now = 42_000;
  const sevenDaysMs = 7 * 24 * 60 * 60_000;
  const clock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const taskLimits = limits({
    wallTimeMs: { hard: 10 },
    idleTimeMs: { hard: 15 * 24 * 60 * 60_000 },
  });
  const options = {
    eventStore,
    clock,
    instanceLimits: taskLimits,
    requestedTaskDefaults: taskLimits,
    autonomousTaskDefaults: taskLimits,
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  } as const;
  const enforcer = new DurableTaskBudgetEnforcer(options);
  await enforcer.ensureTask({ taskId: "task-long-lived", kind: "requested" });

  now += sevenDaysMs;
  assert.equal((await enforcer.snapshot("task-long-lived")).usage.wallTimeMs ?? 0, 0);

  const firstGuard = await enforcer.beginTaskExecution({
    taskId: "task-long-lived",
    executionKey: "execution-after-seven-days",
    attempt: 1,
    signal: new AbortController().signal,
  });
  now += 2;
  const parallelGuard = await enforcer.beginTaskExecution({
    taskId: "task-long-lived",
    executionKey: "parallel-execution",
    attempt: 1,
    signal: new AbortController().signal,
  });
  now += 4;
  await enforcer.recordActivity({
    taskId: "task-long-lived",
    operationId: "active-progress",
    source: "worker-progress",
  });
  assert.equal((await enforcer.snapshot("task-long-lived")).usage.wallTimeMs, 6);
  const processRestart = new DurableTaskBudgetEnforcer(options);
  assert.equal((await processRestart.snapshot("task-long-lived")).usage.wallTimeMs, 6);
  await firstGuard.close();
  await parallelGuard.close();

  now += sevenDaysMs;
  const restarted = new DurableTaskBudgetEnforcer(options);
  assert.equal((await restarted.snapshot("task-long-lived")).usage.wallTimeMs, 6);
});

test("a smaller Work Order wall Budget is measured durably from active Runs", async () => {
  let now = 43_000;
  const sevenDaysMs = 7 * 24 * 60 * 60_000;
  const clock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const parentLimits = limits({
    wallTimeMs: { hard: 30 * 24 * 60 * 60_000 },
    idleTimeMs: { hard: 30 * 24 * 60 * 60_000 },
  });
  const options = {
    eventStore,
    clock,
    instanceLimits: parentLimits,
    requestedTaskDefaults: parentLimits,
    autonomousTaskDefaults: parentLimits,
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  } as const;
  const enforcer = new DurableTaskBudgetEnforcer(options);
  await enforcer.ensureTask({ taskId: "task-child-wall", kind: "requested" });
  await enforcer.registerWorkOrders({
    taskId: "task-child-wall",
    operationId: "child-wall-plan",
    workOrders: [
      workOrder("work-short-wall", {
        wallTimeMs: { soft: 5, hard: 10 },
        idleTimeMs: { hard: 30 * 24 * 60 * 60_000 },
      }),
    ],
  });

  now += sevenDaysMs;
  assert.equal(
    (await enforcer.snapshot("task-child-wall")).workOrders[0]?.usage.wallTimeMs ?? 0,
    0,
  );
  await enforcer.beginWorkerRun({
    taskId: "task-child-wall",
    workOrderId: "work-short-wall",
    runId: "run-short-wall-1",
    attempt: 1,
  });
  now += 6;
  await enforcer.finishWorkerRun({
    taskId: "task-child-wall",
    workOrderId: "work-short-wall",
    runId: "run-short-wall-1",
  });
  assert.equal(
    (await enforcer.snapshot("task-child-wall")).limitEvents.some(
      (event) =>
        event.metric === "wallTimeMs" &&
        event.state === "soft-limit" &&
        event.workOrderId === "work-short-wall",
    ),
    true,
  );

  now += sevenDaysMs;
  const restarted = new DurableTaskBudgetEnforcer(options);
  assert.equal((await restarted.snapshot("task-child-wall")).workOrders[0]?.usage.wallTimeMs, 6);
  await restarted.beginWorkerRun({
    taskId: "task-child-wall",
    workOrderId: "work-short-wall",
    runId: "run-short-wall-2",
    attempt: 1,
  });
  now += 5;
  await restarted.finishWorkerRun({
    taskId: "task-child-wall",
    workOrderId: "work-short-wall",
    runId: "run-short-wall-2",
  });
  await assert.rejects(
    restarted.beginWorkerRun({
      taskId: "task-child-wall",
      workOrderId: "work-short-wall",
      runId: "run-after-exhausted-child-wall",
      attempt: 1,
    }),
    (error: unknown) =>
      error instanceof BudgetHardLimitError &&
      error.metric === "wallTimeMs" &&
      error.workOrderId === "work-short-wall",
  );
  assert.equal((await restarted.snapshot("task-child-wall")).workOrders[0]?.usage.wallTimeMs, 11);
});

test("an active Work Order hard deadline aborts the Task guard with child scope", async () => {
  let now = 44_000;
  const clock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const enforcer = new DurableTaskBudgetEnforcer({
    eventStore,
    clock,
    instanceLimits: limits(),
    requestedTaskDefaults: limits({
      wallTimeMs: { hard: 1_000 },
      idleTimeMs: { hard: 1_000 },
    }),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  });
  await enforcer.ensureTask({ taskId: "task-active-child-wall", kind: "requested" });
  const guard = await enforcer.beginTaskExecution({
    taskId: "task-active-child-wall",
    executionKey: "execution-active-child",
    attempt: 1,
    signal: new AbortController().signal,
  });
  await enforcer.registerWorkOrders({
    taskId: "task-active-child-wall",
    operationId: "active-child-plan",
    workOrders: [
      workOrder("work-active-child", {
        wallTimeMs: { soft: 5, hard: 10 },
        idleTimeMs: { hard: 1_000 },
      }),
    ],
  });
  await enforcer.beginWorkerRun({
    taskId: "task-active-child-wall",
    workOrderId: "work-active-child",
    runId: "run-active-child",
    attempt: 1,
  });

  now += 11;
  await enforcer.recordActivity({
    taskId: "task-active-child-wall",
    workOrderId: "work-active-child",
    operationId: "active-child-clock-tick",
    source: "worker-progress",
  });
  await waitUntil(
    () => guard.signal.aborted,
    "The active Work Order hard Budget did not abort the Task guard.",
  );

  assert.equal(guard.exhaustion()?.metric, "wallTimeMs");
  assert.equal(guard.exhaustion()?.workOrderId, "work-active-child");
  await enforcer.finishWorkerRun({
    taskId: "task-active-child-wall",
    workOrderId: "work-active-child",
    runId: "run-active-child",
  });
  await guard.close();
});

test("late provider evidence records a durable hard-limit event without hiding spent usage", async () => {
  let now = 45_000;
  const clock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const options = {
    eventStore,
    clock,
    instanceLimits: limits(),
    requestedTaskDefaults: limits({
      tokens: { soft: 120, hard: 150 },
    }),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  } as const;
  const enforcer = new DurableTaskBudgetEnforcer(options);
  await enforcer.ensureTask({ taskId: "task-provider-overage", kind: "requested" });
  await enforcer.registerWorkOrders({
    taskId: "task-provider-overage",
    operationId: "provider-overage-plan",
    workOrders: [workOrder("work-provider-overage")],
  });
  await enforcer.beginWorkerRun({
    taskId: "task-provider-overage",
    workOrderId: "work-provider-overage",
    runId: "run-provider-overage",
    attempt: 1,
  });
  now += 1;
  await enforcer.finishWorkerRun({
    taskId: "task-provider-overage",
    workOrderId: "work-provider-overage",
    runId: "run-provider-overage",
    usage: {
      inputTokens: 125,
      outputTokens: 75,
    },
  });

  const restarted = new DurableTaskBudgetEnforcer(options);
  const snapshot = await restarted.snapshot("task-provider-overage");
  assert.equal(snapshot.usage.tokens, 200);
  assert.equal(snapshot.usage.concurrentRuns, 0);
  assert.equal(
    snapshot.limitEvents.some(
      (event) =>
        event.metric === "tokens" &&
        event.state === "hard-limit" &&
        event.source === "worker-run-finish",
    ),
    true,
  );
});

test("wall, idle, and retry limits stop new execution deterministically after restart", async () => {
  let now = 50_000;
  const clock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const options = {
    eventStore,
    clock,
    instanceLimits: limits(),
    requestedTaskDefaults: limits({
      wallTimeMs: { hard: 1_000 },
      idleTimeMs: { hard: 500 },
      retries: { hard: 1 },
    }),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  } as const;
  const enforcer = new DurableTaskBudgetEnforcer(options);
  await enforcer.ensureTask({ taskId: "task-deadline", kind: "requested" });
  const first = await enforcer.beginTaskExecution({
    taskId: "task-deadline",
    executionKey: "execution-1",
    attempt: 1,
    signal: new AbortController().signal,
  });
  await first.close();

  const retry = await enforcer.beginTaskExecution({
    taskId: "task-deadline",
    executionKey: "execution-2",
    attempt: 2,
    signal: new AbortController().signal,
  });
  await retry.close();
  await assert.rejects(
    enforcer.beginTaskExecution({
      taskId: "task-deadline",
      executionKey: "execution-3",
      attempt: 3,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof BudgetHardLimitError && error.metric === "retries",
  );

  now += 501;
  const restarted = new DurableTaskBudgetEnforcer(options);
  await assert.rejects(
    restarted.beginTaskExecution({
      taskId: "task-deadline",
      executionKey: "execution-after-idle",
      attempt: 1,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof BudgetHardLimitError && error.metric === "idleTimeMs",
  );
  const snapshot = await restarted.snapshot("task-deadline");
  assert.equal(snapshot.usage.retries, 1);
  assert.equal(snapshot.usage.idleTimeMs, 501);
});

test("an active execution is aborted when its durable wall Budget expires", async () => {
  let now = 75_000;
  const clock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const enforcer = new DurableTaskBudgetEnforcer({
    eventStore,
    clock,
    instanceLimits: limits(),
    requestedTaskDefaults: limits({
      wallTimeMs: { soft: 5, hard: 10 },
      idleTimeMs: { hard: 1_000 },
    }),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  });
  await enforcer.ensureTask({ taskId: "task-active-deadline", kind: "requested" });
  const guard = await enforcer.beginTaskExecution({
    taskId: "task-active-deadline",
    executionKey: "execution-active",
    attempt: 1,
    signal: new AbortController().signal,
  });
  const aborted = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("The active Task Budget guard did not abort.")),
      500,
    );
    guard.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });

  now += 6;
  await enforcer.recordActivity({
    taskId: "task-active-deadline",
    operationId: "activity-after-wall-soft-limit",
    source: "worker-progress",
  });
  await waitUntil(
    async () =>
      (await enforcer.snapshot("task-active-deadline")).limitEvents.some(
        (event) => event.metric === "wallTimeMs" && event.state === "soft-limit",
      ),
    "The active Task Budget guard did not publish its soft warning.",
  );
  assert.equal(guard.signal.aborted, false);

  now += 5;
  await enforcer.recordActivity({
    taskId: "task-active-deadline",
    operationId: "activity-after-wall-hard-limit",
    source: "worker-progress",
  });
  await aborted;

  assert.equal(guard.exhaustion()?.metric, "wallTimeMs");
  assert.equal(guard.exhaustion()?.state, "hard-limit");
  assert.equal(
    (await enforcer.snapshot("task-active-deadline")).limitEvents.filter(
      (event) => event.metric === "wallTimeMs" && event.state === "hard-limit",
    ).length,
    1,
  );
  await guard.close();
});
