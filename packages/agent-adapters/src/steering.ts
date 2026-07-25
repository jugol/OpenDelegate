import {
  type AgentAdapterProbe,
  type AgentRunHandle,
  type AgentSteeringScope,
  type AgentSteerReceipt,
  type AgentSteerRequest,
} from "./contracts.ts";
import { AgentAdapterError } from "./errors.ts";

export const MAX_AGENT_STEERING_INSTRUCTION_BYTES = 64 * 1024;

type ExpectedSteeringScope = Omit<AgentSteeringScope, "nativeSessionId">;

export interface ActiveProviderSteeringTarget {
  readonly nativeSessionId: string;
  send(request: AgentSteerRequest): Promise<{
    readonly providerTurnId?: string;
  }>;
}

interface SteeringAttempt {
  readonly fingerprint: string;
  readonly result: Promise<AgentSteerReceipt>;
}

/**
 * A handle-local steering fence. It deliberately cannot discover another active
 * Run: the adapter must activate it with the native session created by this exact
 * handle.
 */
export class ActiveRunSteeringController {
  readonly #expected: ExpectedSteeringScope;
  readonly #now: () => number;
  readonly #attempts = new Map<string, SteeringAttempt>();
  #state: "pending" | "active" | "completed" = "pending";
  #target: ActiveProviderSteeringTarget | undefined;
  #nativeSessionId: string | undefined;
  #sendTail: Promise<void> = Promise.resolve();

  public constructor(expected: ExpectedSteeringScope, now: () => number) {
    validateExpectedScope(expected);
    this.#expected = Object.freeze({ ...expected });
    this.#now = now;
  }

  public activate(target: ActiveProviderSteeringTarget): void {
    validateIdentifier(target.nativeSessionId, "nativeSessionId", 1_024);
    if (this.#state === "completed") {
      throw new AgentAdapterError(
        "STEERING_TURN_COMPLETED",
        "The provider turn completed before live steering became active.",
      );
    }
    if (this.#target !== undefined) {
      if (this.#target.nativeSessionId === target.nativeSessionId) {
        return;
      }
      throw new AgentAdapterError(
        "NATIVE_SESSION_ID_CHANGED",
        "The provider changed native session IDs during one steerable turn.",
      );
    }
    this.#target = target;
    this.#nativeSessionId = target.nativeSessionId;
    this.#state = "active";
  }

  public complete(): void {
    this.#state = "completed";
    this.#target = undefined;
  }

  public async steer(request: AgentSteerRequest): Promise<AgentSteerReceipt> {
    validateAgentSteerRequest(request);
    this.#assertScope(request.scope);
    const fingerprint = steeringFingerprint(request);
    const existing = this.#attempts.get(request.requestId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new AgentAdapterError(
          "STEERING_REQUEST_REPLAY_CONFLICT",
          "The steering request ID was reused with different content or scope.",
        );
      }
      const receipt = await existing.result;
      return Object.freeze({ ...receipt, status: "already-accepted" });
    }
    if (this.#state === "completed") {
      throw new AgentAdapterError(
        "STEERING_TURN_COMPLETED",
        "A completed provider turn cannot receive a new live steering instruction.",
      );
    }
    const target = this.#target;
    if (target === undefined || this.#state !== "active") {
      throw new AgentAdapterError(
        "STEERING_ACTIVE_TURN_REQUIRED",
        "Live steering requires the exact provider turn to be active.",
        true,
      );
    }
    const result = this.#sendTail.then(async (): Promise<AgentSteerReceipt> => {
      if (this.#state !== "active" || this.#target !== target) {
        throw new AgentAdapterError(
          "STEERING_TURN_COMPLETED",
          "The provider turn completed before the steering request could be sent.",
        );
      }
      try {
        const provider = await target.send(request);
        return Object.freeze({
          schemaVersion: 1,
          requestId: request.requestId,
          delivery: "live",
          status: "accepted",
          acceptedAt: new Date(this.#now()).toISOString(),
          ...(provider.providerTurnId === undefined
            ? {}
            : { providerTurnId: provider.providerTurnId }),
        });
      } catch (error) {
        // A lost provider response has an unknowable side-effect outcome. Poison
        // this live turn rather than retrying a possibly accepted instruction.
        this.complete();
        throw error;
      }
    });
    this.#sendTail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#attempts.set(request.requestId, { fingerprint, result });
    return await result;
  }

  #assertScope(candidate: AgentSteeringScope): void {
    const target = this.#target;
    if (
      candidate.provider !== this.#expected.provider ||
      candidate.adapterId !== this.#expected.adapterId ||
      candidate.runId !== this.#expected.runId ||
      candidate.taskId !== this.#expected.taskId ||
      candidate.workstreamId !== this.#expected.workstreamId ||
      candidate.sessionKey !== this.#expected.sessionKey ||
      candidate.deviceId !== this.#expected.deviceId ||
      candidate.workspaceId !== this.#expected.workspaceId ||
      (this.#nativeSessionId !== undefined &&
        candidate.nativeSessionId !== this.#nativeSessionId) ||
      (target !== undefined && candidate.nativeSessionId !== target.nativeSessionId)
    ) {
      throw new AgentAdapterError(
        "STEERING_SCOPE_MISMATCH",
        "The steering request does not match this exact active Run and native session.",
      );
    }
  }
}

export interface AgentSteeringDisposition {
  readonly delivery: "live" | "next-resume";
  readonly reasonCode: "ADAPTER_LIVE_STEERING_SUPPORTED" | "ADAPTER_LIVE_STEERING_UNAVAILABLE";
  readonly audit: {
    readonly eventName: "agent.steering.delivery-selected";
    readonly requestId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly deviceId: string;
    readonly nativeSessionId: string;
    readonly adapterId: string;
    readonly delivery: "live" | "next-resume";
    readonly reasonCode: "ADAPTER_LIVE_STEERING_SUPPORTED" | "ADAPTER_LIVE_STEERING_UNAVAILABLE";
  };
  /**
   * Present for deterministic fallback. The coordinator must persist this exact
   * instruction as an input to the next resume; the adapter does not improvise a
   * second provider turn.
   */
  readonly nextResumeInstruction?: string;
}

/**
 * Makes reduced-capability fallback explicit. It has no side effect: the caller
 * persists the returned audit object and, for `next-resume`, queues the exact
 * instruction for a later resume.
 */
export function selectAgentSteeringDisposition(
  probe: AgentAdapterProbe,
  handle: AgentRunHandle,
  request: AgentSteerRequest,
): AgentSteeringDisposition {
  validateAgentSteerRequest(request);
  if (request.scope.provider !== probe.provider || request.scope.adapterId !== probe.adapterId) {
    throw new AgentAdapterError(
      "STEERING_SCOPE_MISMATCH",
      "The steering request does not match the probed adapter.",
    );
  }
  if (probe.capabilities.steering && handle.steer === undefined) {
    throw new AgentAdapterError(
      "STEERING_CAPABILITY_CONTRACT_MISMATCH",
      "The adapter advertised live steering but its Run handle did not expose it.",
    );
  }
  if (!probe.capabilities.steering && handle.steer !== undefined) {
    throw new AgentAdapterError(
      "STEERING_CAPABILITY_CONTRACT_MISMATCH",
      "The Run handle exposed live steering that the adapter did not advertise.",
    );
  }
  const delivery = probe.capabilities.steering ? "live" : "next-resume";
  const reasonCode = probe.capabilities.steering
    ? "ADAPTER_LIVE_STEERING_SUPPORTED"
    : "ADAPTER_LIVE_STEERING_UNAVAILABLE";
  return Object.freeze({
    delivery,
    reasonCode,
    audit: Object.freeze({
      eventName: "agent.steering.delivery-selected",
      requestId: request.requestId,
      runId: request.scope.runId,
      taskId: request.scope.taskId,
      deviceId: request.scope.deviceId,
      nativeSessionId: request.scope.nativeSessionId,
      adapterId: request.scope.adapterId,
      delivery,
      reasonCode,
    }),
    ...(delivery === "next-resume" ? { nextResumeInstruction: request.instruction } : {}),
  });
}

export function validateAgentSteerRequest(request: AgentSteerRequest): void {
  if (request.schemaVersion !== 1) {
    throw new AgentAdapterError(
      "STEERING_REQUEST_INVALID",
      "The steering request schema version is unsupported.",
    );
  }
  validateIdentifier(request.requestId, "requestId");
  validateExpectedScope(request.scope);
  validateIdentifier(request.scope.nativeSessionId, "nativeSessionId", 1_024);
  if (
    typeof request.instruction !== "string" ||
    request.instruction.trim().length === 0 ||
    request.instruction.includes("\0") ||
    Buffer.byteLength(request.instruction, "utf8") > MAX_AGENT_STEERING_INSTRUCTION_BYTES
  ) {
    throw new AgentAdapterError(
      "STEERING_REQUEST_INVALID",
      "The steering instruction is empty or exceeds its safe size limit.",
    );
  }
  if (request.requestedBy !== "owner" && request.requestedBy !== "main-agent") {
    throw new AgentAdapterError("STEERING_REQUEST_INVALID", "The steering requester is invalid.");
  }
}

function validateExpectedScope(scope: ExpectedSteeringScope): void {
  if (scope.provider !== "codex" && scope.provider !== "claude" && scope.provider !== "generic") {
    throw new AgentAdapterError("STEERING_REQUEST_INVALID", "The steering provider is invalid.");
  }
  validateIdentifier(scope.adapterId, "adapterId");
  validateIdentifier(scope.runId, "runId");
  validateIdentifier(scope.taskId, "taskId");
  validateIdentifier(scope.workstreamId, "workstreamId");
  validateIdentifier(scope.sessionKey, "sessionKey", 1_024);
  validateIdentifier(scope.deviceId, "deviceId");
  validateIdentifier(scope.workspaceId, "workspaceId");
}

function validateIdentifier(value: string, field: string, maxBytes = 256): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new AgentAdapterError("STEERING_REQUEST_INVALID", `The steering ${field} is invalid.`);
  }
}

function steeringFingerprint(request: AgentSteerRequest): string {
  return JSON.stringify([
    request.schemaVersion,
    request.requestId,
    request.scope.provider,
    request.scope.adapterId,
    request.scope.runId,
    request.scope.taskId,
    request.scope.workstreamId,
    request.scope.sessionKey,
    request.scope.deviceId,
    request.scope.workspaceId,
    request.scope.nativeSessionId,
    request.instruction,
    request.requestedBy,
  ]);
}
