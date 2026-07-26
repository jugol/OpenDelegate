import {
  NativeDriverError,
  type NativeComputerUseAction,
  type NativeComputerUseDriver,
  type NativeDriverAuthorizedInputContext,
  type NativeDriverControlContext,
  type NativeDriverExecutionContext,
} from "@opendelegate/computer-use-os";
import type {
  HelperSessionHelperChannel,
  SignedHelperSessionHelperChannel,
  SessionHelperCapabilityErrorCode,
  SessionHelperCapabilityRequest,
  SessionHelperCapabilityResponse,
} from "@opendelegate/session-helper-ipc";

export interface ServeSessionHelperChannelOptions {
  readonly channel: HelperSessionHelperChannel | SignedHelperSessionHelperChannel;
  readonly driver: NativeComputerUseDriver;
  readonly clock?: () => number;
}

export interface SessionHelperChannelServer {
  close(): Promise<void>;
}

export function serveSessionHelperChannel(
  options: ServeSessionHelperChannelOptions,
): SessionHelperChannelServer {
  const runtime = new SessionHelperChannelRuntime(options);
  runtime.start();
  return runtime;
}

class SessionHelperChannelRuntime implements SessionHelperChannelServer {
  readonly #channel: HelperSessionHelperChannel | SignedHelperSessionHelperChannel;
  readonly #driver: NativeComputerUseDriver;
  readonly #clock: () => number;
  readonly #active = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly control: NativeDriverControlContext;
    }
  >();
  #closed = false;
  #loop: Promise<void> | undefined;

  public constructor(options: ServeSessionHelperChannelOptions) {
    this.#channel = options.channel;
    this.#driver = options.driver;
    this.#clock = options.clock ?? Date.now;
  }

  public start(): void {
    this.#loop ??= this.#serve().catch(async () => {
      await this.#stopAll();
      this.#channel.close();
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      await this.#loop?.catch(() => undefined);
      return;
    }
    this.#closed = true;
    await this.#stopAll();
    this.#channel.close();
    await this.#loop?.catch(() => undefined);
  }

  async #serve(): Promise<void> {
    while (!this.#closed && !this.#channel.isClosed) {
      const request = await this.#channel.receive();
      this.#dispatchAndSend(request).catch(() => {
        this.#channel.close();
      });
    }
  }

  async #dispatchAndSend(request: SessionHelperCapabilityRequest): Promise<void> {
    const response = await this.#dispatch(request);
    if (!this.#closed) {
      await this.#channel.send(response);
    }
  }

  async #dispatch(
    request: SessionHelperCapabilityRequest,
  ): Promise<SessionHelperCapabilityResponse> {
    try {
      switch (request.capability) {
        case "readiness": {
          const probe = await this.#driver.probe();
          const status = (name: string) =>
            probe.checks.find((check) => check.name === name)?.status === "pass";
          return ok(request, {
            interactiveSession: status("interactive-session"),
            unlockedSession: status("unlocked-session"),
            captureAvailable: status("screen-capture"),
            observationAvailable: status("accessibility"),
            inputAvailable: status("input"),
            emergencyStopAvailable: status("input"),
            displayFingerprint: probe.displayFingerprint,
          });
        }
        case "observe": {
          const active = this.#begin(request);
          try {
            const observation = await this.#driver.observe(
              executionContext(request.payload, this.#channel, active.controller.signal),
            );
            return ok(request, {
              displayFingerprint: observation.displayFingerprint,
              elements: observation.accessibilityTree
                .slice(0, request.payload.maxElements)
                .map((element) => ({
                  elementId: element.controlId,
                  role: element.role,
                  label: element.label,
                  value: element.value ?? null,
                  enabled: true,
                  selected: element.selected ?? null,
                })),
            });
          } finally {
            this.#active.delete(request.requestId);
          }
        }
        case "capture": {
          const active = this.#begin(request);
          try {
            const capture = await this.#driver.capture(
              executionContext(request.payload, this.#channel, active.controller.signal),
            );
            return ok(request, {
              mediaType: "image/png" as const,
              width: capture.width,
              height: capture.height,
              displayFingerprint: capture.displayFingerprint,
              bytesBase64Url: Buffer.from(capture.bytes).toString("base64url"),
            });
          } finally {
            this.#active.delete(request.requestId);
          }
        }
        case "exact_input": {
          const active = this.#begin(request);
          try {
            const action = nativeAction(request.payload.action);
            const base = executionContext(request.payload, this.#channel, active.controller.signal);
            const context: NativeDriverAuthorizedInputContext = {
              ...base,
              authorization: {
                authorizationId: request.payload.authorizationId,
                fingerprint: request.payload.policyFingerprint,
                action: request.payload.authorizedAction,
              },
            };
            await this.#driver.act(context, action);
            return ok(request, {
              applied: true,
              actionDigest: request.payload.policyFingerprint,
            });
          } finally {
            this.#active.delete(request.requestId);
          }
        }
        case "cancel": {
          const active = this.#active.get(request.payload.targetRequestId);
          if (active !== undefined) {
            active.controller.abort();
            await this.#driver.cancel(active.control);
          }
          return ok(request, { cancelled: active !== undefined });
        }
        case "emergency_stop": {
          await this.#stopAll();
          return ok(request, { stopped: true });
        }
        case "diagnostics":
          return ok(request, { entries: [] });
      }
    } catch (error: unknown) {
      return failure(request, errorCode(error));
    }
  }

  #begin(
    request: Extract<
      SessionHelperCapabilityRequest,
      { readonly capability: "capture" | "exact_input" | "observe" }
    >,
  ) {
    if (request.payload.deadlineUnixMs <= this.#clock()) {
      throw new NativeDriverError("TIMEOUT", "The helper capability deadline expired.");
    }
    const controller = new AbortController();
    const control = {
      executionHandleId: request.payload.executionHandleId,
      taskId: request.payload.taskId,
      deviceId: this.#channel.binding.deviceId,
      runId: request.payload.runId,
    };
    const active = { controller, control };
    this.#active.set(request.requestId, active);
    return active;
  }

  async #stopAll(): Promise<void> {
    const active = [...this.#active.values()];
    this.#active.clear();
    await Promise.all(
      active.map(async ({ controller, control }) => {
        controller.abort();
        await this.#driver.emergencyStop(control).catch(() => undefined);
      }),
    );
  }
}

function executionContext(
  payload: {
    readonly executionHandleId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly persistenceGeneration: string;
    readonly leaseId: string;
    readonly fencingToken: string;
    readonly displayFingerprint: string;
  },
  channel: HelperSessionHelperChannel | SignedHelperSessionHelperChannel,
  signal: AbortSignal,
): NativeDriverExecutionContext {
  const persistenceGeneration = Number(payload.persistenceGeneration);
  const fencingToken = Number(payload.fencingToken);
  if (
    !Number.isSafeInteger(persistenceGeneration) ||
    persistenceGeneration <= 0 ||
    !Number.isSafeInteger(fencingToken) ||
    fencingToken <= 0
  ) {
    throw new NativeDriverError("PERMISSION_DENIED", "The helper execution fence is invalid.");
  }
  return {
    executionHandleId: payload.executionHandleId,
    taskId: payload.taskId,
    deviceId: channel.binding.deviceId,
    runId: payload.runId,
    helperInstanceId: channel.binding.helperId,
    serviceEpoch: channel.binding.serviceEpoch,
    persistenceGeneration,
    leaseId: payload.leaseId,
    fencingToken,
    expectedDisplayFingerprint: payload.displayFingerprint,
    signal,
  };
}

function nativeAction(
  action: Extract<
    SessionHelperCapabilityRequest,
    { readonly capability: "exact_input" }
  >["payload"]["action"],
): NativeComputerUseAction {
  if (action.kind === "accessibility" && action.operation === "invoke") {
    return { kind: "click", controlId: action.targetId };
  }
  if (action.kind === "accessibility" && action.operation === "set_value") {
    return { kind: "type-text", controlId: action.targetId, text: action.value };
  }
  throw new NativeDriverError(
    "PERMISSION_DENIED",
    "The native driver does not support this exact helper action.",
  );
}

function ok(
  request: SessionHelperCapabilityRequest,
  payload: unknown,
): SessionHelperCapabilityResponse {
  return {
    type: "response",
    requestId: request.requestId,
    capability: request.capability,
    outcome: "ok",
    payload,
  } as SessionHelperCapabilityResponse;
}

function failure(
  request: SessionHelperCapabilityRequest,
  code: SessionHelperCapabilityErrorCode,
): SessionHelperCapabilityResponse {
  return {
    type: "response",
    requestId: request.requestId,
    capability: request.capability,
    outcome: "error",
    payload: { code },
  };
}

function errorCode(error: unknown): SessionHelperCapabilityErrorCode {
  if (!(error instanceof NativeDriverError)) {
    return "rejected";
  }
  switch (error.code) {
    case "CANCELLED":
      return "cancelled";
    case "DISPLAY_CHANGED":
      return "display_changed";
    case "PERMISSION_DENIED":
      return "permission_denied";
    case "TIMEOUT":
      return "deadline_exceeded";
    default:
      return "not_ready";
  }
}
