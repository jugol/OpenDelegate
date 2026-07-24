import type { TaskState } from "@opendelegate/domain";
import {
  InMemoryEventStore,
  type EventClock,
  type EventStore,
  type StoredEvent,
} from "@opendelegate/event-store";

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
  readonly report: WorkerReport;
}

export interface JournaledRunAssignment {
  readonly workOrderId: string;
  readonly assignment: RunAssignment;
}

export interface JournaledArtifactResult {
  readonly reference: ArtifactReference;
}

export interface JournaledClarification {
  readonly request: ClarificationRequest;
  readonly answer?: ClarificationExchange;
}

export interface OrchestrationJournal {
  taskIdFor(forumPostId: string): Promise<string | undefined>;
  taskIntake(taskId: string): Promise<JournaledTaskIntake | undefined>;
  bindTask(forumPostId: string, intake: JournaledTaskIntake): Promise<void>;
  intakeReady(taskId: string): Promise<boolean>;
  recordIntakeReady(taskId: string): Promise<void>;
  clarification(taskId: string): Promise<JournaledClarification | undefined>;
  recordClarificationRequest(taskId: string, clarification: ClarificationRequest): Promise<void>;
  recordClarificationAnswer(taskId: string, clarification: ClarificationExchange): Promise<void>;
  plan(taskId: string): Promise<CoordinatorPlan | undefined>;
  recordPlan(taskId: string, plan: CoordinatorPlan): Promise<void>;
  runAssignment(taskId: string, workOrderId: string): Promise<JournaledRunAssignment | undefined>;
  runAssignments(taskId: string): Promise<readonly JournaledRunAssignment[]>;
  recordRunAssignment(taskId: string, assignment: JournaledRunAssignment): Promise<void>;
  recordRunFailed(taskId: string, workOrderId: string, runId: string): Promise<void>;
  synthesis(taskId: string): Promise<CoordinatorSynthesis | undefined>;
  recordSynthesis(taskId: string, synthesis: CoordinatorSynthesis): Promise<void>;
  workOrderResults(taskId: string): Promise<readonly JournaledWorkOrderResult[]>;
  recordWorkOrderResult(taskId: string, result: JournaledWorkOrderResult): Promise<void>;
  artifactResult(taskId: string): Promise<JournaledArtifactResult | undefined>;
  recordArtifactResult(taskId: string, result: JournaledArtifactResult): Promise<void>;
  reviewStarted(taskId: string): Promise<boolean>;
  recordReviewStarted(taskId: string): Promise<void>;
  review(taskId: string): Promise<CoordinatorReview | undefined>;
  recordReview(taskId: string, review: CoordinatorReview): Promise<void>;
  taskStateHistory(taskId: string): Promise<readonly TaskState[]>;
  completedTask(taskId: string): Promise<CompletedTaskView | undefined>;
  recordCompletedTask(taskId: string, task: CompletedTaskView): Promise<void>;
}

export interface InMemoryOrchestrationJournalOptions {
  readonly clock: EventClock;
  readonly eventStore?: EventStore;
  readonly recordedEvents?: readonly StoredEvent[];
}

export type EventStoreOrchestrationJournalOptions = InMemoryOrchestrationJournalOptions;

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
  private readonly initialization: Promise<void>;
  private readonly store: EventStore;
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(options: InMemoryOrchestrationJournalOptions) {
    if (options.eventStore !== undefined && options.recordedEvents !== undefined) {
      throw new OrchestratorError(
        "JOURNAL_EVENT_INVALID",
        "An injected EventStore cannot be combined with recorded in-memory events.",
      );
    }
    this.clock = new MonotonicJournalClock(options.clock);
    this.store = options.eventStore ?? new InMemoryEventStore({ clock: this.clock });
    this.initialization =
      options.eventStore === undefined
        ? this.restore(options.recordedEvents ?? [])
        : this.initializeExistingStore();
  }

  public async taskIdFor(forumPostId: string): Promise<string | undefined> {
    await this.initialization;
    const matching = (await this.store.readAll())
      .filter((event) => event.type === "task.bound")
      .map((event) => {
        const payload = requireRecord(event.payload);
        return {
          forumPostId: requireString(payload, "forumPostId"),
          taskId: requireString(payload, "taskId"),
        };
      })
      .find((binding) => binding.forumPostId === forumPostId);
    return matching?.taskId;
  }

  public async taskIntake(taskId: string): Promise<JournaledTaskIntake | undefined> {
    const intake = (await this.project(taskId)).intake;
    return intake === undefined ? undefined : freezeTaskIntake(intake);
  }

  public async bindTask(forumPostId: string, intake: JournaledTaskIntake): Promise<void> {
    const normalized = freezeTaskIntake(intake);
    await this.initialization;
    await this.enqueueWrite(() => this.bindTaskLocked(forumPostId, normalized));
  }

  private async bindTaskLocked(
    forumPostId: string,
    normalized: JournaledTaskIntake,
  ): Promise<void> {
    if (normalized.forumPost.postId !== forumPostId) {
      throw new OrchestratorError(
        "FORUM_POST_CONFLICT",
        "A Task intake must be stored under its original Forum post ID.",
      );
    }

    const boundTaskId = await this.taskIdFor(forumPostId);
    if (boundTaskId !== undefined) {
      const existing = await this.taskIntake(boundTaskId);
      if (existing === undefined || !sameValue(existing, normalized)) {
        throw new OrchestratorError(
          boundTaskId === normalized.taskId ? "FORUM_POST_CONFLICT" : "TASK_ID_CONFLICT",
          `Forum post ${forumPostId} already has a conflicting Task binding.`,
        );
      }
      return;
    }
    const existingTask = await this.taskIntake(normalized.taskId);
    if (existingTask !== undefined) {
      throw new OrchestratorError(
        "TASK_ID_CONFLICT",
        `Task ${normalized.taskId} is already bound to Forum post ${existingTask.forumPost.postId}.`,
      );
    }

    const occurredAt = this.clock.readLive();
    await this.appendNow(
      normalized.taskId,
      "task.bound",
      ["task", normalized.taskId],
      {
        forumPostId,
        ...normalized,
      },
      occurredAt,
    );
  }

  public async intakeReady(taskId: string): Promise<boolean> {
    return (await this.project(taskId)).intakeReady;
  }

  public async recordIntakeReady(taskId: string): Promise<void> {
    const projection = await this.project(taskId);
    if (projection.intakeReady) {
      return;
    }
    if (projection.intake === undefined || projection.clarification !== undefined) {
      throw new OrchestratorError(
        "COORDINATOR_INTAKE_INVALID",
        "A ready intake requires one Task binding and cannot follow a clarification.",
      );
    }
    await this.append(taskId, "intake.ready", ["intake-ready", taskId], {
      taskId,
    });
  }

  public async clarification(taskId: string): Promise<JournaledClarification | undefined> {
    const clarification = (await this.project(taskId)).clarification;
    return clarification === undefined ? undefined : freezeJournaledClarification(clarification);
  }

  public async recordClarificationRequest(
    taskId: string,
    clarification: ClarificationRequest,
  ): Promise<void> {
    const normalized = parseClarificationRequest(clarification, "COORDINATOR_INTAKE_INVALID");
    const projection = await this.project(taskId);
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
    await this.append(taskId, "clarification.requested", ["clarification-request", taskId], {
      taskId,
      clarification: normalized,
    });
  }

  public async recordClarificationAnswer(
    taskId: string,
    clarification: ClarificationExchange,
  ): Promise<void> {
    const normalized = parseClarificationExchange(clarification, "CLARIFICATION_ANSWER_INVALID");
    const existing = await this.clarification(taskId);
    if (existing === undefined) {
      throw new OrchestratorError(
        "CLARIFICATION_NOT_FOUND",
        `Task ${taskId} has no pending clarification.`,
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

    await this.append(taskId, "clarification.answered", ["clarification-answer", taskId], {
      taskId,
      clarification: normalized,
    });
  }

  public async plan(taskId: string): Promise<CoordinatorPlan | undefined> {
    const plan = (await this.project(taskId)).plan;
    return plan === undefined ? undefined : parseCoordinatorPlan(plan, "JOURNAL_EVENT_INVALID");
  }

  public async recordPlan(taskId: string, plan: CoordinatorPlan): Promise<void> {
    const normalized = parseCoordinatorPlan(plan);
    const projection = await this.project(taskId);
    const existing = projection.plan;
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "COORDINATOR_PLAN_CONFLICT",
          `Task ${taskId} already has a different durable plan.`,
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
    await this.append(taskId, "plan.recorded", ["plan", taskId], {
      taskId,
      plan: normalized,
    });
  }

  public async runAssignment(
    taskId: string,
    workOrderId: string,
  ): Promise<JournaledRunAssignment | undefined> {
    const projection = await this.project(taskId);
    const assignment = projection.runAssignments.get(workOrderId)?.at(-1);
    return assignment === undefined || projection.failedRunIds.has(assignment.assignment.runId)
      ? undefined
      : freezeRunAssignment(assignment);
  }

  public async runAssignments(taskId: string): Promise<readonly JournaledRunAssignment[]> {
    return Object.freeze(
      [...(await this.project(taskId)).runAssignments.values()]
        .flat()
        .sort((left, right) => left.workOrderId.localeCompare(right.workOrderId))
        .map(freezeRunAssignment),
    );
  }

  public async recordRunAssignment(
    taskId: string,
    assignment: JournaledRunAssignment,
  ): Promise<void> {
    const normalized = freezeRunAssignment(assignment);
    await this.initialization;
    await this.enqueueWrite(() => this.recordRunAssignmentLocked(taskId, normalized));
  }

  private async recordRunAssignmentLocked(
    taskId: string,
    normalized: JournaledRunAssignment,
  ): Promise<void> {
    const projection = await this.project(taskId);
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
      normalized.assignment.workOrderId !== normalized.workOrderId ||
      normalized.assignment.taskId !== taskId ||
      !plannedWorkOrder.dependsOn.every((dependencyId) => projection.workOrders.has(dependencyId))
    ) {
      throw new OrchestratorError(
        "RUN_ASSIGNMENT_CONFLICT",
        `Run assignment for Work Order ${normalized.workOrderId} is unplanned or out of dependency order.`,
      );
    }
    await this.assertRunIdentifiersAvailable(normalized.assignment);
    const acceptedAt = this.clock.readLive();
    assertAssignmentLiveAt(
      normalized.assignment,
      acceptedAt,
      "RUN_ASSIGNMENT_INVALID",
      "A Run assignment must be live when it is durably dispatched.",
    );
    await this.clock.runAt(acceptedAt, "ORCHESTRATION_CLOCK_INVALID", () =>
      this.appendNow(
        taskId,
        "work-order.dispatched",
        ["dispatch", taskId, normalized.workOrderId, normalized.assignment.runId],
        {
          taskId,
          ...normalized,
          planFingerprint: fingerprintPlannedWorkOrder(plannedWorkOrder),
        },
        acceptedAt,
      ),
    );
  }

  public async recordRunFailed(taskId: string, workOrderId: string, runId: string): Promise<void> {
    const projection = await this.project(taskId);
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
    await this.append(
      taskId,
      "work-order.run-failed",
      ["dispatch-failed", taskId, workOrderId, runId],
      {
        taskId,
        workOrderId,
        runId,
      },
    );
  }

  public async synthesis(taskId: string): Promise<CoordinatorSynthesis | undefined> {
    const synthesis = (await this.project(taskId)).synthesis;
    return synthesis === undefined
      ? undefined
      : parseCoordinatorSynthesis(synthesis, "JOURNAL_EVENT_INVALID");
  }

  public async recordSynthesis(taskId: string, synthesis: CoordinatorSynthesis): Promise<void> {
    const normalized = parseCoordinatorSynthesis(synthesis);
    const projection = await this.project(taskId);
    const existing = projection.synthesis;
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "COORDINATOR_SYNTHESIS_INVALID",
          `Task ${taskId} already has a different durable synthesis.`,
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
    await this.append(taskId, "synthesis.recorded", ["synthesis", taskId], {
      taskId,
      synthesis: normalized,
    });
  }

  public async workOrderResults(taskId: string): Promise<readonly JournaledWorkOrderResult[]> {
    return Object.freeze(
      [...(await this.project(taskId)).workOrders.values()]
        .sort((left, right) => left.workOrderId.localeCompare(right.workOrderId))
        .map(freezeWorkOrderResult),
    );
  }

  public async recordWorkOrderResult(
    taskId: string,
    result: JournaledWorkOrderResult,
  ): Promise<void> {
    const normalized = freezeWorkOrderResult(result);
    const projection = await this.project(taskId);
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
    await this.appendAt(
      taskId,
      "work-order.completed",
      ["work-order", taskId, result.workOrderId],
      {
        ...normalized,
        planFingerprint: fingerprintPlannedWorkOrder(plannedWorkOrder),
      },
      acceptedAt,
    );
  }

  public async artifactResult(taskId: string): Promise<JournaledArtifactResult | undefined> {
    const result = (await this.project(taskId)).artifact;
    return result === undefined ? undefined : freezeArtifactResult(result);
  }

  public async recordArtifactResult(
    taskId: string,
    result: JournaledArtifactResult,
  ): Promise<void> {
    const normalized = freezeArtifactResult(result);
    const projection = await this.project(taskId);
    const existing = projection.artifact;
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "ARTIFACT_ID_CONFLICT",
          `Task ${taskId} already has a conflicting Artifact result.`,
        );
      }
      return;
    }
    if (projection.synthesis === undefined) {
      throw new OrchestratorError(
        "ARTIFACT_ID_CONFLICT",
        "Artifact publication requires and must match one durable Coordinator synthesis.",
      );
    }
    await this.append(taskId, "artifact.published", ["artifact", taskId], {
      taskId,
      ...normalized,
      contentFingerprint: fingerprintArtifactContent(projection.synthesis.artifact),
    });
  }

  public async reviewStarted(taskId: string): Promise<boolean> {
    return (await this.project(taskId)).reviewStarted;
  }

  public async recordReviewStarted(taskId: string): Promise<void> {
    const projection = await this.project(taskId);
    if (projection.reviewStarted) {
      return;
    }
    if (projection.artifact === undefined) {
      throw new OrchestratorError(
        "COORDINATOR_REVIEW_INVALID",
        "Task review requires a published Artifact.",
      );
    }
    await this.append(taskId, "task.review-started", ["review-started", taskId], {
      taskId,
    });
  }

  public async review(taskId: string): Promise<CoordinatorReview | undefined> {
    const projection = await this.project(taskId);
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

  public async recordReview(taskId: string, review: CoordinatorReview): Promise<void> {
    const projection = await this.project(taskId);
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
          `Task ${taskId} already has a different durable review.`,
        );
      }
      return;
    }
    await this.append(taskId, "task.review-completed", ["review-completed", taskId], {
      taskId,
      review: normalized,
    });
  }

  public async taskStateHistory(taskId: string): Promise<readonly TaskState[]> {
    const projection = await this.project(taskId);
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

  public async completedTask(taskId: string): Promise<CompletedTaskView | undefined> {
    const task = (await this.project(taskId)).completedTask;
    return task === undefined ? undefined : cloneTaskView(task);
  }

  public async recordCompletedTask(taskId: string, task: CompletedTaskView): Promise<void> {
    const normalized = parseCompletedTaskView(task);
    const projection = await this.project(taskId);
    const existing = projection.completedTask;
    if (existing !== undefined) {
      if (!sameValue(existing, normalized)) {
        throw new OrchestratorError(
          "TASK_ID_CONFLICT",
          `Task ${taskId} already has a conflicting completed Task.`,
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
    await this.append(taskId, "task.completed", ["completed", taskId], {
      taskId,
      task: normalized,
    });
  }

  public async recordedEvents(): Promise<readonly StoredEvent[]> {
    await this.initialization;
    return this.store.readAll();
  }

  private async restore(recordedEvents: readonly StoredEvent[]): Promise<void> {
    for (const event of [...recordedEvents].sort(
      (left, right) => left.globalPosition - right.globalPosition,
    )) {
      await this.clock.runAt(event.occurredAt, "JOURNAL_EVENT_INVALID", async () => {
        await this.store.append({
          streamId: event.streamId,
          expectedVersion: await this.store.streamVersion(event.streamId),
          occurredAt: event.occurredAt,
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
    await this.validateGlobalIdentities("JOURNAL_EVENT_INVALID");
  }

  private async initializeExistingStore(): Promise<void> {
    const events = await this.store.readAll();
    const streamVersions = new Map<string, number>();
    const eventIds = new Set<string>();

    for (const [index, event] of events.entries()) {
      const expectedGlobalPosition = index + 1;
      const expectedStreamVersion = (streamVersions.get(event.streamId) ?? 0) + 1;
      if (
        event.globalPosition !== expectedGlobalPosition ||
        event.streamVersion !== expectedStreamVersion ||
        eventIds.has(event.eventId)
      ) {
        throw new OrchestratorError(
          "JOURNAL_EVENT_INVALID",
          "An injected EventStore must return one contiguous, uniquely identified global and per-stream event order.",
        );
      }
      streamVersions.set(event.streamId, expectedStreamVersion);
      eventIds.add(event.eventId);
      await this.clock.runAt(event.occurredAt, "JOURNAL_EVENT_INVALID", () => undefined);
    }

    this.clock.readLive();
    await this.validateGlobalIdentities("JOURNAL_EVENT_INVALID");
  }

  private async append(
    taskId: string,
    type: string,
    eventIdentity: readonly string[],
    payload: object,
  ): Promise<void> {
    await this.initialization;
    await this.enqueueWrite(() => {
      const occurredAt = this.clock.readLive();
      return this.appendNow(taskId, type, eventIdentity, payload, occurredAt);
    });
  }

  private async appendNow(
    taskId: string,
    type: string,
    eventIdentity: readonly string[],
    payload: object,
    occurredAt: string,
  ): Promise<void> {
    const streamId = streamIdFor(taskId);
    await this.store.append({
      streamId,
      expectedVersion: await this.store.streamVersion(streamId),
      occurredAt,
      events: [
        {
          eventId: JSON.stringify(["orchestration", ...eventIdentity]),
          type,
          payload,
        },
      ],
    });
  }

  private async appendAt(
    taskId: string,
    type: string,
    eventIdentity: readonly string[],
    payload: object,
    occurredAt: string,
  ): Promise<void> {
    await this.initialization;
    await this.enqueueWrite(() =>
      this.clock.runAt(occurredAt, "ORCHESTRATION_CLOCK_INVALID", () =>
        this.appendNow(taskId, type, eventIdentity, payload, occurredAt),
      ),
    );
  }

  private async project(taskId: string): Promise<JournalProjection> {
    await this.initialization;
    const initial: JournalProjection = {
      intakeReady: false,
      runAssignments: new Map<string, JournaledRunAssignment[]>(),
      failedRunIds: new Set<string>(),
      workOrders: new Map<string, JournaledWorkOrderResult>(),
      reviewStarted: false,
    };
    return this.store.replay(streamIdFor(taskId), initial, (projection, event) =>
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

  private enqueueWrite<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async assertRunIdentifiersAvailable(assignment: RunAssignment): Promise<void> {
    await this.initialization;
    for (const event of await this.store.readAll()) {
      if (event.type !== "work-order.dispatched") {
        continue;
      }
      const payload = requireRecord(event.payload);
      const existingTaskId = requireString(payload, "taskId");
      const existing = parseRunAssignment(payload["assignment"], "JOURNAL_EVENT_INVALID");
      if (
        existing.runId === assignment.runId ||
        existing.leaseId === assignment.leaseId ||
        existing.idempotencyKey === assignment.idempotencyKey
      ) {
        throw new OrchestratorError(
          "RUN_ASSIGNMENT_CONFLICT",
          `Run, lease, and dispatch idempotency identifiers must be globally unique; conflict with Task ${existingTaskId}.`,
        );
      }
    }
  }

  private async validateGlobalIdentities(code: "JOURNAL_EVENT_INVALID"): Promise<void> {
    const taskBindings = new Map<string, string>();
    const forumBindings = new Map<string, string>();
    const runIds = new Set<string>();
    const leaseIds = new Set<string>();
    const idempotencyKeys = new Set<string>();

    for (const event of await this.store.readAll()) {
      if (event.type === "task.bound") {
        const payload = requireRecord(event.payload);
        const forumPostId = requireString(payload, "forumPostId");
        const taskId = requireString(payload, "taskId");
        const existingForumPostId = taskBindings.get(taskId);
        const existingTaskId = forumBindings.get(forumPostId);
        if (
          event.streamId !== streamIdFor(taskId) ||
          (existingForumPostId !== undefined && existingForumPostId !== forumPostId) ||
          (existingTaskId !== undefined && existingTaskId !== taskId)
        ) {
          throw new OrchestratorError(code, `Task ${taskId} is bound to more than one Forum post.`);
        }
        taskBindings.set(taskId, forumPostId);
        forumBindings.set(forumPostId, taskId);
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

  public async runAt<TResult>(
    value: string,
    code: OrchestratorErrorCode,
    operation: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    if (this.forcedInstant !== undefined) {
      throw new OrchestratorError(
        code,
        "The orchestration event clock cannot nest authoritative instants.",
      );
    }
    const instant = this.observe(value, code);
    this.forcedInstant = instant;
    try {
      return await operation();
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

function streamIdFor(taskId: string): string {
  return JSON.stringify(["task", taskId]);
}

function applyJournalEvent(projection: JournalProjection, event: StoredEvent): JournalProjection {
  const payload = requireRecord(event.payload);
  const taskId = requireString(payload, "taskId");
  assertJournalState(
    event.streamId === streamIdFor(taskId),
    "An orchestration event must stay in its canonical Task stream.",
  );
  if (event.type !== "task.bound") {
    assertJournalState(
      projection.intake?.taskId === taskId,
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
        taskId,
        forumPost: parseAuthorizedForumPost(payload["forumPost"], "JOURNAL_EVENT_INVALID"),
      });
      assertJournalState(
        projection.intake.taskId === taskId &&
          projection.intake.forumPost.postId === requireString(payload, "forumPostId"),
        "A Task binding payload must match its canonical Task stream and channel binding.",
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
      const planFingerprint = requireString(payload, "planFingerprint");
      const assignment = freezeRunAssignment({
        workOrderId: requireString(payload, "workOrderId"),
        assignment: parseRunAssignment(payload["assignment"], "JOURNAL_EVENT_INVALID"),
      });
      const plannedWorkOrder = projection.plan.workOrders.find(
        (workOrder) => workOrder.workOrderId === assignment.workOrderId,
      );
      const priorAssignment = projection.runAssignments.get(assignment.workOrderId)?.at(-1);
      assertJournalState(
        plannedWorkOrder !== undefined &&
          planFingerprint === fingerprintPlannedWorkOrder(plannedWorkOrder) &&
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
      const planFingerprint = requireString(payload, "planFingerprint");
      const result = freezeWorkOrderResult({
        ...completion,
        report: parseWorkerReport(payload["report"]),
      });
      const plannedWorkOrder = projection.plan.workOrders.find(
        (workOrder) => workOrder.workOrderId === result.workOrderId,
      );
      assertJournalState(
        plannedWorkOrder !== undefined &&
          planFingerprint === fingerprintPlannedWorkOrder(plannedWorkOrder) &&
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
    case "artifact.published": {
      assertJournalState(
        projection.synthesis !== undefined && projection.artifact === undefined,
        "Artifact publication must follow one durable synthesis.",
      );
      const contentFingerprint = requireString(payload, "contentFingerprint");
      projection.artifact = freezeArtifactResult({
        reference: parseArtifactReference(payload["reference"], "JOURNAL_EVENT_INVALID"),
      });
      assertJournalState(
        contentFingerprint === fingerprintArtifactContent(projection.synthesis.artifact),
        "Artifact content must match the durable Coordinator synthesis.",
      );
      break;
    }
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
  if (assignment.workOrderId.trim() === "") {
    throw new OrchestratorError(
      "JOURNAL_EVENT_INVALID",
      "A journaled Run assignment requires a non-blank Work Order identifier.",
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
    assignment: normalized,
  });
}

function freezeWorkOrderResult(result: JournaledWorkOrderResult): JournaledWorkOrderResult {
  const completion = parseWorkerRunCompletion(result, "JOURNAL_EVENT_INVALID");
  if (
    result.workOrderId.trim() === "" ||
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
  return Object.freeze({
    reference: parseArtifactReference(result.reference, "JOURNAL_EVENT_INVALID"),
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
