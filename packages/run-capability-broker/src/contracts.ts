export const RUN_CAPABILITY_PROTOCOL_VERSION = 1 as const;

export type RunCapabilityJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly RunCapabilityJsonValue[]
  | { readonly [key: string]: RunCapabilityJsonValue };

export interface RunCapabilityBinding {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly deviceId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs: number;
}

export interface RunCapabilityRequest {
  readonly method: string;
  readonly payload: RunCapabilityJsonValue;
}

export interface RunCapabilityRequestContext {
  readonly binding: RunCapabilityBinding;
  readonly signal: AbortSignal;
}

export interface RunCapabilityRegistration {
  readonly capability: string;
  readonly binding: RunCapabilityBinding;
  readonly metadata: RunCapabilityJsonValue;
  readonly expiresAtMs: number;
  /**
   * Returns the live Main-authority snapshot. Immutable Run/fence fields must
   * remain byte-identical; only leaseExpiresAtMs may advance after renewal.
   */
  currentBinding(): RunCapabilityBinding;
  isExecutionCurrent(): Promise<boolean>;
  handler(
    request: RunCapabilityRequest,
    context: RunCapabilityRequestContext,
  ): Promise<RunCapabilityJsonValue>;
}

export interface RunCapabilityLease {
  readonly capabilityFile: string;
  dispose(): Promise<void>;
}

export interface RunCapabilityClient {
  readonly capability: string;
  readonly binding: RunCapabilityBinding;
  readonly metadata: RunCapabilityJsonValue;
  request(input: {
    readonly method: string;
    readonly payload: RunCapabilityJsonValue;
    readonly signal?: AbortSignal;
  }): Promise<RunCapabilityJsonValue>;
  close(): Promise<void>;
}

export interface LocalRunCapabilityBrokerOptions {
  readonly runtimeDirectory: string;
  readonly sourceCheckoutDirectory: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly clock?: { now(): number };
  readonly idSource?: { nextId(): string };
  readonly tokenSource?: { nextToken(): Buffer };
  readonly maxFrameBytes?: number;
  readonly maxInFlightRequests?: number;
}

export type RunCapabilityBrokerErrorCode =
  | "CAPABILITY_CONSUMED"
  | "CAPABILITY_EXPIRED"
  | "CAPABILITY_FILE_INVALID"
  | "CAPABILITY_FILE_UNSAFE"
  | "CAPABILITY_REVOKED"
  | "CONNECTION_FAILED"
  | "FRAME_INVALID"
  | "FRAME_TOO_LARGE"
  | "INVALID_CONFIGURATION"
  | "REQUEST_CANCELLED"
  | "REQUEST_FAILED";

const PUBLIC_MESSAGES: Readonly<Record<RunCapabilityBrokerErrorCode, string>> = Object.freeze({
  CAPABILITY_CONSUMED: "The one-time Run capability has already been consumed.",
  CAPABILITY_EXPIRED: "The Run capability has expired.",
  CAPABILITY_FILE_INVALID: "The Run capability file is invalid.",
  CAPABILITY_FILE_UNSAFE: "The Run capability file is not protected safely.",
  CAPABILITY_REVOKED: "The exact Worker Run capability is no longer current.",
  CONNECTION_FAILED: "The local Run capability broker is unavailable.",
  FRAME_INVALID: "The local Run capability frame is invalid.",
  FRAME_TOO_LARGE: "The local Run capability frame exceeds its configured bound.",
  INVALID_CONFIGURATION: "The local Run capability broker configuration is invalid.",
  REQUEST_CANCELLED: "The local Run capability request was cancelled.",
  REQUEST_FAILED: "The local Run capability request failed.",
});

export class RunCapabilityBrokerError extends Error {
  public readonly code: RunCapabilityBrokerErrorCode;

  public constructor(code: RunCapabilityBrokerErrorCode) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "RunCapabilityBrokerError";
    this.code = code;
  }
}
