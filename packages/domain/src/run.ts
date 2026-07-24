import { DomainError } from "./domain-error.ts";
import type { RunId, TaskId, WorkOrderId } from "./identifiers.ts";

export type RunState =
  | "created"
  | "queued"
  | "dispatched"
  | "claimed"
  | "running"
  | "blocked"
  | "waiting-for-approval"
  | "succeeded"
  | "failed"
  | "lost"
  | "cancelled";

export interface CreateRun {
  readonly id: RunId;
  readonly taskId: TaskId;
  readonly workOrderId: WorkOrderId;
  readonly previousRunId?: RunId;
  readonly attempt?: number;
}

export interface RunDispatch {
  readonly workerId: string;
  readonly idempotencyKey: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly dispatchedAtMs: number;
  readonly expiresAtMs: number;
}

export interface RunClaim {
  readonly workerId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly observedAtMs: number;
}

export interface ClaimRun {
  readonly workerId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly claimedAtMs: number;
}

export interface ResumeRunAfterApproval extends RunClaim {
  readonly approvalId: string;
}

export interface RunClaimSnapshot {
  readonly workerId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly claimedAtMs: number;
  readonly expiresAtMs: number;
}

export interface RunSnapshot {
  readonly id: string;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly state: RunState;
  readonly attempt: number;
  readonly previousRunId?: string;
  readonly dispatch?: RunDispatch;
  readonly claim?: RunClaimSnapshot;
  readonly pendingApprovalId?: string;
  readonly blockedReason?: string;
  readonly failureReason?: string;
  readonly lostReason?: string;
  readonly cancellationReason?: string;
}

export class Run {
  public readonly id: RunId;
  public readonly taskId: TaskId;
  public readonly workOrderId: WorkOrderId;
  public readonly attempt: number;
  public readonly previousRunId: RunId | undefined;
  private currentState: RunState = "created";
  private currentDispatch: RunDispatch | undefined;
  private currentClaim: RunClaimSnapshot | undefined;
  private currentApprovalId: string | undefined;
  private currentBlockedReason: string | undefined;
  private currentFailureReason: string | undefined;
  private currentLostReason: string | undefined;
  private currentCancellationReason: string | undefined;

  private constructor(input: CreateRun) {
    this.id = input.id;
    this.taskId = input.taskId;
    this.workOrderId = input.workOrderId;
    this.previousRunId = input.previousRunId;
    this.attempt = input.attempt ?? 1;
  }

  public static create(input: CreateRun): Run {
    return new Run(input);
  }

  public get state(): RunState {
    return this.currentState;
  }

  public get dispatchSnapshot(): RunDispatch | undefined {
    return this.currentDispatch;
  }

  public get claimSnapshot(): RunClaimSnapshot | undefined {
    return this.currentClaim;
  }

  public get pendingApprovalId(): string | undefined {
    return this.currentApprovalId;
  }

  public get blockedReason(): string | undefined {
    return this.currentBlockedReason;
  }

  public get failureReason(): string | undefined {
    return this.currentFailureReason;
  }

  public get lostReason(): string | undefined {
    return this.currentLostReason;
  }

  public get cancellationReason(): string | undefined {
    return this.currentCancellationReason;
  }

  public get snapshot(): RunSnapshot {
    return Object.freeze({
      id: this.id.value,
      taskId: this.taskId.value,
      workOrderId: this.workOrderId.value,
      state: this.currentState,
      attempt: this.attempt,
      ...(this.previousRunId === undefined ? {} : { previousRunId: this.previousRunId.value }),
      ...(this.currentDispatch === undefined ? {} : { dispatch: this.currentDispatch }),
      ...(this.currentClaim === undefined ? {} : { claim: this.currentClaim }),
      ...(this.currentApprovalId === undefined
        ? {}
        : { pendingApprovalId: this.currentApprovalId }),
      ...(this.currentBlockedReason === undefined
        ? {}
        : { blockedReason: this.currentBlockedReason }),
      ...(this.currentFailureReason === undefined
        ? {}
        : { failureReason: this.currentFailureReason }),
      ...(this.currentLostReason === undefined ? {} : { lostReason: this.currentLostReason }),
      ...(this.currentCancellationReason === undefined
        ? {}
        : { cancellationReason: this.currentCancellationReason }),
    });
  }

  public queue(): void {
    if (this.currentState === "queued") {
      return;
    }
    this.requireState("created");
    this.currentState = "queued";
  }

  public dispatch(dispatch: RunDispatch): void {
    validateDispatch(dispatch);
    if (this.currentDispatch?.idempotencyKey === dispatch.idempotencyKey) {
      if (sameDispatch(this.currentDispatch, dispatch)) {
        return;
      }
      throw new DomainError(
        "RUN_DISPATCH_CONFLICT",
        `Dispatch idempotency key ${dispatch.idempotencyKey} was reused with different input.`,
      );
    }
    this.requireOneOfStates(["created", "queued"]);
    this.currentDispatch = freezeDispatch(dispatch);
    this.currentState = "dispatched";
  }

  public claim(claim: ClaimRun): void {
    const dispatch = this.currentDispatch;
    if (dispatch !== undefined) {
      this.assertClaimMatchesDispatch(claim, dispatch);
    }

    if (
      this.currentClaim !== undefined &&
      dispatch !== undefined &&
      sameClaim(this.currentClaim, claim, dispatch)
    ) {
      return;
    }
    this.requireState("dispatched");
    if (dispatch === undefined) {
      throw new DomainError("RUN_ASSIGNMENT_INVALID", "The Run has no leased dispatch.");
    }
    this.assertClaimMatchesDispatch(claim, dispatch);
    this.currentClaim = Object.freeze({
      workerId: claim.workerId,
      leaseId: claim.leaseId,
      fencingToken: claim.fencingToken,
      claimedAtMs: claim.claimedAtMs,
      expiresAtMs: dispatch.expiresAtMs,
    });
    this.currentState = "claimed";
  }

  private assertClaimMatchesDispatch(claim: ClaimRun, dispatch: RunDispatch): void {
    if (!Number.isSafeInteger(claim.claimedAtMs) || claim.claimedAtMs < dispatch.dispatchedAtMs) {
      throw new DomainError(
        "RUN_ASSIGNMENT_INVALID",
        "A Run claim must use a finite time at or after dispatch.",
      );
    }
    if (claim.claimedAtMs >= dispatch.expiresAtMs) {
      throw new DomainError("RUN_LEASE_EXPIRED", "The Run dispatch lease has expired.");
    }
    if (claim.workerId !== dispatch.workerId) {
      throw new DomainError(
        "RUN_WORKER_MISMATCH",
        `Worker ${claim.workerId} is not the dispatched Worker for this Run.`,
      );
    }
    if (claim.leaseId !== dispatch.leaseId) {
      throw new DomainError(
        "RUN_LEASE_MISMATCH",
        `Lease ${claim.leaseId} is not current for this Run.`,
      );
    }
    if (claim.fencingToken !== dispatch.fencingToken) {
      throw new DomainError(
        "RUN_FENCE_STALE",
        `Fencing token ${claim.fencingToken} is not current for this Run.`,
      );
    }
  }

  public start(claim: RunClaim): void {
    this.requireState("claimed");
    this.assertCurrentClaim(claim);
    this.currentState = "running";
  }

  public succeed(claim: RunClaim): void {
    this.requireState("running");
    this.assertCurrentClaim(claim);
    this.currentState = "succeeded";
  }

  public block(claim: RunClaim, reason: string): void {
    this.requireState("running");
    this.assertCurrentClaim(claim);
    this.currentBlockedReason = reason;
    this.currentState = "blocked";
  }

  public resume(claim: RunClaim): void {
    this.requireState("blocked");
    this.assertCurrentClaim(claim);
    this.currentBlockedReason = undefined;
    this.currentState = "running";
  }

  public fail(claim: RunClaim, reason: string): void {
    this.requireOneOfStates(["claimed", "running", "blocked", "waiting-for-approval"]);
    this.assertCurrentClaim(claim);
    this.currentApprovalId = undefined;
    this.currentBlockedReason = undefined;
    this.currentFailureReason = reason;
    this.currentState = "failed";
  }

  public markLost(reason: string): void {
    if (this.currentState === "lost") {
      return;
    }
    if (isTerminal(this.currentState)) {
      throw new DomainError(
        "RUN_TRANSITION_INVALID",
        `A ${this.currentState} Run cannot become lost.`,
      );
    }
    this.currentApprovalId = undefined;
    this.currentBlockedReason = undefined;
    this.currentLostReason = reason;
    this.currentState = "lost";
  }

  public waitForApproval(claim: RunClaim, approvalId: string): void {
    this.requireState("running");
    this.assertCurrentClaim(claim);
    this.currentApprovalId = approvalId;
    this.currentState = "waiting-for-approval";
  }

  public resumeAfterApproval(input: ResumeRunAfterApproval): void {
    this.requireState("waiting-for-approval");
    this.assertCurrentClaim(input);

    if (input.approvalId !== this.currentApprovalId) {
      throw new DomainError(
        "RUN_APPROVAL_MISMATCH",
        `Approval ${input.approvalId} is not pending for this Run.`,
      );
    }

    this.currentApprovalId = undefined;
    this.currentState = "running";
  }

  public cancel(reason: string): void {
    if (this.currentState === "cancelled") {
      return;
    }

    if (isTerminal(this.currentState)) {
      throw new DomainError(
        "RUN_TRANSITION_INVALID",
        `A ${this.currentState} Run cannot be cancelled.`,
      );
    }

    this.currentCancellationReason = reason;
    this.currentApprovalId = undefined;
    this.currentBlockedReason = undefined;
    this.currentState = "cancelled";
  }

  private requireState(expected: RunState): void {
    if (this.currentState !== expected) {
      throw new DomainError(
        "RUN_TRANSITION_INVALID",
        `Run state ${this.currentState} cannot perform an operation requiring ${expected}.`,
      );
    }
  }

  private requireOneOfStates(expected: readonly RunState[]): void {
    if (!expected.includes(this.currentState)) {
      throw new DomainError(
        "RUN_TRANSITION_INVALID",
        `Run state ${this.currentState} cannot perform an operation requiring ${expected.join(" or ")}.`,
      );
    }
  }

  private assertCurrentClaim(claim: RunClaim): void {
    if (this.currentClaim === undefined) {
      throw new DomainError("RUN_TRANSITION_INVALID", "The Run has no active claim.");
    }

    if (claim.workerId !== this.currentClaim.workerId) {
      throw new DomainError(
        "RUN_WORKER_MISMATCH",
        `Worker ${claim.workerId} does not own this Run claim.`,
      );
    }

    if (claim.fencingToken !== this.currentClaim.fencingToken) {
      throw new DomainError(
        "RUN_FENCE_STALE",
        `Fencing token ${claim.fencingToken} is not current for this Run.`,
      );
    }

    if (claim.leaseId !== this.currentClaim.leaseId) {
      throw new DomainError(
        "RUN_LEASE_MISMATCH",
        `Lease ${claim.leaseId} is not current for this Run.`,
      );
    }

    if (
      !Number.isSafeInteger(claim.observedAtMs) ||
      claim.observedAtMs < this.currentClaim.claimedAtMs
    ) {
      throw new DomainError(
        "RUN_ASSIGNMENT_INVALID",
        "A Run mutation requires a safe observation time at or after claim.",
      );
    }

    if (claim.observedAtMs >= this.currentClaim.expiresAtMs) {
      throw new DomainError("RUN_LEASE_EXPIRED", "The Run dispatch lease has expired.");
    }
  }
}

function isTerminal(state: RunState): boolean {
  return state === "succeeded" || state === "failed" || state === "lost" || state === "cancelled";
}

function validateDispatch(dispatch: RunDispatch): void {
  if (
    dispatch.workerId.trim() === "" ||
    dispatch.idempotencyKey.trim() === "" ||
    dispatch.leaseId.trim() === "" ||
    !Number.isSafeInteger(dispatch.fencingToken) ||
    dispatch.fencingToken <= 0 ||
    !Number.isSafeInteger(dispatch.dispatchedAtMs) ||
    !Number.isSafeInteger(dispatch.expiresAtMs) ||
    dispatch.expiresAtMs <= dispatch.dispatchedAtMs
  ) {
    throw new DomainError(
      "RUN_ASSIGNMENT_INVALID",
      "A Run dispatch requires a valid Worker, idempotency key, lease, fence, and deadline.",
    );
  }
}

function sameClaim(current: RunClaimSnapshot, replay: ClaimRun, dispatch: RunDispatch): boolean {
  return (
    current.workerId === replay.workerId &&
    current.leaseId === replay.leaseId &&
    current.fencingToken === replay.fencingToken &&
    current.claimedAtMs === replay.claimedAtMs &&
    current.expiresAtMs === dispatch.expiresAtMs
  );
}

function freezeDispatch(dispatch: RunDispatch): RunDispatch {
  return Object.freeze({
    workerId: dispatch.workerId,
    idempotencyKey: dispatch.idempotencyKey,
    leaseId: dispatch.leaseId,
    fencingToken: dispatch.fencingToken,
    dispatchedAtMs: dispatch.dispatchedAtMs,
    expiresAtMs: dispatch.expiresAtMs,
  });
}

function sameDispatch(left: RunDispatch, right: RunDispatch): boolean {
  return (
    left.workerId === right.workerId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.leaseId === right.leaseId &&
    left.fencingToken === right.fencingToken &&
    left.dispatchedAtMs === right.dispatchedAtMs &&
    left.expiresAtMs === right.expiresAtMs
  );
}
