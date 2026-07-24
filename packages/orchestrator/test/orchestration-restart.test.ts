import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenDelegate,
  InMemoryOrchestrationJournal,
  OrchestratorError,
  type ArtifactGateway,
  type ChannelAuthorizer,
  type Coordinator,
  type OrchestrationIdSource,
  type RunAssignment,
  type RunAssignmentSource,
  type RunAssignmentTarget,
  type Worker,
  type WorkerDeviceSnapshot,
  type WorkerExecutionInput,
  type WorkOrderSchedulingInput,
} from "../src/index.ts";

const forumPost = {
  forumId: "forum-owner-work",
  postId: "post-restart-proof",
  authorId: "discord-owner",
  title: "Prove restart safety",
  body: "Run both checks and publish one report.",
} as const;

const taskBrief = {
  objective: "Prove orchestration restart safety.",
  completionCriteria: ["Verify both restart checks and publish the result."],
  constraints: ["Do not repeat a completed Worker side effect."],
  knownInputIds: ["forum-post:post-restart-proof"],
  decisions: ["Use the durable orchestration journal."],
  openQuestions: [],
} as const;

class FixedClock {
  public now(): string {
    return "2026-07-24T00:00:00.000Z";
  }
}

const dispatchDependencies = {
  clock: new FixedClock(),
  dispatchPolicy: {
    evaluate() {
      return { outcome: "allow", code: "test-dispatch-allowed" } as const;
    },
  },
  scheduler: {
    select(input: WorkOrderSchedulingInput) {
      const candidate = input.candidates.find((value) =>
        input.workOrder.requiredCapabilities.every((required) =>
          value.capabilities.some(
            (capability) => capability.name === required && capability.verification === "verified",
          ),
        ),
      );
      assert.ok(candidate);
      const route = candidate.routes.find((value) => value.health === "healthy");
      assert.ok(route);
      return {
        deviceId: candidate.deviceId,
        workerId: candidate.workerId,
        routeId: route.routeId,
        explanations: [],
      };
    },
  },
} as const;

function workerScheduling(capabilities: readonly string[]): WorkerDeviceSnapshot {
  return {
    enabled: true,
    status: "online",
    draining: false,
    osFamily: "linux",
    capabilities: capabilities.map((name) => ({ name, verification: "verified" })),
    roles: [],
    workspaceIds: [],
    routes: [{ routeId: "route-test", priority: 1, health: "healthy" }],
    availableRunSlots: 2,
    loadRatio: 0,
    desktopSessionAvailable: false,
    availableSecretRefs: [],
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

class RestartCoordinator implements Coordinator {
  public async assessIntake() {
    return {
      decision: "ready",
    } as const;
  }

  public async plan() {
    return {
      taskBrief,
      workOrders: [
        {
          workOrderId: "work-order-stable",
          title: "Complete the stable side effect",
          brief: "Complete the stable side effect.",
          completionCriteria: ["Return stable evidence."],
          constraints: [],
          selectedInputIds: ["forum-post:post-restart-proof"],
          dependsOn: [],
          schedulingHints: {
            preferredDeviceIds: [],
            preferredRoles: [],
          },
          requiredCapabilities: ["stable"],
          requiredSecretRefs: [],
        },
        {
          workOrderId: "work-order-flaky",
          title: "Complete the retryable side effect",
          brief: "Complete the retryable side effect.",
          completionCriteria: ["Return recovered evidence."],
          constraints: [],
          selectedInputIds: ["forum-post:post-restart-proof"],
          dependsOn: [],
          schedulingHints: {
            preferredDeviceIds: [],
            preferredRoles: [],
          },
          requiredCapabilities: ["flaky"],
          requiredSecretRefs: [],
        },
      ],
    };
  }

  public async synthesize() {
    return {
      summary: "Both restart checks passed.",
      artifact: {
        filename: "restart-proof.html",
        mediaType: "text/html",
        content: "<p>Restart-safe</p>",
      },
    };
  }

  public async review() {
    return {
      decision: "complete",
      verifiedCompletionCriteria: taskBrief.completionCriteria,
    } as const;
  }
}

class CountingWorker implements Worker {
  public calls = 0;
  public readonly deviceId: string;
  public readonly workerId: string;
  public readonly scheduling: WorkerDeviceSnapshot;
  private failuresRemaining: number;

  public constructor(workerId: string, capabilities: readonly string[], failuresRemaining = 0) {
    this.workerId = workerId;
    this.deviceId = workerId.replace(/^worker-/, "device-");
    this.scheduling = workerScheduling(capabilities);
    this.failuresRemaining = failuresRemaining;
  }

  public async execute(input: WorkerExecutionInput) {
    this.calls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("simulated retryable failure");
    }
    return {
      taskId: input.run.taskId,
      workOrderId: input.run.workOrderId,
      deviceId: input.run.deviceId,
      workerId: input.run.workerId,
      routeId: input.run.routeId,
      runId: input.run.runId,
      leaseId: input.run.leaseId,
      fencingToken: input.run.fencingToken,
      report: `${this.workerId} completed.`,
    };
  }
}

class CountingIds implements OrchestrationIdSource {
  public calls = 0;

  public nextTaskId(): string {
    this.calls += 1;
    return "task-restart-proof";
  }
}

class FailingIds implements OrchestrationIdSource {
  public nextTaskId(): never {
    throw new Error("A restored Task must not allocate another Task ID.");
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

const artifacts: ArtifactGateway = {
  async publish() {
    return {
      artifactId: "artifact-restart-proof",
      href: "https://artifacts.example.test/restart-proof",
    };
  },
};

test("one durable Task ID cannot bind to two Forum posts", () => {
  const journal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
  });
  journal.bindTask("post-one", {
    taskId: "task-one-to-one",
    forumPost: {
      forumId: "forum-owner-work",
      postId: "post-one",
      authorId: "discord-owner",
      title: "First post",
      body: "First Task body.",
      authorizedPrincipalId: "owner-primary",
    },
  });

  assert.throws(
    () =>
      journal.bindTask("post-two", {
        taskId: "task-one-to-one",
        forumPost: {
          forumId: "forum-owner-work",
          postId: "post-two",
          authorId: "discord-owner",
          title: "Second post",
          body: "Second Task body.",
          authorizedPrincipalId: "owner-primary",
        },
      }),
    (error: unknown) => error instanceof OrchestratorError && error.code === "TASK_ID_CONFLICT",
  );
});

test("recorded orchestration events restore Task identity and completed side effects", async () => {
  const firstJournal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
  });
  const firstIds = new CountingIds();
  const runAssignments = new SequentialRuns();
  const stableBeforeRestart = new CountingWorker("worker-stable", ["stable"]);
  const flakyBeforeRestart = new CountingWorker("worker-flaky", ["flaky"], 1);
  const firstRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator: new RestartCoordinator(),
    workers: [stableBeforeRestart, flakyBeforeRestart],
    artifacts,
    ids: firstIds,
    runAssignments,
    journal: firstJournal,
  });

  await assert.rejects(firstRuntime.acceptForumPost(forumPost), /simulated retryable failure/);
  assert.equal(firstIds.calls, 1);
  assert.equal(stableBeforeRestart.calls, 1);
  assert.equal(flakyBeforeRestart.calls, 1);

  const restoredJournal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
    recordedEvents: firstJournal.recordedEvents(),
  });
  const stableAfterRestart = new CountingWorker("worker-stable", ["stable"]);
  const flakyAfterRestart = new CountingWorker("worker-flaky", ["flaky"]);
  const restoredRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator: new RestartCoordinator(),
    workers: [stableAfterRestart, flakyAfterRestart],
    artifacts,
    ids: new FailingIds(),
    runAssignments,
    journal: restoredJournal,
  });

  const completed = await restoredRuntime.acceptForumPost(forumPost);

  assert.equal(completed.taskId, "task-restart-proof");
  assert.equal(stableAfterRestart.calls, 0);
  assert.equal(flakyAfterRestart.calls, 1);

  const afterCompletionRestart = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
    recordedEvents: restoredJournal.recordedEvents(),
  });
  const forbiddenWorker = new CountingWorker("worker-forbidden", ["stable", "flaky"], 99);
  const completedRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new AllowOwner(),
    coordinator: new RestartCoordinator(),
    workers: [forbiddenWorker],
    artifacts,
    ids: new FailingIds(),
    runAssignments: new SequentialRuns(),
    journal: afterCompletionRestart,
  });

  assert.deepEqual(completedRuntime.getTaskByForumPost(forumPost.postId), completed);
  assert.deepEqual(await completedRuntime.acceptForumPost(forumPost), completed);
  assert.equal(forbiddenWorker.calls, 0);

  const validEvents = afterCompletionRestart.recordedEvents();
  const missingArtifactJournal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
    recordedEvents: validEvents.filter((event) => event.type !== "artifact.published"),
  });
  assert.throws(
    () => missingArtifactJournal.completedTask(forumPost.postId),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "JOURNAL_EVENT_INVALID",
  );

  const invalidHistoryEvents = validEvents.map((event) => {
    if (event.type !== "task.completed") {
      return event;
    }
    const payload = structuredClone(event.payload) as Record<string, unknown>;
    const task = payload["task"] as Record<string, unknown>;
    return {
      ...event,
      payload: {
        ...payload,
        task: {
          ...task,
          stateHistory: ["intake", "review", "running", "completed"],
        },
      },
    };
  });
  const invalidHistoryJournal = new InMemoryOrchestrationJournal({
    clock: new FixedClock(),
    recordedEvents: invalidHistoryEvents,
  });
  assert.throws(
    () => invalidHistoryJournal.completedTask(forumPost.postId),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "JOURNAL_EVENT_INVALID",
  );
});
