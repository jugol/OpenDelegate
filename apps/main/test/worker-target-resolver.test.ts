import assert from "node:assert/strict";
import { test } from "node:test";

import type { DeviceCandidate } from "@opendelegate/scheduler";

import {
  type AgentAwareWorkerCandidate,
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

test("local Worker IDs may repeat across different Device candidates", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      candidate("device-nas", {
        workerId: "worker-primary",
      }),
      candidate("device-windows", {
        workerId: "worker-primary",
        osFamily: "windows",
        capabilities: [
          { name: "codex", verification: "verified" },
          { name: "windows", verification: "verified" },
        ],
      }),
    ]),
  });

  const selected = await resolver.resolve({
    task: task(),
    workOrder: {
      ...workOrder(),
      requiredOsFamily: "windows",
      requiredCapabilities: ["windows"],
      schedulingHints: {
        preferredDeviceIds: ["device-windows"],
        preferredRoles: [],
      },
    },
    previousRuns: [],
    signal: new AbortController().signal,
  });

  assert.deepEqual(selected, {
    deviceId: "device-windows",
    workerId: "worker-primary",
    routeId: "route-device-windows",
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
      retryKind: "resource",
    },
  );
});

test("invalid candidate state is not mislabeled as an offline Worker", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      candidate("device-duplicate"),
      candidate("device-duplicate", { workerId: "worker-other" }),
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
      code: "WORKER_CANDIDATE_STATE_INVALID",
      retryable: false,
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

test("a Device profile resolves one exact adapter and model into the dispatch target", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      {
        ...candidate("device-nas", {
          capabilities: [{ name: "claude-code", verification: "verified" }],
        }),
        agentExecutionProfile: {
          schemaVersion: 1,
          mode: "pinned",
          primary: {
            provider: "claude",
            adapterId: "claude-agent-sdk",
            modelId: "claude-opus-5",
          },
        },
        agentAdapters: [
          {
            provider: "claude",
            adapterId: "claude-agent-sdk",
            readiness: "ready",
            compatibility: "tested",
            models: [{ modelId: "claude-opus-5", isDefault: true }],
          },
        ],
      },
    ]),
  });

  const selected = await resolver.resolve({
    task: task(),
    workOrder: { ...workOrder(), requiredCapabilities: [] },
    previousRuns: [],
    signal: new AbortController().signal,
  });

  assert.deepEqual(selected.agentRequirement, {
    provider: "claude",
    adapterId: "claude-agent-sdk",
    modelId: "claude-opus-5",
    allowedCompatibilities: ["tested"],
  });
});

test("a Prefer profile falls back in declared order when its primary binding is unavailable", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      {
        ...candidate("device-prefer"),
        agentExecutionProfile: {
          schemaVersion: 1,
          mode: "prefer",
          primary: {
            provider: "codex",
            adapterId: "codex-app-server",
            modelId: "gpt-primary",
          },
          fallbacks: [
            {
              provider: "codex",
              adapterId: "codex-cli",
              modelId: "gpt-fallback",
            },
            {
              provider: "claude",
              adapterId: "claude-cli",
              modelId: "claude-fallback",
            },
          ],
        },
        agentAdapters: [
          {
            provider: "codex",
            adapterId: "codex-app-server",
            readiness: "degraded",
            compatibility: "tested",
            models: [{ modelId: "gpt-primary", isDefault: true }],
          },
          {
            provider: "codex",
            adapterId: "codex-cli",
            readiness: "ready",
            compatibility: "tested",
            models: [{ modelId: "gpt-fallback", isDefault: true }],
          },
          {
            provider: "claude",
            adapterId: "claude-cli",
            readiness: "ready",
            compatibility: "tested",
            models: [{ modelId: "claude-fallback", isDefault: true }],
          },
        ],
      },
    ]),
  });

  const selected = await resolver.resolve({
    task: task(),
    workOrder: workOrder(),
    previousRuns: [],
    signal: new AbortController().signal,
  });

  assert.deepEqual(selected.agentRequirement, {
    provider: "codex",
    adapterId: "codex-cli",
    modelId: "gpt-fallback",
    allowedCompatibilities: ["tested"],
  });
});

test("a Pinned profile fails closed when it conflicts with a Work Order hard requirement", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      {
        ...candidate("device-conflict", {
          capabilities: [
            { name: "codex", verification: "verified" },
            { name: "claude-code", verification: "verified" },
          ],
        }),
        agentExecutionProfile: {
          schemaVersion: 1,
          mode: "pinned",
          primary: {
            provider: "claude",
            adapterId: "claude-agent-sdk",
            modelId: "claude-opus",
          },
        },
        agentAdapters: [
          {
            provider: "codex",
            adapterId: "codex-app-server",
            readiness: "ready",
            compatibility: "tested",
            models: [{ modelId: "gpt-required", isDefault: true }],
          },
          {
            provider: "claude",
            adapterId: "claude-agent-sdk",
            readiness: "ready",
            compatibility: "tested",
            models: [{ modelId: "claude-opus", isDefault: true }],
          },
        ],
      },
    ]),
  });

  await assert.rejects(
    resolver.resolve({
      task: task(),
      workOrder: {
        ...workOrder(),
        requiredAgent: {
          provider: "codex",
          adapterId: "codex-app-server",
          modelId: "gpt-required",
          allowedCompatibilities: ["tested"],
        },
      },
      previousRuns: [],
      signal: new AbortController().signal,
    }),
    {
      code: "AGENT_BINDING_UNAVAILABLE",
      retryable: true,
    },
  );
});

test("automatic first-class Agent selection fails closed without a verified model catalog", async () => {
  const resolver = new DeterministicWorkerTargetResolver({
    candidates: source([
      {
        ...candidate("device-model-catalog-missing"),
        agentExecutionProfile: { schemaVersion: 1, mode: "auto" },
        agentAdapters: [
          {
            provider: "codex",
            adapterId: "codex-app-server",
            readiness: "ready",
            compatibility: "tested",
            models: [],
          },
        ],
      },
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
      code: "AGENT_BINDING_UNAVAILABLE",
      retryable: true,
    },
  );
});

function source(candidates: readonly AgentAwareWorkerCandidate[]): WorkerCandidateSource {
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
