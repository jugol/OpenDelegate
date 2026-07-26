export const SESSION_HELPER_IPC_PROTOCOL_VERSION = 1 as const;

export type SessionHelperIpcTransportKind = "memory" | "unix-domain-socket" | "windows-named-pipe";

export type SessionHelperIpcEndpoint =
  | {
      readonly kind: "unix-domain-socket";
      readonly path: string;
    }
  | {
      readonly kind: "windows-named-pipe";
      readonly path: string;
    };

/**
 * Transport-observed identity is defense in depth. Implementations may enrich this
 * record with OS-verified data, but the HMAC handshake is always mandatory.
 */
export interface SessionHelperIpcPeerIdentity {
  readonly transport: SessionHelperIpcTransportKind;
  readonly processId?: number;
  readonly principalId?: string;
  readonly sessionId?: string;
}

export interface SessionHelperIpcConnection {
  readonly peerIdentity: SessionHelperIpcPeerIdentity;
  readFrame(maxBytes: number, signal?: AbortSignal): Promise<Buffer | null>;
  writeFrame(frame: Buffer, signal?: AbortSignal): Promise<void>;
  close(): void;
}

export interface SessionHelperIpcDialer {
  connect(
    endpoint: SessionHelperIpcEndpoint,
    signal?: AbortSignal,
  ): Promise<SessionHelperIpcConnection>;
}

export interface SessionHelperIpcListener {
  close(): Promise<void>;
}

export interface SessionHelperIpcTransport extends SessionHelperIpcDialer {
  listen(
    endpoint: SessionHelperIpcEndpoint,
    onConnection: (connection: SessionHelperIpcConnection) => void | Promise<void>,
  ): Promise<SessionHelperIpcListener>;
}

export interface SessionHelperBinding {
  readonly protocolVersion: typeof SESSION_HELPER_IPC_PROTOCOL_VERSION;
  readonly deviceId: string;
  readonly helperId: string;
  readonly sessionId: string;
  readonly serviceEpoch: number;
  readonly releaseVersion: string;
}

export interface SessionHelperIpcKeyLease {
  readonly keyId: string;
  /**
   * A disposable 32-byte Buffer. The IPC module zeroes it after the handshake.
   * Providers must not return storage shared with their long-lived Secret.
   */
  readonly material: Buffer;
  readonly usage: "active" | "migration";
  /**
   * Required for a migration lease. It atomically permits exactly one overlap
   * handshake and returns false after that allowance has been consumed.
   */
  readonly consumeMigration?: () => Promise<boolean>;
}

export interface SessionHelperIpcKeyProvider {
  acquire(
    reference: string,
    request: { readonly mode: "initiate" } | { readonly mode: "verify"; readonly keyId: string },
  ): Promise<SessionHelperIpcKeyLease | null>;
}

export interface SessionHelperIpcPeerAuthorizationRequest {
  readonly localRole: "core" | "helper";
  readonly binding: SessionHelperBinding;
  readonly peerIdentity: SessionHelperIpcPeerIdentity;
}

export interface SessionHelperIpcPeerAuthorizer {
  authorize(request: SessionHelperIpcPeerAuthorizationRequest): boolean | Promise<boolean>;
}

export interface SessionHelperIpcNonceReplayGuard {
  claim(
    role: "core" | "helper",
    binding: SessionHelperBinding,
    nonce: Buffer,
  ): boolean | Promise<boolean>;
}

export interface SessionHelperIpcFactoryOptions {
  readonly keyProvider: SessionHelperIpcKeyProvider;
  readonly peerAuthorizer: SessionHelperIpcPeerAuthorizer;
  readonly nonceGuard?: SessionHelperIpcNonceReplayGuard;
  readonly nonceSource?: () => Buffer;
  readonly handshakeTimeoutMs?: number;
  readonly maxFrameBytes?: number;
}

export interface ConnectCoreSessionHelperOptions {
  readonly binding: SessionHelperBinding;
  readonly endpoint: SessionHelperIpcEndpoint;
  readonly keyReference: string;
  readonly dialer: SessionHelperIpcDialer;
  readonly signal?: AbortSignal;
}

export interface AcceptHelperSessionOptions {
  readonly binding: SessionHelperBinding;
  readonly keyReference: string;
  readonly connection: SessionHelperIpcConnection;
  readonly signal?: AbortSignal;
}

export interface CoreSessionHelperIpc {
  connect(options: ConnectCoreSessionHelperOptions): Promise<CoreSessionHelperChannel>;
}

export interface HelperSessionHelperIpc {
  accept(options: AcceptHelperSessionOptions): Promise<HelperSessionHelperChannel>;
}

export type SessionHelperCapability =
  "readiness" | "capture" | "observe" | "exact_input" | "cancel" | "emergency_stop" | "diagnostics";

interface CapabilityRequestBase<TCapability extends SessionHelperCapability, TPayload> {
  readonly type: "request";
  readonly requestId: string;
  readonly capability: TCapability;
  readonly payload: TPayload;
}

export type SessionHelperExactInputAction =
  | {
      readonly kind: "pointer";
      readonly operation: "move";
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly kind: "pointer";
      readonly operation: "click" | "double_click";
      readonly x: number;
      readonly y: number;
      readonly button: "primary" | "secondary" | "middle";
    }
  | {
      readonly kind: "pointer";
      readonly operation: "scroll";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | {
      readonly kind: "keyboard";
      readonly operation: "key";
      readonly key: string;
      readonly modifiers: readonly ("alt" | "control" | "meta" | "shift")[];
    }
  | {
      readonly kind: "keyboard";
      readonly operation: "text";
      readonly text: string;
    }
  | {
      readonly kind: "accessibility";
      readonly operation: "invoke";
      readonly targetId: string;
    }
  | {
      readonly kind: "accessibility";
      readonly operation: "set_value" | "select";
      readonly targetId: string;
      readonly value: string;
    };

export type SessionHelperCapabilityRequest =
  | CapabilityRequestBase<"readiness", Record<string, never>>
  | CapabilityRequestBase<"capture", SessionHelperExecutionContext>
  | CapabilityRequestBase<
      "observe",
      SessionHelperExecutionContext & {
        readonly maxElements: number;
      }
    >
  | CapabilityRequestBase<
      "exact_input",
      {
        readonly executionHandleId: string;
        readonly taskId: string;
        readonly runId: string;
        readonly persistenceGeneration: string;
        readonly leaseId: string;
        readonly fencingToken: string;
        readonly authorizationId: string;
        readonly policyFingerprint: `sha256:${string}`;
        readonly authorizedAction: SessionHelperAuthorizedInputDescriptor;
        readonly deadlineUnixMs: number;
        readonly displayFingerprint: string;
        readonly action: SessionHelperExactInputAction;
      }
    >
  | CapabilityRequestBase<
      "cancel",
      {
        readonly targetRequestId: string;
      }
    >
  | CapabilityRequestBase<
      "emergency_stop",
      {
        readonly reasonCode: "owner" | "core_disconnect" | "policy" | "timeout";
      }
    >
  | CapabilityRequestBase<
      "diagnostics",
      {
        readonly maxEntries: number;
        readonly maxBytes: number;
      }
    >;

export interface SessionHelperObservedElement {
  readonly elementId: string;
  readonly role: string;
  readonly label: string;
  readonly value: string | null;
  readonly enabled: boolean;
  readonly selected: boolean | null;
}

export interface SessionHelperExecutionContext {
  readonly executionHandleId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly persistenceGeneration: string;
  readonly leaseId: string;
  readonly fencingToken: string;
  readonly deadlineUnixMs: number;
  readonly displayFingerprint: string;
}

export type SessionHelperAuthorizedInputDescriptor =
  | {
      readonly kind: "click";
      readonly controlId: string;
    }
  | {
      readonly kind: "type-text";
      readonly controlId: string;
      readonly textSha256: `sha256:${string}`;
      readonly textLength: number;
    };

export interface SessionHelperDiagnosticEntry {
  readonly code:
    | "cancelled"
    | "capture_unavailable"
    | "display_changed"
    | "emergency_stopped"
    | "helper_ready"
    | "input_unavailable"
    | "internal_failure"
    | "permission_denied"
    | "session_locked";
  readonly severity: "info" | "warning" | "error";
  readonly observedAtUnixMs: number;
}

export type SessionHelperCapabilityErrorCode =
  | "cancelled"
  | "deadline_exceeded"
  | "display_changed"
  | "not_ready"
  | "permission_denied"
  | "rejected"
  | "stale_authority"
  | "unsupported";

interface CapabilityResponseBase<
  TCapability extends SessionHelperCapability,
  TOutcome extends "ok" | "error",
  TPayload,
> {
  readonly type: "response";
  readonly requestId: string;
  readonly capability: TCapability;
  readonly outcome: TOutcome;
  readonly payload: TPayload;
}

type CapabilityErrorResponse<TCapability extends SessionHelperCapability> = CapabilityResponseBase<
  TCapability,
  "error",
  {
    readonly code: SessionHelperCapabilityErrorCode;
  }
>;

export type SessionHelperCapabilityResponse =
  | CapabilityResponseBase<
      "readiness",
      "ok",
      {
        readonly interactiveSession: boolean;
        readonly unlockedSession: boolean;
        readonly captureAvailable: boolean;
        readonly observationAvailable: boolean;
        readonly inputAvailable: boolean;
        readonly emergencyStopAvailable: boolean;
        readonly displayFingerprint: string | null;
      }
    >
  | CapabilityResponseBase<
      "capture",
      "ok",
      {
        readonly mediaType: "image/png";
        readonly width: number;
        readonly height: number;
        readonly displayFingerprint: string;
        readonly bytesBase64Url: string;
      }
    >
  | CapabilityResponseBase<
      "observe",
      "ok",
      {
        readonly displayFingerprint: string;
        readonly elements: readonly SessionHelperObservedElement[];
      }
    >
  | CapabilityResponseBase<
      "exact_input",
      "ok",
      {
        readonly applied: boolean;
        readonly actionDigest: string;
      }
    >
  | CapabilityResponseBase<"cancel", "ok", { readonly cancelled: boolean }>
  | CapabilityResponseBase<"emergency_stop", "ok", { readonly stopped: boolean }>
  | CapabilityResponseBase<
      "diagnostics",
      "ok",
      {
        readonly entries: readonly SessionHelperDiagnosticEntry[];
      }
    >
  | CapabilityErrorResponse<SessionHelperCapability>;

export interface CoreSessionHelperChannel {
  readonly binding: SessionHelperBinding;
  readonly isClosed: boolean;
  send(request: SessionHelperCapabilityRequest, signal?: AbortSignal): Promise<void>;
  receive(signal?: AbortSignal): Promise<SessionHelperCapabilityResponse>;
  close(): void;
}

export interface HelperSessionHelperChannel {
  readonly binding: SessionHelperBinding;
  readonly isClosed: boolean;
  send(response: SessionHelperCapabilityResponse, signal?: AbortSignal): Promise<void>;
  receive(signal?: AbortSignal): Promise<SessionHelperCapabilityRequest>;
  close(): void;
}
