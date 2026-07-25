import assert from "node:assert/strict";
import test from "node:test";

import Value from "typebox/value";

import { ExtendTaskBudgetRequestSchema, TaskBudgetSnapshotSchema } from "../src/index.ts";

const completeLimits = {
  wallTimeMs: { soft: 50_000, hard: 60_000 },
  idleTimeMs: { soft: 5_000, hard: 10_000 },
  retries: { soft: 1, hard: 2 },
  childWorkOrders: { soft: 1, hard: 2 },
  concurrentRuns: { soft: 1, hard: 2 },
  nativeTurns: { soft: 3, hard: 4 },
  tokens: { soft: 800, hard: 1_000 },
  costUsdMicros: { soft: 8_000, hard: 10_000 },
} as const;

test("Task Budget HTTP contracts expose only bounded owner-visible projections", () => {
  const snapshot = {
    schemaVersion: 1,
    taskId: "task_release",
    kind: "requested",
    revision: 2,
    createdAt: "2026-07-25T00:00:00.000Z",
    lastActivityAt: "2026-07-25T00:00:01.000Z",
    limits: completeLimits,
    usage: {
      wallTimeMs: 1_000,
      childWorkOrders: 2,
      tokens: 850,
    },
    workOrders: [
      {
        workOrderId: "work_order_report",
        limits: completeLimits,
        usage: { tokens: 850 },
      },
    ],
    activeRunIds: ["run_report"],
    limitEvents: [
      {
        eventId: "event_budget_soft_tokens",
        metric: "tokens",
        state: "soft-limit",
        current: 850,
        hard: 1_000,
        attempted: 850,
        occurredAt: "2026-07-25T00:00:01.000Z",
        workOrderId: "work_order_report",
      },
    ],
    extensions: [
      {
        eventId: "event_budget_extension",
        baseRevision: 1,
        revision: 2,
        occurredAt: "2026-07-25T00:00:02.000Z",
        actorId: "owner_personal",
        limits: completeLimits,
      },
    ],
    omitted: { workOrders: 0, activeRunIds: 0, limitEvents: 0, extensions: 0 },
  };

  assert.equal(Value.Check(TaskBudgetSnapshotSchema, snapshot), true);
  assert.equal(
    Value.Check(TaskBudgetSnapshotSchema, {
      ...snapshot,
      limitEvents: [
        {
          ...snapshot.limitEvents[0],
          payload: {
            operationFingerprint: "must-not-cross-admin",
            ownerCredential: "must-not-cross-admin",
          },
        },
      ],
    }),
    false,
  );
});

test("Task Budget extension requires the current revision and one exact complete limits set", () => {
  assert.equal(
    Value.Check(ExtendTaskBudgetRequestSchema, {
      baseRevision: 2,
      limits: completeLimits,
    }),
    true,
  );
  assert.equal(
    Value.Check(ExtendTaskBudgetRequestSchema, {
      baseRevision: 2,
      limits: {
        tokens: { hard: 2_000 },
      },
    }),
    false,
  );
  assert.equal(
    Value.Check(ExtendTaskBudgetRequestSchema, {
      baseRevision: 2,
      limits: {
        ...completeLimits,
        tokens: { soft: 2_001, hard: 2_000 },
      },
    }),
    true,
    "cross-field soft/hard validation remains the deterministic Budget authority's job",
  );
  assert.equal(
    Value.Check(ExtendTaskBudgetRequestSchema, {
      baseRevision: 2,
      limits: completeLimits,
      authority: { kind: "owner", authorityId: "forged-client-authority" },
    }),
    false,
  );
});
