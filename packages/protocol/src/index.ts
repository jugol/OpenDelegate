import type { OsFamily } from "@opendelegate/domain";
import type { TaskContinuationCheckpointV1 } from "./task-continuation-checkpoint.ts";
import { PROTOCOL_VERSION, ProtocolValidationError } from "./validation.ts";

export * from "./http/v1/index.ts";
export * from "./artifact-upload.ts";
export * from "./task-continuation-checkpoint.ts";
export {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  type ProtocolValidationErrorCode,
} from "./validation.ts";

export interface ForumTaskIntakeV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly forumId: string;
  readonly postId: string;
  readonly authorId: string;
  readonly title: string;
  readonly body: string;
}

export interface WorkOrderV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly workOrderId: string;
  readonly title: string;
  readonly brief: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly selectedInputIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly schedulingHints: WorkOrderSchedulingHintsV1;
  readonly requiredCapabilities: readonly string[];
  readonly requiredSecretRefs: readonly string[];
  /**
   * Optional semantic requirement chosen by the Main coordinator. Main copies
   * this value into the immutable Run assignment before dispatch.
   */
  readonly requiredAgent?: WorkerAgentRequirementV1;
  readonly budgetLimits?: WorkOrderBudgetLimitsV1;
  readonly requiredOsFamily?: OsFamily;
  readonly workspaceId?: string;
}

export interface WorkOrderSchedulingHintsV1 {
  readonly preferredDeviceIds: readonly string[];
  readonly preferredRoles: readonly string[];
}

export type WorkOrderBudgetMetricV1 =
  | "wallTimeMs"
  | "idleTimeMs"
  | "retries"
  | "childWorkOrders"
  | "concurrentRuns"
  | "nativeTurns"
  | "tokens"
  | "costUsdMicros";

export interface WorkOrderBudgetLimitV1 {
  readonly soft?: number;
  readonly hard: number;
}

export type WorkOrderBudgetLimitsV1 = Partial<
  Record<WorkOrderBudgetMetricV1, WorkOrderBudgetLimitV1>
>;

export type RedactedDiagnosticV1 =
  | boolean
  | number
  | string
  | null
  | readonly RedactedDiagnosticV1[]
  | { readonly [key: string]: RedactedDiagnosticV1 };

export type WorkerAgentProviderV1 = "claude" | "codex" | "generic";
export type WorkerAgentCompatibilityV1 = "compatible" | "tested" | "untested";

/**
 * A deterministic provider constraint. Omitting `allowedCompatibilities`
 * means tested-only; incompatible adapters can never be authorized.
 */
export interface WorkerAgentRequirementV1 {
  readonly provider: WorkerAgentProviderV1;
  readonly adapterId?: string;
  readonly modelId?: string;
  /** Provider tuning pinned alongside the model, when the provider exposes it. */
  readonly effort?: string;
  readonly allowedCompatibilities?: readonly WorkerAgentCompatibilityV1[];
}

export interface WorkerRunAssignmentV1 {
  readonly taskId: string;
  readonly workOrder: WorkOrderV1;
  readonly continuationCheckpoint?: TaskContinuationCheckpointV1;
  readonly agentRequirement?: WorkerAgentRequirementV1;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs: number;
}

export interface WorkerRunIdentityV1 {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
}

export interface WorkerProviderUsageV1 {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costUsdMicros?: number;
}

export interface WorkerAgentSessionObservationV1 {
  readonly provider: WorkerAgentProviderV1;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly modelId?: string;
  /** The effective provider tuning the session actually ran with. */
  readonly effort?: string;
  readonly nativeSessionId: string;
  readonly workstreamId: string;
  readonly workspaceId: string;
  /**
   * Deliberately excludes Device-local cwd, worktreePath, and sessionKey.
   */
  readonly lineage: {
    readonly lineageId: string;
    readonly parentNativeSessionId?: string;
    readonly continuationReason?: string;
  };
}

export type WorkerOutboundEventTypeV1 =
  | "worker.run.cancelled"
  | "worker.run.claimed"
  | "worker.run.failed"
  | "worker.run.progress"
  | "worker.run.rejected"
  | "worker.run.succeeded";

export interface WorkerOutboundEventV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly messageId: string;
  readonly senderDeviceId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly type: WorkerOutboundEventTypeV1;
  readonly payload: WorkerRunIdentityV1 & {
    readonly report?: string;
    readonly artifactIds?: readonly string[];
    readonly diagnostic?: RedactedDiagnosticV1;
    readonly usage?: WorkerProviderUsageV1;
    readonly agentSession?: WorkerAgentSessionObservationV1;
  };
}

export interface SequencedWorkerEventV1 extends WorkerOutboundEventV1 {
  readonly sequence: number;
}

export interface SemanticPlanningCandidateV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly deviceId: string;
  readonly roles: readonly string[];
  readonly verifiedCapabilities: readonly string[];
}

export interface SemanticPlanningRequestV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly taskId: string;
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly selectedInputRefs: readonly string[];
  readonly decisions: readonly string[];
  readonly openQuestions: readonly string[];
  readonly eligibleDevices: readonly SemanticPlanningCandidateV1[];
}

export interface SemanticPlanningResponseV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly taskId: string;
  readonly workOrders: readonly WorkOrderV1[];
}

export interface SemanticDeviceSelectionRequestV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly taskId: string;
  readonly workOrder: WorkOrderV1;
  readonly eligibleDevices: readonly SemanticPlanningCandidateV1[];
}

export interface SemanticDeviceSelectionResponseV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly preferredDeviceId: string;
}

export interface ArtifactReferenceV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly artifactId: string;
  readonly href: string;
}

export type WorkerReportStatusV1 = "blocked" | "failed" | "succeeded";

export interface WorkerReportV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly status: WorkerReportStatusV1;
  readonly report: string;
  readonly artifactRefs: readonly ArtifactReferenceV1[];
}

export type ProtocolParser<TValue> = (input: unknown) => TValue;

export type InferProtocol<TParser extends ProtocolParser<unknown>> =
  TParser extends ProtocolParser<infer TValue> ? TValue : never;

export interface ApplicationEnvelopeV1<TPayload = unknown> {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly messageId: string;
  readonly senderDeviceId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly payload: TPayload;
}

export type ApplicationRequestEnvelopeV1<TPayload = unknown> = ApplicationEnvelopeV1<TPayload>;
export type EventEnvelopeV1<TPayload = unknown> = ApplicationEnvelopeV1<TPayload>;

function fieldPath(prefix: string, field: string): string {
  return prefix === "" ? field : `${prefix}.${field}`;
}

function assertProtocolVersion(input: unknown, path = "protocolVersion"): void {
  const protocolVersion = (input as { readonly protocolVersion?: unknown } | null)?.protocolVersion;

  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      "UNKNOWN_PROTOCOL_VERSION",
      path,
      "Unsupported protocol version.",
    );
  }
}

function parseIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new ProtocolValidationError(
      "BLANK_IDENTIFIER",
      path,
      "Identifier must be a non-blank string.",
    );
  }

  return value;
}

function parseBoundedIdentifier(value: unknown, path: string, maximumLength = 512): string {
  const identifier = parseIdentifier(value, path);
  if (
    identifier.length > maximumLength ||
    [...identifier].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected a bounded identifier without control characters.",
    );
  }
  return identifier;
}

function parseBoundedText(value: unknown, path: string, maximumLength: number): string {
  const text = parseNonBlankString(value, path);
  if (
    text.length > maximumLength ||
    [...text].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 8 || codePoint === 11 || codePoint === 12);
    })
  ) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected bounded text without unsafe control characters.",
    );
  }
  return text;
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ProtocolValidationError("INVALID_CONTRACT", path, "Expected a string.");
  }

  return value;
}

function parseNonBlankString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new ProtocolValidationError("INVALID_CONTRACT", path, "Expected a non-blank string.");
  }

  return value;
}

function parsePositiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected a positive safe integer.",
    );
  }

  return value as number;
}

function parseStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected an array of non-blank strings.",
    );
  }

  const values = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "" || entry !== entry.trim()) {
      throw new ProtocolValidationError(
        "INVALID_CONTRACT",
        `${path}[${index}]`,
        "Expected a non-blank string.",
      );
    }

    return entry;
  });
  assertUnique(values, path);
  return values;
}

function parseCapabilityArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ProtocolValidationError(
      "MALFORMED_CAPABILITY_ARRAY",
      path,
      "Capabilities must be an array of non-blank strings.",
    );
  }

  const capabilities = value.map((capability, index) => {
    if (
      typeof capability !== "string" ||
      capability.trim() === "" ||
      capability !== capability.trim()
    ) {
      throw new ProtocolValidationError(
        "MALFORMED_CAPABILITY_ARRAY",
        `${path}[${index}]`,
        "Capabilities must be an array of non-blank strings.",
      );
    }

    return capability;
  });
  assertUnique(capabilities, path);
  return capabilities;
}

function parseIdentifierArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected an array of identifiers.",
    );
  }

  const identifiers = value.map((identifier, index) =>
    parseIdentifier(identifier, `${path}[${index}]`),
  );
  assertUnique(identifiers, path);
  return identifiers;
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new ProtocolValidationError("INVALID_CONTRACT", path, "Expected unique values.");
  }
}

function parseWorkerReportStatus(value: unknown, path: string): WorkerReportStatusV1 {
  if (value !== "blocked" && value !== "failed" && value !== "succeeded") {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected blocked, failed, or succeeded.",
    );
  }

  return value;
}

function parseOsFamily(value: unknown, path: string): OsFamily {
  if (value !== "macos" && value !== "windows" && value !== "linux") {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected macos, windows, or linux.",
    );
  }

  return value;
}

function requireExactObjectKeys(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolValidationError("INVALID_CONTRACT", path, "Expected an object.");
  }
  const record = input as Readonly<Record<string, unknown>>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected an exact supported field set.",
    );
  }
  return record;
}

function parseWorkerAgentProvider(value: unknown, path: string): WorkerAgentProviderV1 {
  if (value !== "claude" && value !== "codex" && value !== "generic") {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected claude, codex, or generic.",
    );
  }
  return value;
}

function parseWorkerAgentRequirementAt(input: unknown, prefix: string): WorkerAgentRequirementV1 {
  const value = requireExactObjectKeys(
    input,
    ["provider"],
    ["adapterId", "modelId", "effort", "allowedCompatibilities"],
    prefix,
  );
  const rawCompatibilities = value["allowedCompatibilities"];
  let allowedCompatibilities: readonly WorkerAgentCompatibilityV1[] | undefined;
  if (rawCompatibilities !== undefined) {
    if (!Array.isArray(rawCompatibilities) || rawCompatibilities.length === 0) {
      throw new ProtocolValidationError(
        "INVALID_CONTRACT",
        fieldPath(prefix, "allowedCompatibilities"),
        "Expected at least one allowed compatibility.",
      );
    }
    allowedCompatibilities = rawCompatibilities.map((entry, index) => {
      if (entry !== "tested" && entry !== "compatible" && entry !== "untested") {
        throw new ProtocolValidationError(
          "INVALID_CONTRACT",
          `${fieldPath(prefix, "allowedCompatibilities")}[${index}]`,
          "Expected tested, compatible, or untested.",
        );
      }
      return entry;
    });
    assertUnique(allowedCompatibilities, fieldPath(prefix, "allowedCompatibilities"));
    allowedCompatibilities = Object.freeze([...allowedCompatibilities]);
  }
  return Object.freeze({
    provider: parseWorkerAgentProvider(value["provider"], fieldPath(prefix, "provider")),
    ...(value["adapterId"] === undefined
      ? {}
      : {
          adapterId: parseBoundedIdentifier(value["adapterId"], fieldPath(prefix, "adapterId")),
        }),
    ...(value["modelId"] === undefined
      ? {}
      : {
          modelId: parseBoundedIdentifier(value["modelId"], fieldPath(prefix, "modelId")),
        }),
    ...(value["effort"] === undefined
      ? {}
      : {
          effort: parseBoundedIdentifier(value["effort"], fieldPath(prefix, "effort")),
        }),
    ...(allowedCompatibilities === undefined ? {} : { allowedCompatibilities }),
  });
}

function parseWorkerAgentSessionObservationAt(
  input: unknown,
  prefix: string,
): WorkerAgentSessionObservationV1 {
  const value = requireExactObjectKeys(
    input,
    [
      "provider",
      "adapterId",
      "adapterVersion",
      "nativeSessionId",
      "workstreamId",
      "workspaceId",
      "lineage",
    ],
    ["modelId", "effort"],
    prefix,
  );
  const lineagePath = fieldPath(prefix, "lineage");
  const lineage = requireExactObjectKeys(
    value["lineage"],
    ["lineageId"],
    ["parentNativeSessionId", "continuationReason"],
    lineagePath,
  );
  return Object.freeze({
    provider: parseWorkerAgentProvider(value["provider"], fieldPath(prefix, "provider")),
    adapterId: parseBoundedIdentifier(value["adapterId"], fieldPath(prefix, "adapterId")),
    adapterVersion: parseBoundedIdentifier(
      value["adapterVersion"],
      fieldPath(prefix, "adapterVersion"),
    ),
    ...(value["modelId"] === undefined
      ? {}
      : {
          modelId: parseBoundedIdentifier(value["modelId"], fieldPath(prefix, "modelId")),
        }),
    ...(value["effort"] === undefined
      ? {}
      : {
          effort: parseBoundedIdentifier(value["effort"], fieldPath(prefix, "effort")),
        }),
    nativeSessionId: parseBoundedIdentifier(
      value["nativeSessionId"],
      fieldPath(prefix, "nativeSessionId"),
    ),
    workstreamId: parseBoundedIdentifier(value["workstreamId"], fieldPath(prefix, "workstreamId")),
    workspaceId: parseBoundedIdentifier(value["workspaceId"], fieldPath(prefix, "workspaceId")),
    lineage: Object.freeze({
      lineageId: parseBoundedIdentifier(lineage["lineageId"], fieldPath(lineagePath, "lineageId")),
      ...(lineage["parentNativeSessionId"] === undefined
        ? {}
        : {
            parentNativeSessionId: parseBoundedIdentifier(
              lineage["parentNativeSessionId"],
              fieldPath(lineagePath, "parentNativeSessionId"),
            ),
          }),
      ...(lineage["continuationReason"] === undefined
        ? {}
        : {
            continuationReason: parseBoundedText(
              lineage["continuationReason"],
              fieldPath(lineagePath, "continuationReason"),
              1_024,
            ),
          }),
    }),
  });
}

function parseWorkOrderAt(input: unknown, prefix: string): WorkOrderV1 {
  assertProtocolVersion(input, fieldPath(prefix, "protocolVersion"));
  const value = input as WorkOrderV1;

  return {
    protocolVersion: PROTOCOL_VERSION,
    workOrderId: parseIdentifier(value.workOrderId, fieldPath(prefix, "workOrderId")),
    title: parseNonBlankString(value.title, fieldPath(prefix, "title")),
    brief: parseNonBlankString(value.brief, fieldPath(prefix, "brief")),
    completionCriteria: parseNonEmptyStringArray(
      value.completionCriteria,
      fieldPath(prefix, "completionCriteria"),
    ),
    requiredCapabilities: parseCapabilityArray(
      value.requiredCapabilities,
      fieldPath(prefix, "requiredCapabilities"),
    ),
    constraints: parseStringArray(value.constraints, fieldPath(prefix, "constraints")),
    selectedInputIds: parseIdentifierArray(
      value.selectedInputIds,
      fieldPath(prefix, "selectedInputIds"),
    ),
    dependsOn: parseIdentifierArray(value.dependsOn, fieldPath(prefix, "dependsOn")),
    schedulingHints: parseWorkOrderSchedulingHintsAt(
      value.schedulingHints,
      fieldPath(prefix, "schedulingHints"),
    ),
    requiredSecretRefs: parseIdentifierArray(
      value.requiredSecretRefs,
      fieldPath(prefix, "requiredSecretRefs"),
    ),
    ...(value.requiredAgent === undefined
      ? {}
      : {
          requiredAgent: parseWorkerAgentRequirementAt(
            value.requiredAgent,
            fieldPath(prefix, "requiredAgent"),
          ),
        }),
    ...(value.budgetLimits === undefined
      ? {}
      : {
          budgetLimits: parseWorkOrderBudgetLimitsAt(
            value.budgetLimits,
            fieldPath(prefix, "budgetLimits"),
          ),
        }),
    ...(value.requiredOsFamily === undefined
      ? {}
      : {
          requiredOsFamily: parseOsFamily(
            value.requiredOsFamily,
            fieldPath(prefix, "requiredOsFamily"),
          ),
        }),
    ...(value.workspaceId === undefined
      ? {}
      : { workspaceId: parseIdentifier(value.workspaceId, fieldPath(prefix, "workspaceId")) }),
  };
}

const workOrderBudgetMetrics = [
  "wallTimeMs",
  "idleTimeMs",
  "retries",
  "childWorkOrders",
  "concurrentRuns",
  "nativeTurns",
  "tokens",
  "costUsdMicros",
] as const satisfies readonly WorkOrderBudgetMetricV1[];

function parseWorkOrderBudgetLimitsAt(input: unknown, prefix: string): WorkOrderBudgetLimitsV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      prefix,
      "Expected Work Order Budget limits.",
    );
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(workOrderBudgetMetrics as readonly string[]).includes(key)) {
      throw new ProtocolValidationError(
        "INVALID_CONTRACT",
        fieldPath(prefix, key),
        "Unknown Work Order Budget metric.",
      );
    }
  }
  const limits: WorkOrderBudgetLimitsV1 = {};
  for (const metric of workOrderBudgetMetrics) {
    const value = record[metric];
    if (value === undefined) {
      continue;
    }
    const path = fieldPath(prefix, metric);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProtocolValidationError(
        "INVALID_CONTRACT",
        path,
        "Expected a Work Order Budget limit.",
      );
    }
    const limit = value as Record<string, unknown>;
    if (
      !Object.keys(limit).every((key) => key === "soft" || key === "hard") ||
      !Object.prototype.hasOwnProperty.call(limit, "hard") ||
      !isNonNegativeSafeInteger(limit["hard"])
    ) {
      throw new ProtocolValidationError(
        "INVALID_CONTRACT",
        fieldPath(path, "hard"),
        "Expected a finite non-negative safe-integer hard limit.",
      );
    }
    if (limit["soft"] !== undefined) {
      if (!isNonNegativeSafeInteger(limit["soft"]) || limit["soft"] > limit["hard"]) {
        throw new ProtocolValidationError(
          "INVALID_CONTRACT",
          fieldPath(path, "soft"),
          "Expected a finite non-negative soft limit no greater than the hard limit.",
        );
      }
      limits[metric] = {
        soft: limit["soft"],
        hard: limit["hard"],
      };
    } else {
      limits[metric] = { hard: limit["hard"] };
    }
  }
  return Object.freeze(limits);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseNonEmptyStringArray(value: unknown, path: string): readonly string[] {
  const values = parseStringArray(value, path);
  if (values.length === 0) {
    throw new ProtocolValidationError("INVALID_CONTRACT", path, "Expected at least one value.");
  }
  return values;
}

function parseWorkOrderSchedulingHintsAt(
  input: unknown,
  prefix: string,
): WorkOrderSchedulingHintsV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      prefix,
      "Expected Work Order scheduling hints.",
    );
  }
  const value = input as WorkOrderSchedulingHintsV1;

  return {
    preferredDeviceIds: parseIdentifierArray(
      value.preferredDeviceIds,
      fieldPath(prefix, "preferredDeviceIds"),
    ),
    preferredRoles: parseStringArray(value.preferredRoles, fieldPath(prefix, "preferredRoles")),
  };
}

function parseSemanticPlanningCandidateAt(
  input: unknown,
  prefix: string,
): SemanticPlanningCandidateV1 {
  assertProtocolVersion(input, fieldPath(prefix, "protocolVersion"));
  const value = input as SemanticPlanningCandidateV1;

  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: parseIdentifier(value.deviceId, fieldPath(prefix, "deviceId")),
    roles: parseStringArray(value.roles, fieldPath(prefix, "roles")),
    verifiedCapabilities: parseCapabilityArray(
      value.verifiedCapabilities,
      fieldPath(prefix, "verifiedCapabilities"),
    ),
  };
}

function parseArtifactReferenceAt(input: unknown, prefix: string): ArtifactReferenceV1 {
  assertProtocolVersion(input, fieldPath(prefix, "protocolVersion"));
  const value = input as ArtifactReferenceV1;

  return {
    protocolVersion: PROTOCOL_VERSION,
    artifactId: parseIdentifier(value.artifactId, fieldPath(prefix, "artifactId")),
    href: parseArtifactHref(value.href, fieldPath(prefix, "href")),
  };
}

function parseArtifactHref(value: unknown, path: string): string {
  const href = parseNonBlankString(value, path);
  if (
    [...href].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f);
    })
  ) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Artifact URLs cannot contain whitespace or control characters.",
    );
  }
  let parsed: URL;

  try {
    parsed = new URL(href);
  } catch {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected an absolute HTTP(S) Artifact URL.",
    );
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      path,
      "Expected a credential-free HTTP(S) Artifact URL.",
    );
  }

  return href;
}

const RFC3339_INSTANT_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

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

function parseTimestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !RFC3339_INSTANT_PATTERN.test(value) ||
    !hasValidCalendarDate(value)
  ) {
    throw new ProtocolValidationError("INVALID_CONTRACT", path, "Expected an ISO-8601 timestamp.");
  }

  return value;
}

export function parseForumTaskIntake(input: unknown): ForumTaskIntakeV1 {
  assertProtocolVersion(input);
  const value = input as ForumTaskIntakeV1;

  if (Object.prototype.hasOwnProperty.call(value, "approved")) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      "approved",
      "Authorization must be established by the trusted Channel Authorizer.",
    );
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    forumId: parseIdentifier(value.forumId, "forumId"),
    postId: parseIdentifier(value.postId, "postId"),
    authorId: parseIdentifier(value.authorId, "authorId"),
    title: parseNonBlankString(value.title, "title"),
    body: parseString(value.body, "body"),
  };
}

export function parseSemanticPlanningRequest(input: unknown): SemanticPlanningRequestV1 {
  assertProtocolVersion(input);
  const value = input as SemanticPlanningRequestV1;

  if (!Array.isArray(value.eligibleDevices)) {
    throw new ProtocolValidationError("INVALID_CONTRACT", "eligibleDevices", "Expected an array.");
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: parseIdentifier(value.taskId, "taskId"),
    objective: parseNonBlankString(value.objective, "objective"),
    completionCriteria: parseStringArray(value.completionCriteria, "completionCriteria"),
    constraints: parseStringArray(value.constraints, "constraints"),
    selectedInputRefs: parseIdentifierArray(value.selectedInputRefs, "selectedInputRefs"),
    decisions: parseStringArray(value.decisions, "decisions"),
    openQuestions: parseStringArray(value.openQuestions, "openQuestions"),
    eligibleDevices: value.eligibleDevices.map((candidate, index) =>
      parseSemanticPlanningCandidateAt(candidate, `eligibleDevices[${index}]`),
    ),
  };
}

export function parseSemanticPlanningResponse(input: unknown): SemanticPlanningResponseV1 {
  assertProtocolVersion(input);
  const value = input as SemanticPlanningResponseV1;

  if (!Array.isArray(value.workOrders)) {
    throw new ProtocolValidationError("INVALID_CONTRACT", "workOrders", "Expected an array.");
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: parseIdentifier(value.taskId, "taskId"),
    workOrders: value.workOrders.map((workOrder, index) =>
      parseWorkOrderAt(workOrder, `workOrders[${index}]`),
    ),
  };
}

export function parseSemanticDeviceSelectionRequest(
  input: unknown,
): SemanticDeviceSelectionRequestV1 {
  assertProtocolVersion(input);
  const value = input as SemanticDeviceSelectionRequestV1;
  if (!Array.isArray(value.eligibleDevices) || value.eligibleDevices.length < 2) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      "eligibleDevices",
      "Expected at least two eligible Devices.",
    );
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: parseIdentifier(value.taskId, "taskId"),
    workOrder: parseWorkOrderAt(value.workOrder, "workOrder"),
    eligibleDevices: value.eligibleDevices.map((candidate, index) =>
      parseSemanticPlanningCandidateAt(candidate, `eligibleDevices[${index}]`),
    ),
  };
}

export function parseSemanticDeviceSelectionResponse(
  input: unknown,
): SemanticDeviceSelectionResponseV1 {
  assertProtocolVersion(input);
  const value = input as SemanticDeviceSelectionResponseV1;
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: parseIdentifier(value.taskId, "taskId"),
    workOrderId: parseIdentifier(value.workOrderId, "workOrderId"),
    preferredDeviceId: parseIdentifier(value.preferredDeviceId, "preferredDeviceId"),
  };
}

export function parseWorkOrder(input: unknown): WorkOrderV1 {
  return parseWorkOrderAt(input, "");
}

export function parseWorkerAgentRequirement(input: unknown): WorkerAgentRequirementV1 {
  return parseWorkerAgentRequirementAt(input, "agentRequirement");
}

export function parseWorkerAgentSessionObservation(
  input: unknown,
): WorkerAgentSessionObservationV1 {
  return parseWorkerAgentSessionObservationAt(input, "agentSession");
}

export function parseArtifactReference(input: unknown): ArtifactReferenceV1 {
  return parseArtifactReferenceAt(input, "");
}

export function parseWorkerReport(input: unknown): WorkerReportV1 {
  assertProtocolVersion(input);
  const value = input as WorkerReportV1;

  if (!Array.isArray(value.artifactRefs)) {
    throw new ProtocolValidationError("INVALID_CONTRACT", "artifactRefs", "Expected an array.");
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: parseIdentifier(value.taskId, "taskId"),
    workOrderId: parseIdentifier(value.workOrderId, "workOrderId"),
    deviceId: parseIdentifier(value.deviceId, "deviceId"),
    workerId: parseIdentifier(value.workerId, "workerId"),
    routeId: parseIdentifier(value.routeId, "routeId"),
    runId: parseIdentifier(value.runId, "runId"),
    leaseId: parseIdentifier(value.leaseId, "leaseId"),
    fencingToken: parsePositiveSafeInteger(value.fencingToken, "fencingToken"),
    status: parseWorkerReportStatus(value.status, "status"),
    report: parseNonBlankString(value.report, "report"),
    artifactRefs: value.artifactRefs.map((artifact, index) =>
      parseArtifactReferenceAt(artifact, `artifactRefs[${index}]`),
    ),
  };
}

function parseApplicationEnvelope<TPayload>(
  input: unknown,
  parsePayload?: ProtocolParser<TPayload>,
): ApplicationEnvelopeV1<TPayload> {
  assertProtocolVersion(input);
  const value = input as ApplicationEnvelopeV1<unknown>;

  if (!Object.prototype.hasOwnProperty.call(value, "payload")) {
    throw new ProtocolValidationError(
      "INVALID_CONTRACT",
      "payload",
      "Expected an explicit payload field.",
    );
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: parseIdentifier(value.messageId, "messageId"),
    senderDeviceId: parseIdentifier(value.senderDeviceId, "senderDeviceId"),
    correlationId: parseIdentifier(value.correlationId, "correlationId"),
    createdAt: parseTimestamp(value.createdAt, "createdAt"),
    idempotencyKey: parseIdentifier(value.idempotencyKey, "idempotencyKey"),
    type: parseNonBlankString(value.type, "type"),
    payload: parsePayload ? parsePayload(value.payload) : (value.payload as TPayload),
  };
}

export function parseApplicationRequestEnvelope<TPayload = unknown>(
  input: unknown,
  parsePayload?: ProtocolParser<TPayload>,
): ApplicationRequestEnvelopeV1<TPayload> {
  return parseApplicationEnvelope(input, parsePayload);
}

export function parseEventEnvelope<TPayload = unknown>(
  input: unknown,
  parsePayload?: ProtocolParser<TPayload>,
): EventEnvelopeV1<TPayload> {
  return parseApplicationEnvelope(input, parsePayload);
}

export type ForumTaskIntake = InferProtocol<typeof parseForumTaskIntake>;
export type SemanticPlanningRequest = InferProtocol<typeof parseSemanticPlanningRequest>;
export type SemanticPlanningResponse = InferProtocol<typeof parseSemanticPlanningResponse>;
export type SemanticDeviceSelectionRequest = InferProtocol<
  typeof parseSemanticDeviceSelectionRequest
>;
export type SemanticDeviceSelectionResponse = InferProtocol<
  typeof parseSemanticDeviceSelectionResponse
>;
export type WorkOrder = InferProtocol<typeof parseWorkOrder>;
export type ArtifactReference = InferProtocol<typeof parseArtifactReference>;
export type WorkerReport = InferProtocol<typeof parseWorkerReport>;
export type ApplicationRequestEnvelope<TPayload = unknown> = ApplicationRequestEnvelopeV1<TPayload>;
export type EventEnvelope<TPayload = unknown> = EventEnvelopeV1<TPayload>;
