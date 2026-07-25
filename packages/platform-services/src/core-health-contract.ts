import type { DeviceRuntimeRole } from "./types.ts";

export type CoreHealthState = "failed" | "running" | "starting" | "stopping";

export interface CoreHealthResponseV1 {
  readonly schemaVersion: 1;
  readonly product: "OpenDelegate";
  readonly plane: "core";
  readonly instanceId: string;
  readonly deviceId: string;
  readonly role: DeviceRuntimeRole;
  readonly releaseVersion: string;
  readonly status: CoreHealthState;
  readonly headlessWorkAvailable: boolean;
}

export interface ExpectedCoreHealthIdentity {
  readonly instanceId: string;
  readonly deviceId: string;
  readonly role: DeviceRuntimeRole;
  readonly releaseVersion: string;
}

export function isRunningCoreHealthResponseV1(
  input: unknown,
  expected: ExpectedCoreHealthIdentity,
): input is CoreHealthResponseV1 & {
  readonly status: "running";
  readonly headlessWorkAvailable: true;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    record["schemaVersion"] === 1 &&
    record["product"] === "OpenDelegate" &&
    record["plane"] === "core" &&
    record["instanceId"] === expected.instanceId &&
    record["deviceId"] === expected.deviceId &&
    record["role"] === expected.role &&
    record["releaseVersion"] === expected.releaseVersion &&
    record["status"] === "running" &&
    record["headlessWorkAvailable"] === true
  );
}
