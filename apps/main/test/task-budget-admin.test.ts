import assert from "node:assert/strict";
import test from "node:test";

import { TaskBudgetAdminPortError } from "@opendelegate/control-plane";
import type { BudgetLimits } from "@opendelegate/domain";
import { InMemoryEventStore } from "@opendelegate/event-store";
import type { TaskBudgetLimitsV1 } from "@opendelegate/protocol";
import { DurableTaskBudgetEnforcer } from "@opendelegate/task-service";

import { createMainTaskBudgetAdmin } from "../src/task-budget-admin.ts";

const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");

test("Main projects durable Budget warnings and applies one owner-scoped idempotent extension", async () => {
  let now = NOW_MS;
  const clock = { now: () => now };
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(now).toISOString() },
  });
  const requested = limits();
  const authority = new DurableTaskBudgetEnforcer({
    eventStore,
    clock,
    instanceLimits: limits({
      tokens: { soft: 1_500, hard: 2_000 },
      costUsdMicros: { soft: 15_000, hard: 20_000 },
    }),
    requestedTaskDefaults: requested,
    autonomousTaskDefaults: requested,
    usageProxy: {
      tokensPerNativeTurn: 850,
      costUsdMicrosPerNativeTurn: 100,
    },
  });
  await authority.ensureTask({ taskId: "task_budget_release", kind: "requested" });
  now += 1;
  await authority.beginNativeTurn({
    taskId: "task_budget_release",
    operationId: "planner-turn-1",
    source: "main-planner",
  });
  const admin = createMainTaskBudgetAdmin(authority);

  const before = await admin.get("task_budget_release");
  assert.equal(before.usage.tokens, 850);
  assert.deepEqual(
    before.limitEvents.map((event) => [event.metric, event.state]),
    [["tokens", "soft-limit"]],
  );
  assert.equal("source" in before.limitEvents[0]!, false);

  now += 1;
  const nextLimits: TaskBudgetLimitsV1 = {
    ...(requested as TaskBudgetLimitsV1),
    tokens: { soft: 1_200, hard: 1_500 },
  };
  const request = {
    taskId: before.taskId,
    principalId: "owner_personal",
    idempotencyKey: "extend-release-budget",
    baseRevision: before.revision,
    limits: nextLimits,
  };
  const extended = await admin.extend(request);
  assert.equal(extended.revision, before.revision + 1);
  assert.equal(extended.limits.tokens.hard, 1_500);
  assert.deepEqual(await admin.extend(request), extended);
  assert.deepEqual(extended.extensions, [
    {
      eventId: extended.extensions[0]?.eventId,
      baseRevision: before.revision,
      revision: before.revision + 1,
      occurredAt: new Date(now).toISOString(),
      actorId: "owner_personal",
      limits: nextLimits,
    },
  ]);

  const extensionEvents = (await eventStore.readAll()).filter(
    (event) =>
      event.type === "task.budget-mutation-recorded" &&
      typeof event.payload === "object" &&
      event.payload !== null &&
      (event.payload as { extension?: unknown }).extension !== null,
  );
  assert.equal(extensionEvents.length, 1);
  assert.equal(
    (
      extensionEvents[0]?.payload as {
        extension: { ownerId: string; baseRevision: number };
      }
    ).extension.ownerId,
    "owner_personal",
  );

  await assert.rejects(
    admin.extend({
      ...request,
      idempotencyKey: "stale-extension",
    }),
    (error: unknown) =>
      error instanceof TaskBudgetAdminPortError && error.code === "TASK_BUDGET_REVISION_CONFLICT",
  );
  await assert.rejects(
    admin.extend({
      ...request,
      idempotencyKey: "above-instance-ceiling",
      baseRevision: extended.revision,
      limits: {
        ...nextLimits,
        tokens: { soft: 2_100, hard: 2_500 },
      },
    }),
    (error: unknown) =>
      error instanceof TaskBudgetAdminPortError &&
      error.code === "TASK_BUDGET_PARENT_LIMIT_EXCEEDED",
  );
  await assert.rejects(
    admin.extend({
      ...request,
      idempotencyKey: "incomplete-limits",
      baseRevision: extended.revision,
      limits: {
        tokens: { hard: 1_600 },
      } as TaskBudgetLimitsV1,
    }),
    (error: unknown) =>
      error instanceof TaskBudgetAdminPortError && error.code === "TASK_BUDGET_INVALID",
  );
});

test("Main maps a missing durable Task Budget to a bounded owner-facing error", async () => {
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(NOW_MS).toISOString() },
  });
  const authority = new DurableTaskBudgetEnforcer({
    eventStore,
    clock: { now: () => NOW_MS },
    instanceLimits: limits(),
    requestedTaskDefaults: limits(),
    autonomousTaskDefaults: limits(),
    usageProxy: {
      tokensPerNativeTurn: 100,
      costUsdMicrosPerNativeTurn: 1_000,
    },
  });

  await assert.rejects(
    createMainTaskBudgetAdmin(authority).get("task_missing"),
    (error: unknown) =>
      error instanceof TaskBudgetAdminPortError && error.code === "TASK_BUDGET_NOT_FOUND",
  );
});

function limits(overrides: BudgetLimits = {}): BudgetLimits {
  return {
    wallTimeMs: { soft: 50_000, hard: 60_000 },
    idleTimeMs: { soft: 5_000, hard: 10_000 },
    retries: { soft: 1, hard: 2 },
    childWorkOrders: { soft: 1, hard: 2 },
    concurrentRuns: { soft: 1, hard: 2 },
    nativeTurns: { soft: 3, hard: 4 },
    tokens: { soft: 800, hard: 1_000 },
    costUsdMicros: { soft: 8_000, hard: 10_000 },
    ...overrides,
  };
}
