import type { OsFamily } from "@opendelegate/domain";

export const PROTOCOL_VERSION = "v1" as const;

export type ProtocolValidationErrorCode =
  | "BLANK_IDENTIFIER"
  | "INVALID_CONTRACT"
  | "MALFORMED_CAPABILITY_ARRAY"
  | "UNKNOWN_PROTOCOL_VERSION";

export class ProtocolValidationError extends Error {
  public readonly code: ProtocolValidationErrorCode;
  public readonly path: string;

  public constructor(code: ProtocolValidationErrorCode, path: string, message: string) {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.path = path;
  }
}

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
  readonly requiredOsFamily?: OsFamily;
  readonly workspaceId?: string;
}

export interface WorkOrderSchedulingHintsV1 {
  readonly preferredDeviceIds: readonly string[];
  readonly preferredRoles: readonly string[];
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
