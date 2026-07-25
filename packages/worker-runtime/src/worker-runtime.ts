import { PROTOCOL_VERSION, parseWorkerAgentSessionObservation } from "@opendelegate/protocol";
import {
  TransportRoutesExhaustedError,
  transportProfileRevision,
  type TransportResolver,
} from "@opendelegate/transport";

import {
  assignmentFingerprint,
  configurationFingerprint,
  createWorkerRouteIncident,
  parseWorkerAssignmentMessage,
  validateWorkerRunSteeringCommand,
  validateWorkerConfiguration,
  workerRunSteeringCommandFingerprint,
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
  type WorkerRunLeaseAuthority,
  type WorkerRunSteeringCommandV1,
  type WorkerRunSteeringReceiptReasonV1,
  type WorkerRunSteeringReceiptV1,
  type WorkerRouteIncidentV1,
  type WorkerRuntimeHealthProvider,
  type WorkerRuntimeReadiness,
  type WorkerSchedulingInventoryProvider,
  type WorkerSchedulingInventoryV1,
} from "./contracts.ts";
import { sanitizeWorkerDiagnostic } from "./diagnostics.ts";
import { AgentRunBridgeError } from "./agent-run-bridge-error.ts";
import {
  type PersistedRunSteeringAttempt,
  type PersistedWorkerRun,
  type PersistedWorkerState,
  type WorkerStateRepository,
} from "./state-repository.ts";

const ACTIVE_RUN_STATES = new Set(["cancelling", "running", "starting"]);
const DEFAULT_OUTBOX_BATCH_SIZE = 64;
export const DEFAULT_MAXIMUM_CONCURRENT_RUNS = 4;
const MAX_STATE_MUTATION_ATTEMPTS = 64;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;
const MAX_PERSISTED_STEERING_ATTEMPTS = 4_096;

export interface WorkerRuntimeOptions {
  readonly configuration: WorkerConfiguration;
  readonly repository: WorkerStateRepository;
  readonly processFactory: RunProcessFactory;
  readonly clock?: WorkerClock;
  readonly delay?: WorkerDelay;
  readonly healthProvider?: WorkerRuntimeHealthProvider;
  readonly inventoryProvider?: WorkerSchedulingInventoryProvider;
  readonly maximumConcurrentRuns?: number;
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
  readonly leaseAuthority: WorkerRunLeaseAuthority;
}

export class WorkerRuntime {
  private readonly configuration: WorkerConfiguration;
  private readonly repository: WorkerStateRepository;
  private readonly processFactory: RunProcessFactory;
  private readonly clock: WorkerClock;
  private readonly delay: WorkerDelay;
  private readonly healthProvider: WorkerRuntimeHealthProvider;
  private readonly inventoryProvider: WorkerSchedulingInventoryProvider | undefined;
  private readonly maximumConcurrentRuns: number;
  private readonly transportResolver: TransportResolver<WorkerMainConnection> | undefined;
  private readonly processes = new Map<string, PendingProcess>();
  private readonly leaseAuthorities = new Map<string, WorkerRunLeaseAuthority>();
  private connection: WorkerMainConnection | undefined;
  private connectionState: "offline" | "online" = "offline";
  private connectedEndpointId: string | undefined;
  private clockHighWatermarkMs: number;
  private steeringTail: Promise<void> = Promise.resolve();
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
    this.inventoryProvider = options.inventoryProvider;
    this.maximumConcurrentRuns = options.maximumConcurrentRuns ?? DEFAULT_MAXIMUM_CONCURRENT_RUNS;
    this.transportResolver = options.transportResolver;
    this.clockHighWatermarkMs = clockHighWatermarkMs;
  }

  public static async create(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
    if (
      !Number.isSafeInteger(options.maximumConcurrentRuns ?? DEFAULT_MAXIMUM_CONCURRENT_RUNS) ||
      Number(options.maximumConcurrentRuns ?? DEFAULT_MAXIMUM_CONCURRENT_RUNS) < 1 ||
      Number(options.maximumConcurrentRuns ?? DEFAULT_MAXIMUM_CONCURRENT_RUNS) > 1_024
    ) {
      throw new WorkerRuntimeError(
        "INVALID_CONFIGURATION",
        "Maximum concurrent Runs must be a safe integer between 1 and 1024.",
      );
    }
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
      routeIncidents: [],
      steeringAttempts: [],
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

  public async acceptAssignment(
    input: unknown,
    suppliedLeaseAuthority?: WorkerRunLeaseAuthority,
  ): Promise<WorkerAssignmentAcceptance> {
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

      const rejection = assignmentRejection(
        touched,
        message.payload,
        now,
        this.maximumConcurrentRuns,
      );
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
      const leaseAuthority =
        suppliedLeaseAuthority ??
        new WallClockRunLeaseAuthority(message.payload.leaseExpiresAtMs, this.clock);
      this.leaseAuthorities.set(message.payload.runId, leaseAuthority);
      await this.startClaimedRun(message.payload, leaseAuthority);
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

  /**
   * Delivers one authenticated, exact-scope steering command. Durable
   * `delivering` intent is written before provider interaction. If the Worker
   * restarts in that interval, replay returns `outcome-unknown` and never sends a
   * second instruction into an unknowable provider turn.
   */
  public steerRun(input: WorkerRunSteeringCommandV1): Promise<WorkerRunSteeringReceiptV1> {
    this.assertOpen();
    const command = validateWorkerRunSteeringCommand(input);
    const operation = this.steeringTail.then(() => this.steerRunSerialized(command));
    this.steeringTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
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
      this.connectedEndpointId = resolution.endpointId;
      await this.flushRouteIncidents(resolution.connection);
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
      this.connectedEndpointId = undefined;
      this.connection = undefined;
      if (failedConnection?.close !== undefined) {
        await failedConnection.close().catch(() => undefined);
      }
      if (error instanceof TransportRoutesExhaustedError) {
        await this.recordRouteIncident(error.diagnostics.attempts);
        return {
          connected: false,
          diagnostics: error.diagnostics.attempts,
        };
      }
      throw error;
    }
  }

  private async recordRouteIncident(
    attempts: ConstructorParameters<typeof TransportRoutesExhaustedError>[1],
  ): Promise<void> {
    const now = this.readNow();
    await this.mutate((state) => {
      const touched = touchClock(state, now);
      const candidate = createWorkerRouteIncident({
        profile: this.configuration.transportProfile,
        attempts,
        occurrenceSeed: [
          this.configuration.deviceId,
          String(touched.generation + 1),
          String(now),
        ].join(":"),
      });
      const current = touched.routeIncidents ?? [];
      if (current.some((incident) => incident.fingerprint === candidate.fingerprint)) {
        return { nextState: touched, value: undefined };
      }
      if (current.length >= 64) {
        throw new WorkerRuntimeError(
          "STATE_CORRUPT",
          "The durable route incident queue reached its safe capacity.",
        );
      }
      return {
        nextState: {
          ...touched,
          routeIncidents: [...current, candidate],
        },
        value: undefined,
      };
    });
  }

  private async flushRouteIncidents(connection: WorkerMainConnection): Promise<void> {
    if (connection.sendRouteIncident === undefined) {
      return;
    }
    for (;;) {
      const state = await this.repository.read();
      const incident = state.routeIncidents?.[0];
      if (incident === undefined) {
        return;
      }
      await connection.sendRouteIncident(incident);
      await this.removeRouteIncident(incident);
    }
  }

  private async removeRouteIncident(incident: WorkerRouteIncidentV1): Promise<void> {
    await this.mutate((state) => {
      const current = state.routeIncidents ?? [];
      const stored = current.find((entry) => entry.incidentId === incident.incidentId);
      if (stored === undefined) {
        return { value: undefined };
      }
      if (
        stored.fingerprint !== incident.fingerprint ||
        stored.profileRevision !== incident.profileRevision
      ) {
        throw new WorkerRuntimeError(
          "STATE_CORRUPT",
          "The durable route incident identity changed before delivery.",
        );
      }
      return {
        nextState: {
          ...state,
          routeIncidents: current.filter((entry) => entry.incidentId !== incident.incidentId),
        },
        value: undefined,
      };
    });
  }

  public async markOffline(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.connectionState = "offline";
    this.connectedEndpointId = undefined;
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
      activeRuns < this.maximumConcurrentRuns &&
      state.outbox.length + activeRuns + 2 <= this.configuration.maxOutboxEntries;
    const inventory =
      this.inventoryProvider === undefined
        ? undefined
        : validateSchedulingInventory(await this.inventoryProvider.snapshot());
    if (
      inventory?.hardware !== undefined &&
      [
        inventory.hardware.cpu.observedAtMs,
        inventory.hardware.memory.observedAtMs,
        inventory.hardware.gpu.observedAtMs,
      ].some((observedAtMs) => observedAtMs > now)
    ) {
      throw new WorkerRuntimeError(
        "INVALID_CONFIGURATION",
        "Worker hardware evidence cannot be newer than its enclosing heartbeat.",
      );
    }
    const profileRevision = transportProfileRevision(this.configuration.transportProfile);
    const routes = this.configuration.transportProfile.endpoints.map((endpoint, priority) => {
      const connected =
        this.connectionState === "online" && endpoint.endpointId === this.connectedEndpointId;
      return Object.freeze({
        routeId: `route:${profileRevision.slice("sha256:".length)}:${priority}`,
        label: `Route ${priority + 1}`,
        priority,
        kind: endpoint.kind,
        profileRevision,
        health: connected ? ("healthy" as const) : ("unknown" as const),
        ...(connected
          ? {
              lastAttempt: Object.freeze({
                probeSource: "live" as const,
                outcome: "connected" as const,
                observedAtMs: now,
              }),
            }
          : {}),
      });
    });
    const currentRuns = state.runs
      .filter(isActiveRun)
      .sort(
        (left, right) =>
          left.acceptedAtMs - right.acceptedAtMs ||
          left.assignment.runId.localeCompare(right.assignment.runId, "en"),
      )
      .map((run) => {
        const agentSession = this.processes
          .get(run.assignment.runId)
          ?.process.currentAgentSession?.();
        return Object.freeze({
          taskId: run.assignment.taskId,
          workOrderId: run.assignment.workOrder.workOrderId,
          runId: run.assignment.runId,
          state: run.state as "starting" | "running" | "cancelling",
          acceptedAtMs: run.acceptedAtMs,
          leaseExpiresAtMs: run.assignment.leaseExpiresAtMs,
          ...(agentSession === undefined ? {} : { agentSession }),
        });
      });
    return Object.freeze({
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
      ...(inventory === undefined ? {} : { inventory }),
      routes: Object.freeze(routes),
      currentRuns: Object.freeze(currentRuns),
    } satisfies WorkerHeartbeatV1);
  }

  /**
   * Performs one bounded daemon maintenance cycle. A failed channel write marks
   * the Worker offline so the service host can apply its deterministic reconnect
   * policy without owning or inspecting the connection.
   */
  public async pulse(): Promise<boolean> {
    this.assertOpen();
    await this.sweepExpiredRuns();
    const connection = this.connection;
    if (connection === undefined) {
      return false;
    }
    try {
      await Promise.all(
        [...this.leaseAuthorities.values()].map((authority) => authority.renewIfDue()),
      );
      await this.sweepExpiredRuns();
      await this.flushOutbox(connection);
      await connection.sendHeartbeat(await this.heartbeat());
      return true;
    } catch {
      await this.markOffline().catch(() => undefined);
      await this.sweepExpiredRuns().catch(() => undefined);
      return false;
    }
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
    const expired: string[] = [];
    for (const run of state.runs.filter((candidate) => isActiveRun(candidate))) {
      const authority = this.leaseAuthorities.get(run.assignment.runId);
      if (
        authority === undefined
          ? run.assignment.leaseExpiresAtMs <= now
          : !(await authority.isCurrent())
      ) {
        expired.push(run.assignment.runId);
      }
    }
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

  private async startClaimedRun(
    assignment: WorkerRunAssignmentV1,
    leaseAuthority: WorkerRunLeaseAuthority,
  ): Promise<void> {
    let process: RunProcess;
    try {
      process = await this.processFactory.start({
        assignment: structuredClone(assignment),
        leaseAuthority,
        isLeaseCurrent: () => this.isLeaseCurrent(assignment, leaseAuthority),
      });
    } catch (error: unknown) {
      const requirementUnavailable =
        error instanceof AgentRunBridgeError && error.code === "AGENT_REQUIREMENT_UNAVAILABLE";
      await this.finalizeRun(assignment.runId, {
        type: "worker.run.failed",
        report: requirementUnavailable
          ? "The Worker could not satisfy the immutable Agent requirement for this Run."
          : "The Worker could not start the Run.",
        diagnostic: sanitizeWorkerDiagnostic({
          code: requirementUnavailable ? "AGENT_REQUIREMENT_UNAVAILABLE" : "PROCESS_START_FAILED",
          stage: "startup",
          retryable: error instanceof AgentRunBridgeError ? error.retryable : true,
          cause: error,
        }),
      });
      this.leaseAuthorities.delete(assignment.runId);
      return;
    }
    this.processes.set(assignment.runId, { process, leaseAuthority });
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
      this.leaseAuthorities.delete(assignment.runId);
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
          if (await this.isLeaseCurrent(assignment, leaseAuthority)) {
            await this.finalizeRun(assignment.runId, {
              type: "worker.run.succeeded",
              report: outcome.report,
              artifactIds: outcome.artifactIds,
              ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
              ...(outcome.agentSession === undefined ? {} : { agentSession: outcome.agentSession }),
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
              ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
              ...(outcome.agentSession === undefined ? {} : { agentSession: outcome.agentSession }),
            });
          }
        } else {
          await this.finalizeRun(assignment.runId, {
            type: "worker.run.failed",
            report: outcome.report,
            diagnostic: sanitizeWorkerDiagnostic(outcome.diagnostic),
            ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
            ...(outcome.agentSession === undefined ? {} : { agentSession: outcome.agentSession }),
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

  private async steerRunSerialized(
    command: WorkerRunSteeringCommandV1,
  ): Promise<WorkerRunSteeringReceiptV1> {
    const fingerprint = workerRunSteeringCommandFingerprint(command);
    const now = this.readNow();
    const decision = await this.mutate<{
      readonly deliver: boolean;
      readonly receipt?: WorkerRunSteeringReceiptV1;
    }>((state) => {
      const touched = touchClock(state, now);
      const attempts = touched.steeringAttempts ?? [];
      const prior = attempts.find((attempt) => attempt.requestId === command.requestId);
      if (prior !== undefined) {
        if (prior.commandFingerprint !== fingerprint) {
          throw new WorkerRuntimeError(
            "INVALID_MESSAGE",
            "A steering request ID was reused with different content or scope.",
          );
        }
        if (prior.state === "completed" && prior.receipt !== undefined) {
          return { nextState: touched, value: { deliver: false, receipt: prior.receipt } };
        }
        const receipt = steeringReceipt(
          command,
          now,
          "none",
          "outcome-unknown",
          "STEERING_OUTCOME_UNKNOWN",
        );
        return {
          nextState: replaceSteeringAttempt(touched, command.requestId, {
            ...prior,
            state: "completed",
            receipt,
          }),
          value: { deliver: false, receipt },
        };
      }
      if (attempts.length >= MAX_PERSISTED_STEERING_ATTEMPTS) {
        throw new WorkerRuntimeError(
          "STATE_CORRUPT",
          "The bounded durable steering audit reached its safe capacity.",
        );
      }
      const run = touched.runs.find((candidate) => candidate.assignment.runId === command.runId);
      const scopeReason = steeringRunScopeReason(this.configuration, run, command);
      if (scopeReason !== undefined) {
        const receipt = steeringReceipt(command, now, "none", "rejected", scopeReason);
        return {
          nextState: {
            ...touched,
            steeringAttempts: [
              ...attempts,
              {
                requestId: command.requestId,
                commandFingerprint: fingerprint,
                command: structuredClone(command),
                state: "completed",
                startedAtMs: now,
                receipt,
              },
            ],
          },
          value: { deliver: false, receipt },
        };
      }
      return {
        nextState: {
          ...touched,
          steeringAttempts: [
            ...attempts,
            {
              requestId: command.requestId,
              commandFingerprint: fingerprint,
              command: structuredClone(command),
              state: "delivering",
              startedAtMs: now,
            },
          ],
        },
        value: { deliver: true },
      };
    });
    if (!decision.value.deliver) {
      return structuredClone(decision.value.receipt!);
    }

    let receipt: WorkerRunSteeringReceiptV1;
    const pending = this.processes.get(command.runId);
    const authority = pending?.leaseAuthority ?? this.leaseAuthorities.get(command.runId);
    if (pending === undefined || pending.process.steer === undefined || authority === undefined) {
      receipt = steeringReceipt(
        command,
        this.readNow(),
        "none",
        "rejected",
        pending === undefined ? "SESSION_NOT_ACTIVE" : "STEERING_UNAVAILABLE",
      );
    } else if (!(await this.isSteeringAuthorityCurrent(command, authority))) {
      receipt = steeringReceipt(command, this.readNow(), "none", "rejected", "RUN_AUTHORITY_LOST");
    } else {
      try {
        const delivered = await pending.process.steer({
          requestId: command.requestId,
          instruction: command.instruction,
          requestedBy: command.requestedBy,
          agentSession: structuredClone(command.agentSession),
          isCommandCurrent: () => this.isSteeringAuthorityCurrent(command, authority),
        });
        if (!sameAgentSession(delivered.agentSession, command.agentSession)) {
          throw new AgentRunBridgeError(
            "STEERING_SCOPE_MISMATCH",
            "The Run process returned a different native-session scope.",
          );
        }
        receipt = steeringReceipt(
          command,
          this.readNow(),
          delivered.delivery,
          delivered.delivery === "live" ? "accepted" : "queued",
          delivered.delivery === "live" ? "LIVE_STEERING_ACCEPTED" : "NEXT_RESUME_QUEUED",
          delivered.providerTurnId,
        );
      } catch (error: unknown) {
        const mapped = steeringFailure(error);
        receipt = steeringReceipt(
          command,
          this.readNow(),
          "none",
          mapped.status,
          mapped.reasonCode,
        );
      }
    }

    await this.mutate((state) => {
      const attempt = (state.steeringAttempts ?? []).find(
        (candidate) => candidate.requestId === command.requestId,
      );
      if (
        attempt === undefined ||
        attempt.commandFingerprint !== fingerprint ||
        attempt.state !== "delivering"
      ) {
        throw new WorkerRuntimeError(
          "STATE_CORRUPT",
          "The durable steering attempt changed during provider delivery.",
        );
      }
      return {
        nextState: replaceSteeringAttempt(state, command.requestId, {
          ...attempt,
          state: "completed",
          receipt,
        }),
        value: undefined,
      };
    });
    return structuredClone(receipt);
  }

  private async isSteeringAuthorityCurrent(
    command: WorkerRunSteeringCommandV1,
    authority: WorkerRunLeaseAuthority,
  ): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    const now = this.readNow();
    const state = await this.repository.read();
    if (now < state.lastObservedAtMs) {
      return false;
    }
    const run = state.runs.find((candidate) => candidate.assignment.runId === command.runId);
    return (
      run !== undefined &&
      run.state === "running" &&
      exactSteeringRunScope(run.assignment, command) &&
      (await authority.isCurrent()) &&
      state.operationalState !== "disabled" &&
      state.operationalState !== "revoked"
    );
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
      readonly usage?: WorkerOutboundEventV1["payload"]["usage"];
      readonly agentSession?: WorkerOutboundEventV1["payload"]["agentSession"];
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
    this.leaseAuthorities.delete(runId);
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

  private async isLeaseCurrent(
    assignment: WorkerRunAssignmentV1,
    authority = this.leaseAuthorities.get(assignment.runId),
  ): Promise<boolean> {
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
      (authority === undefined ? now < assignment.leaseExpiresAtMs : await authority.isCurrent()) &&
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

class WallClockRunLeaseAuthority implements WorkerRunLeaseAuthority {
  private readonly leaseExpiresAtMs: number;
  private readonly clock: WorkerClock;

  public constructor(leaseExpiresAtMs: number, clock: WorkerClock) {
    this.leaseExpiresAtMs = leaseExpiresAtMs;
    this.clock = clock;
  }

  public snapshot() {
    return Object.freeze({
      leaseExpiresAtMs: this.leaseExpiresAtMs,
      conservativeDeadlineMonotonicMs: this.leaseExpiresAtMs,
    });
  }

  public isCurrent(): boolean {
    return readClock(this.clock) < this.leaseExpiresAtMs;
  }

  public async renewIfDue(): Promise<void> {
    // Legacy/in-process tests without a Device Channel retain fixed authority.
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
  maximumConcurrentRuns: number,
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
  if (countActiveRuns(state) >= maximumConcurrentRuns) {
    return "backpressure";
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
    readonly usage?: WorkerOutboundEventV1["payload"]["usage"];
    readonly agentSession?: WorkerOutboundEventV1["payload"]["agentSession"];
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
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.agentSession === undefined ? {} : { agentSession: result.agentSession }),
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

function replaceSteeringAttempt(
  state: PersistedWorkerState,
  requestId: string,
  replacement: PersistedRunSteeringAttempt,
): PersistedWorkerState {
  return {
    ...state,
    steeringAttempts: (state.steeringAttempts ?? []).map((attempt) =>
      attempt.requestId === requestId ? structuredClone(replacement) : attempt,
    ),
  };
}

function exactSteeringRunScope(
  assignment: WorkerRunAssignmentV1,
  command: WorkerRunSteeringCommandV1,
): boolean {
  return (
    assignment.taskId === command.taskId &&
    assignment.workOrder.workOrderId === command.workOrderId &&
    assignment.deviceId === command.deviceId &&
    assignment.workerId === command.workerId &&
    assignment.routeId === command.routeId &&
    assignment.runId === command.runId &&
    assignment.leaseId === command.leaseId &&
    assignment.fencingToken === command.fencingToken
  );
}

function steeringRunScopeReason(
  configuration: WorkerConfiguration,
  run: PersistedWorkerRun | undefined,
  command: WorkerRunSteeringCommandV1,
): Extract<WorkerRunSteeringReceiptReasonV1, "RUN_NOT_ACTIVE" | "RUN_SCOPE_MISMATCH"> | undefined {
  if (command.deviceId !== configuration.deviceId || command.workerId !== configuration.workerId) {
    return "RUN_SCOPE_MISMATCH";
  }
  if (run === undefined || run.state !== "running") {
    return "RUN_NOT_ACTIVE";
  }
  return exactSteeringRunScope(run.assignment, command) ? undefined : "RUN_SCOPE_MISMATCH";
}

function steeringReceipt(
  command: WorkerRunSteeringCommandV1,
  decidedAtMs: number,
  delivery: WorkerRunSteeringReceiptV1["delivery"],
  status: WorkerRunSteeringReceiptV1["status"],
  reasonCode: WorkerRunSteeringReceiptReasonV1,
  providerTurnId?: string,
): WorkerRunSteeringReceiptV1 {
  if (
    !Number.isSafeInteger(decidedAtMs) ||
    decidedAtMs < 0 ||
    decidedAtMs > MAX_JAVASCRIPT_DATE_MS
  ) {
    throw new WorkerRuntimeError("INVALID_MESSAGE", "The steering decision time is invalid.");
  }
  return Object.freeze({
    requestId: command.requestId,
    requestMessageId: command.requestId,
    taskId: command.taskId,
    workOrderId: command.workOrderId,
    deviceId: command.deviceId,
    workerId: command.workerId,
    routeId: command.routeId,
    runId: command.runId,
    leaseId: command.leaseId,
    fencingToken: command.fencingToken,
    agentSession: structuredClone(command.agentSession),
    delivery,
    status,
    reasonCode,
    decidedAtMs,
    ...(providerTurnId === undefined ? {} : { providerTurnId }),
  });
}

function sameAgentSession(
  left: WorkerRunSteeringCommandV1["agentSession"],
  right: WorkerRunSteeringCommandV1["agentSession"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function steeringFailure(error: unknown): {
  readonly status: Extract<WorkerRunSteeringReceiptV1["status"], "outcome-unknown" | "rejected">;
  readonly reasonCode: WorkerRunSteeringReceiptReasonV1;
} {
  if (error instanceof AgentRunBridgeError) {
    switch (error.code) {
      case "STEERING_OUTCOME_UNKNOWN":
        return {
          status: "outcome-unknown",
          reasonCode: "STEERING_OUTCOME_UNKNOWN",
        };
      case "STEERING_SCOPE_MISMATCH":
      case "SESSION_BINDING_MISMATCH":
        return {
          status: "rejected",
          reasonCode: "SESSION_SCOPE_MISMATCH",
        };
      case "STEERING_NOT_ACTIVE":
        return {
          status: "rejected",
          reasonCode: "SESSION_NOT_ACTIVE",
        };
      default:
        return {
          status: "rejected",
          reasonCode: "STEERING_FAILED",
        };
    }
  }
  return {
    status: "outcome-unknown",
    reasonCode: "STEERING_OUTCOME_UNKNOWN",
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

function validateSchedulingInventory(value: unknown): WorkerSchedulingInventoryV1 {
  if (!isPlainRecord(value)) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker inventory is invalid.");
  }
  requireExactInventoryKeys(
    value,
    [
      "deviceName",
      "osFamily",
      "platformRelease",
      "architecture",
      "serviceMode",
      "maximumConcurrentRuns",
      "capabilities",
      "workspaceIds",
      "availableSecretRefs",
    ],
    ["knowledgeHealth", "hardware", "agentAdapters", "resourceLocks"],
  );
  const osFamily = value["osFamily"];
  const serviceMode = value["serviceMode"];
  const knowledgeHealth = value["knowledgeHealth"];
  if (
    (osFamily !== "linux" && osFamily !== "macos" && osFamily !== "windows") ||
    (serviceMode !== "foreground" &&
      serviceMode !== "system-service" &&
      serviceMode !== "user-service") ||
    (knowledgeHealth !== undefined &&
      knowledgeHealth !== "healthy" &&
      knowledgeHealth !== "degraded" &&
      knowledgeHealth !== "unavailable") ||
    !Number.isSafeInteger(value["maximumConcurrentRuns"]) ||
    Number(value["maximumConcurrentRuns"]) < 1 ||
    Number(value["maximumConcurrentRuns"]) > 1_024
  ) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker inventory is invalid.");
  }
  const deviceName = readInventoryText(value["deviceName"], "Device name", 253);
  const platformRelease = readInventoryText(value["platformRelease"], "platform release", 256);
  const architecture = readInventoryText(value["architecture"], "architecture", 64);
  const capabilities = readCapabilities(value["capabilities"]);
  const hardware =
    value["hardware"] === undefined ? undefined : readHardwareFacts(value["hardware"]);
  const agentAdapters =
    value["agentAdapters"] === undefined ? undefined : readAgentAdapters(value["agentAdapters"]);
  const resourceLocks =
    value["resourceLocks"] === undefined ? undefined : readResourceLocks(value["resourceLocks"]);
  const workspaceIds = readInventoryIdentifiers(value["workspaceIds"], "Workspace ID", 128);
  const availableSecretRefs = readInventoryIdentifiers(
    value["availableSecretRefs"],
    "Secret reference",
    256,
  );
  return Object.freeze({
    deviceName,
    osFamily,
    platformRelease,
    architecture,
    serviceMode,
    ...(knowledgeHealth === undefined ? {} : { knowledgeHealth }),
    ...(hardware === undefined ? {} : { hardware }),
    maximumConcurrentRuns: Number(value["maximumConcurrentRuns"]),
    capabilities,
    ...(agentAdapters === undefined ? {} : { agentAdapters }),
    ...(resourceLocks === undefined ? {} : { resourceLocks }),
    workspaceIds,
    availableSecretRefs,
  });
}

function readHardwareFacts(value: unknown): NonNullable<WorkerSchedulingInventoryV1["hardware"]> {
  if (!isPlainRecord(value)) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker hardware facts are invalid.");
  }
  requireExactInventoryKeys(value, ["cpu", "memory", "gpu"]);
  const cpu = value["cpu"];
  const memory = value["memory"];
  const gpu = value["gpu"];
  if (!isPlainRecord(cpu) || !isPlainRecord(memory) || !isPlainRecord(gpu)) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker hardware facts are invalid.");
  }
  requireExactInventoryKeys(cpu, [
    "model",
    "logicalCoreCount",
    "observedAtMs",
    "source",
    "verification",
  ]);
  requireExactInventoryKeys(memory, ["totalBytes", "observedAtMs", "source", "verification"]);
  requireExactInventoryKeys(gpu, ["devices", "observedAtMs", "source", "verification"]);
  const logicalCoreCount = readBoundedHardwareInteger(
    cpu["logicalCoreCount"],
    "logical CPU core count",
    4_096,
  );
  const totalBytes = readBoundedHardwareInteger(
    memory["totalBytes"],
    "total memory bytes",
    Number.MAX_SAFE_INTEGER,
  );
  const devices = gpu["devices"];
  if (!Array.isArray(devices) || devices.length > 16) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker GPU facts are invalid.");
  }
  const seen = new Set<string>();
  const parsedDevices = devices.map((entry) => {
    if (!isPlainRecord(entry)) {
      throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker GPU facts are invalid.");
    }
    requireExactInventoryKeys(entry, ["model"], ["vendor", "memoryBytes"]);
    const model = readHardwareLabel(entry["model"], "GPU model", 256);
    const vendor =
      entry["vendor"] === undefined
        ? undefined
        : readHardwareLabel(entry["vendor"], "GPU vendor", 128);
    const memoryBytes =
      entry["memoryBytes"] === undefined
        ? undefined
        : readBoundedHardwareInteger(
            entry["memoryBytes"],
            "GPU memory bytes",
            Number.MAX_SAFE_INTEGER,
          );
    const identity = `${vendor ?? ""}\0${model}\0${String(memoryBytes ?? "")}`;
    if (seen.has(identity)) {
      throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker GPU facts must be unique.");
    }
    seen.add(identity);
    return Object.freeze({
      model,
      ...(vendor === undefined ? {} : { vendor }),
      ...(memoryBytes === undefined ? {} : { memoryBytes }),
    });
  });
  const cpuVerification = readHardwareVerification(cpu["verification"], false);
  const memoryVerification = readHardwareVerification(memory["verification"], false);
  const gpuVerification = readHardwareVerification(gpu["verification"], true);
  if (gpuVerification === "not-observed" && parsedDevices.length > 0) {
    throw new WorkerRuntimeError(
      "INVALID_CONFIGURATION",
      "An unobserved GPU probe cannot report GPU devices.",
    );
  }
  return Object.freeze({
    cpu: Object.freeze({
      model: readHardwareLabel(cpu["model"], "CPU model", 256),
      logicalCoreCount,
      observedAtMs: readInventoryTimestamp(cpu["observedAtMs"], "CPU observation time"),
      source: readHardwareSource(cpu["source"]),
      verification: cpuVerification,
    }),
    memory: Object.freeze({
      totalBytes,
      observedAtMs: readInventoryTimestamp(memory["observedAtMs"], "memory observation time"),
      source: readHardwareSource(memory["source"]),
      verification: memoryVerification,
    }),
    gpu: Object.freeze({
      devices: Object.freeze(parsedDevices),
      observedAtMs: readInventoryTimestamp(gpu["observedAtMs"], "GPU observation time"),
      source: readHardwareSource(gpu["source"]),
      verification: gpuVerification,
    }),
  });
}

function readHardwareSource(
  value: unknown,
): NonNullable<WorkerSchedulingInventoryV1["hardware"]>["cpu"]["source"] {
  if (value !== "node-os" && value !== "platform-probe") {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker hardware source is invalid.");
  }
  return value;
}

function readHardwareVerification(value: unknown, allowNotObserved: false): "observed" | "verified";
function readHardwareVerification(
  value: unknown,
  allowNotObserved: true,
): "not-observed" | "observed" | "verified";
function readHardwareVerification(
  value: unknown,
  allowNotObserved: boolean,
): "not-observed" | "observed" | "verified" {
  if (
    value !== "observed" &&
    value !== "verified" &&
    (value !== "not-observed" || !allowNotObserved)
  ) {
    throw new WorkerRuntimeError(
      "INVALID_CONFIGURATION",
      "Worker hardware verification is invalid.",
    );
  }
  return value;
}

function readBoundedHardwareInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", `Worker ${label} is invalid.`);
  }
  return Number(value);
}

function readCapabilities(value: unknown): WorkerSchedulingInventoryV1["capabilities"] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker capabilities are invalid.");
  }
  const seen = new Set<string>();
  const capabilities = value.map((entry) => {
    if (!isPlainRecord(entry)) {
      throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker capabilities are invalid.");
    }
    requireExactInventoryKeys(
      entry,
      ["name", "verification"],
      ["observedAtMs", "evidenceSource", "version"],
    );
    const name = readInventoryText(entry["name"], "capability name", 160);
    const verification = entry["verification"];
    if (
      verification !== "detected" &&
      verification !== "verified" &&
      verification !== "degraded" &&
      verification !== "unavailable" &&
      verification !== "disabled"
    ) {
      throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker capabilities are invalid.");
    }
    if (seen.has(name)) {
      throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker capabilities must be unique.");
    }
    const observedAtMs =
      entry["observedAtMs"] === undefined
        ? undefined
        : readInventoryTimestamp(entry["observedAtMs"], "capability observation time");
    const evidenceSource = entry["evidenceSource"];
    if (
      evidenceSource !== undefined &&
      evidenceSource !== "agent-adapter" &&
      evidenceSource !== "capability-probe" &&
      evidenceSource !== "workspace-registry"
    ) {
      throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker capabilities are invalid.");
    }
    const version =
      entry["version"] === undefined
        ? undefined
        : readInventoryText(entry["version"], "capability version", 256);
    seen.add(name);
    return Object.freeze({
      name,
      verification,
      ...(observedAtMs === undefined ? {} : { observedAtMs }),
      ...(evidenceSource === undefined ? {} : { evidenceSource }),
      ...(version === undefined ? {} : { version }),
    });
  });
  return Object.freeze(capabilities);
}

function readAgentAdapters(
  value: unknown,
): NonNullable<WorkerSchedulingInventoryV1["agentAdapters"]> {
  if (!Array.isArray(value) || value.length > 64) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker Agent adapters are invalid.");
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.map((entry) => {
      if (!isPlainRecord(entry)) {
        throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker Agent adapters are invalid.");
      }
      requireExactInventoryKeys(
        entry,
        ["provider", "adapterId", "readiness", "compatibility", "observedAtMs"],
        ["version"],
      );
      const provider = entry["provider"];
      const readiness = entry["readiness"];
      const compatibility = entry["compatibility"];
      if (
        (provider !== "codex" && provider !== "claude" && provider !== "generic-command") ||
        (readiness !== "ready" && readiness !== "degraded" && readiness !== "unavailable") ||
        (compatibility !== "tested" &&
          compatibility !== "compatible" &&
          compatibility !== "untested" &&
          compatibility !== "incompatible")
      ) {
        throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker Agent adapters are invalid.");
      }
      const adapterId = readInventoryText(entry["adapterId"], "Agent adapter ID", 160);
      const identity = `${provider}\0${adapterId}`;
      if (seen.has(identity)) {
        throw new WorkerRuntimeError(
          "INVALID_CONFIGURATION",
          "Worker Agent adapters must be unique.",
        );
      }
      seen.add(identity);
      const version =
        entry["version"] === undefined
          ? undefined
          : readInventoryText(entry["version"], "Agent adapter version", 256);
      return Object.freeze({
        provider,
        adapterId,
        readiness,
        compatibility,
        ...(version === undefined ? {} : { version }),
        observedAtMs: readInventoryTimestamp(
          entry["observedAtMs"],
          "Agent adapter observation time",
        ),
      });
    }),
  );
}

function readResourceLocks(
  value: unknown,
): NonNullable<WorkerSchedulingInventoryV1["resourceLocks"]> {
  if (!Array.isArray(value) || value.length > 128) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker resource locks are invalid.");
  }
  const seenResources = new Set<string>();
  return Object.freeze(
    value.map((entry) => {
      if (!isPlainRecord(entry)) {
        throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker resource locks are invalid.");
      }
      requireExactInventoryKeys(entry, ["resourceName", "capacity", "holders"]);
      const resourceName = readInventoryText(entry["resourceName"], "resource name", 160);
      const capacity = entry["capacity"];
      const holders = entry["holders"];
      if (
        seenResources.has(resourceName) ||
        !Number.isSafeInteger(capacity) ||
        Number(capacity) < 1 ||
        Number(capacity) > 1_024 ||
        !Array.isArray(holders) ||
        holders.length > Number(capacity)
      ) {
        throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker resource locks are invalid.");
      }
      seenResources.add(resourceName);
      const seenHolders = new Set<string>();
      return Object.freeze({
        resourceName,
        capacity: Number(capacity),
        holders: Object.freeze(
          holders.map((holder) => {
            if (!isPlainRecord(holder)) {
              throw new WorkerRuntimeError(
                "INVALID_CONFIGURATION",
                "Worker resource lock holders are invalid.",
              );
            }
            requireExactInventoryKeys(holder, ["taskId", "runId", "expiresAtMs"]);
            const taskId = readInventoryText(holder["taskId"], "resource lock Task ID", 160);
            const runId = readInventoryText(holder["runId"], "resource lock Run ID", 160);
            const identity = `${taskId}\0${runId}`;
            if (seenHolders.has(identity)) {
              throw new WorkerRuntimeError(
                "INVALID_CONFIGURATION",
                "Worker resource lock holders must be unique.",
              );
            }
            seenHolders.add(identity);
            return Object.freeze({
              taskId,
              runId,
              expiresAtMs: readInventoryTimestamp(holder["expiresAtMs"], "resource lock expiry"),
            });
          }),
        ),
      });
    }),
  );
}

function readInventoryTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_JAVASCRIPT_DATE_MS) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", `${label} inventory is invalid.`);
  }
  return Number(value);
}

function readInventoryIdentifiers(
  value: unknown,
  label: string,
  maximumItems: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", `${label} inventory is invalid.`);
  }
  const result = value.map((entry) => readInventoryText(entry, label, 160));
  if (new Set(result).size !== result.length) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", `${label} inventory must be unique.`);
  }
  return Object.freeze(result);
}

function readInventoryText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    [...value].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  ) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", `${label} inventory is invalid.`);
  }
  return value;
}

function readHardwareLabel(value: unknown, label: string, maximumBytes: number): string {
  const parsed = readInventoryText(value, label, maximumBytes);
  if (
    /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(parsed) ||
    /(?:[\\/]Users[\\/]|[\\/]home[\\/]|[\\/]var[\\/]|[\\/]sys[\\/]|[\\/]proc[\\/]|[\\/]dev[\\/])/iu.test(
      parsed,
    ) ||
    /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+|\b(?:sk[-_]|ghp_)[A-Za-z0-9_-]{16,})/u.test(
      parsed,
    )
  ) {
    throw new WorkerRuntimeError(
      "INVALID_CONFIGURATION",
      `${label} contains prohibited local or credential data.`,
    );
  }
  return parsed;
}

function requireExactInventoryKeys(
  value: Readonly<Record<string, unknown>>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowedKeys.has(key))
  ) {
    throw new WorkerRuntimeError("INVALID_CONFIGURATION", "Worker inventory is invalid.");
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const usage = normalizeWorkerProviderUsage(outcome["usage"]);
  if (outcome["usage"] !== undefined && usage === undefined) {
    return undefined;
  }
  let agentSession;
  try {
    agentSession =
      outcome["agentSession"] === undefined
        ? undefined
        : parseWorkerAgentSessionObservation(outcome["agentSession"]);
  } catch {
    return undefined;
  }
  if (outcome["status"] === "failed") {
    return {
      status: "failed",
      report,
      diagnostic: outcome["diagnostic"],
      ...(usage === undefined ? {} : { usage }),
      ...(agentSession === undefined ? {} : { agentSession }),
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
    ...(usage === undefined ? {} : { usage }),
    ...(agentSession === undefined ? {} : { agentSession }),
  };
}

function normalizeWorkerProviderUsage(
  value: unknown,
): WorkerOutboundEventV1["payload"]["usage"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isPlainRecord(value) ||
    Object.keys(value).length === 0 ||
    !Object.keys(value).every((key) =>
      ["inputTokens", "outputTokens", "cachedInputTokens", "costUsdMicros"].includes(key),
    )
  ) {
    return undefined;
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
      return undefined;
    }
    usage[key] = amount as number;
  }
  return Object.freeze(usage);
}
