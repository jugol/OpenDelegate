import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROTOCOL_VERSION, type WorkOrderV1 } from "@opendelegate/protocol";
import { LocalRunCapabilityBroker } from "@opendelegate/run-capability-broker";
import {
  WorkerEgressGuard,
  type WorkerRunAssignmentV1,
  type WorkerRunLeaseAuthority,
} from "@opendelegate/worker-runtime";

import {
  WorkspaceFileToolError,
  WorkerWorkspaceFileRunCapabilityProvider,
  consumeWorkspaceFileRunCapabilityFile,
  parseWorkspaceFileInspectInput,
  type WorkspaceFileToolContext,
  type WorkspaceFileToolPort,
} from "../src/workspace-file-run-capability.ts";

function assignment(
  runId = "run-workspace-file",
  requiredCapabilities: readonly string[] = ["file-authoring", "windows"],
): WorkerRunAssignmentV1 {
  const workOrder: WorkOrderV1 = {
    protocolVersion: PROTOCOL_VERSION,
    workOrderId: "work-order-workspace-file",
    title: "Create one text file",
    brief: "Create and verify one text file in the Run Workspace.",
    completionCriteria: ["The exact file bytes are verified."],
    constraints: ["Do not use shell."],
    selectedInputIds: [],
    dependsOn: [],
    schedulingHints: { preferredDeviceIds: [], preferredRoles: [] },
    requiredCapabilities,
    requiredSecretRefs: [],
    workspaceId: "workspace-file-tool",
  };
  return {
    taskId: "task-workspace-file",
    workOrder,
    deviceId: "device-worker",
    workerId: "worker-1",
    routeId: "route-main",
    runId,
    leaseId: `lease-${runId}`,
    fencingToken: 7,
    leaseExpiresAtMs: Date.now() + 60_000,
  };
}

async function withWorkspaceFileCapability(
  run: (fixture: {
    readonly root: string;
    readonly context: WorkspaceFileToolContext;
    readonly port: WorkspaceFileToolPort;
    readonly capabilityDescriptor: string;
    loseAuthority(): void;
  }) => Promise<void>,
  guard = WorkerEgressGuard.empty(),
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-workspace-file-")));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtime, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(runtime, "capabilities"),
    sourceCheckoutDirectory: checkout,
    maxFrameBytes: 8 * 1024 * 1024,
  });
  const currentAssignment = assignment();
  let current = true;
  const provider = new WorkerWorkspaceFileRunCapabilityProvider({
    broker,
    toolServerCommand: process.execPath,
    toolServerArgsPrefix: ["worker-cli.mjs"],
  });
  const lease = await provider.prepare({
    assignment: currentAssignment,
    workspace: {
      workspaceId: "workspace-file-tool",
      cwd: await realpath(workspace),
      isolation: "none",
    },
    egressGuard: guard,
    leaseAuthority: staticLeaseAuthority(currentAssignment.leaseExpiresAtMs),
    isExecutionCurrent: () => Promise.resolve(current),
  });
  assert.ok(lease);
  const capabilityFile = lease.toolServers[0]?.args.at(-1) ?? "";
  const capabilityDescriptor = await readFile(capabilityFile, "utf8");
  try {
    const consumed = await consumeWorkspaceFileRunCapabilityFile(capabilityFile);
    try {
      await run({
        root: workspace,
        context: {
          authority: consumed.authority,
          signal: new AbortController().signal,
        },
        port: consumed.port,
        capabilityDescriptor,
        loseAuthority() {
          current = false;
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

test("a file-authoring Run inspects actual Workspace bytes without exposing the root", async () => {
  await withWorkspaceFileCapability(async ({ root, context, port, capabilityDescriptor }) => {
    const content = "OpenDelegate file inspection.\n";
    await writeFile(join(root, "result.txt"), content, "utf8");

    assert.equal(capabilityDescriptor.includes(root), false);
    assert.deepEqual(await port.inspect(context, { relativePath: "result.txt" }), {
      relativePath: "result.txt",
      sizeBytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      utf8Valid: true,
      bom: "none",
      finalLf: true,
      text: content,
    });
  });
});

test("the capability is absent unless the Work Order explicitly requires file-authoring", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-workspace-file-gate-")));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtime, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(runtime, "capabilities"),
    sourceCheckoutDirectory: checkout,
  });
  try {
    const currentAssignment = assignment("run-no-file-authoring", ["windows"]);
    const provider = new WorkerWorkspaceFileRunCapabilityProvider({
      broker,
      toolServerCommand: process.execPath,
    });
    assert.equal(
      await provider.prepare({
        assignment: currentAssignment,
        workspace: {
          workspaceId: "workspace-file-tool",
          cwd: workspace,
          isolation: "none",
        },
        egressGuard: WorkerEgressGuard.empty(),
        leaseAuthority: staticLeaseAuthority(currentAssignment.leaseExpiresAtMs),
        isExecutionCurrent: () => Promise.resolve(true),
      }),
      undefined,
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("portable relative paths reject traversal and host-absolute paths", () => {
  for (const value of ["../secret.txt", "a/../../secret.txt", "/etc/passwd", "C:/secret.txt"]) {
    assert.throws(
      () => parseWorkspaceFileInspectInput({ relativePath: value }),
      (error: unknown) =>
        error instanceof WorkspaceFileToolError && error.code === "INVALID_REQUEST",
    );
  }
});

test("Workspace links are rejected instead of being followed", async (t) => {
  await withWorkspaceFileCapability(async ({ root, context, port }) => {
    const outside = join(root, "..", "outside-workspace-file.txt");
    await writeFile(outside, "outside\n", "utf8");
    try {
      await symlink(outside, join(root, "linked.txt"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("The host does not permit test symlink creation.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      port.inspect(context, { relativePath: "linked.txt" }),
      (error: unknown) =>
        error instanceof WorkspaceFileToolError && error.code === "INVALID_REQUEST",
    );
    await rm(outside, { force: true });
  });
});

test("stale Run authority cannot inspect a Workspace file", async () => {
  await withWorkspaceFileCapability(async ({ root, context, port, loseAuthority }) => {
    await writeFile(join(root, "result.txt"), "safe\n", "utf8");
    loseAuthority();
    await assert.rejects(
      port.inspect(context, { relativePath: "result.txt" }),
      (error: unknown) =>
        error instanceof WorkspaceFileToolError && error.code === "STALE_AUTHORITY",
    );
  });
});

test("the Run egress guard blocks protected file content", async () => {
  const guard = WorkerEgressGuard.empty();
  const secret = "device-local-workspace-file-secret";
  await guard.protectSecrets([secret]);
  await withWorkspaceFileCapability(async ({ root, context, port }) => {
    await writeFile(join(root, "result.txt"), `${secret}\n`, "utf8");
    await assert.rejects(
      port.inspect(context, { relativePath: "result.txt" }),
      (error: unknown) =>
        error instanceof WorkspaceFileToolError &&
        error.code === "EGRESS_DENIED" &&
        error.egressReason === "device-local-secret",
    );
  }, guard);
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
