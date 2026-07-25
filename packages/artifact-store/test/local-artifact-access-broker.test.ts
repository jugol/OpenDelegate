import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArtifactAccessError,
  LocalArtifactAccessBroker,
  LocalArtifactStore,
  type ArtifactClock,
  type ArtifactMutationContext,
  type ArtifactRandomSource,
} from "../src/index.ts";

class MutableClock implements ArtifactClock {
  public value: number;

  public constructor(value: number) {
    this.value = value;
  }

  public nowMs(): number {
    return this.value;
  }
}

class DeterministicRandom implements ArtifactRandomSource {
  #counter = 40;

  public bytes(length: number): Uint8Array {
    this.#counter += 1;
    return Buffer.alloc(length, this.#counter);
  }
}

const context: ArtifactMutationContext = {
  actor: { type: "system", id: "artifact-transfer-test" },
  correlationId: "artifact-transfer-test",
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function* chunks(...values: readonly string[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield Buffer.from(value);
  }
}

test("a Worker resumes a bounded upload after restart and exact chunk replay cannot duplicate bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-access-"));
  const clock = new MutableClock(1_000);
  const random = new DeterministicRandom();
  const store = await LocalArtifactStore.open({
    rootDirectory: join(root, "store"),
    maxArtifactBytes: 64,
    clock,
    signingKey: Buffer.alloc(32, 7),
    random,
  });
  let broker = await LocalArtifactAccessBroker.open({
    rootDirectory: join(root, "access"),
    store,
    clock,
    random,
    maximumArtifactBytes: 64,
    maximumChunkBytes: 4,
  });

  try {
    const bytes = Buffer.from("verified report");
    const issued = await broker.issueUploadGrant({
      artifactId: "artifact-worker-report",
      taskId: "task-worker-report",
      producingRunId: "run-worker-report",
      mediaType: "text/plain",
      originalFilename: "report.txt",
      declaredSizeBytes: bytes.byteLength,
      expectedChecksum: { algorithm: "sha256", value: sha256(bytes) },
      createdAtMs: 1_000,
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      expiresAtMs: 10_000,
      context,
    });

    const first = await broker.appendUploadChunk({
      uploadId: issued.uploadId,
      credential: issued.credential,
      idempotencyKey: "chunk-0001",
      offsetBytes: 0,
      bytes: chunks("veri"),
      correlationId: "upload-request-1",
    });
    assert.deepEqual(first, {
      uploadId: issued.uploadId,
      artifactId: "artifact-worker-report",
      nextOffsetBytes: 4,
      complete: false,
      replayed: false,
    });

    await broker.close();
    broker = await LocalArtifactAccessBroker.open({
      rootDirectory: join(root, "access"),
      store,
      clock,
      random,
      maximumArtifactBytes: 64,
      maximumChunkBytes: 4,
    });
    assert.equal(
      (
        await broker.probeUpload({
          uploadId: issued.uploadId,
          credential: issued.credential,
        })
      ).nextOffsetBytes,
      4,
    );

    const replay = await broker.appendUploadChunk({
      uploadId: issued.uploadId,
      credential: issued.credential,
      idempotencyKey: "chunk-0001",
      offsetBytes: 0,
      bytes: chunks("veri"),
      correlationId: "upload-request-1-retry",
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.nextOffsetBytes, 4);
    await assert.rejects(
      broker.appendUploadChunk({
        uploadId: issued.uploadId,
        credential: issued.credential,
        idempotencyKey: "chunk-0001",
        offsetBytes: 0,
        bytes: chunks("evil"),
        correlationId: "upload-request-conflict",
      }),
      { code: "UPLOAD_IDEMPOTENCY_CONFLICT" },
    );

    let offset = 4;
    for (const [idempotencyKey, value] of [
      ["chunk-0002", "fied"],
      ["chunk-0003", " rep"],
      ["chunk-0004", "ort"],
    ] as const) {
      const result = await broker.appendUploadChunk({
        uploadId: issued.uploadId,
        credential: issued.credential,
        idempotencyKey,
        offsetBytes: offset,
        bytes: chunks(value),
        correlationId: `upload-request-${idempotencyKey}`,
      });
      offset = result.nextOffsetBytes;
    }

    assert.equal(offset, bytes.byteLength);
    assert.deepEqual(Buffer.from((await store.read("artifact-worker-report")).bytes), bytes);
    const completedReplay = await broker.appendUploadChunk({
      uploadId: issued.uploadId,
      credential: issued.credential,
      idempotencyKey: "chunk-0004",
      offsetBytes: 12,
      bytes: chunks("ort"),
      correlationId: "upload-request-final-retry",
    });
    assert.equal(completedReplay.complete, true);
    assert.equal(completedReplay.replayed, true);

    const conflictingBytes = Buffer.from("evil");
    const conflictingGrant = await broker.issueUploadGrant({
      artifactId: "artifact-worker-report",
      taskId: "task-worker-report",
      producingRunId: "run-worker-report",
      mediaType: "text/plain",
      originalFilename: "report.txt",
      declaredSizeBytes: conflictingBytes.byteLength,
      expectedChecksum: {
        algorithm: "sha256",
        value: sha256(conflictingBytes),
      },
      createdAtMs: 1_000,
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      expiresAtMs: 10_000,
      context,
    });
    await assert.rejects(
      broker.appendUploadChunk({
        uploadId: conflictingGrant.uploadId,
        credential: conflictingGrant.credential,
        idempotencyKey: "conflicting-publication",
        offsetBytes: 0,
        bytes: chunks("evil"),
        correlationId: "upload-request-publication-conflict",
      }),
      { code: "UPLOAD_PUBLICATION_CONFLICT" },
    );

    await assert.rejects(
      broker.probeUpload({
        uploadId: issued.uploadId,
        credential: `${issued.credential}x`,
      }),
      { code: "UPLOAD_GRANT_INVALID" },
    );
    const journal = await readFile(join(root, "access", "access.json"), "utf8");
    assert.equal(journal.includes(issued.credential), false);
  } finally {
    await broker.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh grant can idempotently recover after Main stored the Artifact but Worker lost the completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-recovery-"));
  const clock = new MutableClock(1_000);
  const random = new DeterministicRandom();
  const store = await LocalArtifactStore.open({
    rootDirectory: join(root, "store"),
    maxArtifactBytes: 64,
    clock,
    signingKey: Buffer.alloc(32, 7),
    random,
  });
  const broker = await LocalArtifactAccessBroker.open({
    rootDirectory: join(root, "access"),
    store,
    clock,
    random,
    maximumArtifactBytes: 64,
    maximumChunkBytes: 64,
  });
  const bytes = Buffer.from("durable retry");
  const publication = {
    artifactId: "artifact-recovered-publication",
    taskId: "task-recovered-publication",
    producingRunId: "run-recovered-publication",
    mediaType: "text/plain",
    originalFilename: "report.txt",
    declaredSizeBytes: bytes.byteLength,
    expectedChecksum: { algorithm: "sha256" as const, value: sha256(bytes) },
    retentionPolicy: { kind: "task" as const },
    exposurePolicy: { mode: "authenticated" as const },
    provenance: { deviceId: "device-worker", source: "worker-upload" },
    expiresAtMs: 10_000,
    context,
  };

  try {
    const first = await broker.issueUploadGrant({
      ...publication,
      createdAtMs: 1_000,
    });
    assert.equal(
      (
        await broker.appendUploadChunk({
          uploadId: first.uploadId,
          credential: first.credential,
          idempotencyKey: "first-completion",
          offsetBytes: 0,
          bytes: chunks("durable retry"),
          correlationId: "first-completion",
        })
      ).complete,
      true,
    );

    const recovered = await broker.issueUploadGrant({
      ...publication,
      createdAtMs: 1_001,
    });
    assert.equal(
      (
        await broker.appendUploadChunk({
          uploadId: recovered.uploadId,
          credential: recovered.credential,
          idempotencyKey: "recovered-completion",
          offsetBytes: 0,
          bytes: chunks("durable retry"),
          correlationId: "recovered-completion",
        })
      ).complete,
      true,
    );
    assert.equal((await store.getMetadata(publication.artifactId)).createdAtMs, 1_000);
    assert.equal(
      (await store.listAuditEvents(publication.artifactId)).filter(
        (event) => event.eventType === "artifact.stored",
      ).length,
      1,
    );
  } finally {
    await broker.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an authenticated Artifact opens through a one-time POST grant and short artifact-scoped session", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-browser-access-"));
  const clock = new MutableClock(1_000);
  const random = new DeterministicRandom();
  const store = await LocalArtifactStore.open({
    rootDirectory: join(root, "store"),
    maxArtifactBytes: 64,
    clock,
    signingKey: Buffer.alloc(32, 8),
    random,
  });
  let broker = await LocalArtifactAccessBroker.open({
    rootDirectory: join(root, "access"),
    store,
    clock,
    random,
    maximumArtifactBytes: 64,
    maximumChunkBytes: 4,
  });

  try {
    const bytes = Buffer.from("private");
    await store.put({
      artifactId: "artifact-private-report",
      taskId: "task-private-report",
      producingRunId: "run-private-report",
      mediaType: "text/plain",
      originalFilename: "private.txt",
      bytes,
      expectedChecksum: { algorithm: "sha256", value: sha256(bytes) },
      createdAtMs: 1_000,
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-main", source: "main-report" },
      context,
    });
    const grant = await broker.issueBrowserGrant({
      artifactId: "artifact-private-report",
      expiresAtMs: 2_000,
      context,
    });
    await broker.close();
    broker = await LocalArtifactAccessBroker.open({
      rootDirectory: join(root, "access"),
      store,
      clock,
      random,
      maximumArtifactBytes: 64,
      maximumChunkBytes: 4,
    });

    const exchanged = await broker.exchangeBrowserGrant({
      credential: grant.credential,
      plane: "static",
    });
    assert.equal(exchanged.artifactId, "artifact-private-report");
    assert.equal(
      await broker.authorizeBrowserSession({
        artifactId: "artifact-private-report",
        credential: exchanged.sessionCredential,
      }),
      true,
    );
    assert.equal(
      await broker.authorizeBrowserSession({
        artifactId: "artifact-other",
        credential: exchanged.sessionCredential,
      }),
      false,
    );
    await assert.rejects(
      broker.exchangeBrowserGrant({
        credential: grant.credential,
        plane: "static",
      }),
      (error: unknown) => {
        assert.equal(error instanceof ArtifactAccessError, true);
        assert.equal((error as ArtifactAccessError).code, "BROWSER_GRANT_INVALID");
        return true;
      },
    );

    clock.value = 2_000;
    assert.equal(
      await broker.authorizeBrowserSession({
        artifactId: "artifact-private-report",
        credential: exchanged.sessionCredential,
      }),
      false,
    );
    const journal = await readFile(join(root, "access", "access.json"), "utf8");
    assert.equal(journal.includes(grant.credential), false);
    assert.equal(journal.includes(exchanged.sessionCredential), false);
  } finally {
    await broker.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("upload grants reject malformed nested metadata and a journal cannot restore unknown policy fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-access-validation-"));
  const clock = new MutableClock(1_000);
  const random = new DeterministicRandom();
  const store = await LocalArtifactStore.open({
    rootDirectory: join(root, "store"),
    maxArtifactBytes: 64,
    clock,
    signingKey: Buffer.alloc(32, 9),
    random,
  });
  const broker = await LocalArtifactAccessBroker.open({
    rootDirectory: join(root, "access"),
    store,
    clock,
    random,
    maximumArtifactBytes: 64,
    maximumChunkBytes: 4,
  });

  const validGrant = {
    artifactId: "artifact-validated",
    taskId: "task-validated",
    producingRunId: "run-validated",
    mediaType: "text/plain",
    originalFilename: "validated.txt",
    declaredSizeBytes: 4,
    expectedChecksum: { algorithm: "sha256" as const, value: sha256(Buffer.from("safe")) },
    createdAtMs: 1_000,
    retentionPolicy: { kind: "task" as const },
    exposurePolicy: { mode: "authenticated" as const },
    provenance: { deviceId: "device-worker", source: "worker-upload" },
    expiresAtMs: 10_000,
    context,
  };

  try {
    assert.throws(
      () =>
        broker.issueUploadGrant({
          ...validGrant,
          provenance: undefined,
        } as unknown as Parameters<LocalArtifactAccessBroker["issueUploadGrant"]>[0]),
      { code: "UPLOAD_GRANT_INVALID" },
    );
    assert.throws(
      () =>
        broker.issueUploadGrant({
          ...validGrant,
          exposurePolicy: { mode: "authenticated", unexpected: true },
        } as unknown as Parameters<LocalArtifactAccessBroker["issueUploadGrant"]>[0]),
      { code: "UPLOAD_GRANT_INVALID" },
    );

    await broker.issueUploadGrant(validGrant);
    await broker.close();
    const journalPath = join(root, "access", "access.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      uploads: Record<string, { publication: { exposurePolicy: Record<string, unknown> } }>;
    };
    const upload = Object.values(journal.uploads)[0];
    assert.ok(upload);
    upload.publication.exposurePolicy["unexpected"] = true;
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });

    await assert.rejects(
      LocalArtifactAccessBroker.open({
        rootDirectory: join(root, "access"),
        store,
        clock,
        random,
        maximumArtifactBytes: 64,
        maximumChunkBytes: 4,
      }),
      { code: "ACCESS_STORAGE_CORRUPT" },
    );
  } finally {
    await broker.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a zero-byte Artifact is published atomically when its upload grant is issued", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-access-empty-"));
  const clock = new MutableClock(1_000);
  const random = new DeterministicRandom();
  const store = await LocalArtifactStore.open({
    rootDirectory: join(root, "store"),
    maxArtifactBytes: 64,
    clock,
    signingKey: Buffer.alloc(32, 10),
    random,
  });
  let broker = await LocalArtifactAccessBroker.open({
    rootDirectory: join(root, "access"),
    store,
    clock,
    random,
    maximumArtifactBytes: 64,
    maximumChunkBytes: 4,
  });

  try {
    const issued = await broker.issueUploadGrant({
      artifactId: "artifact-empty",
      taskId: "task-empty",
      producingRunId: "run-empty",
      mediaType: "text/plain",
      originalFilename: "empty.txt",
      declaredSizeBytes: 0,
      expectedChecksum: { algorithm: "sha256", value: sha256(Buffer.alloc(0)) },
      createdAtMs: 1_000,
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      expiresAtMs: 10_000,
      context,
    });

    await broker.close();
    broker = await LocalArtifactAccessBroker.open({
      rootDirectory: join(root, "access"),
      store,
      clock,
      random,
      maximumArtifactBytes: 64,
      maximumChunkBytes: 4,
    });
    const progress = await broker.probeUpload({
      uploadId: issued.uploadId,
      credential: issued.credential,
    });
    assert.equal(progress.complete, true);
    assert.equal(progress.nextOffsetBytes, 0);
    assert.equal(progress.metadata?.sizeBytes, 0);
    assert.equal((await store.read("artifact-empty")).bytes.byteLength, 0);
  } finally {
    await broker.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expired transfer capabilities and their partial bytes are pruned durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-access-prune-"));
  const clock = new MutableClock(1_000);
  const random = new DeterministicRandom();
  const store = await LocalArtifactStore.open({
    rootDirectory: join(root, "store"),
    maxArtifactBytes: 64,
    clock,
    signingKey: Buffer.alloc(32, 11),
    random,
  });
  const broker = await LocalArtifactAccessBroker.open({
    rootDirectory: join(root, "access"),
    store,
    clock,
    random,
    maximumArtifactBytes: 64,
    maximumChunkBytes: 4,
  });

  try {
    const uploadBytes = Buffer.from("pending");
    const upload = await broker.issueUploadGrant({
      artifactId: "artifact-expiring-upload",
      taskId: "task-expiring-upload",
      producingRunId: "run-expiring-upload",
      mediaType: "text/plain",
      originalFilename: "pending.txt",
      declaredSizeBytes: uploadBytes.byteLength,
      expectedChecksum: { algorithm: "sha256", value: sha256(uploadBytes) },
      createdAtMs: 1_000,
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      expiresAtMs: 2_000,
      context,
    });
    await broker.appendUploadChunk({
      uploadId: upload.uploadId,
      credential: upload.credential,
      idempotencyKey: "expiring-chunk",
      offsetBytes: 0,
      bytes: chunks("pend"),
      correlationId: "expiring-upload",
    });

    const privateBytes = Buffer.from("private");
    await store.put({
      artifactId: "artifact-expiring-browser",
      taskId: "task-expiring-browser",
      producingRunId: "run-expiring-browser",
      mediaType: "text/plain",
      originalFilename: "private.txt",
      bytes: privateBytes,
      expectedChecksum: { algorithm: "sha256", value: sha256(privateBytes) },
      createdAtMs: 1_000,
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-main", source: "main-report" },
      context,
    });
    const browserGrant = await broker.issueBrowserGrant({
      artifactId: "artifact-expiring-browser",
      expiresAtMs: 2_000,
      context,
    });
    const browserSession = await broker.exchangeBrowserGrant({
      credential: browserGrant.credential,
      plane: "static",
    });

    clock.value = 3_000;
    const replacementBytes = Buffer.from("next");
    await broker.issueUploadGrant({
      artifactId: "artifact-replacement-upload",
      taskId: "task-replacement-upload",
      producingRunId: "run-replacement-upload",
      mediaType: "text/plain",
      originalFilename: "next.txt",
      declaredSizeBytes: replacementBytes.byteLength,
      expectedChecksum: { algorithm: "sha256", value: sha256(replacementBytes) },
      createdAtMs: 3_000,
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      expiresAtMs: 4_000,
      context,
    });

    await assert.rejects(
      broker.probeUpload({
        uploadId: upload.uploadId,
        credential: upload.credential,
      }),
      { code: "UPLOAD_GRANT_INVALID" },
    );
    const journal = await readFile(join(root, "access", "access.json"), "utf8");
    assert.equal(journal.includes(upload.uploadId), false);
    assert.equal(journal.includes(browserGrant.credential.split(".")[1] ?? ""), false);
    assert.equal(journal.includes(browserSession.sessionCredential.split(".")[1] ?? ""), false);
    await assert.rejects(stat(join(root, "access", "partial", `${upload.uploadId}.part`)), {
      code: "ENOENT",
    });
  } finally {
    await broker.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
