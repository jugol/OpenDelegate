export interface DeviceFact {
  readonly label: string;
  readonly value: string;
  readonly state?: "success";
}

export interface CapabilityView {
  readonly capabilityId: "codex" | "claude" | "computer-use" | "browser";
  readonly label: string;
  readonly state: "Verified" | "Detected" | "Ready";
  readonly tone: "success" | "accent";
}

export interface RouteView {
  readonly order: number;
  readonly label: string;
  readonly summary: string;
  readonly tone: "success" | "muted";
}

export interface DeviceOverviewViewModel {
  readonly name: string;
  readonly navigationSummary: string;
  readonly headerSummary: string;
  readonly facts: readonly DeviceFact[];
  readonly roles: readonly string[];
  readonly capabilities: readonly CapabilityView[];
  readonly routes: readonly RouteView[];
  readonly activeRunCount: number;
  readonly knowledge: {
    readonly status: "Ready";
  };
}

export const firstRunDevice = deepFreeze({
  name: "Mac Studio",
  navigationSummary: "Main · Online",
  headerSummary: "Main computer · macOS · Online",
  facts: [
    { label: "Operating system", value: "macOS" },
    { label: "Architecture", value: "Apple silicon" },
    { label: "Worker service", value: "Healthy", state: "success" },
    { label: "User session", value: "Ready", state: "success" },
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
      capabilityId: "claude",
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
      capabilityId: "browser",
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
  activeRunCount: 0,
  knowledge: {
    status: "Ready",
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
