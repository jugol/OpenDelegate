import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { AgentAdapterError } from "@opendelegate/agent-adapters";

import {
  createWorkerAgentAdapters,
  createWorkerNativeSessionLeaseStore,
  resolveWorkerPaths,
} from "../src/worker-app.ts";

test("Worker composes every native provider behind one restart-durable session lease store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-session-leases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: resolve("."),
    home: join(root, "worker"),
  });

  const firstProcess = createWorkerNativeSessionLeaseStore(paths);
  const firstLease = await firstProcess.acquire(
    "task-release/implementation",
    "worker-process-a",
    60_000,
    10_000,
  );
  const restartedProcess = createWorkerNativeSessionLeaseStore(paths);
  await assert.rejects(
    restartedProcess.acquire("task-release/implementation", "worker-process-b", 60_000, 10_001),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "NATIVE_SESSION_BUSY" && error.retryable,
  );

  await firstProcess.release(firstLease);
  const nextLease = await restartedProcess.acquire(
    "task-release/implementation",
    "worker-process-b",
    60_000,
    10_002,
  );
  assert.equal(nextLease.fence, firstLease.fence + 1);
  assert.equal(paths.nativeSessionLeaseStateFile.startsWith(paths.stateDirectory), true);

  const adapters = createWorkerAgentAdapters(
    {
      provider: "auto",
      allowUntestedVersion: false,
    },
    paths,
    restartedProcess,
  );
  assert.deepEqual(
    adapters.map(({ adapterId }) => adapterId),
    ["codex-app-server", "claude-agent-sdk", "codex-cli", "claude-cli"],
  );
});
