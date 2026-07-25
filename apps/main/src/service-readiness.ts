import type { ReadinessV1 } from "@opendelegate/protocol";

export const MAIN_SERVICE_READY_MESSAGE_TYPE = "opendelegate.main.ready.v1" as const;

export interface MainServiceReadyMessageV1 {
  readonly type: typeof MAIN_SERVICE_READY_MESSAGE_TYPE;
  readonly protocolVersion: 1;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly releaseVersion: string;
  readonly buildId: string;
  readonly origin: string;
  readonly readiness: ReadinessV1 & { readonly status: "ready" };
}

export interface ExpectedMainServiceReadyIdentity {
  readonly instanceId: string;
  readonly deviceId: string;
  readonly releaseVersion: string;
  readonly origin: string;
}

export function createMainServiceReadyMessage(input: {
  readonly instanceId: string;
  readonly deviceId: string;
  readonly releaseVersion: string;
  readonly buildId: string;
  readonly origin: string;
  readonly readiness: ReadinessV1;
}): MainServiceReadyMessageV1 {
  if (
    input.readiness.status !== "ready" ||
    input.readiness.checks.length === 0 ||
    input.readiness.checks.some((check) => check.status !== "ready")
  ) {
    throw new Error("Main cannot advertise service readiness while a composed check is not ready.");
  }
  const message: MainServiceReadyMessageV1 = {
    type: MAIN_SERVICE_READY_MESSAGE_TYPE,
    protocolVersion: 1,
    instanceId: input.instanceId,
    deviceId: input.deviceId,
    releaseVersion: input.releaseVersion,
    buildId: input.buildId,
    origin: input.origin,
    readiness: {
      status: "ready",
      checks: input.readiness.checks.map((check) => ({
        status: "ready" as const,
        code: check.code,
      })),
    },
  };
  return Object.freeze(message);
}

export function isMainServiceReadyMessage(
  input: unknown,
  expected: ExpectedMainServiceReadyIdentity,
): input is MainServiceReadyMessageV1 {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  if (
    record["type"] !== MAIN_SERVICE_READY_MESSAGE_TYPE ||
    record["protocolVersion"] !== 1 ||
    record["instanceId"] !== expected.instanceId ||
    record["deviceId"] !== expected.deviceId ||
    record["releaseVersion"] !== expected.releaseVersion ||
    record["origin"] !== expected.origin ||
    !isBoundedText(record["buildId"], 256)
  ) {
    return false;
  }
  const readiness = record["readiness"];
  if (readiness === null || typeof readiness !== "object" || Array.isArray(readiness)) {
    return false;
  }
  const readinessRecord = readiness as Record<string, unknown>;
  const checks = readinessRecord["checks"];
  return (
    readinessRecord["status"] === "ready" &&
    Array.isArray(checks) &&
    checks.length > 0 &&
    checks.length <= 64 &&
    checks.every((check) => isReadyCheck(check)) &&
    checks.some((check) => (check as Record<string, unknown>)["code"] === "DATABASE_READY") &&
    checks.some((check) => (check as Record<string, unknown>)["code"] === "CONTROL_PLANE_READY")
  );
}

function isReadyCheck(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record["status"] === "ready" &&
    isBoundedText(record["code"], 128)
  );
}

function isBoundedText(input: unknown, maximumLength: number): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= maximumLength &&
    input === input.trim() &&
    [...input].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    })
  );
}
