import { DomainError } from "./domain-error.ts";
import type { RunId, TaskId, WorkOrderId } from "./identifiers.ts";

export type WorkOrderState =
  "planned" | "ready" | "dispatched" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";

export interface WorkOrderBrief {
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly selectedInputIds: readonly string[];
}

export interface WorkOrderSchedulingHints {
  readonly preferredDeviceIds?: readonly string[];
  readonly preferredRoles?: readonly string[];
}

export interface CreateWorkOrder {
  readonly id: WorkOrderId;
  readonly taskId: TaskId;
  readonly required: boolean;
  readonly brief: WorkOrderBrief;
  readonly dependencyIds?: readonly WorkOrderId[];
  readonly requiredCapabilities: readonly string[];
  readonly schedulingHints?: WorkOrderSchedulingHints;
}

export interface WorkOrderSnapshot {
  readonly id: string;
  readonly taskId: string;
  readonly required: boolean;
  readonly state: WorkOrderState;
  readonly brief: WorkOrderBrief;
  readonly dependencyIds: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly schedulingHints: {
    readonly preferredDeviceIds: readonly string[];
    readonly preferredRoles: readonly string[];
  };
  readonly runIds: readonly string[];
  readonly activeRunId?: string;
  readonly blockedReason?: string;
  readonly failureReason?: string;
  readonly cancellationReason?: string;
}

export class WorkOrder {
  public readonly id: WorkOrderId;
  public readonly taskId: TaskId;
  public readonly required: boolean;
  private currentState: WorkOrderState = "planned";
  private readonly workOrderBrief: WorkOrderBrief;
  private readonly dependencies: readonly string[];
  private readonly capabilities: readonly string[];
  private readonly hints: WorkOrderSnapshot["schedulingHints"];
  private readonly attempts: string[] = [];
  private currentRunId: string | undefined;
  private currentBlockedReason: string | undefined;
  private currentFailureReason: string | undefined;
  private currentCancellationReason: string | undefined;

  private constructor(input: CreateWorkOrder) {
    this.id = input.id;
    this.taskId = input.taskId;
    this.required = input.required;
    this.workOrderBrief = freezeBrief(input.brief);
    this.dependencies = freezeDependencies(input.id, input.dependencyIds ?? []);
    this.capabilities = freezeStrings(input.requiredCapabilities);
    this.hints = Object.freeze({
      preferredDeviceIds: freezeStrings(input.schedulingHints?.preferredDeviceIds ?? []),
      preferredRoles: freezeStrings(input.schedulingHints?.preferredRoles ?? []),
    });
  }

  public static create(input: CreateWorkOrder): WorkOrder {
    return new WorkOrder(input);
  }

  public get state(): WorkOrderState {
    return this.currentState;
  }

  public get snapshot(): WorkOrderSnapshot {
    const optionalState = {
      ...(this.currentRunId === undefined ? {} : { activeRunId: this.currentRunId }),
      ...(this.currentBlockedReason === undefined
        ? {}
        : { blockedReason: this.currentBlockedReason }),
      ...(this.currentFailureReason === undefined
        ? {}
        : { failureReason: this.currentFailureReason }),
      ...(this.currentCancellationReason === undefined
        ? {}
        : { cancellationReason: this.currentCancellationReason }),
    };

    return Object.freeze({
      id: this.id.value,
      taskId: this.taskId.value,
      required: this.required,
      state: this.currentState,
      brief: this.workOrderBrief,
      dependencyIds: this.dependencies,
      requiredCapabilities: this.capabilities,
      schedulingHints: this.hints,
      runIds: Object.freeze([...this.attempts]),
      ...optionalState,
    });
  }

  public markReady(completedDependencyIds: readonly WorkOrderId[]): void {
    this.requireState("planned");
    const completed = new Set(completedDependencyIds.map((id) => id.value));
    const unresolved = this.dependencies.filter((dependencyId) => !completed.has(dependencyId));

    if (unresolved.length > 0) {
      throw new DomainError(
        "WORK_ORDER_DEPENDENCIES_UNRESOLVED",
        `Work Order ${this.id.value} has unresolved dependencies: ${unresolved.join(", ")}.`,
      );
    }

    this.currentState = "ready";
  }

  public dispatch(runId: RunId): void {
    this.requireState("ready");
    this.registerRun(runId);
    this.currentState = "dispatched";
  }

  public start(runId: RunId): void {
    this.requireState("dispatched");
    this.assertActiveRun(runId);
    this.currentState = "running";
  }

  public block(runId: RunId, reason: string): void {
    this.requireOneOfStates(["dispatched", "running"]);
    this.assertActiveRun(runId);
    this.currentBlockedReason = reason;
    this.currentState = "blocked";
  }

  public resume(runId: RunId): void {
    this.requireState("blocked");
    this.assertActiveRun(runId);
    this.currentBlockedReason = undefined;
    this.currentState = "running";
  }

  public succeed(runId: RunId): void {
    this.requireState("running");
    this.assertActiveRun(runId);
    this.currentFailureReason = undefined;
    this.currentBlockedReason = undefined;
    this.currentState = "succeeded";
  }

  public fail(runId: RunId, reason: string): void {
    this.requireOneOfStates(["dispatched", "running", "blocked"]);
    this.assertActiveRun(runId);
    this.currentBlockedReason = undefined;
    this.currentFailureReason = reason;
    this.currentState = "failed";
  }

  public retry(runId: RunId): void {
    this.requireState("failed");
    this.registerRun(runId);
    this.currentFailureReason = undefined;
    this.currentState = "dispatched";
  }

  public cancel(reason: string): void {
    if (this.currentState === "cancelled") {
      return;
    }

    if (this.currentState === "succeeded") {
      throw new DomainError(
        "WORK_ORDER_TRANSITION_INVALID",
        "A succeeded Work Order cannot be cancelled.",
      );
    }

    this.currentBlockedReason = undefined;
    this.currentCancellationReason = reason;
    this.currentState = "cancelled";
  }

  private registerRun(runId: RunId): void {
    if (this.attempts.includes(runId.value)) {
      throw new DomainError(
        "WORK_ORDER_RUN_DUPLICATED",
        `Run ${runId.value} is already an attempt for Work Order ${this.id.value}.`,
      );
    }

    this.attempts.push(runId.value);
    this.currentRunId = runId.value;
  }

  private assertActiveRun(runId: RunId): void {
    if (this.currentRunId !== runId.value) {
      throw new DomainError(
        "WORK_ORDER_RUN_MISMATCH",
        `Run ${runId.value} is not the active attempt for Work Order ${this.id.value}.`,
      );
    }
  }

  private requireState(expected: WorkOrderState): void {
    if (this.currentState !== expected) {
      throw new DomainError(
        "WORK_ORDER_TRANSITION_INVALID",
        `Work Order state ${this.currentState} cannot perform an operation requiring ${expected}.`,
      );
    }
  }

  private requireOneOfStates(expected: readonly WorkOrderState[]): void {
    if (!expected.includes(this.currentState)) {
      throw new DomainError(
        "WORK_ORDER_TRANSITION_INVALID",
        `Work Order state ${this.currentState} cannot perform an operation requiring ${expected.join(" or ")}.`,
      );
    }
  }
}

function freezeBrief(brief: WorkOrderBrief): WorkOrderBrief {
  return Object.freeze({
    objective: brief.objective,
    completionCriteria: freezeStrings(brief.completionCriteria),
    constraints: freezeStrings(brief.constraints),
    selectedInputIds: freezeStrings(brief.selectedInputIds),
  });
}

function freezeDependencies(
  id: WorkOrderId,
  dependencies: readonly WorkOrderId[],
): readonly string[] {
  const values = dependencies.map((dependency) => dependency.value);
  if (values.includes(id.value) || new Set(values).size !== values.length) {
    throw new DomainError(
      "WORK_ORDER_DEPENDENCY_INVALID",
      `Work Order ${id.value} has a self-reference or duplicate dependency.`,
    );
  }
  return freezeStrings(values);
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}
