import type {
  WorkerConfiguration,
  WorkerOutboundEventV1,
  WorkerOperationalState,
  WorkerRunSteeringCommandV1,
  WorkerRunSteeringReceiptV1,
  WorkerRouteIncidentV1,
  WorkerRunAssignmentV1,
} from "./contracts.ts";

export type PersistedRunState =
  "cancelling" | "failed" | "running" | "starting" | "succeeded" | "cancelled";

export const MAXIMUM_DURABLE_PROGRESS_EVENTS_PER_RUN = 1_000_000;

export interface PersistedWorkerRun {
  readonly assignment: WorkerRunAssignmentV1;
  readonly dispatchMessageId: string;
  readonly assignmentFingerprint: string;
  readonly state: PersistedRunState;
  readonly acceptedAtMs: number;
  readonly finishedAtMs?: number;
  /** Backwards-compatible live-presentation bookkeeping for schemaVersion 1. */
  readonly progressCount?: number;
  readonly lastProgressAtMs?: number;
  readonly lastProgressDigest?: string;
}

export interface PersistedInboxEntry {
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly runId: string;
}

export interface PersistedOutboxEntry {
  readonly sequence: number;
  readonly event: WorkerOutboundEventV1;
}

export interface PersistedRunSteeringAttempt {
  readonly requestId: string;
  readonly commandFingerprint: `sha256:${string}`;
  readonly command: WorkerRunSteeringCommandV1;
  readonly state: "completed" | "delivering";
  readonly startedAtMs: number;
  readonly receipt?: WorkerRunSteeringReceiptV1;
}

export interface PersistedWorkerState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly configuration: WorkerConfiguration;
  readonly configurationFingerprint: string;
  readonly operationalState: WorkerOperationalState;
  readonly lastObservedAtMs: number;
  readonly inbox: readonly PersistedInboxEntry[];
  readonly runs: readonly PersistedWorkerRun[];
  readonly outbox: readonly PersistedOutboxEntry[];
  readonly nextOutboxSequence: number;
  /**
   * Optional for backwards-compatible decoding of schemaVersion 1 states
   * written before authenticated Run steering was introduced.
   */
  readonly steeringAttempts?: readonly PersistedRunSteeringAttempt[];
  /**
   * Optional for backwards-compatible decoding of schemaVersion 1 states
   * written before route incidents gained their dedicated durable queue.
   */
  readonly routeIncidents?: readonly WorkerRouteIncidentV1[];
}

export interface WorkerStateRepository {
  initialize(initialState: PersistedWorkerState): Promise<PersistedWorkerState>;
  read(): Promise<PersistedWorkerState>;
  compareAndSwap(expectedGeneration: number, nextState: PersistedWorkerState): Promise<boolean>;
  close(): void;
}

export function cloneWorkerState(state: PersistedWorkerState): PersistedWorkerState {
  return structuredClone(state);
}
