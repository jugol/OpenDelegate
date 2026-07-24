import assert from "node:assert/strict";
import test from "node:test";
import { SchedulerError } from "@opendelegate/scheduler";

import {
  createOpenDelegate,
  InMemoryOrchestrationJournal,
  OrchestratorError,
  type ArtifactGateway,
  type ArtifactPublishInput,
  type ChannelAuthorizer,
  type Coordinator,
  type OrchestrationIdSource,
  type RunAssignment,
  type RunAssignmentSource,
  type RunAssignmentTarget,
  type Worker,
  type WorkerDeviceSnapshot,
  type WorkerExecutionInput,
} from "../src/index.ts";

const forumPost = {
  forumId: "forum-owner-work",
  postId: "post-release-check",
  authorId: "discord-owner",
  title: "Check release readiness",
  body: "Run both checks and publish the result.",
} as const;

const taskBrief = {
  objective: "Check release readiness.",
  completionCriteria: ["Verify both release checks and publish the result."],
  constraints: ["Use the assigned fake Workers."],
  knownInputIds: ["forum-post:post-release-check"],
  decisions: ["Run both checks."],
  openQuestions: [],
} as const;

const orchestrationClock = {
  now: () => "2026-07-24T00:00:00.000Z",
} as const;

class MutableOrchestrationClock {
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
  clock: orchestrationClock,
  dispatchPolicy: allowDispatchPolicy,
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
    availableRunSlots: 4,
    loadRatio: 0,
    desktopSessionAvailable: true,
    availableSecretRefs: [],
  };
}

class FakeAuthorizer implements ChannelAuthorizer {
  public calls = 0;
  private readonly allowed: boolean;

  public constructor(allowed: boolean) {
    this.allowed = allowed;
  }

  public async authorizeForumPost() {
    this.calls += 1;
    return this.allowed
      ? ({
          decision: "allow",
          principalId: "owner-primary",
        } as const)
      : ({
          decision: "deny",
          reason: "The Discord identity is not allowlisted.",
        } as const);
  }
}

class FakeIds implements OrchestrationIdSource {
  public taskCalls = 0;

  public nextTaskId(): string | undefined {
    this.taskCalls += 1;
    return this.taskCalls === 1 ? "task-release-check" : undefined;
  }
}

class FakeRunAssignments implements RunAssignmentSource {
  public readonly assignments: RunAssignment[] = [];

  public nextRun(input: RunAssignmentTarget): RunAssignment {
    const sequence = this.assignments.length + 1;
    const assignment = {
      runId: `run-${sequence}`,
      idempotencyKey: `run-${sequence}`,
      leaseId: `lease-${sequence}`,
      fencingToken: sequence,
      expiresAt: `2026-07-24T00:0${sequence}:00.000Z`,
      ...input,
    };
    this.assignments.push(assignment);
    return assignment;
  }
}

class FakeCoordinator implements Coordinator {
  public planCalls = 0;
  public synthesisCalls = 0;

  public async assessIntake() {
    return {
      decision: "ready",
    } as const;
  }

  public async plan() {
    this.planCalls += 1;
    return {
      taskBrief,
      workOrders: [
        {
          workOrderId: "work-order-safe",
          title: "Perform the safe check",
          brief: "Perform the safe check.",
          completionCriteria: ["Return the safe result."],
          constraints: [],
          selectedInputIds: ["forum-post:post-release-check"],
          dependsOn: [],
          schedulingHints: {
            preferredDeviceIds: [],
            preferredRoles: [],
          },
          requiredCapabilities: ["safe-check"],
          requiredSecretRefs: [],
        },
        {
          workOrderId: "work-order-flaky",
          title: "Perform the flaky check",
          brief: "Perform the flaky check.",
          completionCriteria: ["Return the recovered result."],
          constraints: [],
          selectedInputIds: ["forum-post:post-release-check"],
          dependsOn: [],
          schedulingHints: {
            preferredDeviceIds: [],
            preferredRoles: [],
          },
          requiredCapabilities: ["flaky-check"],
          requiredSecretRefs: [],
        },
      ],
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
    this.synthesisCalls += 1;
    return {
      summary: "Both checks passed.",
      artifact: {
        filename: "release.html",
        mediaType: "text/html",
        content: "<p>Ready</p>",
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

async function seedJournalRun(journal: InMemoryOrchestrationJournal): Promise<{
  readonly assignment: RunAssignment;
}> {
  const workOrder = {
    workOrderId: "work-order-journal-lease",
    title: "Prove journal lease enforcement",
    brief: "Prove journal lease enforcement.",
    completionCriteria: ["Reject stale completion."],
    constraints: [],
    selectedInputIds: ["forum-post:post-release-check"],
    dependsOn: [],
    schedulingHints: {
      preferredDeviceIds: [],
      preferredRoles: [],
    },
    requiredCapabilities: ["safe-check"],
    requiredSecretRefs: [],
  } as const;
  await journal.bindTask(forumPost.postId, {
    taskId: "task-release-check",
    forumPost: {
      ...forumPost,
      authorizedPrincipalId: "owner-primary",
    },
  });
  await journal.recordIntakeReady("task-release-check");
  await journal.recordPlan("task-release-check", {
    taskBrief,
    workOrders: [workOrder],
  });
  const assignment: RunAssignment = {
    taskId: "task-release-check",
    workOrderId: workOrder.workOrderId,
    deviceId: "device-journal",
    workerId: "worker-journal",
    routeId: "route-test",
    runId: "run-journal",
    idempotencyKey: "dispatch-journal",
    leaseId: "lease-journal",
    fencingToken: 1,
    expiresAt: "2026-07-24T00:01:00.000Z",
  };
  await journal.recordRunAssignment("task-release-check", {
    workOrderId: workOrder.workOrderId,
    assignment,
  });
  const durable = await journal.runAssignment("task-release-check", workOrder.workOrderId);
  assert.ok(durable);
  return { assignment };
}

class RecordingWorker implements Worker {
  public readonly calls: WorkerExecutionInput[] = [];
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
    this.calls.push(input);

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("simulated Worker failure");
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
      report: `${this.workerId} succeeded.`,
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

test("a caller-supplied Discord identity cannot create a Task without trusted authorization", async () => {
  const authorizer = new FakeAuthorizer(false);
  const ids = new FakeIds();
  const coordinator = new FakeCoordinator();
  const runAssignments = new FakeRunAssignments();
  const worker = new RecordingWorker("worker-safe", ["safe-check", "flaky-check"]);
  const openDelegate = createOpenDelegate({
    ...dispatchDependencies,
    authorizer,
    coordinator,
    workers: [worker],
    artifacts,
    ids,
    runAssignments,
  });

  await assert.rejects(
    openDelegate.acceptForumPost(forumPost),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "FORUM_AUTHOR_UNAUTHORIZED",
  );

  assert.equal(authorizer.calls, 1);
  assert.equal(ids.taskCalls, 0);
  assert.equal(coordinator.planCalls, 0);
  assert.equal(worker.calls.length, 0);
});

test("a retry keeps one Task and does not repeat a successful Work Order side effect", async () => {
  const authorizer = new FakeAuthorizer(true);
  const ids = new FakeIds();
  const coordinator = new FakeCoordinator();
  const runAssignments = new FakeRunAssignments();
  const safeWorker = new RecordingWorker("worker-safe", ["safe-check"]);
  const flakyWorker = new RecordingWorker("worker-flaky", ["flaky-check"], 1);
  const openDelegate = createOpenDelegate({
    ...dispatchDependencies,
    authorizer,
    coordinator,
    workers: [safeWorker, flakyWorker],
    artifacts,
    ids,
    runAssignments,
  });

  await assert.rejects(openDelegate.acceptForumPost(forumPost), /simulated Worker failure/);
  const completed = await openDelegate.acceptForumPost(forumPost);

  assert.equal(completed.taskId, "task-release-check");
  assert.equal(ids.taskCalls, 1);
  assert.equal(safeWorker.calls.length, 1);
  assert.equal(flakyWorker.calls.length, 2);
  assert.equal(safeWorker.calls[0]?.run.runId, "run-1");
  assert.equal(safeWorker.calls[0]?.run.fencingToken, 1);
  assert.equal(flakyWorker.calls[0]?.run.runId, "run-2");
  assert.equal(flakyWorker.calls[1]?.run.runId, "run-3");
  assert.notEqual(
    flakyWorker.calls[0]?.run.idempotencyKey,
    flakyWorker.calls[1]?.run.idempotencyKey,
  );

  const duplicate = await openDelegate.acceptForumPost(forumPost);
  assert.equal(duplicate.taskId, completed.taskId);
  assert.equal(safeWorker.calls.length, 1);
  assert.equal(flakyWorker.calls.length, 2);
  assert.equal(Object.isFrozen(completed), true);
  assert.equal(Object.isFrozen(completed.workOrders), true);
  assert.equal(Object.isFrozen(completed.resultProjection), true);
  assert.equal(Object.isFrozen(completed.resultProjection.actions), true);
  assert.equal(Object.isFrozen(completed.artifactRefs), true);
});

test("a retry cannot reuse the failed Run assignment", async () => {
  const safeWorker = new RecordingWorker("worker-safe", ["safe-check"]);
  const flakyWorker = new RecordingWorker("worker-flaky", ["flaky-check"], 1);
  const openDelegate = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new FakeAuthorizer(true),
    coordinator: new FakeCoordinator(),
    workers: [safeWorker, flakyWorker],
    artifacts,
    ids: new FakeIds(),
    runAssignments: {
      nextRun(input: RunAssignmentTarget): RunAssignment {
        const suffix = input.workOrderId.replace("work-order-", "");
        return {
          ...input,
          runId: `run-${suffix}`,
          idempotencyKey: `dispatch-${suffix}`,
          leaseId: `lease-${suffix}`,
          fencingToken: suffix === "safe" ? 1 : 2,
          expiresAt: "2026-07-24T00:01:00.000Z",
        };
      },
    },
  });

  await assert.rejects(openDelegate.acceptForumPost(forumPost), /simulated Worker failure/);
  await assert.rejects(
    openDelegate.acceptForumPost(forumPost),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "RUN_ASSIGNMENT_CONFLICT",
  );

  assert.equal(safeWorker.calls.length, 1);
  assert.equal(flakyWorker.calls.length, 1);
});

test("an ambiguous Artifact response retries with one stable publication idempotency key", async () => {
  const authorizer = new FakeAuthorizer(true);
  const ids = new FakeIds();
  const coordinator = new FakeCoordinator();
  const runAssignments = new FakeRunAssignments();
  const worker = new RecordingWorker("worker-all", ["safe-check", "flaky-check"]);
  const publicationKeys: Array<string | undefined> = [];
  let publicationAttempts = 0;
  const ambiguousArtifacts: ArtifactGateway = {
    async publish(input: ArtifactPublishInput) {
      publicationAttempts += 1;
      publicationKeys.push(
        (input as ArtifactPublishInput & { readonly idempotencyKey?: string }).idempotencyKey,
      );

      if (publicationAttempts === 1) {
        throw new Error("simulated response loss after Artifact publication");
      }

      return {
        artifactId: "artifact-release",
        href: "https://artifacts.example.test/release",
      };
    },
  };
  const openDelegate = createOpenDelegate({
    ...dispatchDependencies,
    authorizer,
    coordinator,
    workers: [worker],
    artifacts: ambiguousArtifacts,
    ids,
    runAssignments,
  });

  await assert.rejects(
    openDelegate.acceptForumPost(forumPost),
    /simulated response loss after Artifact publication/,
  );
  const completed = await openDelegate.acceptForumPost(forumPost);

  assert.equal(completed.state, "completed");
  assert.equal(worker.calls.length, 2);
  assert.deepEqual(publicationKeys, [
    "task-release-check:result-artifact",
    "task-release-check:result-artifact",
  ]);
});

test("Artifact references accept private HTTP but reject non-HTTP or malformed URLs", async () => {
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "not a URL",
  ]) {
    const coordinator = new FakeCoordinator();
    const openDelegate = createOpenDelegate({
      ...dispatchDependencies,
      authorizer: new FakeAuthorizer(true),
      coordinator,
      workers: [new RecordingWorker("worker-all", ["safe-check", "flaky-check"])],
      artifacts: {
        async publish() {
          return {
            artifactId: "artifact-release",
            href,
          };
        },
      },
      ids: new FakeIds(),
      runAssignments: new FakeRunAssignments(),
    });

    await assert.rejects(
      openDelegate.acceptForumPost(forumPost),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "ARTIFACT_REFERENCE_INVALID",
    );
  }

  const privateHttpRuntime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new FakeAuthorizer(true),
    coordinator: new FakeCoordinator(),
    workers: [new RecordingWorker("worker-all", ["safe-check", "flaky-check"])],
    artifacts: {
      async publish() {
        return {
          artifactId: "artifact-private",
          href: "http://main-device.internal:8080/artifacts/release",
        };
      },
    },
    ids: new FakeIds(),
    runAssignments: new FakeRunAssignments(),
  });

  assert.equal((await privateHttpRuntime.acceptForumPost(forumPost)).state, "completed");
});

test("synthesis rejects Artifact filenames that are not safe basenames", async () => {
  for (const filename of [
    "../release.html",
    "nested/release.html",
    "nested\\release.html",
    ".",
    "..",
    "release\0.html",
  ]) {
    const coordinator = new FakeCoordinator();
    coordinator.synthesize = async () => ({
      summary: "Both checks passed.",
      artifact: {
        filename,
        mediaType: "text/html",
        content: "<p>Ready</p>",
      },
    });
    const openDelegate = createOpenDelegate({
      ...dispatchDependencies,
      authorizer: new FakeAuthorizer(true),
      coordinator,
      workers: [new RecordingWorker("worker-all", ["safe-check", "flaky-check"])],
      artifacts,
      ids: new FakeIds(),
      runAssignments: new FakeRunAssignments(),
    });

    await assert.rejects(
      openDelegate.acceptForumPost(forumPost),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "COORDINATOR_SYNTHESIS_INVALID",
    );
  }
});

test("dispatch uses the scheduler's Device-specific selection and binds the Run to that Worker", async () => {
  const linuxWorker = new RecordingWorker("worker-linux", ["safe-check"]);
  const windowsWorker = new RecordingWorker("worker-windows", ["safe-check"]);
  const runtime = createOpenDelegate({
    authorizer: new FakeAuthorizer(true),
    coordinator: {
      async assessIntake() {
        return { decision: "ready" } as const;
      },
      async plan() {
        return {
          taskBrief,
          workOrders: [
            {
              workOrderId: "work-order-device-bound",
              title: "Run the Device-bound check",
              brief: "Run the check on the configured Windows Workspace.",
              completionCriteria: ["Return the Device-bound result."],
              constraints: [],
              selectedInputIds: ["forum-post:post-release-check"],
              dependsOn: [],
              schedulingHints: {
                preferredDeviceIds: ["device-windows"],
                preferredRoles: ["release-runner"],
              },
              requiredCapabilities: ["safe-check"],
              requiredSecretRefs: ["secret-release"],
              requiredOsFamily: "windows" as const,
              workspaceId: "workspace-release",
            },
          ],
        };
      },
      async synthesize() {
        return {
          summary: "The Device-bound check passed.",
          artifact: {
            filename: "device-bound.html",
            mediaType: "text/html",
            content: "<p>Device-bound check passed.</p>",
          },
        };
      },
      async review() {
        return {
          decision: "complete",
          verifiedCompletionCriteria: taskBrief.completionCriteria,
        } as const;
      },
      async selectDevice(input: {
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
      },
    },
    workers: [
      Object.assign(linuxWorker, {
        deviceId: "device-linux",
        scheduling: {
          enabled: true,
          status: "online",
          draining: false,
          osFamily: "linux",
          capabilities: [{ name: "safe-check", verification: "verified" }],
          roles: ["release-runner"],
          workspaceIds: [],
          routes: [{ routeId: "route-linux", priority: 1, health: "healthy" }],
          availableRunSlots: 1,
          loadRatio: 0,
          desktopSessionAvailable: false,
          availableSecretRefs: [],
        },
      }),
      Object.assign(windowsWorker, {
        deviceId: "device-windows",
        scheduling: {
          enabled: true,
          status: "online",
          draining: false,
          osFamily: "windows",
          capabilities: [{ name: "safe-check", verification: "verified" }],
          roles: ["release-runner"],
          workspaceIds: ["workspace-release"],
          routes: [{ routeId: "route-windows", priority: 1, health: "healthy" }],
          availableRunSlots: 1,
          loadRatio: 0,
          desktopSessionAvailable: true,
          availableSecretRefs: ["secret-release"],
        },
      }),
    ],
    artifacts,
    ids: new FakeIds(),
    runAssignments: new FakeRunAssignments(),
    clock: { now: () => "2026-07-24T00:00:00.000Z" },
    dispatchPolicy: {
      evaluate(input: { readonly device: { readonly deviceId: string } }) {
        return {
          outcome: input.device.deviceId === "device-windows" ? "allow" : "deny",
          code: "test-device-policy",
        } as const;
      },
    },
  } as Parameters<typeof createOpenDelegate>[0]);

  const task = await runtime.acceptForumPost(forumPost);

  assert.equal(task.state, "completed");
  assert.equal(linuxWorker.calls.length, 0);
  assert.equal(windowsWorker.calls.length, 1);
  assert.deepEqual(windowsWorker.calls[0]?.run, {
    taskId: "task-release-check",
    workOrderId: "work-order-device-bound",
    deviceId: "device-windows",
    workerId: "worker-windows",
    routeId: "route-windows",
    runId: "run-1",
    idempotencyKey: "run-1",
    leaseId: "lease-1",
    fencingToken: 1,
    expiresAt: "2026-07-24T00:01:00.000Z",
  });
});

test("semantic selection receives only mechanically eligible tied Devices", async () => {
  const workerA = new RecordingWorker("worker-a", ["safe-check"]);
  const workerB = new RecordingWorker("worker-b", ["safe-check"]);
  const incapableWorker = new RecordingWorker("worker-incapable", ["other-check"]);
  const selectionInputs: Array<Parameters<Coordinator["selectDevice"]>[0]> = [];
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new FakeAuthorizer(true),
    coordinator: {
      async assessIntake() {
        return { decision: "ready" } as const;
      },
      async plan() {
        return {
          taskBrief,
          workOrders: [
            {
              workOrderId: "work-order-semantic-tie",
              title: "Resolve a semantic scheduling tie",
              brief: "Run the safe check on the semantically suitable Device.",
              completionCriteria: ["Return the safe result."],
              constraints: [],
              selectedInputIds: [],
              dependsOn: [],
              schedulingHints: { preferredDeviceIds: [], preferredRoles: [] },
              requiredCapabilities: ["safe-check"],
              requiredSecretRefs: [],
            },
          ],
        };
      },
      async selectDevice(input) {
        selectionInputs.push(input);
        return {
          protocolVersion: "v1",
          taskId: input.taskId,
          workOrderId: input.workOrder.workOrderId,
          preferredDeviceId: "device-b",
        } as const;
      },
      async synthesize() {
        return {
          summary: "The semantic selection completed.",
          artifact: {
            filename: "semantic-selection.html",
            mediaType: "text/html",
            content: "<p>Complete</p>",
          },
        };
      },
      async review() {
        return {
          decision: "complete",
          verifiedCompletionCriteria: taskBrief.completionCriteria,
        } as const;
      },
    },
    workers: [incapableWorker, workerB, workerA],
    artifacts,
    ids: new FakeIds(),
    runAssignments: new FakeRunAssignments(),
  });

  await runtime.acceptForumPost(forumPost);

  assert.deepEqual(
    selectionInputs[0]?.eligibleDevices.map((candidate) => candidate.deviceId),
    ["device-a", "device-b"],
  );
  assert.equal(workerA.calls.length, 0);
  assert.equal(workerB.calls.length, 1);
  assert.equal(incapableWorker.calls.length, 0);
});

function createInvalidSemanticSelectionRuntime(selection: unknown) {
  const workerA = new RecordingWorker("worker-a", ["safe-check"]);
  const workerB = new RecordingWorker("worker-b", ["safe-check"]);
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new FakeAuthorizer(true),
    coordinator: {
      async assessIntake() {
        return { decision: "ready" } as const;
      },
      async plan() {
        return {
          taskBrief,
          workOrders: [
            {
              workOrderId: "work-order-semantic-correlation",
              title: "Correlate a semantic scheduling choice",
              brief: "Run the safe check on the semantically selected Device.",
              completionCriteria: ["Return the safe result."],
              constraints: [],
              selectedInputIds: [],
              dependsOn: [],
              schedulingHints: { preferredDeviceIds: [], preferredRoles: [] },
              requiredCapabilities: ["safe-check"],
              requiredSecretRefs: [],
            },
          ],
        };
      },
      async selectDevice() {
        return selection as Awaited<ReturnType<Coordinator["selectDevice"]>>;
      },
      async synthesize() {
        return {
          summary: "The semantic selection completed.",
          artifact: {
            filename: "semantic-correlation.html",
            mediaType: "text/html",
            content: "<p>Complete</p>",
          },
        };
      },
      async review() {
        return {
          decision: "complete",
          verifiedCompletionCriteria: taskBrief.completionCriteria,
        } as const;
      },
    },
    workers: [workerA, workerB],
    artifacts,
    ids: new FakeIds(),
    runAssignments: new FakeRunAssignments(),
  });

  return { runtime, workerA, workerB };
}

const invalidSemanticSelections = [
  {
    name: "an unsupported protocol version",
    selection: {
      protocolVersion: "v2",
      taskId: "task-release-check",
      workOrderId: "work-order-semantic-correlation",
      preferredDeviceId: "device-b",
    },
  },
  {
    name: "a response correlated to another Task",
    selection: {
      protocolVersion: "v1",
      taskId: "task-stale-selection",
      workOrderId: "work-order-semantic-correlation",
      preferredDeviceId: "device-b",
    },
  },
  {
    name: "a response correlated to another Work Order",
    selection: {
      protocolVersion: "v1",
      taskId: "task-release-check",
      workOrderId: "work-order-stale-selection",
      preferredDeviceId: "device-b",
    },
  },
  {
    name: "a Device outside the bounded eligible set",
    selection: {
      protocolVersion: "v1",
      taskId: "task-release-check",
      workOrderId: "work-order-semantic-correlation",
      preferredDeviceId: "device-outside",
    },
  },
] as const;

for (const { name, selection } of invalidSemanticSelections) {
  test(`semantic selection rejects ${name}`, async () => {
    const { runtime, workerA, workerB } = createInvalidSemanticSelectionRuntime(selection);

    await assert.rejects(
      runtime.acceptForumPost(forumPost),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "SCHEDULING_SELECTION_INVALID",
    );
    assert.equal(workerA.calls.length, 0);
    assert.equal(workerB.calls.length, 0);
  });
}

test("the scheduler rejects ambiguous Worker route snapshots", async () => {
  const worker = new RecordingWorker("worker-ambiguous", ["safe-check", "flaky-check"]);
  Object.assign(worker, {
    scheduling: {
      ...workerScheduling(["safe-check", "flaky-check"]),
      routes: [
        { routeId: "route-duplicate", priority: 1, health: "healthy" },
        { routeId: "route-duplicate", priority: 2, health: "healthy" },
      ],
    },
  });
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new FakeAuthorizer(true),
    coordinator: new FakeCoordinator(),
    workers: [worker],
    artifacts,
    ids: new FakeIds(),
    runAssignments: new FakeRunAssignments(),
  });

  await assert.rejects(
    runtime.acceptForumPost(forumPost),
    (error: unknown) =>
      error instanceof SchedulerError &&
      error.explanations.some((explanation) =>
        explanation.exclusions.some(
          (exclusion) =>
            exclusion.code === "DEVICE_SNAPSHOT_INVALID" && exclusion.fields.includes("transports"),
        ),
      ),
  );
  assert.equal(worker.calls.length, 0);
});

test("Run assignment expiry must be a strict future RFC3339 instant", async () => {
  for (const expiresAt of ["2026-07-24 00:01:00Z", "2026-07-24T00:00:00.000Z"]) {
    const worker = new RecordingWorker("worker-all", ["safe-check", "flaky-check"]);
    const runtime = createOpenDelegate({
      ...dispatchDependencies,
      authorizer: new FakeAuthorizer(true),
      coordinator: new FakeCoordinator(),
      workers: [worker],
      artifacts,
      ids: new FakeIds(),
      runAssignments: {
        nextRun(input: RunAssignmentTarget): RunAssignment {
          return {
            ...input,
            runId: "run-invalid-clock",
            idempotencyKey: "dispatch-invalid-clock",
            leaseId: "lease-invalid-clock",
            fencingToken: 1,
            expiresAt,
          };
        },
      },
    });

    await assert.rejects(
      runtime.acceptForumPost(forumPost),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "RUN_ASSIGNMENT_INVALID",
    );
    assert.equal(worker.calls.length, 0);
  }
});

test("Run, lease, and dispatch idempotency identifiers cannot be reused across Work Orders", async () => {
  const worker = new RecordingWorker("worker-all", ["safe-check", "flaky-check"]);
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new FakeAuthorizer(true),
    coordinator: new FakeCoordinator(),
    workers: [worker],
    artifacts,
    ids: new FakeIds(),
    runAssignments: {
      nextRun(input: RunAssignmentTarget): RunAssignment {
        return {
          ...input,
          runId: "run-reused",
          idempotencyKey: "dispatch-reused",
          leaseId: "lease-reused",
          fencingToken: 1,
          expiresAt: "2026-07-24T00:01:00.000Z",
        };
      },
    },
  });

  await assert.rejects(
    runtime.acceptForumPost(forumPost),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "RUN_ASSIGNMENT_CONFLICT",
  );
});

test("a replacement Run requires a strictly higher fence live and during replay", async () => {
  const clock = new MutableOrchestrationClock();
  const journal = new InMemoryOrchestrationJournal({ clock });
  const { assignment } = await seedJournalRun(journal);
  await journal.recordRunFailed("task-release-check", assignment.workOrderId, assignment.runId);
  const sameFenceReplacement: RunAssignment = {
    ...assignment,
    runId: "run-journal-same-fence",
    idempotencyKey: "dispatch-journal-same-fence",
    leaseId: "lease-journal-same-fence",
  };

  await assert.rejects(
    () =>
      journal.recordRunAssignment("task-release-check", {
        workOrderId: assignment.workOrderId,
        assignment: sameFenceReplacement,
      }),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "RUN_ASSIGNMENT_CONFLICT",
  );

  const higherFenceReplacement: RunAssignment = {
    ...sameFenceReplacement,
    runId: "run-journal-higher-fence",
    idempotencyKey: "dispatch-journal-higher-fence",
    leaseId: "lease-journal-higher-fence",
    fencingToken: assignment.fencingToken + 1,
  };
  await journal.recordRunAssignment("task-release-check", {
    workOrderId: assignment.workOrderId,
    assignment: higherFenceReplacement,
  });
  const tamperedEvents = (await journal.recordedEvents()).map((event) =>
    event.type === "work-order.dispatched" &&
    (event.payload as { readonly assignment?: RunAssignment }).assignment?.runId ===
      higherFenceReplacement.runId
      ? {
          ...event,
          payload: {
            ...(event.payload as object),
            assignment: {
              ...higherFenceReplacement,
              fencingToken: assignment.fencingToken,
            },
          },
        }
      : event,
  );

  await assert.rejects(
    async () => {
      const restored = new InMemoryOrchestrationJournal({
        clock,
        recordedEvents: tamperedEvents,
      });
      await restored.runAssignment("task-release-check", assignment.workOrderId);
    },
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "JOURNAL_EVENT_INVALID",
  );
});

test("a Run assignment is durable before its Device Worker can execute", async () => {
  const journal = new InMemoryOrchestrationJournal({ clock: orchestrationClock });
  let executions = 0;
  const worker: Worker = {
    deviceId: "device-durable",
    workerId: "worker-durable",
    scheduling: workerScheduling(["safe-check", "flaky-check"]),
    async execute(input) {
      const durable = await journal.runAssignment(
        "task-release-check",
        input.workOrder.workOrderId,
      );
      assert.equal(durable?.assignment.runId, input.run.runId);
      assert.equal(durable?.assignment.deviceId, this.deviceId);
      assert.equal(durable?.assignment.workerId, this.workerId);
      executions += 1;
      return {
        taskId: input.run.taskId,
        workOrderId: input.run.workOrderId,
        deviceId: input.run.deviceId,
        workerId: input.run.workerId,
        routeId: input.run.routeId,
        runId: input.run.runId,
        leaseId: input.run.leaseId,
        fencingToken: input.run.fencingToken,
        report: "The durable dispatch completed.",
      };
    },
  };
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new FakeAuthorizer(true),
    coordinator: new FakeCoordinator(),
    workers: [worker],
    artifacts,
    ids: new FakeIds(),
    runAssignments: new FakeRunAssignments(),
    journal,
  });

  assert.equal((await runtime.acceptForumPost(forumPost)).state, "completed");
  assert.equal(executions, 2);
});

test("a Worker completion that arrives after its lease expires is rejected", async () => {
  let now = "2026-07-24T00:00:00.000Z";
  const journal = new InMemoryOrchestrationJournal({ clock: orchestrationClock });
  const coordinator = new FakeCoordinator();
  coordinator.plan = async () => ({
    taskBrief,
    workOrders: [
      {
        workOrderId: "work-order-safe",
        title: "Perform the safe check",
        brief: "Perform the safe check.",
        completionCriteria: ["Return the safe result."],
        constraints: [],
        selectedInputIds: ["forum-post:post-release-check"],
        dependsOn: [],
        schedulingHints: {
          preferredDeviceIds: [],
          preferredRoles: [],
        },
        requiredCapabilities: ["safe-check"],
        requiredSecretRefs: [],
      },
    ],
  });
  const worker: Worker = {
    deviceId: "device-expiring",
    workerId: "worker-expiring",
    scheduling: workerScheduling(["safe-check"]),
    async execute(input) {
      now = input.run.expiresAt;
      return {
        taskId: input.run.taskId,
        workOrderId: input.run.workOrderId,
        deviceId: input.run.deviceId,
        workerId: input.run.workerId,
        routeId: input.run.routeId,
        runId: input.run.runId,
        leaseId: input.run.leaseId,
        fencingToken: input.run.fencingToken,
        report: "This completion arrived too late.",
      };
    },
  };
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    clock: { now: () => now },
    authorizer: new FakeAuthorizer(true),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new FakeIds(),
    runAssignments: new FakeRunAssignments(),
    journal,
  });

  await assert.rejects(
    runtime.acceptForumPost(forumPost),
    (error: unknown) => error instanceof OrchestratorError && error.code === "RUN_COMPLETION_STALE",
  );
  assert.deepEqual(await journal.workOrderResults("task-release-check"), []);
});

test("a replaced Run cannot report completion through its old lease and fence", async () => {
  const journal = new InMemoryOrchestrationJournal({ clock: orchestrationClock });
  const coordinator = new FakeCoordinator();
  coordinator.plan = async () => ({
    taskBrief,
    workOrders: [
      {
        workOrderId: "work-order-safe",
        title: "Perform the safe check",
        brief: "Perform the safe check.",
        completionCriteria: ["Return the safe result."],
        constraints: [],
        selectedInputIds: ["forum-post:post-release-check"],
        dependsOn: [],
        schedulingHints: {
          preferredDeviceIds: [],
          preferredRoles: [],
        },
        requiredCapabilities: ["safe-check"],
        requiredSecretRefs: [],
      },
    ],
  });
  const worker: Worker = {
    deviceId: "device-replaced",
    workerId: "worker-replaced",
    scheduling: workerScheduling(["safe-check"]),
    async execute(input) {
      const durable = await journal.runAssignment(
        "task-release-check",
        input.workOrder.workOrderId,
      );
      assert.ok(durable);
      await journal.recordRunFailed(
        "task-release-check",
        input.workOrder.workOrderId,
        input.run.runId,
      );
      await journal.recordRunAssignment("task-release-check", {
        workOrderId: input.workOrder.workOrderId,
        assignment: {
          ...input.run,
          runId: "run-replacement",
          idempotencyKey: "dispatch-replacement",
          leaseId: "lease-replacement",
          fencingToken: input.run.fencingToken + 1,
        },
      });
      return {
        taskId: input.run.taskId,
        workOrderId: input.run.workOrderId,
        deviceId: input.run.deviceId,
        workerId: input.run.workerId,
        routeId: input.run.routeId,
        runId: input.run.runId,
        leaseId: input.run.leaseId,
        fencingToken: input.run.fencingToken,
        report: "This completion belongs to the replaced Run.",
      };
    },
  };
  const runtime = createOpenDelegate({
    ...dispatchDependencies,
    authorizer: new FakeAuthorizer(true),
    coordinator,
    workers: [worker],
    artifacts,
    ids: new FakeIds(),
    runAssignments: new FakeRunAssignments(),
    journal,
  });

  await assert.rejects(
    runtime.acceptForumPost(forumPost),
    (error: unknown) => error instanceof OrchestratorError && error.code === "RUN_COMPLETION_STALE",
  );
  assert.equal(
    (await journal.runAssignment("task-release-check", "work-order-safe"))?.assignment.runId,
    "run-replacement",
  );
  assert.deepEqual(await journal.workOrderResults("task-release-check"), []);
});

test("the durable journal rejects a direct Worker completion at or after lease expiry", async () => {
  const clock = new MutableOrchestrationClock();
  const journal = new InMemoryOrchestrationJournal({ clock });
  const { assignment } = await seedJournalRun(journal);
  clock.value = assignment.expiresAt;

  await assert.rejects(
    () =>
      journal.recordWorkOrderResult("task-release-check", {
        taskId: assignment.taskId,
        workOrderId: assignment.workOrderId,
        deviceId: assignment.deviceId,
        workerId: assignment.workerId,
        routeId: assignment.routeId,
        runId: assignment.runId,
        leaseId: assignment.leaseId,
        fencingToken: assignment.fencingToken,
        report: {
          workOrderId: assignment.workOrderId,
          workerId: assignment.workerId,
          report: "This direct journal completion is stale.",
        },
      }),
    (error: unknown) => error instanceof OrchestratorError && error.code === "RUN_COMPLETION_STALE",
  );
  assert.deepEqual(await journal.workOrderResults("task-release-check"), []);
});

test("the durable journal rejects a direct or replayed dispatch after lease expiry", async () => {
  const expiredClock = new MutableOrchestrationClock();
  expiredClock.value = "2026-07-24T00:01:00.000Z";
  const expiredJournal = new InMemoryOrchestrationJournal({ clock: expiredClock });
  await assert.rejects(
    () => seedJournalRun(expiredJournal),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "RUN_ASSIGNMENT_INVALID",
  );

  const sourceClock = new MutableOrchestrationClock();
  const sourceJournal = new InMemoryOrchestrationJournal({ clock: sourceClock });
  await seedJournalRun(sourceJournal);
  const staleDispatchTime = "2026-07-24T00:02:00.000Z";
  const tamperedEvents = (await sourceJournal.recordedEvents()).map((event) =>
    event.type === "work-order.dispatched"
      ? {
          ...event,
          occurredAt: staleDispatchTime,
        }
      : event,
  );
  sourceClock.value = "2026-07-24T00:03:00.000Z";
  const restored = new InMemoryOrchestrationJournal({
    clock: sourceClock,
    recordedEvents: tamperedEvents,
  });
  await assert.rejects(
    () => restored.runAssignment("task-release-check", "work-order-journal-lease"),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "JOURNAL_EVENT_INVALID",
  );
});

test("journal replay preserves completion time and rejects a result recorded after lease expiry", async () => {
  const clock = new MutableOrchestrationClock();
  const journal = new InMemoryOrchestrationJournal({ clock });
  const { assignment } = await seedJournalRun(journal);
  clock.value = "2026-07-24T00:00:30.000Z";
  await journal.recordWorkOrderResult("task-release-check", {
    taskId: assignment.taskId,
    workOrderId: assignment.workOrderId,
    deviceId: assignment.deviceId,
    workerId: assignment.workerId,
    routeId: assignment.routeId,
    runId: assignment.runId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
    report: {
      workOrderId: assignment.workOrderId,
      workerId: assignment.workerId,
      report: "This completion was initially timely.",
    },
  });
  const staleCompletionTime = "2026-07-24T00:02:00.000Z";
  const tamperedEvents = (await journal.recordedEvents()).map((event) =>
    event.type === "work-order.completed"
      ? {
          ...event,
          occurredAt: staleCompletionTime,
        }
      : event,
  );
  clock.value = "2026-07-24T00:03:00.000Z";
  const restored = new InMemoryOrchestrationJournal({
    clock,
    recordedEvents: tamperedEvents,
  });

  assert.equal(
    (await restored.recordedEvents()).find((event) => event.type === "work-order.completed")
      ?.occurredAt,
    staleCompletionTime,
  );
  await assert.rejects(
    () => restored.workOrderResults("task-release-check"),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "JOURNAL_EVENT_INVALID",
  );
});

test("the journal clock cannot move backward to revive a Run lease", async () => {
  const clock = new MutableOrchestrationClock();
  const journal = new InMemoryOrchestrationJournal({ clock });
  const { assignment } = await seedJournalRun(journal);
  clock.value = "2026-07-23T23:59:59.000Z";

  await assert.rejects(
    () =>
      journal.recordWorkOrderResult("task-release-check", {
        taskId: assignment.taskId,
        workOrderId: assignment.workOrderId,
        deviceId: assignment.deviceId,
        workerId: assignment.workerId,
        routeId: assignment.routeId,
        runId: assignment.runId,
        leaseId: assignment.leaseId,
        fencingToken: assignment.fencingToken,
        report: {
          workOrderId: assignment.workOrderId,
          workerId: assignment.workerId,
          report: "A regressed clock must not revive this lease.",
        },
      }),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "ORCHESTRATION_CLOCK_INVALID",
  );
  assert.deepEqual(await journal.workOrderResults("task-release-check"), []);
});
