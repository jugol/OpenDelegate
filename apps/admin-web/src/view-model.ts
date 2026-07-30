import type { KnownTextKey } from "./i18n/types";

export type StatusTone = "success" | "accent" | "muted" | "warning" | "danger";

export type PresentationText =
  | string
  | {
      readonly fallback: string;
      readonly messageKey: KnownTextKey;
      readonly values?: Readonly<Record<string, string | number>>;
    };

export interface DeviceFact {
  readonly label: PresentationText;
  readonly value: PresentationText;
  readonly evidence?: {
    readonly source: PresentationText;
    readonly observedAtMs: number;
    readonly verification: "observed" | "verified";
  };
}

export interface RuntimeStatusView {
  readonly label: PresentationText;
  readonly value: PresentationText;
  readonly tone: StatusTone;
}

export type CanonicalCapabilityId = string;
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
  readonly detail?: string;
}

export interface WakeOnLanView {
  readonly targetState: "enabled" | "disabled" | "unsupported" | "unknown";
  readonly automaticWakeState: "relay-required" | "unavailable" | "unknown";
  readonly observedAtMs?: number;
  readonly historical: boolean;
}

export interface DevicePolicyView {
  readonly policyId: string;
  readonly actionCategory: string;
  readonly decision: "allow" | "require-approval" | "deny";
  readonly source: "built-in" | "configuration";
  readonly effectiveScope: "instance" | "main" | "device";
}

export interface AgentAdapterView {
  readonly provider: "codex" | "claude" | "generic-command";
  readonly adapterId: string;
  readonly version?: string;
  readonly readiness: "ready" | "degraded" | "unavailable";
  readonly compatibility: "tested" | "compatible" | "untested" | "incompatible";
  readonly observedAtMs: number;
  readonly modelCatalogObservedAtMs?: number;
  readonly models: readonly {
    readonly modelId: string;
    readonly displayName: string;
    readonly isDefault: boolean;
    readonly supportedEfforts: readonly string[];
  }[];
}

export interface AgentBindingView {
  readonly provider: "codex" | "claude" | "generic";
  readonly adapterId: string;
  readonly modelId?: string;
  /** Present only when the selected model advertises an effort catalog. */
  readonly effort?: string;
}

export type AgentExecutionProfileView =
  | { readonly schemaVersion: 1; readonly mode: "auto" }
  | {
      readonly schemaVersion: 1;
      readonly mode: "prefer";
      readonly primary: AgentBindingView;
      readonly fallbacks: readonly AgentBindingView[];
    }
  | {
      readonly schemaVersion: 1;
      readonly mode: "pinned";
      readonly primary: AgentBindingView;
    };

export interface ResourceLockView {
  readonly resourceName: string;
  readonly capacity: number;
  readonly holders: readonly {
    readonly taskId: string;
    readonly runId: string;
    readonly expiresAtMs: number;
  }[];
}

export interface CurrentRunView {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly state: "starting" | "running" | "cancelling";
  readonly acceptedAtMs: number;
  readonly leaseExpiresAtMs: number;
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
  readonly assistantMessage: PresentationText;
  readonly proposal: ConfigurationProposalView | null;
}

export interface DeviceOverviewViewModel {
  readonly deviceId: string;
  readonly name: string;
  readonly osFamily: "macos" | "windows" | "linux";
  readonly role: "main" | "worker";
  readonly roleLabel: PresentationText;
  readonly deviceTypeLabel: PresentationText;
  readonly operatingSystem: string;
  readonly connection: {
    readonly label: PresentationText;
    readonly tone: StatusTone;
  };
  readonly facts: readonly DeviceFact[];
  readonly runtimeStatuses: readonly RuntimeStatusView[];
  readonly lastObservation?: {
    readonly observedAtMs: number;
    readonly acceptedAtMs: number;
  };
  readonly roles: readonly PresentationText[];
  readonly instructions: readonly PresentationText[];
  readonly capabilities: readonly CapabilityView[];
  readonly policies: readonly DevicePolicyView[];
  readonly agentAdapters: readonly AgentAdapterView[];
  readonly agentExecutionProfile: AgentExecutionProfileView;
  readonly coordinatorAgentExecutionProfile?: AgentExecutionProfileView;
  readonly wakeOnLan?: WakeOnLanView;
  readonly routes: readonly RouteView[];
  readonly resourceLocks: readonly ResourceLockView[];
  readonly currentRuns: readonly CurrentRunView[];
  readonly currentWork: {
    readonly activeRunCount: number;
    readonly summary: PresentationText;
    readonly maximumConcurrentRuns?: number;
    readonly acceptingWork?: boolean;
    readonly outboxDepth?: number;
    readonly maxOutboxEntries?: number;
  };
  readonly knowledge: {
    readonly label: PresentationText;
    readonly status: PresentationText;
    readonly tone: StatusTone;
  };
  readonly configurationSession: ConfigurationSessionView;
}

export interface DeviceFleetViewModel {
  readonly devices: readonly [DeviceOverviewViewModel, ...DeviceOverviewViewModel[]];
  readonly mainDeviceId: string;
}

export const firstRunDevice = deepFreeze({
  deviceId: "device-main-mac-studio",
  name: "Mac Studio",
  osFamily: "macos",
  role: "main",
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
  instructions: [],
  policies: [],
  agentAdapters: [],
  agentExecutionProfile: { schemaVersion: 1, mode: "auto" },
  coordinatorAgentExecutionProfile: { schemaVersion: 1, mode: "auto" },
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
  resourceLocks: [],
  currentRuns: [],
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

export function builtInText(
  fallback: string,
  messageKey: KnownTextKey,
  values?: Readonly<Record<string, string | number>>,
): PresentationText {
  return Object.freeze({
    fallback,
    messageKey,
    ...(values === undefined ? {} : { values: Object.freeze({ ...values }) }),
  });
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
