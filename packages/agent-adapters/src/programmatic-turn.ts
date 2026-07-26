import { BoundedAsyncQueue } from "./async-queue.ts";
import {
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentRunResult,
  type AgentStartRequest,
  type AgentUsage,
  type NativeSessionReference,
  type NormalizedAgentEvent,
  type NormalizedAgentEventInput,
} from "./contracts.ts";
import { adapterFailure, AgentAdapterError } from "./errors.ts";
import { SecretRedactor } from "./redaction.ts";
import { type SessionLeaseStore } from "./session-leases.ts";
import { type ProviderSignal } from "./subprocess-turn.ts";

export type ProgrammaticProviderEvent =
  | Exclude<ProviderSignal, { readonly kind: "terminal" }>
  | {
      readonly kind: "steering_accepted";
      readonly requestId: string;
      readonly requestedBy: "owner" | "main-agent";
    };

export interface ProgrammaticProviderResult {
  readonly status: "succeeded" | "failed";
  readonly nativeSessionId: string;
  readonly finalText?: string;
  readonly usage?: AgentUsage;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface ProgrammaticTurnContext {
  readonly signal: AbortSignal;
  emit(event: ProgrammaticProviderEvent): Promise<void>;
}

export interface ProgrammaticTurnOptions {
  readonly request: AgentStartRequest | AgentResumeRequest;
  readonly leaseStore: SessionLeaseStore;
  readonly now: () => number;
  readonly createSession: (nativeSessionId: string) => NativeSessionReference;
  readonly run: (context: ProgrammaticTurnContext) => Promise<ProgrammaticProviderResult>;
}

/**
 * Provider-independent lifecycle for in-process SDK and bidirectional app-server
 * integrations. It preserves the same bounded event stream, timeout, cancellation,
 * and native-session fencing invariants as the CLI subprocess lifecycle.
 */
export async function startProgrammaticTurn(
  options: ProgrammaticTurnOptions,
): Promise<AgentRunHandle> {
  const { request } = options;
  let lease = await options.leaseStore.acquire(
    request.sessionKey,
    request.runId,
    request.limits.leaseTtlMs,
    options.now(),
  );
  const queue = new BoundedAsyncQueue<NormalizedAgentEvent>(request.limits.maxBufferedEvents);
  const redactor = new SecretRedactor(Object.values(request.secretEnvironment ?? {}));
  const abortController = new AbortController();
  let sequence = 0;
  let cancelled = false;
  let cancellationReason = "The run was cancelled.";
  let timedOut = false;
  let leaseLost = false;
  let settled = false;
  let lastActivity = options.now();
  let renewalPromise: Promise<void> | undefined;
  let session: NativeSessionReference | undefined;
  let finalText: string | undefined;
  let usage: AgentUsage | undefined;

  const emitNormalized = async (event: NormalizedAgentEventInput): Promise<void> => {
    if (settled) {
      throw new AgentAdapterError(
        "PROVIDER_EVENT_AFTER_COMPLETION",
        "The provider emitted an event after the turn completed.",
      );
    }
    sequence += 1;
    lastActivity = options.now();
    await queue.push({
      ...event,
      sequence,
      observedAt: new Date(lastActivity).toISOString(),
    } as NormalizedAgentEvent);
  };

  const emit = async (event: ProgrammaticProviderEvent): Promise<void> => {
    if (event.kind === "session") {
      const nativeSessionId = requireNativeSessionId(event.nativeSessionId);
      if (request.operation === "resume" && nativeSessionId !== request.session.nativeSessionId) {
        throw new AgentAdapterError(
          "NATIVE_SESSION_ID_CHANGED",
          "Resume returned a different native session ID.",
        );
      }
      if (session === undefined) {
        session = options.createSession(nativeSessionId);
        await emitNormalized({ type: "session_started", session });
      } else if (session.nativeSessionId !== nativeSessionId) {
        throw new AgentAdapterError(
          "NATIVE_SESSION_ID_CHANGED",
          "The provider changed native session IDs during one turn.",
        );
      }
      return;
    }
    if (event.kind === "public_message") {
      finalText = redactor.text(event.text);
      await emitNormalized({ type: "public_message", role: "assistant", text: finalText });
      return;
    }
    if (event.kind === "message_delta") {
      await emitNormalized({ type: "message_delta", text: redactor.text(event.text) });
      return;
    }
    if (event.kind === "tool_request") {
      await emitNormalized({
        type: "tool_request",
        toolName: redactor.text(event.toolName),
        ...(event.input === undefined ? {} : { input: redactor.unknown(event.input) }),
      });
      return;
    }
    if (event.kind === "tool_result") {
      await emitNormalized({
        type: "tool_result",
        toolName: redactor.text(event.toolName),
        status: event.status,
        ...(event.summary === undefined ? {} : { summary: redactor.text(event.summary) }),
      });
      return;
    }
    if (event.kind === "approval_request") {
      await emitNormalized({
        type: "approval_request",
        requestId: redactor.text(event.requestId),
        actionType: redactor.text(event.actionType),
        summary: redactor.text(event.summary),
        ...(event.scope === undefined ? {} : { scope: redactor.unknown(event.scope) }),
      });
      return;
    }
    if (event.kind === "progress") {
      await emitNormalized({ type: "progress", message: redactor.text(event.message) });
      return;
    }
    if (event.kind === "steering_accepted") {
      await emitNormalized({
        type: "steering_accepted",
        requestId: redactor.text(event.requestId),
        delivery: "live",
        requestedBy: event.requestedBy,
      });
      return;
    }
    if (event.kind === "usage") {
      usage = event.usage;
      await emitNormalized({ type: "usage", usage });
      return;
    }
    await emitNormalized({
      type: "diagnostic",
      level: event.level,
      code: redactor.text(event.code),
      message: redactor.text(event.message),
    });
  };

  const wallTimer = setTimeout(() => {
    timedOut = true;
    abortController.abort(new Error("wall-timeout"));
  }, request.limits.wallTimeoutMs);
  wallTimer.unref();
  const idleTimer = setInterval(
    () => {
      if (options.now() - lastActivity >= request.limits.idleTimeoutMs) {
        timedOut = true;
        abortController.abort(new Error("idle-timeout"));
      }
    },
    Math.min(request.limits.idleTimeoutMs, 250),
  );
  idleTimer.unref();
  const leaseTimer = setInterval(() => {
    if (renewalPromise !== undefined) {
      return;
    }
    renewalPromise = options.leaseStore
      .renew(lease, request.limits.leaseTtlMs, options.now())
      .then((renewed) => {
        lease = renewed;
      })
      .catch(() => {
        leaseLost = true;
        abortController.abort(new Error("lease-lost"));
      })
      .finally(() => {
        renewalPromise = undefined;
      });
  }, request.limits.leaseRenewIntervalMs);
  leaseTimer.unref();

  let resolveResult: (result: AgentRunResult) => void = () => undefined;
  const result = new Promise<AgentRunResult>((resolve) => {
    resolveResult = resolve;
  });

  const producer = async (): Promise<void> => {
    let providerResult: ProgrammaticProviderResult | undefined;
    let terminalError: unknown;
    try {
      providerResult = await options.run({
        signal: abortController.signal,
        emit,
      });
      const nativeSessionId = requireNativeSessionId(providerResult.nativeSessionId);
      if (session === undefined) {
        await emit({ kind: "session", nativeSessionId });
      } else if (session.nativeSessionId !== nativeSessionId) {
        throw new AgentAdapterError(
          "NATIVE_SESSION_ID_CHANGED",
          "The provider result changed native session IDs.",
        );
      }
      if (providerResult.finalText !== undefined) {
        finalText = redactor.text(providerResult.finalText);
      }
      if (providerResult.usage !== undefined) {
        usage = providerResult.usage;
      }
      if (providerResult.status === "failed") {
        terminalError = new AgentAdapterError(
          providerResult.error?.code ?? "PROVIDER_REPORTED_FAILURE",
          providerResult.error?.message ?? "The provider reported a failed turn.",
          providerResult.error?.retryable ?? true,
        );
      }
    } catch (error) {
      terminalError = error;
    }

    clearTimeout(wallTimer);
    clearInterval(idleTimer);
    clearInterval(leaseTimer);
    await renewalPromise;
    if (timedOut) {
      terminalError = new AgentAdapterError(
        "ADAPTER_WALL_OR_IDLE_TIMEOUT",
        "The run exceeded its configured wall or idle timeout.",
        true,
      );
    } else if (leaseLost) {
      terminalError = new AgentAdapterError(
        "NATIVE_SESSION_LEASE_LOST",
        "The native session writer lease was lost.",
      );
    } else if (cancelled) {
      terminalError = new AgentAdapterError("ADAPTER_CANCELLED", cancellationReason, true);
    }
    const status = timedOut
      ? "timed_out"
      : leaseLost
        ? "lease_lost"
        : cancelled
          ? "cancelled"
          : terminalError === undefined
            ? "succeeded"
            : "failed";
    const failure = terminalError === undefined ? undefined : adapterFailure(terminalError);
    if (failure !== undefined) {
      await emitNormalized({
        type: "diagnostic",
        level: "error",
        code: failure.code,
        message: redactor.text(failure.message),
      });
    }
    await emitNormalized({
      type: "completed",
      status,
      ...(failure === undefined ? {} : { error: failure }),
    });
    settled = true;
    resolveResult({
      status,
      ...(session === undefined ? {} : { session }),
      ...(finalText === undefined ? {} : { finalText }),
      ...(usage === undefined ? {} : { usage }),
      ...(failure === undefined ? {} : { error: failure }),
    });
    queue.close();
  };

  void producer()
    .finally(async () => {
      clearTimeout(wallTimer);
      clearInterval(idleTimer);
      clearInterval(leaseTimer);
      await renewalPromise;
      await options.leaseStore.release(lease);
    })
    .catch(() => undefined);

  return {
    events: queue,
    result,
    cancel: async (reason?: string): Promise<void> => {
      if (settled || cancelled) {
        return;
      }
      cancelled = true;
      cancellationReason =
        reason === undefined || reason.length === 0 ? cancellationReason : redactor.text(reason);
      abortController.abort(new Error("cancelled"));
    },
  };
}

function requireNativeSessionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 1_024
  ) {
    throw new AgentAdapterError(
      "MALFORMED_PROVIDER_OUTPUT",
      "The provider did not return a valid native session ID.",
    );
  }
  return value;
}
