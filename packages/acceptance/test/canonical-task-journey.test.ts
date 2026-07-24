import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenDelegate,
  type ArtifactContent,
  type ArtifactGateway,
  type ArtifactPublishInput,
  type ArtifactReference,
  type ChannelAuthorizer,
  type Coordinator,
  type CoordinatorIntakeDecision,
  type CoordinatorIntakeInput,
  type CoordinatorPlan,
  type CoordinatorPlanInput,
  type CoordinatorReview,
  type CoordinatorReviewInput,
  type CoordinatorSynthesis,
  type CoordinatorSynthesisInput,
  type RunAssignment,
  type RunAssignmentSource,
  type RunAssignmentTarget,
  type TaskIdSource,
  type Worker,
  type WorkerDeviceSnapshot,
  type WorkerExecutionInput,
  type WorkerExecutionResult,
  type WorkOrderSchedulingInput,
} from "@opendelegate/orchestrator";

class AllowlistedOwner implements ChannelAuthorizer {
  async authorizeForumPost(input: {
    readonly forumId: string;
    readonly postId: string;
    readonly authorId: string;
  }) {
    assert.equal(input.forumId, "forum-owner-work");
    assert.equal(input.authorId, "discord-owner");
    return {
      decision: "allow",
      principalId: "owner-primary",
    } as const;
  }
}

const dispatchDependencies = {
  clock: {
    now: () => "2026-07-24T00:00:00.000Z",
  },
  dispatchPolicy: {
    evaluate() {
      return { outcome: "allow", code: "acceptance-dispatch-allowed" } as const;
    },
  },
  scheduler: {
    select(input: WorkOrderSchedulingInput) {
      const preferred = input.workOrder.schedulingHints.preferredDeviceIds;
      const eligible = input.candidates.filter((candidate) =>
        input.workOrder.requiredCapabilities.every((required) =>
          candidate.capabilities.some(
            (capability) => capability.name === required && capability.verification === "verified",
          ),
        ),
      );
      const candidate =
        preferred
          .map((deviceId) => eligible.find((value) => value.deviceId === deviceId))
          .find((value) => value !== undefined) ?? eligible[0];
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
    routes: [{ routeId: "route-acceptance", priority: 1, health: "healthy" }],
    availableRunSlots: 4,
    loadRatio: 0,
    desktopSessionAvailable: false,
    availableSecretRefs: [],
  };
}

class ParallelStartGate {
  #release!: () => void;
  readonly #releasePromise: Promise<void>;
  readonly #started = new Set<string>();
  #twoStarted!: () => void;
  readonly #twoStartedPromise: Promise<void>;

  constructor() {
    this.#releasePromise = new Promise<void>((resolve) => {
      this.#release = () => resolve();
    });
    this.#twoStartedPromise = new Promise<void>((resolve) => {
      this.#twoStarted = () => resolve();
    });
  }

  async arrive(workerId: string): Promise<void> {
    this.#started.add(workerId);
    if (this.#started.size === 2) {
      this.#twoStarted();
    }
    await this.#releasePromise;
  }

  async waitForTwoWorkers(): Promise<void> {
    await this.#twoStartedPromise;
  }

  release(): void {
    this.#release();
  }
}

class FakeCoordinator implements Coordinator {
  readonly planInputs: CoordinatorPlanInput[] = [];
  readonly synthesisInputs: CoordinatorSynthesisInput[] = [];

  async assessIntake(input: CoordinatorIntakeInput): Promise<CoordinatorIntakeDecision> {
    assert.match(input.taskId, /^task-/);
    return { decision: "ready" };
  }

  async plan(input: CoordinatorPlanInput): Promise<CoordinatorPlan> {
    this.planInputs.push(input);

    if (input.forumPost.postId === "forum-post-launch-report") {
      return {
        taskBrief: {
          objective: "Verify launch readiness and publish a readable report.",
          completionCriteria: [
            "Collect launch readiness evidence.",
            "Publish an openable launch readiness report.",
          ],
          constraints: ["Keep the report scoped to the requested launch evidence."],
          knownInputIds: ["forum-post:forum-post-launch-report"],
          decisions: ["Use independent research and rendering Workers."],
          openQuestions: [],
        },
        workOrders: [
          {
            workOrderId: "work-order-research",
            title: "Collect launch readiness evidence",
            brief: "Collect the launch readiness evidence.",
            completionCriteria: ["Return a concise evidence summary."],
            constraints: ["Return only launch readiness evidence."],
            selectedInputIds: ["forum-post:forum-post-launch-report"],
            dependsOn: [],
            schedulingHints: {
              preferredDeviceIds: ["device-mac-research"],
              preferredRoles: ["researcher"],
            },
            requiredCapabilities: ["research"],
            requiredSecretRefs: [],
          },
          {
            workOrderId: "work-order-render",
            title: "Render launch readiness report",
            brief: "Prepare the launch readiness report.",
            completionCriteria: ["Return a static HTML report body."],
            constraints: ["Produce static HTML only."],
            selectedInputIds: ["forum-post:forum-post-launch-report"],
            dependsOn: [],
            schedulingHints: {
              preferredDeviceIds: ["device-linux-render"],
              preferredRoles: ["report-renderer"],
            },
            requiredCapabilities: ["report-rendering"],
            requiredSecretRefs: [],
          },
        ],
      };
    }

    return {
      taskBrief: {
        objective: "Report the configured backup policy.",
        completionCriteria: [
          "Identify the configured backup policy.",
          "Publish an openable backup policy report.",
        ],
        constraints: ["Report only configured policy."],
        knownInputIds: ["forum-post:forum-post-backup-policy"],
        decisions: ["Use the research Worker."],
        openQuestions: [],
      },
      workOrders: [
        {
          workOrderId: "work-order-backup-check",
          title: "Check backup policy",
          brief: "Check the backup policy.",
          completionCriteria: ["Return the configured backup policy."],
          constraints: ["Return only configured backup policy."],
          selectedInputIds: ["forum-post:forum-post-backup-policy"],
          dependsOn: [],
          schedulingHints: {
            preferredDeviceIds: ["device-mac-research"],
            preferredRoles: ["researcher"],
          },
          requiredCapabilities: ["research"],
          requiredSecretRefs: [],
        },
      ],
    };
  }

  async synthesize(input: CoordinatorSynthesisInput): Promise<CoordinatorSynthesis> {
    this.synthesisInputs.push(input);

    if (input.taskId === "task-launch-report") {
      return {
        summary: "Launch readiness is verified by both workers.",
        artifact: {
          filename: "launch-readiness.html",
          mediaType: "text/html",
          content: "<h1>Launch readiness</h1><p>Verified.</p>",
        },
      };
    }

    return {
      summary: "The backup policy is local snapshots.",
      artifact: {
        filename: "backup-policy.html",
        mediaType: "text/html",
        content: "<h1>Backup policy</h1><p>Local snapshots.</p>",
      },
    };
  }

  async review(input: CoordinatorReviewInput): Promise<CoordinatorReview> {
    assert.ok(input.artifactReference.artifactId.startsWith("artifact-"));
    return {
      decision: "complete",
      verifiedCompletionCriteria: input.taskBrief.completionCriteria,
    };
  }
}

class FakeWorker implements Worker {
  readonly deviceId: string;
  readonly workerId: string;
  readonly scheduling: WorkerDeviceSnapshot;
  readonly startedRuns: Array<{
    readonly taskId: string;
    readonly workOrderId: string;
  }> = [];
  readonly #reports: Readonly<Record<string, string>>;
  readonly #firstTaskGate: ParallelStartGate;

  constructor({
    workerId,
    capabilities,
    reports,
    firstTaskGate,
  }: {
    readonly workerId: string;
    readonly capabilities: readonly string[];
    readonly reports: Readonly<Record<string, string>>;
    readonly firstTaskGate: ParallelStartGate;
  }) {
    this.workerId = workerId;
    this.deviceId =
      workerId === "worker-mac-research" ? "device-mac-research" : "device-linux-render";
    this.scheduling = workerScheduling(capabilities);
    this.#reports = reports;
    this.#firstTaskGate = firstTaskGate;
  }

  async execute(input: WorkerExecutionInput): Promise<WorkerExecutionResult> {
    this.startedRuns.push({
      taskId: input.taskId,
      workOrderId: input.workOrder.workOrderId,
    });

    if (input.taskId === "task-launch-report") {
      await this.#firstTaskGate.arrive(this.workerId);
    }

    const report = this.#reports[input.workOrder.workOrderId];
    assert.ok(report, "The fake Worker must have a report for its Work Order.");

    return {
      taskId: input.run.taskId,
      workOrderId: input.run.workOrderId,
      deviceId: input.run.deviceId,
      workerId: input.run.workerId,
      routeId: input.run.routeId,
      runId: input.run.runId,
      leaseId: input.run.leaseId,
      fencingToken: input.run.fencingToken,
      report,
    };
  }
}

class FakeArtifactGateway implements ArtifactGateway {
  readonly #artifacts = new Map<string, ArtifactContent>();

  async publish(input: ArtifactPublishInput): Promise<ArtifactReference> {
    const reference =
      input.taskId === "task-launch-report"
        ? {
            artifactId: "artifact-launch-report",
            href: "https://reports.example.test/artifacts/launch-readiness",
          }
        : {
            artifactId: "artifact-backup-policy",
            href: "https://reports.example.test/artifacts/backup-policy",
          };

    this.#artifacts.set(reference.artifactId, {
      filename: input.filename,
      mediaType: input.mediaType,
      content: input.content,
    });

    return reference;
  }

  async open(reference: ArtifactReference): Promise<ArtifactContent | undefined> {
    return this.#artifacts.get(reference.artifactId);
  }
}

class FakeTaskIds implements TaskIdSource {
  #values = ["task-launch-report", "task-backup-policy"];

  nextTaskId(): string | undefined {
    return this.#values.shift();
  }
}

class FakeRunAssignments implements RunAssignmentSource {
  #sequence = 0;

  nextRun(input: RunAssignmentTarget): RunAssignment {
    this.#sequence += 1;
    return {
      ...input,
      runId: `run-${this.#sequence}`,
      idempotencyKey: `run-${this.#sequence}`,
      leaseId: `lease-${this.#sequence}`,
      fencingToken: this.#sequence,
      expiresAt: "2026-07-24T01:00:00.000Z",
    };
  }
}

test(
  "approved Forum posts become isolated completed Tasks with parallel Worker reports and an openable result",
  { timeout: 2_000 },
  async () => {
    const firstTaskGate = new ParallelStartGate();
    const coordinator = new FakeCoordinator();
    const researchWorker = new FakeWorker({
      workerId: "worker-mac-research",
      capabilities: ["research"],
      reports: {
        "work-order-research": "All launch checks passed.",
        "work-order-backup-check": "Backups use local snapshots.",
      },
      firstTaskGate,
    });
    const renderingWorker = new FakeWorker({
      workerId: "worker-linux-render",
      capabilities: ["report-rendering"],
      reports: {
        "work-order-render": "<h1>Launch readiness</h1><p>Verified.</p>",
      },
      firstTaskGate,
    });
    const artifacts = new FakeArtifactGateway();
    const openDelegate = createOpenDelegate({
      ...dispatchDependencies,
      authorizer: new AllowlistedOwner(),
      coordinator,
      workers: [researchWorker, renderingWorker],
      artifacts,
      ids: new FakeTaskIds(),
      runAssignments: new FakeRunAssignments(),
    });

    const firstTaskPromise = openDelegate.acceptForumPost({
      forumId: "forum-owner-work",
      postId: "forum-post-launch-report",
      authorId: "discord-owner",
      title: "Verify launch readiness",
      body: "Research the evidence and publish a readable report.",
    });

    await firstTaskGate.waitForTwoWorkers();

    assert.deepEqual(
      [...researchWorker.startedRuns, ...renderingWorker.startedRuns].sort((left, right) =>
        left.workOrderId.localeCompare(right.workOrderId),
      ),
      [
        {
          taskId: "task-launch-report",
          workOrderId: "work-order-render",
        },
        {
          taskId: "task-launch-report",
          workOrderId: "work-order-research",
        },
      ],
    );

    firstTaskGate.release();
    const firstTask = await firstTaskPromise;

    assert.deepEqual(firstTask, {
      taskId: "task-launch-report",
      state: "completed",
      stateHistory: ["intake", "running", "review", "completed"],
      taskBrief: {
        objective: "Verify launch readiness and publish a readable report.",
        completionCriteria: [
          "Collect launch readiness evidence.",
          "Publish an openable launch readiness report.",
        ],
        constraints: ["Keep the report scoped to the requested launch evidence."],
        knownInputIds: ["forum-post:forum-post-launch-report"],
        decisions: ["Use independent research and rendering Workers."],
        openQuestions: [],
      },
      verifiedCompletionCriteria: [
        "Collect launch readiness evidence.",
        "Publish an openable launch readiness report.",
      ],
      workOrders: [
        {
          workOrderId: "work-order-research",
          workerId: "worker-mac-research",
          state: "succeeded",
          report: "All launch checks passed.",
        },
        {
          workOrderId: "work-order-render",
          workerId: "worker-linux-render",
          state: "succeeded",
          report: "<h1>Launch readiness</h1><p>Verified.</p>",
        },
      ],
      resultProjection: {
        kind: "discord-result",
        statusTag: "Done",
        content: "Launch readiness is verified by both workers.",
        actions: [
          {
            type: "link",
            label: "Open report",
            href: "https://reports.example.test/artifacts/launch-readiness",
          },
        ],
      },
      artifactRefs: [
        {
          artifactId: "artifact-launch-report",
          href: "https://reports.example.test/artifacts/launch-readiness",
        },
      ],
    });

    assert.deepEqual(coordinator.synthesisInputs[0], {
      taskId: "task-launch-report",
      reports: [
        {
          workOrderId: "work-order-research",
          workerId: "worker-mac-research",
          report: "All launch checks passed.",
        },
        {
          workOrderId: "work-order-render",
          workerId: "worker-linux-render",
          report: "<h1>Launch readiness</h1><p>Verified.</p>",
        },
      ],
    });

    const firstArtifact = firstTask.artifactRefs[0];
    assert.ok(firstArtifact);
    assert.deepEqual(await artifacts.open(firstArtifact), {
      filename: "launch-readiness.html",
      mediaType: "text/html",
      content: "<h1>Launch readiness</h1><p>Verified.</p>",
    });

    const duplicateDelivery = await openDelegate.acceptForumPost({
      forumId: "forum-owner-work",
      postId: "forum-post-launch-report",
      authorId: "discord-owner",
      title: "Verify launch readiness",
      body: "Research the evidence and publish a readable report.",
    });
    const secondTask = await openDelegate.acceptForumPost({
      forumId: "forum-owner-work",
      postId: "forum-post-backup-policy",
      authorId: "discord-owner",
      title: "Check backup policy",
      body: "Report only the configured backup policy.",
    });

    assert.equal(duplicateDelivery.taskId, "task-launch-report");
    assert.equal(secondTask.taskId, "task-backup-policy");
    assert.equal(secondTask.state, "completed");
    assert.equal(
      openDelegate.getTaskByForumPost("forum-post-launch-report").taskId,
      "task-launch-report",
    );
    assert.equal(
      openDelegate.getTaskByForumPost("forum-post-backup-policy").taskId,
      "task-backup-policy",
    );
    assert.deepEqual(coordinator.planInputs, [
      {
        taskId: "task-launch-report",
        forumPost: {
          forumId: "forum-owner-work",
          postId: "forum-post-launch-report",
          authorId: "discord-owner",
          authorizedPrincipalId: "owner-primary",
          title: "Verify launch readiness",
          body: "Research the evidence and publish a readable report.",
        },
      },
      {
        taskId: "task-backup-policy",
        forumPost: {
          forumId: "forum-owner-work",
          postId: "forum-post-backup-policy",
          authorId: "discord-owner",
          authorizedPrincipalId: "owner-primary",
          title: "Check backup policy",
          body: "Report only the configured backup policy.",
        },
      },
    ]);
  },
);
