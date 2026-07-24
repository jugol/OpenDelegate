export type SecretErrorCode =
  | "SECRET_ALIAS_UNAVAILABLE"
  | "SECRET_CLOCK_INVALID"
  | "SECRET_IDENTIFIER_INVALID"
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

  public constructor(code: SecretErrorCode, message: string) {
    super(message);
    this.name = "SecretError";
    this.code = code;
  }
}
