import { DomainError } from "./domain-error.ts";
import type { DeviceId, InstanceId, OwnerId } from "./identifiers.ts";

export type AutonomyProfile = "reactive" | "assisted" | "autonomous";

export interface CreateInstance {
  readonly id: InstanceId;
  readonly ownerId: OwnerId;
  readonly mainDeviceId: DeviceId;
  readonly autonomyProfile?: AutonomyProfile;
}

export interface InstanceSnapshot {
  readonly id: string;
  readonly ownerId: string;
  readonly mainDeviceId: string;
  readonly deviceIds: readonly string[];
  readonly autonomyProfile: AutonomyProfile;
}

export class Instance {
  public readonly id: InstanceId;
  public readonly ownerId: OwnerId;
  public readonly mainDeviceId: DeviceId;
  private readonly registeredDeviceIds = new Set<string>();
  private currentAutonomyProfile: AutonomyProfile;

  private constructor(input: CreateInstance) {
    this.id = input.id;
    this.ownerId = input.ownerId;
    this.mainDeviceId = input.mainDeviceId;
    this.registeredDeviceIds.add(input.mainDeviceId.value);
    this.currentAutonomyProfile = input.autonomyProfile ?? "assisted";
  }

  public static create(input: CreateInstance): Instance {
    return new Instance(input);
  }

  public get snapshot(): InstanceSnapshot {
    return Object.freeze({
      id: this.id.value,
      ownerId: this.ownerId.value,
      mainDeviceId: this.mainDeviceId.value,
      deviceIds: Object.freeze([...this.registeredDeviceIds].sort()),
      autonomyProfile: this.currentAutonomyProfile,
    });
  }

  public registerDevice(deviceId: DeviceId): void {
    this.registeredDeviceIds.add(deviceId.value);
  }

  public assignMainDevice(deviceId: DeviceId): void {
    if (deviceId.value === this.mainDeviceId.value) {
      return;
    }

    throw new DomainError(
      "INSTANCE_MAIN_FIXED",
      `Instance ${this.id.value} has fixed Main Device ${this.mainDeviceId.value}.`,
    );
  }

  public setAutonomyProfile(profile: AutonomyProfile): void {
    this.currentAutonomyProfile = profile;
  }
}
