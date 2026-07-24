import { type ChildProcessWithoutNullStreams } from "node:child_process";

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
import { readBoundedLines, spawnCommand, type SpawnCommand } from "./process-utils.ts";
import { SecretRedactor } from "./redaction.ts";
import { type SessionLeaseStore } from "./session-leases.ts";

export type ProviderSignal =
  | {
      readonly kind: "session";
      readonly nativeSessionId: string;
    }
  | {
      readonly kind: "public_message";
      readonly text: string;
    }
  | {
      readonly kind: "message_delta";
      readonly text: string;
    }
  | {
      readonly kind: "tool_request";
      readonly toolName: string;
      readonly input?: unknown;
    }
  | {
      readonly kind: "tool_result";
      readonly toolName: string;
      readonly status: "succeeded" | "failed";
      readonly summary?: string;
    }
  | {
      readonly kind: "approval_request";
      readonly requestId: string;
      readonly actionType: string;
      readonly summary: string;
      readonly scope?: unknown;
    }
  | {
      readonly kind: "progress";
      readonly message: string;
    }
  | {
      readonly kind: "usage";
      readonly usage: AgentUsage;
    }
  | {
      readonly kind: "diagnostic";
      readonly level: "info" | "warning" | "error";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "terminal";
      readonly status: "succeeded" | "failed";
      readonly finalText?: string;
      readonly usage?: AgentUsage;
      readonly error?: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export interface SubprocessTurnOptions {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly request: AgentStartRequest | AgentResumeRequest;
  readonly cwd: string;
  readonly command: SpawnCommand;
  readonly stdin: string;
  readonly leaseStore: SessionLeaseStore;
  readonly now: () => number;
  readonly createSession: (nativeSessionId: string) => NativeSessionReference;
  readonly parseLine: (value: unknown) => readonly ProviderSignal[];
}

export async function startSubprocessTurn(options: SubprocessTurnOptions): Promise<AgentRunHandle> {
  const { request } = options;
  let lease = await options.leaseStore.acquire(
    request.sessionKey,
    request.runId,
    request.limits.leaseTtlMs,
    options.now(),
  );
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnCommand(options.command);
  } catch (error) {
    await options.leaseStore.release(lease);
    throw error;
  }
  const childExit = observeChildExit(child);

  const queue = new BoundedAsyncQueue<NormalizedAgentEvent>(request.limits.maxBufferedEvents);
  const redactor = new SecretRedactor(Object.values(request.secretEnvironment ?? {}));
  let sequence = 0;
  let cancelled = false;
  let cancellationReason = "The run was cancelled.";
  let timedOut = false;
  let leaseLost = false;
  let settled = false;
  let stopping = false;
  let lastActivity = options.now();
  let forceKillTimer: NodeJS.Timeout | undefined;
  let renewalPromise: Promise<void> | undefined;
  let stdinFailed = false;

  const emit = async (event: NormalizedAgentEventInput): Promise<void> => {
    sequence += 1;
    await queue.push({
      ...event,
      sequence,
      observedAt: new Date(options.now()).toISOString(),
    } as NormalizedAgentEvent);
  };

  const stopChild = (): void => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    stopping = true;
    child.kill();
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, request.limits.cancellationGraceMs);
    forceKillTimer.unref();
  };

  const wallTimer = setTimeout(() => {
    timedOut = true;
    stopChild();
  }, request.limits.wallTimeoutMs);
  wallTimer.unref();
  const idleTimer = setInterval(
    () => {
      if (options.now() - lastActivity >= request.limits.idleTimeoutMs) {
        timedOut = true;
        stopChild();
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
        stopChild();
      })
      .finally(() => {
        renewalPromise = undefined;
      });
  }, request.limits.leaseRenewIntervalMs);
  leaseTimer.unref();

  const diagnosticPromise = drainDiagnostics(
    child.stderr,
    request.limits.maxDiagnosticBytes,
    redactor,
    () => {
      lastActivity = options.now();
    },
  );
  child.stdin.once("error", () => {
    stdinFailed = true;
    stopChild();
  });
  try {
    child.stdin.end(options.stdin, "utf8");
  } catch {
    stdinFailed = true;
    stopChild();
  }

  let resolveResult: (result: AgentRunResult) => void = () => undefined;
  const result = new Promise<AgentRunResult>((resolve) => {
    resolveResult = resolve;
  });

  const producer = async (): Promise<void> => {
    let session: NativeSessionReference | undefined;
    let finalText: string | undefined;
    let usage: AgentUsage | undefined;
    let terminalSeen = false;
    let terminalError: unknown;
    try {
      for await (const rawLine of readBoundedLines(child.stdout, request.limits.maxLineBytes)) {
        lastActivity = options.now();
        if (rawLine.trim().length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          throw new AgentAdapterError(
            "MALFORMED_PROVIDER_OUTPUT",
            "The provider emitted invalid JSONL.",
          );
        }
        const signals = options.parseLine(redactor.unknown(parsed));
        for (const signal of signals) {
          if (signal.kind === "session") {
            if (
              request.operation === "resume" &&
              signal.nativeSessionId !== request.session.nativeSessionId
            ) {
              throw new AgentAdapterError(
                "NATIVE_SESSION_ID_CHANGED",
                "Resume returned a different native session ID.",
              );
            }
            if (session === undefined) {
              session = options.createSession(signal.nativeSessionId);
              await emit({ type: "session_started", session });
            } else if (session.nativeSessionId !== signal.nativeSessionId) {
              throw new AgentAdapterError(
                "NATIVE_SESSION_ID_CHANGED",
                "The provider changed native session IDs during one turn.",
              );
            }
          } else if (signal.kind === "public_message") {
            finalText = signal.text;
            await emit({ type: "public_message", role: "assistant", text: signal.text });
          } else if (signal.kind === "message_delta") {
            await emit({ type: "message_delta", text: signal.text });
          } else if (signal.kind === "tool_request") {
            await emit({
              type: "tool_request",
              toolName: signal.toolName,
              ...(signal.input === undefined ? {} : { input: signal.input }),
            });
          } else if (signal.kind === "tool_result") {
            await emit({
              type: "tool_result",
              toolName: signal.toolName,
              status: signal.status,
              ...(signal.summary === undefined ? {} : { summary: signal.summary }),
            });
          } else if (signal.kind === "approval_request") {
            await emit({
              type: "approval_request",
              requestId: signal.requestId,
              actionType: signal.actionType,
              summary: signal.summary,
              ...(signal.scope === undefined ? {} : { scope: signal.scope }),
            });
          } else if (signal.kind === "progress") {
            await emit({ type: "progress", message: signal.message });
          } else if (signal.kind === "usage") {
            usage = signal.usage;
            await emit({ type: "usage", usage });
          } else if (signal.kind === "diagnostic") {
            await emit({
              type: "diagnostic",
              level: signal.level,
              code: signal.code,
              message: signal.message,
            });
          } else {
            terminalSeen = true;
            finalText = signal.finalText ?? finalText;
            usage = signal.usage ?? usage;
            if (signal.usage !== undefined) {
              await emit({ type: "usage", usage: signal.usage });
            }
            if (signal.status === "failed") {
              terminalError = new AgentAdapterError(
                signal.error?.code ?? "PROVIDER_REPORTED_FAILURE",
                signal.error?.message ?? "The provider reported a failed turn.",
                signal.error?.retryable ?? true,
              );
            }
          }
        }
      }

      const exit = await childExit;
      const providerDiagnostic = await diagnosticPromise;
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
      } else if (stdinFailed) {
        terminalError = new AgentAdapterError(
          "PROVIDER_STDIN_FAILED",
          "The provider process did not accept its input.",
          true,
        );
      } else if (exit.error !== undefined) {
        terminalError = new AgentAdapterError(
          "PROVIDER_PROCESS_START_FAILED",
          "The provider process could not be started.",
          true,
        );
      } else if (exit.code !== 0) {
        terminalError = new AgentAdapterError(
          "PROVIDER_PROCESS_FAILED",
          providerDiagnostic.length === 0
            ? "The provider process exited unsuccessfully."
            : "The provider process exited unsuccessfully; provider diagnostic content was withheld.",
          true,
        );
      } else if (session === undefined || !terminalSeen) {
        terminalError = new AgentAdapterError(
          "INCOMPLETE_PROVIDER_OUTPUT",
          "The provider exited without a session and terminal event.",
        );
      }
    } catch (error) {
      terminalError = error;
      stopChild();
      await Promise.allSettled([childExit, diagnosticPromise]);
    }

    clearTimeout(wallTimer);
    clearInterval(idleTimer);
    clearInterval(leaseTimer);
    await renewalPromise;
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
      await emit({
        type: "diagnostic",
        level: "error",
        code: failure.code,
        message: failure.message,
      });
    }
    await emit({
      type: "completed",
      status,
      ...(failure === undefined ? {} : { error: failure }),
    });
    const completed: AgentRunResult = {
      status,
      ...(session === undefined ? {} : { session }),
      ...(finalText === undefined ? {} : { finalText }),
      ...(usage === undefined ? {} : { usage }),
      ...(failure === undefined ? {} : { error: failure }),
    };
    settled = true;
    resolveResult(completed);
    queue.close();
  };

  void producer()
    .finally(async () => {
      clearTimeout(wallTimer);
      clearInterval(idleTimer);
      clearInterval(leaseTimer);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
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
      stopChild();
    },
  };
}

async function drainDiagnostics(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  redactor: SecretRedactor,
  onActivity: () => void,
): Promise<string> {
  const chunks: Buffer[] = [];
  let collected = 0;
  for await (const value of stream) {
    onActivity();
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (collected < maxBytes) {
      const selected = chunk.subarray(0, maxBytes - collected);
      chunks.push(selected);
      collected += selected.length;
    }
  }
  return redactor.text(Buffer.concat(chunks).toString("utf8").trim());
}

function observeChildExit(child: ChildProcessWithoutNullStreams): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: unknown;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    let observed = false;
    child.once("error", (error) => {
      if (!observed) {
        observed = true;
        resolve({ code: null, signal: null, error });
      }
    });
    child.once("close", (code, signal) => {
      if (!observed) {
        observed = true;
        resolve({ code, signal });
      }
    });
  });
}
