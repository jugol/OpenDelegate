import type { EventClock, EventDraft } from "@opendelegate/event-store";

export type CanonicalJourneyStep =
  | "task-intake"
  | "clarification-requested"
  | "clarification-resolved"
  | "research-queued"
  | "report-queued"
  | "research-dispatched"
  | "report-dispatched"
  | "research-reported"
  | "report-reported"
  | "synthesis-recorded"
  | "review-requested"
  | "review-approved"
  | "artifact-presented"
  | "task-completed";

export type CanonicalWorkstream = "research" | "report";

export interface SimulatorIdSource {
  taskId(): string;
  clarificationId(): string;
  workOrderId(workstream: CanonicalWorkstream): string;
  runId(workstream: CanonicalWorkstream): string;
  deviceId(workstream: CanonicalWorkstream): string;
  reviewDecisionId(): string;
  artifactId(): string;
  eventId(step: CanonicalJourneyStep): string;
}

export interface CanonicalTaskJourneySimulatorOptions {
  readonly clock: EventClock;
  readonly ids: SimulatorIdSource;
  readonly recordedEvents?: readonly EventDraft[];
}

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

export interface ClarificationProjection {
  readonly clarificationId: string;
  readonly prompt: string;
  readonly answer: string | null;
}

export type SimulatedWorkOrderState = "queued" | "running" | "succeeded";

export interface SimulatedWorkOrderProjection {
  readonly workOrderId: string;
  readonly title: string;
  readonly state: SimulatedWorkOrderState;
  readonly runId: string | null;
  readonly deviceId: string | null;
  readonly report: string | null;
}

export type ReviewProjection =
  | {
      readonly status: "not-requested";
    }
  | {
      readonly status: "pending";
    }
  | {
      readonly status: "approved";
      readonly decisionId: string;
    };

export interface SimulatedArtifactProjection {
  readonly artifactId: string;
  readonly kind: "static-html";
  readonly title: string;
  readonly presented: true;
}

export interface TaskJourneyProjection {
  readonly taskId: string | null;
  readonly state: TaskState | null;
  readonly objective: string | null;
  readonly stateHistory: readonly TaskState[];
  readonly clarification: ClarificationProjection | null;
  readonly workOrders: readonly SimulatedWorkOrderProjection[];
  readonly activeWorkOrderCount: number;
  readonly peakParallelWorkOrders: number;
  readonly synthesis: string | null;
  readonly review: ReviewProjection;
  readonly artifacts: readonly SimulatedArtifactProjection[];
  readonly completionCriteriaVerified: boolean;
  readonly appliedEventIds: readonly string[];
}

export type SimulatorErrorCode =
  | "SIMULATOR_EVENT_ID_CONFLICT"
  | "SIMULATOR_INVALID_EVENT_ORDER"
  | "SIMULATOR_INVALID_EVENT_PAYLOAD"
  | "SIMULATOR_JOURNAL_DIVERGED"
  | "SIMULATOR_UNKNOWN_EVENT_TYPE";

export class SimulatorError extends Error {
  public readonly code: SimulatorErrorCode;

  public constructor(code: SimulatorErrorCode, message: string) {
    super(message);
    this.name = "SimulatorError";
    this.code = code;
  }
}
