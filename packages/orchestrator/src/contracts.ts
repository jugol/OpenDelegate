import type { OsFamily, TaskBrief, TaskState } from "@opendelegate/domain";
import type {
  ArtifactReferenceV1,
  SemanticDeviceSelectionResponseV1,
  SemanticPlanningCandidateV1,
  WorkerReportV1,
  WorkOrderV1,
} from "@opendelegate/protocol";
import type { DeviceCandidate, DeviceCapability, TransportRoute } from "@opendelegate/scheduler";

import type { OrchestrationJournal } from "./orchestration-journal.ts";

export interface ForumPostInput {
  readonly forumId: string;
  readonly postId: string;
  readonly authorId: string;
  readonly title: string;
  readonly body: string;
}

export interface ForumPostAuthorizationInput {
  readonly forumId: string;
  readonly postId: string;
  readonly authorId: string;
}

export type ForumPostAuthorization =
  | {
      readonly decision: "allow";
      readonly principalId: string;
    }
  | {
      readonly decision: "deny";
      readonly reason: string;
    };

export interface ChannelAuthorizer {
  authorizeForumPost(input: ForumPostAuthorizationInput): Promise<ForumPostAuthorization>;
}

export interface AuthorizedForumPost extends ForumPostInput {
  readonly authorizedPrincipalId: string;
}

export interface ClarificationRequest {
  readonly clarificationId: string;
  readonly question: string;
}

export interface ClarificationExchange extends ClarificationRequest {
  readonly answer: string;
}

export interface ClarificationAnswerInput {
  readonly postId: string;
  readonly clarificationId: string;
  readonly authorId: string;
  readonly answer: string;
}

export interface CoordinatorIntakeInput {
  readonly taskId: string;
  readonly forumPost: AuthorizedForumPost;
}

export type CoordinatorIntakeDecision =
  | {
      readonly decision: "ready";
    }
  | {
      readonly decision: "clarification";
      readonly clarification: ClarificationRequest;
    };

export type PlannedWorkOrderSchedulingHints = WorkOrderV1["schedulingHints"];
export type PlannedWorkOrder = Omit<WorkOrderV1, "protocolVersion">;

export interface CoordinatorPlanInput {
  readonly taskId: string;
  readonly forumPost: AuthorizedForumPost;
  readonly clarification?: ClarificationExchange;
}

export interface CoordinatorPlan {
  readonly taskBrief: TaskBrief;
  readonly workOrders: readonly PlannedWorkOrder[];
}

export type CoordinatorDeviceSelectionCandidate = Omit<
  SemanticPlanningCandidateV1,
  "protocolVersion"
>;

export interface CoordinatorDeviceSelectionInput {
  readonly taskId: string;
  readonly workOrder: PlannedWorkOrder;
  readonly eligibleDevices: readonly CoordinatorDeviceSelectionCandidate[];
}

export type CoordinatorDeviceSelection = SemanticDeviceSelectionResponseV1;

export type WorkerReport = Pick<WorkerReportV1, "workOrderId" | "workerId" | "report">;

export interface CoordinatorSynthesisInput {
  readonly taskId: string;
  readonly reports: readonly WorkerReport[];
}

export interface ArtifactContent {
  readonly filename: string;
  readonly mediaType: string;
  readonly content: string;
}

export interface CoordinatorSynthesis {
  readonly summary: string;
  readonly artifact: ArtifactContent;
}

export interface CoordinatorReviewInput {
  readonly taskId: string;
  readonly taskBrief: TaskBrief;
  readonly workOrders: readonly PlannedWorkOrder[];
  readonly reports: readonly WorkerReport[];
  readonly synthesis: CoordinatorSynthesis;
  readonly artifactReference: ArtifactReference;
}

export interface CoordinatorReview {
  readonly decision: "complete";
  readonly verifiedCompletionCriteria: readonly string[];
}

export interface Coordinator {
  assessIntake(input: CoordinatorIntakeInput): Promise<CoordinatorIntakeDecision>;
  plan(input: CoordinatorPlanInput): Promise<CoordinatorPlan>;
  selectDevice(input: CoordinatorDeviceSelectionInput): Promise<CoordinatorDeviceSelection>;
  synthesize(input: CoordinatorSynthesisInput): Promise<CoordinatorSynthesis>;
  review(input: CoordinatorReviewInput): Promise<CoordinatorReview>;
}

export interface WorkerExecutionInput {
  readonly taskId: string;
  readonly workOrder: PlannedWorkOrder;
  readonly run: RunAssignment;
}

export type WorkerRunCompletion = Pick<
  WorkerReportV1,
  | "taskId"
  | "workOrderId"
  | "deviceId"
  | "workerId"
  | "routeId"
  | "runId"
  | "leaseId"
  | "fencingToken"
>;

export type WorkerExecutionResult = WorkerRunCompletion & Pick<WorkerReportV1, "report">;

export type WorkerOsFamily = OsFamily;

export type WorkerCapabilitySnapshot = DeviceCapability;

export type WorkerRouteSnapshot = TransportRoute;

export interface WorkerDeviceSnapshot {
  readonly enabled: boolean;
  readonly status: "online" | "offline";
  readonly draining: boolean;
  readonly osFamily: WorkerOsFamily;
  readonly capabilities: readonly WorkerCapabilitySnapshot[];
  readonly roles: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly routes: readonly WorkerRouteSnapshot[];
  readonly availableRunSlots: number;
  readonly loadRatio: number;
  readonly desktopSessionAvailable: boolean;
  readonly availableSecretRefs: readonly string[];
}

export interface Worker {
  readonly workerId: string;
  readonly deviceId: string;
  readonly scheduling: WorkerDeviceSnapshot;
  execute(input: WorkerExecutionInput): Promise<WorkerExecutionResult>;
}

export interface DispatchPolicyDecision {
  readonly outcome: "allow" | "require-approval" | "deny";
  readonly code: string;
}

export interface DispatchPolicyEvaluationInput {
  readonly taskId: string;
  readonly workOrder: PlannedWorkOrder;
  readonly device: WorkerDeviceSnapshot & {
    readonly deviceId: string;
    readonly workerId: string;
  };
}

export interface DispatchPolicyEvaluator {
  evaluate(input: DispatchPolicyEvaluationInput): DispatchPolicyDecision;
}

export type WorkOrderSchedulingCandidate = DeviceCandidate;

export interface ArtifactPublishInput extends ArtifactContent {
  readonly taskId: string;
  readonly idempotencyKey: string;
}

export type ArtifactReference = Omit<ArtifactReferenceV1, "protocolVersion">;

export interface ArtifactGateway {
  publish(input: ArtifactPublishInput): Promise<ArtifactReference>;
}

export interface OrchestrationIdSource {
  nextTaskId(): string | undefined;
}

export type TaskIdSource = OrchestrationIdSource;

export interface RunAssignmentTarget {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
}

export interface RunAssignment extends RunAssignmentTarget {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
}

export interface RunAssignmentSource {
  nextRun(input: RunAssignmentTarget): RunAssignment;
}

export interface OrchestrationClock {
  now(): string;
}

export interface WorkOrderView extends WorkerReport {
  readonly state: "succeeded";
}

export interface DiscordResultProjection {
  readonly kind: "discord-result";
  readonly statusTag: "Done";
  readonly content: string;
  readonly actions: readonly [
    {
      readonly type: "link";
      readonly label: "Open report";
      readonly href: string;
    },
  ];
}

export interface DiscordClarificationProjection {
  readonly kind: "discord-question";
  readonly statusTag: "Waiting";
  readonly content: string;
  readonly actions: readonly [];
}

interface BaseTaskView {
  readonly taskId: string;
  readonly stateHistory: readonly TaskState[];
}

export interface WaitingUserTaskView extends BaseTaskView {
  readonly state: "waiting_user";
  readonly clarification: ClarificationRequest;
  readonly workOrders: readonly [];
  readonly resultProjection: DiscordClarificationProjection;
  readonly artifactRefs: readonly [];
}

export interface CompletedTaskView extends BaseTaskView {
  readonly state: "completed";
  readonly taskBrief: TaskBrief;
  readonly verifiedCompletionCriteria: readonly string[];
  readonly workOrders: readonly WorkOrderView[];
  readonly resultProjection: DiscordResultProjection;
  readonly artifactRefs: readonly ArtifactReference[];
}

export type TaskView = WaitingUserTaskView | CompletedTaskView;

export interface OpenDelegateDependencies {
  readonly authorizer: ChannelAuthorizer;
  readonly coordinator: Coordinator;
  readonly workers: readonly Worker[];
  readonly artifacts: ArtifactGateway;
  readonly ids: OrchestrationIdSource;
  readonly runAssignments: RunAssignmentSource;
  readonly dispatchPolicy: DispatchPolicyEvaluator;
  readonly clock: OrchestrationClock;
  readonly journal?: OrchestrationJournal;
}

export interface OpenDelegate {
  acceptForumPost(input: ForumPostInput): Promise<TaskView>;
  answerClarification(input: ClarificationAnswerInput): Promise<CompletedTaskView>;
  getTaskByForumPost(postId: string): TaskView;
}
