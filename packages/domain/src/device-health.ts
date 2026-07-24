import { DomainError } from "./domain-error.ts";
import type { DeviceId } from "./identifiers.ts";

export type DeviceConnectionHealth = "unknown" | "online" | "degraded" | "offline";
export type DeviceOperationalState = "active" | "draining" | "disabled" | "revoked";
export type DesktopReadinessState =
  "ready" | "locked" | "permission-required" | "no-session" | "unavailable";

export interface DesktopReadiness {
  readonly state: DesktopReadinessState;
  readonly reason?: string;
}

export interface DeviceLoad {
  readonly activeRuns: number;
  readonly runCapacity: number;
  readonly heldResourceLocks: readonly string[];
}

export interface DeviceHealthReport {
  readonly sequence: number;
  readonly observedAtMs: number;
  readonly connection: DeviceConnectionHealth;
  readonly desktop: DesktopReadiness;
  readonly load: DeviceLoad;
}

export interface CreateDeviceHealth extends DeviceHealthReport {
  readonly deviceId: DeviceId;
  readonly operationalState?: DeviceOperationalState;
}

export interface DeviceHealthSnapshot extends DeviceHealthReport {
  readonly deviceId: string;
  readonly operationalState: DeviceOperationalState;
  readonly operationalReason?: string;
}

export class DeviceHealth {
  public readonly deviceId: DeviceId;
  private currentSequence: number;
  private currentObservedAtMs: number;
  private currentConnection: DeviceConnectionHealth;
  private currentDesktop: DesktopReadiness;
  private currentLoad: DeviceLoad;
  private currentOperationalState: DeviceOperationalState;
  private currentOperationalReason: string | undefined;

  private constructor(input: CreateDeviceHealth) {
    validateHealthReport(input);
    this.deviceId = input.deviceId;
    this.currentSequence = input.sequence;
    this.currentObservedAtMs = input.observedAtMs;
    this.currentConnection = input.connection;
    this.currentDesktop = freezeDesktop(input.desktop);
    this.currentLoad = freezeLoad(input.load);
    this.currentOperationalState = input.operationalState ?? "active";
  }

  public static create(input: CreateDeviceHealth): DeviceHealth {
    return new DeviceHealth(input);
  }

  public get eligibleForNewWork(): boolean {
    return (
      this.currentOperationalState === "active" &&
      this.currentConnection === "online" &&
      this.currentLoad.activeRuns < this.currentLoad.runCapacity
    );
  }

  public get snapshot(): DeviceHealthSnapshot {
    return Object.freeze({
      deviceId: this.deviceId.value,
      sequence: this.currentSequence,
      observedAtMs: this.currentObservedAtMs,
      connection: this.currentConnection,
      operationalState: this.currentOperationalState,
      ...(this.currentOperationalReason === undefined
        ? {}
        : { operationalReason: this.currentOperationalReason }),
      desktop: this.currentDesktop,
      load: this.currentLoad,
    });
  }

  public recordReport(report: DeviceHealthReport): void {
    this.assertNotRevoked();
    validateHealthReport(report);
    if (report.sequence <= this.currentSequence) {
      throw new DomainError(
        "DEVICE_HEALTH_REPORT_STALE",
        `Device health sequence ${report.sequence} is not newer than ${this.currentSequence}.`,
      );
    }

    this.currentSequence = report.sequence;
    this.currentObservedAtMs = report.observedAtMs;
    this.currentConnection = report.connection;
    this.currentDesktop = freezeDesktop(report.desktop);
    this.currentLoad = freezeLoad(report.load);
  }

  public markOffline(observedAtMs: number): void {
    this.assertNotRevoked();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < this.currentObservedAtMs) {
      throw new DomainError(
        "DEVICE_HEALTH_REPORT_INVALID",
        "A Device health observation must use a non-decreasing safe-integer clock.",
      );
    }
    this.currentObservedAtMs = observedAtMs;
    this.currentConnection = "offline";
  }

  public drain(reason: string): void {
    if (this.currentOperationalState === "draining") {
      return;
    }
    this.requireOperationalState("active");
    this.currentOperationalState = "draining";
    this.currentOperationalReason = reason;
  }

  public activate(): void {
    this.requireOperationalState("draining");
    this.currentOperationalState = "active";
    this.currentOperationalReason = undefined;
  }

  public disable(reason: string): void {
    this.assertNotRevoked();
    if (this.currentOperationalState === "disabled") {
      return;
    }
    this.currentOperationalState = "disabled";
    this.currentOperationalReason = reason;
  }

  public enable(): void {
    this.requireOperationalState("disabled");
    this.currentOperationalState = "active";
    this.currentOperationalReason = undefined;
  }

  public revoke(reason: string): void {
    if (this.currentOperationalState === "revoked") {
      return;
    }
    this.currentOperationalState = "revoked";
    this.currentOperationalReason = reason;
    this.currentConnection = "offline";
  }

  private assertNotRevoked(): void {
    if (this.currentOperationalState === "revoked") {
      throw new DomainError(
        "DEVICE_OPERATION_TRANSITION_INVALID",
        "A revoked Device cannot accept health or lifecycle changes.",
      );
    }
  }

  private requireOperationalState(expected: DeviceOperationalState): void {
    if (this.currentOperationalState !== expected) {
      throw new DomainError(
        "DEVICE_OPERATION_TRANSITION_INVALID",
        `Device state ${this.currentOperationalState} cannot perform an operation requiring ${expected}.`,
      );
    }
  }
}

function freezeDesktop(desktop: DesktopReadiness): DesktopReadiness {
  return Object.freeze(
    desktop.reason === undefined
      ? { state: desktop.state }
      : { state: desktop.state, reason: desktop.reason },
  );
}

function freezeLoad(load: DeviceLoad): DeviceLoad {
  return Object.freeze({
    activeRuns: load.activeRuns,
    runCapacity: load.runCapacity,
    heldResourceLocks: Object.freeze([...load.heldResourceLocks]),
  });
}

function validateHealthReport(report: DeviceHealthReport): void {
  if (
    !Number.isSafeInteger(report.sequence) ||
    report.sequence < 0 ||
    !Number.isSafeInteger(report.observedAtMs) ||
    report.observedAtMs < 0 ||
    !Number.isSafeInteger(report.load.activeRuns) ||
    report.load.activeRuns < 0 ||
    !Number.isSafeInteger(report.load.runCapacity) ||
    report.load.runCapacity <= 0 ||
    report.load.activeRuns > report.load.runCapacity ||
    report.load.heldResourceLocks.some(
      (resourceName) => typeof resourceName !== "string" || resourceName.trim() === "",
    ) ||
    new Set(report.load.heldResourceLocks).size !== report.load.heldResourceLocks.length
  ) {
    throw new DomainError(
      "DEVICE_HEALTH_REPORT_INVALID",
      "Device health requires safe clocks, a valid load, and unique resource locks.",
    );
  }
}
