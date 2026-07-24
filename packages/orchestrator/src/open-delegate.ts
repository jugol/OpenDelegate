import { ArtifactId, RunId, Task, TaskId, WorkOrderId } from "@opendelegate/domain";

import { publishArtifactResult } from "./artifact-publication.ts";
import {
  deepFreeze,
  parseAuthorizedForumPost,
  parseCoordinatorIntakeDecision,
  parseCoordinatorPlan,
  parseCoordinatorReview,
  parseCoordinatorSynthesis,
  parseRfc3339Instant,
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
  WorkerExecutionResult,
  WorkerReport,
  WorkerRunCompletion,
  WorkOrderView,
} from "./contracts.ts";
import { recordRunFailedIfCurrent, resolveDeviceDispatch } from "./device-dispatch.ts";
import {
  InMemoryOrchestrationJournal,
  type JournaledTaskIntake,
  type JournaledWorkOrderResult,
  type OrchestrationJournal,
} from "./orchestration-journal.ts";
import { OrchestratorError } from "./orchestrator-error.ts";

export function createOpenDelegate(dependencies: OpenDelegateDependencies): OpenDelegate {
  const activeExecutions = new Map<string, ActiveExecution>();
  const activeBindings = new Map<string, ActiveExecution>();
  const journal =
    dependencies.journal ??
    new InMemoryOrchestrationJournal({
      clock: dependencies.clock,
    });

  return {
    async acceptForumPost(input) {
      const authorizedForumPost = await authorizeForumPost(input, dependencies);
      const persistedTaskId = journal.taskIdFor(input.postId);
      const persistedIntake =
        persistedTaskId === undefined ? undefined : journal.taskIntake(persistedTaskId);
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
        activeBindings,
        input.postId,
        {
          kind: "accept",
          fingerprint: JSON.stringify(authorizedForumPost),
        },
        async () => {
          const intake = resolveTaskIntake(authorizedForumPost, dependencies, journal);
          return runExclusive(
            activeExecutions,
            intake.taskId,
            {
              kind: "accept",
              fingerprint: JSON.stringify(authorizedForumPost),
            },
            async () => {
              const completed = journal.completedTask(intake.taskId);
              if (completed !== undefined) {
                return completed;
              }

              const clarification = journal.clarification(intake.taskId);
              if (clarification !== undefined && clarification.answer === undefined) {
                return projectWaitingTask(journal, intake);
              }

              if (
                journal.plan(intake.taskId) === undefined &&
                !journal.intakeReady(intake.taskId) &&
                clarification === undefined
              ) {
                const decision = parseCoordinatorIntakeDecision(
                  await dependencies.coordinator.assessIntake({
                    taskId: intake.taskId,
                    forumPost: intake.forumPost,
                  }),
                );
                if (decision.decision === "clarification") {
                  journal.recordClarificationRequest(intake.taskId, decision.clarification);
                  return projectWaitingTask(journal, intake);
                }
                journal.recordIntakeReady(intake.taskId);
              }

              return executeTask(intake, dependencies, journal);
            },
          );
        },
      );
    },

    async answerClarification(input) {
      assertClarificationAnswerInput(input);
      const taskId = journal.taskIdFor(input.postId);
      const intake = taskId === undefined ? undefined : journal.taskIntake(taskId);
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

      const durableClarification = journal.clarification(intake.taskId);
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
        intake.taskId,
        {
          kind: "answer",
          fingerprint: JSON.stringify({
            clarificationId: input.clarificationId,
            answer: input.answer,
          }),
        },
        async () => {
          const currentIntake = journal.taskIntake(intake.taskId);
          const clarification = journal.clarification(intake.taskId);
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
          journal.recordClarificationAnswer(intake.taskId, exchange);

          const completed = journal.completedTask(intake.taskId);
          if (completed !== undefined) {
            return completed;
          }
          return executeTask(currentIntake, dependencies, journal);
        },
      );
    },

    getTaskByForumPost(postId) {
      const taskId = journal.taskIdFor(postId);
      if (taskId === undefined) {
        throw new OrchestratorError(
          "TASK_NOT_FOUND",
          `No presentable Task view is bound to Forum post ${postId}.`,
        );
      }
      const completed = journal.completedTask(taskId);
      if (completed !== undefined) {
        return completed;
      }

      const intake = journal.taskIntake(taskId);
      const clarification = journal.clarification(taskId);
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
  const existingPlan = journal.plan(taskId);
  const clarification = journal.clarification(taskId)?.answer;
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
    journal.recordPlan(taskId, plan);
  }

  const task = Task.create({
    id: TaskId.from(taskId),
    brief: plan.taskBrief,
    completionRequirements: {
      minimumArtifactResults: 1,
    },
  });
  if (journal.clarification(taskId) !== undefined) {
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
    journal.workOrderResults(taskId),
  );
  for (const completedWorkOrder of completedWorkOrders.values()) {
    const assignment = journal.runAssignment(taskId, completedWorkOrder.workOrderId)?.assignment;
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

  const cachedSynthesis = journal.synthesis(taskId);
  const synthesis =
    cachedSynthesis ??
    parseCoordinatorSynthesis(
      await dependencies.coordinator.synthesize({
        taskId,
        reports,
      }),
    );
  if (cachedSynthesis === undefined) {
    journal.recordSynthesis(taskId, synthesis);
  }
  const artifactReference = await publishArtifactResult({
    taskId,
    artifact: synthesis.artifact,
    artifacts: dependencies.artifacts,
    journal,
  });

  task.recordArtifactResult(ArtifactId.from(artifactReference.artifactId));
  task.transitionTo("review");
  journal.recordReviewStarted(taskId);

  const cachedReview = journal.review(taskId);
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
    journal.recordReview(taskId, review);
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
    stateHistory: Object.freeze([...journal.taskStateHistory(taskId), "completed" as const]),
  });
  journal.recordCompletedTask(taskId, completedTask);
  return completedTask;
}

async function executeDependencyWaves(input: {
  readonly task: Task;
  readonly taskId: string;
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
        const { run, worker } = await resolveDeviceDispatch({
          taskId: input.taskId,
          workOrder,
          dependencies: input.dependencies,
          journal: input.journal,
        });
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
            input.taskId,
          );
        } catch (error: unknown) {
          recordRunFailedIfCurrent(input.journal, input.taskId, workOrder.workOrderId, run.runId);
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
          report,
        } satisfies JournaledWorkOrderResult);
        input.journal.recordWorkOrderResult(input.taskId, completedResult);
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

function resolveTaskIntake(
  authorizedForumPost: AuthorizedForumPost,
  dependencies: OpenDelegateDependencies,
  journal: OrchestrationJournal,
): JournaledTaskIntake {
  const existingTaskId = journal.taskIdFor(authorizedForumPost.postId);
  const existing = existingTaskId === undefined ? undefined : journal.taskIntake(existingTaskId);
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
    if (workOrder === undefined) {
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
  const clarification = journal.clarification(intake.taskId);
  if (clarification === undefined || clarification.answer !== undefined) {
    throw new OrchestratorError(
      "CLARIFICATION_NOT_FOUND",
      `Task ${intake.taskId} has no pending clarification.`,
    );
  }

  return deepFreeze({
    taskId: intake.taskId,
    state: "waiting_user",
    stateHistory: journal.taskStateHistory(intake.taskId),
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

function assertWorkerCompletion(
  value: unknown,
  expectedRun: RunAssignment,
  dependencies: OpenDelegateDependencies,
  journal: OrchestrationJournal,
  taskId: string,
): WorkerExecutionResult {
  const completion = parseWorkerExecutionResult(value);
  const currentRun = journal.runAssignment(taskId, expectedRun.workOrderId)?.assignment;
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
  executionKey: string,
  identity: Pick<ActiveExecution, "kind" | "fingerprint">,
  operation: () => Promise<TView>,
): Promise<TView> {
  const existing = activeExecutions.get(executionKey);
  if (existing !== undefined) {
    if (existing.kind === identity.kind) {
      if (existing.fingerprint !== identity.fingerprint) {
        throw new OrchestratorError(
          identity.kind === "accept" ? "FORUM_POST_CONFLICT" : "CLARIFICATION_ANSWER_CONFLICT",
          `Task operation ${executionKey} already has a conflicting in-flight ${identity.kind} operation.`,
        );
      }
      return existing.promise as Promise<TView>;
    }

    await existing.promise;
    return runExclusive(activeExecutions, executionKey, identity, operation);
  }

  const execution = operation();
  const active = {
    ...identity,
    promise: execution,
  };
  activeExecutions.set(executionKey, active);
  try {
    return await execution;
  } finally {
    if (activeExecutions.get(executionKey) === active) {
      activeExecutions.delete(executionKey);
    }
  }
}
