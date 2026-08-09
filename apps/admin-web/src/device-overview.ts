import type { DeviceSummary } from "./admin-api";
import {
  builtInText,
  type CapabilityView,
  type DeviceOverviewViewModel,
  type RuntimeStatusView,
} from "./view-model";

const unassessedCapabilities = Object.freeze([
  {
    capabilityId: "codex",
    label: "Codex",
    state: "not_assessed",
    tone: "muted",
  },
  {
    capabilityId: "claude-code",
    label: "Claude",
    state: "not_assessed",
    tone: "muted",
  },
  {
    capabilityId: "computer-use",
    label: "Computer Use",
    state: "not_assessed",
    tone: "muted",
  },
  {
    capabilityId: "browser-automation",
    label: builtInText("Browser automation", "browserAutomation"),
    state: "not_assessed",
    tone: "muted",
  },
] as const satisfies readonly CapabilityView[]);

export function mapDeviceOverview(device: DeviceSummary): DeviceOverviewViewModel {
  const operatingSystem = `${osFamilyLabel(device.osFamily)} ${device.platformRelease}`;
  const connectionOnline = device.connection === "online";
  const main = device.role === "main";

  return {
    deviceId: device.deviceId,
    name: device.name,
    osFamily: device.osFamily,
    role: device.role,
    roleLabel: main ? builtInText("Main", "main") : builtInText("Worker", "worker"),
    deviceTypeLabel: main
      ? builtInText("Main computer", "mainComputer")
      : builtInText("Worker computer", "workerComputer"),
    operatingSystem,
    connection: {
      label: connectionOnline ? builtInText("Online", "online") : builtInText("Offline", "offline"),
      tone: connectionOnline ? "success" : "muted",
    },
    facts: mapFacts(device, operatingSystem),
    runtimeStatuses: [
      runtimeStatus(device.runtime, device.role),
      serviceStatus(device.serviceMode),
    ],
    ...(device.lastObservation === undefined
      ? {}
      : {
          lastObservation: {
            observedAtMs: device.lastObservation.observedAtMs,
            acceptedAtMs: device.lastObservation.acceptedAtMs,
          },
        }),
    roles: device.roles ?? (main ? [builtInText("Main Coordinator", "mainCoordinator")] : []),
    instructions: device.instructions ?? [],
    capabilities: mapCapabilities(device.capabilities),
    policies: Object.freeze(
      [...(device.policies ?? [])].sort(
        (left, right) =>
          left.actionCategory.localeCompare(right.actionCategory, "en") ||
          left.policyId.localeCompare(right.policyId, "en"),
      ),
    ),
    agentAdapters: Object.freeze(
      [...(device.agentAdapters ?? [])]
        .sort(
          (left, right) =>
            left.provider.localeCompare(right.provider, "en") ||
            left.adapterId.localeCompare(right.adapterId, "en"),
        )
        .map((adapter) =>
          Object.freeze({
            provider: adapter.provider,
            adapterId: adapter.adapterId,
            ...(adapter.version === undefined ? {} : { version: adapter.version }),
            readiness: adapter.readiness,
            compatibility: adapter.compatibility,
            ...(adapter.blockedBy === undefined ? {} : { blockedBy: adapter.blockedBy }),
            ...(adapter.availableUpgrade === undefined
              ? {}
              : { availableUpgrade: Object.freeze({ ...adapter.availableUpgrade }) }),
            observedAtMs: adapter.observedAtMs,
            ...(adapter.modelCatalogObservedAtMs === undefined
              ? {}
              : { modelCatalogObservedAtMs: adapter.modelCatalogObservedAtMs }),
            models: Object.freeze(
              (adapter.models ?? []).map((model) =>
                Object.freeze({
                  modelId: model.modelId,
                  displayName: model.displayName,
                  isDefault: model.isDefault === true,
                  supportedEfforts: Object.freeze([...(model.supportedEfforts ?? [])]),
                }),
              ),
            ),
          }),
        ),
    ),
    agentExecutionProfile: cloneAgentExecutionProfile(device.agentExecutionProfile),
    ...(device.coordinatorAgentExecutionProfile === undefined
      ? {}
      : {
          coordinatorAgentExecutionProfile: cloneAgentExecutionProfile(
            device.coordinatorAgentExecutionProfile,
          ),
        }),
    ...(main
      ? {}
      : {
          wakeOnLan: Object.freeze(
            device.wakeOnLan === undefined
              ? {
                  targetState: "unknown" as const,
                  automaticWakeState: "unknown" as const,
                  historical: false,
                }
              : {
                  targetState: device.wakeOnLan.targetState,
                  automaticWakeState: device.wakeOnLan.automaticWakeState,
                  observedAtMs: device.wakeOnLan.observedAtMs,
                  historical: !connectionOnline,
                },
          ),
        }),
    routes: mapRoutes(device.routes, main),
    resourceLocks: Object.freeze(
      [...(device.resourceLocks ?? [])]
        .sort((left, right) => left.resourceName.localeCompare(right.resourceName, "en"))
        .map((lock) => ({
          ...lock,
          holders: Object.freeze(
            [...lock.holders].sort(
              (left, right) =>
                left.expiresAtMs - right.expiresAtMs || left.runId.localeCompare(right.runId, "en"),
            ),
          ),
        })),
    ),
    currentRuns: Object.freeze(
      [...(device.currentRuns ?? [])].sort(
        (left, right) =>
          left.acceptedAtMs - right.acceptedAtMs || left.runId.localeCompare(right.runId, "en"),
      ),
    ),
    currentWork: {
      activeRunCount: device.capacity?.activeRuns ?? 0,
      summary:
        device.capacity === undefined
          ? builtInText("Run projection not connected", "projectionDisconnected")
          : device.capacity.activeRuns === 0
            ? builtInText("No active runs", "noActiveRuns")
            : builtInText(`${device.capacity.activeRuns} active Runs`, "activeRunCount", {
                count: device.capacity.activeRuns,
              }),
      ...(device.capacity === undefined
        ? {}
        : {
            maximumConcurrentRuns: device.capacity.maximumConcurrentRuns,
            acceptingWork: device.capacity.acceptingWork,
            ...(device.capacity.outboxDepth === undefined
              ? {}
              : { outboxDepth: device.capacity.outboxDepth }),
            ...(device.capacity.maxOutboxEntries === undefined
              ? {}
              : { maxOutboxEntries: device.capacity.maxOutboxEntries }),
          }),
    },
    knowledge: knowledgeStatus(device.knowledgeHealth),
    configurationSession: {
      assistantMessage:
        device.lastObservation?.source === "local-assessment"
          ? builtInText(
              "Device assessment is current. I can now explain the observed Codex, Claude, browser automation, Computer Use, and local Knowledge status and help you propose Roles or Instructions. Provider credentials must stay out of messages.",
              "configurationAssessmentReadyIntro",
            )
          : builtInText(
              "Start with Assess device. I can then explain the observed Codex, Claude, browser automation, Computer Use, and local Knowledge status and help you propose Roles or Instructions. I cannot run the assessment from chat, and provider credentials must stay out of messages.",
              "configurationAssessmentIntro",
            ),
      proposal: null,
    },
  };
}

function cloneAgentExecutionProfile(
  profile: DeviceSummary["agentExecutionProfile"],
): DeviceOverviewViewModel["agentExecutionProfile"] {
  if (profile === undefined || profile.mode === "auto") {
    return { schemaVersion: 1, mode: "auto" };
  }
  const primary = { ...profile.primary };
  return profile.mode === "pinned"
    ? { schemaVersion: 1, mode: "pinned", primary }
    : {
        schemaVersion: 1,
        mode: "prefer",
        primary,
        fallbacks: profile.fallbacks.map((binding) => ({ ...binding })),
      };
}

function mapFacts(
  device: DeviceSummary,
  operatingSystem: string,
): DeviceOverviewViewModel["facts"] {
  if (device.facts === undefined || device.facts.length === 0) {
    return Object.freeze([
      {
        label: builtInText("Operating system", "operatingSystem"),
        value: operatingSystem,
      },
      { label: builtInText("Architecture", "architecture"), value: device.architecture },
    ]);
  }
  const labelByKind = {
    "os-family": builtInText("Operating system", "operatingSystem"),
    "platform-release": builtInText("Platform release", "platformRelease"),
    architecture: builtInText("Architecture", "architecture"),
    hostname: builtInText("Hostname", "hostname"),
    "cpu-model": builtInText("CPU model", "cpuModel"),
    "cpu-logical-cores": builtInText("Logical CPU cores", "logicalCpuCores"),
    "memory-total-bytes": builtInText("Total memory (bytes)", "totalMemoryBytes"),
    "gpu-model": builtInText("GPU model", "gpuModel"),
  } as const;
  const sourceByKind = {
    enrollment: builtInText("Enrollment", "enrollment"),
    "authenticated-heartbeat": builtInText("Authenticated heartbeat", "authenticatedHeartbeat"),
    "node-os": builtInText("Node OS probe", "nodeOsProbe"),
    "platform-probe": builtInText("Platform hardware probe", "platformHardwareProbe"),
  } as const;
  return Object.freeze(
    [...device.facts]
      .sort(
        (left, right) =>
          factOrder(left.kind) - factOrder(right.kind) ||
          left.value.localeCompare(right.value, "en"),
      )
      .map((fact) => ({
        label: labelByKind[fact.kind],
        value:
          fact.kind === "os-family"
            ? osFamilyLabel(fact.value as DeviceSummary["osFamily"])
            : fact.value,
        evidence: {
          source: sourceByKind[fact.source],
          observedAtMs: fact.observedAtMs,
          verification: fact.verification,
        },
      })),
  );
}

function factOrder(kind: NonNullable<DeviceSummary["facts"]>[number]["kind"]): number {
  switch (kind) {
    case "os-family":
      return 0;
    case "platform-release":
      return 1;
    case "architecture":
      return 2;
    case "hostname":
      return 3;
    case "cpu-model":
      return 4;
    case "cpu-logical-cores":
      return 5;
    case "memory-total-bytes":
      return 6;
    case "gpu-model":
      return 7;
  }
}

function mapCapabilities(reported: DeviceSummary["capabilities"]): readonly CapabilityView[] {
  if (reported === undefined || reported.length === 0) {
    return unassessedCapabilities;
  }
  const reportedByName = new Map(reported.map((capability) => [capability.name, capability]));
  const baseline = unassessedCapabilities.map((capability) => {
    const report = reportedByName.get(capability.capabilityId);
    if (report === undefined) {
      return capability;
    }
    reportedByName.delete(capability.capabilityId);
    return {
      ...capability,
      state: report.verification,
      tone: capabilityTone(report.verification),
      ...(report.blockedBy === undefined ? {} : { blockedBy: report.blockedBy }),
    } satisfies CapabilityView;
  });
  const additional = [...reportedByName.values()]
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map((capability): CapabilityView => ({
      capabilityId: capability.name,
      label: capability.name,
      state: capability.verification,
      tone: capabilityTone(capability.verification),
      ...(capability.blockedBy === undefined ? {} : { blockedBy: capability.blockedBy }),
    }));
  return Object.freeze([...baseline, ...additional]);
}

function capabilityTone(
  verification: NonNullable<DeviceSummary["capabilities"]>[number]["verification"],
): CapabilityView["tone"] {
  switch (verification) {
    case "verified":
      return "success";
    case "detected":
      return "accent";
    case "degraded":
      return "warning";
    case "unavailable":
      return "danger";
    case "disabled":
      return "muted";
  }
}

function mapRoutes(
  reported: DeviceSummary["routes"],
  main: boolean,
): DeviceOverviewViewModel["routes"] {
  if (reported === undefined) {
    return main
      ? [
          {
            order: 1,
            label: builtInText("Loopback", "loopback"),
            summary: builtInText("Active · Main-local", "activeMainLocal"),
            tone: "success",
          },
        ]
      : [];
  }
  return Object.freeze(
    [...reported]
      .sort(
        (left, right) =>
          left.priority - right.priority || left.routeId.localeCompare(right.routeId, "en"),
      )
      .map((route, index) => ({
        order: index + 1,
        label: route.label,
        summary:
          route.health === "healthy"
            ? builtInText(`Healthy · Priority ${route.priority + 1}`, "healthyPriority", {
                priority: route.priority + 1,
              })
            : route.health === "degraded"
              ? builtInText(`Degraded · Priority ${route.priority + 1}`, "degradedPriority", {
                  priority: route.priority + 1,
                })
              : route.health === "unknown"
                ? builtInText(`Unknown · Priority ${route.priority + 1}`, "unknownPriority", {
                    priority: route.priority + 1,
                  })
                : builtInText(`Unhealthy · Priority ${route.priority + 1}`, "unhealthyPriority", {
                    priority: route.priority + 1,
                  }),
        tone:
          route.health === "healthy"
            ? ("success" as const)
            : route.health === "degraded"
              ? ("warning" as const)
              : route.health === "unknown"
                ? ("muted" as const)
                : ("danger" as const),
        ...(route.kind === undefined &&
        route.profileRevision === undefined &&
        route.lastAttempt === undefined
          ? {}
          : {
              detail: [
                route.kind?.toUpperCase(),
                route.lastAttempt?.outcome,
                route.profileRevision?.slice(0, 15),
              ]
                .filter((value): value is string => value !== undefined)
                .join(" · "),
            }),
      })),
  );
}

function knowledgeStatus(
  health: DeviceSummary["knowledgeHealth"],
): DeviceOverviewViewModel["knowledge"] {
  const label = builtInText("Local Knowledge", "localKnowledge");
  switch (health) {
    case "healthy":
      return { label, status: builtInText("Healthy", "healthy"), tone: "success" };
    case "degraded":
      return { label, status: builtInText("Degraded", "degraded"), tone: "warning" };
    case "unavailable":
      return { label, status: builtInText("Unavailable", "unavailable"), tone: "danger" };
    case "unknown":
    case undefined:
      return { label, status: builtInText("Not assessed", "notAssessed"), tone: "muted" };
  }
}

function osFamilyLabel(osFamily: DeviceSummary["osFamily"] | string): string {
  switch (osFamily) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return osFamily;
  }
}

function runtimeStatus(
  runtime: DeviceSummary["runtime"],
  role: DeviceSummary["role"],
): RuntimeStatusView {
  const label =
    role === "main"
      ? builtInText("Main runtime", "mainRuntime")
      : builtInText("Worker service", "workerService");

  switch (runtime) {
    case "healthy":
      return {
        label,
        value: builtInText("Healthy", "healthy"),
        tone: "success",
      };
    case "degraded":
      return {
        label,
        value: builtInText("Degraded", "degraded"),
        tone: "warning",
      };
    case "unavailable":
      return {
        label,
        value: builtInText("Unavailable", "unavailable"),
        tone: "danger",
      };
  }
}

function serviceStatus(serviceMode: DeviceSummary["serviceMode"]): RuntimeStatusView {
  switch (serviceMode) {
    case "foreground":
      return {
        label: builtInText("Service supervision", "serviceSupervision"),
        value: builtInText("Not configured (foreground)", "foreground"),
        tone: "muted",
      };
    case "system-service":
      return {
        label: builtInText("Service supervision", "serviceSupervision"),
        value: builtInText("Configured (system service)", "systemService"),
        tone: "success",
      };
    case "user-service":
      return {
        label: builtInText("Service supervision", "serviceSupervision"),
        value: builtInText("Configured (user service)", "userService"),
        tone: "success",
      };
  }
}
