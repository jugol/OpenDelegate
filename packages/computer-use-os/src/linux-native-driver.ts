import {
  NativeDriverError,
  SUPPORTED_GRAPHICAL_LINUX_TARGET,
  type NativeActionReceipt,
  type NativeCapture,
  type NativeComputerUseAction,
  type NativeComputerUseDriver,
  type NativeDriverAuthorizedInputContext,
  type NativeDriverControlContext,
  type NativeDriverErrorCode,
  type NativeDriverExecutionContext,
  type NativeDriverProbe,
  type NativeObservation,
  type ReadinessCheckName,
} from "./contracts.ts";
import { requireExactNativeInputAuthorization } from "./input-authorization.ts";

export const LINUX_NATIVE_BACKEND_ID = "linux-atspi-xdg-portal-pipewire" as const;

const REQUIRED_CHECKS = new Set<ReadinessCheckName>([
  "interactive-session",
  "unlocked-session",
  "screen-capture",
  "accessibility",
  "input",
  "helper-authentication",
]);
const MAX_IDENTIFIER_BYTES = 256;
const MAX_RELEASE_VERSION_BYTES = 128;
const MAX_ACCESSIBILITY_CONTROLS = 2_048;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Authentication evidence supplied by ADR-0011's mutually authenticated
 * core-to-user-session-helper channel. The Python/GLib child is reachable only
 * through inherited anonymous stdio owned by this already-authenticated helper.
 */
export interface LinuxAuthenticatedHelperSession {
  readonly authentication: "adr-0011-ed25519-v2";
  readonly helperInstanceId: string;
  readonly osSessionIdentity: string;
  readonly releaseVersion: string;
  readonly serviceEpoch: number;
}

/**
 * Narrow native capability owned by the authenticated GNOME user-session helper.
 * It is deliberately not a shell or general-purpose D-Bus proxy.
 */
export interface LinuxNativeHelperPort {
  currentSession(): LinuxAuthenticatedHelperSession;
  probe(): Promise<NativeDriverProbe>;
  observe(context: NativeDriverExecutionContext): Promise<NativeObservation>;
  capture(context: NativeDriverExecutionContext): Promise<NativeCapture>;
  act(
    context: NativeDriverAuthorizedInputContext,
    action: NativeComputerUseAction,
  ): Promise<NativeActionReceipt>;
  cancel(context: NativeDriverControlContext): Promise<void>;
  emergencyStop(context: NativeDriverControlContext): Promise<void>;
  close?(): Promise<void>;
}

export interface LinuxNativeComputerUseDriverOptions {
  readonly helper: LinuxNativeHelperPort;
}

/**
 * Production-candidate facade for Ubuntu 24.04 GNOME Wayland. Portal consent,
 * AT-SPI, PipeWire capture, and RemoteDesktop input stay inside the logged-in
 * user-session helper; this facade consumes but never mints Policy or lease
 * authority.
 */
export class LinuxNativeComputerUseDriver implements NativeComputerUseDriver {
  public readonly osFamily = "linux" as const;
  readonly #helper: LinuxNativeHelperPort;
  readonly #session: LinuxAuthenticatedHelperSession;

  public constructor(options: LinuxNativeComputerUseDriverOptions) {
    this.#helper = options.helper;
    this.#session = freezeSession(assertAuthenticatedSession(options.helper.currentSession()));
  }

  public async probe(): Promise<NativeDriverProbe> {
    const probe = await this.#invoke(() => this.#helper.probe());
    assertProbe(probe, this.#session);
    return Object.freeze({
      ...probe,
      checks: Object.freeze(probe.checks.map((check) => Object.freeze({ ...check }))),
    });
  }

  public async observe(context: NativeDriverExecutionContext): Promise<NativeObservation> {
    this.#assertExecutionContext(context);
    const observation = await this.#invoke(() => this.#helper.observe(context));
    assertObservation(observation);
    assertExpectedDisplay(context.expectedDisplayFingerprint, observation.displayFingerprint);
    return observation;
  }

  public async capture(context: NativeDriverExecutionContext): Promise<NativeCapture> {
    this.#assertExecutionContext(context);
    const capture = await this.#invoke(() => this.#helper.capture(context));
    assertCapture(capture);
    assertExpectedDisplay(context.expectedDisplayFingerprint, capture.displayFingerprint);
    return capture;
  }

  public async act(
    context: NativeDriverAuthorizedInputContext,
    action: NativeComputerUseAction,
  ): Promise<NativeActionReceipt> {
    this.#assertExecutionContext(context);
    assertAction(action);
    requireExactNativeInputAuthorization(context, action);
    const receipt = await this.#invoke(() => this.#helper.act(context, action));
    assertReceipt(receipt);
    assertExpectedDisplay(context.expectedDisplayFingerprint, receipt.displayFingerprint);
    return receipt;
  }

  public async cancel(context: NativeDriverControlContext): Promise<void> {
    assertControlContext(context);
    await this.#invoke(() => this.#helper.cancel(context));
  }

  public async emergencyStop(context: NativeDriverControlContext): Promise<void> {
    assertControlContext(context);
    await this.#invoke(() => this.#helper.emergencyStop(context));
  }

  #assertExecutionContext(context: NativeDriverExecutionContext): void {
    assertControlContext(context);
    if (
      context.helperInstanceId !== this.#session.helperInstanceId ||
      context.serviceEpoch !== this.#session.serviceEpoch
    ) {
      throw nativeFailure(
        "HELPER_CRASHED",
        "The authenticated Linux helper identity or service epoch changed.",
      );
    }
    requireIdentifier(context.expectedDisplayFingerprint, "display fingerprint");
    if (context.signal.aborted) {
      throw nativeFailure("CANCELLED", "The Linux native operation was cancelled.");
    }
  }

  async #invoke<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertSessionStillCurrent();
    try {
      const result = await operation();
      this.#assertSessionStillCurrent();
      return result;
    } catch (error: unknown) {
      if (error instanceof NativeDriverError) {
        throw nativeFailure(error.code, nativeMessage(error.code));
      }
      throw nativeFailure("HELPER_CRASHED", "The Linux native helper stopped responding safely.");
    }
  }

  #assertSessionStillCurrent(): void {
    const current = assertAuthenticatedSession(this.#helper.currentSession());
    if (
      current.helperInstanceId !== this.#session.helperInstanceId ||
      current.osSessionIdentity !== this.#session.osSessionIdentity ||
      current.releaseVersion !== this.#session.releaseVersion ||
      current.serviceEpoch !== this.#session.serviceEpoch
    ) {
      throw nativeFailure("HELPER_CRASHED", "The authenticated Linux helper session was replaced.");
    }
  }
}

function assertAuthenticatedSession(
  session: LinuxAuthenticatedHelperSession,
): LinuxAuthenticatedHelperSession {
  if (session.authentication !== "adr-0011-ed25519-v2") {
    throw nativeFailure(
      "UNAVAILABLE",
      "The Linux native child requires an ADR-0011 authenticated helper session.",
    );
  }
  requireIdentifier(session.helperInstanceId, "helper instance ID");
  requireIdentifier(session.osSessionIdentity, "OS session identity");
  requireIdentifier(session.releaseVersion, "release version", MAX_RELEASE_VERSION_BYTES);
  if (!Number.isSafeInteger(session.serviceEpoch) || session.serviceEpoch <= 0) {
    throw nativeFailure("UNAVAILABLE", "The Linux helper service epoch is invalid.");
  }
  return session;
}

function freezeSession(session: LinuxAuthenticatedHelperSession): LinuxAuthenticatedHelperSession {
  return Object.freeze({ ...session });
}

function assertProbe(probe: NativeDriverProbe, session: LinuxAuthenticatedHelperSession): void {
  if (
    probe.osFamily !== "linux" ||
    probe.backendId !== LINUX_NATIVE_BACKEND_ID ||
    probe.helperInstanceId !== session.helperInstanceId ||
    probe.serviceEpoch !== session.serviceEpoch
  ) {
    throw nativeFailure(
      "HELPER_CRASHED",
      "The Linux helper returned an invalid readiness binding.",
    );
  }
  if (probe.linuxTarget !== SUPPORTED_GRAPHICAL_LINUX_TARGET) {
    throw nativeFailure("UNAVAILABLE", "The helper did not prove Ubuntu 24.04 GNOME Wayland.");
  }
  if (probe.displayFingerprint !== null) {
    requireIdentifier(probe.displayFingerprint, "display fingerprint");
  }
  const seen = new Set<ReadinessCheckName>();
  for (const check of probe.checks) {
    if (
      !REQUIRED_CHECKS.has(check.name) ||
      seen.has(check.name) ||
      !["fail", "pass", "unknown"].includes(check.status) ||
      typeof check.evidence !== "string" ||
      check.evidence.length === 0 ||
      Buffer.byteLength(check.evidence, "utf8") > 4_096 ||
      (check.remediation !== undefined &&
        (typeof check.remediation !== "string" ||
          check.remediation.length === 0 ||
          Buffer.byteLength(check.remediation, "utf8") > 4_096))
    ) {
      throw nativeFailure(
        "HELPER_CRASHED",
        "The Linux helper returned invalid readiness evidence.",
      );
    }
    seen.add(check.name);
  }
  if (seen.size !== REQUIRED_CHECKS.size) {
    throw nativeFailure("HELPER_CRASHED", "The Linux helper omitted readiness evidence.");
  }
  if (probe.checks.every((check) => check.status === "pass") && probe.displayFingerprint === null) {
    throw nativeFailure(
      "HELPER_CRASHED",
      "A ready Linux portal session omitted its display fingerprint.",
    );
  }
}

function assertObservation(observation: NativeObservation): void {
  requireIdentifier(observation.displayFingerprint, "display fingerprint");
  if (
    !Array.isArray(observation.accessibilityTree) ||
    observation.accessibilityTree.length > MAX_ACCESSIBILITY_CONTROLS
  ) {
    throw nativeFailure("HELPER_CRASHED", "The Linux AT-SPI observation is invalid.");
  }
  for (const control of observation.accessibilityTree) {
    requireIdentifier(control.controlId, "control ID");
    requireIdentifier(control.label, "control label");
    if (!["button", "radio", "textbox"].includes(control.role)) {
      throw nativeFailure("HELPER_CRASHED", "The Linux accessibility role is invalid.");
    }
  }
}

function assertCapture(capture: NativeCapture): void {
  requireIdentifier(capture.displayFingerprint, "display fingerprint");
  if (
    capture.mediaType !== "image/png" ||
    !Number.isSafeInteger(capture.width) ||
    capture.width <= 0 ||
    !Number.isSafeInteger(capture.height) ||
    capture.height <= 0 ||
    !(capture.bytes instanceof Uint8Array) ||
    capture.bytes.byteLength < PNG_SIGNATURE.length ||
    capture.bytes.byteLength > MAX_CAPTURE_BYTES ||
    !PNG_SIGNATURE.every((value, index) => capture.bytes[index] === value)
  ) {
    throw nativeFailure("UNAVAILABLE", "The Linux PipeWire capture result is not a valid PNG.");
  }
}

function assertReceipt(receipt: NativeActionReceipt): void {
  requireIdentifier(receipt.displayFingerprint, "display fingerprint");
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence <= 0) {
    throw nativeFailure("HELPER_CRASHED", "The Linux native action receipt is invalid.");
  }
}

function assertAction(action: NativeComputerUseAction): void {
  requireIdentifier(action.controlId, "control ID");
  if (action.kind === "type-text") {
    if (
      typeof action.text !== "string" ||
      action.text.length === 0 ||
      Buffer.byteLength(action.text, "utf8") > 1_048_576
    ) {
      throw nativeFailure("UNAVAILABLE", "The Linux text input is invalid.");
    }
    return;
  }
  if (action.kind !== "click") {
    throw nativeFailure("UNAVAILABLE", "The Linux native action is unsupported.");
  }
}

function assertControlContext(context: NativeDriverControlContext): void {
  requireIdentifier(context.executionHandleId, "execution handle ID");
  requireIdentifier(context.taskId, "Task ID");
  requireIdentifier(context.deviceId, "Device ID");
  requireIdentifier(context.runId, "Run ID");
}

function assertExpectedDisplay(expected: string, actual: string): void {
  if (expected !== actual) {
    throw nativeFailure(
      "DISPLAY_CHANGED",
      "The GNOME portal display stream changed during Computer Use.",
    );
  }
}

function requireIdentifier(value: string, name: string, maximumBytes = MAX_IDENTIFIER_BYTES): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw nativeFailure("UNAVAILABLE", `The ${name} is invalid.`);
  }
}

function nativeFailure(code: NativeDriverErrorCode, message: string): NativeDriverError {
  return new NativeDriverError(code, message);
}

function nativeMessage(code: NativeDriverErrorCode): string {
  switch (code) {
    case "CANCELLED":
      return "The Linux native operation was cancelled.";
    case "DISPLAY_CHANGED":
      return "The GNOME portal display stream changed.";
    case "EMERGENCY_STOPPED":
      return "The Linux native helper emergency stop is active.";
    case "HELPER_CRASHED":
      return "The Linux native helper is unavailable.";
    case "PERMISSION_DENIED":
      return "The Linux portal or AT-SPI permission is unavailable.";
    case "SESSION_LOCKED":
      return "The active GNOME Wayland session is not safely unlocked.";
    case "TIMEOUT":
      return "The Linux native operation timed out.";
    case "UNAVAILABLE":
      return "The Linux native capability is unavailable.";
  }
}
