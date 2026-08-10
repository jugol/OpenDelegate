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
  state = "running";
  await runtime.synchronizeNow();
  assert.equal(projections.at(-1)?.activity, undefined);

  await runtime.close();
});
