import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ComputerUseOsBackend,
  ComputerUseOsError,
  InMemoryComputerUseStartHistory,
  createFixtureNativeDriver,
  type ComputerUseSession,
  type DesktopLease,
} from "@opendelegate/computer-use-os";
import { LocalRunCapabilityBroker } from "@opendelegate/run-capability-broker";
import type { WorkerRunAssignmentV1, WorkerRunLeaseAuthority } from "@opendelegate/worker-runtime";

import {
  CurrentRunDesktopLeasePort,
  WorkerComputerUseRunCapabilityProvider,
  consumeComputerUseRunCapabilityFile,
} from "../src/computer-use-run-capability.ts";

const desktopLease: DesktopLease = {
  resourceName: "desktop-session",
  capacity: 1,
  leaseId: "desktop-lease-1",
  fencingToken: 12,
  expiresAtMs: 4_000_000_000_000,
};

test("only a verified required Run receives a one-time Computer Use MCP bridge", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-worker-cu-capability-")));
  const initialNowMs = Date.now();
  let nowMs = initialNowMs;
  let runLeaseExpiresAtMs = initialNowMs + 10_000;
  const leaseAuthority: WorkerRunLeaseAuthority = {
    snapshot: () => ({
      leaseExpiresAtMs: runLeaseExpiresAtMs,
      conservativeDeadlineMonotonicMs: runLeaseExpiresAtMs,
    }),
    isCurrent: () => true,
    async renewIfDue() {},
  };
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: root,
    sourceCheckoutDirectory: process.cwd(),
    maxFrameBytes: 8 * 1024 * 1024,
    clock: { now: () => nowMs },
  });
  let backendCreations = 0;
  let releases = 0;
  let sessionReleases = 0;
  const session = fakeSession(() => {
    sessionReleases += 1;
  });
  const provider = new WorkerComputerUseRunCapabilityProvider({
    broker,
    desktopAuthority: {
      async claim() {
        return { disposition: "acquired", lease: desktopLease };
      },
      async verify(request) {
        return {
          status: "current",
          leaseId: request.lease.leaseId,
          fencingToken: request.lease.fencingToken,
          verifiedAtMs: 1_000,
        };
      },
      async release() {
        releases += 1;
        return "released";
      },
    },
    desktopBinding: {
      helperInstanceId: "helper-1",
      serviceEpoch: 7,
      persistenceGeneration: 11,
    },
    backendFactory: () => {
      backendCreations += 1;
      return {
        async readiness() {
          return readyReport();
        },
        async start() {
          return session;
        },
      };
    },
    toolServerCommand: process.execPath,
    toolServerArgsPrefix: ["worker-cli.mjs"],
    clock: { now: () => 1_000 },
  });
  try {
    assert.equal(
      await provider.prepare({
        assignment: assignment([]),
        isExecutionCurrent: async () => true,
      }),
      undefined,
    );
    assert.equal(backendCreations, 0);

    const lease = await provider.prepare({
      assignment: {
        ...assignment(["computer-use"]),
        leaseExpiresAtMs: runLeaseExpiresAtMs,
      },
      leaseAuthority,
      isExecutionCurrent: async () => true,
    });
    assert.ok(lease);
    assert.equal(backendCreations, 1);
    const toolServer = lease.toolServers[0]!;
    assert.deepEqual(toolServer.enabledTools, [
      "computer_use_readiness",
      "computer_use_observe",
      "computer_use_capture",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_stop",
    ]);
    assert.deepEqual(toolServer.args.slice(0, 3), [
      "worker-cli.mjs",
      "mcp-bridge",
      "--capability-file",
    ]);
    const capabilityFile = toolServer.args[3]!;
    const descriptor = JSON.parse(await readFile(capabilityFile, "utf8")) as {
      readonly token: string;
    };
    assert.equal(JSON.stringify(toolServer).includes(descriptor.token), false);

    const consumed = await consumeComputerUseRunCapabilityFile(capabilityFile);
    assert.equal(consumed.authority.runId, "run-1");
    const toolContext = {
      authority: consumed.authority,
      signal: new AbortController().signal,
    };
    assert.equal((await consumed.port.observe(toolContext)).controls[0]?.controlId, "task-text");
    runLeaseExpiresAtMs = initialNowMs + 30_000;
    nowMs = initialNowMs + 15_000;
    assert.equal((await consumed.port.observe(toolContext)).controls[0]?.controlId, "task-text");
    await consumed.close();
    await lease.dispose();
    await lease.dispose();
    assert.equal(releases, 1);
    assert.equal(sessionReleases, 1);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the real Worker MCP child receives only a capability path and serves Computer Use tools", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-worker-cu-child-")));
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: root,
    sourceCheckoutDirectory: process.cwd(),
    maxFrameBytes: 8 * 1024 * 1024,
    clock: { now: () => 1_000 },
  });
  const provider = new WorkerComputerUseRunCapabilityProvider({
    broker,
    desktopAuthority: {
      async claim() {
        return { disposition: "acquired", lease: desktopLease };
      },
      async verify(request) {
        return {
          status: "current",
          leaseId: request.lease.leaseId,
          fencingToken: request.lease.fencingToken,
          verifiedAtMs: 1_000,
        };
      },
      async release() {
        return "released";
      },
    },
    desktopBinding: {
      helperInstanceId: "helper-child",
      serviceEpoch: 7,
      persistenceGeneration: 11,
    },
    backendFactory: () => ({
      async readiness() {
        return readyReport();
      },
      async start() {
        return fakeSession(() => undefined);
      },
    }),
    toolServerCommand: process.execPath,
    clock: { now: () => 1_000 },
  });
  let lease: Awaited<ReturnType<typeof provider.prepare>> | undefined;
  try {
    lease = await provider.prepare({
      assignment: assignment(["computer-use"]),
      isExecutionCurrent: async () => true,
    });
    assert.ok(lease);
    const capabilityFile = lease.toolServers[0]!.args.at(-1)!;
    const descriptor = JSON.parse(await readFile(capabilityFile, "utf8")) as {
      readonly token: string;
    };
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        resolve(import.meta.dirname, "../src/cli.ts"),
        "mcp-bridge",
        "--capability-file",
        capabilityFile,
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: { ...process.env },
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
            clientInfo: { name: "worker-child-proof", version: "1.0.0" },
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
      .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    assert.deepEqual(
      responses.map(({ id }) => id),
      [1, 2],
    );
    const tools = responses[1]!.result["tools"] as Array<{ name: string }>;
    assert.deepEqual(
      tools.map(({ name }) => name),
      lease.toolServers[0]!.enabledTools,
    );
    assert.equal(child.spawnargs.join("\0").includes(descriptor.token), false);
    assert.equal(outputText.includes(descriptor.token), false);
    assert.equal(errorText.includes(descriptor.token), false);
  } finally {
    await lease?.dispose();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backend start failure releases the capacity-one desktop", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-worker-cu-failure-")));
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: root,
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => 1_000 },
  });
  let releases = 0;
  const provider = new WorkerComputerUseRunCapabilityProvider({
    broker,
    desktopAuthority: {
      async claim() {
        return { disposition: "acquired", lease: desktopLease };
      },
      async verify() {
        return {
          status: "current",
          leaseId: desktopLease.leaseId,
          fencingToken: desktopLease.fencingToken,
          verifiedAtMs: 1_000,
        };
      },
      async release() {
        releases += 1;
        return "released";
      },
    },
    desktopBinding: {
      helperInstanceId: "helper-1",
      serviceEpoch: 7,
      persistenceGeneration: 11,
    },
    backendFactory: () => ({
      async readiness() {
        return readyReport();
      },
      async start() {
        throw new Error("private native failure");
      },
    }),
    toolServerCommand: process.execPath,
    clock: { now: () => 1_000 },
  });
  try {
    await assert.rejects(
      provider.prepare({
        assignment: assignment(["computer-use"]),
        isExecutionCurrent: async () => true,
      }),
    );
    assert.equal(releases, 1);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel desktop verification follows one renewed Run lease without a false-stale race", async () => {
  const runAssignment = {
    ...assignment(["computer-use"]),
    leaseExpiresAtMs: 20_000,
  };
  let runLeaseExpiresAtMs = runAssignment.leaseExpiresAtMs;
  const leaseAuthority: WorkerRunLeaseAuthority = {
    snapshot: () => ({
      leaseExpiresAtMs: runLeaseExpiresAtMs,
      conservativeDeadlineMonotonicMs: runLeaseExpiresAtMs,
    }),
    isCurrent: () => true,
    async renewIfDue() {},
  };
  let currentDesktopLease: DesktopLease = {
    ...desktopLease,
    expiresAtMs: runAssignment.leaseExpiresAtMs,
  };
  let renewalCount = 0;
  const leases = new CurrentRunDesktopLeasePort({
    assignment: runAssignment,
    leaseAuthority,
    desktopLease: currentDesktopLease,
    desktopAuthority: {
      async verify(request) {
        return request.lease.expiresAtMs === currentDesktopLease.expiresAtMs
          ? {
              status: "current",
              leaseId: request.lease.leaseId,
              fencingToken: request.lease.fencingToken,
              verifiedAtMs: 10_000,
            }
          : {
              status: "stale",
              reason: "The supplied desktop lease is no longer current.",
              verifiedAtMs: 10_000,
            };
      },
      async renew(request, run) {
        renewalCount += 1;
        await Promise.resolve();
        if (request.lease.expiresAtMs !== currentDesktopLease.expiresAtMs) {
          return { disposition: "stale" };
        }
        currentDesktopLease = Object.freeze({
          ...currentDesktopLease,
          expiresAtMs: run.runLeaseExpiresAtMs,
        });
        return {
          disposition: "renewed",
          lease: currentDesktopLease,
        };
      },
    },
    isExecutionCurrent: async () => true,
  });
  const originalRequest = {
    taskId: runAssignment.taskId,
    deviceId: runAssignment.deviceId,
    runId: runAssignment.runId,
    lease: { ...currentDesktopLease },
  };

  runLeaseExpiresAtMs = 40_000;
  const outcomes = await Promise.all([
    leases.verify(originalRequest),
    leases.verify(originalRequest),
  ]);

  assert.equal(renewalCount, 2);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["current", "current"],
  );
  assert.equal(leases.snapshot().expiresAtMs, 40_000);
});

test("post-Policy Main Run revocation reaches the backend lease boundary before native act", async () => {
  let executionCurrent = true;
  const fixture = createFixtureNativeDriver({
    osFamily: "windows",
    runIdentifier: "main-revocation-race",
  });
  const leases = new CurrentRunDesktopLeasePort({
    desktopAuthority: {
      async verify(request) {
        return {
          status: "current",
          leaseId: request.lease.leaseId,
          fencingToken: request.lease.fencingToken,
          verifiedAtMs: 10_000,
        };
      },
    },
    isExecutionCurrent: async () => executionCurrent,
  });
  const backend = new ComputerUseOsBackend({
    osFamily: "windows",
    driver: fixture.driver,
    authority: {
      async verify(request) {
        return {
          status: "current",
          helperInstanceId: request.helperInstanceId,
          serviceEpoch: request.serviceEpoch,
          persistenceGeneration: request.persistenceGeneration,
          verifiedAtMs: 10_000,
        };
      },
    },
    leases,
    startHistory: new InMemoryComputerUseStartHistory(),
    authorizer: {
      async authorize(request) {
        await Promise.resolve();
        executionCurrent = false;
        return {
          decision: "allow",
          authorizationId: "authorization-after-await",
          fingerprint: request.fingerprint,
        };
      },
      async consume() {
        throw new Error("Consumption must not run after Main authority changes.");
      },
    },
    clock: { now: () => 10_000 },
    logger: { write() {} },
  });
  const session = await backend.start({
    commandId: "start-main-revocation-race",
    taskId: "task-1",
    deviceId: "device-1",
    runId: "run-1",
    helperInstanceId: "helper-1",
    serviceEpoch: 7,
    persistenceGeneration: 11,
    lease: {
      ...desktopLease,
      expiresAtMs: 20_000,
    },
    timeoutMs: 5_000,
  });

  await assert.rejects(
    session.click({ controlId: "option-beta" }),
    (error: unknown) => error instanceof ComputerUseOsError && error.code === "LEASE_STALE",
  );
  assert.equal(fixture.activity().actionCount, 0);
});

function assignment(requiredCapabilities: readonly string[]): WorkerRunAssignmentV1 {
  return {
    taskId: "task-1",
    workOrder: {
      protocolVersion: "v1",
      workOrderId: "work-order-1",
      title: "Use a desktop",
      brief: "Complete the fixture.",
      completionCriteria: ["Fixture completed"],
      constraints: [],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: { preferredDeviceIds: [], preferredRoles: [] },
      requiredCapabilities,
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

function readyReport() {
  return {
    status: "ready" as const,
    osFamily: "windows" as const,
    backendId: "fixture-windows",
    displayFingerprint: "display:fixture",
    checks: [
      {
        name: "input" as const,
        status: "pass" as const,
        evidence: "Fixture input is ready.",
      },
    ],
  };
}

function fakeSession(onRelease: () => void): ComputerUseSession {
  return {
    executionHandleId: "cu_execution_1",
    status: () => "active",
    async observe() {
      return {
        displayFingerprint: "display:fixture",
        sequence: 1,
        accessibilityTree: [
          {
            controlId: "task-text",
            role: "textbox",
            label: "Task text",
          },
        ],
      };
    },
    async capture() {
      return {
        evidenceId: "capture-1",
        runId: "run-1",
        mediaType: "image/png",
        filename: "capture.png",
        bytes: Buffer.from([137, 80, 78, 71]),
        sha256: `sha256:${"a".repeat(64)}`,
        createdAtMs: 1_000,
        width: 1,
        height: 1,
        capturedAtMs: 1_000,
        displayFingerprint: "display:fixture",
      };
    },
    async click() {},
    async typeText() {},
    actionSummary() {
      return {
        executionHandleId: "cu_execution_1",
        taskId: "task-1",
        deviceId: "device-1",
        runId: "run-1",
        entries: [],
      };
    },
    captureActionSummary() {
      return {
        evidenceId: "actions-1",
        runId: "run-1",
        mediaType: "application/json",
        filename: "actions.json",
        bytes: Buffer.from("{}"),
        sha256: `sha256:${"b".repeat(64)}`,
        createdAtMs: 1_000,
      };
    },
    async cancel() {},
    async emergencyStop() {},
    async release() {
      onRelease();
    },
  };
}
