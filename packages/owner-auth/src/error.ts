export type OwnerAuthErrorCode =
  | "AUTHENTICATION_FAILED"
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_STALE"
  | "AUTHENTICATION_UNAVAILABLE"
  | "CLAIM_ALREADY_ACTIVE"
  | "CLAIM_INVALID"
  | "CSRF_INVALID"
  | "LOCAL_ACCESS_REQUIRED"
  | "PASSPHRASE_INVALID"
  | "RATE_LIMITED"
  | "RECOVERY_INVALID"
  | "SESSION_INVALID";

export class OwnerAuthError extends Error {
  public readonly code: OwnerAuthErrorCode;

  public constructor(code: OwnerAuthErrorCode, message: string) {
    super(message);
    this.name = "OwnerAuthError";
    this.code = code;
  }
}
