import assert from "node:assert/strict";
import test from "node:test";

import type { TaskChannelProjection } from "@opendelegate/discord-adapter";

import { DiscordMainRuntime } from "../src/discord-runtime.ts";

const NOW = "2026-08-10T00:00:00.000Z";

test("an observed activity revision survives a coalesced executor lookup until publication", async () => {
  const projections: TaskChannelProjection[] = [];
  let state: TaskChannelProjection["state"] = "running";
  const runtime = new DiscordMainRuntime({
    adapter: {
      start: () => Promise.resolve(),
      close: () => Promise.resolve(),
      createTaskThread: () => Promise.reject(new Error("not used")),
      flushOutbox: () => Promise.resolve(),
      reconcilePending: () => Promise.resolve(),
      publishTaskProjection: (projection) => {
        projections.push(structuredClone(projection));
        return Promise.resolve();
      },
    },
    repository: {
      getGatewayCursor: () => Promise.resolve(undefined),
      listBindings: () =>
        Promise.resolve([
          {
            guildId: "100000000000000001",
            forumChannelId: "100000000000000002",
            threadId: "100000000000000003",
            starterMessageId: "100000000000000003",
            taskId: "task-activity-handoff",
            externalState: "available" as const,
            archived: false,
            locked: false,
            revision: 1,
          },
        ]),
    },
    tasks: {
      get: () =>
        Promise.resolve({
          taskId: "task-activity-handoff",
          state,
          objective: "Coordinate two read-only checks.",
          updatedAt: NOW,
          messages: [],
          events: [],
        }),
    },
    taskActivity: { activity: () => Promise.resolve(undefined) },
    clock: { nowMs: () => 5_000 },
    synchronizationIntervalMs: 60_000,
  });

  await runtime.start();
  assert.equal(projections.at(-1)?.activity?.phase, "planning");
  assert.equal(projections.at(-1)?.activity?.totalWorkOrders, 0);
  runtime.observeTaskActivity("task-activity-handoff", {
    cycleId: "activity_cycle_live",
    revision: 2,
    updatedAtMs: 5_000,
    phase: "working",
    completedWorkOrders: 1,
    totalWorkOrders: 2,
    milestones: [
      {
        key: "work-order:nas",
        status: "completed",
        summary: "NAS finished its read-only check.",
        deviceId: "device_nas",
      },
    ],
  });
  await runtime.synchronizeNow();

  assert.deepEqual(projections.at(-1)?.activity, {
    cycleId: "activity_cycle_live",
    revision: 2,
    updatedAtMs: 5_000,
    phase: "working",
    completedWorkOrders: 1,
    totalWorkOrders: 2,
    milestones: [
      {
        key: "work-order:nas",
        status: "completed",
        summary: "NAS finished its read-only check.",
        deviceId: "device_nas",
      },
    ],
  });

  state = "completed";
  await runtime.synchronizeNow();
  state = "paused";
  await runtime.synchronizeNow();
  assert.equal(projections.at(-1)?.activity, undefined);

  await runtime.close();
});

test("a Task executor snapshot is narrowed to the durable Discord activity contract", async () => {
  const projections: TaskChannelProjection[] = [];
  const executorSnapshot = {
    taskId: "task-activity-boundary",
    cycleId: "activity_cycle_boundary",
    revision: 3,
    updatedAtMs: 6_000,
    phase: "working" as const,
    completedWorkOrders: 0,
    totalWorkOrders: 1,
    milestones: [
      {
        key: "work-order:windows",
        status: "active" as const,
        summary: "Windows is checking its deterministic context.",
        deviceId: "device_windows",
      },
    ],
  };
  const runtime = new DiscordMainRuntime({
    adapter: {
      start: () => Promise.resolve(),
      close: () => Promise.resolve(),
      createTaskThread: () => Promise.reject(new Error("not used")),
      flushOutbox: () => Promise.resolve(),
      reconcilePending: () => Promise.resolve(),
      publishTaskProjection: (projection) => {
        projections.push(structuredClone(projection));
        return Promise.resolve();
      },
    },
    repository: {
      getGatewayCursor: () => Promise.resolve(undefined),
      listBindings: () =>
        Promise.resolve([
          {
            guildId: "100000000000000001",
            forumChannelId: "100000000000000002",
            threadId: "100000000000000003",
            starterMessageId: "100000000000000003",
            taskId: "task-activity-boundary",
            externalState: "available" as const,
            archived: false,
            locked: false,
            revision: 1,
          },
        ]),
    },
    tasks: {
      get: () =>
        Promise.resolve({
          taskId: "task-activity-boundary",
          state: "running" as const,
          objective: "Coordinate a safe read-only check.",
          updatedAt: NOW,
          messages: [],
          events: [],
        }),
    },
    taskActivity: {
      activity: () =>
        Promise.resolve(
          executorSnapshot as unknown as NonNullable<TaskChannelProjection["activity"]>,
        ),
    },
    clock: { nowMs: () => 6_000 },
    synchronizationIntervalMs: 60_000,
  });

  await runtime.start();

  assert.deepEqual(projections.at(-1)?.activity, {
    cycleId: "activity_cycle_boundary",
    revision: 3,
    updatedAtMs: 6_000,
    phase: "working",
    completedWorkOrders: 0,
    totalWorkOrders: 1,
    milestones: [
      {
        key: "work-order:windows",
        status: "active",
        summary: "Windows is checking its deterministic context.",
        deviceId: "device_windows",
      },
    ],
  });
  assert.equal("taskId" in executorSnapshot, true);
  assert.equal("taskId" in projections.at(-1)!.activity!, false);

  await runtime.close();
});
