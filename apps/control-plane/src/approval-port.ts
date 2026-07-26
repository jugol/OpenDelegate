import type { ApprovalDecisionRequestV1, ApprovalDetailV1 } from "@opendelegate/protocol";

export interface ApprovalDecisionInput {
  readonly approvalId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly decision: ApprovalDecisionRequestV1;
}

export interface ApprovalPort {
  list(): Promise<readonly ApprovalDetailV1[]>;
  get(approvalId: string): Promise<ApprovalDetailV1>;
  decide(input: ApprovalDecisionInput): Promise<ApprovalDetailV1>;
}

export type ApprovalPortErrorCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_IDEMPOTENCY_CONFLICT"
  | "APPROVAL_DECISION_CONFLICT"
  | "APPROVAL_SCOPE_INVALID"
  | "APPROVAL_EXECUTION_FAILED"
  | "APPROVAL_UNAVAILABLE";

export class ApprovalPortError extends Error {
  readonly code: ApprovalPortErrorCode;

  constructor(code: ApprovalPortErrorCode, message: string) {
    super(message);
    this.name = "ApprovalPortError";
    this.code = code;
  }
}
