import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROTOCOL_VERSION } from "@opendelegate/protocol";

import {
  WorkerRuntimeError,
  configurationFingerprint,
  createSqliteWorkerStateRepository,
  sanitizeWorkerDiagnostic,
  validateWorkerConfiguration,
  type PersistedWorkerState,
  type WorkerConfiguration,
} from "../src/index.ts";

function configuration(): WorkerConfiguration {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "device-worker-1",
    workerId: "worker-1",
    mainDeviceId: "device-main",
    transportProfile: {
      deviceId: "device-main",
      endpoints: [
        {
          endpointId: "route-main",
          label: "Main route",
          kind: "wss",
          url: "wss://main.example.test/worker",
          credentialRef: "secret://device-certificate",
        },
      ],
    },
    maxOutboxEntries: 8,
    cancelGraceMs: 1_000,
  };
}

test("Worker configuration rejects database credentials even when hidden in a nested route", () => {
  const unsafe = {
    ...configuration(),
    transportProfile: {
      ...configuration().transportProfile,
      endpoints: [
        {
          ...configuration().transportProfile.endpoints[0],
          databaseUri: "postgres://owner:secret@database.example.test/opendelegate",
        },
      ],
    },
  };

  assert.throws(
    () => validateWorkerConfiguration(unsafe as unknown as WorkerConfiguration),
    (error: unknown) => {
      assert.equal(error instanceof WorkerRuntimeError, true);
      assert.equal((error as WorkerRuntimeError).code, "INVALID_CONFIGURATION");
      assert.equal((error as Error).message.includes("owner:secret"), false);
      return true;
    },
  );
});

test("the SQLite composition boundary rejects source-checkout and relative runtime paths", () => {
  const checkout = process.cwd();
  assert.throws(
    () =>
      createSqliteWorkerStateRepository({
        filename: join(checkout, ".runtime", "worker.sqlite"),
        sourceCheckoutDirectory: checkout,
      }),
    (error: unknown) => {
      assert.equal(error instanceof WorkerRuntimeError, true);
      assert.equal((error as WorkerRuntimeError).code, "INVALID_RUNTIME_PATH");
      return true;
    },
  );
  assert.throws(
    () => createSqliteWorkerStateRepository({ filename: "worker.sqlite" }),
    (error: unknown) => {
      assert.equal(error instanceof WorkerRuntimeError, true);
      assert.equal((error as WorkerRuntimeError).code, "INVALID_RUNTIME_PATH");
      return true;
    },
  );
});

test("diagnostic sanitization copies only allowlisted inert values", () => {
  let getterRead = false;
  const diagnostic = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(diagnostic, {
    code: { enumerable: true, value: "PROCESS_FAILED" },
    stage: { enumerable: true, value: "execution" },
    retryable: { enumerable: true, value: true },
    token: {
      enumerable: true,
      get() {
        getterRead = true;
        return "secret";
      },
    },
  });

  assert.deepEqual(sanitizeWorkerDiagnostic(diagnostic), {
    code: "PROCESS_FAILED",
    stage: "execution",
    retryable: true,
  });
  assert.equal(getterRead, false);
});

test("the local repository refuses an incompatible durable state document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-worker-state-"));
  const repository = createSqliteWorkerStateRepository({
    filename: join(directory, "worker.sqlite"),
  });
  const incompatible = {
    schemaVersion: 2,
    generation: 0,
    configuration: configuration(),
    configurationFingerprint: "invalid",
    operationalState: "active",
    lastObservedAtMs: 1_000,
    inbox: [],
    runs: [],
    outbox: [],
    nextOutboxSequence: 1,
  } as unknown as PersistedWorkerState;

  try {
    await assert.rejects(
      () => repository.initialize(incompatible),
      (error: unknown) => {
        assert.equal(error instanceof WorkerRuntimeError, true);
        assert.equal((error as WorkerRuntimeError).code, "STATE_CORRUPT");
        return true;
      },
    );
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the local repository rejects incoherent durable progress bounds after restart", async () => {
  const variants = [
    {
      progressCount: -1,
      lastProgressAtMs: 1_000,
      lastProgressDigest: "a".repeat(64),
    },
    {
      progressCount: 1,
      lastProgressAtMs: 1_001,
      lastProgressDigest: "a".repeat(64),
    },
    {
      progressCount: 1,
      lastProgressAtMs: 1_000,
      lastProgressDigest: "provider-session-id",
    },
    {
      lastProgressAtMs: 1_000,
      lastProgressDigest: "a".repeat(64),
    },
  ] as const;

  for (const [index, progress] of variants.entries()) {
    const directory = await mkdtemp(join(tmpdir(), `opendelegate-worker-progress-state-${index}-`));
    const repository = createSqliteWorkerStateRepository({
      filename: join(directory, "worker.sqlite"),
    });
    const workerConfiguration = configuration();
    const state = {
      schemaVersion: 1,
      generation: 0,
      configuration: workerConfiguration,
      configurationFingerprint: configurationFingerprint(workerConfiguration),
      operationalState: "active",
      lastObservedAtMs: 1_000,
      inbox: [],
      runs: [
        {
          assignment: {},
          dispatchMessageId: "dispatch-1",
          assignmentFingerprint: "sha256:fixture",
          state: "running",
          acceptedAtMs: 900,
          ...progress,
        },
      ],
      outbox: [],
      nextOutboxSequence: 1,
    } as unknown as PersistedWorkerState;

    try {
      await assert.rejects(
        () => repository.initialize(state),
        (error: unknown) => {
          assert.equal(error instanceof WorkerRuntimeError, true);
          assert.equal((error as WorkerRuntimeError).code, "STATE_CORRUPT");
          return true;
        },
      );
    } finally {
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
