export type AgentRunBridgeErrorCode =
  | "ADAPTER_NOT_FOUND"
  | "ADAPTER_NOT_READY"
  | "ADAPTER_START_FAILED"
  | "AGENT_REQUIREMENT_UNAVAILABLE"
  | "ARTIFACT_PREPARATION_FAILED"
  | "CAPABILITY_PREPARATION_FAILED"
  | "EGRESS_PROTECTION_FAILED"
  | "INITIAL_CONTEXT_FAILED"
  | "INVALID_BRIDGE_CONFIGURATION"
  | "INVALID_EXECUTION_PLAN"
  | "INVALID_SESSION_REFERENCE"
  | "SESSION_BINDING_MISMATCH"
  | "SESSION_STORE_CLOSED"
  | "SESSION_STORE_CONFLICT"
  | "SESSION_STORE_CORRUPT"
  | "SESSION_STORE_PATH_INVALID"
  | "STEERING_FAILED"
  | "STEERING_NOT_ACTIVE"
  | "STEERING_OUTCOME_UNKNOWN"
  | "STEERING_SCOPE_MISMATCH"
  | "WORKSPACE_RESOLUTION_FAILED";

export class AgentRunBridgeError extends Error {
  public readonly code: AgentRunBridgeErrorCode;
  public readonly retryable: boolean;

  public constructor(code: AgentRunBridgeErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "AgentRunBridgeError";
    this.code = code;
    this.retryable = retryable;
  }
}
