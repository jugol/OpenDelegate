export class AgentAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "AgentAdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function adapterFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error instanceof AgentAdapterError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "ADAPTER_INTERNAL_ERROR",
    message: "The agent adapter failed without exposing provider internals.",
    retryable: false,
  };
}
