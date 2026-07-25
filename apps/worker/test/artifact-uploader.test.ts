import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArtifactUploadGrant, type ArtifactUploadProgressV1 } from "@opendelegate/protocol";

import {
  FetchWorkerArtifactUploadTransport,
  WorkerArtifactUploader,
  type WorkerArtifactUploadTransport,
} from "../src/artifact-uploader.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Worker probes durable progress after a lost response and never sends a chunk twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-artifact-"));
  const sourcePath = join(root, "report.txt");
  const bytes = Buffer.from("a report that needs several chunks");
  await writeFile(sourcePath, bytes);
  const grant = parseArtifactUploadGrant({
    protocolVersion: "v1",
    uploadId: "upload-worker-client",
    artifactId: "artifact-worker-client",
    uploadUrl: "https://main.example.test/worker-uploads/upload-worker-client",
    credential: `u1.upload-worker-client.${"a".repeat(43)}`,
    expiresAtMs: 10_000,
    maximumChunkBytes: 8,
    declaredSizeBytes: bytes.byteLength,
    expectedSha256: sha256(bytes),
  });
  let durableOffset = 0;
  let loseFirstResponse = true;
  let putRequests = 0;
  const received: Buffer[] = [];
  const outcomes = new Map<string, ArtifactUploadProgressV1>();
  const progress = (replayed: boolean): ArtifactUploadProgressV1 => ({
    protocolVersion: "v1",
    uploadId: grant.uploadId,
    artifactId: grant.artifactId,
    nextOffsetBytes: durableOffset,
    complete: durableOffset === bytes.byteLength,
    replayed,
  });
  const transport: WorkerArtifactUploadTransport = {
    async probe(input) {
      assert.equal(input.url.includes(input.credential), false);
      return progress(false);
    },
    async append(input) {
      putRequests += 1;
      assert.equal(input.url.includes(input.credential), false);
      const previous = outcomes.get(input.idempotencyKey);
      if (previous !== undefined) {
        return { ...previous, replayed: true };
      }
      assert.equal(input.offsetBytes, durableOffset);
      received.push(Buffer.from(input.bytes));
      durableOffset += input.bytes.byteLength;
      const outcome = progress(false);
      outcomes.set(input.idempotencyKey, outcome);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("synthetic response loss");
      }
      return outcome;
    },
  };
  const uploader = new WorkerArtifactUploader({
    transport,
    clock: { nowMs: () => 1_000 },
    maximumRecoveryAttempts: 4,
  });

  try {
    const result = await uploader.upload({ grant, sourcePath });

    assert.equal(result.complete, true);
    assert.equal(result.nextOffsetBytes, bytes.byteLength);
    assert.equal(putRequests, 5);
    assert.deepEqual(Buffer.concat(received), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Worker refuses a changed or symlinked source before sending Artifact bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-artifact-source-"));
  const sourcePath = join(root, "report.txt");
  const symlinkPath = join(root, "report-link.txt");
  const bytes = Buffer.from("expected");
  await writeFile(sourcePath, Buffer.from("differnt"));
  const grant = parseArtifactUploadGrant({
    protocolVersion: "v1",
    uploadId: "upload-source-check",
    artifactId: "artifact-source-check",
    uploadUrl: "https://main.example.test/worker-uploads/upload-source-check",
    credential: `u1.upload-source-check.${"a".repeat(43)}`,
    expiresAtMs: 10_000,
    maximumChunkBytes: 8,
    declaredSizeBytes: bytes.byteLength,
    expectedSha256: sha256(bytes),
  });
  let networkCalls = 0;
  const transport: WorkerArtifactUploadTransport = {
    async probe() {
      networkCalls += 1;
      throw new Error("must not call network");
    },
    async append() {
      networkCalls += 1;
      throw new Error("must not call network");
    },
  };
  const uploader = new WorkerArtifactUploader({
    transport,
    clock: { nowMs: () => 1_000 },
  });
  try {
    await assert.rejects(uploader.upload({ grant, sourcePath }), {
      code: "SOURCE_CHECKSUM_MISMATCH",
    });
    assert.equal(networkCalls, 0);

    try {
      await symlink(sourcePath, symlinkPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("The current Windows account cannot create a file symlink.");
        return;
      }
      throw error;
    }
    await assert.rejects(uploader.upload({ grant, sourcePath: symlinkPath }), {
      code: "SOURCE_UNSAFE",
    });
    assert.equal(networkCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production upload transport keeps the grant in an Authorization header and rejects redirects", async () => {
  const credential = `u1.upload-fetch.${"b".repeat(43)}`;
  const requests: { readonly url: string; readonly authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/credential-target" });
      response.end();
      return;
    }
    if (request.url === "/invalid-progress") {
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    if (request.url === "/idempotency-conflict") {
      response.writeHead(409, { "content-type": "application/problem+json" });
      response.end(JSON.stringify({ code: "UPLOAD_IDEMPOTENCY_CONFLICT" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        protocolVersion: "v1",
        uploadId: "upload-fetch",
        artifactId: "artifact-fetch",
        nextOffsetBytes: 0,
        complete: false,
        replayed: false,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${String((address as { port: number }).port)}`;
    const transport = new FetchWorkerArtifactUploadTransport({ timeoutMs: 5_000 });
    const progress = await transport.probe({
      url: `${origin}/worker-uploads/upload-fetch`,
      credential,
    });
    assert.equal(progress.uploadId, "upload-fetch");
    assert.deepEqual(requests, [
      {
        url: "/worker-uploads/upload-fetch",
        authorization: `Bearer ${credential}`,
      },
    ]);

    await assert.rejects(
      transport.probe({
        url: `${origin}/redirect`,
        credential,
      }),
      { code: "SERVICE_UNAVAILABLE" },
    );
    assert.equal(
      requests.some((request) => request.url === "/credential-target"),
      false,
    );

    await assert.rejects(
      transport.probe({
        url: `${origin}/invalid-progress`,
        credential,
      }),
      { code: "REQUEST_REJECTED", retryable: false },
    );
    await assert.rejects(
      transport.probe({
        url: `${origin}/idempotency-conflict`,
        credential,
      }),
      { code: "REQUEST_REJECTED", retryable: false },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
});
