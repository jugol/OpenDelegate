import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkerActionAuthorizationRequestV1,
  WorkerActionConsumptionRequestV1,
} from "@opendelegate/device-channel";

import { WorkerAgentActionAuthorizer } from "../src/agent-action-authorizer.ts";

const assignment = {
  taskId: "task-1",
  workOrder: {
    protocolVersion: "v1" as const,
    workOrderId: "work-order-1",
    title: "Implement",
    brief: "Implement the accepted task.",
    roleSelector: {},
    requiredCapabilities: [],
    constraints: [],
    completionCriteria: ["Tests pass."],
    selectedInputIds: [],
    dependsOn: [],
    schedulingHints: {
      preferredDeviceIds: [],
      preferredRoles: [],
    },
    requiredSecretRefs: [],
    budget: {},
    artifactExpectations: [],
    autonomy: "auto" as const,
    parentWorkOrderId: null,
    createdAt: "2026-07-25T00:00:00.000Z",
  },
  deviceId: "device-1",
  workerId: "worker-1",
  routeId: "route-1",
  runId: "run-1",
  leaseId: "lease-1",
  fencingToken: 7,
  leaseExpiresAtMs: 30_000,
};

test("pending provider action polls byte-identically and consumes once at the current Run boundary", async () => {
  let now = 10_000;
  let attempts = 0;
  let currentChecks = 0;
  const authorizationRequests: WorkerActionAuthorizationRequestV1[] = [];
  const consumptionRequests: WorkerActionConsumptionRequestV1[] = [];
  const authorizer = new WorkerAgentActionAuthorizer({
    assignment,
    approvalPollIntervalMs: 100,
    clock: { now: () => now },
    isExecutionCurrent: async () => {
      currentChecks += 1;
      return true;
    },
    channel: () => ({
      authorizeAction: async (request) => {
        authorizationRequests.push(structuredClone(request));
        attempts += 1;
        return {
          authorizationRequestId: request.authorizationRequestId,
          authorizationId: "authorization-1",
          actionFingerprint: request.actionFingerprint,
          decision: attempts < 2 ? "require-approval" : "allow",
          reasonCode: attempts < 2 ? "POLICY_APPROVAL_REQUIRED" : "POLICY_OWNER_GRANT",
        };
      },
      consumeActionAuthorization: async (request) => {
        consumptionRequests.push(structuredClone(request));
        return {
          authorizationRequestId: request.authorizationRequestId,
          authorizationId: request.authorizationId,
          actionFingerprint: request.actionFingerprint,
          decision: "consumed",
          reasonCode: "AUTHORIZATION_CONSUMED",
        };
      },
    }),
  });

  const pending = authorizer.authorizeAndConsume({
    authorizationRequestId: "agent-action-1",
    actionCategory: "sandbox-boundary-escalation",
    actionType: "Bash",
    actionFingerprint: `sha256:${"a".repeat(64)}`,
    actionDescriptor: { provider: "claude", tool: "Bash" },
    requestedAtMs: now,
    signal: new AbortController().signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  now = 10_100;
  const decision = await pending;

  assert.deepEqual(decision, {
    decision: "allow",
    reasonCode: "POLICY_OWNER_GRANT",
  });
  assert.equal(authorizationRequests.length, 2);
  assert.deepEqual(authorizationRequests[0], authorizationRequests[1]);
  assert.equal(consumptionRequests.length, 1);
  assert.equal(consumptionRequests[0]?.fencingToken, assignment.fencingToken);
  assert.ok(currentChecks >= 3);
});

test("revoked Runs and mismatched authorization responses fail closed without consumption", async () => {
  let consumed = false;
  const revoked = new WorkerAgentActionAuthorizer({
    assignment,
    clock: { now: () => 10_000 },
    isExecutionCurrent: async () => false,
    channel: () => ({
      authorizeAction: async () => {
        throw new Error("must not reach channel");
      },
      consumeActionAuthorization: async () => {
        consumed = true;
        throw new Error("must not consume");
      },
    }),
  });
  await assert.rejects(
    revoked.authorizeAndConsume({
      authorizationRequestId: "agent-action-revoked",
      actionCategory: "sandbox-boundary-escalation",
      actionType: "Bash",
      actionFingerprint: `sha256:${"b".repeat(64)}`,
      actionDescriptor: { provider: "codex", tool: "shell" },
      requestedAtMs: 10_000,
      signal: new AbortController().signal,
    }),
    /no longer current/u,
  );
  assert.equal(consumed, false);
});

test("a consumed authorization replay never releases the provider action again", async () => {
  let consumptionAttempt = 0;
  const authorizer = new WorkerAgentActionAuthorizer({
    assignment,
    clock: { now: () => 10_000 },
    isExecutionCurrent: async () => true,
    channel: () => ({
      authorizeAction: async (request) => ({
        authorizationRequestId: request.authorizationRequestId,
        authorizationId: "authorization-replay",
        actionFingerprint: request.actionFingerprint,
        decision: "allow",
        reasonCode: "POLICY_OWNER_GRANT",
      }),
      consumeActionAuthorization: async (request) => {
        consumptionAttempt += 1;
        if (consumptionAttempt === 1) {
          throw new Error("response lost after Main durably consumed the grant");
        }
        return {
          authorizationRequestId: request.authorizationRequestId,
          authorizationId: request.authorizationId,
          actionFingerprint: request.actionFingerprint,
          decision: "consumed",
          reasonCode: "CONSUMPTION_REPLAY",
        };
      },
    }),
  });
  const request = {
    authorizationRequestId: "agent-action-replay",
    actionCategory: "sandbox-boundary-escalation" as const,
    actionType: "Bash",
    actionFingerprint: `sha256:${"c".repeat(64)}` as const,
    actionDescriptor: { provider: "claude", tool: "Bash" },
    requestedAtMs: 10_000,
    signal: new AbortController().signal,
  };

  await assert.rejects(
    authorizer.authorizeAndConsume(request),
    /response lost after Main durably consumed/u,
  );
  assert.deepEqual(await authorizer.authorizeAndConsume(request), {
    decision: "deny",
    reasonCode: "ACTION_AUTHORIZATION_REPLAYED",
  });
});

test("lease expiry during authorization consumption never releases the provider action", async () => {
  let now = assignment.leaseExpiresAtMs - 1;
  let consumptionAttempts = 0;
  const authorizer = new WorkerAgentActionAuthorizer({
    assignment,
    clock: { now: () => now },
    isExecutionCurrent: async () => now < assignment.leaseExpiresAtMs,
    channel: () => ({
      authorizeAction: async (request) => ({
        authorizationRequestId: request.authorizationRequestId,
        authorizationId: "authorization-expiring",
        actionFingerprint: request.actionFingerprint,
        decision: "allow",
        reasonCode: "POLICY_OWNER_GRANT",
      }),
      consumeActionAuthorization: async (request) => {
        consumptionAttempts += 1;
        now = assignment.leaseExpiresAtMs + 1;
        return {
          authorizationRequestId: request.authorizationRequestId,
          authorizationId: request.authorizationId,
          actionFingerprint: request.actionFingerprint,
          decision: "consumed",
          reasonCode: "AUTHORIZATION_CONSUMED",
        };
      },
    }),
  });

  await assert.rejects(
    authorizer.authorizeAndConsume({
      authorizationRequestId: "agent-action-expiring",
      actionCategory: "sandbox-boundary-escalation",
      actionType: "Bash",
      actionFingerprint: `sha256:${"d".repeat(64)}`,
      actionDescriptor: { provider: "codex", tool: "shell" },
      requestedAtMs: now,
      signal: new AbortController().signal,
    }),
    /no longer current/u,
  );
  assert.equal(consumptionAttempts, 1);
});

test("Run replacement during authorization consumption never releases the provider action", async () => {
  let authoritativeRunId = assignment.runId;
  let consumptionAttempts = 0;
  const authorizer = new WorkerAgentActionAuthorizer({
    assignment,
    clock: { now: () => 10_000 },
    isExecutionCurrent: async () => authoritativeRunId === assignment.runId,
    channel: () => ({
      authorizeAction: async (request) => ({
        authorizationRequestId: request.authorizationRequestId,
        authorizationId: "authorization-replaced",
        actionFingerprint: request.actionFingerprint,
        decision: "allow",
        reasonCode: "POLICY_OWNER_GRANT",
      }),
      consumeActionAuthorization: async (request) => {
        consumptionAttempts += 1;
        authoritativeRunId = "run-2";
        return {
          authorizationRequestId: request.authorizationRequestId,
          authorizationId: request.authorizationId,
          actionFingerprint: request.actionFingerprint,
          decision: "consumed",
          reasonCode: "AUTHORIZATION_CONSUMED",
        };
      },
    }),
  });

  await assert.rejects(
    authorizer.authorizeAndConsume({
      authorizationRequestId: "agent-action-replaced",
      actionCategory: "sandbox-boundary-escalation",
      actionType: "Bash",
      actionFingerprint: `sha256:${"e".repeat(64)}`,
      actionDescriptor: { provider: "claude", tool: "Bash" },
      requestedAtMs: 10_000,
      signal: new AbortController().signal,
    }),
    /no longer current/u,
  );
  assert.equal(consumptionAttempts, 1);
});
