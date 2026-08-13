import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AgentAdapter } from "@opendelegate/agent-adapters";
import {
  InMemoryComputerUseStartHistory,
  type ComputerUseReadinessReport,
  type LinuxAuthenticatedHelperSession,
  type LinuxNativeHelperPort,
  type NativeDriverExecutionContext,
  type NativeComputerUseDriver,
  type ReadinessCheckName,
} from "@opendelegate/computer-use-os";
import { PROTOCOL_VERSION } from "@opendelegate/protocol";
import {
  WorkerRuntime,
  createSqliteWorkerStateRepository,
  type WorkerConfiguration,
} from "@opendelegate/worker-runtime";

import {
  createLinuxWorkerComputerUseComposition,
  createWorkerComputerUseRuntime,
  createWorkerSchedulingInventoryProvider,
  projectComputerUseReadiness,
  resolveWorkerPaths,
  type WorkerConfigurationDocument,
} from "../src/index.ts";

const SESSION = Object.freeze({
  authentication: "adr-0011-ed25519-v2" as const,
  helperInstanceId: "helper-gnome-1000",
  osSessionIdentity: "wayland:1000:seat0",
  releaseVersion: "0.1.0-alpha.1",
  serviceEpoch: 19,
});

describe("Worker Computer Use capability composition", () => {
  it("keeps scheduling inventory non-interactive while proving an authenticated helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-passive-computer-use-"));
    const sourceCheckoutRoot = join(root, "source");
    const paths = resolveWorkerPaths({ sourceCheckoutRoot, home: join(root, "runtime") });
    await mkdir(sourceCheckoutRoot, { recursive: true });
    await mkdir(paths.stateDirectory, { recursive: true });
    const hostOsFamily =
      platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : "linux";
    let interactiveProbeCalls = 0;
    const composition = await createWorkerComputerUseRuntime({
      configuration: { deviceId: "device-passive-helper" } as WorkerConfigurationDocument,
      paths,
      actionChannel: {},
      broker: undefined as never,
      toolServerLaunch: { command: process.execPath, argsPrefix: [] },
      runtime: {
        async acquire() {
          return {
            driver: {
              osFamily: hostOsFamily,
              async probe() {
                interactiveProbeCalls += 1;
                throw new Error("background inventory must not invoke the interactive driver");
              },
              async observe() {
                throw new Error("not used");
              },
              async capture() {
                throw new Error("not used");
              },
              async act() {
                throw new Error("not used");
              },
              async cancel() {},
              async emergencyStop() {},
            },
            authority: {
              async verify() {
                throw new Error("background inventory must not request active desktop authority");
              },
            },
            binding: {
              helperInstanceId: "helper-passive",
              serviceEpoch: 7,
              persistenceGeneration: 9,
            },
            async release() {},
          };
        },
      },
    });
    assert.ok(composition);
    try {
      assert.deepEqual(await composition.probe.probe(), { verification: "verified" });
      assert.equal(interactiveProbeCalls, 0);
      assert.deepEqual(composition.healthSnapshot(), {
        daemon: "healthy",
        session: "ready",
        desktop: "unavailable",
        permissions: {
          accessibility: "unknown",
          input: "unknown",
          screenCapture: "unknown",
        },
      });
    } finally {
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects authenticated helper checks into the Worker heartbeat readiness", () => {
    assert.deepEqual(projectComputerUseReadiness(readinessReport()), {
      daemon: "healthy",
      session: "ready",
      desktop: "available",
      permissions: {
        accessibility: "granted",
        input: "granted",
        screenCapture: "granted",
      },
    });

    assert.deepEqual(
      projectComputerUseReadiness(
        readinessReport({
          status: "unavailable",
          checks: [
            check("interactive-session"),
            check("unlocked-session", "fail"),
            check("screen-capture"),
            check("accessibility"),
            check("input"),
            check("helper-authentication"),
            check("service-epoch"),
          ],
        }),
      ),
      {
        daemon: "healthy",
        session: "locked",
        desktop: "locked",
        permissions: {
          accessibility: "granted",
          input: "granted",
          screenCapture: "granted",
        },
      },
    );

    assert.deepEqual(
      projectComputerUseReadiness(
        readinessReport({
          status: "unavailable",
          checks: [
            check("interactive-session", "unknown"),
            check("unlocked-session", "unknown"),
            check("screen-capture", "unknown"),
            check("accessibility", "fail"),
            check("input", "unknown"),
            check("helper-authentication"),
            check("service-epoch"),
          ],
        }),
      ),
      {
        daemon: "healthy",
        session: "unavailable",
        desktop: "unavailable",
        permissions: {
          accessibility: "denied",
          input: "unknown",
          screenCapture: "unknown",
        },
      },
    );

    assert.deepEqual(
      projectComputerUseReadiness(
        readinessReport({
          status: "unavailable",
          backendId: "windows-native-driver-unavailable",
          displayFingerprint: null,
          checks: [
            check("interactive-session", "fail"),
            check("unlocked-session", "fail"),
            check("screen-capture", "fail"),
            check("accessibility", "fail"),
            check("input", "fail"),
            check("helper-authentication", "fail"),
            check("service-epoch", "fail"),
          ],
        }),
      ),
      {
        daemon: "healthy",
        session: "unavailable",
        desktop: "unavailable",
        permissions: {
          accessibility: "unknown",
          input: "unknown",
          screenCapture: "unknown",
        },
      },
    );
  });

  it("publishes authenticated helper presence without probing the interactive desktop", async () => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-computer-use-heartbeat-"));
    const sourceCheckoutRoot = join(root, "source");
    const paths = resolveWorkerPaths({
      sourceCheckoutRoot,
      home: join(root, "runtime"),
    });
    await mkdir(sourceCheckoutRoot, { recursive: true });
    await mkdir(paths.stateDirectory, { recursive: true });
    let interactiveProbeCalls = 0;
    const hostOsFamily =
      platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : "linux";
    const driver: NativeComputerUseDriver = {
      osFamily: hostOsFamily,
      async probe() {
        interactiveProbeCalls += 1;
        throw new Error("heartbeat inventory must remain non-interactive");
      },
      async observe() {
        throw new Error("not used");
      },
      async capture() {
        throw new Error("not used");
      },
      async act() {
        throw new Error("not used");
      },
      async cancel() {},
      async emergencyStop() {},
    };
    const composition = await createWorkerComputerUseRuntime({
      configuration: { deviceId: "device-worker-1" } as WorkerConfigurationDocument,
      paths,
      actionChannel: {},
      broker: undefined as never,
      toolServerLaunch: { command: process.execPath, argsPrefix: [] },
      runtime: {
        async acquire() {
          return {
            driver,
            authority: {
              async verify() {
                return {
                  status: "current" as const,
                  helperInstanceId: "helper-live-1",
                  serviceEpoch: 19,
                  persistenceGeneration: 31,
                  verifiedAtMs: 1_000,
                };
              },
            },
            binding: {
              helperInstanceId: "helper-live-1",
              serviceEpoch: 19,
              persistenceGeneration: 31,
            },
            async release() {},
          };
        },
      },
    });
    assert.ok(composition);
    const runtime = await WorkerRuntime.create({
      configuration: heartbeatConfiguration(),
      repository: createSqliteWorkerStateRepository({ filename: paths.workerStateFile }),
      processFactory: {
        async start() {
          throw new Error("not used");
        },
      },
      inventoryProvider: {
        async snapshot() {
          await composition.probe.probe();
          return {
            deviceName: "Worker Device",
            osFamily: hostOsFamily,
            platformRelease: "test",
            architecture: "test",
            serviceMode: "system-service",
            maximumConcurrentRuns: 4,
            capabilities: [],
            workspaceIds: [],
            availableSecretRefs: [],
          };
        },
      },
      healthProvider: { snapshot: () => composition.healthSnapshot() },
    });

    try {
      assert.deepEqual((await runtime.heartbeat()).readiness, {
        daemon: "healthy",
        session: "ready",
        desktop: "unavailable",
        permissions: {
          accessibility: "unknown",
          input: "unknown",
          screenCapture: "unknown",
        },
      });
      await runtime.heartbeat();
      assert.equal(interactiveProbeCalls, 0);
    } finally {
      await runtime.close();
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports verified only after the authenticated Linux helper and external authority pass", async () => {
    const composition = await createLinuxWorkerComputerUseComposition({
      authenticatedSession: SESSION,
      deviceId: "device-linux",
      persistenceGeneration: 31,
      helperConfiguration: {
        executablePath: "/opt/opendelegate/libexec/linux-computer-use",
        expectedExecutableSha256: `sha256:${"a".repeat(64)}`,
        desktopEnvironment: {
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          WAYLAND_DISPLAY: "wayland-0",
          XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
          XDG_RUNTIME_DIR: "/run/user/1000",
          XDG_SESSION_TYPE: "wayland",
        },
      },
      nativeHelper: readyHelper(SESSION),
      authority: {
        async verify() {
          return {
            status: "current",
            helperInstanceId: SESSION.helperInstanceId,
            serviceEpoch: SESSION.serviceEpoch,
            persistenceGeneration: 31,
            verifiedAtMs: 1_000,
          };
        },
      },
      leases: {
        async verify(request) {
          return {
            status: "current",
            leaseId: request.lease.leaseId,
            fencingToken: request.lease.fencingToken,
            verifiedAtMs: 1_000,
          };
        },
      },
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: {
        authorize(request) {
          return {
            decision: "deny",
            authorizationId: "authorization-test",
            fingerprint: request.fingerprint,
          };
        },
        consume() {
          throw new Error("Readiness-only composition cannot consume input authorization.");
        },
      },
      clock: { now: () => 1_000 },
      logger: { write() {} },
    });

    const readiness = await composition.readiness();
    const capability = await composition.capabilityProbe.probe();

    assert.equal(readiness.status, "ready");
    assert.equal(readiness.displayFingerprint, "portal-stream:42:1920x1080");
    assert.equal(
      readiness.checks.every((check) => check.status === "pass"),
      true,
    );
    assert.deepEqual(capability, { verification: "verified" });
    await composition.close();
  });

  it("never trusts a Workspace declaration or a failed probe as Computer Use verification", async () => {
    for (const computerUseProbe of [
      {
        async probe() {
          throw new Error("private helper unavailable");
        },
      },
      undefined,
    ]) {
      const inventory = createWorkerSchedulingInventoryProvider({
        adapters: [],
        ...(computerUseProbe === undefined ? {} : { computerUseProbe }),
        environment: {},
        workspaceRegistry: {
          async listSchedulingMetadata() {
            return [
              {
                workspaceId: "workspace-untrusted",
                alias: "Untrusted declaration",
                type: "directory" as const,
                isolation: "none" as const,
                capabilities: ["computer-use"],
                state: "active" as const,
                revision: 1,
              },
            ];
          },
        },
        probeCacheMs: 0,
      });

      const snapshot = await inventory.snapshot();
      const computerUse = snapshot.capabilities.find(
        (capability) => capability.name === "computer-use",
      );
      assert.equal(computerUse?.name, "computer-use");
      assert.equal(computerUse?.verification, "unavailable");
      assert.equal(computerUse?.evidenceSource, "capability-probe");
      // A Worker with no runtime composed has no helper to fail; that is a state the
      // owner can leave, and only naming it distinguishes it from a failed probe.
      assert.equal(
        computerUse?.blockedBy,
        computerUseProbe === undefined ? "session-helper-absent" : undefined,
      );
      assert.equal(typeof computerUse?.observedAtMs, "number");
      assert.equal(typeof snapshot.hardware?.cpu.model, "string");
      assert.equal((snapshot.hardware?.cpu.logicalCoreCount ?? 0) > 0, true);
      assert.equal((snapshot.hardware?.memory.totalBytes ?? 0) > 0, true);
      assert.deepEqual(snapshot.hardware?.gpu, {
        devices: [],
        observedAtMs: snapshot.hardware?.gpu.observedAtMs,
        source: "node-os",
        verification: "not-observed",
      });
    }
  });

  it("publishes bounded Wake-on-LAN evidence without allowing a failed probe to block inventory", async () => {
    const workspaceRegistry = { listSchedulingMetadata: async () => [] };
    const observed = createWorkerSchedulingInventoryProvider({
      adapters: [],
      environment: {},
      workspaceRegistry,
      wakeOnLanProbe: {
        probe: async () => ({
          state: "enabled" as const,
          source: "linux-ethtool" as const,
          observedAtMs: 1_000,
        }),
      },
    });
    assert.deepEqual((await observed.snapshot()).wakeOnLan, {
      state: "enabled",
      source: "linux-ethtool",
      observedAtMs: 1_000,
    });

    const unavailable = createWorkerSchedulingInventoryProvider({
      adapters: [],
      environment: {},
      workspaceRegistry,
      wakeOnLanProbe: {
        probe: async () => {
          throw new Error("private platform probe failure");
        },
      },
    });
    const fallback = (await unavailable.snapshot()).wakeOnLan;
    assert.equal(fallback?.state, "unknown");
    assert.equal(fallback?.source, "probe-unavailable");
    assert.equal(typeof fallback?.observedAtMs, "number");
    assert.equal(JSON.stringify(fallback).includes("private platform probe failure"), false);

    const contradictory = createWorkerSchedulingInventoryProvider({
      adapters: [],
      environment: {},
      workspaceRegistry,
      wakeOnLanProbe: {
        probe: async () => ({
          state: "enabled" as const,
          source: "probe-unavailable" as const,
          observedAtMs: 1_000,
        }),
      },
    });
    const contradictoryFallback = (await contradictory.snapshot()).wakeOnLan;
    assert.equal(contradictoryFallback?.state, "unknown");
    assert.equal(contradictoryFallback?.source, "probe-unavailable");
    assert.equal(typeof contradictoryFallback?.observedAtMs, "number");
  });

  it("accepts only bounded descriptive GPU evidence from an explicit platform probe", async () => {
    const provider = createWorkerSchedulingInventoryProvider({
      adapters: [],
      environment: {},
      hardwareFactsProvider: {
        snapshot: async (observedAtMs) => ({
          cpu: {
            model: "Example CPU",
            logicalCoreCount: 12,
            observedAtMs,
            source: "platform-probe",
            verification: "verified",
          },
          memory: {
            totalBytes: 34_359_738_368,
            observedAtMs,
            source: "platform-probe",
            verification: "verified",
          },
          gpu: {
            devices: [
              {
                model: "Example GPU",
                vendor: "Example Vendor",
                memoryBytes: 8_589_934_592,
              },
            ],
            observedAtMs,
            source: "platform-probe",
            verification: "verified",
          },
        }),
      },
      workspaceRegistry: { listSchedulingMetadata: async () => [] },
    });

    const hardware = (await provider.snapshot()).hardware;
    assert.equal(hardware?.gpu.devices[0]?.model, "Example GPU");
    const serialized = JSON.stringify(hardware);
    assert.equal(serialized.includes("localPath"), false);
    assert.equal(serialized.includes("serialNumber"), false);
  });

  it("projects Agent adapters and the desktop lock without provider diagnostics or lease authority", async () => {
    const adapter: AgentAdapter = {
      adapterId: "codex-cli",
      provider: "codex",
      async probe() {
        return {
          contractVersion: 1,
          adapterId: "codex-cli",
          provider: "codex",
          installed: true,
          version: "1.2.3",
          compatibility: "tested",
          auth: { state: "ready" },
          capabilities: {
            start: true,
            resume: true,
            streaming: true,
            cancellation: true,
            approvalBridge: true,
            steering: false,
            checkpointContinuation: true,
            workspaceIsolation: ["opendelegate-worktree"],
          },
          diagnostics: [{ code: "PRIVATE", message: "must-not-cross" }],
        };
      },
      async start() {
        throw new Error("not used");
      },
      async resume() {
        throw new Error("not used");
      },
    };
    const provider = createWorkerSchedulingInventoryProvider({
      adapters: [adapter],
      environment: {},
      workspaceRegistry: { listSchedulingMetadata: async () => [] },
      resourceLockProjection: async () => ({
        resourceName: "desktop-session",
        capacity: 1,
        holders: [{ taskId: "task-1", runId: "run-1", expiresAtMs: 2_000 }],
      }),
    });

    const snapshot = await provider.snapshot();
    assert.deepEqual(
      snapshot.agentAdapters?.map(({ observedAtMs: _observedAtMs, ...observation }) => observation),
      [
        {
          provider: "codex",
          adapterId: "codex-cli",
          toolUse: "authorized",
          readiness: "ready",
          compatibility: "tested",
          version: "1.2.3",
        },
      ],
    );
    assert.deepEqual(snapshot.resourceLocks, [
      {
        resourceName: "desktop-session",
        capacity: 1,
        holders: [{ taskId: "task-1", runId: "run-1", expiresAtMs: 2_000 }],
      },
    ]);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("must-not-cross"), false);
    assert.equal(serialized.includes("leaseId"), false);
    assert.equal(serialized.includes("fencingToken"), false);
  });
});

function readyHelper(session: LinuxAuthenticatedHelperSession): LinuxNativeHelperPort {
  return {
    currentSession: () => session,
    async probe() {
      return {
        osFamily: "linux",
        backendId: "linux-atspi-xdg-portal-pipewire",
        helperInstanceId: session.helperInstanceId,
        serviceEpoch: session.serviceEpoch,
        displayFingerprint: "portal-stream:42:1920x1080",
        linuxTarget: "ubuntu-24.04-gnome-wayland",
        checks: [
          check("interactive-session"),
          check("unlocked-session"),
          check("screen-capture"),
          check("accessibility"),
          check("input"),
          check("helper-authentication"),
        ],
      };
    },
    async observe() {
      return {
        displayFingerprint: "portal-stream:42:1920x1080",
        accessibilityTree: [],
      };
    },
    async capture() {
      return {
        displayFingerprint: "portal-stream:42:1920x1080",
        mediaType: "image/png",
        width: 1,
        height: 1,
        bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      };
    },
    async act(_context: NativeDriverExecutionContext) {
      return {
        displayFingerprint: "portal-stream:42:1920x1080",
        sequence: 1,
      };
    },
    async cancel() {},
    async emergencyStop() {},
    async close() {},
  };
}

function readinessReport(
  overrides: Partial<ComputerUseReadinessReport> = {},
): ComputerUseReadinessReport {
  return {
    status: "ready",
    osFamily: "windows",
    backendId: "windows-session-helper",
    displayFingerprint: "desktop:1",
    checks: [
      check("interactive-session"),
      check("unlocked-session"),
      check("screen-capture"),
      check("accessibility"),
      check("input"),
      check("helper-authentication"),
      check("service-epoch"),
    ],
    ...overrides,
  };
}

function heartbeatConfiguration(): WorkerConfiguration {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "device-worker-1",
    workerId: "worker-1",
    mainDeviceId: "device-main",
    transportProfile: {
      deviceId: "device-main",
      endpoints: [
        {
          endpointId: "route-main-wss",
          label: "Private Main route",
          kind: "wss",
          url: "wss://main.example.test/worker",
          credentialRef: "secret://device-certificate",
        },
      ],
    },
    maxOutboxEntries: 8,
    cancelGraceMs: 10,
  };
}

function check(name: ReadinessCheckName, status: "fail" | "pass" | "unknown" = "pass") {
  return {
    name,
    status,
    evidence: `${name} ${status}.`,
  };
}
