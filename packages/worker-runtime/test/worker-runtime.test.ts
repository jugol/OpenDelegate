import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  createTaskContinuationCheckpoint,
  type WorkOrderV1,
} from "@opendelegate/protocol";
import {
  TransportRoutesExhaustedError,
  createTransportResolver,
  type TransportAttemptTrace,
  type TransportResolver,
} from "@opendelegate/transport";

import {
  WorkerRuntime,
  WorkerRuntimeError,
  createSqliteWorkerStateRepository,
  parseWorkerAssignmentMessage,
  type RunProcess,
  type RunProcessFactory,
  type RunProcessOutcome,
  type WorkerAssignmentMessageV1,
  type WorkerConfiguration,
  type WorkerMainConnection,
  type WorkerRouteIncidentV1,
  type WorkerRunLeaseAuthority,
  type WorkerRunSteeringCommandV1,
} from "../src/index.ts";

const WORK_ORDER: WorkOrderV1 = {
  protocolVersion: PROTOCOL_VERSION,
  workOrderId: "work-order-1",
  title: "Inspect the repository",
  brief: "Inspect the repository and report the result.",
  completionCriteria: ["Return a concise result."],
  constraints: [],
  selectedInputIds: [],
  dependsOn: [],
  schedulingHints: {
    preferredDeviceIds: [],
    preferredRoles: [],
  },
  requiredCapabilities: ["codex"],
  requiredSecretRefs: [],
};

function continuationCheckpoint(taskId = "task-1") {
  return createTaskContinuationCheckpoint({
    schemaVersion: 1,
    taskId,
    taskVersion: 4,
    summary: {
      state: "running",
      mode: "auto",
      objective: "Inspect the repository.",
      rollingSummary: "The repository inspection is pending on the Worker.",
      completionCriteria: ["Return a concise result."],
      constraints: [],
    },
    decisions: [],
    pendingWorkOrders: [
      {
        workOrderId: WORK_ORDER.workOrderId,
        title: WORK_ORDER.title,
        brief: WORK_ORDER.brief,
        completionCriteria: WORK_ORDER.completionCriteria,
        constraints: WORK_ORDER.constraints,
        dependsOn: WORK_ORDER.dependsOn,
        requiredCapabilities: WORK_ORDER.requiredCapabilities,
        omitted: {
          completionCriteria: 0,
          constraints: 0,
          dependsOn: 0,
          requiredCapabilities: 0,
        },
      },
    ],
    artifacts: [],
    messages: [],
    sessions: [],
    omitted: {
      completionCriteria: 0,
      constraints: 0,
      decisions: 0,
      pendingWorkOrders: 0,
      artifacts: 0,
      messages: 0,
      sessions: 0,
    },
  });
}

function configuration(): WorkerConfiguration {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "device-worker-1",
    workerId: "worker-1",
    mainDeviceId: "device-main",
    transportProfile: {
      deviceId: "device-main",
      endpoints: [
        {
          endpointId: "route-main-wss",
          label: "Private Main route",
          kind: "wss",
          url: "wss://main.example.test/worker",
          credentialRef: "secret://device-certificate",
        },
      ],
    },
    maxOutboxEntries: 8,
    cancelGraceMs: 10,
  };
}

function assignment(
  overrides: Partial<WorkerAssignmentMessageV1["payload"]> = {},
): WorkerAssignmentMessageV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: "dispatch-message-1",
    senderDeviceId: "device-main",
    correlationId: "task-1",
    createdAt: "2026-07-24T10:30:00.000Z",
    idempotencyKey: "dispatch:run-1",
    type: "worker.run.assign",
    payload: {
      taskId: "task-1",
      workOrder: WORK_ORDER,
      deviceId: "device-worker-1",
      workerId: "worker-1",
      routeId: "route-main-wss",
      runId: "run-1",
      leaseId: "lease-1",
      fencingToken: 1,
      leaseExpiresAtMs: 2_000,
      ...overrides,
    },
  };
}

class DeferredRunProcess implements RunProcess {
  public readonly completion: Promise<RunProcessOutcome>;
  public cancelRequests = 0;
  public forcedTerminations = 0;
  private resolveCompletion!: (result: RunProcessOutcome) => void;

  public constructor() {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  public requestCancel(): Promise<void> {
    this.cancelRequests += 1;
    return Promise.resolve();
  }

  public forceTerminate(): Promise<void> {
    this.forcedTerminations += 1;
    return Promise.resolve();
  }

  public succeed(
    report = "Repository inspected.",
    usage?: NonNullable<RunProcessOutcome["usage"]>,
    agentSession?: NonNullable<RunProcessOutcome["agentSession"]>,
  ): void {
    this.resolveCompletion({
      status: "succeeded",
      report,
      artifactIds: [],
      ...(usage === undefined ? {} : { usage }),
      ...(agentSession === undefined ? {} : { agentSession }),
    });
  }
}

const ACTIVE_AGENT_SESSION = Object.freeze({
  provider: "codex" as const,
  adapterId: "codex-app-server",
  adapterVersion: "0.145.0",
  nativeSessionId: "thread-native-1",
  workstreamId: "implementation",
  workspaceId: "workspace-1",
  lineage: Object.freeze({
    lineageId: "lineage-1",
  }),
});

class SteerableDeferredRunProcess extends DeferredRunProcess {
  public readonly steeringRequests: Array<{
    readonly requestId: string;
    readonly instruction: string;
  }> = [];
  public holdSteering = false;

  public currentAgentSession() {
    return ACTIVE_AGENT_SESSION;
  }

  public async steer(request: Parameters<NonNullable<RunProcess["steer"]>>[0]) {
    this.steeringRequests.push({
      requestId: request.requestId,
      instruction: request.instruction,
    });
    if (this.holdSteering) {
      return await new Promise<never>(() => undefined);
    }
    return {
      delivery: "live" as const,
      agentSession: ACTIVE_AGENT_SESSION,
      providerTurnId: "turn-1",
    };
  }
}

function steeringCommand(
  overrides: Partial<WorkerRunSteeringCommandV1> = {},
): WorkerRunSteeringCommandV1 {
  return {
    requestId: "steer-request-1",
    taskId: "task-1",
    workOrderId: WORK_ORDER.workOrderId,
    deviceId: "device-worker-1",
    workerId: "worker-1",
    routeId: "route-main-wss",
    runId: "run-1",
    leaseId: "lease-1",
    fencingToken: 1,
    instruction: "Also verify the release manifest.",
    requestedBy: "owner",
    agentSession: ACTIVE_AGENT_SESSION,
    ...overrides,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      assert.fail("Timed out waiting for Worker state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("the Worker assignment boundary preserves only a valid Task-scoped checkpoint", () => {
  const checkpoint = continuationCheckpoint();
  const valid = assignment({ continuationCheckpoint: checkpoint });

  assert.deepEqual(parseWorkerAssignmentMessage(valid).payload.continuationCheckpoint, checkpoint);
  for (const invalid of [
    assignment({ continuationCheckpoint: continuationCheckpoint("task-other") }),
    assignment({
      workOrder: {
        ...WORK_ORDER,
        workOrderId: "work-order-other",
      },
      continuationCheckpoint: checkpoint,
    }),
    {
      ...valid,
      payload: {
        ...valid.payload,
        continuationCheckpoint: {
          ...checkpoint,
          summary: {
            ...checkpoint.summary,
            objective: "Tampered after hashing.",
          },
        },
      },
    },
    {
      ...valid,
      payload: {
        ...valid.payload,
        continuationCheckpoint: {
          ...checkpoint,
          cwd: "C:\\private\\workspace",
        },
      },
    },
  ]) {
    assert.throws(
      () => parseWorkerAssignmentMessage(invalid),
      (error: unknown) => error instanceof WorkerRuntimeError && error.code === "INVALID_MESSAGE",
    );
  }
});

test("a Worker restart retires even a renewed Run and admits only a new higher-fenced Run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-"));
  const filename = join(directory, "worker.sqlite");
  const firstRepository = createSqliteWorkerStateRepository({ filename });
  const secondRepository = createSqliteWorkerStateRepository({ filename });
  const process = new DeferredRunProcess();
  let starts = 0;
  const processFactory: RunProcessFactory = {
    start() {
      starts += 1;
      return Promise.resolve(process);
    },
  };
  const renewedAuthority: WorkerRunLeaseAuthority = {
    snapshot: () => ({
      leaseExpiresAtMs: 10_000,
      conservativeDeadlineMonotonicMs: 10_000,
    }),
    isCurrent: () => true,
    async renewIfDue() {},
  };
  const durableAssignment = assignment({
    continuationCheckpoint: continuationCheckpoint(),
  });

  try {
    const first = await WorkerRuntime.create({
      configuration: configuration(),
      repository: firstRepository,
      processFactory,
      clock: { now: () => 1_000 },
    });
    const second = await WorkerRuntime.create({
      configuration: configuration(),
      repository: secondRepository,
      processFactory,
      clock: { now: () => 1_000 },
    });

    const [left, right] = await Promise.all([
      first.acceptAssignment(durableAssignment, renewedAuthority),
      second.acceptAssignment(durableAssignment, renewedAuthority),
    ]);

    assert.equal(starts, 1);
    assert.deepEqual([left.disposition, right.disposition].sort(), ["accepted", "duplicate"]);

    await first.close();
    await second.close();

    const reopenedRepository = createSqliteWorkerStateRepository({ filename });
    const reopened = await WorkerRuntime.create({
      configuration: configuration(),
      repository: reopenedRepository,
      processFactory,
      clock: { now: () => 1_100 },
    });

    assert.deepEqual(
      (await reopenedRepository.read()).runs[0]?.assignment.continuationCheckpoint,
      durableAssignment.payload.continuationCheckpoint,
    );
    const replay = await reopened.acceptAssignment(durableAssignment);
    assert.equal(replay.disposition, "duplicate");
    assert.equal(starts, 1);
    assert.deepEqual(
      (await reopened.pendingOutbox()).map((event) => event.type),
      ["worker.run.claimed", "worker.run.failed"],
    );
    const replacement = {
      ...assignment({
        runId: "run-2",
        leaseId: "lease-2",
        fencingToken: 2,
        leaseExpiresAtMs: 3_000,
      }),
      messageId: "dispatch-message-2",
      idempotencyKey: "dispatch:run-2",
    } satisfies WorkerAssignmentMessageV1;
    assert.equal((await reopened.acceptAssignment(replacement)).disposition, "accepted");
    assert.equal(starts, 2);

    await reopened.close();
  } finally {
    firstRepository.close();
    secondRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Run steering is exact-scope, replay-safe, and rejected after completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-steering-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const process = new SteerableDeferredRunProcess();
  let now = 1_000;
  const runtime = await WorkerRuntime.create({
    configuration: configuration(),
    repository,
    processFactory: {
      start: () => Promise.resolve(process),
    },
    clock: { now: () => now },
  });

  try {
    assert.equal((await runtime.acceptAssignment(assignment())).disposition, "accepted");
    assert.deepEqual(
      (await runtime.heartbeat()).currentRuns?.[0]?.agentSession,
      ACTIVE_AGENT_SESSION,
    );
    assert.equal(
      JSON.stringify((await runtime.heartbeat()).currentRuns).includes("sessionKey"),
      false,
    );
    const command = steeringCommand();
    const receipt = await runtime.steerRun(command);
    assert.deepEqual(receipt, {
      requestId: command.requestId,
      requestMessageId: command.requestId,
      taskId: command.taskId,
      workOrderId: command.workOrderId,
      deviceId: command.deviceId,
      workerId: command.workerId,
      routeId: command.routeId,
      runId: command.runId,
      leaseId: command.leaseId,
      fencingToken: command.fencingToken,
      agentSession: ACTIVE_AGENT_SESSION,
      delivery: "live",
      status: "accepted",
      reasonCode: "LIVE_STEERING_ACCEPTED",
      decidedAtMs: 1_000,
      providerTurnId: "turn-1",
    });
    assert.deepEqual(await runtime.steerRun(command), receipt);
    assert.equal(process.steeringRequests.length, 1);
    await assert.rejects(
      runtime.steerRun({
        ...command,
        instruction: "Conflicting request replay.",
      }),
      (error: unknown) => error instanceof WorkerRuntimeError && error.code === "INVALID_MESSAGE",
    );

    const crossScope = await runtime.steerRun(
      steeringCommand({
        requestId: "steer-request-cross-scope",
        taskId: "task-other",
      }),
    );
    assert.equal(crossScope.status, "rejected");
    assert.equal(crossScope.reasonCode, "RUN_SCOPE_MISMATCH");
    assert.equal(process.steeringRequests.length, 1);

    now = 1_200;
    process.succeed();
    await waitFor(async () => (await repository.read()).runs[0]?.state === "succeeded");
    const afterCompletion = await runtime.steerRun(
      steeringCommand({ requestId: "steer-request-after-completion" }),
    );
    assert.equal(afterCompletion.status, "rejected");
    assert.equal(afterCompletion.reasonCode, "RUN_NOT_ACTIVE");
    assert.equal(process.steeringRequests.length, 1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Worker restart never resends a steering attempt with an unknown provider outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-steering-restart-"));
  const filename = join(directory, "worker.sqlite");
  const firstRepository = createSqliteWorkerStateRepository({ filename });
  const process = new SteerableDeferredRunProcess();
  process.holdSteering = true;
  const first = await WorkerRuntime.create({
    configuration: configuration(),
    repository: firstRepository,
    processFactory: {
      start: () => Promise.resolve(process),
    },
    clock: { now: () => 1_000 },
  });
  const command = steeringCommand();

  try {
    assert.equal((await first.acceptAssignment(assignment())).disposition, "accepted");
    void first.steerRun(command);
    await waitFor(
      async () => (await firstRepository.read()).steeringAttempts?.[0]?.state === "delivering",
    );
    assert.equal(process.steeringRequests.length, 1);
    await first.close();

    const reopenedRepository = createSqliteWorkerStateRepository({ filename });
    const restarted = await WorkerRuntime.create({
      configuration: configuration(),
      repository: reopenedRepository,
      processFactory: {
        start: () => Promise.resolve(new SteerableDeferredRunProcess()),
      },
      clock: { now: () => 1_100 },
    });
    const receipt = await restarted.steerRun(command);
    assert.equal(receipt.status, "outcome-unknown");
    assert.equal(receipt.reasonCode, "STEERING_OUTCOME_UNKNOWN");
    assert.equal(process.steeringRequests.length, 1);
    assert.deepEqual(await restarted.steerRun(command), receipt);
    await restarted.close();
  } finally {
    firstRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completion observed after lease expiry is reported as failed rather than succeeded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const process = new DeferredRunProcess();
  let now = 1_000;
  const runtime = await WorkerRuntime.create({
    configuration: configuration(),
    repository,
    processFactory: { start: () => Promise.resolve(process) },
    clock: { now: () => now },
  });

  try {
    await runtime.acceptAssignment(assignment());
    now = 2_001;
    process.succeed();
    await waitFor(async () => (await runtime.pendingOutbox()).length === 2);

    assert.deepEqual(
      (await runtime.pendingOutbox()).map((event) => event.type),
      ["worker.run.claimed", "worker.run.failed"],
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("online maintenance crosses two renewal windows while disconnect cannot extend authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-renewal-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const process = new DeferredRunProcess();
  let monotonicNowMs = 0;
  let leaseExpiresAtMs = 301_000;
  let conservativeDeadlineMonotonicMs = 300_000;
  let renewals = 0;
  const leaseAuthority: WorkerRunLeaseAuthority = {
    snapshot: () => ({
      leaseExpiresAtMs,
      conservativeDeadlineMonotonicMs,
    }),
    isCurrent: () => monotonicNowMs < conservativeDeadlineMonotonicMs,
    async renewIfDue() {
      if (conservativeDeadlineMonotonicMs - monotonicNowMs > 60_000) {
        return;
      }
      renewals += 1;
      conservativeDeadlineMonotonicMs = monotonicNowMs + 300_000;
      leaseExpiresAtMs = conservativeDeadlineMonotonicMs + 1_000;
    },
  };
  const connection: WorkerMainConnection = {
    sendEvents(events) {
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        acknowledgedMessageIds: events.map((event) => event.messageId),
      });
    },
    async sendHeartbeat() {},
  };
  const resolver = createTransportResolver<WorkerMainConnection>({
    probeTtlMs: 1_000,
    clock: { now: () => 1_000 },
    probe: () =>
      Promise.resolve({
        healthy: true,
        authenticated: true,
        peerDeviceId: "device-main",
      }),
    connect: () =>
      Promise.resolve({
        connected: true,
        authenticated: true,
        peerDeviceId: "device-main",
        connection,
      }),
  });
  const runtime = await WorkerRuntime.create({
    configuration: configuration(),
    repository,
    processFactory: { start: () => Promise.resolve(process) },
    clock: { now: () => 1_000 },
    delay: { wait: () => Promise.resolve() },
    transportResolver: resolver,
  });

  try {
    assert.equal(
      (await runtime.acceptAssignment(assignment({ leaseExpiresAtMs }), leaseAuthority))
        .disposition,
      "accepted",
    );
    assert.equal((await runtime.connect()).connected, true);

    monotonicNowMs = 240_000;
    assert.equal(await runtime.pulse(), true);
    monotonicNowMs = 480_000;
    assert.equal(await runtime.pulse(), true);
    assert.equal(renewals, 2);

    await runtime.markOffline();
    monotonicNowMs = 610_000;
    assert.equal(await runtime.pulse(), false);
    assert.equal(renewals, 2);
    assert.equal(process.cancelRequests, 0);

    monotonicNowMs = 780_000;
    assert.equal(await runtime.pulse(), false);
    assert.equal(renewals, 2);
    assert.equal(process.cancelRequests, 1);
    assert.equal(process.forcedTerminations, 1);
    assert.deepEqual(
      (await runtime.pendingOutbox()).map((event) => event.type),
      ["worker.run.failed"],
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unacknowledged events replay in sequence after disconnect and process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-"));
  const filename = join(directory, "worker.sqlite");
  const firstRepository = createSqliteWorkerStateRepository({ filename });
  const process = new DeferredRunProcess();
  const runtime = await WorkerRuntime.create({
    configuration: configuration(),
    repository: firstRepository,
    processFactory: { start: () => Promise.resolve(process) },
    clock: { now: () => 1_000 },
  });

  try {
    await runtime.acceptAssignment(assignment());
    const agentSession = {
      provider: "codex" as const,
      adapterId: "codex-app-server",
      adapterVersion: "0.89.0",
      nativeSessionId: "native-session-offline",
      workstreamId: "work-order-1",
      workspaceId: "workspace-product",
      lineage: {
        lineageId: "lineage-task-1",
      },
    };
    process.succeed("Completed while Main was offline.", undefined, agentSession);
    await waitFor(async () => (await runtime.pendingOutbox()).length === 2);

    const deliveredBeforeDisconnect: string[][] = [];
    const failingConnection: WorkerMainConnection = {
      sendEvents(events) {
        deliveredBeforeDisconnect.push(events.map((event) => event.messageId));
        return Promise.reject(new Error("connection reset after Main persisted the batch"));
      },
      sendHeartbeat: () => Promise.resolve(),
    };
    await assert.rejects(() => runtime.flushOutbox(failingConnection), /connection reset/);
    assert.deepEqual(deliveredBeforeDisconnect, [["run-1:claimed", "run-1:succeeded"]]);
    assert.equal((await runtime.pendingOutbox()).length, 2);
    await runtime.close();

    const reopened = await WorkerRuntime.create({
      configuration: configuration(),
      repository: createSqliteWorkerStateRepository({ filename }),
      processFactory: {
        start: () => Promise.reject(new Error("duplicate work must not start")),
      },
      clock: { now: () => 1_100 },
    });
    const replayed: string[][] = [];
    const replayedSessions: unknown[] = [];
    const replayConnection: WorkerMainConnection = {
      sendEvents(events) {
        replayed.push(events.map((event) => event.messageId));
        replayedSessions.push(events[1]?.payload.agentSession);
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          acknowledgedMessageIds: events.map((event) => event.messageId),
        });
      },
      sendHeartbeat: () => Promise.resolve(),
    };

    assert.equal(await reopened.flushOutbox(replayConnection), 2);
    assert.deepEqual(replayed, [["run-1:claimed", "run-1:succeeded"]]);
    assert.deepEqual(replayedSessions, [agentSession]);
    assert.deepEqual(await reopened.pendingOutbox(), []);
    assert.equal((await reopened.acceptAssignment(assignment())).disposition, "duplicate");
    await reopened.close();
  } finally {
    firstRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an acknowledged stale restart terminal cannot poison later replacement Run events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-stale-prefix-"));
  const filename = join(directory, "worker.sqlite");
  const firstProcess = new DeferredRunProcess();
  let first: WorkerRuntime | undefined;
  let restarted: WorkerRuntime | undefined;

  try {
    first = await WorkerRuntime.create({
      configuration: configuration(),
      repository: createSqliteWorkerStateRepository({ filename }),
      processFactory: { start: () => Promise.resolve(firstProcess) },
      clock: { now: () => 1_000 },
    });
    assert.equal((await first.acceptAssignment(assignment())).disposition, "accepted");
    assert.equal(
      await first.flushOutbox({
        sendEvents: (events) =>
          Promise.resolve({
            protocolVersion: PROTOCOL_VERSION,
            acknowledgedMessageIds: events.map((event) => event.messageId),
          }),
        sendHeartbeat: () => Promise.resolve(),
      }),
      1,
    );
    assert.deepEqual(await first.pendingOutbox(), []);
    await first.close();

    const replacementProcess = new DeferredRunProcess();
    restarted = await WorkerRuntime.create({
      configuration: configuration(),
      repository: createSqliteWorkerStateRepository({ filename }),
      processFactory: { start: () => Promise.resolve(replacementProcess) },
      clock: { now: () => 1_100 },
    });
    const replacement = {
      ...assignment({
        runId: "run-2",
        leaseId: "lease-2",
        fencingToken: 2,
        leaseExpiresAtMs: 3_000,
      }),
      messageId: "dispatch-message-2",
      idempotencyKey: "dispatch:run-2",
    };
    assert.equal((await restarted.acceptAssignment(replacement)).disposition, "accepted");
    replacementProcess.succeed("The replacement Run completed.");
    await waitFor(async () => (await restarted!.pendingOutbox()).length === 3);
    assert.deepEqual(
      (await restarted.pendingOutbox()).map((event) => event.type),
      ["worker.run.failed", "worker.run.claimed", "worker.run.succeeded"],
    );

    const delivered: string[][] = [];
    assert.equal(
      await restarted.flushOutbox({
        sendEvents(events) {
          delivered.push(events.map((event) => event.messageId));
          return Promise.resolve({
            protocolVersion: PROTOCOL_VERSION,
            acknowledgedMessageIds: events.map((event) => event.messageId),
          });
        },
        sendHeartbeat: () => Promise.resolve(),
      }),
      3,
    );
    assert.deepEqual(delivered, [["run-1:failed", "run-2:claimed", "run-2:succeeded"]]);
    assert.deepEqual(await restarted.pendingOutbox(), []);
  } finally {
    await restarted?.close();
    await first?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider usage is included in the durable terminal Worker event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-usage-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const process = new DeferredRunProcess();
  const runtime = await WorkerRuntime.create({
    configuration: configuration(),
    repository,
    processFactory: { start: () => Promise.resolve(process) },
    clock: { now: () => 1_000 },
  });

  try {
    await runtime.acceptAssignment(assignment());
    process.succeed("Completed with provider accounting.", {
      inputTokens: 120,
      outputTokens: 80,
      cachedInputTokens: 20,
      costUsdMicros: 4_200,
    });
    await waitFor(async () => (await runtime.pendingOutbox()).length === 2);

    const terminal = (await runtime.pendingOutbox())[1];
    assert.equal(terminal?.type, "worker.run.succeeded");
    assert.deepEqual(terminal?.payload.usage, {
      inputTokens: 120,
      outputTokens: 80,
      cachedInputTokens: 20,
      costUsdMicros: 4_200,
    });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("backpressure preserves terminal capacity while lifecycle and readiness stay independent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const process = new DeferredRunProcess();
  const constrainedConfiguration = { ...configuration(), maxOutboxEntries: 2 };
  const runtime = await WorkerRuntime.create({
    configuration: constrainedConfiguration,
    repository,
    processFactory: { start: () => Promise.resolve(process) },
    clock: { now: () => 1_000 },
    delay: { wait: () => Promise.resolve() },
    healthProvider: {
      snapshot: () => ({
        daemon: "healthy",
        session: "locked",
        desktop: "locked",
        permissions: {
          accessibility: "granted",
          input: "denied",
          screenCapture: "granted",
        },
      }),
    },
  });

  try {
    assert.equal((await runtime.acceptAssignment(assignment())).disposition, "accepted");
    const heartbeat = await runtime.heartbeat();
    assert.equal(heartbeat.operationalState, "active");
    assert.equal(heartbeat.connectionState, "offline");
    assert.equal(heartbeat.capacity.activeRuns, 1);
    assert.equal(heartbeat.capacity.acceptingWork, false);
    assert.deepEqual(heartbeat.currentRuns, [
      {
        taskId: "task-1",
        workOrderId: "work-order-1",
        runId: "run-1",
        state: "running",
        acceptedAtMs: 1_000,
        leaseExpiresAtMs: 2_000,
      },
    ]);
    assert.equal(JSON.stringify(heartbeat.currentRuns).includes("lease-1"), false);
    assert.equal(JSON.stringify(heartbeat.currentRuns).includes("fencingToken"), false);
    assert.deepEqual(heartbeat.readiness, {
      daemon: "healthy",
      session: "locked",
      desktop: "locked",
      permissions: {
        accessibility: "granted",
        input: "denied",
        screenCapture: "granted",
      },
    });

    const second = {
      ...assignment({
        workOrder: { ...WORK_ORDER, workOrderId: "work-order-2" },
        runId: "run-2",
        leaseId: "lease-2",
      }),
      messageId: "dispatch-message-2",
      idempotencyKey: "dispatch:run-2",
    } satisfies WorkerAssignmentMessageV1;
    assert.deepEqual(await runtime.acceptAssignment(second), {
      disposition: "rejected",
      runId: "run-2",
      reason: "backpressure",
    });
    assert.equal((await runtime.pendingOutbox()).length, 1);

    await runtime.setOperationalState("draining", "Finish current work without new claims.");
    assert.equal((await runtime.heartbeat()).operationalState, "draining");
    await runtime.markOffline();
    await runtime.setOperationalState("disabled", "Stop the Worker.");
    assert.equal(process.cancelRequests, 1);
    assert.equal(process.forcedTerminations, 1);
    assert.deepEqual(
      (await runtime.pendingOutbox()).map((event) => event.type),
      ["worker.run.claimed", "worker.run.cancelled"],
    );
    const disabledHeartbeat = await runtime.heartbeat();
    assert.equal(disabledHeartbeat.operationalState, "disabled");
    assert.equal(disabledHeartbeat.connectionState, "offline");

    await runtime.setOperationalState("revoked", "Device identity revoked.");
    await assert.rejects(
      () => runtime.setOperationalState("active", "Attempt to restore."),
      /cannot return to service/,
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("heartbeat publishes only bounded scheduling-safe Device inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-inventory-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  let cpuModel = "Example CPU";
  let cpuObservedAtMs = 900;
  const runtime = await WorkerRuntime.create({
    configuration: configuration(),
    repository,
    processFactory: { start: () => Promise.resolve(new DeferredRunProcess()) },
    clock: { now: () => 1_000 },
    delay: { wait: () => Promise.resolve() },
    inventoryProvider: {
      snapshot: async () => ({
        deviceName: "Build workstation",
        osFamily: "windows",
        platformRelease: "11",
        architecture: "x64",
        serviceMode: "foreground",
        knowledgeHealth: "healthy",
        hardware: {
          cpu: {
            model: cpuModel,
            logicalCoreCount: 16,
            observedAtMs: cpuObservedAtMs,
            source: "node-os",
            verification: "observed",
          },
          memory: {
            totalBytes: 68_719_476_736,
            observedAtMs: 900,
            source: "node-os",
            verification: "observed",
          },
          gpu: {
            devices: [],
            observedAtMs: 900,
            source: "node-os",
            verification: "not-observed",
          },
        },
        maximumConcurrentRuns: 4,
        capabilities: [
          {
            name: "codex",
            verification: "verified",
            observedAtMs: 900,
            evidenceSource: "agent-adapter",
            version: "1.2.3",
          },
          { name: "computer-use", verification: "degraded" },
        ],
        agentAdapters: [
          {
            provider: "codex",
            adapterId: "codex-cli",
            readiness: "ready",
            compatibility: "tested",
            version: "1.2.3",
            observedAtMs: 900,
          },
        ],
        resourceLocks: [
          {
            resourceName: "desktop-session",
            capacity: 1,
            holders: [],
          },
        ],
        workspaceIds: ["workspace-product"],
        availableSecretRefs: ["package-registry"],
      }),
    },
  });

  try {
    const heartbeat = await runtime.heartbeat();
    assert.deepEqual(heartbeat.inventory, {
      deviceName: "Build workstation",
      osFamily: "windows",
      platformRelease: "11",
      architecture: "x64",
      serviceMode: "foreground",
      knowledgeHealth: "healthy",
      hardware: {
        cpu: {
          model: "Example CPU",
          logicalCoreCount: 16,
          observedAtMs: 900,
          source: "node-os",
          verification: "observed",
        },
        memory: {
          totalBytes: 68_719_476_736,
          observedAtMs: 900,
          source: "node-os",
          verification: "observed",
        },
        gpu: {
          devices: [],
          observedAtMs: 900,
          source: "node-os",
          verification: "not-observed",
        },
      },
      maximumConcurrentRuns: 4,
      capabilities: [
        {
          name: "codex",
          verification: "verified",
          observedAtMs: 900,
          evidenceSource: "agent-adapter",
          version: "1.2.3",
        },
        { name: "computer-use", verification: "degraded" },
      ],
      agentAdapters: [
        {
          provider: "codex",
          adapterId: "codex-cli",
          readiness: "ready",
          compatibility: "tested",
          version: "1.2.3",
          observedAtMs: 900,
        },
      ],
      resourceLocks: [
        {
          resourceName: "desktop-session",
          capacity: 1,
          holders: [],
        },
      ],
      workspaceIds: ["workspace-product"],
      availableSecretRefs: ["package-registry"],
    });
    assert.equal(Object.isFrozen(heartbeat.inventory), true);
    assert.equal(Object.isFrozen(heartbeat.inventory?.capabilities), true);
    assert.deepEqual(
      heartbeat.routes?.map(({ label, priority, health }) => ({
        label,
        priority,
        health,
      })),
      [{ label: "Route 1", priority: 0, health: "unknown" }],
    );
    const serialized = JSON.stringify(heartbeat);
    for (const privateValue of [
      "route-main-wss",
      "Private Main route",
      "main.example.test",
      "device-certificate",
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }

    cpuModel = "/proc/cpuinfo";
    await assert.rejects(() => runtime.heartbeat(), /prohibited local or credential data/u);

    cpuModel = "Example CPU";
    cpuObservedAtMs = 1_001;
    await assert.rejects(
      () => runtime.heartbeat(),
      /cannot be newer than its enclosing heartbeat/u,
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease expiry fences stale retries and escalates cancellation before a higher-fenced Run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const firstProcess = new DeferredRunProcess();
  const secondProcess = new DeferredRunProcess();
  const processes = [firstProcess, secondProcess];
  let starts = 0;
  let now = 1_000;
  const runtime = await WorkerRuntime.create({
    configuration: configuration(),
    repository,
    processFactory: {
      start: () => Promise.resolve(processes[starts++] as DeferredRunProcess),
    },
    clock: { now: () => now },
    delay: { wait: () => Promise.resolve() },
  });

  try {
    assert.equal(
      (
        await runtime.acceptAssignment(
          assignment({
            leaseExpiresAtMs: 1_500,
          }),
        )
      ).disposition,
      "accepted",
    );
    now = 1_500;
    assert.deepEqual(await runtime.sweepExpiredRuns(), ["run-1"]);
    assert.equal(firstProcess.cancelRequests, 1);
    assert.equal(firstProcess.forcedTerminations, 1);

    const stale = {
      ...assignment({
        runId: "run-stale",
        leaseId: "lease-stale",
        leaseExpiresAtMs: 2_500,
      }),
      messageId: "dispatch-message-stale",
      idempotencyKey: "dispatch:run-stale",
    } satisfies WorkerAssignmentMessageV1;
    assert.deepEqual(await runtime.acceptAssignment(stale), {
      disposition: "rejected",
      runId: "run-stale",
      reason: "stale-fence",
    });

    const replacement = {
      ...assignment({
        runId: "run-2",
        leaseId: "lease-2",
        fencingToken: 2,
        leaseExpiresAtMs: 2_500,
      }),
      messageId: "dispatch-message-2",
      idempotencyKey: "dispatch:run-2",
    } satisfies WorkerAssignmentMessageV1;
    assert.equal((await runtime.acceptAssignment(replacement)).disposition, "accepted");
    assert.equal(starts, 2);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the outbound route resolver falls back deterministically and flushes before heartbeat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const process = new DeferredRunProcess();
  const sent: string[] = [];
  const ordering: string[] = [];
  let routeIncidentCount = 0;
  const connection: WorkerMainConnection = {
    sendEvents(events) {
      ordering.push("events");
      sent.push(...events.map((event) => event.messageId));
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        acknowledgedMessageIds: events.map((event) => event.messageId),
      });
    },
    sendHeartbeat(heartbeat) {
      ordering.push("heartbeat");
      assert.equal(heartbeat.connectionState, "online");
      return Promise.resolve();
    },
    sendRouteIncident() {
      routeIncidentCount += 1;
      return Promise.resolve();
    },
  };
  const routeConfiguration: WorkerConfiguration = {
    ...configuration(),
    transportProfile: {
      deviceId: "device-main",
      endpoints: [
        {
          endpointId: "route-main-lan",
          label: "LAN route",
          kind: "wss",
          url: "wss://main-lan.example.test/worker",
          credentialRef: "secret://device-certificate",
        },
        {
          endpointId: "route-main-tailnet",
          label: "Tailnet route",
          kind: "wss",
          url: "wss://main-tailnet.example.test/worker",
          credentialRef: "secret://device-certificate",
        },
      ],
    },
  };
  const resolver = createTransportResolver<WorkerMainConnection>({
    probeTtlMs: 1_000,
    clock: { now: () => 1_000 },
    probe(request) {
      return Promise.resolve(
        request.endpoint.endpointId === "route-main-lan"
          ? {
              healthy: false,
              authenticated: false,
              diagnostic: { code: "ECONNREFUSED", token: "must-not-leak" },
            }
          : {
              healthy: true,
              authenticated: true,
              peerDeviceId: "device-main",
            },
      );
    },
    connect: () =>
      Promise.resolve({
        connected: true,
        authenticated: true,
        peerDeviceId: "device-main",
        connection,
      }),
  });
  const runtime = await WorkerRuntime.create({
    configuration: routeConfiguration,
    repository,
    processFactory: { start: () => Promise.resolve(process) },
    clock: { now: () => 1_000 },
    transportResolver: resolver,
  });

  try {
    await runtime.acceptAssignment(
      assignment({
        routeId: "route-main-tailnet",
      }),
    );
    process.succeed();
    await waitFor(async () => (await runtime.pendingOutbox()).length === 2);

    assert.deepEqual(await runtime.connect(), {
      connected: true,
      endpointId: "route-main-tailnet",
      replayedEvents: 2,
    });
    assert.deepEqual(sent, ["run-1:claimed", "run-1:succeeded"]);
    assert.deepEqual(ordering, ["events", "heartbeat"]);
    assert.equal(routeIncidentCount, 0, "successful deterministic fallback must not escalate");
    const heartbeat = await runtime.heartbeat();
    assert.equal("routeAttempts" in heartbeat, false);
    assert.deepEqual(
      heartbeat.routes?.map((route) => ({
        label: route.label,
        priority: route.priority,
        health: route.health,
        outcome: route.lastAttempt?.outcome,
      })),
      [
        { label: "Route 1", priority: 0, health: "unknown", outcome: undefined },
        { label: "Route 2", priority: 1, health: "healthy", outcome: "connected" },
      ],
    );
    const serialized = JSON.stringify(heartbeat.routes);
    for (const privateValue of [
      "route-main-lan",
      "route-main-tailnet",
      "LAN route",
      "Tailnet route",
      "main-lan.example.test",
      "main-tailnet.example.test",
      "device-certificate",
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("route exhaustion remains offline and exposes only sanitized evidence for escalation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const resolver = createTransportResolver<WorkerMainConnection>({
    probeTtlMs: 1_000,
    clock: { now: () => 1_000 },
    probe: () =>
      Promise.resolve({
        healthy: false,
        authenticated: false,
        diagnostic: {
          code: "ETIMEDOUT",
          retryable: true,
          token: "must-not-leak",
          url: "wss://owner:password@main.example.test/worker",
        },
      }),
    connect: () => Promise.reject(new Error("must not connect after an unhealthy probe")),
  });
  const runtime = await WorkerRuntime.create({
    configuration: configuration(),
    repository,
    processFactory: {
      start: () => Promise.reject(new Error("no Run expected")),
    },
    clock: { now: () => 1_000 },
    transportResolver: resolver,
  });

  try {
    const result = await runtime.connect();
    assert.equal(result.connected, false);
    assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(result).includes("password"), false);
    assert.equal((await runtime.heartbeat()).connectionState, "offline");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("route exhaustion survives restart, replays once on authenticated recovery, and recurs after resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-route-incident-"));
  const filename = join(directory, "worker.sqlite");
  const attempts: readonly TransportAttemptTrace[] = [
    {
      endpointId: "route-main-wss",
      label: "secret internal route label",
      kind: "wss",
      probeSource: "live",
      outcome: "connect-failed",
      failureStage: "connect",
      diagnostic: {
        code: "ETIMEDOUT",
        retryable: true,
        status: 503,
        url: "wss://owner:password@private-main.example.test:8443/worker",
        credentialRef: "secret://device-certificate",
        stack: "C:\\private\\route.ts:10",
      },
    },
  ];
  let shouldConnect = false;
  let connection: WorkerMainConnection | undefined;
  const resolver: TransportResolver<WorkerMainConnection> = {
    connect() {
      if (!shouldConnect || connection === undefined) {
        return Promise.reject(new TransportRoutesExhaustedError("device-main", attempts));
      }
      return Promise.resolve({
        deviceId: "device-main",
        endpointId: "route-main-wss",
        kind: "wss",
        connection,
        attemptTrace: [
          {
            endpointId: "route-main-wss",
            label: "secret internal route label",
            kind: "wss",
            probeSource: "live",
            outcome: "connected",
          },
        ],
      });
    },
  };
  const delivered: WorkerRouteIncidentV1[] = [];
  const makeConnection = (): WorkerMainConnection => ({
    sendEvents: () =>
      Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        acknowledgedMessageIds: [],
      }),
    sendHeartbeat: () => Promise.resolve(),
    sendRouteIncident(incident) {
      delivered.push(structuredClone(incident));
      return Promise.resolve();
    },
  });
  let now = 1_000;
  const firstRepository = createSqliteWorkerStateRepository({ filename });
  const first = await WorkerRuntime.create({
    configuration: configuration(),
    repository: firstRepository,
    processFactory: { start: () => Promise.reject(new Error("no Run expected")) },
    clock: { now: () => now },
    transportResolver: resolver,
  });

  try {
    assert.equal((await first.connect()).connected, false);
    assert.equal((await first.connect()).connected, false);
    assert.equal(delivered.length, 0);
    await first.close();

    now = 2_000;
    shouldConnect = true;
    connection = makeConnection();
    const secondRepository = createSqliteWorkerStateRepository({ filename });
    const second = await WorkerRuntime.create({
      configuration: configuration(),
      repository: secondRepository,
      processFactory: { start: () => Promise.reject(new Error("no Run expected")) },
      clock: { now: () => now },
      transportResolver: resolver,
    });
    assert.equal((await second.connect()).connected, true);
    assert.equal(delivered.length, 1);
    const firstIncident = delivered[0]!;
    assert.deepEqual(firstIncident.attempts, [
      {
        attemptIndex: 0,
        kind: "wss",
        outcome: "connect-failed",
        code: "ETIMEDOUT",
      },
    ]);
    const serialized = JSON.stringify(firstIncident);
    for (const forbidden of [
      "secret internal route label",
      "private-main",
      "8443",
      "password",
      "credential",
      "private\\\\route",
      "503",
      "retryable",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }

    await second.markOffline();
    now = 3_000;
    shouldConnect = false;
    assert.equal((await second.connect()).connected, false);
    now = 4_000;
    shouldConnect = true;
    assert.equal((await second.connect()).connected, true);
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1]?.fingerprint, firstIncident.fingerprint);
    assert.notEqual(delivered[1]?.incidentId, firstIncident.incidentId);
    await second.close();

    const thirdRepository = createSqliteWorkerStateRepository({ filename });
    connection = makeConnection();
    const third = await WorkerRuntime.create({
      configuration: configuration(),
      repository: thirdRepository,
      processFactory: { start: () => Promise.reject(new Error("no Run expected")) },
      clock: { now: () => 5_000 },
      transportResolver: resolver,
    });
    assert.equal((await third.connect()).connected, true);
    assert.equal(delivered.length, 2, "acknowledged local incidents must not be re-enqueued");
    await third.close();
  } finally {
    firstRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a disable racing child startup still terminates the child before it can run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const process = new DeferredRunProcess();
  let resolveStart!: (process: RunProcess) => void;
  let notifyStartCalled!: () => void;
  const startCalled = new Promise<void>((resolve) => {
    notifyStartCalled = resolve;
  });
  const pendingStart = new Promise<RunProcess>((resolve) => {
    resolveStart = resolve;
  });
  const runtime = await WorkerRuntime.create({
    configuration: configuration(),
    repository,
    processFactory: {
      start() {
        notifyStartCalled();
        return pendingStart;
      },
    },
    clock: { now: () => 1_000 },
    delay: { wait: () => Promise.resolve() },
  });

  try {
    const acceptance = runtime.acceptAssignment(assignment());
    await startCalled;
    await runtime.setOperationalState("disabled", "Disable during process startup.");
    resolveStart(process);
    assert.equal((await acceptance).disposition, "accepted");
    assert.equal(process.cancelRequests, 1);
    assert.equal(process.forcedTerminations, 1);
    assert.deepEqual(
      (await runtime.pendingOutbox()).map((event) => event.type),
      ["worker.run.claimed", "worker.run.cancelled"],
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
