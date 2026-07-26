import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkerRunSteeringCommandV1 } from "@opendelegate/device-channel";
import type { WorkerRunDispatchPort } from "@opendelegate/task-service";

import { MainDeviceChannelWorkerRunDispatchPort } from "../src/device-worker-dispatch.ts";

type WorkerRunAssignment = Parameters<WorkerRunDispatchPort["enqueue"]>[0]["assignment"];

test("Worker dispatch uses the Run identity as the durable Device-channel command", async () => {
  const channel = new RecordingDeviceChannel();
  const adapter = new MainDeviceChannelWorkerRunDispatchPort(channel);
  const run = assignment();

  await adapter.enqueue({
    idempotencyKey: "dispatch:run-1",
    assignment: run,
  });

  assert.deepEqual(channel.dispatches, [
    {
      assignment: run,
      correlationId: "task-1",
      deviceId: "device-1",
      idempotencyKey: "dispatch:run-1",
    },
  ]);
});

test("Worker cancellation preserves the current lease and fencing identity", async () => {
  const channel = new RecordingDeviceChannel();
  const adapter = new MainDeviceChannelWorkerRunDispatchPort(channel);
  const run = assignment();

  await adapter.cancel({
    idempotencyKey: "cancel:run-1:7",
    assignment: run,
    reason: "coordinator-closed",
  });

  assert.deepEqual(channel.controls, [
    {
      control: {
        action: "cancel",
        fencingToken: 7,
        leaseId: "lease-1",
        reason: "coordinator-closed",
        runId: "run-1",
      },
      correlationId: "task-1",
      deviceId: "device-1",
      idempotencyKey: "cancel:run-1:7",
    },
  ]);
});

test("Worker steering preserves the exact Run and safe native-session scope", async () => {
  const channel = new RecordingDeviceChannel();
  const adapter = new MainDeviceChannelWorkerRunDispatchPort(channel);
  const run = assignment();
  const command: WorkerRunSteeringCommandV1 = {
    requestId: "steer-request-1",
    taskId: run.taskId,
    workOrderId: run.workOrder.workOrderId,
    deviceId: run.deviceId,
    workerId: run.workerId,
    routeId: run.routeId,
    runId: run.runId,
    leaseId: run.leaseId,
    fencingToken: run.fencingToken,
    instruction: "Also verify the release manifest.",
    requestedBy: "main-agent",
    agentSession: {
      provider: "codex",
      adapterId: "codex-app-server",
      adapterVersion: "0.145.0",
      nativeSessionId: "thread-1",
      workstreamId: "implementation",
      workspaceId: "workspace-1",
      lineage: {
        lineageId: "lineage-1",
      },
    },
  };

  await adapter.steer(command);

  assert.deepEqual(channel.steering, [{ deviceId: "device-1", command }]);
  assert.equal(JSON.stringify(channel.steering).includes("sessionKey"), false);
});

function assignment(): WorkerRunAssignment {
  return {
    taskId: "task-1",
    workOrder: {
      protocolVersion: "v1",
      workOrderId: "work-order-1",
      title: "Build",
      brief: "Build the project.",
      completionCriteria: ["The build succeeds."],
      constraints: [],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: {
        preferredDeviceIds: ["device-1"],
        preferredRoles: ["coding"],
      },
      requiredCapabilities: ["coding"],
      requiredSecretRefs: [],
    },
    deviceId: "device-1",
    workerId: "worker-1",
    routeId: "route-1",
    runId: "run-1",
    leaseId: "lease-1",
    fencingToken: 7,
    leaseExpiresAtMs: 10_000,
  };
}

class RecordingDeviceChannel {
  public readonly dispatches: unknown[] = [];
  public readonly controls: unknown[] = [];
  public readonly steering: unknown[] = [];

  public async dispatch(
    deviceId: string,
    run: WorkerRunAssignment,
    correlationId?: string,
    idempotencyKey?: string,
  ): Promise<void> {
    this.dispatches.push({
      assignment: run,
      correlationId,
      deviceId,
      idempotencyKey,
    });
  }

  public async control(
    deviceId: string,
    control: {
      readonly action: "cancel";
      readonly reason: string;
      readonly runId: string;
      readonly leaseId: string;
      readonly fencingToken: number;
    },
    correlationId?: string,
    idempotencyKey?: string,
  ): Promise<void> {
    this.controls.push({
      control,
      correlationId,
      deviceId,
      idempotencyKey,
    });
  }

  public async steerRun(deviceId: string, command: WorkerRunSteeringCommandV1): Promise<void> {
    this.steering.push({ deviceId, command });
  }
}
