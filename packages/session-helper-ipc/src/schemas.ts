import type {
  SessionHelperBinding,
  SessionHelperCapability,
  SessionHelperCapabilityErrorCode,
  SessionHelperCapabilityRequest,
  SessionHelperCapabilityResponse,
  SessionHelperDiagnosticEntry,
  SessionHelperExactInputAction,
  SessionHelperObservedElement,
} from "./contracts.ts";
import { SESSION_HELPER_IPC_PROTOCOL_VERSION } from "./contracts.ts";
import { SessionHelperIpcError } from "./error.ts";

const IDENTIFIER_MAX = 256;
const RELEASE_VERSION_MAX = 128;
const DISPLAY_FINGERPRINT_MAX = 512;
const TEXT_MAX = 16_384;
const MAX_OBSERVED_ELEMENTS = 2_048;
const MAX_DIAGNOSTIC_ENTRIES = 100;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const BASE64URL_PATTERN = /^(?:[A-Za-z0-9_-]{2,})$/u;

export interface CoreHello {
  readonly type: "core_hello";
  readonly protocolVersion: typeof SESSION_HELPER_IPC_PROTOCOL_VERSION;
  readonly deviceId: string;
  readonly helperId: string;
  readonly sessionId: string;
  readonly serviceEpoch: number;
  readonly releaseVersion: string;
  readonly keyId: string;
  readonly coreNonce: string;
}

export interface HelperChallenge {
  readonly type: "helper_challenge";
  readonly protocolVersion: typeof SESSION_HELPER_IPC_PROTOCOL_VERSION;
  readonly deviceId: string;
  readonly helperId: string;
  readonly sessionId: string;
  readonly serviceEpoch: number;
  readonly releaseVersion: string;
  readonly keyId: string;
  readonly coreNonce: string;
  readonly helperNonce: string;
  readonly proof: string;
}

export interface CoreProof {
  readonly type: "core_proof";
  readonly protocolVersion: typeof SESSION_HELPER_IPC_PROTOCOL_VERSION;
  readonly proof: string;
}

export function validateBinding(value: SessionHelperBinding): SessionHelperBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "deviceId",
      "helperId",
      "sessionId",
      "serviceEpoch",
      "releaseVersion",
    ]) ||
    value["protocolVersion"] !== SESSION_HELPER_IPC_PROTOCOL_VERSION ||
    !isIdentifier(value["deviceId"]) ||
    !isIdentifier(value["helperId"]) ||
    !isIdentifier(value["sessionId"]) ||
    !isPositiveSafeInteger(value["serviceEpoch"]) ||
    !isReleaseVersion(value["releaseVersion"])
  ) {
    throw new SessionHelperIpcError("BINDING_MISMATCH");
  }
  return Object.freeze({
    protocolVersion: SESSION_HELPER_IPC_PROTOCOL_VERSION,
    deviceId: value["deviceId"],
    helperId: value["helperId"],
    sessionId: value["sessionId"],
    serviceEpoch: value["serviceEpoch"],
    releaseVersion: value["releaseVersion"],
  });
}

export function createCoreHello(
  binding: SessionHelperBinding,
  keyId: string,
  coreNonce: Buffer,
): CoreHello {
  if (!isIdentifier(keyId) || !isNonce(coreNonce)) {
    throw new SessionHelperIpcError("PROTOCOL_ERROR");
  }
  return Object.freeze({
    type: "core_hello",
    ...binding,
    keyId,
    coreNonce: coreNonce.toString("base64url"),
  });
}

export function parseCoreHello(value: Buffer): CoreHello {
  const parsed = parseJsonRecord(value);
  if (
    !hasExactKeys(parsed, [
      "type",
      "protocolVersion",
      "deviceId",
      "helperId",
      "sessionId",
      "serviceEpoch",
      "releaseVersion",
      "keyId",
      "coreNonce",
    ]) ||
    parsed["type"] !== "core_hello" ||
    parsed["protocolVersion"] !== SESSION_HELPER_IPC_PROTOCOL_VERSION ||
    !isIdentifier(parsed["deviceId"]) ||
    !isIdentifier(parsed["helperId"]) ||
    !isIdentifier(parsed["sessionId"]) ||
    !isPositiveSafeInteger(parsed["serviceEpoch"]) ||
    !isReleaseVersion(parsed["releaseVersion"]) ||
    !isIdentifier(parsed["keyId"]) ||
    !isEncodedNonce(parsed["coreNonce"])
  ) {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return Object.freeze({
    type: "core_hello",
    protocolVersion: SESSION_HELPER_IPC_PROTOCOL_VERSION,
    deviceId: parsed["deviceId"],
    helperId: parsed["helperId"],
    sessionId: parsed["sessionId"],
    serviceEpoch: parsed["serviceEpoch"],
    releaseVersion: parsed["releaseVersion"],
    keyId: parsed["keyId"],
    coreNonce: parsed["coreNonce"],
  });
}

export function createHelperChallenge(
  hello: CoreHello,
  helperNonce: Buffer,
  proof: Buffer,
): HelperChallenge {
  if (!isNonce(helperNonce) || !isMac(proof)) {
    throw new SessionHelperIpcError("PROTOCOL_ERROR");
  }
  return Object.freeze({
    type: "helper_challenge",
    protocolVersion: SESSION_HELPER_IPC_PROTOCOL_VERSION,
    deviceId: hello.deviceId,
    helperId: hello.helperId,
    sessionId: hello.sessionId,
    serviceEpoch: hello.serviceEpoch,
    releaseVersion: hello.releaseVersion,
    keyId: hello.keyId,
    coreNonce: hello.coreNonce,
    helperNonce: helperNonce.toString("base64url"),
    proof: proof.toString("base64url"),
  });
}

export function parseHelperChallenge(value: Buffer): HelperChallenge {
  const parsed = parseJsonRecord(value);
  if (
    !hasExactKeys(parsed, [
      "type",
      "protocolVersion",
      "deviceId",
      "helperId",
      "sessionId",
      "serviceEpoch",
      "releaseVersion",
      "keyId",
      "coreNonce",
      "helperNonce",
      "proof",
    ]) ||
    parsed["type"] !== "helper_challenge" ||
    parsed["protocolVersion"] !== SESSION_HELPER_IPC_PROTOCOL_VERSION ||
    !isIdentifier(parsed["deviceId"]) ||
    !isIdentifier(parsed["helperId"]) ||
    !isIdentifier(parsed["sessionId"]) ||
    !isPositiveSafeInteger(parsed["serviceEpoch"]) ||
    !isReleaseVersion(parsed["releaseVersion"]) ||
    !isIdentifier(parsed["keyId"]) ||
    !isEncodedNonce(parsed["coreNonce"]) ||
    !isEncodedNonce(parsed["helperNonce"]) ||
    !isEncodedMac(parsed["proof"])
  ) {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return Object.freeze({
    type: "helper_challenge",
    protocolVersion: SESSION_HELPER_IPC_PROTOCOL_VERSION,
    deviceId: parsed["deviceId"],
    helperId: parsed["helperId"],
    sessionId: parsed["sessionId"],
    serviceEpoch: parsed["serviceEpoch"],
    releaseVersion: parsed["releaseVersion"],
    keyId: parsed["keyId"],
    coreNonce: parsed["coreNonce"],
    helperNonce: parsed["helperNonce"],
    proof: parsed["proof"],
  });
}

export function parseCoreProof(value: Buffer): CoreProof {
  const parsed = parseJsonRecord(value);
  if (
    !hasExactKeys(parsed, ["type", "protocolVersion", "proof"]) ||
    parsed["type"] !== "core_proof" ||
    parsed["protocolVersion"] !== SESSION_HELPER_IPC_PROTOCOL_VERSION ||
    !isEncodedMac(parsed["proof"])
  ) {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return Object.freeze({
    type: "core_proof",
    protocolVersion: SESSION_HELPER_IPC_PROTOCOL_VERSION,
    proof: parsed["proof"],
  });
}

export function encodeCoreProof(proof: Buffer): Buffer {
  if (!isMac(proof)) {
    throw new SessionHelperIpcError("PROTOCOL_ERROR");
  }
  return encodeJson({
    type: "core_proof",
    protocolVersion: SESSION_HELPER_IPC_PROTOCOL_VERSION,
    proof: proof.toString("base64url"),
  });
}

export function encodeJson(value: unknown): Buffer {
  try {
    return Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
}

export function decodeNonce(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (!isNonce(decoded) || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return decoded;
}

export function decodeMac(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (!isMac(decoded) || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return decoded;
}

export function bindingMatches(
  binding: SessionHelperBinding,
  value: Pick<
    CoreHello,
    "protocolVersion" | "deviceId" | "helperId" | "sessionId" | "serviceEpoch" | "releaseVersion"
  >,
): boolean {
  return (
    value.protocolVersion === binding.protocolVersion &&
    value.deviceId === binding.deviceId &&
    value.helperId === binding.helperId &&
    value.sessionId === binding.sessionId &&
    value.serviceEpoch === binding.serviceEpoch &&
    value.releaseVersion === binding.releaseVersion
  );
}

export function parseCapabilityRequest(value: unknown): SessionHelperCapabilityRequest {
  const envelope = parseCapabilityEnvelope(value, "request");
  switch (envelope.capability) {
    case "readiness":
      requireExactPayload(envelope.payload, []);
      return freezeRequest(envelope, {});
    case "capture": {
      const payload = requireExactPayload(envelope.payload, [
        "executionHandleId",
        "taskId",
        "runId",
        "persistenceGeneration",
        "leaseId",
        "fencingToken",
        "deadlineUnixMs",
        "displayFingerprint",
      ]);
      return freezeRequest(envelope, parseExecutionContext(payload));
    }
    case "observe": {
      const payload = requireExactPayload(envelope.payload, [
        "executionHandleId",
        "taskId",
        "runId",
        "persistenceGeneration",
        "leaseId",
        "fencingToken",
        "deadlineUnixMs",
        "displayFingerprint",
        "maxElements",
      ]);
      if (
        !isPositiveSafeInteger(payload["maxElements"]) ||
        payload["maxElements"] > MAX_OBSERVED_ELEMENTS
      ) {
        malformed();
      }
      return freezeRequest(envelope, {
        ...parseExecutionContext(payload),
        maxElements: payload["maxElements"] as number,
      });
    }
    case "exact_input": {
      const payload = requireExactPayload(envelope.payload, [
        "executionHandleId",
        "taskId",
        "runId",
        "persistenceGeneration",
        "leaseId",
        "fencingToken",
        "authorizationId",
        "policyFingerprint",
        "authorizedAction",
        "deadlineUnixMs",
        "displayFingerprint",
        "action",
      ]);
      for (const key of [
        "executionHandleId",
        "taskId",
        "runId",
        "leaseId",
        "authorizationId",
      ] as const) {
        if (!isIdentifier(payload[key])) {
          malformed();
        }
      }
      for (const key of ["persistenceGeneration", "fencingToken"] as const) {
        if (
          typeof payload[key] !== "string" ||
          !UNSIGNED_DECIMAL_PATTERN.test(payload[key]) ||
          payload[key] === "0"
        ) {
          malformed();
        }
      }
      if (
        typeof payload["policyFingerprint"] !== "string" ||
        !HASH_PATTERN.test(payload["policyFingerprint"])
      ) {
        malformed();
      }
      requireDeadline(payload["deadlineUnixMs"]);
      requireDisplayFingerprint(payload["displayFingerprint"]);
      return freezeRequest(envelope, {
        executionHandleId: payload["executionHandleId"] as string,
        taskId: payload["taskId"] as string,
        runId: payload["runId"] as string,
        persistenceGeneration: payload["persistenceGeneration"] as string,
        leaseId: payload["leaseId"] as string,
        fencingToken: payload["fencingToken"] as string,
        authorizationId: payload["authorizationId"] as string,
        policyFingerprint: payload["policyFingerprint"] as string,
        authorizedAction: parseAuthorizedAction(payload["authorizedAction"]),
        deadlineUnixMs: payload["deadlineUnixMs"] as number,
        displayFingerprint: payload["displayFingerprint"] as string,
        action: parseExactInputAction(payload["action"]),
      });
    }
    case "cancel": {
      const payload = requireExactPayload(envelope.payload, ["targetRequestId"]);
      if (!isIdentifier(payload["targetRequestId"])) {
        malformed();
      }
      return freezeRequest(envelope, {
        targetRequestId: payload["targetRequestId"] as string,
      });
    }
    case "emergency_stop": {
      const payload = requireExactPayload(envelope.payload, ["reasonCode"]);
      if (
        !["owner", "core_disconnect", "policy", "timeout"].includes(
          typeof payload["reasonCode"] === "string" ? payload["reasonCode"] : "",
        )
      ) {
        malformed();
      }
      return freezeRequest(envelope, {
        reasonCode: payload["reasonCode"] as "owner" | "core_disconnect" | "policy" | "timeout",
      });
    }
    case "diagnostics": {
      const payload = requireExactPayload(envelope.payload, ["maxEntries", "maxBytes"]);
      if (
        !isPositiveSafeInteger(payload["maxEntries"]) ||
        payload["maxEntries"] > MAX_DIAGNOSTIC_ENTRIES ||
        !isPositiveSafeInteger(payload["maxBytes"]) ||
        payload["maxBytes"] > 65_536
      ) {
        malformed();
      }
      return freezeRequest(envelope, {
        maxEntries: payload["maxEntries"] as number,
        maxBytes: payload["maxBytes"] as number,
      });
    }
  }
}

export function parseCapabilityResponse(value: unknown): SessionHelperCapabilityResponse {
  const envelope = parseCapabilityEnvelope(value, "response");
  if (
    !hasExactKeys(envelope.record, ["type", "requestId", "capability", "outcome", "payload"]) ||
    !["ok", "error"].includes(
      typeof envelope.record["outcome"] === "string" ? envelope.record["outcome"] : "",
    )
  ) {
    malformed();
  }
  const outcome = envelope.record["outcome"] as "ok" | "error";
  if (outcome === "error") {
    const payload = requireExactPayload(envelope.payload, ["code"]);
    if (!isCapabilityErrorCode(payload["code"])) {
      malformed();
    }
    return Object.freeze({
      type: "response",
      requestId: envelope.requestId,
      capability: envelope.capability,
      outcome: "error",
      payload: Object.freeze({ code: payload["code"] }),
    });
  }

  switch (envelope.capability) {
    case "readiness": {
      const payload = requireExactPayload(envelope.payload, [
        "interactiveSession",
        "unlockedSession",
        "captureAvailable",
        "observationAvailable",
        "inputAvailable",
        "emergencyStopAvailable",
        "displayFingerprint",
      ]);
      for (const key of [
        "interactiveSession",
        "unlockedSession",
        "captureAvailable",
        "observationAvailable",
        "inputAvailable",
        "emergencyStopAvailable",
      ] as const) {
        if (typeof payload[key] !== "boolean") {
          malformed();
        }
      }
      if (
        payload["displayFingerprint"] !== null &&
        !isBoundedText(payload["displayFingerprint"], DISPLAY_FINGERPRINT_MAX)
      ) {
        malformed();
      }
      return freezeResponse(envelope, "ok", {
        interactiveSession: payload["interactiveSession"] as boolean,
        unlockedSession: payload["unlockedSession"] as boolean,
        captureAvailable: payload["captureAvailable"] as boolean,
        observationAvailable: payload["observationAvailable"] as boolean,
        inputAvailable: payload["inputAvailable"] as boolean,
        emergencyStopAvailable: payload["emergencyStopAvailable"] as boolean,
        displayFingerprint: payload["displayFingerprint"] as string | null,
      });
    }
    case "capture": {
      const payload = requireExactPayload(envelope.payload, [
        "mediaType",
        "width",
        "height",
        "displayFingerprint",
        "bytesBase64Url",
      ]);
      if (
        payload["mediaType"] !== "image/png" ||
        !isPositiveSafeInteger(payload["width"]) ||
        payload["width"] > 32_768 ||
        !isPositiveSafeInteger(payload["height"]) ||
        payload["height"] > 32_768
      ) {
        malformed();
      }
      requireDisplayFingerprint(payload["displayFingerprint"]);
      requireBoundedBase64Url(payload["bytesBase64Url"], MAX_CAPTURE_BYTES);
      return freezeResponse(envelope, "ok", {
        mediaType: "image/png" as const,
        width: payload["width"] as number,
        height: payload["height"] as number,
        displayFingerprint: payload["displayFingerprint"] as string,
        bytesBase64Url: payload["bytesBase64Url"] as string,
      });
    }
    case "observe": {
      const payload = requireExactPayload(envelope.payload, ["displayFingerprint", "elements"]);
      requireDisplayFingerprint(payload["displayFingerprint"]);
      if (
        !Array.isArray(payload["elements"]) ||
        payload["elements"].length > MAX_OBSERVED_ELEMENTS
      ) {
        malformed();
      }
      const elements = payload["elements"].map(parseObservedElement);
      return freezeResponse(envelope, "ok", {
        displayFingerprint: payload["displayFingerprint"] as string,
        elements: Object.freeze(elements),
      });
    }
    case "exact_input": {
      const payload = requireExactPayload(envelope.payload, ["applied", "actionDigest"]);
      if (
        typeof payload["applied"] !== "boolean" ||
        typeof payload["actionDigest"] !== "string" ||
        !HASH_PATTERN.test(payload["actionDigest"])
      ) {
        malformed();
      }
      return freezeResponse(envelope, "ok", {
        applied: payload["applied"],
        actionDigest: payload["actionDigest"],
      });
    }
    case "cancel": {
      const payload = requireExactPayload(envelope.payload, ["cancelled"]);
      if (typeof payload["cancelled"] !== "boolean") {
        malformed();
      }
      return freezeResponse(envelope, "ok", { cancelled: payload["cancelled"] });
    }
    case "emergency_stop": {
      const payload = requireExactPayload(envelope.payload, ["stopped"]);
      if (typeof payload["stopped"] !== "boolean") {
        malformed();
      }
      return freezeResponse(envelope, "ok", { stopped: payload["stopped"] });
    }
    case "diagnostics": {
      const payload = requireExactPayload(envelope.payload, ["entries"]);
      if (
        !Array.isArray(payload["entries"]) ||
        payload["entries"].length > MAX_DIAGNOSTIC_ENTRIES
      ) {
        malformed();
      }
      const entries = payload["entries"].map(parseDiagnosticEntry);
      const result = { entries: Object.freeze(entries) };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 65_536) {
        malformed();
      }
      return freezeResponse(envelope, "ok", result);
    }
  }
}

function parseCapabilityEnvelope(
  value: unknown,
  expectedType: "request" | "response",
): {
  readonly record: Record<string, unknown>;
  readonly requestId: string;
  readonly capability: SessionHelperCapability;
  readonly payload: unknown;
} {
  if (!isRecord(value)) {
    malformed();
  }
  const record = value as Record<string, unknown>;
  if (
    record["type"] !== expectedType ||
    !isIdentifier(record["requestId"]) ||
    !isCapability(record["capability"])
  ) {
    malformed();
  }
  if (
    expectedType === "request" &&
    !hasExactKeys(record, ["type", "requestId", "capability", "payload"])
  ) {
    malformed();
  }
  return {
    record,
    requestId: record["requestId"] as string,
    capability: record["capability"] as SessionHelperCapability,
    payload: record["payload"],
  };
}

function freezeRequest<TPayload>(
  envelope: {
    readonly requestId: string;
    readonly capability: SessionHelperCapability;
  },
  payload: TPayload,
): SessionHelperCapabilityRequest {
  return Object.freeze({
    type: "request",
    requestId: envelope.requestId,
    capability: envelope.capability,
    payload: Object.freeze(payload),
  }) as SessionHelperCapabilityRequest;
}

function freezeResponse<TPayload>(
  envelope: {
    readonly requestId: string;
    readonly capability: SessionHelperCapability;
  },
  outcome: "ok",
  payload: TPayload,
): SessionHelperCapabilityResponse {
  return Object.freeze({
    type: "response",
    requestId: envelope.requestId,
    capability: envelope.capability,
    outcome,
    payload: Object.freeze(payload),
  }) as unknown as SessionHelperCapabilityResponse;
}

function parseExecutionContext(payload: Record<string, unknown>) {
  for (const key of ["executionHandleId", "taskId", "runId", "leaseId"] as const) {
    if (!isIdentifier(payload[key])) {
      malformed();
    }
  }
  for (const key of ["persistenceGeneration", "fencingToken"] as const) {
    if (
      typeof payload[key] !== "string" ||
      !UNSIGNED_DECIMAL_PATTERN.test(payload[key]) ||
      payload[key] === "0"
    ) {
      malformed();
    }
  }
  requireDeadline(payload["deadlineUnixMs"]);
  requireDisplayFingerprint(payload["displayFingerprint"]);
  return Object.freeze({
    executionHandleId: payload["executionHandleId"] as string,
    taskId: payload["taskId"] as string,
    runId: payload["runId"] as string,
    persistenceGeneration: payload["persistenceGeneration"] as string,
    leaseId: payload["leaseId"] as string,
    fencingToken: payload["fencingToken"] as string,
    deadlineUnixMs: payload["deadlineUnixMs"] as number,
    displayFingerprint: payload["displayFingerprint"] as string,
  });
}

function parseAuthorizedAction(value: unknown) {
  if (!isRecord(value)) {
    return malformed();
  }
  if (
    value["kind"] === "click" &&
    hasExactKeys(value, ["kind", "controlId"]) &&
    isIdentifier(value["controlId"])
  ) {
    return Object.freeze({
      kind: "click" as const,
      controlId: value["controlId"],
    });
  }
  if (
    value["kind"] === "type-text" &&
    hasExactKeys(value, ["kind", "controlId", "textSha256", "textLength"]) &&
    isIdentifier(value["controlId"]) &&
    typeof value["textSha256"] === "string" &&
    HASH_PATTERN.test(value["textSha256"]) &&
    Number.isSafeInteger(value["textLength"]) &&
    typeof value["textLength"] === "number" &&
    value["textLength"] >= 0 &&
    value["textLength"] <= TEXT_MAX
  ) {
    return Object.freeze({
      kind: "type-text" as const,
      controlId: value["controlId"],
      textSha256: value["textSha256"] as `sha256:${string}`,
      textLength: value["textLength"],
    });
  }
  return malformed();
}

function parseExactInputAction(value: unknown): SessionHelperExactInputAction {
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    malformed();
  }
  const operation = value["operation"];
  switch (value["kind"]) {
    case "pointer":
      requireCoordinate(value["x"]);
      requireCoordinate(value["y"]);
      if (operation === "move") {
        requireKeys(value, ["kind", "operation", "x", "y"]);
        return Object.freeze({
          kind: "pointer",
          operation: "move",
          x: value["x"] as number,
          y: value["y"] as number,
        });
      }
      if (operation === "click" || operation === "double_click") {
        requireKeys(value, ["kind", "operation", "x", "y", "button"]);
        if (!["primary", "secondary", "middle"].includes(String(value["button"]))) {
          malformed();
        }
        return Object.freeze({
          kind: "pointer",
          operation,
          x: value["x"] as number,
          y: value["y"] as number,
          button: value["button"] as "primary" | "secondary" | "middle",
        });
      }
      if (operation === "scroll") {
        requireKeys(value, ["kind", "operation", "x", "y", "deltaX", "deltaY"]);
        requireCoordinate(value["deltaX"]);
        requireCoordinate(value["deltaY"]);
        return Object.freeze({
          kind: "pointer",
          operation: "scroll",
          x: value["x"] as number,
          y: value["y"] as number,
          deltaX: value["deltaX"] as number,
          deltaY: value["deltaY"] as number,
        });
      }
      return malformed();
    case "keyboard":
      if (operation === "key") {
        requireKeys(value, ["kind", "operation", "key", "modifiers"]);
        if (
          !isBoundedText(value["key"], 64) ||
          !Array.isArray(value["modifiers"]) ||
          value["modifiers"].length > 4 ||
          new Set(value["modifiers"]).size !== value["modifiers"].length ||
          value["modifiers"].some(
            (modifier) => !["alt", "control", "meta", "shift"].includes(String(modifier)),
          )
        ) {
          malformed();
        }
        return Object.freeze({
          kind: "keyboard",
          operation: "key",
          key: value["key"],
          modifiers: Object.freeze([
            ...(value["modifiers"] as ("alt" | "control" | "meta" | "shift")[]),
          ]),
        });
      }
      if (operation === "text") {
        requireKeys(value, ["kind", "operation", "text"]);
        if (!isBoundedText(value["text"], TEXT_MAX, true)) {
          malformed();
        }
        return Object.freeze({
          kind: "keyboard",
          operation: "text",
          text: value["text"],
        });
      }
      return malformed();
    case "accessibility":
      if (operation === "invoke") {
        requireKeys(value, ["kind", "operation", "targetId"]);
        if (!isIdentifier(value["targetId"])) {
          malformed();
        }
        return Object.freeze({
          kind: "accessibility",
          operation: "invoke",
          targetId: value["targetId"],
        });
      }
      if (operation === "set_value" || operation === "select") {
        requireKeys(value, ["kind", "operation", "targetId", "value"]);
        if (!isIdentifier(value["targetId"]) || !isBoundedText(value["value"], TEXT_MAX, true)) {
          malformed();
        }
        return Object.freeze({
          kind: "accessibility",
          operation,
          targetId: value["targetId"],
          value: value["value"],
        });
      }
      return malformed();
    default:
      return malformed();
  }
}

function parseObservedElement(value: unknown): SessionHelperObservedElement {
  const record = requireExactPayload(value, [
    "elementId",
    "role",
    "label",
    "value",
    "enabled",
    "selected",
  ]);
  if (
    !isIdentifier(record["elementId"]) ||
    !isBoundedText(record["role"], 64) ||
    !isBoundedText(record["label"], 1_024, true) ||
    (record["value"] !== null && !isBoundedText(record["value"], TEXT_MAX, true)) ||
    typeof record["enabled"] !== "boolean" ||
    (record["selected"] !== null && typeof record["selected"] !== "boolean")
  ) {
    malformed();
  }
  return Object.freeze({
    elementId: record["elementId"] as string,
    role: record["role"] as string,
    label: record["label"] as string,
    value: record["value"] as string | null,
    enabled: record["enabled"] as boolean,
    selected: record["selected"] as boolean | null,
  });
}

function parseDiagnosticEntry(value: unknown): SessionHelperDiagnosticEntry {
  const record = requireExactPayload(value, ["code", "severity", "observedAtUnixMs"]);
  if (
    ![
      "cancelled",
      "capture_unavailable",
      "display_changed",
      "emergency_stopped",
      "helper_ready",
      "input_unavailable",
      "internal_failure",
      "permission_denied",
      "session_locked",
    ].includes(String(record["code"])) ||
    !["info", "warning", "error"].includes(String(record["severity"])) ||
    !isPositiveSafeInteger(record["observedAtUnixMs"])
  ) {
    malformed();
  }
  return Object.freeze({
    code: record["code"] as SessionHelperDiagnosticEntry["code"],
    severity: record["severity"] as "info" | "warning" | "error",
    observedAtUnixMs: record["observedAtUnixMs"] as number,
  });
}

function requireExactPayload(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    malformed();
  }
  return value as Record<string, unknown>;
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (!hasExactKeys(value, keys)) {
    malformed();
  }
}

function requireDeadline(value: unknown): void {
  if (!isPositiveSafeInteger(value)) {
    malformed();
  }
}

function requireDisplayFingerprint(value: unknown): void {
  if (!isBoundedText(value, DISPLAY_FINGERPRINT_MAX)) {
    malformed();
  }
}

function requireCoordinate(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    malformed();
  }
}

function requireBoundedBase64Url(value: unknown, maxBytes: number): void {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    value.length > Math.ceil((maxBytes * 4) / 3)
  ) {
    malformed();
  }
  const decoded = Buffer.from(value, "base64url");
  const valid =
    decoded.length > 0 && decoded.length <= maxBytes && decoded.toString("base64url") === value;
  decoded.fill(0);
  if (!valid) {
    malformed();
  }
}

function parseJsonRecord(value: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value.toString("utf8"));
    if (!isRecord(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IDENTIFIER_MAX &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function isBoundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= max &&
    !value.includes("\u0000")
  );
}

function isReleaseVersion(value: unknown): value is string {
  return (
    isBoundedText(value, RELEASE_VERSION_MAX) &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonce(value: Buffer): boolean {
  return Buffer.isBuffer(value) && value.length === 32;
}

function isMac(value: Buffer): boolean {
  return Buffer.isBuffer(value) && value.length === 32;
}

function isEncodedNonce(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  const valid = isNonce(decoded) && decoded.toString("base64url") === value;
  decoded.fill(0);
  return valid;
}

function isEncodedMac(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  const valid = isMac(decoded) && decoded.toString("base64url") === value;
  decoded.fill(0);
  return valid;
}

function isCapability(value: unknown): value is SessionHelperCapability {
  return (
    typeof value === "string" &&
    [
      "readiness",
      "capture",
      "observe",
      "exact_input",
      "cancel",
      "emergency_stop",
      "diagnostics",
    ].includes(value)
  );
}

function isCapabilityErrorCode(value: unknown): value is SessionHelperCapabilityErrorCode {
  return (
    typeof value === "string" &&
    [
      "cancelled",
      "deadline_exceeded",
      "display_changed",
      "not_ready",
      "permission_denied",
      "rejected",
      "stale_authority",
      "unsupported",
    ].includes(value)
  );
}

function malformed(): never {
  throw new SessionHelperIpcError("MALFORMED_MESSAGE");
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}
