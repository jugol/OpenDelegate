import type {
  SecureSecretIngestPurposeV1,
  SecureSecretIngestReceiptV1,
} from "@opendelegate/protocol";

export interface SecureSecretIngestInput {
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly purpose: SecureSecretIngestPurposeV1;
  readonly secret: Uint8Array;
}

export interface SecureSecretIngestPort {
  ingest(input: SecureSecretIngestInput): Promise<SecureSecretIngestReceiptV1>;
}

export type SecureSecretIngestPortErrorCode =
  "SECRET_INGEST_IDEMPOTENCY_CONFLICT" | "SECRET_INGEST_INVALID" | "SECRET_INGEST_UNAVAILABLE";

export class SecureSecretIngestPortError extends Error {
  public readonly code: SecureSecretIngestPortErrorCode;

  public constructor(code: SecureSecretIngestPortErrorCode) {
    super(publicMessage(code));
    this.name = "SecureSecretIngestPortError";
    this.code = code;
  }
}

function publicMessage(code: SecureSecretIngestPortErrorCode): string {
  switch (code) {
    case "SECRET_INGEST_IDEMPOTENCY_CONFLICT":
      return "The idempotency key was already used for different Secret material.";
    case "SECRET_INGEST_INVALID":
      return "The Secret material does not satisfy the selected secure-ingest purpose.";
    case "SECRET_INGEST_UNAVAILABLE":
      return "The Main Device secure Secret Store is unavailable.";
  }
}
