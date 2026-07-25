import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentAdapter } from "@opendelegate/agent-adapters";
import {
  InMemoryComputerUseStartHistory,
  type LinuxAuthenticatedHelperSession,
  type LinuxNativeHelperPort,
  type NativeDriverExecutionContext,
  type ReadinessCheckName,
} from "@opendelegate/computer-use-os";

import {
  createLinuxWorkerComputerUseComposition,
  createWorkerSchedulingInventoryProvider,
} from "../src/index.ts";

const SESSION = Object.freeze({
  authentication: "adr-0011-ed25519-v2" as const,
  helperInstanceId: "helper-gnome-1000",
  osSessionIdentity: "wayland:1000:seat0",
  releaseVersion: "0.1.0-alpha.1",
  serviceEpoch: 19,
});

describe("Worker Computer Use capability composition", () => {
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

function check(name: ReadinessCheckName) {
  return {
    name,
    status: "pass" as const,
    evidence: `${name} passed.`,
  };
}
