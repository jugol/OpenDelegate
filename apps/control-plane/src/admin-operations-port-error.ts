export type AdminOperationsPortErrorCode =
  | "ARTIFACT_IDEMPOTENCY_CONFLICT"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_OPEN_UNAVAILABLE"
  | "ARTIFACT_POLICY_UNAVAILABLE"
  | "AUDIT_UNAVAILABLE"
  | "ENROLLMENT_IDEMPOTENCY_CONFLICT"
  | "ENROLLMENT_IDEMPOTENCY_INDETERMINATE"
  | "ENROLLMENT_UNAVAILABLE";

export class AdminOperationsPortError extends Error {
  public readonly code: AdminOperationsPortErrorCode;

  public constructor(code: AdminOperationsPortErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdminOperationsPortError";
    this.code = code;
  }
}
