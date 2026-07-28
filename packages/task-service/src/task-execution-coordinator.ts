import type { TaskDetailV1, TaskSummaryV1 } from "@opendelegate/protocol";

import {
  BudgetHardLimitError,
  type BudgetTaskKind,
  type TaskBudgetEnforcementPort,
  type TaskBudgetExecutionGuard,
} from "./durable-budget-enforcer.ts";
import type {
  AppendTaskInput,
  CreateTaskInput,
  ResolveTaskApprovalInput,
  TaskCommandInput,
  TaskExecutionCycle,
  TaskExecutionRecord,
  TaskServiceError,
} from "./index.ts";

export interface TaskExecutionRequest {
  readonly task: TaskDetailV1;
  readonly attempt: number;
  readonly executionKey: string;
  readonly signal: AbortSignal;
}

export type TaskExecutionResult =
  | {
      readonly state: "waiting_user" | "waiting_resource" | "review" | "failed";
      readonly publicMessage?: string;
    }
  | {
      readonly state: "completed";
      readonly verifiedCompletionCriteria: readonly string[];
      readonly publicMessage?: string;
    };

export interface TaskExecutor {
  execute(request: TaskExecutionRequest): Promise<TaskExecutionResult>;
  cancel?(request: {
    readonly taskId: string;
    readonly executionKey: string;
    readonly reason: "cancelled" | "coordinator-closed" | "paused" | "superseded";
  }): Promise<void>;
}

interface TaskServicePort {
  create(input: CreateTaskInput): Promise<TaskDetailV1>;
  get(taskId: string): Promise<TaskDetailV1>;
  list(): Promise<readonly TaskSummaryV1[]>;
  command(input: TaskCommandInput): Promise<TaskDetailV1>;
  appendInput(input: AppendTaskInput): Promise<TaskDetailV1>;
  resolveApproval(input: ResolveTaskApprovalInput): Promise<TaskDetailV1>;
  recordExecution(input: {
    readonly taskId: string;
    readonly idempotencyKey: string;
    readonly state:
      | "queued"
      | "running"
      | "waiting_user"
      | "waiting_resource"
      | "review"
      | "completed"
      | "failed";
    readonly verifiedCompletionCriteria?: readonly string[];
    readonly expectedTaskVersion?: number;
    readonly publicMessage?: string;
  }): Promise<TaskDetailV1>;
  executionHistory(taskId: string): Promise<readonly TaskExecutionRecord[]>;
  executionCycle(taskId: string): Promise<TaskExecutionCycle>;
}

export interface TaskExecutionCoordinatorOptions {
  readonly taskService: TaskServicePort;
  readonly executor: TaskExecutor;
  readonly budget?: TaskBudgetEnforcementPort;
  readonly budgetKindForTask?: (task: TaskDetailV1) => BudgetTaskKind;
  /**
   * Keeps persisted mutations durable but undispatched until start() completes
   * startup reconciliation. Main uses this while Discord and other ingress
   * projections reconcile their durable state.
   */
  readonly deferExecutionUntilStart?: boolean;
  readonly maximumConcurrentTasks?: number;
  readonly maximumAutomaticAttempts?: number;
  readonly retryDelayMs?: number;
}

export type TaskExecutorErrorCode =
  "EXECUTOR_FAILED" | "EXECUTOR_RESULT_INVALID" | "WORKER_OFFLINE" | (string & {});

export class TaskExecutorError extends Error {
  readonly code: TaskExecutorErrorCode;
  readonly retryable: boolean;

  constructor(
    code: TaskExecutorErrorCode,
    message: string,
    retryable = false,
    options?: ErrorOptions,
  ) {
    assertErrorText(code, 160);
    assertErrorText(message, 2_048);
    super(message, options);
    this.name = "TaskExecutorError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type TaskExecutionCoordinatorErrorCode = "EXECUTION_PIPELINE_FAILED";

export class TaskExecutionCoordinatorError extends Error {
  readonly code: TaskExecutionCoordinatorErrorCode;

  constructor(code: TaskExecutionCoordinatorErrorCode, message: string) {
    super(message);
    this.name = "TaskExecutionCoordinatorError";
    this.code = code;
  }
}

interface ActiveExecution {
  readonly controller: AbortController;
  readonly executionKey: string;
  readonly promise: Promise<void>;
}

const DEFAULT_MAXIMUM_CONCURRENT_TASKS = 4;
const DEFAULT_MAXIMUM_AUTOMATIC_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export class TaskExecutionCoordinator {
  readonly #taskService: TaskServicePort;
  readonly #executor: TaskExecutor;
  readonly #budget: TaskBudgetEnforcementPort | undefined;
  readonly #budgetKindForTask: (task: TaskDetailV1) => BudgetTaskKind;
  readonly #maximumConcurrentTasks: number;
  readonly #maximumAutomaticAttempts: number;
  readonly #retryDelayMs: number;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #queued = new Set<string>();
  readonly #queue: string[] = [];
  readonly #pendingBeforeStart = new Set<string>();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #rerunAfterActive = new Set<string>();
  readonly #idleWaiters = new Set<() => void>();
  #drainScheduled = false;
  #executionStarted: boolean;
  #startPromise: Promise<void> | undefined;
  #closed = false;
  #failure: TaskExecutionCoordinatorError | undefined;

  constructor(options: TaskExecutionCoordinatorOptions) {
    if (!isRecord(options)) {
      throw new TypeError("Task execution coordinator options are invalid.");
    }
    assertPositiveSafeInteger(
      options.maximumConcurrentTasks ?? DEFAULT_MAXIMUM_CONCURRENT_TASKS,
      "maximumConcurrentTasks",
    );
    assertPositiveSafeInteger(
      options.maximumAutomaticAttempts ?? DEFAULT_MAXIMUM_AUTOMATIC_ATTEMPTS,
      "maximumAutomaticAttempts",
    );
    assertNonNegativeSafeInteger(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, "retryDelayMs");
    if (
      !isTaskServicePort(options.taskService) ||
      !isTaskExecutor(options.executor) ||
      (options.budget !== undefined && !isTaskBudgetEnforcementPort(options.budget)) ||
      (options.budgetKindForTask !== undefined &&
        typeof options.budgetKindForTask !== "function") ||
      (options.deferExecutionUntilStart !== undefined &&
        typeof options.deferExecutionUntilStart !== "boolean")
    ) {
      throw new TypeError("Task execution coordinator dependencies are invalid.");
    }

    this.#taskService = options.taskService;
    this.#executor = options.executor;
    this.#budget = options.budget;
    this.#budgetKindForTask = options.budgetKindForTask ?? (() => "requested");
    this.#maximumConcurrentTasks =
      options.maximumConcurrentTasks ?? DEFAULT_MAXIMUM_CONCURRENT_TASKS;
    this.#maximumAutomaticAttempts =
      options.maximumAutomaticAttempts ?? DEFAULT_MAXIMUM_AUTOMATIC_ATTEMPTS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#executionStarted = options.deferExecutionUntilStart !== true;
  }

  start(): Promise<void> {
    this.#assertOpen();
    this.#startPromise ??= this.#start().catch((error: unknown) => {
      this.#failExecutionPipeline();
      throw error;
    });
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    const tasks = await this.#taskService.list();
    for (const task of tasks) {
      if (isAutomaticallyExecutableTask(task)) {
        await this.#ensureTaskBudget(await this.#taskService.get(task.taskId));
        this.#enqueue(task.taskId);
      }
    }
    if (!this.#executionStarted) {
      this.#executionStarted = true;
      const pending = [...this.#pendingBeforeStart];
      this.#pendingBeforeStart.clear();
      for (const taskId of pending) {
        this.#enqueue(taskId);
      }
    }
  }

  async create(input: CreateTaskInput): Promise<TaskDetailV1> {
    this.#assertOpen();
    const task = await this.#taskService.create(input);
    await this.#ensureTaskBudget(task);
    if (task.mode === "auto") {
      this.#enqueue(task.taskId);
    }
    return task;
  }

  get(taskId: string): Promise<TaskDetailV1> {
    return this.#taskService.get(taskId);
  }

  list(): Promise<readonly TaskSummaryV1[]> {
    return this.#taskService.list();
  }

  async appendInput(input: AppendTaskInput): Promise<TaskDetailV1> {
    this.#assertOpen();
    const task = await this.#taskService.appendInput(input);
    if (this.#active.has(task.taskId)) {
      await this.#abort(task.taskId, "superseded");
    }
    if (task.mode === "auto" && isAutomaticallyExecutable(task.state)) {
      this.#enqueue(task.taskId);
    }
    return task;
  }

  async resolveApproval(input: ResolveTaskApprovalInput): Promise<TaskDetailV1> {
    this.#assertOpen();
    const task = await this.#taskService.resolveApproval(input);
    if (input.decision === "approve") {
      this.#enqueue(task.taskId);
    } else {
      await this.#abort(task.taskId, "cancelled");
    }
    return task;
  }

  async command(input: TaskCommandInput): Promise<TaskDetailV1> {
    this.#assertOpen();
    const task = await this.#taskService.command(input);
    switch (input.command) {
      case "pause":
        await this.#abort(task.taskId, "paused");
        break;
      case "cancel":
        await this.#abort(task.taskId, "cancelled");
        break;
      case "resume":
      case "retry":
        this.#enqueue(task.taskId);
        break;
    }
    return task;
  }

  async waitForIdle(): Promise<void> {
    if (!this.#isIdle()) {
      await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
    }
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#queue.length = 0;
    this.#queued.clear();
    this.#pendingBeforeStart.clear();
    this.#rerunAfterActive.clear();
    for (const timer of this.#retryTimers.values()) {
      clearTimeout(timer);
    }
    this.#retryTimers.clear();

    const active = [...this.#active.entries()];
    await Promise.all(
      active.map(async ([taskId, execution]) => {
        execution.controller.abort("coordinator-closed");
        await this.#invokeCancellation(taskId, execution.executionKey, "coordinator-closed");
      }),
    );
    await Promise.allSettled(active.map(([, execution]) => execution.promise));
    this.#notifyIdle();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("The Task execution coordinator is closed.");
    }
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }

  #enqueue(taskId: string): void {
    if (this.#closed || this.#failure !== undefined) {
      return;
    }
    if (!this.#executionStarted) {
      this.#pendingBeforeStart.add(taskId);
      return;
    }
    if (this.#queued.has(taskId) || this.#retryTimers.has(taskId)) {
      return;
    }
    if (this.#active.has(taskId)) {
      this.#rerunAfterActive.add(taskId);
      return;
    }
    this.#queued.add(taskId);
    this.#queue.push(taskId);
    this.#scheduleDrain();
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled || this.#closed || this.#failure !== undefined) {
      return;
    }
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#closed || this.#failure !== undefined) {
      this.#queue.length = 0;
      this.#queued.clear();
      this.#notifyIdle();
      return;
    }
    while (this.#active.size < this.#maximumConcurrentTasks && this.#queue.length > 0) {
      const taskId = this.#queue.shift();
      if (taskId === undefined) {
        break;
      }
      this.#queued.delete(taskId);
      this.#startExecution(taskId);
    }
    this.#notifyIdle();
  }

  #startExecution(taskId: string): void {
    const controller = new AbortController();
    let retry = false;
    let executionKey = `task-execution:${taskId}:pending`;
    const promise = this.#execute(taskId, controller.signal, (key) => {
      executionKey = key;
    })
      .then((shouldRetry) => {
        retry = shouldRetry;
      })
      .catch(() => {
        this.#failExecutionPipeline();
      })
      .finally(() => {
        this.#active.delete(taskId);
        const rerun = this.#rerunAfterActive.delete(taskId);
        if (rerun && !this.#closed) {
          this.#enqueue(taskId);
        } else if (retry && !this.#closed) {
          this.#scheduleRetry(taskId);
        }
        this.#scheduleDrain();
        this.#notifyIdle();
      });
    this.#active.set(taskId, {
      controller,
      get executionKey() {
        return executionKey;
      },
      promise,
    });
  }

  async #execute(
    taskId: string,
    signal: AbortSignal,
    setExecutionKey: (executionKey: string) => void,
  ): Promise<boolean> {
    let task = await this.#taskService.get(taskId);
    if (!isAutomaticallyExecutable(task.state)) {
      return false;
    }
    const cycle = await this.#taskService.executionCycle(taskId);
    const runningRecords = cycle.records.filter((record) => record.state === "running");
    const resumesInterruptedAttempt = task.state === "running" && runningRecords.length > 0;
    const attempt = resumesInterruptedAttempt ? runningRecords.length : runningRecords.length + 1;
    const executionKey = `task-execution:${taskId}:cycle:${cycle.cycleId}:attempt:${attempt}`;
    setExecutionKey(executionKey);

    if (attempt > this.#maximumAutomaticAttempts) {
      await this.#recordUnlessSuperseded({
        taskId,
        idempotencyKey: `${executionKey}:attempt-limit`,
        state: "failed",
        expectedTaskVersion: task.version,
        publicMessage: latestPublicMessage(cycle.records) ?? exhaustedResourceMessage(attempt - 1),
      });
      return false;
    }

    let budgetGuard: TaskBudgetExecutionGuard | undefined;
    if (this.#budget !== undefined) {
      try {
        budgetGuard = await this.#budget.beginTaskExecution({
          taskId,
          executionKey,
          attempt,
          signal,
        });
      } catch (error) {
        if (error instanceof BudgetHardLimitError) {
          await this.#recordBudgetExhaustion(task, executionKey, error);
          return false;
        }
        throw error;
      }
    }

    try {
      if (!resumesInterruptedAttempt) {
        const recorded = await this.#recordUnlessSuperseded({
          taskId,
          idempotencyKey: `${executionKey}:running`,
          state: "running",
          expectedTaskVersion: task.version,
        });
        if (recorded === undefined) {
          return false;
        }
        task = recorded;
      }

      const result = validateExecutionResult(
        await this.#executor.execute({
          task,
          attempt,
          executionKey,
          signal: budgetGuard?.signal ?? signal,
        }),
      );
      const budgetExhaustion = budgetGuard?.exhaustion();
      if (budgetExhaustion !== undefined) {
        await this.#recordBudgetExhaustion(
          task,
          executionKey,
          new BudgetHardLimitError({
            taskId,
            metric: budgetExhaustion.metric,
            current: budgetExhaustion.current,
            hard: budgetExhaustion.hard,
            attempted: budgetExhaustion.attempted,
            ...(budgetExhaustion.workOrderId === undefined
              ? {}
              : { workOrderId: budgetExhaustion.workOrderId }),
          }),
        );
        return false;
      }
      if (signal.aborted) {
        return false;
      }
      if (result.state === "completed") {
        await this.#recordUnlessSuperseded({
          taskId,
          idempotencyKey: `${executionKey}:completed`,
          state: "completed",
          verifiedCompletionCriteria: result.verifiedCompletionCriteria,
          expectedTaskVersion: task.version,
          ...(result.publicMessage === undefined ? {} : { publicMessage: result.publicMessage }),
        });
        return false;
      }

      if (result.state === "waiting_resource" && attempt >= this.#maximumAutomaticAttempts) {
        await this.#recordUnlessSuperseded({
          taskId,
          idempotencyKey: `${executionKey}:attempt-limit`,
          state: "failed",
          expectedTaskVersion: task.version,
          publicMessage: result.publicMessage ?? exhaustedResourceMessage(attempt),
        });
        return false;
      }
      await this.#recordUnlessSuperseded({
        taskId,
        idempotencyKey: `${executionKey}:${result.state}`,
        state: result.state,
        expectedTaskVersion: task.version,
        ...(result.publicMessage === undefined
          ? result.state === "failed"
            ? { publicMessage: missingFailureExplanationMessage() }
            : {}
          : { publicMessage: result.publicMessage }),
      });
      return result.state === "waiting_resource";
    } catch (error) {
      if (error instanceof TaskExecutorError && error.code === "WORKER_CANCELLATION_FAILED") {
        throw error;
      }
      if (error instanceof BudgetHardLimitError) {
        await this.#recordBudgetExhaustion(task, executionKey, error);
        return false;
      }
      const budgetExhaustion = budgetGuard?.exhaustion();
      if (budgetExhaustion !== undefined) {
        await this.#recordBudgetExhaustion(
          task,
          executionKey,
          new BudgetHardLimitError({
            taskId,
            metric: budgetExhaustion.metric,
            current: budgetExhaustion.current,
            hard: budgetExhaustion.hard,
            attempted: budgetExhaustion.attempted,
            ...(budgetExhaustion.workOrderId === undefined
              ? {}
              : { workOrderId: budgetExhaustion.workOrderId }),
          }),
        );
        return false;
      }
      if (signal.aborted) {
        return false;
      }
      const executorError =
        error instanceof TaskExecutorError
          ? error
          : new TaskExecutorError(
              "EXECUTOR_FAILED",
              "The Task executor failed without a structured result.",
              true,
            );
      const willRetry = executorError.retryable && attempt < this.#maximumAutomaticAttempts;
      await this.#recordUnlessSuperseded({
        taskId,
        idempotencyKey: `${executionKey}:${willRetry ? "waiting-resource" : "failed"}`,
        state: willRetry ? "waiting_resource" : "failed",
        expectedTaskVersion: task.version,
        publicMessage: executorFailureMessage(executorError, willRetry),
      });
      return willRetry;
    } finally {
      await budgetGuard?.close();
    }
  }

  async #ensureTaskBudget(task: TaskDetailV1): Promise<void> {
    if (this.#budget === undefined) {
      return;
    }
    const kind = this.#budgetKindForTask(task);
    if (kind !== "requested" && kind !== "autonomous") {
      throw new TypeError("Task Budget kind selector returned an invalid value.");
    }
    await this.#budget.ensureTask({
      taskId: task.taskId,
      kind,
    });
  }

  async #recordBudgetExhaustion(
    task: TaskDetailV1,
    executionKey: string,
    error: BudgetHardLimitError,
  ): Promise<void> {
    await this.#invokeCancellation(task.taskId, executionKey, "paused");
    await this.#recordUnlessSuperseded({
      taskId: task.taskId,
      idempotencyKey: `${executionKey}:budget:${error.metric}:hard-limit`,
      state: "waiting_user",
      expectedTaskVersion: task.version,
      publicMessage: `OpenDelegate paused new automatic work because the ${error.metric} hard Budget is exhausted. An owner-authorized Budget extension is required to continue.`,
    });
  }

  async #recordUnlessSuperseded(
    input: Parameters<TaskServicePort["recordExecution"]>[0],
  ): Promise<TaskDetailV1 | undefined> {
    try {
      return await this.#taskService.recordExecution(input);
    } catch (error) {
      if (isPotentialSupersession(error)) {
        const current = await this.#taskService.get(input.taskId);
        if (
          current.state === "paused" ||
          current.state === "cancelled" ||
          (input.expectedTaskVersion !== undefined && current.version !== input.expectedTaskVersion)
        ) {
          return undefined;
        }
      }
      throw error;
    }
  }

  #scheduleRetry(taskId: string): void {
    if (this.#closed || this.#retryTimers.has(taskId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.#retryTimers.delete(taskId);
      this.#enqueue(taskId);
      this.#notifyIdle();
    }, this.#retryDelayMs);
    this.#retryTimers.set(taskId, timer);
  }

  async #abort(taskId: string, reason: "cancelled" | "paused" | "superseded"): Promise<void> {
    this.#pendingBeforeStart.delete(taskId);
    const timer = this.#retryTimers.get(taskId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#retryTimers.delete(taskId);
    }
    if (this.#queued.delete(taskId)) {
      const index = this.#queue.indexOf(taskId);
      if (index >= 0) {
        this.#queue.splice(index, 1);
      }
    }
    if (reason !== "superseded") {
      this.#rerunAfterActive.delete(taskId);
    }
    const active = this.#active.get(taskId);
    if (active !== undefined) {
      active.controller.abort(reason);
      await this.#invokeCancellation(taskId, active.executionKey, reason);
    }
    this.#notifyIdle();
  }

  async #invokeCancellation(
    taskId: string,
    executionKey: string,
    reason: "cancelled" | "coordinator-closed" | "paused" | "superseded",
  ): Promise<void> {
    if (this.#executor.cancel === undefined) {
      return;
    }
    try {
      await this.#executor.cancel({ taskId, executionKey, reason });
    } catch {
      // The durable Task state remains authoritative even if best-effort adapter cancellation fails.
    }
  }

  #isIdle(): boolean {
    return (
      !this.#drainScheduled &&
      this.#pendingBeforeStart.size === 0 &&
      this.#queue.length === 0 &&
      this.#active.size === 0 &&
      this.#retryTimers.size === 0
    );
  }

  #notifyIdle(): void {
    if (!this.#isIdle()) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }

  #failExecutionPipeline(): void {
    this.#failure ??= new TaskExecutionCoordinatorError(
      "EXECUTION_PIPELINE_FAILED",
      "The Task execution pipeline could not persist a durable state transition.",
    );
    this.#queue.length = 0;
    this.#queued.clear();
    this.#pendingBeforeStart.clear();
    this.#rerunAfterActive.clear();
    for (const timer of this.#retryTimers.values()) {
      clearTimeout(timer);
    }
    this.#retryTimers.clear();
    for (const execution of this.#active.values()) {
      execution.controller.abort();
    }
    this.#notifyIdle();
  }
}

function latestPublicMessage(records: readonly TaskExecutionRecord[]): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const message = records[index]?.publicMessage;
    if (message !== null && message !== undefined) {
      return message;
    }
  }
  return undefined;
}

function exhaustedResourceMessage(attempts: number): string {
  return `OpenDelegate could not find an eligible Device, route, Secret, or lock after ${attempts.toString()} automatic attempts. Check Device health and Runs, then retry.`;
}

function executorFailureMessage(error: TaskExecutorError, willRetry: boolean): string {
  const retryStatus = willRetry
    ? "OpenDelegate will retry automatically."
    : "Automatic retries are exhausted. Check the Task Runs, then retry.";
  return `${error.message} ${retryStatus} Failure code: ${error.code}.`;
}

function missingFailureExplanationMessage(): string {
  return "The Task executor reported failure without an owner-safe explanation. Inspect the Task Runs for the failing step, then retry.";
}

function isAutomaticallyExecutable(state: TaskSummaryV1["state"]): boolean {
  return (
    state === "intake" || state === "queued" || state === "running" || state === "waiting_resource"
  );
}

function isAutomaticallyExecutableTask(task: TaskSummaryV1): boolean {
  return task.mode === "auto" && isAutomaticallyExecutable(task.state);
}

function validateExecutionResult(value: unknown): TaskExecutionResult {
  if (!isRecord(value) || typeof value.state !== "string") {
    throw new TaskExecutorError(
      "EXECUTOR_RESULT_INVALID",
      "The Task executor returned an invalid result.",
    );
  }
  if (value.state === "completed") {
    if (
      !hasAllowedAndRequiredKeys(
        value,
        ["state", "verifiedCompletionCriteria", "publicMessage"],
        ["state", "verifiedCompletionCriteria"],
      ) ||
      !isUniqueTextArray(value.verifiedCompletionCriteria)
    ) {
      throw new TaskExecutorError(
        "EXECUTOR_RESULT_INVALID",
        "The Task executor returned an invalid completion result.",
      );
    }
    return Object.freeze({
      state: "completed",
      verifiedCompletionCriteria: Object.freeze([...value.verifiedCompletionCriteria]),
      ...(value.publicMessage === undefined
        ? {}
        : { publicMessage: requirePublicMessage(value.publicMessage) }),
    });
  }
  if (
    (value.state === "waiting_user" ||
      value.state === "waiting_resource" ||
      value.state === "review" ||
      value.state === "failed") &&
    hasAllowedAndRequiredKeys(value, ["state", "publicMessage"], ["state"])
  ) {
    return Object.freeze({
      state: value.state,
      ...(value.publicMessage === undefined
        ? {}
        : { publicMessage: requirePublicMessage(value.publicMessage) }),
    });
  }
  throw new TaskExecutorError(
    "EXECUTOR_RESULT_INVALID",
    "The Task executor returned an unsupported result.",
  );
}

function isTaskServicePort(value: unknown): value is TaskServicePort {
  if (!isRecord(value)) {
    return false;
  }
  return [
    "create",
    "get",
    "list",
    "command",
    "appendInput",
    "resolveApproval",
    "recordExecution",
    "executionHistory",
    "executionCycle",
  ].every((method) => typeof value[method] === "function");
}

function isTaskExecutor(value: unknown): value is TaskExecutor {
  return isRecord(value) && typeof value.execute === "function";
}

function isTaskBudgetEnforcementPort(value: unknown): value is TaskBudgetEnforcementPort {
  return (
    isRecord(value) &&
    [
      "ensureTask",
      "beginTaskExecution",
      "registerWorkOrders",
      "beginNativeTurn",
      "beginWorkerRun",
      "finishWorkerRun",
      "recordActivity",
    ].every((method) => typeof value[method] === "function")
  );
}

function isPotentialSupersession(value: unknown): value is TaskServiceError {
  return (
    value instanceof Error &&
    "code" in value &&
    ((value as { readonly code?: unknown }).code === "TRANSITION_INVALID" ||
      (value as { readonly code?: unknown }).code === "STORAGE_CONFLICT")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAllowedAndRequiredKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function requirePublicMessage(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 32_768 ||
    value.includes("\u0000")
  ) {
    throw new TaskExecutorError(
      "EXECUTOR_RESULT_INVALID",
      "The Task executor returned an invalid public message.",
    );
  }
  return value;
}

function isUniqueTextArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function assertErrorText(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    throw new TypeError("Task executor error text is invalid.");
  }
}
