import type { AgentProvider } from "@opendelegate/domain";

export type { AgentProvider } from "@opendelegate/domain";

export type AgentAuthenticationState = "missing" | "not-required" | "ready";

export type AgentAdapterErrorCode =
  | "ADAPTER_AUTHENTICATION_REQUIRED"
  | "ADAPTER_ID_DUPLICATE"
  | "ADAPTER_ID_INVALID"
  | "ADAPTER_NOT_READY"
  | "ADAPTER_TIMESTAMP_INVALID"
  | "CHECKPOINT_NOT_FOUND"
  | "NATIVE_SESSION_NOT_FOUND"
  | "NATIVE_SESSION_UNAVAILABLE"
  | "NATIVE_SESSION_WRITER_BUSY"
  | "SESSION_BINDING_MISMATCH";

export class AgentAdapterError extends Error {
  public readonly code: AgentAdapterErrorCode;

  public constructor(code: AgentAdapterErrorCode, message: string) {
    super(message);
    this.name = "AgentAdapterError";
    this.code = code;
  }
}

export interface AgentAdapterProbe {
  readonly provider: AgentProvider;
  readonly ready: boolean;
  readonly version: string;
  readonly authentication: AgentAuthenticationState;
}

export interface AgentAdapterIdSource {
  nextNativeSessionId(): string;
  nextTurnId(): string;
  nextEventId(): string;
  nextCheckpointId(): string;
}

export interface AgentAdapterClock {
  now(): string;
}

export interface AgentSessionBinding {
  readonly taskId: string;
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly workingDirectory: string;
}

export type StartAgentSessionInput = AgentSessionBinding;

export interface ResumeAgentSessionInput extends AgentSessionBinding {
  readonly nativeSessionId: string;
}

export interface AgentSessionLineage {
  readonly rootNativeSessionId: string;
  readonly parentNativeSessionId: string | null;
  readonly checkpointId: string | null;
  readonly generation: number;
}

export interface AgentSessionReference extends AgentSessionBinding {
  readonly provider: AgentProvider;
  readonly adapterVersion: string;
  readonly nativeSessionId: string;
  readonly createdAt: string;
  readonly lineage: AgentSessionLineage;
}

export interface AgentCheckpointContext {
  readonly taskBrief: string;
  readonly rollingSummary: string;
  readonly decisions: readonly string[];
  readonly pendingWork: readonly string[];
  readonly artifactRefs: readonly string[];
}

export interface CheckpointAgentSessionInput {
  readonly session: AgentSessionReference;
  readonly context: AgentCheckpointContext;
}

export interface AgentSessionCheckpoint extends AgentSessionBinding {
  readonly checkpointId: string;
  readonly provider: AgentProvider;
  readonly sourceNativeSessionId: string;
  readonly createdAt: string;
  readonly context: AgentCheckpointContext;
}

export interface ContinueAgentSessionInput {
  readonly checkpoint: AgentSessionCheckpoint;
}

export interface AgentPublicEventBase {
  readonly eventId: string;
  readonly turnId: string;
  readonly nativeSessionId: string;
  readonly occurredAt: string;
}

export interface AgentMessageEvent extends AgentPublicEventBase {
  readonly type: "message";
  readonly role: "assistant";
  readonly content: string;
}

export interface AgentProgressEvent extends AgentPublicEventBase {
  readonly type: "progress";
  readonly summary: string;
}

export interface AgentToolOutcomeEvent extends AgentPublicEventBase {
  readonly type: "tool-outcome";
  readonly toolKind: "command" | "tool";
  readonly name: string;
  readonly status: "failed" | "succeeded";
  readonly summary: string;
}

export interface AgentApprovalRequestEvent extends AgentPublicEventBase {
  readonly type: "approval-request";
  readonly approvalId: string;
  readonly actionType: string;
  readonly summary: string;
  readonly risk: "high" | "low" | "medium";
}

export interface AgentUsageEvent extends AgentPublicEventBase {
  readonly type: "usage";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

export interface AgentCompletedEvent extends AgentPublicEventBase {
  readonly type: "completed";
  readonly result: string;
}

export interface AgentFailedEvent extends AgentPublicEventBase {
  readonly type: "failed";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentPublicEvent =
  | AgentApprovalRequestEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentMessageEvent
  | AgentProgressEvent
  | AgentToolOutcomeEvent
  | AgentUsageEvent;

export type FakeAgentEventDraft =
  | Omit<AgentApprovalRequestEvent, keyof AgentPublicEventBase>
  | Omit<AgentCompletedEvent, keyof AgentPublicEventBase>
  | Omit<AgentFailedEvent, keyof AgentPublicEventBase>
  | Omit<AgentMessageEvent, keyof AgentPublicEventBase>
  | Omit<AgentProgressEvent, keyof AgentPublicEventBase>
  | Omit<AgentToolOutcomeEvent, keyof AgentPublicEventBase>
  | Omit<AgentUsageEvent, keyof AgentPublicEventBase>;

export interface StartAgentTurnInput {
  readonly session: AgentSessionReference;
  readonly input: string;
}

export interface AgentTurnHandle {
  readonly turnId: string;
  readonly events: AsyncIterable<AgentPublicEvent>;
  cancel(): Promise<void>;
}

export interface FakeTurnScriptInput {
  readonly provider: AgentProvider;
  readonly session: AgentSessionReference;
  readonly turnId: string;
  readonly input: string;
}

export interface AgentAdapter {
  probe(): Promise<AgentAdapterProbe>;
  startSession(input: StartAgentSessionInput): Promise<AgentSessionReference>;
  resumeSession(input: ResumeAgentSessionInput): Promise<AgentSessionReference>;
  startTurn(input: StartAgentTurnInput): Promise<AgentTurnHandle>;
  checkpointSession(input: CheckpointAgentSessionInput): Promise<AgentSessionCheckpoint>;
  continueFromCheckpoint(input: ContinueAgentSessionInput): Promise<AgentSessionReference>;
}

export interface FakeAgentAdapter extends AgentAdapter {
  markNativeSessionUnavailable(nativeSessionId: string): void;
}

export interface FakeAgentAdapterConfig {
  readonly provider: AgentProvider;
  readonly probe: Omit<AgentAdapterProbe, "provider">;
  readonly ids: AgentAdapterIdSource;
  readonly clock: AgentAdapterClock;
  readonly turnScript?: (input: FakeTurnScriptInput) => readonly FakeAgentEventDraft[];
}

function normalizeEvent(draft: FakeAgentEventDraft, base: AgentPublicEventBase): AgentPublicEvent {
  switch (draft.type) {
    case "message":
      return {
        ...base,
        type: "message",
        role: draft.role,
        content: draft.content,
      };
    case "progress":
      return {
        ...base,
        type: "progress",
        summary: draft.summary,
      };
    case "tool-outcome":
      return {
        ...base,
        type: "tool-outcome",
        toolKind: draft.toolKind,
        name: draft.name,
        status: draft.status,
        summary: draft.summary,
      };
    case "approval-request":
      return {
        ...base,
        type: "approval-request",
        approvalId: draft.approvalId,
        actionType: draft.actionType,
        summary: draft.summary,
        risk: draft.risk,
      };
    case "usage": {
      const event = {
        ...base,
        type: "usage" as const,
        inputTokens: draft.inputTokens,
        outputTokens: draft.outputTokens,
      };
      return draft.costUsd === undefined ? event : { ...event, costUsd: draft.costUsd };
    }
    case "completed":
      return {
        ...base,
        type: "completed",
        result: draft.result,
      };
    case "failed":
      return {
        ...base,
        type: "failed",
        code: draft.code,
        message: draft.message,
        retryable: draft.retryable,
      };
  }
}

export function createFakeAgentAdapter(config: FakeAgentAdapterConfig): FakeAgentAdapter {
  const sessions = new Map<string, AgentSessionReference>();
  const activeWriters = new Map<string, string | symbol>();
  const unavailableSessions = new Set<string>();
  const checkpoints = new Map<string, AgentSessionCheckpoint>();
  const nativeSessionIds = new Set<string>();
  const turnIds = new Set<string>();
  const eventIds = new Set<string>();
  const checkpointIds = new Set<string>();

  const requireOperationalAdapter = (): void => {
    if (!config.probe.ready) {
      throw new AgentAdapterError("ADAPTER_NOT_READY", "Agent adapter is not ready.");
    }
    if (config.probe.authentication === "missing") {
      throw new AgentAdapterError(
        "ADAPTER_AUTHENTICATION_REQUIRED",
        "Agent adapter authentication is required.",
      );
    }
  };

  const getSession = (input: ResumeAgentSessionInput): AgentSessionReference => {
    const session = sessions.get(input.nativeSessionId);
    if (session === undefined) {
      throw new AgentAdapterError("NATIVE_SESSION_NOT_FOUND", "Native session was not found.");
    }
    if (
      session.taskId !== input.taskId ||
      session.deviceId !== input.deviceId ||
      session.workspaceId !== input.workspaceId ||
      session.workingDirectory !== input.workingDirectory
    ) {
      throw new AgentAdapterError(
        "SESSION_BINDING_MISMATCH",
        "Native session binding does not match.",
      );
    }
    return session;
  };

  const requireAvailable = (session: AgentSessionReference): void => {
    if (unavailableSessions.has(session.nativeSessionId)) {
      throw new AgentAdapterError("NATIVE_SESSION_UNAVAILABLE", "Native session is unavailable.");
    }
  };

  return {
    async probe() {
      return {
        provider: config.provider,
        ready: config.probe.ready,
        version: config.probe.version,
        authentication: config.probe.authentication,
      };
    },
    async startSession(input) {
      requireOperationalAdapter();
      const nativeSessionId = claimGeneratedId(
        "native session",
        config.ids.nextNativeSessionId(),
        nativeSessionIds,
      );
      const createdAt = readTimestamp(config.clock);
      const session: AgentSessionReference = Object.freeze({
        provider: config.provider,
        adapterVersion: config.probe.version,
        nativeSessionId,
        taskId: input.taskId,
        deviceId: input.deviceId,
        workspaceId: input.workspaceId,
        workingDirectory: input.workingDirectory,
        createdAt,
        lineage: Object.freeze({
          rootNativeSessionId: nativeSessionId,
          parentNativeSessionId: null,
          checkpointId: null,
          generation: 0,
        }),
      });
      sessions.set(nativeSessionId, session);
      return session;
    },
    async resumeSession(input) {
      requireOperationalAdapter();
      const session = getSession(input);
      requireAvailable(session);
      return session;
    },
    async startTurn(input) {
      requireOperationalAdapter();
      const session = getSession(input.session);
      requireAvailable(session);
      if (activeWriters.has(session.nativeSessionId)) {
        throw new AgentAdapterError(
          "NATIVE_SESSION_WRITER_BUSY",
          "Native session already has an active writer.",
        );
      }
      const provisionalWriter = Symbol("provisional native-session writer");
      activeWriters.set(session.nativeSessionId, provisionalWriter);
      let turnId: string;
      try {
        turnId = claimGeneratedId("turn", config.ids.nextTurnId(), turnIds);
      } catch (error: unknown) {
        if (activeWriters.get(session.nativeSessionId) === provisionalWriter) {
          activeWriters.delete(session.nativeSessionId);
        }
        throw error;
      }
      activeWriters.set(session.nativeSessionId, turnId);
      const releaseWriter = () => {
        if (activeWriters.get(session.nativeSessionId) === turnId) {
          activeWriters.delete(session.nativeSessionId);
        }
      };
      let drafts: readonly FakeAgentEventDraft[];
      try {
        drafts =
          config.turnScript?.({
            provider: config.provider,
            session,
            turnId,
            input: input.input,
          }) ?? [];
      } catch (error: unknown) {
        releaseWriter();
        throw error;
      }
      let cancelled = false;
      let terminal = false;
      let abandoned = false;
      let draftIndex = 0;
      const cancellationEvent = (): AgentPublicEvent =>
        normalizeEvent(
          {
            type: "failed",
            code: "CANCELLED",
            message: "Turn cancelled.",
            retryable: false,
          },
          createEventBase(config, eventIds, turnId, session.nativeSessionId),
        );
      const iterator: AsyncIterator<AgentPublicEvent> = {
        async next() {
          if (terminal || abandoned) {
            return { done: true, value: undefined };
          }

          if (cancelled) {
            terminal = true;
            try {
              return { done: false, value: cancellationEvent() };
            } finally {
              releaseWriter();
            }
          }

          const draft = drafts[draftIndex];
          if (draft === undefined) {
            abandoned = true;
            return { done: true, value: undefined };
          }

          draftIndex += 1;

          try {
            const event = normalizeEvent(
              draft,
              createEventBase(config, eventIds, turnId, session.nativeSessionId),
            );
            if (event.type === "completed" || event.type === "failed") {
              terminal = true;
              releaseWriter();
            }
            return { done: false, value: event };
          } catch (error: unknown) {
            abandoned = true;
            throw error;
          }
        },
        async return() {
          if (!terminal) {
            abandoned = true;
            if (cancelled) {
              terminal = true;
              releaseWriter();
            }
          }
          return { done: true, value: undefined };
        },
        async throw(error?: unknown) {
          if (!terminal) {
            abandoned = true;
            if (cancelled) {
              terminal = true;
              releaseWriter();
            }
          }
          throw error;
        },
      };
      return {
        turnId,
        events: {
          [Symbol.asyncIterator]() {
            return iterator;
          },
        },
        async cancel() {
          if (!terminal) {
            cancelled = true;
            if (abandoned) {
              terminal = true;
              releaseWriter();
            }
          }
        },
      };
    },
    async checkpointSession(input) {
      const session = getSession(input.session);
      const context: AgentCheckpointContext = Object.freeze({
        taskBrief: input.context.taskBrief,
        rollingSummary: input.context.rollingSummary,
        decisions: Object.freeze([...input.context.decisions]),
        pendingWork: Object.freeze([...input.context.pendingWork]),
        artifactRefs: Object.freeze([...input.context.artifactRefs]),
      });
      const checkpoint: AgentSessionCheckpoint = Object.freeze({
        checkpointId: claimGeneratedId("checkpoint", config.ids.nextCheckpointId(), checkpointIds),
        provider: session.provider,
        sourceNativeSessionId: session.nativeSessionId,
        taskId: session.taskId,
        deviceId: session.deviceId,
        workspaceId: session.workspaceId,
        workingDirectory: session.workingDirectory,
        createdAt: readTimestamp(config.clock),
        context,
      });
      checkpoints.set(checkpoint.checkpointId, checkpoint);
      return checkpoint;
    },
    async continueFromCheckpoint(input) {
      requireOperationalAdapter();
      const checkpoint = checkpoints.get(input.checkpoint.checkpointId);
      if (checkpoint === undefined) {
        throw new AgentAdapterError("CHECKPOINT_NOT_FOUND", "Session checkpoint was not found.");
      }
      const source = getSession({
        nativeSessionId: checkpoint.sourceNativeSessionId,
        taskId: checkpoint.taskId,
        deviceId: checkpoint.deviceId,
        workspaceId: checkpoint.workspaceId,
        workingDirectory: checkpoint.workingDirectory,
      });
      const nativeSessionId = claimGeneratedId(
        "native session",
        config.ids.nextNativeSessionId(),
        nativeSessionIds,
      );
      const createdAt = readTimestamp(config.clock);
      const continuation: AgentSessionReference = Object.freeze({
        provider: config.provider,
        adapterVersion: config.probe.version,
        nativeSessionId,
        taskId: checkpoint.taskId,
        deviceId: checkpoint.deviceId,
        workspaceId: checkpoint.workspaceId,
        workingDirectory: checkpoint.workingDirectory,
        createdAt,
        lineage: Object.freeze({
          rootNativeSessionId: source.lineage.rootNativeSessionId,
          parentNativeSessionId: source.nativeSessionId,
          checkpointId: checkpoint.checkpointId,
          generation: source.lineage.generation + 1,
        }),
      });
      sessions.set(nativeSessionId, continuation);
      return continuation;
    },
    markNativeSessionUnavailable(nativeSessionId) {
      if (!sessions.has(nativeSessionId)) {
        throw new AgentAdapterError("NATIVE_SESSION_NOT_FOUND", "Native session was not found.");
      }
      unavailableSessions.add(nativeSessionId);
    },
  };
}

function createEventBase(
  config: FakeAgentAdapterConfig,
  eventIds: Set<string>,
  turnId: string,
  nativeSessionId: string,
): AgentPublicEventBase {
  return {
    eventId: claimGeneratedId("event", config.ids.nextEventId(), eventIds),
    turnId,
    nativeSessionId,
    occurredAt: readTimestamp(config.clock),
  };
}

function claimGeneratedId(kind: string, value: string, claimed: Set<string>): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    value.trim().length === 0 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new AgentAdapterError("ADAPTER_ID_INVALID", `Generated ${kind} identifier is invalid.`);
  }

  if (claimed.has(value)) {
    throw new AgentAdapterError(
      "ADAPTER_ID_DUPLICATE",
      `Generated ${kind} identifier has already been used.`,
    );
  }

  claimed.add(value);
  return value;
}

function readTimestamp(clock: AgentAdapterClock): string {
  const value = clock.now();

  if (typeof value !== "string" || !isStrictRfc3339(value)) {
    throw new AgentAdapterError(
      "ADAPTER_TIMESTAMP_INVALID",
      "Agent adapter clock returned an invalid RFC 3339 timestamp.",
    );
  }

  return value;
}

function isStrictRfc3339(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);

  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
  const maximumDay =
    month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;

  return (
    year >= 1 &&
    day >= 1 &&
    day <= maximumDay &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (offset === null || (Number(offset[2]) <= 23 && Number(offset[3]) <= 59)) &&
    Number.isFinite(Date.parse(value))
  );
}
