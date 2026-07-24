import type { TaskState } from "@opendelegate/domain";
import { InMemoryEventStore, type EventClock, type StoredEvent } from "@opendelegate/event-store";

import {
  cloneTaskView,
  fingerprintArtifactContent,
  fingerprintPlannedWorkOrder,
  parseArtifactReference,
  parseAuthorizedForumPost,
  parseClarificationExchange,
  parseClarificationRequest,
  parseCompletedTaskView,
  parseCoordinatorPlan,
  parseCoordinatorReview,
  parseCoordinatorSynthesis,
  parseRfc3339Instant,
  parseRunAssignment,
  parseWorkerRunCompletion,
  parseWorkerReport,
} from "./contract-validation.ts";
import type {
  ArtifactReference,
  AuthorizedForumPost,
  ClarificationExchange,
  ClarificationRequest,
  CompletedTaskView,
  CoordinatorPlan,
  CoordinatorReview,
  CoordinatorSynthesis,
  RunAssignment,
  WorkerReport,
  WorkerRunCompletion,
} from "./contracts.ts";
import { OrchestratorError, type OrchestratorErrorCode } from "./orchestrator-error.ts";

export interface JournaledTaskIntake {
  readonly taskId: string;
  readonly forumPost: AuthorizedForumPost;
}

export interface JournaledWorkOrderResult extends WorkerRunCompletion {
  readonly planFingerprint: string;
  readonly report: WorkerReport;
}

export interface JournaledRunAssignment {
  readonly workOrderId: string;
  readonly planFingerprint: string;
  readonly assignment: RunAssignment;
}

export interface JournaledArtifactResult {
  readonly contentFingerprint: string;
  readonly reference: ArtifactReference;
}

export interface JournaledClarification {
  readonly request: ClarificationRequest;
  readonly answer?: ClarificationExchange;
}

export interface OrchestrationJournal {
  taskIdFor(forumPostId: string): string | undefined;
  taskIntake(forumPostId: string): JournaledTaskIntake | undefined;
  bindTask(forumPostId: string, intake: JournaledTaskIntake): void;
  intakeReady(forumPostId: string): boolean;
  recordIntakeReady(forumPostId: string): void;
  clarification(forumPostId: string): JournaledClarification | undefined;
  recordClarificationRequest(forumPostId: string, clarification: ClarificationRequest): void;
  recordClarificationAnswer(forumPostId: string, clarification: ClarificationExchange): void;
  plan(forumPostId: string): CoordinatorPlan | undefined;
  recordPlan(forumPostId: string, plan: CoordinatorPlan): void;
  runAssignment(forumPostId: string, workOrderId: string): JournaledRunAssignment | undefined;
  runAssignments(forumPostId: string): readonly JournaledRunAssignment[];
  recordRunAssignment(forumPostId: string, assignment: JournaledRunAssignment): void;
  recordRunFailed(forumPostId: string, workOrderId: string, runId: string): void;
  synthesis(forumPostId: string): CoordinatorSynthesis | undefined;
  recordSynthesis(forumPostId: string, synthesis: CoordinatorSynthesis): void;
  workOrderResults(forumPostId: string): readonly JournaledWorkOrderResult[];
  recordWorkOrderResult(forumPostId: string, result: JournaledWorkOrderResult): void;
  artifactResult(forumPostId: string): JournaledArtifactResult | undefined;
  recordArtifactResult(forumPostId: string, result: JournaledArtifactResult): void;
  reviewStarted(forumPostId: string): boolean;
  recordReviewStarted(forumPostId: string): void;
  review(forumPostId: string): CoordinatorReview | undefined;
  recordReview(forumPostId: string, review: CoordinatorReview): void;
  taskStateHistory(forumPostId: string): readonly TaskState[];
  completedTask(forumPostId: string): CompletedTaskView | undefined;
  recordCompletedTask(forumPostId: string, task: CompletedTaskView): void;
}

export interface InMemoryOrchestrationJournalOptions {
  readonly clock: EventClock;
  readonly recordedEvents?: readonly StoredEvent[];
}

interface JournalProjection {
  intake?: JournaledTaskIntake;
  intakeReady: boolean;
  clarification?: JournaledClarification;
  plan?: CoordinatorPlan;
  readonly runAssignments: Map<string, JournaledRunAssignment[]>;
  readonly failedRunIds: Set<string>;
  synthesis?: CoordinatorSynthesis;
  readonly workOrders: Map<string, JournaledWorkOrderResult>;
  artifact?: JournaledArtifactResult;
  reviewStarted: boolean;
  review?: CoordinatorReview;
  completedTask?: CompletedTaskView;
}

export class InMemoryOrchestrationJournal implements OrchestrationJournal {
  private readonly clock: MonotonicJournalClock;
  private readonly store: InMemoryEventStore;

  public constructor(options: InMemoryOrchestrationJournalOptions) {
    this.clock = new MonotonicJournalClock(options.clock);
    this.store = new InMemoryEventStore({ clock: this.clock });

    for (const event of [...(options.recordedEvents ?? [])].sort(
      (left, right) => left.globalPosition - right.globalPosition,
    )) {
      this.clock.runAt(event.occurredAt, "JOURNAL_EVENT_INVALID", () => {
        this.store.append({
          streamId: event.streamId,
          expectedVersion: this.store.streamVersion(event.streamId),
          events: [
            {
              eventId: event.eventId,
              type: event.type,
              payload: event.payload,
            },
          ],
        });
      });
    }
    this.clock.readLive();
    this.validateGlobalIdentities("JOURNAL_EVENT_INVALID");
  }

  public taskIdFor(forumPostId: string): string | undefined {
    return this.project(forumPostId).intake?.taskId;
  }

  public taskIntake(forumPostId: string): JournaledTaskIntake | undefined {
    const intake = this.project(forumPostId).intake;
    return intake === undefined ? undefined : freezeTaskIntake(intake);
  }

  public bindTask(forumPostId: string, intake: JournaledTaskIntake): void {
    const normalized = freezeTaskIntake(intake);
    if (normalized.forumPost.postId !== forumPostId) {
      throw new OrchestratorError(
        "FORUM_POST_CONFLICT",
        "A Task intake must be stored under its original Forum post ID.",
      );
    }

    const existing = this.taskIntake(forumPostId);
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          existing.taskId === normalized.taskId ? "FORUM_POST_CONFLICT" : "TASK_ID_CONFLICT",
          `Forum post ${forumPostId} already has a conflicting Task binding.`,
        );
      }
      return;
    }
    const conflictingBinding = this.store
      .readAll()
      .filter((event) => event.type === "task.bound")
      .map((event) => {
        const payload = requireRecord(event.payload);
        return {
          forumPostId: requireString(payload, "forumPostId"),
          taskId: requireString(payload, "taskId"),
        };
      })
      .find((binding) => binding.taskId === normalized.taskId);
    if (conflictingBinding !== undefined) {
      throw new OrchestratorError(
        "TASK_ID_CONFLICT",
        `Task ${normalized.taskId} is already bound to Forum post ${conflictingBinding.forumPostId}.`,
      );
    }

    this.append(forumPostId, "task.bound", ["task", forumPostId], {
      forumPostId,
      ...normalized,
    });
  }

  public intakeReady(forumPostId: string): boolean {
    return this.project(forumPostId).intakeReady;
  }

  public recordIntakeReady(forumPostId: string): void {
    const projection = this.project(forumPostId);
    if (projection.intakeReady) {
      return;
    }
    if (projection.intake === undefined || projection.clarification !== undefined) {
      throw new OrchestratorError(
        "COORDINATOR_INTAKE_INVALID",
        "A ready intake requires one Task binding and cannot follow a clarification.",
      );
    }
    this.append(forumPostId, "intake.ready", ["intake-ready", forumPostId], {
      forumPostId,
    });
  }

  public clarification(forumPostId: string): JournaledClarification | undefined {
    const clarification = this.project(forumPostId).clarification;
    return clarification === undefined ? undefined : freezeJournaledClarification(clarification);
  }

  public recordClarificationRequest(
    forumPostId: string,
    clarification: ClarificationRequest,
  ): void {
    const normalized = parseClarificationRequest(clarification, "COORDINATOR_INTAKE_INVALID");
    const projection = this.project(forumPostId);
    const existing = projection.clarification;
    if (existing !== undefined) {
      if (!sameValue(existing.request, normalized)) {
        throw new OrchestratorError(
          "COORDINATOR_INTAKE_INVALID",
          "A Task cannot replace its pending clarification with a different question.",
        );
      }
      return;
    }
    if (projection.intake === undefined || projection.intakeReady) {
      throw new OrchestratorError(
        "COORDINATOR_INTAKE_INVALID",
        "A clarification requires one unassessed Task binding.",
      );
    }
    this.append(forumPostId, "clarification.requested", ["clarification-request", forumPostId], {
      forumPostId,
      clarification: normalized,
    });
  }

  public recordClarificationAnswer(
    forumPostId: string,
    clarification: ClarificationExchange,
  ): void {
    const normalized = parseClarificationExchange(clarification, "CLARIFICATION_ANSWER_INVALID");
    const existing = this.clarification(forumPostId);
    if (existing === undefined) {
      throw new OrchestratorError(
        "CLARIFICATION_NOT_FOUND",
        `Forum post ${forumPostId} has no pending clarification.`,
      );
    }
    if (
      existing.request.clarificationId !== normalized.clarificationId ||
      existing.request.question !== normalized.question
    ) {
      throw new OrchestratorError(
        "CLARIFICATION_NOT_FOUND",
        "The clarification answer does not match the pending question.",
      );
    }
    if (existing.answer !== undefined) {
      if (!sameValue(existing.answer, normalized)) {
        throw new OrchestratorError(
          "CLARIFICATION_ANSWER_CONFLICT",
          "The clarification already has a different durable answer.",
        );
      }
      return;
    }

    this.append(forumPostId, "clarification.answered", ["clarification-answer", forumPostId], {
      forumPostId,
      clarification: normalized,
    });
  }

  public plan(forumPostId: string): CoordinatorPlan | undefined {
    const plan = this.project(forumPostId).plan;
    return plan === undefined ? undefined : parseCoordinatorPlan(plan, "JOURNAL_EVENT_INVALID");
  }

  public recordPlan(forumPostId: string, plan: CoordinatorPlan): void {
    const normalized = parseCoordinatorPlan(plan);
    const projection = this.project(forumPostId);
    const existing = projection.plan;
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "COORDINATOR_PLAN_CONFLICT",
          `Forum post ${forumPostId} already has a different durable plan.`,
        );
      }
      return;
    }
    if (
      projection.intake === undefined ||
      (!projection.intakeReady && projection.clarification?.answer === undefined)
    ) {
      throw new OrchestratorError(
        "COORDINATOR_PLAN_INVALID",
        "A Coordinator plan requires a ready intake or answered clarification.",
      );
    }
    this.append(forumPostId, "plan.recorded", ["plan", forumPostId], {
      forumPostId,
      plan: normalized,
    });
  }

  public runAssignment(
    forumPostId: string,
    workOrderId: string,
  ): JournaledRunAssignment | undefined {
    const projection = this.project(forumPostId);
    const assignment = projection.runAssignments.get(workOrderId)?.at(-1);
    return assignment === undefined || projection.failedRunIds.has(assignment.assignment.runId)
      ? undefined
      : freezeRunAssignment(assignment);
  }

  public runAssignments(forumPostId: string): readonly JournaledRunAssignment[] {
    return Object.freeze(
      [...this.project(forumPostId).runAssignments.values()]
        .flat()
        .sort((left, right) => left.workOrderId.localeCompare(right.workOrderId))
        .map(freezeRunAssignment),
    );
  }

  public recordRunAssignment(forumPostId: string, assignment: JournaledRunAssignment): void {
    const normalized = freezeRunAssignment(assignment);
    const projection = this.project(forumPostId);
    const existing = projection.runAssignments.get(normalized.workOrderId)?.at(-1);
    if (existing !== undefined) {
      if (projection.failedRunIds.has(existing.assignment.runId)) {
        if (sameValue(existing, normalized)) {
          throw new OrchestratorError(
            "RUN_ASSIGNMENT_CONFLICT",
            `Failed Run ${normalized.assignment.runId} cannot be reused for Work Order ${normalized.workOrderId}.`,
          );
        }
        if (normalized.assignment.fencingToken <= existing.assignment.fencingToken) {
          throw new OrchestratorError(
            "RUN_ASSIGNMENT_CONFLICT",
            `Replacement Run for Work Order ${normalized.workOrderId} must use a strictly higher fencing token.`,
          );
        }
      } else if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "RUN_ASSIGNMENT_CONFLICT",
          `Work Order ${normalized.workOrderId} already has a conflicting Run assignment.`,
        );
      } else {
        return;
      }
    }
    const plannedWorkOrder = projection.plan?.workOrders.find(
      (workOrder) => workOrder.workOrderId === normalized.workOrderId,
    );
    if (
      plannedWorkOrder === undefined ||
      normalized.planFingerprint !== fingerprintPlannedWorkOrder(plannedWorkOrder) ||
      normalized.assignment.workOrderId !== normalized.workOrderId ||
      normalized.assignment.taskId !== projection.intake?.taskId ||
      !plannedWorkOrder.dependsOn.every((dependencyId) => projection.workOrders.has(dependencyId))
    ) {
      throw new OrchestratorError(
        "RUN_ASSIGNMENT_CONFLICT",
        `Run assignment for Work Order ${normalized.workOrderId} is unplanned or out of dependency order.`,
      );
    }
    this.assertRunIdentifiersAvailable(normalized.assignment);
    const acceptedAt = this.clock.readLive();
    assertAssignmentLiveAt(
      normalized.assignment,
      acceptedAt,
      "RUN_ASSIGNMENT_INVALID",
      "A Run assignment must be live when it is durably dispatched.",
    );
    this.appendAt(
      forumPostId,
      "work-order.dispatched",
      ["dispatch", forumPostId, normalized.workOrderId, normalized.assignment.runId],
      {
        forumPostId,
        ...normalized,
      },
      acceptedAt,
    );
  }

  public recordRunFailed(forumPostId: string, workOrderId: string, runId: string): void {
    const projection = this.project(forumPostId);
    const assignment = projection.runAssignments.get(workOrderId)?.at(-1);
    if (
      assignment === undefined ||
      assignment.assignment.runId !== runId ||
      projection.workOrders.has(workOrderId)
    ) {
      throw new OrchestratorError(
        "RUN_ASSIGNMENT_CONFLICT",
        `Run ${runId} is not the active incomplete assignment for Work Order ${workOrderId}.`,
      );
    }
    if (projection.failedRunIds.has(runId)) {
      return;
    }
    this.append(
      forumPostId,
      "work-order.run-failed",
      ["dispatch-failed", forumPostId, workOrderId, runId],
      {
        forumPostId,
        workOrderId,
        runId,
      },
    );
  }

  public synthesis(forumPostId: string): CoordinatorSynthesis | undefined {
    const synthesis = this.project(forumPostId).synthesis;
    return synthesis === undefined
      ? undefined
      : parseCoordinatorSynthesis(synthesis, "JOURNAL_EVENT_INVALID");
  }

  public recordSynthesis(forumPostId: string, synthesis: CoordinatorSynthesis): void {
    const normalized = parseCoordinatorSynthesis(synthesis);
    const projection = this.project(forumPostId);
    const existing = projection.synthesis;
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "COORDINATOR_SYNTHESIS_INVALID",
          `Forum post ${forumPostId} already has a different durable synthesis.`,
        );
      }
      return;
    }
    if (
      projection.plan === undefined ||
      !projection.plan.workOrders.every((workOrder) =>
        projection.workOrders.has(workOrder.workOrderId),
      )
    ) {
      throw new OrchestratorError(
        "COORDINATOR_SYNTHESIS_INVALID",
        "Coordinator synthesis requires every planned Work Order result.",
      );
    }
    this.append(forumPostId, "synthesis.recorded", ["synthesis", forumPostId], {
      forumPostId,
      synthesis: normalized,
    });
  }

  public workOrderResults(forumPostId: string): readonly JournaledWorkOrderResult[] {
    return Object.freeze(
      [...this.project(forumPostId).workOrders.values()]
        .sort((left, right) => left.workOrderId.localeCompare(right.workOrderId))
        .map(freezeWorkOrderResult),
    );
  }

  public recordWorkOrderResult(forumPostId: string, result: JournaledWorkOrderResult): void {
    const normalized = freezeWorkOrderResult(result);
    const projection = this.project(forumPostId);
    const existing = projection.workOrders.get(result.workOrderId);
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "WORK_ORDER_ID_CONFLICT",
          `Work Order ${result.workOrderId} has conflicting journal results.`,
        );
      }
      return;
    }
    const plannedWorkOrder = projection.plan?.workOrders.find(
      (workOrder) => workOrder.workOrderId === result.workOrderId,
    );
    const currentAssignment = this.currentRunAssignment(
      projection,
      normalized.workOrderId,
    )?.assignment;
    if (
      plannedWorkOrder === undefined ||
      currentAssignment === undefined ||
      projection.synthesis !== undefined ||
      normalized.planFingerprint !== fingerprintPlannedWorkOrder(plannedWorkOrder) ||
      normalized.report.workOrderId !== normalized.workOrderId ||
      normalized.report.workerId !== normalized.workerId ||
      !runCompletionMatchesAssignment(normalized, currentAssignment) ||
      !plannedWorkOrder.dependsOn.every((dependencyId) => projection.workOrders.has(dependencyId))
    ) {
      throw new OrchestratorError(
        "WORK_ORDER_ID_CONFLICT",
        `Work Order ${result.workOrderId} is unplanned, out of dependency order, or already synthesized.`,
      );
    }

    const acceptedAt = this.clock.readLive();
    assertAssignmentLiveAt(
      currentAssignment,
      acceptedAt,
      "RUN_COMPLETION_STALE",
      `Worker completion for Run ${normalized.runId} arrived after its lease expired.`,
    );
    this.appendAt(
      forumPostId,
      "work-order.completed",
      ["work-order", forumPostId, result.workOrderId],
      {
        forumPostId,
        ...normalized,
      },
      acceptedAt,
    );
  }

  public artifactResult(forumPostId: string): JournaledArtifactResult | undefined {
    const result = this.project(forumPostId).artifact;
    return result === undefined ? undefined : freezeArtifactResult(result);
  }

  public recordArtifactResult(forumPostId: string, result: JournaledArtifactResult): void {
    const normalized = freezeArtifactResult(result);
    const projection = this.project(forumPostId);
    const existing = projection.artifact;
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "ARTIFACT_ID_CONFLICT",
          `Forum post ${forumPostId} already has a conflicting Artifact result.`,
        );
      }
      return;
    }
    if (
      projection.synthesis === undefined ||
      normalized.contentFingerprint !== fingerprintArtifactContent(projection.synthesis.artifact)
    ) {
      throw new OrchestratorError(
        "ARTIFACT_ID_CONFLICT",
        "Artifact publication requires and must match one durable Coordinator synthesis.",
      );
    }
    this.append(forumPostId, "artifact.published", ["artifact", forumPostId], {
      forumPostId,
      ...normalized,
    });
  }

  public reviewStarted(forumPostId: string): boolean {
    return this.project(forumPostId).reviewStarted;
  }

  public recordReviewStarted(forumPostId: string): void {
    const projection = this.project(forumPostId);
    if (projection.reviewStarted) {
      return;
    }
    if (projection.artifact === undefined) {
      throw new OrchestratorError(
        "COORDINATOR_REVIEW_INVALID",
        "Task review requires a published Artifact.",
      );
    }
    this.append(forumPostId, "task.review-started", ["review-started", forumPostId], {
      forumPostId,
    });
  }

  public review(forumPostId: string): CoordinatorReview | undefined {
    const projection = this.project(forumPostId);
    if (projection.review === undefined) {
      return undefined;
    }
    if (projection.plan === undefined) {
      throw new OrchestratorError(
        "JOURNAL_EVENT_INVALID",
        "A durable review requires a durable Coordinator plan.",
      );
    }
    return parseCoordinatorReview(
      projection.review,
      projection.plan.taskBrief,
      "JOURNAL_EVENT_INVALID",
    );
  }

  public recordReview(forumPostId: string, review: CoordinatorReview): void {
    const projection = this.project(forumPostId);
    const plan = projection.plan;
    if (
      plan === undefined ||
      projection.synthesis === undefined ||
      projection.artifact === undefined ||
      !projection.reviewStarted
    ) {
      throw new OrchestratorError(
        "COORDINATOR_REVIEW_INVALID",
        "A Coordinator review requires its plan, synthesis, Artifact, and review transition.",
      );
    }
    const normalized = parseCoordinatorReview(review, plan.taskBrief);
    const existing = projection.review;
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "COORDINATOR_REVIEW_INVALID",
          `Forum post ${forumPostId} already has a different durable review.`,
        );
      }
      return;
    }
    this.append(forumPostId, "task.review-completed", ["review-completed", forumPostId], {
      forumPostId,
      review: normalized,
    });
  }

  public taskStateHistory(forumPostId: string): readonly TaskState[] {
    const projection = this.project(forumPostId);
    if (projection.intake === undefined) {
      return Object.freeze([]);
    }

    const states: TaskState[] = ["intake"];
    if (projection.clarification !== undefined) {
      states.push("waiting_user");
    }
    if (projection.plan !== undefined) {
      states.push("running");
    }
    if (projection.reviewStarted) {
      states.push("review");
    }
    if (projection.completedTask !== undefined) {
      states.push("completed");
    }
    return Object.freeze(states);
  }

  public completedTask(forumPostId: string): CompletedTaskView | undefined {
    const task = this.project(forumPostId).completedTask;
    return task === undefined ? undefined : cloneTaskView(task);
  }

  public recordCompletedTask(forumPostId: string, task: CompletedTaskView): void {
    const normalized = parseCompletedTaskView(task);
    const projection = this.project(forumPostId);
    const existing = projection.completedTask;
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "TASK_ID_CONFLICT",
          `Forum post ${forumPostId} already has a conflicting completed Task.`,
        );
      }
      return;
    }
    if (projection.review === undefined) {
      throw new OrchestratorError(
        "JOURNAL_EVENT_INVALID",
        "A completed Task requires one durable Coordinator review.",
      );
    }
    assertCompletedTaskMatchesProjection(normalized, projection);
    this.append(forumPostId, "task.completed", ["completed", forumPostId], {
      forumPostId,
      task: normalized,
    });
  }

  public recordedEvents(): readonly StoredEvent[] {
    return this.store.readAll();
  }

  private append(
    forumPostId: string,
    type: string,
    eventIdentity: readonly string[],
    payload: object,
  ): void {
    const streamId = streamIdFor(forumPostId);
    this.store.append({
      streamId,
      expectedVersion: this.store.streamVersion(streamId),
      events: [
        {
          eventId: JSON.stringify(["orchestration", ...eventIdentity]),
          type,
          payload,
        },
      ],
    });
  }

  private appendAt(
    forumPostId: string,
    type: string,
    eventIdentity: readonly string[],
    payload: object,
    occurredAt: string,
  ): void {
    this.clock.runAt(occurredAt, "ORCHESTRATION_CLOCK_INVALID", () => {
      this.append(forumPostId, type, eventIdentity, payload);
    });
  }

  private project(forumPostId: string): JournalProjection {
    const initial: JournalProjection = {
      intakeReady: false,
      runAssignments: new Map<string, JournaledRunAssignment[]>(),
      failedRunIds: new Set<string>(),
      workOrders: new Map<string, JournaledWorkOrderResult>(),
      reviewStarted: false,
    };
    return this.store.replay(streamIdFor(forumPostId), initial, (projection, event) =>
      applyJournalEvent(projection, event),
    );
  }

  private currentRunAssignment(
    projection: JournalProjection,
    workOrderId: string,
  ): JournaledRunAssignment | undefined {
    const assignment = projection.runAssignments.get(workOrderId)?.at(-1);
    return assignment === undefined || projection.failedRunIds.has(assignment.assignment.runId)
      ? undefined
      : assignment;
  }

  private assertRunIdentifiersAvailable(assignment: RunAssignment): void {
    for (const event of this.store.readAll()) {
      if (event.type !== "work-order.dispatched") {
        continue;
      }
      const payload = requireRecord(event.payload);
      const existingForumPostId = requireString(payload, "forumPostId");
      const existing = parseRunAssignment(payload["assignment"], "JOURNAL_EVENT_INVALID");
      if (
        existing.runId === assignment.runId ||
        existing.leaseId === assignment.leaseId ||
        existing.idempotencyKey === assignment.idempotencyKey
      ) {
        throw new OrchestratorError(
          "RUN_ASSIGNMENT_CONFLICT",
          `Run, lease, and dispatch idempotency identifiers must be globally unique; conflict with Forum post ${existingForumPostId}.`,
        );
      }
    }
  }

  private validateGlobalIdentities(code: "JOURNAL_EVENT_INVALID"): void {
    const taskBindings = new Map<string, string>();
    const runIds = new Set<string>();
    const leaseIds = new Set<string>();
    const idempotencyKeys = new Set<string>();

    for (const event of this.store.readAll()) {
      if (event.type === "task.bound") {
        const payload = requireRecord(event.payload);
        const forumPostId = requireString(payload, "forumPostId");
        const taskId = requireString(payload, "taskId");
        const existing = taskBindings.get(taskId);
        if (existing !== undefined && existing !== forumPostId) {
          throw new OrchestratorError(code, `Task ${taskId} is bound to more than one Forum post.`);
        }
        taskBindings.set(taskId, forumPostId);
      }
      if (event.type === "work-order.dispatched") {
        const payload = requireRecord(event.payload);
        const assignment = parseRunAssignment(payload["assignment"], code);
        if (
          runIds.has(assignment.runId) ||
          leaseIds.has(assignment.leaseId) ||
          idempotencyKeys.has(assignment.idempotencyKey)
        ) {
          throw new OrchestratorError(
            code,
            "Recorded Run, lease, and dispatch idempotency identifiers must be globally unique.",
          );
        }
        runIds.add(assignment.runId);
        leaseIds.add(assignment.leaseId);
        idempotencyKeys.add(assignment.idempotencyKey);
      }
    }
  }
}

class MonotonicJournalClock implements EventClock {
  private readonly source: EventClock;
  private forcedInstant: string | undefined;
  private lastObservedEpochMs: number | undefined;

  public constructor(source: EventClock) {
    this.source = source;
  }

  public now(): string {
    return this.forcedInstant ?? this.readLive();
  }

  public readLive(): string {
    return this.observe(this.source.now(), "ORCHESTRATION_CLOCK_INVALID");
  }

  public runAt<TResult>(
    value: string,
    code: OrchestratorErrorCode,
    operation: () => TResult,
  ): TResult {
    if (this.forcedInstant !== undefined) {
      throw new OrchestratorError(
        code,
        "The orchestration event clock cannot nest authoritative instants.",
      );
    }
    const instant = this.observe(value, code);
    this.forcedInstant = instant;
    try {
      return operation();
    } finally {
      this.forcedInstant = undefined;
    }
  }

  private observe(value: string, code: OrchestratorErrorCode): string {
    const instant = parseRfc3339Instant(value, "orchestration clock", code);
    if (this.lastObservedEpochMs !== undefined && instant.epochMs < this.lastObservedEpochMs) {
      throw new OrchestratorError(
        code,
        "The orchestration clock must be monotonically non-decreasing.",
      );
    }
    this.lastObservedEpochMs = instant.epochMs;
    return instant.value;
  }
}

function streamIdFor(forumPostId: string): string {
  return JSON.stringify(["forum-task", forumPostId]);
}

function applyJournalEvent(projection: JournalProjection, event: StoredEvent): JournalProjection {
  const payload = requireRecord(event.payload);
  const forumPostId = requireString(payload, "forumPostId");
  assertJournalState(
    event.streamId === streamIdFor(forumPostId),
    "An orchestration event must stay in its Forum Task stream.",
  );
  if (event.type !== "task.bound") {
    assertJournalState(
      projection.intake?.forumPost.postId === forumPostId,
      "An orchestration event must follow its matching Task binding.",
    );
  }

  switch (event.type) {
    case "task.bound":
      assertJournalState(
        projection.intake === undefined,
        "A Task binding must be the first event in its orchestration stream.",
      );
      projection.intake = freezeTaskIntake({
        taskId: requireString(payload, "taskId"),
        forumPost: parseAuthorizedForumPost(payload["forumPost"], "JOURNAL_EVENT_INVALID"),
      });
      assertJournalState(
        projection.intake.forumPost.postId === forumPostId,
        "A Task binding payload must match its Forum Task stream.",
      );
      break;
    case "intake.ready":
      assertJournalState(
        projection.intake !== undefined &&
          !projection.intakeReady &&
          projection.clarification === undefined,
        "A ready intake must follow one Task binding and cannot follow a clarification.",
      );
      projection.intakeReady = true;
      break;
    case "clarification.requested":
      assertJournalState(
        projection.intake !== undefined &&
          !projection.intakeReady &&
          projection.clarification === undefined,
        "A clarification request must follow an unassessed Task binding.",
      );
      projection.clarification = Object.freeze({
        request: parseClarificationRequest(payload["clarification"]),
      });
      break;
    case "clarification.answered": {
      const answer = parseClarificationExchange(payload["clarification"]);
      if (
        projection.clarification === undefined ||
        projection.clarification.answer !== undefined ||
        projection.clarification.request.clarificationId !== answer.clarificationId ||
        projection.clarification.request.question !== answer.question
      ) {
        throw new OrchestratorError(
          "JOURNAL_EVENT_INVALID",
          "A clarification answer must follow its matching request.",
        );
      }
      projection.clarification = Object.freeze({
        request: projection.clarification.request,
        answer,
      });
      break;
    }
    case "plan.recorded":
      assertJournalState(
        projection.intake !== undefined &&
          projection.plan === undefined &&
          (projection.intakeReady || projection.clarification?.answer !== undefined),
        "A plan must follow a ready intake or an answered clarification.",
      );
      projection.plan = parseCoordinatorPlan(payload["plan"], "JOURNAL_EVENT_INVALID");
      break;
    case "work-order.dispatched": {
      assertJournalState(
        projection.plan !== undefined && projection.synthesis === undefined,
        "A Work Order dispatch must follow its plan and precede synthesis.",
      );
      const assignment = freezeRunAssignment({
        workOrderId: requireString(payload, "workOrderId"),
        planFingerprint: requireString(payload, "planFingerprint"),
        assignment: parseRunAssignment(payload["assignment"], "JOURNAL_EVENT_INVALID"),
      });
      const plannedWorkOrder = projection.plan.workOrders.find(
        (workOrder) => workOrder.workOrderId === assignment.workOrderId,
      );
      const priorAssignment = projection.runAssignments.get(assignment.workOrderId)?.at(-1);
      assertJournalState(
        plannedWorkOrder !== undefined &&
          assignment.planFingerprint === fingerprintPlannedWorkOrder(plannedWorkOrder) &&
          assignment.assignment.taskId === projection.intake?.taskId &&
          assignment.assignment.workOrderId === assignment.workOrderId &&
          assignmentIsLiveAt(assignment.assignment, event.occurredAt, "JOURNAL_EVENT_INVALID") &&
          plannedWorkOrder.dependsOn.every((dependencyId) =>
            projection.workOrders.has(dependencyId),
          ) &&
          (priorAssignment === undefined ||
            (projection.failedRunIds.has(priorAssignment.assignment.runId) &&
              assignment.assignment.fencingToken > priorAssignment.assignment.fencingToken)),
        `Run assignment for Work Order ${assignment.workOrderId} must follow a failed attempt with a higher fence, be planned, and be dependency-ready.`,
      );
      const assignments = projection.runAssignments.get(assignment.workOrderId) ?? [];
      projection.runAssignments.set(assignment.workOrderId, [...assignments, assignment]);
      break;
    }
    case "work-order.run-failed": {
      const workOrderId = requireString(payload, "workOrderId");
      const runId = requireString(payload, "runId");
      const assignment = projection.runAssignments.get(workOrderId)?.at(-1);
      assertJournalState(
        assignment?.assignment.runId === runId &&
          !projection.failedRunIds.has(runId) &&
          !projection.workOrders.has(workOrderId),
        `Failed Run ${runId} must be the active incomplete assignment for Work Order ${workOrderId}.`,
      );
      projection.failedRunIds.add(runId);
      break;
    }
    case "synthesis.recorded":
      assertJournalState(
        projection.plan !== undefined &&
          projection.synthesis === undefined &&
          projection.plan.workOrders.every((workOrder) =>
            projection.workOrders.has(workOrder.workOrderId),
          ),
        "Synthesis must follow durable results for every planned Work Order.",
      );
      projection.synthesis = parseCoordinatorSynthesis(
        payload["synthesis"],
        "JOURNAL_EVENT_INVALID",
      );
      break;
    case "work-order.completed": {
      assertJournalState(
        projection.plan !== undefined &&
          projection.synthesis === undefined &&
          (() => {
            const workOrderId = requireString(payload, "workOrderId");
            const assignment = projection.runAssignments.get(workOrderId)?.at(-1);
            return (
              assignment !== undefined && !projection.failedRunIds.has(assignment.assignment.runId)
            );
          })(),
        "A Work Order result must follow its plan and precede synthesis.",
      );
      const completion = parseWorkerRunCompletion(payload, "JOURNAL_EVENT_INVALID");
      const result = freezeWorkOrderResult({
        ...completion,
        planFingerprint: requireString(payload, "planFingerprint"),
        report: parseWorkerReport(payload["report"]),
      });
      const plannedWorkOrder = projection.plan.workOrders.find(
        (workOrder) => workOrder.workOrderId === result.workOrderId,
      );
      assertJournalState(
        plannedWorkOrder !== undefined &&
          result.planFingerprint === fingerprintPlannedWorkOrder(plannedWorkOrder) &&
          result.report.workOrderId === result.workOrderId &&
          result.report.workerId === result.workerId &&
          (() => {
            const assignment = projection.runAssignments.get(result.workOrderId)?.at(-1);
            return (
              assignment !== undefined &&
              !projection.failedRunIds.has(assignment.assignment.runId) &&
              runCompletionMatchesAssignment(result, assignment.assignment) &&
              assignmentIsLiveAt(assignment.assignment, event.occurredAt, "JOURNAL_EVENT_INVALID")
            );
          })() &&
          plannedWorkOrder.dependsOn.every((dependencyId) =>
            projection.workOrders.has(dependencyId),
          ),
        `Work Order ${result.workOrderId} must be planned and follow its dependency results.`,
      );
      const existing = projection.workOrders.get(result.workOrderId);
      if (existing !== undefined) {
        throw new OrchestratorError(
          "JOURNAL_EVENT_INVALID",
          `Work Order ${result.workOrderId} appears more than once in the journal.`,
        );
      }
      projection.workOrders.set(result.workOrderId, result);
      break;
    }
    case "artifact.published":
      assertJournalState(
        projection.synthesis !== undefined && projection.artifact === undefined,
        "Artifact publication must follow one durable synthesis.",
      );
      projection.artifact = freezeArtifactResult({
        contentFingerprint: requireString(payload, "contentFingerprint"),
        reference: parseArtifactReference(payload["reference"], "JOURNAL_EVENT_INVALID"),
      });
      assertJournalState(
        projection.artifact.contentFingerprint ===
          fingerprintArtifactContent(projection.synthesis.artifact),
        "Artifact content must match the durable Coordinator synthesis.",
      );
      break;
    case "task.review-started":
      assertJournalState(
        projection.artifact !== undefined && !projection.reviewStarted,
        "Task review must follow Artifact publication.",
      );
      projection.reviewStarted = true;
      break;
    case "task.review-completed":
      assertJournalState(
        projection.plan !== undefined &&
          projection.synthesis !== undefined &&
          projection.artifact !== undefined &&
          projection.reviewStarted &&
          projection.review === undefined,
        "A completed Coordinator review must follow its synthesis, Artifact, and review transition.",
      );
      projection.review = parseCoordinatorReview(
        payload["review"],
        projection.plan.taskBrief,
        "JOURNAL_EVENT_INVALID",
      );
      break;
    case "task.completed":
      assertJournalState(
        projection.review !== undefined && projection.completedTask === undefined,
        "Task completion must follow one durable Coordinator review.",
      );
      projection.completedTask = parseCompletedTaskView(payload["task"]);
      assertCompletedTaskMatchesProjection(projection.completedTask, projection);
      break;
    default:
      throw new OrchestratorError(
        "JOURNAL_EVENT_INVALID",
        `Unsupported orchestration event type ${event.type}.`,
      );
  }

  return projection;
}

function assertJournalState(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new OrchestratorError("JOURNAL_EVENT_INVALID", message);
  }
}

function assertCompletedTaskMatchesProjection(
  task: CompletedTaskView,
  projection: JournalProjection,
): void {
  assertJournalState(
    projection.intake !== undefined &&
      projection.plan !== undefined &&
      projection.synthesis !== undefined &&
      projection.artifact !== undefined &&
      projection.review !== undefined,
    "A completed Task must reconcile with its full durable orchestration state.",
  );

  const expectedWorkOrders = projection.plan.workOrders.map((workOrder) => {
    const result = projection.workOrders.get(workOrder.workOrderId);
    assertJournalState(
      result !== undefined,
      `Completed Task is missing Work Order ${workOrder.workOrderId}.`,
    );
    return {
      ...result.report,
      state: "succeeded",
    } as const;
  });
  const expectedStateHistory: TaskState[] = [
    "intake",
    ...(projection.clarification === undefined ? [] : (["waiting_user"] as const)),
    "running",
    "review",
    "completed",
  ];

  assertJournalState(
    task.taskId === projection.intake.taskId &&
      sameValue(task.taskBrief, projection.plan.taskBrief) &&
      sameValue(task.verifiedCompletionCriteria, projection.review.verifiedCompletionCriteria) &&
      sameValue(task.workOrders, expectedWorkOrders) &&
      sameValue(task.artifactRefs, [projection.artifact.reference]) &&
      task.resultProjection.content === projection.synthesis.summary &&
      task.resultProjection.actions[0].href === projection.artifact.reference.href &&
      sameValue(task.stateHistory, expectedStateHistory),
    "Completed Task view conflicts with its durable plan, results, Artifact, review, or lifecycle.",
  );
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OrchestratorError(
      "JOURNAL_EVENT_INVALID",
      "An orchestration event payload must be an object.",
    );
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new OrchestratorError(
      "JOURNAL_EVENT_INVALID",
      `Orchestration event field ${field} must be a non-blank string.`,
    );
  }
  return value;
}

function freezeTaskIntake(intake: JournaledTaskIntake): JournaledTaskIntake {
  if (intake.taskId.trim() === "") {
    throw new OrchestratorError(
      "TASK_ID_UNAVAILABLE",
      "A journaled Task intake requires a non-blank Task ID.",
    );
  }
  return Object.freeze({
    taskId: intake.taskId,
    forumPost: parseAuthorizedForumPost(intake.forumPost),
  });
}

function freezeJournaledClarification(
  clarification: JournaledClarification,
): JournaledClarification {
  const request = parseClarificationRequest(clarification.request);
  return Object.freeze({
    request,
    ...(clarification.answer === undefined
      ? {}
      : { answer: parseClarificationExchange(clarification.answer) }),
  });
}

function freezeRunAssignment(assignment: JournaledRunAssignment): JournaledRunAssignment {
  if (assignment.workOrderId.trim() === "" || assignment.planFingerprint.trim() === "") {
    throw new OrchestratorError(
      "JOURNAL_EVENT_INVALID",
      "A journaled Run assignment requires non-blank Work Order and plan identifiers.",
    );
  }
  const normalized = parseRunAssignment(assignment.assignment, "JOURNAL_EVENT_INVALID");
  if (normalized.workOrderId !== assignment.workOrderId) {
    throw new OrchestratorError(
      "JOURNAL_EVENT_INVALID",
      "A journaled Run assignment must match its Work Order identifier.",
    );
  }
  return Object.freeze({
    workOrderId: assignment.workOrderId,
    planFingerprint: assignment.planFingerprint,
    assignment: normalized,
  });
}

function freezeWorkOrderResult(result: JournaledWorkOrderResult): JournaledWorkOrderResult {
  const completion = parseWorkerRunCompletion(result, "JOURNAL_EVENT_INVALID");
  if (
    result.workOrderId.trim() === "" ||
    result.planFingerprint.trim() === "" ||
    result.report.workOrderId !== result.workOrderId ||
    result.report.workerId !== result.workerId
  ) {
    throw new OrchestratorError(
      "JOURNAL_EVENT_INVALID",
      "A Work Order journal result requires matching non-blank identifiers.",
    );
  }
  return Object.freeze({
    ...completion,
    planFingerprint: result.planFingerprint,
    report: parseWorkerReport(result.report),
  });
}

function runCompletionMatchesAssignment(
  completion: WorkerRunCompletion,
  assignment: RunAssignment,
): boolean {
  return (
    completion.taskId === assignment.taskId &&
    completion.workOrderId === assignment.workOrderId &&
    completion.deviceId === assignment.deviceId &&
    completion.workerId === assignment.workerId &&
    completion.routeId === assignment.routeId &&
    completion.runId === assignment.runId &&
    completion.leaseId === assignment.leaseId &&
    completion.fencingToken === assignment.fencingToken
  );
}

function assignmentIsLiveAt(
  assignment: RunAssignment,
  observedAt: string,
  code: OrchestratorErrorCode,
): boolean {
  return (
    parseRfc3339Instant(assignment.expiresAt, "expiresAt", code).epochMs >
    parseRfc3339Instant(observedAt, "completion acceptance time", code).epochMs
  );
}

function assertAssignmentLiveAt(
  assignment: RunAssignment,
  observedAt: string,
  code: OrchestratorErrorCode,
  message: string,
): void {
  if (!assignmentIsLiveAt(assignment, observedAt, code)) {
    throw new OrchestratorError(code, message);
  }
}

function freezeArtifactResult(result: JournaledArtifactResult): JournaledArtifactResult {
  if (result.contentFingerprint.trim() === "") {
    throw new OrchestratorError(
      "JOURNAL_EVENT_INVALID",
      "An Artifact journal result requires a content fingerprint.",
    );
  }
  return Object.freeze({
    contentFingerprint: result.contentFingerprint,
    reference: parseArtifactReference(result.reference, "JOURNAL_EVENT_INVALID"),
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
