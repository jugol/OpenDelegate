import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { PROTOCOL_VERSION, type WorkOrderV1 } from "@opendelegate/protocol";
import { LocalRunCapabilityBroker } from "@opendelegate/run-capability-broker";
import {
  WorkerEgressGuard,
  workerArtifactAssignmentFingerprint,
  type WorkerRunAssignmentV1,
  type WorkerRunLeaseAuthority,
} from "@opendelegate/worker-runtime";

import {
  ArtifactToolError,
  WorkerArtifactRunCapabilityProvider,
  consumeArtifactRunCapabilityFile,
  type ArtifactToolContext,
  type ArtifactToolPort,
} from "../src/artifact-run-capability.ts";

function assignment(runId = "run-artifact-tool"): WorkerRunAssignmentV1 {
  const workOrder: WorkOrderV1 = {
    protocolVersion: PROTOCOL_VERSION,
    workOrderId: "work-order-artifact-tool",
    title: "Write a durable report",
    brief: "Create the owner-facing report through the Artifact capability.",
    completionCriteria: ["Commit one report."],
    constraints: ["Do not include credentials."],
    selectedInputIds: [],
    dependsOn: [],
    schedulingHints: {
      preferredDeviceIds: [],
      preferredRoles: [],
    },
    requiredCapabilities: ["artifact-rendering"],
    requiredSecretRefs: [],
    workspaceId: "workspace-artifact-tool",
  };
  return {
    taskId: "task-artifact-tool",
    workOrder,
    deviceId: "device-worker",
    workerId: "worker-1",
    routeId: "route-main",
    runId,
    leaseId: `lease-${runId}`,
    fencingToken: 9,
    leaseExpiresAtMs: Date.now() + 60_000,
  };
}

async function withArtifactCapability(
  runId: string,
  guard: WorkerEgressGuard,
  run: (fixture: {
    readonly context: ArtifactToolContext;
    readonly outputRoot: string;
    readonly manifestPath: string;
    readonly port: ArtifactToolPort;
    disposeCapability(): Promise<void>;
    loseAuthority(): void;
    renewPastBootstrapExpiry(): void;
  }) => Promise<void>,
): Promise<void> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "opendelegate-artifact-capability-fixture-")),
  );
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  const outputRoot = join(runtimeDirectory, "artifact-output");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(outputRoot, { recursive: true }),
  ]);
  let now = Date.now();
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(runtimeDirectory, "capabilities"),
    sourceCheckoutDirectory: checkout,
    clock: { now: () => now },
    maxFrameBytes: 8 * 1024 * 1024,
  });
  const currentAssignment = {
    ...assignment(runId),
    leaseExpiresAtMs: now + 60_000,
  };
  const workspace = {
    workspaceId: "workspace-artifact-tool",
    cwd: await realpath(workspaceDirectory),
    isolation: "none" as const,
  };
  const manifestPath = join(outputRoot, "manifest.v1.json");
  const plan = {
    schemaVersion: 1 as const,
    outputRoot,
    manifestPath,
    assignmentFingerprint: workerArtifactAssignmentFingerprint(
      currentAssignment,
      workspace.workspaceId,
    ),
  };
  let current = true;
  let leaseExpiresAtMs = currentAssignment.leaseExpiresAtMs;
  const leaseAuthority: WorkerRunLeaseAuthority = {
    snapshot: () => ({
      leaseExpiresAtMs,
      conservativeDeadlineMonotonicMs: leaseExpiresAtMs,
    }),
    isCurrent: () => current && now < leaseExpiresAtMs,
    renewIfDue: () => Promise.resolve(),
  };
  const provider = new WorkerArtifactRunCapabilityProvider({
    broker,
    toolServerCommand: process.execPath,
  });
  const lease = await provider.prepare({
    assignment: currentAssignment,
    workspace,
    egressGuard: guard,
    leaseAuthority,
    artifact: { plan, egressGuard: guard },
    isExecutionCurrent: () => Promise.resolve(current && now < leaseExpiresAtMs),
  });
  assert.ok(lease);
  try {
    const consumed = await consumeArtifactRunCapabilityFile(
      lease.toolServers[0]?.args.at(-1) ?? "",
    );
    try {
      await run({
        context: {
          authority: consumed.authority,
          signal: new AbortController().signal,
        },
        outputRoot,
        manifestPath,
        port: consumed.port,
        disposeCapability: () => lease.dispose(),
        loseAuthority() {
          current = false;
        },
        renewPastBootstrapExpiry() {
          now = currentAssignment.leaseExpiresAtMs + 1;
          leaseExpiresAtMs = currentAssignment.leaseExpiresAtMs + 60_000;
        },
      });
    } finally {
      await consumed.close();
    }
  } finally {
    await lease.dispose();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("one exact Run writes and idempotently commits an Artifact without exposing its staging path", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-artifact-capability-")));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  const outputRoot = join(runtimeDirectory, "artifact-output");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(outputRoot, { recursive: true }),
  ]);
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(runtimeDirectory, "capabilities"),
    sourceCheckoutDirectory: checkout,
  });
  const currentAssignment = assignment();
  const workspace = {
    workspaceId: "workspace-artifact-tool",
    cwd: await realpath(workspaceDirectory),
    isolation: "none" as const,
  };
  const guard = WorkerEgressGuard.empty();
  const secret = "device-local-artifact-secret";
  await guard.protectSecrets([secret]);
  const plan = {
    schemaVersion: 1 as const,
    outputRoot,
    manifestPath: join(outputRoot, "manifest.v1.json"),
    assignmentFingerprint: workerArtifactAssignmentFingerprint(
      currentAssignment,
      workspace.workspaceId,
    ),
  };
  const provider = new WorkerArtifactRunCapabilityProvider({
    broker,
    toolServerCommand: process.execPath,
    toolServerArgsPrefix: ["worker-cli.mjs"],
  });
  const lease = await provider.prepare({
    assignment: currentAssignment,
    workspace,
    egressGuard: guard,
    leaseAuthority: staticLeaseAuthority(currentAssignment.leaseExpiresAtMs),
    artifact: { plan, egressGuard: guard },
    isExecutionCurrent: () => Promise.resolve(true),
  });
  assert.ok(lease);

  try {
    assert.deepEqual(lease.toolServers[0]?.enabledTools, [
      "artifact_write_chunk",
      "artifact_commit",
    ]);
    const capabilityFile = lease.toolServers[0]?.args.at(-1);
    assert.equal(typeof capabilityFile, "string");
    const descriptor = await readFile(capabilityFile ?? "", "utf8");
    assert.equal(descriptor.includes(outputRoot), false);
    assert.equal(descriptor.includes(secret), false);

    const consumed = await consumeArtifactRunCapabilityFile(capabilityFile ?? "");
    try {
      const context = {
        authority: consumed.authority,
        signal: new AbortController().signal,
      };
      const first = await consumed.port.writeChunk(context, {
        commandId: "write-report-0001",
        relativePath: "reports/final.md",
        offsetBytes: 0,
        contentBase64: Buffer.from("safe owner ", "utf8").toString("base64"),
      });
      assert.deepEqual(first, {
        relativePath: "reports/final.md",
        nextOffsetBytes: 11,
        replayed: false,
      });
      await consumed.port.writeChunk(context, {
        commandId: "write-report-0002",
        relativePath: "reports/final.md",
        offsetBytes: 11,
        contentBase64: Buffer.from("report\n", "utf8").toString("base64"),
      });
      assert.deepEqual(
        await consumed.port.writeChunk(context, {
          commandId: "write-report-0001",
          relativePath: "reports/final.md",
          offsetBytes: 0,
          contentBase64: Buffer.from("safe owner ", "utf8").toString("base64"),
        }),
        {
          relativePath: "reports/final.md",
          nextOffsetBytes: 11,
          replayed: true,
        },
      );
      await assert.rejects(
        consumed.port.writeChunk(context, {
          commandId: "write-report-0001",
          relativePath: "reports/final.md",
          offsetBytes: 0,
          contentBase64: Buffer.from("different", "utf8").toString("base64"),
        }),
        (error: unknown) => error instanceof ArtifactToolError && error.code === "CONFLICT",
      );

      assert.deepEqual(
        await consumed.port.commit(context, {
          commandId: "commit-report-0001",
          artifacts: [
            {
              relativePath: "reports/final.md",
              mediaType: "text/markdown",
              originalFilename: "final.md",
              requestedPresentation: "inline",
            },
          ],
        }),
        { artifactCount: 1, manifestCommitted: true, replayed: false },
      );
      assert.equal(
        await readFile(join(outputRoot, "reports", "final.md"), "utf8"),
        "safe owner report\n",
      );
      const manifest = JSON.parse(await readFile(plan.manifestPath, "utf8")) as {
        readonly assignmentFingerprint: string;
        readonly artifacts: readonly unknown[];
      };
      assert.equal(manifest.assignmentFingerprint, plan.assignmentFingerprint);
      assert.equal(manifest.artifacts.length, 1);
      await assert.rejects(
        consumed.port.writeChunk(context, {
          commandId: "write-after-commit",
          relativePath: "reports/final.md",
          offsetBytes: 18,
          contentBase64: Buffer.from("late", "utf8").toString("base64"),
        }),
        (error: unknown) => error instanceof ArtifactToolError && error.code === "CONFLICT",
      );
    } finally {
      await consumed.close();
    }
  } finally {
    await lease.dispose();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the real Worker Artifact MCP child receives only its opaque capability path", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-artifact-child-")));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  const outputRoot = join(runtimeDirectory, "artifact-output");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(outputRoot, { recursive: true }),
  ]);
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(runtimeDirectory, "capabilities"),
    sourceCheckoutDirectory: checkout,
  });
  const currentAssignment = assignment("run-artifact-child");
  const workspace = {
    workspaceId: "workspace-artifact-tool",
    cwd: await realpath(workspaceDirectory),
    isolation: "none" as const,
  };
  const guard = WorkerEgressGuard.empty();
  const inheritedSecret = "artifact-child-inherited-secret";
  await guard.protectSecrets([inheritedSecret]);
  const plan = {
    schemaVersion: 1 as const,
    outputRoot,
    manifestPath: join(outputRoot, "manifest.v1.json"),
    assignmentFingerprint: workerArtifactAssignmentFingerprint(
      currentAssignment,
      workspace.workspaceId,
    ),
  };
  const provider = new WorkerArtifactRunCapabilityProvider({
    broker,
    toolServerCommand: process.execPath,
  });
  const lease = await provider.prepare({
    assignment: currentAssignment,
    workspace,
    egressGuard: guard,
    leaseAuthority: staticLeaseAuthority(currentAssignment.leaseExpiresAtMs),
    artifact: { plan, egressGuard: guard },
    isExecutionCurrent: () => Promise.resolve(true),
  });
  assert.ok(lease);
  try {
    const capabilityFile = lease.toolServers[0]?.args.at(-1) ?? "";
    const descriptor = JSON.parse(await readFile(capabilityFile, "utf8")) as {
      readonly token: string;
    };
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        resolve(import.meta.dirname, "../src/cli.ts"),
        "artifact-mcp-bridge",
        "--capability-file",
        capabilityFile,
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          OPENDELEGATE_PRIVATE_SENTINEL: inheritedSecret,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.stdin.end(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "artifact-child-proof", version: "1.0.0" },
          },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        "",
      ].join("\n"),
    );
    const exit = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => accept({ code, signal }));
    });
    const outputText = Buffer.concat(stdout).toString("utf8");
    const errorText = Buffer.concat(stderr).toString("utf8");
    assert.deepEqual(exit, { code: 0, signal: null }, errorText);
    const responses = outputText
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly id: number;
            readonly result: Readonly<Record<string, unknown>>;
          },
      );
    assert.deepEqual(
      responses.map(({ id }) => id),
      [1, 2],
    );
    const tools = responses[1]?.result["tools"] as Array<{ readonly name: string }> | undefined;
    assert.deepEqual(
      tools?.map(({ name }) => name),
      lease.toolServers[0]?.enabledTools,
    );
    for (const privateValue of [
      descriptor.token,
      inheritedSecret,
      outputRoot,
      plan.assignmentFingerprint,
    ]) {
      assert.equal(child.spawnargs.join("\0").includes(privateValue), false);
      assert.equal(outputText.includes(privateValue), false);
      assert.equal(errorText.includes(privateValue), false);
    }
  } finally {
    await lease.dispose();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Secret split across write chunks rejects the entire Artifact commit", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "opendelegate-artifact-capability-egress-")),
  );
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  const outputRoot = join(runtimeDirectory, "artifact-output");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(outputRoot, { recursive: true }),
  ]);
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(runtimeDirectory, "capabilities"),
    sourceCheckoutDirectory: checkout,
  });
  const currentAssignment = assignment("run-artifact-egress");
  const workspace = {
    workspaceId: "workspace-artifact-tool",
    cwd: await realpath(workspaceDirectory),
    isolation: "none" as const,
  };
  const secret = "cross-chunk-secret-sentinel";
  const guard = WorkerEgressGuard.empty();
  await guard.protectSecrets([secret]);
  const plan = {
    schemaVersion: 1 as const,
    outputRoot,
    manifestPath: join(outputRoot, "manifest.v1.json"),
    assignmentFingerprint: workerArtifactAssignmentFingerprint(
      currentAssignment,
      workspace.workspaceId,
    ),
  };
  const provider = new WorkerArtifactRunCapabilityProvider({
    broker,
    toolServerCommand: process.execPath,
  });
  const lease = await provider.prepare({
    assignment: currentAssignment,
    workspace,
    egressGuard: guard,
    leaseAuthority: staticLeaseAuthority(currentAssignment.leaseExpiresAtMs),
    artifact: { plan, egressGuard: guard },
    isExecutionCurrent: () => Promise.resolve(true),
  });
  assert.ok(lease);

  try {
    const consumed = await consumeArtifactRunCapabilityFile(
      lease.toolServers[0]?.args.at(-1) ?? "",
    );
    try {
      const context = {
        authority: consumed.authority,
        signal: new AbortController().signal,
      };
      const split = 10;
      await consumed.port.writeChunk(context, {
        commandId: "write-secret-0001",
        relativePath: "tainted.bin",
        offsetBytes: 0,
        contentBase64: Buffer.concat([
          Buffer.from([0xff, 0x80]),
          Buffer.from(secret.slice(0, split), "utf8"),
        ]).toString("base64"),
      });
      await assert.rejects(
        consumed.port.writeChunk(context, {
          commandId: "write-secret-0002",
          relativePath: "tainted.bin",
          offsetBytes: split + 2,
          contentBase64: Buffer.concat([
            Buffer.from(secret.slice(split), "utf8"),
            Buffer.from([0x81]),
          ]).toString("base64"),
        }),
        (error: unknown) => error instanceof ArtifactToolError && error.code === "EGRESS_DENIED",
      );
      await assert.rejects(
        consumed.port.commit(context, {
          commandId: "commit-secret-0001",
          artifacts: [
            {
              relativePath: "tainted.bin",
              mediaType: "application/octet-stream",
              originalFilename: "tainted.bin",
            },
          ],
        }),
        (error: unknown) => error instanceof ArtifactToolError && error.code === "EGRESS_DENIED",
      );
      await assert.rejects(access(plan.manifestPath));
      await assert.rejects(access(join(outputRoot, "tainted.bin")));
    } finally {
      await consumed.close();
    }
  } finally {
    await lease.dispose();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

function staticLeaseAuthority(leaseExpiresAtMs: number): WorkerRunLeaseAuthority {
  return {
    snapshot: () => ({
      leaseExpiresAtMs,
      conservativeDeadlineMonotonicMs: leaseExpiresAtMs,
    }),
    isCurrent: () => true,
    renewIfDue: () => Promise.resolve(),
  };
}

test("Secret-bearing Artifact paths and filenames are denied before commit", async () => {
  const secret = "artifact-metadata-secret";
  for (const metadataField of ["relativePath", "originalFilename"] as const) {
    const guard = WorkerEgressGuard.empty();
    await guard.protectSecrets([secret]);
    await withArtifactCapability(
      `run-secret-${metadataField}`,
      guard,
      async ({ context, manifestPath, outputRoot, port }) => {
        const relativePath =
          metadataField === "relativePath" ? `reports/${secret}.md` : "reports/safe.md";
        await port.writeChunk(context, {
          commandId: `write-${metadataField}-0001`,
          relativePath,
          offsetBytes: 0,
          contentBase64: Buffer.from("safe owner-facing report\n", "utf8").toString("base64"),
        });
        await assert.rejects(
          port.commit(context, {
            commandId: `commit-${metadataField}-0001`,
            artifacts: [
              {
                relativePath,
                mediaType: "text/markdown",
                originalFilename: metadataField === "originalFilename" ? `${secret}.md` : "safe.md",
              },
            ],
          }),
          (error: unknown) =>
            error instanceof ArtifactToolError &&
            error.code === "EGRESS_DENIED" &&
            error.egressReason === "device-local-secret",
        );
        await assert.rejects(access(manifestPath));
        await assert.rejects(access(join(outputRoot, ...relativePath.split("/"))));
      },
    );
  }
});

test("Device-local Knowledge content and metadata cannot be committed as Artifacts", async () => {
  const knowledgeBody = "KNOWLEDGE_ARTIFACT_SENTINEL requires the private local signing procedure.";
  const knowledgeTitle = "KNOWLEDGE_ARTIFACT_TITLE_SENTINEL";
  const contentGuard = WorkerEgressGuard.empty();
  await contentGuard.protectKnowledge({
    noteIds: ["private/knowledge-artifact.md"],
    titles: [knowledgeTitle],
    contents: [knowledgeBody],
  });
  await withArtifactCapability(
    "run-knowledge-content",
    contentGuard,
    async ({ context, manifestPath, port }) => {
      await assert.rejects(
        port.writeChunk(context, {
          commandId: "write-knowledge-content-0001",
          relativePath: "report.md",
          offsetBytes: 0,
          contentBase64: Buffer.from(knowledgeBody, "utf8").toString("base64"),
        }),
        (error: unknown) =>
          error instanceof ArtifactToolError &&
          error.code === "EGRESS_DENIED" &&
          error.egressReason === "device-local-knowledge",
      );
      await assert.rejects(access(manifestPath));
    },
  );

  const metadataGuard = WorkerEgressGuard.empty();
  await metadataGuard.protectKnowledge({
    noteIds: ["private/knowledge-artifact.md"],
    titles: [knowledgeTitle],
    contents: [knowledgeBody],
  });
  await withArtifactCapability(
    "run-knowledge-metadata",
    metadataGuard,
    async ({ context, manifestPath, port }) => {
      await port.writeChunk(context, {
        commandId: "write-knowledge-metadata-0001",
        relativePath: "report.md",
        offsetBytes: 0,
        contentBase64: Buffer.from("safe owner-facing report\n", "utf8").toString("base64"),
      });
      await assert.rejects(
        port.commit(context, {
          commandId: "commit-knowledge-metadata-0001",
          artifacts: [
            {
              relativePath: "report.md",
              mediaType: "text/markdown",
              originalFilename: `${knowledgeTitle}.md`,
            },
          ],
        }),
        (error: unknown) =>
          error instanceof ArtifactToolError &&
          error.code === "EGRESS_DENIED" &&
          error.egressReason === "device-local-knowledge",
      );
      await assert.rejects(access(manifestPath));
    },
  );
});

test("a claimed Artifact writer follows the exact Run's renewed lease expiry", async () => {
  const guard = WorkerEgressGuard.empty();
  await withArtifactCapability(
    "run-artifact-renewed-lease",
    guard,
    async ({ context, manifestPath, port, renewPastBootstrapExpiry }) => {
      renewPastBootstrapExpiry();
      await port.writeChunk(context, {
        commandId: "write-after-renewal-0001",
        relativePath: "renewed.md",
        offsetBytes: 0,
        contentBase64: Buffer.from("renewed Run authority\n", "utf8").toString("base64"),
      });
      assert.deepEqual(
        await port.commit(context, {
          commandId: "commit-after-renewal-0001",
          artifacts: [
            {
              relativePath: "renewed.md",
              mediaType: "text/markdown",
              originalFilename: "renewed.md",
            },
          ],
        }),
        {
          artifactCount: 1,
          manifestCommitted: true,
          replayed: false,
        },
      );
      await access(manifestPath);
    },
  );
});

test("parallel Artifact requests serialize commit and same-offset writes deterministically", async () => {
  const guard = WorkerEgressGuard.empty();
  await withArtifactCapability(
    "run-artifact-concurrent-commit",
    guard,
    async ({ context, manifestPath, outputRoot, port }) => {
      const [write, commit] = await Promise.all([
        port.writeChunk(context, {
          commandId: "write-concurrent-commit-0001",
          relativePath: "serialized.md",
          offsetBytes: 0,
          contentBase64: Buffer.alloc(192 * 1024, 0x61).toString("base64"),
        }),
        port.commit(context, {
          commandId: "commit-concurrent-write-0001",
          artifacts: [
            {
              relativePath: "serialized.md",
              mediaType: "text/markdown",
              originalFilename: "serialized.md",
            },
          ],
        }),
      ]);
      assert.equal(write.nextOffsetBytes, 192 * 1024);
      assert.equal(commit.manifestCommitted, true);
      assert.equal((await readFile(join(outputRoot, "serialized.md"))).byteLength, 192 * 1024);
      await access(manifestPath);
    },
  );

  await withArtifactCapability(
    "run-artifact-concurrent-offset",
    guard,
    async ({ context, outputRoot, port }) => {
      const outcomes = await Promise.allSettled([
        port.writeChunk(context, {
          commandId: "write-concurrent-offset-0001",
          relativePath: "winner.md",
          offsetBytes: 0,
          contentBase64: Buffer.from("first", "utf8").toString("base64"),
        }),
        port.writeChunk(context, {
          commandId: "write-concurrent-offset-0002",
          relativePath: "winner.md",
          offsetBytes: 0,
          contentBase64: Buffer.from("second", "utf8").toString("base64"),
        }),
      ]);
      assert.equal(outcomes[0]?.status, "fulfilled");
      assert.equal(outcomes[1]?.status, "rejected");
      assert.ok(
        outcomes[1]?.status === "rejected" &&
          outcomes[1].reason instanceof ArtifactToolError &&
          outcomes[1].reason.code === "CONFLICT",
      );
      await port.commit(context, {
        commandId: "commit-concurrent-offset-0001",
        artifacts: [
          {
            relativePath: "winner.md",
            mediaType: "text/markdown",
            originalFilename: "winner.md",
          },
        ],
      });
      assert.equal(await readFile(join(outputRoot, "winner.md"), "utf8"), "first");
    },
  );
});

test("lost Run authority revokes writes and disposal removes partial staging", async () => {
  const guard = WorkerEgressGuard.empty();
  await withArtifactCapability(
    "run-artifact-authority-loss",
    guard,
    async ({ context, disposeCapability, loseAuthority, manifestPath, outputRoot, port }) => {
      await port.writeChunk(context, {
        commandId: "write-before-authority-loss-0001",
        relativePath: "partial.md",
        offsetBytes: 0,
        contentBase64: Buffer.from("partial", "utf8").toString("base64"),
      });
      loseAuthority();
      await assert.rejects(
        port.writeChunk(context, {
          commandId: "write-after-authority-loss-0001",
          relativePath: "partial.md",
          offsetBytes: 7,
          contentBase64: Buffer.from("late", "utf8").toString("base64"),
        }),
        (error: unknown) => error instanceof ArtifactToolError && error.code === "STALE_AUTHORITY",
      );
      await assert.rejects(access(manifestPath));
      assert.equal(
        (await readdir(outputRoot)).some((name) => name.startsWith(".artifact-writer-")),
        true,
      );
      await disposeCapability();
      assert.equal(
        (await readdir(outputRoot)).some((name) => name.startsWith(".artifact-writer-")),
        false,
      );
    },
  );
});
