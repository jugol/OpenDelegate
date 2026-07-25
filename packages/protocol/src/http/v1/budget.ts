import Type from "typebox";

import { OpaqueIdSchema, Rfc3339InstantSchema } from "./common.ts";

export const TaskBudgetMetricSchema = Type.Union([
  Type.Literal("wallTimeMs"),
  Type.Literal("idleTimeMs"),
  Type.Literal("retries"),
  Type.Literal("childWorkOrders"),
  Type.Literal("concurrentRuns"),
  Type.Literal("nativeTurns"),
  Type.Literal("tokens"),
  Type.Literal("costUsdMicros"),
]);

export type TaskBudgetMetricV1 = Type.Static<typeof TaskBudgetMetricSchema>;

const BoundedBudgetValueSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const TaskBudgetLimitSchema = Type.Object(
  {
    soft: Type.Optional(BoundedBudgetValueSchema),
    hard: BoundedBudgetValueSchema,
  },
  { additionalProperties: false },
);

export type TaskBudgetLimitV1 = Type.Static<typeof TaskBudgetLimitSchema>;

const CompleteBudgetLimitProperties = {
  wallTimeMs: TaskBudgetLimitSchema,
  idleTimeMs: TaskBudgetLimitSchema,
  retries: TaskBudgetLimitSchema,
  childWorkOrders: TaskBudgetLimitSchema,
  concurrentRuns: TaskBudgetLimitSchema,
  nativeTurns: TaskBudgetLimitSchema,
  tokens: TaskBudgetLimitSchema,
  costUsdMicros: TaskBudgetLimitSchema,
} as const;

export const TaskBudgetLimitsSchema = Type.Object(CompleteBudgetLimitProperties, {
  additionalProperties: false,
});

export type TaskBudgetLimitsV1 = Type.Static<typeof TaskBudgetLimitsSchema>;

export const TaskBudgetUsageSchema = Type.Object(
  {
    wallTimeMs: Type.Optional(BoundedBudgetValueSchema),
    idleTimeMs: Type.Optional(BoundedBudgetValueSchema),
    retries: Type.Optional(BoundedBudgetValueSchema),
    childWorkOrders: Type.Optional(BoundedBudgetValueSchema),
    concurrentRuns: Type.Optional(BoundedBudgetValueSchema),
    nativeTurns: Type.Optional(BoundedBudgetValueSchema),
    tokens: Type.Optional(BoundedBudgetValueSchema),
    costUsdMicros: Type.Optional(BoundedBudgetValueSchema),
  },
  { additionalProperties: false },
);

export type TaskBudgetUsageV1 = Type.Static<typeof TaskBudgetUsageSchema>;

export const TaskBudgetLimitEventSchema = Type.Object(
  {
    eventId: OpaqueIdSchema,
    metric: TaskBudgetMetricSchema,
    state: Type.Union([Type.Literal("soft-limit"), Type.Literal("hard-limit")]),
    current: BoundedBudgetValueSchema,
    hard: BoundedBudgetValueSchema,
    attempted: BoundedBudgetValueSchema,
    occurredAt: Rfc3339InstantSchema,
    workOrderId: Type.Optional(OpaqueIdSchema),
  },
  { additionalProperties: false },
);

export type TaskBudgetLimitEventV1 = Type.Static<typeof TaskBudgetLimitEventSchema>;

export const TaskBudgetExtensionEventSchema = Type.Object(
  {
    eventId: OpaqueIdSchema,
    baseRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    revision: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
    occurredAt: Rfc3339InstantSchema,
    actorId: OpaqueIdSchema,
    limits: TaskBudgetLimitsSchema,
  },
  { additionalProperties: false },
);

export type TaskBudgetExtensionEventV1 = Type.Static<typeof TaskBudgetExtensionEventSchema>;

export const WorkOrderBudgetSnapshotSchema = Type.Object(
  {
    workOrderId: OpaqueIdSchema,
    limits: TaskBudgetLimitsSchema,
    usage: TaskBudgetUsageSchema,
  },
  { additionalProperties: false },
);

export type WorkOrderBudgetSnapshotV1 = Type.Static<typeof WorkOrderBudgetSnapshotSchema>;

export const TaskBudgetSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: OpaqueIdSchema,
    kind: Type.Union([Type.Literal("requested"), Type.Literal("autonomous")]),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    createdAt: Rfc3339InstantSchema,
    lastActivityAt: Rfc3339InstantSchema,
    limits: TaskBudgetLimitsSchema,
    usage: TaskBudgetUsageSchema,
    workOrders: Type.Array(WorkOrderBudgetSnapshotSchema, { maxItems: 256 }),
    activeRunIds: Type.Array(OpaqueIdSchema, {
      maxItems: 1_024,
      uniqueItems: true,
    }),
    limitEvents: Type.Array(TaskBudgetLimitEventSchema, { maxItems: 512 }),
    extensions: Type.Array(TaskBudgetExtensionEventSchema, { maxItems: 256 }),
    omitted: Type.Object(
      {
        workOrders: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        activeRunIds: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        limitEvents: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        extensions: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateTaskBudgetSnapshotV1",
  },
);

export type TaskBudgetSnapshotV1 = Type.Static<typeof TaskBudgetSnapshotSchema>;

export const ExtendTaskBudgetRequestSchema = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    limits: TaskBudgetLimitsSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateExtendTaskBudgetRequestV1",
  },
);

export type ExtendTaskBudgetRequestV1 = Type.Static<typeof ExtendTaskBudgetRequestSchema>;
