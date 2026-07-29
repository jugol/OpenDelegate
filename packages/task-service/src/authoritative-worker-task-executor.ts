import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { EventStoreError, type EventStore, type StoredEvent } from "@opendelegate/event-store";
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  parseEventEnvelope,
  parseSemanticPlanningResponse,
  validateTaskContinuationCheckpoint,
  parseWorkerAgentRequirement,
  parseWorkerAgentSessionObservation,
  parseWorkOrder,
  type SequencedWorkerEventV1,
  type SemanticPlanningResponseV1,
  type WorkerAgentSessionObservationV1,
  type WorkerRunAssignmentV1,
  type WorkerProviderUsageV1,
  type WorkOrderV1,
  type TaskContinuationCheckpointV1,
} from "@opendelegate/protocol";

import {
  BudgetHardLimitError,
  TASK_BUDGET_EXHAUSTED_ABORT_REASON,
  type ProviderUsageEvidence,
  type TaskBudgetEnforcementPort,
} from "./durable-budget-enforcer.ts";
import type { TaskContinuationCheckpointPort } from "./task-continuation-checkpoint.ts";
import {
  TaskExecutorError,
  type TaskExecutionRequest,
  type TaskExecutionResult,
  type TaskExecutor,
} from "./task-execution-coordinator.ts";

const DEFAULT_LEASE_DURATION_MS = 5 * 60_000;
const MAXIMUM_LEASE_DURATION_MS = 24 * 60 * 60_000;
const MAXIMUM_WORK_ORDERS = 256;
const MAXIMUM_IDENTIFIER_BYTES = 512;
const MAXIMUM_PUBLIC_MESSAGE_BYTES = 32_768;
const MAXIMUM_REPORT_BYTES = 262_144;
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;
const MAXIMUM_DATE_MS = 8_640_000_000_000_000;

export type TaskWorkPlanDecision =
  | {
      readonly state: "failed" | "waiting_resource" | "waiting_user";
      readonly publicMessage?: string;
    }
  | {
      /**
       * A deterministic read-only answer synthesized exclusively from a bounded
       * Main-owned orchestration snapshot. The executor still requires its trusted
       * direct-completion authorizer to recognize this exact decision.
       */
      readonly state: "completed";
      readonly publicMessage: string;
      readonly verifiedCompletionCriteria: readonly string[];
    }
  | {
      readonly state: "ready";
      readonly plan: SemanticPlanningResponseV1;
    };

export interface TaskWorkPlanner {
  /**
   * Optional side-effect-free fast path evaluated before a native-turn Budget is
   * consumed. It may return only a deterministically authorized completion.
   */
  planDeterministically?(input: {
    readonly task: TaskExecutionRequest["task"];
    readonly attempt: number;
    readonly executionKey: string;
    readonly signal: AbortSignal;
  }): Promise<Extract<TaskWorkPlanDecision, { readonly state: "completed" }> | undefined>;
  plan(input: {
    readonly task: TaskExecutionRequest["task"];
    readonly attempt: number;
    readonly executionKey: string;
    readonly signal: AbortSignal;
  }): Promise<TaskWorkPlanDecision>;
}

export interface DirectPlanningCompletionAuthorizer {
  /**
   * Authorizes the narrow Main-owned, read-only completion exception.
   *
   * A planner decision is never sufficient authority on its own. Production
   * composition supplies an authorizer that recognizes only decisions produced
   * by a deterministic, side-effect-free query path.
   */
  authorize(input: {
    readonly task: TaskExecutionRequest["task"];
    readonly executionKey: string;
    readonly decision: Extract<TaskWorkPlanDecision, { readonly state: "completed" }>;
  }): boolean;
}

export interface WorkerDispatchTarget {
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
}

export interface WorkerDispatchTargetResolver {
  resolve(input: {
    readonly task: TaskExecutionRequest["task"];
    readonly workOrder: WorkOrderV1;
    readonly previousRuns: readonly WorkerRunAssignmentV1[];
    readonly signal: AbortSignal;
  }): Promise<WorkerDispatchTarget>;
}

/**
 * The dispatch adapter is an outbox seam, not a best-effort socket send. Repeating
 * one idempotency key and assignment after process restart must resolve to the same
 * durable outbound command and must never start a second Worker Run.
 */
export interface WorkerRunDispatchPort {
  enqueue(input: {
    readonly idempotencyKey: string;
    readonly assignment: WorkerRunAssignmentV1;
  }): Promise<void>;
  cancel?(input: {
    readonly idempotencyKey: string;
    readonly assignment: WorkerRunAssignmentV1;
    readonly reason: "cancelled" | "coordinator-closed" | "paused" | "superseded";
  }): Promise<void>;
}

export interface AuthoritativeWorkerReport {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly report: string;
  readonly artifactIds: readonly string[];
  readonly usage?: WorkerProviderUsageV1;
  readonly agentSession?: WorkerAgentSessionObservationV1;
  readonly acceptedAtMs: number;
}

export interface TaskEvidenceVerifier {
  /**
   * This seam is called only after every required Work Order has an accepted,
   * current, unexpired `worker.run.succeeded` report. It may judge semantic Task
   * criteria, but it cannot manufacture execution evidence.
   */
  verify(input: {
    readonly task: TaskExecutionRequest["task"];
    readonly workOrders: readonly WorkOrderV1[];
    readonly reports: readonly AuthoritativeWorkerReport[];
    readonly signal: AbortSignal;
  }): Promise<TaskExecutionResult>;
}

export interface AuthoritativeWorkerTaskExecutorClock {
  now(): number;
}

export interface AuthoritativeWorkerTaskExecutorIdSource {
  nextId(kind: "lease" | "run"): string;
}

export interface AuthoritativeWorkerTaskExecutorOptions {
  readonly eventStore: EventStore;
  readonly planner: TaskWorkPlanner;
  readonly targetResolver: WorkerDispatchTargetResolver;
  readonly dispatch: WorkerRunDispatchPort;
  readonly verifier: TaskEvidenceVerifier;
  readonly clock: AuthoritativeWorkerTaskExecutorClock;
  readonly idSource: AuthoritativeWorkerTaskExecutorIdSource;
  readonly leaseDurationMs?: number;
  readonly budget?: TaskBudgetEnforcementPort;
  readonly checkpoints?: TaskContinuationCheckpointPort;
  readonly directCompletionAuthorizer?: DirectPlanningCompletionAuthorizer;
}

export interface WorkerEventAcceptance {
  readonly disposition: "accepted" | "duplicate" | "rejected-stale";
  readonly messageId: string;
}

export interface WorkerArtifactRunScope {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
}

export type WorkerArtifactRunAuthorization =
  | {
      readonly authorized: true;
      readonly leaseExpiresAtMs: number;
      readonly workspaceId?: string;
    }
  | {
      readonly authorized: false;
    };

export type WorkerActionRunScope = WorkerArtifactRunScope;
export type WorkerActionRunAuthorization = WorkerArtifactRunAuthorization;

export interface WorkerRunLeaseRenewalRequest extends WorkerArtifactRunScope {
  readonly renewalId: string;
  readonly priorLeaseExpiresAtMs: number;
}

export type WorkerRunLeaseRenewalRejectionCode =
  | "RUN_LEASE_CHANGED"
  | "RUN_LEASE_EXPIRED"
  | "RUN_LEASE_NOT_DUE"
  | "RUN_NOT_ACTIVE"
  | "RUN_SCOPE_MISMATCH";

export type WorkerRunLeaseRenewalOutcome =
  | {
      readonly status: "renewed";
      readonly renewalId: string;
      readonly renewedAtMs: number;
      readonly priorLeaseExpiresAtMs: number;
      readonly leaseExpiresAtMs: number;
    }
  | {
      readonly status: "rejected";
      readonly renewalId: string;
      readonly decidedAtMs: number;
      readonly priorLeaseExpiresAtMs: number;
      readonly reasonCode: WorkerRunLeaseRenewalRejectionCode;
    };

interface ActiveTaskExecution {
  readonly controller: AbortController;
  readonly taskId: string;
  readonly assignments: Map<string, WorkerRunAssignmentV1>;
}

interface PersistedRunAssignment {
  assignment: WorkerRunAssignmentV1;
  readonly assignedAtMs: number;
  readonly executionKeyDigest: string;
  readonly workOrderFingerprint: string;
  status: RunStatus;
  retirementReason?: RunRetirementReason;
  terminalEvent?: AcceptedWorkerEvent;
}

type RunStatus =
  "assigned" | "cancelled" | "claimed" | "failed" | "rejected" | "retired" | "succeeded";

interface AcceptedWorkerEvent {
  readonly acceptedAtMs: number;
  readonly event: SequencedWorkerEventV1;
}

interface RejectedStaleWorkerEvent {
  readonly rejectedAtMs: number;
  readonly event: SequencedWorkerEventV1;
  readonly reasonCode: WorkerEventStaleReasonCode;
}

type WorkerEventStaleReasonCode = "RUN_LEASE_EXPIRED" | "RUN_NOT_CURRENT" | "RUN_TRANSITION_STALE";

interface RunJournalProjection {
  readonly version: number;
  readonly runs: readonly PersistedRunAssignment[];
  readonly acceptedEvents: readonly AcceptedWorkerEvent[];
  readonly rejectedStaleEvents: readonly RejectedStaleWorkerEvent[];
  readonly renewalDecisions: ReadonlyMap<
    string,
    {
      readonly requestFingerprint: string;
      readonly outcome: WorkerRunLeaseRenewalOutcome;
    }
  >;
  readonly lastAuthorityAtMs: number;
  readonly workOrderFingerprint?: string;
}

type WorkOrderExecution =
  | {
      readonly state: "succeeded";
      readonly report: AuthoritativeWorkerReport;
    }
  | {
      readonly state: "failed" | "waiting_resource";
      readonly publicMessage: string;
    };

interface PlanRecordedPayload {
  readonly schemaVersion: 1;
  readonly executionKeyDigest: string;
  readonly taskId: string;
  readonly plan: SemanticPlanningResponseV1;
}

interface RunAssignedPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly executionKeyDigest: string;
  readonly workOrderFingerprint: string;
  readonly assignedAtMs: number;
  readonly assignment: WorkerRunAssignmentV1;
}

interface WorkerEventAcceptedPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly acceptedAtMs: number;
  readonly event: SequencedWorkerEventV1;
}

interface WorkerEventRejectedStalePayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly rejectedAtMs: number;
  readonly reasonCode: WorkerEventStaleReasonCode;
  readonly event: SequencedWorkerEventV1;
}

interface RunRetiredPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly retiredAtMs: number;
  readonly reason: RunRetirementReason;
}

interface RunLeaseRenewalDecidedPayload {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly renewalId: string;
  readonly requestFingerprint: string;
  readonly decidedAtMs: number;
  readonly outcome: WorkerRunLeaseRenewalOutcome;
}

type RunRetirementReason = "cancelled" | "lease-expired" | "paused" | "superseded";

export class AuthoritativeWorkerTaskExecutor implements TaskExecutor {
  readonly #eventStore: EventStore;
  readonly #planner: TaskWorkPlanner;
  readonly #targetResolver: WorkerDispatchTargetResolver;
  readonly #dispatch: WorkerRunDispatchPort;
  readonly #verifier: TaskEvidenceVerifier;
  readonly #clock: AuthoritativeWorkerTaskExecutorClock;
  readonly #idSource: AuthoritativeWorkerTaskExecutorIdSource;
  readonly #budget: TaskBudgetEnforcementPort | undefined;
  readonly #checkpoints: TaskContinuationCheckpointPort | undefined;
  readonly #directCompletionAuthorizer: DirectPlanningCompletionAuthorizer | undefined;
  readonly #leaseDurationMs: number;
  readonly #active = new Map<string, ActiveTaskExecution>();
  readonly #runWaiters = new Map<string, Set<() => void>>();
  readonly #streamLocks = new Map<string, Promise<void>>();

  public constructor(options: AuthoritativeWorkerTaskExecutorOptions) {
    assertOptions(options);
    const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1 ||
      leaseDurationMs > MAXIMUM_LEASE_DURATION_MS
    ) {
      throw new TypeError("leaseDurationMs must be a safe integer between 1 and 86400000.");
    }
    this.#eventStore = options.eventStore;
    this.#planner = options.planner;
    this.#targetResolver = options.targetResolver;
    this.#dispatch = options.dispatch;
    this.#verifier = options.verifier;
    this.#clock = options.clock;
    this.#idSource = options.idSource;
    this.#budget = options.budget;
    this.#checkpoints = options.checkpoints;
    this.#directCompletionAuthorizer = options.directCompletionAuthorizer;
    this.#leaseDurationMs = leaseDurationMs;
  }

  public async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    assertExecutionRequest(request);
    if (this.#active.has(request.executionKey)) {
      throw new TaskExecutorError(
        "EXECUTION_ALREADY_ACTIVE",
        "The authoritative Worker execution is already active.",
      );
    }
    const active: ActiveTaskExecution = {
      controller: new AbortController(),
      taskId: request.task.taskId,
      assignments: new Map(),
    };
    this.#active.set(request.executionKey, active);
    const abortFromRequest = (): void => {
      active.controller.abort(request.signal.reason);
    };
    request.signal.addEventListener("abort", abortFromRequest, { once: true });
    if (request.signal.aborted) {
      abortFromRequest();
    }

    try {
      const planned = await this.#loadOrCreatePlan(request, active.controller.signal);
      if (planned.state === "completed") {
        return {
          state: "completed",
          publicMessage: planned.publicMessage,
          verifiedCompletionCriteria: planned.verifiedCompletionCriteria,
        };
      }
      if (planned.state !== "ready") {
        return {
          state: planned.state,
          ...(planned.publicMessage === undefined
            ? {}
            : { publicMessage: validatePublicMessage(planned.publicMessage) }),
        };
      }
      const workOrders = planned.plan.workOrders;
      await this.#budget?.registerWorkOrders({
        taskId: request.task.taskId,
        operationId: `authoritative-plan:${request.planningKey}`,
        workOrders,
      });
      const result = await this.#executeDependencyWaves(
        request,
        workOrders,
        active,
        active.controller.signal,
      );
      if (result.state !== "succeeded") {
        return {
          state: result.state,
          publicMessage: result.publicMessage,
        };
      }
      assertNotAborted(active.controller.signal);
      await this.#budget?.beginNativeTurn({
        taskId: request.task.taskId,
        operationId: `authoritative-verifier:${request.executionKey}`,
        source: "main-verifier",
      });
      const verification = await this.#verifier.verify({
        task: request.task,
        workOrders,
        reports: result.reports,
        signal: active.controller.signal,
      });
      assertNotAborted(active.controller.signal);
      return validateVerifierResult(verification, request.task.completionCriteria);
    } catch (error) {
      const cancellationReason = cancellationReasonFromAbort(active.controller.signal);
      if (cancellationReason !== undefined) {
        try {
          await this.#cancelAssignments(active, cancellationReason);
        } catch (cancellationError) {
          throw new TaskExecutorError(
            "WORKER_CANCELLATION_FAILED",
            "The active Worker Run could not be durably fenced during cancellation.",
            true,
            { cause: cancellationError },
          );
        }
      }
      throw error;
    } finally {
      request.signal.removeEventListener("abort", abortFromRequest);
      this.#active.delete(request.executionKey);
    }
  }

  public async cancel(input: {
    readonly taskId: string;
    readonly executionKey: string;
    readonly reason: "cancelled" | "coordinator-closed" | "paused" | "superseded";
  }): Promise<void> {
    if (!isRecord(input) || !isCancellationReason(input.reason)) {
      throw new TypeError("The authoritative Worker cancellation is invalid.");
    }
    assertIdentifier(input.taskId, "Task ID");
    assertIdentifier(input.executionKey, "execution key");
    const active = this.#active.get(input.executionKey);
    if (active === undefined) {
      return;
    }
    if (active.taskId !== input.taskId) {
      throw new TaskExecutorError(
        "CANCELLATION_SCOPE_INVALID",
        "The Task cancellation does not match the active execution.",
      );
    }
    active.controller.abort(input.reason);
    await this.#cancelAssignments(active, input.reason);
  }

  /**
   * Main's authenticated Device-channel callback enters here. Durable acceptance,
   * not callback return text or Worker timestamps, is the authority instant.
   */
  public async acceptWorkerEvents(
    authenticatedDeviceId: string,
    input: readonly SequencedWorkerEventV1[],
  ): Promise<readonly WorkerEventAcceptance[]> {
    assertIdentifier(authenticatedDeviceId, "authenticated Device ID");
    if (!Array.isArray(input) || input.length === 0 || input.length > 256) {
      throw new TaskExecutorError(
        "WORKER_EVENT_INVALID",
        "The Worker event batch is outside the supported bound.",
      );
    }
    const accepted: WorkerEventAcceptance[] = [];
    for (const rawEvent of input) {
      const event = normalizeWorkerEvent(rawEvent, authenticatedDeviceId);
      const streamId = runStreamId(event.payload.taskId, event.payload.workOrderId);
      const disposition = await this.#withStreamLock(streamId, async () => {
        const projection = await this.#loadRunJournal(
          event.payload.taskId,
          event.payload.workOrderId,
        );
        const matchingIdentities = [
          ...projection.acceptedEvents.map((candidate) => ({
            disposition: "duplicate" as const,
            event: candidate.event,
          })),
          ...projection.rejectedStaleEvents.map((candidate) => ({
            disposition: "rejected-stale" as const,
            event: candidate.event,
          })),
        ].filter(
          (candidate) =>
            candidate.event.messageId === event.messageId ||
            candidate.event.idempotencyKey === event.idempotencyKey,
        );
        if (matchingIdentities.length > 0) {
          if (
            matchingIdentities.length !== 1 ||
            !isDeepStrictEqual(matchingIdentities[0]?.event, event)
          ) {
            throw new TaskExecutorError(
              "WORKER_EVENT_IDEMPOTENCY_CONFLICT",
              "A Worker event identity was reused with different content.",
            );
          }
          return matchingIdentities[0]!.disposition;
        }

        const decidedAtMs = this.#now();
        if (decidedAtMs < projection.lastAuthorityAtMs) {
          throw staleCompletion(event.payload.runId);
        }
        const current = projection.runs.at(-1);
        if (current === undefined || !eventMatchesAssignment(event, current.assignment)) {
          const historical = projection.runs.find((candidate) =>
            eventMatchesAssignment(event, candidate.assignment),
          );
          if (historical === undefined) {
            throw invalidWorkerEvent();
          }
          assertAgentSessionMatchesAssignment(event, historical.assignment);
          await this.#recordStaleWorkerEvent(
            streamId,
            projection,
            event,
            "RUN_NOT_CURRENT",
            decidedAtMs,
          );
          return "rejected-stale" as const;
        }
        assertAgentSessionMatchesAssignment(event, current.assignment);
        if (decidedAtMs >= current.assignment.leaseExpiresAtMs) {
          await this.#recordStaleWorkerEvent(
            streamId,
            projection,
            event,
            "RUN_LEASE_EXPIRED",
            decidedAtMs,
          );
          return "rejected-stale" as const;
        }
        if (!isWorkerEventTransitionCurrent(current, event)) {
          await this.#recordStaleWorkerEvent(
            streamId,
            projection,
            event,
            "RUN_TRANSITION_STALE",
            decidedAtMs,
          );
          return "rejected-stale" as const;
        }
        assertWorkerEventTransition(current, event);
        const payload: WorkerEventAcceptedPayload = {
          schemaVersion: 1,
          taskId: event.payload.taskId,
          workOrderId: event.payload.workOrderId,
          acceptedAtMs: decidedAtMs,
          event,
        };
        await this.#appendEvent({
          streamId,
          expectedVersion: projection.version,
          eventId: acceptedWorkerEventId(event),
          type: "task.worker-event-accepted",
          payload,
          occurredAt: new Date(decidedAtMs).toISOString(),
        });
        return "accepted" as const;
      });
      accepted.push(
        Object.freeze({
          disposition,
          messageId: event.messageId,
        }),
      );
      if (disposition !== "rejected-stale") {
        if (event.type === "worker.run.claimed") {
          await this.#budget?.recordActivity({
            taskId: event.payload.taskId,
            workOrderId: event.payload.workOrderId,
            operationId: `worker-event:${event.messageId}`,
            source: "worker-run-claimed",
          });
        } else {
          await this.#finishBudgetForEvent(event);
        }
        this.#notifyRun(event.payload.runId);
      }
    }
    return Object.freeze(accepted);
  }

  async #recordStaleWorkerEvent(
    streamId: string,
    projection: RunJournalProjection,
    event: SequencedWorkerEventV1,
    reasonCode: WorkerEventStaleReasonCode,
    rejectedAtMs = this.#now(),
  ): Promise<void> {
    const payload: WorkerEventRejectedStalePayload = {
      schemaVersion: 1,
      taskId: event.payload.taskId,
      workOrderId: event.payload.workOrderId,
      rejectedAtMs,
      reasonCode,
      event,
    };
    await this.#appendEvent({
      streamId,
      expectedVersion: projection.version,
      eventId: rejectedStaleWorkerEventId(event),
      type: "task.worker-event-rejected-stale",
      payload,
      occurredAt: new Date(rejectedAtMs).toISOString(),
    });
  }

  public async authorizeWorkerArtifactRun(
    authenticatedDeviceId: string,
    scope: WorkerArtifactRunScope,
  ): Promise<WorkerArtifactRunAuthorization> {
    assertIdentifier(authenticatedDeviceId, "authenticated Device ID");
    for (const [value, label] of [
      [scope.taskId, "Task ID"],
      [scope.workOrderId, "Work Order ID"],
      [scope.deviceId, "Device ID"],
      [scope.workerId, "Worker ID"],
      [scope.routeId, "route ID"],
      [scope.runId, "Run ID"],
      [scope.leaseId, "lease ID"],
    ] as const) {
      assertIdentifier(value, label);
    }
    if (!Number.isSafeInteger(scope.fencingToken) || scope.fencingToken <= 0) {
      throw new TaskExecutorError(
        "WORKER_EVENT_INVALID",
        "The Artifact Run fencing token is invalid.",
      );
    }
    if (scope.deviceId !== authenticatedDeviceId) {
      return Object.freeze({ authorized: false });
    }
    const streamId = runStreamId(scope.taskId, scope.workOrderId);
    return this.#withStreamLock(streamId, async () => {
      const projection = await this.#loadRunJournal(scope.taskId, scope.workOrderId);
      const current = projection.runs.at(-1);
      const currentTime = this.#now();
      if (
        current === undefined ||
        isTerminal(current.status) ||
        currentTime < projection.lastAuthorityAtMs ||
        currentTime >= current.assignment.leaseExpiresAtMs ||
        !artifactScopeMatchesAssignment(scope, current.assignment)
      ) {
        return Object.freeze({ authorized: false });
      }
      const workspaceId = current.assignment.workOrder.workspaceId;
      return Object.freeze({
        authorized: true,
        leaseExpiresAtMs: current.assignment.leaseExpiresAtMs,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      });
    });
  }

  /**
   * Mutating Worker actions share the same authoritative Run projection as
   * Artifact preparation. The action layer adds its own exact two-phase Policy
   * permit; this method proves only that the underlying Run lease/fence is current.
   */
  public async authorizeWorkerActionRun(
    authenticatedDeviceId: string,
    scope: WorkerActionRunScope,
  ): Promise<WorkerActionRunAuthorization> {
    return await this.authorizeWorkerArtifactRun(authenticatedDeviceId, scope);
  }

  /**
   * Renews one exact current Run lease under Main's durable clock. The command ID
   * is a durable identity: exact replay returns the original decision, while reuse
   * with different content fails closed and cannot extend authority twice.
   */
  public async renewWorkerRunLease(
    authenticatedDeviceId: string,
    input: WorkerRunLeaseRenewalRequest,
  ): Promise<WorkerRunLeaseRenewalOutcome> {
    assertIdentifier(authenticatedDeviceId, "authenticated Device ID");
    const request = normalizeRunLeaseRenewalRequest(input);
    const requestFingerprint = fingerprint(request);
    const streamId = runStreamId(request.taskId, request.workOrderId);
    let retireExpired: WorkerRunAssignmentV1 | undefined;
    const outcome = await this.#withStreamLock(streamId, async () => {
      const projection = await this.#loadRunJournal(request.taskId, request.workOrderId);
      const replay = projection.renewalDecisions.get(request.renewalId);
      if (replay !== undefined) {
        if (replay.requestFingerprint !== requestFingerprint) {
          throw new TaskExecutorError(
            "RUN_LEASE_RENEWAL_IDEMPOTENCY_CONFLICT",
            "The Run lease renewal identity was reused with different content.",
          );
        }
        return replay.outcome;
      }

      const decidedAtMs = this.#now();
      if (decidedAtMs < projection.lastAuthorityAtMs) {
        throw corruptState();
      }
      const current = projection.runs.at(-1);
      let decision: WorkerRunLeaseRenewalOutcome;
      if (current === undefined || isTerminal(current.status)) {
        decision = rejectedRenewal(request, decidedAtMs, "RUN_NOT_ACTIVE");
      } else if (
        authenticatedDeviceId !== request.deviceId ||
        !artifactScopeMatchesAssignment(request, current.assignment)
      ) {
        decision = rejectedRenewal(request, decidedAtMs, "RUN_SCOPE_MISMATCH");
      } else if (decidedAtMs >= current.assignment.leaseExpiresAtMs) {
        decision = rejectedRenewal(request, decidedAtMs, "RUN_LEASE_EXPIRED");
        retireExpired = current.assignment;
      } else if (request.priorLeaseExpiresAtMs !== current.assignment.leaseExpiresAtMs) {
        decision = rejectedRenewal(request, decidedAtMs, "RUN_LEASE_CHANGED");
      } else {
        const leaseExpiresAtMs = decidedAtMs + this.#leaseDurationMs;
        if (!Number.isSafeInteger(leaseExpiresAtMs) || leaseExpiresAtMs > MAXIMUM_DATE_MS) {
          throw new TaskExecutorError(
            "CLOCK_VALUE_INVALID",
            "The renewed Run lease expiry is invalid.",
          );
        }
        if (leaseExpiresAtMs <= current.assignment.leaseExpiresAtMs) {
          decision = rejectedRenewal(request, decidedAtMs, "RUN_LEASE_NOT_DUE");
        } else {
          decision = deepFreeze({
            status: "renewed",
            renewalId: request.renewalId,
            renewedAtMs: decidedAtMs,
            priorLeaseExpiresAtMs: request.priorLeaseExpiresAtMs,
            leaseExpiresAtMs,
          });
        }
      }

      const payload: RunLeaseRenewalDecidedPayload = {
        schemaVersion: 1,
        taskId: request.taskId,
        workOrderId: request.workOrderId,
        renewalId: request.renewalId,
        requestFingerprint,
        decidedAtMs,
        outcome: decision,
      };
      await this.#appendEvent({
        streamId,
        expectedVersion: projection.version,
        eventId: runLeaseRenewalEventId(request.taskId, request.workOrderId, request.renewalId),
        type: "task.worker-run-lease-renewal-decided",
        payload,
        occurredAt: new Date(decidedAtMs).toISOString(),
      });
      return decision;
    });
    if (retireExpired !== undefined) {
      await this.#retireExpiredRun(request.taskId, request.workOrderId, retireExpired);
    }
    this.#notifyRun(request.runId);
    return outcome;
  }

  async #loadOrCreatePlan(
    request: TaskExecutionRequest,
    signal: AbortSignal,
  ): Promise<TaskWorkPlanDecision> {
    assertNotAborted(signal);
    const deterministic = await this.#planner.planDeterministically?.({
      task: request.task,
      attempt: request.attempt,
      executionKey: request.planningKey,
      signal,
    });
    if (deterministic !== undefined) {
      assertNotAborted(signal);
      return this.#validateDirectPlanningCompletion(request, deterministic);
    }
    const existing = await this.#loadPlan(request.planningKey, request.task.taskId);
    if (existing !== undefined) {
      return { state: "ready", plan: existing };
    }
    await this.#budget?.beginNativeTurn({
      taskId: request.task.taskId,
      operationId: `authoritative-planner:${request.planningKey}`,
      source: "main-planner",
    });
    const decision = await this.#planner.plan({
      task: request.task,
      attempt: request.attempt,
      executionKey: request.planningKey,
      signal,
    });
    assertNotAborted(signal);
    if (
      decision.state === "failed" ||
      decision.state === "waiting_resource" ||
      decision.state === "waiting_user"
    ) {
      return {
        state: decision.state,
        ...(decision.publicMessage === undefined
          ? {}
          : { publicMessage: validatePublicMessage(decision.publicMessage) }),
      };
    }
    if (decision.state === "completed") {
      return this.#validateDirectPlanningCompletion(request, decision);
    }
    if (decision.state !== "ready") {
      throw new TaskExecutorError(
        "WORK_PLAN_INVALID",
        "The Main Agent returned an invalid Work Order planning decision.",
      );
    }
    const plan = validatePlan(decision.plan, request.task.taskId);
    const streamId = planStreamId(request.planningKey);
    const payload: PlanRecordedPayload = {
      schemaVersion: 1,
      executionKeyDigest: digest(request.planningKey),
      taskId: request.task.taskId,
      plan,
    };
    await this.#appendEvent({
      streamId,
      expectedVersion: 0,
      eventId: `event_plan_${digest(request.planningKey)}`,
      type: "task.worker-plan-recorded",
      payload,
    });
    return {
      state: "ready",
      plan: (await this.#loadPlan(request.planningKey, request.task.taskId)) ?? plan,
    };
  }

  #validateDirectPlanningCompletion(
    request: TaskExecutionRequest,
    decision: Extract<TaskWorkPlanDecision, { readonly state: "completed" }>,
  ): Extract<TaskWorkPlanDecision, { readonly state: "completed" }> {
    if (
      this.#directCompletionAuthorizer?.authorize({
        task: request.task,
        executionKey: request.planningKey,
        decision,
      }) !== true
    ) {
      throw new TaskExecutorError(
        "WORK_PLAN_INVALID",
        "A planning answer cannot complete a Task without deterministic read-only authority.",
      );
    }
    const completed = validateVerifierResult(
      {
        state: "completed",
        publicMessage: decision.publicMessage,
        verifiedCompletionCriteria: decision.verifiedCompletionCriteria,
      },
      request.task.completionCriteria,
    );
    if (completed.state !== "completed") {
      throw invalidVerifierResult();
    }
    return {
      state: "completed",
      publicMessage: validatePublicMessage(decision.publicMessage),
      verifiedCompletionCriteria: completed.verifiedCompletionCriteria,
    };
  }

  async #loadPlan(
    executionKey: string,
    taskId: string,
  ): Promise<SemanticPlanningResponseV1 | undefined> {
    const events = await this.#readStream(planStreamId(executionKey));
    if (events.length === 0) {
      return undefined;
    }
    if (events.length !== 1) {
      throw corruptState();
    }
    const event = events[0];
    if (
      event === undefined ||
      event.streamVersion !== 1 ||
      event.eventId !== `event_plan_${digest(executionKey)}` ||
      event.type !== "task.worker-plan-recorded" ||
      !isRecord(event.payload) ||
      !hasExactKeys(event.payload, ["schemaVersion", "executionKeyDigest", "taskId", "plan"]) ||
      event.payload["schemaVersion"] !== 1 ||
      event.payload["executionKeyDigest"] !== digest(executionKey) ||
      event.payload["taskId"] !== taskId
    ) {
      throw corruptState();
    }
    return validatePlan(event.payload["plan"], taskId);
  }

  async #executeDependencyWaves(
    request: TaskExecutionRequest,
    workOrders: readonly WorkOrderV1[],
    active: ActiveTaskExecution,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly state: "succeeded";
        readonly reports: readonly AuthoritativeWorkerReport[];
      }
    | {
        readonly state: "failed" | "waiting_resource";
        readonly publicMessage: string;
      }
  > {
    const reports = new Map<string, AuthoritativeWorkerReport>();
    const pending = new Set(workOrders.map((workOrder) => workOrder.workOrderId));
    while (pending.size > 0) {
      assertNotAborted(signal);
      const ready = workOrders.filter(
        (workOrder) =>
          pending.has(workOrder.workOrderId) &&
          workOrder.dependsOn.every((dependency) => reports.has(dependency)),
      );
      if (ready.length === 0) {
        throw new TaskExecutorError(
          "WORK_PLAN_INVALID",
          "The Work Order dependency graph cannot make progress.",
        );
      }
      const settlements = await Promise.allSettled(
        ready.map((workOrder) => this.#executeWorkOrder(request, workOrder, active, signal)),
      );
      const rejected = settlements.find(
        (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
      );
      if (rejected !== undefined) {
        throw rejected.reason;
      }
      let failed: Extract<WorkOrderExecution, { state: "failed" | "waiting_resource" }> | undefined;
      settlements.forEach((settlement, index) => {
        if (settlement.status !== "fulfilled") {
          return;
        }
        const workOrder = ready[index];
        if (workOrder === undefined) {
          throw corruptState();
        }
        if (settlement.value.state === "succeeded") {
          reports.set(workOrder.workOrderId, settlement.value.report);
          pending.delete(workOrder.workOrderId);
        } else {
          failed ??= settlement.value;
        }
      });
      if (failed !== undefined) {
        return failed;
      }
    }
    return {
      state: "succeeded",
      reports: Object.freeze(
        workOrders.map((workOrder) => {
          const report = reports.get(workOrder.workOrderId);
          if (report === undefined) {
            throw corruptState();
          }
          return report;
        }),
      ),
    };
  }

  async #executeWorkOrder(
    request: TaskExecutionRequest,
    workOrder: WorkOrderV1,
    active: ActiveTaskExecution,
    signal: AbortSignal,
  ): Promise<WorkOrderExecution> {
    const executionKeyDigest = digest(request.executionKey);
    const projection = await this.#loadRunJournal(request.task.taskId, workOrder.workOrderId);
    const workOrderFingerprint = fingerprint(workOrder);
    if (
      projection.workOrderFingerprint !== undefined &&
      projection.workOrderFingerprint !== workOrderFingerprint
    ) {
      throw new TaskExecutorError(
        "WORK_ORDER_ID_CONFLICT",
        "A Work Order ID was reused for different durable execution content.",
      );
    }
    let current = projection.runs.at(-1);
    if (current?.status === "succeeded") {
      await this.#finishBudgetForPersistedRun(current);
      return {
        state: "succeeded",
        report: reportFrom(current),
      };
    }
    if (
      current !== undefined &&
      isTerminal(current.status) &&
      current.executionKeyDigest === executionKeyDigest
    ) {
      await this.#finishBudgetForPersistedRun(current);
      return failureFrom(current);
    }
    if (current !== undefined && !isTerminal(current.status)) {
      const now = this.#now();
      if (now < projection.lastAuthorityAtMs) {
        throw corruptState();
      }
      if (now >= current.assignment.leaseExpiresAtMs) {
        await this.#retireExpiredRun(
          request.task.taskId,
          workOrder.workOrderId,
          current.assignment,
        );
        return {
          state: "waiting_resource",
          publicMessage: "The Worker Run lease expired before an authoritative completion arrived.",
        };
      }
    } else {
      current = await this.#createRun(
        request,
        workOrder,
        projection,
        executionKeyDigest,
        workOrderFingerprint,
        signal,
      );
    }
    active.assignments.set(current.assignment.runId, current.assignment);
    assertNotAborted(signal);
    try {
      await this.#budget?.beginWorkerRun({
        taskId: request.task.taskId,
        workOrderId: workOrder.workOrderId,
        runId: current.assignment.runId,
        attempt: current.assignment.fencingToken,
      });
    } catch (error) {
      if (error instanceof BudgetHardLimitError) {
        await this.#retireRun(
          request.task.taskId,
          workOrder.workOrderId,
          current.assignment,
          "paused",
          false,
        );
        active.assignments.delete(current.assignment.runId);
      }
      throw error;
    }
    try {
      await this.#dispatch.enqueue({
        idempotencyKey: dispatchIdempotencyKey(current.assignment),
        assignment: current.assignment,
      });
    } catch {
      throw new TaskExecutorError(
        "WORKER_DISPATCH_FAILED",
        "The durable Worker dispatch outbox could not accept the Run assignment.",
        true,
      );
    }
    const terminal = await this.#waitForTerminal(
      request.task.taskId,
      workOrder.workOrderId,
      current.assignment,
      signal,
    );
    active.assignments.delete(current.assignment.runId);
    await this.#finishBudgetForPersistedRun(terminal);
    if (terminal.status === "succeeded") {
      return {
        state: "succeeded",
        report: reportFrom(terminal),
      };
    }
    return failureFrom(terminal);
  }

  async #createRun(
    request: TaskExecutionRequest,
    workOrder: WorkOrderV1,
    projection: RunJournalProjection,
    executionKeyDigest: string,
    workOrderFingerprint: string,
    signal: AbortSignal,
  ): Promise<PersistedRunAssignment> {
    assertNotAborted(signal);
    const target = validateTarget(
      await this.#targetResolver.resolve({
        task: request.task,
        workOrder,
        previousRuns: projection.runs.map((run) => run.assignment),
        signal,
      }),
    );
    assertNotAborted(signal);
    const assignedAtMs = this.#now();
    if (assignedAtMs < projection.lastAuthorityAtMs) {
      throw corruptState();
    }
    const runId = this.#nextId("run");
    const leaseId = this.#nextId("lease");
    if (
      projection.runs.some(
        (run) => run.assignment.runId === runId || run.assignment.leaseId === leaseId,
      )
    ) {
      throw new TaskExecutorError(
        "RUN_ID_CONFLICT",
        "The Run identity source reused a durable identifier.",
      );
    }
    const leaseExpiresAtMs = assignedAtMs + this.#leaseDurationMs;
    if (!Number.isSafeInteger(leaseExpiresAtMs) || leaseExpiresAtMs > MAXIMUM_DATE_MS) {
      throw new TaskExecutorError("CLOCK_VALUE_INVALID", "The Run lease expiry is invalid.");
    }
    let continuationCheckpoint: TaskContinuationCheckpointV1 | undefined;
    if (this.#checkpoints !== undefined) {
      try {
        continuationCheckpoint = validateTaskContinuationCheckpoint(
          await this.#checkpoints.build(request.task.taskId),
        );
      } catch {
        throw new TaskExecutorError(
          "TASK_CHECKPOINT_UNAVAILABLE",
          "The authoritative Worker continuation checkpoint is unavailable.",
          true,
        );
      }
      if (
        continuationCheckpoint.taskId !== request.task.taskId ||
        !continuationCheckpoint.pendingWorkOrders.some(
          (candidate) => candidate.workOrderId === workOrder.workOrderId,
        )
      ) {
        throw new TaskExecutorError(
          "TASK_CHECKPOINT_MISMATCH",
          "The Worker continuation checkpoint does not bind this Task and Work Order.",
        );
      }
    }
    assertNotAborted(signal);
    const assignment: WorkerRunAssignmentV1 = deepFreeze({
      taskId: request.task.taskId,
      workOrder,
      ...(continuationCheckpoint === undefined ? {} : { continuationCheckpoint }),
      ...(workOrder.requiredAgent === undefined
        ? {}
        : { agentRequirement: workOrder.requiredAgent }),
      ...target,
      runId,
      leaseId,
      fencingToken:
        projection.runs.reduce(
          (maximum, run) => Math.max(maximum, run.assignment.fencingToken),
          0,
        ) + 1,
      leaseExpiresAtMs,
    });
    const payload: RunAssignedPayload = {
      schemaVersion: 1,
      taskId: request.task.taskId,
      workOrderId: workOrder.workOrderId,
      executionKeyDigest,
      workOrderFingerprint,
      assignedAtMs,
      assignment,
    };
    await this.#appendEvent({
      streamId: runStreamId(request.task.taskId, workOrder.workOrderId),
      expectedVersion: projection.version,
      eventId: `event_run_assigned_${digest(`${request.task.taskId}\0${workOrder.workOrderId}\0${runId}`)}`,
      type: "task.worker-run-assigned",
      payload,
      occurredAt: new Date(assignedAtMs).toISOString(),
    });
    const persisted = (
      await this.#loadRunJournal(request.task.taskId, workOrder.workOrderId)
    ).runs.at(-1);
    if (persisted === undefined || persisted.assignment.runId !== runId) {
      throw corruptState();
    }
    return persisted;
  }

  async #waitForTerminal(
    taskId: string,
    workOrderId: string,
    assignment: WorkerRunAssignmentV1,
    signal: AbortSignal,
  ): Promise<PersistedRunAssignment> {
    while (true) {
      assertNotAborted(signal);
      const projection = await this.#loadRunJournal(taskId, workOrderId);
      const current = projection.runs.at(-1);
      if (current === undefined || current.assignment.runId !== assignment.runId) {
        throw staleCompletion(assignment.runId);
      }
      if (isTerminal(current.status)) {
        return current;
      }
      const now = this.#now();
      if (now < projection.lastAuthorityAtMs) {
        throw corruptState();
      }
      if (now >= current.assignment.leaseExpiresAtMs) {
        await this.#retireExpiredRun(taskId, workOrderId, current.assignment);
        continue;
      }
      await this.#waitForRunChange(
        assignment.runId,
        current.assignment.leaseExpiresAtMs - now,
        signal,
      );
    }
  }

  async #waitForRunChange(
    runId: string,
    untilExpiryMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiters = this.#runWaiters.get(runId) ?? new Set<() => void>();
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        waiters.delete(finish);
        if (waiters.size === 0) {
          this.#runWaiters.delete(runId);
        }
        resolve();
      };
      const abort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) {
          this.#runWaiters.delete(runId);
        }
        reject(cancelled());
      };
      const timer = setTimeout(
        finish,
        Math.max(1, Math.min(untilExpiryMs, MAXIMUM_TIMER_DELAY_MS)),
      );
      timer.unref();
      waiters.add(finish);
      this.#runWaiters.set(runId, waiters);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  }

  async #retireExpiredRun(
    taskId: string,
    workOrderId: string,
    assignment: WorkerRunAssignmentV1,
  ): Promise<void> {
    await this.#retireRun(taskId, workOrderId, assignment, "lease-expired");
  }

  async #retireRun(
    taskId: string,
    workOrderId: string,
    assignment: WorkerRunAssignmentV1,
    reason: RunRetirementReason,
    finishBudget = true,
  ): Promise<boolean> {
    const streamId = runStreamId(taskId, workOrderId);
    const retired = await this.#withStreamLock(streamId, async () => {
      const projection = await this.#loadRunJournal(taskId, workOrderId);
      const current = projection.runs.at(-1);
      if (
        current === undefined ||
        current.assignment.runId !== assignment.runId ||
        isTerminal(current.status)
      ) {
        return false;
      }
      const retiredAtMs = this.#now();
      if (retiredAtMs < projection.lastAuthorityAtMs) {
        throw corruptState();
      }
      if (reason === "lease-expired" && retiredAtMs < assignment.leaseExpiresAtMs) {
        return false;
      }
      const payload: RunRetiredPayload = {
        schemaVersion: 1,
        taskId,
        workOrderId,
        runId: assignment.runId,
        leaseId: assignment.leaseId,
        fencingToken: assignment.fencingToken,
        retiredAtMs,
        reason,
      };
      await this.#appendEvent({
        streamId,
        expectedVersion: projection.version,
        eventId: `event_run_retired_${digest(`${taskId}\0${workOrderId}\0${assignment.runId}`)}`,
        type: "task.worker-run-retired",
        payload,
        occurredAt: new Date(retiredAtMs).toISOString(),
      });
      return true;
    });
    if (retired && finishBudget) {
      await this.#budget?.finishWorkerRun({
        taskId,
        workOrderId,
        runId: assignment.runId,
      });
      this.#notifyRun(assignment.runId);
    }
    return retired;
  }

  async #loadRunJournal(taskId: string, workOrderId: string): Promise<RunJournalProjection> {
    const events = await this.#readStream(runStreamId(taskId, workOrderId));
    const runs: PersistedRunAssignment[] = [];
    const acceptedEvents: AcceptedWorkerEvent[] = [];
    const rejectedStaleEvents: RejectedStaleWorkerEvent[] = [];
    const renewalDecisions = new Map<
      string,
      {
        readonly requestFingerprint: string;
        readonly outcome: WorkerRunLeaseRenewalOutcome;
      }
    >();
    let lastAuthorityAtMs = 0;
    let workOrderFingerprint: string | undefined;
    for (const [index, event] of events.entries()) {
      if (event.streamVersion !== index + 1) {
        throw corruptState();
      }
      if (event.type === "task.worker-run-assigned") {
        const payload = parseRunAssignedPayload(event.payload, taskId, workOrderId);
        const prior = runs.at(-1);
        if (
          event.eventId !==
            `event_run_assigned_${digest(`${taskId}\0${workOrderId}\0${payload.assignment.runId}`)}` ||
          event.occurredAt !== new Date(payload.assignedAtMs).toISOString() ||
          (prior !== undefined && !isTerminal(prior.status)) ||
          (prior !== undefined &&
            payload.assignment.fencingToken <= prior.assignment.fencingToken) ||
          payload.assignedAtMs < lastAuthorityAtMs
        ) {
          throw corruptState();
        }
        workOrderFingerprint ??= payload.workOrderFingerprint;
        if (workOrderFingerprint !== payload.workOrderFingerprint) {
          throw corruptState();
        }
        runs.push({
          assignment: payload.assignment,
          assignedAtMs: payload.assignedAtMs,
          executionKeyDigest: payload.executionKeyDigest,
          workOrderFingerprint: payload.workOrderFingerprint,
          status: "assigned",
        });
        lastAuthorityAtMs = payload.assignedAtMs;
        continue;
      }
      const current = runs.at(-1);
      if (event.type === "task.worker-run-lease-renewal-decided") {
        const payload = parseRunLeaseRenewalDecidedPayload(event.payload, taskId, workOrderId);
        if (
          event.eventId !== runLeaseRenewalEventId(taskId, workOrderId, payload.renewalId) ||
          event.occurredAt !== new Date(payload.decidedAtMs).toISOString() ||
          payload.decidedAtMs < lastAuthorityAtMs ||
          renewalDecisions.has(payload.renewalId) ||
          (current === undefined &&
            (payload.outcome.status !== "rejected" ||
              payload.outcome.reasonCode !== "RUN_NOT_ACTIVE"))
        ) {
          throw corruptState();
        }
        if (payload.outcome.status === "renewed") {
          if (
            current === undefined ||
            isTerminal(current.status) ||
            payload.outcome.priorLeaseExpiresAtMs !== current.assignment.leaseExpiresAtMs ||
            payload.outcome.renewedAtMs !== payload.decidedAtMs ||
            payload.outcome.leaseExpiresAtMs <= current.assignment.leaseExpiresAtMs ||
            payload.decidedAtMs >= current.assignment.leaseExpiresAtMs
          ) {
            throw corruptState();
          }
          current.assignment = deepFreeze({
            ...current.assignment,
            leaseExpiresAtMs: payload.outcome.leaseExpiresAtMs,
          });
        }
        renewalDecisions.set(payload.renewalId, {
          requestFingerprint: payload.requestFingerprint,
          outcome: payload.outcome,
        });
        lastAuthorityAtMs = payload.decidedAtMs;
        continue;
      }
      if (event.type === "task.worker-event-rejected-stale") {
        const payload = parseWorkerEventRejectedStalePayload(event.payload, taskId, workOrderId);
        if (
          event.eventId !== rejectedStaleWorkerEventId(payload.event) ||
          event.occurredAt !== new Date(payload.rejectedAtMs).toISOString() ||
          payload.rejectedAtMs < lastAuthorityAtMs ||
          [...acceptedEvents, ...rejectedStaleEvents].some(
            (candidate) =>
              candidate.event.messageId === payload.event.messageId ||
              candidate.event.idempotencyKey === payload.event.idempotencyKey,
          ) ||
          !staleReasonMatchesProjection(payload, runs, current)
        ) {
          throw corruptState();
        }
        rejectedStaleEvents.push({
          rejectedAtMs: payload.rejectedAtMs,
          reasonCode: payload.reasonCode,
          event: payload.event,
        });
        lastAuthorityAtMs = payload.rejectedAtMs;
        continue;
      }
      if (current === undefined) {
        throw corruptState();
      }
      if (event.type === "task.worker-event-accepted") {
        const payload = parseWorkerEventAcceptedPayload(event.payload, taskId, workOrderId);
        if (
          event.eventId !== acceptedWorkerEventId(payload.event) ||
          event.occurredAt !== new Date(payload.acceptedAtMs).toISOString() ||
          payload.acceptedAtMs < lastAuthorityAtMs ||
          payload.acceptedAtMs >= current.assignment.leaseExpiresAtMs ||
          !eventMatchesAssignment(payload.event, current.assignment)
        ) {
          throw corruptState();
        }
        assertAgentSessionMatchesAssignment(payload.event, current.assignment, true);
        assertWorkerEventTransition(current, payload.event, true);
        current.status = runStatusFor(payload.event.type);
        const accepted = {
          acceptedAtMs: payload.acceptedAtMs,
          event: payload.event,
        };
        if (isTerminal(current.status)) {
          current.terminalEvent = accepted;
        }
        acceptedEvents.push(accepted);
        lastAuthorityAtMs = payload.acceptedAtMs;
        continue;
      }
      if (event.type === "task.worker-run-retired") {
        const payload = parseRunRetiredPayload(event.payload, taskId, workOrderId);
        if (
          event.eventId !==
            `event_run_retired_${digest(`${taskId}\0${workOrderId}\0${payload.runId}`)}` ||
          event.occurredAt !== new Date(payload.retiredAtMs).toISOString() ||
          isTerminal(current.status) ||
          payload.runId !== current.assignment.runId ||
          payload.leaseId !== current.assignment.leaseId ||
          payload.fencingToken !== current.assignment.fencingToken ||
          (payload.reason === "lease-expired" &&
            payload.retiredAtMs < current.assignment.leaseExpiresAtMs) ||
          payload.retiredAtMs < lastAuthorityAtMs
        ) {
          throw corruptState();
        }
        current.status = "retired";
        current.retirementReason = payload.reason;
        lastAuthorityAtMs = payload.retiredAtMs;
        continue;
      }
      throw corruptState();
    }
    return {
      version: events.length,
      runs,
      acceptedEvents,
      rejectedStaleEvents,
      renewalDecisions,
      lastAuthorityAtMs,
      ...(workOrderFingerprint === undefined ? {} : { workOrderFingerprint }),
    };
  }

  async #appendEvent(input: {
    readonly streamId: string;
    readonly expectedVersion: number;
    readonly eventId: string;
    readonly type: string;
    readonly payload: object;
    readonly occurredAt?: string;
  }): Promise<void> {
    try {
      await this.#eventStore.append({
        streamId: input.streamId,
        expectedVersion: input.expectedVersion,
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        events: [
          {
            eventId: input.eventId,
            type: input.type,
            payload: input.payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof EventStoreError) {
        throw new TaskExecutorError(
          "WORKER_RUN_STATE_CONFLICT",
          "The durable Worker Run journal could not accept the transition.",
          error.code === "STREAM_VERSION_CONFLICT",
        );
      }
      throw error;
    }
  }

  async #readStream(streamId: string): Promise<readonly StoredEvent[]> {
    try {
      return await this.#eventStore.readStream(streamId);
    } catch {
      throw new TaskExecutorError(
        "WORKER_RUN_STATE_FAILED",
        "The durable Worker Run journal is unavailable.",
        true,
      );
    }
  }

  async #withStreamLock<TResult>(
    streamId: string,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.#streamLocks.get(streamId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.#streamLocks.set(streamId, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#streamLocks.get(streamId) === chained) {
        this.#streamLocks.delete(streamId);
      }
    }
  }

  async #cancelAssignments(
    active: ActiveTaskExecution,
    reason: "cancelled" | "coordinator-closed" | "paused" | "superseded",
  ): Promise<void> {
    if (reason === "coordinator-closed") {
      return;
    }
    await Promise.all(
      [...active.assignments.values()].map(async (assignment) => {
        try {
          const retired = await this.#retireRun(
            assignment.taskId,
            assignment.workOrder.workOrderId,
            assignment,
            reason,
            false,
          );
          if (!retired) {
            return;
          }
          if (this.#dispatch.cancel !== undefined) {
            try {
              await this.#dispatch.cancel({
                idempotencyKey: `cancel:${assignment.runId}:${String(assignment.fencingToken)}`,
                assignment,
                reason,
              });
            } catch {
              // The durable retirement fences late completion; channel cancellation is best effort.
            }
          }
          await this.#budget?.finishWorkerRun({
            taskId: assignment.taskId,
            workOrderId: assignment.workOrder.workOrderId,
            runId: assignment.runId,
          });
        } finally {
          active.assignments.delete(assignment.runId);
          this.#notifyRun(assignment.runId);
        }
      }),
    );
  }

  #notifyRun(runId: string): void {
    for (const notify of this.#runWaiters.get(runId) ?? []) {
      notify();
    }
  }

  #now(): number {
    const value = this.#clock.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_DATE_MS) {
      throw new TaskExecutorError("CLOCK_VALUE_INVALID", "The Run authority clock is invalid.");
    }
    return value;
  }

  #nextId(kind: "lease" | "run"): string {
    const value = this.#idSource.nextId(kind);
    assertIdentifier(value, `${kind} ID`);
    return value;
  }

  async #finishBudgetForEvent(event: SequencedWorkerEventV1): Promise<void> {
    await this.#budget?.finishWorkerRun({
      taskId: event.payload.taskId,
      workOrderId: event.payload.workOrderId,
      runId: event.payload.runId,
      ...(event.payload.usage === undefined
        ? {}
        : { usage: providerUsageEvidence(event.payload.usage) }),
    });
  }

  async #finishBudgetForPersistedRun(run: PersistedRunAssignment): Promise<void> {
    const terminal = run.terminalEvent?.event;
    await this.#budget?.finishWorkerRun({
      taskId: run.assignment.taskId,
      workOrderId: run.assignment.workOrder.workOrderId,
      runId: run.assignment.runId,
      ...(terminal?.payload.usage === undefined
        ? {}
        : { usage: providerUsageEvidence(terminal.payload.usage) }),
    });
  }
}

function validatePlan(value: unknown, taskId: string): SemanticPlanningResponseV1 {
  let plan: SemanticPlanningResponseV1;
  try {
    plan = parseSemanticPlanningResponse(value);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new TaskExecutorError(
        "WORK_PLAN_INVALID",
        "The Work Order plan failed protocol validation.",
      );
    }
    throw error;
  }
  if (
    plan.taskId !== taskId ||
    plan.workOrders.length === 0 ||
    plan.workOrders.length > MAXIMUM_WORK_ORDERS
  ) {
    throw new TaskExecutorError("WORK_PLAN_INVALID", "The Work Order plan is outside Task scope.");
  }
  const workOrderIds = new Set(plan.workOrders.map((workOrder) => workOrder.workOrderId));
  if (workOrderIds.size !== plan.workOrders.length) {
    throw new TaskExecutorError("WORK_PLAN_INVALID", "Work Order IDs must be unique.");
  }
  for (const workOrder of plan.workOrders) {
    if (
      workOrder.dependsOn.includes(workOrder.workOrderId) ||
      workOrder.dependsOn.some((dependency) => !workOrderIds.has(dependency))
    ) {
      throw new TaskExecutorError(
        "WORK_PLAN_INVALID",
        "A Work Order dependency is missing or self-referential.",
      );
    }
  }
  assertAcyclic(plan.workOrders);
  return deepFreeze(structuredClone(plan));
}

function assertAcyclic(workOrders: readonly WorkOrderV1[]): void {
  const byId = new Map(workOrders.map((workOrder) => [workOrder.workOrderId, workOrder] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (workOrderId: string): void => {
    if (visiting.has(workOrderId)) {
      throw new TaskExecutorError(
        "WORK_PLAN_INVALID",
        "The Work Order dependency graph is cyclic.",
      );
    }
    if (visited.has(workOrderId)) {
      return;
    }
    visiting.add(workOrderId);
    for (const dependency of byId.get(workOrderId)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(workOrderId);
    visited.add(workOrderId);
  };
  for (const workOrder of workOrders) {
    visit(workOrder.workOrderId);
  }
}

function normalizeWorkerEvent(
  value: SequencedWorkerEventV1,
  authenticatedDeviceId: string,
): SequencedWorkerEventV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "messageId",
      "senderDeviceId",
      "correlationId",
      "createdAt",
      "idempotencyKey",
      "type",
      "payload",
      "sequence",
    ])
  ) {
    throw invalidWorkerEvent();
  }
  if (
    value.protocolVersion !== PROTOCOL_VERSION ||
    value.senderDeviceId !== authenticatedDeviceId ||
    !isWorkerEventType(value.type) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence <= 0
  ) {
    throw invalidWorkerEvent();
  }
  for (const [entry, label] of [
    [value.messageId, "message ID"],
    [value.senderDeviceId, "sender Device ID"],
    [value.correlationId, "correlation ID"],
    [value.idempotencyKey, "idempotency key"],
  ] as const) {
    assertIdentifier(entry, label);
  }
  try {
    parseEventEnvelope(value);
  } catch {
    throw invalidWorkerEvent();
  }
  if (!isRecord(value.payload)) {
    throw invalidWorkerEvent();
  }
  const allowedPayloadKeys = new Set([
    "taskId",
    "workOrderId",
    "deviceId",
    "workerId",
    "routeId",
    "runId",
    "leaseId",
    "fencingToken",
    "report",
    "artifactIds",
    "diagnostic",
    "usage",
    "agentSession",
  ]);
  if (
    !Object.keys(value.payload).every((key) => allowedPayloadKeys.has(key)) ||
    ![
      "taskId",
      "workOrderId",
      "deviceId",
      "workerId",
      "routeId",
      "runId",
      "leaseId",
      "fencingToken",
    ].every((key) => Object.prototype.hasOwnProperty.call(value.payload, key))
  ) {
    throw invalidWorkerEvent();
  }
  const payload = value.payload;
  for (const [entry, label] of [
    [payload.taskId, "Task ID"],
    [payload.workOrderId, "Work Order ID"],
    [payload.deviceId, "Device ID"],
    [payload.workerId, "Worker ID"],
    [payload.routeId, "route ID"],
    [payload.runId, "Run ID"],
    [payload.leaseId, "lease ID"],
  ] as const) {
    assertIdentifier(entry, label);
  }
  if (
    payload.deviceId !== authenticatedDeviceId ||
    value.senderDeviceId !== payload.deviceId ||
    value.correlationId !== payload.taskId ||
    !Number.isSafeInteger(payload.fencingToken) ||
    payload.fencingToken <= 0
  ) {
    throw invalidWorkerEvent();
  }
  if (value.type === "worker.run.claimed") {
    if (
      payload.report !== undefined ||
      payload.artifactIds !== undefined ||
      payload.diagnostic !== undefined ||
      payload.usage !== undefined ||
      payload.agentSession !== undefined
    ) {
      throw invalidWorkerEvent();
    }
  } else if (
    typeof payload.report !== "string" ||
    payload.report.trim().length === 0 ||
    Buffer.byteLength(payload.report, "utf8") > MAXIMUM_REPORT_BYTES ||
    payload.report.includes("\0")
  ) {
    throw invalidWorkerEvent();
  }
  if (
    payload.artifactIds !== undefined &&
    (!Array.isArray(payload.artifactIds) ||
      new Set(payload.artifactIds).size !== payload.artifactIds.length ||
      payload.artifactIds.some((artifactId) => {
        try {
          assertIdentifier(artifactId, "Artifact ID");
          return false;
        } catch {
          return true;
        }
      }))
  ) {
    throw invalidWorkerEvent();
  }
  if (payload.usage !== undefined) {
    normalizeWorkerProviderUsage(payload.usage);
  }
  if (payload.agentSession !== undefined) {
    try {
      parseWorkerAgentSessionObservation(payload.agentSession);
    } catch {
      throw invalidWorkerEvent();
    }
  }
  if (
    payload.diagnostic !== undefined &&
    (!isRecord(payload.diagnostic) || !isJsonCompatible(payload.diagnostic, new WeakSet()))
  ) {
    throw invalidWorkerEvent();
  }
  return deepFreeze(structuredClone(value));
}

function normalizeWorkerProviderUsage(value: unknown): WorkerProviderUsageV1 {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !Object.keys(value).every((key) =>
      ["inputTokens", "outputTokens", "cachedInputTokens", "costUsdMicros"].includes(key),
    )
  ) {
    throw invalidWorkerEvent();
  }
  const usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsdMicros?: number;
  } = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "costUsdMicros",
  ] as const) {
    const amount = value[key];
    if (amount === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(amount) || Number(amount) < 0) {
      throw invalidWorkerEvent();
    }
    usage[key] = amount as number;
  }
  return deepFreeze(usage);
}

function providerUsageEvidence(value: WorkerProviderUsageV1): ProviderUsageEvidence {
  return normalizeWorkerProviderUsage(value);
}

function assertWorkerEventTransition(
  current: PersistedRunAssignment,
  event: SequencedWorkerEventV1,
  replay = false,
): void {
  if (!isWorkerEventTransitionCurrent(current, event)) {
    throw replay ? corruptState() : staleCompletion(event.payload.runId);
  }
}

function isWorkerEventTransitionCurrent(
  current: PersistedRunAssignment,
  event: SequencedWorkerEventV1,
): boolean {
  return event.type === "worker.run.claimed"
    ? current.status === "assigned"
    : current.status === "claimed";
}

function staleReasonMatchesProjection(
  payload: WorkerEventRejectedStalePayload,
  runs: readonly PersistedRunAssignment[],
  current: PersistedRunAssignment | undefined,
): boolean {
  const assignmentMatches =
    current !== undefined && eventMatchesAssignment(payload.event, current.assignment);
  if (payload.reasonCode === "RUN_NOT_CURRENT") {
    const historical = runs.find((candidate) =>
      eventMatchesAssignment(payload.event, candidate.assignment),
    );
    if (assignmentMatches || historical === undefined) {
      return false;
    }
    assertAgentSessionMatchesAssignment(payload.event, historical.assignment, true);
    return true;
  }
  if (!assignmentMatches || current === undefined) {
    return false;
  }
  assertAgentSessionMatchesAssignment(payload.event, current.assignment, true);
  if (payload.reasonCode === "RUN_LEASE_EXPIRED") {
    return payload.rejectedAtMs >= current.assignment.leaseExpiresAtMs;
  }
  return (
    payload.rejectedAtMs < current.assignment.leaseExpiresAtMs &&
    !isWorkerEventTransitionCurrent(current, payload.event)
  );
}

function isWorkerEventStaleReasonCode(value: unknown): value is WorkerEventStaleReasonCode {
  return (
    value === "RUN_LEASE_EXPIRED" || value === "RUN_NOT_CURRENT" || value === "RUN_TRANSITION_STALE"
  );
}

function parseRunAssignedPayload(
  value: unknown,
  taskId: string,
  workOrderId: string,
): RunAssignedPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "taskId",
      "workOrderId",
      "executionKeyDigest",
      "workOrderFingerprint",
      "assignedAtMs",
      "assignment",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["taskId"] !== taskId ||
    value["workOrderId"] !== workOrderId ||
    !isSha256(value["executionKeyDigest"]) ||
    !isSha256(value["workOrderFingerprint"]) ||
    !isTimestampMs(value["assignedAtMs"])
  ) {
    throw corruptState();
  }
  const assignment = normalizeAssignment(value["assignment"], taskId, workOrderId);
  if (
    fingerprint(assignment.workOrder) !== value["workOrderFingerprint"] ||
    assignment.leaseExpiresAtMs <= value["assignedAtMs"]
  ) {
    throw corruptState();
  }
  return {
    schemaVersion: 1,
    taskId,
    workOrderId,
    executionKeyDigest: value["executionKeyDigest"],
    workOrderFingerprint: value["workOrderFingerprint"],
    assignedAtMs: value["assignedAtMs"],
    assignment,
  };
}

function parseWorkerEventAcceptedPayload(
  value: unknown,
  taskId: string,
  workOrderId: string,
): WorkerEventAcceptedPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "taskId", "workOrderId", "acceptedAtMs", "event"]) ||
    value["schemaVersion"] !== 1 ||
    value["taskId"] !== taskId ||
    value["workOrderId"] !== workOrderId ||
    !isTimestampMs(value["acceptedAtMs"]) ||
    !isRecord(value["event"]) ||
    typeof value["event"]["senderDeviceId"] !== "string"
  ) {
    throw corruptState();
  }
  let event: SequencedWorkerEventV1;
  try {
    event = normalizeWorkerEvent(
      value["event"] as unknown as SequencedWorkerEventV1,
      value["event"]["senderDeviceId"],
    );
  } catch {
    throw corruptState();
  }
  return {
    schemaVersion: 1,
    taskId,
    workOrderId,
    acceptedAtMs: value["acceptedAtMs"],
    event,
  };
}

function parseWorkerEventRejectedStalePayload(
  value: unknown,
  taskId: string,
  workOrderId: string,
): WorkerEventRejectedStalePayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "taskId",
      "workOrderId",
      "rejectedAtMs",
      "reasonCode",
      "event",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["taskId"] !== taskId ||
    value["workOrderId"] !== workOrderId ||
    !isTimestampMs(value["rejectedAtMs"]) ||
    !isWorkerEventStaleReasonCode(value["reasonCode"]) ||
    !isRecord(value["event"]) ||
    typeof value["event"]["senderDeviceId"] !== "string"
  ) {
    throw corruptState();
  }
  let event: SequencedWorkerEventV1;
  try {
    event = normalizeWorkerEvent(
      value["event"] as unknown as SequencedWorkerEventV1,
      value["event"]["senderDeviceId"],
    );
  } catch {
    throw corruptState();
  }
  return {
    schemaVersion: 1,
    taskId,
    workOrderId,
    rejectedAtMs: value["rejectedAtMs"],
    reasonCode: value["reasonCode"],
    event,
  };
}

function parseRunRetiredPayload(
  value: unknown,
  taskId: string,
  workOrderId: string,
): RunRetiredPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "taskId",
      "workOrderId",
      "runId",
      "leaseId",
      "fencingToken",
      "retiredAtMs",
      "reason",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["taskId"] !== taskId ||
    value["workOrderId"] !== workOrderId ||
    !isRunRetirementReason(value["reason"]) ||
    !Number.isSafeInteger(value["fencingToken"]) ||
    Number(value["fencingToken"]) <= 0 ||
    !isTimestampMs(value["retiredAtMs"])
  ) {
    throw corruptState();
  }
  try {
    assertIdentifier(value["runId"], "Run ID");
    assertIdentifier(value["leaseId"], "lease ID");
  } catch {
    throw corruptState();
  }
  return {
    schemaVersion: 1,
    taskId,
    workOrderId,
    runId: value["runId"],
    leaseId: value["leaseId"],
    fencingToken: value["fencingToken"] as number,
    retiredAtMs: value["retiredAtMs"],
    reason: value["reason"],
  };
}

function parseRunLeaseRenewalDecidedPayload(
  value: unknown,
  taskId: string,
  workOrderId: string,
): RunLeaseRenewalDecidedPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "taskId",
      "workOrderId",
      "renewalId",
      "requestFingerprint",
      "decidedAtMs",
      "outcome",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["taskId"] !== taskId ||
    value["workOrderId"] !== workOrderId ||
    !isSha256(value["requestFingerprint"]) ||
    !isTimestampMs(value["decidedAtMs"])
  ) {
    throw corruptState();
  }
  try {
    assertIdentifier(value["renewalId"], "renewal ID");
  } catch {
    throw corruptState();
  }
  const outcome = parseRunLeaseRenewalOutcome(
    value["outcome"],
    value["renewalId"],
    value["decidedAtMs"],
  );
  return {
    schemaVersion: 1,
    taskId,
    workOrderId,
    renewalId: value["renewalId"],
    requestFingerprint: value["requestFingerprint"],
    decidedAtMs: value["decidedAtMs"],
    outcome,
  };
}

function parseRunLeaseRenewalOutcome(
  value: unknown,
  renewalId: string,
  decidedAtMs: number,
): WorkerRunLeaseRenewalOutcome {
  if (!isRecord(value)) {
    throw corruptState();
  }
  if (value["status"] === "renewed") {
    if (
      !hasExactKeys(value, [
        "status",
        "renewalId",
        "renewedAtMs",
        "priorLeaseExpiresAtMs",
        "leaseExpiresAtMs",
      ]) ||
      value["renewalId"] !== renewalId ||
      value["renewedAtMs"] !== decidedAtMs ||
      !isTimestampMs(value["priorLeaseExpiresAtMs"]) ||
      !isTimestampMs(value["leaseExpiresAtMs"]) ||
      Number(value["leaseExpiresAtMs"]) <= Number(value["priorLeaseExpiresAtMs"])
    ) {
      throw corruptState();
    }
    return deepFreeze({
      status: "renewed",
      renewalId,
      renewedAtMs: decidedAtMs,
      priorLeaseExpiresAtMs: value["priorLeaseExpiresAtMs"] as number,
      leaseExpiresAtMs: value["leaseExpiresAtMs"] as number,
    });
  }
  if (
    value["status"] !== "rejected" ||
    !hasExactKeys(value, [
      "status",
      "renewalId",
      "decidedAtMs",
      "priorLeaseExpiresAtMs",
      "reasonCode",
    ]) ||
    value["renewalId"] !== renewalId ||
    value["decidedAtMs"] !== decidedAtMs ||
    !isTimestampMs(value["priorLeaseExpiresAtMs"]) ||
    !isRunLeaseRenewalRejectionCode(value["reasonCode"])
  ) {
    throw corruptState();
  }
  return deepFreeze({
    status: "rejected",
    renewalId,
    decidedAtMs,
    priorLeaseExpiresAtMs: value["priorLeaseExpiresAtMs"] as number,
    reasonCode: value["reasonCode"],
  });
}

function normalizeRunLeaseRenewalRequest(
  value: WorkerRunLeaseRenewalRequest,
): WorkerRunLeaseRenewalRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "taskId",
      "workOrderId",
      "deviceId",
      "workerId",
      "routeId",
      "runId",
      "leaseId",
      "fencingToken",
      "renewalId",
      "priorLeaseExpiresAtMs",
    ]) ||
    !Number.isSafeInteger(value.fencingToken) ||
    value.fencingToken <= 0 ||
    !isTimestampMs(value.priorLeaseExpiresAtMs)
  ) {
    throw new TaskExecutorError(
      "RUN_LEASE_RENEWAL_INVALID",
      "The Run lease renewal request is invalid.",
    );
  }
  try {
    for (const [entry, label] of [
      [value.taskId, "Task ID"],
      [value.workOrderId, "Work Order ID"],
      [value.deviceId, "Device ID"],
      [value.workerId, "Worker ID"],
      [value.routeId, "route ID"],
      [value.runId, "Run ID"],
      [value.leaseId, "lease ID"],
      [value.renewalId, "renewal ID"],
    ] as const) {
      assertIdentifier(entry, label);
    }
  } catch {
    throw new TaskExecutorError(
      "RUN_LEASE_RENEWAL_INVALID",
      "The Run lease renewal request is invalid.",
    );
  }
  return deepFreeze(structuredClone(value));
}

function rejectedRenewal(
  request: WorkerRunLeaseRenewalRequest,
  decidedAtMs: number,
  reasonCode: WorkerRunLeaseRenewalRejectionCode,
): WorkerRunLeaseRenewalOutcome {
  return deepFreeze({
    status: "rejected",
    renewalId: request.renewalId,
    decidedAtMs,
    priorLeaseExpiresAtMs: request.priorLeaseExpiresAtMs,
    reasonCode,
  });
}

function normalizeAssignment(
  value: unknown,
  taskId: string,
  workOrderId: string,
): WorkerRunAssignmentV1 {
  if (!isRecord(value)) {
    throw corruptState();
  }
  const requiredKeys = [
    "taskId",
    "workOrder",
    "deviceId",
    "workerId",
    "routeId",
    "runId",
    "leaseId",
    "fencingToken",
    "leaseExpiresAtMs",
  ];
  if (
    !hasAllowedAndRequiredKeys(
      value,
      [...requiredKeys, "agentRequirement", "continuationCheckpoint"],
      requiredKeys,
    ) ||
    value["taskId"] !== taskId ||
    !Number.isSafeInteger(value["fencingToken"]) ||
    Number(value["fencingToken"]) <= 0 ||
    !isTimestampMs(value["leaseExpiresAtMs"])
  ) {
    throw corruptState();
  }
  let workOrder: WorkOrderV1;
  let agentRequirement: WorkerRunAssignmentV1["agentRequirement"];
  let continuationCheckpoint: WorkerRunAssignmentV1["continuationCheckpoint"];
  try {
    workOrder = parseWorkOrder(value["workOrder"]);
    agentRequirement =
      value["agentRequirement"] === undefined
        ? undefined
        : parseWorkerAgentRequirement(value["agentRequirement"]);
    continuationCheckpoint =
      value["continuationCheckpoint"] === undefined
        ? undefined
        : validateTaskContinuationCheckpoint(value["continuationCheckpoint"]);
    for (const key of ["deviceId", "workerId", "routeId", "runId", "leaseId"] as const) {
      assertIdentifier(value[key], key);
    }
  } catch {
    throw corruptState();
  }
  if (workOrder.workOrderId !== workOrderId) {
    throw corruptState();
  }
  if (
    continuationCheckpoint !== undefined &&
    (continuationCheckpoint.taskId !== taskId ||
      !continuationCheckpoint.pendingWorkOrders.some(
        (candidate) => candidate.workOrderId === workOrderId,
      ))
  ) {
    throw corruptState();
  }
  if (
    workOrder.requiredAgent !== undefined &&
    (agentRequirement === undefined ||
      !isDeepStrictEqual(agentRequirement, workOrder.requiredAgent))
  ) {
    throw corruptState();
  }
  return deepFreeze({
    taskId,
    workOrder,
    ...(continuationCheckpoint === undefined ? {} : { continuationCheckpoint }),
    ...(agentRequirement === undefined ? {} : { agentRequirement }),
    deviceId: value["deviceId"] as string,
    workerId: value["workerId"] as string,
    routeId: value["routeId"] as string,
    runId: value["runId"] as string,
    leaseId: value["leaseId"] as string,
    fencingToken: value["fencingToken"] as number,
    leaseExpiresAtMs: value["leaseExpiresAtMs"] as number,
  });
}

function reportFrom(run: PersistedRunAssignment): AuthoritativeWorkerReport {
  const terminal = run.terminalEvent;
  if (
    run.status !== "succeeded" ||
    terminal === undefined ||
    terminal.event.type !== "worker.run.succeeded" ||
    terminal.event.payload.report === undefined
  ) {
    throw corruptState();
  }
  return deepFreeze({
    taskId: terminal.event.payload.taskId,
    workOrderId: terminal.event.payload.workOrderId,
    deviceId: terminal.event.payload.deviceId,
    workerId: terminal.event.payload.workerId,
    routeId: terminal.event.payload.routeId,
    runId: terminal.event.payload.runId,
    leaseId: terminal.event.payload.leaseId,
    fencingToken: terminal.event.payload.fencingToken,
    report: terminal.event.payload.report,
    artifactIds: Object.freeze([...(terminal.event.payload.artifactIds ?? [])]),
    ...(terminal.event.payload.usage === undefined
      ? {}
      : { usage: normalizeWorkerProviderUsage(terminal.event.payload.usage) }),
    ...(terminal.event.payload.agentSession === undefined
      ? {}
      : {
          agentSession: parseWorkerAgentSessionObservation(terminal.event.payload.agentSession),
        }),
    acceptedAtMs: terminal.acceptedAtMs,
  });
}

function assertAgentSessionMatchesAssignment(
  event: SequencedWorkerEventV1,
  assignment: WorkerRunAssignmentV1,
  replay = false,
): void {
  const session = event.payload.agentSession;
  if (
    event.type === "worker.run.succeeded" &&
    assignment.agentRequirement !== undefined &&
    session === undefined
  ) {
    throw replay ? corruptState() : invalidWorkerEvent();
  }
  if (session === undefined || assignment.agentRequirement === undefined) {
    return;
  }
  const requirement = assignment.agentRequirement;
  if (
    session.provider !== requirement.provider ||
    (requirement.adapterId !== undefined && session.adapterId !== requirement.adapterId)
  ) {
    throw replay ? corruptState() : invalidWorkerEvent();
  }
}

function failureFrom(
  run: PersistedRunAssignment,
): Extract<WorkOrderExecution, { state: "failed" | "waiting_resource" }> {
  if (run.status === "retired") {
    if (run.retirementReason !== undefined && run.retirementReason !== "lease-expired") {
      return {
        state: "failed",
        publicMessage: `The Worker Run was retired because its Task execution was ${run.retirementReason}.`,
      };
    }
    return {
      state: "waiting_resource",
      publicMessage: "The Worker Run lease expired before an authoritative completion arrived.",
    };
  }
  const terminal = run.terminalEvent;
  if (
    terminal === undefined ||
    terminal.event.type === "worker.run.claimed" ||
    terminal.event.type === "worker.run.succeeded" ||
    terminal.event.payload.report === undefined
  ) {
    throw corruptState();
  }
  const diagnostic: unknown = terminal.event.payload.diagnostic;
  const retryable = isRecord(diagnostic) && diagnostic["retryable"] === true;
  return {
    state: retryable ? "waiting_resource" : "failed",
    publicMessage: terminal.event.payload.report,
  };
}

function validateVerifierResult(
  value: TaskExecutionResult,
  completionCriteria: readonly string[],
): TaskExecutionResult {
  if (!isRecord(value) || typeof value["state"] !== "string") {
    throw invalidVerifierResult();
  }
  if (value.state === "completed") {
    if (
      !hasAllowedAndRequiredKeys(
        value,
        ["state", "verifiedCompletionCriteria", "publicMessage"],
        ["state", "verifiedCompletionCriteria"],
      ) ||
      !Array.isArray(value.verifiedCompletionCriteria) ||
      value.verifiedCompletionCriteria.some((criterion) => typeof criterion !== "string") ||
      !sameSet(value.verifiedCompletionCriteria, completionCriteria)
    ) {
      throw invalidVerifierResult();
    }
    return {
      state: "completed",
      verifiedCompletionCriteria: Object.freeze([...completionCriteria]),
      ...(value.publicMessage === undefined
        ? {}
        : { publicMessage: validatePublicMessage(value.publicMessage) }),
    };
  }
  if (
    (value.state === "waiting_user" ||
      value.state === "waiting_resource" ||
      value.state === "review" ||
      value.state === "failed") &&
    hasAllowedAndRequiredKeys(value, ["state", "publicMessage"], ["state"])
  ) {
    return {
      state: value.state,
      ...(value.publicMessage === undefined
        ? {}
        : { publicMessage: validatePublicMessage(value.publicMessage) }),
    };
  }
  throw invalidVerifierResult();
}

function validateTarget(value: WorkerDispatchTarget): WorkerDispatchTarget {
  if (!isRecord(value) || !hasExactKeys(value, ["deviceId", "workerId", "routeId"])) {
    throw new TaskExecutorError(
      "WORKER_SELECTION_INVALID",
      "The Worker target resolver returned an invalid selection.",
    );
  }
  try {
    assertIdentifier(value.deviceId, "Device ID");
    assertIdentifier(value.workerId, "Worker ID");
    assertIdentifier(value.routeId, "route ID");
  } catch {
    throw new TaskExecutorError(
      "WORKER_SELECTION_INVALID",
      "The Worker target resolver returned an invalid selection.",
    );
  }
  return Object.freeze({ ...value });
}

function validatePublicMessage(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_PUBLIC_MESSAGE_BYTES ||
    value.includes("\0")
  ) {
    throw new TaskExecutorError(
      "EXECUTOR_RESULT_INVALID",
      "The Task executor returned an invalid public message.",
    );
  }
  return value;
}

function assertOptions(options: AuthoritativeWorkerTaskExecutorOptions): void {
  if (
    !isRecord(options) ||
    !hasMethods(options.eventStore, ["append", "readStream"]) ||
    !hasMethods(options.planner, ["plan"]) ||
    (options.planner.planDeterministically !== undefined &&
      typeof options.planner.planDeterministically !== "function") ||
    !hasMethods(options.targetResolver, ["resolve"]) ||
    !hasMethods(options.dispatch, ["enqueue"]) ||
    !hasMethods(options.verifier, ["verify"]) ||
    !hasMethods(options.clock, ["now"]) ||
    !hasMethods(options.idSource, ["nextId"]) ||
    (options.checkpoints !== undefined && !hasMethods(options.checkpoints, ["build"])) ||
    (options.directCompletionAuthorizer !== undefined &&
      !hasMethods(options.directCompletionAuthorizer, ["authorize"])) ||
    (options.budget !== undefined &&
      !hasMethods(options.budget, [
        "ensureTask",
        "beginTaskExecution",
        "registerWorkOrders",
        "beginNativeTurn",
        "beginWorkerRun",
        "finishWorkerRun",
        "recordActivity",
      ]))
  ) {
    throw new TypeError("Authoritative Worker Task executor options are invalid.");
  }
}

function assertExecutionRequest(request: TaskExecutionRequest): void {
  if (
    !isRecord(request) ||
    !isRecord(request.task) ||
    typeof request.executionKey !== "string" ||
    typeof request.planningKey !== "string" ||
    !Number.isSafeInteger(request.attempt) ||
    request.attempt < 1 ||
    !isRecord(request.signal)
  ) {
    throw new TypeError("The Task execution request is invalid.");
  }
  assertIdentifier(request.executionKey, "execution key");
  assertIdentifier(request.planningKey, "planning key");
  assertIdentifier(request.task.taskId, "Task ID");
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_IDENTIFIER_BYTES ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new TaskExecutorError("IDENTIFIER_INVALID", `${label} is invalid.`);
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelled();
  }
}

function eventMatchesAssignment(
  event: SequencedWorkerEventV1,
  assignment: WorkerRunAssignmentV1,
): boolean {
  return (
    event.payload.taskId === assignment.taskId &&
    event.payload.workOrderId === assignment.workOrder.workOrderId &&
    event.payload.deviceId === assignment.deviceId &&
    event.payload.workerId === assignment.workerId &&
    event.payload.routeId === assignment.routeId &&
    event.payload.runId === assignment.runId &&
    event.payload.leaseId === assignment.leaseId &&
    event.payload.fencingToken === assignment.fencingToken
  );
}

function artifactScopeMatchesAssignment(
  scope: WorkerArtifactRunScope,
  assignment: WorkerRunAssignmentV1,
): boolean {
  return (
    scope.taskId === assignment.taskId &&
    scope.workOrderId === assignment.workOrder.workOrderId &&
    scope.deviceId === assignment.deviceId &&
    scope.workerId === assignment.workerId &&
    scope.routeId === assignment.routeId &&
    scope.runId === assignment.runId &&
    scope.leaseId === assignment.leaseId &&
    scope.fencingToken === assignment.fencingToken
  );
}

function runStatusFor(type: SequencedWorkerEventV1["type"]): RunStatus {
  switch (type) {
    case "worker.run.claimed":
      return "claimed";
    case "worker.run.cancelled":
      return "cancelled";
    case "worker.run.failed":
      return "failed";
    case "worker.run.rejected":
      return "rejected";
    case "worker.run.succeeded":
      return "succeeded";
  }
}

function isWorkerEventType(value: unknown): value is SequencedWorkerEventV1["type"] {
  return (
    value === "worker.run.claimed" ||
    value === "worker.run.cancelled" ||
    value === "worker.run.failed" ||
    value === "worker.run.rejected" ||
    value === "worker.run.succeeded"
  );
}

function isTerminal(status: RunStatus): boolean {
  return (
    status === "cancelled" ||
    status === "failed" ||
    status === "rejected" ||
    status === "retired" ||
    status === "succeeded"
  );
}

function isRunRetirementReason(value: unknown): value is RunRetirementReason {
  return (
    value === "cancelled" ||
    value === "lease-expired" ||
    value === "paused" ||
    value === "superseded"
  );
}

function isRunLeaseRenewalRejectionCode(
  value: unknown,
): value is WorkerRunLeaseRenewalRejectionCode {
  return (
    value === "RUN_LEASE_CHANGED" ||
    value === "RUN_LEASE_EXPIRED" ||
    value === "RUN_LEASE_NOT_DUE" ||
    value === "RUN_NOT_ACTIVE" ||
    value === "RUN_SCOPE_MISMATCH"
  );
}

function isCancellationReason(
  value: unknown,
): value is "cancelled" | "coordinator-closed" | "paused" | "superseded" {
  return value === "coordinator-closed" || isRunRetirementReason(value);
}

function cancellationReasonFromAbort(
  signal: AbortSignal,
): "cancelled" | "coordinator-closed" | "paused" | "superseded" | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  if (signal.reason === TASK_BUDGET_EXHAUSTED_ABORT_REASON) {
    return "paused";
  }
  return isCancellationReason(signal.reason) ? signal.reason : undefined;
}

function isTimestampMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAXIMUM_DATE_MS;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isJsonCompatible(value: unknown, active: WeakSet<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || active.has(value)) {
    return false;
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((entry) => isJsonCompatible(entry, active));
    }
    return (
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((entry) => isJsonCompatible(entry, active))
    );
  } finally {
    active.delete(value);
  }
}

function dispatchIdempotencyKey(assignment: WorkerRunAssignmentV1): string {
  return `dispatch:${assignment.runId}`;
}

function acceptedWorkerEventId(event: SequencedWorkerEventV1): string {
  return `event_worker_${digest(
    `${event.payload.taskId}\0${event.payload.workOrderId}\0${event.senderDeviceId}\0${event.messageId}`,
  )}`;
}

function rejectedStaleWorkerEventId(event: SequencedWorkerEventV1): string {
  return `event_worker_stale_${digest(
    `${event.payload.taskId}\0${event.payload.workOrderId}\0${event.senderDeviceId}\0${event.messageId}`,
  )}`;
}

function planStreamId(executionKey: string): string {
  return `task-worker-plan:${digest(executionKey)}`;
}

function runStreamId(taskId: string, workOrderId: string): string {
  return `task-worker-run:${digest(`${taskId}\0${workOrderId}`)}`;
}

function runLeaseRenewalEventId(taskId: string, workOrderId: string, renewalId: string): string {
  return `event_run_lease_renewal_${digest(`${taskId}\0${workOrderId}\0${renewalId}`)}`;
}

function fingerprint(value: unknown): string {
  return digest(canonicalJson(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return isRecord(value) && methods.every((method) => typeof value[method] === "function");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
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

function cancelled(): TaskExecutorError {
  return new TaskExecutorError(
    "EXECUTION_CANCELLED",
    "The authoritative Worker execution was cancelled.",
  );
}

function staleCompletion(runId: string): TaskExecutorError {
  return new TaskExecutorError(
    "RUN_COMPLETION_STALE",
    `Worker completion for Run ${runId} is expired, replaced, or incorrectly scoped.`,
  );
}

function invalidWorkerEvent(): TaskExecutorError {
  return new TaskExecutorError(
    "WORKER_EVENT_INVALID",
    "The Worker event is invalid or outside the authenticated Device scope.",
  );
}

function invalidVerifierResult(): TaskExecutorError {
  return new TaskExecutorError(
    "TASK_VERIFICATION_INVALID",
    "The Task evidence verifier returned an invalid result.",
  );
}

function corruptState(): TaskExecutorError {
  return new TaskExecutorError(
    "WORKER_RUN_STATE_CORRUPT",
    "The durable Worker Run journal is corrupt or violates its authority chain.",
  );
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
