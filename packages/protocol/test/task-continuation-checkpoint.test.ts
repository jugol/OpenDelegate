import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_CONTINUATION_CHECKPOINT_LIMITS,
  TASK_CONTINUATION_CHECKPOINT_MAX_BYTES,
  createTaskContinuationCheckpoint,
  serializeTaskContinuationCheckpoint,
  validateTaskContinuationCheckpoint,
  type TaskContinuationCheckpointBodyV1,
} from "../src/index.ts";

test("continuation checkpoint hashing is canonical and version-pinned", () => {
  const checkpoint = createTaskContinuationCheckpoint(checkpointBody());

  assert.equal(
    checkpoint.checkpointHash,
    "sha256:59c71b73dde3d0381481e6393eab6ef2df56e1bb75be2282cd69ce49eec3e464",
  );
  assert.equal(
    Buffer.byteLength(serializeTaskContinuationCheckpoint(checkpoint), "utf8") <=
      TASK_CONTINUATION_CHECKPOINT_MAX_BYTES,
    true,
  );
  assert.deepEqual(
    createTaskContinuationCheckpoint({
      ...checkpointBody(),
      decisions: [...checkpointBody().decisions],
    }),
    checkpoint,
  );
});

test("continuation checkpoints reject excess items, bytes, private fields, and local paths", () => {
  const body = checkpointBody();
  const checkpoint = createTaskContinuationCheckpoint(body);

  assert.throws(
    () =>
      createTaskContinuationCheckpoint({
        ...body,
        decisions: Array.from(
          { length: TASK_CONTINUATION_CHECKPOINT_LIMITS.decisions + 1 },
          (_, index) => ({
            decisionId: `decision-${String(index)}`,
            kind: "command" as const,
            outcome: "resume",
            occurredAt: "2026-07-25T00:00:00.000Z",
          }),
        ),
      }),
    /bounded continuation list/u,
  );
  assert.throws(
    () =>
      createTaskContinuationCheckpoint({
        ...body,
        messages: Array.from({ length: 9 }, (_, index) => ({
          messageId: `message-${String(index)}`,
          role: "owner" as const,
          content: "x".repeat(8_192),
          occurredAt: "2026-07-25T00:00:00.000Z",
        })),
      }),
    /byte limit/u,
  );
  assert.throws(
    () =>
      createTaskContinuationCheckpoint({
        ...body,
        pendingWorkOrders: [
          {
            ...body.pendingWorkOrders[0]!,
            workspaceId: "C:/Users/owner/private-workspace",
          },
        ],
      }),
    /bounded opaque identifier/u,
  );
  assert.throws(
    () =>
      validateTaskContinuationCheckpoint({
        ...checkpoint,
        rawTranscript: "private transcript",
      }),
    /unexpected shape/u,
  );
});

function checkpointBody(): TaskContinuationCheckpointBodyV1 {
  return {
    schemaVersion: 1,
    taskId: "task-checkpoint-contract",
    taskVersion: 11,
    summary: {
      state: "running",
      mode: "auto",
      objective: "Publish the release report.",
      rollingSummary: "One bounded Work Order remains.",
      completionCriteria: ["The report is available."],
      constraints: ["Use public evidence only."],
    },
    decisions: [
      {
        decisionId: "decision-resume",
        kind: "command",
        outcome: "resume",
        occurredAt: "2026-07-25T00:00:00.000Z",
      },
    ],
    pendingWorkOrders: [
      {
        workOrderId: "work-order-publish",
        title: "Publish report",
        brief: "Publish the verified report.",
        completionCriteria: ["The report is available."],
        constraints: [],
        dependsOn: [],
        requiredCapabilities: ["artifact-publishing"],
        omitted: {
          completionCriteria: 0,
          constraints: 0,
          dependsOn: 0,
          requiredCapabilities: 0,
        },
        requiredAgent: {
          provider: "codex",
          adapterId: "codex-app-server",
          allowedCompatibilities: ["tested"],
        },
        workspaceId: "workspace-release",
      },
    ],
    artifacts: [
      {
        artifactId: "artifact-release-report",
        source: "selected-input",
      },
    ],
    messages: [
      {
        messageId: "message-owner",
        role: "owner",
        content: "Publish the verified report.",
        occurredAt: "2026-07-25T00:00:01.000Z",
      },
    ],
    sessions: [
      {
        scope: "coordinator",
        deviceId: "device-main",
        provider: "codex",
        adapterId: "codex-app-server",
        adapterVersion: "1.2.3",
        nativeSessionId: "native-session-main",
        workstreamId: "coordinator",
        workspaceId: "workspace-release",
        lineage: {
          lineageId: "lineage-main",
        },
      },
    ],
    omitted: {
      completionCriteria: 0,
      constraints: 0,
      decisions: 0,
      pendingWorkOrders: 0,
      artifacts: 0,
      messages: 0,
      sessions: 0,
    },
  };
}
