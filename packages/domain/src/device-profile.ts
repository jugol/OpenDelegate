import { DomainError } from "./domain-error.ts";
import type { DeviceId } from "./identifiers.ts";

export type OsFamily = "macos" | "windows" | "linux";

export interface CreateDeviceProfile {
  readonly id: DeviceId;
  readonly name: string;
  readonly osFamily: OsFamily;
  readonly roles: readonly string[];
  readonly instructions: readonly string[];
}

export interface DeviceProfilePatch {
  readonly proposalId: string;
  readonly baseRevision: number;
  readonly roles?: readonly string[];
  readonly instructions?: readonly string[];
  readonly reason: string;
}

export type DeviceProfileAuthority =
  | {
      readonly kind: "owner" | "main-agent";
      readonly authorityId: string;
    }
  | {
      readonly kind: "worker-agent";
      readonly authorityId: string;
    };

export interface ApplyDeviceProfilePatch {
  readonly patch: DeviceProfilePatch;
  readonly authority: DeviceProfileAuthority;
}

export interface DeviceProfileChange {
  readonly deviceId: string;
  readonly proposalId: string;
  readonly previousRevision: number;
  readonly revision: number;
  readonly authority: DeviceProfileAuthority;
  readonly reason: string;
}

export class DeviceProfile {
  public readonly id: DeviceId;
  public readonly name: string;
  public readonly osFamily: OsFamily;
  private currentRevision = 1;
  private currentRoles: readonly string[];
  private currentInstructions: readonly string[];

  private constructor(input: CreateDeviceProfile) {
    this.id = input.id;
    this.name = input.name;
    this.osFamily = input.osFamily;
    this.currentRoles = freezeCopy(input.roles);
    this.currentInstructions = freezeCopy(input.instructions);
  }

  public static create(input: CreateDeviceProfile): DeviceProfile {
    return new DeviceProfile(input);
  }

  public get revision(): number {
    return this.currentRevision;
  }

  public get roles(): readonly string[] {
    return this.currentRoles;
  }

  public get instructions(): readonly string[] {
    return this.currentInstructions;
  }

  public applyPatch(input: ApplyDeviceProfilePatch): DeviceProfileChange {
    if (input.authority.kind === "worker-agent") {
      throw new DomainError(
        "DEVICE_PROFILE_AUTHORITY_REQUIRED",
        "A Worker Agent may propose a Device Profile patch but cannot persist it.",
      );
    }

    if (input.patch.baseRevision !== this.currentRevision) {
      throw new DomainError(
        "DEVICE_PROFILE_REVISION_CONFLICT",
        `Device Profile revision ${this.currentRevision} does not match patch base revision ${input.patch.baseRevision}.`,
      );
    }

    const previousRevision = this.currentRevision;

    if (input.patch.roles !== undefined) {
      this.currentRoles = freezeCopy(input.patch.roles);
    }

    if (input.patch.instructions !== undefined) {
      this.currentInstructions = freezeCopy(input.patch.instructions);
    }

    this.currentRevision += 1;

    return {
      deviceId: this.id.value,
      proposalId: input.patch.proposalId,
      previousRevision,
      revision: this.currentRevision,
      authority: input.authority,
      reason: input.patch.reason,
    };
  }
}

function freezeCopy(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}
