import { createHash } from "node:crypto";

import { ProtocolValidationError } from "./validation.ts";

export const TASK_CONTINUATION_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const TASK_CONTINUATION_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const TASK_CONTINUATION_CHECKPOINT_LIMITS = Object.freeze({
  decisions: 64,
  pendingWorkOrders: 24,
  artifacts: 128,
  messages: 32,
  sessions: 64,
  completionCriteria: 64,
  constraints: 64,
  workOrderCompletionCriteria: 16,
  workOrderConstraints: 16,
  workOrderDependencies: 32,
  workOrderCapabilities: 32,
});

export type TaskContinuationCheckpointStateV1 =
  | "intake"
  | "queued"
  | "waiting_user"
  | "waiting_resource"
  | "running"
  | "review"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export interface TaskContinuationCheckpointSummaryV1 {
  readonly state: TaskContinuationCheckpointStateV1;
  readonly mode: "auto" | "manual";
  readonly objective: string;
  readonly rollingSummary: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
}

export interface TaskContinuationDecisionV1 {
  readonly decisionId: string;
  readonly kind: "approval" | "command" | "criterion-verified";
  readonly outcome: string;
  readonly occurredAt: string;
}

export interface TaskContinuationPendingWorkOrderV1 {
  readonly workOrderId: string;
  readonly title: string;
  readonly brief: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly dependsOn: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly omitted: {
    readonly completionCriteria: number;
    readonly constraints: number;
    readonly dependsOn: number;
    readonly requiredCapabilities: number;
  };
  readonly requiredAgent?: {
    readonly provider: "claude" | "codex" | "generic";
    readonly adapterId?: string;
    readonly allowedCompatibilities?: readonly ("compatible" | "tested" | "untested")[];
  };
  readonly requiredOsFamily?: "macos" | "windows" | "linux";
  readonly workspaceId?: string;
}

export interface TaskContinuationArtifactV1 {
  readonly artifactId: string;
  readonly source: "selected-input" | "worker-report";
  readonly workOrderId?: string;
}

export interface TaskContinuationMessageV1 {
  readonly messageId: string;
  readonly role: "owner" | "agent";
  readonly content: string;
  readonly occurredAt: string;
}

export interface TaskContinuationNativeSessionV1 {
  readonly scope: "coordinator" | "worker";
  readonly deviceId: string;
  readonly provider: "claude" | "codex" | "generic";
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly nativeSessionId: string;
  readonly workstreamId: string;
  readonly workspaceId: string;
  readonly workOrderId?: string;
  readonly lineage: {
    readonly lineageId: string;
    readonly parentNativeSessionId?: string;
    readonly continuationReason?: string;
  };
}

export interface TaskContinuationOmittedCountsV1 {
  readonly completionCriteria: number;
  readonly constraints: number;
  readonly decisions: number;
  readonly pendingWorkOrders: number;
  readonly artifacts: number;
  readonly messages: number;
  readonly sessions: number;
}

export interface TaskContinuationCheckpointBodyV1 {
  readonly schemaVersion: typeof TASK_CONTINUATION_CHECKPOINT_SCHEMA_VERSION;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly summary: TaskContinuationCheckpointSummaryV1;
  readonly decisions: readonly TaskContinuationDecisionV1[];
  readonly pendingWorkOrders: readonly TaskContinuationPendingWorkOrderV1[];
  readonly artifacts: readonly TaskContinuationArtifactV1[];
  readonly messages: readonly TaskContinuationMessageV1[];
  readonly sessions: readonly TaskContinuationNativeSessionV1[];
  readonly omitted: TaskContinuationOmittedCountsV1;
}

export interface TaskContinuationCheckpointV1 extends TaskContinuationCheckpointBodyV1 {
  readonly checkpointHash: `sha256:${string}`;
}

const TASK_STATES = new Set<TaskContinuationCheckpointStateV1>([
  "intake",
  "queued",
  "waiting_user",
  "waiting_resource",
  "running",
  "review",
  "completed",
  "failed",
  "paused",
  "cancelled",
]);
const DECISION_KINDS = new Set<TaskContinuationDecisionV1["kind"]>([
  "approval",
  "command",
  "criterion-verified",
]);
const SESSION_PROVIDERS = new Set<TaskContinuationNativeSessionV1["provider"]>([
  "claude",
  "codex",
  "generic",
]);
const RFC3339_INSTANT =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const SHA256_ID = /^sha256:[0-9a-f]{64}$/u;
const FILE_LOCAL_PATH =
  /\bfile:\/\/\/(?:[a-z]:[\\/]|(?:Users|home|root|var|tmp|private|etc|opt|srv|mnt|Volumes)[\\/])[^\s"'`<>]*/giu;
const WINDOWS_LOCAL_PATH =
  /(^|[\s("'`])(?:[a-z]:[\\/]|(?:\\\\|\/\/)(?:localhost|127(?:\.\d{1,3}){3}|[a-z0-9._-]+)[\\/])[^\s"'`<>]*/giu;
const POSIX_LOCAL_PATH =
  /(^|[\s("'`])\/(?:Users|home|root|var|tmp|private|etc|opt|srv|mnt|Volumes)\/[^\s"'`<>]*/gu;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/giu;
const CONTEXTUAL_CREDENTIAL =
  /((?:api[-_ ]?key|authorization|credential|password|passwd|private[-_ ]?key|secret|token)\s*(?::|=|\bis\b)\s*)(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s,;}]{8,})/giu;
const URL_CREDENTIAL = /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/giu;

export function createTaskContinuationCheckpoint(
  input: TaskContinuationCheckpointBodyV1,
): TaskContinuationCheckpointV1 {
  const body = validateBody(input);
  const checkpointHash = checkpointDigest(body);
  return validateTaskContinuationCheckpoint({
    ...body,
    checkpointHash,
  });
}

export function validateTaskContinuationCheckpoint(input: unknown): TaskContinuationCheckpointV1 {
  const record = exactRecord(input, [
    "schemaVersion",
    "taskId",
    "taskVersion",
    "summary",
    "decisions",
    "pendingWorkOrders",
    "artifacts",
    "messages",
    "sessions",
    "omitted",
    "checkpointHash",
  ]);
  const body = validateBody({
    schemaVersion: record["schemaVersion"] as 1,
    taskId: record["taskId"] as string,
    taskVersion: record["taskVersion"] as number,
    summary: record["summary"] as TaskContinuationCheckpointSummaryV1,
    decisions: record["decisions"] as readonly TaskContinuationDecisionV1[],
    pendingWorkOrders: record["pendingWorkOrders"] as readonly TaskContinuationPendingWorkOrderV1[],
    artifacts: record["artifacts"] as readonly TaskContinuationArtifactV1[],
    messages: record["messages"] as readonly TaskContinuationMessageV1[],
    sessions: record["sessions"] as readonly TaskContinuationNativeSessionV1[],
    omitted: record["omitted"] as TaskContinuationOmittedCountsV1,
  });
  if (typeof record["checkpointHash"] !== "string" || !SHA256_ID.test(record["checkpointHash"])) {
    invalid("checkpointHash", "Expected a canonical SHA-256 checkpoint hash.");
  }
  const expected = checkpointDigest(body);
  if (record["checkpointHash"] !== expected) {
    invalid("checkpointHash", "The checkpoint hash does not match its canonical body.");
  }
  const checkpoint = deepFreeze({
    ...body,
    checkpointHash: expected,
  });
  if (
    Buffer.byteLength(canonicalJson(checkpoint), "utf8") > TASK_CONTINUATION_CHECKPOINT_MAX_BYTES
  ) {
    invalid("", "The continuation checkpoint exceeds its strict byte limit.");
  }
  return checkpoint;
}

export function serializeTaskContinuationCheckpoint(input: TaskContinuationCheckpointV1): string {
  return canonicalJson(validateTaskContinuationCheckpoint(input));
}

/**
 * Checkpoint text is public Task context, but it still crosses a Device boundary.
 * This deterministic final guard removes common raw credential forms and local
 * filesystem paths. Product code should also keep its existing exact-secret guard
 * upstream; this function is a last boundary, not a Secret Store.
 */
export function sanitizeTaskContinuationText(input: string): string {
  let output = input;
  output = output.replace(PRIVATE_KEY_BLOCK, "[credential-redacted]");
  output = output.replace(BEARER_CREDENTIAL, "Bearer [credential-redacted]");
  output = output.replace(CONTEXTUAL_CREDENTIAL, "$1[credential-redacted]");
  output = output.replace(URL_CREDENTIAL, "[credential-redacted-url]");
  output = output.replace(FILE_LOCAL_PATH, "[local-path-redacted]");
  output = output.replace(WINDOWS_LOCAL_PATH, "$1[local-path-redacted]");
  output = output.replace(POSIX_LOCAL_PATH, "$1[local-path-redacted]");
  return output;
}

function validateBody(input: TaskContinuationCheckpointBodyV1): TaskContinuationCheckpointBodyV1 {
  const record = exactRecord(input, [
    "schemaVersion",
    "taskId",
    "taskVersion",
    "summary",
    "decisions",
    "pendingWorkOrders",
    "artifacts",
    "messages",
    "sessions",
    "omitted",
  ]);
  if (record["schemaVersion"] !== TASK_CONTINUATION_CHECKPOINT_SCHEMA_VERSION) {
    invalid("schemaVersion", "Unsupported continuation checkpoint schema.");
  }
  const taskId = identifier(record["taskId"], "taskId");
  const taskVersion = positiveInteger(record["taskVersion"], "taskVersion");
  const summary = validateSummary(record["summary"]);
  const decisions = boundedArray(
    record["decisions"],
    TASK_CONTINUATION_CHECKPOINT_LIMITS.decisions,
    "decisions",
    validateDecision,
  );
  const pendingWorkOrders = boundedArray(
    record["pendingWorkOrders"],
    TASK_CONTINUATION_CHECKPOINT_LIMITS.pendingWorkOrders,
    "pendingWorkOrders",
    validatePendingWorkOrder,
  );
  const artifacts = boundedArray(
    record["artifacts"],
    TASK_CONTINUATION_CHECKPOINT_LIMITS.artifacts,
    "artifacts",
    validateArtifact,
  );
  const messages = boundedArray(
    record["messages"],
    TASK_CONTINUATION_CHECKPOINT_LIMITS.messages,
    "messages",
    validateMessage,
  );
  const sessions = boundedArray(
    record["sessions"],
    TASK_CONTINUATION_CHECKPOINT_LIMITS.sessions,
    "sessions",
    validateSession,
  );
  const omitted = validateOmitted(record["omitted"]);
  assertUnique(
    decisions.map((decision) => decision.decisionId),
    "decisions",
  );
  assertUnique(
    pendingWorkOrders.map((workOrder) => workOrder.workOrderId),
    "pendingWorkOrders",
  );
  assertUnique(
    artifacts.map(
      (artifact) =>
        `${artifact.source}\u0000${artifact.workOrderId ?? ""}\u0000${artifact.artifactId}`,
    ),
    "artifacts",
  );
  assertUnique(
    messages.map((message) => message.messageId),
    "messages",
  );
  assertUnique(
    sessions.map(
      (session) =>
        `${session.scope}\u0000${session.deviceId}\u0000${session.workstreamId}\u0000${session.nativeSessionId}`,
    ),
    "sessions",
  );
  if (
    sessions.some((session) =>
      session.scope === "coordinator"
        ? session.workOrderId !== undefined
        : session.workOrderId === undefined,
    )
  ) {
    invalid("sessions", "Session scope and Work Order identity are inconsistent.");
  }
  return deepFreeze({
    schemaVersion: TASK_CONTINUATION_CHECKPOINT_SCHEMA_VERSION,
    taskId,
    taskVersion,
    summary,
    decisions,
    pendingWorkOrders,
    artifacts,
    messages,
    sessions,
    omitted,
  });
}

function validateSummary(input: unknown): TaskContinuationCheckpointSummaryV1 {
  const record = exactRecord(input, [
    "state",
    "mode",
    "objective",
    "rollingSummary",
    "completionCriteria",
    "constraints",
  ]);
  if (typeof record["state"] !== "string" || !TASK_STATES.has(record["state"] as never)) {
    invalid("summary.state", "The Task state is invalid.");
  }
  if (record["mode"] !== "auto" && record["mode"] !== "manual") {
    invalid("summary.mode", "The Task mode is invalid.");
  }
  return deepFreeze({
    state: record["state"] as TaskContinuationCheckpointStateV1,
    mode: record["mode"],
    objective: publicText(record["objective"], "summary.objective", 8_192),
    rollingSummary: publicText(record["rollingSummary"], "summary.rollingSummary", 8_192),
    completionCriteria: textArray(
      record["completionCriteria"],
      TASK_CONTINUATION_CHECKPOINT_LIMITS.completionCriteria,
      "summary.completionCriteria",
      2_048,
    ),
    constraints: textArray(
      record["constraints"],
      TASK_CONTINUATION_CHECKPOINT_LIMITS.constraints,
      "summary.constraints",
      2_048,
    ),
  });
}

function validateDecision(input: unknown, index: number): TaskContinuationDecisionV1 {
  const path = `decisions[${String(index)}]`;
  const record = exactRecord(input, ["decisionId", "kind", "outcome", "occurredAt"], path);
  if (typeof record["kind"] !== "string" || !DECISION_KINDS.has(record["kind"] as never)) {
    invalid(`${path}.kind`, "The decision kind is invalid.");
  }
  return deepFreeze({
    decisionId: identifier(record["decisionId"], `${path}.decisionId`),
    kind: record["kind"] as TaskContinuationDecisionV1["kind"],
    outcome: publicText(record["outcome"], `${path}.outcome`, 2_048),
    occurredAt: instant(record["occurredAt"], `${path}.occurredAt`),
  });
}

function validatePendingWorkOrder(
  input: unknown,
  index: number,
): TaskContinuationPendingWorkOrderV1 {
  const path = `pendingWorkOrders[${String(index)}]`;
  const record = optionalExactRecord(
    input,
    [
      "workOrderId",
      "title",
      "brief",
      "completionCriteria",
      "constraints",
      "dependsOn",
      "requiredCapabilities",
      "omitted",
    ],
    ["requiredAgent", "requiredOsFamily", "workspaceId"],
    path,
  );
  return deepFreeze({
    workOrderId: identifier(record["workOrderId"], `${path}.workOrderId`),
    title: publicText(record["title"], `${path}.title`, 1_024),
    brief: publicText(record["brief"], `${path}.brief`, 4_096),
    completionCriteria: textArray(
      record["completionCriteria"],
      TASK_CONTINUATION_CHECKPOINT_LIMITS.workOrderCompletionCriteria,
      `${path}.completionCriteria`,
      1_024,
    ),
    constraints: textArray(
      record["constraints"],
      TASK_CONTINUATION_CHECKPOINT_LIMITS.workOrderConstraints,
      `${path}.constraints`,
      1_024,
    ),
    dependsOn: identifierArray(
      record["dependsOn"],
      TASK_CONTINUATION_CHECKPOINT_LIMITS.workOrderDependencies,
      `${path}.dependsOn`,
    ),
    requiredCapabilities: identifierArray(
      record["requiredCapabilities"],
      TASK_CONTINUATION_CHECKPOINT_LIMITS.workOrderCapabilities,
      `${path}.requiredCapabilities`,
    ),
    omitted: validateWorkOrderOmitted(record["omitted"], `${path}.omitted`),
    ...(record["requiredAgent"] === undefined
      ? {}
      : { requiredAgent: validateRequiredAgent(record["requiredAgent"], `${path}.requiredAgent`) }),
    ...(record["requiredOsFamily"] === undefined
      ? {}
      : {
          requiredOsFamily: osFamily(record["requiredOsFamily"], `${path}.requiredOsFamily`),
        }),
    ...(record["workspaceId"] === undefined
      ? {}
      : { workspaceId: identifier(record["workspaceId"], `${path}.workspaceId`) }),
  });
}

function validateRequiredAgent(
  input: unknown,
  path: string,
): NonNullable<TaskContinuationPendingWorkOrderV1["requiredAgent"]> {
  const record = optionalExactRecord(
    input,
    ["provider"],
    ["adapterId", "allowedCompatibilities"],
    path,
  );
  if (
    typeof record["provider"] !== "string" ||
    !SESSION_PROVIDERS.has(record["provider"] as never)
  ) {
    invalid(`${path}.provider`, "The required Agent provider is invalid.");
  }
  let allowedCompatibilities: readonly ("compatible" | "tested" | "untested")[] | undefined;
  if (record["allowedCompatibilities"] !== undefined) {
    if (
      !Array.isArray(record["allowedCompatibilities"]) ||
      record["allowedCompatibilities"].length === 0 ||
      record["allowedCompatibilities"].length > 3 ||
      new Set(record["allowedCompatibilities"]).size !== record["allowedCompatibilities"].length ||
      record["allowedCompatibilities"].some(
        (value) => value !== "compatible" && value !== "tested" && value !== "untested",
      )
    ) {
      invalid(`${path}.allowedCompatibilities`, "The compatibility set is invalid.");
    }
    allowedCompatibilities = Object.freeze([
      ...(record["allowedCompatibilities"] as ("compatible" | "tested" | "untested")[]),
    ]);
  }
  return deepFreeze({
    provider: record["provider"] as "claude" | "codex" | "generic",
    ...(record["adapterId"] === undefined
      ? {}
      : { adapterId: identifier(record["adapterId"], `${path}.adapterId`) }),
    ...(allowedCompatibilities === undefined ? {} : { allowedCompatibilities }),
  });
}

function validateArtifact(input: unknown, index: number): TaskContinuationArtifactV1 {
  const path = `artifacts[${String(index)}]`;
  const record = optionalExactRecord(input, ["artifactId", "source"], ["workOrderId"], path);
  if (record["source"] !== "selected-input" && record["source"] !== "worker-report") {
    invalid(`${path}.source`, "The Artifact source is invalid.");
  }
  if ((record["source"] === "worker-report") !== (record["workOrderId"] !== undefined)) {
    invalid(path, "Worker-report Artifacts require exactly one Work Order identity.");
  }
  return deepFreeze({
    artifactId: identifier(record["artifactId"], `${path}.artifactId`),
    source: record["source"],
    ...(record["workOrderId"] === undefined
      ? {}
      : { workOrderId: identifier(record["workOrderId"], `${path}.workOrderId`) }),
  });
}

function validateMessage(input: unknown, index: number): TaskContinuationMessageV1 {
  const path = `messages[${String(index)}]`;
  const record = exactRecord(input, ["messageId", "role", "content", "occurredAt"], path);
  if (record["role"] !== "owner" && record["role"] !== "agent") {
    invalid(`${path}.role`, "The public message role is invalid.");
  }
  return deepFreeze({
    messageId: identifier(record["messageId"], `${path}.messageId`),
    role: record["role"],
    content: publicText(record["content"], `${path}.content`, 8_192),
    occurredAt: instant(record["occurredAt"], `${path}.occurredAt`),
  });
}

function validateSession(input: unknown, index: number): TaskContinuationNativeSessionV1 {
  const path = `sessions[${String(index)}]`;
  const record = optionalExactRecord(
    input,
    [
      "scope",
      "deviceId",
      "provider",
      "adapterId",
      "adapterVersion",
      "nativeSessionId",
      "workstreamId",
      "workspaceId",
      "lineage",
    ],
    ["workOrderId"],
    path,
  );
  if (record["scope"] !== "coordinator" && record["scope"] !== "worker") {
    invalid(`${path}.scope`, "The native-session scope is invalid.");
  }
  if (
    typeof record["provider"] !== "string" ||
    !SESSION_PROVIDERS.has(record["provider"] as never)
  ) {
    invalid(`${path}.provider`, "The native-session provider is invalid.");
  }
  const lineage = optionalExactRecord(
    record["lineage"],
    ["lineageId"],
    ["parentNativeSessionId", "continuationReason"],
    `${path}.lineage`,
  );
  if (
    (lineage["parentNativeSessionId"] === undefined) !==
    (lineage["continuationReason"] === undefined)
  ) {
    invalid(`${path}.lineage`, "Continuation lineage is incomplete.");
  }
  return deepFreeze({
    scope: record["scope"],
    deviceId: identifier(record["deviceId"], `${path}.deviceId`),
    provider: record["provider"] as TaskContinuationNativeSessionV1["provider"],
    adapterId: identifier(record["adapterId"], `${path}.adapterId`),
    adapterVersion: identifier(record["adapterVersion"], `${path}.adapterVersion`),
    nativeSessionId: identifier(record["nativeSessionId"], `${path}.nativeSessionId`),
    workstreamId: identifier(record["workstreamId"], `${path}.workstreamId`),
    workspaceId: identifier(record["workspaceId"], `${path}.workspaceId`),
    ...(record["workOrderId"] === undefined
      ? {}
      : { workOrderId: identifier(record["workOrderId"], `${path}.workOrderId`) }),
    lineage: deepFreeze({
      lineageId: identifier(lineage["lineageId"], `${path}.lineage.lineageId`),
      ...(lineage["parentNativeSessionId"] === undefined
        ? {}
        : {
            parentNativeSessionId: identifier(
              lineage["parentNativeSessionId"],
              `${path}.lineage.parentNativeSessionId`,
            ),
            continuationReason: identifier(
              lineage["continuationReason"],
              `${path}.lineage.continuationReason`,
            ),
          }),
    }),
  });
}

function validateOmitted(input: unknown): TaskContinuationOmittedCountsV1 {
  const record = exactRecord(input, [
    "completionCriteria",
    "constraints",
    "decisions",
    "pendingWorkOrders",
    "artifacts",
    "messages",
    "sessions",
  ]);
  return deepFreeze({
    completionCriteria: nonNegativeInteger(
      record["completionCriteria"],
      "omitted.completionCriteria",
    ),
    constraints: nonNegativeInteger(record["constraints"], "omitted.constraints"),
    decisions: nonNegativeInteger(record["decisions"], "omitted.decisions"),
    pendingWorkOrders: nonNegativeInteger(record["pendingWorkOrders"], "omitted.pendingWorkOrders"),
    artifacts: nonNegativeInteger(record["artifacts"], "omitted.artifacts"),
    messages: nonNegativeInteger(record["messages"], "omitted.messages"),
    sessions: nonNegativeInteger(record["sessions"], "omitted.sessions"),
  });
}

function validateWorkOrderOmitted(
  input: unknown,
  path: string,
): TaskContinuationPendingWorkOrderV1["omitted"] {
  const record = exactRecord(
    input,
    ["completionCriteria", "constraints", "dependsOn", "requiredCapabilities"],
    path,
  );
  return deepFreeze({
    completionCriteria: nonNegativeInteger(
      record["completionCriteria"],
      `${path}.completionCriteria`,
    ),
    constraints: nonNegativeInteger(record["constraints"], `${path}.constraints`),
    dependsOn: nonNegativeInteger(record["dependsOn"], `${path}.dependsOn`),
    requiredCapabilities: nonNegativeInteger(
      record["requiredCapabilities"],
      `${path}.requiredCapabilities`,
    ),
  });
}

function publicText(value: unknown, path: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    sanitizeTaskContinuationText(value) !== value
  ) {
    invalid(path, "Expected bounded public text without credentials or local paths.");
  }
  return value;
}

function textArray(
  value: unknown,
  maximumItems: number,
  path: string,
  maximumItemBytes: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    invalid(path, "The bounded text list is invalid.");
  }
  const output = value.map((item, index) =>
    publicText(item, `${path}[${String(index)}]`, maximumItemBytes),
  );
  assertUnique(output, path);
  return Object.freeze(output);
}

function identifierArray(value: unknown, maximumItems: number, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    invalid(path, "The bounded identifier list is invalid.");
  }
  const output = value.map((item, index) => identifier(item, `${path}[${String(index)}]`));
  assertUnique(output, path);
  return Object.freeze(output);
}

function boundedArray<T>(
  value: unknown,
  maximumItems: number,
  path: string,
  parser: (item: unknown, index: number) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    invalid(path, "The bounded continuation list is invalid.");
  }
  return Object.freeze(value.map(parser));
}

function exactRecord(input: unknown, keys: readonly string[], path = ""): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    invalid(path, "Expected an object.");
  }
  const record = input as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    invalid(path, "The continuation object has an unexpected shape.");
  }
  return record;
}

function optionalExactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    invalid(path, "Expected an object.");
  }
  const record = input as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    invalid(path, "The continuation object has an unexpected shape.");
  }
  return record;
}

function identifier(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    sanitizeTaskContinuationText(value) !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    invalid(path, "Expected a bounded opaque identifier.");
  }
  return value;
}

function instant(value: unknown, path: string): string {
  if (typeof value !== "string" || !RFC3339_INSTANT.test(value)) {
    invalid(path, "Expected an RFC 3339 instant.");
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(path, "Expected a positive safe integer.");
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(path, "Expected a non-negative safe integer.");
  }
  return Number(value);
}

function osFamily(value: unknown, path: string): "macos" | "windows" | "linux" {
  if (value !== "macos" && value !== "windows" && value !== "linux") {
    invalid(path, "The required OS family is invalid.");
  }
  return value;
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    invalid(path, "The continuation list contains duplicate identities.");
  }
}

function checkpointDigest(body: TaskContinuationCheckpointBodyV1): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(body), "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalid(path: string, message: string): never {
  throw new ProtocolValidationError("INVALID_CONTRACT", path, message);
}
