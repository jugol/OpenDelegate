import assert from "node:assert/strict";
import test from "node:test";

import {
  SchedulerError,
  scheduleWorkOrder,
  type DeviceCandidate,
  type ScheduleRequest,
} from "../src/index.ts";

const baseRequest: ScheduleRequest = {
  workOrderId: "work-order-launch-readiness",
  requiredCapabilities: ["research"],
  preferredCapabilities: ["report-rendering"],
  preferredRoles: ["release-research"],
  requiredSecretRefs: [],
  workspaceId: "workspace-opendelegate",
};

const macResearchDevice: DeviceCandidate = {
  deviceId: "device-mac-research",
  enabled: true,
  status: "online",
  draining: false,
  osFamily: "macos",
  capabilities: [
    { name: "research", verification: "verified" },
    { name: "report-rendering", verification: "verified" },
  ],
  roles: ["release-research"],
  workspaceIds: ["workspace-opendelegate"],
  transports: [
    {
      routeId: "route-mac-tailscale",
      priority: 30,
      health: "healthy",
    },
  ],
  availableRunSlots: 2,
  loadRatio: 0.7,
  desktopSessionAvailable: true,
  executionPolicyDecision: {
    outcome: "allow",
    code: "POLICY_SAFE_OBSERVATION",
  },
  availableSecretRefs: ["secret-release-api"],
};

const linuxIdleDevice: DeviceCandidate = {
  deviceId: "device-linux-idle",
  enabled: true,
  status: "online",
  draining: false,
  osFamily: "linux",
  capabilities: [{ name: "research", verification: "verified" }],
  roles: [],
  workspaceIds: ["workspace-opendelegate"],
  transports: [
    {
      routeId: "route-linux-lan",
      priority: 1,
      health: "healthy",
    },
  ],
  availableRunSlots: 4,
  loadRatio: 0.05,
  desktopSessionAvailable: false,
  executionPolicyDecision: {
    outcome: "allow",
    code: "POLICY_SAFE_OBSERVATION",
  },
  availableSecretRefs: [],
};

test("selects the strongest eligible Device and explains every score component", () => {
  const result = scheduleWorkOrder(baseRequest, [macResearchDevice, linuxIdleDevice]);

  assert.equal(result.selectedDevice.deviceId, "device-mac-research");
  assert.equal(result.selectedRoute.routeId, "route-mac-tailscale");
  assert.deepEqual(result.explanations, [
    {
      deviceId: "device-linux-idle",
      eligible: true,
      exclusions: [],
      score: {
        matchedRoles: [],
        matchedPreferredCapabilities: [],
        roleMatchCount: 0,
        preferredCapabilityMatchCount: 0,
        loadRatio: 0.05,
        routePriority: 1,
        routeId: "route-linux-lan",
      },
    },
    {
      deviceId: "device-mac-research",
      eligible: true,
      exclusions: [],
      score: {
        matchedRoles: ["release-research"],
        matchedPreferredCapabilities: ["report-rendering"],
        roleMatchCount: 1,
        preferredCapabilityMatchCount: 1,
        loadRatio: 0.7,
        routePriority: 30,
        routeId: "route-mac-tailscale",
      },
    },
  ]);
});

test("reports every deterministic eligibility exclusion in stable order", () => {
  const request: ScheduleRequest = {
    workOrderId: "work-order-desktop-check",
    requiredCapabilities: ["research", "computer-use"],
    preferredCapabilities: [],
    preferredRoles: [],
    requiredSecretRefs: ["secret-desktop-license"],
    requiredOsFamily: "windows",
    workspaceId: "workspace-desktop-fixture",
  };
  const eligibleWindowsDevice: DeviceCandidate = {
    deviceId: "device-windows-ready",
    enabled: true,
    status: "online",
    draining: false,
    osFamily: "windows",
    capabilities: [
      { name: "research", verification: "verified" },
      { name: "computer-use", verification: "verified" },
    ],
    roles: [],
    workspaceIds: ["workspace-desktop-fixture"],
    transports: [
      {
        routeId: "route-windows-omada",
        priority: 10,
        health: "healthy",
      },
    ],
    availableRunSlots: 1,
    loadRatio: 0.4,
    desktopSessionAvailable: true,
    executionPolicyDecision: {
      outcome: "allow",
      code: "POLICY_SAFE_OBSERVATION",
    },
    availableSecretRefs: ["secret-desktop-license"],
  };
  const excludedLinuxDevice: DeviceCandidate = {
    deviceId: "device-linux-unavailable",
    enabled: false,
    status: "offline",
    draining: true,
    osFamily: "linux",
    capabilities: [
      { name: "research", verification: "detected" },
      { name: "computer-use", verification: "unavailable" },
    ],
    roles: [],
    workspaceIds: [],
    transports: [
      {
        routeId: "route-linux-broken",
        priority: 50,
        health: "unhealthy",
      },
    ],
    availableRunSlots: 0,
    loadRatio: 1,
    desktopSessionAvailable: false,
    executionPolicyDecision: {
      outcome: "deny",
      code: "POLICY_TARGET_NOT_AUTHORIZED",
    },
    availableSecretRefs: [],
  };

  const result = scheduleWorkOrder(request, [eligibleWindowsDevice, excludedLinuxDevice]);

  assert.deepEqual(result.explanations[0], {
    deviceId: "device-linux-unavailable",
    eligible: false,
    exclusions: [
      { code: "DEVICE_DISABLED" },
      { code: "DEVICE_OFFLINE" },
      { code: "DEVICE_DRAINING" },
      {
        code: "POLICY_EXECUTION_NOT_ALLOWED",
        outcome: "deny",
        policyCode: "POLICY_TARGET_NOT_AUTHORIZED",
      },
      {
        code: "OS_FAMILY_MISMATCH",
        required: "windows",
        actual: "linux",
      },
      {
        code: "REQUIRED_CAPABILITY_NOT_VERIFIED",
        capabilities: ["computer-use", "research"],
      },
      {
        code: "REQUIRED_SECRET_UNAVAILABLE",
        secretRefs: ["secret-desktop-license"],
      },
      {
        code: "WORKSPACE_UNAVAILABLE",
        workspaceId: "workspace-desktop-fixture",
      },
      { code: "TRANSPORT_UNHEALTHY" },
      { code: "CAPACITY_UNAVAILABLE" },
      { code: "DESKTOP_SESSION_UNAVAILABLE" },
    ],
    score: null,
  });
});

test("throws a typed error with all explanations when no Device is eligible", () => {
  const offlineDevice: DeviceCandidate = {
    ...linuxIdleDevice,
    status: "offline",
  };

  assert.throws(
    () => scheduleWorkOrder(baseRequest, [offlineDevice]),
    (error: unknown) => {
      assert.ok(error instanceof SchedulerError);
      assert.equal(error.code, "SCHEDULER_NO_ELIGIBLE_DEVICE");
      assert.deepEqual(error.explanations, [
        {
          deviceId: "device-linux-idle",
          eligible: false,
          exclusions: [{ code: "DEVICE_OFFLINE" }],
          score: null,
        },
      ]);
      return true;
    },
  );
});

test("does not select a Device whose executable Policy decision requires approval", () => {
  const policyBlockedDevice: DeviceCandidate = {
    ...linuxIdleDevice,
    executionPolicyDecision: {
      outcome: "require-approval",
      code: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
    },
  };

  assert.throws(
    () => scheduleWorkOrder(baseRequest, [policyBlockedDevice]),
    (error: unknown) => {
      assert.ok(error instanceof SchedulerError);
      assert.deepEqual(error.explanations, [
        {
          deviceId: "device-linux-idle",
          eligible: false,
          exclusions: [
            {
              code: "POLICY_EXECUTION_NOT_ALLOWED",
              outcome: "require-approval",
              policyCode: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
            },
          ],
          score: null,
        },
      ]);
      return true;
    },
  );
});

test("does not select a Device missing a required local Secret", () => {
  const secretBoundRequest: ScheduleRequest = {
    ...baseRequest,
    requiredSecretRefs: ["secret-release-api"],
  };
  const deviceWithoutSecret: DeviceCandidate = {
    ...linuxIdleDevice,
    availableSecretRefs: [],
  };

  assert.throws(
    () => scheduleWorkOrder(secretBoundRequest, [deviceWithoutSecret]),
    (error: unknown) => {
      assert.ok(error instanceof SchedulerError);
      assert.deepEqual(error.explanations, [
        {
          deviceId: "device-linux-idle",
          eligible: false,
          exclusions: [
            {
              code: "REQUIRED_SECRET_UNAVAILABLE",
              secretRefs: ["secret-release-api"],
            },
          ],
          score: null,
        },
      ]);
      return true;
    },
  );
});

test("replays the same result for tied Devices regardless of input order", () => {
  const deviceA: DeviceCandidate = {
    ...macResearchDevice,
    deviceId: "device-a",
    transports: [
      {
        routeId: "route-a",
        priority: 10,
        health: "healthy",
      },
    ],
    loadRatio: 0.25,
  };
  const deviceZ: DeviceCandidate = {
    ...macResearchDevice,
    deviceId: "device-z",
    transports: [
      {
        routeId: "route-z",
        priority: 10,
        health: "healthy",
      },
    ],
    loadRatio: 0.25,
  };

  const forward = scheduleWorkOrder(baseRequest, [deviceZ, deviceA]);
  const reverse = scheduleWorkOrder(baseRequest, [deviceA, deviceZ]);

  assert.equal(forward.selectedDevice.deviceId, "device-a");
  assert.deepEqual(forward, reverse);
});

test("malformed capacity and load values never make a Device eligible", () => {
  for (const invalidDevice of [
    { ...linuxIdleDevice, availableRunSlots: Number.NaN },
    { ...linuxIdleDevice, availableRunSlots: 1.5 },
    { ...linuxIdleDevice, loadRatio: Number.NaN },
    { ...linuxIdleDevice, loadRatio: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => scheduleWorkOrder(baseRequest, [invalidDevice]),
      (error: unknown) => {
        assert.ok(error instanceof SchedulerError);
        assert.equal(error.code, "SCHEDULER_NO_ELIGIBLE_DEVICE");
        assert.equal(error.explanations[0]?.exclusions[0]?.code, "DEVICE_SNAPSHOT_INVALID");
        return true;
      },
    );
  }
});

test("duplicate Device identities are rejected independently of input order", () => {
  const first = {
    ...linuxIdleDevice,
    deviceId: "device-duplicate",
    transports: [{ routeId: "route-a", priority: 1, health: "healthy" as const }],
  };
  const second = {
    ...linuxIdleDevice,
    deviceId: "device-duplicate",
    transports: [{ routeId: "route-z", priority: 1, health: "healthy" as const }],
  };

  for (const devices of [
    [first, second],
    [second, first],
  ]) {
    assert.throws(
      () => scheduleWorkOrder(baseRequest, devices),
      (error: unknown) => {
        assert.ok(error instanceof SchedulerError);
        assert.equal(error.code, "SCHEDULER_INPUT_INVALID");
        return true;
      },
    );
  }
});
