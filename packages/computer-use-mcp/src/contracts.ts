export const COMPUTER_USE_MCP_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
] as const;

export type ComputerUseMcpProtocolVersion = (typeof COMPUTER_USE_MCP_PROTOCOL_VERSIONS)[number];

export const COMPUTER_USE_TOOL_NAMES = [
  "computer_use_readiness",
  "computer_use_observe",
  "computer_use_capture",
  "computer_use_click",
  "computer_use_type_text",
  "computer_use_key",
  "computer_use_scroll",
  "computer_use_stop",
] as const;

export type ComputerUseToolName = (typeof COMPUTER_USE_TOOL_NAMES)[number];

export interface ComputerUseRunAuthority {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly deviceId: string;
  readonly executionHandleId: string;
  readonly lease: {
    readonly resourceName: "desktop-session";
    readonly capacity: 1;
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly expiresAtMs: number;
  };
  readonly desktopAuthority: {
    readonly helperInstanceId: string;
    readonly serviceEpoch: number;
    readonly persistenceGeneration: number;
  };
}

export interface ComputerUseToolContext {
  /**
   * Exact immutable authority supplied by the Worker capability broker. The MCP
   * server cannot create, widen, renew, or replace it.
   */
  readonly authority: ComputerUseRunAuthority;
  readonly signal: AbortSignal;
}

export interface ComputerUseReadinessCheck {
  readonly name: string;
  readonly status: "fail" | "pass" | "unknown";
  readonly evidence: string;
  readonly remediation?: string;
}

export interface ComputerUseToolReadiness {
  readonly status: "ready" | "unavailable";
  readonly osFamily: "linux" | "macos" | "windows";
  readonly backendId: string;
  readonly displayFingerprint: string | null;
  readonly checks: readonly ComputerUseReadinessCheck[];
}

export interface ComputerUseObservedControl {
  readonly controlId: string;
  readonly role: string;
  readonly label: string;
  readonly value?: string;
  readonly selected?: boolean;
}

export interface ComputerUseToolObservation {
  readonly displayFingerprint: string;
  readonly summary: string;
  readonly controls: readonly ComputerUseObservedControl[];
}

export interface ComputerUseToolCapture {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly capturedAtMs: number;
  readonly displayFingerprint: string;
}

export interface ComputerUseClickInput {
  readonly controlId: string;
}

export interface ComputerUseTypeTextInput {
  readonly controlId: string;
  /**
   * Sensitive plaintext. Implementations MUST NOT log, persist, or repeat this
   * value in an error. It may be held only for the duration of the port call.
   */
  readonly text: string;
}

export type ComputerUseKeyModifier = "alt" | "control" | "meta" | "shift";

export interface ComputerUseKeyInput {
  readonly key: string;
  readonly modifiers?: readonly ComputerUseKeyModifier[];
}

export interface ComputerUseScrollInput {
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface ComputerUseStopInput {
  readonly mode: "cancel" | "emergency-stop";
}

export interface ComputerUseToolActionReceipt {
  readonly sequence: number;
  readonly executedAtMs: number;
  readonly displayFingerprint: string;
}

export interface ComputerUseToolStopReceipt {
  readonly status: "stopped";
}

/**
 * Execution seam owned by the Worker capability broker.
 *
 * Every method MUST revalidate that `context.authority` is the exact current
 * Task/Work Order/Run, execution handle, capacity-one desktop lease and fencing
 * token, and external desktop epoch before using the backend. `click`,
 * `typeText`, `key`, and `scroll` MUST additionally re-run executable Policy and
 * approval matching, then revalidate lease and epoch immediately before the
 * mutation. The MCP server performs none of those authority operations.
 */
export interface ComputerUseToolPort {
  readiness(context: ComputerUseToolContext): Promise<ComputerUseToolReadiness>;
  observe(context: ComputerUseToolContext): Promise<ComputerUseToolObservation>;
  capture(context: ComputerUseToolContext): Promise<ComputerUseToolCapture>;
  click(
    context: ComputerUseToolContext,
    input: ComputerUseClickInput,
  ): Promise<ComputerUseToolActionReceipt>;
  typeText(
    context: ComputerUseToolContext,
    input: ComputerUseTypeTextInput,
  ): Promise<ComputerUseToolActionReceipt>;
  key(
    context: ComputerUseToolContext,
    input: ComputerUseKeyInput,
  ): Promise<ComputerUseToolActionReceipt>;
  scroll(
    context: ComputerUseToolContext,
    input: ComputerUseScrollInput,
  ): Promise<ComputerUseToolActionReceipt>;
  stop(
    context: ComputerUseToolContext,
    input: ComputerUseStopInput,
  ): Promise<ComputerUseToolStopReceipt>;
}

export type ComputerUseToolPortErrorCode =
  | "CANCELLED"
  | "FAILED"
  | "NOT_READY"
  | "PERMISSION_DENIED"
  | "STALE_AUTHORITY"
  | "STALE_LEASE"
  | "TIMEOUT"
  | "UNSUPPORTED";

export class ComputerUseToolPortError extends Error {
  public readonly code: ComputerUseToolPortErrorCode;

  public constructor(code: ComputerUseToolPortErrorCode) {
    super("The Computer Use execution port rejected the operation.");
    this.name = "ComputerUseToolPortError";
    this.code = code;
  }
}

export interface ComputerUseMcpLimits {
  readonly maxInputLineBytes?: number;
  readonly maxOutputLineBytes?: number;
  readonly maxCaptureBytes?: number;
  readonly maxInFlightToolCalls?: number;
  readonly toolTimeoutMs?: number;
}

export interface ComputerUseMcpServerInfo {
  readonly name: string;
  readonly version: string;
}

export type ComputerUseMcpDiagnosticCode =
  | "input_rejected"
  | "port_failure"
  | "port_result_rejected"
  | "request_cancelled"
  | "request_timed_out";

export interface ComputerUseMcpDiagnostic {
  readonly level: "warning" | "error";
  readonly event: "computer_use_mcp.input" | "computer_use_mcp.tool";
  readonly code: ComputerUseMcpDiagnosticCode;
  readonly tool?: ComputerUseToolName;
}

export interface ComputerUseMcpServerOptions {
  readonly authority: ComputerUseRunAuthority;
  readonly port: ComputerUseToolPort;
  /**
   * Exact tools implemented by the composed backend. Omitted means the complete
   * package contract; production compositions should advertise only operations
   * that can currently execute.
   */
  readonly enabledTools?: readonly ComputerUseToolName[];
  readonly limits?: ComputerUseMcpLimits;
  readonly serverInfo?: ComputerUseMcpServerInfo;
  readonly diagnostic?: (event: ComputerUseMcpDiagnostic) => void;
}
