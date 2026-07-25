import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventStore } from "@opendelegate/event-store";
import {
  PROTOCOL_VERSION,
  TASK_CONTINUATION_CHECKPOINT_MAX_BYTES,
  serializeTaskContinuationCheckpoint,
  validateTaskContinuationCheckpoint,
  type WorkOrderV1,
} from "@opendelegate/protocol";

import {
  DurableTaskContinuationCheckpointService,
  TaskContinuationCheckpointError,
  TaskService,
} from "../src/index.ts";

test("durable checkpoint is deterministic across restart and excludes private execution state", async () => {
  let now = Date.parse("2026-07-25T00:00:00.000Z");
  const eventStore = new InMemoryEventStore({
    clock: {
      now: () => new Date(now++).toISOString(),
    },
  });
  const tasks = new TaskService({
    clock: { now: () => new Date(now++).toISOString() },
    eventStore,
  });
  const task = await tasks.create({
    principalId: "owner-checkpoint",
    idempotencyKey: "create-checkpoint-task",
    objective: "Produce a durable release report.",
    completionCriteria: ["The report is complete."],
    constraints: ["Use only public evidence."],
    selectedInputRefs: ["artifact-selected"],
    mode: "auto",
  });
  await tasks.appendInput({
    taskId: task.taskId,
    principalId: "owner-checkpoint",
    idempotencyKey: "append-private-looking-input",
    message:
      "Use the public fixture. token: ultra-private-token-12345 is invalid; never read C:\\Users\\owner\\private\\notes.md, C:/Users/owner/private/report.txt, or file:///home/owner/private/report.txt.",
    selectedInputRefs: [],
  });
  await tasks.recordExecution({
    taskId: task.taskId,
    idempotencyKey: "checkpoint-running",
    state: "running",
    publicMessage: "The public release checks are running.",
  });
  const workOrders = [
    workOrder("work-order-complete", "Complete report"),
    workOrder("work-order-pending", "Publish report"),
  ];
  await eventStore.append({
    streamId: "task-worker-plan:fixture",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-plan-checkpoint",
        type: "task.worker-plan-recorded",
        payload: {
          schemaVersion: 1,
          executionKeyDigest: "sha256:plan",
          taskId: task.taskId,
          plan: {
            protocolVersion: PROTOCOL_VERSION,
            taskId: task.taskId,
            workOrders,
          },
        },
      },
    ],
  });
  await eventStore.append({
    streamId: "agent-session:coordinator-fixture",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-coordinator-session",
        type: "agent.native-session-recorded",
        payload: {
          schemaVersion: 1,
          sessionKeyDigest: "sha256:private-session-key-digest",
          reference: {
            schemaVersion: 1,
            provider: "codex",
            adapterId: "codex-main",
            adapterVersion: "1.0.0",
            nativeSessionId: "native-coordinator",
            sessionKey: "private-coordinator-session-key",
            taskId: task.taskId,
            workstreamId: "coordinator",
            deviceId: "device-main",
            workspaceId: "workspace-public-id",
            cwd: "C:\\Users\\owner\\source",
            worktreePath: "C:\\Users\\owner\\source\\.worktrees\\private",
            lineage: { lineageId: "lineage-coordinator" },
            createdAt: "2026-07-25T00:00:01.000Z",
          },
        },
      },
    ],
  });
  await eventStore.append({
    streamId: "task-worker-run:fixture",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-worker-accepted",
        type: "task.worker-event-accepted",
        payload: {
          schemaVersion: 1,
          taskId: task.taskId,
          workOrderId: "work-order-complete",
          acceptedAtMs: 1_000,
          event: {
            protocolVersion: PROTOCOL_VERSION,
            sequence: 9,
            messageId: "message-worker-complete",
            senderDeviceId: "device-worker",
            correlationId: "run-private-correlation",
            createdAt: "2026-07-25T00:00:02.000Z",
            idempotencyKey: "private-worker-idempotency",
            type: "worker.run.succeeded",
            payload: {
              taskId: task.taskId,
              workOrderId: "work-order-complete",
              deviceId: "device-worker",
              workerId: "worker-private",
              routeId: "route-private",
              runId: "run-private",
              leaseId: "lease-private-do-not-copy",
              fencingToken: 91_337,
              report:
                "KNOWLEDGE-PRIVATE-CONTENT from /home/worker/Knowledge/private.md must not cross.",
              artifactIds: ["artifact-worker-report"],
              diagnostic: {
                credential: "worker-private-credential",
                stack: "/home/worker/private-stack.ts",
              },
              agentSession: {
                provider: "claude",
                adapterId: "claude-worker",
                adapterVersion: "2.0.0",
                nativeSessionId: "native-worker",
                workstreamId: "work-order-complete",
                workspaceId: "workspace-worker-id",
                lineage: { lineageId: "lineage-worker" },
              },
            },
          },
        },
      },
    ],
  });

  const service = new DurableTaskContinuationCheckpointService({ eventStore, tasks });
  const checkpoint = await service.build(task.taskId);
  const serialized = serializeTaskContinuationCheckpoint(checkpoint);

  assert.equal(
    Buffer.byteLength(serialized, "utf8") <= TASK_CONTINUATION_CHECKPOINT_MAX_BYTES,
    true,
  );
  assert.deepEqual(
    checkpoint.pendingWorkOrders.map((order) => order.workOrderId),
    ["work-order-pending"],
  );
  assert.deepEqual(
    checkpoint.artifacts.map((artifact) => artifact.artifactId),
    ["artifact-selected", "artifact-worker-report"],
  );
  assert.deepEqual(
    checkpoint.sessions.map((session) => [session.scope, session.nativeSessionId]),
    [
      ["coordinator", "native-coordinator"],
      ["worker", "native-worker"],
    ],
  );
  for (const forbidden of [
    "ultra-private-token-12345",
    "C:\\Users\\owner",
    "C:/Users/owner",
    "file:///home/owner",
    "private-coordinator-session-key",
    "lease-private-do-not-copy",
    "91337",
    "route-private",
    "worker-private",
    "KNOWLEDGE-PRIVATE-CONTENT",
    "/home/worker",
    "worker-private-credential",
    "secret://worker-token",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.match(serialized, /\[credential-redacted\]/u);
  assert.match(serialized, /\[local-path-redacted\]/u);
  assert.doesNotThrow(() => validateTaskContinuationCheckpoint(checkpoint));

  const restarted = new DurableTaskContinuationCheckpointService({
    eventStore,
    tasks: new TaskService({
      clock: { now: () => new Date(now++).toISOString() },
      eventStore,
    }),
  });
  assert.deepEqual(await restarted.build(task.taskId), checkpoint);
});

test("checkpoint construction is strictly isolated to the requested Task", async () => {
  let tick = 0;
  const eventStore = new InMemoryEventStore({
    clock: {
      now: () => new Date(Date.UTC(2026, 6, 25, 1, 0, tick++)).toISOString(),
    },
  });
  const tasks = new TaskService({
    clock: {
      now: () => new Date(Date.UTC(2026, 6, 25, 1, 0, tick++)).toISOString(),
    },
    eventStore,
  });
  const left = await tasks.create({
    principalId: "owner",
    idempotencyKey: "task-left",
    objective: "LEFT-TASK-OBJECTIVE",
    completionCriteria: ["LEFT-CRITERION"],
    constraints: [],
    selectedInputRefs: ["artifact-left"],
    mode: "auto",
  });
  const right = await tasks.create({
    principalId: "owner",
    idempotencyKey: "task-right",
    objective: "RIGHT-TASK-OBJECTIVE",
    completionCriteria: ["RIGHT-CRITERION"],
    constraints: [],
    selectedInputRefs: ["artifact-right"],
    mode: "auto",
  });
  await tasks.appendInput({
    taskId: right.taskId,
    principalId: "owner",
    idempotencyKey: "right-message",
    message: "RIGHT-TASK-PRIVATE-PUBLIC-MESSAGE",
    selectedInputRefs: [],
  });
  await eventStore.append({
    streamId: "agent-session:right",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-right-session",
        type: "agent.native-session-recorded",
        payload: {
          schemaVersion: 1,
          sessionKeyDigest: "sha256:right",
          reference: {
            schemaVersion: 1,
            provider: "codex",
            adapterId: "codex-right",
            adapterVersion: "1.0.0",
            nativeSessionId: "RIGHT-NATIVE-SESSION",
            sessionKey: "right-session-key",
            taskId: right.taskId,
            workstreamId: "coordinator",
            deviceId: "device-main",
            workspaceId: "workspace-right",
            cwd: "/home/right/private",
            lineage: { lineageId: "lineage-right" },
            createdAt: "2026-07-25T01:00:00.000Z",
          },
        },
      },
    ],
  });

  const checkpoint = await new DurableTaskContinuationCheckpointService({
    eventStore,
    tasks,
  }).build(left.taskId);
  const serialized = serializeTaskContinuationCheckpoint(checkpoint);
  assert.match(serialized, /LEFT-TASK-OBJECTIVE/u);
  for (const forbidden of [
    right.taskId,
    "RIGHT-TASK-OBJECTIVE",
    "RIGHT-CRITERION",
    "artifact-right",
    "RIGHT-TASK-PRIVATE-PUBLIC-MESSAGE",
    "RIGHT-NATIVE-SESSION",
    "workspace-right",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  assert.throws(
    () =>
      validateTaskContinuationCheckpoint({
        ...checkpoint,
        taskId: right.taskId,
      }),
    /checkpoint hash/u,
  );
});

test("checkpoint construction fails closed when the durable Task snapshot never stabilizes", async () => {
  const eventStore = new InMemoryEventStore({
    clock: { now: () => "2026-07-25T02:00:00.000Z" },
  });
  const tasks = new TaskService({
    clock: { now: () => "2026-07-25T02:00:00.000Z" },
    eventStore,
  });
  const task = await tasks.create({
    principalId: "owner",
    idempotencyKey: "task-unstable",
    objective: "Prove snapshot stability.",
    completionCriteria: ["The checkpoint is coherent."],
    constraints: [],
    selectedInputRefs: [],
    mode: "auto",
  });
  let reads = 0;
  const service = new DurableTaskContinuationCheckpointService({
    eventStore,
    tasks: {
      async get(taskId) {
        const detail = await tasks.get(taskId);
        reads += 1;
        return {
          ...detail,
          version: detail.version + reads,
        };
      },
    },
  });

  await assert.rejects(
    () => service.build(task.taskId),
    (error: unknown) =>
      error instanceof TaskContinuationCheckpointError &&
      error.code === "CHECKPOINT_SOURCE_UNSTABLE",
  );
  assert.equal(reads, 6);
});

function workOrder(workOrderId: string, title: string): WorkOrderV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    workOrderId,
    title,
    brief: `Execute ${title}.`,
    completionCriteria: [`${title} is verified.`],
    constraints: [],
    selectedInputIds: ["artifact-selected"],
    dependsOn: [],
    schedulingHints: {
      preferredDeviceIds: [],
      preferredRoles: [],
    },
    requiredCapabilities: ["filesystem"],
    requiredSecretRefs: ["secret://worker-token"],
    requiredAgent: {
      provider: "codex",
      adapterId: "codex-worker",
      allowedCompatibilities: ["tested"],
    },
    workspaceId: "workspace-public-id",
  };
}
