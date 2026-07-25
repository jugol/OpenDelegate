import { randomUUID } from "node:crypto";

import {
  NativeDriverError,
  requireExactNativeInputAuthorization,
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
} from "@opendelegate/computer-use-os";
import type {
  CoreSessionHelperChannel,
  SignedCoreSessionHelperChannel,
  SessionHelperCapability,
  SessionHelperCapabilityRequest,
  SessionHelperCapabilityResponse,
} from "@opendelegate/session-helper-ipc";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ELEMENTS = 2_048;

export interface SessionHelperCoreClientOptions {
  readonly channel: CoreSessionHelperChannel | SignedCoreSessionHelperChannel;
  readonly osFamily: NativeComputerUseDriver["osFamily"];
  readonly backendId: string;
  readonly requestTimeoutMs?: number;
  readonly requestIdSource?: () => string;
  readonly clock?: () => number;
}

export class SessionHelperCoreClient implements NativeComputerUseDriver {
  public readonly osFamily: NativeComputerUseDriver["osFamily"];
  readonly #channel: CoreSessionHelperChannel | SignedCoreSessionHelperChannel;
  readonly #backendId: string;
  readonly #requestTimeoutMs: number;
  readonly #requestIdSource: () => string;
  readonly #clock: () => number;
  readonly #pending = new Map<
    string,
    {
      readonly capability: SessionHelperCapability;
      readonly resolve: (response: SessionHelperCapabilityResponse) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  readonly #activeRequests = new Map<string, string>();
  readonly #closedPromise: Promise<void>;
  #resolveClosed: () => void = () => {};
  #closed = false;
  #sequence = 0;

  public constructor(options: SessionHelperCoreClientOptions) {
    this.#channel = options.channel;
    this.osFamily = options.osFamily;
    this.#backendId = requireIdentifier(options.backendId, "backend ID");
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs <= 0 ||
      this.#requestTimeoutMs > 60_000
    ) {
      throw new TypeError("The session-helper request timeout is invalid.");
    }
    this.#requestIdSource = options.requestIdSource ?? randomUUID;
    this.#clock = options.clock ?? Date.now;
    this.#closedPromise = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.#receiveLoop().catch(() => this.close());
  }

  public get isClosed(): boolean {
    return this.#closed;
  }

  public get completed(): Promise<void> {
    return this.#closedPromise;
  }

  public async probe(): Promise<NativeDriverProbe> {
    const response = await this.#request("readiness", {});
    if (response.capability !== "readiness" || response.outcome !== "ok") {
      throw responseError(response);
    }
    const payload = response.payload;
    return Object.freeze({
      osFamily: this.osFamily,
      backendId: this.#backendId,
      helperInstanceId: this.#channel.binding.helperId,
      serviceEpoch: this.#channel.binding.serviceEpoch,
      displayFingerprint: payload.displayFingerprint,
      ...(this.osFamily === "linux"
        ? {
            linuxTarget:
              payload.interactiveSession && payload.displayFingerprint !== null
                ? ("ubuntu-24.04-gnome-wayland" as const)
                : ("headless" as const),
          }
        : {}),
      checks: Object.freeze(readinessChecks(payload)),
    });
  }

  public async observe(context: NativeDriverExecutionContext): Promise<NativeObservation> {
    this.#requireContext(context);
    const response = await this.#request(
      "observe",
      {
        ...wireContext(context, this.#deadline()),
        maxElements: MAX_ELEMENTS,
      },
      context.signal,
    );
    if (response.capability !== "observe" || response.outcome !== "ok") {
      throw responseError(response);
    }
    return Object.freeze({
      displayFingerprint: response.payload.displayFingerprint,
      accessibilityTree: Object.freeze(
        response.payload.elements.map((element) =>
          Object.freeze({
            controlId: element.elementId,
            role: normalizeRole(element.role),
            label: element.label,
            ...(element.value === null ? {} : { value: element.value }),
            ...(element.selected === null ? {} : { selected: element.selected }),
          }),
        ),
      ),
    });
  }

  public async capture(context: NativeDriverExecutionContext): Promise<NativeCapture> {
    this.#requireContext(context);
    const response = await this.#request(
      "capture",
      wireContext(context, this.#deadline()),
      context.signal,
    );
    if (response.capability !== "capture" || response.outcome !== "ok") {
      throw responseError(response);
    }
    return Object.freeze({
      mediaType: "image/png",
      width: response.payload.width,
      height: response.payload.height,
      displayFingerprint: response.payload.displayFingerprint,
      bytes: Buffer.from(response.payload.bytesBase64Url, "base64url"),
    });
  }

  public async act(
    context: NativeDriverAuthorizedInputContext,
    action: NativeComputerUseAction,
  ): Promise<NativeActionReceipt> {
    this.#requireContext(context);
    requireExactNativeInputAuthorization(context, action);
    const requestId = this.#nextRequestId();
    this.#activeRequests.set(context.executionHandleId, requestId);
    try {
      const response = await this.#requestWithId(
        requestId,
        "exact_input",
        {
          ...wireContext(context, this.#deadline()),
          authorizationId: context.authorization.authorizationId,
          policyFingerprint: context.authorization.fingerprint,
          authorizedAction: context.authorization.action,
          action:
            action.kind === "click"
              ? {
                  kind: "accessibility" as const,
                  operation: "invoke" as const,
                  targetId: action.controlId,
                }
              : {
                  kind: "accessibility" as const,
                  operation: "set_value" as const,
                  targetId: action.controlId,
                  value: action.text,
                },
        },
        context.signal,
      );
      if (response.capability !== "exact_input" || response.outcome !== "ok") {
        throw responseError(response);
      }
      if (
        response.payload.applied !== true ||
        response.payload.actionDigest !== context.authorization.fingerprint
      ) {
        throw new NativeDriverError(
          "PERMISSION_DENIED",
          "The session helper did not attest the exact authorized input.",
        );
      }
      this.#sequence += 1;
      return Object.freeze({
        displayFingerprint: context.expectedDisplayFingerprint,
        sequence: this.#sequence,
      });
    } finally {
      this.#activeRequests.delete(context.executionHandleId);
    }
  }

  public async cancel(context: NativeDriverControlContext): Promise<void> {
    const targetRequestId = this.#activeRequests.get(context.executionHandleId);
    if (targetRequestId === undefined) {
      return;
    }
    const response = await this.#request("cancel", { targetRequestId });
    if (response.capability !== "cancel" || response.outcome !== "ok") {
      throw responseError(response);
    }
  }

  public async emergencyStop(_context: NativeDriverControlContext): Promise<void> {
    const response = await this.#request("emergency_stop", { reasonCode: "policy" });
    if (response.capability !== "emergency_stop" || response.outcome !== "ok") {
      throw responseError(response);
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#channel.close();
    const error = new NativeDriverError("HELPER_CRASHED", "The session helper disconnected.");
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#activeRequests.clear();
    this.#resolveClosed();
  }

  async #request(
    capability: SessionHelperCapability,
    payload: SessionHelperCapabilityRequest["payload"],
    signal?: AbortSignal,
  ): Promise<SessionHelperCapabilityResponse> {
    return await this.#requestWithId(this.#nextRequestId(), capability, payload, signal);
  }

  async #requestWithId(
    requestId: string,
    capability: SessionHelperCapability,
    payload: SessionHelperCapabilityRequest["payload"],
    signal?: AbortSignal,
  ): Promise<SessionHelperCapabilityResponse> {
    if (this.#closed || this.#channel.isClosed || signal?.aborted === true) {
      throw new NativeDriverError("CANCELLED", "The session-helper request is unavailable.");
    }
    const response = new Promise<SessionHelperCapabilityResponse>((resolve, reject) => {
      this.#pending.set(requestId, { capability, resolve, reject });
    });
    const timer = setTimeout(() => {
      this.#pending
        .get(requestId)
        ?.reject(new NativeDriverError("TIMEOUT", "The session-helper request timed out."));
      this.#pending.delete(requestId);
    }, this.#requestTimeoutMs);
    const abort = () => {
      this.#pending
        .get(requestId)
        ?.reject(new NativeDriverError("CANCELLED", "The session-helper request was cancelled."));
      this.#pending.delete(requestId);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.#channel.send({
        type: "request",
        requestId,
        capability,
        payload,
      } as unknown as SessionHelperCapabilityRequest);
      return await response;
    } catch (error: unknown) {
      if (error instanceof NativeDriverError) {
        throw error;
      }
      throw new NativeDriverError("HELPER_CRASHED", "The session helper disconnected.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.#pending.delete(requestId);
    }
  }

  async #receiveLoop(): Promise<void> {
    while (!this.#closed && !this.#channel.isClosed) {
      const response = await this.#channel.receive();
      const pending = this.#pending.get(response.requestId);
      if (pending === undefined || pending.capability !== response.capability) {
        throw new Error("The session-helper response correlation is invalid.");
      }
      pending.resolve(response);
    }
  }

  #requireContext(context: NativeDriverExecutionContext): void {
    if (
      context.signal.aborted ||
      context.deviceId !== this.#channel.binding.deviceId ||
      context.helperInstanceId !== this.#channel.binding.helperId ||
      context.serviceEpoch !== this.#channel.binding.serviceEpoch
    ) {
      throw new NativeDriverError(
        "HELPER_CRASHED",
        "The session-helper execution binding is stale.",
      );
    }
  }

  #nextRequestId(): string {
    return requireIdentifier(this.#requestIdSource(), "request ID");
  }

  #deadline(): number {
    return this.#clock() + this.#requestTimeoutMs;
  }
}

function wireContext(context: NativeDriverExecutionContext, deadlineUnixMs: number) {
  return {
    executionHandleId: context.executionHandleId,
    taskId: context.taskId,
    runId: context.runId,
    persistenceGeneration: String(context.persistenceGeneration),
    leaseId: context.leaseId,
    fencingToken: String(context.fencingToken),
    deadlineUnixMs,
    displayFingerprint: context.expectedDisplayFingerprint,
  };
}

function readinessChecks(payload: {
  readonly interactiveSession: boolean;
  readonly unlockedSession: boolean;
  readonly captureAvailable: boolean;
  readonly observationAvailable: boolean;
  readonly inputAvailable: boolean;
  readonly emergencyStopAvailable: boolean;
}): readonly ReadinessCheck[] {
  return [
    check("interactive-session", payload.interactiveSession),
    check("unlocked-session", payload.unlockedSession),
    check("screen-capture", payload.captureAvailable),
    check("accessibility", payload.observationAvailable),
    check("input", payload.inputAvailable && payload.emergencyStopAvailable),
    check("helper-authentication", true),
  ];
}

function check(name: ReadinessCheck["name"], passed: boolean): ReadinessCheck {
  return Object.freeze({
    name,
    status: passed ? ("pass" as const) : ("fail" as const),
    evidence: passed
      ? "The authenticated session helper positively verified this boundary."
      : "The authenticated session helper reported this boundary unavailable.",
    ...(passed
      ? {}
      : { remediation: "Restore the logged-in owner session and its native permissions." }),
  });
}

function normalizeRole(role: string): "button" | "radio" | "textbox" {
  if (role === "radio" || role === "textbox") {
    return role;
  }
  return "button";
}

function responseError(response: SessionHelperCapabilityResponse): NativeDriverError {
  if (response.outcome !== "error") {
    return new NativeDriverError("HELPER_CRASHED", "The session-helper response is invalid.");
  }
  const code = response.payload.code;
  return new NativeDriverError(
    code === "cancelled"
      ? "CANCELLED"
      : code === "deadline_exceeded"
        ? "TIMEOUT"
        : code === "display_changed"
          ? "DISPLAY_CHANGED"
          : code === "permission_denied" || code === "rejected" || code === "stale_authority"
            ? "PERMISSION_DENIED"
            : "UNAVAILABLE",
    "The session helper rejected the bounded capability request.",
  );
}

function requireIdentifier(value: string, name: string): string {
  if (value.length === 0 || value.length > 256 || value !== value.trim() || /\p{Cc}/u.test(value)) {
    throw new TypeError(`The ${name} is invalid.`);
  }
  return value;
}
