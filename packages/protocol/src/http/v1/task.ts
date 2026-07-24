import Type from "typebox";

import { OpaqueIdSchema, Rfc3339InstantSchema } from "./common.ts";

const BoundedTextSchema = Type.String({
  minLength: 1,
  maxLength: 8_192,
});

const BoundedTextListSchema = Type.Array(BoundedTextSchema, {
  maxItems: 128,
  uniqueItems: true,
});

export const CreateTaskRequestSchema = Type.Object(
  {
    objective: BoundedTextSchema,
    completionCriteria: Type.Array(BoundedTextSchema, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
    constraints: BoundedTextListSchema,
    selectedInputRefs: Type.Array(OpaqueIdSchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
    mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("manual")])),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateCreateTaskRequestV1",
  },
);

export type CreateTaskRequestV1 = Type.Static<typeof CreateTaskRequestSchema>;

export const TaskStateSchema = Type.Union([
  Type.Literal("intake"),
  Type.Literal("queued"),
  Type.Literal("waiting_user"),
  Type.Literal("waiting_resource"),
  Type.Literal("running"),
  Type.Literal("review"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("paused"),
  Type.Literal("cancelled"),
]);

const TaskSummaryProperties = {
  taskId: OpaqueIdSchema,
  state: TaskStateSchema,
  mode: Type.Union([Type.Literal("auto"), Type.Literal("manual")]),
  objective: BoundedTextSchema,
  createdAt: Rfc3339InstantSchema,
  updatedAt: Rfc3339InstantSchema,
  version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
} as const;

export const TaskSummarySchema = Type.Object(TaskSummaryProperties, {
  additionalProperties: false,
  $id: "OpenDelegateTaskSummaryV1",
});

export type TaskSummaryV1 = Type.Static<typeof TaskSummarySchema>;

export const TaskListResponseSchema = Type.Object(
  {
    tasks: Type.Array(TaskSummarySchema, { maxItems: 10_000 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateTaskListResponseV1",
  },
);

export type TaskListResponseV1 = Type.Static<typeof TaskListResponseSchema>;

export const TaskParamsSchema = Type.Object(
  {
    taskId: OpaqueIdSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateTaskParamsV1",
  },
);

export type TaskParamsV1 = Type.Static<typeof TaskParamsSchema>;

export const TaskEventSummarySchema = Type.Object(
  {
    eventId: OpaqueIdSchema,
    type: Type.String({
      minLength: 1,
      maxLength: 160,
      pattern: "^[a-z][a-z0-9.-]*$",
    }),
    occurredAt: Rfc3339InstantSchema,
    streamVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

export const TaskDetailSchema = Type.Object(
  {
    ...TaskSummaryProperties,
    completionCriteria: BoundedTextListSchema,
    constraints: BoundedTextListSchema,
    selectedInputRefs: Type.Array(OpaqueIdSchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
    events: Type.Array(TaskEventSummarySchema, { maxItems: 10_000 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateTaskDetailV1",
  },
);

export type TaskDetailV1 = Type.Static<typeof TaskDetailSchema>;

export const TaskCommandRequestSchema = Type.Object(
  {
    command: Type.Union([
      Type.Literal("pause"),
      Type.Literal("resume"),
      Type.Literal("cancel"),
      Type.Literal("retry"),
    ]),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateTaskCommandRequestV1",
  },
);

export type TaskCommandRequestV1 = Type.Static<typeof TaskCommandRequestSchema>;
