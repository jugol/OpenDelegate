export const AGENT_ADAPTER_CONTRACT_VERSION = 1 as const;

export type AgentProvider = "codex" | "claude" | "generic";
export type WorkspaceIsolation =
  "none" | "agent-native-worktree" | "opendelegate-worktree" | "container" | "custom";
export type AgentSandbox =
  | "provider-default"
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | "container"
  | "custom";

export interface WorkspaceBinding {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly worktreePath?: string;
  readonly isolation: WorkspaceIsolation;
}

export interface DangerousBypassGrant {
  readonly grantId: string;
  readonly grantedBy: "owner" | "policy";
  readonly scope: "task";
  readonly taskId: string;
}

export interface AgentPermissionInput {
  readonly mode: "deny" | "allow-listed" | "bypass";
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly dangerousBypassGrant?: DangerousBypassGrant;
}

export interface AgentRunLimits {
  readonly wallTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly cancellationGraceMs: number;
  readonly leaseTtlMs: number;
  readonly leaseRenewIntervalMs: number;
  readonly maxBufferedEvents: number;
  readonly maxLineBytes: number;
  readonly maxDiagnosticBytes: number;
}

export interface SessionLineage {
  readonly lineageId: string;
  readonly parentNativeSessionId?: string;
  readonly continuationReason?: string;
}

export interface NativeSessionReference {
  readonly schemaVersion: 1;
  readonly provider: AgentProvider;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly nativeSessionId: string;
  readonly sessionKey: string;
  readonly taskId: string;
  readonly workstreamId: string;
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly worktreePath?: string;
  readonly lineage: SessionLineage;
  readonly createdAt: string;
}

interface AgentRunRequestFields {
  readonly requestId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly workstreamId: string;
  readonly sessionKey: string;
  readonly deviceId: string;
  readonly prompt: string;
  readonly workspace: WorkspaceBinding;
  readonly sandbox: AgentSandbox;
  readonly permissions: AgentPermissionInput;
  readonly limits: AgentRunLimits;
  readonly environment?: Readonly<Record<string, string>>;
  readonly secretEnvironment?: Readonly<Record<string, string>>;
}

export interface AgentStartRequest extends AgentRunRequestFields {
  readonly operation: "start";
  readonly continuationOf?: NativeSessionReference;
  readonly continuationReason?: string;
}

export interface AgentResumeRequest extends AgentRunRequestFields {
  readonly operation: "resume";
  readonly session: NativeSessionReference;
}

export interface AgentUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costUsd?: number;
}

interface AgentEventBase {
  readonly sequence: number;
  readonly observedAt: string;
}

export type NormalizedAgentEvent =
  | (AgentEventBase & {
      readonly type: "session_started";
      readonly session: NativeSessionReference;
    })
  | (AgentEventBase & {
      readonly type: "public_message";
      readonly role: "assistant";
      readonly text: string;
    })
  | (AgentEventBase & {
      readonly type: "message_delta";
      readonly text: string;
    })
  | (AgentEventBase & {
      readonly type: "tool_request";
      readonly toolName: string;
      readonly input?: unknown;
    })
  | (AgentEventBase & {
      readonly type: "tool_result";
      readonly toolName: string;
      readonly status: "succeeded" | "failed";
      readonly summary?: string;
    })
  | (AgentEventBase & {
      readonly type: "approval_request";
      readonly requestId: string;
      readonly actionType: string;
      readonly summary: string;
      readonly scope?: unknown;
    })
  | (AgentEventBase & {
      readonly type: "progress";
      readonly message: string;
    })
  | (AgentEventBase & {
      readonly type: "usage";
      readonly usage: AgentUsage;
    })
  | (AgentEventBase & {
      readonly type: "diagnostic";
      readonly level: "info" | "warning" | "error";
      readonly code: string;
      readonly message: string;
    })
  | (AgentEventBase & {
      readonly type: "completed";
      readonly status: AgentRunStatus;
      readonly error?: AgentRunFailure;
    });

export type NormalizedAgentEventInput = NormalizedAgentEvent extends infer Event
  ? Event extends AgentEventBase
    ? Omit<Event, "sequence" | "observedAt">
    : never
  : never;

export type AgentRunStatus = "succeeded" | "failed" | "cancelled" | "timed_out" | "lease_lost";

export interface AgentRunFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentRunResult {
  readonly status: AgentRunStatus;
  readonly session?: NativeSessionReference;
  readonly finalText?: string;
  readonly usage?: AgentUsage;
  readonly error?: AgentRunFailure;
}

export interface AgentRunHandle {
  readonly events: AsyncIterable<NormalizedAgentEvent>;
  readonly result: Promise<AgentRunResult>;
  cancel(reason?: string): Promise<void>;
}

export type AdapterCompatibility = "tested" | "compatible" | "untested" | "incompatible";
export type AdapterAuthState = "ready" | "not_ready" | "not_required" | "unknown";

export interface AgentAdapterProbe {
  readonly contractVersion: 1;
  readonly adapterId: string;
  readonly provider: AgentProvider;
  readonly installed: boolean;
  readonly version?: string;
  readonly compatibility: AdapterCompatibility;
  readonly auth: {
    readonly state: AdapterAuthState;
  };
  readonly capabilities: {
    readonly start: boolean;
    readonly resume: boolean;
    readonly streaming: boolean;
    readonly cancellation: boolean;
    readonly approvalBridge: boolean;
    readonly steering: boolean;
    readonly checkpointContinuation: boolean;
    readonly workspaceIsolation: readonly WorkspaceIsolation[];
  };
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}

export interface AgentAdapterProbeInput {
  readonly environment?: Readonly<Record<string, string>>;
  readonly secretEnvironment?: Readonly<Record<string, string>>;
}

export interface AgentAdapter {
  readonly adapterId: string;
  readonly provider: AgentProvider;
  probe(input?: AgentAdapterProbeInput): Promise<AgentAdapterProbe>;
  start(request: AgentStartRequest): Promise<AgentRunHandle>;
  resume(request: AgentResumeRequest): Promise<AgentRunHandle>;
}

export interface AgentSdkDriver {
  readonly provider: "codex" | "claude";
  probe(input?: AgentAdapterProbeInput): Promise<AgentAdapterProbe>;
  start(
    request: AgentStartRequest,
    emit: (event: NormalizedAgentEventInput) => Promise<void>,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
  resume(
    request: AgentResumeRequest,
    emit: (event: NormalizedAgentEventInput) => Promise<void>,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
}
