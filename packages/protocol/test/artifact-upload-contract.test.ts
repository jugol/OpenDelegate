import assert from "node:assert/strict";
import test from "node:test";

import {
  ProtocolValidationError,
  parseArtifactUploadGrant,
  parseArtifactUploadProgress,
} from "../src/index.ts";

test("Artifact upload grants carry one credential over the authenticated Device channel without URL credentials", () => {
  const parsed = parseArtifactUploadGrant({
    protocolVersion: "v1",
    uploadId: "upload-report",
    artifactId: "artifact-report",
    uploadUrl: "https://main.example.test/worker-uploads/upload-report",
    credential: `u1.upload-report.${"a".repeat(43)}`,
    expiresAtMs: 2_000,
    maximumChunkBytes: 8_388_608,
    declaredSizeBytes: 20,
    expectedSha256: "1".repeat(64),
  });

  assert.equal(parsed.uploadUrl.includes(parsed.credential), false);
  assert.equal(parsed.expectedSha256, "1".repeat(64));
  assert.throws(
    () =>
      parseArtifactUploadGrant({
        ...parsed,
        uploadUrl: `https://main.example.test/worker-uploads/upload-report?token=${parsed.credential}`,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).path, "uploadUrl");
      return true;
    },
  );
});

test("Artifact upload progress validates durable resume offsets and terminal metadata", () => {
  assert.deepEqual(
    parseArtifactUploadProgress({
      protocolVersion: "v1",
      uploadId: "upload-report",
      artifactId: "artifact-report",
      nextOffsetBytes: 20,
      complete: true,
      replayed: true,
    }),
    {
      protocolVersion: "v1",
      uploadId: "upload-report",
      artifactId: "artifact-report",
      nextOffsetBytes: 20,
      complete: true,
      replayed: true,
    },
  );
});
