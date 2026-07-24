export type SqlStorageErrorCode =
  | "DATA_CORRUPT"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_FAILED"
  | "MIGRATION_PENDING"
  | "MIGRATION_UNKNOWN"
  | "STORAGE_CONFIGURATION_INVALID"
  | "STORAGE_UNAVAILABLE";

export class SqlStorageError extends Error {
  public readonly code: SqlStorageErrorCode;

  public constructor(code: SqlStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqlStorageError";
    this.code = code;
  }
}
