import type {
  AgentActionAuthorizationDecision,
  AgentActionAuthorizationPort,
  AgentActionAuthorizationRequest,
} from "@opendelegate/agent-adapters";
import type {
  WorkerActionAuthorizationDecisionV1,
  WorkerActionAuthorizationRequestV1,
  WorkerActionConsumptionDecisionV1,
  WorkerActionConsumptionRequestV1,
} from "@opendelegate/device-channel";
import type { WorkerRunAssignmentV1, WorkerRunLeaseAuthority } from "@opendelegate/worker-runtime";

export interface WorkerAgentActionAuthorizationChannelPort {
  authorizeAction(
    request: WorkerActionAuthorizationRequestV1,
  ): Promise<WorkerActionAuthorizationDecisionV1>;
  consumeActionAuthorization(
    request: WorkerActionConsumptionRequestV1,
  ): Promise<WorkerActionConsumptionDecisionV1>;
}

export interface WorkerAgentActionAuthorizerOptions {
  readonly assignment: WorkerRunAssignmentV1;
  readonly leaseAuthority?: WorkerRunLeaseAuthority;
  readonly channel: () => WorkerAgentActionAuthorizationChannelPort | undefined;
  readonly isExecutionCurrent: () => Promise<boolean>;
  readonly clock?: { now(): number };
  readonly approvalPollIntervalMs?: number;
}

/**
 * Device-local, LLM-free bridge from provider-native permission callbacks to
 * Main's durable Policy/Approval runtime.
 *
 * A pending owner Approval is polled with byte-identical request content. An
 * allow is consumed durably after a final Run-authority check and immediately
 * before the provider callback is released.
 */
export class WorkerAgentActionAuthorizer implements AgentActionAuthorizationPort {
  readonly #options: WorkerAgentActionAuthorizerOptions;
  readonly #pollIntervalMs: number;

  public constructor(options: WorkerAgentActionAuthorizerOptions) {
    this.#options = options;
    this.#pollIntervalMs = options.approvalPollIntervalMs ?? 750;
    if (
      typeof options.channel !== "function" ||
      typeof options.isExecutionCurrent !== "function" ||
      (options.leaseAuthority !== undefined &&
        typeof options.leaseAuthority.snapshot !== "function") ||
      !Number.isSafeInteger(this.#pollIntervalMs) ||
      this.#pollIntervalMs < 100 ||
      this.#pollIntervalMs > 10_000
    ) {
      throw new TypeError("The Worker Agent action authorizer configuration is invalid.");
    }
  }

  public async authorizeAndConsume(
    input: AgentActionAuthorizationRequest,
  ): Promise<AgentActionAuthorizationDecision> {
    validateAgentActionRequest(input);
    const request = Object.freeze({
      ...runScope(
        this.#options.assignment,
        this.#options.leaseAuthority?.snapshot().leaseExpiresAtMs ??
          this.#options.assignment.leaseExpiresAtMs,
      ),
      authorizationRequestId: input.authorizationRequestId,
      actionCategory: input.actionCategory,
      actionType: input.actionType,
      actionFingerprint: input.actionFingerprint,
      actionDescriptor: structuredClone(input.actionDescriptor),
      requestedAtMs: input.requestedAtMs,
    }) satisfies WorkerActionAuthorizationRequestV1;

    for (;;) {
      if (input.signal.aborted) {
        return denied("ACTION_CANCELLED");
      }
      await this.#requireCurrent();
      const channel = this.#options.channel();
      if (channel === undefined) {
        return denied("ACTION_CHANNEL_UNAVAILABLE");
      }
      const response = await channel.authorizeAction(request);
      if (
        response.authorizationRequestId !== input.authorizationRequestId ||
        response.actionFingerprint !== input.actionFingerprint ||
        !validIdentifier(response.authorizationId)
      ) {
        return denied("ACTION_AUTHORIZATION_RESPONSE_MISMATCH");
      }
      if (response.decision === "deny") {
        return denied(response.reasonCode);
      }
      if (response.decision === "require-approval") {
        await abortableDelay(this.#pollIntervalMs, input.signal);
        continue;
      }

      await this.#requireCurrent();
      if (input.signal.aborted) {
        return denied("ACTION_CANCELLED");
      }
      const currentChannel = this.#options.channel();
      if (currentChannel === undefined) {
        return denied("ACTION_CHANNEL_UNAVAILABLE");
      }
      const consumed = await currentChannel.consumeActionAuthorization({
        // Consumption must remain byte-identical to the scope persisted under
        // this authorizationRequestId, even when the exact Run later renews.
        ...runScope(this.#options.assignment, request.leaseExpiresAtMs),
        authorizationRequestId: input.authorizationRequestId,
        authorizationId: response.authorizationId,
        actionCategory: input.actionCategory,
        actionFingerprint: input.actionFingerprint,
        requestedAtMs: this.#now(),
      });
      if (
        consumed.decision !== "consumed" ||
        consumed.reasonCode !== "AUTHORIZATION_CONSUMED" ||
        consumed.authorizationRequestId !== input.authorizationRequestId ||
        consumed.authorizationId !== response.authorizationId ||
        consumed.actionFingerprint !== input.actionFingerprint
      ) {
        return denied(
          consumed.decision === "consumed" && consumed.reasonCode === "CONSUMPTION_REPLAY"
            ? "ACTION_AUTHORIZATION_REPLAYED"
            : "ACTION_AUTHORIZATION_NOT_CONSUMED",
        );
      }
      await this.#requireCurrent();
      return Object.freeze({
        decision: "allow",
        reasonCode: response.reasonCode,
      });
    }
  }

  async #requireCurrent(): Promise<void> {
    try {
      if ((await this.#options.isExecutionCurrent()) === true) {
        return;
      }
    } catch {
      // Fail closed below.
    }
    throw new Error("The authoritative Worker Run is no longer current.");
  }

  #now(): number {
    const now = (this.#options.clock ?? { now: () => Date.now() }).now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("The Worker Agent authorization clock is invalid.");
    }
    return now;
  }
}

function runScope(assignment: WorkerRunAssignmentV1, leaseExpiresAtMs: number) {
  return {
    taskId: assignment.taskId,
    workOrderId: assignment.workOrder.workOrderId,
    deviceId: assignment.deviceId,
    workerId: assignment.workerId,
    routeId: assignment.routeId,
    runId: assignment.runId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
    leaseExpiresAtMs,
  };
}

function validateAgentActionRequest(input: AgentActionAuthorizationRequest): void {
  if (
    !validIdentifier(input.authorizationRequestId) ||
    !validIdentifier(input.actionType) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.actionFingerprint) ||
    !Number.isSafeInteger(input.requestedAtMs) ||
    input.requestedAtMs < 0 ||
    input.signal === null ||
    typeof input.signal !== "object"
  ) {
    throw new Error("The provider action authorization request is invalid.");
  }
}

function denied(reasonCode: string): AgentActionAuthorizationDecision {
  return Object.freeze({
    decision: "deny",
    reasonCode: validIdentifier(reasonCode) ? reasonCode : "ACTION_AUTHORIZATION_DENIED",
  });
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 512
  );
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveDelay();
      },
      { once: true },
    );
  });
}
