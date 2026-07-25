import { DomainError } from "@opendelegate/domain";
import {
  TaskBudgetAdminPortError,
  type ExtendTaskBudgetInput,
  type TaskBudgetAdminPort,
} from "@opendelegate/control-plane";
import type {
  TaskBudgetLimitsV1,
  TaskBudgetMetricV1,
  TaskBudgetSnapshotV1,
  TaskBudgetUsageV1,
} from "@opendelegate/protocol";
import {
  TaskBudgetServiceError,
  type TaskBudgetAdministrationPort,
  type TaskBudgetSnapshot,
} from "@opendelegate/task-service";

const BUDGET_METRICS = [
  "wallTimeMs",
  "idleTimeMs",
  "retries",
  "childWorkOrders",
  "concurrentRuns",
  "nativeTurns",
  "tokens",
  "costUsdMicros",
] as const satisfies readonly TaskBudgetMetricV1[];
const MAXIMUM_WORK_ORDERS = 256;
const MAXIMUM_ACTIVE_RUNS = 1_024;
const MAXIMUM_LIMIT_EVENTS = 512;
const MAXIMUM_EXTENSIONS = 256;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export function createMainTaskBudgetAdmin(
  authority: TaskBudgetAdministrationPort,
): TaskBudgetAdminPort {
  if (
    authority === null ||
    typeof authority !== "object" ||
    typeof authority.snapshot !== "function" ||
    typeof authority.extendTask !== "function"
  ) {
    throw new TypeError("The Task Budget administration authority is invalid.");
  }
  return new MainTaskBudgetAdminPort(authority);
}

class MainTaskBudgetAdminPort implements TaskBudgetAdminPort {
  readonly #authority: TaskBudgetAdministrationPort;

  public constructor(authority: TaskBudgetAdministrationPort) {
    this.#authority = authority;
  }

  public async get(taskId: string): Promise<TaskBudgetSnapshotV1> {
    requireId(taskId, "Task ID");
    try {
      return budgetSnapshot(await this.#authority.snapshot(taskId));
    } catch (error) {
      throw mapBudgetError(error);
    }
  }

  public async extend(input: ExtendTaskBudgetInput): Promise<TaskBudgetSnapshotV1> {
    requireId(input.taskId, "Task ID");
    requireId(input.principalId, "Owner ID");
    requireIdempotencyKey(input.idempotencyKey);
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1) {
      throw invalidBudget("The Task Budget base revision is invalid.");
    }
    const limits = completeLimits(input.limits);
    try {
      return budgetSnapshot(
        await this.#authority.extendTask({
          taskId: input.taskId,
          operationId: `admin:${input.principalId}:${input.idempotencyKey}`,
          baseRevision: input.baseRevision,
          authority: {
            kind: "owner",
            authorityId: input.principalId,
          },
          limits,
        }),
      );
    } catch (error) {
      throw mapBudgetError(error);
    }
  }
}

function budgetSnapshot(snapshot: TaskBudgetSnapshot): TaskBudgetSnapshotV1 {
  try {
    return projectBudgetSnapshot(snapshot);
  } catch {
    throw unavailableBudget();
  }
}

function projectBudgetSnapshot(snapshot: TaskBudgetSnapshot): TaskBudgetSnapshotV1 {
  requireId(snapshot.taskId, "Task ID");
  if (
    (snapshot.kind !== "requested" && snapshot.kind !== "autonomous") ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1
  ) {
    throw unavailableBudget();
  }
  const workOrders = snapshot.workOrders.slice(0, MAXIMUM_WORK_ORDERS).map((workOrder) => {
    requireId(workOrder.workOrderId, "Work Order ID");
    return {
      workOrderId: workOrder.workOrderId,
      limits: completeLimits(workOrder.limits),
      usage: budgetUsage(workOrder.usage),
    };
  });
  const activeRunIds = snapshot.activeRunIds.slice(0, MAXIMUM_ACTIVE_RUNS).map((runId) => {
    requireId(runId, "Run ID");
    return runId;
  });
  const limitEvents = snapshot.limitEvents.slice(-MAXIMUM_LIMIT_EVENTS).map((event) => {
    requireId(event.eventId, "Budget event ID");
    if (
      !BUDGET_METRICS.includes(event.metric) ||
      (event.state !== "soft-limit" && event.state !== "hard-limit")
    ) {
      throw unavailableBudget();
    }
    if (event.workOrderId !== undefined) {
      requireId(event.workOrderId, "Work Order ID");
    }
    return {
      eventId: event.eventId,
      metric: event.metric,
      state: event.state,
      current: budgetValue(event.current),
      hard: budgetValue(event.hard),
      attempted: budgetValue(event.attempted),
      occurredAt: instant(event.occurredAtMs),
      ...(event.workOrderId === undefined ? {} : { workOrderId: event.workOrderId }),
    };
  });
  const extensions = snapshot.extensions.slice(-MAXIMUM_EXTENSIONS).map((extension) => {
    requireId(extension.eventId, "Budget event ID");
    requireId(extension.ownerId, "Owner ID");
    if (
      !Number.isSafeInteger(extension.baseRevision) ||
      extension.baseRevision < 1 ||
      !Number.isSafeInteger(extension.revision) ||
      extension.revision !== extension.baseRevision + 1
    ) {
      throw unavailableBudget();
    }
    return {
      eventId: extension.eventId,
      baseRevision: extension.baseRevision,
      revision: extension.revision,
      occurredAt: instant(extension.occurredAtMs),
      actorId: extension.ownerId,
      limits: completeLimits(extension.limits),
    };
  });
  return deepFreeze({
    schemaVersion: 1,
    taskId: snapshot.taskId,
    kind: snapshot.kind,
    revision: snapshot.revision,
    createdAt: instant(snapshot.createdAtMs),
    lastActivityAt: instant(snapshot.lastActivityAtMs),
    limits: completeLimits(snapshot.limits),
    usage: budgetUsage(snapshot.usage),
    workOrders,
    activeRunIds,
    limitEvents,
    extensions,
    omitted: {
      workOrders: Math.max(0, snapshot.workOrders.length - workOrders.length),
      activeRunIds: Math.max(0, snapshot.activeRunIds.length - activeRunIds.length),
      limitEvents: Math.max(0, snapshot.limitEvents.length - limitEvents.length),
      extensions: Math.max(0, snapshot.extensions.length - extensions.length),
    },
  });
}

function completeLimits(input: unknown): TaskBudgetLimitsV1 {
  if (!isRecord(input) || !hasExactKeys(input, BUDGET_METRICS)) {
    throw invalidBudget("Every Task Budget metric requires one exact limit.");
  }
  const output: Record<string, { soft?: number; hard: number }> = {};
  for (const metric of BUDGET_METRICS) {
    const value = input[metric];
    if (!isRecord(value) || !hasAllowedAndRequiredKeys(value, ["soft", "hard"], ["hard"])) {
      throw invalidBudget(`The ${metric} Task Budget limit is invalid.`);
    }
    const hard = budgetValue(value["hard"]);
    const soft = value["soft"] === undefined ? undefined : budgetValue(value["soft"]);
    if (soft !== undefined && soft > hard) {
      throw invalidBudget(`The ${metric} soft limit cannot exceed its hard limit.`);
    }
    output[metric] = soft === undefined ? { hard } : { soft, hard };
  }
  return deepFreeze(output as unknown as TaskBudgetLimitsV1);
}

function budgetUsage(input: unknown): TaskBudgetUsageV1 {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !BUDGET_METRICS.includes(key as never))
  ) {
    throw unavailableBudget();
  }
  const usage: Partial<Record<TaskBudgetMetricV1, number>> = {};
  for (const metric of BUDGET_METRICS) {
    if (input[metric] !== undefined) {
      usage[metric] = budgetValue(input[metric]);
    }
  }
  return deepFreeze(usage);
}

function budgetValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidBudget("Task Budget values must be non-negative safe integers.");
  }
  return Number(value);
}

function instant(value: unknown): string {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 8_640_000_000_000_000) {
    throw unavailableBudget();
  }
  return new Date(Number(value)).toISOString();
}

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw invalidBudget(`${label} is invalid.`);
  }
}

function requireIdempotencyKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    value.includes("\0")
  ) {
    throw invalidBudget("The Task Budget idempotency key is invalid.");
  }
}

function mapBudgetError(error: unknown): TaskBudgetAdminPortError {
  if (error instanceof TaskBudgetAdminPortError) {
    return error;
  }
  if (error instanceof TaskBudgetServiceError) {
    switch (error.code) {
      case "BUDGET_NOT_FOUND":
        return new TaskBudgetAdminPortError("TASK_BUDGET_NOT_FOUND", error.message);
      case "BUDGET_IDEMPOTENCY_CONFLICT":
        return new TaskBudgetAdminPortError("TASK_BUDGET_IDEMPOTENCY_CONFLICT", error.message);
      case "BUDGET_JOURNAL_CORRUPT":
      case "BUDGET_STORAGE_UNAVAILABLE":
        return unavailableBudget();
    }
  }
  if (error instanceof DomainError) {
    switch (error.code) {
      case "BUDGET_REVISION_CONFLICT":
        return new TaskBudgetAdminPortError("TASK_BUDGET_REVISION_CONFLICT", error.message);
      case "BUDGET_PARENT_LIMIT_EXCEEDED":
        return new TaskBudgetAdminPortError("TASK_BUDGET_PARENT_LIMIT_EXCEEDED", error.message);
      case "BUDGET_LIMIT_INVALID":
      case "BUDGET_EXTENSION_AUTHORITY_REQUIRED":
        return new TaskBudgetAdminPortError("TASK_BUDGET_LIMIT_INVALID", error.message);
      default:
        return unavailableBudget();
    }
  }
  if (error instanceof TypeError) {
    return invalidBudget(error.message);
  }
  return unavailableBudget();
}

function invalidBudget(message = "The Task Budget request is invalid."): TaskBudgetAdminPortError {
  return new TaskBudgetAdminPortError("TASK_BUDGET_INVALID", message);
}

function unavailableBudget(): TaskBudgetAdminPortError {
  return new TaskBudgetAdminPortError(
    "TASK_BUDGET_UNAVAILABLE",
    "The durable Task Budget is unavailable.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasAllowedAndRequiredKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
