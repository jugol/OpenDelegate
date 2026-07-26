import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROTOCOL_VERSION, type WorkOrderV1 } from "@opendelegate/protocol";
import {
  WorkerEgressGuard,
  workerArtifactAssignmentFingerprint,
  type WorkerRunAssignmentV1,
} from "@opendelegate/worker-runtime";

import { FileManifestWorkerArtifactLifecycle } from "../src/artifact-promotion.ts";

function assignment(): WorkerRunAssignmentV1 {
  const workOrder: WorkOrderV1 = {
    protocolVersion: PROTOCOL_VERSION,
    workOrderId: "work-order-report",
    title: "Create a durable report",
    brief: "Create a Markdown report for the owner.",
    completionCriteria: ["Upload the report."],
    constraints: ["Do not include credentials."],
    selectedInputIds: [],
    dependsOn: [],
    schedulingHints: {
      preferredDeviceIds: [],
      preferredRoles: [],
    },
    requiredCapabilities: ["artifact-rendering"],
    requiredSecretRefs: [],
    workspaceId: "workspace-reports",
  };
  return {
    taskId: "task-report",
    workOrder,
    deviceId: "device-worker",
    workerId: "worker-1",
    routeId: "route-main",
    runId: "run-report",
    leaseId: "lease-report",
    fencingToken: 7,
    leaseExpiresAtMs: 100_000,
  };
}

test("a valid per-Run manifest promotes regular files with immutable assignment provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-promotion-"));
  const checkout = join(root, "checkout");
  const staging = join(root, "runtime", "artifact-staging");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(staging, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspace = {
    workspaceId: "workspace-reports",
    cwd: await realpath(workspaceDirectory),
    isolation: "none" as const,
  };
  const currentAssignment = assignment();
  let originalArtifactPath: string | undefined;
  const delivered: Array<{
    readonly manifest: {
      readonly artifactId: string;
      readonly runId: string;
      readonly leaseId: string;
      readonly fencingToken: number;
      readonly expectedSha256: string;
    };
    readonly sourcePath: string;
    readonly bytes: string;
  }> = [];
  const lifecycle = await FileManifestWorkerArtifactLifecycle.create({
    stagingRoot: staging,
    sourceCheckoutRoot: checkout,
    delivery: {
      async deliver(input) {
        assert.equal(await input.isExecutionCurrent(), true);
        if (originalArtifactPath !== undefined) {
          await writeFile(originalArtifactPath, "not-present-in-the-report\n", "utf8");
        }
        delivered.push({
          manifest: input.manifest,
          sourcePath: input.sourcePath,
          bytes: await readFile(input.sourcePath, "utf8"),
        });
        return {
          protocolVersion: PROTOCOL_VERSION,
          uploadId: "upload-report",
          artifactId: input.manifest.artifactId,
          nextOffsetBytes: input.manifest.declaredSizeBytes,
          complete: true,
          replayed: false,
        };
      },
    },
  });

  try {
    const assignmentFingerprint = workerArtifactAssignmentFingerprint(
      currentAssignment,
      workspace.workspaceId,
    );
    const plan = await lifecycle.prepare({
      assignment: currentAssignment,
      workspace,
      assignmentFingerprint,
    });
    originalArtifactPath = join(plan.outputRoot, "report.md");
    await writeFile(originalArtifactPath, "durable report\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(
      plan.manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        assignmentFingerprint,
        artifacts: [
          {
            relativePath: "report.md",
            mediaType: "text/markdown",
            originalFilename: "report.md",
            requestedPresentation: "inline",
          },
        ],
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const guard = WorkerEgressGuard.empty();
    await guard.protectSecrets(["not-present-in-the-report"]);
    const artifactIds = await lifecycle.promote({
      assignment: currentAssignment,
      workspace,
      plan,
      egressGuard: guard,
      isExecutionCurrent: () => Promise.resolve(true),
    });

    assert.equal(artifactIds.length, 1);
    assert.match(artifactIds[0] ?? "", /^artifact-[a-f0-9]{64}$/u);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.manifest.artifactId, artifactIds[0]);
    assert.equal(delivered[0]?.manifest.runId, "run-report");
    assert.equal(delivered[0]?.manifest.leaseId, "lease-report");
    assert.equal(delivered[0]?.manifest.fencingToken, 7);
    assert.equal(
      delivered[0]?.manifest.expectedSha256,
      "41bd100d6cd105be8b0e8213db8d4ecf8a9b6e7ab7d306aa5c9db1a4b3e2bee9",
    );
    assert.notEqual(delivered[0]?.sourcePath, await realpath(originalArtifactPath));
    assert.match(delivered[0]?.sourcePath ?? "", /\.sealed-artifacts-/u);
    assert.equal(delivered[0]?.bytes, "durable report\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a manifest rejects assignment replay and cross-platform path aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-replay-"));
  const checkout = join(root, "checkout");
  const staging = join(root, "runtime", "artifact-staging");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(staging, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspace = {
    workspaceId: "workspace-reports",
    cwd: await realpath(workspaceDirectory),
    isolation: "none" as const,
  };
  let deliveryCalls = 0;
  const lifecycle = await FileManifestWorkerArtifactLifecycle.create({
    stagingRoot: staging,
    sourceCheckoutRoot: checkout,
    delivery: {
      async deliver() {
        deliveryCalls += 1;
        throw new Error("must not deliver");
      },
    },
  });

  try {
    const currentAssignment = assignment();
    const assignmentFingerprint = workerArtifactAssignmentFingerprint(
      currentAssignment,
      workspace.workspaceId,
    );
    const plan = await lifecycle.prepare({
      assignment: currentAssignment,
      workspace,
      assignmentFingerprint,
    });
    await writeFile(join(plan.outputRoot, "report.md"), "durable report\n");
    await writeFile(
      plan.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        assignmentFingerprint: "b".repeat(64),
        artifacts: [
          {
            relativePath: "report.md",
            mediaType: "text/markdown",
            originalFilename: "report.md",
          },
        ],
      }),
    );

    await assert.rejects(
      lifecycle.promote({
        assignment: currentAssignment,
        workspace,
        plan,
        egressGuard: WorkerEgressGuard.empty(),
        isExecutionCurrent: () => Promise.resolve(true),
      }),
      { code: "MANIFEST_INVALID" },
    );
    assert.equal(deliveryCalls, 0);

    await writeFile(
      plan.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        assignmentFingerprint,
        artifacts: [
          {
            relativePath: "Report.md",
            mediaType: "text/markdown",
            originalFilename: "Report.md",
          },
          {
            relativePath: "report.md",
            mediaType: "text/markdown",
            originalFilename: "report.md",
          },
        ],
      }),
    );
    await assert.rejects(
      lifecycle.promote({
        assignment: currentAssignment,
        workspace,
        plan,
        egressGuard: WorkerEgressGuard.empty(),
        isExecutionCurrent: () => Promise.resolve(true),
      }),
      { code: "MANIFEST_INVALID" },
    );
    assert.equal(deliveryCalls, 0);

    await writeFile(
      plan.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        assignmentFingerprint,
        artifacts: [
          {
            relativePath: "reports/CON.txt",
            mediaType: "text/plain",
            originalFilename: "CON.txt",
          },
        ],
      }),
    );
    await assert.rejects(
      lifecycle.promote({
        assignment: currentAssignment,
        workspace,
        plan,
        egressGuard: WorkerEgressGuard.empty(),
        isExecutionCurrent: () => Promise.resolve(true),
      }),
      { code: "MANIFEST_INVALID" },
    );
    assert.equal(deliveryCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Artifact paths cannot traverse or follow a linked directory outside the per-Run root", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-path-"));
  const checkout = join(root, "checkout");
  const staging = join(root, "runtime", "artifact-staging");
  const workspaceDirectory = join(root, "workspace");
  const outsideDirectory = join(root, "outside");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(staging, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(outsideDirectory, { recursive: true }),
  ]);
  const workspace = {
    workspaceId: "workspace-reports",
    cwd: await realpath(workspaceDirectory),
    isolation: "none" as const,
  };
  let deliveryCalls = 0;
  const lifecycle = await FileManifestWorkerArtifactLifecycle.create({
    stagingRoot: staging,
    sourceCheckoutRoot: checkout,
    delivery: {
      async deliver() {
        deliveryCalls += 1;
        throw new Error("must not deliver");
      },
    },
  });

  try {
    const currentAssignment = assignment();
    const assignmentFingerprint = workerArtifactAssignmentFingerprint(
      currentAssignment,
      workspace.workspaceId,
    );
    const plan = await lifecycle.prepare({
      assignment: currentAssignment,
      workspace,
      assignmentFingerprint,
    });
    await writeFile(join(outsideDirectory, "private.txt"), "outside\n");
    await symlink(
      outsideDirectory,
      join(plan.outputRoot, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      plan.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        assignmentFingerprint,
        artifacts: [
          {
            relativePath: "linked/private.txt",
            mediaType: "text/plain",
            originalFilename: "private.txt",
          },
        ],
      }),
    );

    await assert.rejects(
      lifecycle.promote({
        assignment: currentAssignment,
        workspace,
        plan,
        egressGuard: WorkerEgressGuard.empty(),
        isExecutionCurrent: () => Promise.resolve(true),
      }),
      { code: "SOURCE_UNSAFE" },
    );
    assert.equal(deliveryCalls, 0);

    await writeFile(
      plan.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        assignmentFingerprint,
        artifacts: [
          {
            relativePath: "../outside/private.txt",
            mediaType: "text/plain",
            originalFilename: "private.txt",
          },
        ],
      }),
    );
    await assert.rejects(
      lifecycle.promote({
        assignment: currentAssignment,
        workspace,
        plan,
        egressGuard: WorkerEgressGuard.empty(),
        isExecutionCurrent: () => Promise.resolve(true),
      }),
      { code: "MANIFEST_INVALID" },
    );
    assert.equal(deliveryCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Run without an Artifact manifest completes with no promoted Artifact IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-empty-"));
  const checkout = join(root, "checkout");
  const staging = join(root, "runtime", "artifact-staging");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(staging, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspace = {
    workspaceId: "workspace-reports",
    cwd: await realpath(workspaceDirectory),
    isolation: "none" as const,
  };
  const lifecycle = await FileManifestWorkerArtifactLifecycle.create({
    stagingRoot: staging,
    sourceCheckoutRoot: checkout,
    delivery: {
      async deliver() {
        throw new Error("must not deliver");
      },
    },
  });

  try {
    const currentAssignment = assignment();
    const assignmentFingerprint = workerArtifactAssignmentFingerprint(
      currentAssignment,
      workspace.workspaceId,
    );
    const plan = await lifecycle.prepare({
      assignment: currentAssignment,
      workspace,
      assignmentFingerprint,
    });
    assert.deepEqual(
      await lifecycle.promote({
        assignment: currentAssignment,
        workspace,
        plan,
        egressGuard: WorkerEgressGuard.empty(),
        isExecutionCurrent: () => Promise.resolve(true),
      }),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all declared Artifact bytes are Secret-scanned before the first delivery call", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-artifact-egress-"));
  const checkout = join(root, "checkout");
  const staging = join(root, "runtime", "artifact-staging");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(staging, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspace = {
    workspaceId: "workspace-reports",
    cwd: await realpath(workspaceDirectory),
    isolation: "none" as const,
  };
  let deliveryCalls = 0;
  const lifecycle = await FileManifestWorkerArtifactLifecycle.create({
    stagingRoot: staging,
    sourceCheckoutRoot: checkout,
    delivery: {
      async deliver() {
        deliveryCalls += 1;
        throw new Error("must not deliver");
      },
    },
  });

  try {
    const currentAssignment = assignment();
    const assignmentFingerprint = workerArtifactAssignmentFingerprint(
      currentAssignment,
      workspace.workspaceId,
    );
    const plan = await lifecycle.prepare({
      assignment: currentAssignment,
      workspace,
      assignmentFingerprint,
    });
    const secret = "artifact-egress-secret-value";
    const guard = WorkerEgressGuard.empty();
    await guard.protectSecrets([secret]);
    await writeFile(join(plan.outputRoot, "clean.md"), "safe owner-facing report\n");
    await writeFile(
      join(plan.outputRoot, "tainted.bin"),
      Buffer.concat([
        Buffer.from([0xff, 0x00, 0x81]),
        Buffer.from(secret, "utf8"),
        Buffer.from([0x82, 0xfe]),
      ]),
    );
    await writeFile(
      plan.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        assignmentFingerprint,
        artifacts: [
          {
            relativePath: "clean.md",
            mediaType: "text/markdown",
            originalFilename: "clean.md",
          },
          {
            relativePath: "tainted.bin",
            mediaType: "application/octet-stream",
            originalFilename: "tainted.bin",
          },
        ],
      }),
    );

    await assert.rejects(
      lifecycle.promote({
        assignment: currentAssignment,
        workspace,
        plan,
        egressGuard: guard,
        isExecutionCurrent: () => Promise.resolve(true),
      }),
      { code: "EGRESS_DENIED" },
    );
    assert.equal(deliveryCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
