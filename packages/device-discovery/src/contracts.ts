export type OsFamily = "macos" | "windows" | "linux";

export type CapabilityState =
  "detected" | "verification-pending" | "verified" | "degraded" | "unavailable" | "disabled";

export type EvidenceSource =
  | "agent-adapter"
  | "capability-probe"
  | "service-manager"
  | "user-session-helper"
  | "device-discovery";

export interface CapabilityProbe {
  readonly probeId: string;
  readonly capabilityId: string;
  readonly source: "agent-adapter" | "capability-probe";
  readonly observedAt: number;
  readonly installation: "present" | "absent";
  readonly verification: "not-run" | "pending" | "passed" | "failed";
  readonly version?: string;
  readonly disabled: boolean;
}

export interface WorkerServiceRuntimeFact {
  readonly state: "running" | "degraded" | "stopped";
  readonly observedAt: number;
  readonly source: "service-manager";
}

export interface UserSessionRuntimeFact {
  readonly state:
    "ready" | "headless" | "missing" | "locked" | "permission-denied" | "helper-stopped";
  readonly observedAt: number;
  readonly source: "user-session-helper";
}

export interface RuntimeFactsInput {
  readonly platform: string;
  readonly architecture: string;
  readonly hostname: string;
  readonly observedAt: number;
  readonly workerService: WorkerServiceRuntimeFact;
  readonly userSession: UserSessionRuntimeFact;
}

export interface DiscoveryInput {
  readonly deviceId: string;
  readonly runtimeFacts: RuntimeFactsInput;
  readonly capabilityProbes: readonly CapabilityProbe[];
}

export interface DeviceFacts {
  readonly deviceId: string;
  readonly osFamily: OsFamily;
  readonly architecture: string;
  readonly hostname: string;
  readonly observedAt: number;
}

export interface DiscoveryEvidence {
  readonly evidenceId: string;
  readonly source: EvidenceSource;
  readonly observedAt: number;
  readonly code: string;
  readonly message: string;
  readonly action?: string;
  readonly version?: string;
}

export interface CapabilityObservation {
  readonly capabilityId: string;
  readonly state: CapabilityState;
  readonly observedAt: number;
  readonly evidence: readonly DiscoveryEvidence[];
}

export interface ReadinessObservation {
  readonly status: "ready" | "degraded" | "unavailable";
  readonly observedAt: number;
  readonly evidence: readonly DiscoveryEvidence[];
}

export interface DeviceReadiness {
  readonly workerService: ReadinessObservation;
  readonly userSession: ReadinessObservation;
}

export interface DeviceProfilePatchOperation {
  readonly field: "roles" | "instructions";
  readonly operation: "add";
  readonly value: string;
}

export interface DeviceProfilePatchProposal {
  readonly proposalId: string;
  readonly targetDeviceId: string;
  readonly reasonCode: "COMPUTER_USE_READY";
  readonly operations: readonly DeviceProfilePatchOperation[];
  readonly evidenceCapabilityIds: readonly string[];
}

export interface DiscoveryResult {
  readonly facts: DeviceFacts;
  readonly capabilities: readonly CapabilityObservation[];
  readonly readiness: DeviceReadiness;
  readonly profilePatchProposals: readonly DeviceProfilePatchProposal[];
}
