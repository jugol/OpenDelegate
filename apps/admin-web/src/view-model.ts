export type StatusTone = "success" | "accent" | "muted" | "warning" | "danger";

export interface DeviceFact {
  readonly label: string;
  readonly value: string;
}

export interface RuntimeStatusView {
  readonly label: string;
  readonly value: string;
  readonly tone: StatusTone;
}

export type CanonicalCapabilityId = "codex" | "claude-code" | "computer-use" | "browser-automation";

export interface CapabilityView {
  readonly capabilityId: CanonicalCapabilityId;
  readonly label: string;
  readonly state: "Verified" | "Detected" | "Ready" | "Degraded" | "Unavailable" | "Disabled";
  readonly tone: StatusTone;
}

export interface RouteView {
  readonly order: number;
  readonly label: string;
  readonly summary: string;
  readonly tone: StatusTone;
}

export interface ConfigurationProposalView {
  readonly role: {
    readonly actionLabel: string;
    readonly label: string;
  };
  readonly capability: {
    readonly actionLabel: string;
    readonly capabilityId: CanonicalCapabilityId;
    readonly fromState: CapabilityView["state"];
    readonly label: string;
    readonly toState: CapabilityView["state"];
  };
}

export interface ConfigurationSessionView {
  readonly assistantMessage: string;
  readonly proposal: ConfigurationProposalView | null;
}

export interface DeviceOverviewViewModel {
  readonly deviceId: string;
  readonly name: string;
  readonly roleLabel: string;
  readonly deviceTypeLabel: string;
  readonly operatingSystem: string;
  readonly connection: {
    readonly label: string;
    readonly tone: StatusTone;
  };
  readonly facts: readonly DeviceFact[];
  readonly runtimeStatuses: readonly RuntimeStatusView[];
  readonly roles: readonly string[];
  readonly capabilities: readonly CapabilityView[];
  readonly routes: readonly RouteView[];
  readonly currentWork: {
    readonly activeRunCount: number;
    readonly summary: string;
  };
  readonly knowledge: {
    readonly label: string;
    readonly status: string;
    readonly tone: StatusTone;
  };
  readonly configurationSession: ConfigurationSessionView;
}

export const firstRunDevice = deepFreeze({
  deviceId: "device-main-mac-studio",
  name: "Mac Studio",
  roleLabel: "Main",
  deviceTypeLabel: "Main computer",
  operatingSystem: "macOS",
  connection: {
    label: "Online",
    tone: "success",
  },
  facts: [
    { label: "Operating system", value: "macOS" },
    { label: "Architecture", value: "Apple silicon" },
  ],
  runtimeStatuses: [
    { label: "Worker service", value: "Healthy", tone: "success" },
    { label: "User session", value: "Ready", tone: "success" },
  ],
  roles: ["Main Coordinator", "Development"],
  capabilities: [
    {
      capabilityId: "codex",
      label: "Codex",
      state: "Verified",
      tone: "success",
    },
    {
      capabilityId: "claude-code",
      label: "Claude",
      state: "Detected",
      tone: "accent",
    },
    {
      capabilityId: "computer-use",
      label: "Computer Use",
      state: "Detected",
      tone: "accent",
    },
    {
      capabilityId: "browser-automation",
      label: "Browser automation",
      state: "Verified",
      tone: "success",
    },
  ],
  routes: [
    {
      order: 1,
      label: "Local network",
      summary: "Healthy · Priority 1",
      tone: "success",
    },
    {
      order: 2,
      label: "Tailscale",
      summary: "Not configured · Priority 2",
      tone: "muted",
    },
  ],
  currentWork: {
    activeRunCount: 0,
    summary: "No active runs",
  },
  knowledge: {
    label: "Local Knowledge",
    status: "Ready",
    tone: "success",
  },
  configurationSession: {
    assistantMessage:
      "Codex and this desktop session are ready. I can verify Computer Use and propose it as a role for this Device.",
    proposal: {
      role: {
        actionLabel: "Add role",
        label: "Computer Use",
      },
      capability: {
        actionLabel: "Verify capability",
        capabilityId: "computer-use",
        fromState: "Detected",
        label: "Computer Use",
        toState: "Verified",
      },
    },
  },
}) satisfies DeviceOverviewViewModel;

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value);
}
