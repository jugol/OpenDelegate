import type {
  ComputerUseInputAuthorizationProof,
  ComputerUseInputAuthorizationRequest,
  ComputerUseInputAuthorizer,
  ComputerUseInputConsumptionProof,
} from "@opendelegate/computer-use-os";
import type {
  WorkerActionAuthorizationDecisionV1,
  WorkerActionAuthorizationRequestV1,
  WorkerActionConsumptionDecisionV1,
  WorkerActionConsumptionRequestV1,
} from "@opendelegate/device-channel";
import type { WorkerRunAssignmentV1, WorkerRunLeaseAuthority } from "@opendelegate/worker-runtime";

export interface WorkerActionAuthorizationChannelPort {
  authorizeAction(
    request: WorkerActionAuthorizationRequestV1,
  ): Promise<WorkerActionAuthorizationDecisionV1>;
  consumeActionAuthorization(
    request: WorkerActionConsumptionRequestV1,
  ): Promise<WorkerActionConsumptionDecisionV1>;
}

export interface WorkerComputerUseInputAuthorizerOptions {
  readonly assignment: WorkerRunAssignmentV1;
  readonly leaseAuthority?: WorkerRunLeaseAuthority;
  readonly channel: () => WorkerActionAuthorizationChannelPort | undefined;
  readonly isExecutionCurrent: () => Promise<boolean>;
  readonly clock?: { now(): number };
}

/**
 * Typed Computer Use facade over the generic exact-action Device-channel RPC.
 * It has no local allow fallback: an absent channel, mismatched response, or
 * stale Run always fails closed before the OS backend can mutate input.
 */
export class WorkerComputerUseInputAuthorizer implements ComputerUseInputAuthorizer {
  readonly #options: WorkerComputerUseInputAuthorizerOptions;
  readonly #requestLeaseExpiries = new Map<string, number>();

  public constructor(options: WorkerComputerUseInputAuthorizerOptions) {
    if (
      typeof options.channel !== "function" ||
      typeof options.isExecutionCurrent !== "function" ||
      (options.leaseAuthority !== undefined &&
        typeof options.leaseAuthority.snapshot !== "function")
    ) {
      throw new TypeError("The Worker action authorization channel is invalid.");
    }
    this.#options = options;
  }

  public async authorize(
    request: ComputerUseInputAuthorizationRequest,
  ): Promise<ComputerUseInputAuthorizationProof> {
    this.#assertRequestScope(request);
    await this.#requireCurrent();
    const channel = this.#options.channel();
    if (channel === undefined) {
      return deniedProof(request, "channel-unavailable");
    }
    const leaseExpiresAtMs =
      this.#requestLeaseExpiries.get(request.authorizationRequestId) ??
      this.#options.leaseAuthority?.snapshot().leaseExpiresAtMs ??
      this.#options.assignment.leaseExpiresAtMs;
    this.#requestLeaseExpiries.set(request.authorizationRequestId, leaseExpiresAtMs);
    const response = await channel.authorizeAction({
      ...runScope(this.#options.assignment, leaseExpiresAtMs),
      authorizationRequestId: request.authorizationRequestId,
      actionCategory: request.actionCategory,
      actionType: request.action.kind,
      actionFingerprint: request.fingerprint,
      actionDescriptor: {
        kind: request.action.kind,
        privacy: "exact-input-withheld-on-device",
      },
      requestedAtMs: request.requestedAtMs,
    });
    await this.#requireCurrent();
    if (
      response.authorizationRequestId !== request.authorizationRequestId ||
      response.actionFingerprint !== request.fingerprint ||
      !validIdentifier(response.authorizationId)
    ) {
      return deniedProof(request, "response-mismatch");
    }
    if (response.decision === "deny") {
      this.#requestLeaseExpiries.delete(request.authorizationRequestId);
    }
    return Object.freeze({
      decision: response.decision,
      authorizationId: response.authorizationId,
      fingerprint: response.actionFingerprint,
      ...(response.reasonCode.length === 0 ? {} : { reason: response.reasonCode }),
    });
  }

  public async consume(
    request: ComputerUseInputAuthorizationRequest,
    proof: Extract<ComputerUseInputAuthorizationProof, { readonly decision: "allow" }>,
  ): Promise<ComputerUseInputConsumptionProof> {
    this.#assertRequestScope(request);
    if (proof.fingerprint !== request.fingerprint || !validIdentifier(proof.authorizationId)) {
      throw new Error("The exact action authorization proof is invalid.");
    }
    await this.#requireCurrent();
    const channel = this.#options.channel();
    if (channel === undefined) {
      throw new Error("The action authorization channel is unavailable.");
    }
    const leaseExpiresAtMs = this.#requestLeaseExpiries.get(request.authorizationRequestId);
    if (leaseExpiresAtMs === undefined) {
      throw new Error("The exact action authorization scope is unavailable.");
    }
    const response = await channel.consumeActionAuthorization({
      ...runScope(this.#options.assignment, leaseExpiresAtMs),
      authorizationRequestId: request.authorizationRequestId,
      authorizationId: proof.authorizationId,
      actionCategory: request.actionCategory,
      actionFingerprint: request.fingerprint,
      requestedAtMs: readClock(this.#options.clock),
    });
    if (
      response.decision !== "consumed" ||
      response.reasonCode !== "AUTHORIZATION_CONSUMED" ||
      response.authorizationRequestId !== request.authorizationRequestId ||
      response.authorizationId !== proof.authorizationId ||
      response.actionFingerprint !== request.fingerprint
    ) {
      throw new Error(
        response.reasonCode === "CONSUMPTION_REPLAY"
          ? "The exact Computer Use action authorization was already consumed."
          : "The exact action authorization was not consumed.",
      );
    }
    this.#requestLeaseExpiries.delete(request.authorizationRequestId);
    return Object.freeze({
      decision: "consumed",
      authorizationRequestId: response.authorizationRequestId,
      authorizationId: response.authorizationId,
      fingerprint: response.actionFingerprint,
    });
  }

  #assertRequestScope(request: ComputerUseInputAuthorizationRequest): void {
    const assignment = this.#options.assignment;
    if (
      request.actionCategory !== "computer-use-input" ||
      request.taskId !== assignment.taskId ||
      request.deviceId !== assignment.deviceId ||
      request.runId !== assignment.runId ||
      !validIdentifier(request.authorizationRequestId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(request.fingerprint)
    ) {
      throw new Error("The Computer Use request escaped its exact Worker Run.");
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

function deniedProof(
  request: ComputerUseInputAuthorizationRequest,
  reason: string,
): ComputerUseInputAuthorizationProof {
  return Object.freeze({
    decision: "deny" as const,
    authorizationId: `denied:${request.authorizationRequestId}`,
    fingerprint: request.fingerprint,
    reason,
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

function readClock(clock: { now(): number } | undefined): number {
  const now = (clock ?? { now: () => Date.now() }).now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("The Worker action authorization clock is invalid.");
  }
  return now;
}
