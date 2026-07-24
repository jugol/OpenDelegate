import { createHash } from "node:crypto";

import { DomainError, Task, TaskId, type TaskMode, type TaskState } from "@opendelegate/domain";
import {
  EventStoreError,
  type EventClock,
  type EventDraft,
  type EventStore,
  type StoredEvent,
} from "@opendelegate/event-store";
import type { CreateTaskRequestV1, TaskDetailV1, TaskSummaryV1 } from "@opendelegate/protocol";

export interface CreateTaskInput extends Omit<
  CreateTaskRequestV1,
  "completionCriteria" | "constraints" | "selectedInputRefs"
> {
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly selectedInputRefs: readonly string[];
}

export type TaskCommand = "pause" | "resume" | "cancel" | "retry";

export interface TaskCommandInput {
  readonly taskId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly command: TaskCommand;
}

export interface TaskServiceOptions {
  readonly clock: EventClock;
  readonly eventStore: EventStore;
}

export type TaskServiceErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "INPUT_INVALID"
  | "TASK_NOT_FOUND"
  | "TRANSITION_INVALID"
  | "STORAGE_CONFLICT";

export class TaskServiceError extends Error {
  readonly code: TaskServiceErrorCode;

  constructor(code: TaskServiceErrorCode, message: string) {
    super(message);
    this.name = "TaskServiceError";
    this.code = code;
  }
}

interface TaskCreatedPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly principalId: string;
  readonly idempotencyDigest: string;
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly selectedInputRefs: readonly string[];
  readonly mode: TaskMode;
}

interface TaskCommandedPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly principalId: string;
  readonly idempotencyDigest: string;
  readonly command: TaskCommand;
}

type TaskEvent =
  | (StoredEvent<TaskCreatedPayload> & { readonly type: "task.created" })
  | (StoredEvent<TaskCommandedPayload> & { readonly type: "task.commanded" });

interface ProjectedTask {
  readonly aggregate: Task;
  readonly created: TaskCreatedPayload;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly events: readonly TaskEvent[];
}

export class TaskService {
  readonly #clock: EventClock;
  readonly #eventStore: EventStore;

  constructor(options: TaskServiceOptions) {
    this.#clock = options.clock;
    this.#eventStore = options.eventStore;
  }

  async create(input: CreateTaskInput): Promise<TaskDetailV1> {
    const validated = validateCreateInput(input);
    const intakeDigest = digestText(
      `task-intake-v1\u0000${validated.principalId}\u0000${validated.idempotencyKey}`,
    );
    const taskId = `task_${intakeDigest.slice("sha256:".length)}`;
    const payload: TaskCreatedPayload = {
      schemaVersion: 1,
      taskId,
      principalId: validated.principalId,
      idempotencyDigest: intakeDigest,
      objective: validated.objective,
      completionCriteria: validated.completionCriteria,
      constraints: validated.constraints,
      selectedInputRefs: validated.selectedInputRefs,
      mode: validated.mode,
    };

    try {
      await this.#eventStore.append({
        streamId: taskStream(taskId),
        expectedVersion: 0,
        occurredAt: this.#clock.now(),
        events: [
          {
            eventId: `event_${intakeDigest.slice("sha256:".length)}`,
            type: "task.created",
            payload,
          },
        ],
      });
    } catch (error) {
      throw mapStorageError(error);
    }
    return this.get(taskId);
  }

  async get(taskId: string): Promise<TaskDetailV1> {
    assertOpaqueId(taskId, "Task ID");
    const events = await this.#eventStore.readStream(taskStream(taskId));
    if (events.length === 0) {
      throw new TaskServiceError("TASK_NOT_FOUND", "The Task does not exist.");
    }
    return taskDetail(projectTask(events));
  }

  async list(): Promise<readonly TaskSummaryV1[]> {
    const events = await this.#eventStore.readAll();
    const taskIds = new Set(
      events
        .filter((event) => event.type === "task.created" && event.streamId.startsWith("task:"))
        .map((event) => event.streamId.slice("task:".length)),
    );
    const details = await Promise.all([...taskIds].map((taskId) => this.get(taskId)));
    return Object.freeze(
      details
        .map(taskSummary)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.taskId.localeCompare(left.taskId),
        ),
    );
  }

  async command(input: TaskCommandInput): Promise<TaskDetailV1> {
    const validated = validateCommandInput(input);
    const currentEvents = await this.#eventStore.readStream(taskStream(validated.taskId));
    if (currentEvents.length === 0) {
      throw new TaskServiceError("TASK_NOT_FOUND", "The Task does not exist.");
    }

    const commandDigest = digestText(
      `task-command-v1\u0000${validated.taskId}\u0000${validated.principalId}\u0000${validated.idempotencyKey}`,
    );
    const eventId = `event_${commandDigest.slice("sha256:".length)}`;
    const prior = currentEvents.find((event) => event.eventId === eventId);
    if (prior !== undefined) {
      if (
        isCommandedEvent(prior) &&
        prior.payload.taskId === validated.taskId &&
        prior.payload.principalId === validated.principalId &&
        prior.payload.idempotencyDigest === commandDigest &&
        prior.payload.command === validated.command
      ) {
        return taskDetail(projectTask(currentEvents));
      }
      throw new TaskServiceError(
        "IDEMPOTENCY_CONFLICT",
        "The command idempotency key was already used for another action.",
      );
    }

    const current = projectTask(currentEvents);
    applyCommand(current.aggregate, validated.command);

    const draft: EventDraft<TaskCommandedPayload> = {
      eventId,
      type: "task.commanded",
      payload: {
        schemaVersion: 1,
        taskId: validated.taskId,
        principalId: validated.principalId,
        idempotencyDigest: commandDigest,
        command: validated.command,
      },
    };

    try {
      await this.#eventStore.append({
        streamId: taskStream(validated.taskId),
        expectedVersion: current.version,
        occurredAt: this.#clock.now(),
        events: [draft],
      });
    } catch (error) {
      throw mapStorageError(error);
    }
    return this.get(validated.taskId);
  }
}

function projectTask(events: readonly StoredEvent[]): ProjectedTask {
  const first = events[0];
  if (first === undefined || !isCreatedEvent(first)) {
    throw new TaskServiceError("STORAGE_CONFLICT", "The Task stream has no valid creation event.");
  }
  const aggregate = Task.create({
    id: TaskId.from(first.payload.taskId),
    mode: first.payload.mode,
    brief: {
      objective: first.payload.objective,
      completionCriteria: first.payload.completionCriteria,
      constraints: first.payload.constraints,
      knownInputIds: first.payload.selectedInputRefs,
      decisions: [],
      openQuestions: [],
    },
  });

  const typedEvents: TaskEvent[] = [first];
  for (const event of events.slice(1)) {
    if (!isCommandedEvent(event) || event.payload.taskId !== first.payload.taskId) {
      throw new TaskServiceError("STORAGE_CONFLICT", "The Task stream contains an unknown event.");
    }
    applyCommand(aggregate, event.payload.command);
    typedEvents.push(event);
  }

  const last = typedEvents.at(-1);
  if (last === undefined) {
    throw new TaskServiceError("STORAGE_CONFLICT", "The Task stream is empty.");
  }
  return {
    aggregate,
    created: first.payload,
    createdAt: first.occurredAt,
    updatedAt: last.occurredAt,
    version: last.streamVersion,
    events: Object.freeze(typedEvents),
  };
}

function taskDetail(projected: ProjectedTask): TaskDetailV1 {
  const snapshot = projected.aggregate.snapshot;
  return Object.freeze({
    taskId: snapshot.id,
    state: snapshot.state,
    mode: snapshot.mode,
    objective: projected.created.objective,
    createdAt: projected.createdAt,
    updatedAt: projected.updatedAt,
    version: projected.version,
    completionCriteria: frozenArray([...projected.created.completionCriteria]),
    constraints: frozenArray([...projected.created.constraints]),
    selectedInputRefs: frozenArray([...projected.created.selectedInputRefs]),
    events: frozenArray(
      projected.events.map((event) =>
        Object.freeze({
          eventId: event.eventId,
          type: event.type,
          occurredAt: event.occurredAt,
          streamVersion: event.streamVersion,
        }),
      ),
    ),
  });
}

function taskSummary(detail: TaskDetailV1): TaskSummaryV1 {
  return Object.freeze({
    taskId: detail.taskId,
    state: detail.state,
    mode: detail.mode,
    objective: detail.objective,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    version: detail.version,
  });
}

function applyCommand(task: Task, command: TaskCommand): void {
  try {
    switch (command) {
      case "pause":
        task.pause();
        return;
      case "resume":
        task.resume();
        return;
      case "cancel":
        task.transitionTo("cancelled");
        return;
      case "retry":
        task.reopen();
        return;
    }
  } catch (error) {
    if (error instanceof DomainError) {
      throw new TaskServiceError("TRANSITION_INVALID", "The Task command is not valid now.");
    }
    throw error;
  }
}

function isCreatedEvent(event: StoredEvent): event is TaskEvent & {
  readonly type: "task.created";
  readonly payload: TaskCreatedPayload;
} {
  if (event.type !== "task.created" || !isRecord(event.payload)) {
    return false;
  }
  const payload = event.payload;
  return (
    hasExactKeys(payload, [
      "schemaVersion",
      "taskId",
      "principalId",
      "idempotencyDigest",
      "objective",
      "completionCriteria",
      "constraints",
      "selectedInputRefs",
      "mode",
    ]) &&
    payload["schemaVersion"] === 1 &&
    typeof payload["taskId"] === "string" &&
    typeof payload["principalId"] === "string" &&
    typeof payload["idempotencyDigest"] === "string" &&
    typeof payload["objective"] === "string" &&
    isTextArray(payload["completionCriteria"]) &&
    isTextArray(payload["constraints"]) &&
    isTextArray(payload["selectedInputRefs"]) &&
    (payload["mode"] === "auto" || payload["mode"] === "manual")
  );
}

function isCommandedEvent(event: StoredEvent): event is TaskEvent & {
  readonly type: "task.commanded";
  readonly payload: TaskCommandedPayload;
} {
  if (event.type !== "task.commanded" || !isRecord(event.payload)) {
    return false;
  }
  const payload = event.payload;
  return (
    hasExactKeys(payload, [
      "schemaVersion",
      "taskId",
      "principalId",
      "idempotencyDigest",
      "command",
    ]) &&
    payload["schemaVersion"] === 1 &&
    typeof payload["taskId"] === "string" &&
    typeof payload["principalId"] === "string" &&
    typeof payload["idempotencyDigest"] === "string" &&
    isTaskCommand(payload["command"])
  );
}

function validateCreateInput(input: CreateTaskInput): Required<CreateTaskInput> {
  if (
    !isRecord(input) ||
    !hasAllowedKeys(input, [
      "principalId",
      "idempotencyKey",
      "objective",
      "completionCriteria",
      "constraints",
      "selectedInputRefs",
      "mode",
    ])
  ) {
    throw inputInvalid();
  }
  assertBoundedText(input.principalId, 200);
  assertBoundedText(input.idempotencyKey, 500);
  assertBoundedText(input.objective, 8_192);
  assertTextList(input.completionCriteria, 1, 64, 8_192);
  assertTextList(input.constraints, 0, 128, 8_192);
  assertTextList(input.selectedInputRefs, 0, 128, 160);
  if (input.mode !== undefined && input.mode !== "auto" && input.mode !== "manual") {
    throw inputInvalid();
  }
  return {
    principalId: input.principalId,
    idempotencyKey: input.idempotencyKey,
    objective: input.objective,
    completionCriteria: frozenArray([...input.completionCriteria]),
    constraints: frozenArray([...input.constraints]),
    selectedInputRefs: frozenArray([...input.selectedInputRefs]),
    mode: input.mode ?? "auto",
  };
}

function validateCommandInput(input: TaskCommandInput): TaskCommandInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["taskId", "principalId", "idempotencyKey", "command"])
  ) {
    throw inputInvalid();
  }
  assertOpaqueId(input.taskId, "Task ID");
  assertBoundedText(input.principalId, 200);
  assertBoundedText(input.idempotencyKey, 500);
  if (!isTaskCommand(input.command)) {
    throw inputInvalid();
  }
  return Object.freeze({ ...input });
}

function assertTextList(
  value: unknown,
  minimum: number,
  maximum: number,
  itemMaximum: number,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    new Set(value).size !== value.length
  ) {
    throw inputInvalid();
  }
  for (const item of value) {
    assertBoundedText(item, itemMaximum);
  }
}

function assertBoundedText(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    [...value].some((character) => character.codePointAt(0) === 0)
  ) {
    throw inputInvalid();
  }
}

function assertOpaqueId(value: unknown, _label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw inputInvalid();
  }
}

function isTaskCommand(value: unknown): value is TaskCommand {
  return value === "pause" || value === "resume" || value === "cancel" || value === "retry";
}

function isTextArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function taskStream(taskId: string): string {
  return `task:${taskId}`;
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function frozenArray<T>(values: T[]): T[] {
  Object.freeze(values);
  return values;
}

function inputInvalid(): TaskServiceError {
  return new TaskServiceError("INPUT_INVALID", "The Task request is invalid.");
}

function mapStorageError(error: unknown): TaskServiceError {
  if (error instanceof EventStoreError) {
    switch (error.code) {
      case "EVENT_ID_CONFLICT":
      case "EVENT_BATCH_REPLAY_MISMATCH":
      case "EVENT_BATCH_PARTIAL_REPLAY":
        return new TaskServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used for different Task content.",
        );
      case "STREAM_VERSION_CONFLICT":
        return new TaskServiceError(
          "STORAGE_CONFLICT",
          "The Task changed concurrently; retry with a new command idempotency key.",
        );
      default:
        return new TaskServiceError("STORAGE_CONFLICT", "The Task could not be persisted.");
    }
  }
  if (error instanceof TaskServiceError) {
    return error;
  }
  throw error;
}

export type { TaskState };
