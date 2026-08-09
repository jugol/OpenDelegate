import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceSummaryV1 } from "@opendelegate/protocol";

import { mergeMainDeviceSummary } from "../src/device-directory-projection.ts";

function mainSummary(): DeviceSummaryV1 {
  return {
    deviceId: "device-main",
    name: "Studio",
    osFamily: "windows",
    platformRelease: "11",
    architecture: "x64",
    role: "main",
    connection: "online",
    runtime: "healthy",
    serviceMode: "foreground",
    roles: ["main-coordinator"],
    instructions: ["Keep the owner informed."],
    policies: [
      {
        policyId: "built-in-secret-export",
        actionCategory: "secret-export",
        decision: "deny",
        source: "built-in",
        effectiveScope: "instance",
      },
    ],
    routes: [
      {
        routeId: "main-local:device-main",
        label: "Main-local",
        priority: 0,
        health: "healthy",
      },
    ],
    knowledgeHealth: "unknown",
  };
}

function workerSummary(deviceId = "device-main"): DeviceSummaryV1 {
  return {
    deviceId,
    name: deviceId === "device-main" ? "Worker self-report" : "Remote Worker",
    osFamily: "windows",
    platformRelease: "11",
    architecture: "x64",
    role: "worker",
    connection: "online",
    runtime: "healthy",
    serviceMode: "system-service",
    roles: ["untrusted-worker-role"],
    instructions: ["Untrusted worker instruction."],
    facts: [
      {
        kind: "platform-release",
        value: "11",
        source: "authenticated-heartbeat",
        observedAtMs: 1_000,
        verification: "observed",
      },
    ],
    capabilities: [
      {
        name: "computer-use",
        verification: "verified",
        evidenceSource: "capability-probe",
      },
    ],
    policies: [
      {
        policyId: "untrusted-worker-policy",
        actionCategory: "secret-export",
        decision: "allow",
        source: "configuration",
        effectiveScope: "device",
      },
    ],
    workspaceIds: ["workspace-product"],
    agentAdapters: [
      {
        provider: "codex",
        adapterId: "codex-app-server",
        readiness: "ready",
        compatibility: "tested",
        version: "1.2.3",
        observedAtMs: 1_000,
      },
    ],
    routes: [
      {
        routeId: "route:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0",
        label: "Route 1",
        priority: 0,
        kind: "wss",
        profileRevision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        health: "healthy",
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
        acceptedAtMs: 1_000,
        leaseExpiresAtMs: 20_000,
      },
    ],
    capacity: {
      activeRuns: 1,
      maximumConcurrentRuns: 4,
      acceptingWork: true,
    },
    knowledgeHealth: "healthy",
  };
}

test("co-located Main and Worker roles project as one authoritative Device", () => {
  const remote = workerSummary("device-remote");
  const projected = mergeMainDeviceSummary(mainSummary(), [workerSummary(), remote]);

  assert.equal(projected.length, 2);
  const merged = projected[0]!;
  assert.equal(merged.deviceId, "device-main");
  assert.equal(merged.role, "main");
  assert.equal(merged.name, "Studio");
  assert.deepEqual(merged.roles, ["main-coordinator"]);
  assert.deepEqual(merged.instructions, ["Keep the owner informed."]);
  assert.deepEqual(
    merged.policies?.map((policy) => policy.policyId),
    ["built-in-secret-export"],
  );
  assert.equal(merged.serviceMode, "system-service");
  assert.deepEqual(merged.capabilities, workerSummary().capabilities);
  assert.deepEqual(merged.agentAdapters, workerSummary().agentAdapters);
  assert.deepEqual(merged.workspaceIds, ["workspace-product"]);
  assert.deepEqual(merged.resourceLocks, workerSummary().resourceLocks);
  assert.deepEqual(merged.currentRuns, workerSummary().currentRuns);
  assert.deepEqual(
    merged.routes?.map((route) => [route.routeId, route.priority]),
    [
      ["main-local:device-main", 0],
      ["route:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0", 1],
    ],
  );
  assert.equal(projected[1]?.deviceId, "device-remote");
});

test("a Main-only installation remains a single Device", () => {
  assert.deepEqual(mergeMainDeviceSummary(mainSummary(), []), [mainSummary()]);
});

test("conflicting or duplicate co-located Worker identities fail closed", () => {
  const conflicting = { ...workerSummary(), architecture: "arm64" } as DeviceSummaryV1;
  assert.throws(() => mergeMainDeviceSummary(mainSummary(), [conflicting]), /conflicts with Main/u);
  assert.throws(
    () => mergeMainDeviceSummary(mainSummary(), [workerSummary(), workerSummary()]),
    /duplicate identities/u,
  );
});
