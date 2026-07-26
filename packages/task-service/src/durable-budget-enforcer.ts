import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  Budget,
  BudgetId,
  DomainError,
  type BudgetAuthority,
  type BudgetLimit,
  type BudgetLimits,
  type BudgetMetric,
} from "@opendelegate/domain";
import { EventStoreError, type EventStore, type StoredEvent } from "@opendelegate/event-store";
import type { WorkOrderV1 } from "@opendelegate/protocol";

const MAXIMUM_DATE_MS = 8_640_000_000_000_000;
export const TASK_BUDGET_EXHAUSTED_ABORT_REASON = Object.freeze({
  code: "TASK_BUDGET_EXHAUSTED",
});
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;
const MAXIMUM_OPERATION_ID_BYTES = 1_024;
const MAXIMUM_TASK_ID_BYTES = 512;
const MAXIMUM_WORK_ORDERS_PER_MUTATION = 256;

const budgetMetrics = [
  "wallTimeMs",
  "idleTimeMs",
  "retries",
  "childWorkOrders",
  "concurrentRuns",
  "nativeTurns",
  "tokens",
  "costUsdMicros",
] as const satisfies readonly BudgetMetric[];

const measuredTimeMetrics = new Set<BudgetMetric>(["wallTimeMs", "idleTimeMs"]);

export const DEFAULT_INSTANCE_BUDGET_LIMITS: Readonly<BudgetLimits> = freezeLimits({
  wallTimeMs: { soft: 21 * 60 * 60_000, hard: 24 * 60 * 60_000 },
  idleTimeMs: { soft: 25 * 60_000, hard: 30 * 60_000 },
  retries: { soft: 2, hard: 3 },
  childWorkOrders: { soft: 24, hard: 32 },
  concurrentRuns: { soft: 3, hard: 4 },
  nativeTurns: { soft: 48, hard: 64 },
  tokens: { soft: 1_500_000, hard: 2_000_000 },
  costUsdMicros: { soft: 40_000_000, hard: 50_000_000 },
});

export const DEFAULT_REQUESTED_TASK_BUDGET_LIMITS: Readonly<BudgetLimits> = freezeLimits({
  ...DEFAULT_INSTANCE_BUDGET_LIMITS,
});

export const DEFAULT_AUTONOMOUS_TASK_BUDGET_LIMITS: Readonly<BudgetLimits> = freezeLimits({
  wallTimeMs: { soft: 45 * 60_000, hard: 60 * 60_000 },
  idleTimeMs: { soft: 8 * 60_000, hard: 10 * 60_000 },
  retries: { soft: 1, hard: 2 },
  childWorkOrders: { soft: 6, hard: 8 },
  concurrentRuns: { soft: 1, hard: 2 },
  nativeTurns: { soft: 12, hard: 16 },
  tokens: { soft: 200_000, hard: 250_000 },
  costUsdMicros: { soft: 4_000_000, hard: 5_000_000 },
});

export const DEFAULT_PROVIDER_USAGE_PROXY = Object.freeze({
  tokensPerNativeTurn: 8_192,
  costUsdMicrosPerNativeTurn: 250_000,
});

export type BudgetTaskKind = "autonomous" | "requested";

export interface TaskBudgetClock {
  now(): number;
}

export interface ProviderUsageEvidence {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costUsdMicros?: number;
}

export interface ProviderUsageProxy {
  readonly tokensPerNativeTurn: number;
  readonly costUsdMicrosPerNativeTurn: number;
}

export interface DurableTaskBudgetEnforcerOptions {
  readonly eventStore: EventStore;
  readonly clock: TaskBudgetClock;
  /**
   * Instance limits are ceilings inherited by each Task, rather than a lifetime
   * Instance spend counter. A durable default change creates new Task Budgets;
   * existing Task Budgets change only through an owner-authorized extension.
   */
  readonly instanceLimits: BudgetLimits;
  readonly requestedTaskDefaults: BudgetLimits;
  readonly autonomousTaskDefaults: BudgetLimits;
  readonly usageProxy: ProviderUsageProxy;
}

export interface BudgetLimitEvent {
  readonly eventId: string;
  readonly metric: BudgetMetric;
  readonly state: "hard-limit" | "soft-limit";
  readonly current: number;
  readonly hard: number;
  readonly attempted: number;
  readonly occurredAtMs: number;
  readonly source: string;
  readonly workOrderId?: string;
}

export interface BudgetExtensionEvent {
  readonly eventId: string;
  readonly baseRevision: number;
  readonly revision: number;
  readonly occurredAtMs: number;
  readonly ownerId: string;
  readonly limits: Readonly<BudgetLimits>;
}

export interface WorkOrderBudgetSnapshot {
  readonly workOrderId: string;
  readonly limits: Readonly<BudgetLimits>;
  readonly usage: Readonly<Partial<Record<BudgetMetric, number>>>;
}

export interface TaskBudgetSnapshot {
  readonly taskId: string;
  readonly kind: BudgetTaskKind;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
  readonly limits: Readonly<BudgetLimits>;
  readonly usage: Readonly<Partial<Record<BudgetMetric, number>>>;
  readonly workOrders: readonly WorkOrderBudgetSnapshot[];
  readonly activeRunIds: readonly string[];
  readonly limitEvents: readonly BudgetLimitEvent[];
  readonly extensions: readonly BudgetExtensionEvent[];
}

export interface TaskBudgetExecutionGuard {
  readonly signal: AbortSignal;
  exhaustion(): BudgetLimitEvent | undefined;
  close(): Promise<void>;
}

export interface TaskBudgetEnforcementPort {
  ensureTask(input: {
    readonly taskId: string;
    readonly kind: BudgetTaskKind;
  }): Promise<TaskBudgetSnapshot>;
  beginTaskExecution(input: {
    readonly taskId: string;
    readonly executionKey: string;
    readonly attempt: number;
    readonly signal: AbortSignal;
  }): Promise<TaskBudgetExecutionGuard>;
  registerWorkOrders(input: {
    readonly taskId: string;
    readonly operationId: string;
    readonly workOrders: readonly WorkOrderV1[];
  }): Promise<TaskBudgetSnapshot>;
  beginNativeTurn(input: {
    readonly taskId: string;
    readonly operationId: string;
    readonly source: "main-planner" | "main-verifier";
  }): Promise<TaskBudgetSnapshot>;
  beginWorkerRun(input: {
    readonly taskId: string;
    readonly workOrderId: string;
    readonly runId: string;
    readonly attempt: number;
  }): Promise<TaskBudgetSnapshot>;
  finishWorkerRun(input: {
    readonly taskId: string;
    readonly workOrderId: string;
    readonly runId: string;
    readonly usage?: ProviderUsageEvidence;
  }): Promise<TaskBudgetSnapshot>;
  recordActivity(input: {
    readonly taskId: string;
    readonly operationId: string;
    readonly source: string;
    readonly workOrderId?: string;
  }): Promise<TaskBudgetSnapshot>;
}

export interface TaskBudgetAdministrationPort extends TaskBudgetEnforcementPort {
  snapshot(taskId: string): Promise<TaskBudgetSnapshot>;
  extendTask(input: {
    readonly taskId: string;
    readonly operationId: string;
    readonly baseRevision: number;
    readonly authority: BudgetAuthority;
    readonly limits: BudgetLimits;
  }): Promise<TaskBudgetSnapshot>;
}

export type TaskBudgetServiceErrorCode =
  | "BUDGET_IDEMPOTENCY_CONFLICT"
  | "BUDGET_JOURNAL_CORRUPT"
  | "BUDGET_NOT_FOUND"
  | "BUDGET_STORAGE_UNAVAILABLE";

export class TaskBudgetServiceError extends Error {
  public readonly code: TaskBudgetServiceErrorCode;

  public constructor(code: TaskBudgetServiceErrorCode, message: string) {
    super(message);
    this.name = "TaskBudgetServiceError";
    this.code = code;
  }
}

export class BudgetHardLimitError extends Error {
  public readonly code = "BUDGET_HARD_LIMIT_REACHED" as const;
  public readonly taskId: string;
  public readonly metric: BudgetMetric;
  public readonly current: number;
  public readonly hard: number;
  public readonly attempted: number;
  public readonly workOrderId: string | undefined;

  public constructor(input: {
    readonly taskId: string;
    readonly metric: BudgetMetric;
    readonly current: number;
    readonly hard: number;
    readonly attempted: number;
    readonly workOrderId?: string;
  }) {
    super(
      `The ${input.metric} hard Budget for Task ${input.taskId} is exhausted; owner-authorized extension is required before new work.`,
    );
    this.name = "BudgetHardLimitError";
    this.taskId = input.taskId;
    this.metric = input.metric;
    this.current = input.current;
    this.hard = input.hard;
    this.attempted = input.attempted;
    this.workOrderId = input.workOrderId;
  }
}

interface CreatedPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly kind: BudgetTaskKind;
  readonly createdAtMs: number;
  readonly limits: BudgetLimits;
  readonly usageProxy: ProviderUsageProxy;
}

interface PersistedWorkOrderBudget {
  readonly workOrderId: string;
  readonly limits: BudgetLimits;
}

interface RunStart {
  readonly runId: string;
  readonly workOrderId: string;
  readonly proxyTokens: number;
  readonly proxyCostUsdMicros: number;
}

interface RunFinish {
  readonly runId: string;
  readonly workOrderId: string;
}

interface ExtensionRecord {
  readonly baseRevision: number;
  readonly ownerId: string;
  readonly limits: BudgetLimits;
}

interface MutationPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly operationDigest: string;
  readonly operationFingerprint: string;
  readonly occurredAtMs: number;
  readonly source: string;
  readonly usageDelta: Partial<Record<BudgetMetric, number>>;
  readonly workOrderUsageDelta: Partial<Record<BudgetMetric, number>>;
  readonly workOrderId: string | null;
  readonly registeredWorkOrders: readonly PersistedWorkOrderBudget[];
  readonly activityAtMs: number | null;
  readonly runStart: RunStart | null;
  readonly runFinish: RunFinish | null;
  readonly extension: ExtensionRecord | null;
  readonly limitEvent: Omit<BudgetLimitEvent, "eventId"> | null;
}

interface MutableWorkOrderBudget {
  readonly workOrderId: string;
  limits: BudgetLimits;
  readonly createdAtMs: number;
  lastActivityAtMs: number;
  readonly usage: Partial<Record<BudgetMetric, number>>;
}

interface ActiveRun {
  readonly runId: string;
  readonly workOrderId: string;
  readonly proxyTokens: number;
  readonly proxyCostUsdMicros: number;
}

interface ProjectedBudget {
  readonly version: number;
  readonly taskId: string;
  readonly kind: BudgetTaskKind;
  revision: number;
  readonly createdAtMs: number;
  lastActivityAtMs: number;
  readonly initialLimits: BudgetLimits;
  limits: BudgetLimits;
  readonly usageProxy: ProviderUsageProxy;
  readonly usage: Partial<Record<BudgetMetric, number>>;
  readonly workOrders: Map<string, MutableWorkOrderBudget>;
  readonly activeRuns: Map<string, ActiveRun>;
  readonly operations: Map<string, string>;
  readonly limitEvents: BudgetLimitEvent[];
  readonly extensions: BudgetExtensionEvent[];
}

interface MutationDraft {
  readonly operationId: string;
  readonly source: string;
  readonly usageDelta?: Partial<Record<BudgetMetric, number>>;
  readonly workOrderUsageDelta?: Partial<Record<BudgetMetric, number>>;
  readonly workOrderId?: string;
  readonly registeredWorkOrders?: readonly PersistedWorkOrderBudget[];
  readonly activityAtMs?: number;
  readonly runStart?: RunStart;
  readonly runFinish?: RunFinish;
  readonly extension?: ExtensionRecord;
}

interface GuardControl {
  readonly taskId: string;
  readonly controller: AbortController;
  readonly upstreamSignal: AbortSignal;
  readonly upstreamAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  exhaustion?: BudgetLimitEvent;
  closed: boolean;
  scheduling: boolean;
  refreshRequested: boolean;
}

export class DurableTaskBudgetEnforcer implements TaskBudgetAdministrationPort {
  readonly #eventStore: EventStore;
  readonly #clock: TaskBudgetClock;
  readonly #instanceLimits: BudgetLimits;
  readonly #requestedTaskDefaults: BudgetLimits;
  readonly #autonomousTaskDefaults: BudgetLimits;
  readonly #usageProxy: ProviderUsageProxy;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #guards = new Map<string, Set<GuardControl>>();

  public constructor(options: DurableTaskBudgetEnforcerOptions) {
    if (
      !isRecord(options) ||
      !hasMethods(options.eventStore, ["append", "readStream"]) ||
      !isRecord(options.clock) ||
      typeof options.clock.now !== "function"
    ) {
      throw new TypeError("Durable Task Budget dependencies are invalid.");
    }
    this.#instanceLimits = validateCompleteLimits(options.instanceLimits, "Instance");
    this.#requestedTaskDefaults = validateInheritedDefaults(
      options.requestedTaskDefaults,
      this.#instanceLimits,
      "requested Task",
    );
    this.#autonomousTaskDefaults = validateInheritedDefaults(
      options.autonomousTaskDefaults,
      this.#instanceLimits,
      "Autonomous Task",
    );
    this.#usageProxy = validateUsageProxy(options.usageProxy);
    this.#eventStore = options.eventStore;
    this.#clock = options.clock;
  }

  public async ensureTask(input: {
    readonly taskId: string;
    readonly kind: BudgetTaskKind;
  }): Promise<TaskBudgetSnapshot> {
    assertTaskId(input.taskId);
    if (input.kind !== "requested" && input.kind !== "autonomous") {
      throw new TypeError("Task Budget kind is invalid.");
    }
    return this.#withLock(input.taskId, async () => {
      let state = await this.#loadOptional(input.taskId);
      if (state === undefined) {
        const now = this.#now();
        const limits =
          input.kind === "autonomous" ? this.#autonomousTaskDefaults : this.#requestedTaskDefaults;
        const payload: CreatedPayload = {
          schemaVersion: 1,
          taskId: input.taskId,
          kind: input.kind,
          createdAtMs: now,
          limits: cloneLimits(limits),
          usageProxy: { ...this.#usageProxy },
        };
        try {
          await this.#eventStore.append({
            streamId: budgetStreamId(input.taskId),
            expectedVersion: 0,
            occurredAt: new Date(now).toISOString(),
            events: [
              {
                eventId: `event_budget_created_${digest(input.taskId)}`,
                type: "task.budget-created",
                payload,
              },
            ],
          });
        } catch (error) {
          if (!(error instanceof EventStoreError)) {
            throw error;
          }
          if (error.code !== "STREAM_VERSION_CONFLICT" && error.code !== "EVENT_ID_CONFLICT") {
            throw budgetStorageFailed();
          }
        }
        state = await this.#loadRequired(input.taskId);
      }
      if (
        state.kind !== input.kind ||
        !isDeepStrictEqual(
          state.initialLimits,
          input.kind === "autonomous" ? this.#autonomousTaskDefaults : this.#requestedTaskDefaults,
        )
      ) {
        throw new Error(
          "The durable Task Budget already exists with different immutable defaults.",
        );
      }
      return this.#snapshot(state);
    });
  }

  public async beginTaskExecution(input: {
    readonly taskId: string;
    readonly executionKey: string;
    readonly attempt: number;
    readonly signal: AbortSignal;
  }): Promise<TaskBudgetExecutionGuard> {
    assertTaskId(input.taskId);
    assertOperationId(input.executionKey);
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new TypeError("Task execution attempt is invalid.");
    }
    if (!(input.signal instanceof AbortSignal)) {
      throw new TypeError("Task execution AbortSignal is invalid.");
    }
    await this.#mutate(input.taskId, {
      operationId: `task-execution:${input.executionKey}`,
      source: "task-execution",
      usageDelta: input.attempt > 1 ? { retries: 1 } : {},
      activityAtMs: this.#now(),
    });
    return this.#createGuard(input.taskId, input.signal);
  }

  public async registerWorkOrders(input: {
    readonly taskId: string;
    readonly operationId: string;
    readonly workOrders: readonly WorkOrderV1[];
  }): Promise<TaskBudgetSnapshot> {
    assertTaskId(input.taskId);
    assertOperationId(input.operationId);
    if (
      !Array.isArray(input.workOrders) ||
      input.workOrders.length === 0 ||
      input.workOrders.length > MAXIMUM_WORK_ORDERS_PER_MUTATION
    ) {
      throw new TypeError("The Work Order Budget registration is invalid.");
    }
    return this.#withLock(input.taskId, async () => {
      const state = await this.#loadRequired(input.taskId);
      const operationFingerprint = fingerprint({
        operationId: `work-order-plan:${input.operationId}`,
        taskId: input.taskId,
        workOrders: input.workOrders.map((workOrder) => ({
          workOrderId: workOrder.workOrderId,
          budgetLimits: readWorkOrderBudgetLimits(workOrder),
        })),
      });
      const existingOperation = state.operations.get(
        digest(`work-order-plan:${input.operationId}`),
      );
      if (existingOperation !== undefined) {
        if (existingOperation !== operationFingerprint) {
          throw idempotencyConflict();
        }
        return this.#snapshot(state);
      }
      const registeredWorkOrders: PersistedWorkOrderBudget[] = [];
      const seen = new Set<string>();
      for (const workOrder of input.workOrders) {
        assertWorkOrderId(workOrder.workOrderId);
        if (seen.has(workOrder.workOrderId)) {
          throw new TypeError("Work Order Budget registrations must be unique.");
        }
        seen.add(workOrder.workOrderId);
        const existing = state.workOrders.get(workOrder.workOrderId);
        const requested = readWorkOrderBudgetLimits(workOrder);
        if (existing !== undefined) {
          for (const metric of budgetMetrics) {
            const requestedLimit = requested[metric];
            if (
              requestedLimit !== undefined &&
              !isDeepStrictEqual(existing.limits[metric], requestedLimit)
            ) {
              throw new Error("A Work Order ID was reused with a different Budget.");
            }
          }
          continue;
        }
        const effective = effectiveChildLimits(state.limits, requested, workOrder.workOrderId);
        registeredWorkOrders.push({
          workOrderId: workOrder.workOrderId,
          limits: effective,
        });
      }
      return this.#mutateLocked(
        state,
        {
          operationId: `work-order-plan:${input.operationId}`,
          source: "work-order-plan",
          usageDelta: { childWorkOrders: registeredWorkOrders.length },
          registeredWorkOrders,
          activityAtMs: this.#now(),
        },
        false,
        operationFingerprint,
      );
    });
  }

  public beginNativeTurn(input: {
    readonly taskId: string;
    readonly operationId: string;
    readonly source: "main-planner" | "main-verifier";
  }): Promise<TaskBudgetSnapshot> {
    assertTaskId(input.taskId);
    assertOperationId(input.operationId);
    if (input.source !== "main-planner" && input.source !== "main-verifier") {
      throw new TypeError("Native turn Budget source is invalid.");
    }
    return this.#withLock(input.taskId, async () => {
      const state = await this.#loadRequired(input.taskId);
      return this.#mutateLocked(state, {
        operationId: `native-turn:${input.operationId}`,
        source: input.source,
        usageDelta: {
          nativeTurns: 1,
          tokens: state.usageProxy.tokensPerNativeTurn,
          costUsdMicros: state.usageProxy.costUsdMicrosPerNativeTurn,
        },
        activityAtMs: this.#now(),
      });
    });
  }

  public beginWorkerRun(input: {
    readonly taskId: string;
    readonly workOrderId: string;
    readonly runId: string;
    readonly attempt: number;
  }): Promise<TaskBudgetSnapshot> {
    assertTaskId(input.taskId);
    assertWorkOrderId(input.workOrderId);
    assertOperationId(input.runId);
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new TypeError("Worker Run Budget attempt is invalid.");
    }
    return this.#withLock(input.taskId, async () => {
      const state = await this.#loadRequired(input.taskId);
      return this.#mutateLocked(state, {
        operationId: `worker-run-start:${input.runId}`,
        source: "worker-run-start",
        usageDelta: {
          concurrentRuns: 1,
          nativeTurns: 1,
          tokens: state.usageProxy.tokensPerNativeTurn,
          costUsdMicros: state.usageProxy.costUsdMicrosPerNativeTurn,
        },
        workOrderUsageDelta: {
          concurrentRuns: 1,
          ...(input.attempt > 1 ? { retries: 1 } : {}),
          nativeTurns: 1,
          tokens: state.usageProxy.tokensPerNativeTurn,
          costUsdMicros: state.usageProxy.costUsdMicrosPerNativeTurn,
        },
        workOrderId: input.workOrderId,
        runStart: {
          runId: input.runId,
          workOrderId: input.workOrderId,
          proxyTokens: state.usageProxy.tokensPerNativeTurn,
          proxyCostUsdMicros: state.usageProxy.costUsdMicrosPerNativeTurn,
        },
        activityAtMs: this.#now(),
      });
    });
  }

  public async finishWorkerRun(input: {
    readonly taskId: string;
    readonly workOrderId: string;
    readonly runId: string;
    readonly usage?: ProviderUsageEvidence;
  }): Promise<TaskBudgetSnapshot> {
    assertTaskId(input.taskId);
    assertWorkOrderId(input.workOrderId);
    assertOperationId(input.runId);
    return this.#withLock(input.taskId, async () => {
      const state = await this.#loadRequired(input.taskId);
      const priorOperation = state.operations.get(digest(`worker-run-finish:${input.runId}`));
      const usage = normalizeProviderUsage(input.usage);
      const operationFingerprint = fingerprint({
        operationId: `worker-run-finish:${input.runId}`,
        source: "worker-run-finish",
        ...(usage === undefined ? {} : { usage }),
        taskId: input.taskId,
        workOrderId: input.workOrderId,
      });
      if (priorOperation !== undefined) {
        if (priorOperation !== operationFingerprint) {
          throw idempotencyConflict();
        }
        return this.#snapshot(state);
      }
      const active = state.activeRuns.get(input.runId);
      if (active === undefined) {
        throw new Error("The Worker Run has no durable Budget start record.");
      }
      if (active.workOrderId !== input.workOrderId) {
        throw new Error("The Worker Run Budget scope does not match its Work Order.");
      }
      const actualTokens = providerTokenTotal(usage);
      const actualCost = usage?.costUsdMicros;
      const extraTokens =
        actualTokens === undefined ? 0 : Math.max(0, actualTokens - active.proxyTokens);
      const extraCost =
        actualCost === undefined ? 0 : Math.max(0, actualCost - active.proxyCostUsdMicros);
      return this.#mutateLocked(
        state,
        {
          operationId: `worker-run-finish:${input.runId}`,
          source: "worker-run-finish",
          usageDelta: {
            concurrentRuns: -1,
            ...(extraTokens === 0 ? {} : { tokens: extraTokens }),
            ...(extraCost === 0 ? {} : { costUsdMicros: extraCost }),
          },
          workOrderUsageDelta: {
            concurrentRuns: -1,
            ...(extraTokens === 0 ? {} : { tokens: extraTokens }),
            ...(extraCost === 0 ? {} : { costUsdMicros: extraCost }),
          },
          workOrderId: input.workOrderId,
          runFinish: {
            runId: input.runId,
            workOrderId: input.workOrderId,
          },
          activityAtMs: this.#now(),
        },
        true,
        operationFingerprint,
      );
    });
  }

  public recordActivity(input: {
    readonly taskId: string;
    readonly operationId: string;
    readonly source: string;
    readonly workOrderId?: string;
  }): Promise<TaskBudgetSnapshot> {
    assertTaskId(input.taskId);
    assertOperationId(input.operationId);
    assertSource(input.source);
    if (input.workOrderId !== undefined) {
      assertWorkOrderId(input.workOrderId);
    }
    return this.#mutate(
      input.taskId,
      {
        operationId: `activity:${input.operationId}`,
        source: input.source,
        ...(input.workOrderId === undefined ? {} : { workOrderId: input.workOrderId }),
        activityAtMs: this.#now(),
      },
      true,
    );
  }

  public async extendTask(input: {
    readonly taskId: string;
    readonly operationId: string;
    readonly baseRevision: number;
    readonly authority: BudgetAuthority;
    readonly limits: BudgetLimits;
  }): Promise<TaskBudgetSnapshot> {
    assertTaskId(input.taskId);
    assertOperationId(input.operationId);
    return this.#withLock(input.taskId, async () => {
      const state = await this.#loadRequired(input.taskId);
      if (input.authority.kind !== "owner") {
        throw new DomainError(
          "BUDGET_EXTENSION_AUTHORITY_REQUIRED",
          "Only the Owner may extend a Budget hard limit.",
        );
      }
      const operationId = `owner-extension:${input.operationId}`;
      const requestedLimits = cloneLimits(input.limits);
      const operationDigest = digest(operationId);
      const operationFingerprint = fingerprint({
        taskId: input.taskId,
        operationId,
        source: "owner-budget-extension",
        extensionRequest: {
          baseRevision: input.baseRevision,
          ownerId: input.authority.authorityId,
          limits: requestedLimits,
        },
      });
      const existing = state.operations.get(operationDigest);
      if (existing !== undefined) {
        if (existing !== operationFingerprint) {
          throw idempotencyConflict();
        }
        return this.#snapshot(state);
      }
      const aggregate = Budget.create({
        id: BudgetId.from(`budget-${digest(input.taskId)}`),
        scope: state.kind === "autonomous" ? "autonomous-task" : "task",
        limits: state.limits,
      });
      aggregate.extend({
        baseRevision: 1,
        authority: input.authority,
        limits: input.limits,
      });
      const nextLimits = cloneLimits(aggregate.snapshot.limits);
      for (const metric of budgetMetrics) {
        const ceiling = this.#instanceLimits[metric];
        const proposed = nextLimits[metric];
        if (ceiling !== undefined && proposed !== undefined && proposed.hard > ceiling.hard) {
          throw new DomainError(
            "BUDGET_PARENT_LIMIT_EXCEEDED",
            `The Task Budget for ${metric} cannot exceed the Instance ceiling.`,
          );
        }
      }
      const draft: MutationDraft = {
        operationId,
        source: "owner-budget-extension",
        extension: {
          baseRevision: input.baseRevision,
          ownerId: input.authority.authorityId,
          limits: nextLimits,
        },
        activityAtMs: this.#now(),
      };
      if (input.baseRevision !== state.revision) {
        throw new DomainError(
          "BUDGET_REVISION_CONFLICT",
          `Budget revision ${state.revision} does not match extension base revision ${input.baseRevision}.`,
        );
      }
      return this.#mutateLocked(state, draft, false, operationFingerprint);
    });
  }

  public async snapshot(taskId: string): Promise<TaskBudgetSnapshot> {
    assertTaskId(taskId);
    return this.#snapshot(await this.#loadRequired(taskId));
  }

  async #mutate(
    taskId: string,
    draft: MutationDraft,
    allowObservedOverage = false,
  ): Promise<TaskBudgetSnapshot> {
    return this.#withLock(taskId, async () =>
      this.#mutateLocked(await this.#loadRequired(taskId), draft, allowObservedOverage),
    );
  }

  async #mutateLocked(
    state: ProjectedBudget,
    draft: MutationDraft,
    allowObservedOverage = false,
    explicitFingerprint?: string,
  ): Promise<TaskBudgetSnapshot> {
    assertOperationId(draft.operationId);
    assertSource(draft.source);
    const operationDigest = digest(draft.operationId);
    const operationFingerprint = explicitFingerprint ?? mutationFingerprint(state.taskId, draft);
    const existing = state.operations.get(operationDigest);
    if (existing !== undefined) {
      if (existing !== operationFingerprint) {
        throw idempotencyConflict();
      }
      return this.#snapshot(state);
    }

    const now = this.#now();
    const workOrder =
      draft.workOrderId === undefined ? undefined : state.workOrders.get(draft.workOrderId);
    if (draft.workOrderId !== undefined && workOrder === undefined) {
      throw new Error("The Work Order has no durable child Budget.");
    }
    const taskTimeHit = allowObservedOverage ? undefined : hardTimeLimit(state, now);
    const workOrderTimeHit =
      allowObservedOverage || workOrder === undefined
        ? undefined
        : hardWorkOrderTimeLimit(workOrder, now);
    let timeHit:
      | {
          readonly metric: "wallTimeMs" | "idleTimeMs";
          readonly current: number;
          readonly hard: number;
          readonly workOrderId: string | undefined;
        }
      | undefined = taskTimeHit;
    if (timeHit === undefined && workOrderTimeHit !== undefined && workOrder !== undefined) {
      timeHit = {
        ...workOrderTimeHit,
        workOrderId: workOrder.workOrderId,
      };
    }
    if (timeHit !== undefined) {
      await this.#appendLimitEvent(
        state,
        draft.operationId,
        draft.source,
        timeHit.metric,
        timeHit.current,
        timeHit.hard,
        0,
        timeHit.workOrderId,
      );
      throw hardLimitError(
        state.taskId,
        timeHit.metric,
        timeHit.current,
        timeHit.hard,
        0,
        timeHit.workOrderId,
      );
    }

    const usageDelta = normalizeUsageDelta(draft.usageDelta ?? {});
    const workOrderUsageDelta = normalizeUsageDelta(draft.workOrderUsageDelta ?? {});
    const hits = [
      ...projectedHardLimitHits(state.limits, state.usage, usageDelta),
      ...(workOrder === undefined
        ? []
        : projectedHardLimitHits(workOrder.limits, workOrder.usage, workOrderUsageDelta)),
    ];
    const hit = hits[0];
    if (hit !== undefined && !allowObservedOverage) {
      await this.#appendLimitEvent(
        state,
        draft.operationId,
        draft.source,
        hit.metric,
        hit.current,
        hit.hard,
        hit.attempted,
        draft.workOrderId,
      );
      throw hardLimitError(
        state.taskId,
        hit.metric,
        hit.current,
        hit.hard,
        hit.attempted,
        draft.workOrderId,
      );
    }

    if (draft.runStart !== undefined && state.activeRuns.has(draft.runStart.runId)) {
      throw idempotencyConflict();
    }
    if (draft.runFinish !== undefined && !state.activeRuns.has(draft.runFinish.runId)) {
      throw new Error("The Worker Run has no active Budget record.");
    }
    if (draft.extension !== undefined && draft.extension.baseRevision !== state.revision) {
      throw new DomainError(
        "BUDGET_REVISION_CONFLICT",
        "The durable Task Budget revision changed before extension.",
      );
    }

    const occurredAtMs = draft.activityAtMs ?? now;
    if (occurredAtMs < state.lastActivityAtMs || occurredAtMs > now) {
      throw new Error("Budget activity time is not monotonic.");
    }
    const registeredWorkOrders = Object.freeze(
      [...(draft.registeredWorkOrders ?? [])]
        .map((entry) =>
          Object.freeze({
            workOrderId: entry.workOrderId,
            limits: cloneLimits(entry.limits),
          }),
        )
        .sort((left, right) => left.workOrderId.localeCompare(right.workOrderId)),
    );
    const payload: MutationPayload = {
      schemaVersion: 1,
      taskId: state.taskId,
      operationDigest,
      operationFingerprint,
      occurredAtMs: now,
      source: draft.source,
      usageDelta,
      workOrderUsageDelta,
      workOrderId: draft.workOrderId ?? null,
      registeredWorkOrders,
      activityAtMs: draft.activityAtMs ?? null,
      runStart: draft.runStart ?? null,
      runFinish: draft.runFinish ?? null,
      extension: draft.extension ?? null,
      limitEvent: null,
    };
    await this.#appendMutation(state, payload);
    const next = await this.#loadRequired(state.taskId);
    await this.#appendCrossedSoftLimits(state, next, draft, usageDelta, workOrderUsageDelta);
    if (allowObservedOverage) {
      await this.#appendObservedHardLimits(state, next, draft, usageDelta, workOrderUsageDelta);
    }
    queueMicrotask(() => {
      void this.#refreshGuards(state.taskId).catch(() => undefined);
    });
    return this.#snapshot(await this.#loadRequired(state.taskId));
  }

  async #appendCrossedSoftLimits(
    before: ProjectedBudget,
    after: ProjectedBudget,
    draft: MutationDraft,
    usageDelta: Partial<Record<BudgetMetric, number>>,
    workOrderUsageDelta: Partial<Record<BudgetMetric, number>>,
  ): Promise<void> {
    const candidates: Array<{
      metric: BudgetMetric;
      current: number;
      hard: number;
      attempted: number;
      workOrderId?: string;
      operationId?: string;
    }> = [];
    const now = this.#now();
    for (const metric of budgetMetrics) {
      const limit = after.limits[metric];
      const previous = effectiveMetricUsage(before, metric, now);
      const current = effectiveMetricUsage(after, metric, now);
      const timeOperationId =
        measuredTimeMetrics.has(metric) && limit?.soft !== undefined
          ? timeSoftOperationId(metric as "wallTimeMs" | "idleTimeMs", limit.soft, limit.hard)
          : undefined;
      if (
        limit?.soft !== undefined &&
        current >= limit.soft &&
        (previous < limit.soft ||
          (timeOperationId !== undefined && !before.operations.has(digest(timeOperationId))))
      ) {
        candidates.push({
          metric,
          current,
          hard: limit.hard,
          attempted: usageDelta[metric] ?? 0,
          ...(timeOperationId === undefined ? {} : { operationId: timeOperationId }),
        });
      }
    }
    const workOrder =
      draft.workOrderId === undefined ? undefined : after.workOrders.get(draft.workOrderId);
    const beforeWorkOrder =
      draft.workOrderId === undefined ? undefined : before.workOrders.get(draft.workOrderId);
    if (workOrder !== undefined && beforeWorkOrder !== undefined) {
      for (const metric of budgetMetrics) {
        const limit = workOrder.limits[metric];
        const previous = effectiveWorkOrderMetricUsage(beforeWorkOrder, metric, now);
        const current = effectiveWorkOrderMetricUsage(workOrder, metric, now);
        const timeOperationId =
          measuredTimeMetrics.has(metric) && limit?.soft !== undefined
            ? timeSoftOperationId(
                metric as "wallTimeMs" | "idleTimeMs",
                limit.soft,
                limit.hard,
                workOrder.workOrderId,
              )
            : undefined;
        if (
          limit?.soft !== undefined &&
          current >= limit.soft &&
          (previous < limit.soft ||
            (timeOperationId !== undefined && !before.operations.has(digest(timeOperationId))))
        ) {
          candidates.push({
            metric,
            current,
            hard: limit.hard,
            attempted: workOrderUsageDelta[metric] ?? 0,
            workOrderId: workOrder.workOrderId,
            ...(timeOperationId === undefined ? {} : { operationId: timeOperationId }),
          });
        }
      }
    }
    for (const candidate of candidates) {
      const state = await this.#loadRequired(after.taskId);
      const operationId =
        candidate.operationId ??
        `soft:${draft.operationId}:${candidate.workOrderId ?? "task"}:${candidate.metric}`;
      await this.#appendSoftLimitEvent(
        state,
        operationId,
        draft.source,
        candidate.metric,
        candidate.current,
        candidate.hard,
        candidate.attempted,
        candidate.workOrderId,
      );
    }
  }

  async #appendSoftLimitEvent(
    state: ProjectedBudget,
    operationId: string,
    source: string,
    metric: BudgetMetric,
    current: number,
    hard: number,
    attempted: number,
    workOrderId?: string,
  ): Promise<void> {
    const operationDigest = digest(operationId);
    if (state.operations.has(operationDigest)) {
      return;
    }
    const occurredAtMs = this.#now();
    const event: Omit<BudgetLimitEvent, "eventId"> = {
      metric,
      state: "soft-limit",
      current,
      hard,
      attempted,
      occurredAtMs,
      source,
      ...(workOrderId === undefined ? {} : { workOrderId }),
    };
    await this.#appendMutation(state, {
      schemaVersion: 1,
      taskId: state.taskId,
      operationDigest,
      operationFingerprint: fingerprint(event),
      occurredAtMs,
      source,
      usageDelta: {},
      workOrderUsageDelta: {},
      workOrderId: workOrderId ?? null,
      registeredWorkOrders: [],
      activityAtMs: null,
      runStart: null,
      runFinish: null,
      extension: null,
      limitEvent: event,
    });
  }

  async #appendObservedHardLimits(
    before: ProjectedBudget,
    after: ProjectedBudget,
    draft: MutationDraft,
    usageDelta: Partial<Record<BudgetMetric, number>>,
    workOrderUsageDelta: Partial<Record<BudgetMetric, number>>,
  ): Promise<void> {
    const candidates: Array<{
      metric: BudgetMetric;
      current: number;
      hard: number;
      attempted: number;
      workOrderId?: string;
    }> = [];
    for (const metric of budgetMetrics) {
      if (measuredTimeMetrics.has(metric) || (usageDelta[metric] ?? 0) <= 0) {
        continue;
      }
      const limit = after.limits[metric];
      const previous = before.usage[metric] ?? 0;
      const current = after.usage[metric] ?? 0;
      if (limit !== undefined && previous <= limit.hard && current > limit.hard) {
        candidates.push({
          metric,
          current,
          hard: limit.hard,
          attempted: usageDelta[metric] ?? 0,
        });
      }
    }
    const workOrder =
      draft.workOrderId === undefined ? undefined : after.workOrders.get(draft.workOrderId);
    const beforeWorkOrder =
      draft.workOrderId === undefined ? undefined : before.workOrders.get(draft.workOrderId);
    if (workOrder !== undefined && beforeWorkOrder !== undefined) {
      for (const metric of budgetMetrics) {
        if (measuredTimeMetrics.has(metric) || (workOrderUsageDelta[metric] ?? 0) <= 0) {
          continue;
        }
        const limit = workOrder.limits[metric];
        const previous = beforeWorkOrder.usage[metric] ?? 0;
        const current = workOrder.usage[metric] ?? 0;
        if (limit !== undefined && previous <= limit.hard && current > limit.hard) {
          candidates.push({
            metric,
            current,
            hard: limit.hard,
            attempted: workOrderUsageDelta[metric] ?? 0,
            workOrderId: workOrder.workOrderId,
          });
        }
      }
    }
    for (const candidate of candidates) {
      const state = await this.#loadRequired(after.taskId);
      await this.#appendLimitEvent(
        state,
        `observed:${draft.operationId}`,
        draft.source,
        candidate.metric,
        candidate.current,
        candidate.hard,
        candidate.attempted,
        candidate.workOrderId,
      );
    }
  }

  async #appendLimitEvent(
    state: ProjectedBudget,
    blockedOperationId: string,
    source: string,
    metric: BudgetMetric,
    current: number,
    hard: number,
    attempted: number,
    workOrderId?: string,
  ): Promise<void> {
    const operationId = `hard:${blockedOperationId}:${workOrderId ?? "task"}:${metric}`;
    const operationDigest = digest(operationId);
    if (state.operations.has(operationDigest)) {
      return;
    }
    const occurredAtMs = this.#now();
    const event: Omit<BudgetLimitEvent, "eventId"> = {
      metric,
      state: "hard-limit",
      current,
      hard,
      attempted,
      occurredAtMs,
      source,
      ...(workOrderId === undefined ? {} : { workOrderId }),
    };
    await this.#appendMutation(state, {
      schemaVersion: 1,
      taskId: state.taskId,
      operationDigest,
      operationFingerprint: fingerprint(event),
      occurredAtMs,
      source,
      usageDelta: {},
      workOrderUsageDelta: {},
      workOrderId: workOrderId ?? null,
      registeredWorkOrders: [],
      activityAtMs: null,
      runStart: null,
      runFinish: null,
      extension: null,
      limitEvent: event,
    });
  }

  async #appendMutation(state: ProjectedBudget, payload: MutationPayload): Promise<void> {
    try {
      await this.#eventStore.append({
        streamId: budgetStreamId(state.taskId),
        expectedVersion: state.version,
        occurredAt: new Date(payload.occurredAtMs).toISOString(),
        events: [
          {
            eventId: budgetMutationEventId(state.taskId, payload.operationDigest),
            type: "task.budget-mutation-recorded",
            payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof EventStoreError) {
        if (
          error.code === "STREAM_VERSION_CONFLICT" ||
          error.code === "EVENT_ID_CONFLICT" ||
          error.code === "EVENT_BATCH_REPLAY_MISMATCH"
        ) {
          throw idempotencyConflict();
        }
        throw budgetStorageFailed();
      }
      throw error;
    }
  }

  async #loadOptional(taskId: string): Promise<ProjectedBudget | undefined> {
    let events: readonly StoredEvent[];
    try {
      events = await this.#eventStore.readStream(budgetStreamId(taskId));
    } catch {
      throw budgetStorageFailed();
    }
    if (events.length === 0) {
      return undefined;
    }
    return projectBudget(events, taskId);
  }

  async #loadRequired(taskId: string): Promise<ProjectedBudget> {
    const state = await this.#loadOptional(taskId);
    if (state === undefined) {
      throw new TaskBudgetServiceError("BUDGET_NOT_FOUND", "The Task has no durable Budget.");
    }
    return state;
  }

  #snapshot(state: ProjectedBudget): TaskBudgetSnapshot {
    const now = this.#now();
    const usage: Partial<Record<BudgetMetric, number>> = { ...state.usage };
    usage.concurrentRuns ??= 0;
    usage.wallTimeMs = Math.max(0, now - state.createdAtMs);
    usage.idleTimeMs = Math.max(0, now - state.lastActivityAtMs);
    return deepFreeze({
      taskId: state.taskId,
      kind: state.kind,
      revision: state.revision,
      createdAtMs: state.createdAtMs,
      lastActivityAtMs: state.lastActivityAtMs,
      limits: cloneLimits(state.limits),
      usage,
      workOrders: [...state.workOrders.values()]
        .sort((left, right) => left.workOrderId.localeCompare(right.workOrderId))
        .map((entry) => ({
          workOrderId: entry.workOrderId,
          limits: cloneLimits(entry.limits),
          usage: {
            ...cloneUsage(entry.usage),
            wallTimeMs: Math.max(0, now - entry.createdAtMs),
            idleTimeMs: Math.max(0, now - entry.lastActivityAtMs),
          },
        })),
      activeRunIds: [...state.activeRuns.keys()].sort(),
      limitEvents: [...state.limitEvents],
      extensions: state.extensions.map((extension) => ({
        ...extension,
        limits: cloneLimits(extension.limits),
      })),
    });
  }

  #createGuard(taskId: string, upstreamSignal: AbortSignal): TaskBudgetExecutionGuard {
    const controller = new AbortController();
    const control: GuardControl = {
      taskId,
      controller,
      upstreamSignal,
      upstreamAbort: () => controller.abort(upstreamSignal.reason),
      closed: false,
      scheduling: false,
      refreshRequested: false,
    };
    upstreamSignal.addEventListener("abort", control.upstreamAbort, { once: true });
    if (upstreamSignal.aborted) {
      control.upstreamAbort();
    }
    const controls = this.#guards.get(taskId) ?? new Set<GuardControl>();
    controls.add(control);
    this.#guards.set(taskId, controls);
    void this.#scheduleGuard(control);
    return Object.freeze({
      signal: controller.signal,
      exhaustion: () => control.exhaustion,
      close: async () => {
        if (control.closed) {
          return;
        }
        control.closed = true;
        if (control.timer !== undefined) {
          clearTimeout(control.timer);
        }
        upstreamSignal.removeEventListener("abort", control.upstreamAbort);
        controls.delete(control);
        if (controls.size === 0) {
          this.#guards.delete(taskId);
        }
      },
    });
  }

  async #scheduleGuard(control: GuardControl): Promise<void> {
    if (control.scheduling) {
      control.refreshRequested = true;
      return;
    }
    control.scheduling = true;
    try {
      do {
        control.refreshRequested = false;
        await this.#scheduleGuardOnce(control);
      } while (control.refreshRequested && !control.closed && !control.controller.signal.aborted);
    } finally {
      control.scheduling = false;
    }
  }

  async #scheduleGuardOnce(control: GuardControl): Promise<void> {
    if (control.closed || control.controller.signal.aborted) {
      return;
    }
    if (control.timer !== undefined) {
      clearTimeout(control.timer);
    }
    while (!control.closed && !control.controller.signal.aborted) {
      const state = await this.#loadRequired(control.taskId);
      const now = this.#now();
      const taskHit = hardTimeLimit(state, now);
      const activeWorkOrderHit =
        taskHit === undefined ? hardActiveWorkOrderTimeLimit(state, now) : undefined;
      const hit = taskHit ?? activeWorkOrderHit;
      if (hit !== undefined) {
        await this.#withLock(control.taskId, async () => {
          const current = await this.#loadRequired(control.taskId);
          const currentTaskHit = hardTimeLimit(current, this.#now());
          const currentActiveWorkOrderHit =
            currentTaskHit === undefined
              ? hardActiveWorkOrderTimeLimit(current, this.#now())
              : undefined;
          const currentHit = currentTaskHit ?? currentActiveWorkOrderHit;
          if (currentHit === undefined) {
            return;
          }
          const blockedOperationId = timeHardOperationId(
            currentHit.metric,
            currentHit.hard,
            currentHit.workOrderId,
          );
          await this.#appendLimitEvent(
            current,
            blockedOperationId,
            "task-time-guard",
            currentHit.metric,
            currentHit.current,
            currentHit.hard,
            0,
            currentHit.workOrderId,
          );
          const refreshed = await this.#loadRequired(control.taskId);
          const eventId = budgetMutationEventId(
            current.taskId,
            digest(
              `hard:${blockedOperationId}:${currentHit.workOrderId ?? "task"}:${currentHit.metric}`,
            ),
          );
          const exhaustion = refreshed.limitEvents.find((event) => event.eventId === eventId);
          if (exhaustion === undefined) {
            throw corruptBudget();
          }
          control.exhaustion = exhaustion;
        });
        if (control.exhaustion !== undefined) {
          control.controller.abort(TASK_BUDGET_EXHAUSTED_ABORT_REASON);
          return;
        }
        continue;
      }
      const taskSoftHit = reachedTimeSoftLimit(state, now);
      const activeWorkOrderSoftHit =
        taskSoftHit === undefined ? reachedActiveWorkOrderSoftLimit(state, now) : undefined;
      const softHit = taskSoftHit ?? activeWorkOrderSoftHit;
      if (softHit !== undefined) {
        await this.#withLock(control.taskId, async () => {
          const current = await this.#loadRequired(control.taskId);
          const currentTaskHit = reachedTimeSoftLimit(current, this.#now());
          const currentActiveWorkOrderHit =
            currentTaskHit === undefined
              ? reachedActiveWorkOrderSoftLimit(current, this.#now())
              : undefined;
          const currentHit = currentTaskHit ?? currentActiveWorkOrderHit;
          if (currentHit === undefined) {
            return;
          }
          await this.#appendSoftLimitEvent(
            current,
            timeSoftOperationId(
              currentHit.metric,
              currentHit.soft,
              currentHit.hard,
              currentHit.workOrderId,
            ),
            "task-time-guard",
            currentHit.metric,
            currentHit.current,
            currentHit.hard,
            0,
            currentHit.workOrderId,
          );
        });
        continue;
      }
      const delays = timeRemaining(state, now);
      const delay = Math.min(...delays);
      if (control.closed || control.controller.signal.aborted) {
        return;
      }
      control.timer = setTimeout(
        () => {
          void this.#scheduleGuard(control);
        },
        Math.max(1, Math.min(delay, MAXIMUM_TIMER_DELAY_MS)),
      );
      control.timer.unref();
      return;
    }
  }

  async #refreshGuards(taskId: string): Promise<void> {
    await Promise.all(
      [...(this.#guards.get(taskId) ?? [])].map((guard) => this.#scheduleGuard(guard)),
    );
  }

  async #withLock<TResult>(taskId: string, operation: () => Promise<TResult>): Promise<TResult> {
    const previous = this.#locks.get(taskId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.#locks.set(taskId, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#locks.get(taskId) === chained) {
        this.#locks.delete(taskId);
      }
    }
  }

  #now(): number {
    const now = this.#clock.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAXIMUM_DATE_MS) {
      throw new Error("The Task Budget clock returned an invalid time.");
    }
    return now;
  }
}

function projectBudget(events: readonly StoredEvent[], taskId: string): ProjectedBudget {
  const first = events[0];
  if (
    first === undefined ||
    first.streamVersion !== 1 ||
    first.type !== "task.budget-created" ||
    first.eventId !== `event_budget_created_${digest(taskId)}`
  ) {
    throw corruptBudget();
  }
  const created = parseCreatedPayload(first.payload, taskId);
  if (first.occurredAt !== new Date(created.createdAtMs).toISOString()) {
    throw corruptBudget();
  }
  const state: ProjectedBudget = {
    version: events.length,
    taskId,
    kind: created.kind,
    revision: 1,
    createdAtMs: created.createdAtMs,
    lastActivityAtMs: created.createdAtMs,
    initialLimits: created.limits,
    limits: created.limits,
    usageProxy: created.usageProxy,
    usage: {},
    workOrders: new Map(),
    activeRuns: new Map(),
    operations: new Map(),
    limitEvents: [],
    extensions: [],
  };
  for (const [index, event] of events.entries()) {
    if (event.streamVersion !== index + 1) {
      throw corruptBudget();
    }
    if (index === 0) {
      continue;
    }
    if (
      event.type !== "task.budget-mutation-recorded" ||
      event.eventId !== budgetMutationEventId(taskId, readOperationDigest(event.payload))
    ) {
      throw corruptBudget();
    }
    const payload = parseMutationPayload(event.payload, taskId);
    if (event.occurredAt !== new Date(payload.occurredAtMs).toISOString()) {
      throw corruptBudget();
    }
    const prior = state.operations.get(payload.operationDigest);
    if (prior !== undefined) {
      throw corruptBudget();
    }
    state.operations.set(payload.operationDigest, payload.operationFingerprint);
    for (const entry of payload.registeredWorkOrders) {
      if (state.workOrders.has(entry.workOrderId)) {
        throw corruptBudget();
      }
      state.workOrders.set(entry.workOrderId, {
        workOrderId: entry.workOrderId,
        limits: entry.limits,
        createdAtMs: payload.occurredAtMs,
        lastActivityAtMs: payload.occurredAtMs,
        usage: {},
      });
    }
    applyUsageDelta(state.usage, payload.usageDelta);
    if (payload.workOrderId !== null) {
      const child = state.workOrders.get(payload.workOrderId);
      if (child === undefined) {
        throw corruptBudget();
      }
      applyUsageDelta(child.usage, payload.workOrderUsageDelta);
    } else if (Object.keys(payload.workOrderUsageDelta).length > 0) {
      throw corruptBudget();
    }
    if (payload.activityAtMs !== null) {
      if (
        payload.activityAtMs < state.lastActivityAtMs ||
        payload.activityAtMs > payload.occurredAtMs
      ) {
        throw corruptBudget();
      }
      state.lastActivityAtMs = payload.activityAtMs;
      if (payload.workOrderId !== null) {
        const child = state.workOrders.get(payload.workOrderId);
        if (
          child === undefined ||
          payload.activityAtMs < child.lastActivityAtMs ||
          payload.activityAtMs < child.createdAtMs
        ) {
          throw corruptBudget();
        }
        child.lastActivityAtMs = payload.activityAtMs;
      }
    }
    if (payload.runStart !== null) {
      if (
        state.activeRuns.has(payload.runStart.runId) ||
        payload.workOrderId !== payload.runStart.workOrderId
      ) {
        throw corruptBudget();
      }
      state.activeRuns.set(payload.runStart.runId, payload.runStart);
    }
    if (payload.runFinish !== null) {
      const active = state.activeRuns.get(payload.runFinish.runId);
      if (
        active === undefined ||
        active.workOrderId !== payload.runFinish.workOrderId ||
        payload.workOrderId !== payload.runFinish.workOrderId
      ) {
        throw corruptBudget();
      }
      state.activeRuns.delete(payload.runFinish.runId);
    }
    if (payload.extension !== null) {
      if (payload.extension.baseRevision !== state.revision) {
        throw corruptBudget();
      }
      state.limits = payload.extension.limits;
      state.revision += 1;
      state.extensions.push({
        eventId: event.eventId,
        baseRevision: payload.extension.baseRevision,
        revision: state.revision,
        occurredAtMs: payload.occurredAtMs,
        ownerId: payload.extension.ownerId,
        limits: payload.extension.limits,
      });
    }
    if (payload.limitEvent !== null) {
      state.limitEvents.push({
        eventId: event.eventId,
        ...payload.limitEvent,
      });
    }
  }
  if ((state.usage.concurrentRuns ?? 0) !== state.activeRuns.size) {
    throw corruptBudget();
  }
  return state;
}

function parseCreatedPayload(value: unknown, taskId: string): CreatedPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "taskId",
      "kind",
      "createdAtMs",
      "limits",
      "usageProxy",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["taskId"] !== taskId ||
    (value["kind"] !== "requested" && value["kind"] !== "autonomous") ||
    !isTimestampMs(value["createdAtMs"])
  ) {
    throw corruptBudget();
  }
  return {
    schemaVersion: 1,
    taskId,
    kind: value["kind"],
    createdAtMs: value["createdAtMs"],
    limits: parseCompleteLimits(value["limits"]),
    usageProxy: validateUsageProxy(value["usageProxy"]),
  };
}

function parseMutationPayload(value: unknown, taskId: string): MutationPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "taskId",
      "operationDigest",
      "operationFingerprint",
      "occurredAtMs",
      "source",
      "usageDelta",
      "workOrderUsageDelta",
      "workOrderId",
      "registeredWorkOrders",
      "activityAtMs",
      "runStart",
      "runFinish",
      "extension",
      "limitEvent",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["taskId"] !== taskId ||
    !isSha256(value["operationDigest"]) ||
    !isSha256(value["operationFingerprint"]) ||
    !isTimestampMs(value["occurredAtMs"]) ||
    typeof value["source"] !== "string" ||
    value["source"].trim().length === 0 ||
    (value["workOrderId"] !== null && typeof value["workOrderId"] !== "string") ||
    (value["activityAtMs"] !== null && !isTimestampMs(value["activityAtMs"]))
  ) {
    throw corruptBudget();
  }
  const registeredWorkOrders = parseRegisteredWorkOrders(value["registeredWorkOrders"]);
  const workOrderId = value["workOrderId"] as string | null;
  if (workOrderId !== null) {
    assertWorkOrderId(workOrderId);
  }
  return {
    schemaVersion: 1,
    taskId,
    operationDigest: value["operationDigest"],
    operationFingerprint: value["operationFingerprint"],
    occurredAtMs: value["occurredAtMs"],
    source: value["source"],
    usageDelta: parseUsageDelta(value["usageDelta"]),
    workOrderUsageDelta: parseUsageDelta(value["workOrderUsageDelta"]),
    workOrderId,
    registeredWorkOrders,
    activityAtMs: value["activityAtMs"] as number | null,
    runStart: parseRunStart(value["runStart"]),
    runFinish: parseRunFinish(value["runFinish"]),
    extension: parseExtension(value["extension"]),
    limitEvent: parseLimitEvent(value["limitEvent"]),
  };
}

function parseRegisteredWorkOrders(value: unknown): readonly PersistedWorkOrderBudget[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_WORK_ORDERS_PER_MUTATION) {
    throw corruptBudget();
  }
  const ids = new Set<string>();
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["workOrderId", "limits"]) ||
      typeof entry["workOrderId"] !== "string"
    ) {
      throw corruptBudget();
    }
    assertWorkOrderId(entry["workOrderId"]);
    if (ids.has(entry["workOrderId"])) {
      throw corruptBudget();
    }
    ids.add(entry["workOrderId"]);
    return {
      workOrderId: entry["workOrderId"],
      limits: parseCompleteLimits(entry["limits"]),
    };
  });
}

function parseRunStart(value: unknown): RunStart | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["runId", "workOrderId", "proxyTokens", "proxyCostUsdMicros"]) ||
    typeof value["runId"] !== "string" ||
    typeof value["workOrderId"] !== "string"
  ) {
    throw corruptBudget();
  }
  assertOperationId(value["runId"]);
  assertWorkOrderId(value["workOrderId"]);
  assertNonNegativeSafeInteger(value["proxyTokens"], "proxy tokens");
  assertNonNegativeSafeInteger(value["proxyCostUsdMicros"], "proxy cost");
  return {
    runId: value["runId"],
    workOrderId: value["workOrderId"],
    proxyTokens: value["proxyTokens"],
    proxyCostUsdMicros: value["proxyCostUsdMicros"],
  };
}

function parseRunFinish(value: unknown): RunFinish | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["runId", "workOrderId"]) ||
    typeof value["runId"] !== "string" ||
    typeof value["workOrderId"] !== "string"
  ) {
    throw corruptBudget();
  }
  assertOperationId(value["runId"]);
  assertWorkOrderId(value["workOrderId"]);
  return {
    runId: value["runId"],
    workOrderId: value["workOrderId"],
  };
}

function parseExtension(value: unknown): ExtensionRecord | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["baseRevision", "ownerId", "limits"]) ||
    !Number.isSafeInteger(value["baseRevision"]) ||
    Number(value["baseRevision"]) < 1 ||
    typeof value["ownerId"] !== "string" ||
    value["ownerId"].trim().length === 0
  ) {
    throw corruptBudget();
  }
  return {
    baseRevision: value["baseRevision"] as number,
    ownerId: value["ownerId"],
    limits: parseCompleteLimits(value["limits"]),
  };
}

function parseLimitEvent(value: unknown): Omit<BudgetLimitEvent, "eventId"> | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasAllowedAndRequiredKeys(
      value,
      ["metric", "state", "current", "hard", "attempted", "occurredAtMs", "source", "workOrderId"],
      ["metric", "state", "current", "hard", "attempted", "occurredAtMs", "source"],
    ) ||
    !isBudgetMetric(value["metric"]) ||
    (value["state"] !== "hard-limit" && value["state"] !== "soft-limit") ||
    !isTimestampMs(value["occurredAtMs"]) ||
    typeof value["source"] !== "string" ||
    (value["workOrderId"] !== undefined && typeof value["workOrderId"] !== "string")
  ) {
    throw corruptBudget();
  }
  assertNonNegativeFinite(value["current"], "limit current");
  assertNonNegativeFinite(value["hard"], "limit hard");
  assertNonNegativeFinite(value["attempted"], "limit attempted");
  const base = {
    metric: value["metric"],
    state: value["state"],
    current: value["current"],
    hard: value["hard"],
    attempted: value["attempted"],
    occurredAtMs: value["occurredAtMs"],
    source: value["source"],
  } as const;
  if (value["workOrderId"] === undefined) {
    return base;
  }
  assertWorkOrderId(value["workOrderId"]);
  return { ...base, workOrderId: value["workOrderId"] };
}

function validateCompleteLimits(value: BudgetLimits, label: string): BudgetLimits {
  const limits = parseCompleteLimits(value);
  try {
    Budget.create({
      id: BudgetId.from(`budget-${label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}`),
      scope: "autonomous-task",
      limits,
    });
  } catch {
    throw new TypeError(`${label} Budget defaults must define every finite hard limit.`);
  }
  return limits;
}

function validateInheritedDefaults(
  value: BudgetLimits,
  instance: BudgetLimits,
  label: string,
): BudgetLimits {
  const limits = validateCompleteLimits(value, label);
  for (const metric of budgetMetrics) {
    const parent = instance[metric];
    const child = limits[metric];
    if (parent === undefined || child === undefined || child.hard > parent.hard) {
      throw new TypeError(`${label} Budget defaults cannot exceed Instance ceilings.`);
    }
  }
  return limits;
}

function parseCompleteLimits(value: unknown): BudgetLimits {
  if (!isRecord(value) || !hasExactKeys(value, budgetMetrics)) {
    throw corruptBudget();
  }
  const limits: BudgetLimits = {};
  for (const metric of budgetMetrics) {
    limits[metric] = parseLimit(value[metric]);
  }
  return freezeLimits(limits);
}

function parsePartialLimits(value: unknown): BudgetLimits {
  if (!isRecord(value) || !Object.keys(value).every(isBudgetMetric)) {
    throw new TypeError("Work Order Budget limits are invalid.");
  }
  const limits: BudgetLimits = {};
  for (const metric of budgetMetrics) {
    if (value[metric] !== undefined) {
      limits[metric] = parseLimit(value[metric]);
    }
  }
  return freezeLimits(limits);
}

function parseLimit(value: unknown): BudgetLimit {
  if (!isRecord(value) || !hasAllowedAndRequiredKeys(value, ["soft", "hard"], ["hard"])) {
    throw corruptBudget();
  }
  assertNonNegativeFinite(value["hard"], "Budget hard limit");
  if (value["soft"] !== undefined) {
    assertNonNegativeFinite(value["soft"], "Budget soft limit");
    if (value["soft"] > value["hard"]) {
      throw corruptBudget();
    }
    return Object.freeze({ soft: value["soft"], hard: value["hard"] });
  }
  return Object.freeze({ hard: value["hard"] });
}

function effectiveChildLimits(
  parentLimits: BudgetLimits,
  requested: BudgetLimits,
  workOrderId: string,
): BudgetLimits {
  const effective: BudgetLimits = { ...parentLimits };
  for (const metric of budgetMetrics) {
    const requestedLimit = requested[metric];
    const parentLimit = parentLimits[metric];
    if (requestedLimit === undefined) {
      continue;
    }
    if (parentLimit === undefined || requestedLimit.hard > parentLimit.hard) {
      throw new DomainError(
        "BUDGET_PARENT_LIMIT_EXCEEDED",
        `Work Order ${workOrderId} cannot exceed its parent Task Budget for ${metric}.`,
      );
    }
    effective[metric] = requestedLimit;
  }
  const parent = Budget.create({
    id: BudgetId.from(`budget-parent-${digest(workOrderId)}`),
    scope: "task",
    limits: parentLimits,
  });
  parent.deriveChild({
    id: BudgetId.from(`budget-child-${digest(workOrderId)}`),
    limits: effective,
  });
  return freezeLimits(effective);
}

function readWorkOrderBudgetLimits(workOrder: WorkOrderV1): BudgetLimits {
  const value = (workOrder as WorkOrderV1 & { readonly budgetLimits?: unknown }).budgetLimits;
  return value === undefined ? {} : parsePartialLimits(value);
}

function normalizeUsageDelta(
  value: Partial<Record<BudgetMetric, number>>,
): Partial<Record<BudgetMetric, number>> {
  if (!isRecord(value) || !Object.keys(value).every(isBudgetMetric)) {
    throw new TypeError("Budget usage delta is invalid.");
  }
  const result: Partial<Record<BudgetMetric, number>> = {};
  for (const metric of budgetMetrics) {
    const amount = value[metric];
    if (amount === undefined || amount === 0) {
      continue;
    }
    if (!Number.isFinite(amount) || !Number.isSafeInteger(amount)) {
      throw new TypeError("Budget usage delta must use finite safe integers.");
    }
    if (amount < 0 && (metric !== "concurrentRuns" || amount !== -1)) {
      throw new TypeError("Only a Worker Run finish may release one concurrent Run.");
    }
    result[metric] = amount;
  }
  return Object.freeze(result);
}

function parseUsageDelta(value: unknown): Partial<Record<BudgetMetric, number>> {
  try {
    return normalizeUsageDelta(value as Partial<Record<BudgetMetric, number>>);
  } catch {
    throw corruptBudget();
  }
}

function applyUsageDelta(
  usage: Partial<Record<BudgetMetric, number>>,
  delta: Partial<Record<BudgetMetric, number>>,
): void {
  for (const metric of budgetMetrics) {
    const amount = delta[metric] ?? 0;
    const next = (usage[metric] ?? 0) + amount;
    if (!Number.isSafeInteger(next) || next < 0) {
      throw corruptBudget();
    }
    if (next === 0) {
      delete usage[metric];
    } else {
      usage[metric] = next;
    }
  }
}

function projectedHardLimitHits(
  limits: BudgetLimits,
  usage: Partial<Record<BudgetMetric, number>>,
  delta: Partial<Record<BudgetMetric, number>>,
): Array<{
  readonly metric: BudgetMetric;
  readonly current: number;
  readonly hard: number;
  readonly attempted: number;
}> {
  const hits: Array<{
    readonly metric: BudgetMetric;
    readonly current: number;
    readonly hard: number;
    readonly attempted: number;
  }> = [];
  for (const metric of budgetMetrics) {
    if (measuredTimeMetrics.has(metric)) {
      continue;
    }
    const amount = delta[metric] ?? 0;
    if (amount <= 0) {
      continue;
    }
    const current = usage[metric] ?? 0;
    const limit = limits[metric];
    if (limit !== undefined && current + amount > limit.hard) {
      hits.push({
        metric,
        current,
        hard: limit.hard,
        attempted: amount,
      });
    }
  }
  return hits;
}

function hardTimeLimit(
  state: ProjectedBudget,
  now: number,
):
  | {
      readonly metric: "wallTimeMs" | "idleTimeMs";
      readonly current: number;
      readonly hard: number;
      readonly workOrderId: undefined;
    }
  | undefined {
  for (const metric of ["wallTimeMs", "idleTimeMs"] as const) {
    const limit = state.limits[metric];
    const current = effectiveMetricUsage(state, metric, now);
    if (limit !== undefined && current >= limit.hard) {
      return { metric, current, hard: limit.hard, workOrderId: undefined };
    }
  }
  return undefined;
}

function hardActiveWorkOrderTimeLimit(
  state: ProjectedBudget,
  now: number,
):
  | {
      readonly metric: "wallTimeMs" | "idleTimeMs";
      readonly current: number;
      readonly hard: number;
      readonly workOrderId: string;
    }
  | undefined {
  const activeWorkOrderIds = [
    ...new Set([...state.activeRuns.values()].map((run) => run.workOrderId)),
  ].sort();
  for (const workOrderId of activeWorkOrderIds) {
    const workOrder = state.workOrders.get(workOrderId);
    if (workOrder === undefined) {
      throw corruptBudget();
    }
    const hit = hardWorkOrderTimeLimit(workOrder, now);
    if (hit !== undefined) {
      return {
        ...hit,
        workOrderId,
      };
    }
  }
  return undefined;
}

function hardWorkOrderTimeLimit(
  workOrder: MutableWorkOrderBudget,
  now: number,
):
  | {
      readonly metric: "wallTimeMs" | "idleTimeMs";
      readonly current: number;
      readonly hard: number;
    }
  | undefined {
  for (const metric of ["wallTimeMs", "idleTimeMs"] as const) {
    const limit = workOrder.limits[metric];
    const current = effectiveWorkOrderMetricUsage(workOrder, metric, now);
    if (limit !== undefined && current >= limit.hard) {
      return { metric, current, hard: limit.hard };
    }
  }
  return undefined;
}

function reachedTimeSoftLimit(
  state: ProjectedBudget,
  now: number,
):
  | {
      readonly metric: "wallTimeMs" | "idleTimeMs";
      readonly current: number;
      readonly soft: number;
      readonly hard: number;
      readonly workOrderId: undefined;
    }
  | undefined {
  for (const metric of ["wallTimeMs", "idleTimeMs"] as const) {
    const limit = state.limits[metric];
    if (limit?.soft === undefined) {
      continue;
    }
    const operationId = timeSoftOperationId(metric, limit.soft, limit.hard);
    const current = effectiveMetricUsage(state, metric, now);
    if (current >= limit.soft && !state.operations.has(digest(operationId))) {
      return {
        metric,
        current,
        soft: limit.soft,
        hard: limit.hard,
        workOrderId: undefined,
      };
    }
  }
  return undefined;
}

function reachedActiveWorkOrderSoftLimit(
  state: ProjectedBudget,
  now: number,
):
  | {
      readonly metric: "wallTimeMs" | "idleTimeMs";
      readonly current: number;
      readonly soft: number;
      readonly hard: number;
      readonly workOrderId: string;
    }
  | undefined {
  const activeWorkOrderIds = [
    ...new Set([...state.activeRuns.values()].map((run) => run.workOrderId)),
  ].sort();
  for (const workOrderId of activeWorkOrderIds) {
    const workOrder = state.workOrders.get(workOrderId);
    if (workOrder === undefined) {
      throw corruptBudget();
    }
    for (const metric of ["wallTimeMs", "idleTimeMs"] as const) {
      const limit = workOrder.limits[metric];
      if (limit?.soft === undefined) {
        continue;
      }
      const operationId = timeSoftOperationId(metric, limit.soft, limit.hard, workOrderId);
      const current = effectiveWorkOrderMetricUsage(workOrder, metric, now);
      if (current >= limit.soft && !state.operations.has(digest(operationId))) {
        return {
          metric,
          current,
          soft: limit.soft,
          hard: limit.hard,
          workOrderId,
        };
      }
    }
  }
  return undefined;
}

function timeRemaining(state: ProjectedBudget, now: number): readonly number[] {
  const taskDelays = (["wallTimeMs", "idleTimeMs"] as const).map((metric) => {
    const limit = state.limits[metric];
    if (limit === undefined) {
      return MAXIMUM_TIMER_DELAY_MS;
    }
    const current = effectiveMetricUsage(state, metric, now);
    const softOperation =
      limit.soft === undefined ? undefined : timeSoftOperationId(metric, limit.soft, limit.hard);
    const boundary =
      limit.soft !== undefined &&
      softOperation !== undefined &&
      current < limit.soft &&
      !state.operations.has(digest(softOperation))
        ? limit.soft
        : limit.hard;
    return Math.max(1, boundary - current);
  });
  const workOrderDelays = [
    ...new Set([...state.activeRuns.values()].map((run) => run.workOrderId)),
  ].flatMap((workOrderId) => {
    const workOrder = state.workOrders.get(workOrderId);
    if (workOrder === undefined) {
      throw corruptBudget();
    }
    return (["wallTimeMs", "idleTimeMs"] as const).map((metric) => {
      const limit = workOrder.limits[metric];
      if (limit === undefined) {
        return MAXIMUM_TIMER_DELAY_MS;
      }
      const current = effectiveWorkOrderMetricUsage(workOrder, metric, now);
      const softOperation =
        limit.soft === undefined
          ? undefined
          : timeSoftOperationId(metric, limit.soft, limit.hard, workOrderId);
      const boundary =
        limit.soft !== undefined &&
        softOperation !== undefined &&
        current < limit.soft &&
        !state.operations.has(digest(softOperation))
          ? limit.soft
          : limit.hard;
      return Math.max(1, boundary - current);
    });
  });
  return [...taskDelays, ...workOrderDelays];
}

function effectiveMetricUsage(state: ProjectedBudget, metric: BudgetMetric, now: number): number {
  if (metric === "wallTimeMs") {
    return Math.max(0, now - state.createdAtMs);
  }
  if (metric === "idleTimeMs") {
    return Math.max(0, now - state.lastActivityAtMs);
  }
  return state.usage[metric] ?? 0;
}

function effectiveWorkOrderMetricUsage(
  workOrder: MutableWorkOrderBudget,
  metric: BudgetMetric,
  now: number,
): number {
  if (metric === "wallTimeMs") {
    return Math.max(0, now - workOrder.createdAtMs);
  }
  if (metric === "idleTimeMs") {
    return Math.max(0, now - workOrder.lastActivityAtMs);
  }
  return workOrder.usage[metric] ?? 0;
}

function normalizeProviderUsage(
  value: ProviderUsageEvidence | undefined,
): ProviderUsageEvidence | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new TypeError("Provider usage evidence is invalid.");
  }
  const allowed = ["inputTokens", "outputTokens", "cachedInputTokens", "costUsdMicros"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    throw new TypeError("Provider usage evidence is invalid.");
  }
  const result: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsdMicros?: number;
  } = {};
  for (const key of allowed as Array<keyof ProviderUsageEvidence>) {
    const amount = value[key];
    if (amount === undefined) {
      continue;
    }
    assertNonNegativeSafeInteger(amount, `provider ${key}`);
    result[key] = amount;
  }
  return Object.freeze(result);
}

function providerTokenTotal(usage: ProviderUsageEvidence | undefined): number | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const values = [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens].filter(
    (value): value is number => value !== undefined,
  );
  if (values.length === 0) {
    return undefined;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    throw new TypeError("Provider token usage exceeds safe accounting range.");
  }
  return total;
}

function validateUsageProxy(value: unknown): ProviderUsageProxy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tokensPerNativeTurn", "costUsdMicrosPerNativeTurn"])
  ) {
    throw new TypeError("Provider usage proxy configuration is invalid.");
  }
  assertNonNegativeSafeInteger(value["tokensPerNativeTurn"], "proxy tokens");
  assertNonNegativeSafeInteger(value["costUsdMicrosPerNativeTurn"], "proxy cost");
  if (value["tokensPerNativeTurn"] === 0 || value["costUsdMicrosPerNativeTurn"] === 0) {
    throw new TypeError("Provider usage proxies must be conservative positive values.");
  }
  return Object.freeze({
    tokensPerNativeTurn: value["tokensPerNativeTurn"],
    costUsdMicrosPerNativeTurn: value["costUsdMicrosPerNativeTurn"],
  });
}

function freezeLimits(value: BudgetLimits): BudgetLimits {
  const limits: BudgetLimits = {};
  for (const metric of budgetMetrics) {
    const limit = value[metric];
    if (limit !== undefined) {
      limits[metric] = Object.freeze(
        limit.soft === undefined ? { hard: limit.hard } : { soft: limit.soft, hard: limit.hard },
      );
    }
  }
  return Object.freeze(limits);
}

function cloneLimits(value: BudgetLimits): BudgetLimits {
  return freezeLimits(value);
}

function cloneUsage(
  value: Partial<Record<BudgetMetric, number>>,
): Partial<Record<BudgetMetric, number>> {
  const usage: Partial<Record<BudgetMetric, number>> = {};
  for (const metric of budgetMetrics) {
    if (value[metric] !== undefined) {
      usage[metric] = value[metric];
    }
  }
  return Object.freeze(usage);
}

function hardLimitError(
  taskId: string,
  metric: BudgetMetric,
  current: number,
  hard: number,
  attempted: number,
  workOrderId?: string,
): BudgetHardLimitError {
  return new BudgetHardLimitError({
    taskId,
    metric,
    current,
    hard,
    attempted,
    ...(workOrderId === undefined ? {} : { workOrderId }),
  });
}

function budgetStreamId(taskId: string): string {
  return `task-budget:${digest(taskId)}`;
}

function budgetMutationEventId(taskId: string, operationDigest: string): string {
  return `event_budget_${digest(`${taskId}\0${operationDigest}`)}`;
}

function timeSoftOperationId(
  metric: "wallTimeMs" | "idleTimeMs",
  soft: number,
  hard: number,
  workOrderId?: string,
): string {
  return `time-soft:${workOrderId ?? "task"}:${metric}:${String(soft)}:${String(hard)}`;
}

function timeHardOperationId(
  metric: "wallTimeMs" | "idleTimeMs",
  hard: number,
  workOrderId?: string,
): string {
  return `time-hard:${workOrderId ?? "task"}:${metric}:${String(hard)}`;
}

function readOperationDigest(value: unknown): string {
  if (!isRecord(value) || !isSha256(value["operationDigest"])) {
    throw corruptBudget();
  }
  return value["operationDigest"];
}

function fingerprint(value: unknown): string {
  return digest(canonicalJson(value));
}

function mutationFingerprint(taskId: string, draft: MutationDraft): string {
  return fingerprint({
    taskId,
    operationId: draft.operationId,
    source: draft.source,
    usageDelta: draft.usageDelta ?? {},
    workOrderUsageDelta: draft.workOrderUsageDelta ?? {},
    workOrderId: draft.workOrderId ?? null,
    registeredWorkOrders: draft.registeredWorkOrders ?? [],
    runStart: draft.runStart ?? null,
    runFinish: draft.runFinish ?? null,
    extension: draft.extension ?? null,
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Budget operation fingerprint input is invalid.");
}

function assertTaskId(value: unknown): asserts value is string {
  assertBoundedIdentifier(value, MAXIMUM_TASK_ID_BYTES, "Task ID");
}

function assertWorkOrderId(value: unknown): asserts value is string {
  assertBoundedIdentifier(value, MAXIMUM_TASK_ID_BYTES, "Work Order ID");
}

function assertOperationId(value: unknown): asserts value is string {
  assertBoundedIdentifier(value, MAXIMUM_OPERATION_ID_BYTES, "Budget operation ID");
}

function assertSource(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    value.includes("\0")
  ) {
    throw new TypeError("Budget source is invalid.");
  }
}

function assertBoundedIdentifier(
  value: unknown,
  maximum: number,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertNonNegativeFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number.`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function isTimestampMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAXIMUM_DATE_MS;
}

function isBudgetMetric(value: unknown): value is BudgetMetric {
  return typeof value === "string" && (budgetMetrics as readonly string[]).includes(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return isRecord(value) && methods.every((method) => typeof value[method] === "function");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
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

function corruptBudget(): TaskBudgetServiceError {
  return new TaskBudgetServiceError(
    "BUDGET_JOURNAL_CORRUPT",
    "The durable Task Budget journal is corrupt or internally inconsistent.",
  );
}

function budgetStorageFailed(): TaskBudgetServiceError {
  return new TaskBudgetServiceError(
    "BUDGET_STORAGE_UNAVAILABLE",
    "The durable Task Budget journal is unavailable.",
  );
}

function idempotencyConflict(): TaskBudgetServiceError {
  return new TaskBudgetServiceError(
    "BUDGET_IDEMPOTENCY_CONFLICT",
    "The Budget operation identity was reused with different content.",
  );
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
