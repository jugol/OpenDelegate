import { ArtifactId, RunId, Task, TaskId, WorkOrderId } from "@opendelegate/domain";

import {
  deepFreeze,
  fingerprintArtifactContent,
  fingerprintPlannedWorkOrder,
  parseArtifactReference,
  parseAuthorizedForumPost,
  parseCoordinatorIntakeDecision,
  parseCoordinatorPlan,
  parseCoordinatorReview,
  parseCoordinatorSynthesis,
  parseRfc3339Instant,
  parseRunAssignment,
  parseWorkerExecutionResult,
  parseWorkerReport,
} from "./contract-validation.ts";
import type {
  ArtifactReference,
  AuthorizedForumPost,
  ClarificationAnswerInput,
  ClarificationExchange,
  CompletedTaskView,
  ForumPostInput,
  OpenDelegate,
  OpenDelegateDependencies,
  PlannedWorkOrder,
  RunAssignment,
  TaskView,
  WaitingUserTaskView,
  WorkOrderSchedulingCandidate,
  WorkerExecutionResult,
  WorkerReport,
  WorkerRunCompletion,
  WorkOrderView,
} from "./contracts.ts";
import {
  InMemoryOrchestrationJournal,
  type JournaledTaskIntake,
  type JournaledWorkOrderResult,
  type OrchestrationJournal,
} from "./orchestration-journal.ts";
import { OrchestratorError } from "./orchestrator-error.ts";

export function createOpenDelegate(dependencies: OpenDelegateDependencies): OpenDelegate {
  const activeExecutions = new Map<string, ActiveExecution>();
  const journal =
    dependencies.journal ??
    new InMemoryOrchestrationJournal({
      clock: dependencies.clock,
    });

  return {
    async acceptForumPost(input) {
      const authorizedForumPost = await authorizeForumPost(input, dependencies);
      const persistedIntake = journal.taskIntake(input.postId);
      if (
        persistedIntake !== undefined &&
        JSON.stringify(persistedIntake.forumPost) !== JSON.stringify(authorizedForumPost)
      ) {
        throw new OrchestratorError(
          "FORUM_POST_CONFLICT",
          `Forum post ${input.postId} was redelivered with conflicting intake content or authority.`,
        );
      }
      return runExclusive(
        activeExecutions,
        input.postId,
        {
          kind: "accept",
          fingerprint: JSON.stringify(authorizedForumPost),
        },
        async () => {
          const intake = resolveTaskIntake(authorizedForumPost, dependencies, journal);
          const completed = journal.completedTask(input.postId);
          if (completed !== undefined) {
            return completed;
          }

          const clarification = journal.clarification(input.postId);
          if (clarification !== undefined && clarification.answer === undefined) {
            return projectWaitingTask(journal, intake);
          }

          if (
            journal.plan(input.postId) === undefined &&
            !journal.intakeReady(input.postId) &&
            clarification === undefined
          ) {
            const decision = parseCoordinatorIntakeDecision(
              await dependencies.coordinator.assessIntake({
                taskId: intake.taskId,
                forumPost: intake.forumPost,
              }),
            );
            if (decision.decision === "clarification") {
              journal.recordClarificationRequest(input.postId, decision.clarification);
              return projectWaitingTask(journal, intake);
            }
            journal.recordIntakeReady(input.postId);
          }

          return executeTask(intake, dependencies, journal);
        },
      );
    },

    async answerClarification(input) {
      assertClarificationAnswerInput(input);
      const intake = journal.taskIntake(input.postId);
      if (intake === undefined) {
        throw new OrchestratorError(
          "CLARIFICATION_NOT_FOUND",
          `Forum post ${input.postId} has no durable Task clarification.`,
        );
      }

      const authorization = await dependencies.authorizer.authorizeForumPost({
        forumId: intake.forumPost.forumId,
        postId: intake.forumPost.postId,
        authorId: input.authorId,
      });
      if (
        authorization.decision !== "allow" ||
        authorization.principalId !== intake.forumPost.authorizedPrincipalId
      ) {
        throw new OrchestratorError(
          "FORUM_AUTHOR_UNAUTHORIZED",
          "The Discord reply author is not authorized to answer this Task clarification.",
        );
      }

      const durableClarification = journal.clarification(input.postId);
      if (
        durableClarification === undefined ||
        durableClarification.request.clarificationId !== input.clarificationId
      ) {
        throw new OrchestratorError(
          "CLARIFICATION_NOT_FOUND",
          "The clarification ID does not match the pending Task question.",
        );
      }
      if (
        durableClarification.answer !== undefined &&
        durableClarification.answer.answer !== input.answer
      ) {
        throw new OrchestratorError(
          "CLARIFICATION_ANSWER_CONFLICT",
          "The clarification already has a different durable answer.",
        );
      }

      return runExclusive(
        activeExecutions,
        input.postId,
        {
          kind: "answer",
          fingerprint: JSON.stringify({
            clarificationId: input.clarificationId,
            answer: input.answer,
          }),
        },
        async () => {
          const currentIntake = journal.taskIntake(input.postId);
          const clarification = journal.clarification(input.postId);
          if (currentIntake === undefined || clarification === undefined) {
            throw new OrchestratorError(
              "CLARIFICATION_NOT_FOUND",
              `Forum post ${input.postId} has no durable Task clarification.`,
            );
          }
          if (clarification.request.clarificationId !== input.clarificationId) {
            throw new OrchestratorError(
              "CLARIFICATION_NOT_FOUND",
              "The clarification ID does not match the pending Task question.",
            );
          }

          const exchange = deepFreeze({
            ...clarification.request,
            answer: input.answer,
          } satisfies ClarificationExchange);
          journal.recordClarificationAnswer(input.postId, exchange);

          const completed = journal.completedTask(input.postId);
          if (completed !== undefined) {
            return completed;
          }
          return executeTask(currentIntake, dependencies, journal);
        },
      );
    },

    getTaskByForumPost(postId) {
      const completed = journal.completedTask(postId);
      if (completed !== undefined) {
        return completed;
      }

      const intake = journal.taskIntake(postId);
      const clarification = journal.clarification(postId);
      if (
        intake !== undefined &&
        clarification !== undefined &&
        clarification.answer === undefined
      ) {
        return projectWaitingTask(journal, intake);
      }

      throw new OrchestratorError(
        "TASK_NOT_FOUND",
        `No presentable Task view is bound to Forum post ${postId}.`,
      );
    },
  };
}

async function executeTask(
  intake: JournaledTaskIntake,
  dependencies: OpenDelegateDependencies,
  journal: OrchestrationJournal,
): Promise<CompletedTaskView> {
  const { taskId, forumPost } = intake;
  const forumPostId = forumPost.postId;
  const existingPlan = journal.plan(forumPostId);
  const clarification = journal.clarification(forumPostId)?.answer;
  const plan =
    existingPlan ??
    parseCoordinatorPlan(
      await dependencies.coordinator.plan({
        taskId,
        forumPost,
        ...(clarification === undefined ? {} : { clarification }),
      }),
    );

  if (existingPlan === undefined) {
    journal.recordPlan(forumPostId, plan);
  }

  const task = Task.create({
    id: TaskId.from(taskId),
    brief: plan.taskBrief,
    completionRequirements: {
      minimumArtifactResults: 1,
    },
  });
  if (journal.clarification(forumPostId) !== undefined) {
    task.transitionTo("waiting_user");
    task.transitionTo("running");
  }

  for (const workOrder of plan.workOrders) {
    task.dispatchWorkOrder({
      id: WorkOrderId.from(workOrder.workOrderId),
      required: true,
    });
  }

  const completedWorkOrders = validateCachedWorkOrders(
    plan.workOrders,
    journal.workOrderResults(forumPostId),
  );
  for (const completedWorkOrder of completedWorkOrders.values()) {
    const assignment = journal.runAssignment(
      forumPostId,
      completedWorkOrder.workOrderId,
    )?.assignment;
    if (assignment === undefined) {
      throw new OrchestratorError(
        "RUN_ASSIGNMENT_CONFLICT",
        `Completed Work Order ${completedWorkOrder.workOrderId} has no durable Run assignment.`,
      );
    }
    if (!runCompletionMatchesAssignment(completedWorkOrder, assignment)) {
      throw new OrchestratorError(
        "RUN_ASSIGNMENT_CONFLICT",
        `Completed Work Order ${completedWorkOrder.workOrderId} does not match its durable Run assignment.`,
      );
    }
    task.recordWorkOrderSucceeded({
      id: WorkOrderId.from(completedWorkOrder.workOrderId),
      runId: RunId.from(completedWorkOrder.runId),
      fencingToken: completedWorkOrder.fencingToken,
    });
  }

  await executeDependencyWaves({
    task,
    taskId,
    forumPostId,
    workOrders: plan.workOrders,
    completedWorkOrders,
    dependencies,
    journal,
  });

  const reports = Object.freeze(
    plan.workOrders.map((workOrder) => {
      const result = completedWorkOrders.get(workOrder.workOrderId);
      if (result === undefined) {
        throw new OrchestratorError(
          "WORK_ORDER_ID_CONFLICT",
          `Work Order ${workOrder.workOrderId} completed without a durable report.`,
        );
      }
      return result.report;
    }),
  );

  const cachedSynthesis = journal.synthesis(forumPostId);
  const synthesis =
    cachedSynthesis ??
    parseCoordinatorSynthesis(
      await dependencies.coordinator.synthesize({
        taskId,
        reports,
      }),
    );
  if (cachedSynthesis === undefined) {
    journal.recordSynthesis(forumPostId, synthesis);
  }
  const artifactReference = await publishArtifactResult({
    taskId,
    forumPostId,
    synthesis,
    dependencies,
    journal,
  });

  task.recordArtifactResult(ArtifactId.from(artifactReference.artifactId));
  task.transitionTo("review");
  journal.recordReviewStarted(forumPostId);

  const cachedReview = journal.review(forumPostId);
  const review =
    cachedReview ??
    parseCoordinatorReview(
      await dependencies.coordinator.review(
        deepFreeze({
          taskId,
          taskBrief: plan.taskBrief,
          workOrders: plan.workOrders,
          reports,
          synthesis,
          artifactReference,
        }),
      ),
      plan.taskBrief,
    );
  if (cachedReview === undefined) {
    journal.recordReview(forumPostId, review);
  }
  for (const criterion of review.verifiedCompletionCriteria) {
    task.verifyCompletionCriterion(criterion);
  }
  task.complete();

  const completedTask = projectCompletedTask({
    taskId,
    taskBrief: plan.taskBrief,
    verifiedCompletionCriteria: review.verifiedCompletionCriteria,
    reports,
    summary: synthesis.summary,
    artifactReference,
    stateHistory: Object.freeze([...journal.taskStateHistory(forumPostId), "completed" as const]),
  });
  journal.recordCompletedTask(forumPostId, completedTask);
  return completedTask;
}

async function executeDependencyWaves(input: {
  readonly task: Task;
  readonly taskId: string;
  readonly forumPostId: string;
  readonly workOrders: readonly PlannedWorkOrder[];
  readonly completedWorkOrders: Map<string, JournaledWorkOrderResult>;
  readonly dependencies: OpenDelegateDependencies;
  readonly journal: OrchestrationJournal;
}): Promise<void> {
  const pending = new Set(
    input.workOrders
      .filter((workOrder) => !input.completedWorkOrders.has(workOrder.workOrderId))
      .map((workOrder) => workOrder.workOrderId),
  );

  while (pending.size > 0) {
    const ready = input.workOrders.filter(
      (workOrder) =>
        pending.has(workOrder.workOrderId) &&
        workOrder.dependsOn.every((dependencyId) => input.completedWorkOrders.has(dependencyId)),
    );
    if (ready.length === 0) {
      throw new OrchestratorError(
        "COORDINATOR_PLAN_INVALID",
        "No Work Order dependency wave can make progress.",
      );
    }

    const settlements = await Promise.allSettled(
      ready.map(async (workOrder) => {
        const durableDispatch = input.journal.runAssignment(
          input.forumPostId,
          workOrder.workOrderId,
        );
        const dispatch =
          durableDispatch ??
          createDurableDispatch({
            taskId: input.taskId,
            forumPostId: input.forumPostId,
            workOrder,
            completedWorkOrderIds: [...input.completedWorkOrders.keys()],
            dependencies: input.dependencies,
            journal: input.journal,
          });
        let run: RunAssignment;
        try {
          run = assertRunAssignment(
            dispatch.assignment,
            {
              taskId: input.taskId,
              workOrderId: workOrder.workOrderId,
              deviceId: dispatch.assignment.deviceId,
              workerId: dispatch.assignment.workerId,
              routeId: dispatch.assignment.routeId,
            },
            input.dependencies,
          );
        } catch (error: unknown) {
          if (error instanceof ExpiredRunAssignmentError) {
            recordRunFailedIfCurrent(
              input.journal,
              input.forumPostId,
              workOrder.workOrderId,
              dispatch.assignment.runId,
            );
          }
          throw error;
        }
        const candidates = createSchedulingCandidates(input.taskId, workOrder, input.dependencies);
        const candidate = candidates.find(
          (value) => value.deviceId === run.deviceId && value.workerId === run.workerId,
        );
        if (candidate === undefined) {
          recordRunFailedIfCurrent(
            input.journal,
            input.forumPostId,
            workOrder.workOrderId,
            run.runId,
          );
          throw new OrchestratorError(
            "WORKER_UNAVAILABLE",
            `Durable Run ${run.runId} no longer has its assigned Device-specific Worker.`,
          );
        }
        try {
          assertSelectedCandidateEligible(workOrder, candidate, run.routeId);
        } catch (error: unknown) {
          if (error instanceof OrchestratorError && error.code === "SCHEDULING_SELECTION_INVALID") {
            recordRunFailedIfCurrent(
              input.journal,
              input.forumPostId,
              workOrder.workOrderId,
              run.runId,
            );
          }
          throw error;
        }
        const worker = input.dependencies.workers.find(
          (value) => value.workerId === run.workerId && value.deviceId === run.deviceId,
        );
        if (worker === undefined) {
          recordRunFailedIfCurrent(
            input.journal,
            input.forumPostId,
            workOrder.workOrderId,
            run.runId,
          );
          throw new OrchestratorError(
            "WORKER_UNAVAILABLE",
            `Run ${run.runId} cannot resolve its assigned Device-specific Worker.`,
          );
        }
        let result: WorkerExecutionResult;
        try {
          result = assertWorkerCompletion(
            await worker.execute({
              taskId: input.taskId,
              workOrder,
              run,
            }),
            run,
            input.dependencies,
            input.journal,
            input.forumPostId,
          );
        } catch (error: unknown) {
          recordRunFailedIfCurrent(
            input.journal,
            input.forumPostId,
            workOrder.workOrderId,
            run.runId,
          );
          throw error;
        }
        const report = parseWorkerReport({
          workOrderId: result.workOrderId,
          workerId: result.workerId,
          report: result.report,
        });
        const completedResult = deepFreeze({
          taskId: result.taskId,
          workOrderId: result.workOrderId,
          deviceId: result.deviceId,
          workerId: result.workerId,
          routeId: result.routeId,
          runId: result.runId,
          leaseId: result.leaseId,
          fencingToken: result.fencingToken,
          planFingerprint: fingerprintPlannedWorkOrder(workOrder),
          report,
        } satisfies JournaledWorkOrderResult);
        input.journal.recordWorkOrderResult(input.forumPostId, completedResult);
        input.completedWorkOrders.set(workOrder.workOrderId, completedResult);
        input.task.recordWorkOrderSucceeded({
          id: WorkOrderId.from(workOrder.workOrderId),
          runId: RunId.from(result.runId),
          fencingToken: result.fencingToken,
        });
        pending.delete(workOrder.workOrderId);
      }),
    );

    const failed = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    );
    if (failed !== undefined) {
      throw failed.reason;
    }
  }
}

function createDurableDispatch(input: {
  readonly taskId: string;
  readonly forumPostId: string;
  readonly workOrder: PlannedWorkOrder;
  readonly completedWorkOrderIds: readonly string[];
  readonly dependencies: OpenDelegateDependencies;
  readonly journal: OrchestrationJournal;
}) {
  const candidates = createSchedulingCandidates(input.taskId, input.workOrder, input.dependencies);
  const selection = input.dependencies.scheduler.select(
    deepFreeze({
      taskId: input.taskId,
      workOrder: input.workOrder,
      candidates,
      completedWorkOrderIds: Object.freeze([...input.completedWorkOrderIds].sort()),
    }),
  );
  const selected = candidates.find(
    (candidate) =>
      candidate.deviceId === selection.deviceId && candidate.workerId === selection.workerId,
  );
  if (selected === undefined) {
    throw new OrchestratorError(
      "SCHEDULING_SELECTION_INVALID",
      `The scheduler selected an unknown Device-specific Worker for Work Order ${input.workOrder.workOrderId}.`,
    );
  }
  assertSelectedCandidateEligible(input.workOrder, selected, selection.routeId);

  const assignment = assertRunAssignment(
    input.dependencies.runAssignments.nextRun({
      taskId: input.taskId,
      workOrderId: input.workOrder.workOrderId,
      deviceId: selection.deviceId,
      workerId: selection.workerId,
      routeId: selection.routeId,
    }),
    {
      taskId: input.taskId,
      workOrderId: input.workOrder.workOrderId,
      deviceId: selection.deviceId,
      workerId: selection.workerId,
      routeId: selection.routeId,
    },
    input.dependencies,
  );
  const dispatch = deepFreeze({
    workOrderId: input.workOrder.workOrderId,
    planFingerprint: fingerprintPlannedWorkOrder(input.workOrder),
    assignment,
  });
  input.journal.recordRunAssignment(input.forumPostId, dispatch);
  return dispatch;
}

function createSchedulingCandidates(
  taskId: string,
  workOrder: PlannedWorkOrder,
  dependencies: OpenDelegateDependencies,
): readonly WorkOrderSchedulingCandidate[] {
  const candidates = dependencies.workers.map((worker) => {
    assertWorkerSchedulingSnapshot(worker);
    const device = deepFreeze({
      deviceId: worker.deviceId,
      workerId: worker.workerId,
      ...worker.scheduling,
    });
    const executionPolicyDecision = dependencies.dispatchPolicy.evaluate({
      taskId,
      workOrder,
      device,
    });
    if (
      (executionPolicyDecision.outcome !== "allow" &&
        executionPolicyDecision.outcome !== "require-approval" &&
        executionPolicyDecision.outcome !== "deny") ||
      executionPolicyDecision.code.trim() === ""
    ) {
      throw new OrchestratorError(
        "SCHEDULING_SELECTION_INVALID",
        `Dispatch Policy returned an invalid decision for Device ${worker.deviceId}.`,
      );
    }
    return deepFreeze({
      ...device,
      executionPolicyDecision,
    });
  });
  const workerIds = new Set(candidates.map((candidate) => candidate.workerId));
  const deviceIds = new Set(candidates.map((candidate) => candidate.deviceId));
  if (workerIds.size !== candidates.length || deviceIds.size !== candidates.length) {
    throw new OrchestratorError(
      "WORKER_UNAVAILABLE",
      "Worker and Device identifiers must be unique across the dispatch fleet.",
    );
  }
  return Object.freeze(candidates);
}

function assertSelectedCandidateEligible(
  workOrder: PlannedWorkOrder,
  candidate: WorkOrderSchedulingCandidate,
  routeId: string,
): void {
  const verifiedCapabilities = new Set(
    candidate.capabilities
      .filter((capability) => capability.verification === "verified")
      .map((capability) => capability.name),
  );
  const route = candidate.routes.find(
    (candidateRoute) => candidateRoute.routeId === routeId && candidateRoute.health === "healthy",
  );
  const eligible =
    candidate.enabled &&
    candidate.status === "online" &&
    !candidate.draining &&
    candidate.executionPolicyDecision.outcome === "allow" &&
    (workOrder.requiredOsFamily === undefined ||
      candidate.osFamily === workOrder.requiredOsFamily) &&
    workOrder.requiredCapabilities.every((capability) => verifiedCapabilities.has(capability)) &&
    workOrder.requiredSecretRefs.every((secretRef) =>
      candidate.availableSecretRefs.includes(secretRef),
    ) &&
    (workOrder.workspaceId === undefined ||
      candidate.workspaceIds.includes(workOrder.workspaceId)) &&
    Number.isSafeInteger(candidate.availableRunSlots) &&
    candidate.availableRunSlots > 0 &&
    Number.isFinite(candidate.loadRatio) &&
    candidate.loadRatio >= 0 &&
    candidate.loadRatio <= 1 &&
    route !== undefined &&
    (!workOrder.requiredCapabilities.includes("computer-use") || candidate.desktopSessionAvailable);
  if (!eligible) {
    throw new OrchestratorError(
      "SCHEDULING_SELECTION_INVALID",
      `The scheduler selected ineligible Device ${candidate.deviceId} for Work Order ${workOrder.workOrderId}.`,
    );
  }
}

function assertWorkerSchedulingSnapshot(worker: OpenDelegateDependencies["workers"][number]): void {
  const snapshot = worker.scheduling;
  const validCapabilityStates = new Set([
    "detected",
    "verified",
    "degraded",
    "unavailable",
    "disabled",
  ]);
  const identifiers = [
    worker.workerId,
    worker.deviceId,
    ...snapshot.capabilities.map((capability) => capability.name),
    ...snapshot.roles,
    ...snapshot.workspaceIds,
    ...snapshot.routes.map((route) => route.routeId),
    ...snapshot.availableSecretRefs,
  ];
  const uniqueLists = [
    snapshot.capabilities.map((capability) => capability.name),
    snapshot.roles,
    snapshot.workspaceIds,
    snapshot.routes.map((route) => route.routeId),
    snapshot.availableSecretRefs,
  ];
  const valid =
    identifiers.every((identifier) => identifier.trim() !== "") &&
    uniqueLists.every((values) => new Set(values).size === values.length) &&
    (snapshot.status === "online" || snapshot.status === "offline") &&
    (snapshot.osFamily === "macos" ||
      snapshot.osFamily === "windows" ||
      snapshot.osFamily === "linux") &&
    snapshot.capabilities.every((capability) =>
      validCapabilityStates.has(capability.verification),
    ) &&
    snapshot.routes.every(
      (route) =>
        Number.isSafeInteger(route.priority) &&
        route.priority >= 0 &&
        (route.health === "healthy" || route.health === "unhealthy"),
    ) &&
    Number.isSafeInteger(snapshot.availableRunSlots) &&
    snapshot.availableRunSlots >= 0 &&
    Number.isFinite(snapshot.loadRatio) &&
    snapshot.loadRatio >= 0 &&
    snapshot.loadRatio <= 1;
  if (!valid) {
    throw new OrchestratorError(
      "SCHEDULING_SELECTION_INVALID",
      `Worker ${worker.workerId} exposed an invalid or ambiguous scheduling snapshot.`,
    );
  }
}

async function publishArtifactResult(input: {
  readonly taskId: string;
  readonly forumPostId: string;
  readonly synthesis: {
    readonly artifact: {
      readonly filename: string;
      readonly mediaType: string;
      readonly content: string;
    };
  };
  readonly dependencies: OpenDelegateDependencies;
  readonly journal: OrchestrationJournal;
}): Promise<ArtifactReference> {
  const contentFingerprint = fingerprintArtifactContent(input.synthesis.artifact);
  const cachedArtifact = input.journal.artifactResult(input.forumPostId);
  if (cachedArtifact !== undefined) {
    if (cachedArtifact.contentFingerprint !== contentFingerprint) {
      throw new OrchestratorError(
        "ARTIFACT_ID_CONFLICT",
        `The result Artifact for Task ${input.taskId} changed after it was published.`,
      );
    }
    return cachedArtifact.reference;
  }

  const artifactReference = parseArtifactReference(
    await input.dependencies.artifacts.publish({
      taskId: input.taskId,
      idempotencyKey: artifactPublicationKey(input.taskId),
      ...input.synthesis.artifact,
    }),
  );
  input.journal.recordArtifactResult(input.forumPostId, {
    contentFingerprint,
    reference: artifactReference,
  });
  return artifactReference;
}

function resolveTaskIntake(
  authorizedForumPost: AuthorizedForumPost,
  dependencies: OpenDelegateDependencies,
  journal: OrchestrationJournal,
): JournaledTaskIntake {
  const existing = journal.taskIntake(authorizedForumPost.postId);
  if (existing !== undefined) {
    if (JSON.stringify(existing.forumPost) !== JSON.stringify(authorizedForumPost)) {
      throw new OrchestratorError(
        "FORUM_POST_CONFLICT",
        `Forum post ${authorizedForumPost.postId} was redelivered with conflicting intake content or authority.`,
      );
    }
    return existing;
  }

  const taskId = dependencies.ids.nextTaskId();
  if (taskId === undefined || taskId.trim() === "") {
    throw new OrchestratorError(
      "TASK_ID_UNAVAILABLE",
      "The Task ID source did not provide an identifier.",
    );
  }
  const intake = deepFreeze({
    taskId,
    forumPost: authorizedForumPost,
  } satisfies JournaledTaskIntake);
  journal.bindTask(authorizedForumPost.postId, intake);
  return intake;
}

async function authorizeForumPost(
  input: ForumPostInput,
  dependencies: OpenDelegateDependencies,
): Promise<AuthorizedForumPost> {
  const authorization = await dependencies.authorizer.authorizeForumPost({
    forumId: input.forumId,
    postId: input.postId,
    authorId: input.authorId,
  });
  if (authorization.decision !== "allow") {
    throw new OrchestratorError(
      "FORUM_AUTHOR_UNAUTHORIZED",
      "The Discord author is not authorized to create a Task in this Forum.",
    );
  }

  return parseAuthorizedForumPost({
    ...input,
    authorizedPrincipalId: authorization.principalId,
  });
}

function validateCachedWorkOrders(
  workOrders: readonly PlannedWorkOrder[],
  cachedResults: readonly JournaledWorkOrderResult[],
): Map<string, JournaledWorkOrderResult> {
  const byId = new Map(workOrders.map((workOrder) => [workOrder.workOrderId, workOrder] as const));
  const completed = new Map<string, JournaledWorkOrderResult>();

  for (const cached of cachedResults) {
    const workOrder = byId.get(cached.workOrderId);
    if (
      workOrder === undefined ||
      cached.planFingerprint !== fingerprintPlannedWorkOrder(workOrder)
    ) {
      throw new OrchestratorError(
        "WORK_ORDER_ID_CONFLICT",
        `Work Order ID ${cached.workOrderId} was reused with different execution content.`,
      );
    }
    completed.set(cached.workOrderId, cached);
  }
  for (const cachedWorkOrderId of completed.keys()) {
    const workOrder = byId.get(cachedWorkOrderId);
    if (
      workOrder === undefined ||
      !workOrder.dependsOn.every((dependencyId) => completed.has(dependencyId))
    ) {
      throw new OrchestratorError(
        "WORK_ORDER_ID_CONFLICT",
        `Cached Work Order ${cachedWorkOrderId} is missing a durable dependency result.`,
      );
    }
  }
  return completed;
}

function projectWaitingTask(
  journal: OrchestrationJournal,
  intake: JournaledTaskIntake,
): WaitingUserTaskView {
  const clarification = journal.clarification(intake.forumPost.postId);
  if (clarification === undefined || clarification.answer !== undefined) {
    throw new OrchestratorError(
      "CLARIFICATION_NOT_FOUND",
      `Task ${intake.taskId} has no pending clarification.`,
    );
  }

  return deepFreeze({
    taskId: intake.taskId,
    state: "waiting_user",
    stateHistory: journal.taskStateHistory(intake.forumPost.postId),
    clarification: clarification.request,
    workOrders: [],
    resultProjection: {
      kind: "discord-question",
      statusTag: "Waiting",
      content: clarification.request.question,
      actions: [],
    },
    artifactRefs: [],
  });
}

function artifactPublicationKey(taskId: string): string {
  return `${taskId}:result-artifact`;
}

class ExpiredRunAssignmentError extends OrchestratorError {
  public constructor(workOrderId: string) {
    super(
      "RUN_ASSIGNMENT_INVALID",
      `Run assignment for Work Order ${workOrderId} is expired and must be retired.`,
    );
    this.name = "ExpiredRunAssignmentError";
  }
}

function assertRunAssignment(
  value: RunAssignment,
  target: Pick<RunAssignment, "taskId" | "workOrderId" | "deviceId" | "workerId" | "routeId">,
  dependencies: OpenDelegateDependencies,
): RunAssignment {
  const run = parseRunAssignment(value);
  if (
    run.taskId !== target.taskId ||
    run.workOrderId !== target.workOrderId ||
    run.deviceId !== target.deviceId ||
    run.workerId !== target.workerId ||
    run.routeId !== target.routeId
  ) {
    throw new OrchestratorError(
      "RUN_ASSIGNMENT_INVALID",
      `Run assignment for Work Order ${target.workOrderId} is invalid or incorrectly scoped.`,
    );
  }
  const now = parseRfc3339Instant(dependencies.clock.now(), "orchestration clock").epochMs;
  const expiresAt = parseRfc3339Instant(run.expiresAt, "expiresAt").epochMs;
  if (expiresAt <= now) {
    throw new ExpiredRunAssignmentError(target.workOrderId);
  }
  return run;
}

function assertWorkerCompletion(
  value: unknown,
  expectedRun: RunAssignment,
  dependencies: OpenDelegateDependencies,
  journal: OrchestrationJournal,
  forumPostId: string,
): WorkerExecutionResult {
  const completion = parseWorkerExecutionResult(value);
  const currentRun = journal.runAssignment(forumPostId, expectedRun.workOrderId)?.assignment;
  const now = parseRfc3339Instant(dependencies.clock.now(), "orchestration clock").epochMs;
  const expiresAt =
    currentRun === undefined
      ? Number.NEGATIVE_INFINITY
      : parseRfc3339Instant(currentRun.expiresAt, "expiresAt").epochMs;

  if (
    currentRun === undefined ||
    !sameRunAssignment(currentRun, expectedRun) ||
    !runCompletionMatchesAssignment(completion, expectedRun) ||
    expiresAt <= now
  ) {
    throw new OrchestratorError(
      "RUN_COMPLETION_STALE",
      `Worker completion for Run ${completion.runId} is expired, replaced, or incorrectly scoped.`,
    );
  }
  return completion;
}

function recordRunFailedIfCurrent(
  journal: OrchestrationJournal,
  forumPostId: string,
  workOrderId: string,
  runId: string,
): void {
  const currentRun = journal.runAssignment(forumPostId, workOrderId)?.assignment;
  if (currentRun?.runId === runId) {
    journal.recordRunFailed(forumPostId, workOrderId, runId);
  }
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

function sameRunAssignment(left: RunAssignment, right: RunAssignment): boolean {
  return (
    runCompletionMatchesAssignment(left, right) &&
    left.idempotencyKey === right.idempotencyKey &&
    left.expiresAt === right.expiresAt
  );
}

function projectCompletedTask(input: {
  readonly taskId: string;
  readonly taskBrief: CompletedTaskView["taskBrief"];
  readonly verifiedCompletionCriteria: readonly string[];
  readonly reports: readonly WorkerReport[];
  readonly summary: string;
  readonly artifactReference: ArtifactReference;
  readonly stateHistory: CompletedTaskView["stateHistory"];
}): CompletedTaskView {
  const workOrders: readonly WorkOrderView[] = input.reports.map((report) => ({
    ...report,
    state: "succeeded",
  }));

  return deepFreeze({
    taskId: input.taskId,
    state: "completed",
    stateHistory: input.stateHistory,
    taskBrief: input.taskBrief,
    verifiedCompletionCriteria: input.verifiedCompletionCriteria,
    workOrders,
    resultProjection: {
      kind: "discord-result",
      statusTag: "Done",
      content: input.summary,
      actions: [
        {
          type: "link",
          label: "Open report",
          href: input.artifactReference.href,
        },
      ],
    },
    artifactRefs: [input.artifactReference],
  });
}

function assertClarificationAnswerInput(input: ClarificationAnswerInput): void {
  if (
    [input.postId, input.clarificationId, input.authorId, input.answer].some(
      (value) => value.trim() === "",
    )
  ) {
    throw new OrchestratorError(
      "CLARIFICATION_ANSWER_INVALID",
      "A clarification answer requires non-blank post, clarification, author, and answer values.",
    );
  }
}

interface ActiveExecution {
  readonly kind: "accept" | "answer";
  readonly fingerprint: string;
  readonly promise: Promise<TaskView>;
}

async function runExclusive<TView extends TaskView>(
  activeExecutions: Map<string, ActiveExecution>,
  forumPostId: string,
  identity: Pick<ActiveExecution, "kind" | "fingerprint">,
  operation: () => Promise<TView>,
): Promise<TView> {
  const existing = activeExecutions.get(forumPostId);
  if (existing !== undefined) {
    if (existing.kind === identity.kind) {
      if (existing.fingerprint !== identity.fingerprint) {
        throw new OrchestratorError(
          identity.kind === "accept" ? "FORUM_POST_CONFLICT" : "CLARIFICATION_ANSWER_CONFLICT",
          `Forum post ${forumPostId} already has a conflicting in-flight ${identity.kind} operation.`,
        );
      }
      return existing.promise as Promise<TView>;
    }

    await existing.promise;
    return runExclusive(activeExecutions, forumPostId, identity, operation);
  }

  const execution = operation();
  const active = {
    ...identity,
    promise: execution,
  };
  activeExecutions.set(forumPostId, active);
  try {
    return await execution;
  } finally {
    if (activeExecutions.get(forumPostId) === active) {
      activeExecutions.delete(forumPostId);
    }
  }
}
