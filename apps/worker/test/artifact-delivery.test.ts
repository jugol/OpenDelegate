import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactPrepareManifestV1 } from "@opendelegate/device-channel";
import type { ArtifactUploadGrantV1, ArtifactUploadProgressV1 } from "@opendelegate/protocol";

import {
  WorkerArtifactDeliveryCoordinator,
  type WorkerArtifactDeliveryUploadPort,
} from "../src/artifact-delivery.ts";

const manifest: ArtifactPrepareManifestV1 = {
  artifactId: "artifact-report",
  taskId: "task-1",
  workOrderId: "work-order-1",
  deviceId: "device-worker",
  workerId: "worker-1",
  routeId: "route-main",
  runId: "run-1",
  leaseId: "lease-1",
  fencingToken: 1,
  mediaType: "text/plain",
  originalFilename: "report.txt",
  declaredSizeBytes: 20,
  expectedSha256: "1".repeat(64),
};

const grant: ArtifactUploadGrantV1 = {
  protocolVersion: "v1",
  uploadId: "upload-report",
  artifactId: "artifact-report",
  uploadUrl: "https://main.example.test/worker-uploads/upload-report",
  credential: `u1.upload-report.${"a".repeat(43)}`,
  expiresAtMs: 10_000,
  maximumChunkBytes: 8_388_608,
  declaredSizeBytes: 20,
  expectedSha256: "1".repeat(64),
};

test("Worker delivery obtains a Main-authorized grant before invoking the bounded uploader", async () => {
  const calls: string[] = [];
  const completed: ArtifactUploadProgressV1 = {
    protocolVersion: "v1",
    uploadId: "upload-report",
    artifactId: "artifact-report",
    nextOffsetBytes: 20,
    complete: true,
    replayed: false,
  };
  const uploader: WorkerArtifactDeliveryUploadPort = {
    async upload(input) {
      calls.push(`upload:${input.grant.uploadId}:${input.sourcePath}`);
      return completed;
    },
  };
  const coordinator = new WorkerArtifactDeliveryCoordinator({
    channel: {
      async prepareArtifact(input) {
        calls.push(`prepare:${input.runId}:${input.artifactId}`);
        return grant;
      },
    },
    uploader,
  });

  assert.deepEqual(
    await coordinator.deliver({
      manifest,
      sourcePath: "C:\\runtime\\artifacts\\report.txt",
      isExecutionCurrent: () => Promise.resolve(true),
    }),
    completed,
  );
  assert.deepEqual(calls, [
    "prepare:run-1:artifact-report",
    "upload:upload-report:C:\\runtime\\artifacts\\report.txt",
  ]);
});

test("Worker delivery rejects a grant that changes immutable manifest metadata", async () => {
  let uploadCalls = 0;
  const coordinator = new WorkerArtifactDeliveryCoordinator({
    channel: {
      async prepareArtifact() {
        return { ...grant, expectedSha256: "2".repeat(64) };
      },
    },
    uploader: {
      async upload() {
        uploadCalls += 1;
        throw new Error("must not upload");
      },
    },
  });

  await assert.rejects(
    coordinator.deliver({
      manifest,
      sourcePath: "C:\\runtime\\artifacts\\report.txt",
      isExecutionCurrent: () => Promise.resolve(true),
    }),
    { code: "GRANT_SCOPE_MISMATCH" },
  );
  assert.equal(uploadCalls, 0);
});

test("Worker delivery cannot prepare an Artifact after Run authority is lost", async () => {
  let prepareCalls = 0;
  let uploadCalls = 0;
  const coordinator = new WorkerArtifactDeliveryCoordinator({
    channel: {
      async prepareArtifact() {
        prepareCalls += 1;
        return grant;
      },
    },
    uploader: {
      async upload() {
        uploadCalls += 1;
        throw new Error("must not upload");
      },
    },
  });

  await assert.rejects(
    coordinator.deliver({
      manifest,
      sourcePath: "C:\\runtime\\artifacts\\report.txt",
      isExecutionCurrent: () => Promise.resolve(false),
    }),
    { code: "RUN_AUTHORITY_LOST" },
  );
  assert.equal(prepareCalls, 0);
  assert.equal(uploadCalls, 0);
});

test("Worker delivery revalidates Run authority between prepare and upload", async () => {
  let authorityChecks = 0;
  let uploadCalls = 0;
  const coordinator = new WorkerArtifactDeliveryCoordinator({
    channel: {
      async prepareArtifact() {
        return grant;
      },
    },
    uploader: {
      async upload() {
        uploadCalls += 1;
        throw new Error("must not upload");
      },
    },
  });

  await assert.rejects(
    coordinator.deliver({
      manifest,
      sourcePath: "C:\\runtime\\artifacts\\report.txt",
      isExecutionCurrent: () => Promise.resolve(++authorityChecks === 1),
    }),
    { code: "RUN_AUTHORITY_LOST" },
  );
  assert.equal(authorityChecks, 2);
  assert.equal(uploadCalls, 0);
});

test("Worker delivery cannot credit an upload completed after Run authority changed", async () => {
  let authorityChecks = 0;
  let uploadCalls = 0;
  const coordinator = new WorkerArtifactDeliveryCoordinator({
    channel: {
      async prepareArtifact() {
        return grant;
      },
    },
    uploader: {
      async upload() {
        uploadCalls += 1;
        return {
          protocolVersion: "v1",
          uploadId: grant.uploadId,
          artifactId: grant.artifactId,
          nextOffsetBytes: grant.declaredSizeBytes,
          complete: true,
          replayed: false,
        };
      },
    },
  });

  await assert.rejects(
    coordinator.deliver({
      manifest,
      sourcePath: "C:\\runtime\\artifacts\\report.txt",
      isExecutionCurrent: () => Promise.resolve(++authorityChecks < 3),
    }),
    { code: "RUN_AUTHORITY_LOST" },
  );
  assert.equal(authorityChecks, 3);
  assert.equal(uploadCalls, 1);
});
