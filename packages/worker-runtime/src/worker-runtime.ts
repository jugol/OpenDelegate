import { PROTOCOL_VERSION } from "@opendelegate/protocol";
import {
  TransportRoutesExhaustedError,
  type TransportAttemptTrace,
  type TransportResolver,
} from "@opendelegate/transport";

import {
  assignmentFingerprint,
  configurationFingerprint,
  parseWorkerAssignmentMessage,
  validateWorkerConfiguration,
  WorkerRuntimeError,
  type RunProcess,
  type RunProcessFactory,
  type RunProcessOutcome,
  type SequencedWorkerEventV1,
  type WorkerAssignmentAcceptance,
  type WorkerAssignmentMessageV1,
  type WorkerClock,
  type WorkerConfiguration,
  type WorkerConnectResult,
  type WorkerDelay,
  type WorkerHeartbeatV1,
  type WorkerMainConnection,
  type WorkerOperationalState,
  type WorkerOutboundEventTypeV1,
  type WorkerOutboundEventV1,
  type WorkerRunAssignmentV1,
  type WorkerRuntimeHealthProvider,
  type WorkerRuntimeReadiness,
} from "./contracts.ts";
import { sanitizeWorkerDiagnostic } from "./diagnostics.ts";
import {
  type PersistedWorkerRun,
  type PersistedWorkerState,
  type WorkerStateRepository,
} from "./state-repository.ts";

const ACTIVE_RUN_STATES = new Set(["cancelling", "running", "starting"]);
const DEFAULT_OUTBOX_BATCH_SIZE = 64;
const MAX_STATE_MUTATION_ATTEMPTS = 64;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;

export interface WorkerRuntimeOptions {
  readonly configuration: WorkerConfiguration;
  readonly repository: WorkerStateRepository;
  readonly processFactory: RunProcessFactory;
  readonly clock?: WorkerClock;
  readonly delay?: WorkerDelay;
  readonly healthProvider?: WorkerRuntimeHealthProvider;
  readonly transportResolver?: TransportResolver<WorkerMainConnection>;
}

interface MutationResult<TValue> {
  readonly state: PersistedWorkerState;
  readonly value: TValue;
}

interface MutationPlan<TValue> {
  readonly nextState?: PersistedWorkerState;
  readonly value: TValue;
}

interface PendingProcess {
  readonly process: RunProcess;
}

export class WorkerRuntime {
  private readonly configuration: WorkerConfiguration;
  private readonly repository: WorkerStateRepository;
  private readonly processFactory: RunProcessFactory;
  private readonly clock: WorkerClock;
  private readonly delay: WorkerDelay;
  private readonly healthProvider: WorkerRuntimeHealthProvider;
  private readonly transportResolver: TransportResolver<WorkerMainConnection> | undefined;
  private readonly processes = new Map<string, PendingProcess>();
  private connection: WorkerMainConnection | undefined;
  private connectionState: "offline" | "online" = "offline";
  private routeAttempts: readonly TransportAttemptTrace[] | undefined;
  private clockHighWatermarkMs: number;
  private closed = false;

  private constructor(
    options: WorkerRuntimeOptions,
    configuration: WorkerConfiguration,
    clockHighWatermarkMs: number,
  ) {
    this.configuration = configuration;
    this.repository = options.repository;
    this.processFactory = options.processFactory;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.delay = options.delay ?? {
      wait: (milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }),
    };
    this.healthProvider = options.healthProvider ?? {
      snapshot: () => DEFAULT_READINESS,
    };
    this.transportResolver = options.transportResolver;
    this.clockHighWatermarkMs = clockHighWatermarkMs;
  }

  public static async create(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
    const configuration = validateWorkerConfiguration(options.configuration);
    const now = readClock(options.clock ?? { now: () => Date.now() });
    const initialState: PersistedWorkerState = {
      schemaVersion: 1,
      generation: 0,
      configuration,
      configurationFingerprint: configurationFingerprint(configuration),
      operationalState: "active",
      lastObservedAtMs: now,
      inbox: [],
      runs: [],
      outbox: [],
      nextOutboxSequence: 1,
    };
    const state = await options.repository.initialize(initialState);
    if (state.configurationFingerprint !== initialState.configurationFingerprint) {
      throw new WorkerRuntimeError(
        "CONFIGURATION_MISMATCH",
        "Persisted Worker configuration does not match the requested configuration.",
      );
    }
    const runtime = new WorkerRuntime(options, configuration, state.lastObservedAtMs);
    await runtime.recoverInterruptedRuns();
    return runtime;
  }

  public async acceptAssignment(input: unknown): Promise<WorkerAssignmentAcceptance> {
    this.assertOpen();
    const message = parseWorkerAssignmentMessage(input);
    this.assertAssignmentScope(message);
    const fingerprint = assignmentFingerprint(message);
    const now = this.readNow();
    const result = await this.mutate<WorkerAssignmentAcceptance>((state) => {
      const touched = touchClock(state, now);
      const priorInbox = touched.inbox.find(
        (entry) =>
          entry.messageId === message.messageId || entry.idempotencyKey === message.idempotencyKey,
      );
      if (priorInbox !== undefined) {
        if (priorInbox.fingerprint !== fingerprint) {
          throw new WorkerRuntimeError(
            "INVALID_MESSAGE",
            "A dispatch message or idempotency key was reused with different content.",
          );
        }
        return {
          nextState: touched,
          value: {
            disposition: "duplicate",
            runId: priorInbox.runId,
          } satisfies WorkerAssignmentAcceptance,
        };
      }

      const rejection = assignmentRejection(touched, message.payload, now);
      if (rejection !== undefined) {
        return {
          nextState: recordRejectedAssignment(touched, message, fingerprint, now, rejection),
          value: {
            disposition: "rejected",
            runId: message.payload.runId,
            reason: rejection,
          } satisfies WorkerAssignmentAcceptance,
        };
      }

      const claimedEvent = createRunEvent(
        this.configuration.deviceId,
        message.payload,
        "worker.run.claimed",
        now,
      );
      return {
        nextState: {
          ...appendOutbox(touched, claimedEvent),
          inbox: [
            ...touched.inbox,
            {
              messageId: message.messageId,
              idempotencyKey: message.idempotencyKey,
              fingerprint,
              runId: message.payload.runId,
            },
          ],
          runs: [
            ...touched.runs,
            {
              assignment: structuredClone(message.payload),
              dispatchMessageId: message.messageId,
              assignmentFingerprint: fingerprint,
              state: "starting",
              acceptedAtMs: now,
            },
          ],
        },
        value: {
          disposition: "accepted",
          runId: message.payload.runId,
        } satisfies WorkerAssignmentAcceptance,
      };
    });

    if (result.value.disposition === "accepted") {
      await this.startClaimedRun(message.payload);
    }
    return result.value;
  }

  public async pendingOutbox(
    limit = Number.MAX_SAFE_INTEGER,
  ): Promise<readonly SequencedWorkerEventV1[]> {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new WorkerRuntimeError("INVALID_MESSAGE", "Outbox limit must be positive.");
    }
    const state = await this.repository.read();
    return Object.freeze(
      state.outbox
        .slice(0, limit)
        .map(({ sequence, event }) => Object.freeze({ sequence, ...structuredClone(event) })),
    );
  }

  public async flushOutbox(
    connection = this.connection,
    batchSize = DEFAULT_OUTBOX_BATCH_SIZE,
  ): Promise<number> {
    this.assertOpen();
    if (connection === undefined) {
      return 0;
    }
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 1_000) {
      throw new WorkerRuntimeError("INVALID_MESSAGE", "Outbox batch size is invalid.");
    }
    let acknowledged = 0;
    for (;;) {
      const batch = await this.pendingOutbox(batchSize);
      if (batch.length === 0) {
        return acknowledged;
      }
      const ack = await connection.sendEvents(batch);
      if (ack.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(ack.acknowledgedMessageIds)) {
        throw new WorkerRuntimeError("INVALID_ACK", "Main returned an invalid outbox ack.");
      }
      const acknowledgedIds = validateAckPrefix(batch, ack.acknowledgedMessageIds);
      if (acknowledgedIds.length === 0) {
        return acknowledged;
      }
      await this.acknowledgeOutbox(acknowledgedIds);
      acknowledged += acknowledgedIds.length;
      if (acknowledgedIds.length < batch.length) {
        return acknowledged;
      }
    }
  }

  public async connect(): Promise<WorkerConnectResult> {
    this.assertOpen();
    if (this.transportResolver === undefined) {
      throw new WorkerRuntimeError(
        "INVALID_CONFIGURATION",
        "No outbound Transport Resolver is configured.",
      );
    }
    const currentState = await this.repository.read();
    if (currentState.operationalState === "revoked") {
      throw new WorkerRuntimeError(
        "INVALID_MESSAGE",
        "A revoked Worker cannot establish a new Main connection.",
      );
    }
    try {
      const resolution = await this.transportResolver.connect(this.configuration.transportProfile, {
        acceptedKinds: ["https", "wss"],
      });
      this.connection = resolution.connection;
      this.connectionState = "online";
      this.routeAttempts = resolution.attemptTrace;
      const replayedEvents = await this.flushOutbox(resolution.connection);
      await resolution.connection.sendHeartbeat(await this.heartbeat());
      return {
        connected: true,
        endpointId: resolution.endpointId,
        replayedEvents,
      };
    } catch (error: unknown) {
      const failedConnection = this.connection;
      this.connectionState = "offline";
      this.connection = undefined;
      if (failedConnection?.close !== undefined) {
        await failedConnection.close().catch(() => undefined);
      }
      if (error instanceof TransportRoutesExhaustedError) {
        this.routeAttempts = error.diagnostics.attempts;
        return {
          connected: false,
          diagnostics: error.diagnostics.attempts,
        };
      }
      throw error;
    }
  }

  public async markOffline(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.connectionState = "offline";
    if (connection?.close !== undefined) {
      await connection.close();
    }
  }

  public async heartbeat(): Promise<WorkerHeartbeatV1> {
    this.assertOpen();
    const now = this.readNow();
    const state = await this.repository.read();
    assertClockNotRegressed(state, now);
    const activeRuns = countActiveRuns(state);
    const readiness = readReadiness(this.healthProvider);
    const acceptingWork =
      state.operationalState === "active" &&
      state.outbox.length + activeRuns + 2 <= this.configuration.maxOutboxEntries;
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.configuration.deviceId,
      workerId: this.configuration.workerId,
      observedAtMs: now,
      operationalState: state.operationalState,
      connectionState: this.connectionState,
      readiness,
      capacity: {
        acceptingWork,
        activeRuns,
        maxOutboxEntries: this.configuration.maxOutboxEntries,
        outboxDepth: state.outbox.length,
      },
    } satisfies Omit<WorkerHeartbeatV1, "routeAttempts">;
    return Object.freeze(
      this.routeAttempts === undefined
        ? base
        : {
            ...base,
            routeAttempts: this.routeAttempts,
          },
    );
  }

  public async setOperationalState(
    operationalState: WorkerOperationalState,
    reason: string,
  ): Promise<void> {
    this.assertOpen();
    if (!isOperationalState(operationalState) || reason.trim() === "") {
      throw new WorkerRuntimeError("INVALID_MESSAGE", "Worker lifecycle change is invalid.");
    }
    const now = this.readNow();
    const result = await this.mutate((state) => {
      const touched = touchClock(state, now);
      if (touched.operationalState === "revoked" && operationalState !== "revoked") {
        throw new WorkerRuntimeError(
          "INVALID_MESSAGE",
          "A revoked Device cannot return to service without re-enrollment.",
        );
      }
      return {
        nextState:
          touched.operationalState === operationalState
            ? touched
            : { ...touched, operationalState },
        value: touched.runs.filter((run) => isActiveRun(run)).map((run) => run.assignment.runId),
      };
    });
    if (operationalState === "disabled" || operationalState === "revoked") {
      await Promise.all(
        result.value.map((runId) => this.cancelRun(runId, reason, "worker.run.cancelled")),
      );
    }
    if (operationalState === "revoked") {
      await this.markOffline().catch(() => undefined);
    }
  }

  public async cancelRun(
    runId: string,
    _reason: string,
    terminalType: Extract<
      WorkerOutboundEventTypeV1,
      "worker.run.cancelled" | "worker.run.failed"
    > = "worker.run.cancelled",
  ): Promise<void> {
    this.assertOpen();
    const now = this.readNow();
    const result = await this.mutate((state) => {
      const touched = touchClock(state, now);
      const run = touched.runs.find((candidate) => candidate.assignment.runId === runId);
      if (run === undefined || !isActiveRun(run)) {
        return { nextState: touched, value: false };
      }
      return {
        nextState: replaceRun(touched, runId, { ...run, state: "cancelling" }),
        value: true,
      };
    });
    if (!result.value) {
      return;
    }

    const pending = this.processes.get(runId);
    if (pending !== undefined) {
      await pending.process.requestCancel();
      const completedCooperatively = await Promise.race([
        pending.process.completion.then(() => true),
        this.delay.wait(this.configuration.cancelGraceMs).then(() => false),
      ]);
      if (!completedCooperatively) {
        await pending.process.forceTerminate();
      }
    }
    await this.finalizeCancelledRun(runId, terminalType);
  }

  public async sweepExpiredRuns(): Promise<readonly string[]> {
    this.assertOpen();
    const now = this.readNow();
    const state = await this.repository.read();
    assertClockNotRegressed(state, now);
    const expired = state.runs
      .filter((run) => isActiveRun(run) && run.assignment.leaseExpiresAtMs <= now)
      .map((run) => run.assignment.runId);
    await Promise.all(
      expired.map((runId) => this.cancelRun(runId, "Run lease expired.", "worker.run.failed")),
    );
    return Object.freeze(expired);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const connection = this.connection;
    this.connection = undefined;
    this.connectionState = "offline";
    try {
      if (connection?.close !== undefined) {
        await connection.close();
      }
    } finally {
      this.repository.close();
    }
  }

  private async startClaimedRun(assignment: WorkerRunAssignmentV1): Promise<void> {
    let process: RunProcess;
    try {
      process = await this.processFactory.start({
        assignment: structuredClone(assignment),
        isLeaseCurrent: () => this.isLeaseCurrent(assignment),
      });
    } catch (error: unknown) {
      await this.finalizeRun(assignment.runId, {
        type: "worker.run.failed",
        report: "The Worker could not start the Run.",
        diagnostic: sanitizeWorkerDiagnostic({
          code: "PROCESS_START_FAILED",
          stage: "startup",
          retryable: true,
          cause: error,
        }),
      });
      return;
    }
    this.processes.set(assignment.runId, { process });
    const transition = await this.mutate<boolean>((state) => {
      const run = state.runs.find((candidate) => candidate.assignment.runId === assignment.runId);
      if (run === undefined || run.state !== "starting") {
        return { value: false };
      }
      return {
        nextState: replaceRun(state, assignment.runId, { ...run, state: "running" }),
        value: true,
      };
    });
    if (!transition.value) {
      await process.requestCancel().catch(() => undefined);
      const completedCooperatively = await Promise.race([
        process.completion.then(
          () => true,
          () => true,
        ),
        this.delay.wait(this.configuration.cancelGraceMs).then(() => false),
      ]);
      if (!completedCooperatively) {
        await process.forceTerminate().catch(() => undefined);
      }
      this.processes.delete(assignment.runId);
      return;
    }
    void process.completion
      .then(async (rawOutcome) => {
        const outcome = normalizeRunProcessOutcome(rawOutcome);
        if (outcome === undefined) {
          await this.finalizeRun(assignment.runId, {
            type: "worker.run.failed",
            report: "The supervised Run returned an invalid terminal result.",
            diagnostic: sanitizeWorkerDiagnostic({
              code: "PROCESS_FAILED",
              stage: "execution",
              retryable: true,
            }),
          });
          return;
        }
        if (outcome.status === "succeeded") {
          if (await this.isLeaseCurrent(assignment)) {
            await this.finalizeRun(assignment.runId, {
              type: "worker.run.succeeded",
              report: outcome.report,
              artifactIds: outcome.artifactIds,
            });
          } else {
            await this.finalizeRun(assignment.runId, {
              type: "worker.run.failed",
              report: "The Run finished after its execution authority was lost.",
              diagnostic: sanitizeWorkerDiagnostic({
                code: "RUN_AUTHORITY_LOST",
                stage: "lease",
                retryable: true,
              }),
            });
          }
        } else {
          await this.finalizeRun(assignment.runId, {
            type: "worker.run.failed",
            report: outcome.report,
            diagnostic: sanitizeWorkerDiagnostic(outcome.diagnostic),
          });
        }
      })
      .catch(async (error: unknown) => {
        await this.finalizeRun(assignment.runId, {
          type: "worker.run.failed",
          report: "The supervised Run process failed.",
          diagnostic: sanitizeWorkerDiagnostic({
            code: "PROCESS_FAILED",
            stage: "execution",
            retryable: true,
            cause: error,
          }),
        });
      })
      .catch(() => undefined);
  }

  private async finalizeCancelledRun(
    runId: string,
    terminalType: Extract<WorkerOutboundEventTypeV1, "worker.run.cancelled" | "worker.run.failed">,
  ): Promise<void> {
    await this.finalizeRun(runId, {
      type: terminalType,
      report:
        terminalType === "worker.run.failed" ? "The Run lease expired." : "The Run was cancelled.",
      diagnostic: sanitizeWorkerDiagnostic({
        code: terminalType === "worker.run.failed" ? "LEASE_EXPIRED" : "PROCESS_CANCELLED",
        stage: terminalType === "worker.run.failed" ? "lease" : "cancellation",
        retryable: terminalType === "worker.run.failed",
      }),
    });
  }

  private async finalizeRun(
    runId: string,
    result: {
      readonly type: Extract<
        WorkerOutboundEventTypeV1,
        "worker.run.cancelled" | "worker.run.failed" | "worker.run.succeeded"
      >;
      readonly report: string;
      readonly artifactIds?: readonly string[];
      readonly diagnostic?: WorkerOutboundEventV1["payload"]["diagnostic"];
    },
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    const now = this.readNow();
    await this.mutate((state) => {
      const touched = touchClock(state, now);
      const run = touched.runs.find((candidate) => candidate.assignment.runId === runId);
      if (run === undefined || !isActiveRun(run)) {
        return { nextState: touched, value: undefined };
      }
      const event = createRunEvent(
        this.configuration.deviceId,
        run.assignment,
        result.type,
        now,
        result,
      );
      const terminalState =
        result.type === "worker.run.succeeded"
          ? "succeeded"
          : result.type === "worker.run.cancelled"
            ? "cancelled"
            : "failed";
      return {
        nextState: replaceRun(appendOutbox(touched, event), runId, {
          ...run,
          state: terminalState,
          finishedAtMs: now,
        }),
        value: undefined,
      };
    });
    this.processes.delete(runId);
  }

  private async acknowledgeOutbox(messageIds: readonly string[]): Promise<void> {
    const idSet = new Set(messageIds);
    await this.mutate((state) => ({
      nextState: {
        ...state,
        outbox: state.outbox.filter((entry) => !idSet.has(entry.event.messageId)),
      },
      value: undefined,
    }));
  }

  private async isLeaseCurrent(assignment: WorkerRunAssignmentV1): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    const now = this.readNow();
    const state = await this.repository.read();
    if (now < state.lastObservedAtMs) {
      return false;
    }
    const run = state.runs.find((candidate) => candidate.assignment.runId === assignment.runId);
    return (
      run !== undefined &&
      isActiveRun(run) &&
      run.assignment.leaseId === assignment.leaseId &&
      run.assignment.fencingToken === assignment.fencingToken &&
      now < assignment.leaseExpiresAtMs &&
      state.operationalState !== "disabled" &&
      state.operationalState !== "revoked"
    );
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const now = this.readNow();
    await this.mutate((state) => {
      let next = touchClock(state, now);
      for (const run of state.runs.filter((candidate) => isActiveRun(candidate))) {
        const event = createRunEvent(
          this.configuration.deviceId,
          run.assignment,
          "worker.run.failed",
          now,
          {
            report: "The Worker restarted before the supervised Run completed.",
            diagnostic: sanitizeWorkerDiagnostic({
              code: "WORKER_RESTARTED",
              stage: "execution",
              retryable: true,
            }),
          },
        );
        next = replaceRun(appendOutbox(next, event), run.assignment.runId, {
          ...run,
          state: "failed",
          finishedAtMs: now,
        });
      }
      return { nextState: next, value: undefined };
    });
  }

  private assertAssignmentScope(message: WorkerAssignmentMessageV1): void {
    if (
      message.senderDeviceId !== this.configuration.mainDeviceId ||
      message.payload.deviceId !== this.configuration.deviceId ||
      message.payload.workerId !== this.configuration.workerId ||
      message.correlationId !== message.payload.taskId ||
      message.payload.workOrder.workOrderId.length === 0
    ) {
      throw new WorkerRuntimeError(
        "INVALID_MESSAGE",
        "Run assignment does not match this Worker and Main relationship.",
      );
    }
  }

  private readNow(): number {
    const now = readClock(this.clock);
    if (now < this.clockHighWatermarkMs) {
      throw new WorkerRuntimeError(
        "CLOCK_REGRESSION",
        "Worker clock moved behind its in-process high-watermark.",
      );
    }
    this.clockHighWatermarkMs = now;
    return now;
  }

  private async mutate<TValue>(
    mutation: (state: PersistedWorkerState) => MutationPlan<TValue>,
  ): Promise<MutationResult<TValue>> {
    for (let attempt = 0; attempt < MAX_STATE_MUTATION_ATTEMPTS; attempt += 1) {
      const state = await this.repository.read();
      const plan = mutation(state);
      if (plan.nextState === undefined || sameState(plan.nextState, state)) {
        return { state, value: plan.value };
      }
      const nextState: PersistedWorkerState = {
        ...plan.nextState,
        generation: state.generation + 1,
      };
      if (await this.repository.compareAndSwap(state.generation, nextState)) {
        return { state: nextState, value: plan.value };
      }
    }
    throw new WorkerRuntimeError(
      "CONCURRENT_STATE_UPDATE",
      "Worker state remained busy after bounded compare-and-swap retries.",
    );
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WorkerRuntimeError("REPOSITORY_CLOSED", "Worker runtime is closed.");
    }
  }
}

const DEFAULT_READINESS: WorkerRuntimeReadiness = Object.freeze({
  daemon: "healthy",
  session: "unavailable",
  desktop: "unavailable",
  permissions: Object.freeze({
    accessibility: "not-applicable",
    input: "not-applicable",
    screenCapture: "not-applicable",
  }),
});
const DEGRADED_READINESS: WorkerRuntimeReadiness = Object.freeze({
  daemon: "degraded",
  session: "unavailable",
  desktop: "unavailable",
  permissions: Object.freeze({
    accessibility: "unknown",
    input: "unknown",
    screenCapture: "unknown",
  }),
});

function assignmentRejection(
  state: PersistedWorkerState,
  assignment: WorkerRunAssignmentV1,
  now: number,
): WorkerAssignmentAcceptance["reason"] | undefined {
  if (state.operationalState !== "active") {
    return "device-not-active";
  }
  if (assignment.leaseExpiresAtMs <= now) {
    return "lease-expired";
  }
  const workOrderRuns = state.runs.filter(
    (run) => run.assignment.workOrder.workOrderId === assignment.workOrder.workOrderId,
  );
  if (
    workOrderRuns.some(
      (run) =>
        run.assignment.fencingToken >= assignment.fencingToken ||
        run.assignment.leaseId === assignment.leaseId ||
        run.assignment.runId === assignment.runId,
    )
  ) {
    return "stale-fence";
  }
  if (workOrderRuns.some((run) => isActiveRun(run))) {
    return "work-order-busy";
  }
  if (state.outbox.length + countActiveRuns(state) + 2 > state.configuration.maxOutboxEntries) {
    return "backpressure";
  }
  return undefined;
}

function recordRejectedAssignment(
  state: PersistedWorkerState,
  message: WorkerAssignmentMessageV1,
  fingerprint: string,
  now: number,
  reason: NonNullable<WorkerAssignmentAcceptance["reason"]>,
): PersistedWorkerState {
  const event = createRunEvent(
    state.configuration.deviceId,
    message.payload,
    "worker.run.rejected",
    now,
    {
      report: `The Worker rejected the assignment: ${reason}.`,
      diagnostic: Object.freeze({
        code: rejectionDiagnosticCode(reason),
        retryable: reason === "backpressure" || reason === "work-order-busy",
      }),
    },
  );
  const stateWithOptionalEvent =
    state.outbox.length + countActiveRuns(state) < state.configuration.maxOutboxEntries
      ? appendOutbox(state, event)
      : state;
  if (stateWithOptionalEvent === state) {
    return state;
  }
  return {
    ...stateWithOptionalEvent,
    inbox: [
      ...stateWithOptionalEvent.inbox,
      {
        messageId: message.messageId,
        idempotencyKey: message.idempotencyKey,
        fingerprint,
        runId: message.payload.runId,
      },
    ],
  };
}

function rejectionDiagnosticCode(
  reason: NonNullable<WorkerAssignmentAcceptance["reason"]>,
): string {
  switch (reason) {
    case "backpressure":
      return "WORKER_BACKPRESSURE";
    case "device-not-active":
      return "DEVICE_NOT_ACTIVE";
    case "lease-expired":
      return "LEASE_EXPIRED";
    case "stale-fence":
      return "STALE_FENCE";
    case "work-order-busy":
      return "WORK_ORDER_BUSY";
  }
}

function createRunEvent(
  senderDeviceId: string,
  assignment: WorkerRunAssignmentV1,
  type: WorkerOutboundEventTypeV1,
  now: number,
  result: {
    readonly report?: string;
    readonly artifactIds?: readonly string[];
    readonly diagnostic?: WorkerOutboundEventV1["payload"]["diagnostic"];
  } = {},
): WorkerOutboundEventV1 {
  const suffix = type.slice("worker.run.".length);
  const payload: WorkerOutboundEventV1["payload"] = {
    taskId: assignment.taskId,
    workOrderId: assignment.workOrder.workOrderId,
    deviceId: assignment.deviceId,
    workerId: assignment.workerId,
    routeId: assignment.routeId,
    runId: assignment.runId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
    ...(result.report === undefined ? {} : { report: result.report }),
    ...(result.artifactIds === undefined ? {} : { artifactIds: result.artifactIds }),
    ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
  };
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    messageId: `${assignment.runId}:${suffix}`,
    senderDeviceId,
    correlationId: assignment.taskId,
    createdAt: new Date(now).toISOString(),
    idempotencyKey: `${assignment.runId}:${assignment.leaseId}:${assignment.fencingToken}:${suffix}`,
    type,
    payload: Object.freeze(payload),
  });
}

function appendOutbox(
  state: PersistedWorkerState,
  event: WorkerOutboundEventV1,
  requireCapacity = true,
): PersistedWorkerState {
  if (state.outbox.some((entry) => entry.event.messageId === event.messageId)) {
    return state;
  }
  if (state.outbox.length >= state.configuration.maxOutboxEntries) {
    if (!requireCapacity) {
      return state;
    }
    throw new WorkerRuntimeError("STATE_CORRUPT", "Reserved terminal outbox capacity was lost.");
  }
  return {
    ...state,
    outbox: [...state.outbox, { sequence: state.nextOutboxSequence, event }],
    nextOutboxSequence: state.nextOutboxSequence + 1,
  };
}

function replaceRun(
  state: PersistedWorkerState,
  runId: string,
  replacement: PersistedWorkerRun,
): PersistedWorkerState {
  return {
    ...state,
    runs: state.runs.map((run) =>
      run.assignment.runId === runId ? structuredClone(replacement) : run,
    ),
  };
}

function touchClock(state: PersistedWorkerState, now: number): PersistedWorkerState {
  assertClockNotRegressed(state, now);
  return now === state.lastObservedAtMs ? state : { ...state, lastObservedAtMs: now };
}

function assertClockNotRegressed(state: PersistedWorkerState, now: number): void {
  if (now < state.lastObservedAtMs) {
    throw new WorkerRuntimeError(
      "CLOCK_REGRESSION",
      "Worker clock moved behind its durable high-watermark.",
    );
  }
}

function readClock(clock: WorkerClock): number {
  let now: number;
  try {
    now = clock.now();
  } catch {
    throw new WorkerRuntimeError("CLOCK_REGRESSION", "Worker clock could not be read.");
  }
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_JAVASCRIPT_DATE_MS) {
    throw new WorkerRuntimeError(
      "CLOCK_REGRESSION",
      "Worker clock must return a non-negative safe integer.",
    );
  }
  return now;
}

function isActiveRun(run: PersistedWorkerRun): boolean {
  return ACTIVE_RUN_STATES.has(run.state);
}

function countActiveRuns(state: PersistedWorkerState): number {
  return state.runs.filter((run) => isActiveRun(run)).length;
}

function validateAckPrefix(
  batch: readonly SequencedWorkerEventV1[],
  acknowledgedMessageIds: readonly string[],
): readonly string[] {
  if (
    acknowledgedMessageIds.some(
      (messageId, index) =>
        typeof messageId !== "string" ||
        messageId !== batch[index]?.messageId ||
        acknowledgedMessageIds.indexOf(messageId) !== index,
    )
  ) {
    throw new WorkerRuntimeError(
      "INVALID_ACK",
      "Main may acknowledge only a unique ordered prefix of the delivered outbox batch.",
    );
  }
  return acknowledgedMessageIds;
}

function isOperationalState(value: string): value is WorkerOperationalState {
  return value === "active" || value === "disabled" || value === "draining" || value === "revoked";
}

function sameState(left: PersistedWorkerState, right: PersistedWorkerState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readReadiness(provider: WorkerRuntimeHealthProvider): WorkerRuntimeReadiness {
  try {
    const readiness = provider.snapshot();
    if (
      !isDaemonState(readiness.daemon) ||
      !isSessionState(readiness.session) ||
      !isDesktopState(readiness.desktop) ||
      !isPermissionState(readiness.permissions.accessibility) ||
      !isPermissionState(readiness.permissions.input) ||
      !isPermissionState(readiness.permissions.screenCapture)
    ) {
      return DEGRADED_READINESS;
    }
    return Object.freeze({
      daemon: readiness.daemon,
      session: readiness.session,
      desktop: readiness.desktop,
      permissions: Object.freeze({
        accessibility: readiness.permissions.accessibility,
        input: readiness.permissions.input,
        screenCapture: readiness.permissions.screenCapture,
      }),
    });
  } catch {
    return DEGRADED_READINESS;
  }
}

function isDaemonState(value: string): boolean {
  return (
    value === "starting" || value === "healthy" || value === "degraded" || value === "stopping"
  );
}

function isSessionState(value: string): boolean {
  return (
    value === "unavailable" || value === "logged-out" || value === "locked" || value === "ready"
  );
}

function isDesktopState(value: string): boolean {
  return value === "unavailable" || value === "locked" || value === "available" || value === "busy";
}

function isPermissionState(value: string): boolean {
  return (
    value === "unknown" || value === "granted" || value === "denied" || value === "not-applicable"
  );
}

function normalizeRunProcessOutcome(value: unknown): RunProcessOutcome | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const outcome = value as Record<string, unknown>;
  const report = outcome["report"];
  if (
    typeof report !== "string" ||
    report.length === 0 ||
    Buffer.byteLength(report, "utf8") > 262_144
  ) {
    return undefined;
  }
  if (outcome["status"] === "failed") {
    return {
      status: "failed",
      report,
      diagnostic: outcome["diagnostic"],
    };
  }
  if (outcome["status"] !== "succeeded") {
    return undefined;
  }
  const artifactIds = outcome["artifactIds"];
  if (
    !Array.isArray(artifactIds) ||
    artifactIds.length > 256 ||
    artifactIds.some(
      (artifactId, index) =>
        typeof artifactId !== "string" ||
        artifactId.length === 0 ||
        artifactId.length > 256 ||
        artifactId !== artifactId.trim() ||
        artifactIds.indexOf(artifactId) !== index,
    )
  ) {
    return undefined;
  }
  return {
    status: "succeeded",
    report,
    artifactIds: Object.freeze([...artifactIds]) as readonly string[],
  };
}
