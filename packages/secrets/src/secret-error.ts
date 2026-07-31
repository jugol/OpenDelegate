export type SecretErrorCode =
  | "SECRET_ALIAS_UNAVAILABLE"
  | "SECRET_ALIAS_CONFLICT"
  | "SECRET_BACKEND_UNAVAILABLE"
  | "SECRET_CLOCK_INVALID"
  | "SECRET_CONFIGURATION_INVALID"
  | "SECRET_CORRUPTED"
  | "SECRET_IDENTIFIER_INVALID"
  | "SECRET_MATERIAL_INVALID"
  | "SECRET_LEASE_EXPIRY_INVALID"
  | "SECRET_LEASE_TTL_INVALID"
  | "SECRET_LEASE_ID_DUPLICATED"
  | "SECRET_LEASE_NOT_FOUND"
  | "SECRET_LEASE_REPLAYED"
  | "SECRET_LEASE_REVOKED"
  | "SECRET_LEASE_EXPIRED"
  | "SECRET_LEASE_DEVICE_MISMATCH"
  | "SECRET_LEASE_CONSUMER_MISMATCH"
  | "SECRET_LEASE_RUN_MISMATCH"
  | "SECRET_STORE_ACCESS_FAILED"
  | "SECRET_EXECUTOR_FAILED";

export class SecretError extends Error {
  public readonly code: SecretErrorCode;
  /**
   * Names the boundary that refused and what would satisfy it. The code alone
   * cannot distinguish, say, a directory whose ACL cannot be rewritten from a
   * native command that failed, which leaves an operator with nothing to act on.
   * Only host-side facts belong here — never Secret material.
   */
  public readonly detail: string | undefined;

  public constructor(code: SecretErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "SecretError";
    this.code = code;
    this.detail = detail;
  }
}
