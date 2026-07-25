import { createHash } from "node:crypto";

import {
  COMPUTER_USE_TOOL_NAMES,
  type ComputerUseClickInput,
  type ComputerUseKeyInput,
  type ComputerUseKeyModifier,
  type ComputerUseRunAuthority,
  type ComputerUseScrollInput,
  type ComputerUseStopInput,
  type ComputerUseToolActionReceipt,
  type ComputerUseToolCapture,
  type ComputerUseToolContext,
  type ComputerUseToolName,
  type ComputerUseToolObservation,
  type ComputerUseToolPort,
  type ComputerUseToolReadiness,
  type ComputerUseToolStopReceipt,
  type ComputerUseTypeTextInput,
} from "./contracts.ts";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KEY_MODIFIERS = new Set<ComputerUseKeyModifier>(["alt", "control", "meta", "shift"]);

export type ParsedComputerUseToolCall =
  | { readonly name: "computer_use_readiness" }
  | { readonly name: "computer_use_observe" }
  | { readonly name: "computer_use_capture" }
  | { readonly name: "computer_use_click"; readonly input: ComputerUseClickInput }
  | {
      readonly name: "computer_use_type_text";
      readonly input: ComputerUseTypeTextInput;
    }
  | { readonly name: "computer_use_key"; readonly input: ComputerUseKeyInput }
  | { readonly name: "computer_use_scroll"; readonly input: ComputerUseScrollInput }
  | { readonly name: "computer_use_stop"; readonly input: ComputerUseStopInput };

export class InvalidComputerUsePortResultError extends Error {
  public constructor() {
    super("The Computer Use execution port returned an invalid result.");
    this.name = "InvalidComputerUsePortResultError";
  }
}

export function normalizeComputerUseRunAuthority(
  value: ComputerUseRunAuthority,
): ComputerUseRunAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "taskId",
      "workOrderId",
      "runId",
      "deviceId",
      "executionHandleId",
      "lease",
      "desktopAuthority",
    ]) ||
    !isIdentifier(value.taskId, 256) ||
    !isIdentifier(value.workOrderId, 256) ||
    !isIdentifier(value.runId, 256) ||
    !isIdentifier(value.deviceId, 256) ||
    !isIdentifier(value.executionHandleId, 256) ||
    !isRecord(value.lease) ||
    !hasExactKeys(value.lease, [
      "resourceName",
      "capacity",
      "leaseId",
      "fencingToken",
      "expiresAtMs",
    ]) ||
    value.lease.resourceName !== "desktop-session" ||
    value.lease.capacity !== 1 ||
    !isIdentifier(value.lease.leaseId, 256) ||
    !isPositiveSafeInteger(value.lease.fencingToken) ||
    !isPositiveSafeInteger(value.lease.expiresAtMs) ||
    !isRecord(value.desktopAuthority) ||
    !hasExactKeys(value.desktopAuthority, [
      "helperInstanceId",
      "serviceEpoch",
      "persistenceGeneration",
    ]) ||
    !isIdentifier(value.desktopAuthority.helperInstanceId, 256) ||
    !isPositiveSafeInteger(value.desktopAuthority.serviceEpoch) ||
    !isPositiveSafeInteger(value.desktopAuthority.persistenceGeneration)
  ) {
    throw new TypeError("Computer Use MCP Run authority is invalid.");
  }
  return Object.freeze({
    taskId: value.taskId,
    workOrderId: value.workOrderId,
    runId: value.runId,
    deviceId: value.deviceId,
    executionHandleId: value.executionHandleId,
    lease: Object.freeze({
      resourceName: "desktop-session",
      capacity: 1,
      leaseId: value.lease.leaseId,
      fencingToken: value.lease.fencingToken,
      expiresAtMs: value.lease.expiresAtMs,
    }),
    desktopAuthority: Object.freeze({
      helperInstanceId: value.desktopAuthority.helperInstanceId,
      serviceEpoch: value.desktopAuthority.serviceEpoch,
      persistenceGeneration: value.desktopAuthority.persistenceGeneration,
    }),
  });
}

export function requireComputerUseToolPort(value: ComputerUseToolPort): ComputerUseToolPort {
  const candidate = value as unknown;
  if (
    !isRecord(candidate) ||
    !COMPUTER_USE_TOOL_NAMES.every((name) => {
      const methodName = portMethodName(name);
      return typeof candidate[methodName] === "function";
    })
  ) {
    throw new TypeError("Computer Use MCP execution port is invalid.");
  }
  return value;
}

export function parseComputerUseToolCall(
  name: unknown,
  argumentsValue: unknown,
): ParsedComputerUseToolCall | null {
  if (
    typeof name !== "string" ||
    !COMPUTER_USE_TOOL_NAMES.includes(name as ComputerUseToolName) ||
    !isRecord(argumentsValue)
  ) {
    return null;
  }
  switch (name as ComputerUseToolName) {
    case "computer_use_readiness":
      return Object.keys(argumentsValue).length === 0 ? { name: "computer_use_readiness" } : null;
    case "computer_use_observe":
      return Object.keys(argumentsValue).length === 0 ? { name: "computer_use_observe" } : null;
    case "computer_use_capture":
      return Object.keys(argumentsValue).length === 0 ? { name: "computer_use_capture" } : null;
    case "computer_use_click":
      return parseClick(argumentsValue);
    case "computer_use_type_text":
      return parseTypeText(argumentsValue);
    case "computer_use_key":
      return parseKey(argumentsValue);
    case "computer_use_scroll":
      return parseScroll(argumentsValue);
    case "computer_use_stop":
      return parseStop(argumentsValue);
  }
}

export async function executeComputerUseTool(
  port: ComputerUseToolPort,
  authority: ComputerUseRunAuthority,
  call: ParsedComputerUseToolCall,
  signal: AbortSignal,
  maxCaptureBytes: number,
): Promise<Readonly<Record<string, unknown>>> {
  const context: ComputerUseToolContext = Object.freeze({ authority, signal });
  switch (call.name) {
    case "computer_use_readiness":
      return textToolResult(normalizeReadiness(await port.readiness(context)));
    case "computer_use_observe":
      return textToolResult(normalizeObservation(await port.observe(context)));
    case "computer_use_capture":
      return captureToolResult(normalizeCapture(await port.capture(context), maxCaptureBytes));
    case "computer_use_click":
      return textToolResult(normalizeActionReceipt(await port.click(context, call.input)));
    case "computer_use_type_text":
      return textToolResult(normalizeActionReceipt(await port.typeText(context, call.input)));
    case "computer_use_key":
      return textToolResult(normalizeActionReceipt(await port.key(context, call.input)));
    case "computer_use_scroll":
      return textToolResult(normalizeActionReceipt(await port.scroll(context, call.input)));
    case "computer_use_stop":
      return textToolResult(normalizeStopReceipt(await port.stop(context, call.input)));
  }
}

function parseClick(value: Readonly<Record<string, unknown>>): ParsedComputerUseToolCall | null {
  return hasExactRequiredKeys(value, ["controlId"], ["controlId"]) &&
    isIdentifier(value.controlId, 256)
    ? { name: "computer_use_click", input: { controlId: value.controlId } }
    : null;
}

function parseTypeText(value: Readonly<Record<string, unknown>>): ParsedComputerUseToolCall | null {
  return hasExactRequiredKeys(value, ["controlId", "text"], ["controlId", "text"]) &&
    isIdentifier(value.controlId, 256) &&
    isDisplayText(value.text, 16_384)
    ? {
        name: "computer_use_type_text",
        input: { controlId: value.controlId, text: value.text },
      }
    : null;
}

function parseKey(value: Readonly<Record<string, unknown>>): ParsedComputerUseToolCall | null {
  if (!hasExactRequiredKeys(value, ["key", "modifiers"], ["key"]) || !isIdentifier(value.key, 64)) {
    return null;
  }
  if (!hasOwn(value, "modifiers")) {
    return { name: "computer_use_key", input: { key: value.key } };
  }
  if (
    !Array.isArray(value.modifiers) ||
    value.modifiers.length > 4 ||
    !value.modifiers.every(
      (modifier): modifier is ComputerUseKeyModifier =>
        typeof modifier === "string" && KEY_MODIFIERS.has(modifier as ComputerUseKeyModifier),
    ) ||
    new Set(value.modifiers).size !== value.modifiers.length
  ) {
    return null;
  }
  return {
    name: "computer_use_key",
    input: { key: value.key, modifiers: Object.freeze([...value.modifiers]) },
  };
}

function parseScroll(value: Readonly<Record<string, unknown>>): ParsedComputerUseToolCall | null {
  return hasExactRequiredKeys(value, ["deltaX", "deltaY"], ["deltaX", "deltaY"]) &&
    isIntegerInRange(value.deltaX, -10_000, 10_000) &&
    isIntegerInRange(value.deltaY, -10_000, 10_000)
    ? {
        name: "computer_use_scroll",
        input: { deltaX: value.deltaX, deltaY: value.deltaY },
      }
    : null;
}

function parseStop(value: Readonly<Record<string, unknown>>): ParsedComputerUseToolCall | null {
  return hasExactRequiredKeys(value, ["mode"], ["mode"]) &&
    (value.mode === "cancel" || value.mode === "emergency-stop")
    ? { name: "computer_use_stop", input: { mode: value.mode } }
    : null;
}

function normalizeReadiness(value: ComputerUseToolReadiness): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "osFamily", "backendId", "displayFingerprint", "checks"]) ||
    (value.status !== "ready" && value.status !== "unavailable") ||
    (value.osFamily !== "linux" && value.osFamily !== "macos" && value.osFamily !== "windows") ||
    !isIdentifier(value.backendId, 256) ||
    (value.displayFingerprint !== null && !isIdentifier(value.displayFingerprint, 512)) ||
    !Array.isArray(value.checks) ||
    value.checks.length > 32
  ) {
    throw new InvalidComputerUsePortResultError();
  }
  const names = new Set<string>();
  const checks = value.checks.map((check) => {
    if (
      !isRecord(check) ||
      !hasExactKeys(check, ["name", "status", "evidence", "remediation"]) ||
      !isIdentifier(check.name, 128) ||
      names.has(check.name) ||
      (check.status !== "fail" && check.status !== "pass" && check.status !== "unknown") ||
      !isDisplayText(check.evidence, 2_048) ||
      (hasOwn(check, "remediation") && !isDisplayText(check.remediation, 2_048))
    ) {
      throw new InvalidComputerUsePortResultError();
    }
    names.add(check.name);
    return hasOwn(check, "remediation")
      ? {
          name: check.name,
          status: check.status,
          evidence: check.evidence,
          remediation: check.remediation,
        }
      : {
          name: check.name,
          status: check.status,
          evidence: check.evidence,
        };
  });
  return {
    status: value.status,
    osFamily: value.osFamily,
    backendId: value.backendId,
    displayFingerprint: value.displayFingerprint,
    checks,
  };
}

function normalizeObservation(
  value: ComputerUseToolObservation,
): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["displayFingerprint", "summary", "controls"]) ||
    !isIdentifier(value.displayFingerprint, 512) ||
    !isDisplayText(value.summary, 16_384, true) ||
    !Array.isArray(value.controls) ||
    value.controls.length > 512
  ) {
    throw new InvalidComputerUsePortResultError();
  }
  const controlIds = new Set<string>();
  const controls = value.controls.map((control) => {
    if (
      !isRecord(control) ||
      !hasExactKeys(control, ["controlId", "role", "label", "value", "selected"]) ||
      !isIdentifier(control.controlId, 256) ||
      controlIds.has(control.controlId) ||
      !isIdentifier(control.role, 128) ||
      !isDisplayText(control.label, 1_024) ||
      (hasOwn(control, "value") && !isDisplayText(control.value, 4_096, true)) ||
      (hasOwn(control, "selected") && typeof control.selected !== "boolean")
    ) {
      throw new InvalidComputerUsePortResultError();
    }
    controlIds.add(control.controlId);
    return {
      controlId: control.controlId,
      role: control.role,
      label: control.label,
      ...(hasOwn(control, "value") ? { value: control.value } : {}),
      ...(hasOwn(control, "selected") ? { selected: control.selected } : {}),
    };
  });
  return {
    displayFingerprint: value.displayFingerprint,
    summary: value.summary,
    controls,
  };
}

function normalizeCapture(
  value: ComputerUseToolCapture,
  maxCaptureBytes: number,
): ComputerUseToolCapture {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["png", "width", "height", "capturedAtMs", "displayFingerprint"]) ||
    !(value.png instanceof Uint8Array) ||
    value.png.byteLength < PNG_SIGNATURE.byteLength ||
    value.png.byteLength > maxCaptureBytes ||
    !PNG_SIGNATURE.every((byte, index) => value.png[index] === byte) ||
    !isIntegerInRange(value.width, 1, 32_768) ||
    !isIntegerInRange(value.height, 1, 32_768) ||
    !isNonNegativeSafeInteger(value.capturedAtMs) ||
    !isIdentifier(value.displayFingerprint, 512)
  ) {
    throw new InvalidComputerUsePortResultError();
  }
  return {
    png: value.png,
    width: value.width,
    height: value.height,
    capturedAtMs: value.capturedAtMs,
    displayFingerprint: value.displayFingerprint,
  };
}

function normalizeActionReceipt(
  value: ComputerUseToolActionReceipt,
): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sequence", "executedAtMs", "displayFingerprint"]) ||
    !isPositiveSafeInteger(value.sequence) ||
    !isNonNegativeSafeInteger(value.executedAtMs) ||
    !isIdentifier(value.displayFingerprint, 512)
  ) {
    throw new InvalidComputerUsePortResultError();
  }
  return {
    sequence: value.sequence,
    executedAtMs: value.executedAtMs,
    displayFingerprint: value.displayFingerprint,
  };
}

function normalizeStopReceipt(
  value: ComputerUseToolStopReceipt,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !hasExactKeys(value, ["status"]) || value.status !== "stopped") {
    throw new InvalidComputerUsePortResultError();
  }
  return { status: "stopped" };
}

function textToolResult(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}

function captureToolResult(value: ComputerUseToolCapture): Readonly<Record<string, unknown>> {
  const sha256 = `sha256:${createHash("sha256").update(value.png).digest("hex")}`;
  return {
    content: [
      {
        type: "image",
        data: Buffer.from(value.png).toString("base64"),
        mimeType: "image/png",
      },
      {
        type: "text",
        text: JSON.stringify({
          width: value.width,
          height: value.height,
          sha256,
          capturedAtMs: value.capturedAtMs,
          displayFingerprint: value.displayFingerprint,
        }),
      },
    ],
    isError: false,
  };
}

function portMethodName(name: ComputerUseToolName): keyof ComputerUseToolPort {
  switch (name) {
    case "computer_use_readiness":
      return "readiness";
    case "computer_use_observe":
      return "observe";
    case "computer_use_capture":
      return "capture";
    case "computer_use_click":
      return "click";
    case "computer_use_type_text":
      return "typeText";
    case "computer_use_key":
      return "key";
    case "computer_use_scroll":
      return "scroll";
    case "computer_use_stop":
      return "stop";
  }
}

function hasExactRequiredKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  return hasExactKeys(value, allowed) && required.every((key) => hasOwn(value, key));
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    isDisplayText(value, maximumLength)
  );
}

function isDisplayText(value: unknown, maximumLength: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximumLength &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        (codePoint >= 32 || codePoint === 9 || codePoint === 10 || codePoint === 13) &&
        codePoint !== 127
      );
    })
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}
