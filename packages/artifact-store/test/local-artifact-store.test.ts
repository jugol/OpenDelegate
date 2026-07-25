import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArtifactStoreError,
  LocalArtifactStore,
  type ArtifactClock,
  type ArtifactIndexRepository,
  type ArtifactIndexSnapshot,
  type ArtifactMutationContext,
  type ArtifactRandomSource,
} from "../src/index.ts";

const context: ArtifactMutationContext = {
  actor: { type: "system", id: "test-control-plane" },
  correlationId: "correlation-artifact-test",
};

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
  private counter = 0;

  public bytes(length: number): Uint8Array {
    this.counter += 1;
    return Buffer.alloc(length, this.counter);
  }
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactInput(overrides: Record<string, unknown> = {}) {
  const bytes = Buffer.from("<h1>Verified report</h1>", "utf8");
  return {
    artifactId: "artifact-report",
    taskId: "task-report",
    producingRunId: "run-report",
    mediaType: "text/html",
    originalFilename: "report.html",
    bytes,
    expectedChecksum: { algorithm: "sha256" as const, value: checksum(bytes) },
    createdAtMs: 1_000,
    retentionPolicy: { kind: "temporary" as const, expiresAtMs: 10_000 },
    exposurePolicy: { mode: "signed-link" as const },
    provenance: {
      deviceId: "device-worker",
      source: "worker-upload",
      workspaceId: "workspace-project",
    },
    context,
    ...overrides,
  };
}

async function withStore(
  run: (fixture: {
    rootDirectory: string;
    clock: MutableClock;
    store: LocalArtifactStore;
    signingKey: Buffer;
  }) => Promise<void>,
): Promise<void> {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-artifacts-"));
  const clock = new MutableClock(1_000);
  const signingKey = Buffer.alloc(32, 9);
  const store = await LocalArtifactStore.open({
    rootDirectory,
    maxArtifactBytes: 1_024,
    clock,
    signingKey,
    random: new DeterministicRandom(),
  });

  try {
    await run({ rootDirectory, clock, store, signingKey });
  } finally {
    await store.close();
    await rm(rootDirectory, { recursive: true, force: true });
  }
}

test("content-addressed bytes and complete metadata survive a store restart", async () => {
  await withStore(async ({ rootDirectory, clock, store, signingKey }) => {
    const input = artifactInput();
    const metadata = await store.put(input);

    assert.equal(metadata.presentation, "static-html");
    assert.equal(metadata.checksum.value, checksum(input.bytes));
    assert.equal(metadata.sizeBytes, input.bytes.byteLength);
    assert.deepEqual(
      Buffer.from((await store.read("artifact-report")).bytes),
      Buffer.from(input.bytes),
    );

    const objectPrefix = metadata.checksum.value.slice(0, 2);
    const objectNames = await readdir(join(rootDirectory, "objects", objectPrefix));
    assert.deepEqual(objectNames, [metadata.checksum.value]);
    assert.equal(JSON.stringify(objectNames).includes("report.html"), false);

    await store.put(
      artifactInput({
        artifactId: "constructor",
        retentionPolicy: { kind: "task" },
      }),
    );
    assert.equal((await store.getMetadata("constructor")).artifactId, "constructor");

    await store.close();
    const reopened = await LocalArtifactStore.open({
      rootDirectory,
      maxArtifactBytes: 1_024,
      clock,
      signingKey,
      random: new DeterministicRandom(),
    });
    try {
      assert.deepEqual(
        Buffer.from((await reopened.read("artifact-report")).bytes),
        Buffer.from(input.bytes),
      );
      assert.equal((await reopened.getMetadata("artifact-report")).state, "available");
      assert.equal((await reopened.getMetadata("constructor")).artifactId, "constructor");
    } finally {
      await reopened.close();
    }
  });
});

test("Artifact metadata can be listed without exposing stored bytes or access credentials", async () => {
  await withStore(async ({ store }) => {
    await store.put(
      artifactInput({
        artifactId: "artifact-older",
        createdAtMs: 1_000,
        originalFilename: "older.html",
      }),
    );
    await store.put(
      artifactInput({
        artifactId: "artifact-newer",
        createdAtMs: 2_000,
        originalFilename: "newer.html",
      }),
    );

    const listed = await store.listMetadata();

    assert.deepEqual(
      listed.map((artifact) => artifact.artifactId),
      ["artifact-newer", "artifact-older"],
    );
    assert.equal("bytes" in listed[0]!, false);
    assert.equal("token" in listed[0]!, false);
    assert.equal(Object.isFrozen(listed), true);
    assert.equal(Object.isFrozen(listed[0]), true);
  });
});

test("checksum mismatch and configured byte limits fail before metadata publication", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(store.put(artifactInput({ unexpectedMetadata: "reject-me" })), {
      code: "ARTIFACT_METADATA_INVALID",
    });
    await assert.rejects(
      store.put(
        artifactInput({
          retentionPolicy: { kind: "task", unexpectedPolicyField: true },
        }),
      ),
      { code: "ARTIFACT_METADATA_INVALID" },
    );
    await assert.rejects(
      store.put(
        artifactInput({
          expectedChecksum: { algorithm: "sha256", value: "0".repeat(64) },
        }),
      ),
      (error: unknown) => {
        assert.equal(error instanceof ArtifactStoreError, true);
        assert.equal((error as ArtifactStoreError).code, "CHECKSUM_MISMATCH");
        return true;
      },
    );
    await assert.rejects(store.getMetadata("artifact-report"), {
      code: "ARTIFACT_NOT_FOUND",
    });

    const oversized = Buffer.alloc(1_025);
    await assert.rejects(
      store.put(
        artifactInput({
          artifactId: "artifact-oversized",
          bytes: oversized,
          expectedChecksum: { algorithm: "sha256", value: checksum(oversized) },
        }),
      ),
      { code: "ARTIFACT_TOO_LARGE" },
    );
  });
});

test("streamed publication verifies the declared size and checksum without requiring one in-memory payload", async () => {
  await withStore(async ({ store }) => {
    const chunks = [
      Buffer.alloc(300, 1),
      Buffer.alloc(300, 2),
      Buffer.alloc(300, 3),
      Buffer.alloc(124, 4),
    ];
    const bytes = Buffer.concat(chunks);
    let yielded = 0;
    async function* stream(): AsyncIterable<Uint8Array> {
      for (const chunk of chunks) {
        yielded += 1;
        yield chunk;
      }
    }

    const metadata = await store.putStream({
      ...artifactInput({
        artifactId: "artifact-streamed",
        expectedChecksum: { algorithm: "sha256", value: checksum(bytes) },
      }),
      declaredSizeBytes: bytes.byteLength,
      bytes: stream(),
    });

    assert.equal(yielded, chunks.length);
    assert.equal(metadata.sizeBytes, 1_024);
    assert.deepEqual(Buffer.from((await store.read("artifact-streamed")).bytes), bytes);

    await assert.rejects(
      store.putStream({
        ...artifactInput({
          artifactId: "artifact-short-stream",
          expectedChecksum: { algorithm: "sha256", value: checksum(Buffer.from("short")) },
        }),
        declaredSizeBytes: 6,
        bytes: (async function* () {
          yield Buffer.from("short");
        })(),
      }),
      { code: "ARTIFACT_SIZE_MISMATCH" },
    );
  });
});

test("traversal metadata and managed-path symlink substitution fail closed", async (t) => {
  await withStore(async ({ rootDirectory, store }) => {
    await assert.rejects(store.put(artifactInput({ artifactId: "../escape" })), {
      code: "ARTIFACT_METADATA_INVALID",
    });
    await assert.rejects(store.put(artifactInput({ originalFilename: "..\\escape.html" })), {
      code: "ARTIFACT_METADATA_INVALID",
    });
    await assert.rejects(
      store.put(
        artifactInput({
          artifactId: "artifact-svg",
          mediaType: "image/svg+xml",
          originalFilename: "unsafe.svg",
          presentation: "inline",
        }),
      ),
      { code: "ARTIFACT_METADATA_INVALID" },
    );

    const metadata = await store.put(artifactInput());
    const objectPath = join(
      rootDirectory,
      "objects",
      metadata.checksum.value.slice(0, 2),
      metadata.checksum.value,
    );
    await rm(objectPath);
    const outside = join(rootDirectory, "outside.txt");
    await writeFile(outside, "stolen");

    try {
      await symlink(outside, objectPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("The current Windows account cannot create a file symlink.");
        return;
      }
      throw error;
    }

    await assert.rejects(store.read("artifact-report"), {
      code: "ARTIFACT_STORAGE_UNSAFE",
    });
  });
});

test("pin, due expiration, and revocation are durable and audited", async () => {
  await withStore(async ({ clock, store }) => {
    await store.put(artifactInput({ artifactId: "artifact-pin" }));
    await store.pin("artifact-pin", context);
    clock.value = 20_000;
    assert.deepEqual(await store.expireDue(context), []);
    assert.equal((await store.getMetadata("artifact-pin")).retentionPolicy.kind, "pinned");

    await store.put(artifactInput({ artifactId: "artifact-expire" }));
    await assert.rejects(store.pin("artifact-expire", context), {
      code: "ARTIFACT_UNAVAILABLE",
    });
    assert.deepEqual(await store.expireDue(context), []);
    await assert.rejects(store.read("artifact-expire"), { code: "ARTIFACT_UNAVAILABLE" });

    await store.put(
      artifactInput({
        artifactId: "artifact-revoke",
        createdAtMs: 20_000,
        retentionPolicy: { kind: "task" },
      }),
    );
    await store.revoke("artifact-revoke", context);
    await store.revoke("artifact-revoke", context);
    assert.equal((await store.getMetadata("artifact-revoke")).state, "revoked");

    const events = await store.listAuditEvents();
    assert.deepEqual(
      events.map((event) => event.eventType),
      [
        "artifact.stored",
        "artifact.pinned",
        "artifact.stored",
        "artifact.expired",
        "artifact.stored",
        "artifact.revoked",
      ],
    );
    assert.equal(events[0]?.details["exposureMode"], "signed-link");
    assert.equal(JSON.stringify(events).includes(rootDirectoryForbiddenMarker), false);
  });
});

const rootDirectoryForbiddenMarker = "opendelegate-artifacts-";

test("signed-link bearers are Artifact-bound, hash-only, replayable, revocable, and expiring", async () => {
  await withStore(async ({ rootDirectory, clock, store, signingKey }) => {
    await store.put(artifactInput());
    await store.put(
      artifactInput({
        artifactId: "artifact-other",
        expectedChecksum: artifactInput().expectedChecksum,
      }),
    );

    const issued = await store.issueSignedToken({
      artifactId: "artifact-report",
      expiresAtMs: 5_000,
      context,
    });
    const indexJson = await readFile(join(rootDirectory, "index.json"), "utf8");
    assert.equal(indexJson.includes(issued.token), false);
    assert.equal(indexJson.includes(issued.token.split(".")[2] ?? "missing"), false);
    assert.equal(indexJson.includes(issued.token.split(".")[3] ?? "missing"), false);
    assert.equal(indexJson.includes(signingKey.toString("base64url")), false);
    assert.equal(indexJson.includes(signingKey.toString("hex")), false);

    await store.verifySignedToken({
      artifactId: "artifact-report",
      token: issued.token,
      context,
    });
    await store.verifySignedToken({
      artifactId: "artifact-report",
      token: issued.token,
      context,
    });
    await assert.rejects(
      store.verifySignedToken({
        artifactId: "artifact-other",
        token: issued.token,
        context,
      }),
      { code: "SIGNED_TOKEN_INVALID" },
    );

    await store.close();
    const reopened = await LocalArtifactStore.open({
      rootDirectory,
      maxArtifactBytes: 1_024,
      clock,
      signingKey,
      random: new DeterministicRandom(),
    });
    try {
      await reopened.verifySignedToken({
        artifactId: "artifact-report",
        token: issued.token,
        context,
      });
      await reopened.revokeSignedToken(issued.tokenId, context);
      await assert.rejects(
        reopened.verifySignedToken({
          artifactId: "artifact-report",
          token: issued.token,
          context,
        }),
        { code: "SIGNED_TOKEN_INVALID" },
      );

      const expiring = await reopened.issueSignedToken({
        artifactId: "artifact-report",
        expiresAtMs: 5_000,
        context,
      });
      clock.value = 5_000;
      await assert.rejects(
        reopened.verifySignedToken({
          artifactId: "artifact-report",
          token: expiring.token,
          context,
        }),
        { code: "SIGNED_TOKEN_INVALID" },
      );
    } finally {
      await reopened.close();
    }
  });
});

interface MemoryArtifactIndexBackend {
  snapshot?: ArtifactIndexSnapshot;
}

class MemoryArtifactIndexRepository implements ArtifactIndexRepository {
  public closed = false;
  public failAfterCommitOnce = false;
  private readonly backend: MemoryArtifactIndexBackend;

  public constructor(backend: MemoryArtifactIndexBackend) {
    this.backend = backend;
  }

  public async load(): Promise<ArtifactIndexSnapshot | undefined> {
    return this.backend.snapshot === undefined
      ? undefined
      : Object.freeze({ ...this.backend.snapshot });
  }

  public async initialize(initial: ArtifactIndexSnapshot): Promise<ArtifactIndexSnapshot> {
    this.backend.snapshot ??= Object.freeze({ ...initial });
    return Object.freeze({ ...this.backend.snapshot });
  }

  public async compareAndSet(
    expectedGeneration: number,
    next: ArtifactIndexSnapshot,
  ): Promise<boolean> {
    if (this.backend.snapshot?.generation !== expectedGeneration) {
      return false;
    }
    this.backend.snapshot = Object.freeze({ ...next });
    if (this.failAfterCommitOnce) {
      this.failAfterCommitOnce = false;
      throw new Error("synthetic lost commit acknowledgement");
    }
    return true;
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

test("an injected durable index owns metadata, signed tokens, and audit while bytes stay local", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-artifacts-repository-"));
  const backend: MemoryArtifactIndexBackend = {};
  const clock = new MutableClock(1_000);
  const signingKey = Buffer.alloc(32, 7);
  const firstRepository = new MemoryArtifactIndexRepository(backend);
  let first: LocalArtifactStore | undefined;
  let restarted: LocalArtifactStore | undefined;
  try {
    first = await LocalArtifactStore.open({
      rootDirectory,
      maxArtifactBytes: 1_024,
      clock,
      signingKey,
      random: new DeterministicRandom(),
      indexRepository: firstRepository,
    });
    await first.put(artifactInput());
    const issued = await first.issueSignedToken({
      artifactId: "artifact-report",
      expiresAtMs: 5_000,
      context,
    });
    await first.verifySignedToken({
      artifactId: "artifact-report",
      token: issued.token,
      context,
    });
    assert.ok(backend.snapshot);
    assert.equal(backend.snapshot.stateJson.includes(issued.token), false);
    await assert.rejects(readFile(join(rootDirectory, "index.json"), "utf8"), {
      code: "ENOENT",
    });
    assert.deepEqual(
      await readdir(join(rootDirectory, "objects", checksum(artifactInput().bytes).slice(0, 2))),
      [checksum(artifactInput().bytes)],
    );

    await first.close();
    first = undefined;
    assert.equal(firstRepository.closed, true);

    restarted = await LocalArtifactStore.open({
      rootDirectory,
      maxArtifactBytes: 1_024,
      clock,
      signingKey,
      random: new DeterministicRandom(),
      indexRepository: new MemoryArtifactIndexRepository(backend),
    });
    assert.equal((await restarted.getMetadata("artifact-report")).state, "available");
    await restarted.verifySignedToken({
      artifactId: "artifact-report",
      token: issued.token,
      context,
    });
    assert.deepEqual(
      (await restarted.listAuditEvents("artifact-report")).map((event) => event.eventType),
      [
        "artifact.stored",
        "artifact.signed-token-issued",
        "artifact.access-granted",
        "artifact.access-granted",
      ],
    );
  } finally {
    await first?.close();
    await restarted?.close();
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("a pristine injected index imports one legacy local index through compare-and-set", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-artifacts-legacy-index-"));
  const clock = new MutableClock(1_000);
  const signingKey = Buffer.alloc(32, 4);
  let legacy: LocalArtifactStore | undefined;
  let migrated: LocalArtifactStore | undefined;
  try {
    legacy = await LocalArtifactStore.open({
      rootDirectory,
      maxArtifactBytes: 1_024,
      clock,
      signingKey,
      random: new DeterministicRandom(),
    });
    await legacy.put(artifactInput());
    await legacy.close();
    legacy = undefined;

    const stateJson = JSON.stringify({
      schemaVersion: 1,
      generation: 0,
      artifacts: {},
      signedTokens: {},
      auditEvents: [],
      nextAuditSequence: 1,
    });
    const backend: MemoryArtifactIndexBackend = {
      snapshot: {
        schemaVersion: 1,
        generation: 0,
        stateJson,
        stateSha256: checksum(Buffer.from(stateJson, "utf8")),
      },
    };
    migrated = await LocalArtifactStore.open({
      rootDirectory,
      maxArtifactBytes: 1_024,
      clock,
      signingKey,
      random: new DeterministicRandom(),
      indexRepository: new MemoryArtifactIndexRepository(backend),
    });
    assert.equal((await migrated.getMetadata("artifact-report")).artifactId, "artifact-report");
    assert.equal(backend.snapshot?.generation, 1);
    assert.deepEqual(
      Buffer.from((await migrated.read("artifact-report")).bytes),
      artifactInput().bytes,
    );
  } finally {
    await legacy?.close();
    await migrated?.close();
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("a stale injected index writer refreshes and fails closed without losing either publication", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-artifacts-cas-"));
  const backend: MemoryArtifactIndexBackend = {};
  const clock = new MutableClock(1_000);
  const signingKey = Buffer.alloc(32, 6);
  const first = await LocalArtifactStore.open({
    rootDirectory,
    maxArtifactBytes: 1_024,
    clock,
    signingKey,
    random: new DeterministicRandom(),
    indexRepository: new MemoryArtifactIndexRepository(backend),
  });
  const second = await LocalArtifactStore.open({
    rootDirectory,
    maxArtifactBytes: 1_024,
    clock,
    signingKey,
    random: new DeterministicRandom(),
    indexRepository: new MemoryArtifactIndexRepository(backend),
  });
  try {
    await first.put(artifactInput({ artifactId: "artifact-first" }));
    await assert.rejects(
      second.put(artifactInput({ artifactId: "artifact-second" })),
      (error: unknown) =>
        error instanceof ArtifactStoreError && error.code === "ARTIFACT_STORAGE_UNAVAILABLE",
    );
    await second.put(artifactInput({ artifactId: "artifact-second" }));

    const restarted = await LocalArtifactStore.open({
      rootDirectory,
      maxArtifactBytes: 1_024,
      clock,
      signingKey,
      random: new DeterministicRandom(),
      indexRepository: new MemoryArtifactIndexRepository(backend),
    });
    try {
      assert.deepEqual(
        (await restarted.listMetadata()).map((metadata) => metadata.artifactId).sort(),
        ["artifact-first", "artifact-second"],
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("an ambiguous repository response recovers an exactly committed generation without replay", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-artifacts-ambiguous-"));
  const backend: MemoryArtifactIndexBackend = {};
  const repository = new MemoryArtifactIndexRepository(backend);
  const store = await LocalArtifactStore.open({
    rootDirectory,
    maxArtifactBytes: 1_024,
    clock: new MutableClock(1_000),
    signingKey: Buffer.alloc(32, 8),
    random: new DeterministicRandom(),
    indexRepository: repository,
  });
  try {
    repository.failAfterCommitOnce = true;
    assert.equal((await store.put(artifactInput())).artifactId, "artifact-report");
    assert.deepEqual(
      (await store.listAuditEvents()).map((event) => event.eventType),
      ["artifact.stored"],
    );
    assert.equal(backend.snapshot?.generation, 1);
  } finally {
    await store.close();
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("an injected index with a mismatched integrity digest is rejected as corrupt", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-artifacts-corrupt-"));
  const backend: MemoryArtifactIndexBackend = {};
  const repository = new MemoryArtifactIndexRepository(backend);
  const clock = new MutableClock(1_000);
  const signingKey = Buffer.alloc(32, 5);
  const first = await LocalArtifactStore.open({
    rootDirectory,
    maxArtifactBytes: 1_024,
    clock,
    signingKey,
    indexRepository: repository,
  });
  await first.close();
  assert.ok(backend.snapshot);
  backend.snapshot = { ...backend.snapshot, stateSha256: "0".repeat(64) };
  try {
    await assert.rejects(
      LocalArtifactStore.open({
        rootDirectory,
        maxArtifactBytes: 1_024,
        clock,
        signingKey,
        indexRepository: new MemoryArtifactIndexRepository(backend),
      }),
      (error: unknown) =>
        error instanceof ArtifactStoreError && error.code === "ARTIFACT_STORAGE_CORRUPT",
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("a repository corruption failure is normalized at the Artifact Store boundary", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-artifacts-repository-error-"));
  let closed = false;
  const repository: ArtifactIndexRepository = {
    load: async () => {
      throw Object.assign(new Error("synthetic SQL integrity failure"), {
        code: "DATA_CORRUPT",
      });
    },
    initialize: async (initial) => initial,
    compareAndSet: async () => false,
    close: async () => {
      closed = true;
    },
  };
  try {
    await assert.rejects(
      LocalArtifactStore.open({
        rootDirectory,
        maxArtifactBytes: 1_024,
        clock: new MutableClock(1_000),
        signingKey: Buffer.alloc(32, 3),
        indexRepository: repository,
      }),
      (error: unknown) =>
        error instanceof ArtifactStoreError && error.code === "ARTIFACT_STORAGE_CORRUPT",
    );
    assert.equal(closed, true);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
