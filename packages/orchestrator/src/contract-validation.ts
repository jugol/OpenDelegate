import type { TaskBrief, TaskState } from "@opendelegate/domain";
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  parseArtifactReference as parseProtocolArtifactReference,
  parseSemanticDeviceSelectionResponse,
  parseWorkOrder as parseProtocolWorkOrder,
} from "@opendelegate/protocol";

import type {
  ArtifactContent,
  ArtifactReference,
  AuthorizedForumPost,
  ClarificationExchange,
  ClarificationRequest,
  CompletedTaskView,
  CoordinatorIntakeDecision,
  CoordinatorDeviceSelection,
  CoordinatorPlan,
  CoordinatorReview,
  CoordinatorSynthesis,
  PlannedWorkOrder,
  RunAssignment,
  TaskView,
  WorkerExecutionResult,
  WorkerReport,
  WorkerRunCompletion,
  WorkOrderView,
} from "./contracts.ts";
import { OrchestratorError, type OrchestratorErrorCode } from "./orchestrator-error.ts";

const taskStates = new Set<TaskState>([
  "intake",
  "queued",
  "running",
  "waiting_user",
  "waiting_resource",
  "review",
  "completed",
  "failed",
  "paused",
  "cancelled",
]);
const allowedTaskStateTransitions: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  intake: new Set([
    "queued",
    "running",
    "waiting_user",
    "waiting_resource",
    "review",
    "completed",
    "failed",
    "paused",
    "cancelled",
  ]),
  queued: new Set([
    "running",
    "waiting_user",
    "waiting_resource",
    "review",
    "completed",
    "failed",
    "paused",
    "cancelled",
  ]),
  running: new Set([
    "waiting_user",
    "waiting_resource",
    "review",
    "completed",
    "failed",
    "paused",
    "cancelled",
  ]),
  waiting_user: new Set(["queued", "running", "waiting_resource", "failed", "paused", "cancelled"]),
  waiting_resource: new Set(["queued", "running", "waiting_user", "failed", "paused", "cancelled"]),
  review: new Set([
    "running",
    "waiting_user",
    "waiting_resource",
    "completed",
    "failed",
    "paused",
    "cancelled",
  ]),
  completed: new Set(),
  failed: new Set(),
  paused: new Set(),
  cancelled: new Set(),
};

export function parseAuthorizedForumPost(
  value: unknown,
  code: OrchestratorErrorCode = "FORUM_POST_CONFLICT",
): AuthorizedForumPost {
  const record = requireRecord(value, code, "Forum post");
  return Object.freeze({
    forumId: requireString(record["forumId"], "forumId", code),
    postId: requireString(record["postId"], "postId", code),
    authorId: requireString(record["authorId"], "authorId", code),
    title: requireString(record["title"], "title", code),
    body: requireString(record["body"], "body", code),
    authorizedPrincipalId: requireString(
      record["authorizedPrincipalId"],
      "authorizedPrincipalId",
      code,
    ),
  });
}

export function parseCoordinatorIntakeDecision(value: unknown): CoordinatorIntakeDecision {
  const record = requireRecord(value, "COORDINATOR_INTAKE_INVALID", "Coordinator intake decision");

  if (record["decision"] === "ready") {
    return Object.freeze({
      decision: "ready",
    });
  }
  if (record["decision"] === "clarification") {
    return Object.freeze({
      decision: "clarification",
      clarification: parseClarificationRequest(
        record["clarification"],
        "COORDINATOR_INTAKE_INVALID",
      ),
    });
  }

  throw invalid(
    "COORDINATOR_INTAKE_INVALID",
    "Coordinator intake decision must be ready or clarification.",
  );
}

export function parseCoordinatorDeviceSelection(
  value: unknown,
  expected: {
    readonly taskId: string;
    readonly workOrderId: string;
    readonly eligibleDeviceIds: readonly string[];
  },
): CoordinatorDeviceSelection {
  requireRecord(value, "SCHEDULING_SELECTION_INVALID", "Coordinator Device selection");
  const parsed = parseProtocolBoundary(
    () => parseSemanticDeviceSelectionResponse(value),
    "SCHEDULING_SELECTION_INVALID",
    "Coordinator Device selection",
  );
  if (parsed.taskId !== expected.taskId) {
    throw invalid(
      "SCHEDULING_SELECTION_INVALID",
      `Coordinator Device selection belongs to Task ${parsed.taskId}, expected ${expected.taskId}.`,
    );
  }
  if (parsed.workOrderId !== expected.workOrderId) {
    throw invalid(
      "SCHEDULING_SELECTION_INVALID",
      `Coordinator Device selection belongs to Work Order ${parsed.workOrderId}, expected ${expected.workOrderId}.`,
    );
  }
  if (!expected.eligibleDeviceIds.includes(parsed.preferredDeviceId)) {
    throw invalid(
      "SCHEDULING_SELECTION_INVALID",
      `Coordinator selected Device ${parsed.preferredDeviceId} outside the bounded eligible set.`,
    );
  }
  return Object.freeze({
    protocolVersion: parsed.protocolVersion,
    taskId: parsed.taskId,
    workOrderId: parsed.workOrderId,
    preferredDeviceId: parsed.preferredDeviceId,
  });
}

export function parseClarificationRequest(
  value: unknown,
  code: OrchestratorErrorCode = "JOURNAL_EVENT_INVALID",
): ClarificationRequest {
  const record = requireRecord(value, code, "Clarification request");
  return Object.freeze({
    clarificationId: requireString(record["clarificationId"], "clarificationId", code),
    question: requireString(record["question"], "question", code),
  });
}

export function parseClarificationExchange(
  value: unknown,
  code: OrchestratorErrorCode = "JOURNAL_EVENT_INVALID",
): ClarificationExchange {
  const request = parseClarificationRequest(value, code);
  const record = requireRecord(value, code, "Clarification exchange");
  return Object.freeze({
    ...request,
    answer: requireString(record["answer"], "answer", code),
  });
}

export function parseCoordinatorPlan(
  value: unknown,
  code: OrchestratorErrorCode = "COORDINATOR_PLAN_INVALID",
): CoordinatorPlan {
  const record = requireRecord(value, code, "Coordinator plan");
  const taskBrief = parseTaskBrief(record["taskBrief"], code);
  const rawWorkOrders = record["workOrders"];

  if (!Array.isArray(rawWorkOrders) || rawWorkOrders.length === 0) {
    throw invalid(code, "Coordinator plan must contain at least one Work Order.");
  }

  const workOrders = rawWorkOrders.map((workOrder) => parsePlannedWorkOrder(workOrder, code));
  assertWorkOrderGraph(workOrders, code);

  return Object.freeze({
    taskBrief,
    workOrders: Object.freeze(workOrders),
  });
}

export function parseCoordinatorSynthesis(
  value: unknown,
  code: OrchestratorErrorCode = "COORDINATOR_SYNTHESIS_INVALID",
): CoordinatorSynthesis {
  const record = requireRecord(value, code, "Coordinator synthesis");
  const artifact = requireRecord(record["artifact"], code, "Synthesis Artifact");

  const filename = requireString(artifact["filename"], "artifact.filename", code);
  if (
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  ) {
    throw invalid(code, "Synthesis Artifact filename must be a safe basename.");
  }

  return Object.freeze({
    summary: requireString(record["summary"], "summary", code),
    artifact: Object.freeze({
      filename,
      mediaType: requireString(artifact["mediaType"], "artifact.mediaType", code),
      content: requireString(artifact["content"], "artifact.content", code),
    }),
  });
}

export function parseCoordinatorReview(
  value: unknown,
  taskBrief: TaskBrief,
  code: OrchestratorErrorCode = "COORDINATOR_REVIEW_INVALID",
): CoordinatorReview {
  const record = requireRecord(value, code, "Coordinator review");
  if (record["decision"] !== "complete") {
    throw invalid(code, "Coordinator review must explicitly decide complete.");
  }

  const verifiedCompletionCriteria = parseStringList(
    record["verifiedCompletionCriteria"],
    "verifiedCompletionCriteria",
    code,
    { allowEmpty: false },
  );
  if (
    verifiedCompletionCriteria.length !== taskBrief.completionCriteria.length ||
    verifiedCompletionCriteria.some(
      (criterion) => !taskBrief.completionCriteria.includes(criterion),
    )
  ) {
    throw invalid(
      code,
      "Coordinator review must verify exactly the Task Brief completion criteria.",
    );
  }

  return Object.freeze({
    decision: "complete",
    verifiedCompletionCriteria: Object.freeze([...taskBrief.completionCriteria]),
  });
}

export function parseArtifactReference(
  value: unknown,
  code: OrchestratorErrorCode = "ARTIFACT_REFERENCE_INVALID",
): ArtifactReference {
  const record = requireRecord(value, code, "Artifact reference");
  const parsed = parseProtocolBoundary(
    () =>
      parseProtocolArtifactReference({
        ...record,
        protocolVersion: PROTOCOL_VERSION,
      }),
    code,
    "Artifact reference",
  );
  return Object.freeze({
    artifactId: parsed.artifactId,
    href: parsed.href,
  });
}

export function parseWorkerReport(
  value: unknown,
  code: OrchestratorErrorCode = "JOURNAL_EVENT_INVALID",
): WorkerReport {
  const record = requireRecord(value, code, "Worker report");
  return Object.freeze({
    workOrderId: requireString(record["workOrderId"], "workOrderId", code),
    workerId: requireString(record["workerId"], "workerId", code),
    report: requireString(record["report"], "report", code),
  });
}

const RFC3339_INSTANT_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function parseRfc3339Instant(
  value: unknown,
  field: string,
  code: OrchestratorErrorCode = "RUN_ASSIGNMENT_INVALID",
): { readonly value: string; readonly epochMs: number } {
  if (
    typeof value !== "string" ||
    !RFC3339_INSTANT_PATTERN.test(value) ||
    !hasValidCalendarDate(value)
  ) {
    throw invalid(code, `${field} must be a strict RFC3339 instant.`);
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    throw invalid(code, `${field} must be a finite RFC3339 instant.`);
  }
  return Object.freeze({ value, epochMs });
}

export function parseRunAssignment(
  value: unknown,
  code: OrchestratorErrorCode = "RUN_ASSIGNMENT_INVALID",
): RunAssignment {
  const record = requireRecord(value, code, "Run assignment");
  const expiresAt = parseRfc3339Instant(record["expiresAt"], "expiresAt", code).value;
  const fencingToken = record["fencingToken"];
  if (!Number.isSafeInteger(fencingToken) || (fencingToken as number) <= 0) {
    throw invalid(code, "fencingToken must be a positive safe integer.");
  }

  return Object.freeze({
    taskId: requireString(record["taskId"], "taskId", code),
    workOrderId: requireString(record["workOrderId"], "workOrderId", code),
    deviceId: requireString(record["deviceId"], "deviceId", code),
    workerId: requireString(record["workerId"], "workerId", code),
    routeId: requireString(record["routeId"], "routeId", code),
    runId: requireString(record["runId"], "runId", code),
    idempotencyKey: requireString(record["idempotencyKey"], "idempotencyKey", code),
    leaseId: requireString(record["leaseId"], "leaseId", code),
    fencingToken: fencingToken as number,
    expiresAt,
  });
}

export function parseWorkerRunCompletion(
  value: unknown,
  code: OrchestratorErrorCode = "RUN_COMPLETION_INVALID",
): WorkerRunCompletion {
  const record = { ...requireRecord(value, code, "Worker Run completion") };
  return parseWorkerRunIdentity(record, code);
}

function parseWorkerRunIdentity(
  record: Readonly<Record<string, unknown>>,
  code: OrchestratorErrorCode,
): WorkerRunCompletion {
  const taskId = requireString(record["taskId"], "taskId", code);
  const workOrderId = requireString(record["workOrderId"], "workOrderId", code);
  const deviceId = requireString(record["deviceId"], "deviceId", code);
  const workerId = requireString(record["workerId"], "workerId", code);
  const routeId = requireString(record["routeId"], "routeId", code);
  const runId = requireString(record["runId"], "runId", code);
  const leaseId = requireString(record["leaseId"], "leaseId", code);
  const fencingToken = record["fencingToken"];
  if (!Number.isSafeInteger(fencingToken) || (fencingToken as number) <= 0) {
    throw invalid(code, "fencingToken must be a positive safe integer.");
  }

  return Object.freeze({
    taskId,
    workOrderId,
    deviceId,
    workerId,
    routeId,
    runId,
    leaseId,
    fencingToken: fencingToken as number,
  });
}

export function parseWorkerExecutionResult(value: unknown): WorkerExecutionResult {
  const record = {
    ...requireRecord(value, "RUN_COMPLETION_INVALID", "Worker execution result"),
  };
  const completion = parseWorkerRunIdentity(record, "RUN_COMPLETION_INVALID");
  return Object.freeze({
    ...completion,
    report: requireString(record["report"], "report", "RUN_COMPLETION_INVALID"),
  });
}

export function parseCompletedTaskView(
  value: unknown,
  code: OrchestratorErrorCode = "JOURNAL_EVENT_INVALID",
): CompletedTaskView {
  const record = requireRecord(value, code, "Completed Task view");
  if (record["state"] !== "completed") {
    throw invalid(code, "Completed Task view must have state completed.");
  }

  const taskBrief = parseTaskBrief(record["taskBrief"], code);
  const verifiedCompletionCriteria = parseStringList(
    record["verifiedCompletionCriteria"],
    "verifiedCompletionCriteria",
    code,
    { allowEmpty: false },
  );
  if (
    verifiedCompletionCriteria.length !== taskBrief.completionCriteria.length ||
    verifiedCompletionCriteria.some(
      (criterion, index) => criterion !== taskBrief.completionCriteria[index],
    )
  ) {
    throw invalid(code, "Completed Task view must contain the exact verified completion criteria.");
  }

  const rawWorkOrders = record["workOrders"];
  if (!Array.isArray(rawWorkOrders)) {
    throw invalid(code, "Completed Task workOrders must be an array.");
  }
  const workOrders = rawWorkOrders.map((workOrder) => parseWorkOrderView(workOrder, code));

  const rawArtifactRefs = record["artifactRefs"];
  if (!Array.isArray(rawArtifactRefs) || rawArtifactRefs.length === 0) {
    throw invalid(code, "Completed Task must contain at least one Artifact reference.");
  }
  const artifactRefs = rawArtifactRefs.map((reference) => parseArtifactReference(reference, code));

  const resultProjection = requireRecord(
    record["resultProjection"],
    code,
    "Discord result projection",
  );
  if (resultProjection["kind"] !== "discord-result" || resultProjection["statusTag"] !== "Done") {
    throw invalid(code, "Completed Task Discord projection is invalid.");
  }
  const rawActions = resultProjection["actions"];
  if (!Array.isArray(rawActions) || rawActions.length !== 1) {
    throw invalid(code, "Completed Task must contain one Open report action.");
  }
  const action = requireRecord(rawActions[0], code, "Discord result action");
  if (action["type"] !== "link" || action["label"] !== "Open report") {
    throw invalid(code, "Completed Task Open report action is invalid.");
  }

  const actionHref = parseHttpUrl(action["href"], "actions[0].href", code);
  if (actionHref !== artifactRefs[0]?.href) {
    throw invalid(code, "Completed Task Open report action must reference its primary Artifact.");
  }

  return deepFreeze({
    taskId: requireString(record["taskId"], "taskId", code),
    state: "completed",
    stateHistory: parseTaskStateHistory(record["stateHistory"], code),
    taskBrief,
    verifiedCompletionCriteria,
    workOrders,
    resultProjection: {
      kind: "discord-result",
      statusTag: "Done",
      content: requireString(resultProjection["content"], "content", code),
      actions: [
        {
          type: "link",
          label: "Open report",
          href: actionHref,
        },
      ],
    },
    artifactRefs,
  } satisfies CompletedTaskView);
}

export function cloneTaskView<TView extends TaskView>(view: TView): TView {
  return deepFreeze(structuredClone(view));
}

export function fingerprintPlannedWorkOrder(workOrder: PlannedWorkOrder): string {
  return JSON.stringify({
    workOrderId: workOrder.workOrderId,
    title: workOrder.title,
    brief: workOrder.brief,
    completionCriteria: workOrder.completionCriteria,
    constraints: workOrder.constraints,
    selectedInputIds: workOrder.selectedInputIds,
    dependsOn: workOrder.dependsOn,
    schedulingHints: workOrder.schedulingHints,
    requiredCapabilities: workOrder.requiredCapabilities,
    requiredSecretRefs: workOrder.requiredSecretRefs,
    requiredAgent: workOrder.requiredAgent ?? null,
    requiredOsFamily: workOrder.requiredOsFamily ?? null,
    workspaceId: workOrder.workspaceId ?? null,
  });
}

export function fingerprintArtifactContent(artifact: ArtifactContent): string {
  return JSON.stringify({
    filename: artifact.filename,
    mediaType: artifact.mediaType,
    content: artifact.content,
  });
}

export function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function parseTaskBrief(value: unknown, code: OrchestratorErrorCode): TaskBrief {
  const record = requireRecord(value, code, "Task Brief");
  return Object.freeze({
    objective: requireString(record["objective"], "taskBrief.objective", code),
    completionCriteria: parseStringList(
      record["completionCriteria"],
      "taskBrief.completionCriteria",
      code,
      { allowEmpty: false },
    ),
    constraints: parseStringList(record["constraints"], "taskBrief.constraints", code),
    knownInputIds: parseStringList(record["knownInputIds"], "taskBrief.knownInputIds", code),
    decisions: parseStringList(record["decisions"], "taskBrief.decisions", code),
    openQuestions: parseStringList(record["openQuestions"], "taskBrief.openQuestions", code),
  });
}

function hasValidCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  return daysInMonth !== undefined && day <= daysInMonth;
}

function parsePlannedWorkOrder(value: unknown, code: OrchestratorErrorCode): PlannedWorkOrder {
  const record = requireRecord(value, code, "Planned Work Order");
  const parsed = parseProtocolBoundary(
    () =>
      parseProtocolWorkOrder({
        ...record,
        protocolVersion: PROTOCOL_VERSION,
      }),
    code,
    "Planned Work Order",
  );
  const { protocolVersion, ...workOrder } = parsed;
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw invalid(code, "Planned Work Order uses an unsupported protocol version.");
  }
  return deepFreeze(workOrder);
}

function assertWorkOrderGraph(
  workOrders: readonly PlannedWorkOrder[],
  code: OrchestratorErrorCode,
): void {
  const identifiers = new Set(workOrders.map((workOrder) => workOrder.workOrderId));
  if (identifiers.size !== workOrders.length) {
    throw invalid(code, "Coordinator plan contains duplicate Work Order IDs.");
  }

  for (const workOrder of workOrders) {
    if (
      workOrder.dependsOn.includes(workOrder.workOrderId) ||
      workOrder.dependsOn.some((dependencyId) => !identifiers.has(dependencyId))
    ) {
      throw invalid(code, `Work Order ${workOrder.workOrderId} has an invalid dependency.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(workOrders.map((workOrder) => [workOrder.workOrderId, workOrder] as const));
  const visit = (workOrderId: string): void => {
    if (visiting.has(workOrderId)) {
      throw invalid(code, "Coordinator plan contains a Work Order dependency cycle.");
    }
    if (visited.has(workOrderId)) {
      return;
    }
    visiting.add(workOrderId);
    for (const dependencyId of byId.get(workOrderId)?.dependsOn ?? []) {
      visit(dependencyId);
    }
    visiting.delete(workOrderId);
    visited.add(workOrderId);
  };

  for (const workOrder of workOrders) {
    visit(workOrder.workOrderId);
  }
}

function parseWorkOrderView(value: unknown, code: OrchestratorErrorCode): WorkOrderView {
  const report = parseWorkerReport(value, code);
  const record = requireRecord(value, code, "Work Order view");
  if (record["state"] !== "succeeded") {
    throw invalid(code, "Completed Task Work Orders must have state succeeded.");
  }
  return Object.freeze({
    ...report,
    state: "succeeded",
  });
}

function parseTaskStateHistory(value: unknown, code: OrchestratorErrorCode): readonly TaskState[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(code, "Task stateHistory must be a non-empty array.");
  }
  const states = value.map((state) => {
    if (typeof state !== "string" || !taskStates.has(state as TaskState)) {
      throw invalid(code, "Task stateHistory contains an invalid Task state.");
    }
    return state as TaskState;
  });
  if (states.at(-1) !== "completed") {
    throw invalid(code, "Completed Task stateHistory must end in completed.");
  }
  if (states[0] !== "intake" || !states.includes("running") || !states.includes("review")) {
    throw invalid(code, "Completed Task stateHistory must include intake, running, and review.");
  }
  if (states.at(-2) !== "review") {
    throw invalid(
      code,
      "Completed Task stateHistory must complete directly from its final review.",
    );
  }
  for (let index = 1; index < states.length; index += 1) {
    const previous = states[index - 1];
    const current = states[index];
    if (
      previous === undefined ||
      current === undefined ||
      !allowedTaskStateTransitions[previous].has(current)
    ) {
      throw invalid(code, "Task stateHistory contains an invalid lifecycle transition.");
    }
  }
  return Object.freeze(states);
}

function parseStringList(
  value: unknown,
  field: string,
  code: OrchestratorErrorCode,
  options: { readonly allowEmpty?: boolean } = {},
): readonly string[] {
  if (!Array.isArray(value) || (options.allowEmpty === false && value.length === 0)) {
    throw invalid(
      code,
      `${field} must be a${options.allowEmpty === false ? " non-empty" : "n"} array.`,
    );
  }
  const values = value.map((item) => requireString(item, field, code));
  if (new Set(values).size !== values.length) {
    throw invalid(code, `${field} must not contain duplicates.`);
  }
  return Object.freeze(values);
}

function requireRecord(
  value: unknown,
  code: OrchestratorErrorCode,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(code, `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, code: OrchestratorErrorCode): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw invalid(code, `${field} must be a non-blank string.`);
  }
  return value;
}

function parseHttpUrl(value: unknown, field: string, code: OrchestratorErrorCode): string {
  const text = requireString(value, field, code);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid(code, `${field} must be a valid HTTP(S) URL.`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    throw invalid(code, `${field} must be a valid HTTP(S) URL.`);
  }
  return text;
}

function invalid(code: OrchestratorErrorCode, message: string): OrchestratorError {
  return new OrchestratorError(code, message);
}

function parseProtocolBoundary<TValue>(
  parse: () => TValue,
  code: OrchestratorErrorCode,
  label: string,
): TValue {
  try {
    return parse();
  } catch (error: unknown) {
    if (error instanceof ProtocolValidationError) {
      throw invalid(code, `${label} is invalid at ${error.path}: ${error.message}`);
    }
    throw error;
  }
}
