import type { DiscordTaskPort } from "./contracts.ts";

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
      await tasks.command({ ...input });
    },
    async resolveApproval(input) {
      await tasks.resolveApproval({ ...input });
    },
  };
  return Object.freeze(port);
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
