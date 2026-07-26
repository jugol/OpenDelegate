export const PROTOCOL_VERSION = "v1" as const;

export type ProtocolValidationErrorCode =
  | "BLANK_IDENTIFIER"
  | "INVALID_CONTRACT"
  | "MALFORMED_CAPABILITY_ARRAY"
  | "UNKNOWN_PROTOCOL_VERSION";

export class ProtocolValidationError extends Error {
  public readonly code: ProtocolValidationErrorCode;
  public readonly path: string;

  public constructor(code: ProtocolValidationErrorCode, path: string, message: string) {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.path = path;
  }
}
