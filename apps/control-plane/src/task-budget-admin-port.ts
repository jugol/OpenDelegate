import type { ExtendTaskBudgetRequestV1, TaskBudgetSnapshotV1 } from "@opendelegate/protocol";

export interface ExtendTaskBudgetInput extends ExtendTaskBudgetRequestV1 {
  readonly taskId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
}

export interface TaskBudgetAdminPort {
  get(taskId: string): Promise<TaskBudgetSnapshotV1>;
  extend(input: ExtendTaskBudgetInput): Promise<TaskBudgetSnapshotV1>;
}

export type TaskBudgetAdminPortErrorCode =
  | "TASK_BUDGET_IDEMPOTENCY_CONFLICT"
  | "TASK_BUDGET_INVALID"
  | "TASK_BUDGET_LIMIT_INVALID"
  | "TASK_BUDGET_NOT_FOUND"
  | "TASK_BUDGET_PARENT_LIMIT_EXCEEDED"
  | "TASK_BUDGET_REVISION_CONFLICT"
  | "TASK_BUDGET_UNAVAILABLE";

export class TaskBudgetAdminPortError extends Error {
  public readonly code: TaskBudgetAdminPortErrorCode;

  public constructor(code: TaskBudgetAdminPortErrorCode, message: string) {
    super(message);
    this.name = "TaskBudgetAdminPortError";
    this.code = code;
  }
}
