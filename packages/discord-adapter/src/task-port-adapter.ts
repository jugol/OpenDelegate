import type { DiscordTaskPort } from "./contracts.ts";
import { DiscordTaskPortError } from "./errors.ts";

export interface DiscordTaskServicePort {
  create(input: {
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly objective: string;
    readonly completionCriteria: readonly string[];
    readonly constraints: readonly string[];
    readonly selectedInputRefs: readonly string[];
  }): Promise<{ readonly taskId: string }>;
  appendInput(input: {
    readonly taskId: string;
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly message: string;
    readonly selectedInputRefs: readonly string[];
  }): Promise<{ readonly taskId: string }>;
  command(input: {
    readonly taskId: string;
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly command: "pause" | "resume" | "cancel" | "retry";
  }): Promise<{ readonly taskId: string }>;
  resolveApproval(input: {
    readonly taskId: string;
    readonly approvalId: string;
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly decision: "approve" | "reject";
  }): Promise<{ readonly taskId: string }>;
}

export function createDiscordTaskPort(tasks: DiscordTaskServicePort): DiscordTaskPort {
  assertTaskServicePort(tasks);
  const port: DiscordTaskPort = {
    async createTask(input) {
      const task = await tasks.create({
        principalId: input.principalId,
        idempotencyKey: input.idempotencyKey,
        objective: input.objective,
        completionCriteria: Object.freeze([...input.completionCriteria]),
        constraints: Object.freeze([...input.constraints]),
        selectedInputRefs: Object.freeze([...input.selectedInputRefs]),
      });
      return Object.freeze({ taskId: task.taskId });
    },
    async appendTaskInput(input) {
      await tasks.appendInput({
        taskId: input.taskId,
        principalId: input.principalId,
        idempotencyKey: input.idempotencyKey,
        message: input.message,
        selectedInputRefs: Object.freeze([...input.selectedInputRefs]),
      });
    },
    async commandTask(input) {
      try {
        await tasks.command({ ...input });
      } catch (error) {
        throw mapTaskServiceError(error, "command");
      }
    },
    async resolveApproval(input) {
      try {
        await tasks.resolveApproval({ ...input });
      } catch (error) {
        throw mapTaskServiceError(error, "approval");
      }
    },
  };
  return Object.freeze(port);
}

function mapTaskServiceError(error: unknown, operation: "approval" | "command"): unknown {
  const code = taskServiceErrorCode(error);
  switch (code) {
    case "TRANSITION_INVALID":
      return new DiscordTaskPortError(
        operation === "command" ? "CONTROL_UNAVAILABLE" : "APPROVAL_UNAVAILABLE",
        operation === "command"
          ? "The Task control is no longer available in the current Task state."
          : "The Task approval is no longer available in the current Task state.",
        error instanceof Error ? { cause: error } : undefined,
      );
    case "TASK_NOT_FOUND":
      return new DiscordTaskPortError(
        "TASK_NOT_FOUND",
        "The Task no longer exists.",
        error instanceof Error ? { cause: error } : undefined,
      );
    case "IDEMPOTENCY_CONFLICT":
    case "INPUT_INVALID":
      return new DiscordTaskPortError(
        "REQUEST_CONFLICT",
        "The Task control conflicts with an already processed request.",
        error instanceof Error ? { cause: error } : undefined,
      );
    default:
      return error;
  }
}

function taskServiceErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function assertTaskServicePort(value: DiscordTaskServicePort): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !["create", "appendInput", "command", "resolveApproval"].every(
      (method) => typeof (value as unknown as Record<string, unknown>)[method] === "function",
    )
  ) {
    throw new TypeError("Discord requires one durable Task service port.");
  }
}
