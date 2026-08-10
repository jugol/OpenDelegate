import { createHash } from "node:crypto";

import type { EventStore, StoredEvent } from "@opendelegate/event-store";
import {
  TASK_CONTINUATION_CHECKPOINT_LIMITS,
  TASK_CONTINUATION_CHECKPOINT_MAX_BYTES,
  createTaskContinuationCheckpoint,
  parseSemanticPlanningResponse,
  parseWorkerAgentSessionObservation,
  sanitizeTaskContinuationText,
  type TaskContinuationArtifactV1,
  type TaskContinuationCheckpointBodyV1,
  type TaskContinuationCheckpointV1,
  type TaskContinuationDecisionV1,
  type TaskContinuationMessageV1,
  type TaskContinuationNativeSessionV1,
  type TaskContinuationPendingWorkOrderV1,
  type TaskDetailV1,
  type WorkerAgentSessionObservationV1,
  type WorkOrderV1,
} from "@opendelegate/protocol";

const SOURCE_COMPLETION_CRITERIA_LIMIT = 24;
const SOURCE_CONSTRAINT_LIMIT = 24;
const SOURCE_WORK_ORDER_DETAIL_LIMIT = 4;
const SOURCE_WORK_ORDER_REFERENCE_LIMIT = 16;
const PUBLIC_OBJECTIVE_BYTES = 4_096;
const PUBLIC_SUMMARY_BYTES = 4_096;
const PUBLIC_MESSAGE_BYTES = 4_096;
const PUBLIC_WORK_ORDER_BRIEF_BYTES = 1_024;
const PUBLIC_LIST_ITEM_BYTES = 512;
const CHECKPOINT_HASH_OVERHEAD_BYTES = 128;

export interface TaskContinuationCheckpointTaskSource {
  get(taskId: string): Promise<TaskDetailV1>;
}

export interface TaskContinuationCheckpointPort {
  build(taskId: string): Promise<TaskContinuationCheckpointV1>;
}

export interface DurableTaskContinuationCheckpointServiceOptions {
  readonly eventStore: Pick<EventStore, "readAll">;
  readonly tasks: TaskContinuationCheckpointTaskSource;
}

export type TaskContinuationCheckpointErrorCode =
  "CHECKPOINT_SOURCE_INVALID" | "CHECKPOINT_SOURCE_UNSTABLE" | "CHECKPOINT_TOO_LARGE";

export class TaskContinuationCheckpointError extends Error {
  public readonly code: TaskContinuationCheckpointErrorCode;

  public constructor(code: TaskContinuationCheckpointErrorCode, message: string) {
    super(message);
    this.name = "TaskContinuationCheckpointError";
    this.code = code;
  }
}

interface PositionedDecision {
  readonly position: number;
  readonly decision: TaskContinuationDecisionV1;
}

interface PositionedWorkerSession {
  readonly position: number;
  readonly session: TaskContinuationNativeSessionV1;
}

interface AcceptedWorkerProjection {
  readonly position: number;
  readonly workOrderId: string;
  readonly succeeded: boolean;
  readonly artifacts: readonly TaskContinuationArtifactV1[];
  readonly session?: TaskContinuationNativeSessionV1;
}

interface MutableCheckpointBody {
  schemaVersion: 1;
  taskId: string;
  taskVersion: number;
  summary: {
    state: TaskContinuationCheckpointBodyV1["summary"]["state"];
    mode: TaskContinuationCheckpointBodyV1["summary"]["mode"];
    objective: string;
    rollingSummary: string;
    completionCriteria: string[];
    constraints: string[];
  };
  decisions: TaskContinuationDecisionV1[];
  pendingWorkOrders: TaskContinuationPendingWorkOrderV1[];
  artifacts: TaskContinuationArtifactV1[];
  messages: TaskContinuationMessageV1[];
  sessions: TaskContinuationNativeSessionV1[];
  omitted: {
    completionCriteria: number;
    constraints: number;
    decisions: number;
    pendingWorkOrders: number;
    artifacts: number;
    messages: number;
    sessions: number;
  };
}

/**
 * Builds one deterministic, Task-isolated continuation document exclusively from
 * the durable Task projection and Event Store. Private transcript fields, Knowledge,
 * local paths, lease authority, fencing tokens, Secret references, and raw Worker
 * reports have no field in the output schema.
 */
export class DurableTaskContinuationCheckpointService implements TaskContinuationCheckpointPort {
  readonly #eventStore: Pick<EventStore, "readAll">;
  readonly #tasks: TaskContinuationCheckpointTaskSource;

  public constructor(options: DurableTaskContinuationCheckpointServiceOptions) {
    if (
      options.eventStore === null ||
      typeof options.eventStore !== "object" ||
      typeof options.eventStore.readAll !== "function" ||
      options.tasks === null ||
      typeof options.tasks !== "object" ||
      typeof options.tasks.get !== "function"
    ) {
      throw new TypeError("Durable continuation checkpoint sources are invalid.");
    }
    this.#eventStore = options.eventStore;
    this.#tasks = options.tasks;
  }

  public async build(taskId: string): Promise<TaskContinuationCheckpointV1> {
    assertIdentifier(taskId, "Task ID");
    let task: TaskDetailV1 | undefined;
    let events: readonly StoredEvent[] | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.#tasks.get(taskId);
      assertTask(before, taskId);
      const candidateEvents = await this.#eventStore.readAll();
      const after = await this.#tasks.get(taskId);
      assertTask(after, taskId);
      if (before.version === after.version) {
        task = after;
        events = candidateEvents;
        break;
      }
    }
    if (task === undefined || events === undefined) {
      throw new TaskContinuationCheckpointError(
        "CHECKPOINT_SOURCE_UNSTABLE",
        "The durable Task changed repeatedly while its continuation checkpoint was built.",
      );
    }
    const decisions = decisionsForTask(events, taskId);
    const accepted = acceptedWorkerEventsForTask(events, taskId);
    const latestPlan = latestPlanForTask(events, taskId);
    const succeededWorkOrders = new Set(
      accepted.filter((entry) => entry.succeeded).map((entry) => entry.workOrderId),
    );
    const pending = (latestPlan?.workOrders ?? [])
      .filter((workOrder) => !succeededWorkOrders.has(workOrder.workOrderId))
      .map(toPendingWorkOrder);
    const artifacts = artifactsForTask(task, accepted);
    const messages = messagesForTask(task);
    const sessions = sessionsForTask(events, taskId, accepted);

    return fitCheckpoint({
      schemaVersion: 1,
      taskId,
      taskVersion: task.version,
      summary: {
        state: task.state,
        mode: task.mode,
        objective: publicText(task.objective, PUBLIC_OBJECTIVE_BYTES),
        rollingSummary: rollingSummary(task, pending.length, artifacts.length, messages),
        completionCriteria: task.completionCriteria
          .slice(0, SOURCE_COMPLETION_CRITERIA_LIMIT)
          .map((criterion) => publicText(criterion, PUBLIC_LIST_ITEM_BYTES)),
        constraints: task.constraints
          .slice(0, SOURCE_CONSTRAINT_LIMIT)
          .map((constraint) => publicText(constraint, PUBLIC_LIST_ITEM_BYTES)),
      },
      decisions: decisions
        .slice(-TASK_CONTINUATION_CHECKPOINT_LIMITS.decisions)
        .map((entry) => entry.decision),
      pendingWorkOrders: pending.slice(0, TASK_CONTINUATION_CHECKPOINT_LIMITS.pendingWorkOrders),
      artifacts: artifacts.slice(0, TASK_CONTINUATION_CHECKPOINT_LIMITS.artifacts),
      messages: messages.slice(-TASK_CONTINUATION_CHECKPOINT_LIMITS.messages),
      sessions: sessions.slice(0, TASK_CONTINUATION_CHECKPOINT_LIMITS.sessions),
      omitted: {
        completionCriteria: Math.max(
          0,
          task.completionCriteria.length - SOURCE_COMPLETION_CRITERIA_LIMIT,
        ),
        constraints: Math.max(0, task.constraints.length - SOURCE_CONSTRAINT_LIMIT),
        decisions: Math.max(0, decisions.length - TASK_CONTINUATION_CHECKPOINT_LIMITS.decisions),
        pendingWorkOrders: Math.max(
          0,
          pending.length - TASK_CONTINUATION_CHECKPOINT_LIMITS.pendingWorkOrders,
        ),
        artifacts: Math.max(0, artifacts.length - TASK_CONTINUATION_CHECKPOINT_LIMITS.artifacts),
        messages: Math.max(0, messages.length - TASK_CONTINUATION_CHECKPOINT_LIMITS.messages),
        sessions: Math.max(0, sessions.length - TASK_CONTINUATION_CHECKPOINT_LIMITS.sessions),
      },
    });
  }
}

function decisionsForTask(
  events: readonly StoredEvent[],
  taskId: string,
): readonly PositionedDecision[] {
  const decisions: PositionedDecision[] = [];
  for (const event of events) {
    if (!isRecord(event.payload) || event.payload["taskId"] !== taskId) {
      continue;
    }
    if (event.type === "task.commanded") {
      const command = event.payload["command"];
      if (
        command !== "pause" &&
        command !== "resume" &&
        command !== "cancel" &&
        command !== "retry"
      ) {
        throw sourceInvalid();
      }
      decisions.push({
        position: event.globalPosition,
        decision: {
          decisionId: boundedIdentifier(event.eventId),
          kind: "command",
          outcome: command,
          occurredAt: event.occurredAt,
        },
      });
      continue;
    }
    if (event.type === "task.approval-resolved") {
      const decision = event.payload["decision"];
      if (
        (decision !== "approve" && decision !== "reject") ||
        typeof event.payload["approvalId"] !== "string"
      ) {
        throw sourceInvalid();
      }
      decisions.push({
        position: event.globalPosition,
        decision: {
          decisionId: boundedIdentifier(event.payload["approvalId"]),
          kind: "approval",
          outcome: decision === "approve" ? "approved" : "rejected",
          occurredAt: event.occurredAt,
        },
      });
      continue;
    }
    if (event.type === "task.execution-recorded") {
      const criteria = event.payload["verifiedCompletionCriteria"];
      if (!Array.isArray(criteria) || criteria.some((criterion) => typeof criterion !== "string")) {
        throw sourceInvalid();
      }
      criteria.forEach((criterion, index) => {
        decisions.push({
          position: event.globalPosition,
          decision: {
            decisionId: `decision_${digest(`${event.eventId}\u0000${String(index)}`)}`,
            kind: "criterion-verified",
            outcome: publicText(criterion, PUBLIC_LIST_ITEM_BYTES),
            occurredAt: event.occurredAt,
          },
        });
      });
    }
  }
  return Object.freeze(
    decisions.sort(
      (left, right) =>
        left.position - right.position ||
        compareOrdinal(left.decision.decisionId, right.decision.decisionId),
    ),
  );
}

function latestPlanForTask(
  events: readonly StoredEvent[],
  taskId: string,
): ReturnType<typeof parseSemanticPlanningResponse> | undefined {
  let latest:
    | {
        readonly position: number;
        readonly plan: ReturnType<typeof parseSemanticPlanningResponse>;
      }
    | undefined;
  for (const event of events) {
    if (
      event.type !== "task.worker-plan-recorded" ||
      !isRecord(event.payload) ||
      event.payload["taskId"] !== taskId
    ) {
      continue;
    }
    let plan;
    try {
      plan = parseSemanticPlanningResponse(event.payload["plan"]);
    } catch {
      throw sourceInvalid();
    }
    if (plan.taskId !== taskId) {
      throw sourceInvalid();
    }
    if (latest === undefined || event.globalPosition > latest.position) {
      latest = { position: event.globalPosition, plan };
    }
  }
  return latest?.plan;
}

function acceptedWorkerEventsForTask(
  events: readonly StoredEvent[],
  taskId: string,
): readonly AcceptedWorkerProjection[] {
  const accepted: AcceptedWorkerProjection[] = [];
  for (const event of events) {
    if (
      event.type !== "task.worker-event-accepted" ||
      !isRecord(event.payload) ||
      event.payload["taskId"] !== taskId
    ) {
      continue;
    }
    const workOrderId = boundedIdentifier(event.payload["workOrderId"]);
    const envelope = event.payload["event"];
    if (!isRecord(envelope) || !isRecord(envelope["payload"])) {
      throw sourceInvalid();
    }
    const payload = envelope["payload"];
    if (
      payload["taskId"] !== taskId ||
      payload["workOrderId"] !== workOrderId ||
      typeof envelope["senderDeviceId"] !== "string"
    ) {
      throw sourceInvalid();
    }
    if (envelope["type"] === "worker.run.progress") {
      continue;
    }
    const artifacts = readArtifactIds(payload["artifactIds"]).map((artifactId) => ({
      artifactId,
      source: "worker-report" as const,
      workOrderId,
    }));
    let session: TaskContinuationNativeSessionV1 | undefined;
    if (payload["agentSession"] !== undefined) {
      let observation: WorkerAgentSessionObservationV1;
      try {
        observation = parseWorkerAgentSessionObservation(payload["agentSession"]);
      } catch {
        throw sourceInvalid();
      }
      session = workerSession(
        boundedIdentifier(envelope["senderDeviceId"]),
        workOrderId,
        observation,
      );
    }
    accepted.push({
      position: event.globalPosition,
      workOrderId,
      succeeded: envelope["type"] === "worker.run.succeeded",
      artifacts,
      ...(session === undefined ? {} : { session }),
    });
  }
  return Object.freeze(accepted.sort((left, right) => left.position - right.position));
}

function artifactsForTask(
  task: TaskDetailV1,
  accepted: readonly AcceptedWorkerProjection[],
): readonly TaskContinuationArtifactV1[] {
  const artifacts: TaskContinuationArtifactV1[] = task.selectedInputRefs.map((artifactId) => ({
    artifactId: boundedIdentifier(artifactId),
    source: "selected-input",
  }));
  for (const entry of accepted) {
    artifacts.push(...entry.artifacts);
  }
  const unique = new Map<string, TaskContinuationArtifactV1>();
  for (const artifact of artifacts) {
    const key = `${artifact.source}\u0000${artifact.workOrderId ?? ""}\u0000${artifact.artifactId}`;
    unique.set(key, artifact);
  }
  return Object.freeze(
    [...unique.values()].sort(
      (left, right) =>
        compareOrdinal(left.source, right.source) ||
        compareOrdinal(left.workOrderId ?? "", right.workOrderId ?? "") ||
        compareOrdinal(left.artifactId, right.artifactId),
    ),
  );
}

function messagesForTask(task: TaskDetailV1): readonly TaskContinuationMessageV1[] {
  return Object.freeze(
    task.messages.map((message) => ({
      messageId: boundedIdentifier(message.messageId),
      role: message.role,
      content: publicText(message.content, PUBLIC_MESSAGE_BYTES),
      occurredAt: message.occurredAt,
    })),
  );
}

function sessionsForTask(
  events: readonly StoredEvent[],
  taskId: string,
  accepted: readonly AcceptedWorkerProjection[],
): readonly TaskContinuationNativeSessionV1[] {
  let coordinator:
    | {
        readonly position: number;
        readonly session: TaskContinuationNativeSessionV1;
      }
    | undefined;
  for (const event of events) {
    if (event.type !== "agent.native-session-recorded" || !isRecord(event.payload)) {
      continue;
    }
    const reference = event.payload["reference"];
    if (!isRecord(reference) || reference["taskId"] !== taskId) {
      continue;
    }
    const session = coordinatorSession(reference);
    if (session.workstreamId !== "coordinator") {
      continue;
    }
    if (coordinator === undefined || event.globalPosition > coordinator.position) {
      coordinator = { position: event.globalPosition, session };
    }
  }
  const workers = new Map<string, PositionedWorkerSession>();
  for (const entry of accepted) {
    if (entry.session === undefined) {
      continue;
    }
    const key = `${entry.session.deviceId}\u0000${entry.session.workstreamId}\u0000${entry.workOrderId}`;
    const prior = workers.get(key);
    if (prior === undefined || entry.position > prior.position) {
      workers.set(key, { position: entry.position, session: entry.session });
    }
  }
  return Object.freeze([
    ...(coordinator === undefined ? [] : [coordinator.session]),
    ...[...workers.values()]
      .sort(
        (left, right) =>
          compareOrdinal(left.session.workOrderId!, right.session.workOrderId!) ||
          compareOrdinal(left.session.deviceId, right.session.deviceId) ||
          left.position - right.position,
      )
      .map((entry) => entry.session),
  ]);
}

function coordinatorSession(reference: Record<string, unknown>): TaskContinuationNativeSessionV1 {
  if (
    reference["schemaVersion"] !== 1 ||
    !isProvider(reference["provider"]) ||
    !isRecord(reference["lineage"])
  ) {
    throw sourceInvalid();
  }
  const lineage = reference["lineage"];
  return {
    scope: "coordinator",
    deviceId: boundedIdentifier(reference["deviceId"]),
    provider: reference["provider"],
    adapterId: boundedIdentifier(reference["adapterId"]),
    adapterVersion: boundedIdentifier(reference["adapterVersion"]),
    nativeSessionId: boundedIdentifier(reference["nativeSessionId"]),
    workstreamId: boundedIdentifier(reference["workstreamId"]),
    workspaceId: boundedIdentifier(reference["workspaceId"]),
    lineage: readLineage(lineage),
  };
}

function workerSession(
  deviceId: string,
  workOrderId: string,
  observation: WorkerAgentSessionObservationV1,
): TaskContinuationNativeSessionV1 {
  return {
    scope: "worker",
    deviceId,
    provider: observation.provider,
    adapterId: observation.adapterId,
    adapterVersion: observation.adapterVersion,
    nativeSessionId: observation.nativeSessionId,
    workstreamId: observation.workstreamId,
    workspaceId: observation.workspaceId,
    workOrderId,
    lineage: {
      lineageId: observation.lineage.lineageId,
      ...(observation.lineage.parentNativeSessionId === undefined
        ? {}
        : {
            parentNativeSessionId: observation.lineage.parentNativeSessionId,
            continuationReason: observation.lineage.continuationReason!,
          }),
    },
  };
}

function readLineage(lineage: Record<string, unknown>): TaskContinuationNativeSessionV1["lineage"] {
  const lineageId = boundedIdentifier(lineage["lineageId"]);
  if (
    (lineage["parentNativeSessionId"] === undefined) !==
    (lineage["continuationReason"] === undefined)
  ) {
    throw sourceInvalid();
  }
  return {
    lineageId,
    ...(lineage["parentNativeSessionId"] === undefined
      ? {}
      : {
          parentNativeSessionId: boundedIdentifier(lineage["parentNativeSessionId"]),
          continuationReason: boundedIdentifier(lineage["continuationReason"]),
        }),
  };
}

function toPendingWorkOrder(workOrder: WorkOrderV1): TaskContinuationPendingWorkOrderV1 {
  const completionCriteria = workOrder.completionCriteria
    .slice(0, SOURCE_WORK_ORDER_DETAIL_LIMIT)
    .map((criterion) => publicText(criterion, PUBLIC_LIST_ITEM_BYTES));
  const constraints = workOrder.constraints
    .slice(0, SOURCE_WORK_ORDER_DETAIL_LIMIT)
    .map((constraint) => publicText(constraint, PUBLIC_LIST_ITEM_BYTES));
  const dependsOn = workOrder.dependsOn
    .slice(0, SOURCE_WORK_ORDER_REFERENCE_LIMIT)
    .map(boundedIdentifier);
  const requiredCapabilities = workOrder.requiredCapabilities
    .slice(0, SOURCE_WORK_ORDER_REFERENCE_LIMIT)
    .map(boundedIdentifier);
  return {
    workOrderId: boundedIdentifier(workOrder.workOrderId),
    title: publicText(workOrder.title, 256),
    brief: publicText(workOrder.brief, PUBLIC_WORK_ORDER_BRIEF_BYTES),
    completionCriteria,
    constraints,
    dependsOn,
    requiredCapabilities,
    omitted: {
      completionCriteria: Math.max(
        0,
        workOrder.completionCriteria.length - completionCriteria.length,
      ),
      constraints: Math.max(0, workOrder.constraints.length - constraints.length),
      dependsOn: Math.max(0, workOrder.dependsOn.length - dependsOn.length),
      requiredCapabilities: Math.max(
        0,
        workOrder.requiredCapabilities.length - requiredCapabilities.length,
      ),
    },
    ...(workOrder.requiredAgent === undefined
      ? {}
      : {
          requiredAgent: {
            provider: workOrder.requiredAgent.provider,
            ...(workOrder.requiredAgent.adapterId === undefined
              ? {}
              : { adapterId: workOrder.requiredAgent.adapterId }),
            ...(workOrder.requiredAgent.allowedCompatibilities === undefined
              ? {}
              : {
                  allowedCompatibilities: workOrder.requiredAgent.allowedCompatibilities,
                }),
          },
        }),
    ...(workOrder.requiredOsFamily === undefined
      ? {}
      : { requiredOsFamily: workOrder.requiredOsFamily }),
    ...(workOrder.workspaceId === undefined ? {} : { workspaceId: workOrder.workspaceId }),
  };
}

function rollingSummary(
  task: TaskDetailV1,
  pendingWorkOrders: number,
  artifacts: number,
  messages: readonly TaskContinuationMessageV1[],
): string {
  const latest = messages.at(-1)?.content;
  return publicText(
    [
      `Task state: ${task.state}.`,
      `Pending Work Orders: ${String(pendingWorkOrders)}.`,
      `Selected or produced Artifacts: ${String(artifacts)}.`,
      latest === undefined
        ? "No durable public update is recorded."
        : `Latest public update: ${latest}`,
    ].join(" "),
    PUBLIC_SUMMARY_BYTES,
  );
}

function fitCheckpoint(initial: TaskContinuationCheckpointBodyV1): TaskContinuationCheckpointV1 {
  const body: MutableCheckpointBody = {
    schemaVersion: 1,
    taskId: initial.taskId,
    taskVersion: initial.taskVersion,
    decisions: [...initial.decisions],
    pendingWorkOrders: [...initial.pendingWorkOrders],
    artifacts: [...initial.artifacts],
    messages: [...initial.messages],
    sessions: [...initial.sessions],
    summary: {
      ...initial.summary,
      completionCriteria: [...initial.summary.completionCriteria],
      constraints: [...initial.summary.constraints],
    },
    omitted: { ...initial.omitted },
  };

  while (estimatedBytes(body) > TASK_CONTINUATION_CHECKPOINT_MAX_BYTES) {
    if (body.messages.length > 8) {
      body.messages.shift();
      body.omitted.messages += 1;
      continue;
    }
    if (body.decisions.length > 16) {
      body.decisions.shift();
      body.omitted.decisions += 1;
      continue;
    }
    if (body.sessions.length > 16) {
      body.sessions.pop();
      body.omitted.sessions += 1;
      continue;
    }
    if (body.artifacts.length > 32) {
      body.artifacts.pop();
      body.omitted.artifacts += 1;
      continue;
    }
    if (body.summary.constraints.length > 8) {
      body.summary.constraints.pop();
      body.omitted.constraints += 1;
      continue;
    }
    if (body.summary.completionCriteria.length > 8) {
      body.summary.completionCriteria.pop();
      body.omitted.completionCriteria += 1;
      continue;
    }
    if (body.pendingWorkOrders.length > 8) {
      body.pendingWorkOrders.pop();
      body.omitted.pendingWorkOrders += 1;
      continue;
    }
    const shrunk = shrinkOneWorkOrder(body.pendingWorkOrders);
    if (shrunk !== undefined) {
      body.pendingWorkOrders = shrunk;
      continue;
    }
    if (body.messages.length > 0) {
      body.messages.shift();
      body.omitted.messages += 1;
      continue;
    }
    if (body.decisions.length > 0) {
      body.decisions.shift();
      body.omitted.decisions += 1;
      continue;
    }
    if (body.sessions.length > 1) {
      body.sessions.pop();
      body.omitted.sessions += 1;
      continue;
    }
    if (body.artifacts.length > 0) {
      body.artifacts.pop();
      body.omitted.artifacts += 1;
      continue;
    }
    if (body.pendingWorkOrders.length > 1) {
      body.pendingWorkOrders.pop();
      body.omitted.pendingWorkOrders += 1;
      continue;
    }
    throw new TaskContinuationCheckpointError(
      "CHECKPOINT_TOO_LARGE",
      "The durable Task summary cannot fit the continuation checkpoint byte limit.",
    );
  }
  return createTaskContinuationCheckpoint(body);
}

function shrinkOneWorkOrder(
  workOrders: readonly TaskContinuationPendingWorkOrderV1[],
): TaskContinuationPendingWorkOrderV1[] | undefined {
  const index = workOrders.findIndex(
    (workOrder) =>
      workOrder.completionCriteria.length > 2 ||
      workOrder.constraints.length > 2 ||
      workOrder.dependsOn.length > 8 ||
      workOrder.requiredCapabilities.length > 8 ||
      Buffer.byteLength(workOrder.brief, "utf8") > 512,
  );
  if (index < 0) {
    return undefined;
  }
  const current = workOrders[index]!;
  const completionCriteria = current.completionCriteria.slice(0, 2);
  const constraints = current.constraints.slice(0, 2);
  const dependsOn = current.dependsOn.slice(0, 8);
  const requiredCapabilities = current.requiredCapabilities.slice(0, 8);
  const replacement: TaskContinuationPendingWorkOrderV1 = {
    ...current,
    brief: publicText(current.brief, 512),
    completionCriteria,
    constraints,
    dependsOn,
    requiredCapabilities,
    omitted: {
      completionCriteria:
        current.omitted.completionCriteria +
        current.completionCriteria.length -
        completionCriteria.length,
      constraints: current.omitted.constraints + current.constraints.length - constraints.length,
      dependsOn: current.omitted.dependsOn + current.dependsOn.length - dependsOn.length,
      requiredCapabilities:
        current.omitted.requiredCapabilities +
        current.requiredCapabilities.length -
        requiredCapabilities.length,
    },
  };
  const output = [...workOrders];
  output[index] = replacement;
  return output;
}

function estimatedBytes(body: TaskContinuationCheckpointBodyV1): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8") + CHECKPOINT_HASH_OVERHEAD_BYTES;
}

function readArtifactIds(input: unknown): readonly string[] {
  if (input === undefined) {
    return [];
  }
  if (
    !Array.isArray(input) ||
    input.length > TASK_CONTINUATION_CHECKPOINT_LIMITS.artifacts ||
    input.some((entry) => typeof entry !== "string")
  ) {
    throw sourceInvalid();
  }
  return Object.freeze(input.map(boundedIdentifier));
}

function publicText(input: string, maximumBytes: number): string {
  if (typeof input !== "string") {
    throw sourceInvalid();
  }
  const sanitized = sanitizeTaskContinuationText(input).trim();
  if (sanitized.length === 0) {
    return "[redacted public text]";
  }
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

function boundedIdentifier(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 256 ||
    input !== input.trim() ||
    sanitizeTaskContinuationText(input) !== input ||
    [...input].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  ) {
    throw sourceInvalid();
  }
  return input;
}

function assertTask(task: TaskDetailV1, taskId: string): void {
  if (
    task === null ||
    typeof task !== "object" ||
    task.taskId !== taskId ||
    task.version < 1 ||
    !Number.isSafeInteger(task.version) ||
    (task.mode !== "auto" && task.mode !== "manual") ||
    !Array.isArray(task.completionCriteria) ||
    !Array.isArray(task.constraints) ||
    !Array.isArray(task.selectedInputRefs) ||
    !Array.isArray(task.messages)
  ) {
    throw sourceInvalid();
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  try {
    boundedIdentifier(value);
  } catch {
    throw new TypeError(`${label} is invalid.`);
  }
}

function isProvider(value: unknown): value is "claude" | "codex" | "generic" {
  return value === "claude" || value === "codex" || value === "generic";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceInvalid(): TaskContinuationCheckpointError {
  return new TaskContinuationCheckpointError(
    "CHECKPOINT_SOURCE_INVALID",
    "The durable Task continuation source is invalid or crosses its Task boundary.",
  );
}
