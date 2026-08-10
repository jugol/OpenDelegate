import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import {
  DeviceChannelRepositoryError,
  SqliteDeviceChannelRepository,
  type MainDispatchFrameV1,
  type MainPingFrameV1,
  type MainRunSteerFrameV1,
  type WorkerPongFrameV1,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("SQLite channel state durably replays, acknowledges, and rejects gaps or changed duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-channel-repository-"));
  roots.push(root);
  const filename = join(root, "channel.sqlite3");
  let repository = await SqliteDeviceChannelRepository.open({
    filename,
    sourceCheckoutRoot: process.cwd(),
  });

  await repository.observeConnection({
    certificateGeneration: 1,
    deviceId: "device-worker-1",
  });
  assert.deepEqual(await repository.commitInbound(workerPong(1)), {
    disposition: "accepted",
    acknowledgedWorkerSequence: 0,
  });
  assert.deepEqual(await repository.commitInbound(workerPong(1)), {
    disposition: "duplicate",
    acknowledgedWorkerSequence: 0,
  });
  assert.deepEqual(await repository.claimInboundEffect(workerPong(1), "claim-failed"), {
    disposition: "claimed",
    acknowledgedSequence: 0,
  });
  await repository.releaseInboundEffect(workerPong(1), "claim-failed");
  assert.deepEqual(await repository.claimInboundEffect(workerPong(1), "claim-complete"), {
    disposition: "claimed",
    acknowledgedSequence: 0,
  });
  assert.deepEqual(await repository.completeInboundEffect(workerPong(1), "claim-complete"), {
    acknowledgedSequence: 1,
  });
  assert.deepEqual(await repository.commitInbound(workerPong(1)), {
    disposition: "duplicate",
    acknowledgedWorkerSequence: 1,
  });
  await assert.rejects(
    repository.commitInbound({ ...workerPong(1), payload: { pingId: "changed", observedAtMs: 2 } }),
    isRepositoryError("CHANNEL_IDEMPOTENCY_CONFLICT"),
  );
  await assert.rejects(
    repository.commitInbound({
      ...workerPong(2),
      messageId: "worker-pong-1",
    }),
    isRepositoryError("CHANNEL_IDEMPOTENCY_CONFLICT"),
  );
  await assert.rejects(
    repository.commitInbound({
      ...workerPong(2),
      idempotencyKey: "worker-pong-1",
    }),
    isRepositoryError("CHANNEL_IDEMPOTENCY_CONFLICT"),
  );
  await assert.rejects(
    repository.commitInbound(workerPong(3)),
    isRepositoryError("CHANNEL_SEQUENCE_GAP"),
  );

  const first = await repository.enqueueOutbound("device-worker-1", (sequence) =>
    mainPing(sequence, "ping-1"),
  );
  const second = await repository.enqueueOutbound("device-worker-1", (sequence) =>
    mainPing(sequence, "ping-2"),
  );
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  await repository.close();

  repository = await SqliteDeviceChannelRepository.open({
    filename,
    sourceCheckoutRoot: process.cwd(),
  });
  assert.deepEqual(
    (await repository.resume("device-worker-1")).pendingOutbound.map((frame) => frame.messageId),
    ["main-ping-1", "main-ping-2"],
  );
  await repository.acknowledgeOutbound({
    acknowledgedMainSequence: 1,
    acknowledgedMessageIds: ["main-ping-1"],
    deviceId: "device-worker-1",
  });
  assert.deepEqual(
    (await repository.resume("device-worker-1")).pendingOutbound.map((frame) => frame.messageId),
    ["main-ping-2"],
  );
  await assert.rejects(
    repository.acknowledgeOutbound({
      acknowledgedMainSequence: 2,
      acknowledgedMessageIds: ["wrong-message"],
      deviceId: "device-worker-1",
    }),
    isRepositoryError("CHANNEL_ACK_INVALID"),
  );
  await repository.acknowledgeOutbound({
    acknowledgedMainSequence: 2,
    acknowledgedMessageIds: ["main-ping-2"],
    deviceId: "device-worker-1",
  });
  assert.deepEqual((await repository.resume("device-worker-1")).pendingOutbound, []);
  const dispatch = await repository.enqueueOutbound("device-worker-1", (sequence) =>
    mainDispatch(sequence),
  );
  await repository.acknowledgeOutbound({
    acknowledgedMainSequence: dispatch.sequence,
    acknowledgedMessageIds: [dispatch.messageId],
    deviceId: "device-worker-1",
  });
  assert.deepEqual(
    await repository.outboundByIdempotencyKey("device-worker-1", "dispatch:run-1"),
    dispatch,
  );
  const steering = await repository.enqueueOutbound("device-worker-1", (sequence) =>
    mainRunSteering(sequence),
  );
  await repository.acknowledgeOutbound({
    acknowledgedMainSequence: steering.sequence,
    acknowledgedMessageIds: [steering.messageId],
    deviceId: "device-worker-1",
  });
  assert.deepEqual(
    await repository.outboundByIdempotencyKey("device-worker-1", steering.idempotencyKey),
    steering,
  );
  assert.equal(
    await repository.outboundByIdempotencyKey("device-worker-1", "main-ping-1"),
    undefined,
  );
  await repository.acknowledgeOutbound({
    acknowledgedMainSequence: 1,
    acknowledgedMessageIds: [],
    deviceId: "device-worker-1",
  });
  await repository.close();
});

test("SQLite Main channel starts one fresh epoch only for a newer re-credentialed generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-recredential-"));
  roots.push(root);
  const repository = await SqliteDeviceChannelRepository.open({
    filename: join(root, "channel.sqlite3"),
    sourceCheckoutRoot: process.cwd(),
  });
  try {
    await repository.observeConnection({ certificateGeneration: 1, deviceId: "device-worker-1" });
    await repository.commitInbound(workerPong(1));
    await repository.enqueueOutbound("device-worker-1", (sequence) =>
      mainPing(sequence, "before-recredential"),
    );

    await repository.observeConnection({ certificateGeneration: 2, deviceId: "device-worker-1" });
    assert.equal(
      (await repository.resume("device-worker-1")).nextMainSequence,
      2,
      "routine rotation preserves transport durability",
    );

    await repository.observeConnection({
      certificateGeneration: 3,
      deviceId: "device-worker-1",
      resetForRecredential: true,
    });
    assert.deepEqual(await repository.resume("device-worker-1"), {
      acknowledgedWorkerSequence: 0,
      acknowledgedMainSequence: 0,
      nextMainSequence: 1,
      pendingOutbound: [],
    });
    await repository.commitInbound(workerPong(1));
    await repository.enqueueOutbound("device-worker-1", (sequence) =>
      mainPing(sequence, "after-recredential"),
    );

    await repository.observeConnection({
      certificateGeneration: 3,
      deviceId: "device-worker-1",
      resetForRecredential: true,
    });
    assert.deepEqual(
      (await repository.resume("device-worker-1")).pendingOutbound.map((frame) => frame.messageId),
      ["main-after-recredential"],
      "the durable audit flag must not reset an already-established generation twice",
    );
  } finally {
    await repository.close();
  }
});

test("SQLite channel effect claims recover interrupted processing after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-channel-effect-"));
  roots.push(root);
  const filename = join(root, "channel.sqlite3");
  let repository = await SqliteDeviceChannelRepository.open({
    filename,
    sourceCheckoutRoot: process.cwd(),
  });

  await repository.observeConnection({
    certificateGeneration: 1,
    deviceId: "device-worker-1",
  });
  await repository.commitInbound(workerPong(1));
  assert.deepEqual(await repository.claimInboundEffect(workerPong(1), "claim-before-crash"), {
    disposition: "claimed",
    acknowledgedSequence: 0,
  });
  await repository.close();

  repository = await SqliteDeviceChannelRepository.open({
    filename,
    sourceCheckoutRoot: process.cwd(),
  });
  assert.equal((await repository.resume("device-worker-1")).acknowledgedWorkerSequence, 0);
  assert.deepEqual(await repository.claimInboundEffect(workerPong(1), "claim-after-restart"), {
    disposition: "claimed",
    acknowledgedSequence: 0,
  });
  assert.deepEqual(await repository.completeInboundEffect(workerPong(1), "claim-after-restart"), {
    acknowledgedSequence: 1,
  });
  assert.deepEqual(await repository.claimInboundEffect(workerPong(1), "claim-duplicate"), {
    disposition: "handled",
    acknowledgedSequence: 1,
  });
  await repository.close();
});

test("SQLite channel upgrades the legacy inbox without repeating accepted work", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-channel-legacy-effect-"));
  roots.push(root);
  const filename = join(root, "channel.sqlite3");
  let repository = await SqliteDeviceChannelRepository.open({
    filename,
    sourceCheckoutRoot: process.cwd(),
  });
  await repository.observeConnection({
    certificateGeneration: 1,
    deviceId: "device-worker-1",
  });
  await repository.commitInbound(workerPong(1));
  await repository.close();

  const legacy = new Database(filename);
  try {
    legacy.exec("DROP TABLE od_device_channel_inbound_effect");
  } finally {
    legacy.close();
  }

  repository = await SqliteDeviceChannelRepository.open({
    filename,
    sourceCheckoutRoot: process.cwd(),
  });
  assert.equal((await repository.resume("device-worker-1")).acknowledgedWorkerSequence, 1);
  assert.deepEqual(await repository.claimInboundEffect(workerPong(1), "claim-after-upgrade"), {
    disposition: "handled",
    acknowledgedSequence: 1,
  });
  await repository.close();
});

function workerPong(sequence: number): WorkerPongFrameV1 {
  return {
    protocolVersion: "v1",
    messageId: `worker-pong-${sequence}`,
    senderDeviceId: "device-worker-1",
    correlationId: "connection-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    idempotencyKey: `worker-pong-${sequence}`,
    sequence,
    type: "worker.pong",
    payload: {
      pingId: `ping-${sequence}`,
      observedAtMs: sequence,
    },
  };
}

function mainPing(sequence: number, pingId: string): MainPingFrameV1 {
  return {
    protocolVersion: "v1",
    messageId: `main-${pingId}`,
    senderDeviceId: "device-main-1",
    correlationId: "connection-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    idempotencyKey: `main-${pingId}`,
    sequence,
    type: "main.ping",
    payload: {
      pingId,
      deadlineAtMs: 1_900_000_000_000,
    },
  };
}

function mainDispatch(sequence: number): MainDispatchFrameV1 {
  return {
    protocolVersion: "v1",
    messageId: "dispatch:run-1",
    senderDeviceId: "device-main-1",
    correlationId: "task-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    idempotencyKey: "dispatch:run-1",
    sequence,
    type: "main.dispatch",
    payload: {
      taskId: "task-1",
      workOrder: {
        protocolVersion: "v1",
        workOrderId: "work-order-1",
        title: "Run the assignment",
        brief: "Produce the observable result.",
        completionCriteria: ["The result is reported."],
        constraints: [],
        selectedInputIds: [],
        dependsOn: [],
        schedulingHints: {
          preferredDeviceIds: [],
          preferredRoles: [],
        },
        requiredCapabilities: [],
        requiredSecretRefs: [],
      },
      deviceId: "device-worker-1",
      workerId: "worker-1",
      routeId: "route-1",
      runId: "run-1",
      leaseId: "lease-1",
      fencingToken: 1,
      leaseExpiresAtMs: 1_900_000_000_000,
    },
  };
}

function mainRunSteering(sequence: number): MainRunSteerFrameV1 {
  return {
    protocolVersion: "v1",
    messageId: "steer-request-1",
    senderDeviceId: "device-main-1",
    correlationId: "task-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    idempotencyKey: "steer-request-1",
    sequence,
    type: "main.run.steer",
    payload: {
      requestId: "steer-request-1",
      taskId: "task-1",
      workOrderId: "work-order-1",
      deviceId: "device-worker-1",
      workerId: "worker-1",
      routeId: "route-1",
      runId: "run-1",
      leaseId: "lease-1",
      fencingToken: 1,
      instruction: "Include the final checksum.",
      requestedBy: "owner",
      agentSession: {
        provider: "codex",
        adapterId: "codex-app-server",
        adapterVersion: "0.1.0",
        nativeSessionId: "native-session-1",
        workstreamId: "workstream-1",
        workspaceId: "workspace-1",
        lineage: {
          lineageId: "lineage-1",
        },
      },
    },
  };
}

function isRepositoryError(code: DeviceChannelRepositoryError["code"]) {
  return (error: unknown): boolean =>
    error instanceof DeviceChannelRepositoryError && error.code === code;
}
