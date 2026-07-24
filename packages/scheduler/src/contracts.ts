export type OsFamily = "macos" | "windows" | "linux";

export type CapabilityVerification =
  "detected" | "verified" | "degraded" | "unavailable" | "disabled";

export interface DeviceCapability {
  readonly name: string;
  readonly verification: CapabilityVerification;
}

export interface TransportRoute {
  readonly routeId: string;
  readonly priority: number;
  readonly health: "healthy" | "unhealthy";
}

export type ExecutablePolicyOutcome = "allow" | "require-approval" | "deny";

export interface ExecutablePolicyDecision {
  readonly outcome: ExecutablePolicyOutcome;
  readonly code: string;
}

export interface DeviceCandidate {
  readonly deviceId: string;
  readonly enabled: boolean;
  readonly status: "online" | "offline";
  readonly draining: boolean;
  readonly osFamily: OsFamily;
  readonly capabilities: readonly DeviceCapability[];
  readonly roles: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly transports: readonly TransportRoute[];
  readonly availableRunSlots: number;
  readonly loadRatio: number;
  readonly desktopSessionAvailable: boolean;
  readonly executionPolicyDecision: ExecutablePolicyDecision;
  readonly availableSecretRefs: readonly string[];
}

export interface ScheduleRequest {
  readonly workOrderId: string;
  readonly requiredCapabilities: readonly string[];
  readonly preferredCapabilities: readonly string[];
  readonly preferredRoles: readonly string[];
  readonly requiredSecretRefs: readonly string[];
  readonly requiredOsFamily?: OsFamily;
  readonly workspaceId?: string;
}

export interface CandidateScore {
  readonly matchedRoles: readonly string[];
  readonly matchedPreferredCapabilities: readonly string[];
  readonly roleMatchCount: number;
  readonly preferredCapabilityMatchCount: number;
  readonly loadRatio: number;
  readonly routePriority: number;
  readonly routeId: string;
}

export type CandidateExclusion =
  | {
      readonly code: "DEVICE_SNAPSHOT_INVALID";
      readonly fields: readonly string[];
    }
  | { readonly code: "DEVICE_DISABLED" }
  | { readonly code: "DEVICE_OFFLINE" }
  | { readonly code: "DEVICE_DRAINING" }
  | {
      readonly code: "POLICY_EXECUTION_NOT_ALLOWED";
      readonly outcome: Exclude<ExecutablePolicyOutcome, "allow">;
      readonly policyCode: string;
    }
  | {
      readonly code: "OS_FAMILY_MISMATCH";
      readonly required: OsFamily;
      readonly actual: OsFamily;
    }
  | {
      readonly code: "REQUIRED_CAPABILITY_NOT_VERIFIED";
      readonly capabilities: readonly string[];
    }
  | {
      readonly code: "REQUIRED_SECRET_UNAVAILABLE";
      readonly secretRefs: readonly string[];
    }
  | {
      readonly code: "WORKSPACE_UNAVAILABLE";
      readonly workspaceId: string;
    }
  | { readonly code: "TRANSPORT_UNHEALTHY" }
  | { readonly code: "CAPACITY_UNAVAILABLE" }
  | { readonly code: "DESKTOP_SESSION_UNAVAILABLE" };

export interface CandidateExplanation {
  readonly deviceId: string;
  readonly eligible: boolean;
  readonly exclusions: readonly CandidateExclusion[];
  readonly score: CandidateScore | null;
}

export interface ScheduleSelection {
  readonly selectedDevice: DeviceCandidate;
  readonly selectedRoute: TransportRoute;
  readonly explanations: readonly CandidateExplanation[];
}
