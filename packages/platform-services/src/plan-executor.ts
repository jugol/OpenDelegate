import type { PlanAction, ServicePlan } from "./plans.ts";

export interface PlanExecutionAdapter {
  perform(action: PlanAction, phase: "forward" | "rollback"): Promise<void>;
}

export interface RollbackFailure {
  readonly stepId: string;
  readonly actionKind: PlanAction["kind"];
  readonly errorType: string;
}

export interface ServicePlanExecutionReport {
  readonly outcome: "failed" | "rolled-back" | "succeeded";
  readonly operation: ServicePlan["operation"];
  readonly platform: ServicePlan["platform"];
  readonly instanceId: string;
  readonly completedStepIds: readonly string[];
  readonly failedStepId?: string;
  readonly rollback: {
    readonly attempted: boolean;
    readonly completedStepIds: readonly string[];
    readonly failures: readonly RollbackFailure[];
  };
  readonly diagnostic: {
    readonly eventName:
      | "platform.service.operation.failed"
      | "platform.service.operation.rolled_back"
      | "platform.service.operation.succeeded";
    readonly summary: string;
    readonly errorType?: string;
  };
}

export async function executeServicePlan(
  plan: ServicePlan,
  adapter: PlanExecutionAdapter,
): Promise<ServicePlanExecutionReport> {
  const completedStepIds: string[] = [];
  const rollbackStack: Array<{
    readonly stepId: string;
    readonly action: PlanAction;
  }> = [];
  for (const step of plan.steps) {
    try {
      await adapter.perform(step.action, "forward");
      completedStepIds.push(step.id);
      if (step.rollback !== undefined) {
        rollbackStack.push({ stepId: step.id, action: step.rollback });
      }
    } catch (error) {
      const completedRollback: string[] = [];
      const failures: RollbackFailure[] = [];
      for (const entry of rollbackStack.reverse()) {
        try {
          await adapter.perform(entry.action, "rollback");
          completedRollback.push(entry.stepId);
        } catch (rollbackError) {
          failures.push({
            stepId: entry.stepId,
            actionKind: entry.action.kind,
            errorType: safeErrorType(rollbackError),
          });
        }
      }
      const attempted = rollbackStack.length > 0;
      const rolledBack = attempted && failures.length === 0;
      return {
        outcome: rolledBack ? "rolled-back" : "failed",
        operation: plan.operation,
        platform: plan.platform,
        instanceId: plan.instanceId,
        completedStepIds,
        failedStepId: step.id,
        rollback: {
          attempted,
          completedStepIds: completedRollback,
          failures,
        },
        diagnostic: {
          eventName: rolledBack
            ? "platform.service.operation.rolled_back"
            : "platform.service.operation.failed",
          summary: rolledBack
            ? `${plan.operation} failed at ${step.id} and was rolled back to the prior service state.`
            : `${plan.operation} failed at ${step.id}; rollback incomplete or unavailable.`,
          errorType: safeErrorType(error),
        },
      };
    }
  }
  return {
    outcome: "succeeded",
    operation: plan.operation,
    platform: plan.platform,
    instanceId: plan.instanceId,
    completedStepIds,
    rollback: {
      attempted: false,
      completedStepIds: [],
      failures: [],
    },
    diagnostic: {
      eventName: "platform.service.operation.succeeded",
      summary: `${plan.operation} completed and all required health checks passed.`,
    },
  };
}

function safeErrorType(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)) {
    return error.name;
  }
  return "UnknownError";
}
