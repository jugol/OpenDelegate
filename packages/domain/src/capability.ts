import { DomainError } from "./domain-error.ts";
import type { CapabilityId, DeviceId } from "./identifiers.ts";

export type CapabilityState =
  "detected" | "verification-pending" | "verified" | "degraded" | "unavailable" | "disabled";

export type CapabilityHealth = "healthy" | "degraded" | "unavailable";

export interface CapabilityEvidence {
  readonly kind: "observation" | "probe" | "verification" | "owner-action";
  readonly source: string;
  readonly observedAtMs: number;
  readonly detail: string;
}

export interface CapabilityConstraint {
  readonly key: string;
  readonly value: string;
}

export interface CapabilityResourceRequirement {
  readonly resource: string;
  readonly units: number;
}

export interface CreateCapability {
  readonly id: CapabilityId;
  readonly deviceId: DeviceId;
  readonly name: string;
  readonly state: CapabilityState;
  readonly version?: string;
  readonly evidence: readonly CapabilityEvidence[];
  readonly constraints?: readonly CapabilityConstraint[];
  readonly resourceRequirements?: readonly CapabilityResourceRequirement[];
}

export interface CapabilityTransition {
  readonly state: CapabilityState;
  readonly evidence: CapabilityEvidence;
  readonly version?: string;
}

export interface CapabilitySnapshot {
  readonly id: string;
  readonly deviceId: string;
  readonly name: string;
  readonly state: CapabilityState;
  readonly health: CapabilityHealth;
  readonly version?: string;
  readonly evidence: readonly CapabilityEvidence[];
  readonly constraints: readonly CapabilityConstraint[];
  readonly resourceRequirements: readonly CapabilityResourceRequirement[];
}

const allowedTransitions = {
  detected: ["verification-pending", "unavailable", "disabled"],
  "verification-pending": ["verified", "degraded", "unavailable", "disabled"],
  verified: ["degraded", "unavailable", "disabled"],
  degraded: ["verification-pending", "verified", "unavailable", "disabled"],
  unavailable: ["detected", "verification-pending", "disabled"],
  disabled: ["detected"],
} as const satisfies Readonly<Record<CapabilityState, readonly CapabilityState[]>>;

export class Capability {
  public readonly id: CapabilityId;
  public readonly deviceId: DeviceId;
  public readonly name: string;
  private currentState: CapabilityState;
  private currentVersion: string | undefined;
  private readonly evidenceHistory: CapabilityEvidence[];
  private readonly capabilityConstraints: readonly CapabilityConstraint[];
  private readonly requiredResources: readonly CapabilityResourceRequirement[];

  private constructor(input: CreateCapability) {
    this.id = input.id;
    this.deviceId = input.deviceId;
    this.name = input.name;
    this.currentState = input.state;
    this.currentVersion = input.version;
    this.evidenceHistory = input.evidence.map(freezeEvidence);
    this.capabilityConstraints = freezeRecords(input.constraints ?? []);
    this.requiredResources = freezeRecords(input.resourceRequirements ?? []);
  }

  public static create(input: CreateCapability): Capability {
    return new Capability(input);
  }

  public get state(): CapabilityState {
    return this.currentState;
  }

  public get snapshot(): CapabilitySnapshot {
    const base = {
      id: this.id.value,
      deviceId: this.deviceId.value,
      name: this.name,
      state: this.currentState,
      health: healthForState(this.currentState),
      evidence: Object.freeze(this.evidenceHistory.map(freezeEvidence)),
      constraints: this.capabilityConstraints,
      resourceRequirements: this.requiredResources,
    };

    return Object.freeze(
      this.currentVersion === undefined ? base : { ...base, version: this.currentVersion },
    );
  }

  public transition(input: CapabilityTransition): void {
    if (input.state === this.currentState) {
      this.evidenceHistory.push(freezeEvidence(input.evidence));
      if (input.version !== undefined) {
        this.currentVersion = input.version;
      }
      return;
    }

    const nextStates: readonly CapabilityState[] = allowedTransitions[this.currentState];
    if (!nextStates.includes(input.state)) {
      throw new DomainError(
        "CAPABILITY_TRANSITION_INVALID",
        `Capability state ${this.currentState} cannot transition to ${input.state}.`,
      );
    }

    this.currentState = input.state;
    this.evidenceHistory.push(freezeEvidence(input.evidence));
    if (input.version !== undefined) {
      this.currentVersion = input.version;
    }
  }
}

function healthForState(state: CapabilityState): CapabilityHealth {
  switch (state) {
    case "verified":
      return "healthy";
    case "detected":
    case "verification-pending":
    case "degraded":
      return "degraded";
    case "unavailable":
    case "disabled":
      return "unavailable";
  }
}

function freezeEvidence(evidence: CapabilityEvidence): CapabilityEvidence {
  return Object.freeze({ ...evidence });
}

function freezeRecords<T extends object>(records: readonly T[]): readonly Readonly<T>[] {
  return Object.freeze(records.map((record) => Object.freeze({ ...record })));
}
