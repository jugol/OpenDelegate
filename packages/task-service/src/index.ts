import { createHash } from "node:crypto";

import { DomainError, Task, TaskId, type TaskMode, type TaskState } from "@opendelegate/domain";
import {
  EventStoreError,
  type EventClock,
  type EventDraft,
  type EventStore,
  type StoredEvent,
} from "@opendelegate/event-store";
import type {
  CreateTaskRequestV1,
  TaskConversationMessageV1,
  TaskDetailV1,
  TaskSummaryV1,
} from "@opendelegate/protocol";

export {
  DurableTaskContinuationCheckpointService,
  TaskContinuationCheckpointError,
  type DurableTaskContinuationCheckpointServiceOptions,
  type TaskContinuationCheckpointErrorCode,
  type TaskContinuationCheckpointPort,
  type TaskContinuationCheckpointTaskSource,
} from "./task-continuation-checkpoint.ts";

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

export interface AppendTaskInput {
  readonly taskId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly message: string;
  readonly selectedInputRefs: readonly string[];
}

export interface ResolveTaskApprovalInput {
  readonly taskId: string;
  readonly approvalId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly decision: "approve" | "reject";
}

export type TaskExecutionState =
  "queued" | "running" | "waiting_user" | "waiting_resource" | "review" | "completed" | "failed";

export interface RecordTaskExecutionInput {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly state: TaskExecutionState;
  readonly verifiedCompletionCriteria?: readonly string[];
  readonly expectedTaskVersion?: number;
  readonly publicMessage?: string;
}

export interface TaskExecutionRecord {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly streamVersion: number;
  readonly state: TaskExecutionState;
  readonly verifiedCompletionCriteria: readonly string[];
  readonly expectedTaskVersion: number | null;
  readonly publicMessage: string | null;
}

export interface TaskExecutionCycle {
  readonly cycleId: string;
  readonly records: readonly TaskExecutionRecord[];
}

export interface TaskServiceOptions {
  readonly clock: EventClock;
  readonly eventStore: EventStore;
  readonly resolveDefaultMode?: () => TaskMode | Promise<TaskMode>;
}

export type TaskServiceErrorCode =
  | "CONFIGURATION_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "INPUT_INVALID"
  | "TASK_NOT_FOUND"
  | "TRANSITION_INVALID"
  | "STORAGE_CONFLICT";

export class TaskServiceError extends Error {
  readonly code: TaskServiceErrorCode;

  constructor(code: TaskServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
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

interface TaskInputAppendedPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly principalId: string;
  readonly idempotencyDigest: string;
  readonly message: string;
  readonly selectedInputRefs: readonly string[];
}

interface TaskApprovalResolvedPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly approvalId: string;
  readonly principalId: string;
  readonly idempotencyDigest: string;
  readonly decision: "approve" | "reject";
}

interface TaskExecutionRecordedPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly idempotencyDigest: string;
  readonly state: TaskExecutionState;
  readonly verifiedCompletionCriteria: readonly string[];
  readonly expectedTaskVersion: number | null;
  readonly publicMessage: string | null;
}

type TaskEvent =
  | (StoredEvent<TaskCreatedPayload> & { readonly type: "task.created" })
  | (StoredEvent<TaskCommandedPayload> & { readonly type: "task.commanded" })
  | (StoredEvent<TaskInputAppendedPayload> & { readonly type: "task.input-appended" })
  | (StoredEvent<TaskApprovalResolvedPayload> & { readonly type: "task.approval-resolved" })
  | (StoredEvent<TaskExecutionRecordedPayload> & {
      readonly type: "task.execution-recorded";
    });

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
  readonly #resolveDefaultMode: (() => TaskMode | Promise<TaskMode>) | undefined;

  constructor(options: TaskServiceOptions) {
    if (
      options.resolveDefaultMode !== undefined &&
      typeof options.resolveDefaultMode !== "function"
    ) {
      throw new TypeError("The Task default-mode resolver is invalid.");
    }
    this.#clock = options.clock;
    this.#eventStore = options.eventStore;
    this.#resolveDefaultMode = options.resolveDefaultMode;
  }

  async create(input: CreateTaskInput): Promise<TaskDetailV1> {
    const validatedShape = validateCreateInput(input);
    const intakeDigest = digestText(
      `task-intake-v1\u0000${validatedShape.principalId}\u0000${validatedShape.idempotencyKey}`,
    );
    const taskId = `task_${intakeDigest.slice("sha256:".length)}`;
    const existing = await this.#eventStore.readStream(taskStream(taskId));
    if (existing.length > 0) {
      return resolveCreateReplay(existing, validatedShape, intakeDigest, input.mode !== undefined);
    }
    const defaultMode = input.mode === undefined ? await this.#currentDefaultMode() : input.mode;
    const validated = {
      ...validatedShape,
      mode: input.mode ?? defaultMode,
    };
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
      if (error instanceof EventStoreError) {
        const concurrentlyCreated = await this.#eventStore.readStream(taskStream(taskId));
        if (concurrentlyCreated.length > 0) {
          return resolveCreateReplay(
            concurrentlyCreated,
            validatedShape,
            intakeDigest,
            input.mode !== undefined,
          );
        }
      }
      throw mapStorageError(error);
    }
    return this.get(taskId);
  }

  async #currentDefaultMode(): Promise<TaskMode> {
    if (this.#resolveDefaultMode === undefined) {
      return "auto";
    }
    let mode: TaskMode;
    try {
      mode = await this.#resolveDefaultMode();
    } catch (error) {
      throw new TaskServiceError(
        "CONFIGURATION_UNAVAILABLE",
        "The current Task default mode is unavailable.",
        { cause: error },
      );
    }
    if (mode !== "auto" && mode !== "manual") {
      throw new TaskServiceError(
        "CONFIGURATION_UNAVAILABLE",
        "The current Task default mode is invalid.",
      );
    }
    return mode;
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

  async executionHistory(taskId: string): Promise<readonly TaskExecutionRecord[]> {
    assertOpaqueId(taskId, "Task ID");
    const events = await this.#eventStore.readStream(taskStream(taskId));
    if (events.length === 0) {
      throw new TaskServiceError("TASK_NOT_FOUND", "The Task does not exist.");
    }
    const projected = projectTask(events);
    return frozenArray(
      projected.events.filter(isExecutionRecordedEvent).map((event) =>
        Object.freeze({
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          streamVersion: event.streamVersion,
          state: event.payload.state,
          verifiedCompletionCriteria: frozenArray([...event.payload.verifiedCompletionCriteria]),
          expectedTaskVersion: event.payload.expectedTaskVersion,
          publicMessage: event.payload.publicMessage,
        }),
      ),
    );
  }

  async executionCycle(taskId: string): Promise<TaskExecutionCycle> {
    assertOpaqueId(taskId, "Task ID");
    const events = await this.#eventStore.readStream(taskStream(taskId));
    if (events.length === 0) {
      throw new TaskServiceError("TASK_NOT_FOUND", "The Task does not exist.");
    }
    const projected = projectTask(events);
    let cycleId = projected.events[0]?.eventId;
    let cycleStart = 0;
    for (const [index, event] of projected.events.entries()) {
      if (startsExecutionCycle(event)) {
        cycleId = event.eventId;
        cycleStart = index + 1;
      }
    }
    if (cycleId === undefined) {
      throw new TaskServiceError("STORAGE_CONFLICT", "The Task stream is empty.");
    }
    const records = projected.events.slice(cycleStart).filter(isExecutionRecordedEvent);
    return Object.freeze({
      cycleId,
      records: frozenArray(
        records.map((event) =>
          Object.freeze({
            eventId: event.eventId,
            occurredAt: event.occurredAt,
            streamVersion: event.streamVersion,
            state: event.payload.state,
            verifiedCompletionCriteria: frozenArray([...event.payload.verifiedCompletionCriteria]),
            expectedTaskVersion: event.payload.expectedTaskVersion,
            publicMessage: event.payload.publicMessage,
          }),
        ),
      ),
    });
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

  async appendInput(input: AppendTaskInput): Promise<TaskDetailV1> {
    const validated = validateAppendInput(input);
    const currentEvents = await this.#eventStore.readStream(taskStream(validated.taskId));
    if (currentEvents.length === 0) {
      throw new TaskServiceError("TASK_NOT_FOUND", "The Task does not exist.");
    }
    const digest = digestText(
      `task-input-v1\u0000${validated.taskId}\u0000${validated.principalId}\u0000${validated.idempotencyKey}`,
    );
    const eventId = `event_${digest.slice("sha256:".length)}`;
    const prior = currentEvents.find((event) => event.eventId === eventId);
    if (prior !== undefined) {
      if (
        isInputAppendedEvent(prior) &&
        prior.payload.taskId === validated.taskId &&
        prior.payload.principalId === validated.principalId &&
        prior.payload.idempotencyDigest === digest &&
        prior.payload.message === validated.message &&
        sameArray(prior.payload.selectedInputRefs, validated.selectedInputRefs)
      ) {
        return taskDetail(projectTask(currentEvents));
      }
      throw idempotencyConflict();
    }

    const current = projectTask(currentEvents);
    applyInputAppended(current.aggregate);
    const payload: TaskInputAppendedPayload = {
      schemaVersion: 1,
      taskId: validated.taskId,
      principalId: validated.principalId,
      idempotencyDigest: digest,
      message: validated.message,
      selectedInputRefs: validated.selectedInputRefs,
    };
    await this.#append(current, eventId, "task.input-appended", payload);
    return this.get(validated.taskId);
  }

  async resolveApproval(input: ResolveTaskApprovalInput): Promise<TaskDetailV1> {
    const validated = validateApprovalInput(input);
    const currentEvents = await this.#eventStore.readStream(taskStream(validated.taskId));
    if (currentEvents.length === 0) {
      throw new TaskServiceError("TASK_NOT_FOUND", "The Task does not exist.");
    }
    const digest = digestText(
      `task-approval-v1\u0000${validated.taskId}\u0000${validated.principalId}\u0000${validated.idempotencyKey}`,
    );
    const eventId = `event_${digest.slice("sha256:".length)}`;
    const prior = currentEvents.find((event) => event.eventId === eventId);
    if (prior !== undefined) {
      if (
        isApprovalResolvedEvent(prior) &&
        prior.payload.taskId === validated.taskId &&
        prior.payload.approvalId === validated.approvalId &&
        prior.payload.principalId === validated.principalId &&
        prior.payload.idempotencyDigest === digest &&
        prior.payload.decision === validated.decision
      ) {
        return taskDetail(projectTask(currentEvents));
      }
      throw idempotencyConflict();
    }

    const current = projectTask(currentEvents);
    applyApprovalResolved(current.aggregate, validated.decision);
    const payload: TaskApprovalResolvedPayload = {
      schemaVersion: 1,
      taskId: validated.taskId,
      approvalId: validated.approvalId,
      principalId: validated.principalId,
      idempotencyDigest: digest,
      decision: validated.decision,
    };
    await this.#append(current, eventId, "task.approval-resolved", payload);
    return this.get(validated.taskId);
  }

  async recordExecution(input: RecordTaskExecutionInput): Promise<TaskDetailV1> {
    const validated = validateExecutionInput(input);
    const currentEvents = await this.#eventStore.readStream(taskStream(validated.taskId));
    if (currentEvents.length === 0) {
      throw new TaskServiceError("TASK_NOT_FOUND", "The Task does not exist.");
    }
    const digest = digestText(
      `task-execution-v1\u0000${validated.taskId}\u0000${validated.idempotencyKey}`,
    );
    const eventId = `event_${digest.slice("sha256:".length)}`;
    const prior = currentEvents.find((event) => event.eventId === eventId);
    if (prior !== undefined) {
      if (
        isExecutionRecordedEvent(prior) &&
        prior.payload.taskId === validated.taskId &&
        prior.payload.idempotencyDigest === digest &&
        prior.payload.state === validated.state &&
        sameArray(prior.payload.verifiedCompletionCriteria, validated.verifiedCompletionCriteria) &&
        prior.payload.expectedTaskVersion === validated.expectedTaskVersion &&
        prior.payload.publicMessage === validated.publicMessage
      ) {
        return taskDetail(projectTask(currentEvents));
      }
      throw idempotencyConflict();
    }

    const current = projectTask(currentEvents);
    if (
      validated.expectedTaskVersion !== null &&
      validated.expectedTaskVersion !== current.version
    ) {
      throw new TaskServiceError(
        "TRANSITION_INVALID",
        "The Task execution result was superseded by newer durable Task activity.",
      );
    }
    if (
      validated.verifiedCompletionCriteria.some(
        (criterion) => !current.created.completionCriteria.includes(criterion),
      )
    ) {
      throw inputInvalid();
    }
    applyExecutionRecorded(
      current.aggregate,
      validated.state,
      validated.verifiedCompletionCriteria,
    );
    const payload: TaskExecutionRecordedPayload = {
      schemaVersion: 1,
      taskId: validated.taskId,
      idempotencyDigest: digest,
      state: validated.state,
      verifiedCompletionCriteria: validated.verifiedCompletionCriteria,
      expectedTaskVersion: validated.expectedTaskVersion,
      publicMessage: validated.publicMessage,
    };
    await this.#append(current, eventId, "task.execution-recorded", payload);
    return this.get(validated.taskId);
  }

  async #append<TPayload extends object>(
    current: ProjectedTask,
    eventId: string,
    type: string,
    payload: TPayload,
  ): Promise<void> {
    try {
      await this.#eventStore.append({
        streamId: taskStream(current.created.taskId),
        expectedVersion: current.version,
        occurredAt: this.#clock.now(),
        events: [{ eventId, type, payload }],
      });
    } catch (error) {
      throw mapStorageError(error);
    }
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
    if (isCommandedEvent(event) && event.payload.taskId === first.payload.taskId) {
      applyCommand(aggregate, event.payload.command);
      typedEvents.push(event);
      continue;
    }
    if (isInputAppendedEvent(event) && event.payload.taskId === first.payload.taskId) {
      applyInputAppended(aggregate);
      typedEvents.push(event);
      continue;
    }
    if (isApprovalResolvedEvent(event) && event.payload.taskId === first.payload.taskId) {
      applyApprovalResolved(aggregate, event.payload.decision);
      typedEvents.push(event);
      continue;
    }
    if (isExecutionRecordedEvent(event) && event.payload.taskId === first.payload.taskId) {
      applyExecutionRecorded(
        aggregate,
        event.payload.state,
        event.payload.verifiedCompletionCriteria,
      );
      typedEvents.push(event);
      continue;
    }
    {
      throw new TaskServiceError("STORAGE_CONFLICT", "The Task stream contains an unknown event.");
    }
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
    messages: taskMessages(projected.events),
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

function applyInputAppended(task: Task): void {
  try {
    if (task.state === "completed" || task.state === "failed") {
      task.reopen();
      return;
    }
    if (
      task.state === "waiting_user" ||
      task.state === "waiting_resource" ||
      task.state === "review"
    ) {
      task.transitionTo("queued");
    }
  } catch (error) {
    throw mapDomainTransition(error);
  }
}

function applyApprovalResolved(task: Task, decision: "approve" | "reject"): void {
  if (task.state !== "waiting_user") {
    throw new TaskServiceError(
      "TRANSITION_INVALID",
      "The Task has no approval that can be resolved in its current state.",
    );
  }
  try {
    task.transitionTo(decision === "approve" ? "queued" : "failed");
  } catch (error) {
    throw mapDomainTransition(error);
  }
}

function applyExecutionRecorded(
  task: Task,
  state: TaskExecutionState,
  verifiedCompletionCriteria: readonly string[],
): void {
  try {
    for (const criterion of verifiedCompletionCriteria) {
      task.verifyCompletionCriterion(criterion);
    }
    task.transitionTo(state);
  } catch (error) {
    throw mapDomainTransition(error);
  }
}

function mapDomainTransition(error: unknown): TaskServiceError {
  if (error instanceof DomainError) {
    return new TaskServiceError("TRANSITION_INVALID", "The Task transition is not valid now.");
  }
  throw error;
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

function isInputAppendedEvent(event: StoredEvent): event is TaskEvent & {
  readonly type: "task.input-appended";
  readonly payload: TaskInputAppendedPayload;
} {
  if (event.type !== "task.input-appended" || !isRecord(event.payload)) {
    return false;
  }
  const payload = event.payload;
  return (
    hasExactKeys(payload, [
      "schemaVersion",
      "taskId",
      "principalId",
      "idempotencyDigest",
      "message",
      "selectedInputRefs",
    ]) &&
    payload["schemaVersion"] === 1 &&
    typeof payload["taskId"] === "string" &&
    typeof payload["principalId"] === "string" &&
    typeof payload["idempotencyDigest"] === "string" &&
    typeof payload["message"] === "string" &&
    isTextArray(payload["selectedInputRefs"])
  );
}

function isApprovalResolvedEvent(event: StoredEvent): event is TaskEvent & {
  readonly type: "task.approval-resolved";
  readonly payload: TaskApprovalResolvedPayload;
} {
  if (event.type !== "task.approval-resolved" || !isRecord(event.payload)) {
    return false;
  }
  const payload = event.payload;
  return (
    hasExactKeys(payload, [
      "schemaVersion",
      "taskId",
      "approvalId",
      "principalId",
      "idempotencyDigest",
      "decision",
    ]) &&
    payload["schemaVersion"] === 1 &&
    typeof payload["taskId"] === "string" &&
    typeof payload["approvalId"] === "string" &&
    typeof payload["principalId"] === "string" &&
    typeof payload["idempotencyDigest"] === "string" &&
    (payload["decision"] === "approve" || payload["decision"] === "reject")
  );
}

function isExecutionRecordedEvent(event: StoredEvent): event is TaskEvent & {
  readonly type: "task.execution-recorded";
  readonly payload: TaskExecutionRecordedPayload;
} {
  if (event.type !== "task.execution-recorded" || !isRecord(event.payload)) {
    return false;
  }
  const payload = event.payload;
  return (
    hasExactKeys(payload, [
      "schemaVersion",
      "taskId",
      "idempotencyDigest",
      "state",
      "verifiedCompletionCriteria",
      "expectedTaskVersion",
      "publicMessage",
    ]) &&
    payload["schemaVersion"] === 1 &&
    typeof payload["taskId"] === "string" &&
    typeof payload["idempotencyDigest"] === "string" &&
    isTaskExecutionState(payload["state"]) &&
    isTextArray(payload["verifiedCompletionCriteria"]) &&
    (payload["expectedTaskVersion"] === null ||
      (Number.isSafeInteger(payload["expectedTaskVersion"]) &&
        Number(payload["expectedTaskVersion"]) >= 1)) &&
    (payload["publicMessage"] === null || isPublicMessage(payload["publicMessage"]))
  );
}

function validateCreateInput(
  input: CreateTaskInput,
  defaultMode: TaskMode = "auto",
): Required<CreateTaskInput> {
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
    mode: input.mode ?? defaultMode,
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

function validateAppendInput(input: AppendTaskInput): AppendTaskInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "taskId",
      "principalId",
      "idempotencyKey",
      "message",
      "selectedInputRefs",
    ])
  ) {
    throw inputInvalid();
  }
  assertOpaqueId(input.taskId, "Task ID");
  assertBoundedText(input.principalId, 200);
  assertBoundedText(input.idempotencyKey, 500);
  assertBoundedText(input.message, 32_768);
  assertTextList(input.selectedInputRefs, 0, 128, 160);
  return Object.freeze({
    taskId: input.taskId,
    principalId: input.principalId,
    idempotencyKey: input.idempotencyKey,
    message: input.message,
    selectedInputRefs: frozenArray([...input.selectedInputRefs]),
  });
}

function validateApprovalInput(input: ResolveTaskApprovalInput): ResolveTaskApprovalInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["taskId", "approvalId", "principalId", "idempotencyKey", "decision"])
  ) {
    throw inputInvalid();
  }
  assertOpaqueId(input.taskId, "Task ID");
  assertOpaqueId(input.approvalId, "Approval ID");
  assertBoundedText(input.principalId, 200);
  assertBoundedText(input.idempotencyKey, 500);
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw inputInvalid();
  }
  return Object.freeze({ ...input });
}

function validateExecutionInput(input: RecordTaskExecutionInput): {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly state: TaskExecutionState;
  readonly verifiedCompletionCriteria: readonly string[];
  readonly expectedTaskVersion: number | null;
  readonly publicMessage: string | null;
} {
  if (
    !isRecord(input) ||
    !hasAllowedKeys(input, [
      "taskId",
      "idempotencyKey",
      "state",
      "verifiedCompletionCriteria",
      "expectedTaskVersion",
      "publicMessage",
    ]) ||
    !hasRequiredKeys(input, ["taskId", "idempotencyKey", "state"])
  ) {
    throw inputInvalid();
  }
  assertOpaqueId(input.taskId, "Task ID");
  assertBoundedText(input.idempotencyKey, 500);
  if (!isTaskExecutionState(input.state)) {
    throw inputInvalid();
  }
  const verifiedCompletionCriteria = input.verifiedCompletionCriteria ?? [];
  assertTextList(verifiedCompletionCriteria, 0, 64, 8_192);
  if (input.state !== "completed" && verifiedCompletionCriteria.length > 0) {
    throw inputInvalid();
  }
  if (
    input.expectedTaskVersion !== undefined &&
    (!Number.isSafeInteger(input.expectedTaskVersion) || input.expectedTaskVersion < 1)
  ) {
    throw inputInvalid();
  }
  if (input.publicMessage !== undefined) {
    assertBoundedText(input.publicMessage, 32_768);
  }
  return Object.freeze({
    taskId: input.taskId,
    idempotencyKey: input.idempotencyKey,
    state: input.state,
    verifiedCompletionCriteria: frozenArray([...verifiedCompletionCriteria]),
    expectedTaskVersion: input.expectedTaskVersion ?? null,
    publicMessage: input.publicMessage ?? null,
  });
}

function startsExecutionCycle(event: TaskEvent): boolean {
  return (
    event.type === "task.input-appended" ||
    (event.type === "task.approval-resolved" && event.payload.decision === "approve") ||
    (event.type === "task.commanded" && event.payload.command === "retry")
  );
}

function taskMessages(events: readonly TaskEvent[]): TaskConversationMessageV1[] {
  const messages: TaskConversationMessageV1[] = [];
  for (const event of events) {
    if (event.type === "task.input-appended") {
      messages.push(
        Object.freeze({
          messageId: event.eventId,
          role: "owner",
          content: event.payload.message,
          occurredAt: event.occurredAt,
        }),
      );
    } else if (event.type === "task.execution-recorded" && event.payload.publicMessage !== null) {
      messages.push(
        Object.freeze({
          messageId: event.eventId,
          role: "agent",
          content: event.payload.publicMessage,
          occurredAt: event.occurredAt,
        }),
      );
    }
  }
  return frozenArray(messages);
}

function isPublicMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 32_768 &&
    !value.includes("\u0000")
  );
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

function isTaskExecutionState(value: unknown): value is TaskExecutionState {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting_user" ||
    value === "waiting_resource" ||
    value === "review" ||
    value === "completed" ||
    value === "failed"
  );
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

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveCreateReplay(
  events: readonly StoredEvent[],
  input: Required<CreateTaskInput>,
  intakeDigest: string,
  modeWasExplicit: boolean,
): TaskDetailV1 {
  const projected = projectTask(events);
  const created = projected.created;
  if (
    created.principalId !== input.principalId ||
    created.idempotencyDigest !== intakeDigest ||
    created.objective !== input.objective ||
    !sameArray(created.completionCriteria, input.completionCriteria) ||
    !sameArray(created.constraints, input.constraints) ||
    !sameArray(created.selectedInputRefs, input.selectedInputRefs) ||
    (modeWasExplicit && created.mode !== input.mode)
  ) {
    throw idempotencyConflict();
  }
  return taskDetail(projected);
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

function idempotencyConflict(): TaskServiceError {
  return new TaskServiceError(
    "IDEMPOTENCY_CONFLICT",
    "The idempotency key was already used for different Task content.",
  );
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
export {
  TaskExecutionCoordinator,
  TaskExecutionCoordinatorError,
  TaskExecutorError,
  type TaskExecutionCoordinatorErrorCode,
  type TaskExecutionCoordinatorOptions,
  type TaskExecutionRequest,
  type TaskExecutionResult,
  type TaskExecutor,
  type TaskExecutorErrorCode,
  type TaskExecutorErrorOptions,
  type TaskExecutorRetryKind,
} from "./task-execution-coordinator.ts";
export {
  AuthoritativeWorkerTaskExecutor,
  type AuthoritativeWorkerReport,
  type AuthoritativeWorkerTaskExecutorClock,
  type AuthoritativeWorkerTaskExecutorIdSource,
  type AuthoritativeWorkerTaskExecutorOptions,
  type DirectPlanningCompletionAuthorizer,
  type TaskEvidenceVerifier,
  type TaskWorkPlanDecision,
  type TaskWorkPlanner,
  type TaskExecutionActivityMilestone,
  type TaskExecutionActivityPhase,
  type TaskExecutionActivityPort,
  type TaskExecutionActivitySnapshot,
  type WorkerDispatchTarget,
  type WorkerDispatchTargetResolver,
  type WorkerArtifactRunAuthorization,
  type WorkerArtifactRunScope,
  type WorkerActionRunAuthorization,
  type WorkerActionRunScope,
  type WorkerEventAcceptance,
  type WorkerRunLeaseRenewalOutcome,
  type WorkerRunLeaseRenewalRejectionCode,
  type WorkerRunLeaseRenewalRequest,
  type WorkerRunDispatchPort,
} from "./authoritative-worker-task-executor.ts";
export {
  BudgetHardLimitError,
  DEFAULT_AUTONOMOUS_TASK_BUDGET_LIMITS,
  DEFAULT_INSTANCE_BUDGET_LIMITS,
  DEFAULT_PROVIDER_USAGE_PROXY,
  DEFAULT_REQUESTED_TASK_BUDGET_LIMITS,
  DurableTaskBudgetEnforcer,
  TaskBudgetServiceError,
  type BudgetExtensionEvent,
  type BudgetLimitEvent,
  type BudgetTaskKind,
  type DurableTaskBudgetEnforcerOptions,
  type ProviderUsageEvidence,
  type ProviderUsageProxy,
  type TaskBudgetAdministrationPort,
  type TaskBudgetClock,
  type TaskBudgetEnforcementPort,
  type TaskBudgetExecutionGuard,
  type TaskBudgetSnapshot,
  type TaskBudgetServiceErrorCode,
  type WorkOrderBudgetSnapshot,
} from "./durable-budget-enforcer.ts";
