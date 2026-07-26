import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  RunCapabilityBrokerError,
  type RunCapabilityBinding,
  type RunCapabilityJsonValue,
} from "./contracts.ts";

export const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;

export function normalizeBinding(input: unknown): RunCapabilityBinding {
  const record = requireRecord(input);
  requireExactKeys(record, [
    "taskId",
    "workOrderId",
    "runId",
    "deviceId",
    "leaseId",
    "fencingToken",
    "leaseExpiresAtMs",
  ]);
  const binding = {
    taskId: requireIdentifier(record["taskId"], 256),
    workOrderId: requireIdentifier(record["workOrderId"], 256),
    runId: requireIdentifier(record["runId"], 256),
    deviceId: requireIdentifier(record["deviceId"], 256),
    leaseId: requireIdentifier(record["leaseId"], 256),
    fencingToken: requirePositiveInteger(record["fencingToken"]),
    leaseExpiresAtMs: requireTimestamp(record["leaseExpiresAtMs"]),
  };
  return deepFreeze(binding);
}

export function normalizeJsonValue(input: unknown, maximumBytes: number): RunCapabilityJsonValue {
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded, "utf8") > maximumBytes ||
    containsUnsafeJsonValue(input, new WeakSet<object>(), 0)
  ) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  return deepFreeze(structuredClone(input)) as RunCapabilityJsonValue;
}

function containsUnsafeJsonValue(value: unknown, active: WeakSet<object>, depth: number): boolean {
  if (depth > 32) {
    return true;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return typeof value === "string" && Buffer.byteLength(value, "utf8") > 262_144;
  }
  if (typeof value !== "object" || value === null || active.has(value)) {
    return true;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) {
    return true;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return true;
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        value.length > 4_096 ||
        value.some((entry) => containsUnsafeJsonValue(entry, active, depth + 1))
      );
    }
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record);
    return (
      keys.length > 4_096 ||
      Object.getOwnPropertyNames(record).length !== keys.length ||
      keys.some(
        (key) =>
          !/^[A-Za-z0-9_.:-]{1,256}$/u.test(key) ||
          containsUnsafeJsonValue(record[key], active, depth + 1),
      )
    );
  } finally {
    active.delete(value);
  }
}

export function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

export function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
}

export function requireIdentifier(value: unknown, maximumBytes = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  ) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  return value;
}

export function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  return value;
}

export function requireTimestamp(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  return value;
}

export function requireAbsoluteExternalPath(
  value: string,
  sourceCheckoutDirectory: string,
): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    typeof sourceCheckoutDirectory !== "string" ||
    !isAbsolute(sourceCheckoutDirectory)
  ) {
    throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
  }
  const target = resolve(value);
  const checkout = resolve(sourceCheckoutDirectory);
  const path = relative(checkout, target);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) {
    throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
  }
  return target;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
      deepFreeze(child);
    }
  }
  return value;
}
