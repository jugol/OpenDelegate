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

test("Discord identifies sequential exact-action Approvals with closed presentation metadata", async () => {
  let nextId = 1;
  const approvals = new ApprovalService({
    repository: new InMemoryApprovalRepository(),
    executor: {
      execute(input: ApprovalExecutionContext) {
        return Promise.resolve({ operationId: input.operationId, state: "authorized" });
      },
    },
    clock: { now: () => 1_000 },
    idSource: { nextId: () => `approval-${String(nextId++).padStart(3, "0")}` },
  });
  const request = async (suffix: string) =>
    await approvals.request({
      idempotencyKey: `worker-action-${suffix}`,
      requestedBy: "worker:device-windows",
      expiresAtMs: 10_000,
      actionCategory: "sandbox-boundary-escalation",
      actionType: "shell.command",
      targetDeviceId: "device-windows",
      taskId: "task-sequential",
      resource: "worker-run:run-sequential",
      descriptor: {
        kind: "worker-action",
        operation: "shell.command",
        target: { actionFingerprint: `sha256:${suffix.repeat(64).slice(0, 64)}` },
      },
      presentation: {
        reason: "Private provider reason must not be projected.",
        target: "C:\\private\\workspace",
        risk: "medium",
        evidence: ["private command"],
      },
      execution: {
        kind: "worker-action.authorize",
        payload: { actionRequestId: `action-${suffix}`, requestHash: `hash-${suffix}` },
      },
    });
  const first = await request("a");
  await request("b");
  const bridge = new DiscordActionApproval({
    approvals,
    listDevices: () =>
      Promise.resolve([{ deviceId: "device-windows", name: "Windows workstation" }]),
  });

  assert.deepEqual(await bridge.current("task-sequential"), {
    approvalId: first.approvalId,
    description:
      "Windows workstation wants to temporarily expand its sandbox for this Task. Risk: medium. Evidence: a current Worker Run requested this exact protected action. 1 more approval(s) are waiting.",
    sequence: 1,
    remaining: 1,
    deviceLabel: "Windows workstation",
    actionCategory: "sandbox-boundary-escalation",
    risk: "medium",
  });

  await bridge.resolve({
    taskId: "task-sequential",
    approvalId: first.approvalId,
    principalId: "discord:owner",
    idempotencyKey: "approve-first-sequential",
    decision: "approve",
  });
  const second = await bridge.current("task-sequential");
  assert.equal(second?.sequence, 2);
  assert.equal(second?.remaining, 0);
  assert.equal(second?.deviceLabel, "Windows workstation");
  assert.equal(second?.actionCategory, "sandbox-boundary-escalation");
  assert.equal(second?.risk, "medium");
});

test("Discord skips and refuses Approvals whose originating Worker Run is no longer current", async () => {
  let nextId = 1;
  const approvals = new ApprovalService({
    repository: new InMemoryApprovalRepository(),
    executor: {
      execute(input: ApprovalExecutionContext) {
        return Promise.resolve({ operationId: input.operationId, state: "authorized" });
      },
    },
    clock: { now: () => 1_000 },
    idSource: { nextId: () => `approval-${String(nextId++).padStart(3, "0")}` },
  });
  const request = async (suffix: string) =>
    await approvals.request({
      idempotencyKey: `worker-action-${suffix}`,
      requestedBy: "worker:device-windows",
      expiresAtMs: 10_000,
      actionCategory: "computer-use-input",
      actionType: "computer-use.click",
      targetDeviceId: "device-windows",
      taskId: "task-current-run",
      resource: `worker-run:run-${suffix}`,
      descriptor: {
        kind: "worker-action",
        operation: "computer-use.click",
        target: { actionFingerprint: `sha256:${suffix.repeat(64).slice(0, 64)}` },
      },
      presentation: {
        reason: "A protected desktop input was requested.",
        target: "Windows desktop",
        risk: "high",
        evidence: ["current Run"],
      },
      execution: {
        kind: "worker-action.authorize",
        payload: { actionRequestId: `action-${suffix}`, requestHash: `hash-${suffix}` },
      },
    });
  const stale = await request("a");
  const current = await request("b");
  const bridge = new DiscordActionApproval({
    approvals,
    isCurrent: (approval) => approval.approvalId === current.approvalId,
    listDevices: () =>
      Promise.resolve([{ deviceId: "device-windows", name: "Windows workstation" }]),
  });

  assert.deepEqual(await bridge.current("task-current-run"), {
    approvalId: current.approvalId,
    description:
      "Windows workstation wants to control its desktop for this Task. Risk: high. Evidence: a current Worker Run requested this exact protected action.",
    sequence: 2,
    remaining: 0,
    deviceLabel: "Windows workstation",
    actionCategory: "computer-use-input",
    risk: "high",
  });
  await assert.rejects(
    bridge.resolve({
      taskId: "task-current-run",
      approvalId: stale.approvalId,
      principalId: "discord:owner",
      idempotencyKey: "approve-stale-run",
      decision: "approve",
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "DiscordTaskPortError" &&
      error.message.includes("no longer current"),
  );
  assert.equal((await approvals.get(stale.approvalId)).state, "pending");
});
