import type {
  CapabilityObservation,
  CapabilityProbe,
  CapabilityState,
  DeviceProfilePatchProposal,
  DeviceReadiness,
  DiscoveryEvidence,
  DiscoveryInput,
  DiscoveryResult,
  OsFamily,
  ReadinessObservation,
  UserSessionRuntimeFact,
  WorkerServiceRuntimeFact,
} from "./contracts.ts";

export class DeviceDiscoveryService {
  public discover(input: DiscoveryInput): DiscoveryResult {
    const osFamily = normalizeOsFamily(input.runtimeFacts.platform);
    const latestProbes = selectLatestProbes(input.capabilityProbes);
    const observedCapabilities = latestProbes
      .filter((probe) => probe.capabilityId !== "computer-use")
      .map(observeCapability);
    const agentCapabilities = observedCapabilities.filter(
      (capability) =>
        capability.capabilityId === "codex" || capability.capabilityId === "claude-code",
    );
    const readiness = observeReadiness(input);
    const computerUseProbe = latestProbes.find((probe) => probe.capabilityId === "computer-use");
    const computerUse =
      computerUseProbe?.disabled === true
        ? observeCapability(computerUseProbe)
        : observeComputerUse(
            input.deviceId,
            agentCapabilities,
            readiness.userSession,
            computerUseProbe,
          );
    const capabilities = [...observedCapabilities, computerUse].sort((left, right) =>
      compareStableString(left.capabilityId, right.capabilityId),
    );
    const proposals = proposeProfilePatches(input.deviceId, agentCapabilities, computerUse);

    return deepFreeze({
      facts: {
        deviceId: input.deviceId,
        osFamily,
        architecture: input.runtimeFacts.architecture,
        hostname: input.runtimeFacts.hostname,
        observedAt: input.runtimeFacts.observedAt,
      },
      capabilities,
      readiness,
      profilePatchProposals: proposals,
    });
  }
}

function normalizeOsFamily(platform: string): OsFamily {
  switch (platform.toLocaleLowerCase("en-US")) {
    case "macos":
    case "darwin":
      return "macos";
    case "windows":
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported Device platform: ${platform}`);
  }
}

function selectLatestProbes(probes: readonly CapabilityProbe[]): readonly CapabilityProbe[] {
  const selected = new Map<string, CapabilityProbe>();

  for (const probe of probes) {
    const current = selected.get(probe.capabilityId);

    if (
      current === undefined ||
      probe.observedAt > current.observedAt ||
      (probe.observedAt === current.observedAt &&
        compareStableString(probe.probeId, current.probeId) < 0)
    ) {
      selected.set(probe.capabilityId, probe);
    }
  }

  return [...selected.values()].sort((left, right) =>
    compareStableString(left.capabilityId, right.capabilityId),
  );
}

function observeCapability(probe: CapabilityProbe): CapabilityObservation {
  const state = capabilityState(probe);
  const evidence = capabilityEvidence(probe, state);

  return {
    capabilityId: probe.capabilityId,
    state,
    observedAt: probe.observedAt,
    evidence: [evidence],
  };
}

function capabilityState(probe: CapabilityProbe): CapabilityState {
  if (probe.disabled) {
    return "disabled";
  }

  if (probe.installation === "absent") {
    return "unavailable";
  }

  switch (probe.verification) {
    case "not-run":
      return "detected";
    case "pending":
      return "verification-pending";
    case "passed":
      return "verified";
    case "failed":
      return "degraded";
  }
}

function capabilityEvidence(probe: CapabilityProbe, state: CapabilityState): DiscoveryEvidence {
  const descriptions: Record<CapabilityState, { readonly code: string; readonly message: string }> =
    {
      detected: {
        code: "CAPABILITY_INSTALLED_UNVERIFIED",
        message: "The capability is installed but has not passed smoke verification.",
      },
      "verification-pending": {
        code: "CAPABILITY_VERIFICATION_PENDING",
        message: "Capability smoke verification is pending.",
      },
      verified: {
        code: "CAPABILITY_SMOKE_VERIFIED",
        message: "The capability passed smoke verification.",
      },
      degraded: {
        code: "CAPABILITY_SMOKE_FAILED",
        message: "The installed capability failed smoke verification.",
      },
      unavailable: {
        code: "CAPABILITY_NOT_INSTALLED",
        message: "The capability is not installed.",
      },
      disabled: {
        code: "CAPABILITY_DISABLED",
        message: "The capability is administratively disabled.",
      },
    };
  const description = descriptions[state];

  return {
    evidenceId: probe.probeId,
    source: probe.source,
    observedAt: probe.observedAt,
    code: description.code,
    message: description.message,
    ...(probe.version === undefined ? {} : { version: probe.version }),
  };
}

function observeReadiness(input: DiscoveryInput): DeviceReadiness {
  return {
    workerService: observeWorkerService(input.deviceId, input.runtimeFacts.workerService),
    userSession: observeUserSession(input.deviceId, input.runtimeFacts.userSession),
  };
}

function observeWorkerService(
  deviceId: string,
  fact: WorkerServiceRuntimeFact,
): ReadinessObservation {
  const byState: Record<
    WorkerServiceRuntimeFact["state"],
    {
      readonly status: ReadinessObservation["status"];
      readonly code: string;
      readonly message: string;
      readonly action?: string;
    }
  > = {
    running: {
      status: "ready",
      code: "WORKER_SERVICE_RUNNING",
      message: "The always-on Worker service is running.",
    },
    degraded: {
      status: "degraded",
      code: "WORKER_SERVICE_DEGRADED",
      message: "The always-on Worker service reports degraded health.",
      action: "Inspect and restart the OpenDelegate Worker service.",
    },
    stopped: {
      status: "unavailable",
      code: "WORKER_SERVICE_STOPPED",
      message: "The always-on Worker service is stopped.",
      action: "Start the OpenDelegate Worker service.",
    },
  };
  const observation = byState[fact.state];

  return {
    status: observation.status,
    observedAt: fact.observedAt,
    evidence: [
      {
        evidenceId: `runtime-${deviceId}-worker-service`,
        source: fact.source,
        observedAt: fact.observedAt,
        code: observation.code,
        message: observation.message,
        ...(observation.action === undefined ? {} : { action: observation.action }),
      },
    ],
  };
}

function observeUserSession(deviceId: string, fact: UserSessionRuntimeFact): ReadinessObservation {
  const byState: Record<
    UserSessionRuntimeFact["state"],
    {
      readonly status: ReadinessObservation["status"];
      readonly code: string;
      readonly message: string;
      readonly action?: string;
    }
  > = {
    ready: {
      status: "ready",
      code: "USER_SESSION_READY",
      message: "The graphical user-session helper is ready for desktop work.",
    },
    headless: {
      status: "unavailable",
      code: "USER_SESSION_HEADLESS",
      message: "This Device has no graphical user session.",
      action: "Schedule only non-graphical Work Orders on this Device.",
    },
    missing: {
      status: "unavailable",
      code: "USER_SESSION_MISSING",
      message: "No logged-in graphical user session is available.",
      action: "Log in to a graphical session and start the user-session helper.",
    },
    locked: {
      status: "degraded",
      code: "USER_SESSION_LOCKED",
      message: "The graphical user session is locked.",
      action: "Unlock the Device before starting Computer Use.",
    },
    "permission-denied": {
      status: "degraded",
      code: "USER_SESSION_PERMISSION_DENIED",
      message: "The user-session helper lacks required screen or input permissions.",
      action: "Grant the documented screen capture and accessibility permissions.",
    },
    "helper-stopped": {
      status: "unavailable",
      code: "USER_SESSION_HELPER_STOPPED",
      message: "The graphical user-session helper is stopped.",
      action: "Start the OpenDelegate user-session helper.",
    },
  };
  const observation = byState[fact.state];

  return {
    status: observation.status,
    observedAt: fact.observedAt,
    evidence: [
      {
        evidenceId: `runtime-${deviceId}-user-session`,
        source: fact.source,
        observedAt: fact.observedAt,
        code: observation.code,
        message: observation.message,
        ...(observation.action === undefined ? {} : { action: observation.action }),
      },
    ],
  };
}

function observeComputerUse(
  deviceId: string,
  agentCapabilities: readonly CapabilityObservation[],
  userSession: ReadinessObservation,
  smokeProbe: CapabilityProbe | undefined,
): CapabilityObservation {
  const verifiedAgent = agentCapabilities.find((capability) => capability.state === "verified");
  const latestAgentObservation = agentCapabilities.reduce(
    (latest, capability) => Math.max(latest, capability.observedAt),
    0,
  );
  const observedAt = Math.max(
    latestAgentObservation,
    userSession.observedAt,
    smokeProbe?.observedAt ?? 0,
  );
  let state: CapabilityState;
  let code: string;
  let message: string;

  if (userSession.status !== "ready") {
    state = userSession.status === "degraded" ? "degraded" : "unavailable";
    code = "COMPUTER_USE_DESKTOP_NOT_READY";
    message = "Computer Use is unavailable until the graphical user session is ready.";
  } else if (smokeProbe === undefined) {
    state = "verification-pending";
    code = "COMPUTER_USE_SMOKE_PROBE_MISSING";
    message = "Computer Use requires its own successful observation-and-input smoke probe.";
  } else if (capabilityState(smokeProbe) !== "verified") {
    state = capabilityState(smokeProbe);
    code = "COMPUTER_USE_SMOKE_NOT_VERIFIED";
    message = "Computer Use remains unavailable until its explicit smoke probe is verified.";
  } else if (verifiedAgent === undefined) {
    state = agentCapabilities.length > 0 ? "verification-pending" : "unavailable";
    code = "COMPUTER_USE_AGENT_NOT_VERIFIED";
    message = "Computer Use requires a smoke-verified local Agent capability.";
  } else {
    state = "verified";
    code = "COMPUTER_USE_VERIFIED";
    message =
      "An explicit Computer Use smoke probe, a verified Agent, and a ready graphical helper support Computer Use.";
  }

  const probeEvidence =
    smokeProbe === undefined ? [] : [capabilityEvidence(smokeProbe, capabilityState(smokeProbe))];

  return {
    capabilityId: "computer-use",
    state,
    observedAt,
    evidence: [
      ...probeEvidence,
      {
        evidenceId: `derived-${deviceId}-computer-use`,
        source: "device-discovery",
        observedAt,
        code,
        message,
        ...(userSession.evidence[0]?.action === undefined
          ? {}
          : { action: userSession.evidence[0].action }),
      },
    ],
  };
}

function proposeProfilePatches(
  deviceId: string,
  agentCapabilities: readonly CapabilityObservation[],
  computerUse: CapabilityObservation,
): readonly DeviceProfilePatchProposal[] {
  if (computerUse.state !== "verified") {
    return [];
  }

  const verifiedAgent = agentCapabilities.find((capability) => capability.state === "verified");

  if (verifiedAgent === undefined) {
    return [];
  }

  return [
    {
      proposalId: `proposal-${deviceId}-computer-use`,
      targetDeviceId: deviceId,
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
      evidenceCapabilityIds: [verifiedAgent.capabilityId, "computer-use"],
    },
  ];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }

    Object.freeze(value);
  }

  return value;
}

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
