import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROTOCOL_VERSION, type WorkOrderV1 } from "@opendelegate/protocol";
import { createTransportResolver } from "@opendelegate/transport";

import {
  WorkerRuntime,
  createSqliteWorkerStateRepository,
  type RunProcess,
  type RunProcessFactory,
  type WorkerAssignmentMessageV1,
  type WorkerConfiguration,
  type WorkerMainConnection,
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
  public readonly completion: Promise<{
    readonly status: "succeeded";
    readonly report: string;
    readonly artifactIds: readonly string[];
  }>;
  public cancelRequests = 0;
  public forcedTerminations = 0;
  private resolveCompletion!: (result: {
    readonly status: "succeeded";
    readonly report: string;
    readonly artifactIds: readonly string[];
  }) => void;

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

  public succeed(report = "Repository inspected."): void {
    this.resolveCompletion({
      status: "succeeded",
      report,
      artifactIds: [],
    });
  }
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

test("a concurrent duplicate dispatch starts exactly one Run and survives repository restart", async () => {
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
      first.acceptAssignment(assignment()),
      second.acceptAssignment(assignment()),
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

    const replay = await reopened.acceptAssignment(assignment());
    assert.equal(replay.disposition, "duplicate");
    assert.equal(starts, 1);
    assert.deepEqual(
      (await reopened.pendingOutbox()).map((event) => event.type),
      ["worker.run.claimed", "worker.run.failed"],
    );

    await reopened.close();
  } finally {
    firstRepository.close();
    secondRepository.close();
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
    process.succeed("Completed while Main was offline.");
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
    const replayConnection: WorkerMainConnection = {
      sendEvents(events) {
        replayed.push(events.map((event) => event.messageId));
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          acknowledgedMessageIds: events.map((event) => event.messageId),
        });
      },
      sendHeartbeat: () => Promise.resolve(),
    };

    assert.equal(await reopened.flushOutbox(replayConnection), 2);
    assert.deepEqual(replayed, [["run-1:claimed", "run-1:succeeded"]]);
    assert.deepEqual(await reopened.pendingOutbox(), []);
    assert.equal((await reopened.acceptAssignment(assignment())).disposition, "duplicate");
    await reopened.close();
  } finally {
    firstRepository.close();
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
    const heartbeat = await runtime.heartbeat();
    assert.equal(heartbeat.routeAttempts?.[0]?.outcome, "probe-unhealthy");
    assert.equal(JSON.stringify(heartbeat.routeAttempts).includes("must-not-leak"), false);
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
