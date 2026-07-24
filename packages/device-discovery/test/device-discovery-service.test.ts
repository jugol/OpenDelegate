import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceDiscoveryService,
  type CapabilityProbe,
  type DiscoveryInput,
  type OsFamily,
} from "../src/index.ts";

const observedAt = Date.parse("2026-07-24T00:00:00.000Z");

function verifiedAgentProbe(capabilityId: "codex" | "claude-code"): CapabilityProbe {
  return {
    probeId: `probe-${capabilityId}`,
    capabilityId,
    source: "agent-adapter",
    observedAt,
    installation: "present",
    verification: "passed",
    version: "1.0.0",
    disabled: false,
  };
}

function computerUseProbe(
  verification: CapabilityProbe["verification"] = "passed",
): CapabilityProbe {
  return {
    probeId: `probe-computer-use-${verification}`,
    capabilityId: "computer-use",
    source: "capability-probe",
    observedAt,
    installation: "present",
    verification,
    disabled: false,
  };
}

function discoveryInput(platform: string, agent: "codex" | "claude-code"): DiscoveryInput {
  return {
    deviceId: `device-${platform.toLowerCase()}`,
    runtimeFacts: {
      platform,
      architecture: "arm64",
      hostname: "worker-device",
      observedAt,
      workerService: {
        state: "running",
        observedAt,
        source: "service-manager",
      },
      userSession: {
        state: "ready",
        observedAt,
        source: "user-session-helper",
      },
    },
    capabilityProbes: [verifiedAgentProbe(agent), computerUseProbe()],
  };
}

test("normalizes all three OS families and recommends Computer Use without persisting profile changes", () => {
  const service = new DeviceDiscoveryService();
  const cases: readonly {
    readonly platform: string;
    readonly osFamily: OsFamily;
    readonly agent: "codex" | "claude-code";
  }[] = [
    { platform: "macOS", osFamily: "macos", agent: "codex" },
    { platform: "win32", osFamily: "windows", agent: "claude-code" },
    { platform: "Linux", osFamily: "linux", agent: "codex" },
  ];

  for (const item of cases) {
    const result = service.discover(discoveryInput(item.platform, item.agent));
    const agentCapability = result.capabilities.find(
      (capability) => capability.capabilityId === item.agent,
    );
    const computerUse = result.capabilities.find(
      (capability) => capability.capabilityId === "computer-use",
    );

    assert.equal(result.facts.osFamily, item.osFamily);
    assert.equal(agentCapability?.state, "verified");
    assert.equal(computerUse?.state, "verified");
    assert.equal(result.readiness.workerService.status, "ready");
    assert.equal(result.readiness.userSession.status, "ready");
    assert.deepEqual(result.profilePatchProposals, [
      {
        proposalId: `proposal-${result.facts.deviceId}-computer-use`,
        targetDeviceId: result.facts.deviceId,
        reasonCode: "COMPUTER_USE_READY",
        operations: [
          {
            field: "roles",
            operation: "add",
            value: "computer-use-worker",
          },
          {
            field: "instructions",
            operation: "add",
            value:
              "Prefer structured browser automation for browser-only work; otherwise acquire the desktop-session lock before Computer Use.",
          },
        ],
        evidenceCapabilityIds: [item.agent, "computer-use"],
      },
    ]);
  }
});

test("maps installed, pending, verified, degraded, unavailable, and disabled probe states without promoting an unverified Agent", () => {
  const base = discoveryInput("linux", "codex");
  const probes: readonly CapabilityProbe[] = [
    {
      ...verifiedAgentProbe("codex"),
      probeId: "probe-codex-detected",
      verification: "not-run",
    },
    {
      ...verifiedAgentProbe("claude-code"),
      probeId: "probe-claude-pending",
      verification: "pending",
    },
    {
      ...verifiedAgentProbe("codex"),
      probeId: "probe-browser-verified",
      capabilityId: "browser-automation",
    },
    {
      ...verifiedAgentProbe("codex"),
      probeId: "probe-docker-degraded",
      capabilityId: "docker",
      verification: "failed",
    },
    {
      ...verifiedAgentProbe("codex"),
      probeId: "probe-gpu-unavailable",
      capabilityId: "gpu-compute",
      installation: "absent",
      verification: "not-run",
    },
    {
      ...verifiedAgentProbe("codex"),
      probeId: "probe-camera-disabled",
      capabilityId: "camera",
      disabled: true,
    },
  ];

  const result = new DeviceDiscoveryService().discover({
    ...base,
    capabilityProbes: probes,
  });
  const states = Object.fromEntries(
    result.capabilities.map((capability) => [capability.capabilityId, capability.state]),
  );

  assert.deepEqual(states, {
    "browser-automation": "verified",
    camera: "disabled",
    "claude-code": "verification-pending",
    codex: "detected",
    "computer-use": "verification-pending",
    docker: "degraded",
    "gpu-compute": "unavailable",
  });
  assert.deepEqual(result.profilePatchProposals, []);
});

test("keeps a headless Linux NAS ready for Worker tasks while Computer Use is unavailable", () => {
  const base = discoveryInput("linux", "codex");
  const result = new DeviceDiscoveryService().discover({
    ...base,
    runtimeFacts: {
      ...base.runtimeFacts,
      userSession: {
        state: "headless",
        observedAt,
        source: "user-session-helper",
      },
    },
  });
  const computerUse = result.capabilities.find(
    (capability) => capability.capabilityId === "computer-use",
  );

  assert.equal(result.readiness.workerService.status, "ready");
  assert.equal(result.readiness.userSession.status, "unavailable");
  assert.equal(result.readiness.userSession.evidence[0]?.code, "USER_SESSION_HEADLESS");
  assert.equal(
    result.readiness.userSession.evidence[0]?.action,
    "Schedule only non-graphical Work Orders on this Device.",
  );
  assert.equal(computerUse?.state, "unavailable");
  assert.equal(
    result.capabilities.find((capability) => capability.capabilityId === "codex")?.state,
    "verified",
  );
  assert.deepEqual(result.profilePatchProposals, []);
});

test("turns missing, locked, and permission-denied desktops into actionable unavailable or degraded evidence", () => {
  const service = new DeviceDiscoveryService();
  const cases = [
    {
      state: "missing" as const,
      expectedStatus: "unavailable",
      expectedCapability: "unavailable",
      code: "USER_SESSION_MISSING",
    },
    {
      state: "locked" as const,
      expectedStatus: "degraded",
      expectedCapability: "degraded",
      code: "USER_SESSION_LOCKED",
    },
    {
      state: "permission-denied" as const,
      expectedStatus: "degraded",
      expectedCapability: "degraded",
      code: "USER_SESSION_PERMISSION_DENIED",
    },
  ];

  for (const item of cases) {
    const base = discoveryInput("win32", "claude-code");
    const result = service.discover({
      ...base,
      runtimeFacts: {
        ...base.runtimeFacts,
        userSession: {
          state: item.state,
          observedAt,
          source: "user-session-helper",
        },
      },
    });
    const computerUse = result.capabilities.find(
      (capability) => capability.capabilityId === "computer-use",
    );

    assert.equal(result.readiness.userSession.status, item.expectedStatus);
    assert.equal(result.readiness.userSession.evidence[0]?.code, item.code);
    assert.ok((result.readiness.userSession.evidence[0]?.action?.length ?? 0) > 0);
    assert.equal(computerUse?.state, item.expectedCapability);
    assert.ok(computerUse?.evidence.some((evidence) => (evidence.action?.length ?? 0) > 0));
    assert.deepEqual(result.profilePatchProposals, []);
  }
});

test("uses the newest evidence deterministically and does not resurrect stale verification", () => {
  const base = discoveryInput("darwin", "codex");
  const staleVerified: CapabilityProbe = {
    ...verifiedAgentProbe("codex"),
    probeId: "probe-codex-stale-verified",
    observedAt: observedAt - 1_000,
    version: "0.9.0",
  };
  const currentDetected: CapabilityProbe = {
    ...verifiedAgentProbe("codex"),
    probeId: "probe-codex-current-detected",
    observedAt: observedAt + 1_000,
    verification: "not-run",
    version: "1.0.0",
  };
  const service = new DeviceDiscoveryService();

  const forward = service.discover({
    ...base,
    capabilityProbes: [staleVerified, currentDetected],
  });
  const reverse = service.discover({
    ...base,
    capabilityProbes: [currentDetected, staleVerified],
  });
  const codex = forward.capabilities.find((capability) => capability.capabilityId === "codex");

  assert.deepEqual(forward, reverse);
  assert.equal(codex?.state, "detected");
  assert.deepEqual(codex?.evidence, [
    {
      evidenceId: "probe-codex-current-detected",
      source: "agent-adapter",
      observedAt: observedAt + 1_000,
      code: "CAPABILITY_INSTALLED_UNVERIFIED",
      message: "The capability is installed but has not passed smoke verification.",
      version: "1.0.0",
    },
  ]);
  assert.equal(
    forward.capabilities.find((capability) => capability.capabilityId === "computer-use")?.state,
    "verification-pending",
  );
});

test("deep-freezes discovery output and never copies Secret values or Knowledge metadata", () => {
  const base = discoveryInput("win32", "claude-code");
  const taintedInput = {
    ...base,
    runtimeFacts: {
      ...base.runtimeFacts,
      secretValue: "runtime-super-secret",
      knowledgeMetadata: {
        filename: "private-device-note.md",
        title: "Private Knowledge title",
        snippet: "Private Knowledge snippet",
      },
    },
    capabilityProbes: [
      {
        ...verifiedAgentProbe("claude-code"),
        secretValue: "adapter-super-secret",
        knowledgeTitle: "Agent-local Knowledge",
      },
    ],
  };

  const result = new DeviceDiscoveryService().discover(taintedInput);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.facts), true);
  assert.equal(Object.isFrozen(result.capabilities), true);
  assert.equal(Object.isFrozen(result.capabilities[0]), true);
  assert.equal(Object.isFrozen(result.capabilities[0]?.evidence), true);
  assert.equal(Object.isFrozen(result.readiness), true);
  assert.equal(Object.isFrozen(result.profilePatchProposals), true);
  assert.equal(Object.isFrozen(result.profilePatchProposals[0]?.operations), true);
  assert.throws(() => {
    (result.facts as { hostname: string }).hostname = "mutated";
  }, TypeError);

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "secretValue",
    "runtime-super-secret",
    "adapter-super-secret",
    "knowledgeMetadata",
    "private-device-note.md",
    "Private Knowledge title",
    "Private Knowledge snippet",
    "knowledgeTitle",
    "Agent-local Knowledge",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("keeps an explicitly disabled Computer Use capability disabled despite ready components", () => {
  const base = discoveryInput("macos", "codex");
  const disabledComputerUse: CapabilityProbe = {
    probeId: "probe-computer-use-disabled",
    capabilityId: "computer-use",
    source: "capability-probe",
    observedAt: observedAt + 1,
    installation: "present",
    verification: "passed",
    disabled: true,
  };

  const result = new DeviceDiscoveryService().discover({
    ...base,
    capabilityProbes: [...base.capabilityProbes, disabledComputerUse],
  });
  const computerUse = result.capabilities.find(
    (capability) => capability.capabilityId === "computer-use",
  );

  assert.equal(computerUse?.state, "disabled");
  assert.equal(computerUse?.evidence[0]?.code, "CAPABILITY_DISABLED");
  assert.deepEqual(result.profilePatchProposals, []);
});

test("never promotes Computer Use without its own current smoke-verification probe", () => {
  const base = discoveryInput("macos", "codex");
  const service = new DeviceDiscoveryService();
  const cases = [
    {
      label: "missing",
      probes: [verifiedAgentProbe("codex")],
      expectedState: "verification-pending",
      expectedCode: "COMPUTER_USE_SMOKE_PROBE_MISSING",
    },
    {
      label: "not-run",
      probes: [verifiedAgentProbe("codex"), computerUseProbe("not-run")],
      expectedState: "detected",
      expectedCode: "CAPABILITY_INSTALLED_UNVERIFIED",
    },
    {
      label: "pending",
      probes: [verifiedAgentProbe("codex"), computerUseProbe("pending")],
      expectedState: "verification-pending",
      expectedCode: "CAPABILITY_VERIFICATION_PENDING",
    },
    {
      label: "failed",
      probes: [verifiedAgentProbe("codex"), computerUseProbe("failed")],
      expectedState: "degraded",
      expectedCode: "CAPABILITY_SMOKE_FAILED",
    },
  ] as const;

  for (const item of cases) {
    const result = service.discover({
      ...base,
      deviceId: `device-${item.label}`,
      capabilityProbes: item.probes,
    });
    const computerUse = result.capabilities.find(
      (capability) => capability.capabilityId === "computer-use",
    );

    assert.equal(computerUse?.state, item.expectedState);
    assert.ok(computerUse?.evidence.some((evidence) => evidence.code === item.expectedCode));
    assert.deepEqual(result.profilePatchProposals, []);
  }
});

test("a passed Computer Use probe still requires a verified Agent and ready user session", () => {
  const base = discoveryInput("win32", "claude-code");
  const service = new DeviceDiscoveryService();
  const unverifiedAgent = {
    ...verifiedAgentProbe("claude-code"),
    verification: "pending" as const,
  };
  const withoutVerifiedAgent = service.discover({
    ...base,
    capabilityProbes: [unverifiedAgent, computerUseProbe()],
  });
  const withoutReadySession = service.discover({
    ...base,
    runtimeFacts: {
      ...base.runtimeFacts,
      userSession: {
        state: "locked",
        observedAt,
        source: "user-session-helper",
      },
    },
  });

  assert.notEqual(
    withoutVerifiedAgent.capabilities.find(
      (capability) => capability.capabilityId === "computer-use",
    )?.state,
    "verified",
  );
  assert.notEqual(
    withoutReadySession.capabilities.find(
      (capability) => capability.capabilityId === "computer-use",
    )?.state,
    "verified",
  );
  assert.deepEqual(withoutVerifiedAgent.profilePatchProposals, []);
  assert.deepEqual(withoutReadySession.profilePatchProposals, []);
});
