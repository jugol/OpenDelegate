import type { DeviceSummary } from "./admin-api";
import type { CapabilityView, DeviceOverviewViewModel, RuntimeStatusView } from "./view-model";

const unassessedCapabilities = Object.freeze([
  {
    capabilityId: "codex",
    label: "Codex",
    state: "Not assessed",
    tone: "muted",
  },
  {
    capabilityId: "claude-code",
    label: "Claude",
    state: "Not assessed",
    tone: "muted",
  },
  {
    capabilityId: "computer-use",
    label: "Computer Use",
    state: "Not assessed",
    tone: "muted",
  },
  {
    capabilityId: "browser-automation",
    label: "Browser automation",
    state: "Not assessed",
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
    roleLabel: "Main",
    deviceTypeLabel: "Main computer",
    operatingSystem,
    connection: {
      label: connectionOnline ? "Online" : "Offline",
      tone: connectionOnline ? "success" : "muted",
    },
    facts: [
      { label: "Operating system", value: operatingSystem },
      { label: "Architecture", value: device.architecture },
    ],
    runtimeStatuses: [runtimeStatus(device.runtime), serviceStatus(device.serviceMode)],
    roles: ["Main Coordinator"],
    capabilities: unassessedCapabilities,
    routes: [
      {
        order: 1,
        label: "Loopback",
        summary: "Active · Main-local",
        tone: "success",
      },
    ],
    currentWork: {
      activeRunCount: 0,
      summary: "Run projection not connected",
    },
    knowledge: {
      label: "Local Knowledge",
      status: "Not assessed",
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
      return { label: "Main runtime", value: "Healthy", tone: "success" };
    case "degraded":
      return { label: "Main runtime", value: "Degraded", tone: "warning" };
    case "unavailable":
      return { label: "Main runtime", value: "Unavailable", tone: "danger" };
  }
}

function serviceStatus(serviceMode: DeviceSummary["serviceMode"]): RuntimeStatusView {
  switch (serviceMode) {
    case "foreground":
      return {
        label: "Service supervision",
        value: "Not configured (foreground)",
        tone: "muted",
      };
    case "system-service":
      return {
        label: "Service supervision",
        value: "Configured (system service)",
        tone: "success",
      };
    case "user-service":
      return {
        label: "Service supervision",
        value: "Configured (user service)",
        tone: "success",
      };
  }
}
