import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NativeSessionReference } from "@opendelegate/agent-adapters";
import Database from "better-sqlite3";

import {
  AgentRunBridgeError,
  SqliteNativeSessionReferenceStore,
  WorkerEgressGuard,
  emptyWorkerEgressGuardSnapshot,
} from "../src/index.ts";

function reference(cwd: string): NativeSessionReference {
  return {
    schemaVersion: 1,
    provider: "claude",
    adapterId: "claude-cli",
    adapterVersion: "2.1.205",
    nativeSessionId: "native-session-1",
    sessionKey: "opendelegate.worker-session.v1:fixture",
    taskId: "task-1",
    workstreamId: "implementation",
    deviceId: "device-worker",
    workspaceId: "workspace-1",
    cwd,
    lineage: {
      lineageId: "lineage-1",
    },
    createdAt: "2026-07-25T00:00:00.000Z",
  };
}

test("native session state refuses a source-checkout path", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-session-store-"));
  const checkout = join(root, "checkout");
  await mkdir(checkout, { recursive: true });

  try {
    assert.throws(
      () =>
        new SqliteNativeSessionReferenceStore({
          filename: join(checkout, ".runtime", "worker.sqlite"),
          sourceCheckoutDirectory: checkout,
        }),
      (error: unknown) =>
        error instanceof AgentRunBridgeError && error.code === "SESSION_STORE_PATH_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native session state rejects checksum corruption instead of resuming unknown context", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-session-store-"));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtime, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const filename = join(runtime, "worker.sqlite");
  const session = reference(await realpath(workspace));
  const store = new SqliteNativeSessionReferenceStore({
    filename,
    sourceCheckoutDirectory: checkout,
  });

  try {
    await store.save(session, emptyWorkerEgressGuardSnapshot());
    store.close();
    const database = new Database(filename);
    database
      .prepare("UPDATE native_agent_sessions SET document = ? WHERE session_key = ?")
      .run(JSON.stringify({ compromised: true }), session.sessionKey);
    database.close();

    const reopened = new SqliteNativeSessionReferenceStore({
      filename,
      sourceCheckoutDirectory: checkout,
    });
    await assert.rejects(
      reopened.load(session.sessionKey),
      (error: unknown) =>
        error instanceof AgentRunBridgeError && error.code === "SESSION_STORE_CORRUPT",
    );
    reopened.close();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native session replacement requires an explicit continuation lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-session-store-"));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtime, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const store = new SqliteNativeSessionReferenceStore({
    filename: join(runtime, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const original = reference(await realpath(workspace));

  try {
    await store.save(original, emptyWorkerEgressGuardSnapshot());
    await assert.rejects(
      store.save(
        {
          ...original,
          nativeSessionId: "native-session-unrelated",
          lineage: {
            lineageId: "lineage-unrelated",
          },
        },
        emptyWorkerEgressGuardSnapshot(),
      ),
      (error: unknown) =>
        error instanceof AgentRunBridgeError && error.code === "SESSION_STORE_CONFLICT",
    );

    const continuation: NativeSessionReference = {
      ...original,
      nativeSessionId: "native-session-2",
      createdAt: "2026-07-25T00:01:00.000Z",
      lineage: {
        lineageId: "lineage-2",
        parentNativeSessionId: original.nativeSessionId,
        continuationReason: "The provider session was no longer resumable.",
      },
    };
    const guard = WorkerEgressGuard.empty();
    await guard.protectKnowledge({
      noteIds: ["private-path.md"],
      titles: ["Private title"],
      contents: ["Private durable Device procedure."],
    });
    await store.save(continuation, guard.snapshot());
    assert.deepEqual(await store.load(original.sessionKey), continuation);
    assert.deepEqual(await store.loadEgressGuardSnapshot(original.sessionKey), guard.snapshot());
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("next-resume steering remains exact and pending across Worker restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-session-steering-"));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtime, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const filename = join(runtime, "worker.sqlite");
  const session = reference(await realpath(workspace));
  const instruction = {
    schemaVersion: 1 as const,
    requestId: "steer-request-1",
    sourceRunId: "run-1",
    sessionKey: session.sessionKey,
    nativeSessionId: session.nativeSessionId,
    taskId: session.taskId,
    workstreamId: session.workstreamId,
    deviceId: session.deviceId,
    workspaceId: session.workspaceId,
    provider: session.provider,
    adapterId: session.adapterId,
    instruction: "Also verify the release manifest.",
    requestedBy: "owner" as const,
    queuedAt: "2026-07-25T00:02:00.000Z",
  };
  const first = new SqliteNativeSessionReferenceStore({
    filename,
    sourceCheckoutDirectory: checkout,
  });

  try {
    await first.save(session, emptyWorkerEgressGuardSnapshot());
    assert.equal(await first.queueSteeringInstruction(instruction), "queued");
    assert.equal(await first.queueSteeringInstruction(instruction), "already-queued");
    await assert.rejects(
      first.queueSteeringInstruction({
        ...instruction,
        instruction: "Conflicting replay.",
      }),
      (error: unknown) =>
        error instanceof AgentRunBridgeError && error.code === "SESSION_STORE_CONFLICT",
    );
    const laterInstruction = {
      ...instruction,
      requestId: "steer-request-0",
      instruction: "Then verify the package checksums.",
      queuedAt: "2026-07-25T00:03:00.000Z",
    };
    assert.equal(await first.queueSteeringInstruction(laterInstruction), "queued");
    first.close();

    const reopened = new SqliteNativeSessionReferenceStore({
      filename,
      sourceCheckoutDirectory: checkout,
    });
    assert.deepEqual(await reopened.loadPendingSteeringInstructions(session.sessionKey), [
      instruction,
      laterInstruction,
    ]);
    await reopened.markSteeringInstructionsDispatched(session.sessionKey, [
      instruction.requestId,
      laterInstruction.requestId,
    ]);
    assert.deepEqual(await reopened.loadPendingSteeringInstructions(session.sessionKey), []);
    reopened.close();
  } finally {
    first.close();
    await rm(root, { recursive: true, force: true });
  }
});
