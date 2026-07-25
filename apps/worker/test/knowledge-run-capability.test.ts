import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KnowledgeToolPortError } from "@opendelegate/knowledge-mcp";
import { LocalKnowledgeService } from "@opendelegate/knowledge";
import {
  LocalRunCapabilityBroker,
  RunCapabilityBrokerError,
} from "@opendelegate/run-capability-broker";
import {
  WorkerEgressGuard,
  type WorkerRunAssignmentV1,
  type WorkerRunLeaseAuthority,
} from "@opendelegate/worker-runtime";

import {
  WorkerKnowledgeRunCapabilityProvider,
  consumeKnowledgeRunCapabilityFile,
} from "../src/knowledge-run-capability.ts";

test("one exact Run receives one local Knowledge MCP connection with no Knowledge egress", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-worker-knowledge-")));
  const knowledgeRoot = join(root, "knowledge-private");
  const runtimeRoot = join(root, "runtime");
  await mkdir(knowledgeRoot, { recursive: true });
  await writeFile(
    join(knowledgeRoot, "build.md"),
    "# Private build title\nUse the private local runner. See [[runner]].",
    "utf8",
  );
  await writeFile(
    join(knowledgeRoot, "runner.md"),
    "# Private runner title\nOnly this device knows the runner.",
    "utf8",
  );
  const knowledge = new LocalKnowledgeService({ root: knowledgeRoot });
  await knowledge.rebuild();
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: runtimeRoot,
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => 1_000 },
  });
  const provider = new WorkerKnowledgeRunCapabilityProvider({
    broker,
    knowledge,
    toolServerCommand: process.execPath,
    toolServerArgsPrefix: ["worker-cli.mjs"],
    budgets: {
      maxCumulativeSearchCandidates: 4,
      maxCumulativeOpenCharacters: 128,
      maxCumulativeContextCharacters: 2_048,
    },
  });

  try {
    const egressGuard = WorkerEgressGuard.empty();
    const lease = await provider.prepare({
      assignment: assignment(),
      egressGuard,
      isExecutionCurrent: async () => true,
    });
    assert.ok(lease);
    assert.deepEqual(lease.toolServers, [
      {
        serverName: "opendelegate-knowledge",
        command: process.execPath,
        args: [
          "worker-cli.mjs",
          "knowledge-mcp-bridge",
          "--capability-file",
          lease.toolServers[0]?.args[3],
        ],
        enabledTools: [
          "knowledge_search",
          "knowledge_open",
          "knowledge_relationships",
          "knowledge_upsert",
        ],
        startupTimeoutMs: 15_000,
        toolTimeoutMs: 30_000,
      },
    ]);
    const capabilityFile = lease.toolServers[0]?.args[3];
    assert.equal(typeof capabilityFile, "string");
    const descriptorText = await readFile(capabilityFile ?? "", "utf8");
    const descriptor = JSON.parse(descriptorText) as { token: string };
    const publicSurface = JSON.stringify({ toolServers: lease.toolServers, descriptor });
    for (const privateValue of [
      knowledgeRoot,
      "build.md",
      "runner.md",
      "Private build title",
      "Use the private local runner",
    ]) {
      assert.equal(publicSurface.includes(privateValue), false);
    }
    assert.equal(JSON.stringify(lease.toolServers).includes(descriptor.token), false);
    if (process.platform !== "win32") {
      assert.equal((await lstat(capabilityFile ?? "")).mode & 0o077, 0);
    }

    const consumed = await consumeKnowledgeRunCapabilityFile(capabilityFile ?? "");
    assert.deepEqual(consumed.authority, {
      taskId: "task-1",
      workOrderId: "work-order-1",
      runId: "run-1",
      deviceId: "device-1",
      leaseId: "run-lease-1",
      fencingToken: 9,
      leaseExpiresAtMs: 4_000_000_000_000,
    });
    assert.deepEqual(consumed.limits, {
      maxCumulativeSearchCandidates: 4,
      maxCumulativeOpenCharacters: 128,
      maxCumulativeContextCharacters: 2_048,
    });
    const context = {
      authority: consumed.authority,
      signal: new AbortController().signal,
    };
    const candidates = await consumed.port.search(context, {
      query: "local runner",
      limit: 2,
    });
    assert.ok(candidates.some((candidate) => candidate.noteId === "build.md"));
    const opened = await consumed.port.open(context, {
      noteIds: ["build.md"],
      totalCharacterBudget: 64,
    });
    assert.match(opened.notes[0]?.content ?? "", /private local runner/u);
    assert.deepEqual(await consumed.port.relationships(context, { noteId: "build.md" }), {
      outgoing: ["runner.md"],
      backlinks: [],
    });
    assert.deepEqual(
      await consumed.port.upsert(context, {
        noteId: "workflow.md",
        contentKind: "durable-device-knowledge",
        content: "# Workflow\nUse [[runner]] for durable device work.",
        qualification: {
          deviceSpecific: true,
          repeatedlyUseful: true,
          expensiveToRediscover: true,
          actionable: true,
        },
      }),
      { noteId: "workflow.md", operation: "created" },
    );
    assert.equal(knowledge.search("durable device work")[0]?.noteId, "workflow.md");
    for (const protectedValue of [
      "build.md",
      "Private build title",
      "Use the private local runner",
      "workflow.md",
      "Use [[runner]] for durable device work",
    ]) {
      assert.equal(
        egressGuard.inspectText(protectedValue).safe,
        false,
        `Expected local Knowledge DLP to protect ${protectedValue}`,
      );
    }

    await assert.rejects(
      consumeKnowledgeRunCapabilityFile(capabilityFile ?? ""),
      RunCapabilityBrokerError,
    );
    await consumed.close();
    await lease.dispose();
    await lease.dispose();
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a claimed Knowledge capability follows the exact Run's renewed lease expiry", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "opendelegate-worker-knowledge-renewed-")),
  );
  const knowledgeRoot = join(root, "knowledge");
  await mkdir(knowledgeRoot, { recursive: true });
  await writeFile(join(knowledgeRoot, "durable.md"), "# Durable\nRenewed local context.", "utf8");
  const knowledge = new LocalKnowledgeService({ root: knowledgeRoot });
  await knowledge.rebuild();
  const initialNowMs = Date.now();
  let nowMs = initialNowMs;
  let leaseExpiresAtMs = initialNowMs + 10_000;
  const leaseAuthority: WorkerRunLeaseAuthority = {
    snapshot: () => ({
      leaseExpiresAtMs,
      conservativeDeadlineMonotonicMs: leaseExpiresAtMs,
    }),
    isCurrent: () => true,
    async renewIfDue() {},
  };
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(root, "runtime"),
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => nowMs },
  });
  const provider = new WorkerKnowledgeRunCapabilityProvider({
    broker,
    knowledge,
    toolServerCommand: process.execPath,
    budgets: {
      maxCumulativeSearchCandidates: 4,
      maxCumulativeOpenCharacters: 128,
      maxCumulativeContextCharacters: 1_024,
    },
  });

  try {
    const lease = await provider.prepare({
      assignment: { ...assignment(), leaseExpiresAtMs },
      leaseAuthority,
      egressGuard: WorkerEgressGuard.empty(),
      isExecutionCurrent: async () => true,
    });
    assert.ok(lease);
    const consumed = await consumeKnowledgeRunCapabilityFile(lease.toolServers[0]?.args[2] ?? "");
    const context = {
      authority: consumed.authority,
      signal: new AbortController().signal,
    };

    leaseExpiresAtMs = initialNowMs + 30_000;
    nowMs = initialNowMs + 15_000;
    const candidates = await consumed.port.search(context, {
      query: "renewed local context",
      limit: 1,
    });
    assert.equal(candidates[0]?.noteId, "durable.md");

    await consumed.close();
    await lease.dispose();
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Run revocation, cancellation, restart, authority mismatch, and path attacks fail closed", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "opendelegate-worker-knowledge-stale-")),
  );
  const knowledgeRoot = join(root, "knowledge");
  await mkdir(knowledgeRoot, { recursive: true });
  await writeFile(join(knowledgeRoot, "safe.md"), "# Safe\nLocal only.", "utf8");
  const knowledge = new LocalKnowledgeService({ root: knowledgeRoot });
  await knowledge.rebuild();
  let current = true;
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(root, "runtime"),
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => 1_000 },
  });
  const provider = new WorkerKnowledgeRunCapabilityProvider({
    broker,
    knowledge,
    toolServerCommand: process.execPath,
    budgets: {
      maxCumulativeSearchCandidates: 2,
      maxCumulativeOpenCharacters: 64,
      maxCumulativeContextCharacters: 1_024,
    },
  });

  try {
    const lease = await provider.prepare({
      assignment: assignment(),
      egressGuard: WorkerEgressGuard.empty(),
      isExecutionCurrent: async () => current,
    });
    assert.ok(lease);
    const consumed = await consumeKnowledgeRunCapabilityFile(lease.toolServers[0]?.args[2] ?? "");
    const context = {
      authority: consumed.authority,
      signal: new AbortController().signal,
    };
    await assert.rejects(
      consumed.port.open(context, {
        noteIds: ["../escape.md"],
        totalCharacterBudget: 8,
      }),
      KnowledgeToolPortError,
    );
    assert.equal(await fileExists(join(root, "escape.md")), false);

    await assert.rejects(
      consumed.port.search(
        {
          ...context,
          authority: { ...consumed.authority, fencingToken: 10 },
        },
        { query: "safe", limit: 1 },
      ),
      (error: unknown) =>
        error instanceof KnowledgeToolPortError && error.code === "STALE_AUTHORITY",
    );

    await consumed.port.search(context, { query: "safe", limit: 2 });
    await assert.rejects(
      consumed.port.search(context, { query: "safe", limit: 1 }),
      KnowledgeToolPortError,
    );

    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      consumed.port.relationships(
        { authority: consumed.authority, signal: cancelled.signal },
        { noteId: "safe.md" },
      ),
      (error: unknown) => error instanceof KnowledgeToolPortError && error.code === "CANCELLED",
    );

    current = false;
    await assert.rejects(
      consumed.port.relationships(context, { noteId: "safe.md" }),
      (error: unknown) =>
        error instanceof KnowledgeToolPortError && error.code === "STALE_AUTHORITY",
    );
    await consumed.close();
    await lease.dispose();

    current = true;
    const restartLease = await provider.prepare({
      assignment: { ...assignment(), runId: "run-2", fencingToken: 10 },
      egressGuard: WorkerEgressGuard.empty(),
      isExecutionCurrent: async () => true,
    });
    assert.ok(restartLease);
    const restarted = await consumeKnowledgeRunCapabilityFile(
      restartLease.toolServers[0]?.args[2] ?? "",
    );
    await broker.close();
    await assert.rejects(
      restarted.port.search(
        {
          authority: restarted.authority,
          signal: new AbortController().signal,
        },
        { query: "safe", limit: 1 },
      ),
      (error: unknown) =>
        error instanceof KnowledgeToolPortError && error.code === "STALE_AUTHORITY",
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

function assignment(): WorkerRunAssignmentV1 {
  return {
    taskId: "task-1",
    workOrder: {
      protocolVersion: "v1",
      workOrderId: "work-order-1",
      title: "Use local Knowledge",
      brief: "Complete the fixture.",
      completionCriteria: ["Fixture completed"],
      constraints: [],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: { preferredDeviceIds: [], preferredRoles: [] },
      requiredCapabilities: [],
      requiredSecretRefs: [],
    },
    deviceId: "device-1",
    workerId: "worker-1",
    routeId: "route-1",
    runId: "run-1",
    leaseId: "run-lease-1",
    fencingToken: 9,
    leaseExpiresAtMs: 4_000_000_000_000,
  };
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch {
    return false;
  }
}
