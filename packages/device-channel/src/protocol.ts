import {
  PROTOCOL_VERSION,
  parseArtifactUploadGrant,
  parseWorkerAgentRequirement,
  parseWorkerAgentSessionObservation,
  parseWorkOrder,
  validateTaskContinuationCheckpoint,
  type ArtifactUploadGrantV1,
  type RedactedDiagnosticV1,
} from "@opendelegate/protocol";
import type {
  SequencedWorkerEventV1,
  WorkerControlActionV1,
  WorkerHeartbeatV1,
  WorkerOutboxAckV1,
  WorkerRouteIncidentV1,
  WorkerRunAssignmentV1,
  WorkerRunSteeringCommandV1,
  WorkerRunSteeringReceiptV1,
} from "@opendelegate/worker-runtime";
import {
  validateWorkerRouteIncident,
  validateWorkerRunSteeringCommand,
  validateWorkerRunSteeringReceipt,
} from "@opendelegate/worker-runtime";

export const DEVICE_CHANNEL_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const MAX_DEVICE_CHANNEL_FRAME_BYTES = 1_048_576;
const MAX_BATCH_ITEMS = 256;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_TEXT_BYTES = 262_144;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

export type DeviceChannelDirection = "main-to-worker" | "worker-to-main";
export type WorkerToMainMessageType =
  | "worker.ack"
  | "worker.action.authorize"
  | "worker.action.consume"
  | "worker.artifact.prepare"
  | "worker.events"
  | "worker.heartbeat"
  | "worker.hello"
  | "worker.route.incident"
  | "worker.run.renew"
  | "worker.run.steering"
  | "worker.pong";
export type MainToWorkerMessageType =
  | "main.ack"
  | "main.action.authorization"
  | "main.action.consumption"
  | "main.artifact.grant"
  | "main.artifact.rejected"
  | "main.control"
  | "main.dispatch"
  | "main.ping"
  | "main.revoked"
  | "main.run.lease"
  | "main.run.steer"
  | "main.welcome";
export type DeviceChannelMessageType = MainToWorkerMessageType | WorkerToMainMessageType;

interface DeviceChannelEnvelopeV1<TType extends DeviceChannelMessageType, TPayload> {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly messageId: string;
  readonly senderDeviceId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly sequence: number;
  readonly type: TType;
  readonly payload: TPayload;
}

export type WorkerHelloFrameV1 = DeviceChannelEnvelopeV1<
  "worker.hello",
  {
    readonly deviceId: string;
    readonly workerId: string;
    readonly certificateGeneration: number;
    readonly minimumProtocolVersion: typeof PROTOCOL_VERSION;
    readonly maximumProtocolVersion: typeof PROTOCOL_VERSION;
    readonly acknowledgedMainSequence: number;
    readonly workerWallSentAtMs: number;
  }
>;
export type WorkerHeartbeatFrameV1 = DeviceChannelEnvelopeV1<"worker.heartbeat", WorkerHeartbeatV1>;
export type WorkerEventsFrameV1 = DeviceChannelEnvelopeV1<
  "worker.events",
  {
    readonly events: readonly SequencedWorkerEventV1[];
  }
>;
export type WorkerRouteIncidentFrameV1 = DeviceChannelEnvelopeV1<
  "worker.route.incident",
  WorkerRouteIncidentV1
>;
export type WorkerAckFrameV1 = DeviceChannelEnvelopeV1<
  "worker.ack",
  {
    readonly acknowledgedMainSequence: number;
    readonly acknowledgedMessageIds: readonly string[];
  }
>;
export type WorkerPongFrameV1 = DeviceChannelEnvelopeV1<
  "worker.pong",
  {
    readonly pingId: string;
    readonly observedAtMs: number;
  }
>;
export interface WorkerRunLeaseRenewalRequestV1 {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly renewalId: string;
  readonly priorLeaseExpiresAtMs: number;
}
export type WorkerRunLeaseRenewFrameV1 = DeviceChannelEnvelopeV1<
  "worker.run.renew",
  WorkerRunLeaseRenewalRequestV1
>;
export type WorkerRunSteeringReceiptFrameV1 = DeviceChannelEnvelopeV1<
  "worker.run.steering",
  WorkerRunSteeringReceiptV1
>;
export type ArtifactPresentationRequestV1 =
  "download" | "inline" | "interactive-html" | "static-html";
export interface ArtifactPrepareManifestV1 {
  readonly artifactId: string;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly declaredSizeBytes: number;
  readonly expectedSha256: string;
  readonly requestedPresentation?: ArtifactPresentationRequestV1;
}
export type WorkerArtifactPrepareFrameV1 = DeviceChannelEnvelopeV1<
  "worker.artifact.prepare",
  ArtifactPrepareManifestV1
>;
export interface WorkerActionAuthorizationRequestV1 {
  readonly authorizationRequestId: string;
  readonly actionCategory: string;
  readonly actionType: string;
  readonly actionFingerprint: `sha256:${string}`;
  readonly actionDescriptor: RedactedDiagnosticV1;
  readonly requestedAtMs: number;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs: number;
}
export type WorkerActionAuthorizeFrameV1 = DeviceChannelEnvelopeV1<
  "worker.action.authorize",
  WorkerActionAuthorizationRequestV1
>;
export interface WorkerActionConsumptionRequestV1 {
  readonly authorizationRequestId: string;
  readonly authorizationId: string;
  readonly actionCategory: string;
  readonly actionFingerprint: `sha256:${string}`;
  readonly requestedAtMs: number;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs: number;
}
export type WorkerActionConsumeFrameV1 = DeviceChannelEnvelopeV1<
  "worker.action.consume",
  WorkerActionConsumptionRequestV1
>;
export type MainWelcomeFrameV1 = DeviceChannelEnvelopeV1<
  "main.welcome",
  {
    readonly deviceId: string;
    readonly acceptedProtocolVersion: typeof PROTOCOL_VERSION;
    readonly acknowledgedWorkerSequence: number;
    readonly nextMainSequence: number;
    readonly heartbeatIntervalMs: number;
    readonly maximumInFlightFrames: number;
    readonly workerWallSentAtMs: number;
    readonly mainReceivedAtMs: number;
    readonly mainSentAtMs: number;
    readonly maximumHandshakeRttMs: number;
    readonly maximumAbsoluteClockSkewMs: number;
  }
>;
export type MainDispatchFrameV1 = DeviceChannelEnvelopeV1<"main.dispatch", WorkerRunAssignmentV1>;
export type MainControlFrameV1 = DeviceChannelEnvelopeV1<
  "main.control",
  {
    readonly action: WorkerControlActionV1;
    readonly reason: string;
    readonly runId?: string;
    readonly leaseId?: string;
    readonly fencingToken?: number;
  }
>;
export type MainAckFrameV1 = DeviceChannelEnvelopeV1<
  "main.ack",
  WorkerOutboxAckV1 & {
    readonly acknowledgedWorkerSequence: number;
  }
>;
export type MainPingFrameV1 = DeviceChannelEnvelopeV1<
  "main.ping",
  {
    readonly pingId: string;
    readonly deadlineAtMs: number;
  }
>;
export type MainRevokedFrameV1 = DeviceChannelEnvelopeV1<
  "main.revoked",
  {
    readonly reasonCode: "DEVICE_REVOKED";
  }
>;
export type MainRunLeaseFrameV1 = DeviceChannelEnvelopeV1<
  "main.run.lease",
  | (WorkerRunLeaseRenewalRequestV1 & {
      readonly requestMessageId: string;
      readonly status: "renewed";
      readonly renewedAtMs: number;
      readonly leaseExpiresAtMs: number;
    })
  | (WorkerRunLeaseRenewalRequestV1 & {
      readonly requestMessageId: string;
      readonly status: "rejected";
      readonly decidedAtMs: number;
      readonly reasonCode:
        | "RUN_LEASE_CHANGED"
        | "RUN_LEASE_EXPIRED"
        | "RUN_LEASE_NOT_DUE"
        | "RUN_NOT_ACTIVE"
        | "RUN_SCOPE_MISMATCH";
    })
>;
export type MainRunSteerFrameV1 = DeviceChannelEnvelopeV1<
  "main.run.steer",
  WorkerRunSteeringCommandV1
>;
export type MainArtifactGrantFrameV1 = DeviceChannelEnvelopeV1<
  "main.artifact.grant",
  {
    readonly requestMessageId: string;
    readonly deviceId: string;
    readonly grant: ArtifactUploadGrantV1;
  }
>;
export type ArtifactPrepareRejectionCodeV1 =
  "ARTIFACT_INVALID" | "POLICY_REJECTED" | "RUN_NOT_CURRENT" | "SERVICE_UNAVAILABLE";
export type MainArtifactRejectedFrameV1 = DeviceChannelEnvelopeV1<
  "main.artifact.rejected",
  {
    readonly requestMessageId: string;
    readonly deviceId: string;
    readonly artifactId: string;
    readonly code: ArtifactPrepareRejectionCodeV1;
    readonly retryable: boolean;
  }
>;
export type MainActionAuthorizationFrameV1 = DeviceChannelEnvelopeV1<
  "main.action.authorization",
  {
    readonly requestMessageId: string;
    readonly authorizationRequestId: string;
    readonly authorizationId: string;
    readonly actionFingerprint: `sha256:${string}`;
    readonly decision: "allow" | "deny" | "require-approval";
    readonly reasonCode: string;
  }
>;
export type MainActionConsumptionFrameV1 = DeviceChannelEnvelopeV1<
  "main.action.consumption",
  {
    readonly requestMessageId: string;
    readonly authorizationRequestId: string;
    readonly authorizationId: string;
    readonly actionFingerprint: `sha256:${string}`;
    readonly decision: "consumed" | "deny";
    readonly reasonCode: string;
  }
>;

export type WorkerToMainFrameV1 =
  | WorkerAckFrameV1
  | WorkerActionAuthorizeFrameV1
  | WorkerActionConsumeFrameV1
  | WorkerArtifactPrepareFrameV1
  | WorkerEventsFrameV1
  | WorkerHeartbeatFrameV1
  | WorkerHelloFrameV1
  | WorkerRouteIncidentFrameV1
  | WorkerRunLeaseRenewFrameV1
  | WorkerRunSteeringReceiptFrameV1
  | WorkerPongFrameV1;
export type MainToWorkerFrameV1 =
  | MainAckFrameV1
  | MainActionAuthorizationFrameV1
  | MainActionConsumptionFrameV1
  | MainArtifactGrantFrameV1
  | MainArtifactRejectedFrameV1
  | MainControlFrameV1
  | MainDispatchFrameV1
  | MainPingFrameV1
  | MainRevokedFrameV1
  | MainRunLeaseFrameV1
  | MainRunSteerFrameV1
  | MainWelcomeFrameV1;
export type DeviceChannelFrameV1 = MainToWorkerFrameV1 | WorkerToMainFrameV1;

export type DeviceChannelProtocolErrorCode =
  "FRAME_INVALID" | "FRAME_TOO_LARGE" | "MESSAGE_TYPE_FORBIDDEN" | "SENDER_IDENTITY_MISMATCH";

export class DeviceChannelProtocolError extends Error {
  public readonly code: DeviceChannelProtocolErrorCode;

  public constructor(code: DeviceChannelProtocolErrorCode, message: string) {
    super(message);
    this.name = "DeviceChannelProtocolError";
    this.code = code;
  }
}

export function decodeDeviceChannelFrame(
  bytes: Uint8Array | string,
  authenticatedSenderDeviceId: string,
  direction: DeviceChannelDirection,
): DeviceChannelFrameV1 {
  assertIdentifier(authenticatedSenderDeviceId, "authenticated Device ID");
  const encoded =
    typeof bytes === "string"
      ? Buffer.from(bytes, "utf8")
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_DEVICE_CHANNEL_FRAME_BYTES) {
    throw protocolError(
      encoded.byteLength > MAX_DEVICE_CHANNEL_FRAME_BYTES ? "FRAME_TOO_LARGE" : "FRAME_INVALID",
      "The Device channel frame is outside the supported size bound.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded.toString("utf8"));
  } catch {
    throw protocolError("FRAME_INVALID", "The Device channel frame is not valid JSON.");
  }
  const frame = parseEnvelope(parsed);
  if (frame.senderDeviceId !== authenticatedSenderDeviceId) {
    throw protocolError(
      "SENDER_IDENTITY_MISMATCH",
      "The frame sender does not match the authenticated Device identity.",
    );
  }
  if (!allowedMessageTypes(direction).has(frame.type)) {
    throw protocolError(
      "MESSAGE_TYPE_FORBIDDEN",
      "The message type is not authorized in this channel direction.",
    );
  }

  return deepFreeze(assertPayloadIdentity(parsePayload(frame)));
}

export function encodeDeviceChannelFrame(frame: DeviceChannelFrameV1): Buffer {
  const validated = assertPayloadIdentity(parsePayload(parseEnvelope(structuredClone(frame))));
  const encoded = Buffer.from(JSON.stringify(validated), "utf8");
  if (encoded.byteLength > MAX_DEVICE_CHANNEL_FRAME_BYTES) {
    throw protocolError("FRAME_TOO_LARGE", "The Device channel frame exceeds the size bound.");
  }
  return encoded;
}

/**
 * Validates the heartbeat payload independently of its channel envelope. Main
 * persistence uses this boundary again when restoring durable observations.
 */
export function validateWorkerHeartbeat(input: unknown): WorkerHeartbeatV1 {
  return deepFreeze(parseWorkerHeartbeat(input));
}

function assertPayloadIdentity(frame: DeviceChannelFrameV1): DeviceChannelFrameV1 {
  switch (frame.type) {
    case "worker.hello":
    case "worker.heartbeat":
    case "worker.artifact.prepare":
    case "worker.action.authorize":
    case "worker.action.consume":
    case "worker.run.renew":
      if (frame.payload.deviceId !== frame.senderDeviceId) {
        throw protocolError(
          "SENDER_IDENTITY_MISMATCH",
          "The Worker payload Device does not match the authenticated sender.",
        );
      }
      break;
    case "worker.route.incident":
      // The authenticated envelope is the Device authority. The deliberately
      // narrow incident payload contains no independently claimed Device ID.
      break;
    case "worker.events":
      if (
        frame.payload.events.some(
          (event) =>
            event.senderDeviceId !== frame.senderDeviceId ||
            event.payload.deviceId !== frame.senderDeviceId,
        )
      ) {
        throw protocolError(
          "SENDER_IDENTITY_MISMATCH",
          "A Worker event Device does not match the authenticated sender.",
        );
      }
      break;
    default:
      break;
  }
  return frame;
}

function parseEnvelope(input: unknown): DeviceChannelFrameV1 {
  const record = readRecord(input, "Device channel frame");
  assertExactKeys(record, [
    "protocolVersion",
    "messageId",
    "senderDeviceId",
    "correlationId",
    "createdAt",
    "idempotencyKey",
    "sequence",
    "type",
    "payload",
  ]);
  if (record["protocolVersion"] !== PROTOCOL_VERSION) {
    throw protocolError("FRAME_INVALID", "The Device channel protocol version is unsupported.");
  }
  const type = record["type"];
  if (typeof type !== "string" || !ALL_MESSAGE_TYPES.has(type as DeviceChannelMessageType)) {
    throw protocolError("MESSAGE_TYPE_FORBIDDEN", "The Device channel message type is forbidden.");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: readIdentifier(record["messageId"], "message ID"),
    senderDeviceId: readIdentifier(record["senderDeviceId"], "sender Device ID"),
    correlationId: readIdentifier(record["correlationId"], "correlation ID"),
    createdAt: readTimestamp(record["createdAt"]),
    idempotencyKey: readIdentifier(record["idempotencyKey"], "idempotency key"),
    sequence: readPositiveInteger(record["sequence"], "frame sequence"),
    type: type as DeviceChannelMessageType,
    payload: record["payload"],
  } as DeviceChannelFrameV1;
}

function parsePayload(frame: DeviceChannelFrameV1): DeviceChannelFrameV1 {
  switch (frame.type) {
    case "worker.hello":
      return { ...frame, payload: parseWorkerHello(frame.payload) };
    case "worker.heartbeat":
      return { ...frame, payload: parseWorkerHeartbeat(frame.payload) };
    case "worker.events":
      return { ...frame, payload: parseWorkerEvents(frame.payload) };
    case "worker.ack":
      return { ...frame, payload: parseWorkerAck(frame.payload) };
    case "worker.pong":
      return { ...frame, payload: parseWorkerPong(frame.payload) };
    case "worker.artifact.prepare":
      return { ...frame, payload: parseArtifactPrepare(frame.payload) };
    case "worker.action.authorize":
      return { ...frame, payload: parseWorkerActionAuthorization(frame.payload) };
    case "worker.action.consume":
      return { ...frame, payload: parseWorkerActionConsumption(frame.payload) };
    case "worker.run.renew":
      return { ...frame, payload: parseWorkerRunLeaseRenewal(frame.payload) };
    case "worker.run.steering":
      return { ...frame, payload: parseWorkerRunSteeringReceipt(frame.payload) };
    case "worker.route.incident":
      return { ...frame, payload: parseWorkerRouteIncident(frame.payload) };
    case "main.welcome":
      return { ...frame, payload: parseMainWelcome(frame.payload) };
    case "main.dispatch":
      return { ...frame, payload: parseAssignment(frame.payload) };
    case "main.control":
      return { ...frame, payload: parseMainControl(frame.payload) };
    case "main.ack":
      return { ...frame, payload: parseMainAck(frame.payload) };
    case "main.ping":
      return { ...frame, payload: parseMainPing(frame.payload) };
    case "main.revoked":
      return { ...frame, payload: parseMainRevoked(frame.payload) };
    case "main.run.lease":
      return { ...frame, payload: parseMainRunLease(frame.payload) };
    case "main.run.steer":
      return { ...frame, payload: parseMainRunSteering(frame.payload) };
    case "main.artifact.grant":
      return { ...frame, payload: parseMainArtifactGrant(frame.payload) };
    case "main.artifact.rejected":
      return { ...frame, payload: parseMainArtifactRejected(frame.payload) };
    case "main.action.authorization":
      return { ...frame, payload: parseMainActionAuthorization(frame.payload) };
    case "main.action.consumption":
      return { ...frame, payload: parseMainActionConsumption(frame.payload) };
  }
}

function parseWorkerHello(input: unknown): WorkerHelloFrameV1["payload"] {
  const record = readRecord(input, "Worker hello");
  assertExactKeys(record, [
    "deviceId",
    "workerId",
    "certificateGeneration",
    "minimumProtocolVersion",
    "maximumProtocolVersion",
    "acknowledgedMainSequence",
    "workerWallSentAtMs",
  ]);
  if (
    record["minimumProtocolVersion"] !== PROTOCOL_VERSION ||
    record["maximumProtocolVersion"] !== PROTOCOL_VERSION
  ) {
    throw protocolError("FRAME_INVALID", "The Worker protocol compatibility range is unsupported.");
  }
  return {
    deviceId: readIdentifier(record["deviceId"], "Device ID"),
    workerId: readIdentifier(record["workerId"], "Worker ID"),
    certificateGeneration: readPositiveInteger(
      record["certificateGeneration"],
      "certificate generation",
    ),
    minimumProtocolVersion: PROTOCOL_VERSION,
    maximumProtocolVersion: PROTOCOL_VERSION,
    acknowledgedMainSequence: readNonNegativeInteger(
      record["acknowledgedMainSequence"],
      "Main acknowledgment",
    ),
    workerWallSentAtMs: readTimestampInteger(
      record["workerWallSentAtMs"],
      "Worker hello wall time",
    ),
  };
}

function parseWorkerHeartbeat(input: unknown): WorkerHeartbeatV1 {
  const record = readRecord(input, "Worker heartbeat");
  assertExactKeys(
    record,
    [
      "protocolVersion",
      "deviceId",
      "workerId",
      "observedAtMs",
      "operationalState",
      "connectionState",
      "readiness",
      "capacity",
    ],
    ["inventory", "routeAttempts", "routes", "currentRuns"],
  );
  if (record["protocolVersion"] !== PROTOCOL_VERSION) {
    throw protocolError("FRAME_INVALID", "The heartbeat protocol version is unsupported.");
  }
  const operationalState = readEnum(
    record["operationalState"],
    ["active", "disabled", "draining", "revoked"] as const,
    "operational state",
  );
  const connectionState = readEnum(
    record["connectionState"],
    ["offline", "online"] as const,
    "connection state",
  );
  const readiness = readRecord(record["readiness"], "Worker readiness");
  assertExactKeys(readiness, ["daemon", "session", "desktop", "permissions"]);
  const permissions = readRecord(readiness["permissions"], "Worker permissions");
  assertExactKeys(permissions, ["accessibility", "input", "screenCapture"]);
  const capacity = readRecord(record["capacity"], "Worker capacity");
  assertExactKeys(capacity, ["acceptingWork", "activeRuns", "maxOutboxEntries", "outboxDepth"]);
  if (record["routeAttempts"] !== undefined) {
    throw protocolError(
      "FRAME_INVALID",
      "Route attempt diagnostics require the dedicated bounded diagnostic message.",
    );
  }
  const observedAtMs = readTimestampInteger(record["observedAtMs"], "heartbeat time");
  const inventory =
    record["inventory"] === undefined ? undefined : parseWorkerInventory(record["inventory"]);
  const routes = record["routes"] === undefined ? undefined : parseWorkerRoutes(record["routes"]);
  const currentRuns =
    record["currentRuns"] === undefined ? undefined : parseWorkerCurrentRuns(record["currentRuns"]);
  const activeRuns = readNonNegativeInteger(capacity["activeRuns"], "active Run count");
  if (currentRuns !== undefined && currentRuns.length !== activeRuns) {
    throw protocolError(
      "FRAME_INVALID",
      "The current Run projection must match the reported active Run count.",
    );
  }
  const healthyRouteCount = routes?.filter((route) => route.health === "healthy").length ?? 0;
  if (
    routes !== undefined &&
    ((connectionState === "online" && healthyRouteCount !== 1) ||
      (connectionState === "offline" && healthyRouteCount !== 0))
  ) {
    throw protocolError(
      "FRAME_INVALID",
      "The route projection does not match the Worker connection state.",
    );
  }
  if (
    inventory !== undefined &&
    (activeRuns > inventory.maximumConcurrentRuns ||
      inventory.resourceLocks?.some((lock) =>
        lock.holders.some(
          (holder) =>
            currentRuns === undefined ||
            !currentRuns.some((run) => run.taskId === holder.taskId && run.runId === holder.runId),
        ),
      ))
  ) {
    throw protocolError("FRAME_INVALID", "The scheduling projections are internally inconsistent.");
  }
  if (
    inventory?.hardware !== undefined &&
    [
      inventory.hardware.cpu.observedAtMs,
      inventory.hardware.memory.observedAtMs,
      inventory.hardware.gpu.observedAtMs,
    ].some((hardwareObservedAtMs) => hardwareObservedAtMs > observedAtMs)
  ) {
    throw protocolError(
      "FRAME_INVALID",
      "Hardware evidence cannot be newer than its enclosing heartbeat.",
    );
  }
  if (inventory?.wakeOnLan !== undefined && inventory.wakeOnLan.observedAtMs > observedAtMs) {
    throw protocolError(
      "FRAME_INVALID",
      "Wake-on-LAN evidence cannot be newer than its enclosing heartbeat.",
    );
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: readIdentifier(record["deviceId"], "Device ID"),
    workerId: readIdentifier(record["workerId"], "Worker ID"),
    observedAtMs,
    operationalState,
    connectionState,
    readiness: {
      daemon: readEnum(
        readiness["daemon"],
        ["degraded", "healthy", "starting", "stopping"] as const,
        "daemon state",
      ),
      session: readEnum(
        readiness["session"],
        ["locked", "logged-out", "ready", "unavailable"] as const,
        "session state",
      ),
      desktop: readEnum(
        readiness["desktop"],
        ["available", "busy", "locked", "unavailable"] as const,
        "desktop state",
      ),
      permissions: {
        accessibility: readPermission(permissions["accessibility"]),
        input: readPermission(permissions["input"]),
        screenCapture: readPermission(permissions["screenCapture"]),
      },
    },
    capacity: {
      acceptingWork: readBoolean(capacity["acceptingWork"], "accepting work"),
      activeRuns,
      maxOutboxEntries: readPositiveInteger(capacity["maxOutboxEntries"], "outbox capacity"),
      outboxDepth: readNonNegativeInteger(capacity["outboxDepth"], "outbox depth"),
    },
    ...(inventory === undefined ? {} : { inventory }),
    ...(routes === undefined ? {} : { routes }),
    ...(currentRuns === undefined ? {} : { currentRuns }),
  };
}

function parseWorkerInventory(input: unknown): NonNullable<WorkerHeartbeatV1["inventory"]> {
  const record = readRecord(input, "Worker scheduling inventory");
  assertExactKeys(
    record,
    [
      "deviceName",
      "osFamily",
      "platformRelease",
      "architecture",
      "serviceMode",
      "maximumConcurrentRuns",
      "capabilities",
      "workspaceIds",
      "availableSecretRefs",
    ],
    ["knowledgeHealth", "hardware", "wakeOnLan", "agentAdapters", "resourceLocks"],
  );
  const capabilityValues = readArray(record["capabilities"], "Worker capabilities");
  if (capabilityValues.length > 256) {
    throw protocolError("FRAME_INVALID", "Worker capabilities exceed their item bound.");
  }
  const capabilityNames = new Set<string>();
  const capabilities = capabilityValues.map((value) => {
    const capability = readRecord(value, "Worker capability");
    assertExactKeys(
      capability,
      ["name", "verification"],
      ["observedAtMs", "evidenceSource", "version"],
    );
    const name = readIdentifier(capability["name"], "capability name");
    if (capabilityNames.has(name)) {
      throw protocolError("FRAME_INVALID", "Worker capabilities must be unique.");
    }
    capabilityNames.add(name);
    return {
      name,
      verification: readEnum(
        capability["verification"],
        ["detected", "verified", "degraded", "unavailable", "disabled"] as const,
        "capability verification",
      ),
      ...(capability["observedAtMs"] === undefined
        ? {}
        : {
            observedAtMs: readTimestampInteger(
              capability["observedAtMs"],
              "capability observation time",
            ),
          }),
      ...(capability["evidenceSource"] === undefined
        ? {}
        : {
            evidenceSource: readEnum(
              capability["evidenceSource"],
              ["agent-adapter", "capability-probe", "workspace-registry"] as const,
              "capability evidence source",
            ),
          }),
      ...(capability["version"] === undefined
        ? {}
        : { version: readIdentifier(capability["version"], "capability version") }),
    };
  });
  const agentAdapters =
    record["agentAdapters"] === undefined
      ? undefined
      : parseWorkerAgentAdapters(record["agentAdapters"]);
  const resourceLocks =
    record["resourceLocks"] === undefined
      ? undefined
      : parseWorkerResourceLocks(record["resourceLocks"]);
  const hardware =
    record["hardware"] === undefined ? undefined : parseWorkerHardware(record["hardware"]);
  const wakeOnLan =
    record["wakeOnLan"] === undefined ? undefined : parseWorkerWakeOnLan(record["wakeOnLan"]);
  const osFamily = readEnum(
    record["osFamily"],
    ["linux", "macos", "windows"] as const,
    "OS family",
  );
  if (
    wakeOnLan !== undefined &&
    wakeOnLan.source !== "probe-unavailable" &&
    ((osFamily === "windows" && wakeOnLan.source !== "windows-netadapter-power") ||
      (osFamily === "macos" && wakeOnLan.source !== "macos-pmset") ||
      (osFamily === "linux" && wakeOnLan.source !== "linux-ethtool"))
  ) {
    throw protocolError(
      "FRAME_INVALID",
      "Worker Wake-on-LAN evidence does not match the Device OS.",
    );
  }
  return {
    deviceName: readIdentifier(record["deviceName"], "Device name"),
    osFamily,
    platformRelease: readIdentifier(record["platformRelease"], "platform release"),
    architecture: readIdentifier(record["architecture"], "architecture"),
    serviceMode: readEnum(
      record["serviceMode"],
      ["foreground", "system-service", "user-service"] as const,
      "service mode",
    ),
    ...(record["knowledgeHealth"] === undefined
      ? {}
      : {
          knowledgeHealth: readEnum(
            record["knowledgeHealth"],
            ["healthy", "degraded", "unavailable"] as const,
            "Knowledge health",
          ),
        }),
    ...(hardware === undefined ? {} : { hardware }),
    ...(wakeOnLan === undefined ? {} : { wakeOnLan }),
    maximumConcurrentRuns: readBoundedPositiveInteger(
      record["maximumConcurrentRuns"],
      "maximum concurrent Runs",
      1_024,
    ),
    capabilities,
    ...(agentAdapters === undefined ? {} : { agentAdapters }),
    ...(resourceLocks === undefined ? {} : { resourceLocks }),
    workspaceIds: readUniqueIdentifiers(record["workspaceIds"], "Workspace ID", 128),
    availableSecretRefs: readUniqueIdentifiers(
      record["availableSecretRefs"],
      "Secret reference",
      256,
    ),
  };
}

function parseWorkerWakeOnLan(
  input: unknown,
): NonNullable<NonNullable<WorkerHeartbeatV1["inventory"]>["wakeOnLan"]> {
  const record = readRecord(input, "Worker Wake-on-LAN observation");
  assertExactKeys(record, ["state", "source", "observedAtMs"]);
  const state = readEnum(
    record["state"],
    ["enabled", "disabled", "unsupported", "unknown"] as const,
    "Wake-on-LAN target state",
  );
  const source = readEnum(
    record["source"],
    ["windows-netadapter-power", "macos-pmset", "linux-ethtool", "probe-unavailable"] as const,
    "Wake-on-LAN probe source",
  );
  if (source === "probe-unavailable" && state !== "unknown") {
    throw protocolError("FRAME_INVALID", "Unavailable Wake-on-LAN evidence must remain unknown.");
  }
  return {
    state,
    source,
    observedAtMs: readTimestampInteger(record["observedAtMs"], "Wake-on-LAN observation time"),
  };
}

function parseWorkerHardware(
  input: unknown,
): NonNullable<NonNullable<WorkerHeartbeatV1["inventory"]>["hardware"]> {
  const record = readRecord(input, "Worker hardware facts");
  assertExactKeys(record, ["cpu", "memory", "gpu"]);
  const cpu = readRecord(record["cpu"], "Worker CPU facts");
  const memory = readRecord(record["memory"], "Worker memory facts");
  const gpu = readRecord(record["gpu"], "Worker GPU facts");
  assertExactKeys(cpu, ["model", "logicalCoreCount", "observedAtMs", "source", "verification"]);
  assertExactKeys(memory, ["totalBytes", "observedAtMs", "source", "verification"]);
  assertExactKeys(gpu, ["devices", "observedAtMs", "source", "verification"]);
  const deviceValues = readArray(gpu["devices"], "GPU devices");
  if (deviceValues.length > 16) {
    throw protocolError("FRAME_INVALID", "GPU devices exceed their item bound.");
  }
  const seen = new Set<string>();
  const devices = deviceValues.map((value) => {
    const device = readRecord(value, "GPU device");
    assertExactKeys(device, ["model"], ["vendor", "memoryBytes"]);
    const model = readHardwareLabel(device["model"], "GPU model", 256);
    const vendor =
      device["vendor"] === undefined
        ? undefined
        : readHardwareLabel(device["vendor"], "GPU vendor", 128);
    const memoryBytes =
      device["memoryBytes"] === undefined
        ? undefined
        : readBoundedPositiveInteger(
            device["memoryBytes"],
            "GPU memory bytes",
            Number.MAX_SAFE_INTEGER,
          );
    const identity = `${vendor ?? ""}\0${model}\0${String(memoryBytes ?? "")}`;
    if (seen.has(identity)) {
      throw protocolError("FRAME_INVALID", "GPU devices must be unique.");
    }
    seen.add(identity);
    return {
      model,
      ...(vendor === undefined ? {} : { vendor }),
      ...(memoryBytes === undefined ? {} : { memoryBytes }),
    };
  });
  const gpuVerification = readEnum(
    gpu["verification"],
    ["not-observed", "observed", "verified"] as const,
    "GPU verification",
  );
  if (gpuVerification === "not-observed" && devices.length > 0) {
    throw protocolError("FRAME_INVALID", "An unobserved GPU probe cannot report GPU devices.");
  }
  return {
    cpu: {
      model: readHardwareLabel(cpu["model"], "CPU model", 256),
      logicalCoreCount: readBoundedPositiveInteger(
        cpu["logicalCoreCount"],
        "logical CPU core count",
        4_096,
      ),
      observedAtMs: readTimestampInteger(cpu["observedAtMs"], "CPU observation time"),
      source: readHardwareSource(cpu["source"]),
      verification: readObservedHardwareVerification(cpu["verification"], "CPU verification"),
    },
    memory: {
      totalBytes: readBoundedPositiveInteger(
        memory["totalBytes"],
        "total memory bytes",
        Number.MAX_SAFE_INTEGER,
      ),
      observedAtMs: readTimestampInteger(memory["observedAtMs"], "memory observation time"),
      source: readHardwareSource(memory["source"]),
      verification: readObservedHardwareVerification(memory["verification"], "memory verification"),
    },
    gpu: {
      devices,
      observedAtMs: readTimestampInteger(gpu["observedAtMs"], "GPU observation time"),
      source: readHardwareSource(gpu["source"]),
      verification: gpuVerification,
    },
  };
}

function readHardwareSource(
  value: unknown,
): NonNullable<NonNullable<WorkerHeartbeatV1["inventory"]>["hardware"]>["cpu"]["source"] {
  return readEnum(value, ["node-os", "platform-probe"] as const, "hardware source");
}

function readObservedHardwareVerification(value: unknown, label: string): "observed" | "verified" {
  return readEnum(value, ["observed", "verified"] as const, label);
}

function parseWorkerAgentAdapters(
  input: unknown,
): NonNullable<NonNullable<WorkerHeartbeatV1["inventory"]>["agentAdapters"]> {
  const values = readArray(input, "Worker Agent adapters");
  if (values.length > 64) {
    throw protocolError("FRAME_INVALID", "Worker Agent adapters exceed their item bound.");
  }
  const seen = new Set<string>();
  return values.map((value) => {
    const adapter = readRecord(value, "Worker Agent adapter");
    assertExactKeys(
      adapter,
      ["provider", "adapterId", "readiness", "compatibility", "observedAtMs"],
      ["version"],
    );
    const provider = readEnum(
      adapter["provider"],
      ["codex", "claude", "generic-command"] as const,
      "Agent adapter provider",
    );
    const adapterId = readIdentifier(adapter["adapterId"], "Agent adapter ID");
    const identity = `${provider}\0${adapterId}`;
    if (seen.has(identity)) {
      throw protocolError("FRAME_INVALID", "Worker Agent adapters must be unique.");
    }
    seen.add(identity);
    return {
      provider,
      adapterId,
      readiness: readEnum(
        adapter["readiness"],
        ["ready", "degraded", "unavailable"] as const,
        "Agent adapter readiness",
      ),
      compatibility: readEnum(
        adapter["compatibility"],
        ["tested", "compatible", "untested", "incompatible"] as const,
        "Agent adapter compatibility",
      ),
      ...(adapter["version"] === undefined
        ? {}
        : { version: readIdentifier(adapter["version"], "Agent adapter version") }),
      observedAtMs: readTimestampInteger(adapter["observedAtMs"], "Agent adapter observation time"),
    };
  });
}

function parseWorkerResourceLocks(
  input: unknown,
): NonNullable<NonNullable<WorkerHeartbeatV1["inventory"]>["resourceLocks"]> {
  const values = readArray(input, "Worker resource locks");
  if (values.length > 128) {
    throw protocolError("FRAME_INVALID", "Worker resource locks exceed their item bound.");
  }
  const seenResources = new Set<string>();
  return values.map((value) => {
    const lock = readRecord(value, "Worker resource lock");
    assertExactKeys(lock, ["resourceName", "capacity", "holders"]);
    const resourceName = readIdentifier(lock["resourceName"], "resource name");
    if (seenResources.has(resourceName)) {
      throw protocolError("FRAME_INVALID", "Worker resource locks must be unique.");
    }
    seenResources.add(resourceName);
    const capacity = readBoundedPositiveInteger(lock["capacity"], "resource capacity", 1_024);
    const holderValues = readArray(lock["holders"], "Worker resource lock holders");
    if (holderValues.length > capacity) {
      throw protocolError("FRAME_INVALID", "Worker resource lock holders exceed capacity.");
    }
    const seenHolders = new Set<string>();
    const holders = holderValues.map((holderValue) => {
      const holder = readRecord(holderValue, "Worker resource lock holder");
      assertExactKeys(holder, ["taskId", "runId", "expiresAtMs"]);
      const taskId = readIdentifier(holder["taskId"], "resource lock Task ID");
      const runId = readIdentifier(holder["runId"], "resource lock Run ID");
      const identity = `${taskId}\0${runId}`;
      if (seenHolders.has(identity)) {
        throw protocolError("FRAME_INVALID", "Worker resource lock holders must be unique.");
      }
      seenHolders.add(identity);
      return {
        taskId,
        runId,
        expiresAtMs: readTimestampInteger(holder["expiresAtMs"], "resource lock expiry"),
      };
    });
    return { resourceName, capacity, holders };
  });
}

function parseWorkerRoutes(input: unknown): NonNullable<WorkerHeartbeatV1["routes"]> {
  const values = readArray(input, "Worker route projection");
  if (values.length === 0 || values.length > 64) {
    throw protocolError("FRAME_INVALID", "Worker routes must contain between 1 and 64 entries.");
  }
  const seen = new Set<string>();
  let expectedProfileRevision: `sha256:${string}` | undefined;
  let healthyRouteCount = 0;
  return values.map((value, expectedPriority) => {
    const route = readRecord(value, "Worker route");
    assertExactKeys(
      route,
      ["routeId", "label", "priority", "kind", "profileRevision", "health"],
      ["lastAttempt"],
    );
    const profileRevision = readSha256Digest(
      route["profileRevision"],
      "Transport Profile revision",
    );
    const routeId = readIdentifier(route["routeId"], "route ID");
    const expectedRouteId = `route:${profileRevision.slice("sha256:".length)}:${expectedPriority}`;
    if (
      seen.has(routeId) ||
      route["priority"] !== expectedPriority ||
      routeId !== expectedRouteId ||
      route["label"] !== `Route ${expectedPriority + 1}`
    ) {
      throw protocolError(
        "FRAME_INVALID",
        "Worker routes must use the redacted ordinal identity contract.",
      );
    }
    if (expectedProfileRevision !== undefined && profileRevision !== expectedProfileRevision) {
      throw protocolError(
        "FRAME_INVALID",
        "Worker routes must share one Transport Profile revision.",
      );
    }
    expectedProfileRevision = profileRevision;
    seen.add(routeId);
    const health = readEnum(route["health"], ["healthy", "unknown"] as const, "route health");
    if (health === "healthy") {
      healthyRouteCount += 1;
      if (healthyRouteCount > 1) {
        throw protocolError("FRAME_INVALID", "Only one Worker route may be connected.");
      }
    }
    const lastAttempt =
      route["lastAttempt"] === undefined
        ? undefined
        : parseWorkerRouteLastAttempt(route["lastAttempt"]);
    if ((health === "healthy") !== (lastAttempt !== undefined)) {
      throw protocolError(
        "FRAME_INVALID",
        "Only a live connected route may include a last-attempt projection.",
      );
    }
    return {
      routeId,
      label: `Route ${expectedPriority + 1}`,
      priority: expectedPriority,
      kind: readEnum(route["kind"], ["https", "wss"] as const, "route kind"),
      profileRevision,
      health,
      ...(lastAttempt === undefined ? {} : { lastAttempt }),
    };
  });
}

function parseWorkerRouteLastAttempt(
  input: unknown,
): NonNullable<NonNullable<WorkerHeartbeatV1["routes"]>[number]["lastAttempt"]> {
  const attempt = readRecord(input, "Worker route last attempt");
  assertExactKeys(attempt, ["probeSource", "outcome", "observedAtMs"]);
  if (attempt["probeSource"] !== "live" || attempt["outcome"] !== "connected") {
    throw protocolError(
      "FRAME_INVALID",
      "The route projection may report only a live successful connection.",
    );
  }
  return {
    probeSource: "live",
    outcome: "connected",
    observedAtMs: readTimestampInteger(attempt["observedAtMs"], "route observation time"),
  };
}

function parseWorkerCurrentRuns(input: unknown): NonNullable<WorkerHeartbeatV1["currentRuns"]> {
  const values = readArray(input, "Worker current Runs");
  if (values.length > 1_024) {
    throw protocolError("FRAME_INVALID", "Worker current Runs exceed their item bound.");
  }
  const seen = new Set<string>();
  return values.map((value) => {
    const run = readRecord(value, "Worker current Run");
    assertExactKeys(
      run,
      ["taskId", "workOrderId", "runId", "state", "acceptedAtMs", "leaseExpiresAtMs"],
      ["agentSession"],
    );
    const runId = readIdentifier(run["runId"], "current Run ID");
    if (seen.has(runId)) {
      throw protocolError("FRAME_INVALID", "Worker current Runs must be unique.");
    }
    seen.add(runId);
    const agentSession =
      run["agentSession"] === undefined
        ? undefined
        : parseWorkerAgentSessionObservation(run["agentSession"]);
    return {
      taskId: readIdentifier(run["taskId"], "current Run Task ID"),
      workOrderId: readIdentifier(run["workOrderId"], "current WorkOrder ID"),
      runId,
      state: readEnum(
        run["state"],
        ["starting", "running", "cancelling"] as const,
        "current Run state",
      ),
      acceptedAtMs: readTimestampInteger(run["acceptedAtMs"], "current Run acceptance time"),
      leaseExpiresAtMs: readTimestampInteger(run["leaseExpiresAtMs"], "current Run lease expiry"),
      ...(agentSession === undefined ? {} : { agentSession }),
    };
  });
}

function parseWorkerEvents(input: unknown): WorkerEventsFrameV1["payload"] {
  const record = readRecord(input, "Worker event batch");
  assertExactKeys(record, ["events"]);
  const events = readArray(record["events"], "Worker events");
  if (events.length === 0 || events.length > MAX_BATCH_ITEMS) {
    throw protocolError("FRAME_INVALID", "A Worker event batch must contain 1-256 events.");
  }
  let previousSequence = 0;
  return {
    events: events.map((event) => {
      const parsed = parseWorkerEvent(event);
      if (parsed.sequence <= previousSequence) {
        throw protocolError("FRAME_INVALID", "Worker event sequences must increase strictly.");
      }
      previousSequence = parsed.sequence;
      return parsed;
    }),
  };
}

function parseWorkerRouteIncident(input: unknown): WorkerRouteIncidentV1 {
  try {
    return validateWorkerRouteIncident(input as WorkerRouteIncidentV1);
  } catch {
    throw protocolError(
      "FRAME_INVALID",
      "The Worker route incident is outside the bounded diagnostic contract.",
    );
  }
}

function parseWorkerEvent(input: unknown): SequencedWorkerEventV1 {
  const record = readRecord(input, "Worker event");
  assertExactKeys(record, [
    "protocolVersion",
    "messageId",
    "senderDeviceId",
    "correlationId",
    "createdAt",
    "idempotencyKey",
    "type",
    "payload",
    "sequence",
  ]);
  if (record["protocolVersion"] !== PROTOCOL_VERSION) {
    throw protocolError("FRAME_INVALID", "A Worker event uses an unsupported protocol version.");
  }
  const type = readEnum(
    record["type"],
    [
      "worker.run.cancelled",
      "worker.run.claimed",
      "worker.run.failed",
      "worker.run.rejected",
      "worker.run.succeeded",
    ] as const,
    "Worker event type",
  );
  const payload = readRecord(record["payload"], "Worker event payload");
  assertExactKeys(
    payload,
    [
      "taskId",
      "workOrderId",
      "deviceId",
      "workerId",
      "routeId",
      "runId",
      "leaseId",
      "fencingToken",
    ],
    ["agentSession", "artifactIds", "diagnostic", "report", "usage"],
  );
  const report =
    payload["report"] === undefined ? undefined : readText(payload["report"], "Worker report");
  const artifactIds =
    payload["artifactIds"] === undefined
      ? undefined
      : readUniqueIdentifiers(payload["artifactIds"], "Artifact IDs", MAX_BATCH_ITEMS);
  if (payload["diagnostic"] !== undefined) {
    assertRedactedDiagnostic(payload["diagnostic"], 0);
  }
  const diagnostic =
    payload["diagnostic"] === undefined
      ? undefined
      : (structuredClone(payload["diagnostic"]) as NonNullable<
          SequencedWorkerEventV1["payload"]["diagnostic"]
        >);
  const usage =
    payload["usage"] === undefined ? undefined : parseWorkerProviderUsage(payload["usage"]);
  const agentSession =
    payload["agentSession"] === undefined
      ? undefined
      : parseWorkerAgentSessionObservation(payload["agentSession"]);
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: readIdentifier(record["messageId"], "event message ID"),
    senderDeviceId: readIdentifier(record["senderDeviceId"], "event sender Device ID"),
    correlationId: readIdentifier(record["correlationId"], "event correlation ID"),
    createdAt: readTimestamp(record["createdAt"]),
    idempotencyKey: readIdentifier(record["idempotencyKey"], "event idempotency key"),
    sequence: readPositiveInteger(record["sequence"], "event sequence"),
    type,
    payload: {
      taskId: readIdentifier(payload["taskId"], "Task ID"),
      workOrderId: readIdentifier(payload["workOrderId"], "Work Order ID"),
      deviceId: readIdentifier(payload["deviceId"], "Device ID"),
      workerId: readIdentifier(payload["workerId"], "Worker ID"),
      routeId: readIdentifier(payload["routeId"], "route ID"),
      runId: readIdentifier(payload["runId"], "Run ID"),
      leaseId: readIdentifier(payload["leaseId"], "lease ID"),
      fencingToken: readPositiveInteger(payload["fencingToken"], "fencing token"),
      ...(report === undefined ? {} : { report }),
      ...(artifactIds === undefined ? {} : { artifactIds }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(usage === undefined ? {} : { usage }),
      ...(agentSession === undefined ? {} : { agentSession }),
    },
  };
}

function parseWorkerProviderUsage(
  input: unknown,
): NonNullable<SequencedWorkerEventV1["payload"]["usage"]> {
  const record = readRecord(input, "Worker provider usage");
  const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "costUsdMicros"] as const;
  assertExactKeys(record, [], fields);
  if (Object.keys(record).length === 0) {
    throw protocolError("FRAME_INVALID", "Worker provider usage cannot be empty.");
  }
  const usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsdMicros?: number;
  } = {};
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined) {
      usage[field] = readNonNegativeInteger(value, `Worker provider ${field}`);
    }
  }
  return Object.freeze(usage);
}

function parseWorkerAck(input: unknown): WorkerAckFrameV1["payload"] {
  const record = readRecord(input, "Worker acknowledgment");
  assertExactKeys(record, ["acknowledgedMainSequence", "acknowledgedMessageIds"]);
  return {
    acknowledgedMainSequence: readNonNegativeInteger(
      record["acknowledgedMainSequence"],
      "Main sequence acknowledgment",
    ),
    acknowledgedMessageIds: readUniqueIdentifiers(
      record["acknowledgedMessageIds"],
      "acknowledged message IDs",
      MAX_BATCH_ITEMS,
    ),
  };
}

function parseWorkerPong(input: unknown): WorkerPongFrameV1["payload"] {
  const record = readRecord(input, "Worker pong");
  assertExactKeys(record, ["pingId", "observedAtMs"]);
  return {
    pingId: readIdentifier(record["pingId"], "ping ID"),
    observedAtMs: readTimestampInteger(record["observedAtMs"], "pong time"),
  };
}

function parseWorkerRunLeaseRenewal(input: unknown): WorkerRunLeaseRenewalRequestV1 {
  const record = readRecord(input, "Worker Run lease renewal");
  assertExactKeys(record, [
    "taskId",
    "workOrderId",
    "deviceId",
    "workerId",
    "routeId",
    "runId",
    "leaseId",
    "fencingToken",
    "renewalId",
    "priorLeaseExpiresAtMs",
  ]);
  return {
    taskId: readIdentifier(record["taskId"], "Task ID"),
    workOrderId: readIdentifier(record["workOrderId"], "Work Order ID"),
    deviceId: readIdentifier(record["deviceId"], "Device ID"),
    workerId: readIdentifier(record["workerId"], "Worker ID"),
    routeId: readIdentifier(record["routeId"], "route ID"),
    runId: readIdentifier(record["runId"], "Run ID"),
    leaseId: readIdentifier(record["leaseId"], "lease ID"),
    fencingToken: readPositiveInteger(record["fencingToken"], "fencing token"),
    renewalId: readIdentifier(record["renewalId"], "renewal ID"),
    priorLeaseExpiresAtMs: readTimestampInteger(
      record["priorLeaseExpiresAtMs"],
      "prior Run lease expiry",
    ),
  };
}

function parseArtifactPrepare(input: unknown): ArtifactPrepareManifestV1 {
  const record = readRecord(input, "Artifact prepare manifest");
  assertExactKeys(
    record,
    [
      "artifactId",
      "taskId",
      "workOrderId",
      "deviceId",
      "workerId",
      "routeId",
      "runId",
      "leaseId",
      "fencingToken",
      "mediaType",
      "originalFilename",
      "declaredSizeBytes",
      "expectedSha256",
    ],
    ["requestedPresentation"],
  );
  const mediaType = readMediaType(record["mediaType"]);
  const requestedPresentation =
    record["requestedPresentation"] === undefined
      ? undefined
      : readEnum(
          record["requestedPresentation"],
          ["download", "inline", "interactive-html", "static-html"] as const,
          "Artifact presentation",
        );
  if (
    ((requestedPresentation === "interactive-html" || requestedPresentation === "static-html") &&
      mediaType !== "text/html") ||
    (mediaType === "image/svg+xml" &&
      requestedPresentation !== undefined &&
      requestedPresentation !== "download")
  ) {
    throw protocolError("FRAME_INVALID", "The requested Artifact presentation is unsafe.");
  }
  const expectedSha256 = record["expectedSha256"];
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw protocolError("FRAME_INVALID", "The Artifact checksum is invalid.");
  }
  return {
    artifactId: readIdentifier(record["artifactId"], "Artifact ID"),
    taskId: readIdentifier(record["taskId"], "Task ID"),
    workOrderId: readIdentifier(record["workOrderId"], "Work Order ID"),
    deviceId: readIdentifier(record["deviceId"], "Device ID"),
    workerId: readIdentifier(record["workerId"], "Worker ID"),
    routeId: readIdentifier(record["routeId"], "route ID"),
    runId: readIdentifier(record["runId"], "Run ID"),
    leaseId: readIdentifier(record["leaseId"], "lease ID"),
    fencingToken: readPositiveInteger(record["fencingToken"], "fencing token"),
    mediaType,
    originalFilename: readArtifactFilename(record["originalFilename"]),
    declaredSizeBytes: readNonNegativeInteger(
      record["declaredSizeBytes"],
      "declared Artifact size",
    ),
    expectedSha256,
    ...(requestedPresentation === undefined ? {} : { requestedPresentation }),
  };
}

function parseWorkerActionAuthorization(input: unknown): WorkerActionAuthorizationRequestV1 {
  const record = readRecord(input, "Worker action authorization");
  assertExactKeys(record, [
    "authorizationRequestId",
    "actionCategory",
    "actionType",
    "actionFingerprint",
    "actionDescriptor",
    "requestedAtMs",
    "taskId",
    "workOrderId",
    "deviceId",
    "workerId",
    "routeId",
    "runId",
    "leaseId",
    "fencingToken",
    "leaseExpiresAtMs",
  ]);
  const actionCategory = readIdentifier(record["actionCategory"], "action category");
  const actionType = readIdentifier(record["actionType"], "action type");
  const actionDescriptor = parseActionDescriptor(
    actionCategory,
    actionType,
    record["actionDescriptor"],
  );
  return {
    authorizationRequestId: readIdentifier(
      record["authorizationRequestId"],
      "authorization request ID",
    ),
    actionCategory,
    actionType,
    actionFingerprint: readActionFingerprint(record["actionFingerprint"]),
    actionDescriptor,
    requestedAtMs: readTimestampInteger(record["requestedAtMs"], "action request time"),
    ...parseActionRunIdentity(record),
  };
}

function parseActionDescriptor(
  actionCategory: string,
  actionType: string,
  input: unknown,
): RedactedDiagnosticV1 {
  if (actionCategory === "computer-use-input") {
    const record = readRecord(input, "Computer Use action descriptor");
    if (actionType !== "click" && actionType !== "type-text") {
      throw protocolError("FRAME_INVALID", "The Computer Use action type is unsupported.");
    }
    assertExactKeys(record, ["kind", "privacy"]);
    if (record["kind"] !== actionType || record["privacy"] !== "exact-input-withheld-on-device") {
      throw protocolError("FRAME_INVALID", "The Computer Use action descriptor is invalid.");
    }
    return {
      kind: actionType,
      privacy: "exact-input-withheld-on-device",
    };
  }
  assertRedactedDiagnostic(input, 0);
  assertNoSensitiveActionDescriptorKeys(input);
  return structuredClone(input) as RedactedDiagnosticV1;
}

function assertNoSensitiveActionDescriptorKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSensitiveActionDescriptorKeys(item);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(?:authorization|cookie|credential|password|private[-_]?key|secret|text|token|value)$/iu.test(
        key,
      )
    ) {
      throw protocolError("FRAME_INVALID", "The action descriptor contains a sensitive field.");
    }
    assertNoSensitiveActionDescriptorKeys(child);
  }
}

function parseWorkerActionConsumption(input: unknown): WorkerActionConsumptionRequestV1 {
  const record = readRecord(input, "Worker action consumption");
  assertExactKeys(record, [
    "authorizationRequestId",
    "authorizationId",
    "actionCategory",
    "actionFingerprint",
    "requestedAtMs",
    "taskId",
    "workOrderId",
    "deviceId",
    "workerId",
    "routeId",
    "runId",
    "leaseId",
    "fencingToken",
    "leaseExpiresAtMs",
  ]);
  return {
    authorizationRequestId: readIdentifier(
      record["authorizationRequestId"],
      "authorization request ID",
    ),
    authorizationId: readIdentifier(record["authorizationId"], "authorization ID"),
    actionCategory: readIdentifier(record["actionCategory"], "action category"),
    actionFingerprint: readActionFingerprint(record["actionFingerprint"]),
    requestedAtMs: readTimestampInteger(record["requestedAtMs"], "action consumption time"),
    ...parseActionRunIdentity(record),
  };
}

function parseActionRunIdentity(record: Readonly<Record<string, unknown>>) {
  return {
    taskId: readIdentifier(record["taskId"], "Task ID"),
    workOrderId: readIdentifier(record["workOrderId"], "Work Order ID"),
    deviceId: readIdentifier(record["deviceId"], "Device ID"),
    workerId: readIdentifier(record["workerId"], "Worker ID"),
    routeId: readIdentifier(record["routeId"], "route ID"),
    runId: readIdentifier(record["runId"], "Run ID"),
    leaseId: readIdentifier(record["leaseId"], "lease ID"),
    fencingToken: readPositiveInteger(record["fencingToken"], "fencing token"),
    leaseExpiresAtMs: readTimestampInteger(record["leaseExpiresAtMs"], "lease expiry"),
  };
}

function parseMainWelcome(input: unknown): MainWelcomeFrameV1["payload"] {
  const record = readRecord(input, "Main welcome");
  assertExactKeys(record, [
    "deviceId",
    "acceptedProtocolVersion",
    "acknowledgedWorkerSequence",
    "nextMainSequence",
    "heartbeatIntervalMs",
    "maximumInFlightFrames",
    "workerWallSentAtMs",
    "mainReceivedAtMs",
    "mainSentAtMs",
    "maximumHandshakeRttMs",
    "maximumAbsoluteClockSkewMs",
  ]);
  if (record["acceptedProtocolVersion"] !== PROTOCOL_VERSION) {
    throw protocolError("FRAME_INVALID", "Main selected an unsupported protocol version.");
  }
  return {
    deviceId: readIdentifier(record["deviceId"], "Device ID"),
    acceptedProtocolVersion: PROTOCOL_VERSION,
    acknowledgedWorkerSequence: readNonNegativeInteger(
      record["acknowledgedWorkerSequence"],
      "Worker sequence acknowledgment",
    ),
    nextMainSequence: readPositiveInteger(record["nextMainSequence"], "next Main sequence"),
    heartbeatIntervalMs: readBoundedPositiveInteger(
      record["heartbeatIntervalMs"],
      "heartbeat interval",
      3_600_000,
    ),
    maximumInFlightFrames: readBoundedPositiveInteger(
      record["maximumInFlightFrames"],
      "in-flight frame capacity",
      1_024,
    ),
    workerWallSentAtMs: readTimestampInteger(
      record["workerWallSentAtMs"],
      "echoed Worker wall time",
    ),
    mainReceivedAtMs: readTimestampInteger(record["mainReceivedAtMs"], "Main hello receive time"),
    mainSentAtMs: readTimestampInteger(record["mainSentAtMs"], "Main welcome send time"),
    maximumHandshakeRttMs: readBoundedPositiveInteger(
      record["maximumHandshakeRttMs"],
      "maximum handshake round trip",
      60_000,
    ),
    maximumAbsoluteClockSkewMs: readBoundedPositiveInteger(
      record["maximumAbsoluteClockSkewMs"],
      "maximum absolute clock skew",
      3_600_000,
    ),
  };
}

function parseAssignment(input: unknown): WorkerRunAssignmentV1 {
  const record = readRecord(input, "Run assignment");
  assertExactKeys(
    record,
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
  );
  const taskId = readIdentifier(record["taskId"], "Task ID");
  const workOrder = parseWorkOrder(record["workOrder"]);
  const agentRequirement =
    record["agentRequirement"] === undefined
      ? undefined
      : parseWorkerAgentRequirement(record["agentRequirement"]);
  let continuationCheckpoint;
  try {
    continuationCheckpoint =
      record["continuationCheckpoint"] === undefined
        ? undefined
        : validateTaskContinuationCheckpoint(record["continuationCheckpoint"]);
  } catch {
    throw protocolError("FRAME_INVALID", "The Task continuation checkpoint is invalid.");
  }
  if (
    workOrder.requiredAgent !== undefined &&
    (agentRequirement === undefined ||
      JSON.stringify(agentRequirement) !== JSON.stringify(workOrder.requiredAgent))
  ) {
    throw protocolError(
      "FRAME_INVALID",
      "The Run assignment does not preserve its Work Order Agent requirement.",
    );
  }
  if (
    continuationCheckpoint !== undefined &&
    (continuationCheckpoint.taskId !== taskId ||
      !continuationCheckpoint.pendingWorkOrders.some(
        (candidate) => candidate.workOrderId === workOrder.workOrderId,
      ))
  ) {
    throw protocolError(
      "FRAME_INVALID",
      "The Task continuation checkpoint does not bind this Task and Work Order.",
    );
  }
  return {
    taskId,
    workOrder,
    ...(continuationCheckpoint === undefined ? {} : { continuationCheckpoint }),
    ...(agentRequirement === undefined ? {} : { agentRequirement }),
    deviceId: readIdentifier(record["deviceId"], "Device ID"),
    workerId: readIdentifier(record["workerId"], "Worker ID"),
    routeId: readIdentifier(record["routeId"], "route ID"),
    runId: readIdentifier(record["runId"], "Run ID"),
    leaseId: readIdentifier(record["leaseId"], "lease ID"),
    fencingToken: readPositiveInteger(record["fencingToken"], "fencing token"),
    leaseExpiresAtMs: readTimestampInteger(record["leaseExpiresAtMs"], "lease expiry"),
  };
}

function parseMainControl(input: unknown): MainControlFrameV1["payload"] {
  const record = readRecord(input, "Main control");
  assertExactKeys(record, ["action", "reason"], ["fencingToken", "leaseId", "runId"]);
  const action = readEnum(
    record["action"],
    ["cancel", "disable", "drain", "revoke"] as const,
    "control action",
  );
  const runId = optionalIdentifier(record["runId"], "Run ID");
  const leaseId = optionalIdentifier(record["leaseId"], "lease ID");
  const fencingToken =
    record["fencingToken"] === undefined
      ? undefined
      : readPositiveInteger(record["fencingToken"], "fencing token");
  const hasRunScope = runId !== undefined || leaseId !== undefined || fencingToken !== undefined;
  if (
    (action === "cancel" &&
      (runId === undefined || leaseId === undefined || fencingToken === undefined)) ||
    (action !== "cancel" && hasRunScope)
  ) {
    throw protocolError("FRAME_INVALID", "The control action scope is invalid.");
  }
  return {
    action,
    reason: readText(record["reason"], "control reason"),
    ...(runId === undefined ? {} : { runId }),
    ...(leaseId === undefined ? {} : { leaseId }),
    ...(fencingToken === undefined ? {} : { fencingToken }),
  };
}

function parseMainRunSteering(input: unknown): MainRunSteerFrameV1["payload"] {
  try {
    return validateWorkerRunSteeringCommand(input as WorkerRunSteeringCommandV1);
  } catch {
    throw protocolError(
      "FRAME_INVALID",
      "The Main Run steering command is outside the exact bounded contract.",
    );
  }
}

function parseWorkerRunSteeringReceipt(input: unknown): WorkerRunSteeringReceiptFrameV1["payload"] {
  try {
    return validateWorkerRunSteeringReceipt(input as WorkerRunSteeringReceiptV1);
  } catch {
    throw protocolError(
      "FRAME_INVALID",
      "The Worker Run steering receipt is outside the exact bounded contract.",
    );
  }
}

function parseMainAck(input: unknown): MainAckFrameV1["payload"] {
  const record = readRecord(input, "Main acknowledgment");
  assertExactKeys(record, [
    "protocolVersion",
    "acknowledgedWorkerSequence",
    "acknowledgedMessageIds",
  ]);
  if (record["protocolVersion"] !== PROTOCOL_VERSION) {
    throw protocolError("FRAME_INVALID", "The Main acknowledgment version is unsupported.");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    acknowledgedWorkerSequence: readNonNegativeInteger(
      record["acknowledgedWorkerSequence"],
      "Worker sequence acknowledgment",
    ),
    acknowledgedMessageIds: readUniqueIdentifiers(
      record["acknowledgedMessageIds"],
      "acknowledged message IDs",
      MAX_BATCH_ITEMS,
    ),
  };
}

function parseMainPing(input: unknown): MainPingFrameV1["payload"] {
  const record = readRecord(input, "Main ping");
  assertExactKeys(record, ["pingId", "deadlineAtMs"]);
  return {
    pingId: readIdentifier(record["pingId"], "ping ID"),
    deadlineAtMs: readTimestampInteger(record["deadlineAtMs"], "ping deadline"),
  };
}

function parseMainRevoked(input: unknown): MainRevokedFrameV1["payload"] {
  const record = readRecord(input, "Main revocation");
  assertExactKeys(record, ["reasonCode"]);
  if (record["reasonCode"] !== "DEVICE_REVOKED") {
    throw protocolError("FRAME_INVALID", "The Device revocation reason is invalid.");
  }
  return { reasonCode: "DEVICE_REVOKED" };
}

function parseMainRunLease(input: unknown): MainRunLeaseFrameV1["payload"] {
  const record = readRecord(input, "Main Run lease decision");
  const common = [
    "requestMessageId",
    "taskId",
    "workOrderId",
    "deviceId",
    "workerId",
    "routeId",
    "runId",
    "leaseId",
    "fencingToken",
    "renewalId",
    "priorLeaseExpiresAtMs",
    "status",
  ];
  const request = parseWorkerRunLeaseRenewal({
    taskId: record["taskId"],
    workOrderId: record["workOrderId"],
    deviceId: record["deviceId"],
    workerId: record["workerId"],
    routeId: record["routeId"],
    runId: record["runId"],
    leaseId: record["leaseId"],
    fencingToken: record["fencingToken"],
    renewalId: record["renewalId"],
    priorLeaseExpiresAtMs: record["priorLeaseExpiresAtMs"],
  });
  const requestMessageId = readIdentifier(
    record["requestMessageId"],
    "Run lease request message ID",
  );
  if (record["status"] === "renewed") {
    assertExactKeys(record, [...common, "renewedAtMs", "leaseExpiresAtMs"]);
    const renewedAtMs = readTimestampInteger(record["renewedAtMs"], "Run lease renewal time");
    const leaseExpiresAtMs = readTimestampInteger(
      record["leaseExpiresAtMs"],
      "renewed Run lease expiry",
    );
    if (renewedAtMs >= leaseExpiresAtMs || request.priorLeaseExpiresAtMs >= leaseExpiresAtMs) {
      throw protocolError("FRAME_INVALID", "The renewed Run lease interval is invalid.");
    }
    return {
      requestMessageId,
      ...request,
      status: "renewed",
      renewedAtMs,
      leaseExpiresAtMs,
    };
  }
  assertExactKeys(record, [...common, "decidedAtMs", "reasonCode"]);
  const reasonCode = readEnum(
    record["reasonCode"],
    [
      "RUN_LEASE_CHANGED",
      "RUN_LEASE_EXPIRED",
      "RUN_LEASE_NOT_DUE",
      "RUN_NOT_ACTIVE",
      "RUN_SCOPE_MISMATCH",
    ] as const,
    "Run lease rejection code",
  );
  if (record["status"] !== "rejected") {
    throw protocolError("FRAME_INVALID", "The Main Run lease decision is invalid.");
  }
  return {
    requestMessageId,
    ...request,
    status: "rejected",
    decidedAtMs: readTimestampInteger(record["decidedAtMs"], "Run lease decision time"),
    reasonCode,
  };
}

function parseMainArtifactGrant(input: unknown): MainArtifactGrantFrameV1["payload"] {
  const record = readRecord(input, "Main Artifact grant");
  assertExactKeys(record, ["requestMessageId", "deviceId", "grant"]);
  let grant: ArtifactUploadGrantV1;
  try {
    grant = parseArtifactUploadGrant(record["grant"]);
  } catch {
    throw protocolError("FRAME_INVALID", "The Main Artifact upload grant is invalid.");
  }
  return {
    requestMessageId: readIdentifier(record["requestMessageId"], "Artifact request message ID"),
    deviceId: readIdentifier(record["deviceId"], "Artifact target Device ID"),
    grant,
  };
}

function parseMainArtifactRejected(input: unknown): MainArtifactRejectedFrameV1["payload"] {
  const record = readRecord(input, "Main Artifact rejection");
  assertExactKeys(record, ["requestMessageId", "deviceId", "artifactId", "code", "retryable"]);
  return {
    requestMessageId: readIdentifier(record["requestMessageId"], "Artifact request message ID"),
    deviceId: readIdentifier(record["deviceId"], "Artifact target Device ID"),
    artifactId: readIdentifier(record["artifactId"], "Artifact ID"),
    code: readEnum(
      record["code"],
      ["ARTIFACT_INVALID", "POLICY_REJECTED", "RUN_NOT_CURRENT", "SERVICE_UNAVAILABLE"] as const,
      "Artifact rejection code",
    ),
    retryable: readBoolean(record["retryable"], "Artifact rejection retryability"),
  };
}

function parseMainActionAuthorization(input: unknown): MainActionAuthorizationFrameV1["payload"] {
  const record = readRecord(input, "Main action authorization");
  assertExactKeys(record, [
    "requestMessageId",
    "authorizationRequestId",
    "authorizationId",
    "actionFingerprint",
    "decision",
    "reasonCode",
  ]);
  return {
    requestMessageId: readIdentifier(record["requestMessageId"], "request message ID"),
    authorizationRequestId: readIdentifier(
      record["authorizationRequestId"],
      "authorization request ID",
    ),
    authorizationId: readIdentifier(record["authorizationId"], "authorization ID"),
    actionFingerprint: readActionFingerprint(record["actionFingerprint"]),
    decision: readEnum(
      record["decision"],
      ["allow", "deny", "require-approval"] as const,
      "action authorization decision",
    ),
    reasonCode: readIdentifier(record["reasonCode"], "authorization reason code"),
  };
}

function parseMainActionConsumption(input: unknown): MainActionConsumptionFrameV1["payload"] {
  const record = readRecord(input, "Main action consumption");
  assertExactKeys(record, [
    "requestMessageId",
    "authorizationRequestId",
    "authorizationId",
    "actionFingerprint",
    "decision",
    "reasonCode",
  ]);
  return {
    requestMessageId: readIdentifier(record["requestMessageId"], "request message ID"),
    authorizationRequestId: readIdentifier(
      record["authorizationRequestId"],
      "authorization request ID",
    ),
    authorizationId: readIdentifier(record["authorizationId"], "authorization ID"),
    actionFingerprint: readActionFingerprint(record["actionFingerprint"]),
    decision: readEnum(
      record["decision"],
      ["consumed", "deny"] as const,
      "action consumption decision",
    ),
    reasonCode: readIdentifier(record["reasonCode"], "consumption reason code"),
  };
}

function readActionFingerprint(value: unknown): `sha256:${string}` {
  return readSha256Digest(value, "action fingerprint");
}

function readSha256Digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw protocolError("FRAME_INVALID", `The ${label} is invalid.`);
  }
  return value as `sha256:${string}`;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("FRAME_INVALID", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw protocolError("FRAME_INVALID", "The Device channel frame has an invalid field set.");
  }
}

function readArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw protocolError("FRAME_INVALID", `${label} must be an array.`);
  }
  return value;
}

function readIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw protocolError("FRAME_INVALID", `${label} is invalid.`);
  }
  return value;
}

function readBoundedText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw protocolError("FRAME_INVALID", `${label} is invalid.`);
  }
  return value;
}

function readHardwareLabel(value: unknown, label: string, maximumBytes: number): string {
  const parsed = readBoundedText(value, label, maximumBytes);
  if (
    /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(parsed) ||
    /(?:[\\/]Users[\\/]|[\\/]home[\\/]|[\\/]var[\\/]|[\\/]sys[\\/]|[\\/]proc[\\/]|[\\/]dev[\\/])/iu.test(
      parsed,
    ) ||
    /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+|\b(?:sk[-_]|ghp_)[A-Za-z0-9_-]{16,})/u.test(
      parsed,
    )
  ) {
    throw protocolError("FRAME_INVALID", `${label} contains prohibited local or credential data.`);
  }
  return parsed;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  void readIdentifier(value, label);
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : readIdentifier(value, label);
}

function readText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES ||
    hasControlCharacterExceptWhitespace(value)
  ) {
    throw protocolError("FRAME_INVALID", `${label} is invalid.`);
  }
  return value;
}

function readMediaType(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value)
  ) {
    throw protocolError("FRAME_INVALID", "Artifact media type is invalid.");
  }
  return value;
}

function readArtifactFilename(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 255 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    throw protocolError("FRAME_INVALID", "Artifact filename is invalid.");
  }
  return value;
}

function readTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw protocolError("FRAME_INVALID", "The frame creation time is invalid.");
  }
  return value;
}

function readPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw protocolError("FRAME_INVALID", `${label} must be a positive safe integer.`);
  }
  return value as number;
}

function readBoundedPositiveInteger(value: unknown, label: string, maximum: number): number {
  const parsed = readPositiveInteger(value, label);
  if (parsed > maximum) {
    throw protocolError("FRAME_INVALID", `${label} exceeds its supported bound.`);
  }
  return parsed;
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolError("FRAME_INVALID", `${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function readTimestampInteger(value: unknown, label: string): number {
  const parsed = readNonNegativeInteger(value, label);
  if (parsed > MAX_TIMESTAMP_MS) {
    throw protocolError("FRAME_INVALID", `${label} is outside the supported time range.`);
  }
  return parsed;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw protocolError("FRAME_INVALID", `${label} must be a boolean.`);
  }
  return value;
}

function readEnum<const TValues extends readonly string[]>(
  value: unknown,
  allowed: TValues,
  label: string,
): TValues[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw protocolError("FRAME_INVALID", `${label} is unsupported.`);
  }
  return value as TValues[number];
}

function readPermission(value: unknown): WorkerHeartbeatV1["readiness"]["permissions"]["input"] {
  return readEnum(
    value,
    ["denied", "granted", "not-applicable", "unknown"] as const,
    "permission state",
  );
}

function readUniqueIdentifiers(
  value: unknown,
  label: string,
  maximumItems: number,
): readonly string[] {
  const values = readArray(value, label);
  if (values.length > maximumItems) {
    throw protocolError("FRAME_INVALID", `${label} exceeds its item bound.`);
  }
  const result = values.map((item) => readIdentifier(item, label));
  if (new Set(result).size !== result.length) {
    throw protocolError("FRAME_INVALID", `${label} must be unique.`);
  }
  return result;
}

function assertRedactedDiagnostic(value: unknown, depth: number): void {
  if (depth > 8) {
    throw protocolError("FRAME_INVALID", "The diagnostic nesting is too deep.");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 4_096 || hasControlCharacterExceptWhitespace(value)) {
      throw protocolError("FRAME_INVALID", "A diagnostic string is invalid.");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) {
      throw protocolError("FRAME_INVALID", "A diagnostic collection is too large.");
    }
    for (const entry of value) {
      assertRedactedDiagnostic(entry, depth + 1);
    }
    return;
  }
  const record = readRecord(value, "diagnostic");
  if (Object.keys(record).length > 64) {
    throw protocolError("FRAME_INVALID", "A diagnostic object is too large.");
  }
  for (const [key, entry] of Object.entries(record)) {
    readIdentifier(key, "diagnostic field");
    assertRedactedDiagnostic(entry, depth + 1);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function hasControlCharacterExceptWhitespace(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      ((codePoint <= 31 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
        codePoint === 127)
    );
  });
}

function allowedMessageTypes(direction: DeviceChannelDirection): ReadonlySet<string> {
  return direction === "worker-to-main"
    ? WORKER_TO_MAIN_MESSAGE_TYPES
    : MAIN_TO_WORKER_MESSAGE_TYPES;
}

function protocolError(
  code: DeviceChannelProtocolErrorCode,
  message: string,
): DeviceChannelProtocolError {
  return new DeviceChannelProtocolError(code, message);
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

const WORKER_TO_MAIN_MESSAGE_TYPES = new Set<WorkerToMainMessageType>([
  "worker.ack",
  "worker.action.authorize",
  "worker.action.consume",
  "worker.artifact.prepare",
  "worker.events",
  "worker.heartbeat",
  "worker.hello",
  "worker.pong",
  "worker.route.incident",
  "worker.run.renew",
  "worker.run.steering",
]);
const MAIN_TO_WORKER_MESSAGE_TYPES = new Set<MainToWorkerMessageType>([
  "main.ack",
  "main.action.authorization",
  "main.action.consumption",
  "main.artifact.grant",
  "main.artifact.rejected",
  "main.control",
  "main.dispatch",
  "main.ping",
  "main.revoked",
  "main.run.lease",
  "main.run.steer",
  "main.welcome",
]);
const ALL_MESSAGE_TYPES = new Set<DeviceChannelMessageType>([
  ...WORKER_TO_MAIN_MESSAGE_TYPES,
  ...MAIN_TO_WORKER_MESSAGE_TYPES,
]);
