export type ArtifactStoreErrorCode =
  | "ARTIFACT_CONFLICT"
  | "ARTIFACT_METADATA_INVALID"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_STORAGE_CORRUPT"
  | "ARTIFACT_STORAGE_UNAVAILABLE"
  | "ARTIFACT_STORAGE_UNSAFE"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_UNAVAILABLE"
  | "CHECKSUM_MISMATCH"
  | "SIGNED_TOKEN_INVALID";

export class ArtifactStoreError extends Error {
  public readonly code: ArtifactStoreErrorCode;

  public constructor(code: ArtifactStoreErrorCode, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}
