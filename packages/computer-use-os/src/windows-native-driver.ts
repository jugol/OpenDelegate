import {
  NativeDriverError,
  type FixtureObservation,
  type NativeActionReceipt,
  type NativeCapture,
  type NativeComputerUseAction,
  type NativeComputerUseDriver,
  type NativeDriverAuthorizedInputContext,
  type NativeDriverControlContext,
  type NativeDriverExecutionContext,
  type NativeDriverProbe,
  type NativeObservation,
  type ReadinessCheck,
} from "./contracts.ts";
import { requireExactNativeInputAuthorization } from "./input-authorization.ts";

const WINDOWS_HELPER_PROTOCOL_VERSION = 1 as const;
const WINDOWS_BACKEND_ID = "windows-uia-wgc-sendinput-v1";
const MAX_CONTROL_COUNT = 10_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_STRING_LENGTH = 1_000_000;

export interface WindowsAuthenticatedHelperBinding {
  readonly protocolVersion: typeof WINDOWS_HELPER_PROTOCOL_VERSION;
  readonly expectedHelperInstanceId: string;
  readonly expectedServiceEpoch: number;
  readonly expectedSessionIdentity: string;
  readonly expectedReleaseVersion: string;
}

export interface WindowsHelperExecutionScope {
  readonly executionHandleId: string;
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly helperInstanceId: string;
  readonly serviceEpoch: number;
  readonly persistenceGeneration: number;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly expectedDisplayFingerprint: string;
}

export interface WindowsHelperAuthorizedExecutionScope extends WindowsHelperExecutionScope {
  readonly authorization: NativeDriverAuthorizedInputContext["authorization"];
}

export interface WindowsHelperControlScope {
  readonly executionHandleId: string;
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
}

export type WindowsAuthenticatedHelperCommand =
  | (WindowsAuthenticatedHelperBinding & {
      readonly kind: "probe";
    })
  | (WindowsAuthenticatedHelperBinding & {
      readonly kind: "observe" | "capture";
      readonly scope: WindowsHelperExecutionScope;
    })
  | (WindowsAuthenticatedHelperBinding & {
      readonly kind: "act";
      readonly scope: WindowsHelperAuthorizedExecutionScope;
      /**
       * `text` is intentionally present only on this final native mutation command.
       * The helper transport MUST NOT log, persist, or echo it.
       */
      readonly action: NativeComputerUseAction;
    })
  | (WindowsAuthenticatedHelperBinding & {
      readonly kind: "cancel" | "emergency-stop";
      readonly scope: WindowsHelperControlScope;
    });

export interface WindowsHelperReadiness {
  readonly interactiveSession: boolean;
  readonly unlockedSession: boolean;
  readonly captureSupported: boolean;
  readonly captureTargetSelected: boolean;
  readonly frameReady: boolean;
  readonly accessibilityAvailable: boolean;
  readonly fixtureControlsVisible: boolean;
  readonly inputAvailable: boolean;
  readonly emergencyStopAvailable: boolean;
  readonly targetIntegrity: "higher" | "same-or-lower" | "unknown";
}

export interface WindowsHelperObservation {
  readonly accessibilityTree: NativeObservation["accessibilityTree"];
  readonly fixture?: FixtureObservation;
}

export interface WindowsHelperCapture {
  readonly mediaType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

/**
 * An authenticated helper response is an attestation from ADR-0011's local IPC
 * channel. The native driver consumes this binding; it never creates or upgrades it.
 */
export interface WindowsAuthenticatedHelperResponse {
  readonly protocolVersion: typeof WINDOWS_HELPER_PROTOCOL_VERSION;
  readonly authenticated: boolean;
  readonly helperInstanceId: string;
  readonly serviceEpoch: number;
  readonly sessionIdentity: string;
  readonly releaseVersion: string;
  readonly displayFingerprint: string | null;
  readonly kind: WindowsAuthenticatedHelperCommand["kind"];
  readonly sequence?: number;
  readonly readiness?: WindowsHelperReadiness;
  readonly observation?: WindowsHelperObservation;
  readonly capture?: WindowsHelperCapture;
}

export interface WindowsAuthenticatedHelperPort {
  /**
   * Executes one bounded command over an already authenticated ADR-0011 helper
   * channel. Implementations must validate frame signature/sequence/version before
   * returning and redact all native diagnostic details.
   */
  execute(
    command: WindowsAuthenticatedHelperCommand,
    signal?: AbortSignal,
  ): Promise<WindowsAuthenticatedHelperResponse>;
}

export interface WindowsNativeComputerUseDriverOptions {
  readonly helper: WindowsAuthenticatedHelperPort;
  readonly expectedHelperInstanceId: string;
  readonly expectedServiceEpoch: number;
  readonly expectedSessionIdentity: string;
  readonly releaseVersion: string;
}

export function createWindowsNativeComputerUseDriver(
  options: WindowsNativeComputerUseDriverOptions,
): NativeComputerUseDriver {
  validateOptions(options);
  return new WindowsNativeComputerUseDriver(options);
}

class WindowsNativeComputerUseDriver implements NativeComputerUseDriver {
  public readonly osFamily = "windows" as const;
  readonly #helper: WindowsAuthenticatedHelperPort;
  readonly #binding: WindowsAuthenticatedHelperBinding;
  readonly #cancelled = new Set<string>();
  readonly #emergencyStopped = new Set<string>();

  public constructor(options: WindowsNativeComputerUseDriverOptions) {
    this.#helper = options.helper;
    this.#binding = Object.freeze({
      protocolVersion: WINDOWS_HELPER_PROTOCOL_VERSION,
      expectedHelperInstanceId: options.expectedHelperInstanceId,
      expectedServiceEpoch: options.expectedServiceEpoch,
      expectedSessionIdentity: options.expectedSessionIdentity,
      expectedReleaseVersion: options.releaseVersion,
    });
  }

  public async probe(): Promise<NativeDriverProbe> {
    try {
      const command = Object.freeze({
        ...this.#binding,
        kind: "probe" as const,
      });
      const response = await this.#helper.execute(command);
      this.#requireTrustedResponse(command, response);
      const readiness = requireReadiness(response);
      return Object.freeze({
        osFamily: "windows",
        backendId: WINDOWS_BACKEND_ID,
        helperInstanceId: response.helperInstanceId,
        serviceEpoch: response.serviceEpoch,
        displayFingerprint: response.displayFingerprint,
        checks: Object.freeze(createReadinessChecks(readiness)),
      });
    } catch {
      return unavailableProbe(this.#binding);
    }
  }

  public async observe(context: NativeDriverExecutionContext): Promise<NativeObservation> {
    this.#requireActive(context);
    const command = Object.freeze({
      ...this.#binding,
      kind: "observe" as const,
      scope: executionScope(context),
    });
    const response = await this.#execute(command, context.signal);
    this.#requireDisplay(context, response);
    if (response.observation === undefined) {
      throw helperFailure();
    }
    validateObservation(response.observation);
    return Object.freeze({
      displayFingerprint: response.displayFingerprint,
      accessibilityTree: Object.freeze(
        response.observation.accessibilityTree.map((control) => Object.freeze({ ...control })),
      ),
      ...(response.observation.fixture === undefined
        ? {}
        : { fixture: cloneFixture(response.observation.fixture) }),
    });
  }

  public async capture(context: NativeDriverExecutionContext): Promise<NativeCapture> {
    this.#requireActive(context);
    const command = Object.freeze({
      ...this.#binding,
      kind: "capture" as const,
      scope: executionScope(context),
    });
    const response = await this.#execute(command, context.signal);
    this.#requireDisplay(context, response);
    if (response.capture === undefined) {
      throw helperFailure();
    }
    validateCapture(response.capture);
    return Object.freeze({
      displayFingerprint: response.displayFingerprint,
      mediaType: "image/png",
      width: response.capture.width,
      height: response.capture.height,
      bytes: response.capture.bytes.slice(),
    });
  }

  public async act(
    context: NativeDriverAuthorizedInputContext,
    action: NativeComputerUseAction,
  ): Promise<NativeActionReceipt> {
    this.#requireActive(context);
    requireExactNativeInputAuthorization(context, action);
    const command = Object.freeze({
      ...this.#binding,
      kind: "act" as const,
      scope: authorizedExecutionScope(context),
      action:
        action.kind === "click"
          ? Object.freeze({ kind: "click" as const, controlId: action.controlId })
          : Object.freeze({
              kind: "type-text" as const,
              controlId: action.controlId,
              text: action.text,
            }),
    });
    const response = await this.#execute(command, context.signal);
    this.#requireDisplay(context, response);
    const sequence = response.sequence;
    if (!Number.isSafeInteger(sequence) || sequence === undefined || sequence <= 0) {
      throw helperFailure();
    }
    return Object.freeze({
      displayFingerprint: response.displayFingerprint,
      sequence,
    });
  }

  public async cancel(context: NativeDriverControlContext): Promise<void> {
    this.#cancelled.add(context.executionHandleId);
    const command = Object.freeze({
      ...this.#binding,
      kind: "cancel" as const,
      scope: controlScope(context),
    });
    await this.#execute(command);
  }

  public async emergencyStop(context: NativeDriverControlContext): Promise<void> {
    this.#emergencyStopped.add(context.executionHandleId);
    const command = Object.freeze({
      ...this.#binding,
      kind: "emergency-stop" as const,
      scope: controlScope(context),
    });
    await this.#execute(command);
  }

  async #execute(
    command: WindowsAuthenticatedHelperCommand,
    signal?: AbortSignal,
  ): Promise<WindowsAuthenticatedHelperResponse> {
    try {
      if (signal?.aborted === true) {
        throw new NativeDriverError("CANCELLED", "The native operation was cancelled.");
      }
      const response = await this.#helper.execute(command, signal);
      this.#requireTrustedResponse(command, response);
      return response;
    } catch (error: unknown) {
      if (error instanceof NativeDriverError) {
        throw error;
      }
      if (signal?.aborted === true) {
        throw new NativeDriverError("CANCELLED", "The native operation was cancelled.");
      }
      throw helperFailure();
    }
  }

  #requireTrustedResponse(
    command: WindowsAuthenticatedHelperCommand,
    response: WindowsAuthenticatedHelperResponse,
  ): void {
    if (
      response.protocolVersion !== WINDOWS_HELPER_PROTOCOL_VERSION ||
      response.authenticated !== true ||
      response.helperInstanceId !== this.#binding.expectedHelperInstanceId ||
      response.serviceEpoch !== this.#binding.expectedServiceEpoch ||
      response.sessionIdentity !== this.#binding.expectedSessionIdentity ||
      response.releaseVersion !== this.#binding.expectedReleaseVersion ||
      response.kind !== command.kind
    ) {
      throw helperFailure();
    }
  }

  #requireDisplay(
    context: NativeDriverExecutionContext,
    response: WindowsAuthenticatedHelperResponse,
  ): asserts response is WindowsAuthenticatedHelperResponse & {
    readonly displayFingerprint: string;
  } {
    if (
      response.displayFingerprint === null ||
      response.displayFingerprint !== context.expectedDisplayFingerprint
    ) {
      throw new NativeDriverError(
        "DISPLAY_CHANGED",
        "The authenticated Windows desktop display binding changed.",
      );
    }
  }

  #requireActive(context: NativeDriverExecutionContext): void {
    if (this.#emergencyStopped.has(context.executionHandleId)) {
      throw new NativeDriverError(
        "EMERGENCY_STOPPED",
        "The native input boundary was emergency-stopped.",
      );
    }
    if (this.#cancelled.has(context.executionHandleId) || context.signal.aborted) {
      throw new NativeDriverError("CANCELLED", "The native input operation was cancelled.");
    }
    if (
      context.helperInstanceId !== this.#binding.expectedHelperInstanceId ||
      context.serviceEpoch !== this.#binding.expectedServiceEpoch
    ) {
      throw helperFailure();
    }
  }
}

function createReadinessChecks(readiness: WindowsHelperReadiness): readonly ReadinessCheck[] {
  return [
    readinessCheck(
      "interactive-session",
      readiness.interactiveSession,
      "The authenticated Windows helper owns an active interactive session.",
      "Log in as the configured owner and start the per-user helper.",
    ),
    readinessCheck(
      "unlocked-session",
      readiness.unlockedSession,
      "The authenticated helper positively verified the active input desktop.",
      "Unlock the configured owner session before Computer Use.",
    ),
    readinessCheck(
      "screen-capture",
      readiness.captureSupported && readiness.captureTargetSelected && readiness.frameReady,
      "Windows.Graphics.Capture has an owner-selected target and produced a current frame.",
      "Select the intended window or display through Windows capture consent.",
    ),
    readinessCheck(
      "accessibility",
      readiness.accessibilityAvailable && readiness.fixtureControlsVisible,
      "Windows UI Automation can observe the selected target controls.",
      "Expose accessible controls or use a permitted pointer action.",
    ),
    readinessCheck(
      "input",
      readiness.inputAvailable &&
        readiness.emergencyStopAvailable &&
        readiness.targetIntegrity === "same-or-lower",
      "UI Automation and SendInput are available for a same-or-lower integrity target.",
      readiness.targetIntegrity === "higher"
        ? "Run the target without elevation; OpenDelegate does not cross UIPI."
        : "Restore input permission and the local emergency-stop boundary.",
    ),
    readinessCheck(
      "helper-authentication",
      true,
      "The helper response passed the authenticated IPC binding.",
      "Restart and re-authenticate the per-user helper.",
    ),
  ];
}

function readinessCheck(
  name: ReadinessCheck["name"],
  passed: boolean,
  passedEvidence: string,
  remediation: string,
): ReadinessCheck {
  return Object.freeze(
    passed
      ? { name, status: "pass" as const, evidence: passedEvidence }
      : {
          name,
          status: "fail" as const,
          evidence: "The Windows native helper did not prove this readiness condition.",
          remediation,
        },
  );
}

function unavailableProbe(binding: WindowsAuthenticatedHelperBinding): NativeDriverProbe {
  const checks: readonly ReadinessCheck[] = Object.freeze([
    readinessCheck(
      "interactive-session",
      false,
      "",
      "Log in as the configured owner and start the per-user helper.",
    ),
    readinessCheck("unlocked-session", false, "", "Unlock the configured owner session."),
    readinessCheck(
      "screen-capture",
      false,
      "",
      "Select the intended window or display through Windows capture consent.",
    ),
    readinessCheck(
      "accessibility",
      false,
      "",
      "Restart the helper and verify Windows UI Automation readiness.",
    ),
    readinessCheck(
      "input",
      false,
      "",
      "Restart the helper and verify the emergency-stop boundary.",
    ),
    readinessCheck(
      "helper-authentication",
      false,
      "",
      "Restart and re-authenticate the per-user helper.",
    ),
  ]);
  return Object.freeze({
    osFamily: "windows",
    backendId: WINDOWS_BACKEND_ID,
    helperInstanceId: binding.expectedHelperInstanceId,
    serviceEpoch: binding.expectedServiceEpoch,
    displayFingerprint: null,
    checks,
  });
}

function executionScope(context: NativeDriverExecutionContext): WindowsHelperExecutionScope {
  return Object.freeze({
    executionHandleId: context.executionHandleId,
    taskId: context.taskId,
    deviceId: context.deviceId,
    runId: context.runId,
    helperInstanceId: context.helperInstanceId,
    serviceEpoch: context.serviceEpoch,
    persistenceGeneration: context.persistenceGeneration,
    leaseId: context.leaseId,
    fencingToken: context.fencingToken,
    expectedDisplayFingerprint: context.expectedDisplayFingerprint,
  });
}

function authorizedExecutionScope(
  context: NativeDriverAuthorizedInputContext,
): WindowsHelperAuthorizedExecutionScope {
  return Object.freeze({
    ...executionScope(context),
    authorization: Object.freeze({
      authorizationId: context.authorization.authorizationId,
      fingerprint: context.authorization.fingerprint,
      action: Object.freeze({ ...context.authorization.action }),
    }),
  });
}

function controlScope(context: NativeDriverControlContext): WindowsHelperControlScope {
  return Object.freeze({
    executionHandleId: context.executionHandleId,
    taskId: context.taskId,
    deviceId: context.deviceId,
    runId: context.runId,
  });
}

function requireReadiness(response: WindowsAuthenticatedHelperResponse): WindowsHelperReadiness {
  if (response.readiness === undefined) {
    throw helperFailure();
  }
  const readiness = response.readiness;
  if (
    typeof readiness.interactiveSession !== "boolean" ||
    typeof readiness.unlockedSession !== "boolean" ||
    typeof readiness.captureSupported !== "boolean" ||
    typeof readiness.captureTargetSelected !== "boolean" ||
    typeof readiness.frameReady !== "boolean" ||
    typeof readiness.accessibilityAvailable !== "boolean" ||
    typeof readiness.fixtureControlsVisible !== "boolean" ||
    typeof readiness.inputAvailable !== "boolean" ||
    typeof readiness.emergencyStopAvailable !== "boolean" ||
    !["higher", "same-or-lower", "unknown"].includes(readiness.targetIntegrity)
  ) {
    throw helperFailure();
  }
  return readiness;
}

function validateObservation(observation: WindowsHelperObservation): void {
  if (
    !Array.isArray(observation.accessibilityTree) ||
    observation.accessibilityTree.length > MAX_CONTROL_COUNT
  ) {
    throw helperFailure();
  }
  for (const control of observation.accessibilityTree) {
    requireBoundedString(control.controlId);
    requireBoundedString(control.label);
    if (!["button", "radio", "textbox"].includes(control.role)) {
      throw helperFailure();
    }
    if (control.value !== undefined) {
      requireBoundedText(control.value);
    }
  }
}

function validateCapture(capture: WindowsHelperCapture): void {
  if (
    capture.mediaType !== "image/png" ||
    !Number.isSafeInteger(capture.width) ||
    capture.width <= 0 ||
    !Number.isSafeInteger(capture.height) ||
    capture.height <= 0 ||
    !(capture.bytes instanceof Uint8Array) ||
    capture.bytes.length === 0 ||
    capture.bytes.length > MAX_CAPTURE_BYTES
  ) {
    throw helperFailure();
  }
}

function cloneFixture(fixture: FixtureObservation): FixtureObservation {
  return Object.freeze({
    runIdentifier: fixture.runIdentifier,
    state: fixture.state,
    textValue: fixture.textValue,
    selectedOption: fixture.selectedOption,
    resultFile:
      fixture.resultFile === null
        ? null
        : Object.freeze({
            filename: fixture.resultFile.filename,
            mediaType: "application/json",
            bytes: fixture.resultFile.bytes.slice(),
          }),
  });
}

function validateOptions(options: WindowsNativeComputerUseDriverOptions): void {
  requireBoundedString(options.expectedHelperInstanceId);
  requireBoundedString(options.expectedSessionIdentity);
  requireBoundedString(options.releaseVersion);
  if (!Number.isSafeInteger(options.expectedServiceEpoch) || options.expectedServiceEpoch <= 0) {
    throw new TypeError("The expected Windows helper service epoch is invalid.");
  }
}

function requireBoundedString(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_LENGTH ||
    value !== value.trim()
  ) {
    throw helperFailure();
  }
}

function requireBoundedText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_STRING_LENGTH) {
    throw helperFailure();
  }
}

function helperFailure(): NativeDriverError {
  return new NativeDriverError(
    "HELPER_CRASHED",
    "The authenticated Windows user-session helper response was unavailable or invalid.",
  );
}
