import assert from "node:assert/strict";
import test from "node:test";

import type { ComputerUseInputAuthorizationRequest } from "@opendelegate/computer-use-os";
import type {
  WorkerActionAuthorizationRequestV1,
  WorkerActionConsumptionRequestV1,
} from "@opendelegate/device-channel";
import type { WorkerRunAssignmentV1 } from "@opendelegate/worker-runtime";

import { WorkerComputerUseInputAuthorizer } from "../src/computer-use-action-authorizer.ts";

const fingerprint = `sha256:${"a".repeat(64)}` as const;

test("Worker action authorization is exact, typed, and consumed before native use", async () => {
  let authorizationRequest: WorkerActionAuthorizationRequestV1 | undefined;
  let consumptionRequest: WorkerActionConsumptionRequestV1 | undefined;
  const authorizer = new WorkerComputerUseInputAuthorizer({
    assignment: assignment(),
    isExecutionCurrent: async () => true,
    clock: { now: () => 1_100 },
    channel: () => ({
      async authorizeAction(request) {
        authorizationRequest = request;
        return {
          authorizationRequestId: request.authorizationRequestId,
          authorizationId: "authorization-1",
          actionFingerprint: request.actionFingerprint,
          decision: "allow",
          reasonCode: "POLICY_ALLOW",
        };
      },
      async consumeActionAuthorization(request) {
        consumptionRequest = request;
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

  const proof = await authorizer.authorize(request());
  assert.deepEqual(proof, {
    decision: "allow",
    authorizationId: "authorization-1",
    fingerprint,
    reason: "POLICY_ALLOW",
  });
  assert.deepEqual(authorizationRequest?.actionDescriptor, {
    kind: "type-text",
    privacy: "exact-input-withheld-on-device",
  });
  assert.equal(JSON.stringify(authorizationRequest).includes("private typed value"), false);
  assert.equal(JSON.stringify(authorizationRequest).includes("task-text"), false);

  const consumption = await authorizer.consume(
    request(),
    proof as Extract<typeof proof, { readonly decision: "allow" }>,
  );
  assert.deepEqual(consumption, {
    decision: "consumed",
    authorizationRequestId: "run-1:input:1",
    authorizationId: "authorization-1",
    fingerprint,
  });
  assert.equal(consumptionRequest?.requestedAtMs, 1_100);
  assert.equal(consumptionRequest?.runId, "run-1");
  assert.equal(consumptionRequest?.fencingToken, 9);
});

test("Worker action authorization has no local allow fallback", async () => {
  const unavailable = new WorkerComputerUseInputAuthorizer({
    assignment: assignment(),
    isExecutionCurrent: async () => true,
    channel: () => undefined,
  });
  assert.deepEqual(await unavailable.authorize(request()), {
    decision: "deny",
    authorizationId: "denied:run-1:input:1",
    fingerprint,
    reason: "channel-unavailable",
  });

  const mismatched = new WorkerComputerUseInputAuthorizer({
    assignment: assignment(),
    isExecutionCurrent: async () => true,
    channel: () => ({
      async authorizeAction(request_) {
        return {
          authorizationRequestId: `${request_.authorizationRequestId}-other`,
          authorizationId: "authorization-1",
          actionFingerprint: request_.actionFingerprint,
          decision: "allow",
          reasonCode: "POLICY_ALLOW",
        };
      },
      async consumeActionAuthorization(request_) {
        return {
          authorizationRequestId: request_.authorizationRequestId,
          authorizationId: request_.authorizationId,
          actionFingerprint: request_.actionFingerprint,
          decision: "deny",
          reasonCode: "NOT_ALLOWED",
        };
      },
    }),
  });
  assert.equal((await mismatched.authorize(request())).decision, "deny");
  await assert.rejects(
    mismatched.consume(request(), {
      decision: "allow",
      authorizationId: "authorization-1",
      fingerprint,
    }),
    /not consumed/u,
  );
});

test("Worker action authorization fails closed when exact Main Run authority changes", async () => {
  const stale = new WorkerComputerUseInputAuthorizer({
    assignment: assignment(),
    isExecutionCurrent: async () => false,
    channel: () => {
      throw new Error("The channel must not be consulted for a stale Run.");
    },
  });
  await assert.rejects(stale.authorize(request()), /no longer current/u);
  await assert.rejects(
    stale.consume(request(), {
      decision: "allow",
      authorizationId: "authorization-1",
      fingerprint,
    }),
    /no longer current/u,
  );
});

test("a consumed Computer Use authorization replay never releases native input again", async () => {
  let consumptionAttempt = 0;
  const authorizer = new WorkerComputerUseInputAuthorizer({
    assignment: assignment(),
    isExecutionCurrent: async () => true,
    channel: () => ({
      async authorizeAction(request_) {
        return {
          authorizationRequestId: request_.authorizationRequestId,
          authorizationId: "authorization-replay",
          actionFingerprint: request_.actionFingerprint,
          decision: "allow",
          reasonCode: "POLICY_OWNER_GRANT",
        };
      },
      async consumeActionAuthorization(request_) {
        consumptionAttempt += 1;
        if (consumptionAttempt === 1) {
          throw new Error("response lost after Main durably consumed the Computer Use grant");
        }
        return {
          authorizationRequestId: request_.authorizationRequestId,
          authorizationId: request_.authorizationId,
          actionFingerprint: request_.actionFingerprint,
          decision: "consumed",
          reasonCode: "CONSUMPTION_REPLAY",
        };
      },
    }),
  });
  const proof = await authorizer.authorize(request());
  assert.equal(proof.decision, "allow");

  await assert.rejects(
    authorizer.consume(request(), proof as Extract<typeof proof, { readonly decision: "allow" }>),
    /response lost after Main durably consumed/u,
  );
  await assert.rejects(
    authorizer.consume(request(), proof as Extract<typeof proof, { readonly decision: "allow" }>),
    /already consumed/u,
  );
  assert.equal(consumptionAttempt, 2);
});

function request(): ComputerUseInputAuthorizationRequest {
  return {
    authorizationRequestId: "run-1:input:1",
    actionCategory: "computer-use-input",
    taskId: "task-1",
    deviceId: "device-1",
    runId: "run-1",
    requestedAtMs: 1_000,
    action: {
      kind: "type-text",
      controlId: "task-text",
      textSha256: `sha256:${"b".repeat(64)}`,
      textLength: 18,
    },
    fingerprint,
  };
}

function assignment(): WorkerRunAssignmentV1 {
  return {
    taskId: "task-1",
    workOrder: {
      protocolVersion: "v1",
      workOrderId: "work-order-1",
      title: "Use a desktop",
      brief: "Complete the exact action.",
      completionCriteria: ["The action is complete."],
      constraints: [],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: { preferredDeviceIds: [], preferredRoles: [] },
      requiredCapabilities: ["computer-use"],
      requiredSecretRefs: [],
    },
    deviceId: "device-1",
    workerId: "worker-1",
    routeId: "route-1",
    runId: "run-1",
    leaseId: "run-lease-1",
    fencingToken: 9,
    leaseExpiresAtMs: 2_000,
  };
}
