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

export type DiscordTaskPortErrorCode =
  "APPROVAL_UNAVAILABLE" | "CONTROL_UNAVAILABLE" | "REQUEST_CONFLICT" | "TASK_NOT_FOUND";

/**
 * A deterministic Task-authority refusal. Retrying the same Discord callback
 * cannot change its outcome, so the outbox must resolve it for the owner rather
 * than treating it as a transport failure.
 */
export class DiscordTaskPortError extends Error {
  readonly code: DiscordTaskPortErrorCode;

  constructor(code: DiscordTaskPortErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordTaskPortError";
    this.code = code;
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
