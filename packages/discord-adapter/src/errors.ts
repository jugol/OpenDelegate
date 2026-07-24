export type DiscordApiErrorCode =
  "OFFLINE" | "RATE_LIMIT" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_RESPONSE";

export class DiscordApiError extends Error {
  readonly code: DiscordApiErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: DiscordApiErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "DiscordApiError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export type DiscordAdapterErrorCode =
  "CONFIG_INVALID" | "IDEMPOTENCY_CONFLICT" | "PERSISTENCE_CONFLICT" | "PROJECTION_INVALID";

export class DiscordAdapterError extends Error {
  readonly code: DiscordAdapterErrorCode;

  constructor(code: DiscordAdapterErrorCode, message: string) {
    super(message);
    this.name = "DiscordAdapterError";
    this.code = code;
  }
}
