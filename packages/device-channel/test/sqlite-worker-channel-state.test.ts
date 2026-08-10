import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PROTOCOL_VERSION, type WorkOrderV1 } from "@opendelegate/protocol";
import Database from "better-sqlite3";

import {
  SqliteWorkerChannelState,
  type MainDispatchFrameV1,
  type WorkerHeartbeatFrameV1,
} from "../src/index.ts";

test("Worker channel state durably sequences, replays, and de-duplicates authenticated frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-channel-"));
  const filename = join(directory, "channel.sqlite");
  const sourceCheckoutRoot = process.cwd();
  let state: SqliteWorkerChannelState | undefined;
  try {
    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 1,
      filename,
      sourceCheckoutRoot,
    });
    const heartbeat = await state.enqueueOutbound((sequence) =>
      workerHeartbeat(sequence, "heartbeat-1"),
    );
    assert.equal(heartbeat.sequence, 1);
    assert.deepEqual(await state.commitInbound(mainDispatch(1, "dispatch-1")), {
      disposition: "accepted",
      acknowledgedMainSequence: 0,
    });
    assert.equal(
      (await state.commitInbound(mainDispatch(1, "dispatch-1"))).disposition,
      "duplicate",
    );
    assert.deepEqual(
      await state.claimInboundEffect(mainDispatch(1, "dispatch-1"), "claim-failed"),
      {
        disposition: "claimed",
        acknowledgedSequence: 0,
      },
    );
    await state.releaseInboundEffect(mainDispatch(1, "dispatch-1"), "claim-failed");
    assert.deepEqual(
      await state.claimInboundEffect(mainDispatch(1, "dispatch-1"), "claim-complete"),
      {
        disposition: "claimed",
        acknowledgedSequence: 0,
      },
    );
    assert.deepEqual(
      await state.completeInboundEffect(mainDispatch(1, "dispatch-1"), "claim-complete"),
      {
        acknowledgedSequence: 1,
      },
    );
    await state.close();
    state = undefined;

    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 1,
      filename,
      sourceCheckoutRoot,
    });
    const resume = await state.resume();
    assert.equal(resume.acknowledgedMainSequence, 1);
    assert.equal(resume.acknowledgedWorkerSequence, 0);
    assert.deepEqual(
      resume.pendingOutbound.map((frame) => frame.messageId),
      ["heartbeat-1"],
    );

    await assert.rejects(state.commitInbound(mainDispatch(3, "dispatch-gap")), /sequence/i);
    await assert.rejects(state.commitInbound(mainDispatch(1, "dispatch-changed")), /identity/i);
    await state.acknowledgeOutbound(1);
    assert.deepEqual((await state.resume()).pendingOutbound, []);
    await state.close();
    state = undefined;
  } finally {
    await state?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Worker re-credentialing starts one fresh transport epoch while rotation preserves state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-recredential-"));
  const filename = join(directory, "channel.sqlite");
  const sourceCheckoutRoot = process.cwd();
  let state: SqliteWorkerChannelState | undefined;
  try {
    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 1,
      filename,
      sourceCheckoutRoot,
    });
    await state.enqueueOutbound((sequence) => workerHeartbeat(sequence, "before-recredential"));
    await state.commitInbound(mainDispatch(1, "before-recredential"));
    await state.close();
    state = undefined;

    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 2,
      filename,
      sourceCheckoutRoot,
    });
    assert.equal((await state.resume()).nextWorkerSequence, 2, "routine rotation preserves state");
    await state.close();
    state = undefined;

    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 3,
      resetForRecredential: true,
      filename,
      sourceCheckoutRoot,
    });
    assert.deepEqual(await state.resume(), {
      acknowledgedMainSequence: 0,
      acknowledgedWorkerSequence: 0,
      nextWorkerSequence: 1,
      pendingOutbound: [],
    });
    await state.enqueueOutbound((sequence) => workerHeartbeat(sequence, "after-recredential"));
    await state.close();
    state = undefined;

    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 3,
      resetForRecredential: true,
      filename,
      sourceCheckoutRoot,
    });
    assert.deepEqual(
      (await state.resume()).pendingOutbound.map((frame) => frame.messageId),
      ["after-recredential"],
      "reconnecting at the same generation must not repeat the epoch reset",
    );
  } finally {
    await state?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Worker channel effect claims recover interrupted processing after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-effect-"));
  const filename = join(directory, "channel.sqlite");
  const sourceCheckoutRoot = process.cwd();
  let state: SqliteWorkerChannelState | undefined;
  try {
    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 1,
      filename,
      sourceCheckoutRoot,
    });
    await state.commitInbound(mainDispatch(1, "dispatch-1"));
    assert.deepEqual(
      await state.claimInboundEffect(mainDispatch(1, "dispatch-1"), "claim-before-crash"),
      {
        disposition: "claimed",
        acknowledgedSequence: 0,
      },
    );
    await state.close();
    state = undefined;

    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 1,
      filename,
      sourceCheckoutRoot,
    });
    assert.equal((await state.resume()).acknowledgedMainSequence, 0);
    assert.deepEqual(
      await state.claimInboundEffect(mainDispatch(1, "dispatch-1"), "claim-after-restart"),
      {
        disposition: "claimed",
        acknowledgedSequence: 0,
      },
    );
    assert.deepEqual(
      await state.completeInboundEffect(mainDispatch(1, "dispatch-1"), "claim-after-restart"),
      {
        acknowledgedSequence: 1,
      },
    );
    assert.deepEqual(
      await state.claimInboundEffect(mainDispatch(1, "dispatch-1"), "claim-duplicate"),
      {
        disposition: "handled",
        acknowledgedSequence: 1,
      },
    );
  } finally {
    await state?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Worker channel upgrades the legacy inbox without repeating accepted work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-legacy-effect-"));
  const filename = join(directory, "channel.sqlite");
  const sourceCheckoutRoot = process.cwd();
  let state: SqliteWorkerChannelState | undefined;
  try {
    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 1,
      filename,
      sourceCheckoutRoot,
    });
    await state.commitInbound(mainDispatch(1, "dispatch-1"));
    await state.close();
    state = undefined;

    const legacy = new Database(filename);
    try {
      legacy.exec("DROP TABLE od_worker_channel_inbound_effect");
    } finally {
      legacy.close();
    }

    state = await SqliteWorkerChannelState.open({
      deviceId: "worker-1",
      mainDeviceId: "main-1",
      certificateGeneration: 1,
      filename,
      sourceCheckoutRoot,
    });
    assert.equal((await state.resume()).acknowledgedMainSequence, 1);
    assert.deepEqual(
      await state.claimInboundEffect(mainDispatch(1, "dispatch-1"), "claim-after-upgrade"),
      {
        disposition: "handled",
        acknowledgedSequence: 1,
      },
    );
  } finally {
    await state?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

function workerHeartbeat(sequence: number, messageId: string): WorkerHeartbeatFrameV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId,
    senderDeviceId: "worker-1",
    correlationId: messageId,
    createdAt: "2026-07-25T00:00:00.000Z",
    idempotencyKey: messageId,
    sequence,
    type: "worker.heartbeat",
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "worker-1",
      workerId: "worker-runtime-1",
      observedAtMs: 1,
      operationalState: "active",
      connectionState: "online",
      readiness: {
        daemon: "healthy",
        session: "ready",
        desktop: "available",
        permissions: {
          accessibility: "granted",
          input: "granted",
          screenCapture: "granted",
        },
      },
      capacity: {
        acceptingWork: true,
        activeRuns: 0,
        maxOutboxEntries: 100,
        outboxDepth: 0,
      },
    },
  };
}

function mainDispatch(sequence: number, messageId: string): MainDispatchFrameV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId,
    senderDeviceId: "main-1",
    correlationId: messageId,
    createdAt: "2026-07-25T00:00:00.000Z",
    idempotencyKey: messageId,
    sequence,
    type: "main.dispatch",
    payload: {
      taskId: "task-1",
      workOrder: {
        protocolVersion: PROTOCOL_VERSION,
        workOrderId: "order-1",
        title: "Compile",
        brief: "Compile the project.",
        completionCriteria: ["Return a report."],
        constraints: [],
        selectedInputIds: [],
        dependsOn: [],
        schedulingHints: {
          preferredDeviceIds: ["worker-1"],
          preferredRoles: ["coding"],
        },
        requiredCapabilities: ["coding"],
        requiredSecretRefs: [],
      } satisfies WorkOrderV1,
      deviceId: "worker-1",
      workerId: "worker-runtime-1",
      routeId: "route-1",
      runId: "run-1",
      leaseId: "lease-1",
      fencingToken: 1,
      leaseExpiresAtMs: 2_000_000_000_000,
    },
  };
}
