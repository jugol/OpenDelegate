import type { PlanActionExecutionResult, ServicePlanExecutionReport } from "./plan-executor.ts";
import { executeServicePlan } from "./plan-executor.ts";
import { validateSupervisorCommands } from "./command-validation.ts";
import type { PlanAction, ServicePlan, SupervisorOperation } from "./plans.ts";
import {
  ServiceCommandExecutionError,
  fingerprintServiceValue,
  servicePlanFingerprint,
  type ServicePlanRunContext,
  type ServicePlanRunner,
} from "./service-command.ts";

type AccountAction = Extract<PlanAction, { readonly kind: "account.ensure" | "account.remove" }>;
type HealthAction = Extract<PlanAction, { readonly kind: "health.check" }>;
type SupervisorAction = Extract<PlanAction, { readonly kind: "supervisor.invoke" }>;
type FilesystemAction = Exclude<PlanAction, AccountAction | HealthAction | SupervisorAction>;

export interface ServiceActionExecutionContext extends ServicePlanRunContext {
  readonly actionId: string;
  readonly phase: "forward" | "rollback";
}

export interface ServiceFilesystemAdapter {
  /**
   * Performs only the structured directory, file, release, and activation action supplied.
   * Implementations must durably make exact actionId replay idempotent.
   */
  perform(
    action: FilesystemAction,
    context: ServiceActionExecutionContext,
  ): Promise<PlanActionExecutionResult | void>;
}

export interface ServiceAccountAdapter {
  /**
   * Performs only the structured least-privilege account action supplied.
   * Implementations must durably make exact actionId replay idempotent.
   */
  perform(
    action: AccountAction,
    context: ServiceActionExecutionContext,
  ): Promise<PlanActionExecutionResult | void>;
}

export interface ServiceHealthAdapter {
  perform(
    action: HealthAction,
    context: ServiceActionExecutionContext,
  ): Promise<PlanActionExecutionResult | void>;
}

export interface ServiceSupervisorAdapter {
  /**
   * Invokes a validated native supervisor operation without a shell.
   * Implementations must durably make exact actionId replay idempotent.
   */
  perform(
    operation: SupervisorOperation,
    context: ServiceActionExecutionContext,
  ): Promise<PlanActionExecutionResult | void>;
}

export interface CreateServicePlanRunnerInput {
  readonly filesystem: ServiceFilesystemAdapter;
  readonly accounts: ServiceAccountAdapter;
  readonly supervisor: ServiceSupervisorAdapter;
  readonly health: ServiceHealthAdapter;
}

export function createServicePlanRunner(input: CreateServicePlanRunnerInput): ServicePlanRunner {
  return {
    async execute(
      plan: ServicePlan,
      context: ServicePlanRunContext,
    ): Promise<ServicePlanExecutionReport> {
      if (servicePlanFingerprint(plan) !== context.planFingerprint) {
        throw new ServiceCommandExecutionError(
          "SERVICE_COMMAND_CONFLICT",
          "The service plan runner received a plan that does not match its claimed fingerprint.",
          false,
        );
      }
      const occurrences = new Map<string, number>();
      return executeServicePlan(plan, {
        async perform(action, phase) {
          const actionFingerprint = fingerprintServiceValue(action);
          const occurrenceKey = `${phase}:${actionFingerprint}`;
          const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
          occurrences.set(occurrenceKey, occurrence);
          const actionContext: ServiceActionExecutionContext = {
            ...context,
            phase,
            actionId: fingerprintServiceValue({
              commandId: context.commandId,
              planFingerprint: context.planFingerprint,
              phase,
              actionFingerprint,
              occurrence,
            }),
          };
          if (action.kind === "account.ensure" || action.kind === "account.remove") {
            return input.accounts.perform(action, actionContext);
          }
          if (action.kind === "health.check") {
            return input.health.perform(action, actionContext);
          }
          if (action.kind === "supervisor.invoke") {
            if (
              action.command.platform !== plan.platform ||
              action.command.invocations.some(
                (invocation) => invocation.plane !== action.command.plane,
              )
            ) {
              throw new ServiceCommandExecutionError(
                "SERVICE_COMMAND_OUTCOME_UNCERTAIN",
                "The service plan contains a mismatched supervisor operation.",
                false,
              );
            }
            validateSupervisorCommands(action.command.invocations);
            return input.supervisor.perform(action.command, actionContext);
          }
          return input.filesystem.perform(action, actionContext);
        },
      });
    },
  };
}
