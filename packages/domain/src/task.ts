import { DomainError } from "./domain-error.ts";
import type { ArtifactId, RunId, TaskId, WorkOrderId } from "./identifiers.ts";

export type TaskState =
  | "intake"
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_resource"
  | "review"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export type TaskMode = "auto" | "manual";

export interface TaskBrief {
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly knownInputIds: readonly string[];
  readonly decisions: readonly string[];
  readonly openQuestions: readonly string[];
}

export interface CreateTask {
  readonly id: TaskId;
  readonly mode?: TaskMode;
  readonly brief?: TaskBrief;
  readonly completionRequirements?: TaskCompletionRequirements;
}

export interface TaskCompletionRequirements {
  readonly minimumArtifactResults: number;
}

export interface DispatchWorkOrder {
  readonly id: WorkOrderId;
  readonly required: boolean;
}

export interface TaskWorkOrderSnapshot {
  readonly id: string;
  readonly required: boolean;
  readonly state: "dispatched" | "succeeded" | "failed";
  readonly resultRunId?: string;
  readonly resultFencingToken?: number;
}

export interface RecordWorkOrderResult {
  readonly id: WorkOrderId;
  readonly runId: RunId;
  readonly fencingToken: number;
}

export interface TaskSnapshot {
  readonly id: string;
  readonly state: TaskState;
  readonly mode: TaskMode;
  readonly brief: TaskBrief;
  readonly archived: boolean;
  readonly workOrders: readonly TaskWorkOrderSnapshot[];
  readonly artifactResultIds: readonly string[];
  readonly verifiedCompletionCriteria: readonly string[];
}

interface WorkOrderRecord {
  readonly required: boolean;
  state: "dispatched" | "succeeded" | "failed";
  resultRunId?: string;
  resultFencingToken?: number;
}

const allowedTransitions = {
  intake: [
    "queued",
    "running",
    "waiting_user",
    "waiting_resource",
    "review",
    "completed",
    "failed",
    "paused",
    "cancelled",
  ],
  queued: [
    "running",
    "waiting_user",
    "waiting_resource",
    "review",
    "completed",
    "failed",
    "paused",
    "cancelled",
  ],
  running: [
    "waiting_user",
    "waiting_resource",
    "review",
    "completed",
    "failed",
    "paused",
    "cancelled",
  ],
  waiting_user: ["queued", "running", "waiting_resource", "failed", "paused", "cancelled"],
  waiting_resource: ["queued", "running", "waiting_user", "failed", "paused", "cancelled"],
  review: [
    "running",
    "waiting_user",
    "waiting_resource",
    "completed",
    "failed",
    "paused",
    "cancelled",
  ],
  completed: [],
  failed: [],
  paused: [],
  cancelled: [],
} as const satisfies Readonly<Record<TaskState, readonly TaskState[]>>;

export class Task {
  public readonly id: TaskId;
  private currentState: TaskState = "intake";
  private readonly taskMode: TaskMode;
  private currentBrief: TaskBrief;
  private currentlyArchived = false;
  private resumeState: Exclude<TaskState, "paused"> | undefined;
  private readonly workOrders = new Map<string, WorkOrderRecord>();
  private readonly minimumArtifactResults: number;
  private readonly artifactResults = new Set<string>();
  private readonly verifiedCompletionCriteria = new Set<string>();

  private constructor(input: CreateTask) {
    const minimumArtifactResults = input.completionRequirements?.minimumArtifactResults ?? 0;
    if (!Number.isSafeInteger(minimumArtifactResults) || minimumArtifactResults < 0) {
      throw new DomainError(
        "TASK_COMPLETION_REQUIREMENTS_INVALID",
        "A Task requires a non-negative safe-integer Artifact result minimum.",
      );
    }
    this.id = input.id;
    this.taskMode = input.mode ?? "auto";
    this.currentBrief = freezeBrief(input.brief ?? emptyBrief());
    this.minimumArtifactResults = minimumArtifactResults;
  }

  public static create(input: CreateTask): Task {
    return new Task(input);
  }

  public get state(): TaskState {
    return this.currentState;
  }

  public get mode(): TaskMode {
    return this.taskMode;
  }

  public get snapshot(): TaskSnapshot {
    return Object.freeze({
      id: this.id.value,
      state: this.currentState,
      mode: this.taskMode,
      brief: this.currentBrief,
      archived: this.currentlyArchived,
      workOrders: Object.freeze(
        [...this.workOrders.entries()]
          .map(([id, record]) =>
            Object.freeze({
              id,
              required: record.required,
              state: record.state,
              ...(record.resultRunId === undefined ? {} : { resultRunId: record.resultRunId }),
              ...(record.resultFencingToken === undefined
                ? {}
                : { resultFencingToken: record.resultFencingToken }),
            }),
          )
          .sort((left, right) => left.id.localeCompare(right.id)),
      ),
      artifactResultIds: Object.freeze([...this.artifactResults].sort()),
      verifiedCompletionCriteria: Object.freeze([...this.verifiedCompletionCriteria].sort()),
    });
  }

  public updateBrief(brief: TaskBrief): void {
    this.assertNotTerminal();
    this.currentBrief = freezeBrief(brief);
    this.verifiedCompletionCriteria.clear();
  }

  public verifyCompletionCriterion(criterion: string): void {
    this.assertNotTerminal();
    if (!this.currentBrief.completionCriteria.includes(criterion)) {
      throw new DomainError(
        "TASK_COMPLETION_CRITERION_UNKNOWN",
        `Completion criterion "${criterion}" does not belong to this Task Brief.`,
      );
    }
    this.verifiedCompletionCriteria.add(criterion);
  }

  public transitionTo(nextState: TaskState): void {
    if (nextState === this.currentState) {
      return;
    }
    if (nextState === "completed") {
      this.complete();
      return;
    }
    if (nextState === "paused") {
      this.pause();
      return;
    }

    const nextStates: readonly TaskState[] = allowedTransitions[this.currentState];
    if (!nextStates.includes(nextState)) {
      throw new DomainError(
        "TASK_TRANSITION_INVALID",
        `Task state ${this.currentState} cannot transition to ${nextState}.`,
      );
    }

    this.currentState = nextState;
  }

  public pause(): void {
    if (this.currentState === "paused") {
      return;
    }
    this.assertNotTerminal();
    this.resumeState = this.currentState;
    this.currentState = "paused";
  }

  public resume(): void {
    if (this.currentState !== "paused" || this.resumeState === undefined) {
      throw new DomainError(
        "TASK_TRANSITION_INVALID",
        `Task state ${this.currentState} cannot resume.`,
      );
    }
    this.currentState = this.resumeState;
    this.resumeState = undefined;
  }

  public reopen(): void {
    if (!isTerminal(this.currentState)) {
      throw new DomainError(
        "TASK_TRANSITION_INVALID",
        `Task state ${this.currentState} cannot be reopened.`,
      );
    }
    this.currentState = "queued";
    this.currentlyArchived = false;
    this.resumeState = undefined;
  }

  public archive(): void {
    this.currentlyArchived = true;
  }

  public unarchive(): void {
    this.currentlyArchived = false;
  }

  public dispatchWorkOrder(input: DispatchWorkOrder): void {
    this.assertCanDispatch();

    if (this.workOrders.has(input.id.value)) {
      throw new DomainError(
        "WORK_ORDER_DUPLICATED",
        `Work Order ${input.id.value} already belongs to this Task.`,
      );
    }

    this.workOrders.set(input.id.value, {
      required: input.required,
      state: "dispatched",
    });
    this.currentState = "running";
  }

  public recordWorkOrderSucceeded(input: RecordWorkOrderResult): void {
    this.recordWorkOrderResult(input, "succeeded");
  }

  public recordWorkOrderFailed(input: RecordWorkOrderResult): void {
    this.recordWorkOrderResult(input, "failed");
  }

  private recordWorkOrderResult(
    input: RecordWorkOrderResult,
    outcome: "succeeded" | "failed",
  ): void {
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken <= 0) {
      throw new DomainError(
        "WORK_ORDER_RESULT_INVALID",
        "A Work Order result requires a positive safe-integer fencing token.",
      );
    }

    const workOrder = this.requireWorkOrder(input.id);
    const currentFence = workOrder.resultFencingToken;

    if (currentFence !== undefined) {
      if (input.fencingToken < currentFence) {
        throw new DomainError(
          "WORK_ORDER_RESULT_STALE",
          `Run ${input.runId.value} reported with stale fence ${input.fencingToken}; current fence is ${currentFence}.`,
        );
      }

      if (input.fencingToken === currentFence) {
        if (workOrder.resultRunId === input.runId.value && workOrder.state === outcome) {
          return;
        }

        throw new DomainError(
          "WORK_ORDER_RESULT_CONFLICT",
          `Fence ${input.fencingToken} was reused for a different Work Order result.`,
        );
      }
    }

    this.assertAcceptsResults();
    workOrder.state = outcome;
    workOrder.resultRunId = input.runId.value;
    workOrder.resultFencingToken = input.fencingToken;
  }

  public recordArtifactResult(id: ArtifactId): void {
    this.assertAcceptsResults();
    this.artifactResults.add(id.value);
  }

  public complete(): void {
    if (this.currentState === "completed") {
      return;
    }

    const completableStates: readonly TaskState[] = ["intake", "queued", "running", "review"];
    if (!completableStates.includes(this.currentState)) {
      throw new DomainError(
        "TASK_TRANSITION_INVALID",
        `Task state ${this.currentState} cannot transition to completed.`,
      );
    }

    const hasUnresolvedRequiredWork = [...this.workOrders.values()].some(
      (workOrder) => workOrder.required && workOrder.state !== "succeeded",
    );

    if (hasUnresolvedRequiredWork) {
      throw new DomainError(
        "TASK_REQUIRED_WORK_UNRESOLVED",
        "A Task cannot complete while required Work Orders remain unresolved.",
      );
    }

    if (this.artifactResults.size < this.minimumArtifactResults) {
      throw new DomainError(
        "TASK_ARTIFACT_RESULTS_MISSING",
        "A Task cannot complete before its required Artifact results are recorded.",
      );
    }

    const unverifiedCriteria = this.currentBrief.completionCriteria.filter(
      (criterion) => !this.verifiedCompletionCriteria.has(criterion),
    );
    if (unverifiedCriteria.length > 0) {
      throw new DomainError(
        "TASK_COMPLETION_CRITERIA_UNVERIFIED",
        `Task completion criteria remain unverified: ${unverifiedCriteria.join(", ")}.`,
      );
    }

    this.currentState = "completed";
  }

  private requireWorkOrder(id: WorkOrderId): WorkOrderRecord {
    const workOrder = this.workOrders.get(id.value);
    if (workOrder === undefined) {
      throw new DomainError(
        "WORK_ORDER_NOT_FOUND",
        `Work Order ${id.value} does not belong to this Task.`,
      );
    }
    return workOrder;
  }

  private assertCanDispatch(): void {
    const dispatchableStates: readonly TaskState[] = [
      "intake",
      "queued",
      "running",
      "waiting_resource",
    ];
    if (!dispatchableStates.includes(this.currentState)) {
      throw new DomainError(
        "TASK_TRANSITION_INVALID",
        `Task state ${this.currentState} cannot dispatch Work Orders.`,
      );
    }
  }

  private assertAcceptsResults(): void {
    if (isTerminal(this.currentState)) {
      throw new DomainError(
        "TASK_TRANSITION_INVALID",
        `A ${this.currentState} Task cannot accept additional results.`,
      );
    }
  }

  private assertNotTerminal(): void {
    if (isTerminal(this.currentState)) {
      throw new DomainError(
        "TASK_TRANSITION_INVALID",
        `A ${this.currentState} Task cannot perform this transition without reopen.`,
      );
    }
  }
}

function isTerminal(state: TaskState): state is "completed" | "failed" | "cancelled" {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function emptyBrief(): TaskBrief {
  return {
    objective: "",
    completionCriteria: [],
    constraints: [],
    knownInputIds: [],
    decisions: [],
    openQuestions: [],
  };
}

function freezeBrief(brief: TaskBrief): TaskBrief {
  return Object.freeze({
    objective: brief.objective,
    completionCriteria: Object.freeze([...brief.completionCriteria]),
    constraints: Object.freeze([...brief.constraints]),
    knownInputIds: Object.freeze([...brief.knownInputIds]),
    decisions: Object.freeze([...brief.decisions]),
    openQuestions: Object.freeze([...brief.openQuestions]),
  });
}
