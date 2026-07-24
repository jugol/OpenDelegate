import assert from "node:assert/strict";
import test from "node:test";

import {
  SchedulerError,
  isWorkOrderAssignmentEligible,
  scheduleWorkOrder,
  type DeviceCandidate,
  type ScheduleRequest,
} from "../src/index.ts";

const baseRequest: ScheduleRequest = {
  workOrderId: "work-order-launch-readiness",
  requiredCapabilities: ["research"],
  preferredCapabilities: ["report-rendering"],
  preferredDeviceIds: [],
  preferredRoles: ["release-research"],
  requiredSecretRefs: [],
  workspaceId: "workspace-opendelegate",
};

const macResearchDevice: DeviceCandidate = {
  deviceId: "device-mac-research",
  workerId: "worker-mac-research",
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
  workerId: "worker-linux-idle",
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
  assert.deepEqual(result.semanticSelectionCandidates, []);
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
    preferredDeviceIds: [],
    preferredRoles: [],
    requiredSecretRefs: ["secret-desktop-license"],
    requiredOsFamily: "windows",
    workspaceId: "workspace-desktop-fixture",
  };
  const eligibleWindowsDevice: DeviceCandidate = {
    deviceId: "device-windows-ready",
    workerId: "worker-windows-ready",
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
    workerId: "worker-linux-unavailable",
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
    workerId: "worker-a",
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
    workerId: "worker-z",
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
  assert.deepEqual(
    forward.semanticSelectionCandidates.map((candidate) => candidate.deviceId),
    ["device-a", "device-z"],
  );
  assert.deepEqual(forward, reverse);
});

test("honors only eligible preferred Devices and otherwise falls back to the full eligible set", () => {
  const preferredRequest: ScheduleRequest = {
    ...baseRequest,
    preferredDeviceIds: ["device-linux-idle", "device-offline"],
  };
  const offlinePreferredDevice: DeviceCandidate = {
    ...macResearchDevice,
    deviceId: "device-offline",
    workerId: "worker-offline",
    status: "offline",
  };

  const preferred = scheduleWorkOrder(preferredRequest, [
    macResearchDevice,
    linuxIdleDevice,
    offlinePreferredDevice,
  ]);
  assert.equal(preferred.selectedDevice.deviceId, "device-linux-idle");
  assert.deepEqual(preferred.semanticSelectionCandidates, []);

  const fallback = scheduleWorkOrder(
    { ...preferredRequest, preferredDeviceIds: ["device-offline"] },
    [macResearchDevice, linuxIdleDevice, offlinePreferredDevice],
  );
  assert.equal(fallback.selectedDevice.deviceId, "device-mac-research");
});

test("validates a durable assignment against the same eligibility rules without changing its route", () => {
  assert.equal(
    isWorkOrderAssignmentEligible(
      baseRequest,
      {
        ...macResearchDevice,
        transports: [
          ...macResearchDevice.transports,
          { routeId: "route-existing", priority: 50, health: "healthy" },
        ],
      },
      "route-existing",
    ),
    true,
  );
  assert.equal(
    isWorkOrderAssignmentEligible(baseRequest, macResearchDevice, "route-retired"),
    false,
  );
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

test("complete Device snapshot validation is shared by selection and durable assignment checks", () => {
  const malformedSnapshots: ReadonlyArray<{
    readonly name: string;
    readonly field: string;
    readonly device: DeviceCandidate;
  }> = [
    {
      name: "padded Device identity",
      field: "deviceId",
      device: { ...linuxIdleDevice, deviceId: " device-linux-idle" },
    },
    {
      name: "padded Worker identity",
      field: "workerId",
      device: { ...linuxIdleDevice, workerId: "worker-linux-idle " },
    },
    {
      name: "unknown OS family",
      field: "osFamily",
      device: { ...linuxIdleDevice, osFamily: "plan9" } as unknown as DeviceCandidate,
    },
    {
      name: "non-boolean enabled readiness",
      field: "enabled",
      device: { ...linuxIdleDevice, enabled: "yes" } as unknown as DeviceCandidate,
    },
    {
      name: "unknown online status",
      field: "status",
      device: { ...linuxIdleDevice, status: "ready" } as unknown as DeviceCandidate,
    },
    {
      name: "non-boolean draining state",
      field: "draining",
      device: { ...linuxIdleDevice, draining: 0 } as unknown as DeviceCandidate,
    },
    {
      name: "blank Capability name",
      field: "capabilities",
      device: {
        ...linuxIdleDevice,
        capabilities: [...linuxIdleDevice.capabilities, { name: " ", verification: "verified" }],
      },
    },
    {
      name: "non-array Capabilities",
      field: "capabilities",
      device: { ...linuxIdleDevice, capabilities: null } as unknown as DeviceCandidate,
    },
    {
      name: "unknown Capability verification",
      field: "capabilities",
      device: {
        ...linuxIdleDevice,
        capabilities: [
          ...linuxIdleDevice.capabilities,
          { name: "artifact-rendering", verification: "trusted" },
        ],
      } as unknown as DeviceCandidate,
    },
    {
      name: "duplicate Capability names",
      field: "capabilities",
      device: {
        ...linuxIdleDevice,
        capabilities: [
          ...linuxIdleDevice.capabilities,
          { name: "research", verification: "verified" },
        ],
      },
    },
    {
      name: "duplicate Roles",
      field: "roles",
      device: { ...linuxIdleDevice, roles: ["researcher", "researcher"] },
    },
    {
      name: "blank Role",
      field: "roles",
      device: { ...linuxIdleDevice, roles: [" "] },
    },
    {
      name: "non-array Roles",
      field: "roles",
      device: { ...linuxIdleDevice, roles: "researcher" } as unknown as DeviceCandidate,
    },
    {
      name: "duplicate Workspace references",
      field: "workspaceIds",
      device: {
        ...linuxIdleDevice,
        workspaceIds: ["workspace-opendelegate", "workspace-opendelegate"],
      },
    },
    {
      name: "blank Workspace reference",
      field: "workspaceIds",
      device: { ...linuxIdleDevice, workspaceIds: ["workspace-opendelegate", " "] },
    },
    {
      name: "non-array Workspace references",
      field: "workspaceIds",
      device: { ...linuxIdleDevice, workspaceIds: null } as unknown as DeviceCandidate,
    },
    {
      name: "duplicate Secret references",
      field: "availableSecretRefs",
      device: {
        ...linuxIdleDevice,
        availableSecretRefs: ["secret-release-api", "secret-release-api"],
      },
    },
    {
      name: "blank Secret reference",
      field: "availableSecretRefs",
      device: { ...linuxIdleDevice, availableSecretRefs: [" "] },
    },
    {
      name: "non-array Secret references",
      field: "availableSecretRefs",
      device: {
        ...linuxIdleDevice,
        availableSecretRefs: "secret-release-api",
      } as unknown as DeviceCandidate,
    },
    {
      name: "malformed desktop readiness",
      field: "desktopSessionAvailable",
      device: {
        ...linuxIdleDevice,
        desktopSessionAvailable: "ready",
      } as unknown as DeviceCandidate,
    },
    {
      name: "unknown executable Policy outcome",
      field: "executionPolicyDecision",
      device: {
        ...linuxIdleDevice,
        executionPolicyDecision: { outcome: "permit", code: "POLICY_INVALID" },
      } as unknown as DeviceCandidate,
    },
    {
      name: "blank executable Policy code",
      field: "executionPolicyDecision",
      device: {
        ...linuxIdleDevice,
        executionPolicyDecision: { outcome: "allow", code: " " },
      },
    },
    {
      name: "malformed executable Policy decision",
      field: "executionPolicyDecision",
      device: {
        ...linuxIdleDevice,
        executionPolicyDecision: null,
      } as unknown as DeviceCandidate,
    },
    {
      name: "unknown transport health",
      field: "transports",
      device: {
        ...linuxIdleDevice,
        transports: [{ routeId: "route-linux-lan", priority: 1, health: "unknown" }],
      } as unknown as DeviceCandidate,
    },
    {
      name: "non-array transports",
      field: "transports",
      device: { ...linuxIdleDevice, transports: null } as unknown as DeviceCandidate,
    },
  ];

  for (const malformed of malformedSnapshots) {
    assert.throws(
      () => scheduleWorkOrder(baseRequest, [malformed.device]),
      (error: unknown) => {
        assert.ok(error instanceof SchedulerError, malformed.name);
        assert.equal(error.code, "SCHEDULER_NO_ELIGIBLE_DEVICE", malformed.name);
        assert.deepEqual(
          error.explanations[0]?.exclusions,
          [{ code: "DEVICE_SNAPSHOT_INVALID", fields: [malformed.field] }],
          malformed.name,
        );
        return true;
      },
      malformed.name,
    );
    assert.equal(
      isWorkOrderAssignmentEligible(baseRequest, malformed.device, "route-linux-lan"),
      false,
      malformed.name,
    );
  }
});

test("malformed Schedule requests fail deterministically at both public scheduling boundaries", () => {
  const malformedRequests: ReadonlyArray<{
    readonly name: string;
    readonly request: ScheduleRequest;
  }> = [
    {
      name: "non-object request",
      request: null as unknown as ScheduleRequest,
    },
    {
      name: "blank Work Order identity",
      request: { ...baseRequest, workOrderId: " " },
    },
    {
      name: "padded Work Order identity",
      request: { ...baseRequest, workOrderId: " work-order-launch-readiness" },
    },
    {
      name: "non-array required Capabilities",
      request: { ...baseRequest, requiredCapabilities: null } as unknown as ScheduleRequest,
    },
    {
      name: "blank required Capability",
      request: { ...baseRequest, requiredCapabilities: ["research", " "] },
    },
    {
      name: "duplicate required Capabilities",
      request: { ...baseRequest, requiredCapabilities: ["research", "research"] },
    },
    {
      name: "non-array preferred Capabilities",
      request: { ...baseRequest, preferredCapabilities: "research" } as unknown as ScheduleRequest,
    },
    {
      name: "padded preferred Capability",
      request: { ...baseRequest, preferredCapabilities: [" research"] },
    },
    {
      name: "duplicate preferred Capabilities",
      request: { ...baseRequest, preferredCapabilities: ["research", "research"] },
    },
    {
      name: "non-array preferred Device identities",
      request: { ...baseRequest, preferredDeviceIds: null } as unknown as ScheduleRequest,
    },
    {
      name: "blank preferred Device identity",
      request: { ...baseRequest, preferredDeviceIds: [" "] },
    },
    {
      name: "duplicate preferred Device identities",
      request: { ...baseRequest, preferredDeviceIds: ["device-a", "device-a"] },
    },
    {
      name: "non-array preferred Roles",
      request: { ...baseRequest, preferredRoles: "researcher" } as unknown as ScheduleRequest,
    },
    {
      name: "padded preferred Role",
      request: { ...baseRequest, preferredRoles: ["researcher "] },
    },
    {
      name: "duplicate preferred Roles",
      request: { ...baseRequest, preferredRoles: ["researcher", "researcher"] },
    },
    {
      name: "non-array required Secret references",
      request: { ...baseRequest, requiredSecretRefs: null } as unknown as ScheduleRequest,
    },
    {
      name: "blank required Secret reference",
      request: { ...baseRequest, requiredSecretRefs: [" "] },
    },
    {
      name: "duplicate required Secret references",
      request: { ...baseRequest, requiredSecretRefs: ["secret-a", "secret-a"] },
    },
    {
      name: "unknown required OS family",
      request: { ...baseRequest, requiredOsFamily: "plan9" } as unknown as ScheduleRequest,
    },
    {
      name: "blank Workspace identity",
      request: { ...baseRequest, workspaceId: " " },
    },
    {
      name: "padded Workspace identity",
      request: { ...baseRequest, workspaceId: " workspace-opendelegate" },
    },
  ];

  for (const malformed of malformedRequests) {
    assert.throws(
      () => scheduleWorkOrder(malformed.request, [linuxIdleDevice]),
      (error: unknown) => {
        assert.ok(error instanceof SchedulerError, malformed.name);
        assert.equal(error.code, "SCHEDULER_INPUT_INVALID", malformed.name);
        assert.deepEqual(error.explanations, [], malformed.name);
        return true;
      },
      malformed.name,
    );
    assert.equal(
      isWorkOrderAssignmentEligible(malformed.request, linuxIdleDevice, "route-linux-lan"),
      false,
      malformed.name,
    );
  }

  for (const routeId of ["", " ", " route-linux-lan", 7 as unknown as string]) {
    assert.equal(
      isWorkOrderAssignmentEligible(baseRequest, linuxIdleDevice, routeId),
      false,
      `route identity ${String(routeId)}`,
    );
  }
});

test("duplicate Device identities are rejected independently of input order", () => {
  const first = {
    ...linuxIdleDevice,
    deviceId: "device-duplicate",
    workerId: "worker-first",
    transports: [{ routeId: "route-a", priority: 1, health: "healthy" as const }],
  };
  const second = {
    ...linuxIdleDevice,
    deviceId: "device-duplicate",
    workerId: "worker-second",
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
