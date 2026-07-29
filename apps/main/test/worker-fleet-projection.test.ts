import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_VERSION } from "@opendelegate/protocol";
import type { PersistedDeviceIdentity } from "@opendelegate/device-identity";
import type { WorkerHeartbeatV1 } from "@opendelegate/device-channel";

import {
  MainWorkerFleetProjection,
  type MainDeviceObservationStore,
} from "../src/worker-fleet-projection.ts";

const identity: PersistedDeviceIdentity = {
  deviceId: "device-worker-1",
  status: "active",
  identityGeneration: 1,
  allowedBootstrapRoles: ["development", "desktop-automation"],
  discovery: {
    osFamily: "windows",
    architecture: "x64",
    hostname: "build-pc",
  },
  createdAt: 1_000,
};
const transportProfileRevision = `sha256:${"b".repeat(64)}` as const;
const routeId = `route:${"b".repeat(64)}:0`;

test("authenticated heartbeat becomes scheduling and Admin metadata without local paths", async () => {
  let now = 10_000;
  const fleet = new MainWorkerFleetProjection({
    identities: { list: async () => [identity] },
    clock: { now: () => now },
    offlineAfterMs: 45_000,
  });

  const offline = await fleet.list();
  assert.equal(offline[0]?.status, "offline");
  assert.equal(offline[0]?.enabled, true);
  assert.deepEqual(offline[0]?.roles, ["development", "desktop-automation"]);

  await fleet.observeHeartbeat("device-worker-1", heartbeat({ observedAtMs: now }));
  const [candidate] = await fleet.list();
  assert.equal(candidate?.status, "online");
  assert.equal(candidate?.workerId, "worker-primary");
  assert.equal(candidate?.availableRunSlots, 3);
  assert.equal(candidate?.loadRatio, 0.25);
  assert.equal(candidate?.desktopSessionAvailable, true);
  assert.deepEqual(candidate?.capabilities, [
    { name: "codex", verification: "verified" },
    { name: "computer-use", verification: "verified" },
  ]);
  assert.deepEqual(candidate?.workspaceIds, ["workspace-product"]);
  assert.deepEqual(candidate?.availableSecretRefs, ["registry-token"]);
  assert.deepEqual(candidate?.transports, [
    {
      routeId,
      priority: 0,
      health: "healthy",
    },
  ]);
  assert.equal(JSON.stringify(candidate).includes("C:\\\\"), false);

  const [summary] = await fleet.deviceSummaries();
  assert.deepEqual(summary, {
    deviceId: "device-worker-1",
    name: "Build workstation",
    osFamily: "windows",
    platformRelease: "11.0.26100",
    architecture: "x64",
    role: "worker",
    connection: "online",
    runtime: "healthy",
    serviceMode: "foreground",
    lastObservation: {
      observedAtMs: 10_000,
      acceptedAtMs: 10_000,
      source: "authenticated-heartbeat",
    },
    roles: ["development", "desktop-automation"],
    instructions: [],
    facts: [
      {
        kind: "os-family",
        value: "windows",
        source: "enrollment",
        observedAtMs: 1_000,
        verification: "verified",
      },
      {
        kind: "architecture",
        value: "x64",
        source: "enrollment",
        observedAtMs: 1_000,
        verification: "verified",
      },
      {
        kind: "hostname",
        value: "build-pc",
        source: "enrollment",
        observedAtMs: 1_000,
        verification: "observed",
      },
      {
        kind: "platform-release",
        value: "11.0.26100",
        source: "authenticated-heartbeat",
        observedAtMs: 10_000,
        verification: "observed",
      },
      {
        kind: "cpu-model",
        value: "Example CPU",
        source: "node-os",
        observedAtMs: 9_900,
        verification: "observed",
      },
      {
        kind: "cpu-logical-cores",
        value: "16",
        source: "node-os",
        observedAtMs: 9_900,
        verification: "observed",
      },
      {
        kind: "memory-total-bytes",
        value: "68719476736",
        source: "node-os",
        observedAtMs: 9_900,
        verification: "observed",
      },
      {
        kind: "gpu-model",
        value: "Example Vendor Example GPU",
        source: "platform-probe",
        observedAtMs: 9_900,
        verification: "verified",
      },
    ],
    capabilities: [
      {
        name: "codex",
        verification: "verified",
        observedAtMs: 9_900,
        evidenceSource: "agent-adapter",
        version: "1.2.3",
      },
      { name: "computer-use", verification: "verified" },
    ],
    policies: [],
    agentAdapters: [
      {
        provider: "codex",
        adapterId: "codex-cli",
        readiness: "ready",
        compatibility: "tested",
        version: "1.2.3",
        observedAtMs: 9_900,
      },
    ],
    agentExecutionProfile: {
      schemaVersion: 1,
      mode: "auto",
    },
    wakeOnLan: {
      targetState: "enabled",
      automaticWakeState: "relay-required",
      source: "windows-netadapter-power",
      observedAtMs: 9_900,
    },
    routes: [
      {
        routeId,
        label: "Route 1",
        priority: 0,
        kind: "wss",
        profileRevision: transportProfileRevision,
        health: "healthy",
        lastAttempt: {
          probeSource: "live",
          outcome: "connected",
          observedAtMs: 10_000,
        },
      },
    ],
    resourceLocks: [
      {
        resourceName: "desktop-session",
        capacity: 1,
        holders: [
          {
            taskId: "task-1",
            runId: "run-1",
            expiresAtMs: 20_000,
          },
        ],
      },
    ],
    currentRuns: [
      {
        taskId: "task-1",
        workOrderId: "work-order-1",
        runId: "run-1",
        state: "running",
        acceptedAtMs: 9_500,
        leaseExpiresAtMs: 20_000,
      },
    ],
    capacity: {
      activeRuns: 1,
      maximumConcurrentRuns: 4,
      acceptingWork: true,
      maxOutboxEntries: 10_000,
      outboxDepth: 0,
    },
    knowledgeHealth: "healthy",
  });

  now += 45_001;
  assert.equal((await fleet.list())[0]?.status, "offline");
  assert.equal((await fleet.deviceSummaries())[0]?.runtime, "unavailable");
});

test("restart keeps the last durable observation while live scheduling remains offline", async () => {
  let now = 10_000;
  const observations = memoryObservationStore();
  const profiles = {
    get: async () => ({
      roles: ["release-engineering"],
      instructions: ["Use signed release workspaces only."],
    }),
  };
  const beforeRestart = new MainWorkerFleetProjection({
    identities: { list: async () => [identity] },
    profiles,
    observations,
    clock: { now: () => now },
  });
  await beforeRestart.observeHeartbeat("device-worker-1", heartbeat({ observedAtMs: now }));

  now += 500;
  const afterRestart = new MainWorkerFleetProjection({
    identities: { list: async () => [identity] },
    profiles,
    observations,
    clock: { now: () => now },
  });
  assert.equal((await afterRestart.list())[0]?.status, "offline");
  const [offline] = await afterRestart.deviceSummaries();
  assert.equal(offline?.connection, "offline");
  assert.equal(offline?.runtime, "unavailable");
  assert.deepEqual(offline?.lastObservation, {
    observedAtMs: 10_000,
    acceptedAtMs: 10_000,
    source: "authenticated-heartbeat",
  });
  assert.equal(offline?.facts?.find(({ kind }) => kind === "cpu-model")?.value, "Example CPU");
  assert.equal(offline?.capabilities?.[0]?.name, "codex");
  assert.deepEqual(offline?.roles, ["release-engineering"]);
  assert.deepEqual(offline?.instructions, ["Use signed release workspaces only."]);
  assert.deepEqual(offline?.wakeOnLan, {
    targetState: "enabled",
    automaticWakeState: "relay-required",
    source: "windows-netadapter-power",
    observedAtMs: 9_900,
  });
  assert.equal(offline?.capacity, undefined);
  assert.equal(offline?.currentRuns, undefined);
  assert.equal(offline?.resourceLocks, undefined);

  await afterRestart.observeHeartbeat("device-worker-1", heartbeat({ observedAtMs: 10_000 }));
  assert.equal((await afterRestart.list())[0]?.status, "online");
});

test("Main-owned profiles override bootstrap scheduling Roles without accepting Worker grants", async () => {
  const fleet = new MainWorkerFleetProjection({
    identities: { list: async () => [identity] },
    profiles: {
      get: async (deviceId) =>
        deviceId === identity.deviceId
          ? {
              displayName: "Release workstation",
              roles: ["release-engineering"],
              instructions: ["Use signed release workspaces only."],
              policies: [
                {
                  policyId: "policy-network-change",
                  actionCategory: "os-network-change",
                  decision: "require-approval",
                  source: "configuration",
                  effectiveScope: "device",
                },
              ],
            }
          : undefined,
    },
    clock: { now: () => 10_000 },
  });
  await fleet.observeHeartbeat("device-worker-1", heartbeat());

  assert.deepEqual((await fleet.list())[0]?.roles, ["release-engineering"]);
  const [summary] = await fleet.deviceSummaries();
  assert.equal(summary?.name, "Release workstation");
  assert.deepEqual(summary?.roles, ["release-engineering"]);
  assert.deepEqual(summary?.instructions, ["Use signed release workspaces only."]);
  assert.deepEqual(summary?.policies, [
    {
      policyId: "policy-network-change",
      actionCategory: "os-network-change",
      decision: "require-approval",
      source: "configuration",
      effectiveScope: "device",
    },
  ]);
});

test("identity mismatch and future heartbeat fail closed while stale replay cannot regress state", async () => {
  let now = 10_000;
  const fleet = new MainWorkerFleetProjection({
    identities: { list: async () => [identity] },
    clock: { now: () => now },
  });
  await assert.rejects(
    fleet.observeHeartbeat(
      "device-worker-1",
      heartbeat({
        inventory: {
          ...heartbeat().inventory!,
          osFamily: "linux",
        },
      }),
    ),
    /identity/i,
  );
  await assert.rejects(fleet.observeHeartbeat("device-worker-2", heartbeat()), /identity/i);
  await assert.rejects(
    fleet.observeHeartbeat("device-worker-1", heartbeat({ observedAtMs: now + 60_000 })),
    /future/i,
  );

  await fleet.observeHeartbeat("device-worker-1", heartbeat({ observedAtMs: now }));
  now += 1_000;
  await fleet.observeHeartbeat(
    "device-worker-1",
    heartbeat({
      observedAtMs: 9_999,
      capacity: {
        ...heartbeat().capacity,
        activeRuns: 4,
      },
    }),
  );
  assert.equal((await fleet.list())[0]?.availableRunSlots, 3);
});

function heartbeat(overrides: Partial<WorkerHeartbeatV1> = {}): WorkerHeartbeatV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "device-worker-1",
    workerId: "worker-primary",
    observedAtMs: 10_000,
    operationalState: "active",
    connectionState: "online",
    readiness: {
      daemon: "healthy",
      session: "ready",
      desktop: "available",
      permissions: {
        accessibility: "granted",
        input: "granted",
        screenCapture: "granted",
      },
    },
    capacity: {
      acceptingWork: true,
      activeRuns: 1,
      maxOutboxEntries: 10_000,
      outboxDepth: 0,
    },
    inventory: {
      deviceName: "Build workstation",
      osFamily: "windows",
      platformRelease: "11.0.26100",
      architecture: "x64",
      serviceMode: "foreground",
      knowledgeHealth: "healthy",
      hardware: {
        cpu: {
          model: "Example CPU",
          logicalCoreCount: 16,
          observedAtMs: 9_900,
          source: "node-os",
          verification: "observed",
        },
        memory: {
          totalBytes: 68_719_476_736,
          observedAtMs: 9_900,
          source: "node-os",
          verification: "observed",
        },
        gpu: {
          devices: [
            {
              model: "Example GPU",
              vendor: "Example Vendor",
              memoryBytes: 17_179_869_184,
            },
          ],
          observedAtMs: 9_900,
          source: "platform-probe",
          verification: "verified",
        },
      },
      maximumConcurrentRuns: 4,
      capabilities: [
        {
          name: "codex",
          verification: "verified",
          observedAtMs: 9_900,
          evidenceSource: "agent-adapter",
          version: "1.2.3",
        },
        { name: "computer-use", verification: "verified" },
      ],
      agentAdapters: [
        {
          provider: "codex",
          adapterId: "codex-cli",
          readiness: "ready",
          compatibility: "tested",
          version: "1.2.3",
          observedAtMs: 9_900,
        },
      ],
      wakeOnLan: {
        state: "enabled",
        source: "windows-netadapter-power",
        observedAtMs: 9_900,
      },
      resourceLocks: [
        {
          resourceName: "desktop-session",
          capacity: 1,
          holders: [
            {
              taskId: "task-1",
              runId: "run-1",
              expiresAtMs: 20_000,
            },
          ],
        },
      ],
      workspaceIds: ["workspace-product"],
      availableSecretRefs: ["registry-token"],
    },
    routes: [
      {
        routeId,
        label: "Route 1",
        priority: 0,
        kind: "wss",
        profileRevision: transportProfileRevision,
        health: "healthy",
        lastAttempt: {
          probeSource: "live",
          outcome: "connected",
          observedAtMs: 10_000,
        },
      },
    ],
    currentRuns: [
      {
        taskId: "task-1",
        workOrderId: "work-order-1",
        runId: "run-1",
        state: "running",
        acceptedAtMs: 9_500,
        leaseExpiresAtMs: 20_000,
      },
    ],
    ...overrides,
  };
}

function memoryObservationStore(): MainDeviceObservationStore {
  const observations = new Map<
    string,
    {
      acceptedAtMs: number;
      deviceId: string;
      heartbeat: WorkerHeartbeatV1;
      observationSequence: number;
      observedAtMs: number;
    }
  >();
  return {
    accept: async ({ authenticatedDeviceId, acceptedAtMs, heartbeat: observed }) => {
      const previous = observations.get(authenticatedDeviceId);
      if (previous !== undefined && observed.observedAtMs < previous.observedAtMs) {
        return {
          disposition: "stale",
          observationSequence: previous.observationSequence,
        };
      }
      if (previous !== undefined && observed.observedAtMs === previous.observedAtMs) {
        if (JSON.stringify(observed) !== JSON.stringify(previous.heartbeat)) {
          throw new Error("The observation time was reused.");
        }
        return {
          disposition: "duplicate",
          observationSequence: previous.observationSequence,
        };
      }
      const observationSequence = (previous?.observationSequence ?? 0) + 1;
      observations.set(authenticatedDeviceId, {
        acceptedAtMs,
        deviceId: authenticatedDeviceId,
        heartbeat: structuredClone(observed),
        observationSequence,
        observedAtMs: observed.observedAtMs,
      });
      return { disposition: "accepted", observationSequence };
    },
    latest: async (deviceId) => {
      const observation = observations.get(deviceId);
      return observation === undefined ? undefined : structuredClone(observation);
    },
  };
}
