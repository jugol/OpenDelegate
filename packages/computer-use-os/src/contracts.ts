export type ComputerUseOsFamily = "linux" | "macos" | "windows";

export const SUPPORTED_GRAPHICAL_LINUX_TARGET = "ubuntu-24.04-gnome-wayland" as const;

export type GraphicalLinuxTarget = typeof SUPPORTED_GRAPHICAL_LINUX_TARGET;

export type ReadinessCheckName =
  | "interactive-session"
  | "unlocked-session"
  | "screen-capture"
  | "accessibility"
  | "input"
  | "helper-authentication"
  | "service-epoch";

export type ReadinessCheckStatus = "fail" | "pass" | "unknown";

export interface ReadinessCheck {
  readonly name: ReadinessCheckName;
  readonly status: ReadinessCheckStatus;
  readonly evidence: string;
  readonly remediation?: string;
}

export interface NativeDriverProbe {
  readonly osFamily: ComputerUseOsFamily;
  readonly backendId: string;
  readonly helperInstanceId: string;
  readonly serviceEpoch: number;
  readonly displayFingerprint: string | null;
  readonly linuxTarget?: GraphicalLinuxTarget | "headless";
  readonly checks: readonly ReadinessCheck[];
}

export interface ComputerUseReadinessRequest {
  readonly deviceId: string;
  readonly helperInstanceId: string;
  readonly serviceEpoch: number;
  readonly persistenceGeneration: number;
}

export interface ComputerUseReadinessReport {
  readonly status: "ready" | "unavailable";
  readonly osFamily: ComputerUseOsFamily;
  readonly backendId: string;
  readonly displayFingerprint: string | null;
  readonly checks: readonly ReadinessCheck[];
}

export interface DesktopAuthorityRequest {
  readonly deviceId: string;
  readonly helperInstanceId: string;
  readonly serviceEpoch: number;
  readonly persistenceGeneration: number;
}

export type DesktopAuthorityResult =
  | {
      readonly status: "current";
      readonly helperInstanceId: string;
      readonly serviceEpoch: number;
      readonly persistenceGeneration: number;
      readonly verifiedAtMs: number;
    }
  | {
      readonly status: "stale" | "unavailable";
      readonly reason: string;
      readonly verifiedAtMs: number;
    };

export interface DesktopAuthorityPort {
  verify(request: DesktopAuthorityRequest): Promise<DesktopAuthorityResult>;
}

export interface DesktopLease {
  readonly resourceName: "desktop-session";
  readonly capacity: 1;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly expiresAtMs: number;
}

export interface DesktopLeaseRequest {
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly lease: DesktopLease;
}

export type DesktopLeaseResult =
  | {
      readonly status: "current";
      readonly leaseId: string;
      readonly fencingToken: number;
      readonly verifiedAtMs: number;
    }
  | {
      readonly status: "stale" | "unavailable";
      readonly reason: string;
      readonly verifiedAtMs: number;
    };

export interface DesktopLeasePort {
  verify(request: DesktopLeaseRequest): Promise<DesktopLeaseResult>;
}

export interface StartComputerUseInput extends ComputerUseReadinessRequest {
  readonly commandId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly lease: DesktopLease;
  readonly timeoutMs: number;
}

export interface ClickInput {
  readonly controlId: string;
}

export interface TypeTextInput {
  readonly controlId: string;
  readonly text: string;
}

export interface NativeClickAction {
  readonly kind: "click";
  readonly controlId: string;
}

export interface NativeTypeTextAction {
  readonly kind: "type-text";
  readonly controlId: string;
  /**
   * Sensitive text is present only at the native driver boundary. Drivers MUST NOT
   * log, persist, or include this value in diagnostics.
   */
  readonly text: string;
}

export type NativeComputerUseAction = NativeClickAction | NativeTypeTextAction;

export interface AuthorizedClickDescriptor {
  readonly kind: "click";
  readonly controlId: string;
}

export interface AuthorizedTypeTextDescriptor {
  readonly kind: "type-text";
  readonly controlId: string;
  readonly textSha256: `sha256:${string}`;
  readonly textLength: number;
}

export type AuthorizedComputerUseAction = AuthorizedClickDescriptor | AuthorizedTypeTextDescriptor;

export type ComputerUseActionFingerprint = `sha256:${string}`;

export interface ComputerUseInputAuthorizationRequest {
  readonly actionCategory: "computer-use-input";
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly requestedAtMs: number;
  readonly action: AuthorizedComputerUseAction;
  readonly fingerprint: ComputerUseActionFingerprint;
}

export type ComputerUseInputAuthorizationProof =
  | {
      readonly decision: "allow";
      readonly authorizationId: string;
      readonly fingerprint: ComputerUseActionFingerprint;
    }
  | {
      readonly decision: "deny" | "require-approval";
      readonly authorizationId: string;
      readonly fingerprint: ComputerUseActionFingerprint;
      readonly reason?: string;
    };

export interface ComputerUseInputAuthorizer {
  authorize(
    request: ComputerUseInputAuthorizationRequest,
  ): Promise<ComputerUseInputAuthorizationProof> | ComputerUseInputAuthorizationProof;
}

export interface FixtureResultFile {
  readonly filename: string;
  readonly mediaType: "application/json";
  readonly bytes: Uint8Array;
}

export interface FixtureObservation {
  readonly runIdentifier: string;
  readonly state: "editing" | "success";
  readonly textValue: string;
  readonly selectedOption: "Alpha" | "Beta" | null;
  readonly resultFile: FixtureResultFile | null;
}

export interface NativeObservation {
  readonly displayFingerprint: string;
  readonly accessibilityTree: readonly {
    readonly controlId: string;
    readonly role: "button" | "radio" | "textbox";
    readonly label: string;
    readonly value?: string;
    readonly selected?: boolean;
  }[];
  readonly fixture?: FixtureObservation;
}

export interface NativeCapture {
  readonly displayFingerprint: string;
  readonly mediaType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

export interface NativeActionReceipt {
  readonly displayFingerprint: string;
  readonly sequence: number;
}

export interface NativeDriverExecutionContext {
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
  readonly signal: AbortSignal;
}

export interface NativeDriverControlContext {
  readonly executionHandleId: string;
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
}

export interface NativeComputerUseDriver {
  readonly osFamily: ComputerUseOsFamily;
  probe(): Promise<NativeDriverProbe>;
  observe(context: NativeDriverExecutionContext): Promise<NativeObservation>;
  capture(context: NativeDriverExecutionContext): Promise<NativeCapture>;
  act(
    context: NativeDriverExecutionContext,
    action: NativeComputerUseAction,
  ): Promise<NativeActionReceipt>;
  cancel(context: NativeDriverControlContext): Promise<void>;
  emergencyStop(context: NativeDriverControlContext): Promise<void>;
}

export type NativeDriverErrorCode =
  | "CANCELLED"
  | "DISPLAY_CHANGED"
  | "EMERGENCY_STOPPED"
  | "HELPER_CRASHED"
  | "PERMISSION_DENIED"
  | "SESSION_LOCKED"
  | "TIMEOUT"
  | "UNAVAILABLE";

export class NativeDriverError extends Error {
  public readonly code: NativeDriverErrorCode;

  public constructor(code: NativeDriverErrorCode, message: string) {
    super(message);
    this.name = "NativeDriverError";
    this.code = code;
  }
}

export interface ComputerUseEvidence {
  readonly evidenceId: string;
  readonly runId: string;
  readonly mediaType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly sha256: `sha256:${string}`;
  readonly capturedAtMs: number;
  readonly displayFingerprint: string;
}

export interface ComputerUseActionSummaryEntry {
  readonly sequence: number;
  readonly kind: AuthorizedComputerUseAction["kind"];
  readonly controlId: string;
  readonly fingerprint: ComputerUseActionFingerprint;
  readonly authorizationId: string;
  readonly executedAtMs: number;
}

export interface ComputerUseActionSummary {
  readonly executionHandleId: string;
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly entries: readonly ComputerUseActionSummaryEntry[];
}

export interface ComputerUseActionSummaryEvidence {
  readonly evidenceId: string;
  readonly runId: string;
  readonly mediaType: "application/json";
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly sha256: `sha256:${string}`;
  readonly createdAtMs: number;
}

export type ComputerUseSessionStatus =
  "active" | "cancelled" | "emergency-stopped" | "failed" | "released" | "timed-out";

export interface ComputerUseSession {
  readonly executionHandleId: string;
  status(): ComputerUseSessionStatus;
  observe(): Promise<NativeObservation>;
  capture(): Promise<ComputerUseEvidence>;
  click(input: ClickInput): Promise<void>;
  typeText(input: TypeTextInput): Promise<void>;
  actionSummary(): ComputerUseActionSummary;
  captureActionSummary(): ComputerUseActionSummaryEvidence;
  cancel(): Promise<void>;
  emergencyStop(): Promise<void>;
  release(): Promise<void>;
}

export interface ComputerUseStartRecord {
  readonly commandId: string;
  readonly startFingerprint: `sha256:${string}`;
  readonly executionHandleId: string;
  readonly recordedAtMs: number;
}

export type ComputerUseStartClaim =
  | { readonly disposition: "created"; readonly record: ComputerUseStartRecord }
  | { readonly disposition: "replay"; readonly record: ComputerUseStartRecord }
  | { readonly disposition: "conflict"; readonly record: ComputerUseStartRecord };

export interface ComputerUseStartHistory {
  claim(record: ComputerUseStartRecord): Promise<ComputerUseStartClaim>;
}

export interface ComputerUseClock {
  now(): number;
}

export type ComputerUseLogEvent =
  | {
      readonly name: "computer_use.readiness";
      readonly deviceId: string;
      readonly osFamily: ComputerUseOsFamily;
      readonly status: "ready" | "unavailable";
      readonly failedChecks: readonly ReadinessCheckName[];
    }
  | {
      readonly name: "computer_use.session_started";
      readonly taskId: string;
      readonly deviceId: string;
      readonly runId: string;
      readonly executionHandleId: string;
      readonly serviceEpoch: number;
      readonly fencingToken: number;
    }
  | {
      readonly name: "computer_use.input";
      readonly taskId: string;
      readonly deviceId: string;
      readonly runId: string;
      readonly kind: AuthorizedComputerUseAction["kind"];
      readonly fingerprint: ComputerUseActionFingerprint;
      readonly authorizationId: string;
      readonly outcome: "executed";
    }
  | {
      readonly name: "computer_use.capture";
      readonly taskId: string;
      readonly deviceId: string;
      readonly runId: string;
      readonly evidenceId: string;
      readonly sha256: `sha256:${string}`;
    }
  | {
      readonly name: "computer_use.action_summary";
      readonly taskId: string;
      readonly deviceId: string;
      readonly runId: string;
      readonly evidenceId: string;
      readonly sha256: `sha256:${string}`;
      readonly actionCount: number;
    }
  | {
      readonly name: "computer_use.stopped";
      readonly taskId: string;
      readonly deviceId: string;
      readonly runId: string;
      readonly reason:
        | "cancelled"
        | "display-changed"
        | "emergency-stop"
        | "helper-crashed"
        | "permission-denied"
        | "released"
        | "session-locked"
        | "stale-authority"
        | "stale-lease"
        | "timeout";
    };

export interface ComputerUseLogger {
  write(event: ComputerUseLogEvent): void;
}

export type ComputerUseOsErrorCode =
  | "AUTHORIZATION_DENIED"
  | "AUTHORIZATION_INVALID"
  | "AUTHORIZATION_REQUIRED"
  | "DISPLAY_CHANGED"
  | "DRIVER_FAILURE"
  | "DRIVER_OS_MISMATCH"
  | "EPOCH_STALE"
  | "HELPER_CRASHED"
  | "INVALID_CAPTURE"
  | "INVALID_INPUT"
  | "LEASE_STALE"
  | "NOT_READY"
  | "PERMISSION_DENIED"
  | "SESSION_CANCELLED"
  | "SESSION_EMERGENCY_STOPPED"
  | "SESSION_LOCKED"
  | "SESSION_RELEASED"
  | "SESSION_TIMEOUT"
  | "START_COMMAND_CONFLICT"
  | "START_HISTORY_UNRECOVERABLE";

export class ComputerUseOsError extends Error {
  public readonly code: ComputerUseOsErrorCode;
  public readonly readiness: ComputerUseReadinessReport | undefined;

  public constructor(
    code: ComputerUseOsErrorCode,
    message: string,
    readiness?: ComputerUseReadinessReport,
  ) {
    super(message);
    this.name = "ComputerUseOsError";
    this.code = code;
    this.readiness = readiness;
  }
}
