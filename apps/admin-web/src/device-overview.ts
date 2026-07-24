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

export function mapMainDeviceOverview(device: DeviceSummary): DeviceOverviewViewModel {
  if (device.role !== "main") {
    throw new Error("The current Admin Device must have the fixed Main role.");
  }

  const operatingSystem = `${osFamilyLabel(device.osFamily)} ${device.platformRelease}`;
  const connectionOnline = device.connection === "online";

  return {
    deviceId: device.deviceId,
    name: device.name,
    roleLabel: builtInText("Main", "main"),
    deviceTypeLabel: builtInText("Main computer", "mainComputer"),
    operatingSystem,
    connection: {
      label: connectionOnline ? builtInText("Online", "online") : builtInText("Offline", "offline"),
      tone: connectionOnline ? "success" : "muted",
    },
    facts: [
      {
        label: builtInText("Operating system", "operatingSystem"),
        value: operatingSystem,
      },
      { label: builtInText("Architecture", "architecture"), value: device.architecture },
    ],
    runtimeStatuses: [runtimeStatus(device.runtime), serviceStatus(device.serviceMode)],
    roles: [builtInText("Main Coordinator", "mainCoordinator")],
    capabilities: unassessedCapabilities,
    routes: [
      {
        order: 1,
        label: builtInText("Loopback", "loopback"),
        summary: builtInText("Active · Main-local", "activeMainLocal"),
        tone: "success",
      },
    ],
    currentWork: {
      activeRunCount: 0,
      summary: builtInText("Run projection not connected", "projectionDisconnected"),
    },
    knowledge: {
      label: builtInText("Local Knowledge", "localKnowledge"),
      status: builtInText("Not assessed", "notAssessed"),
      tone: "muted",
    },
    configurationSession: {
      assistantMessage:
        "I have not assessed this Device yet. Ask me to detect agent tools, browser automation, Computer Use readiness, or local Knowledge health before I propose changes.",
      proposal: null,
    },
  };
}

function osFamilyLabel(osFamily: DeviceSummary["osFamily"]): string {
  switch (osFamily) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
  }
}

function runtimeStatus(runtime: DeviceSummary["runtime"]): RuntimeStatusView {
  switch (runtime) {
    case "healthy":
      return {
        label: builtInText("Main runtime", "mainRuntime"),
        value: builtInText("Healthy", "healthy"),
        tone: "success",
      };
    case "degraded":
      return {
        label: builtInText("Main runtime", "mainRuntime"),
        value: builtInText("Degraded", "degraded"),
        tone: "warning",
      };
    case "unavailable":
      return {
        label: builtInText("Main runtime", "mainRuntime"),
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
