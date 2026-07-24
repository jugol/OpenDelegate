import { DomainError } from "./domain-error.ts";
import type { ArtifactId, DeviceId, RunId, TaskId } from "./identifiers.ts";

export type ArtifactState = "available" | "expired" | "revoked";
export type ArtifactExposureMode =
  "private-network" | "authenticated" | "signed-link" | "public" | "custom";

export type ArtifactRetentionPolicy =
  | {
      readonly kind: "temporary";
      readonly expiresAtMs: number;
    }
  | {
      readonly kind: "task";
    }
  | {
      readonly kind: "pinned";
    };

export type ArtifactExposurePolicy =
  | {
      readonly mode: Exclude<ArtifactExposureMode, "custom">;
      readonly customPolicyId?: never;
    }
  | {
      readonly mode: "custom";
      readonly customPolicyId: string;
    };

export interface ArtifactExposureLayers {
  readonly instance: ArtifactExposurePolicy;
  readonly device?: ArtifactExposurePolicy;
  readonly task?: ArtifactExposurePolicy;
  readonly artifact?: ArtifactExposurePolicy;
}

export interface ResolvedArtifactExposure {
  readonly source: "instance" | "device" | "task" | "artifact";
  readonly policy: ArtifactExposurePolicy;
}

export interface ArtifactChecksum {
  readonly algorithm: "sha256";
  readonly value: string;
}

export interface ArtifactProvenance {
  readonly deviceId: DeviceId;
  readonly source: string;
  readonly workspaceId?: string;
}

export interface CreateArtifact {
  readonly id: ArtifactId;
  readonly taskId: TaskId;
  readonly producingRunId: RunId;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly checksum: ArtifactChecksum;
  readonly createdAtMs: number;
  readonly retentionPolicy: ArtifactRetentionPolicy;
  readonly exposurePolicy: ArtifactExposurePolicy;
  readonly provenance: ArtifactProvenance;
}

export interface ArtifactMetadata {
  readonly id: string;
  readonly taskId: string;
  readonly producingRunId: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly checksum: ArtifactChecksum;
  readonly createdAtMs: number;
  readonly retentionPolicy: ArtifactRetentionPolicy;
  readonly exposurePolicy: ArtifactExposurePolicy;
  readonly provenance: {
    readonly deviceId: string;
    readonly source: string;
    readonly workspaceId?: string;
  };
  readonly state: ArtifactState;
}

export class Artifact {
  public readonly id: ArtifactId;
  public readonly taskId: TaskId;
  public readonly producingRunId: RunId;
  private readonly mediaType: string;
  private readonly sizeBytes: number;
  private readonly checksum: ArtifactChecksum;
  private readonly createdAtMs: number;
  private currentRetentionPolicy: ArtifactRetentionPolicy;
  private currentExposurePolicy: ArtifactExposurePolicy;
  private readonly provenance: ArtifactMetadata["provenance"];
  private currentState: ArtifactState = "available";

  private constructor(input: CreateArtifact) {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new DomainError(
        "ARTIFACT_RETENTION_INVALID",
        "Artifact size must be a non-negative safe integer.",
      );
    }
    if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) {
      throw new DomainError(
        "ARTIFACT_RETENTION_INVALID",
        "Artifact creation time must be a non-negative safe integer.",
      );
    }
    this.id = input.id;
    this.taskId = input.taskId;
    this.producingRunId = input.producingRunId;
    this.mediaType = input.mediaType;
    this.sizeBytes = input.sizeBytes;
    this.checksum = Object.freeze({ ...input.checksum });
    this.createdAtMs = input.createdAtMs;
    this.currentRetentionPolicy = freezeRetention(input.retentionPolicy, input.createdAtMs);
    this.currentExposurePolicy = freezeExposure(input.exposurePolicy);
    this.provenance = Object.freeze({
      deviceId: input.provenance.deviceId.value,
      source: input.provenance.source,
      ...(input.provenance.workspaceId === undefined
        ? {}
        : { workspaceId: input.provenance.workspaceId }),
    });
  }

  public static create(input: CreateArtifact): Artifact {
    return new Artifact(input);
  }

  public get state(): ArtifactState {
    return this.currentState;
  }

  public get metadata(): ArtifactMetadata {
    return Object.freeze({
      id: this.id.value,
      taskId: this.taskId.value,
      producingRunId: this.producingRunId.value,
      mediaType: this.mediaType,
      sizeBytes: this.sizeBytes,
      checksum: this.checksum,
      createdAtMs: this.createdAtMs,
      retentionPolicy: this.currentRetentionPolicy,
      exposurePolicy: this.currentExposurePolicy,
      provenance: this.provenance,
      state: this.currentState,
    });
  }

  public pin(): void {
    this.requireAvailable();
    this.currentRetentionPolicy = Object.freeze({ kind: "pinned" });
  }

  public setExposure(policy: ArtifactExposurePolicy): void {
    this.requireAvailable();
    this.currentExposurePolicy = freezeExposure(policy);
  }

  public expire(nowMs: number): void {
    this.requireAvailable();
    if (!Number.isSafeInteger(nowMs) || nowMs < this.createdAtMs) {
      throw new DomainError(
        "ARTIFACT_RETENTION_INVALID",
        "Artifact expiration requires a safe observation time at or after creation.",
      );
    }
    if (
      this.currentRetentionPolicy.kind !== "temporary" ||
      nowMs < this.currentRetentionPolicy.expiresAtMs
    ) {
      throw new DomainError(
        "ARTIFACT_RETENTION_ACTIVE",
        "Artifact retention policy has not reached expiration.",
      );
    }
    this.currentState = "expired";
  }

  public revoke(): void {
    if (this.currentState === "revoked") {
      return;
    }
    if (this.currentState === "expired") {
      throw new DomainError(
        "ARTIFACT_TRANSITION_INVALID",
        "An expired Artifact cannot transition to revoked.",
      );
    }
    this.currentState = "revoked";
  }

  private requireAvailable(): void {
    if (this.currentState !== "available") {
      throw new DomainError(
        "ARTIFACT_TRANSITION_INVALID",
        `Artifact state ${this.currentState} cannot be mutated.`,
      );
    }
  }
}

export function resolveArtifactExposure(layers: ArtifactExposureLayers): ResolvedArtifactExposure {
  const selected =
    layers.artifact === undefined
      ? layers.task === undefined
        ? layers.device === undefined
          ? { source: "instance" as const, policy: layers.instance }
          : { source: "device" as const, policy: layers.device }
        : { source: "task" as const, policy: layers.task }
      : { source: "artifact" as const, policy: layers.artifact };

  return Object.freeze({
    source: selected.source,
    policy: freezeExposure(selected.policy),
  });
}

function freezeRetention(
  policy: ArtifactRetentionPolicy,
  createdAtMs: number,
): ArtifactRetentionPolicy {
  if (policy.kind === "temporary") {
    if (!Number.isSafeInteger(policy.expiresAtMs) || policy.expiresAtMs <= createdAtMs) {
      throw new DomainError(
        "ARTIFACT_RETENTION_INVALID",
        "Temporary Artifact retention requires a safe expiration after creation.",
      );
    }
    return Object.freeze({ kind: "temporary", expiresAtMs: policy.expiresAtMs });
  }
  return Object.freeze({ kind: policy.kind });
}

function freezeExposure(policy: ArtifactExposurePolicy): ArtifactExposurePolicy {
  if (policy.mode === "custom") {
    if (policy.customPolicyId.trim() === "") {
      throw new DomainError(
        "ARTIFACT_EXPOSURE_INVALID",
        "Custom Artifact exposure requires a non-blank Policy identifier.",
      );
    }
    return Object.freeze({
      mode: "custom",
      customPolicyId: policy.customPolicyId,
    });
  }

  if ("customPolicyId" in policy && policy.customPolicyId !== undefined) {
    throw new DomainError(
      "ARTIFACT_EXPOSURE_INVALID",
      "Only custom Artifact exposure can name a custom Policy.",
    );
  }

  return Object.freeze({ mode: policy.mode });
}
