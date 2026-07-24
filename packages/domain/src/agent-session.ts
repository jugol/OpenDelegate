import { DomainError } from "./domain-error.ts";
import { AgentSessionId, DeviceId, TaskId, type RunId } from "./identifiers.ts";

export type AgentProvider = "claude" | "codex" | "generic-command";
export type AgentSessionState = "available" | "in-use" | "lost";

export interface AgentWorkspaceBinding {
  readonly workspaceId: string;
  readonly workingDirectory: string;
}

export interface CreateAgentSession {
  readonly id: AgentSessionId;
  readonly taskId: TaskId;
  readonly deviceId: DeviceId;
  readonly provider: AgentProvider;
  readonly nativeSessionId: string;
  readonly adapterVersion: string;
  readonly workspace: AgentWorkspaceBinding;
}

export interface AgentSessionResumeBinding extends AgentWorkspaceBinding {
  readonly taskId: string;
  readonly deviceId: string;
  readonly provider: AgentProvider;
  readonly nativeSessionId: string;
  readonly adapterVersion: string;
}

export interface AssertAgentSessionResumeBinding extends AgentWorkspaceBinding {
  readonly deviceId: string;
}

export interface MarkAgentSessionLost {
  readonly checkpointId: string;
  readonly reason: string;
}

export interface AgentSessionWriterLease {
  readonly runId: RunId;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

export interface ReleaseAgentSessionWriter {
  readonly runId: RunId;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly observedAtMs: number;
}

export interface AgentSessionWriterLeaseSnapshot {
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

export interface AgentSessionSnapshot {
  readonly id: string;
  readonly taskId: string;
  readonly deviceId: string;
  readonly provider: AgentProvider;
  readonly nativeSessionId: string;
  readonly adapterVersion: string;
  readonly workspace: AgentWorkspaceBinding;
  readonly state: AgentSessionState;
  readonly lastWriterFencingToken: number;
  readonly writerLease?: AgentSessionWriterLeaseSnapshot;
}

export interface AgentSessionContinuation {
  readonly parentSessionId: string;
  readonly taskId: string;
  readonly deviceId: string;
  readonly checkpointId: string;
  readonly reason: string;
}

export class AgentSession {
  public readonly id: AgentSessionId;
  public readonly taskId: TaskId;
  public readonly deviceId: DeviceId;
  public readonly provider: AgentProvider;
  public readonly nativeSessionId: string;
  public readonly adapterVersion: string;
  private readonly workspace: AgentWorkspaceBinding;
  private currentState: AgentSessionState = "available";
  private currentWriterLease: AgentSessionWriterLeaseSnapshot | undefined;
  private lastWriterFencingToken = 0;

  private constructor(input: CreateAgentSession) {
    this.id = input.id;
    this.taskId = input.taskId;
    this.deviceId = input.deviceId;
    this.provider = input.provider;
    this.nativeSessionId = input.nativeSessionId;
    this.adapterVersion = input.adapterVersion;
    this.workspace = Object.freeze({ ...input.workspace });
  }

  public static create(input: CreateAgentSession): AgentSession {
    return new AgentSession(input);
  }

  public static restore(snapshot: AgentSessionSnapshot): AgentSession {
    validateSnapshot(snapshot);
    const session = new AgentSession({
      id: AgentSessionId.from(snapshot.id),
      taskId: TaskId.from(snapshot.taskId),
      deviceId: DeviceId.from(snapshot.deviceId),
      provider: snapshot.provider,
      nativeSessionId: snapshot.nativeSessionId,
      adapterVersion: snapshot.adapterVersion,
      workspace: snapshot.workspace,
    });
    session.currentState = snapshot.state;
    session.lastWriterFencingToken = snapshot.lastWriterFencingToken;
    session.currentWriterLease =
      snapshot.writerLease === undefined ? undefined : freezeWriterLease(snapshot.writerLease);
    return session;
  }

  public get state(): AgentSessionState {
    return this.currentState;
  }

  public get activeWriterRunId(): string | undefined {
    return this.currentWriterLease?.runId;
  }

  public get snapshot(): AgentSessionSnapshot {
    return Object.freeze({
      id: this.id.value,
      taskId: this.taskId.value,
      deviceId: this.deviceId.value,
      provider: this.provider,
      nativeSessionId: this.nativeSessionId,
      adapterVersion: this.adapterVersion,
      workspace: this.workspace,
      state: this.currentState,
      lastWriterFencingToken: this.lastWriterFencingToken,
      ...(this.currentWriterLease === undefined ? {} : { writerLease: this.currentWriterLease }),
    });
  }

  public get resumeBinding(): AgentSessionResumeBinding {
    return Object.freeze({
      taskId: this.taskId.value,
      deviceId: this.deviceId.value,
      provider: this.provider,
      nativeSessionId: this.nativeSessionId,
      adapterVersion: this.adapterVersion,
      ...this.workspace,
    });
  }

  public acquireWriter(input: AgentSessionWriterLease): void {
    if (this.currentState === "lost") {
      throw new DomainError(
        "AGENT_SESSION_UNAVAILABLE",
        "A lost native Agent Session cannot accept a writer.",
      );
    }

    validateWriterLease(input);
    const currentLease = this.currentWriterLease;

    if (currentLease !== undefined) {
      if (sameWriterLease(currentLease, input)) {
        return;
      }

      if (input.acquiredAtMs < currentLease.expiresAtMs) {
        throw new DomainError(
          "AGENT_SESSION_WRITER_CONFLICT",
          `Run ${currentLease.runId} already owns this native Agent Session.`,
        );
      }
    }

    if (input.fencingToken <= this.lastWriterFencingToken) {
      throw new DomainError(
        "AGENT_SESSION_FENCE_STALE",
        `Fencing token ${input.fencingToken} is not newer than ${this.lastWriterFencingToken}.`,
      );
    }

    this.currentWriterLease = freezeWriterLease({
      runId: input.runId.value,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken,
      acquiredAtMs: input.acquiredAtMs,
      expiresAtMs: input.expiresAtMs,
    });
    this.lastWriterFencingToken = input.fencingToken;
    this.currentState = "in-use";
  }

  public releaseWriter(input: ReleaseAgentSessionWriter): void {
    const currentLease = this.currentWriterLease;
    if (
      currentLease === undefined ||
      currentLease.runId !== input.runId.value ||
      currentLease.leaseId !== input.leaseId ||
      currentLease.fencingToken !== input.fencingToken
    ) {
      throw new DomainError(
        "AGENT_SESSION_WRITER_MISMATCH",
        `Run ${input.runId.value} does not own this native Agent Session lease.`,
      );
    }

    validateObservedAt(input.observedAtMs, currentLease.acquiredAtMs);
    if (input.observedAtMs >= currentLease.expiresAtMs) {
      this.currentWriterLease = undefined;
      this.currentState = "available";
      throw new DomainError(
        "AGENT_SESSION_WRITER_LEASE_EXPIRED",
        "The native Agent Session writer lease expired before release.",
      );
    }

    this.currentWriterLease = undefined;
    this.currentState = "available";
  }

  public assertResumeBinding(input: AssertAgentSessionResumeBinding): void {
    if (
      input.deviceId !== this.deviceId.value ||
      input.workspaceId !== this.workspace.workspaceId ||
      input.workingDirectory !== this.workspace.workingDirectory
    ) {
      throw new DomainError(
        "AGENT_SESSION_BINDING_MISMATCH",
        "Native Agent Session resume requires the original Device, Workspace, and working directory.",
      );
    }
  }

  public markLost(input: MarkAgentSessionLost): AgentSessionContinuation {
    this.currentWriterLease = undefined;
    this.currentState = "lost";

    return Object.freeze({
      parentSessionId: this.id.value,
      taskId: this.taskId.value,
      deviceId: this.deviceId.value,
      checkpointId: input.checkpointId,
      reason: input.reason,
    });
  }
}

function validateWriterLease(
  input: Pick<
    AgentSessionWriterLeaseSnapshot,
    "leaseId" | "fencingToken" | "acquiredAtMs" | "expiresAtMs"
  >,
): void {
  if (
    input.leaseId.trim() === "" ||
    !Number.isSafeInteger(input.fencingToken) ||
    input.fencingToken <= 0 ||
    !Number.isSafeInteger(input.acquiredAtMs) ||
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.expiresAtMs <= input.acquiredAtMs
  ) {
    throw new DomainError(
      "AGENT_SESSION_WRITER_LEASE_INVALID",
      "A native Agent Session writer requires a valid lease, fence, and expiration.",
    );
  }
}

function validateObservedAt(observedAtMs: number, acquiredAtMs: number): void {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < acquiredAtMs) {
    throw new DomainError(
      "AGENT_SESSION_WRITER_LEASE_INVALID",
      "A writer mutation requires a safe observation time at or after acquisition.",
    );
  }
}

function freezeWriterLease(
  lease: AgentSessionWriterLeaseSnapshot,
): AgentSessionWriterLeaseSnapshot {
  return Object.freeze({ ...lease });
}

function sameWriterLease(
  current: AgentSessionWriterLeaseSnapshot,
  replay: AgentSessionWriterLease,
): boolean {
  return (
    current.runId === replay.runId.value &&
    current.leaseId === replay.leaseId &&
    current.fencingToken === replay.fencingToken &&
    current.acquiredAtMs === replay.acquiredAtMs &&
    current.expiresAtMs === replay.expiresAtMs
  );
}

function validateSnapshot(snapshot: AgentSessionSnapshot): void {
  if (
    !Number.isSafeInteger(snapshot.lastWriterFencingToken) ||
    snapshot.lastWriterFencingToken < 0
  ) {
    throw new DomainError(
      "AGENT_SESSION_SNAPSHOT_INVALID",
      "An Agent Session snapshot requires a non-negative safe writer fence.",
    );
  }

  const writerLease = snapshot.writerLease;
  if (
    (snapshot.state === "in-use") !== (writerLease !== undefined) ||
    (snapshot.state === "lost" && writerLease !== undefined)
  ) {
    throw new DomainError(
      "AGENT_SESSION_SNAPSHOT_INVALID",
      "Agent Session state and writer lease are inconsistent.",
    );
  }

  if (writerLease !== undefined) {
    if (writerLease.runId.trim() === "") {
      throw new DomainError(
        "AGENT_SESSION_SNAPSHOT_INVALID",
        "An active writer snapshot requires a non-blank Run identifier.",
      );
    }
    validateWriterLease(writerLease);
    if (writerLease.fencingToken !== snapshot.lastWriterFencingToken) {
      throw new DomainError(
        "AGENT_SESSION_SNAPSHOT_INVALID",
        "The active writer fence must equal the last issued writer fence.",
      );
    }
  }
}
