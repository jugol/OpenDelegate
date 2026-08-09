import { createHash } from "node:crypto";

import {
  PROTOCOL_VERSION,
  parseApplicationRequestEnvelope,
  parseWorkerAgentSessionObservation,
  parseWorkerAgentRequirement,
  parseWorkOrder,
  validateTaskContinuationCheckpoint,
  type SequencedWorkerEventV1,
  type WorkerOutboundEventTypeV1,
  type WorkerOutboundEventV1,
  type WorkerAgentSessionObservationV1,
  type WorkerProviderUsageV1,
  type WorkerRunAssignmentV1,
  type WorkerRunIdentityV1,
} from "@opendelegate/protocol";
import {
  transportProfileRevision,
  type TransportAttemptTrace,
  type TransportEndpointKind,
  type TransportProfile,
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

export type WorkerRunSteeringRequesterV1 = "main-agent" | "owner";

export interface WorkerRunSteeringCommandV1 extends WorkerRunIdentityV1 {
  readonly requestId: string;
  readonly instruction: string;
  readonly requestedBy: WorkerRunSteeringRequesterV1;
  /**
   * Safe Main-visible identity of the exact active native session. Device-local
   * session keys and paths deliberately have no representation here.
   */
  readonly agentSession: WorkerAgentSessionObservationV1;
}

export type WorkerRunSteeringReceiptStatusV1 =
  "accepted" | "outcome-unknown" | "queued" | "rejected";

export type WorkerRunSteeringReceiptReasonV1 =
  | "LIVE_STEERING_ACCEPTED"
  | "NEXT_RESUME_QUEUED"
  | "RUN_AUTHORITY_LOST"
  | "RUN_NOT_ACTIVE"
  | "RUN_SCOPE_MISMATCH"
  | "SESSION_NOT_ACTIVE"
  | "SESSION_SCOPE_MISMATCH"
  | "STEERING_FAILED"
  | "STEERING_OUTCOME_UNKNOWN"
  | "STEERING_UNAVAILABLE";

export interface WorkerRunSteeringReceiptV1 extends WorkerRunIdentityV1 {
  readonly requestId: string;
  readonly requestMessageId: string;
  readonly agentSession: WorkerAgentSessionObservationV1;
  readonly delivery: "live" | "next-resume" | "none";
  readonly status: WorkerRunSteeringReceiptStatusV1;
  readonly reasonCode: WorkerRunSteeringReceiptReasonV1;
  readonly decidedAtMs: number;
  readonly providerTurnId?: string;
}

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

export type WorkerCapabilityVerification =
  "detected" | "verified" | "degraded" | "unavailable" | "disabled";

export type WorkerCapabilityEvidenceSource =
  "agent-adapter" | "capability-probe" | "workspace-registry";

/**
 * A named, owner-actionable cause for a Capability being unusable.
 *
 * `session-helper-absent` means this Worker runs without the native service, so
 * no user-session helper exists and nothing on the Device is even attempting the
 * Capability. That is a state the owner can leave, and it reads identically to a
 * permanent limitation unless it is said out loud.
 */
export type WorkerCapabilityBlockerV1 = "session-helper-absent";

/**
 * A bounded, owner-actionable explanation for an Agent Adapter that is not
 * ready. Raw provider diagnostics stay on the Device because they can contain
 * local paths or provider output; this enum is safe to project through Main.
 */
export type WorkerAgentAdapterBlockerV1 =
  | "provider-home-unavailable"
  | "executable-unavailable"
  | "authentication-required"
  | "version-unsupported"
  | "platform-incompatible"
  | "probe-failed";

export interface WorkerSchedulingAgentAdapterV1 {
  readonly provider: "codex" | "claude" | "generic-command";
  readonly adapterId: string;
  readonly readiness: "ready" | "degraded" | "unavailable";
  readonly compatibility: "tested" | "compatible" | "untested" | "incompatible";
  readonly blockedBy?: WorkerAgentAdapterBlockerV1;
  readonly version?: string;
  /**
   * The upgrade that would make this adapter usable, when the Device has one.
   * Carrying it lets the owner act on an untested version from Admin Web instead
   * of reading a status with no remedy attached.
   */
  readonly availableUpgrade?: {
    readonly packageName: string;
    readonly targetVersion: string;
  };
  readonly observedAtMs: number;
  readonly modelCatalogObservedAtMs?: number;
  readonly models?: readonly {
    readonly modelId: string;
    readonly displayName: string;
    readonly isDefault?: boolean;
    readonly supportedEfforts?: readonly string[];
  }[];
}

export interface WorkerSchedulingResourceLockV1 {
  readonly resourceName: string;
  readonly capacity: number;
  readonly holders: readonly {
    readonly taskId: string;
    readonly runId: string;
    readonly expiresAtMs: number;
  }[];
}

export type WorkerHardwareFactSource = "node-os" | "platform-probe";
export type WorkerHardwareFactVerification = "not-observed" | "observed" | "verified";

export interface WorkerSchedulingHardwareFactsV1 {
  readonly cpu: {
    readonly model: string;
    readonly logicalCoreCount: number;
    readonly observedAtMs: number;
    readonly source: WorkerHardwareFactSource;
    readonly verification: Exclude<WorkerHardwareFactVerification, "not-observed">;
  };
  readonly memory: {
    readonly totalBytes: number;
    readonly observedAtMs: number;
    readonly source: WorkerHardwareFactSource;
    readonly verification: Exclude<WorkerHardwareFactVerification, "not-observed">;
  };
  readonly gpu: {
    readonly devices: readonly {
      readonly model: string;
      readonly vendor?: string;
      readonly memoryBytes?: number;
    }[];
    readonly observedAtMs: number;
    readonly source: WorkerHardwareFactSource;
    readonly verification: WorkerHardwareFactVerification;
  };
}

/**
 * Scheduling-safe metadata that may cross the Device boundary. It deliberately
 * excludes local Workspace paths, Knowledge names/content, credentials, and raw
 * route diagnostics.
 */
export interface WorkerSchedulingInventoryV1 {
  readonly deviceName: string;
  readonly osFamily: "linux" | "macos" | "windows";
  readonly platformRelease: string;
  readonly architecture: string;
  readonly serviceMode: "foreground" | "system-service" | "user-service";
  /**
   * Bounded hardware observations contain descriptive values only. Device-local
   * paths, serial numbers, bus identifiers, driver paths, and raw probe output
   * have no representation in this contract.
   */
  readonly hardware?: WorkerSchedulingHardwareFactsV1;
  /**
   * Coarse Device-local service health only. Knowledge document names,
   * references, search terms, paths, and contents never cross this boundary.
   */
  readonly knowledgeHealth?: "healthy" | "degraded" | "unavailable";
  /**
   * Sanitized Device-local observation only. It intentionally carries no MAC
   * address, interface name, SecureOn value, or raw platform output.
   */
  readonly wakeOnLan?: WorkerWakeOnLanObservationV1;
  readonly maximumConcurrentRuns: number;
  readonly capabilities: readonly {
    readonly name: string;
    readonly verification: WorkerCapabilityVerification;
    readonly observedAtMs?: number;
    readonly evidenceSource?: WorkerCapabilityEvidenceSource;
    readonly version?: string;
    /**
     * What is holding the Capability back, when this Device knows a cause the
     * owner can act on. Absent when the Capability works, or when the cause is
     * transient enough that naming it would only mislead.
     */
    readonly blockedBy?: WorkerCapabilityBlockerV1;
  }[];
  readonly agentAdapters?: readonly WorkerSchedulingAgentAdapterV1[];
  readonly resourceLocks?: readonly WorkerSchedulingResourceLockV1[];
  readonly workspaceIds: readonly string[];
  readonly availableSecretRefs: readonly string[];
}

export type WorkerWakeOnLanTargetStateV1 = "enabled" | "disabled" | "unsupported" | "unknown";

export type WorkerWakeOnLanProbeSourceV1 =
  "windows-netadapter-power" | "macos-pmset" | "linux-ethtool" | "probe-unavailable";

export interface WorkerWakeOnLanObservationV1 {
  readonly state: WorkerWakeOnLanTargetStateV1;
  readonly source: WorkerWakeOnLanProbeSourceV1;
  readonly observedAtMs: number;
}

export interface WorkerSchedulingInventoryProvider {
  snapshot(): WorkerSchedulingInventoryV1 | Promise<WorkerSchedulingInventoryV1>;
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
  readonly inventory?: WorkerSchedulingInventoryV1;
  /**
   * Redacted Transport Profile projection. Route IDs and labels are generated
   * from ordinal position and the opaque profile revision; configured endpoint
   * IDs, labels, URLs, hosts, ports, credentials, and diagnostics never cross.
   */
  readonly routes?: readonly {
    readonly routeId: string;
    readonly label: string;
    readonly priority: number;
    readonly kind: TransportEndpointKind;
    readonly profileRevision: `sha256:${string}`;
    readonly health: "healthy" | "unknown";
    readonly lastAttempt?: {
      readonly probeSource: "live";
      readonly outcome: "connected";
      readonly observedAtMs: number;
    };
  }[];
  /**
   * Active Run scheduling projection. Main authority fields such as lease IDs
   * and fencing tokens remain excluded.
   */
  readonly currentRuns?: readonly {
    readonly taskId: string;
    readonly workOrderId: string;
    readonly runId: string;
    readonly state: "starting" | "running" | "cancelling";
    readonly acceptedAtMs: number;
    readonly leaseExpiresAtMs: number;
    /**
     * Present only after the active adapter has exposed and durably bound its
     * safe native-session identity.
     */
    readonly agentSession?: WorkerAgentSessionObservationV1;
  }[];
}

export type RunProcessOutcome =
  | {
      readonly status: "failed";
      readonly report: string;
      readonly diagnostic?: unknown;
      readonly usage?: WorkerProviderUsageV1;
      readonly agentSession?: WorkerAgentSessionObservationV1;
    }
  | {
      readonly status: "succeeded";
      readonly report: string;
      readonly artifactIds: readonly string[];
      readonly usage?: WorkerProviderUsageV1;
      readonly agentSession?: WorkerAgentSessionObservationV1;
    };

export interface RunProcess {
  readonly completion: Promise<RunProcessOutcome>;
  currentAgentSession?(): WorkerAgentSessionObservationV1 | undefined;
  steer?(request: {
    readonly requestId: string;
    readonly instruction: string;
    readonly requestedBy: WorkerRunSteeringRequesterV1;
    readonly agentSession: WorkerAgentSessionObservationV1;
    isCommandCurrent(): Promise<boolean>;
  }): Promise<{
    readonly delivery: "live" | "next-resume";
    readonly agentSession: WorkerAgentSessionObservationV1;
    readonly providerTurnId?: string;
  }>;
  requestCancel(): Promise<void>;
  forceTerminate(): Promise<void>;
}

/**
 * Closed, owner-safe progress vocabulary. Provider prose is classified on the
 * Device and must never cross the Worker runtime boundary as progress text.
 */
export type WorkerRunProgressKindV1 =
  "consulting-knowledge" | "delegating" | "using-tools" | "verifying" | "working";

export interface RunExecutionContext {
  readonly assignment: WorkerRunAssignmentV1;
  readonly leaseAuthority: WorkerRunLeaseAuthority;
  isLeaseCurrent(): Promise<boolean>;
  /**
   * Emits one presentation-only progress category. The Worker runtime owns the
   * public wording and applies its lease, deduplication, rate, count, and outbox
   * bounds before any event can leave this Device.
   */
  reportProgress?(input: { readonly kind: WorkerRunProgressKindV1 }): Promise<void>;
}

export interface WorkerRunLeaseSnapshot {
  readonly leaseExpiresAtMs: number;
  readonly conservativeDeadlineMonotonicMs: number;
}

/**
 * Device-local view of one exact Main-issued Run authority. Implementations
 * convert Main wall-clock expiries into a conservative monotonic deadline and
 * may renew only that exact Run/Worker/fence/prior-expiry tuple.
 */
export interface WorkerRunLeaseAuthority {
  snapshot(): WorkerRunLeaseSnapshot;
  isCurrent(): boolean | Promise<boolean>;
  renewIfDue(): Promise<void>;
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
  /**
   * Production Device channels persist this frame before sending it. The method
   * remains optional for narrow test and extension transports; Worker keeps the
   * incident pending until a connection implements the durable bridge.
   */
  sendRouteIncident?(incident: WorkerRouteIncidentV1): Promise<void>;
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

export type WorkerRouteIncidentOutcome = Exclude<TransportAttemptTrace["outcome"], "connected">;

export type WorkerRouteIncidentCode =
  | "CERTIFICATE_EXPIRED"
  | "EAI_AGAIN"
  | "ECONNREFUSED"
  | "ECONNRESET"
  | "EHOSTUNREACH"
  | "ENETUNREACH"
  | "ETIMEDOUT"
  | "PEER_IDENTITY_MISMATCH"
  | "TLS_HANDSHAKE_FAILED"
  | "TRANSPORT_BOUNDARY_ERROR"
  | "UNABLE_TO_VERIFY_LEAF_SIGNATURE";

export interface WorkerRouteIncidentAttemptV1 {
  readonly attemptIndex: number;
  readonly kind: TransportEndpointKind;
  readonly outcome: WorkerRouteIncidentOutcome;
  readonly code?: WorkerRouteIncidentCode;
}

/**
 * The only route-exhaustion document allowed to cross the Worker boundary.
 * Endpoint identity, label, URL, host, port, credential references, arbitrary
 * diagnostics, timestamps, paths, and stacks have no fields in this contract.
 */
export interface WorkerRouteIncidentV1 {
  readonly incidentId: `sha256:${string}`;
  readonly profileRevision: `sha256:${string}`;
  readonly fingerprint: `sha256:${string}`;
  readonly attempts: readonly WorkerRouteIncidentAttemptV1[];
}

const WORKER_ROUTE_INCIDENT_CODES = new Set<WorkerRouteIncidentCode>([
  "CERTIFICATE_EXPIRED",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "PEER_IDENTITY_MISMATCH",
  "TLS_HANDSHAKE_FAILED",
  "TRANSPORT_BOUNDARY_ERROR",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const WORKER_ROUTE_INCIDENT_OUTCOMES = new Set<WorkerRouteIncidentOutcome>([
  "authentication-rejected",
  "connect-failed",
  "identity-rejected",
  "probe-unhealthy",
  "skipped-incompatible",
]);
const SHA256_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

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
export const MAX_WORKER_STEERING_INSTRUCTION_BYTES = 64 * 1024;

export type {
  SequencedWorkerEventV1,
  WorkerOutboundEventTypeV1,
  WorkerOutboundEventV1,
  WorkerRunAssignmentV1,
  WorkerRunIdentityV1,
};

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
  assertMessageExactKeys(
    payload,
    [
      "taskId",
      "workOrder",
      "deviceId",
      "workerId",
      "routeId",
      "runId",
      "leaseId",
      "fencingToken",
      "leaseExpiresAtMs",
    ],
    ["agentRequirement", "continuationCheckpoint"],
    "Run assignment payload",
  );
  const workOrder = parseWorkOrder(payload["workOrder"]);
  let agentRequirement;
  let continuationCheckpoint;
  try {
    agentRequirement =
      payload["agentRequirement"] === undefined
        ? undefined
        : parseWorkerAgentRequirement(payload["agentRequirement"]);
    continuationCheckpoint =
      payload["continuationCheckpoint"] === undefined
        ? undefined
        : validateTaskContinuationCheckpoint(payload["continuationCheckpoint"]);
  } catch {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "Agent requirement or continuation checkpoint is invalid.",
    );
  }
  if (
    workOrder.requiredAgent !== undefined &&
    (agentRequirement === undefined ||
      JSON.stringify(agentRequirement) !== JSON.stringify(workOrder.requiredAgent))
  ) {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "The Run assignment does not preserve its Work Order Agent requirement.",
    );
  }
  const taskId = readIdentifier(payload, "taskId");
  if (
    continuationCheckpoint !== undefined &&
    (continuationCheckpoint.taskId !== taskId ||
      !continuationCheckpoint.pendingWorkOrders.some(
        (candidate) => candidate.workOrderId === workOrder.workOrderId,
      ))
  ) {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "The continuation checkpoint does not bind this Task and Work Order.",
    );
  }
  const assignment: WorkerRunAssignmentV1 = {
    taskId,
    workOrder,
    ...(continuationCheckpoint === undefined ? {} : { continuationCheckpoint }),
    ...(agentRequirement === undefined ? {} : { agentRequirement }),
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

export function validateWorkerRunSteeringCommand(
  input: WorkerRunSteeringCommandV1,
): WorkerRunSteeringCommandV1 {
  assertRecord(input, "Run steering command");
  assertMessageExactKeys(
    input,
    [
      "requestId",
      "taskId",
      "workOrderId",
      "deviceId",
      "workerId",
      "routeId",
      "runId",
      "leaseId",
      "fencingToken",
      "instruction",
      "requestedBy",
      "agentSession",
    ],
    [],
    "Run steering command",
  );
  const instruction = input["instruction"];
  if (
    typeof instruction !== "string" ||
    instruction.trim().length === 0 ||
    instruction.includes("\0") ||
    Buffer.byteLength(instruction, "utf8") > MAX_WORKER_STEERING_INSTRUCTION_BYTES
  ) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", "Run steering instruction is invalid.");
  }
  const requestedBy = input["requestedBy"];
  if (requestedBy !== "main-agent" && requestedBy !== "owner") {
    throw new WorkerRuntimeError("INVALID_MESSAGE", "Run steering requester is invalid.");
  }
  let agentSession: WorkerAgentSessionObservationV1;
  try {
    agentSession = parseWorkerAgentSessionObservation(input["agentSession"]);
  } catch {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "Run steering native-session scope is invalid.",
    );
  }
  return Object.freeze({
    requestId: readIdentifier(input, "requestId"),
    taskId: readIdentifier(input, "taskId"),
    workOrderId: readIdentifier(input, "workOrderId"),
    deviceId: readIdentifier(input, "deviceId"),
    workerId: readIdentifier(input, "workerId"),
    routeId: readIdentifier(input, "routeId"),
    runId: readIdentifier(input, "runId"),
    leaseId: readIdentifier(input, "leaseId"),
    fencingToken: readPositiveInteger(input, "fencingToken"),
    instruction,
    requestedBy,
    agentSession,
  });
}

export function workerRunSteeringCommandFingerprint(
  input: WorkerRunSteeringCommandV1,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(validateWorkerRunSteeringCommand(input)), "utf8")
    .digest("hex")}`;
}

export function validateWorkerRunSteeringReceipt(
  input: WorkerRunSteeringReceiptV1,
): WorkerRunSteeringReceiptV1 {
  assertRecord(input, "Run steering receipt");
  assertMessageExactKeys(
    input,
    [
      "requestId",
      "requestMessageId",
      "taskId",
      "workOrderId",
      "deviceId",
      "workerId",
      "routeId",
      "runId",
      "leaseId",
      "fencingToken",
      "agentSession",
      "delivery",
      "status",
      "reasonCode",
      "decidedAtMs",
    ],
    ["providerTurnId"],
    "Run steering receipt",
  );
  const delivery = input["delivery"];
  const status = input["status"];
  const reasonCode = input["reasonCode"];
  const reasonCodes = new Set<WorkerRunSteeringReceiptReasonV1>([
    "LIVE_STEERING_ACCEPTED",
    "NEXT_RESUME_QUEUED",
    "RUN_AUTHORITY_LOST",
    "RUN_NOT_ACTIVE",
    "RUN_SCOPE_MISMATCH",
    "SESSION_NOT_ACTIVE",
    "SESSION_SCOPE_MISMATCH",
    "STEERING_FAILED",
    "STEERING_OUTCOME_UNKNOWN",
    "STEERING_UNAVAILABLE",
  ]);
  if (
    (delivery !== "live" && delivery !== "next-resume" && delivery !== "none") ||
    (status !== "accepted" &&
      status !== "outcome-unknown" &&
      status !== "queued" &&
      status !== "rejected") ||
    !reasonCodes.has(reasonCode as WorkerRunSteeringReceiptReasonV1) ||
    (status === "accepted" && (delivery !== "live" || reasonCode !== "LIVE_STEERING_ACCEPTED")) ||
    (status === "queued" && (delivery !== "next-resume" || reasonCode !== "NEXT_RESUME_QUEUED")) ||
    (status === "outcome-unknown" &&
      (delivery !== "none" || reasonCode !== "STEERING_OUTCOME_UNKNOWN")) ||
    (status === "rejected" &&
      (delivery !== "none" ||
        reasonCode === "LIVE_STEERING_ACCEPTED" ||
        reasonCode === "NEXT_RESUME_QUEUED" ||
        reasonCode === "STEERING_OUTCOME_UNKNOWN"))
  ) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", "Run steering receipt outcome is invalid.");
  }
  let agentSession: WorkerAgentSessionObservationV1;
  try {
    agentSession = parseWorkerAgentSessionObservation(input["agentSession"]);
  } catch {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "Run steering receipt native-session scope is invalid.",
    );
  }
  const providerTurnId = input["providerTurnId"];
  if (providerTurnId !== undefined) {
    assertIdentifier(providerTurnId, "providerTurnId");
    if (status !== "accepted") {
      throw new WorkerRuntimeError(
        "INVALID_MESSAGE",
        "Only accepted live steering may expose a provider turn ID.",
      );
    }
  }
  return Object.freeze({
    requestId: readIdentifier(input, "requestId"),
    requestMessageId: readIdentifier(input, "requestMessageId"),
    taskId: readIdentifier(input, "taskId"),
    workOrderId: readIdentifier(input, "workOrderId"),
    deviceId: readIdentifier(input, "deviceId"),
    workerId: readIdentifier(input, "workerId"),
    routeId: readIdentifier(input, "routeId"),
    runId: readIdentifier(input, "runId"),
    leaseId: readIdentifier(input, "leaseId"),
    fencingToken: readPositiveInteger(input, "fencingToken"),
    agentSession,
    delivery,
    status,
    reasonCode: reasonCode as WorkerRunSteeringReceiptReasonV1,
    decidedAtMs: readNonNegativeInteger(input, "decidedAtMs"),
    ...(providerTurnId === undefined ? {} : { providerTurnId }),
  });
}

export function configurationFingerprint(configuration: WorkerConfiguration): string {
  return createHash("sha256").update(canonicalJson(configuration)).digest("hex");
}

export function createWorkerRouteIncident(input: {
  readonly profile: TransportProfile;
  readonly attempts: readonly TransportAttemptTrace[];
  readonly occurrenceSeed: string;
}): WorkerRouteIncidentV1 {
  if (
    typeof input.occurrenceSeed !== "string" ||
    input.occurrenceSeed.length === 0 ||
    input.occurrenceSeed.length > 1_024
  ) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", "Route incident occurrence seed is invalid.");
  }
  const profileRevision = transportProfileRevision(input.profile);
  const attempts = Object.freeze(
    input.attempts.map((attempt, attemptIndex) =>
      sanitizeRouteIncidentAttempt(attempt, attemptIndex),
    ),
  );
  if (attempts.length === 0 || attempts.length > 64) {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "Route exhaustion must contain between 1 and 64 bounded attempts.",
    );
  }
  const fingerprint = workerRouteIncidentFingerprint(profileRevision, attempts);
  const incidentId = `sha256:${createHash("sha256")
    .update(canonicalJson([fingerprint, input.occurrenceSeed]), "utf8")
    .digest("hex")}` as const;
  return Object.freeze({
    incidentId,
    profileRevision,
    fingerprint,
    attempts,
  });
}

export function workerRouteIncidentFingerprint(
  profileRevision: `sha256:${string}`,
  attempts: readonly WorkerRouteIncidentAttemptV1[],
): `sha256:${string}` {
  assertSha256Identifier(profileRevision, "Transport Profile revision");
  const validatedAttempts = validateRouteIncidentAttempts(attempts);
  return `sha256:${createHash("sha256")
    .update(canonicalJson([profileRevision, validatedAttempts]), "utf8")
    .digest("hex")}`;
}

export function validateWorkerRouteIncident(input: WorkerRouteIncidentV1): WorkerRouteIncidentV1 {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", "Route incident must be an object.");
  }
  const record = input as unknown as Record<string, unknown>;
  const allowedKeys = new Set(["incidentId", "profileRevision", "fingerprint", "attempts"]);
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    !Object.keys(record).every((key) => allowedKeys.has(key)) ||
    Object.keys(record).length !== allowedKeys.size
  ) {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "Route incident contains an unsupported or missing field.",
    );
  }
  assertSha256Identifier(record["incidentId"], "Route incident ID");
  assertSha256Identifier(record["profileRevision"], "Transport Profile revision");
  assertSha256Identifier(record["fingerprint"], "Route incident fingerprint");
  if (!Array.isArray(record["attempts"])) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", "Route incident attempts must be an array.");
  }
  const attempts = validateRouteIncidentAttempts(
    record["attempts"] as readonly WorkerRouteIncidentAttemptV1[],
  );
  const expectedFingerprint = workerRouteIncidentFingerprint(
    record["profileRevision"] as `sha256:${string}`,
    attempts,
  );
  if (record["fingerprint"] !== expectedFingerprint) {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "Route incident fingerprint does not match its bounded evidence.",
    );
  }
  return Object.freeze({
    incidentId: record["incidentId"] as `sha256:${string}`,
    profileRevision: record["profileRevision"] as `sha256:${string}`,
    fingerprint: expectedFingerprint,
    attempts,
  });
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

function sanitizeRouteIncidentAttempt(
  attempt: TransportAttemptTrace,
  attemptIndex: number,
): WorkerRouteIncidentAttemptV1 {
  if (attempt.kind !== "https" && attempt.kind !== "wss") {
    throw new WorkerRuntimeError("INVALID_MESSAGE", "Route incident transport kind is invalid.");
  }
  if (!WORKER_ROUTE_INCIDENT_OUTCOMES.has(attempt.outcome as WorkerRouteIncidentOutcome)) {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "A connected route cannot appear in an exhaustion incident.",
    );
  }
  const diagnostic =
    attempt.diagnostic !== null &&
    typeof attempt.diagnostic === "object" &&
    !Array.isArray(attempt.diagnostic)
      ? (attempt.diagnostic as Readonly<Record<string, unknown>>)
      : undefined;
  const code = diagnostic?.["code"];
  return Object.freeze({
    attemptIndex,
    kind: attempt.kind,
    outcome: attempt.outcome as WorkerRouteIncidentOutcome,
    ...(typeof code === "string" && WORKER_ROUTE_INCIDENT_CODES.has(code as WorkerRouteIncidentCode)
      ? { code: code as WorkerRouteIncidentCode }
      : {}),
  });
}

function validateRouteIncidentAttempts(
  input: readonly WorkerRouteIncidentAttemptV1[],
): readonly WorkerRouteIncidentAttemptV1[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw new WorkerRuntimeError(
      "INVALID_MESSAGE",
      "Route incident attempts must contain between 1 and 64 entries.",
    );
  }
  return Object.freeze(
    input.map((attempt, attemptIndex) => {
      if (attempt === null || typeof attempt !== "object" || Array.isArray(attempt)) {
        throw new WorkerRuntimeError("INVALID_MESSAGE", "Route incident attempt is invalid.");
      }
      const record = attempt as unknown as Record<string, unknown>;
      const keys = Object.keys(record);
      if (
        keys.some(
          (key) => key !== "attemptIndex" && key !== "kind" && key !== "outcome" && key !== "code",
        ) ||
        !Object.prototype.hasOwnProperty.call(record, "attemptIndex") ||
        !Object.prototype.hasOwnProperty.call(record, "kind") ||
        !Object.prototype.hasOwnProperty.call(record, "outcome") ||
        record["attemptIndex"] !== attemptIndex ||
        (record["kind"] !== "https" && record["kind"] !== "wss") ||
        !WORKER_ROUTE_INCIDENT_OUTCOMES.has(record["outcome"] as WorkerRouteIncidentOutcome) ||
        (record["code"] !== undefined &&
          (typeof record["code"] !== "string" ||
            !WORKER_ROUTE_INCIDENT_CODES.has(record["code"] as WorkerRouteIncidentCode)))
      ) {
        throw new WorkerRuntimeError(
          "INVALID_MESSAGE",
          "Route incident attempt is outside the bounded diagnostic contract.",
        );
      }
      return Object.freeze({
        attemptIndex,
        kind: record["kind"] as TransportEndpointKind,
        outcome: record["outcome"] as WorkerRouteIncidentOutcome,
        ...(record["code"] === undefined
          ? {}
          : { code: record["code"] as WorkerRouteIncidentCode }),
      });
    }),
  );
}

function assertSha256Identifier(
  value: unknown,
  label: string,
): asserts value is `sha256:${string}` {
  if (typeof value !== "string" || !SHA256_ID_PATTERN.test(value)) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", `${label} is invalid.`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", `${label} must be an object.`);
  }
}

function assertMessageExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", `${label} has an invalid field set.`);
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
