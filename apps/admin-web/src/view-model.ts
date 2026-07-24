import type { KnownTextKey } from "./i18n/types";

export type StatusTone = "success" | "accent" | "muted" | "warning" | "danger";

export type PresentationText =
  | string
  | {
      readonly fallback: string;
      readonly messageKey: KnownTextKey;
    };

export interface DeviceFact {
  readonly label: PresentationText;
  readonly value: PresentationText;
}

export interface RuntimeStatusView {
  readonly label: PresentationText;
  readonly value: PresentationText;
  readonly tone: StatusTone;
}

export type CanonicalCapabilityId = "codex" | "claude-code" | "computer-use" | "browser-automation";
export type CapabilityState =
  "verified" | "detected" | "ready" | "degraded" | "unavailable" | "disabled" | "not_assessed";

export interface CapabilityView {
  readonly capabilityId: CanonicalCapabilityId;
  readonly label: PresentationText;
  readonly state: CapabilityState;
  readonly tone: StatusTone;
}

export interface RouteView {
  readonly order: number;
  readonly label: PresentationText;
  readonly summary: PresentationText;
  readonly tone: StatusTone;
}

export interface ConfigurationProposalView {
  readonly role: {
    readonly actionLabel: PresentationText;
    readonly label: PresentationText;
  };
  readonly capability: {
    readonly actionLabel: PresentationText;
    readonly capabilityId: CanonicalCapabilityId;
    readonly fromState: CapabilityView["state"];
    readonly label: PresentationText;
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
  readonly roleLabel: PresentationText;
  readonly deviceTypeLabel: PresentationText;
  readonly operatingSystem: string;
  readonly connection: {
    readonly label: PresentationText;
    readonly tone: StatusTone;
  };
  readonly facts: readonly DeviceFact[];
  readonly runtimeStatuses: readonly RuntimeStatusView[];
  readonly roles: readonly PresentationText[];
  readonly capabilities: readonly CapabilityView[];
  readonly routes: readonly RouteView[];
  readonly currentWork: {
    readonly activeRunCount: number;
    readonly summary: PresentationText;
  };
  readonly knowledge: {
    readonly label: PresentationText;
    readonly status: PresentationText;
    readonly tone: StatusTone;
  };
  readonly configurationSession: ConfigurationSessionView;
}

export const firstRunDevice = deepFreeze({
  deviceId: "device-main-mac-studio",
  name: "Mac Studio",
  roleLabel: builtInText("Main", "main"),
  deviceTypeLabel: builtInText("Main computer", "mainComputer"),
  operatingSystem: "macOS",
  connection: {
    label: builtInText("Online", "online"),
    tone: "success",
  },
  facts: [
    { label: builtInText("Operating system", "operatingSystem"), value: "macOS" },
    { label: builtInText("Architecture", "architecture"), value: "Apple silicon" },
  ],
  runtimeStatuses: [
    {
      label: builtInText("Worker service", "workerService"),
      value: builtInText("Healthy", "healthy"),
      tone: "success",
    },
    {
      label: builtInText("User session", "userSession"),
      value: builtInText("Ready", "ready"),
      tone: "success",
    },
  ],
  roles: [
    builtInText("Main Coordinator", "mainCoordinator"),
    builtInText("Development", "development"),
  ],
  capabilities: [
    {
      capabilityId: "codex",
      label: "Codex",
      state: "verified",
      tone: "success",
    },
    {
      capabilityId: "claude-code",
      label: "Claude",
      state: "detected",
      tone: "accent",
    },
    {
      capabilityId: "computer-use",
      label: "Computer Use",
      state: "detected",
      tone: "accent",
    },
    {
      capabilityId: "browser-automation",
      label: builtInText("Browser automation", "browserAutomation"),
      state: "verified",
      tone: "success",
    },
  ],
  routes: [
    {
      order: 1,
      label: builtInText("Local network", "localNetwork"),
      summary: builtInText("Healthy · Priority 1", "healthyPriorityOne"),
      tone: "success",
    },
    {
      order: 2,
      label: "Tailscale",
      summary: builtInText("Not configured · Priority 2", "unconfiguredPriorityTwo"),
      tone: "muted",
    },
  ],
  currentWork: {
    activeRunCount: 0,
    summary: builtInText("No active runs", "noActiveRuns"),
  },
  knowledge: {
    label: builtInText("Local Knowledge", "localKnowledge"),
    status: builtInText("Ready", "ready"),
    tone: "success",
  },
  configurationSession: {
    assistantMessage:
      "Codex and this desktop session are ready. I can verify Computer Use and propose it as a role for this Device.",
    proposal: {
      role: {
        actionLabel: builtInText("Add role", "addRole"),
        label: "Computer Use",
      },
      capability: {
        actionLabel: builtInText("Verify capability", "verifyCapability"),
        capabilityId: "computer-use",
        fromState: "detected",
        label: "Computer Use",
        toState: "verified",
      },
    },
  },
}) satisfies DeviceOverviewViewModel;

export function builtInText(fallback: string, messageKey: KnownTextKey): PresentationText {
  return Object.freeze({ fallback, messageKey });
}

export function presentationTextFallback(value: PresentationText): string {
  return typeof value === "string" ? value : value.fallback;
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value);
}
