import assert from "node:assert/strict";
import test from "node:test";

import type {
  TaskContinuationNativeSessionV1,
  WorkerRunAssignmentV1,
} from "@opendelegate/protocol";

import { renderWorkOrderPrompt, resolveWorkerWorkstreamId } from "../src/worker-app.ts";

test("a single related Worker follow-up reuses its prior Task workstream", () => {
  const assignment = workerAssignment([workerSession("work-initial")]);

  assert.equal(resolveWorkerWorkstreamId(assignment, "workspace-repository"), "work-initial");
});

test("an ambiguous follow-up does not merge unrelated prior workstreams", () => {
  const assignment = workerAssignment([
    workerSession("work-first"),
    workerSession("work-parallel"),
  ]);

  assert.equal(resolveWorkerWorkstreamId(assignment, "workspace-repository"), "work-follow-up");
});

test("a truncated checkpoint never guesses the related prior workstream", () => {
  const assignment = workerAssignment([workerSession("work-initial")], 1);

  assert.equal(resolveWorkerWorkstreamId(assignment, "workspace-repository"), "work-follow-up");
});

test("the production Worker prompt requires evidence for every completion criterion", () => {
  const prompt = renderWorkOrderPrompt(workerAssignment([workerSession("work-initial")]));

  assert.match(prompt, /Report only the observable result/u);
  assert.match(prompt, /explicit evidence for every completion criterion/u);
  assert.match(prompt, /Do not add preambles, promises, or narration/u);
  assert.match(prompt, /call workspace_file_inspect with the exact relative path/u);
  assert.match(prompt, /actual text, byte count, SHA-256, BOM, UTF-8, and final-LF/u);
});

function workerAssignment(
  sessions: readonly TaskContinuationNativeSessionV1[],
  omittedSessions = 0,
): WorkerRunAssignmentV1 {
  return {
    taskId: "task-follow-up",
    workOrder: {
      protocolVersion: "v1",
      workOrderId: "work-follow-up",
      title: "Continue the file update",
      brief: "Modify the file created by the prior related Worker Run.",
      completionCriteria: ["The existing file contains the requested update."],
      constraints: [],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: {
        preferredDeviceIds: ["device-worker"],
        preferredRoles: ["worker"],
      },
      requiredCapabilities: ["file-authoring"],
      requiredSecretRefs: [],
      workspaceId: "workspace-repository",
    },
    continuationCheckpoint: {
      schemaVersion: 1,
      taskId: "task-follow-up",
      taskVersion: 4,
      summary: {
        state: "review",
        mode: "auto",
        objective: "Create and then update one file.",
        rollingSummary: "The initial file exists.",
        completionCriteria: ["The updated file is delivered."],
        constraints: [],
      },
      decisions: [],
      pendingWorkOrders: [
        {
          workOrderId: "work-follow-up",
          title: "Continue the file update",
          brief: "Modify the existing file.",
          completionCriteria: ["The file is updated."],
          constraints: [],
          dependsOn: [],
          requiredCapabilities: ["file-authoring"],
          omitted: {
            completionCriteria: 0,
            constraints: 0,
            dependsOn: 0,
            requiredCapabilities: 0,
          },
          workspaceId: "workspace-repository",
        },
      ],
      artifacts: [],
      messages: [],
      sessions,
      omitted: {
        completionCriteria: 0,
        constraints: 0,
        decisions: 0,
        pendingWorkOrders: 0,
        artifacts: 0,
        messages: 0,
        sessions: omittedSessions,
      },
      checkpointHash: `sha256:${"a".repeat(64)}`,
    },
    agentRequirement: {
      provider: "codex",
      adapterId: "codex-app-server",
      modelId: "gpt-5.6-sol",
      allowedCompatibilities: ["tested"],
    },
    deviceId: "device-worker",
    workerId: "worker-primary",
    routeId: "route-worker",
    runId: "run-follow-up",
    leaseId: "lease-follow-up",
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 60_000,
  };
}

function workerSession(workstreamId: string): TaskContinuationNativeSessionV1 {
  return {
    scope: "worker",
    deviceId: "device-worker",
    provider: "codex",
    adapterId: "codex-app-server",
    adapterVersion: "0.146.0",
    nativeSessionId: `native-${workstreamId}`,
    workstreamId,
    workspaceId: "workspace-repository",
    workOrderId: workstreamId,
    lineage: { lineageId: `lineage-${workstreamId}` },
  };
}
