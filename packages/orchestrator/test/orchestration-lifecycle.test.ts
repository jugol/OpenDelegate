import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenDelegate,
  InMemoryOrchestrationJournal,
  OrchestratorError,
  type ArtifactGateway,
  type ChannelAuthorizer,
  type CompletedTaskView,
  type Coordinator,
  type CoordinatorIntakeDecision,
  type CoordinatorPlan,
  type CoordinatorReview,
  type JournaledRunAssignment,
  type OrchestrationIdSource,
  type PlannedWorkOrder,
  type RunAssignment,
  type RunAssignmentSource,
  type RunAssignmentTarget,
  type Worker,
  type WorkerDeviceSnapshot,
  type WorkerExecutionInput,
} from "../src/index.ts";

const ambiguousForumPost = {
  forumId: "forum-owner-work",
  postId: "post-ambiguous-target",
  authorId: "discord-owner",
  title: "Prepare the release",
  body: "Prepare the release for the target environment.",
} as const;

const fullTaskBrief = {
  objective: "Prepare and verify the desktop release.",
  completionCriteria: [
    "Produce a verified release report.",
    "Publish an openable result Artifact.",
  ],
  constraints: ["Do not publish outside the private test route."],
  knownInputIds: ["forum-post:post-ambiguous-target"],
  decisions: ["Target the staging environment."],
  openQuestions: [],
} as const;

const richWorkOrder = {
  workOrderId: "work-order-release-check",
  title: "Verify the desktop release",
  brief: "Run the staging release checks and return observable evidence.",
  completionCriteria: ["Return a verified release result."],
  constraints: ["Use only the registered staging Workspace."],
  selectedInputIds: ["forum-post:post-ambiguous-target"],
  dependsOn: [],
  schedulingHints: {
    preferredDeviceIds: ["device-desktop"],
    preferredRoles: ["release-verification"],
  },
  requiredCapabilities: ["release-check"],
  requiredSecretRefs: ["secret:staging-read-only"],
  requiredOsFamily: "windows",
  workspaceId: "workspace-release",
} as const;

class FixedClock {
  public now(): string {
    return "2026-07-24T00:00:00.000Z";
  }
}

class MutableRuntimeClock {
  public value = "2026-07-24T00:00:00.000Z";

  public now(): string {
    return this.value;
  }
}

const allowDispatchPolicy = {
  evaluate() {
    return { outcome: "allow", code: "test-dispatch-allowed" } as const;
  },
} as const;

const dispatchDependencies = {
  clock: new FixedClock(),
  dispatchPolicy: allowDispatchPolicy,
} as const;

function workerScheduling(capabilities: readonly string[]): WorkerDeviceSnapshot {
  return {
    enabled: true,
    status: "online",
    draining: false,
    osFamily: "windows",
    capabilities: capabilities.map((name) => ({ name, verification: "verified" })),
    roles: ["release-verification"],
    workspaceIds: ["workspace-release"],
    routes: [{ routeId: "route-desktop", priority: 1, health: "healthy" }],
    availableRunSlots: 4,
    loadRatio: 0,
    desktopSessionAvailable: true,
    availableSecretRefs: ["secret:staging-read-only"],
  };
}

class AllowOwner implements ChannelAuthorizer {
  public async authorizeForumPost() {
    return {
      decision: "allow",
      principalId: "owner-primary",
    } as const;
  }
}

class CountingIds implements OrchestrationIdSource {
  public calls = 0;

  public nextTaskId(): string {
    this.calls += 1;
    return "task-ambiguous-target";
  }
}

class FailingIds implements OrchestrationIdSource {
  public nextTaskId(): never {
    throw new Error("A restored clarification must keep the original Task ID.");
  }
}

class SequentialRuns implements RunAssignmentSource {
  private sequence = 0;

  public nextRun(input: RunAssignmentTarget): RunAssignment {
    this.sequence += 1;
    return {
      ...input,
      runId: `run-${String(this.sequence)}`,
      idempotencyKey: `run-${String(this.sequence)}`,
      leaseId: `lease-${String(this.sequence)}`,
      fencingToken: this.sequence,
      expiresAt: "2026-07-24T01:00:00.000Z",
    };
  }
}

class ClarifyingCoordinator implements Coordinator {
  public assessmentCalls = 0;
  public planCalls = 0;
  public reviewCalls = 0;
  public lastPlanInput: unknown;
  public lastReviewInput: unknown;

  public async assessIntake(): Promise<CoordinatorIntakeDecision> {
    this.assessmentCalls += 1;
    return {
      decision: "clarification",
      clarification: {
        clarificationId: "clarification-target-environment",
        question: "Which environment should the release target?",
      },
    } as const;
  }

  public async plan(input: unknown): Promise<CoordinatorPlan> {
    this.planCalls += 1;
    this.lastPlanInput = input;
    return {
      taskBrief: fullTaskBrief,
      workOrders: [richWorkOrder],
    };
  }

  public async selectDevice(input: {
    readonly taskId: string;
    readonly workOrder: { readonly workOrderId: string };
    readonly eligibleDevices: readonly { readonly deviceId: string }[];
  }) {
    const preferredDevice = input.eligibleDevices[0];
    assert.ok(preferredDevice);
    return {
      protocolVersion: "v1",
      taskId: input.taskId,
      workOrderId: input.workOrder.workOrderId,
      preferredDeviceId: preferredDevice.deviceId,
    } as const;
  }

  public async synthesize() {
    return {
      summary: "The staging release passed.",
      artifact: {
        filename: "release.html",
        mediaType: "text/html",
        content: "<p>Staging release passed.</p>",
      },
    };
  }

  public async review(input: unknown): Promise<CoordinatorReview> {
    this.reviewCalls += 1;
    this.lastReviewInput = input;
    return {
      decision: "complete",
      verifiedCompletionCriteria: fullTaskBrief.completionCriteria,
    } as const;
  }
}

class RecordingWorker implements Worker {
  public readonly deviceId = "device-desktop";
  public readonly workerId = "worker-desktop";
  public readonly scheduling = workerScheduling(["release-check"]);
  public readonly calls: WorkerExecutionInput[] = [];

  public async execute(input: WorkerExecutionInput) {
    this.calls.push(input);
    return {
      taskId: input.run.taskId,
      workOrderId: input.run.workOrderId,
      deviceId: input.run.deviceId,
      workerId: input.run.workerId,
      routeId: input.run.routeId,
      runId: input.run.runId,
      leaseId: input.run.leaseId,
      fencingToken: input.run.fencingToken,
      report: "The staging release passed.",
    };
  }
}

const artifacts: ArtifactGateway = {
  async publish() {
    return {
      artifactId: "artifact-release",
      href: "https://artifacts.example.test/release",
    };
  },
};

function createDeferred<TValue>() {
  let resolvePromise: (value: TValue | PromiseLike<TValue>) => void = () => {};
  const promise = new Promise<TValue>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

test("a clarification reply resumes the same durable Task after runtime recreation", async () => {
  const firstJournal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
  });
  const ids = new CountingIds();
  const coordinator = new ClarifyingCoordinator();
  const worker = new RecordingWorker();
  const firstRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids,
    runAssignments: new SequentialRuns(),
    journal: firstJournal,
  });

  const waiting = await firstRuntime.acceptForumPost(ambiguousForumPost);

  assert.equal(waiting.taskId, "task-ambiguous-target");
  assert.equal(waiting.state, "waiting_user");
  assert.deepEqual(waiting.clarification, {
    clarificationId: "clarification-target-environment",
    question: "Which environment should the release target?",
  });
  assert.deepEqual(waiting.stateHistory, ["intake", "waiting_user"]);
  assert.equal(ids.calls, 1);
  assert.equal(coordinator.assessmentCalls, 1);
  assert.equal(coordinator.planCalls, 0);
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(await firstRuntime.getTaskByForumPost(ambiguousForumPost.postId), waiting);

  const restoredJournal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
    recordedEvents: await firstJournal.recordedEvents(),
  });
  const replyAuthorizationInputs: unknown[] = [];
  const unauthorizedRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: {
      async authorizeForumPost(input) {
        replyAuthorizationInputs.push(input);
        return {
          decision: "deny",
          reason: "The reply author is not the owner.",
        } as const;
      },
    },
    coordinator,
    workers: [worker],
    artifacts,
    ids: new FailingIds(),
    runAssignments: new SequentialRuns(),
    journal: restoredJournal,
  });
  await assert.rejects(
    unauthorizedRuntime.answerClarification({
      postId: ambiguousForumPost.postId,
      clarificationId: "clarification-target-environment",
      authorId: "discord-intruder",
      answer: "Use production.",
    }),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "FORUM_AUTHOR_UNAUTHORIZED",
  );
  assert.deepEqual(replyAuthorizationInputs, [
    {
      forumId: ambiguousForumPost.forumId,
      postId: ambiguousForumPost.postId,
      authorId: "discord-intruder",
    },
  ]);

  const restoredRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new FailingIds(),
    runAssignments: new SequentialRuns(),
    journal: restoredJournal,
  });

  await assert.rejects(
    restoredRuntime.answerClarification({
      postId: ambiguousForumPost.postId,
      clarificationId: "clarification-target-environment",
      authorId: "discord-owner",
      answer: "   ",
    }),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "CLARIFICATION_ANSWER_INVALID",
  );
  await assert.rejects(
    restoredRuntime.answerClarification({
      postId: ambiguousForumPost.postId,
      clarificationId: "clarification-other",
      authorId: "discord-owner",
      answer: "Use staging.",
    }),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "CLARIFICATION_NOT_FOUND",
  );

  const completed = await restoredRuntime.answerClarification({
    postId: ambiguousForumPost.postId,
    clarificationId: "clarification-target-environment",
    authorId: "discord-owner",
    answer: "Use the staging environment.",
  });

  assert.equal(completed.taskId, waiting.taskId);
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.taskBrief, fullTaskBrief);
  assert.deepEqual(completed.verifiedCompletionCriteria, fullTaskBrief.completionCriteria);
  assert.deepEqual(completed.stateHistory, [
    "intake",
    "waiting_user",
    "running",
    "review",
    "completed",
  ]);
  assert.equal(coordinator.assessmentCalls, 1);
  assert.equal(coordinator.planCalls, 1);
  assert.equal(coordinator.reviewCalls, 1);
  assert.deepEqual(
    (
      coordinator.lastPlanInput as {
        readonly clarification: {
          readonly clarificationId: string;
          readonly question: string;
          readonly answer: string;
        };
      }
    ).clarification,
    {
      clarificationId: "clarification-target-environment",
      question: "Which environment should the release target?",
      answer: "Use the staging environment.",
    },
  );
  assert.deepEqual(worker.calls[0]?.workOrder, richWorkOrder);
  assert.equal(
    (await restoredJournal.recordedEvents()).filter((event) => event.type === "task.bound").length,
    1,
  );
});

test("completion is rejected unless coordinator review verifies the exact Task Brief criteria", async () => {
  const journal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
  });
  const coordinator = new ClarifyingCoordinator();
  coordinator.assessIntake = async () =>
    ({
      decision: "ready",
    }) as const;
  coordinator.review = async () =>
    ({
      decision: "complete",
      verifiedCompletionCriteria: [fullTaskBrief.completionCriteria[0]],
    }) as const;
  const worker = new RecordingWorker();
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new CountingIds(),
    runAssignments: new SequentialRuns(),
    journal,
  });

  await assert.rejects(
    runtime.acceptForumPost(ambiguousForumPost),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "COORDINATOR_REVIEW_INVALID",
  );

  assert.equal(worker.calls.length, 1);
  assert.equal(
    (await journal.recordedEvents()).some((event) => event.type === "task.review-started"),
    true,
  );
  assert.equal(
    (await journal.recordedEvents()).some((event) => event.type === "task.completed"),
    false,
  );
});

test("an exact review set is normalized to Task Brief order", async () => {
  const coordinator = new ClarifyingCoordinator();
  coordinator.assessIntake = async () =>
    ({
      decision: "ready",
    }) as const;
  coordinator.review = async () => ({
    decision: "complete",
    verifiedCompletionCriteria: [...fullTaskBrief.completionCriteria].reverse(),
  });
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [new RecordingWorker()],
    artifacts,
    ids: new CountingIds(),
    runAssignments: new SequentialRuns(),
  });

  const completed = await runtime.acceptForumPost(ambiguousForumPost);

  assert.equal(completed.state, "completed");
  if (completed.state === "completed") {
    assert.deepEqual(completed.verifiedCompletionCriteria, fullTaskBrief.completionCriteria);
  }
});

test("independent Work Orders run in one wave before their dependent Work Order", async () => {
  const coordinator = new ClarifyingCoordinator();
  coordinator.assessIntake = async () =>
    ({
      decision: "ready",
    }) as const;
  coordinator.plan = async () => ({
    taskBrief: fullTaskBrief,
    workOrders: [
      {
        ...richWorkOrder,
        workOrderId: "work-order-dependent",
        title: "Synthesize prerequisite evidence",
        dependsOn: ["work-order-first", "work-order-second"],
      },
      {
        ...richWorkOrder,
        workOrderId: "work-order-first",
        title: "Collect first prerequisite",
        dependsOn: [],
      },
      {
        ...richWorkOrder,
        workOrderId: "work-order-second",
        title: "Collect second prerequisite",
        dependsOn: [],
      },
    ],
  });
  const executionOrder: string[] = [];
  const worker: Worker = {
    deviceId: "device-desktop",
    workerId: "worker-release",
    scheduling: workerScheduling(["release-check"]),
    async execute(input) {
      executionOrder.push(input.workOrder.workOrderId);
      return {
        taskId: input.run.taskId,
        workOrderId: input.run.workOrderId,
        deviceId: input.run.deviceId,
        workerId: input.run.workerId,
        routeId: input.run.routeId,
        runId: input.run.runId,
        leaseId: input.run.leaseId,
        fencingToken: input.run.fencingToken,
        report: `${input.workOrder.workOrderId} passed.`,
      };
    },
  };
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new CountingIds(),
    runAssignments: new SequentialRuns(),
  });

  const completed = await runtime.acceptForumPost(ambiguousForumPost);

  assert.equal(completed.state, "completed");
  assert.deepEqual(executionOrder, [
    "work-order-first",
    "work-order-second",
    "work-order-dependent",
  ]);
});

test("planning rejects missing, self-referencing, and cyclic Work Order dependencies", async () => {
  const invalidPlans: readonly (readonly PlannedWorkOrder[])[] = [
    [
      {
        ...richWorkOrder,
        dependsOn: ["work-order-missing"],
      },
    ],
    [
      {
        ...richWorkOrder,
        dependsOn: [richWorkOrder.workOrderId],
      },
    ],
    [
      {
        ...richWorkOrder,
        workOrderId: "work-order-a",
        dependsOn: ["work-order-b"],
      },
      {
        ...richWorkOrder,
        workOrderId: "work-order-b",
        dependsOn: ["work-order-a"],
      },
    ],
  ];

  for (const workOrders of invalidPlans) {
    const coordinator = new ClarifyingCoordinator();
    coordinator.assessIntake = async () =>
      ({
        decision: "ready",
      }) as const;
    coordinator.plan = async () => ({
      taskBrief: fullTaskBrief,
      workOrders,
    });
    const worker = new RecordingWorker();
    const runtime = createOpenDelegate({
      ...dispatchDependencies,
      authorizer: new AllowOwner(),
      coordinator,
      workers: [worker],
      artifacts,
      ids: new CountingIds(),
      runAssignments: new SequentialRuns(),
    });

    await assert.rejects(
      runtime.acceptForumPost(ambiguousForumPost),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "COORDINATOR_PLAN_INVALID",
    );
    assert.equal(worker.calls.length, 0);
  }
});

test("conflicting concurrent Forum intake and clarification answers never share an execution", async () => {
  const assessmentStarted = createDeferred<void>();
  const releaseAssessment = createDeferred<void>();
  const coordinator = new ClarifyingCoordinator();
  coordinator.assessIntake = async () => {
    assessmentStarted.resolve();
    await releaseAssessment.promise;
    return {
      decision: "clarification",
      clarification: {
        clarificationId: "clarification-target-environment",
        question: "Which environment should the release target?",
      },
    } as const;
  };
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [new RecordingWorker()],
    artifacts,
    ids: new CountingIds(),
    runAssignments: new SequentialRuns(),
  });

  const firstIntake = runtime.acceptForumPost(ambiguousForumPost);
  await assessmentStarted.promise;
  await assert.rejects(
    runtime.acceptForumPost({
      ...ambiguousForumPost,
      body: "Conflicting content for the same Discord post ID.",
    }),
    (error: unknown) => error instanceof OrchestratorError && error.code === "FORUM_POST_CONFLICT",
  );
  releaseAssessment.resolve();
  const waiting = await firstIntake;
  assert.equal(waiting.state, "waiting_user");

  const planStarted = createDeferred<void>();
  const releasePlan = createDeferred<void>();
  const originalPlan = coordinator.plan.bind(coordinator);
  coordinator.plan = async (input) => {
    planStarted.resolve();
    await releasePlan.promise;
    return originalPlan(input);
  };

  const answer = {
    postId: ambiguousForumPost.postId,
    clarificationId: "clarification-target-environment",
    authorId: "discord-owner",
    answer: "Use the staging environment.",
  } as const;
  const firstAnswer = runtime.answerClarification(answer);
  await planStarted.promise;
  await assert.rejects(
    runtime.answerClarification({
      ...answer,
      answer: "Use production instead.",
    }),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "CLARIFICATION_ANSWER_CONFLICT",
  );
  const duplicateAnswer = runtime.answerClarification(answer);
  releasePlan.resolve();

  const [firstCompleted, duplicateCompleted] = await Promise.all([firstAnswer, duplicateAnswer]);
  assert.deepEqual(duplicateCompleted, firstCompleted);
});

class CrashAfterReviewJournal extends InMemoryOrchestrationJournal {
  private shouldCrash = true;

  public override async recordCompletedTask(
    forumPostId: string,
    task: CompletedTaskView,
  ): Promise<void> {
    if (this.shouldCrash) {
      this.shouldCrash = false;
      throw new Error("simulated process loss after durable review");
    }
    await super.recordCompletedTask(forumPostId, task);
  }
}

class CrashAfterDispatchJournal extends InMemoryOrchestrationJournal {
  private shouldCrash = true;

  public override async recordRunAssignment(
    forumPostId: string,
    assignment: JournaledRunAssignment,
  ): Promise<void> {
    await super.recordRunAssignment(forumPostId, assignment);
    if (this.shouldCrash) {
      this.shouldCrash = false;
      throw new Error("simulated process loss after durable dispatch");
    }
  }
}

test("an expired durable Run is retired after restart before a higher-fenced retry executes", async () => {
  const runtimeClock = new MutableRuntimeClock();
  const firstJournal = new CrashAfterDispatchJournal({
    clock: runtimeClock,
  });
  const coordinator = new ClarifyingCoordinator();
  coordinator.assessIntake = async () =>
    ({
      decision: "ready",
    }) as const;
  const worker = new RecordingWorker();
  let runSequence = 0;
  const runAssignments: RunAssignmentSource = {
    nextRun(input) {
      runSequence += 1;
      return {
        ...input,
        runId: `run-expiry-${String(runSequence)}`,
        idempotencyKey: `dispatch-expiry-${String(runSequence)}`,
        leaseId: `lease-expiry-${String(runSequence)}`,
        fencingToken: runSequence,
        expiresAt: runSequence === 1 ? "2026-07-24T00:01:00.000Z" : "2026-07-24T01:00:00.000Z",
      };
    },
  };
  const firstRuntime = createOpenDelegate({
    ...dispatchDependencies,
    clock: runtimeClock,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new CountingIds(),
    runAssignments,
    journal: firstJournal,
  });

  await assert.rejects(
    firstRuntime.acceptForumPost(ambiguousForumPost),
    /simulated process loss after durable dispatch/,
  );
  assert.equal(
    (await firstJournal.runAssignment("task-ambiguous-target", richWorkOrder.workOrderId))
      ?.assignment.runId,
    "run-expiry-1",
  );
  assert.equal(worker.calls.length, 0);

  runtimeClock.value = "2026-07-24T00:02:00.000Z";
  const restoredJournal = new InMemoryOrchestrationJournal({
    clock: runtimeClock,
    recordedEvents: await firstJournal.recordedEvents(),
  });
  const restoredRuntime = createOpenDelegate({
    ...dispatchDependencies,
    clock: runtimeClock,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new FailingIds(),
    runAssignments,
    journal: restoredJournal,
  });

  await assert.rejects(
    restoredRuntime.acceptForumPost(ambiguousForumPost),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "RUN_ASSIGNMENT_INVALID",
  );
  assert.equal(
    await restoredJournal.runAssignment("task-ambiguous-target", richWorkOrder.workOrderId),
    undefined,
  );

  const completed = await restoredRuntime.acceptForumPost(ambiguousForumPost);
  const assignments = await restoredJournal.runAssignments("task-ambiguous-target");

  assert.equal(completed.state, "completed");
  assert.deepEqual(
    assignments.map((assignment) => ({
      runId: assignment.assignment.runId,
      fencingToken: assignment.assignment.fencingToken,
    })),
    [
      { runId: "run-expiry-1", fencingToken: 1 },
      { runId: "run-expiry-2", fencingToken: 2 },
    ],
  );
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0]?.run.runId, "run-expiry-2");
});

test("an ineligible durable route is retired before a new route receives a higher-fenced retry", async () => {
  const firstJournal = new CrashAfterDispatchJournal({
    clock: new FixedClock(),
  });
  const coordinator = new ClarifyingCoordinator();
  coordinator.assessIntake = async () =>
    ({
      decision: "ready",
    }) as const;
  let runSequence = 0;
  const runAssignments: RunAssignmentSource = {
    nextRun(input) {
      runSequence += 1;
      return {
        ...input,
        runId: `run-route-${String(runSequence)}`,
        idempotencyKey: `dispatch-route-${String(runSequence)}`,
        leaseId: `lease-route-${String(runSequence)}`,
        fencingToken: runSequence,
        expiresAt: "2026-07-24T01:00:00.000Z",
      };
    },
  };
  const firstRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [new RecordingWorker()],
    artifacts,
    ids: new CountingIds(),
    runAssignments,
    journal: firstJournal,
  });

  await assert.rejects(
    firstRuntime.acceptForumPost(ambiguousForumPost),
    /simulated process loss after durable dispatch/,
  );

  const restoredJournal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
    recordedEvents: await firstJournal.recordedEvents(),
  });
  const recoveredWorker = new RecordingWorker();
  Object.defineProperty(recoveredWorker, "scheduling", {
    value: {
      ...workerScheduling(["release-check"]),
      routes: [
        { routeId: "route-desktop", priority: 1, health: "unhealthy" },
        { routeId: "route-recovered", priority: 2, health: "healthy" },
      ],
    } satisfies WorkerDeviceSnapshot,
  });
  const restoredRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [recoveredWorker],
    artifacts,
    ids: new FailingIds(),
    runAssignments,
    journal: restoredJournal,
  });

  await assert.rejects(
    restoredRuntime.acceptForumPost(ambiguousForumPost),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "SCHEDULING_SELECTION_INVALID",
  );
  assert.equal(
    await restoredJournal.runAssignment("task-ambiguous-target", richWorkOrder.workOrderId),
    undefined,
  );

  const completed = await restoredRuntime.acceptForumPost(ambiguousForumPost);
  const assignments = await restoredJournal.runAssignments("task-ambiguous-target");

  assert.equal(completed.state, "completed");
  assert.deepEqual(
    assignments.map((assignment) => ({
      runId: assignment.assignment.runId,
      routeId: assignment.assignment.routeId,
      fencingToken: assignment.assignment.fencingToken,
    })),
    [
      { runId: "run-route-1", routeId: "route-desktop", fencingToken: 1 },
      { runId: "run-route-2", routeId: "route-recovered", fencingToken: 2 },
    ],
  );
  assert.equal(recoveredWorker.calls.length, 1);
  assert.equal(recoveredWorker.calls[0]?.run.runId, "run-route-2");
});

test("a transient fleet-policy validation failure preserves a still-valid durable Run", async () => {
  const firstJournal = new CrashAfterDispatchJournal({
    clock: new FixedClock(),
  });
  const coordinator = new ClarifyingCoordinator();
  coordinator.assessIntake = async () =>
    ({
      decision: "ready",
    }) as const;
  const worker = new RecordingWorker();
  let runSequence = 0;
  const runAssignments: RunAssignmentSource = {
    nextRun(input) {
      runSequence += 1;
      return {
        ...input,
        runId: `run-policy-${String(runSequence)}`,
        idempotencyKey: `dispatch-policy-${String(runSequence)}`,
        leaseId: `lease-policy-${String(runSequence)}`,
        fencingToken: runSequence,
        expiresAt: "2026-07-24T01:00:00.000Z",
      };
    },
  };
  const firstRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new CountingIds(),
    runAssignments,
    journal: firstJournal,
  });

  await assert.rejects(
    firstRuntime.acceptForumPost(ambiguousForumPost),
    /simulated process loss after durable dispatch/,
  );
  const restoredJournal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
    recordedEvents: await firstJournal.recordedEvents(),
  });
  const invalidPolicyRuntime = createOpenDelegate({
    ...dispatchDependencies,
    dispatchPolicy: {
      evaluate() {
        throw new Error("simulated transient Policy dependency failure");
      },
    },
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new FailingIds(),
    runAssignments,
    journal: restoredJournal,
  });

  await assert.rejects(
    invalidPolicyRuntime.acceptForumPost(ambiguousForumPost),
    /simulated transient Policy dependency failure/,
  );
  assert.equal(
    (await restoredJournal.runAssignment("task-ambiguous-target", richWorkOrder.workOrderId))
      ?.assignment.runId,
    "run-policy-1",
  );

  const recoveredRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new FailingIds(),
    runAssignments,
    journal: restoredJournal,
  });
  const completed = await recoveredRuntime.acceptForumPost(ambiguousForumPost);

  assert.equal(completed.state, "completed");
  assert.equal(runSequence, 1);
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0]?.run.runId, "run-policy-1");
});

test("restart reuses durable synthesis and review without repeating semantic calls", async () => {
  const firstJournal = new CrashAfterReviewJournal({
    clock: new FixedClock(),
  });
  const coordinator = new ClarifyingCoordinator();
  coordinator.assessIntake = async () =>
    ({
      decision: "ready",
    }) as const;
  const worker = new RecordingWorker();
  const firstRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new CountingIds(),
    runAssignments: new SequentialRuns(),
    journal: firstJournal,
  });

  await assert.rejects(
    firstRuntime.acceptForumPost(ambiguousForumPost),
    /simulated process loss after durable review/,
  );
  assert.equal(coordinator.planCalls, 1);
  assert.equal(coordinator.reviewCalls, 1);
  assert.equal(worker.calls.length, 1);
  assert.equal(
    (await firstJournal.recordedEvents()).some((event) => event.type === "synthesis.recorded"),
    true,
  );
  assert.equal(
    (await firstJournal.recordedEvents()).some((event) => event.type === "task.review-completed"),
    true,
  );

  const restoredJournal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
    recordedEvents: await firstJournal.recordedEvents(),
  });
  const restoredRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new FailingIds(),
    runAssignments: new SequentialRuns(),
    journal: restoredJournal,
  });
  const completed = await restoredRuntime.acceptForumPost(ambiguousForumPost);

  assert.equal(completed.state, "completed");
  assert.equal(coordinator.planCalls, 1);
  assert.equal(coordinator.reviewCalls, 1);
  assert.equal(worker.calls.length, 1);
});
