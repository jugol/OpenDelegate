import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  PlatformMutationCommandJournal,
  PlatformMutationExecutor,
  PlatformMutationRequest,
} from "@opendelegate/platform-services";
import { createPlatformMutationExecutor } from "@opendelegate/platform-services";
import { LocalRunCapabilityBroker } from "@opendelegate/run-capability-broker";
import type { WorkerRunAssignmentV1, WorkerRunLeaseAuthority } from "@opendelegate/worker-runtime";

import {
  WorkerPlatformMutationRunCapabilityProvider,
  bindPlatformMutationProcessRunnerToWorkspace,
  consumePlatformMutationRunCapabilityFile,
} from "../src/platform-mutation-run-capability.ts";

test("one exact Run receives a local typed mutation capability without wider host authority", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-worker-mutation-")));
  const workspaceRoot = await realpath(root);
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(root, "runtime"),
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => 1_000 },
  });
  const requests: PlatformMutationRequest[] = [];
  const executor: PlatformMutationExecutor = {
    async execute(request) {
      requests.push(request);
      return {
        commandId: request.commandId,
        actionCategory:
          request.kind === "package-install"
            ? "configured-official-package-install"
            : request.actionCategory,
        actionFingerprint: `sha256:${"a".repeat(64)}`,
        outcome: "succeeded",
        reasonCode: "POLICY_TRUSTED_PACKAGE_INSTALL",
        exitCode: 0,
        completedAtMs: 1_005,
      };
    },
  };
  const provider = new WorkerPlatformMutationRunCapabilityProvider({
    broker,
    platform: hostPlatform(),
    executableIds: ["npm", "ufw"],
    executorFactory: () => executor,
    toolServerCommand: process.execPath,
    toolServerArgsPrefix: ["worker-cli.mjs"],
  });

  try {
    const lease = await provider.prepare({
      assignment: assignment(),
      workspace: workspace(workspaceRoot),
      isExecutionCurrent: async () => true,
    });
    assert.ok(lease);
    assert.deepEqual(lease.toolServers[0], {
      serverName: "opendelegate-platform-mutation",
      command: process.execPath,
      args: [
        "worker-cli.mjs",
        "platform-mutation-mcp-bridge",
        "--capability-file",
        lease.toolServers[0]?.args[3],
      ],
      enabledTools: ["platform_mutation_execute"],
      startupTimeoutMs: 15_000,
      toolTimeoutMs: 7_200_000,
    });
    const capabilityFile = lease.toolServers[0]?.args[3];
    assert.equal(typeof capabilityFile, "string");
    const consumed = await consumePlatformMutationRunCapabilityFile(capabilityFile ?? "");
    assert.deepEqual(consumed.authority, {
      taskId: "task-1",
      workOrderId: "work-order-1",
      runId: "run-1",
      deviceId: "device-1",
      leaseId: "run-lease-1",
      fencingToken: 9,
      leaseExpiresAtMs: 4_000_000_000_000,
    });
    const receipt = await consumed.port.execute(
      {
        authority: consumed.authority,
        signal: new AbortController().signal,
      },
      {
        kind: "package-install",
        commandId: "package-install-1001",
        manager: "npm",
        scope: "project",
        packages: ["typescript"],
      },
    );
    assert.equal(receipt.outcome, "succeeded");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.signal.aborted, false);
    assert.notEqual(requests[0]?.commandId, "package-install-1001");
    assert.equal(requests[0]?.workingDirectory, workspaceRoot);
    await assert.rejects(
      consumed.port.execute(
        {
          authority: consumed.authority,
          signal: new AbortController().signal,
        },
        {
          kind: "package-install",
          commandId: "package-install-sibling-1002",
          manager: "npm",
          scope: "project",
          packages: ["typescript"],
          workingDirectory: join(root, "..", "sibling-repository"),
        } as never,
      ),
      /failed/iu,
    );
    assert.equal(requests.length, 1);
    await consumed.close();
    await lease.dispose();
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a claimed platform mutation capability follows the exact Run's renewed lease expiry", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "opendelegate-worker-mutation-renewed-")),
  );
  const workspaceRoot = await realpath(root);
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
  let executions = 0;
  const provider = new WorkerPlatformMutationRunCapabilityProvider({
    broker,
    platform: hostPlatform(),
    executableIds: ["npm"],
    executorFactory: () => ({
      async execute(request) {
        executions += 1;
        return {
          commandId: request.commandId,
          actionCategory: "configured-official-package-install",
          actionFingerprint: `sha256:${"b".repeat(64)}`,
          outcome: "succeeded",
          reasonCode: "POLICY_TRUSTED_PACKAGE_INSTALL",
          exitCode: 0,
          completedAtMs: nowMs,
        };
      },
    }),
    toolServerCommand: process.execPath,
  });

  try {
    const lease = await provider.prepare({
      assignment: { ...assignment(), leaseExpiresAtMs },
      leaseAuthority,
      workspace: workspace(workspaceRoot),
      isExecutionCurrent: async () => true,
    });
    assert.ok(lease);
    const consumed = await consumePlatformMutationRunCapabilityFile(
      lease.toolServers[0]?.args[2] ?? "",
    );

    leaseExpiresAtMs = initialNowMs + 30_000;
    nowMs = initialNowMs + 15_000;
    const receipt = await consumed.port.execute(
      {
        authority: consumed.authority,
        signal: new AbortController().signal,
      },
      {
        kind: "package-install",
        commandId: "package-install-renewed-1004",
        manager: "npm",
        scope: "project",
        packages: ["typescript"],
      },
    );
    assert.equal(receipt.outcome, "succeeded");
    assert.equal(executions, 1);

    await consumed.close();
    await lease.dispose();
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("revoked Run authority blocks mutation before the executor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-worker-mutation-stale-")));
  const workspaceRoot = await realpath(root);
  let current = true;
  let executions = 0;
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(root, "runtime"),
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => 1_000 },
  });
  const provider = new WorkerPlatformMutationRunCapabilityProvider({
    broker,
    platform: hostPlatform(),
    executableIds: ["ufw"],
    executorFactory: () => ({
      async execute() {
        executions += 1;
        throw new Error("must not execute");
      },
    }),
    toolServerCommand: process.execPath,
  });

  try {
    const lease = await provider.prepare({
      assignment: assignment(),
      workspace: workspace(workspaceRoot),
      isExecutionCurrent: async () => current,
    });
    assert.ok(lease);
    const capabilityFile = lease.toolServers[0]?.args[2];
    assert.equal(typeof capabilityFile, "string");
    const consumed = await consumePlatformMutationRunCapabilityFile(capabilityFile ?? "");
    current = false;
    await assert.rejects(
      consumed.port.execute(
        {
          authority: consumed.authority,
          signal: new AbortController().signal,
        },
        {
          kind: "protected-command",
          commandId: "firewall-change-1001",
          actionCategory: "firewall-change",
          executableId: "ufw",
          arguments: ["allow", "43190/tcp"],
        },
      ),
      /authority|current|revoked/iu,
    );
    assert.equal(executions, 0);
    await consumed.close();
    await lease.dispose();
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlink or reparse-point Workspace is rejected before capability creation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-worker-mutation-link-")));
  const outside = join(root, "outside");
  const link = join(root, "workspace-link");
  await mkdir(outside);
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(root, "runtime"),
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => 1_000 },
  });
  const provider = new WorkerPlatformMutationRunCapabilityProvider({
    broker,
    platform: hostPlatform(),
    executableIds: ["npm"],
    executorFactory: () => {
      throw new Error("executor must not be created");
    },
    toolServerCommand: process.execPath,
  });

  try {
    await assert.rejects(
      provider.prepare({
        assignment: assignment(),
        workspace: workspace(link),
        isExecutionCurrent: async () => true,
      }),
      /invalid/iu,
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace replacement during Policy authorization is caught at the process boundary", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "opendelegate-worker-mutation-toctou-")),
  );
  const workspaceRoot = join(root, "workspace");
  const originalWorkspace = join(root, "workspace-original");
  await mkdir(workspaceRoot);
  const canonicalWorkspace = await realpath(workspaceRoot);
  let processRuns = 0;
  let authorizationCalls = 0;
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: join(root, "runtime"),
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => 1_000 },
  });
  const journal: PlatformMutationCommandJournal = {
    async claim() {
      return { disposition: "claimed" };
    },
    async complete() {},
  };
  const provider = new WorkerPlatformMutationRunCapabilityProvider({
    broker,
    platform: hostPlatform(),
    executableIds: ["npm"],
    executorFactory: ({ workspace: workspaceAuthority }) =>
      createPlatformMutationExecutor({
        platform: hostPlatform(),
        executables: { npm: process.execPath },
        authorization: {
          async authorizeAndConsume() {
            authorizationCalls += 1;
            await rename(canonicalWorkspace, originalWorkspace);
            await mkdir(canonicalWorkspace);
            return {
              decision: "allow",
              reasonCode: "POLICY_TRUSTED_PACKAGE_INSTALL",
            };
          },
        },
        journal,
        processPreflight: {
          async assertSafe() {},
        },
        processRunner: bindPlatformMutationProcessRunnerToWorkspace(
          {
            async run() {
              processRuns += 1;
              return { exitCode: 0, signal: null };
            },
          },
          workspaceAuthority,
        ),
      }),
    toolServerCommand: process.execPath,
  });

  try {
    const lease = await provider.prepare({
      assignment: assignment(),
      workspace: workspace(canonicalWorkspace),
      isExecutionCurrent: async () => true,
    });
    assert.ok(lease);
    const capabilityFile = lease.toolServers[0]?.args[2];
    const consumed = await consumePlatformMutationRunCapabilityFile(capabilityFile ?? "");
    await assert.rejects(
      consumed.port.execute(
        {
          authority: consumed.authority,
          signal: new AbortController().signal,
        },
        {
          kind: "package-install",
          commandId: "package-install-toctou-1003",
          manager: "npm",
          scope: "project",
          packages: ["typescript"],
        },
      ),
      /failed|current|unknown/iu,
    );
    assert.equal(authorizationCalls, 1);
    assert.equal(processRuns, 0);
    await consumed.close();
    await lease.dispose();
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
      title: "Install a configured package",
      brief: "Install the required tool.",
      completionCriteria: ["Tool is installed"],
      constraints: [],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: { preferredDeviceIds: [], preferredRoles: [] },
      requiredCapabilities: [],
      requiredSecretRefs: [],
      workspaceId: "workspace-1",
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

function workspace(cwd: string) {
  return {
    workspaceId: "workspace-1",
    cwd,
    isolation: "none" as const,
  };
}

function hostPlatform(): "windows" | "macos" | "linux" {
  return process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : "linux";
}
