import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventStore } from "@opendelegate/event-store";

import { TaskService, TaskServiceError } from "../src/index.ts";

const clock = {
  now: () => "2026-07-24T12:00:00.000Z",
};

test("channel-neutral Task creation defaults to Auto and survives service restart", async () => {
  const eventStore = new InMemoryEventStore({ clock });
  const service = new TaskService({ clock, eventStore });

  const created = await service.create({
    principalId: "owner-1",
    idempotencyKey: "admin-create-1",
    objective: "Prepare a release report.",
    completionCriteria: ["The report has a verdict."],
    constraints: ["Do not publish externally."],
    selectedInputRefs: ["artifact-input-1"],
  });

  assert.equal(created.mode, "auto");
  assert.equal(created.state, "intake");
  assert.equal(created.version, 1);

  const restarted = new TaskService({ clock, eventStore });
  assert.deepEqual(await restarted.get(created.taskId), {
    ...created,
    events: [
      {
        eventId: created.events[0]?.eventId,
        type: "task.created",
        occurredAt: clock.now(),
        streamVersion: 1,
      },
    ],
  });
});

test("create idempotency returns one Task and rejects a conflicting replay", async () => {
  const service = fixture();
  const input = {
    principalId: "owner-1",
    idempotencyKey: "discord-forum-post-1",
    objective: "Inspect the NAS.",
    completionCriteria: ["Health is reported."],
    constraints: [],
    selectedInputRefs: [],
  } as const;

  const [left, right] = await Promise.all([service.create(input), service.create(input)]);
  assert.deepEqual(left, right);

  await assert.rejects(
    service.create({ ...input, objective: "Mutated replay." }),
    isTaskError("IDEMPOTENCY_CONFLICT"),
  );
});

test("different intake keys remain isolated and list in stable newest-first order", async () => {
  let now = 0;
  const eventStore = new InMemoryEventStore({
    clock: { now: () => new Date(++now * 1_000).toISOString() },
  });
  const service = new TaskService({
    clock: { now: () => new Date((now + 1) * 1_000).toISOString() },
    eventStore,
  });

  const first = await service.create(taskInput("one", "First"));
  const second = await service.create(taskInput("two", "Second"));

  assert.notEqual(first.taskId, second.taskId);
  assert.deepEqual(
    (await service.list()).map((task) => task.taskId),
    [second.taskId, first.taskId],
  );
});

test("pause, resume, cancel, and retry use durable validated Task transitions", async () => {
  const service = fixture();
  const task = await service.create(taskInput("lifecycle", "Lifecycle"));

  const paused = await service.command({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "pause-1",
    command: "pause",
  });
  assert.equal(paused.state, "paused");

  const resumed = await service.command({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "resume-1",
    command: "resume",
  });
  assert.equal(resumed.state, "intake");

  const cancelled = await service.command({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "cancel-1",
    command: "cancel",
  });
  assert.equal(cancelled.state, "cancelled");

  const retried = await service.command({
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "retry-1",
    command: "retry",
  });
  assert.equal(retried.state, "queued");
  assert.equal(retried.version, 5);
});

test("command replay is idempotent while command-key reuse with another action fails", async () => {
  const service = fixture();
  const task = await service.create(taskInput("command-replay", "Replay"));
  const command = {
    taskId: task.taskId,
    principalId: "owner-1",
    idempotencyKey: "command-1",
    command: "pause" as const,
  };

  const first = await service.command(command);
  const replay = await service.command(command);
  assert.deepEqual(replay, first);

  await assert.rejects(
    service.command({ ...command, command: "cancel" }),
    isTaskError("IDEMPOTENCY_CONFLICT"),
  );
});

test("unknown Tasks and invalid transitions fail without appending an event", async () => {
  const eventStore = new InMemoryEventStore({ clock });
  const service = new TaskService({ clock, eventStore });
  await assert.rejects(service.get("task_missing"), isTaskError("TASK_NOT_FOUND"));

  const task = await service.create(taskInput("invalid", "Invalid"));
  await assert.rejects(
    service.command({
      taskId: task.taskId,
      principalId: "owner-1",
      idempotencyKey: "resume-invalid",
      command: "resume",
    }),
    isTaskError("TRANSITION_INVALID"),
  );
  assert.equal((await eventStore.readStream(`task:${task.taskId}`)).length, 1);
});

test("runtime validation rejects extra, secret-shaped, and Knowledge-shaped intake fields", async () => {
  const service = fixture();
  const base = taskInput("unsafe", "Unsafe");

  await assert.rejects(
    service.create({ ...base, token: "raw-secret" } as never),
    isTaskError("INPUT_INVALID"),
  );
  await assert.rejects(
    service.create({ ...base, knowledge: "private note" } as never),
    isTaskError("INPUT_INVALID"),
  );
});

function fixture(): TaskService {
  return new TaskService({
    clock,
    eventStore: new InMemoryEventStore({ clock }),
  });
}

function taskInput(key: string, objective: string) {
  return {
    principalId: "owner-1",
    idempotencyKey: key,
    objective,
    completionCriteria: [`${objective} is complete.`],
    constraints: [],
    selectedInputRefs: [],
  };
}

function isTaskError(code: string) {
  return (error: unknown): boolean => error instanceof TaskServiceError && error.code === code;
}
