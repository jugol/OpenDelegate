import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiscordTaskPort,
  type DiscordTaskPort,
  type DiscordTaskServicePort,
} from "../src/index.ts";

test("Discord Task intake, replies, commands, and approvals use one durable Task authority", async () => {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const tasks: DiscordTaskServicePort = {
    async create(input) {
      calls.push({ method: "create", input });
      return { taskId: "task-1" };
    },
    async appendInput(input) {
      calls.push({ method: "appendInput", input });
      return { taskId: input.taskId };
    },
    async command(input) {
      calls.push({ method: "command", input });
      return { taskId: input.taskId };
    },
    async resolveApproval(input) {
      calls.push({ method: "resolveApproval", input });
      return { taskId: input.taskId };
    },
  };
  const port: DiscordTaskPort = createDiscordTaskPort(tasks);
  const source = {
    kind: "discord-forum",
    guildId: "100000000000000001",
    forumChannelId: "100000000000000002",
    threadId: "100000000000000003",
    messageId: "100000000000000004",
    authorId: "100000000000000005",
  } as const;

  assert.deepEqual(
    await port.createTask({
      principalId: "owner-1",
      idempotencyKey: "discord-create-1",
      objective: "Inspect the NAS.",
      completionCriteria: ["NAS health is reported."],
      constraints: [],
      selectedInputRefs: ["artifact-1"],
      source,
    }),
    { taskId: "task-1" },
  );
  await port.appendTaskInput({
    taskId: "task-1",
    principalId: "owner-1",
    idempotencyKey: "discord-reply-1",
    message: "Include storage health.",
    selectedInputRefs: [],
    source: { ...source, messageId: "100000000000000006" },
  });
  await port.commandTask({
    taskId: "task-1",
    principalId: "owner-1",
    idempotencyKey: "discord-pause-1",
    command: "pause",
  });
  await port.resolveApproval({
    taskId: "task-1",
    approvalId: "approval-1",
    principalId: "owner-1",
    idempotencyKey: "discord-approval-1",
    decision: "approve",
  });

  assert.deepEqual(calls, [
    {
      method: "create",
      input: {
        principalId: "owner-1",
        idempotencyKey: "discord-create-1",
        objective: "Inspect the NAS.",
        completionCriteria: ["NAS health is reported."],
        constraints: [],
        selectedInputRefs: ["artifact-1"],
      },
    },
    {
      method: "appendInput",
      input: {
        taskId: "task-1",
        principalId: "owner-1",
        idempotencyKey: "discord-reply-1",
        message: "Include storage health.",
        selectedInputRefs: [],
      },
    },
    {
      method: "command",
      input: {
        taskId: "task-1",
        principalId: "owner-1",
        idempotencyKey: "discord-pause-1",
        command: "pause",
      },
    },
    {
      method: "resolveApproval",
      input: {
        taskId: "task-1",
        approvalId: "approval-1",
        principalId: "owner-1",
        idempotencyKey: "discord-approval-1",
        decision: "approve",
      },
    },
  ]);
});
