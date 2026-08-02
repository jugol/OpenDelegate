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
  /**
   * Device-local bridge to Main's exact-action Policy boundary. Programmatic
   * adapters call this only when the provider is about to cross its sandbox or
   * another protected boundary. The callback must durably consume an allow
   * decision before it returns `allow`.
   *
   * The port is intentionally absent from serialized command envelopes.
   */
  readonly actionAuthorization?: AgentActionAuthorizationPort;
}

export type AgentActionCategory =
  | "read-only-observation"
  | "opendelegate-process-retry"
  | "opendelegate-process-restart"
  | "project-dependency-install"
  | "configured-official-package-install"
  | "computer-use-input"
  | "sandbox-boundary-escalation"
  | "package-repository-addition"
  | "remote-installer-script"
  | "untrusted-installer"
  | "driver-installation"
  | "kernel-extension-installation"
  | "os-network-change"
  | "vpn-change"
  | "firewall-change"
  | "policy-relaxation"
  | "secret-export"
  | "cross-device-knowledge-transfer"
  | "policy-bypass-attempt";

export interface AgentActionAuthorizationRequest {
  readonly authorizationRequestId: string;
  readonly actionCategory: AgentActionCategory;
  readonly actionType: string;
  readonly actionFingerprint: `sha256:${string}`;
  /**
   * Bounded, presentation-safe metadata. Exact provider input is represented by
   * `actionFingerprint` and is never required to leave the Device.
   */
  readonly actionDescriptor: Readonly<Record<string, boolean | number | string | null>>;
  readonly requestedAtMs: number;
  readonly signal: AbortSignal;
}

export interface AgentActionAuthorizationDecision {
  readonly decision: "allow" | "deny";
  readonly reasonCode: string;
}

export interface AgentActionAuthorizationPort {
  authorizeAndConsume(
    request: AgentActionAuthorizationRequest,
  ): Promise<AgentActionAuthorizationDecision>;
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

/**
 * A narrow, run-scoped tool server composed by OpenDelegate. Provider-native
 * configuration remains ignored; only these explicit stdio servers are exposed.
 * Secrets are not accepted here. A server that needs authority receives a path to
 * an opaque, single-use capability file in `args`.
 */
export interface AgentToolServer {
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly enabledTools: readonly string[];
  readonly startupTimeoutMs: number;
  readonly toolTimeoutMs: number;
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
  readonly modelId?: string;
  /** The effective provider tuning, recorded so the lineage names what ran. */
  readonly effort?: string;
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
  readonly modelId?: string;
  /**
   * Provider tuning for the selected model, taken from the model's advertised
   * catalog rather than a fixed list. Providers that expose no effort catalog
   * ignore it.
   */
  readonly effort?: string;
  readonly prompt: string;
  readonly workspace: WorkspaceBinding;
  readonly sandbox: AgentSandbox;
  readonly permissions: AgentPermissionInput;
  readonly toolServers?: readonly AgentToolServer[];
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
      readonly type: "steering_accepted";
      readonly requestId: string;
      readonly delivery: "live";
      readonly requestedBy: "owner" | "main-agent";
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

/**
 * The complete local identity of the one active provider turn that may receive a
 * live steering instruction. `sessionKey` remains Device-local and must not be
 * copied into Main audit records.
 */
export interface AgentSteeringScope {
  readonly provider: AgentProvider;
  readonly adapterId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly workstreamId: string;
  readonly sessionKey: string;
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly nativeSessionId: string;
}

export interface AgentSteerRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly scope: AgentSteeringScope;
  readonly instruction: string;
  readonly requestedBy: "owner" | "main-agent";
}

export interface AgentSteerReceipt {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly delivery: "live";
  readonly status: "accepted" | "already-accepted";
  readonly acceptedAt: string;
  /**
   * Opaque provider turn identity when the provider exposes one. This value is
   * diagnostic evidence, never authority for selecting another Run or session.
   */
  readonly providerTurnId?: string;
}

export interface AgentRunHandle {
  readonly events: AsyncIterable<NormalizedAgentEvent>;
  readonly result: Promise<AgentRunResult>;
  /**
   * Present only when the probed adapter truthfully advertises live steering.
   * The request must match this handle's exact active Run, Task, Device,
   * Workspace, session key, and native session.
   */
  readonly steer?: (request: AgentSteerRequest) => Promise<AgentSteerReceipt>;
  cancel(reason?: string): Promise<void>;
}

export type AdapterCompatibility = "tested" | "compatible" | "untested" | "incompatible";
export type AdapterAuthState = "ready" | "not_ready" | "not_required" | "unknown";

export interface AgentModelDescriptor {
  readonly modelId: string;
  readonly displayName: string;
  readonly isDefault?: boolean;
  readonly supportedEfforts?: readonly string[];
}

export interface AgentModelCatalog {
  readonly observedAt: string;
  readonly models: readonly AgentModelDescriptor[];
}

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
  readonly modelCatalog?: AgentModelCatalog;
  /**
   * The exact upgrade that would make this adapter usable, when one exists.
   *
   * Both the package and the version come from this adapter's own pin, never
   * from the owner or the network, so an owner-facing remedy can name the
   * target instead of leaving "untested" as a dead end.
   */
  readonly remediation?: AgentAdapterRemediation;
  /**
   * Set when nothing an owner could do on this Device would make the adapter
   * usable, so surfaces that exist to offer remedies can leave it out instead of
   * showing a permanent failure with no path forward.
   *
   * A missing install or an out-of-date version never sets this: those have
   * remedies. Only a property of the Device itself does, and the reason belongs
   * in `diagnostics` so a Device-local report can still explain the absence.
   */
  readonly unsupportedOnDevice?: boolean;
}

export interface AgentAdapterRemediation {
  readonly kind: "upgrade-provider";
  readonly packageManager: "npm";
  readonly packageName: string;
  readonly targetVersion: string;
  readonly installedVersion?: string;
}

export interface AgentAdapterProbeInput {
  readonly environment?: Readonly<Record<string, string>>;
  readonly secretEnvironment?: Readonly<Record<string, string>>;
}

export interface AgentAdapter {
  readonly adapterId: string;
  readonly provider: AgentProvider;
  probe(input?: AgentAdapterProbeInput): Promise<AgentAdapterProbe>;
  listModels?(input?: AgentAdapterProbeInput): Promise<AgentModelCatalog>;
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
