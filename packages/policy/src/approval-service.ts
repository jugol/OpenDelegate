import {
  createActionFingerprint,
  isActionFingerprint,
  type ActionFingerprint,
  type ActionTargetDescriptor,
  type ActionTargetValue,
} from "./action-fingerprint.ts";
import type { ActionCategory, OwnerGrant } from "./contracts.ts";

export type ApprovalRequestState = "pending" | "approved" | "denied" | "expired";
export type ApprovalExecutionStatus = "waiting" | "running" | "succeeded" | "failed" | "skipped";
export type ApprovalRisk = "low" | "medium" | "high" | "critical";
export type ApprovalGrantScope = OwnerGrant["scope"]["kind"];

export interface ApprovalPresentation {
  readonly reason: string;
  readonly target: string;
  readonly risk: ApprovalRisk;
  readonly evidence: readonly string[];
}

export interface ApprovalExecution {
  readonly kind: string;
  readonly payload: ActionTargetValue;
}

export interface ApprovalDecision {
  readonly kind: "approve" | "deny";
  readonly operationId: string;
  readonly decidedBy: string;
  readonly decidedAtMs: number;
  readonly grant?: OwnerGrant;
  readonly denialReason?: string;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly requestedBy: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly actionCategory: ActionCategory;
  readonly actionType: string;
  readonly actionFingerprint: ActionFingerprint;
  readonly actionDescriptor: ActionTargetDescriptor;
  readonly targetDeviceId?: string;
  readonly taskId?: string;
  readonly resource: string;
  readonly presentation: ApprovalPresentation;
  readonly execution: ApprovalExecution;
  state: ApprovalRequestState;
  executionStatus: ApprovalExecutionStatus;
  decision?: ApprovalDecision;
  onceGrantConsumedAtMs?: number;
  executionResult?: ActionTargetValue;
  executionErrorCode?: string;
  updatedAtMs: number;
}

export interface ApprovalAuditEvent {
  readonly auditId: string;
  readonly approvalId: string;
  readonly event:
    | "approval.requested"
    | "approval.approved"
    | "approval.denied"
    | "approval.expired"
    | "approval.once-grant-consumed"
    | "approval.execution-succeeded"
    | "approval.execution-failed";
  readonly actor: string;
  readonly occurredAtMs: number;
  readonly actionFingerprint: ActionFingerprint;
}

export interface StoredApprovalIdempotencyReceipt {
  readonly digest: ActionFingerprint;
  readonly approvalId: string;
}

export interface ApprovalRepositoryState {
  revision: number;
  readonly requests: Map<string, ApprovalRequest>;
  readonly requestReceipts: Map<string, StoredApprovalIdempotencyReceipt>;
  readonly decisionReceipts: Map<string, StoredApprovalIdempotencyReceipt>;
  readonly audits: ApprovalAuditEvent[];
}

export interface ReadonlyApprovalRepositoryState {
  readonly revision: number;
  readonly requests: ReadonlyMap<string, ApprovalRequest>;
  readonly requestReceipts: ReadonlyMap<string, StoredApprovalIdempotencyReceipt>;
  readonly decisionReceipts: ReadonlyMap<string, StoredApprovalIdempotencyReceipt>;
  readonly audits: readonly ApprovalAuditEvent[];
}

export interface ApprovalRepository {
  read<T>(operation: (state: ReadonlyApprovalRepositoryState) => T): Promise<T>;
  transact<T>(operation: (state: ApprovalRepositoryState) => T): Promise<T>;
}

export interface ApprovalRepositorySnapshotV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly requests: readonly (readonly [string, ApprovalRequest])[];
  readonly requestReceipts: readonly (readonly [string, StoredApprovalIdempotencyReceipt])[];
  readonly decisionReceipts: readonly (readonly [string, StoredApprovalIdempotencyReceipt])[];
  readonly audits: readonly ApprovalAuditEvent[];
}

export interface RequestApprovalInput {
  readonly idempotencyKey: string;
  readonly requestedBy: string;
  readonly expiresAtMs: number;
  readonly actionCategory: ActionCategory;
  readonly actionType: string;
  readonly targetDeviceId?: string;
  readonly taskId?: string;
  readonly resource: string;
  readonly descriptor: ActionTargetDescriptor;
  readonly presentation: ApprovalPresentation;
  readonly execution: ApprovalExecution;
}

export type ApprovalOwnerDecision =
  | {
      readonly kind: "approve";
      readonly scope: ApprovalGrantScope;
    }
  | {
      readonly kind: "deny";
      readonly reason: string;
    };

export interface DecideApprovalInput {
  readonly approvalId: string;
  readonly idempotencyKey: string;
  readonly decidedBy: string;
  readonly decision: ApprovalOwnerDecision;
}

export interface ApprovalExecutionContext {
  readonly approval: ApprovalRequest;
  readonly grant: OwnerGrant;
  readonly operationId: string;
  /**
   * True only after a once-scoped grant was committed as consumed in the same
   * durable transition that recorded the Owner's decision.
   */
  readonly onceGrantConsumed: boolean;
}

export interface ApprovalExecutionPort {
  execute(input: ApprovalExecutionContext): Promise<ActionTargetValue | undefined>;
}

export interface ApprovalServiceOptions {
  readonly repository: ApprovalRepository;
  readonly executor: ApprovalExecutionPort;
  readonly clock: {
    now(): number;
  };
  readonly idSource: {
    nextId(): string;
  };
}

export type ApprovalServiceErrorCode =
  | "APPROVAL_INPUT_INVALID"
  | "APPROVAL_SECRET_VALUE_REJECTED"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_IDEMPOTENCY_CONFLICT"
  | "APPROVAL_DECISION_CONFLICT"
  | "APPROVAL_SCOPE_INVALID"
  | "APPROVAL_EXECUTION_FAILED"
  | "APPROVAL_DATA_CORRUPT";

export class ApprovalServiceError extends Error {
  readonly code: ApprovalServiceErrorCode;

  constructor(code: ApprovalServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalServiceError";
    this.code = code;
  }
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  #state = createEmptyApprovalRepositoryState();
  #writeTail: Promise<void> = Promise.resolve();

  async read<T>(operation: (state: ReadonlyApprovalRepositoryState) => T): Promise<T> {
    await this.#writeTail;
    return operation(this.#state);
  }

  async transact<T>(operation: (state: ApprovalRepositoryState) => T): Promise<T> {
    const previous = this.#writeTail;
    let release: () => void = () => undefined;
    this.#writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const working = importApprovalRepositorySnapshot(exportApprovalRepositorySnapshot(this.#state));
    try {
      const result = operation(working);
      this.#state = working;
      return result;
    } finally {
      release();
    }
  }
}

export class ApprovalService {
  readonly #repository: ApprovalRepository;
  readonly #executor: ApprovalExecutionPort;
  readonly #clock: ApprovalServiceOptions["clock"];
  readonly #idSource: ApprovalServiceOptions["idSource"];

  constructor(options: ApprovalServiceOptions) {
    if (
      options.repository === null ||
      typeof options.repository !== "object" ||
      typeof options.repository.read !== "function" ||
      typeof options.repository.transact !== "function" ||
      options.executor === null ||
      typeof options.executor !== "object" ||
      typeof options.executor.execute !== "function" ||
      typeof options.clock?.now !== "function" ||
      typeof options.idSource?.nextId !== "function"
    ) {
      throw new TypeError("A valid Approval Service composition is required.");
    }
    this.#repository = options.repository;
    this.#executor = options.executor;
    this.#clock = options.clock;
    this.#idSource = options.idSource;
  }

  async request(input: RequestApprovalInput): Promise<ApprovalRequest> {
    const now = requireTime(this.#clock.now(), "Approval request time");
    const normalized = normalizeRequestInput(input, now);
    const requestDigest = digestRequest(normalized);

    return this.#repository.transact((state) => {
      const receipt = state.requestReceipts.get(normalized.idempotencyKey);
      if (receipt !== undefined) {
        if (receipt.digest !== requestDigest) {
          throw new ApprovalServiceError(
            "APPROVAL_IDEMPOTENCY_CONFLICT",
            "The Approval request idempotency key was reused for different input.",
          );
        }
        return cloneRequest(requireRequest(state, receipt.approvalId));
      }

      const approvalId = requireIdentifier(this.#idSource.nextId(), "Approval ID");
      if (state.requests.has(approvalId)) {
        throw new ApprovalServiceError(
          "APPROVAL_INPUT_INVALID",
          "The generated Approval identifier was already used.",
        );
      }
      const actionFingerprint = createActionFingerprint(normalized.descriptor);
      const request: ApprovalRequest = {
        approvalId,
        requestedBy: normalized.requestedBy,
        requestedAtMs: now,
        expiresAtMs: normalized.expiresAtMs,
        actionCategory: normalized.actionCategory,
        actionType: normalized.actionType,
        actionFingerprint,
        actionDescriptor: cloneDescriptor(normalized.descriptor),
        ...(normalized.targetDeviceId === undefined
          ? {}
          : { targetDeviceId: normalized.targetDeviceId }),
        ...(normalized.taskId === undefined ? {} : { taskId: normalized.taskId }),
        resource: normalized.resource,
        presentation: clonePresentation(normalized.presentation),
        execution: cloneExecution(normalized.execution),
        state: "pending",
        executionStatus: "waiting",
        updatedAtMs: now,
      };
      state.requests.set(approvalId, request);
      state.requestReceipts.set(normalized.idempotencyKey, {
        digest: requestDigest,
        approvalId,
      });
      appendAudit(state, this.#idSource, {
        approvalId,
        event: "approval.requested",
        actor: normalized.requestedBy,
        occurredAtMs: now,
        actionFingerprint,
      });
      advanceRevision(state);
      return cloneRequest(request);
    });
  }

  async get(approvalId: string): Promise<ApprovalRequest> {
    const normalizedId = requireIdentifier(approvalId, "Approval ID");
    const now = requireTime(this.#clock.now(), "Approval observation time");
    return this.#repository.transact((state) => {
      const request = requireRequest(state, normalizedId);
      expireRequest(state, request, now, this.#idSource);
      return cloneRequest(request);
    });
  }

  async list(input: { readonly state?: ApprovalRequestState } = {}): Promise<ApprovalRequest[]> {
    if (
      input.state !== undefined &&
      !["pending", "approved", "denied", "expired"].includes(input.state)
    ) {
      throw new ApprovalServiceError("APPROVAL_INPUT_INVALID", "Unknown Approval state filter.");
    }
    const now = requireTime(this.#clock.now(), "Approval observation time");
    return this.#repository.transact((state) => {
      for (const request of state.requests.values()) {
        expireRequest(state, request, now, this.#idSource);
      }
      return [...state.requests.values()]
        .filter((request) => input.state === undefined || request.state === input.state)
        .sort(
          (left, right) =>
            right.requestedAtMs - left.requestedAtMs ||
            compareText(left.approvalId, right.approvalId),
        )
        .map(cloneRequest);
    });
  }

  audit(): Promise<readonly ApprovalAuditEvent[]> {
    return this.#repository.read((state) => state.audits.map(cloneAudit));
  }

  /**
   * Fences protected effects whose process disappeared after durably claiming
   * execution but before recording a terminal receipt. This must run once after
   * exclusive Main ownership is established and before the Approval surface
   * begins accepting decisions. Re-execution is intentionally forbidden because
   * the external side effect may already have happened.
   */
  async reconcileInterruptedExecutions(): Promise<number> {
    const now = requireTime(this.#clock.now(), "Approval reconciliation time");
    return await this.#repository.transact((state) => {
      let reconciled = 0;
      for (const request of state.requests.values()) {
        if (request.state !== "approved" || request.executionStatus !== "running") {
          continue;
        }
        request.executionStatus = "failed";
        request.executionErrorCode = "APPROVAL_EXECUTION_OUTCOME_UNKNOWN";
        request.updatedAtMs = now;
        appendAudit(state, this.#idSource, {
          approvalId: request.approvalId,
          event: "approval.execution-failed",
          actor: "opendelegate-startup",
          occurredAtMs: now,
          actionFingerprint: request.actionFingerprint,
        });
        reconciled += 1;
      }
      if (reconciled > 0) {
        advanceRevision(state);
      }
      return reconciled;
    });
  }

  async decide(input: DecideApprovalInput): Promise<ApprovalRequest> {
    const normalized = normalizeDecisionInput(input);
    const now = requireTime(this.#clock.now(), "Approval decision time");
    const decisionDigest = digestDecision(normalized);
    const claim = await this.#repository.transact((state) => {
      const request = requireRequest(state, normalized.approvalId);
      expireRequest(state, request, now, this.#idSource);

      const receipt = state.decisionReceipts.get(normalized.idempotencyKey);
      if (receipt !== undefined) {
        if (receipt.digest !== decisionDigest || receipt.approvalId !== request.approvalId) {
          throw new ApprovalServiceError(
            "APPROVAL_IDEMPOTENCY_CONFLICT",
            "The Approval decision idempotency key was reused for different input.",
          );
        }
        return {
          request: cloneRequest(request),
          // The durable decision receipt is also the execution claim. A replay
          // must observe the in-flight state, never start the executable effect
          // again. If the original process disappears, startup reconciliation
          // can report an unknown outcome; blindly re-executing a protected
          // action would be unsafe.
          execute: false,
        };
      }

      if (request.state === "expired") {
        throw new ApprovalServiceError(
          "APPROVAL_EXPIRED",
          "The Approval expired before the Owner decision.",
        );
      }
      if (request.state !== "pending") {
        throw new ApprovalServiceError(
          "APPROVAL_DECISION_CONFLICT",
          "The Approval already has a different completed decision.",
        );
      }

      if (normalized.decision.kind === "deny") {
        request.state = "denied";
        request.executionStatus = "skipped";
        request.decision = {
          kind: "deny",
          operationId: normalized.idempotencyKey,
          decidedBy: normalized.decidedBy,
          decidedAtMs: now,
          denialReason: normalized.decision.reason,
        };
        request.updatedAtMs = now;
        appendAudit(state, this.#idSource, {
          approvalId: request.approvalId,
          event: "approval.denied",
          actor: normalized.decidedBy,
          occurredAtMs: now,
          actionFingerprint: request.actionFingerprint,
        });
        state.decisionReceipts.set(normalized.idempotencyKey, {
          digest: decisionDigest,
          approvalId: request.approvalId,
        });
        advanceRevision(state);
        return { request: cloneRequest(request), execute: false };
      }

      const grant = createGrant(request, normalized.decision.scope);
      request.state = "approved";
      request.executionStatus = "running";
      request.decision = {
        kind: "approve",
        operationId: normalized.idempotencyKey,
        decidedBy: normalized.decidedBy,
        decidedAtMs: now,
        grant,
      };
      if (grant.scope.kind === "once") {
        request.onceGrantConsumedAtMs = now;
      }
      request.updatedAtMs = now;
      appendAudit(state, this.#idSource, {
        approvalId: request.approvalId,
        event: "approval.approved",
        actor: normalized.decidedBy,
        occurredAtMs: now,
        actionFingerprint: request.actionFingerprint,
      });
      if (grant.scope.kind === "once") {
        appendAudit(state, this.#idSource, {
          approvalId: request.approvalId,
          event: "approval.once-grant-consumed",
          actor: normalized.decidedBy,
          occurredAtMs: now,
          actionFingerprint: request.actionFingerprint,
        });
      }
      state.decisionReceipts.set(normalized.idempotencyKey, {
        digest: decisionDigest,
        approvalId: request.approvalId,
      });
      advanceRevision(state);
      return { request: cloneRequest(request), execute: true };
    });

    if (!claim.execute) {
      return claim.request;
    }
    const decision = claim.request.decision;
    if (decision?.kind !== "approve" || decision.grant === undefined) {
      throw corrupt("An executing Approval has no exact owner grant.");
    }
    if (
      createActionFingerprint(claim.request.actionDescriptor) !== claim.request.actionFingerprint
    ) {
      throw corrupt("The stored Approval action fingerprint does not match its descriptor.");
    }
    const executionNow = requireTime(this.#clock.now(), "Approval pre-execution policy time");
    if (executionNow >= decision.grant.expiresAt) {
      await this.#recordExecutionFailure(
        claim.request.approvalId,
        normalized.idempotencyKey,
        "APPROVAL_EXPIRED",
      );
      throw new ApprovalServiceError(
        "APPROVAL_EXPIRED",
        "The owner grant expired before executable enforcement.",
      );
    }

    let result: ActionTargetValue | undefined;
    try {
      result = await this.#executor.execute({
        approval: cloneRequest(claim.request),
        grant: cloneGrant(decision.grant),
        operationId: executionOperationId(claim.request.approvalId),
        onceGrantConsumed:
          decision.grant.scope.kind === "once" && claim.request.onceGrantConsumedAtMs !== undefined,
      });
      if (result !== undefined) {
        validatePublicValue(result, "$.executionResult");
      }
    } catch (error) {
      await this.#recordExecutionFailure(
        claim.request.approvalId,
        normalized.idempotencyKey,
        "APPROVAL_EXECUTION_FAILED",
      );
      throw new ApprovalServiceError(
        "APPROVAL_EXECUTION_FAILED",
        "The approved action could not be applied.",
        { cause: error },
      );
    }

    return this.#repository.transact((state) => {
      const request = requireRequest(state, claim.request.approvalId);
      if (
        request.state !== "approved" ||
        request.executionStatus !== "running" ||
        request.decision?.operationId !== normalized.idempotencyKey
      ) {
        throw corrupt("The Approval execution state changed unexpectedly.");
      }
      request.executionStatus = "succeeded";
      if (result !== undefined) {
        request.executionResult = cloneValue(result);
      }
      request.updatedAtMs = requireTime(this.#clock.now(), "Approval completion time");
      appendAudit(state, this.#idSource, {
        approvalId: request.approvalId,
        event: "approval.execution-succeeded",
        actor: normalized.decidedBy,
        occurredAtMs: request.updatedAtMs,
        actionFingerprint: request.actionFingerprint,
      });
      advanceRevision(state);
      return cloneRequest(request);
    });
  }

  async #recordExecutionFailure(
    approvalId: string,
    operationId: string,
    errorCode: "APPROVAL_EXECUTION_FAILED" | "APPROVAL_EXPIRED",
  ): Promise<void> {
    const now = requireTime(this.#clock.now(), "Approval failure time");
    await this.#repository.transact((state) => {
      const request = requireRequest(state, approvalId);
      if (
        request.state !== "approved" ||
        request.executionStatus !== "running" ||
        request.decision?.operationId !== operationId
      ) {
        throw corrupt("The Approval execution state changed unexpectedly.");
      }
      request.executionStatus = "failed";
      request.executionErrorCode = errorCode;
      request.updatedAtMs = now;
      appendAudit(state, this.#idSource, {
        approvalId: request.approvalId,
        event: "approval.execution-failed",
        actor: request.decision.decidedBy,
        occurredAtMs: now,
        actionFingerprint: request.actionFingerprint,
      });
      advanceRevision(state);
    });
  }
}

export function createEmptyApprovalRepositoryState(): ApprovalRepositoryState {
  return {
    revision: 0,
    requests: new Map(),
    requestReceipts: new Map(),
    decisionReceipts: new Map(),
    audits: [],
  };
}

export function exportApprovalRepositorySnapshot(
  state: ReadonlyApprovalRepositoryState,
): ApprovalRepositorySnapshotV1 {
  validateRepositoryState(state);
  return {
    schemaVersion: 1,
    revision: state.revision,
    requests: sortedEntries(state.requests).map(([id, request]) => [id, cloneRequest(request)]),
    requestReceipts: sortedEntries(state.requestReceipts).map(([id, receipt]) => [
      id,
      cloneReceipt(receipt),
    ]),
    decisionReceipts: sortedEntries(state.decisionReceipts).map(([id, receipt]) => [
      id,
      cloneReceipt(receipt),
    ]),
    audits: state.audits.map(cloneAudit),
  };
}

export function importApprovalRepositorySnapshot(value: unknown): ApprovalRepositoryState {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "schemaVersion",
        "revision",
        "requests",
        "requestReceipts",
        "decisionReceipts",
        "audits",
      ])
    ) {
      throw corrupt("The Approval repository snapshot has an invalid envelope.");
    }
    if (value["schemaVersion"] !== 1 || !isNonNegativeSafeInteger(value["revision"])) {
      throw corrupt("The Approval repository snapshot version is invalid.");
    }
    const state: ApprovalRepositoryState = {
      revision: value["revision"],
      requests: decodeMap(value["requests"], decodeRequest),
      requestReceipts: decodeMap(value["requestReceipts"], decodeReceipt),
      decisionReceipts: decodeMap(value["decisionReceipts"], decodeReceipt),
      audits: decodeArray(value["audits"], decodeAudit),
    };
    validateRepositoryState(state);
    return state;
  } catch (error) {
    if (error instanceof ApprovalServiceError && error.code === "APPROVAL_DATA_CORRUPT") {
      throw error;
    }
    throw corrupt("The Approval repository snapshot failed strict validation.", error);
  }
}

function normalizeRequestInput(input: RequestApprovalInput, now: number): RequestApprovalInput {
  if (!isRecord(input)) {
    throw invalid("Approval input must be an object.");
  }
  const idempotencyKey = requireSafeText(input.idempotencyKey, "Approval idempotency key", 500);
  const requestedBy = requireIdentifier(input.requestedBy, "Approval requester");
  const actionType = requireIdentifier(input.actionType, "Approval action type");
  const resource = requireSafeText(input.resource, "Approval resource", 1_024);
  const expiresAtMs = requireTime(input.expiresAtMs, "Approval expiration");
  if (expiresAtMs <= now) {
    throw invalid("Approval expiration must follow its request time.");
  }
  const descriptor = cloneDescriptor(input.descriptor);
  validatePublicValue(descriptor.target, "$.descriptor.target");
  const presentation = normalizePresentation(input.presentation);
  const execution = normalizeExecution(input.execution);
  return {
    idempotencyKey,
    requestedBy,
    expiresAtMs,
    actionCategory: requireActionCategory(input.actionCategory),
    actionType,
    ...(input.targetDeviceId === undefined
      ? {}
      : { targetDeviceId: requireIdentifier(input.targetDeviceId, "target Device ID") }),
    ...(input.taskId === undefined ? {} : { taskId: requireIdentifier(input.taskId, "Task ID") }),
    resource,
    descriptor,
    presentation,
    execution,
  };
}

function normalizeDecisionInput(input: DecideApprovalInput): DecideApprovalInput {
  if (!isRecord(input) || !isRecord(input.decision)) {
    throw invalid("Approval decision input must be an object.");
  }
  const common = {
    approvalId: requireIdentifier(input.approvalId, "Approval ID"),
    idempotencyKey: requireSafeText(input.idempotencyKey, "Approval decision idempotency key", 500),
    decidedBy: requireIdentifier(input.decidedBy, "Approval decision owner"),
  };
  if (input.decision.kind === "approve") {
    if (!["once", "task", "device", "policy"].includes(input.decision.scope)) {
      throw new ApprovalServiceError("APPROVAL_SCOPE_INVALID", "Unknown Approval grant scope.");
    }
    return {
      ...common,
      decision: {
        kind: "approve",
        scope: input.decision.scope,
      },
    };
  }
  if (input.decision.kind === "deny") {
    return {
      ...common,
      decision: {
        kind: "deny",
        reason: requireSafeText(input.decision.reason, "Approval denial reason", 2_000),
      },
    };
  }
  throw invalid("Unknown Approval decision.");
}

function normalizePresentation(value: ApprovalPresentation): ApprovalPresentation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["reason", "target", "risk", "evidence"]) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 64
  ) {
    throw invalid("Approval presentation is invalid.");
  }
  if (!["low", "medium", "high", "critical"].includes(value.risk)) {
    throw invalid("Approval risk is invalid.");
  }
  return {
    reason: requireSafeText(value.reason, "Approval reason", 4_096),
    target: requireSafeText(value.target, "Approval target", 1_024),
    risk: value.risk,
    evidence: value.evidence.map((item) => requireSafeText(item, "Approval evidence item", 2_048)),
  };
}

function normalizeExecution(value: ApprovalExecution): ApprovalExecution {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "payload"])) {
    throw invalid("Approval execution is invalid.");
  }
  const kind = requireIdentifier(value.kind, "Approval execution kind");
  validatePublicValue(value.payload, "$.execution.payload");
  return {
    kind,
    payload: cloneValue(value.payload),
  };
}

function createGrant(request: ApprovalRequest, scope: ApprovalGrantScope): OwnerGrant {
  const common = {
    grantId: request.approvalId,
    issuer: "owner" as const,
    actionCategory: request.actionCategory,
    expiresAt: request.expiresAtMs,
  };
  switch (scope) {
    case "once":
      return {
        ...common,
        scope: {
          kind: "once",
          requestId: request.approvalId,
          actionFingerprint: request.actionFingerprint,
        },
      };
    case "task":
      if (request.taskId === undefined) {
        throw new ApprovalServiceError(
          "APPROVAL_SCOPE_INVALID",
          "A Task-scoped grant requires an exact Task ID.",
        );
      }
      return {
        ...common,
        scope: {
          kind: "task",
          taskId: request.taskId,
          actionFingerprint: request.actionFingerprint,
        },
      };
    case "device":
      if (request.targetDeviceId === undefined) {
        throw new ApprovalServiceError(
          "APPROVAL_SCOPE_INVALID",
          "A Device-scoped grant requires an exact target Device ID.",
        );
      }
      return {
        ...common,
        scope: {
          kind: "device",
          deviceId: request.targetDeviceId,
          actionFingerprint: request.actionFingerprint,
        },
      };
    case "policy":
      return {
        ...common,
        scope: {
          kind: "policy",
          actionFingerprint: request.actionFingerprint,
        },
      };
  }
}

function expireRequest(
  state: ApprovalRepositoryState,
  request: ApprovalRequest,
  now: number,
  idSource: ApprovalServiceOptions["idSource"],
): void {
  if (request.state !== "pending" || now < request.expiresAtMs) {
    return;
  }
  request.state = "expired";
  request.executionStatus = "skipped";
  request.updatedAtMs = now;
  appendAudit(state, idSource, {
    approvalId: request.approvalId,
    event: "approval.expired",
    actor: "opendelegate-policy",
    occurredAtMs: now,
    actionFingerprint: request.actionFingerprint,
  });
  advanceRevision(state);
}

function appendAudit(
  state: ApprovalRepositoryState,
  idSource: ApprovalServiceOptions["idSource"],
  event: Omit<ApprovalAuditEvent, "auditId">,
): void {
  const auditId = requireIdentifier(idSource.nextId(), "Approval audit ID");
  if (state.audits.some((candidate) => candidate.auditId === auditId)) {
    throw invalid("The generated Approval audit identifier was already used.");
  }
  state.audits.push({
    auditId,
    ...event,
  });
}

function validateRepositoryState(state: ReadonlyApprovalRepositoryState): void {
  if (!isNonNegativeSafeInteger(state.revision)) {
    throw corrupt("The Approval repository revision is invalid.");
  }
  const approvalIds = new Set<string>();
  for (const [id, request] of state.requests) {
    if (id !== request.approvalId || approvalIds.has(id)) {
      throw corrupt("The Approval repository request map is invalid.");
    }
    approvalIds.add(id);
    validateRequest(request);
  }
  validateReceipts(state.requestReceipts, state.requests);
  validateReceipts(state.decisionReceipts, state.requests);
  const auditIds = new Set<string>();
  for (const audit of state.audits) {
    const normalized = decodeAudit(audit);
    if (
      auditIds.has(normalized.auditId) ||
      !approvalIds.has(normalized.approvalId) ||
      state.requests.get(normalized.approvalId)?.actionFingerprint !== normalized.actionFingerprint
    ) {
      throw corrupt("The Approval audit history is invalid.");
    }
    auditIds.add(normalized.auditId);
  }
  validateRepositoryRelationships(state);
}

function validateRepositoryRelationships(state: ReadonlyApprovalRepositoryState): void {
  const requestReceiptCounts = countReceiptTargets(state.requestReceipts);
  const decisionReceiptCounts = countReceiptTargets(state.decisionReceipts);
  for (const request of state.requests.values()) {
    if (requestReceiptCounts.get(request.approvalId) !== 1) {
      throw corrupt("Every Approval must have exactly one request idempotency receipt.");
    }
    const expectedDecisionReceipts =
      request.state === "approved" || request.state === "denied" ? 1 : 0;
    if ((decisionReceiptCounts.get(request.approvalId) ?? 0) !== expectedDecisionReceipts) {
      throw corrupt("Approval decision receipts do not match the durable request state.");
    }
    if (
      request.decision !== undefined &&
      state.decisionReceipts.get(request.decision.operationId)?.approvalId !== request.approvalId
    ) {
      throw corrupt("The Approval decision operation is not bound to its receipt.");
    }
    validateAuditHistory(
      request,
      state.audits.filter((event) => event.approvalId === request.approvalId),
    );
  }
}

function countReceiptTargets(
  receipts: ReadonlyMap<string, StoredApprovalIdempotencyReceipt>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const receipt of receipts.values()) {
    counts.set(receipt.approvalId, (counts.get(receipt.approvalId) ?? 0) + 1);
  }
  return counts;
}

function validateAuditHistory(
  request: ApprovalRequest,
  events: readonly ApprovalAuditEvent[],
): void {
  const count = (type: ApprovalAuditEvent["event"]): number =>
    events.filter((event) => event.event === type).length;
  if (count("approval.requested") !== 1) {
    throw corrupt("Every Approval must have one request audit event.");
  }
  const allowed = new Set<ApprovalAuditEvent["event"]>(["approval.requested"]);
  switch (request.state) {
    case "pending":
      break;
    case "expired":
      allowed.add("approval.expired");
      if (count("approval.expired") !== 1) {
        throw corrupt("An expired Approval must have one expiration audit event.");
      }
      break;
    case "denied":
      allowed.add("approval.denied");
      if (count("approval.denied") !== 1) {
        throw corrupt("A denied Approval must have one denial audit event.");
      }
      break;
    case "approved":
      allowed.add("approval.approved");
      if (count("approval.approved") !== 1) {
        throw corrupt("An approved Approval must have one approval audit event.");
      }
      if (request.decision?.grant?.scope.kind === "once") {
        allowed.add("approval.once-grant-consumed");
        if (count("approval.once-grant-consumed") !== 1) {
          throw corrupt("A once Approval must have one consumption audit event.");
        }
      }
      if (request.executionStatus === "succeeded") {
        allowed.add("approval.execution-succeeded");
        if (count("approval.execution-succeeded") !== 1) {
          throw corrupt("A succeeded Approval must have one success audit event.");
        }
      }
      if (request.executionStatus === "failed") {
        allowed.add("approval.execution-failed");
        if (count("approval.execution-failed") !== 1) {
          throw corrupt("A failed Approval must have one failure audit event.");
        }
      }
      break;
  }
  if (events.some((event) => !allowed.has(event.event))) {
    throw corrupt("The Approval audit history contains an impossible transition.");
  }
  if (
    events.some(
      (event) =>
        event.occurredAtMs < request.requestedAtMs || event.occurredAtMs > request.updatedAtMs,
    )
  ) {
    throw corrupt("The Approval audit history contains an invalid timestamp.");
  }
}

function validateRequest(request: ApprovalRequest): void {
  if (
    !isRecord(request) ||
    !hasRequiredAndAllowedKeys(
      request,
      [
        "approvalId",
        "requestedBy",
        "requestedAtMs",
        "expiresAtMs",
        "actionCategory",
        "actionType",
        "actionFingerprint",
        "actionDescriptor",
        "resource",
        "presentation",
        "execution",
        "state",
        "executionStatus",
        "updatedAtMs",
      ],
      [
        "targetDeviceId",
        "taskId",
        "decision",
        "onceGrantConsumedAtMs",
        "executionResult",
        "executionErrorCode",
      ],
    )
  ) {
    throw corrupt("The Approval request shape is invalid.");
  }
  requireIdentifier(request.approvalId, "Approval ID");
  requireIdentifier(request.requestedBy, "Approval requester");
  requireTime(request.requestedAtMs, "Approval request time");
  requireTime(request.expiresAtMs, "Approval expiration");
  if (request.expiresAtMs <= request.requestedAtMs) {
    throw corrupt("The Approval deadline is invalid.");
  }
  requireActionCategory(request.actionCategory);
  requireIdentifier(request.actionType, "Approval action type");
  requireSafeText(request.resource, "Approval resource", 1_024);
  if (
    request.targetDeviceId !== undefined
      ? requireIdentifier(request.targetDeviceId, "target Device ID") === ""
      : false
  ) {
    throw corrupt("The target Device ID is invalid.");
  }
  if (request.taskId !== undefined ? requireIdentifier(request.taskId, "Task ID") === "" : false) {
    throw corrupt("The Task ID is invalid.");
  }
  const normalizedDescriptor = cloneDescriptor(request.actionDescriptor);
  if (
    !isActionFingerprint(request.actionFingerprint) ||
    createActionFingerprint(normalizedDescriptor) !== request.actionFingerprint
  ) {
    throw corrupt("The Approval action fingerprint is invalid.");
  }
  normalizePresentation(request.presentation);
  normalizeExecution(request.execution);
  if (!["pending", "approved", "denied", "expired"].includes(request.state)) {
    throw corrupt("The Approval state is invalid.");
  }
  if (!["waiting", "running", "succeeded", "failed", "skipped"].includes(request.executionStatus)) {
    throw corrupt("The Approval execution state is invalid.");
  }
  requireTime(request.updatedAtMs, "Approval update time");
  if (request.updatedAtMs < request.requestedAtMs) {
    throw corrupt("The Approval update time is invalid.");
  }
  if (request.onceGrantConsumedAtMs !== undefined) {
    requireTime(request.onceGrantConsumedAtMs, "Once-grant consumption time");
  }
  if (request.executionResult !== undefined) {
    validatePublicValue(request.executionResult, "$.executionResult");
  }
  if (request.executionErrorCode !== undefined) {
    requireErrorCode(request.executionErrorCode);
  }
  if (request.decision !== undefined) {
    decodeDecision(request.decision);
  }
  validateRequestRelationships(request);
}

function validateRequestRelationships(request: ApprovalRequest): void {
  const hasResult = request.executionResult !== undefined;
  const hasError = request.executionErrorCode !== undefined;
  const hasConsumption = request.onceGrantConsumedAtMs !== undefined;
  switch (request.state) {
    case "pending":
      if (
        request.executionStatus !== "waiting" ||
        request.decision !== undefined ||
        hasConsumption ||
        hasResult ||
        hasError
      ) {
        throw corrupt("A pending Approval contains completed decision state.");
      }
      return;
    case "expired":
      if (
        request.executionStatus !== "skipped" ||
        request.decision !== undefined ||
        hasConsumption ||
        hasResult ||
        hasError
      ) {
        throw corrupt("An expired Approval contains executable decision state.");
      }
      return;
    case "denied":
      if (
        request.executionStatus !== "skipped" ||
        request.decision?.kind !== "deny" ||
        hasConsumption ||
        hasResult ||
        hasError
      ) {
        throw corrupt("A denied Approval contains invalid execution state.");
      }
      validateDecisionTime(request, request.decision);
      return;
    case "approved":
      break;
  }

  if (
    request.decision?.kind !== "approve" ||
    request.decision.grant === undefined ||
    !["running", "succeeded", "failed"].includes(request.executionStatus)
  ) {
    throw corrupt("An approved Approval is missing its exact owner grant.");
  }
  validateDecisionTime(request, request.decision);
  validateGrantMatchesRequest(request, request.decision.grant);
  const once = request.decision.grant.scope.kind === "once";
  if (once !== hasConsumption) {
    throw corrupt("Once-grant consumption state does not match the approved scope.");
  }
  if (
    request.onceGrantConsumedAtMs !== undefined &&
    (request.onceGrantConsumedAtMs < request.decision.decidedAtMs ||
      request.onceGrantConsumedAtMs > request.updatedAtMs)
  ) {
    throw corrupt("Once-grant consumption has an invalid timestamp.");
  }
  if (
    (request.executionStatus === "running" && (hasResult || hasError)) ||
    (request.executionStatus === "succeeded" && hasError) ||
    (request.executionStatus === "failed" && (!hasError || hasResult))
  ) {
    throw corrupt("The approved action result does not match its execution state.");
  }
}

function validateDecisionTime(request: ApprovalRequest, decision: ApprovalDecision): void {
  if (
    decision.decidedAtMs < request.requestedAtMs ||
    decision.decidedAtMs >= request.expiresAtMs ||
    decision.decidedAtMs > request.updatedAtMs
  ) {
    throw corrupt("The Approval decision timestamp is outside its durable lifetime.");
  }
}

function validateGrantMatchesRequest(request: ApprovalRequest, grant: OwnerGrant): void {
  if (
    grant.grantId !== request.approvalId ||
    grant.issuer !== "owner" ||
    grant.actionCategory !== request.actionCategory ||
    grant.expiresAt !== request.expiresAtMs ||
    grant.scope.actionFingerprint !== request.actionFingerprint
  ) {
    throw corrupt("The owner grant does not match its approved action.");
  }
  switch (grant.scope.kind) {
    case "once":
      if (grant.scope.requestId !== request.approvalId) {
        throw corrupt("The once grant does not match its Approval request.");
      }
      return;
    case "task":
      if (request.taskId === undefined || grant.scope.taskId !== request.taskId) {
        throw corrupt("The Task grant does not match its Approval request.");
      }
      return;
    case "device":
      if (request.targetDeviceId === undefined || grant.scope.deviceId !== request.targetDeviceId) {
        throw corrupt("The Device grant does not match its Approval request.");
      }
      return;
    case "policy":
      return;
  }
}

function validateReceipts(
  receipts: ReadonlyMap<string, StoredApprovalIdempotencyReceipt>,
  requests: ReadonlyMap<string, ApprovalRequest>,
): void {
  for (const [key, receipt] of receipts) {
    requireSafeText(key, "Approval idempotency key", 500);
    if (!isActionFingerprint(receipt.digest) || !requests.has(receipt.approvalId)) {
      throw corrupt("An Approval idempotency receipt is invalid.");
    }
  }
}

function digestRequest(input: RequestApprovalInput): ActionFingerprint {
  return createActionFingerprint({
    kind: "approval",
    operation: "request",
    target: cloneValue(input as unknown as ActionTargetValue),
  });
}

function digestDecision(input: DecideApprovalInput): ActionFingerprint {
  return createActionFingerprint({
    kind: "approval",
    operation: "decide",
    target: cloneValue(input as unknown as ActionTargetValue),
  });
}

function executionOperationId(approvalId: string): string {
  return `approval:${approvalId}:execute`;
}

function requireRequest(state: ReadonlyApprovalRepositoryState, id: string): ApprovalRequest {
  const request = state.requests.get(id);
  if (request === undefined) {
    throw new ApprovalServiceError("APPROVAL_NOT_FOUND", "The Approval does not exist.");
  }
  return request;
}

function requireActionCategory(value: unknown): ActionCategory {
  const categories: readonly ActionCategory[] = [
    "read-only-observation",
    "opendelegate-process-retry",
    "opendelegate-process-restart",
    "project-dependency-install",
    "configured-official-package-install",
    "computer-use-input",
    "sandbox-boundary-escalation",
    "package-repository-addition",
    "remote-installer-script",
    "untrusted-installer",
    "driver-installation",
    "kernel-extension-installation",
    "os-network-change",
    "vpn-change",
    "firewall-change",
    "policy-relaxation",
    "secret-export",
    "cross-device-knowledge-transfer",
    "policy-bypass-attempt",
  ];
  if (typeof value !== "string" || !categories.includes(value as ActionCategory)) {
    throw invalid("The Approval action category is invalid.");
  }
  return value as ActionCategory;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function requireSafeText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    hasControl(value)
  ) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function requireTime(value: unknown, label: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function requireErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,159}$/u.test(value)) {
    throw corrupt("The Approval execution error code is invalid.");
  }
  return value;
}

function validatePublicValue(
  value: unknown,
  path: string,
  active = new WeakSet<object>(),
  depth = 0,
): asserts value is ActionTargetValue {
  if (depth > 32) {
    throw invalid("Approval public data is too deeply nested.");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && (value.length > 32_768 || hasControl(value))) {
      throw invalid(`${path} contains invalid text.`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalid(`${path} contains a non-finite number.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw invalid(`${path} contains a non-public value.`);
  }
  if (active.has(value)) {
    throw invalid(`${path} contains a cycle.`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 1_024) {
        throw invalid(`${path} contains too many items.`);
      }
      value.forEach((item, index) =>
        validatePublicValue(item, `${path}[${String(index)}]`, active, depth + 1),
      );
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalid(`${path} must contain only plain objects.`);
    }
    const entries = Object.entries(value);
    if (entries.length > 1_024) {
      throw invalid(`${path} contains too many fields.`);
    }
    for (const [key, item] of entries) {
      if (isSecretValueKey(key)) {
        throw new ApprovalServiceError(
          "APPROVAL_SECRET_VALUE_REJECTED",
          "Approval records cannot contain Secret values.",
        );
      }
      validatePublicValue(item, `${path}.${key}`, active, depth + 1);
    }
  } finally {
    active.delete(value);
  }
}

function isSecretValueKey(key: string): boolean {
  const canonical = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  if (canonical.endsWith("secretref") || canonical.endsWith("secretreference")) {
    return false;
  }
  return (
    canonical.includes("password") ||
    canonical.includes("passphrase") ||
    canonical === "token" ||
    canonical.endsWith("token") ||
    canonical.includes("accesstoken") ||
    canonical.includes("refreshtoken") ||
    canonical.includes("authtoken") ||
    canonical.includes("bearertoken") ||
    canonical.includes("apitoken") ||
    canonical.includes("privatekey") ||
    canonical.includes("secretkey") ||
    canonical === "apikey" ||
    canonical.endsWith("apikey") ||
    canonical.includes("credential") ||
    canonical.includes("authorization") ||
    canonical.endsWith("cookie") ||
    canonical === "secret" ||
    canonical.endsWith("secret") ||
    canonical.endsWith("secretvalue")
  );
}

function cloneRequest(request: ApprovalRequest): ApprovalRequest {
  return structuredClone(request);
}

function clonePresentation(value: ApprovalPresentation): ApprovalPresentation {
  return {
    reason: value.reason,
    target: value.target,
    risk: value.risk,
    evidence: [...value.evidence],
  };
}

function cloneExecution(value: ApprovalExecution): ApprovalExecution {
  return {
    kind: value.kind,
    payload: cloneValue(value.payload),
  };
}

function cloneDescriptor(value: ActionTargetDescriptor): ActionTargetDescriptor {
  try {
    if (
      !isRecord(value) ||
      !hasRequiredAndAllowedKeys(value, ["kind", "operation", "target"], ["command"])
    ) {
      throw new TypeError("The action descriptor shape is invalid.");
    }
    const target = structuredClone(value.target);
    validatePublicValue(target, "$.descriptor.target");
    let command: ActionTargetDescriptor["command"];
    if (value.command !== undefined) {
      if (
        !isRecord(value.command) ||
        !hasExactKeys(value.command, ["executable", "arguments"]) ||
        !Array.isArray(value.command.arguments) ||
        value.command.arguments.length > 1_024
      ) {
        throw new TypeError("The action command descriptor shape is invalid.");
      }
      command = {
        executable: requireSafeText(value.command.executable, "Approval command executable", 1_024),
        arguments: value.command.arguments.map((argument) =>
          requireSafeText(argument, "Approval command argument", 32_768),
        ),
      };
    }
    const normalized: ActionTargetDescriptor = {
      kind: requireIdentifier(value.kind, "Approval descriptor kind"),
      operation: requireIdentifier(value.operation, "Approval descriptor operation"),
      target,
      ...(command === undefined ? {} : { command }),
    };
    createActionFingerprint(normalized);
    return normalized;
  } catch (error) {
    if (error instanceof ApprovalServiceError) {
      throw error;
    }
    throw invalid("The Approval action descriptor is invalid.", error);
  }
}

function cloneGrant(value: OwnerGrant): OwnerGrant {
  return structuredClone(value);
}

function cloneReceipt(receipt: StoredApprovalIdempotencyReceipt): StoredApprovalIdempotencyReceipt {
  return { ...receipt };
}

function cloneAudit(event: ApprovalAuditEvent): ApprovalAuditEvent {
  return { ...event };
}

function cloneValue<TValue extends ActionTargetValue>(value: TValue): TValue {
  return structuredClone(value);
}

function advanceRevision(state: ApprovalRepositoryState): void {
  if (!Number.isSafeInteger(state.revision + 1)) {
    throw corrupt("The Approval repository revision overflowed.");
  }
  state.revision += 1;
}

function sortedEntries<TValue>(
  values: ReadonlyMap<string, TValue>,
): readonly (readonly [string, TValue])[] {
  return [...values.entries()].sort(([left], [right]) => compareText(left, right));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodeMap<TValue>(
  value: unknown,
  decoder: (value: unknown) => TValue,
): Map<string, TValue> {
  if (!Array.isArray(value) || value.length > 100_000) {
    throw corrupt("An Approval repository collection is invalid.");
  }
  const result = new Map<string, TValue>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw corrupt("An Approval repository map entry is invalid.");
    }
    const key = requireSafeText(entry[0], "Approval repository map key", 500);
    if (result.has(key)) {
      throw corrupt("An Approval repository map repeats a key.");
    }
    result.set(key, decoder(entry[1]));
  }
  return result;
}

function decodeArray<TValue>(value: unknown, decoder: (value: unknown) => TValue): TValue[] {
  if (!Array.isArray(value) || value.length > 100_000) {
    throw corrupt("An Approval repository list is invalid.");
  }
  return value.map(decoder);
}

function decodeRequest(value: unknown): ApprovalRequest {
  if (!isRecord(value)) {
    throw corrupt("An Approval record is invalid.");
  }
  const request = structuredClone(value) as unknown as ApprovalRequest;
  validateRequest(request);
  return request;
}

function decodeReceipt(value: unknown): StoredApprovalIdempotencyReceipt {
  if (!isRecord(value) || !hasExactKeys(value, ["digest", "approvalId"])) {
    throw corrupt("An Approval idempotency receipt is invalid.");
  }
  if (!isActionFingerprint(value["digest"])) {
    throw corrupt("An Approval idempotency digest is invalid.");
  }
  return {
    digest: value["digest"],
    approvalId: requireIdentifier(value["approvalId"], "Approval receipt ID"),
  };
}

function decodeDecision(value: unknown): ApprovalDecision {
  if (!isRecord(value)) {
    throw corrupt("An Approval decision is invalid.");
  }
  const kind = value["kind"];
  const expectedKeys =
    kind === "deny"
      ? ["kind", "operationId", "decidedBy", "decidedAtMs", "denialReason"]
      : kind === "approve"
        ? ["kind", "operationId", "decidedBy", "decidedAtMs", "grant"]
        : [];
  if (expectedKeys.length === 0 || !hasExactKeys(value, expectedKeys)) {
    throw corrupt("An Approval decision shape is invalid.");
  }
  const common = {
    operationId: requireSafeText(value["operationId"], "Approval decision operation", 500),
    decidedBy: requireIdentifier(value["decidedBy"], "Approval decision owner"),
    decidedAtMs: requireTime(value["decidedAtMs"], "Approval decision time"),
  };
  if (kind === "deny") {
    return {
      kind,
      ...common,
      denialReason: requireSafeText(value["denialReason"], "Approval denial reason", 2_000),
    };
  }
  if (kind === "approve") {
    return {
      kind,
      ...common,
      grant: decodeGrant(value["grant"]),
    };
  }
  throw corrupt("An Approval decision kind is invalid.");
}

function decodeGrant(value: unknown): OwnerGrant {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["grantId", "issuer", "actionCategory", "expiresAt", "scope"]) ||
    !isRecord(value["scope"])
  ) {
    throw corrupt("An Approval owner grant is invalid.");
  }
  const scope = value["scope"];
  if (!isActionFingerprint(scope["actionFingerprint"])) {
    throw corrupt("An Approval owner grant fingerprint is invalid.");
  }
  const common = {
    grantId: requireIdentifier(value["grantId"], "Approval grant ID"),
    issuer: value["issuer"],
    actionCategory: requireActionCategory(value["actionCategory"]),
    expiresAt: requireTime(value["expiresAt"], "Approval grant expiration"),
  };
  if (common.issuer !== "owner") {
    throw corrupt("An Approval grant issuer is invalid.");
  }
  switch (scope["kind"]) {
    case "once":
      if (!hasExactKeys(scope, ["kind", "requestId", "actionFingerprint"])) {
        throw corrupt("An Approval once grant shape is invalid.");
      }
      return {
        ...common,
        issuer: "owner",
        scope: {
          kind: "once",
          requestId: requireIdentifier(scope["requestId"], "Approval grant request ID"),
          actionFingerprint: scope["actionFingerprint"],
        },
      };
    case "task":
      if (!hasExactKeys(scope, ["kind", "taskId", "actionFingerprint"])) {
        throw corrupt("An Approval Task grant shape is invalid.");
      }
      return {
        ...common,
        issuer: "owner",
        scope: {
          kind: "task",
          taskId: requireIdentifier(scope["taskId"], "Approval grant Task ID"),
          actionFingerprint: scope["actionFingerprint"],
        },
      };
    case "device":
      if (!hasExactKeys(scope, ["kind", "deviceId", "actionFingerprint"])) {
        throw corrupt("An Approval Device grant shape is invalid.");
      }
      return {
        ...common,
        issuer: "owner",
        scope: {
          kind: "device",
          deviceId: requireIdentifier(scope["deviceId"], "Approval grant Device ID"),
          actionFingerprint: scope["actionFingerprint"],
        },
      };
    case "policy":
      if (!hasExactKeys(scope, ["kind", "actionFingerprint"])) {
        throw corrupt("An Approval Policy grant shape is invalid.");
      }
      return {
        ...common,
        issuer: "owner",
        scope: {
          kind: "policy",
          actionFingerprint: scope["actionFingerprint"],
        },
      };
    default:
      throw corrupt("An Approval grant scope is invalid.");
  }
}

function decodeAudit(value: unknown): ApprovalAuditEvent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "auditId",
      "approvalId",
      "event",
      "actor",
      "occurredAtMs",
      "actionFingerprint",
    ])
  ) {
    throw corrupt("An Approval audit event is invalid.");
  }
  const events: readonly ApprovalAuditEvent["event"][] = [
    "approval.requested",
    "approval.approved",
    "approval.denied",
    "approval.expired",
    "approval.once-grant-consumed",
    "approval.execution-succeeded",
    "approval.execution-failed",
  ];
  if (
    typeof value["event"] !== "string" ||
    !events.includes(value["event"] as ApprovalAuditEvent["event"]) ||
    !isActionFingerprint(value["actionFingerprint"])
  ) {
    throw corrupt("An Approval audit event is invalid.");
  }
  return {
    auditId: requireIdentifier(value["auditId"], "Approval audit ID"),
    approvalId: requireIdentifier(value["approvalId"], "Approval audit request ID"),
    event: value["event"] as ApprovalAuditEvent["event"],
    actor: requireIdentifier(value["actor"], "Approval audit actor"),
    occurredAtMs: requireTime(value["occurredAtMs"], "Approval audit time"),
    actionFingerprint: value["actionFingerprint"],
  };
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function invalid(message: string, cause?: unknown): ApprovalServiceError {
  return new ApprovalServiceError(
    "APPROVAL_INPUT_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function corrupt(message: string, cause?: unknown): ApprovalServiceError {
  return new ApprovalServiceError(
    "APPROVAL_DATA_CORRUPT",
    message,
    cause === undefined ? undefined : { cause },
  );
}
