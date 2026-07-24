import { DomainError } from "./domain-error.ts";
import type { ApprovalId, TaskId } from "./identifiers.ts";

export type ApprovalState = "pending" | "approved" | "denied" | "expired";
export type ApprovalScope = "once" | "task" | "device" | "policy";

export interface NormalizedActionScope {
  readonly actionType: string;
  readonly targetDeviceId: string;
  readonly resource: string;
}

export interface CreateApproval {
  readonly id: ApprovalId;
  readonly taskId: TaskId;
  readonly actionCategory: string;
  readonly actionScope: NormalizedActionScope;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
}

interface ApprovalDecision {
  readonly decisionId: string;
  readonly decidedBy: string;
  readonly decidedAtMs: number;
}

export type ApproveApproval = ApprovalDecision &
  (
    | { readonly scope: "once" | "task"; readonly scopeTargetId?: never }
    | { readonly scope: "device" | "policy"; readonly scopeTargetId: string }
  );

export interface DenyApproval {
  readonly decisionId: string;
  readonly decidedBy: string;
  readonly decidedAtMs: number;
  readonly reason: string;
}

export interface ApprovalGrant {
  readonly approvalId: string;
  readonly taskId: string;
  readonly actionCategory: string;
  readonly actionScope: NormalizedActionScope;
  readonly decidedBy: string;
  readonly decidedAtMs: number;
  readonly scope: ApprovalScope;
  readonly scopeTargetId?: string;
}

export class Approval {
  public readonly id: ApprovalId;
  public readonly taskId: TaskId;
  public readonly actionCategory: string;
  public readonly actionScope: NormalizedActionScope;
  public readonly requestedAtMs: number;
  public readonly expiresAtMs: number;
  private currentState: ApprovalState = "pending";
  private completedDecisionId: string | undefined;
  private approvedGrant: ApprovalGrant | undefined;

  private constructor(input: CreateApproval) {
    if (
      !Number.isFinite(input.requestedAtMs) ||
      !Number.isFinite(input.expiresAtMs) ||
      input.expiresAtMs <= input.requestedAtMs
    ) {
      throw new DomainError(
        "APPROVAL_TIME_INVALID",
        "Approval timestamps must be finite and expiration must follow the request.",
      );
    }
    this.id = input.id;
    this.taskId = input.taskId;
    this.actionCategory = input.actionCategory;
    this.actionScope = Object.freeze({ ...input.actionScope });
    this.requestedAtMs = input.requestedAtMs;
    this.expiresAtMs = input.expiresAtMs;
  }

  public static create(input: CreateApproval): Approval {
    return new Approval(input);
  }

  public get state(): ApprovalState {
    return this.currentState;
  }

  public approve(input: ApproveApproval): ApprovalGrant {
    if (
      this.currentState === "approved" &&
      this.completedDecisionId === input.decisionId &&
      this.approvedGrant !== undefined
    ) {
      return this.approvedGrant;
    }

    this.requirePending();
    this.assertDecisionTimely(input.decidedAtMs);
    this.assertScopeValid(input);

    const grant = Object.freeze({
      approvalId: this.id.value,
      taskId: this.taskId.value,
      actionCategory: this.actionCategory,
      actionScope: this.actionScope,
      decidedBy: input.decidedBy,
      decidedAtMs: input.decidedAtMs,
      scope: input.scope,
      ...(input.scopeTargetId === undefined ? {} : { scopeTargetId: input.scopeTargetId }),
    });

    this.completedDecisionId = input.decisionId;
    this.approvedGrant = grant;
    this.currentState = "approved";

    return grant;
  }

  public deny(input: DenyApproval): void {
    if (this.currentState === "denied" && this.completedDecisionId === input.decisionId) {
      return;
    }

    this.requirePending();
    this.assertDecisionTimely(input.decidedAtMs);
    this.completedDecisionId = input.decisionId;
    this.currentState = "denied";
  }

  public expire(nowMs: number): void {
    this.requirePending();
    this.assertFiniteTime(nowMs);

    if (nowMs < this.expiresAtMs) {
      throw new DomainError(
        "APPROVAL_EXPIRY_NOT_REACHED",
        "The Approval deadline has not been reached.",
      );
    }

    this.currentState = "expired";
  }

  private requirePending(): void {
    if (this.currentState === "expired") {
      throw new DomainError("APPROVAL_EXPIRED", "An expired Approval cannot receive a decision.");
    }

    if (this.currentState !== "pending") {
      throw new DomainError(
        "APPROVAL_DECISION_CONFLICT",
        `A ${this.currentState} Approval cannot receive a different decision.`,
      );
    }
  }

  private assertDecisionTimely(decidedAtMs: number): void {
    this.assertFiniteTime(decidedAtMs);
    if (decidedAtMs < this.requestedAtMs) {
      throw new DomainError(
        "APPROVAL_TIME_INVALID",
        "An Approval decision cannot predate its request.",
      );
    }

    if (decidedAtMs >= this.expiresAtMs) {
      this.currentState = "expired";
      throw new DomainError(
        "APPROVAL_EXPIRED",
        "An Approval cannot receive a decision at or after its deadline.",
      );
    }
  }

  private assertFiniteTime(value: number): void {
    if (!Number.isFinite(value)) {
      throw new DomainError("APPROVAL_TIME_INVALID", "Approval timestamps must be finite.");
    }
  }

  private assertScopeValid(input: ApproveApproval): void {
    const target = "scopeTargetId" in input ? input.scopeTargetId : undefined;
    if (
      ((input.scope === "device" || input.scope === "policy") &&
        (target === undefined || target.trim().length === 0)) ||
      ((input.scope === "once" || input.scope === "task") && target !== undefined)
    ) {
      throw new DomainError(
        "APPROVAL_SCOPE_INVALID",
        `Approval scope ${input.scope} has an invalid normalized target.`,
      );
    }
  }
}
