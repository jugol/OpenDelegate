import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  AgentAdapterError,
  type AgentAdapter,
  type AgentPermissionInput,
  type AgentRunHandle,
  type AgentRunLimits,
  type AgentSandbox,
  type NativeSessionReference,
  type WorkspaceBinding,
} from "@opendelegate/agent-adapters";
import {
  type AuthoritativeWorkerReport,
  type DirectPlanningCompletionAuthorizer,
  type TaskContinuationCheckpointPort,
  type TaskEvidenceVerifier,
  TaskExecutorError,
  type TaskExecutionRequest,
  type TaskExecutionResult,
  type TaskExecutor,
  type TaskWorkPlanDecision,
  type TaskWorkPlanner,
} from "@opendelegate/task-service";
import {
  sanitizeTaskContinuationText,
  serializeTaskContinuationCheckpoint,
  type DeviceSummaryV1,
  type TaskContinuationCheckpointV1,
} from "@opendelegate/protocol";

interface StoredSessionEvent {
  readonly eventId: string;
  readonly streamVersion: number;
  readonly type: string;
  readonly payload: unknown;
}

export interface NativeSessionEventStore {
  readStream(streamId: string): Promise<readonly StoredSessionEvent[]>;
  append(input: {
    readonly streamId: string;
    readonly expectedVersion: number;
    readonly events: readonly {
      readonly eventId: string;
      readonly type: string;
      readonly payload: object;
    }[];
  }): Promise<readonly StoredSessionEvent[]>;
}

export interface MainNativeSessionRepository {
  load(sessionKey: string): Promise<NativeSessionReference | undefined>;
  save(reference: NativeSessionReference): Promise<void>;
}

export class EventStoreMainNativeSessionRepository implements MainNativeSessionRepository {
  readonly #eventStore: NativeSessionEventStore;

  constructor(eventStore: NativeSessionEventStore) {
    if (
      eventStore === null ||
      typeof eventStore !== "object" ||
      typeof eventStore.readStream !== "function" ||
      typeof eventStore.append !== "function"
    ) {
      throw new TypeError("A durable native-session event store is required.");
    }
    this.#eventStore = eventStore;
  }

  async load(sessionKey: string): Promise<NativeSessionReference | undefined> {
    assertIdentifier(sessionKey, "Session key");
    const events = await this.#eventStore.readStream(sessionStreamId(sessionKey));
    if (events.length === 0) {
      return undefined;
    }
    let reference: NativeSessionReference | undefined;
    for (const [index, event] of events.entries()) {
      if (
        event.streamVersion !== index + 1 ||
        event.type !== "agent.native-session-recorded" ||
        !isRecord(event.payload) ||
        event.payload["schemaVersion"] !== 1 ||
        event.payload["sessionKeyDigest"] !== digest(sessionKey)
      ) {
        throw sessionStateCorrupt();
      }
      const next = validateReference(event.payload["reference"]);
      if (next.sessionKey !== sessionKey) {
        throw sessionStateCorrupt();
      }
      if (reference !== undefined) {
        assertValidReplacement(reference, next);
      }
      reference = next;
    }
    if (reference === undefined) {
      throw sessionStateCorrupt();
    }
    return reference;
  }

  async save(input: NativeSessionReference): Promise<void> {
    const reference = validateReference(input);
    const sessionKey = reference.sessionKey;
    const streamId = sessionStreamId(sessionKey);
    const events = await this.#eventStore.readStream(streamId);
    const current = events.length === 0 ? undefined : await this.load(sessionKey);
    if (current !== undefined) {
      assertValidReplacement(current, reference);
      if (JSON.stringify(current) === JSON.stringify(reference)) {
        return;
      }
    }
    const document = JSON.stringify(reference);
    await this.#eventStore.append({
      streamId,
      expectedVersion: events.length,
      events: [
        {
          eventId: `event_${digest(`${streamId}\u0000${document}`).slice("sha256:".length)}`,
          type: "agent.native-session-recorded",
          payload: {
            schemaVersion: 1,
            sessionKeyDigest: digest(sessionKey),
            reference,
          },
        },
      ],
    });
  }
}

export interface AgentBackedTaskExecutorOptions {
  readonly adapter: AgentAdapter;
  readonly sessionRepository: MainNativeSessionRepository;
  readonly checkpoints: TaskContinuationCheckpointPort;
  readonly deviceId: string;
  readonly workspace: WorkspaceBinding;
  readonly sandbox: AgentSandbox;
  readonly permissions: AgentPermissionInput;
  readonly limits: AgentRunLimits;
  /**
   * Main-owned, owner-safe Device state made available to planning turns for
   * read-only orchestration questions. Secrets, Device instructions, Knowledge,
   * and private transcripts must not be exposed by this port.
   */
  readonly deviceDirectory?: {
    list(): Promise<readonly DeviceSummaryV1[]>;
  };
  /**
   * Resolves the exact provider-native model and optional provider tuning for a
   * newly created Coordinator session. Existing sessions and checkpoint
   * continuations retain their recorded binding and do not call this resolver.
   */
  readonly resolveNewSessionBinding?: () => Promise<{
    readonly modelId?: string;
    readonly effort?: string;
  }>;
  readonly maximumPromptBytes?: number;
}

const DEFAULT_MAXIMUM_PROMPT_BYTES = 256 * 1024;

interface AgentCoordinatorTurn {
  readonly task: TaskExecutionRequest["task"];
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly buildPrompt: (
    sessionAction: "start" | "resume" | "continuation",
    checkpoint?: TaskContinuationCheckpointV1,
  ) => string;
}

export class AgentBackedTaskExecutor
  implements TaskExecutor, TaskWorkPlanner, TaskEvidenceVerifier, DirectPlanningCompletionAuthorizer
{
  readonly #adapter: AgentAdapter;
  readonly #sessionRepository: MainNativeSessionRepository;
  readonly #checkpoints: TaskContinuationCheckpointPort;
  readonly #deviceId: string;
  readonly #workspace: WorkspaceBinding;
  readonly #sandbox: AgentSandbox;
  readonly #permissions: AgentPermissionInput;
  readonly #limits: AgentRunLimits;
  readonly #deviceDirectory: AgentBackedTaskExecutorOptions["deviceDirectory"];
  readonly #resolveNewSessionBinding: AgentBackedTaskExecutorOptions["resolveNewSessionBinding"];
  readonly #maximumPromptBytes: number;
  readonly #active = new Map<string, AgentRunHandle>();
  readonly #taskTails = new Map<string, Promise<void>>();
  readonly #directPlanningCompletions = new WeakMap<
    object,
    { readonly taskId: string; readonly executionKey: string }
  >();

  constructor(options: AgentBackedTaskExecutorOptions) {
    assertAdapter(options.adapter);
    assertRepository(options.sessionRepository);
    assertCheckpointProvider(options.checkpoints);
    assertIdentifier(options.deviceId, "Main Device ID");
    assertWorkspace(options.workspace);
    assertExecutionOptions(options.sandbox, options.permissions, options.limits);
    if (
      options.deviceDirectory !== undefined &&
      (options.deviceDirectory === null ||
        typeof options.deviceDirectory !== "object" ||
        typeof options.deviceDirectory.list !== "function")
    ) {
      throw new TypeError("The Main Agent Device directory is invalid.");
    }
    if (
      options.resolveNewSessionBinding !== undefined &&
      typeof options.resolveNewSessionBinding !== "function"
    ) {
      throw new TypeError("The Coordinator binding resolver is invalid.");
    }
    const maximumPromptBytes = options.maximumPromptBytes ?? DEFAULT_MAXIMUM_PROMPT_BYTES;
    if (!Number.isSafeInteger(maximumPromptBytes) || maximumPromptBytes < 4_096) {
      throw new TypeError("maximumPromptBytes must be a safe integer of at least 4096.");
    }
    this.#adapter = options.adapter;
    this.#sessionRepository = options.sessionRepository;
    this.#checkpoints = options.checkpoints;
    this.#deviceId = options.deviceId;
    this.#workspace = structuredClone(options.workspace);
    this.#sandbox = options.sandbox;
    this.#permissions = structuredClone(options.permissions);
    this.#limits = { ...options.limits };
    this.#deviceDirectory = options.deviceDirectory;
    this.#resolveNewSessionBinding = options.resolveNewSessionBinding;
    this.#maximumPromptBytes = maximumPromptBytes;
  }

  async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    return this.#enqueueTaskTurn(request.task.taskId, request.signal, async () =>
      parseCoordinatorResult(
        await this.#runAgentTurn({
          task: request.task,
          signal: request.signal,
          turnId: request.executionKey,
          buildPrompt: (sessionAction, checkpoint) =>
            buildCoordinatorPrompt(request, this.#maximumPromptBytes, sessionAction, checkpoint),
        }),
      ),
    );
  }

  async plan(input: Parameters<TaskWorkPlanner["plan"]>[0]): Promise<TaskWorkPlanDecision> {
    const directAnswer = await this.planDeterministically(input);
    if (directAnswer !== undefined) {
      return directAnswer;
    }
    const deviceContext = await this.#readPlanningDeviceContext(input.signal);
    return this.#enqueueTaskTurn(input.task.taskId, input.signal, async () =>
      parsePlanningResult(
        await this.#runAgentTurn({
          task: input.task,
          signal: input.signal,
          turnId: `${input.executionKey}:planning`,
          buildPrompt: (sessionAction, checkpoint) =>
            buildPlanningPrompt(
              input.task,
              input.attempt,
              this.#maximumPromptBytes,
              sessionAction,
              checkpoint,
              deviceContext,
            ),
        }),
        input.task,
        input.executionKey,
      ),
    );
  }

  async planDeterministically(
    input: Parameters<NonNullable<TaskWorkPlanner["planDeterministically"]>>[0],
  ): Promise<Extract<TaskWorkPlanDecision, { readonly state: "completed" }> | undefined> {
    const question = deviceDirectoryQuestionForTask(input.task);
    if (question === undefined) {
      return undefined;
    }
    const deviceContext = await this.#readPlanningDeviceContext(input.signal);
    const directAnswer = answerDeviceDirectoryQuestion(input.task, deviceContext, question);
    if (directAnswer !== undefined) {
      this.#directPlanningCompletions.set(directAnswer, {
        taskId: input.task.taskId,
        executionKey: input.executionKey,
      });
    }
    return directAnswer;
  }

  authorize(input: Parameters<DirectPlanningCompletionAuthorizer["authorize"]>[0]): boolean {
    const authority = this.#directPlanningCompletions.get(input.decision);
    return authority?.taskId === input.task.taskId && authority.executionKey === input.executionKey;
  }

  async #readPlanningDeviceContext(
    signal: AbortSignal,
  ): Promise<readonly PlanningDeviceObservation[] | undefined> {
    if (this.#deviceDirectory === undefined) {
      return undefined;
    }
    if (signal.aborted) {
      throw new TaskExecutorError(
        "EXECUTION_CANCELLED",
        "The Main Agent planning turn was cancelled.",
      );
    }
    let devices: readonly DeviceSummaryV1[];
    try {
      devices = await this.#deviceDirectory.list();
    } catch {
      throw new TaskExecutorError(
        "MAIN_CONTEXT_UNAVAILABLE",
        "The Main-owned Device directory is temporarily unavailable.",
        true,
      );
    }
    if (signal.aborted) {
      throw new TaskExecutorError(
        "EXECUTION_CANCELLED",
        "The Main Agent planning turn was cancelled.",
      );
    }
    return projectPlanningDeviceContext(devices);
  }

  async verify(input: Parameters<TaskEvidenceVerifier["verify"]>[0]): Promise<TaskExecutionResult> {
    const evidenceIdentity = input.reports.map((report) => [
      report.runId,
      report.leaseId,
      report.fencingToken,
      report.acceptedAtMs,
    ]);
    const turnId = `task-verification:${input.task.taskId}:${digest(
      JSON.stringify(evidenceIdentity),
    ).slice("sha256:".length)}`;
    return this.#enqueueTaskTurn(input.task.taskId, input.signal, async () =>
      parseVerificationResult(
        await this.#runAgentTurn({
          task: input.task,
          signal: input.signal,
          turnId,
          buildPrompt: (sessionAction, checkpoint) =>
            buildVerificationPrompt(
              input.task,
              input.workOrders,
              input.reports,
              this.#maximumPromptBytes,
              sessionAction,
              checkpoint,
            ),
        }),
      ),
    );
  }

  async #runAgentTurn(input: AgentCoordinatorTurn): Promise<string | undefined> {
    const sessionKey = taskSessionKey(input.task.taskId, this.#adapter.adapterId);
    let session: NativeSessionReference | undefined;
    try {
      session = await this.#sessionRepository.load(sessionKey);
      if (session !== undefined) {
        assertSessionBinding(session, {
          adapter: this.#adapter,
          deviceId: this.#deviceId,
          taskId: input.task.taskId,
          workspace: this.#workspace,
          sessionKey,
          modelId: session.modelId,
        });
      }
    } catch (error) {
      if (error instanceof TaskExecutorError) {
        throw error;
      }
      throw new TaskExecutorError(
        "NATIVE_SESSION_STATE_FAILED",
        "The Main Agent native-session state could not be read safely.",
      );
    }

    const sessionAction =
      session === undefined
        ? ({ kind: "start" } as const)
        : await resolveNativeSessionAction(this.#adapter, session);
    const binding =
      session === undefined
        ? await this.#resolveBindingForNewSession()
        : {
            ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
            ...(session.effort === undefined ? {} : { effort: session.effort }),
          };
    const modelId = binding.modelId;
    let checkpoint: TaskContinuationCheckpointV1 | undefined;
    if (sessionAction.kind === "continuation") {
      try {
        checkpoint = await this.#checkpoints.build(input.task.taskId);
      } catch {
        throw new TaskExecutorError(
          "TASK_CHECKPOINT_UNAVAILABLE",
          "The durable Task continuation checkpoint is unavailable.",
          true,
        );
      }
      if (checkpoint.taskId !== input.task.taskId) {
        throw new TaskExecutorError(
          "TASK_CHECKPOINT_MISMATCH",
          "The durable continuation checkpoint belongs to a different Task.",
        );
      }
    }
    const common = {
      requestId: `${input.turnId}:agent-turn`,
      runId: input.turnId,
      taskId: input.task.taskId,
      workstreamId: "coordinator",
      sessionKey,
      deviceId: this.#deviceId,
      prompt: input.buildPrompt(sessionAction.kind, checkpoint),
      workspace: structuredClone(this.#workspace),
      sandbox: this.#sandbox,
      permissions: structuredClone(this.#permissions),
      limits: { ...this.#limits },
      ...(modelId === undefined ? {} : { modelId }),
      ...(binding.effort === undefined ? {} : { effort: binding.effort }),
    } as const;

    let handle: AgentRunHandle;
    try {
      if (sessionAction.kind === "resume") {
        handle = await this.#adapter.resume({
          operation: "resume",
          ...common,
          session: sessionAction.session,
        });
      } else if (sessionAction.kind === "continuation") {
        handle = await this.#adapter.start({
          operation: "start",
          ...common,
          continuationOf: sessionAction.session,
          continuationReason: sessionAction.reason,
        });
      } else {
        handle = await this.#adapter.start({ operation: "start", ...common });
      }
    } catch (error) {
      throw mapAdapterFailure(error, "The Main Agent could not start.");
    }

    if (this.#active.has(input.turnId)) {
      await safeCancel(handle, "A duplicate Main Agent turn was rejected.");
      throw new TaskExecutorError(
        "EXECUTION_ALREADY_ACTIVE",
        "The Main Agent turn is already active.",
      );
    }
    this.#active.set(input.turnId, handle);
    const abort = (): void => {
      void safeCancel(handle, "The OpenDelegate Task execution was superseded.");
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) {
      abort();
    }

    try {
      const eventCompletion = this.#consumeEvents(handle, input.task.taskId, sessionKey, modelId);
      const [eventResult, result] = await Promise.allSettled([eventCompletion, handle.result]);
      if (input.signal.aborted) {
        throw new TaskExecutorError(
          "EXECUTION_CANCELLED",
          "The Main Agent execution was cancelled.",
        );
      }
      if (eventResult.status === "rejected") {
        throw new TaskExecutorError(
          "AGENT_EVENT_STREAM_FAILED",
          "The Main Agent event stream failed.",
          true,
        );
      }
      if (result.status === "rejected") {
        throw new TaskExecutorError(
          "AGENT_RESULT_FAILED",
          "The Main Agent returned no terminal result.",
          true,
        );
      }
      if (result.value.session !== undefined) {
        assertSessionBinding(result.value.session, {
          adapter: this.#adapter,
          deviceId: this.#deviceId,
          taskId: input.task.taskId,
          workspace: this.#workspace,
          sessionKey,
          modelId,
        });
        await this.#sessionRepository.save(result.value.session);
      }
      if (result.value.status !== "succeeded") {
        throw new TaskExecutorError(
          result.value.error?.code ?? "AGENT_RUN_FAILED",
          "The Main Agent did not complete its coordinator turn.",
          result.value.error?.retryable ?? result.value.status === "timed_out",
        );
      }
      if (result.value.session === undefined) {
        throw new TaskExecutorError(
          "NATIVE_SESSION_MISSING",
          "The Main Agent completed without a durable native-session reference.",
        );
      }
      return result.value.finalText;
    } catch (error) {
      if (error instanceof TaskExecutorError) {
        throw error;
      }
      throw new TaskExecutorError(
        "AGENT_EXECUTION_FAILED",
        "The Main Agent coordinator turn failed.",
        error instanceof AgentAdapterError && error.retryable,
      );
    } finally {
      input.signal.removeEventListener("abort", abort);
      this.#active.delete(input.turnId);
    }
  }

  async #resolveBindingForNewSession(): Promise<{
    readonly modelId?: string;
    readonly effort?: string;
  }> {
    if (this.#resolveNewSessionBinding === undefined) {
      return {};
    }
    let binding: { readonly modelId?: string; readonly effort?: string };
    try {
      binding = await this.#resolveNewSessionBinding();
    } catch (error) {
      if (error instanceof TaskExecutorError) {
        throw error;
      }
      throw new TaskExecutorError(
        "MAIN_AGENT_PROFILE_UNAVAILABLE",
        "The configured Coordinator Agent model is unavailable.",
        true,
      );
    }
    if (binding.modelId !== undefined && !isBoundedProfileValue(binding.modelId, 256)) {
      throw new TaskExecutorError(
        "MAIN_AGENT_PROFILE_INVALID",
        "The configured Coordinator Agent model ID is invalid.",
      );
    }
    if (binding.effort !== undefined && !isBoundedProfileValue(binding.effort, 64)) {
      throw new TaskExecutorError(
        "MAIN_AGENT_PROFILE_INVALID",
        "The configured Coordinator Agent reasoning effort is invalid.",
      );
    }
    return binding;
  }

  #enqueueTaskTurn<TResult>(
    taskId: string,
    signal: AbortSignal,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.#taskTails.get(taskId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        if (signal.aborted) {
          throw new TaskExecutorError(
            "EXECUTION_CANCELLED",
            "The Main Agent execution was cancelled before its serialized turn.",
          );
        }
        return operation();
      });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#taskTails.set(taskId, tail);
    void tail.finally(() => {
      if (this.#taskTails.get(taskId) === tail) {
        this.#taskTails.delete(taskId);
      }
    });
    return result;
  }

  async cancel(input: {
    readonly executionKey: string;
    readonly reason: "cancelled" | "coordinator-closed" | "paused" | "superseded";
  }): Promise<void> {
    const handle = this.#active.get(input.executionKey);
    if (handle !== undefined) {
      await safeCancel(handle, `OpenDelegate cancelled the coordinator turn: ${input.reason}.`);
    }
  }

  async #consumeEvents(
    handle: AgentRunHandle,
    taskId: string,
    sessionKey: string,
    modelId: string | undefined,
  ): Promise<void> {
    for await (const event of handle.events) {
      if (event.type !== "session_started") {
        continue;
      }
      assertSessionBinding(event.session, {
        adapter: this.#adapter,
        deviceId: this.#deviceId,
        taskId,
        workspace: this.#workspace,
        sessionKey,
        modelId,
      });
      await this.#sessionRepository.save(event.session);
    }
  }
}

interface ExpectedSessionBinding {
  readonly adapter: AgentAdapter;
  readonly deviceId: string;
  readonly taskId: string;
  readonly workspace: WorkspaceBinding;
  readonly sessionKey: string;
  readonly modelId: string | undefined;
}

function assertSessionBinding(
  session: NativeSessionReference,
  expected: ExpectedSessionBinding,
): void {
  const canonical = validateReference(session);
  if (
    canonical.provider !== expected.adapter.provider ||
    canonical.adapterId !== expected.adapter.adapterId ||
    canonical.deviceId !== expected.deviceId ||
    canonical.taskId !== expected.taskId ||
    canonical.workstreamId !== "coordinator" ||
    canonical.sessionKey !== expected.sessionKey ||
    canonical.workspaceId !== expected.workspace.workspaceId ||
    canonical.cwd !== expected.workspace.cwd ||
    canonical.worktreePath !== expected.workspace.worktreePath ||
    canonical.modelId !== expected.modelId
  ) {
    throw new TaskExecutorError(
      "NATIVE_SESSION_BINDING_MISMATCH",
      "The Main Agent native session does not belong to this Task and Workspace.",
    );
  }
}

const OUTCOME_ORCHESTRATION_INSTRUCTIONS = Object.freeze([
  "The owner specifies the outcome, not Device placement, by default. Treat Device, OS, route, Agent provider, and multi-Device selection as internal orchestration when capability requirements and deterministic scheduling can decide.",
  "Ask about placement only when it changes an owner-visible outcome or an unavailable durable preference, such as privacy or data locality, cost, a physical or interactive screen, licensed software, or where a result must remain.",
  "Infer the required capabilities and OS constraints from the objective, express them in Work Orders when planning, and let OpenDelegate select the actual Devices and routes.",
  "Ask the owner only about a choice that changes the intended outcome or Policy, or an irreducible human action.",
  "If login, MFA, CAPTCHA, legal confirmation, or OS permission requires the owner, return waiting_user with one clear question. Refer to an existing OpenDelegate interactive Artifact action when one is available, never invent a handoff URL or put a credential in chat, and continue this same Task after the owner replies.",
]);

const OUTCOME_PRESENTATION_INSTRUCTION =
  "Present the verified outcome in the most useful available form: Discord summary, file, Artifact, hosted result, or Git reference. Mention only results supported by authoritative Worker reports.";

const ARTIFACT_PLANNING_INSTRUCTIONS = Object.freeze([
  "A Worker Agent may write and commit a Run-scoped Artifact manifest, but deterministic Worker code performs Main promotion only after that native turn succeeds.",
  "Do not require Worker-authored text to attest post-turn Main promotion or Discord presentation. Plan the file creation and manifest commit; OpenDelegate records promoted Artifact IDs in the authenticated terminal evidence and the Discord adapter presents available results afterward.",
]);

const ARTIFACT_VERIFICATION_INSTRUCTIONS = Object.freeze([
  "Each entry in an authoritative report's artifactEvidence array is deterministic post-turn evidence that the named Artifact reached Main's durable store. Its state \"promoted-to-main-durable-store\" is stronger than Worker-authored report text written before promotion.",
  "Do not treat a Worker report's uncertainty about later Main promotion or Discord presentation as contradicting non-empty artifactEvidence. When the Task asks to return a file in this Task, promoted Artifact evidence satisfies the delivery boundary; the Discord adapter owns its subsequent owner-visible presentation.",
]);

function buildCoordinatorPrompt(
  request: TaskExecutionRequest,
  maximumBytes: number,
  sessionAction: "start" | "resume" | "continuation",
  checkpoint?: TaskContinuationCheckpointV1,
): string {
  if (sessionAction === "continuation") {
    return buildCheckpointPrompt({
      role: "coordinator",
      maximumBytes,
      checkpoint: requireContinuationCheckpoint(checkpoint, request.task.taskId),
      instructions: [
        "You are the OpenDelegate Main Agent continuing exactly one durable Task after its provider-native session became unavailable.",
        "The versioned, hash-verified public checkpoint below is the only prior Task context. Keep it isolated from every other Task.",
        "Worker Run reports remain the only authority for execution side effects. Never infer a side effect from an omitted checkpoint item.",
        ...OUTCOME_ORCHESTRATION_INSTRUCTIONS,
        OUTCOME_PRESENTATION_INSTRUCTION,
        "Do not expose private chain-of-thought. Return one exact JSON object and no Markdown fence.",
        'Return either {"schemaVersion":1,"state":"waiting_user","ownerQuestion":"one targeted question ending in ?"} or {"schemaVersion":1,"state":"waiting_resource|review|failed","publicMessage":"owner-visible text"}.',
        "waiting_user must contain exactly one concise question, not a checklist or multiple questions.",
        "Use review when authoritative evidence still needs deterministic reconciliation. This coordinator turn cannot complete the Task.",
        `Attempt: ${String(request.attempt)}`,
      ],
    });
  }
  const task = request.task;
  const prefix = [
    "You are the OpenDelegate Main Agent for exactly one durable Task.",
    "Keep this Task isolated from every unrelated Task. You may plan and synthesize, but deterministic OpenDelegate modules own dispatch, policy, routes, leases, and durable state.",
    "Worker Run reports are the only authority for execution side effects. Never claim that a Work Order, Run, artifact, command, or external action completed from your own text.",
    ...OUTCOME_ORCHESTRATION_INSTRUCTIONS,
    OUTCOME_PRESENTATION_INSTRUCTION,
    "Do not expose private chain-of-thought. Return one exact JSON object and no Markdown fence.",
    'Return either {"schemaVersion":1,"state":"waiting_user","ownerQuestion":"one targeted question ending in ?"} or {"schemaVersion":1,"state":"waiting_resource|review|failed","publicMessage":"owner-visible text"}.',
    "waiting_user must contain exactly one concise question, not a checklist or multiple questions.",
    "Use review when authoritative evidence still needs deterministic reconciliation. This coordinator turn cannot complete the Task.",
    "",
    `Task ID: ${task.taskId}`,
    `Attempt: ${request.attempt}`,
    `Objective: ${task.objective}`,
    "Completion criteria:",
    ...task.completionCriteria.map((criterion) => `- ${criterion}`),
    "Constraints:",
    ...(task.constraints.length === 0
      ? ["- None."]
      : task.constraints.map((constraint) => `- ${constraint}`)),
    "Selected input references:",
    ...(task.selectedInputRefs.length === 0
      ? ["- None."]
      : task.selectedInputRefs.map((reference) => `- ${reference}`)),
    "",
    "Newest durable public conversation:",
  ].join("\n");
  const suffix = "\n\nReturn the exact JSON object now.";
  if (Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8") > maximumBytes) {
    throw new TaskExecutorError(
      "TASK_PROMPT_TOO_LARGE",
      "The Task brief exceeds the configured Main Agent prompt budget.",
    );
  }

  const messages =
    sessionAction === "resume" ? messagesAfterLastAgent(task.messages) : task.messages;
  const selected: string[] = [];
  let bytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  for (const message of [...messages].reverse()) {
    const line = `\n[${message.role}] ${message.content}`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes > maximumBytes) {
      break;
    }
    selected.unshift(line);
    bytes += lineBytes;
  }
  return `${prefix}${selected.join("")}${suffix}`;
}

function buildPlanningPrompt(
  task: TaskExecutionRequest["task"],
  attempt: number,
  maximumBytes: number,
  sessionAction: "start" | "resume" | "continuation",
  checkpoint?: TaskContinuationCheckpointV1,
  deviceContext?: readonly PlanningDeviceObservation[],
): string {
  if (sessionAction === "continuation") {
    return buildCheckpointPrompt({
      role: "planning",
      maximumBytes,
      checkpoint: requireContinuationCheckpoint(checkpoint, task.taskId),
      instructions: [
        "You are the OpenDelegate Main Agent continuing planning for exactly one durable Task after its provider-native session became unavailable.",
        "Use only the versioned, hash-verified public checkpoint below. Omitted counts are explicit; do not invent omitted details or import another Task's context.",
        "Deterministic OpenDelegate code validates dependencies, selects eligible Devices, issues authority, dispatches Runs, and enforces Policy.",
        ...OUTCOME_ORCHESTRATION_INSTRUCTIONS,
        ...ARTIFACT_PLANNING_INSTRUCTIONS,
        "Do not claim execution happened. Do not expose private chain-of-thought.",
        ...planningContextInstructions(deviceContext),
        "Return one exact JSON object and no Markdown fence.",
        'Either {"schemaVersion":1,"state":"waiting_user","ownerQuestion":"one targeted question ending in ?"}, {"schemaVersion":1,"state":"waiting_resource|failed","publicMessage":"owner-visible text"},',
        'or {"schemaVersion":1,"state":"ready","plan":{"protocolVersion":"v1","taskId":"...","workOrders":[{"protocolVersion":"v1","workOrderId":"plan-local unique label","title":"...","brief":"...","completionCriteria":["..."],"constraints":["..."],"selectedInputIds":["..."],"dependsOn":["plan-local workOrderId"],"schedulingHints":{"preferredDeviceIds":["..."],"preferredRoles":["..."]},"requiredCapabilities":["..."],"requiredSecretRefs":[],"requiredAgent":{"provider":"codex|claude|generic","adapterId":"optional exact adapter","modelId":"optional exact provider-native model","allowedCompatibilities":["tested|compatible|untested"]},"requiredOsFamily":"macos|windows|linux (optional)","workspaceId":"optional"}]}}.',
        "Every Work Order must include requiredSecretRefs. Use [] when no credential is needed; OpenDelegate never infers credential authority.",
        'requiredCapabilities is an execution-authority gate, not descriptive metadata. If a Work Order must invoke Computer Use, include the exact capability "computer-use" even when no current Device advertises it; never hide a required capability to make a Device eligible.',
        "Never return completed from semantic planning. Deterministic OpenDelegate code handles the narrow Main-owned read-only query path before this turn. Every remaining completion requires a Work Order and authoritative Worker evidence.",
        "A continuation checkpoint never carries Secret references. If a Work Order needs one, return waiting_user so deterministic configuration can bind it without exposing a credential.",
        "waiting_user must contain exactly one concise question, not a checklist or multiple questions.",
        `Attempt: ${String(attempt)}`,
      ],
    });
  }
  const prefix = [
    "You are the OpenDelegate Main Agent planning exactly one durable Task.",
    "Return a bounded Work Order plan. Deterministic OpenDelegate code will validate dependencies, select eligible Devices, issue leases, dispatch Runs, and enforce Policy.",
    ...OUTCOME_ORCHESTRATION_INSTRUCTIONS,
    ...ARTIFACT_PLANNING_INSTRUCTIONS,
    "Do not claim any execution happened. Do not expose private chain-of-thought.",
    ...planningContextInstructions(deviceContext),
    "Return one exact JSON object and no Markdown fence.",
    'Either {"schemaVersion":1,"state":"waiting_user","ownerQuestion":"one targeted question ending in ?"}, {"schemaVersion":1,"state":"waiting_resource|failed","publicMessage":"owner-visible text"},',
    'or {"schemaVersion":1,"state":"ready","plan":{"protocolVersion":"v1","taskId":"...","workOrders":[{"protocolVersion":"v1","workOrderId":"plan-local unique label","title":"...","brief":"...","completionCriteria":["..."],"constraints":["..."],"selectedInputIds":["..."],"dependsOn":["plan-local workOrderId"],"schedulingHints":{"preferredDeviceIds":["..."],"preferredRoles":["..."]},"requiredCapabilities":["..."],"requiredSecretRefs":["..."],"requiredAgent":{"provider":"codex|claude|generic","adapterId":"optional exact adapter","modelId":"optional exact provider-native model","allowedCompatibilities":["tested|compatible|untested"]},"requiredOsFamily":"macos|windows|linux (optional)","workspaceId":"optional"}]}}. Omit requiredAgent when the Device profile may choose any ready binding; when present, use only an outcome-relevant hard requirement and tested-only is the default if allowedCompatibilities is omitted.',
    "Every Work Order must include requiredSecretRefs. Use [] when no credential is needed; OpenDelegate never infers credential authority.",
    'requiredCapabilities is an execution-authority gate, not descriptive metadata. If a Work Order must invoke Computer Use, include the exact capability "computer-use" even when no current Device advertises it; never hide a required capability to make a Device eligible.',
    "Never return completed from semantic planning. Deterministic OpenDelegate code handles the narrow Main-owned read-only query path before this turn. Every remaining completion requires a Work Order and authoritative Worker evidence.",
    "Use unique plan-local Work Order labels and explicit completion criteria. OpenDelegate assigns durable owner-cycle-scoped IDs and remaps dependencies deterministically. Keep independent work parallel by leaving dependsOn empty; add dependencies only when evidence must flow between Work Orders.",
    "waiting_user must contain exactly one concise question, not a checklist or multiple questions.",
    "",
    `Task ID: ${task.taskId}`,
    `Attempt: ${String(attempt)}`,
    `Objective: ${task.objective}`,
    "Completion criteria:",
    ...task.completionCriteria.map((criterion) => `- ${criterion}`),
    "Constraints:",
    ...(task.constraints.length === 0
      ? ["- None."]
      : task.constraints.map((constraint) => `- ${constraint}`)),
    "Selected input references:",
    ...(task.selectedInputRefs.length === 0
      ? ["- None."]
      : task.selectedInputRefs.map((reference) => `- ${reference}`)),
    "",
    "Newest durable public conversation:",
  ].join("\n");
  const suffix = "\n\nReturn the exact JSON object now.";
  return appendTaskMessagesWithinBudget({
    prefix,
    suffix,
    messages: sessionAction === "resume" ? messagesAfterLastAgent(task.messages) : task.messages,
    maximumBytes,
    failureMessage: "The Task planning package exceeds the configured Main Agent prompt budget.",
  });
}

function buildVerificationPrompt(
  task: TaskExecutionRequest["task"],
  workOrders: Parameters<TaskEvidenceVerifier["verify"]>[0]["workOrders"],
  reports: readonly AuthoritativeWorkerReport[],
  maximumBytes: number,
  sessionAction: "start" | "resume" | "continuation",
  checkpoint?: TaskContinuationCheckpointV1,
): string {
  const evidence = reports.map((report) => ({
    taskId: report.taskId,
    workOrderId: report.workOrderId,
    deviceId: report.deviceId,
    workerId: report.workerId,
    runId: report.runId,
    report: boundedContinuationEvidence(report.report),
    artifactIds: report.artifactIds,
    artifactEvidence: report.artifactIds.map((artifactId) => ({
      artifactId,
      state: "promoted-to-main-durable-store" as const,
      source: "deterministic-worker-terminal-event" as const,
    })),
    ...(report.agentSession === undefined ? {} : { agentSession: report.agentSession }),
  }));
  const orders = workOrders.map((order) => ({
    workOrderId: order.workOrderId,
    title: order.title,
    brief: order.brief,
    completionCriteria: order.completionCriteria,
  }));
  if (sessionAction === "continuation") {
    const publicCheckpoint = requireContinuationCheckpoint(checkpoint, task.taskId);
    const prompt = [
      "You are the OpenDelegate Main Agent continuing verification for exactly one durable Task after its provider-native session became unavailable.",
      "The versioned, hash-verified public checkpoint is the only prior Task context. The bounded Worker evidence below was accepted from durable authenticated Run events.",
      "Lease, fencing, route, credential, local-path, Knowledge, and private transcript data are intentionally absent.",
      "Judge only whether the evidence satisfies every exact completion criterion in the checkpoint. Never invent omitted evidence.",
      ...OUTCOME_ORCHESTRATION_INSTRUCTIONS,
      ...ARTIFACT_VERIFICATION_INSTRUCTIONS,
      OUTCOME_PRESENTATION_INSTRUCTION,
      "Return one exact JSON object and no Markdown fence.",
      'If every criterion is satisfied: {"schemaVersion":1,"state":"completed","publicMessage":"owner-visible synthesis","verifiedCompletionCriteria":["copy every exact Task criterion"]}.',
      'Otherwise return either {"schemaVersion":1,"state":"waiting_user","ownerQuestion":"one targeted question ending in ?"} or {"schemaVersion":1,"state":"review|waiting_resource|failed","publicMessage":"owner-visible gap"}.',
      "waiting_user must contain exactly one concise question, not a checklist or multiple questions.",
      "",
      `Checkpoint JSON: ${serializeTaskContinuationCheckpoint(publicCheckpoint)}`,
      `Current authoritative Worker evidence JSON: ${JSON.stringify(evidence)}`,
      "",
      "Return the exact JSON object now.",
    ].join("\n");
    if (Buffer.byteLength(prompt, "utf8") > maximumBytes) {
      throw new TaskExecutorError(
        "TASK_PROMPT_TOO_LARGE",
        "The checkpoint and authoritative Worker evidence exceed the Main Agent prompt budget.",
      );
    }
    return prompt;
  }
  const prompt = [
    "You are the OpenDelegate Main Agent verifying exactly one durable Task.",
    "Every record below was accepted by deterministic OpenDelegate code from the authenticated, current, unexpired Worker Run named in that record.",
    "You cannot manufacture, alter, or infer execution evidence. Judge only whether these authoritative reports satisfy every exact Task completion criterion.",
    ...OUTCOME_ORCHESTRATION_INSTRUCTIONS,
    ...ARTIFACT_VERIFICATION_INSTRUCTIONS,
    OUTCOME_PRESENTATION_INSTRUCTION,
    "Return one exact JSON object and no Markdown fence.",
    'If every criterion is satisfied: {"schemaVersion":1,"state":"completed","publicMessage":"owner-visible synthesis","verifiedCompletionCriteria":["copy every exact Task criterion"]}.',
    'Otherwise return either {"schemaVersion":1,"state":"waiting_user","ownerQuestion":"one targeted question ending in ?"} or {"schemaVersion":1,"state":"review|waiting_resource|failed","publicMessage":"owner-visible gap"}.',
    "waiting_user must contain exactly one concise question, not a checklist or multiple questions.",
    "",
    `Task ID: ${task.taskId}`,
    `Objective: ${task.objective}`,
    `Exact completion criteria JSON: ${JSON.stringify(task.completionCriteria)}`,
    `Constraints JSON: ${JSON.stringify(task.constraints)}`,
    `Work Orders JSON: ${JSON.stringify(orders)}`,
    `Authoritative Worker reports JSON: ${JSON.stringify(evidence)}`,
    "",
    "Return the exact JSON object now.",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > maximumBytes) {
    throw new TaskExecutorError(
      "TASK_PROMPT_TOO_LARGE",
      "The authoritative Worker evidence exceeds the configured Main Agent prompt budget.",
    );
  }
  return prompt;
}

function appendTaskMessagesWithinBudget(input: {
  readonly prefix: string;
  readonly suffix: string;
  readonly messages: readonly TaskExecutionRequest["task"]["messages"][number][];
  readonly maximumBytes: number;
  readonly failureMessage: string;
}): string {
  const fixedBytes =
    Buffer.byteLength(input.prefix, "utf8") + Buffer.byteLength(input.suffix, "utf8");
  if (fixedBytes > input.maximumBytes) {
    throw new TaskExecutorError("TASK_PROMPT_TOO_LARGE", input.failureMessage);
  }
  const selected: string[] = [];
  let bytes = fixedBytes;
  for (const message of [...input.messages].reverse()) {
    const line = `\n[${message.role}] ${message.content}`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes > input.maximumBytes) {
      break;
    }
    selected.unshift(line);
    bytes += lineBytes;
  }
  return `${input.prefix}${selected.join("")}${input.suffix}`;
}

function buildCheckpointPrompt(input: {
  readonly role: "coordinator" | "planning";
  readonly maximumBytes: number;
  readonly checkpoint: TaskContinuationCheckpointV1;
  readonly instructions: readonly string[];
}): string {
  const prompt = [
    ...input.instructions,
    "",
    "Durable checkpoint continuation package:",
    serializeTaskContinuationCheckpoint(input.checkpoint),
    "",
    input.role === "planning"
      ? "Return the exact planning JSON object now."
      : "Return the exact coordinator JSON object now.",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > input.maximumBytes) {
    throw new TaskExecutorError(
      "TASK_PROMPT_TOO_LARGE",
      "The durable Task continuation checkpoint exceeds the Main Agent prompt budget.",
    );
  }
  return prompt;
}

function requireContinuationCheckpoint(
  checkpoint: TaskContinuationCheckpointV1 | undefined,
  taskId: string,
): TaskContinuationCheckpointV1 {
  if (checkpoint === undefined || checkpoint.taskId !== taskId) {
    throw new TaskExecutorError(
      "TASK_CHECKPOINT_MISMATCH",
      "The Main Agent continuation checkpoint does not match this Task.",
    );
  }
  return checkpoint;
}

function boundedContinuationEvidence(input: string): string {
  const sanitized = sanitizeTaskContinuationText(input).trim();
  if (sanitized.length === 0) {
    return "[redacted public Worker report]";
  }
  const maximumBytes = 8_192;
  if (Buffer.byteLength(sanitized, "utf8") <= maximumBytes) {
    return sanitized;
  }
  const suffix = "…";
  const available = maximumBytes - Buffer.byteLength(suffix, "utf8");
  let output = "";
  let bytes = 0;
  for (const character of sanitized) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > available) {
      break;
    }
    output += character;
    bytes += next;
  }
  return `${output.trimEnd()}${suffix}`;
}

type NativeSessionAction =
  | {
      readonly kind: "start";
    }
  | {
      readonly kind: "resume";
      readonly session: NativeSessionReference;
    }
  | {
      readonly kind: "continuation";
      readonly session: NativeSessionReference;
      readonly reason: "native-session-resume-unavailable";
    };

async function resolveNativeSessionAction(
  adapter: AgentAdapter,
  session: NativeSessionReference,
): Promise<NativeSessionAction> {
  let probe;
  try {
    probe = await adapter.probe();
  } catch {
    throw new TaskExecutorError(
      "AGENT_READINESS_FAILED",
      "The Main Agent readiness probe failed before native-session recovery.",
      true,
    );
  }
  if (
    probe.contractVersion !== 1 ||
    probe.adapterId !== adapter.adapterId ||
    probe.provider !== adapter.provider
  ) {
    throw new TaskExecutorError(
      "AGENT_IDENTITY_MISMATCH",
      "The Main Agent readiness result does not match the configured adapter.",
    );
  }
  const ready =
    probe.installed &&
    probe.version !== undefined &&
    (probe.auth.state === "ready" || probe.auth.state === "not_required");
  if (ready && probe.version === session.adapterVersion && probe.capabilities.resume) {
    return {
      kind: "resume",
      session,
    };
  }
  if (ready && probe.capabilities.start && probe.capabilities.checkpointContinuation) {
    return {
      kind: "continuation",
      session,
      reason: "native-session-resume-unavailable",
    };
  }
  throw new TaskExecutorError(
    "NATIVE_SESSION_RESUME_UNAVAILABLE",
    "The Main Agent cannot safely resume or continue the persisted native session.",
    true,
  );
}

function parsePlanningResult(
  value: string | undefined,
  task: TaskExecutionRequest["task"],
  planningKey: string,
): TaskWorkPlanDecision {
  const parsed = parseAgentJson(value, "WORK_PLAN_INVALID");
  if (parsed["schemaVersion"] !== 1 || typeof parsed["state"] !== "string") {
    throw invalidWorkPlan();
  }
  if (
    parsed["state"] === "waiting_user" &&
    hasExactKeys(parsed, ["schemaVersion", "state", "ownerQuestion"])
  ) {
    return {
      state: "waiting_user",
      publicMessage: readAgentOwnerQuestion(parsed["ownerQuestion"], invalidWorkPlan),
    };
  }
  if (
    (parsed["state"] === "waiting_resource" || parsed["state"] === "failed") &&
    hasExactKeys(parsed, ["schemaVersion", "state", "publicMessage"])
  ) {
    return {
      state: parsed["state"],
      publicMessage: readAgentPublicMessage(parsed["publicMessage"], invalidWorkPlan),
    };
  }
  if (
    parsed["state"] === "ready" &&
    hasExactKeys(parsed, ["schemaVersion", "state", "plan"]) &&
    isRecord(parsed["plan"]) &&
    parsed["plan"]["protocolVersion"] === "v1" &&
    parsed["plan"]["taskId"] === task.taskId &&
    Array.isArray(parsed["plan"]["workOrders"])
  ) {
    type ReadyPlan = Extract<TaskWorkPlanDecision, { readonly state: "ready" }>["plan"];
    const plan = structuredClone(
      applyAuthorityReducingPlanningDefaults(parsed["plan"]),
    ) as unknown as ReadyPlan;
    requireDeclaredComputerUseAuthority(plan);
    return {
      state: "ready",
      plan: scopePlanningWorkOrderIds(plan, planningKey),
    };
  }
  throw invalidWorkPlan();
}

/**
 * Computer Use is exposed to a Worker only when the immutable Work Order asks
 * for its exact capability. A semantic planner may describe the action while
 * accidentally omitting that authority gate; accepting such a plan would run
 * an Agent without the requested tool and can leave the Run waiting for an
 * impossible action. Reject the inconsistent plan instead of silently adding
 * authority or dispatching a misleading Work Order.
 */
function requireDeclaredComputerUseAuthority(
  plan: Extract<TaskWorkPlanDecision, { readonly state: "ready" }>["plan"],
): void {
  for (const workOrder of plan.workOrders) {
    if (
      workOrderRequiresComputerUse(workOrder) &&
      !workOrder.requiredCapabilities.includes("computer-use")
    ) {
      throw invalidWorkPlan();
    }
  }
}

function workOrderRequiresComputerUse(
  workOrder: Extract<
    TaskWorkPlanDecision,
    { readonly state: "ready" }
  >["plan"]["workOrders"][number],
): boolean {
  const statements = [workOrder.brief, ...workOrder.completionCriteria, ...workOrder.constraints];
  return statements.some(statementRequiresComputerUse);
}

/**
 * Detect an affirmative Computer Use requirement without promoting an explicit
 * prohibition into input authority. Coordinator constraints commonly enumerate
 * several forbidden tools in one sentence (for example, "Computer Use, browser,
 * and network access are forbidden" or "Computer Use ... 사용하지 않는다"). A
 * keyword-only matcher interpreted both forms as a request to control the desktop.
 */
function statementRequiresComputerUse(statement: string): boolean {
  const normalized = statement.normalize("NFKC");

  for (const match of normalized.matchAll(
    /\b(?:invoke|use|execute|perform|run|require)\b.{0,48}\bcomputer[ -]use\b/giu,
  )) {
    const leading = normalized.slice(Math.max(0, (match.index ?? 0) - 24), match.index);
    if (
      !/(?:\bdo\s+not|\bdon't|\bnever|\bmust\s+not|\bmay\s+not|\bwithout|\bno)\s*$/iu.test(leading)
    ) {
      return true;
    }
  }

  if (
    /\bcomputer[ -]use\b\s+(?:(?:is|must\s+be|should\s+be|will\s+be)\s+)?(?:invoked|used|executed|required|performed)\b/iu.test(
      normalized,
    )
  ) {
    return true;
  }

  for (const match of normalized.matchAll(/computer[ -]use.{0,48}?(?:사용|실행|호출|조작)/giu)) {
    const trailing = normalized.slice((match.index ?? 0) + match[0].length);
    if (!/^(?:하지|해서는?\s*안|하면\s*안|해서\s*안|할\s+수\s+없)/u.test(trailing)) {
      return true;
    }
  }

  if (
    /(?:\b(?:do\s+not|don't|never|must\s+not|may\s+not|no)\s+(?:invoke|use|execute|perform|run|require)\s+(?:the\s+)?computer[ -]use\b|\bwithout\s+(?:using\s+)?computer[ -]use\b|\bcomputer[ -]use\b.{0,72}\b(?:(?:must|should|may)\s+(?:not|never)\s+(?:be\s+)?(?:invoked|used|executed|required|performed)|(?:is|are)\s+(?:not\s+(?:invoked|used|executed|required|performed)|(?:strictly\s+)?(?:forbidden|prohibited|disallowed|not\s+allowed)))\b)/iu.test(
      normalized,
    ) ||
    /(?:computer[ -]use.{0,72}(?:(?:사용|실행|호출|조작)(?:하지\s*(?:마|않|못)|해서는?\s*안|하면\s*안|해서\s*안|할\s+수\s+없)|금지|제외|불가)|computer[ -]use\s*없이)/iu.test(
      normalized,
    )
  ) {
    return false;
  }

  return (
    /(?:\b(?:invoke|use|execute|perform|run|require)\b.{0,48}\bcomputer[ -]use\b|\bcomputer[ -]use\b.{0,48}\b(?:is\s+)?(?:invoked|used|executed|required|performed)\b)/iu.test(
      normalized,
    ) ||
    /(?:computer[ -]use.{0,48}(?:사용|실행|호출|조작)|(?:사용|실행|호출|조작).{0,48}computer[ -]use)/iu.test(
      normalized,
    )
  );
}

function applyAuthorityReducingPlanningDefaults(plan: Record<string, unknown>): unknown {
  const workOrders = plan["workOrders"];
  if (!Array.isArray(workOrders)) {
    return plan;
  }
  return {
    ...plan,
    workOrders: workOrders.map((workOrder) => {
      if (!isRecord(workOrder) || workOrder["requiredSecretRefs"] !== undefined) {
        return workOrder;
      }
      return {
        ...workOrder,
        requiredSecretRefs: [],
      };
    }),
  };
}

function scopePlanningWorkOrderIds<
  T extends Extract<TaskWorkPlanDecision, { readonly state: "ready" }>["plan"],
>(plan: T, planningKey: string): T {
  const rawIds: string[] = [];
  for (const workOrder of plan.workOrders) {
    if (
      !isRecord(workOrder) ||
      typeof workOrder["workOrderId"] !== "string" ||
      !Array.isArray(workOrder["dependsOn"]) ||
      !workOrder["dependsOn"].every((dependency) => typeof dependency === "string")
    ) {
      return plan;
    }
    rawIds.push(workOrder["workOrderId"]);
  }
  if (new Set(rawIds).size !== rawIds.length) {
    return plan;
  }
  const scope = digest(`work-order-cycle-v1\0${planningKey}`).slice(7, 23);
  const scopedByRawId = new Map(
    rawIds.map((rawId, index) => [rawId, `work_${scope}_${String(index + 1).padStart(3, "0")}`]),
  );
  return {
    ...plan,
    workOrders: plan.workOrders.map((workOrder) => ({
      ...workOrder,
      workOrderId: scopedByRawId.get(workOrder.workOrderId) ?? workOrder.workOrderId,
      dependsOn: workOrder.dependsOn.map(
        (dependency) => scopedByRawId.get(dependency) ?? dependency,
      ),
    })),
  };
}

interface PlanningDeviceObservation {
  readonly deviceId: string;
  readonly name: string;
  readonly osFamily: DeviceSummaryV1["osFamily"];
  readonly role: DeviceSummaryV1["role"];
  readonly connection: DeviceSummaryV1["connection"];
  readonly runtime: DeviceSummaryV1["runtime"];
  readonly serviceMode: DeviceSummaryV1["serviceMode"];
  readonly lastObservation?: DeviceSummaryV1["lastObservation"];
  readonly roles: readonly string[];
  readonly capabilities: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly readyAgentAdapters: readonly {
    readonly provider: string;
    readonly adapterId: string;
  }[];
  readonly workerAgentProfile?: DeviceSummaryV1["agentExecutionProfile"];
  readonly wakeOnLan?: {
    readonly targetState: NonNullable<DeviceSummaryV1["wakeOnLan"]>["targetState"];
    readonly automaticWakeState: NonNullable<DeviceSummaryV1["wakeOnLan"]>["automaticWakeState"];
    readonly observedAtMs: number;
  };
  readonly routes: readonly {
    readonly label: string;
    readonly health: string;
  }[];
  readonly activeRuns: number;
  readonly maximumConcurrentRuns?: number;
  readonly acceptingWork?: boolean;
}

function projectPlanningDeviceContext(
  devices: readonly DeviceSummaryV1[],
): readonly PlanningDeviceObservation[] {
  if (!Array.isArray(devices) || devices.length > 256) {
    throw new TaskExecutorError(
      "MAIN_CONTEXT_INVALID",
      "The Main-owned Device directory returned invalid state.",
    );
  }
  const seen = new Set<string>();
  const projected = devices.map((device) => {
    if (
      device === null ||
      typeof device !== "object" ||
      typeof device.deviceId !== "string" ||
      device.deviceId.length === 0 ||
      seen.has(device.deviceId)
    ) {
      throw new TaskExecutorError(
        "MAIN_CONTEXT_INVALID",
        "The Main-owned Device directory returned invalid state.",
      );
    }
    seen.add(device.deviceId);
    return Object.freeze({
      deviceId: device.deviceId,
      name: device.name,
      osFamily: device.osFamily,
      role: device.role,
      connection: device.connection,
      runtime: device.runtime,
      serviceMode: device.serviceMode,
      ...(device.lastObservation === undefined
        ? {}
        : { lastObservation: Object.freeze({ ...device.lastObservation }) }),
      roles: Object.freeze([...(device.roles ?? [])]),
      capabilities: Object.freeze(
        (device.capabilities ?? [])
          .filter(
            (capability: NonNullable<DeviceSummaryV1["capabilities"]>[number]) =>
              capability.verification === "verified",
          )
          .map(
            (capability: NonNullable<DeviceSummaryV1["capabilities"]>[number]) => capability.name,
          ),
      ),
      workspaceIds: Object.freeze([...(device.workspaceIds ?? [])]),
      readyAgentAdapters: Object.freeze(
        (device.agentAdapters ?? [])
          .filter(
            (adapter: NonNullable<DeviceSummaryV1["agentAdapters"]>[number]) =>
              adapter.readiness === "ready",
          )
          .map((adapter: NonNullable<DeviceSummaryV1["agentAdapters"]>[number]) =>
            Object.freeze({
              provider: adapter.provider,
              adapterId: adapter.adapterId,
            }),
          ),
      ),
      ...(device.agentExecutionProfile === undefined
        ? {}
        : { workerAgentProfile: structuredClone(device.agentExecutionProfile) }),
      ...(device.role !== "worker" || device.wakeOnLan === undefined
        ? {}
        : {
            wakeOnLan: Object.freeze({
              targetState: device.wakeOnLan.targetState,
              automaticWakeState: device.wakeOnLan.automaticWakeState,
              observedAtMs: device.wakeOnLan.observedAtMs,
            }),
          }),
      routes: Object.freeze(
        (device.routes ?? []).map((route: NonNullable<DeviceSummaryV1["routes"]>[number]) =>
          Object.freeze({ label: route.label, health: route.health }),
        ),
      ),
      activeRuns: device.capacity?.activeRuns ?? device.currentRuns?.length ?? 0,
      ...(device.capacity === undefined
        ? {}
        : {
            maximumConcurrentRuns: device.capacity.maximumConcurrentRuns,
            acceptingWork: device.capacity.acceptingWork,
          }),
    });
  });
  return Object.freeze(projected);
}

function planningContextInstructions(
  devices: readonly PlanningDeviceObservation[] | undefined,
): readonly string[] {
  if (devices === undefined) {
    return Object.freeze([
      "Main-owned orchestration context is unavailable. Do not invent Device state.",
    ]);
  }
  return Object.freeze([
    "The following JSON is a current, bounded, Main-owned, owner-safe Device snapshot for planning target preferences. Only verified capability names are included:",
    "Workspace IDs are opaque registered execution roots. Set workspaceId when an outcome requires a specific Workspace. When a Device has exactly one registered Workspace, OpenDelegate can select that singleton deterministically if workspaceId is omitted; multiple Workspaces require an explicit choice.",
    "For an offline Worker, wakeOnLan is its last authenticated target observation. relay-required means the target reported magic-packet wake enabled, but OpenDelegate has no verified online relay and must not claim that it can wake the Device.",
    JSON.stringify({ schemaVersion: 1, devices }),
  ]);
}

type DeviceDirectoryQueryLocale = "en" | "fr" | "ja" | "ko" | "es" | "zh";

interface DeviceDirectoryQuestion {
  readonly locale: DeviceDirectoryQueryLocale;
  readonly target?: string;
  readonly route?: string;
}

const DEVICE_DIRECTORY_QUERY_PATTERNS: Readonly<
  Record<DeviceDirectoryQueryLocale, readonly RegExp[]>
> = Object.freeze({
  en: Object.freeze([
    /^(?:(?:which|what)\s+(?:devices?|computers?|machines?)\s+(?:are\s+)?(?:currently\s+)?(?:available|online|reachable|connected|registered)(?:\s+(?:right\s+now|now))?|what\s+(?:devices?|computers?|machines?)\s+can\s+(?:i|you|opendelegate)\s+(?:reach|access|use)(?:\s+(?:right\s+now|now))?)[?!.]*$/iu,
    /^(?:show|list|tell\s+me|give\s+me)\s+(?:the\s+)?(?:current\s+)?(?:(?:available|online|reachable|connected|registered)\s+)?(?:devices?|computers?|machines?)(?:\s+(?:list|status|roles?|capabilities|routes?|operating\s+systems?))?[?!.]*$/iu,
  ]),
  fr: Object.freeze([
    /^(?:quels?|quelles?)\s+(?:appareils?|ordinateurs?|machines?)\s+(?:sont\s+)?(?:actuellement\s+)?(?:disponibles?|en\s+ligne|accessibles?|connect[eé]s?)[ ?!.]*$/iu,
  ]),
  ja: Object.freeze([
    /^(?:現在|今)(?:接続可能な|オンラインの|利用可能な|登録済みの)?(?:デバイス|端末|コンピュータ(?:ー)?)(?:は)?(?:何|どれ|どのようなもの)(?:がありますか|ですか)?[？?！!.]*$/u,
    /^(?:現在|今)の?(?:接続可能な|オンラインの|利用可能な|登録済みの)?(?:デバイス|端末|コンピュータ(?:ー)?)の?(?:一覧|状態)を?(?:見せて|教えてください|教えて)[？?！!.]*$/u,
  ]),
  ko: Object.freeze([
    /^(?:(?:지금|현재)\s*)?(?:(?:접속|연결|사용)\s*)?(?:(?:가능한|가능|된|되어\s*있는|중인|온라인인)\s*)?(?:디바이스|기기|장치|컴퓨터)(?:가|는|들이|들은)?\s*(?:뭐뭐가?|뭐가|무엇(?:이|인가요?)?|어떤(?:\s*것들이?|\s*게)?|몇\s*대)(?:\s*(?:있어(?:요)?|있나(?:요)?|있습니까|인가요?|야))?[?!.~]*$/u,
    /^(?:(?:지금|현재)\s*)?(?:(?:접속\s*가능한|연결된|온라인인|등록된)\s*)?(?:디바이스|기기|장치|컴퓨터)(?:들)?(?:의|을|를)?\s*(?:목록|상태)?(?:을|를)?\s*(?:다시\s*)?(?:알려\s*줘|보여\s*줘|말해\s*줘|나열해\s*줘)(?:요)?[?!.~]*$/u,
    /^(?:(?:지금|현재)\s*)?(?:(?:접속|연결|사용)\s*가능(?:하고|하며)?\s*|온라인(?:이고|이며)\s*)?(?:작업(?:을)?\s*(?:받을|수행할)\s*수\s*있는\s*)?(?:디바이스|기기|장치|컴퓨터)(?:들)?(?:의|을|를)?\s*(?:(?:os|운영\s*체제)(?:와|과|,)?\s*)?(?:(?:검증된\s*)?(?:주요\s*)?(?:capabilit(?:y|ies)|기능|역할)(?:만)?\s*)?(?:간단히\s*)?(?:다시\s*)?(?:알려\s*줘|보여\s*줘|말해\s*줘|나열해\s*줘)(?:요)?[?!.~]*$/iu,
  ]),
  es: Object.freeze([
    /^(?:qu[eé]|cu[aá]les)\s+(?:dispositivos?|ordenadores?|computadoras?|m[aá]quinas?)\s+(?:est[aá]n\s+)?(?:actualmente\s+)?(?:disponibles?|en\s+l[ií]nea|accesibles?|conectados?)[ ?!.]*$/iu,
  ]),
  zh: Object.freeze([
    /^(?:现在|目前)?(?:有哪些|哪些)(?:可连接的?|在线的?|可用的?|已连接的?|已注册的?)?(?:设备|电脑|计算机)[？?！!.]*$/u,
    /^(?:请)?(?:显示|列出|告诉我)(?:现在|目前)?(?:可连接的?|在线的?|可用的?|已连接的?|已注册的?)?(?:设备|电脑|计算机)(?:列表|状态)?[？?！!.]*$/u,
  ]),
});

const NAMED_DEVICE_QUERY_PATTERNS: Readonly<Record<DeviceDirectoryQueryLocale, readonly RegExp[]>> =
  Object.freeze({
    en: Object.freeze([
      /^(?:can\s+(?:i|you|opendelegate)\s+(?:reach|access|use|connect\s+to)\s+)(.{1,253}?)[?!.]*$/iu,
      /^is\s+(.{1,253}?)\s+(?:currently\s+)?(?:reachable|online|connected|available)[?!.]*$/iu,
    ]),
    fr: Object.freeze([
      /^(?:est-ce\s+que\s+)?(.{1,253}?)\s+est\s+(?:actuellement\s+)?(?:accessible|disponible|en\s+ligne|connect[eé])[ ?!.]*$/iu,
    ]),
    ja: Object.freeze([
      /^(?:現在|今)?(.{1,253}?)(?:に)?(?:接続|アクセス)(?:できますか|可能ですか|できる)[？?！!.]*$/u,
    ]),
    ko: Object.freeze([
      /^(?:(?:지금|현재)\s*)?(.{1,253}?)(?:에|로)?\s*(?:접속|연결|사용)(?:이|가)?\s*(?:가능(?:한가(?:요)?|해(?:요)?|한지)?|돼(?:요)?|되나(?:요)?|됩니까|할\s*수\s*있(?:어(?:요)?|나(?:요)?|습니까))[?!.~]*$/iu,
    ]),
    es: Object.freeze([
      /^(?:est[aá]\s+)?(.{1,253}?)\s+(?:actualmente\s+)?(?:disponible|en\s+l[ií]nea|accesible|conectado)[ ?!.]*$/iu,
    ]),
    zh: Object.freeze([
      /^(?:现在|目前)?(?:可以|能)?(?:连接|访问)(.{1,253}?)[吗么？?！!.]*$/u,
      /^(?:现在|目前)?(.{1,253}?)(?:可以|能)(?:连接|访问)[吗么？?！!.]*$/u,
    ]),
  });

const DEVICE_ROUTE_QUERY_PATTERNS: readonly {
  readonly locale: DeviceDirectoryQueryLocale;
  readonly pattern: RegExp;
}[] = Object.freeze([
  Object.freeze({
    locale: "ko",
    pattern:
      /^(ssh)(?:로|으로)?도?\s*(?:접속|연결)(?:이|가)?\s*(?:안\s*)?(?:돼(?:요)?|되나(?:요)?|됩니까|가능(?:해(?:요)?|한가(?:요)?)?)[?!.~]*$/iu,
  }),
  Object.freeze({
    locale: "en",
    pattern: /^(ssh)(?:\s+route)?\s+(?:also\s+)?(?:work|connect|reach)[?!.]*$/iu,
  }),
]);

const VAGUE_TASK_OBJECTIVE_PATTERNS = Object.freeze([
  /^(?:(?:test|testing|테스트)\s*(?:(?:를\s*위한|용|for)\s*)?(?:task|일감|작업)|(?:task|일감|작업)\s*(?:(?:를\s*위한|용|for)\s*)?(?:test|testing|테스트))[?!.~]*$/iu,
  /^(?:test task|task for testing|new task|untitled task)[?!.]*$/iu,
  /^(?:테스트(?:를 위한)? 일감|테스트(?:용)? 작업|새 작업)[?!.~]*$/u,
  /^(?:テスト用タスク|テストタスク|新しいタスク)[？?！!.]*$/u,
  /^(?:t[aâ]che de test|nouvelle t[aâ]che|t[aâ]che sans titre)[ ?!.]*$/iu,
  /^(?:tarea de prueba|nueva tarea|tarea sin t[ií]tulo)[ ?!.]*$/iu,
  /^(?:测试任务|新任务|未命名任务)[？?！!.]*$/u,
]);

const KOREAN_DIRECTORY_SAFETY_QUALIFIER = new RegExp(
  "^(?:(?:파일|서비스|계정|권한|설정|네트워크|외부\\s*시스템))" +
    "(?:(?:\\s*,\\s*|\\s+(?:또는|및|과|와)\\s+)(?:파일|서비스|계정|권한|설정|네트워크|외부\\s*시스템))*" +
    "(?:은|는|을|를)?\\s*(?:변경|수정|삭제|생성|재시작|호출|접근)\\s*하지\\s*(?:마|말아\\s*줘)(?:요)?[.!?~]*$",
  "u",
);

function answerDeviceDirectoryQuestion(
  task: TaskExecutionRequest["task"],
  devices: readonly PlanningDeviceObservation[] | undefined,
  question: DeviceDirectoryQuestion,
): Extract<TaskWorkPlanDecision, { readonly state: "completed" }> | undefined {
  if (devices === undefined) {
    return undefined;
  }
  let publicMessage: string;
  if (question.target === undefined) {
    publicMessage = renderDeviceDirectoryAnswer(devices, question.locale);
  } else {
    const device = findNamedDevice(devices, question.target);
    if (device === undefined) {
      return undefined;
    }
    publicMessage = renderNamedDeviceAnswer(device, question);
  }
  return Object.freeze({
    state: "completed",
    publicMessage,
    verifiedCompletionCriteria: Object.freeze([...task.completionCriteria]),
  });
}

function deviceDirectoryQuestionForTask(
  task: TaskExecutionRequest["task"],
): DeviceDirectoryQuestion | undefined {
  if (task.selectedInputRefs.length > 0 || task.constraints.length > 0) {
    return undefined;
  }
  const ownerMessages = task.messages.filter((message) => message.role === "owner");
  const latestOwnerMessage = ownerMessages.at(-1)?.content;
  const objective = normalizeNaturalLanguage(task.objective);
  const objectiveQuestion = classifyDeviceDirectoryQuestion(objective);
  const objectiveAllowsDirectDirectoryAnswer =
    objectiveQuestion !== undefined ||
    VAGUE_TASK_OBJECTIVE_PATTERNS.some((pattern) => pattern.test(objective));
  if (latestOwnerMessage === undefined) {
    return objectiveQuestion;
  }
  const query = normalizeNaturalLanguage(latestOwnerMessage);
  const selfContainedQuestion = classifyDeviceDirectoryQuestion(query);
  if (selfContainedQuestion !== undefined && objectiveAllowsDirectDirectoryAnswer) {
    return selfContainedQuestion;
  }
  const routeQuestion = classifyDeviceRouteQuestion(query);
  if (routeQuestion !== undefined && objectiveQuestion?.target !== undefined) {
    return Object.freeze({
      locale: routeQuestion.locale,
      target: objectiveQuestion.target,
      route: routeQuestion.route,
    });
  }
  return undefined;
}

function classifyDeviceDirectoryQuestion(query: string): DeviceDirectoryQuestion | undefined {
  const boundedQuery = stripDirectorySafetyQualifier(query);
  const genericLocale = deviceDirectoryQueryLocale(boundedQuery);
  if (genericLocale !== undefined) {
    return Object.freeze({ locale: genericLocale });
  }
  for (const locale of ["ko", "en", "ja", "fr", "es", "zh"] as const) {
    for (const pattern of NAMED_DEVICE_QUERY_PATTERNS[locale]) {
      const match = pattern.exec(boundedQuery);
      const target = match?.[1]?.trim().replace(/^["'`]+|["'`]+$/gu, "");
      if (target !== undefined && target.length > 0) {
        return Object.freeze({ locale, target });
      }
    }
  }
  return undefined;
}

function stripDirectorySafetyQualifier(query: string): string {
  const sentence = /^(.{1,512}?[.!?。！？])\s+(.{1,512})$/u.exec(query);
  if (sentence?.[1] === undefined || sentence[2] === undefined) {
    return query;
  }
  return KOREAN_DIRECTORY_SAFETY_QUALIFIER.test(sentence[2]) ? sentence[1] : query;
}

function classifyDeviceRouteQuestion(
  query: string,
): { readonly locale: DeviceDirectoryQueryLocale; readonly route: string } | undefined {
  for (const candidate of DEVICE_ROUTE_QUERY_PATTERNS) {
    const route = candidate.pattern.exec(query)?.[1];
    if (route !== undefined) {
      return Object.freeze({ locale: candidate.locale, route: route.toLocaleLowerCase("en-US") });
    }
  }
  return undefined;
}

function deviceDirectoryQueryLocale(query: string): DeviceDirectoryQueryLocale | undefined {
  for (const locale of ["ko", "en", "ja", "fr", "es", "zh"] as const) {
    if (DEVICE_DIRECTORY_QUERY_PATTERNS[locale].some((pattern) => pattern.test(query))) {
      return locale;
    }
  }
  return undefined;
}

function normalizeNaturalLanguage(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function findNamedDevice(
  devices: readonly PlanningDeviceObservation[],
  target: string,
): PlanningDeviceObservation | undefined {
  const targetAlias = compactDeviceAlias(target);
  if (targetAlias.length < 2) {
    return undefined;
  }
  const matches = devices.filter((device) => deviceAliases(device).has(targetAlias));
  return matches.length === 1 ? matches[0] : undefined;
}

function deviceAliases(device: PlanningDeviceObservation): ReadonlySet<string> {
  const aliases = new Set<string>([
    compactDeviceAlias(device.name),
    compactDeviceAlias(device.deviceId),
  ]);
  for (const value of [device.name, device.deviceId]) {
    for (const numeric of value.matchAll(/\d{3,}/gu)) {
      aliases.add(numeric[0]);
    }
  }
  return aliases;
}

function compactDeviceAlias(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function renderNamedDeviceAnswer(
  device: PlanningDeviceObservation,
  question: DeviceDirectoryQuestion,
): string {
  const reachable = device.connection === "online";
  const routes =
    device.routes.length === 0
      ? question.locale === "ko"
        ? "등록된 경로 없음"
        : "no registered route"
      : device.routes.map((route) => `${route.label} — ${route.health}`).join(", ");
  const observedAt =
    device.lastObservation === undefined
      ? question.locale === "ko"
        ? "확인 기록 없음"
        : "no observation recorded"
      : new Date(device.lastObservation.observedAtMs).toISOString();
  const header =
    question.locale === "ko"
      ? reachable
        ? `${device.name}에는 현재 OpenDelegate로 접속할 수 있습니다.`
        : `${device.name}에는 현재 OpenDelegate로 접속할 수 없습니다.`
      : question.locale === "ja"
        ? `${device.name}には現在OpenDelegateから${reachable ? "接続できます" : "接続できません"}。`
        : question.locale === "fr"
          ? `${device.name} ${reachable ? "est" : "n’est pas"} actuellement accessible via OpenDelegate.`
          : question.locale === "es"
            ? `${device.name} ${reachable ? "está" : "no está"} disponible actualmente mediante OpenDelegate.`
            : question.locale === "zh"
              ? `OpenDelegate 当前${reachable ? "可以" : "无法"}连接 ${device.name}。`
              : `${device.name} is ${reachable ? "reachable" : "not reachable"} through OpenDelegate right now.`;
  const lines =
    question.locale === "ko"
      ? [
          `- 상태: ${device.connection} · runtime ${device.runtime}`,
          `- 서비스 실행 방식: ${device.serviceMode}`,
          `- 마지막 확인: ${observedAt}`,
          `- 등록 경로: ${routes}`,
        ]
      : [
          `- Status: ${device.connection} · runtime ${device.runtime}`,
          `- Service mode: ${device.serviceMode}`,
          `- Last observation: ${observedAt}`,
          `- Registered routes: ${routes}`,
        ];
  if (question.route !== undefined) {
    const routeRegistered = device.routes.some((route) =>
      compactDeviceAlias(route.label).includes(compactDeviceAlias(question.route ?? "")),
    );
    lines.push(
      question.locale === "ko"
        ? routeRegistered
          ? `- ${question.route.toUpperCase()} 경로는 등록되어 있으며 위 상태를 따릅니다.`
          : `- OpenDelegate에 등록된 ${question.route.toUpperCase()} 실행 경로는 없습니다.`
        : routeRegistered
          ? `- A registered ${question.route.toUpperCase()} route is present and has the status shown above.`
          : `- OpenDelegate has no registered ${question.route.toUpperCase()} execution route.`,
    );
  }
  if (!reachable && device.serviceMode === "foreground") {
    lines.push(
      question.locale === "ko"
        ? "- foreground Worker는 실행한 터미널이나 로그인 세션이 끝나면 함께 중지될 수 있습니다."
        : "- A foreground Worker can stop when its terminal or login session ends.",
    );
  }
  return [header, "", ...lines].join("\n");
}

function renderDeviceDirectoryAnswer(
  devices: readonly PlanningDeviceObservation[],
  locale: DeviceDirectoryQueryLocale,
): string {
  const visible = devices.slice(0, 16);
  const online = devices.filter((device) => device.connection === "online").length;
  const header =
    locale === "ko"
      ? `현재 등록된 기기 ${devices.length.toString()}대 중 ${online.toString()}대에 접속할 수 있습니다.`
      : locale === "ja"
        ? `登録済みデバイス${devices.length.toString()}台のうち、現在${online.toString()}台に接続できます。`
        : locale === "fr"
          ? `${online.toString()} appareil(s) sur ${devices.length.toString()} sont actuellement accessibles.`
          : locale === "es"
            ? `${online.toString()} de ${devices.length.toString()} dispositivos están disponibles actualmente.`
            : locale === "zh"
              ? `当前可连接 ${online.toString()} 台设备，共注册 ${devices.length.toString()} 台。`
              : `${online.toString()} of ${devices.length.toString()} registered Devices are reachable now.`;
  const lines = visible.map((device) => {
    const connection =
      locale === "ko"
        ? device.connection === "online"
          ? "접속 가능"
          : "오프라인"
        : locale === "ja"
          ? device.connection === "online"
            ? "接続可能"
            : "オフライン"
          : locale === "fr"
            ? device.connection === "online"
              ? "accessible"
              : "hors ligne"
            : locale === "es"
              ? device.connection === "online"
                ? "disponible"
                : "sin conexión"
              : locale === "zh"
                ? device.connection === "online"
                  ? "可连接"
                  : "离线"
                : device.connection === "online"
                  ? "reachable"
                  : "offline";
    const acceptingWork =
      device.acceptingWork === undefined
        ? undefined
        : locale === "ko"
          ? device.acceptingWork
            ? "작업 가능"
            : "작업 대기 불가"
          : device.acceptingWork
            ? "accepting work"
            : "not accepting work";
    const capabilities =
      device.capabilities.length === 0
        ? locale === "ko"
          ? "검증 기능 없음"
          : "no verified capabilities"
        : `${locale === "ko" ? "검증 기능" : "verified capabilities"}: ${device.capabilities
            .slice(0, 12)
            .join(", ")}`;
    const capacity =
      device.maximumConcurrentRuns === undefined
        ? undefined
        : `${locale === "ko" ? "작업" : "Runs"} ${device.activeRuns.toString()}/${device.maximumConcurrentRuns.toString()}`;
    return [
      `- ${device.name} — ${connection}`,
      device.osFamily,
      device.role,
      `runtime ${device.runtime}`,
      acceptingWork,
      capacity,
      capabilities,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
  });
  if (visible.length < devices.length) {
    const omitted = devices.length - visible.length;
    lines.push(
      locale === "ko"
        ? `- 그 외 ${omitted.toString()}대는 관리자 페이지에서 확인할 수 있습니다.`
        : `- ${omitted.toString()} additional Devices are available in Admin Web.`,
    );
  }
  return [header, "", ...lines].join("\n");
}

function parseVerificationResult(value: string | undefined): TaskExecutionResult {
  const parsed = parseAgentJson(value, "EXECUTOR_RESULT_INVALID");
  if (parsed["schemaVersion"] !== 1 || typeof parsed["state"] !== "string") {
    throw invalidVerificationResult();
  }
  if (
    parsed["state"] === "completed" &&
    hasExactKeys(parsed, [
      "schemaVersion",
      "state",
      "publicMessage",
      "verifiedCompletionCriteria",
    ]) &&
    Array.isArray(parsed["verifiedCompletionCriteria"]) &&
    parsed["verifiedCompletionCriteria"].every(
      (criterion) =>
        typeof criterion === "string" &&
        criterion.trim().length > 0 &&
        Buffer.byteLength(criterion, "utf8") <= 32_768 &&
        !criterion.includes("\0"),
    )
  ) {
    return {
      state: "completed",
      publicMessage: readAgentPublicMessage(parsed["publicMessage"], invalidVerificationResult),
      verifiedCompletionCriteria: Object.freeze([...parsed["verifiedCompletionCriteria"]]),
    };
  }
  if (
    parsed["state"] === "waiting_user" &&
    hasExactKeys(parsed, ["schemaVersion", "state", "ownerQuestion"])
  ) {
    return {
      state: "waiting_user",
      publicMessage: readAgentOwnerQuestion(parsed["ownerQuestion"], invalidVerificationResult),
    };
  }
  if (
    (parsed["state"] === "waiting_resource" ||
      parsed["state"] === "review" ||
      parsed["state"] === "failed") &&
    hasExactKeys(parsed, ["schemaVersion", "state", "publicMessage"])
  ) {
    return {
      state: parsed["state"],
      publicMessage: readAgentPublicMessage(parsed["publicMessage"], invalidVerificationResult),
    };
  }
  throw invalidVerificationResult();
}

function parseCoordinatorResult(value: string | undefined): TaskExecutionResult {
  if (value === undefined || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw invalidCoordinatorResult();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidCoordinatorResult();
  }
  if (!isRecord(parsed) || parsed["schemaVersion"] !== 1 || typeof parsed["state"] !== "string") {
    throw invalidCoordinatorResult();
  }
  const state = parsed["state"];
  if (
    state === "waiting_user" &&
    hasExactKeys(parsed, ["schemaVersion", "state", "ownerQuestion"])
  ) {
    return {
      state: "waiting_user",
      publicMessage: readAgentOwnerQuestion(parsed["ownerQuestion"], invalidCoordinatorResult),
    };
  }
  if (
    (state === "waiting_resource" || state === "review" || state === "failed") &&
    hasExactKeys(parsed, ["schemaVersion", "state", "publicMessage"])
  ) {
    return {
      state,
      publicMessage: readAgentPublicMessage(parsed["publicMessage"], invalidCoordinatorResult),
    };
  }
  throw invalidCoordinatorResult();
}

function parseAgentJson(
  value: string | undefined,
  code: "EXECUTOR_RESULT_INVALID" | "WORK_PLAN_INVALID",
): Record<string, unknown> {
  if (value === undefined || Buffer.byteLength(value, "utf8") > 262_144) {
    throw code === "WORK_PLAN_INVALID" ? invalidWorkPlan() : invalidVerificationResult();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw code === "WORK_PLAN_INVALID" ? invalidWorkPlan() : invalidVerificationResult();
  }
  if (!isRecord(parsed)) {
    throw code === "WORK_PLAN_INVALID" ? invalidWorkPlan() : invalidVerificationResult();
  }
  return parsed;
}

function readAgentPublicMessage(value: unknown, errorFactory: () => TaskExecutorError): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 32_768 ||
    value.includes("\0")
  ) {
    throw errorFactory();
  }
  return value;
}

function readAgentOwnerQuestion(value: unknown, errorFactory: () => TaskExecutorError): string {
  const question = readAgentPublicMessage(value, errorFactory);
  if (
    question !== question.trim() ||
    Buffer.byteLength(question, "utf8") > 1_024 ||
    question.includes("\n") ||
    question.includes("\r") ||
    !/[?？]$/u.test(question) ||
    (question.match(/[?？]/gu)?.length ?? 0) !== 1
  ) {
    throw errorFactory();
  }
  return question;
}

function validateReference(value: unknown): NativeSessionReference {
  if (!isRecord(value) || !hasExactOrOptionalReferenceKeys(value)) {
    throw sessionStateCorrupt();
  }
  if (
    value["schemaVersion"] !== 1 ||
    (value["provider"] !== "codex" &&
      value["provider"] !== "claude" &&
      value["provider"] !== "generic")
  ) {
    throw sessionStateCorrupt();
  }
  for (const key of [
    "adapterId",
    "adapterVersion",
    "nativeSessionId",
    "sessionKey",
    "taskId",
    "workstreamId",
    "deviceId",
    "workspaceId",
    "cwd",
    "createdAt",
  ]) {
    assertReferenceIdentifier(value[key]);
  }
  if (!isAbsolute(value["cwd"] as string) || !isRfc3339Instant(value["createdAt"] as string)) {
    throw sessionStateCorrupt();
  }
  if (value["worktreePath"] !== undefined) {
    assertReferenceIdentifier(value["worktreePath"]);
    if (!isAbsolute(value["worktreePath"] as string)) {
      throw sessionStateCorrupt();
    }
  }
  if (value["modelId"] !== undefined) {
    assertReferenceIdentifier(value["modelId"]);
  }
  const lineage = value["lineage"];
  if (
    !isRecord(lineage) ||
    !Object.keys(lineage).every((key) =>
      ["lineageId", "parentNativeSessionId", "continuationReason"].includes(key),
    )
  ) {
    throw sessionStateCorrupt();
  }
  assertReferenceIdentifier(lineage["lineageId"]);
  if (lineage["parentNativeSessionId"] !== undefined) {
    assertReferenceIdentifier(lineage["parentNativeSessionId"]);
  }
  if (lineage["continuationReason"] !== undefined) {
    assertReferenceIdentifier(lineage["continuationReason"]);
  }
  if (
    (lineage["parentNativeSessionId"] === undefined) !==
    (lineage["continuationReason"] === undefined)
  ) {
    throw sessionStateCorrupt();
  }
  return structuredClone(value) as unknown as NativeSessionReference;
}

function assertValidReplacement(
  current: NativeSessionReference,
  replacement: NativeSessionReference,
): void {
  for (const key of [
    "provider",
    "adapterId",
    "modelId",
    "sessionKey",
    "taskId",
    "workstreamId",
    "deviceId",
    "workspaceId",
    "cwd",
    "worktreePath",
  ] as const) {
    if (current[key] !== replacement[key]) {
      throw sessionStateCorrupt();
    }
  }
  if (current.nativeSessionId === replacement.nativeSessionId) {
    if (
      current.adapterVersion !== replacement.adapterVersion ||
      current.createdAt !== replacement.createdAt ||
      JSON.stringify(current.lineage) !== JSON.stringify(replacement.lineage)
    ) {
      throw sessionStateCorrupt();
    }
  } else if (
    replacement.lineage.parentNativeSessionId !== current.nativeSessionId ||
    replacement.lineage.continuationReason === undefined ||
    replacement.lineage.lineageId === current.lineage.lineageId ||
    Date.parse(replacement.createdAt) < Date.parse(current.createdAt)
  ) {
    throw sessionStateCorrupt();
  }
}

function assertAdapter(adapter: AgentAdapter): void {
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    typeof adapter.adapterId !== "string" ||
    typeof adapter.start !== "function" ||
    typeof adapter.resume !== "function"
  ) {
    throw new TypeError("A valid Agent Adapter is required.");
  }
}

function assertRepository(repository: MainNativeSessionRepository): void {
  if (
    repository === null ||
    typeof repository !== "object" ||
    typeof repository.load !== "function" ||
    typeof repository.save !== "function"
  ) {
    throw new TypeError("A durable Main native-session repository is required.");
  }
}

function assertCheckpointProvider(provider: TaskContinuationCheckpointPort): void {
  if (provider === null || typeof provider !== "object" || typeof provider.build !== "function") {
    throw new TypeError("A durable Task continuation checkpoint provider is required.");
  }
}

function assertWorkspace(workspace: WorkspaceBinding): void {
  assertIdentifier(workspace.workspaceId, "Workspace ID");
  assertIdentifier(workspace.cwd, "Workspace cwd");
}

function assertExecutionOptions(
  sandbox: AgentSandbox,
  permissions: AgentPermissionInput,
  limits: AgentRunLimits,
): void {
  if (
    typeof sandbox !== "string" ||
    permissions === null ||
    typeof permissions !== "object" ||
    typeof permissions.mode !== "string" ||
    limits === null ||
    typeof limits !== "object" ||
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError("Agent execution policy and limits are invalid.");
  }
}

/** Bounded, trimmed, control-character-free profile text. */
function isBoundedProfileValue(value: string, maximumLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    ![...value].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  );
}

function mapAdapterFailure(error: unknown, message: string): TaskExecutorError {
  return new TaskExecutorError(
    error instanceof AgentAdapterError ? error.code : "AGENT_ADAPTER_START_FAILED",
    message,
    error instanceof AgentAdapterError && error.retryable,
  );
}

function invalidCoordinatorResult(): TaskExecutorError {
  return new TaskExecutorError(
    "COORDINATOR_RESULT_INVALID",
    "The Main Agent returned an invalid public coordinator result.",
  );
}

function invalidWorkPlan(): TaskExecutorError {
  return new TaskExecutorError(
    "WORK_PLAN_INVALID",
    "The Main Agent returned an invalid Work Order planning decision.",
  );
}

function invalidVerificationResult(): TaskExecutorError {
  return new TaskExecutorError(
    "EXECUTOR_RESULT_INVALID",
    "The Main Agent returned an invalid authoritative-evidence verification decision.",
  );
}

function sessionStateCorrupt(): TaskExecutorError {
  return new TaskExecutorError(
    "NATIVE_SESSION_STATE_CORRUPT",
    "The Main Agent native-session state is corrupt or conflicts with its Task binding.",
  );
}

function taskSessionKey(taskId: string, adapterId: string): string {
  return `task:${taskId}:coordinator:${adapterId}`;
}

function sessionStreamId(sessionKey: string): string {
  return `agent-session:${digest(sessionKey).slice("sha256:".length)}`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function messagesAfterLastAgent<TMessage extends { readonly role: "owner" | "agent" }>(
  messages: readonly TMessage[],
): readonly TMessage[] {
  const lastAgent = messages.findLastIndex((message) => message.role === "agent");
  return messages.slice(lastAgent + 1);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function hasExactOrOptionalReferenceKeys(value: Record<string, unknown>): boolean {
  const keys = [
    "schemaVersion",
    "provider",
    "adapterId",
    "adapterVersion",
    "nativeSessionId",
    "sessionKey",
    "taskId",
    "workstreamId",
    "deviceId",
    "workspaceId",
    "cwd",
    "lineage",
    "createdAt",
  ];
  return (
    Object.keys(value).every((key) => [...keys, "modelId", "worktreePath"].includes(key)) &&
    keys
      .filter((key) => key !== "modelId")
      .every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 32_768 ||
    value.includes("\u0000")
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertReferenceIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 32_768 ||
    value.includes("\u0000")
  ) {
    throw sessionStateCorrupt();
  }
}

function isRfc3339Instant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function safeCancel(handle: AgentRunHandle, reason: string): Promise<void> {
  try {
    await handle.cancel(reason);
  } catch {
    // Durable Task state and adapter process cleanup remain authoritative.
  }
}
