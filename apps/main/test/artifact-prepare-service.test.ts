import assert from "node:assert/strict";
import test from "node:test";

import type { IssueArtifactUploadGrant } from "@opendelegate/artifact-store";
import type { MainArtifactPrepareRequest } from "@opendelegate/device-channel";

import {
  MainArtifactPrepareService,
  createDefaultMainArtifactPreparePolicy,
} from "../src/artifact-prepare-service.ts";

const request: MainArtifactPrepareRequest = {
  authenticatedDeviceId: "device-worker",
  requestMessageId: "artifact-prepare-1",
  correlationId: "task-1",
  idempotencyKey: "artifact-prepare-1",
  manifest: {
    artifactId: "artifact-report",
    taskId: "task-1",
    workOrderId: "work-order-1",
    deviceId: "device-worker",
    workerId: "worker-1",
    routeId: "route-main",
    runId: "run-1",
    leaseId: "lease-1",
    fencingToken: 7,
    mediaType: "text/html",
    originalFilename: "report.html",
    declaredSizeBytes: 20,
    expectedSha256: "1".repeat(64),
    requestedPresentation: "static-html",
  },
};

test("Main alone authorizes current Run scope, provenance, policy, and upload grant lifetime", async () => {
  const issued: IssueArtifactUploadGrant[] = [];
  const service = new MainArtifactPrepareService({
    clock: { nowMs: () => 1_000 },
    maximumGrantTtlMs: 5_000,
    runAuthority: {
      async authorizeWorkerArtifactRun(authenticatedDeviceId, scope) {
        assert.equal(authenticatedDeviceId, "device-worker");
        assert.deepEqual(scope, {
          taskId: "task-1",
          workOrderId: "work-order-1",
          deviceId: "device-worker",
          workerId: "worker-1",
          routeId: "route-main",
          runId: "run-1",
          leaseId: "lease-1",
          fencingToken: 7,
        });
        return {
          authorized: true,
          leaseExpiresAtMs: 4_000,
          workspaceId: "workspace-product",
        };
      },
    },
    policy: {
      async resolve(input) {
        assert.equal(input.authenticatedDeviceId, "device-worker");
        assert.equal(input.manifest.requestedPresentation, "static-html");
        return {
          status: "allowed",
          retentionPolicy: { kind: "task" },
          exposurePolicy: { mode: "authenticated" },
          presentation: "static-html",
        };
      },
    },
    artifactRuntime: {
      async issueWorkerUploadGrant(input) {
        issued.push(input);
        return {
          protocolVersion: "v1",
          uploadId: "upload-report",
          artifactId: input.artifactId,
          uploadUrl: "https://main.example.test/worker-uploads/upload-report",
          credential: `u1.upload-report.${"a".repeat(43)}`,
          expiresAtMs: input.expiresAtMs,
          maximumChunkBytes: 8_388_608,
          declaredSizeBytes: input.declaredSizeBytes,
          expectedSha256: input.expectedChecksum.value,
        };
      },
    },
  });

  const decision = await service.prepare(request);

  assert.equal(decision.status, "granted");
  assert.equal(decision.status === "granted" ? decision.grant.expiresAtMs : undefined, 4_000);
  assert.equal(issued.length, 1);
  assert.deepEqual(issued[0], {
    artifactId: "artifact-report",
    taskId: "task-1",
    producingRunId: "run-1",
    mediaType: "text/html",
    originalFilename: "report.html",
    declaredSizeBytes: 20,
    expectedChecksum: { algorithm: "sha256", value: "1".repeat(64) },
    createdAtMs: 1_000,
    retentionPolicy: { kind: "task" },
    exposurePolicy: { mode: "authenticated" },
    provenance: {
      deviceId: "device-worker",
      workspaceId: "workspace-product",
      source: "worker-upload",
    },
    presentation: "static-html",
    expiresAtMs: 4_000,
    context: {
      actor: { type: "device", id: "device-worker" },
      correlationId: "task-1",
    },
  });
});

test("spoofed, stale, and policy-rejected Artifact manifests never receive a grant", async () => {
  let runtimeCalls = 0;
  let runAuthorized = true;
  let policyAllowed = true;
  const service = new MainArtifactPrepareService({
    clock: { nowMs: () => 1_000 },
    runAuthority: {
      async authorizeWorkerArtifactRun() {
        return runAuthorized
          ? { authorized: true, leaseExpiresAtMs: 5_000 }
          : { authorized: false };
      },
    },
    policy: {
      async resolve() {
        return policyAllowed
          ? {
              status: "allowed",
              retentionPolicy: { kind: "task" },
              exposurePolicy: { mode: "authenticated" },
            }
          : { status: "rejected", retryable: false };
      },
    },
    artifactRuntime: {
      async issueWorkerUploadGrant() {
        runtimeCalls += 1;
        throw new Error("must not issue");
      },
    },
  });

  assert.deepEqual(
    await service.prepare({
      ...request,
      manifest: { ...request.manifest, deviceId: "device-spoofed" },
    }),
    { status: "rejected", code: "RUN_NOT_CURRENT", retryable: false },
  );
  runAuthorized = false;
  assert.deepEqual(await service.prepare(request), {
    status: "rejected",
    code: "RUN_NOT_CURRENT",
    retryable: false,
  });
  runAuthorized = true;
  policyAllowed = false;
  assert.deepEqual(await service.prepare(request), {
    status: "rejected",
    code: "POLICY_REJECTED",
    retryable: false,
  });
  assert.equal(runtimeCalls, 0);
});

test("the default policy keeps HTML inert and never accepts Worker-selected executable exposure", async () => {
  const policy = createDefaultMainArtifactPreparePolicy({
    exposureMode: "private-network",
  });
  const manifestWithoutPresentation = { ...request.manifest };
  Reflect.deleteProperty(manifestWithoutPresentation, "requestedPresentation");
  assert.deepEqual(
    await policy.resolve({
      authenticatedDeviceId: "device-worker",
      manifest: manifestWithoutPresentation,
      run: { authorized: true, leaseExpiresAtMs: 5_000 },
    }),
    {
      status: "allowed",
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "private-network" },
      presentation: "static-html",
    },
  );
  assert.deepEqual(
    await policy.resolve({
      authenticatedDeviceId: "device-worker",
      manifest: { ...request.manifest, requestedPresentation: "interactive-html" },
      run: { authorized: true, leaseExpiresAtMs: 5_000 },
    }),
    { status: "rejected", retryable: false },
  );
  assert.deepEqual(
    await createDefaultMainArtifactPreparePolicy({ exposureMode: "custom" }).resolve({
      authenticatedDeviceId: "device-worker",
      manifest: request.manifest,
      run: { authorized: true, leaseExpiresAtMs: 5_000 },
    }),
    { status: "rejected", retryable: false },
  );
});
