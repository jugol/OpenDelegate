import assert from "node:assert/strict";
import { test } from "node:test";

import type { DeviceCandidate } from "@opendelegate/scheduler";

import {
  DeterministicWorkerTargetResolver,
  type WorkerCandidateSource,
} from "../src/worker-target-resolver.ts";

test("target resolution filters mechanically ineligible Devices before deterministic scoring", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      candidate("device-offline", {
        status: "offline",
        roles: ["development"],
      }),
      candidate("device-policy-denied", {
        executionPolicyDecision: {
          outcome: "deny",
          code: "POLICY_DENIED",
        },
        roles: ["development"],
      }),
      candidate("device-build-rig", {
        availableRunSlots: 3,
        loadRatio: 0.2,
        roles: ["development"],
      }),
      candidate("device-busy", {
        availableRunSlots: 1,
        loadRatio: 0.9,
        roles: ["development"],
      }),
    ]),
  });

  const selected = await resolver.resolve({
    task: task(),
    workOrder: workOrder(),
    previousRuns: [],
    signal: new AbortController().signal,
  });

  assert.deepEqual(selected, {
    deviceId: "device-build-rig",
    workerId: "worker-device-build-rig",
    routeId: "route-device-build-rig",
  });
});

test("a retry prefers an eligible Device that has not already owned this Work Order", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      candidate("device-a", { loadRatio: 0.1 }),
      candidate("device-b", { loadRatio: 0.2 }),
    ]),
  });
  const order = workOrder();

  const selected = await resolver.resolve({
    task: task(),
    workOrder: order,
    previousRuns: [
      {
        taskId: "task-release",
        workOrder: order,
        deviceId: "device-a",
        workerId: "worker-device-a",
        routeId: "route-device-a",
        runId: "run-old",
        leaseId: "lease-old",
        fencingToken: 1,
        leaseExpiresAtMs: Date.now() + 60_000,
      },
    ],
    signal: new AbortController().signal,
  });

  assert.equal(selected.deviceId, "device-b");
});

test("target resolution fails with a retryable structured error when no eligible Worker exists", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      candidate("device-no-capability", {
        capabilities: [{ name: "codex", verification: "detected" }],
      }),
    ]),
  });

  await assert.rejects(
    resolver.resolve({
      task: task(),
      workOrder: workOrder(),
      previousRuns: [],
      signal: new AbortController().signal,
    }),
    {
      code: "WORKER_OFFLINE",
      retryable: true,
    },
  );
});

test("an explicit Agent provider requirement is a mechanical scheduling gate", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      candidate("device-codex"),
      candidate("device-claude", {
        capabilities: [{ name: "claude-code", verification: "verified" }],
      }),
    ]),
  });

  const selected = await resolver.resolve({
    task: task(),
    workOrder: {
      ...workOrder(),
      requiredCapabilities: [],
      requiredAgent: {
        provider: "claude",
        adapterId: "claude-agent-sdk",
        allowedCompatibilities: ["tested"],
      },
    },
    previousRuns: [],
    signal: new AbortController().signal,
  });

  assert.equal(selected.deviceId, "device-claude");
});

function source(candidates: readonly DeviceCandidate[]): WorkerCandidateSource {
  return {
    list: async () => structuredClone(candidates),
  };
}

function task() {
  return {
    taskId: "task-release",
    state: "running" as const,
    mode: "auto" as const,
    objective: "Build the release.",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    version: 1,
    completionCriteria: ["The release is verified."],
    constraints: [],
    selectedInputRefs: [],
    messages: [],
    events: [],
  };
}

function workOrder() {
  return {
    protocolVersion: "v1" as const,
    workOrderId: "work-release",
    title: "Build",
    brief: "Build and test the release.",
    completionCriteria: ["The build and tests succeed."],
    constraints: [],
    selectedInputIds: [],
    dependsOn: [],
    schedulingHints: {
      preferredDeviceIds: [],
      preferredRoles: ["development"],
    },
    requiredCapabilities: ["codex"],
    requiredSecretRefs: [],
  };
}

function candidate(deviceId: string, overrides: Partial<DeviceCandidate> = {}): DeviceCandidate {
  return {
    deviceId,
    workerId: `worker-${deviceId}`,
    enabled: true,
    status: "online",
    draining: false,
    osFamily: "linux",
    capabilities: [{ name: "codex", verification: "verified" }],
    roles: [],
    workspaceIds: [],
    transports: [
      {
        routeId: `route-${deviceId}`,
        priority: 0,
        health: "healthy",
      },
    ],
    availableRunSlots: 1,
    loadRatio: 0.5,
    desktopSessionAvailable: false,
    executionPolicyDecision: {
      outcome: "allow",
      code: "POLICY_ALLOWED",
    },
    availableSecretRefs: [],
    ...overrides,
  };
}
