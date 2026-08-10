import assert from "node:assert/strict";
import test from "node:test";

import {
  ApprovalService,
  InMemoryApprovalRepository,
  type ApprovalExecutionContext,
} from "@opendelegate/policy";

import { DiscordActionApproval } from "../src/discord-action-approval.ts";

test("Discord projects and resolves one owner-safe Worker action Approval", async () => {
  let nextId = 1;
  let executionCount = 0;
  let changedTaskId: string | undefined;
  const approvals = new ApprovalService({
    repository: new InMemoryApprovalRepository(),
    executor: {
      execute(input: ApprovalExecutionContext) {
        executionCount += 1;
        return Promise.resolve({ operationId: input.operationId, state: "authorized" });
      },
    },
    clock: { now: () => 1_000 },
    idSource: { nextId: () => `approval-${String(nextId++).padStart(3, "0")}` },
  });
  const pending = await approvals.request({
    idempotencyKey: "worker-action-request",
    requestedBy: "worker:device-windows",
    expiresAtMs: 10_000,
    actionCategory: "sandbox-boundary-escalation",
    actionType: "shell.command",
    targetDeviceId: "device-windows",
    taskId: "task-release",
    resource: "worker-run:run-release",
    descriptor: {
      kind: "worker-action",
      operation: "shell.command",
      target: { actionFingerprint: `sha256:${"a".repeat(64)}` },
    },
    presentation: {
      reason: "Private provider reason must not be projected.",
      target: "C:\\private\\workspace",
      risk: "medium",
      evidence: ["private command"],
    },
    execution: {
      kind: "worker-action.authorize",
      payload: { actionRequestId: "action-request", requestHash: "request-hash" },
    },
  });
  await approvals.request({
    idempotencyKey: "configuration-request",
    requestedBy: "owner",
    expiresAtMs: 10_000,
    actionCategory: "policy-relaxation",
    actionType: "configuration.apply",
    taskId: "task-release",
    resource: "configuration:proposal",
    descriptor: { kind: "configuration", operation: "apply", target: { revision: 1 } },
    presentation: {
      reason: "Change configuration.",
      target: "Main",
      risk: "medium",
      evidence: [],
    },
    execution: { kind: "configuration.apply", payload: { revision: 1 } },
  });
  const bridge = new DiscordActionApproval({
    approvals,
    listDevices: () =>
      Promise.resolve([{ deviceId: "device-windows", name: "Windows build workstation" }]),
    onChanged: (taskId) => {
      changedTaskId = taskId;
    },
  });

  const projection = await bridge.current("task-release");
  assert.equal(projection?.approvalId, pending.approvalId);
  assert.match(projection?.description ?? "", /Windows build workstation/u);
  assert.doesNotMatch(projection?.description ?? "", /private|C:\\/iu);
  assert.equal(
    await bridge.resolve({
      taskId: "task-other",
      approvalId: pending.approvalId,
      principalId: "discord:owner",
      idempotencyKey: "discord-wrong-task",
      decision: "approve",
    }),
    false,
  );
  const decision = {
    taskId: "task-release",
    approvalId: pending.approvalId,
    principalId: "discord:owner",
    idempotencyKey: "discord-approval-once",
    decision: "approve" as const,
  };
  assert.equal(await bridge.resolve(decision), true);
  assert.equal(await bridge.resolve(decision), true);
  assert.equal(executionCount, 1);
  assert.equal(changedTaskId, "task-release");
  assert.equal(await bridge.current("task-release"), undefined);
});
