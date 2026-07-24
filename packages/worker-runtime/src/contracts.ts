import { createHash } from "node:crypto";

import {
  PROTOCOL_VERSION,
  parseApplicationRequestEnvelope,
  parseWorkOrder,
  type WorkOrderV1,
} from "@opendelegate/protocol";
import type {
  RedactedDiagnostic,
  TransportAttemptTrace,
  TransportProfile,
} from "@opendelegate/transport";

export type WorkerOperationalState = "active" | "disabled" | "draining" | "revoked";
export type WorkerConnectionState = "offline" | "online";
export type WorkerDaemonState = "degraded" | "healthy" | "starting" | "stopping";
export type WorkerSessionState = "locked" | "logged-out" | "ready" | "unavailable";
export type WorkerDesktopState = "available" | "busy" | "locked" | "unavailable";
export type WorkerPermissionState = "denied" | "granted" | "not-applicable" | "unknown";

export interface WorkerConfiguration {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly deviceId: string;
  readonly workerId: string;
  readonly mainDeviceId: string;
  readonly transportProfile: TransportProfile;
  readonly maxOutboxEntries: number;
  readonly cancelGraceMs: number;
}

export interface WorkerRunAssignmentV1 {
  readonly taskId: string;
  readonly workOrder: WorkOrderV1;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs: number;
}

export interface WorkerAssignmentMessageV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly messageId: string;
  readonly senderDeviceId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly type: "worker.run.assign";
  readonly payload: WorkerRunAssignmentV1;
}

export type WorkerControlActionV1 = "cancel" | "disable" | "drain" | "revoke";

export interface WorkerControlMessageV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly messageId: string;
  readonly senderDeviceId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly type: "worker.control";
  readonly payload: {
    readonly action: WorkerControlActionV1;
    readonly reason: string;
    readonly runId?: string;
    readonly leaseId?: string;
    readonly fencingToken?: number;
  };
}

export interface WorkerRunIdentityV1 {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
}

export type WorkerOutboundEventTypeV1 =
  | "worker.run.cancelled"
  | "worker.run.claimed"
  | "worker.run.failed"
  | "worker.run.rejected"
  | "worker.run.succeeded";

export interface WorkerOutboundEventV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly messageId: string;
  readonly senderDeviceId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly type: WorkerOutboundEventTypeV1;
  readonly payload: WorkerRunIdentityV1 & {
    readonly report?: string;
    readonly artifactIds?: readonly string[];
    readonly diagnostic?: RedactedDiagnostic;
  };
}

export interface SequencedWorkerEventV1 extends WorkerOutboundEventV1 {
  readonly sequence: number;
}

export interface WorkerOutboxAckV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly acknowledgedMessageIds: readonly string[];
}

export interface WorkerRuntimeReadiness {
  readonly daemon: WorkerDaemonState;
  readonly session: WorkerSessionState;
  readonly desktop: WorkerDesktopState;
  readonly permissions: {
    readonly accessibility: WorkerPermissionState;
    readonly input: WorkerPermissionState;
    readonly screenCapture: WorkerPermissionState;
  };
}

export interface WorkerHeartbeatV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly deviceId: string;
  readonly workerId: string;
  readonly observedAtMs: number;
  readonly operationalState: WorkerOperationalState;
  readonly connectionState: WorkerConnectionState;
  readonly readiness: WorkerRuntimeReadiness;
  readonly capacity: {
    readonly acceptingWork: boolean;
    readonly activeRuns: number;
    readonly maxOutboxEntries: number;
    readonly outboxDepth: number;
  };
  readonly routeAttempts?: readonly TransportAttemptTrace[];
}

export type RunProcessOutcome =
  | {
      readonly status: "failed";
      readonly report: string;
      readonly diagnostic?: unknown;
    }
  | {
      readonly status: "succeeded";
      readonly report: string;
      readonly artifactIds: readonly string[];
    };

export interface RunProcess {
  readonly completion: Promise<RunProcessOutcome>;
  requestCancel(): Promise<void>;
  forceTerminate(): Promise<void>;
}

export interface RunExecutionContext {
  readonly assignment: WorkerRunAssignmentV1;
  isLeaseCurrent(): Promise<boolean>;
}

export interface RunProcessFactory {
  start(context: RunExecutionContext): Promise<RunProcess>;
}

export interface WorkerClock {
  now(): number;
}

export interface WorkerDelay {
  wait(milliseconds: number): Promise<void>;
}

export interface WorkerMainConnection {
  sendEvents(events: readonly SequencedWorkerEventV1[]): Promise<WorkerOutboxAckV1>;
  sendHeartbeat(heartbeat: WorkerHeartbeatV1): Promise<void>;
  close?(): Promise<void>;
}

export interface WorkerRuntimeHealthProvider {
  snapshot(): WorkerRuntimeReadiness;
}

export interface WorkerAssignmentAcceptance {
  readonly disposition: "accepted" | "duplicate" | "rejected";
  readonly runId: string;
  readonly reason?:
    "backpressure" | "device-not-active" | "lease-expired" | "stale-fence" | "work-order-busy";
}

export interface WorkerConnectionResult {
  readonly connected: true;
  readonly endpointId: string;
  readonly replayedEvents: number;
}

export interface WorkerConnectionFailure {
  readonly connected: false;
  readonly diagnostics: readonly TransportAttemptTrace[];
}

export type WorkerConnectResult = WorkerConnectionResult | WorkerConnectionFailure;

const CONFIGURATION_KEYS = new Set([
  "protocolVersion",
  "deviceId",
  "workerId",
  "mainDeviceId",
  "transportProfile",
  "maxOutboxEntries",
  "cancelGraceMs",
]);
const TRANSPORT_PROFILE_KEYS = new Set(["deviceId", "endpoints"]);
const TRANSPORT_ENDPOINT_KEYS = new Set(["endpointId", "label", "kind", "url", "credentialRef"]);
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;

export function validateWorkerConfiguration(input: WorkerConfiguration): WorkerConfiguration {
  assertConfigurationRecord(input, "Worker configuration");
  assertExactKeys(input, CONFIGURATION_KEYS, "Worker configuration");
  if (input.protocolVersion !== PROTOCOL_VERSION) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Unsupported protocol version.");
  }
  assertConfigurationIdentifier(input.deviceId, "Device ID");
  assertConfigurationIdentifier(input.workerId, "Worker ID");
  assertConfigurationIdentifier(input.mainDeviceId, "Main Device ID");
  const transportProfile = validateTransportProfile(input.transportProfile);
  if (transportProfile.deviceId !== input.mainDeviceId) {
    throw new WorkerRuntimeError(
      "INVALID_CONFIGURATION",
      "The Transport Profile must target the configured Main Device.",
    );
  }
  if (
    !Number.isSafeInteger(input.maxOutboxEntries) ||
    input.maxOutboxEntries < 2 ||
    input.maxOutboxEntries > 1_000_000
  ) {
    throw new WorkerRuntimeError(
      "INVALID_CONFIGURATION",
      "Outbox capacity must be a safe integer between 2 and 1,000,000.",
    );
  }
  if (
    !Number.isSafeInteger(input.cancelGraceMs) ||
    input.cancelGraceMs < 0 ||
    input.cancelGraceMs > 300_000
  ) {
    throw new WorkerRuntimeError(
      "INVALID_CONFIGURATION",
      "Cancellation grace must be a safe integer between 0 and 300,000 milliseconds.",
    );
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: input.deviceId,
    workerId: input.workerId,
    mainDeviceId: input.mainDeviceId,
    transportProfile,
    maxOutboxEntries: input.maxOutboxEntries,
    cancelGraceMs: input.cancelGraceMs,
  };
}

export function parseWorkerAssignmentMessage(input: unknown): WorkerAssignmentMessageV1 {
  const envelope = parseApplicationRequestEnvelope(input);
  if (envelope.type !== "worker.run.assign") {
    throw new WorkerRuntimeError("INVALID_MESSAGE", "Expected a Worker Run assignment.");
  }
  const payload = envelope.payload;
  assertRecord(payload, "Run assignment payload");
  const workOrder = parseWorkOrder(payload["workOrder"]);
  const assignment: WorkerRunAssignmentV1 = {
    taskId: readIdentifier(payload, "taskId"),
    workOrder,
    deviceId: readIdentifier(payload, "deviceId"),
    workerId: readIdentifier(payload, "workerId"),
    routeId: readIdentifier(payload, "routeId"),
    runId: readIdentifier(payload, "runId"),
    leaseId: readIdentifier(payload, "leaseId"),
    fencingToken: readPositiveInteger(payload, "fencingToken"),
    leaseExpiresAtMs: readNonNegativeInteger(payload, "leaseExpiresAtMs"),
  };

  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    messageId: envelope.messageId,
    senderDeviceId: envelope.senderDeviceId,
    correlationId: envelope.correlationId,
    createdAt: envelope.createdAt,
    idempotencyKey: envelope.idempotencyKey,
    type: "worker.run.assign",
    payload: Object.freeze(assignment),
  });
}

export function assignmentFingerprint(message: WorkerAssignmentMessageV1): string {
  return createHash("sha256").update(canonicalJson(message)).digest("hex");
}

export function configurationFingerprint(configuration: WorkerConfiguration): string {
  return createHash("sha256").update(canonicalJson(configuration)).digest("hex");
}

export type WorkerRuntimeErrorCode =
  | "CLOCK_REGRESSION"
  | "CONCURRENT_STATE_UPDATE"
  | "CONFIGURATION_MISMATCH"
  | "INVALID_ACK"
  | "INVALID_CONFIGURATION"
  | "INVALID_MESSAGE"
  | "INVALID_RUNTIME_PATH"
  | "REPOSITORY_CLOSED"
  | "STATE_CORRUPT";

export class WorkerRuntimeError extends Error {
  public readonly code: WorkerRuntimeErrorCode;

  public constructor(code: WorkerRuntimeErrorCode, message: string) {
    super(message);
    this.name = "WorkerRuntimeError";
    this.code = code;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", `${label} must be an object.`);
  }
}

function assertConfigurationRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", `${label} must be an object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new WorkerRuntimeError(
      "INVALID_CONFIGURATION",
      `${label} contains an unsupported field.`,
    );
  }
}

function validateTransportProfile(value: unknown): TransportProfile {
  assertConfigurationRecord(value, "Transport Profile");
  assertExactKeys(value, TRANSPORT_PROFILE_KEYS, "Transport Profile");
  const deviceId = value["deviceId"];
  assertConfigurationIdentifier(deviceId, "Transport Profile Device ID");
  const rawEndpoints = value["endpoints"];
  if (!Array.isArray(rawEndpoints) || rawEndpoints.length === 0 || rawEndpoints.length > 64) {
    throw new WorkerRuntimeError(
      "INVALID_CONFIGURATION",
      "Transport Profile endpoints must contain between 1 and 64 entries.",
    );
  }
  const endpointIds = new Set<string>();
  const endpoints = rawEndpoints.map((rawEndpoint, index) => {
    assertConfigurationRecord(rawEndpoint, `Transport endpoint ${index}`);
    assertExactKeys(rawEndpoint, TRANSPORT_ENDPOINT_KEYS, `Transport endpoint ${index}`);
    const endpointId = rawEndpoint["endpointId"];
    const label = rawEndpoint["label"];
    const credentialRef = rawEndpoint["credentialRef"];
    assertConfigurationIdentifier(endpointId, `Transport endpoint ${index} ID`);
    assertConfigurationIdentifier(label, `Transport endpoint ${index} label`);
    assertConfigurationIdentifier(
      credentialRef,
      `Transport endpoint ${index} credential reference`,
    );
    if (endpointIds.has(endpointId)) {
      throw new WorkerRuntimeError(
        "INVALID_CONFIGURATION",
        "Transport endpoint IDs must be unique.",
      );
    }
    endpointIds.add(endpointId);
    const kind = rawEndpoint["kind"];
    if (kind !== "https" && kind !== "wss") {
      throw new WorkerRuntimeError(
        "INVALID_CONFIGURATION",
        "Transport endpoint kind must be https or wss.",
      );
    }
    const url = rawEndpoint["url"];
    if (typeof url !== "string" || url !== url.trim() || url.length > 2_048) {
      throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Transport endpoint URL is invalid.");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new WorkerRuntimeError(
        "INVALID_CONFIGURATION",
        "Transport endpoint URL must be absolute.",
      );
    }
    const expectedProtocol = kind === "https" ? "https:" : "wss:";
    if (
      parsed.protocol !== expectedProtocol ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new WorkerRuntimeError(
        "INVALID_CONFIGURATION",
        "Transport endpoint URL must match its kind and contain no credentials, query, or fragment.",
      );
    }
    return Object.freeze({
      endpointId,
      label,
      kind,
      url,
      credentialRef,
    });
  });
  return Object.freeze({
    deviceId,
    endpoints: Object.freeze(endpoints),
  });
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", `${label} is invalid.`);
  }
}

function assertConfigurationIdentifier(value: unknown, label: string): asserts value is string {
  try {
    assertIdentifier(value, label);
  } catch {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", `${label} is invalid.`);
  }
}

function readIdentifier(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  assertIdentifier(value, key);
  return value;
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", `${key} must be a positive safe integer.`);
  }
  return value as number;
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_JAVASCRIPT_DATE_MS
  ) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", `${key} must be a non-negative safe integer.`);
  }
  return value as number;
}
