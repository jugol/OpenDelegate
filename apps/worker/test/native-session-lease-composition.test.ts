import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

test(
  "Windows service composition discovers the real Codex adapters in the owner npm path",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-codex-path-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const npmDirectory = join(root, "owner", "AppData", "Roaming", "npm");
    const codexEntrypoint = join(
      npmDirectory,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    const fixtureUrl = new URL(
      "../../../packages/agent-adapters/fixtures/fake-provider.mjs",
      import.meta.url,
    );
    const ownerCodexHome = join(root, "owner", ".codex");
    const serviceCodexHome = join(root, "service-state", "providers", "codex");
    await mkdir(dirname(codexEntrypoint), { recursive: true });
    await writeFile(
      codexEntrypoint,
      `process.env.FIXTURE_EXPECT_CODEX_HOME = ${JSON.stringify(serviceCodexHome)};\nprocess.argv.splice(2, 0, "codex");\nimport(${JSON.stringify(fixtureUrl.href)}).catch(() => process.exit(1));\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const paths = resolveWorkerPaths({
      sourceCheckoutRoot: resolve("."),
      home: join(root, "worker"),
    });
    const environment = {
      PATH: `${npmDirectory};C:\\Windows\\System32`,
      CODEX_HOME: serviceCodexHome,
      OPENDELEGATE_SERVICE_MODE: "system-service",
    };
    const adapters = createWorkerAgentAdapters(
      {
        provider: "auto",
        allowUntestedVersion: false,
        codexHome: ownerCodexHome,
      },
      paths,
      undefined,
      environment,
    ).filter((adapter) => adapter.provider === "codex");

    const probes = await Promise.all(adapters.map((adapter) => adapter.probe({ environment })));

    assert.deepEqual(
      probes.map((probe) => ({
        adapterId: probe.adapterId,
        installed: probe.installed,
        version: probe.version,
        compatibility: probe.compatibility,
        auth: probe.auth.state,
      })),
      [
        {
          adapterId: "codex-app-server",
          installed: true,
          version: "0.146.0",
          compatibility: "tested",
          auth: "ready",
        },
        {
          adapterId: "codex-cli",
          installed: true,
          version: "0.146.0",
          compatibility: "tested",
          auth: "ready",
        },
      ],
    );
  },
);
