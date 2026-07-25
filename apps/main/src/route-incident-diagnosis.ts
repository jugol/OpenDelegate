import { createHash } from "node:crypto";

import {
  type AgentAdapter,
  type AgentRunHandle,
  type AgentRunLimits,
  type WorkspaceBinding,
} from "@opendelegate/agent-adapters";
import {
  validateWorkerRouteIncident,
  type MainRouteIncidentRequest,
  type WorkerRouteIncidentV1,
} from "@opendelegate/device-channel";
import { EventStoreError, type EventStore, type StoredEvent } from "@opendelegate/event-store";

const CLAIM_EVENT_TYPE = "transport.route-incident.diagnosis-claimed.v1";
export const ROUTE_INCIDENT_DIAGNOSIS_COMPLETED_EVENT_TYPE =
  "transport.route-incident.diagnosis-completed.v1";
const COMPLETED_EVENT_TYPE = ROUTE_INCIDENT_DIAGNOSIS_COMPLETED_EVENT_TYPE;
const MAXIMUM_EVENT_STORE_RETRIES = 16;
const DEFAULT_MAXIMUM_OUTPUT_CHARACTERS = 4_096;
const DEFAULT_MAXIMUM_RECOMMENDATION_CHARACTERS = 2_048;
const DEFAULT_MAXIMUM_QUESTION_CHARACTERS = 1_024;

export interface RouteIncidentDiagnosticAgentInput {
  readonly authenticatedDeviceId: string;
  readonly incident: WorkerRouteIncidentV1;
  readonly limits: {
    readonly maximumTurns: 1;
    readonly maximumOutputCharacters: number;
  };
  readonly authority: {
    readonly tools: "denied";
    readonly osMutation: "denied";
    readonly networkMutation: "denied";
  };
}

export interface RouteIncidentDiagnosticAgentOutput {
  readonly recommendation: string;
  readonly ownerQuestion: string;
}

export interface RouteIncidentDiagnosticAgentPort {
  diagnose(input: RouteIncidentDiagnosticAgentInput): Promise<unknown>;
}

export interface RouteIncidentDiagnosisResult {
  readonly incidentId: WorkerRouteIncidentV1["incidentId"];
  readonly fingerprint: WorkerRouteIncidentV1["fingerprint"];
  readonly profileRevision: WorkerRouteIncidentV1["profileRevision"];
  readonly authenticatedDeviceId: string;
  readonly recommendation: string;
  readonly ownerQuestion: string;
  readonly source: "agent" | "deterministic-fallback";
  readonly reasonCode: "AGENT_COMPLETED" | "AGENT_UNAVAILABLE" | "DIAGNOSIS_INTERRUPTED";
}

export interface RouteIncidentNotificationPort {
  /**
   * Implementations must consume the supplied key idempotently. This lets Main
   * retry owner presentation after a process interruption without duplicating a
   * Discord incident or Admin notification.
   */
  publish(input: {
    readonly idempotencyKey: string;
    readonly result: RouteIncidentDiagnosisResult;
  }): Promise<void>;
}

export interface MainRouteIncidentDiagnosisServiceOptions {
  readonly eventStore: EventStore;
  readonly agent?: RouteIncidentDiagnosticAgentPort;
  readonly notifications?: RouteIncidentNotificationPort;
  readonly maximumOutputCharacters?: number;
}

export interface MainRouteIncidentDiagnosisReceipt {
  readonly disposition: "diagnosed" | "duplicate" | "recovered";
  readonly result: RouteIncidentDiagnosisResult;
}

interface RouteIncidentClaimPayload {
  readonly schemaVersion: 1;
  readonly authenticatedDeviceId: string;
  readonly requestMessageId: string;
  readonly idempotencyKey: string;
  readonly receivedAtMs: number;
  readonly incident: WorkerRouteIncidentV1;
}

interface RouteIncidentCompletedPayload {
  readonly schemaVersion: 1;
  readonly incidentId: WorkerRouteIncidentV1["incidentId"];
  readonly result: RouteIncidentDiagnosisResult;
}

/**
 * Strictly reads the already-redacted, bounded result from one durable completed
 * event payload. Admin and notification projections use this instead of exposing
 * arbitrary EventStore payloads.
 */
export function parseStoredRouteIncidentDiagnosisResult(
  input: unknown,
): RouteIncidentDiagnosisResult {
  return parseCompletedPayload(input).result;
}

interface IncidentProjection {
  readonly claim: RouteIncidentClaimPayload;
  readonly result?: RouteIncidentDiagnosisResult;
}

type ClaimDisposition =
  | { readonly status: "claimed"; readonly claim: RouteIncidentClaimPayload }
  | { readonly status: "completed"; readonly result: RouteIncidentDiagnosisResult }
  | { readonly status: "interrupted"; readonly claim: RouteIncidentClaimPayload };

/**
 * Main-side, Task-independent route diagnosis. The event-store claim is written
 * before the Agent turn, so replay or restart cannot invoke the Agent twice for
 * one occurrence. An interrupted claim is completed with a deterministic owner
 * question instead of retrying an unknowable external model side effect.
 */
export class MainRouteIncidentDiagnosisService {
  readonly #eventStore: EventStore;
  readonly #agent: RouteIncidentDiagnosticAgentPort | undefined;
  readonly #notifications: RouteIncidentNotificationPort | undefined;
  readonly #maximumOutputCharacters: number;

  public constructor(options: MainRouteIncidentDiagnosisServiceOptions) {
    assertEventStore(options.eventStore);
    if (options.agent !== undefined && typeof options.agent.diagnose !== "function") {
      throw new TypeError("The route diagnostic Agent port is invalid.");
    }
    if (
      options.notifications !== undefined &&
      typeof options.notifications.publish !== "function"
    ) {
      throw new TypeError("The route incident notification port is invalid.");
    }
    const maximumOutputCharacters =
      options.maximumOutputCharacters ?? DEFAULT_MAXIMUM_OUTPUT_CHARACTERS;
    if (
      !Number.isSafeInteger(maximumOutputCharacters) ||
      maximumOutputCharacters < 256 ||
      maximumOutputCharacters > 16_384
    ) {
      throw new TypeError(
        "Route diagnostic Agent output must be bounded between 256 and 16384 characters.",
      );
    }
    this.#eventStore = options.eventStore;
    this.#agent = options.agent;
    this.#notifications = options.notifications;
    this.#maximumOutputCharacters = maximumOutputCharacters;
  }

  public async handle(input: MainRouteIncidentRequest): Promise<MainRouteIncidentDiagnosisReceipt> {
    const request = validateRequest(input);
    const claimed = await this.#claim(request);
    if (claimed.status === "completed") {
      await this.#publish(claimed.result);
      return Object.freeze({
        disposition: "duplicate",
        result: claimed.result,
      });
    }
    if (claimed.status === "interrupted") {
      const result = deterministicFallback(claimed.claim, "DIAGNOSIS_INTERRUPTED");
      await this.#complete(claimed.claim, result);
      await this.#publish(result);
      return Object.freeze({
        disposition: "recovered",
        result,
      });
    }

    const result = await this.#diagnose(claimed.claim);
    await this.#complete(claimed.claim, result);
    await this.#publish(result);
    return Object.freeze({
      disposition: "diagnosed",
      result,
    });
  }

  public async recoverInterrupted(): Promise<number> {
    const events = await this.#eventStore.readAll();
    const completedIncidentIds = new Set(
      events
        .filter((event) => event.type === COMPLETED_EVENT_TYPE)
        .map((event) => parseCompletedPayload(event.payload).incidentId),
    );
    const claims = events
      .filter((event) => event.type === CLAIM_EVENT_TYPE)
      .map((event) => parseClaimPayload(event.payload))
      .filter((claim) => !completedIncidentIds.has(claim.incident.incidentId));
    let recovered = 0;
    for (const claim of claims) {
      const result = deterministicFallback(claim, "DIAGNOSIS_INTERRUPTED");
      await this.#complete(claim, result);
      await this.#publish(result);
      recovered += 1;
    }
    return recovered;
  }

  async #claim(request: MainRouteIncidentRequest): Promise<ClaimDisposition> {
    const claim: RouteIncidentClaimPayload = Object.freeze({
      schemaVersion: 1,
      authenticatedDeviceId: request.authenticatedDeviceId,
      requestMessageId: request.requestMessageId,
      idempotencyKey: request.idempotencyKey,
      receivedAtMs: request.receivedAtMs,
      incident: request.incident,
    });
    const streamId = incidentStreamId(request.authenticatedDeviceId, request.incident.fingerprint);
    const eventId = claimEventId(request.authenticatedDeviceId, request.incident.incidentId);
    for (let attempt = 0; attempt < MAXIMUM_EVENT_STORE_RETRIES; attempt += 1) {
      const events = await this.#eventStore.readStream(streamId);
      const projection = projectIncidentStream(events);
      const existing = projection.get(request.incident.incidentId);
      if (existing?.result !== undefined) {
        return { status: "completed", result: existing.result };
      }
      if (existing !== undefined) {
        if (!sameClaim(existing.claim, claim)) {
          throw new Error("A route incident occurrence was reused with different evidence.");
        }
        return { status: "interrupted", claim: existing.claim };
      }
      try {
        await this.#eventStore.append({
          streamId,
          expectedVersion: events.length,
          events: [
            {
              eventId,
              type: CLAIM_EVENT_TYPE,
              payload: claim,
            },
          ],
        });
        return { status: "claimed", claim };
      } catch (error) {
        if (error instanceof EventStoreError && error.code === "STREAM_VERSION_CONFLICT") {
          continue;
        }
        throw error;
      }
    }
    throw new Error("The route incident claim remained concurrently unavailable.");
  }

  async #diagnose(claim: RouteIncidentClaimPayload): Promise<RouteIncidentDiagnosisResult> {
    if (this.#agent === undefined) {
      return deterministicFallback(claim, "AGENT_UNAVAILABLE");
    }
    try {
      const output = await this.#agent.diagnose(
        Object.freeze({
          authenticatedDeviceId: claim.authenticatedDeviceId,
          incident: claim.incident,
          limits: Object.freeze({
            maximumTurns: 1 as const,
            maximumOutputCharacters: this.#maximumOutputCharacters,
          }),
          authority: Object.freeze({
            tools: "denied" as const,
            osMutation: "denied" as const,
            networkMutation: "denied" as const,
          }),
        }),
      );
      const parsed = validateAgentOutput(output, this.#maximumOutputCharacters);
      return Object.freeze({
        incidentId: claim.incident.incidentId,
        fingerprint: claim.incident.fingerprint,
        profileRevision: claim.incident.profileRevision,
        authenticatedDeviceId: claim.authenticatedDeviceId,
        recommendation: parsed.recommendation,
        ownerQuestion: parsed.ownerQuestion,
        source: "agent",
        reasonCode: "AGENT_COMPLETED",
      });
    } catch {
      return deterministicFallback(claim, "AGENT_UNAVAILABLE");
    }
  }

  async #complete(
    claim: RouteIncidentClaimPayload,
    result: RouteIncidentDiagnosisResult,
  ): Promise<void> {
    const streamId = incidentStreamId(claim.authenticatedDeviceId, claim.incident.fingerprint);
    const eventId = completedEventId(claim.authenticatedDeviceId, claim.incident.incidentId);
    const payload: RouteIncidentCompletedPayload = Object.freeze({
      schemaVersion: 1,
      incidentId: claim.incident.incidentId,
      result,
    });
    for (let attempt = 0; attempt < MAXIMUM_EVENT_STORE_RETRIES; attempt += 1) {
      const events = await this.#eventStore.readStream(streamId);
      const existing = projectIncidentStream(events).get(claim.incident.incidentId);
      if (existing?.result !== undefined) {
        if (!sameResult(existing.result, result)) {
          throw new Error("A route incident diagnosis was completed with a different result.");
        }
        return;
      }
      if (existing === undefined || !sameClaim(existing.claim, claim)) {
        throw new Error("The route incident diagnosis claim is missing or changed.");
      }
      try {
        await this.#eventStore.append({
          streamId,
          expectedVersion: events.length,
          events: [
            {
              eventId,
              type: COMPLETED_EVENT_TYPE,
              payload,
            },
          ],
        });
        return;
      } catch (error) {
        if (error instanceof EventStoreError && error.code === "STREAM_VERSION_CONFLICT") {
          continue;
        }
        throw error;
      }
    }
    throw new Error("The route incident diagnosis result remained concurrently unavailable.");
  }

  async #publish(result: RouteIncidentDiagnosisResult): Promise<void> {
    await this.#notifications?.publish({
      idempotencyKey: `route-incident-result:${result.incidentId}`,
      result,
    });
  }
}

export interface AgentBackedRouteIncidentDiagnosticOptions {
  readonly adapter: AgentAdapter;
  readonly deviceId: string;
  readonly workspace: WorkspaceBinding;
  readonly limits?: AgentRunLimits;
}

/**
 * One reasoning-only native Agent turn. No OpenDelegate tool server is composed,
 * provider tool permission is deny, and the sandbox is read-only. Any observed
 * tool or approval request rejects the diagnosis and lets the deterministic
 * fallback ask the owner.
 */
export class AgentBackedRouteIncidentDiagnostic implements RouteIncidentDiagnosticAgentPort {
  readonly #adapter: AgentAdapter;
  readonly #deviceId: string;
  readonly #workspace: WorkspaceBinding;
  readonly #limits: AgentRunLimits;

  public constructor(options: AgentBackedRouteIncidentDiagnosticOptions) {
    if (
      options.adapter === null ||
      typeof options.adapter !== "object" ||
      typeof options.adapter.start !== "function"
    ) {
      throw new TypeError("A route diagnostic Agent Adapter is required.");
    }
    assertIdentifier(options.deviceId, "Main Device ID");
    assertWorkspace(options.workspace);
    this.#adapter = options.adapter;
    this.#deviceId = options.deviceId;
    this.#workspace = structuredClone(options.workspace);
    this.#limits = validateAgentLimits(options.limits ?? ROUTE_DIAGNOSTIC_AGENT_LIMITS);
  }

  public async diagnose(input: RouteIncidentDiagnosticAgentInput): Promise<unknown> {
    const incident = validateWorkerRouteIncident(input.incident);
    const identity = digest(`${input.authenticatedDeviceId}\u0000${incident.incidentId}`);
    const prompt = buildAgentPrompt(input.authenticatedDeviceId, incident);
    const handle = await this.#adapter.start({
      operation: "start",
      requestId: `route-diagnosis-request-${identity}`,
      runId: `route-diagnosis-run-${identity}`,
      taskId: `system-route-incident-${identity}`,
      workstreamId: "route-diagnosis",
      sessionKey: `route-diagnosis:${identity}`,
      deviceId: this.#deviceId,
      prompt,
      workspace: this.#workspace,
      sandbox: "read-only",
      permissions: {
        mode: "deny",
        allowedTools: [],
        deniedTools: [],
      },
      limits: this.#limits,
    });
    const [events, result] = await Promise.allSettled([rejectToolUse(handle), handle.result]);
    if (
      events.status === "rejected" ||
      result.status === "rejected" ||
      result.value.status !== "succeeded" ||
      typeof result.value.finalText !== "string" ||
      result.value.finalText.length > input.limits.maximumOutputCharacters
    ) {
      await safeCancel(handle);
      throw new Error("The route diagnostic Agent did not return a bounded reasoning result.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value.finalText);
    } catch {
      throw new Error("The route diagnostic Agent result is not valid JSON.");
    }
    return parsed;
  }
}

export const ROUTE_DIAGNOSTIC_AGENT_LIMITS: AgentRunLimits = Object.freeze({
  wallTimeoutMs: 60_000,
  idleTimeoutMs: 30_000,
  cancellationGraceMs: 2_000,
  leaseTtlMs: 30_000,
  leaseRenewIntervalMs: 10_000,
  maxBufferedEvents: 64,
  maxLineBytes: 32 * 1_024,
  maxDiagnosticBytes: 8 * 1_024,
});

function projectIncidentStream(events: readonly StoredEvent[]): Map<string, IncidentProjection> {
  const projection = new Map<string, IncidentProjection>();
  for (const [index, event] of events.entries()) {
    if (event.streamVersion !== index + 1) {
      throw new Error("The route incident event stream is not contiguous.");
    }
    if (event.type === CLAIM_EVENT_TYPE) {
      const claim = parseClaimPayload(event.payload);
      if (projection.has(claim.incident.incidentId)) {
        throw new Error("A route incident stream contains a duplicate claim.");
      }
      projection.set(claim.incident.incidentId, { claim });
      continue;
    }
    if (event.type === COMPLETED_EVENT_TYPE) {
      const completed = parseCompletedPayload(event.payload);
      const existing = projection.get(completed.incidentId);
      if (existing === undefined || existing.result !== undefined) {
        throw new Error("A route incident stream contains an orphan or duplicate result.");
      }
      projection.set(completed.incidentId, {
        claim: existing.claim,
        result: completed.result,
      });
      continue;
    }
    throw new Error("The route incident stream contains an unsupported event.");
  }
  return projection;
}

function parseClaimPayload(input: unknown): RouteIncidentClaimPayload {
  const record = requireExactRecord(input, [
    "schemaVersion",
    "authenticatedDeviceId",
    "requestMessageId",
    "idempotencyKey",
    "receivedAtMs",
    "incident",
  ]);
  if (record["schemaVersion"] !== 1) {
    throw new Error("The route incident claim schema version is invalid.");
  }
  assertIdentifier(record["authenticatedDeviceId"], "authenticated Device ID");
  assertIdentifier(record["requestMessageId"], "request message ID");
  assertIdentifier(record["idempotencyKey"], "request idempotency key");
  assertTimestamp(record["receivedAtMs"]);
  return Object.freeze({
    schemaVersion: 1,
    authenticatedDeviceId: record["authenticatedDeviceId"],
    requestMessageId: record["requestMessageId"],
    idempotencyKey: record["idempotencyKey"],
    receivedAtMs: record["receivedAtMs"],
    incident: validateWorkerRouteIncident(record["incident"] as WorkerRouteIncidentV1),
  });
}

function parseCompletedPayload(input: unknown): RouteIncidentCompletedPayload {
  const record = requireExactRecord(input, ["schemaVersion", "incidentId", "result"]);
  if (record["schemaVersion"] !== 1) {
    throw new Error("The route incident result schema version is invalid.");
  }
  const result = validateStoredResult(record["result"]);
  if (record["incidentId"] !== result.incidentId) {
    throw new Error("The route incident result identity is inconsistent.");
  }
  return Object.freeze({
    schemaVersion: 1,
    incidentId: result.incidentId,
    result,
  });
}

function validateStoredResult(input: unknown): RouteIncidentDiagnosisResult {
  const record = requireExactRecord(input, [
    "incidentId",
    "fingerprint",
    "profileRevision",
    "authenticatedDeviceId",
    "recommendation",
    "ownerQuestion",
    "source",
    "reasonCode",
  ]);
  for (const field of ["incidentId", "fingerprint", "profileRevision"] as const) {
    if (typeof record[field] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record[field])) {
      throw new Error("The stored route incident digest is invalid.");
    }
  }
  assertIdentifier(record["authenticatedDeviceId"], "stored authenticated Device ID");
  const recommendation = readBoundedText(
    record["recommendation"],
    "stored recommendation",
    DEFAULT_MAXIMUM_RECOMMENDATION_CHARACTERS,
  );
  const ownerQuestion = readBoundedText(
    record["ownerQuestion"],
    "stored owner question",
    DEFAULT_MAXIMUM_QUESTION_CHARACTERS,
  );
  if (
    (record["source"] !== "agent" && record["source"] !== "deterministic-fallback") ||
    (record["reasonCode"] !== "AGENT_COMPLETED" &&
      record["reasonCode"] !== "AGENT_UNAVAILABLE" &&
      record["reasonCode"] !== "DIAGNOSIS_INTERRUPTED")
  ) {
    throw new Error("The stored route incident diagnosis source is invalid.");
  }
  return Object.freeze({
    incidentId: record["incidentId"] as WorkerRouteIncidentV1["incidentId"],
    fingerprint: record["fingerprint"] as WorkerRouteIncidentV1["fingerprint"],
    profileRevision: record["profileRevision"] as WorkerRouteIncidentV1["profileRevision"],
    authenticatedDeviceId: record["authenticatedDeviceId"],
    recommendation,
    ownerQuestion,
    source: record["source"],
    reasonCode: record["reasonCode"],
  });
}

function validateRequest(input: MainRouteIncidentRequest): MainRouteIncidentRequest {
  if (input === null || typeof input !== "object") {
    throw new TypeError("A Main route incident request is required.");
  }
  assertIdentifier(input.authenticatedDeviceId, "authenticated Device ID");
  assertIdentifier(input.requestMessageId, "request message ID");
  assertIdentifier(input.idempotencyKey, "request idempotency key");
  assertTimestamp(input.receivedAtMs);
  return Object.freeze({
    authenticatedDeviceId: input.authenticatedDeviceId,
    requestMessageId: input.requestMessageId,
    idempotencyKey: input.idempotencyKey,
    incident: validateWorkerRouteIncident(input.incident),
    receivedAtMs: input.receivedAtMs,
  });
}

function validateAgentOutput(
  input: unknown,
  maximumOutputCharacters: number,
): RouteIncidentDiagnosticAgentOutput {
  const record = requireExactRecord(input, ["recommendation", "ownerQuestion"]);
  const recommendation = readBoundedText(
    record["recommendation"],
    "Agent recommendation",
    Math.min(DEFAULT_MAXIMUM_RECOMMENDATION_CHARACTERS, maximumOutputCharacters),
  );
  const ownerQuestion = readBoundedText(
    record["ownerQuestion"],
    "Agent owner question",
    Math.min(DEFAULT_MAXIMUM_QUESTION_CHARACTERS, maximumOutputCharacters),
  );
  if (recommendation.length + ownerQuestion.length > maximumOutputCharacters) {
    throw new Error("The route diagnostic Agent result exceeds its total output bound.");
  }
  return Object.freeze({ recommendation, ownerQuestion });
}

function deterministicFallback(
  claim: RouteIncidentClaimPayload,
  reasonCode: Extract<
    RouteIncidentDiagnosisResult["reasonCode"],
    "AGENT_UNAVAILABLE" | "DIAGNOSIS_INTERRUPTED"
  >,
): RouteIncidentDiagnosisResult {
  const evidence = claim.incident.attempts
    .map(
      (attempt) =>
        `${attempt.kind}:${attempt.outcome}${attempt.code === undefined ? "" : `:${attempt.code}`}`,
    )
    .join(", ");
  return Object.freeze({
    incidentId: claim.incident.incidentId,
    fingerprint: claim.incident.fingerprint,
    profileRevision: claim.incident.profileRevision,
    authenticatedDeviceId: claim.authenticatedDeviceId,
    recommendation: `Deterministic recovery exhausted ${claim.incident.attempts.length} configured transport attempt(s) before the Device reconnected. Bounded evidence: ${evidence}.`,
    ownerQuestion:
      "Is this Device's configured private-network path to Main expected to be reachable now, or should its Transport Profile be reviewed?",
    source: "deterministic-fallback",
    reasonCode,
  });
}

function buildAgentPrompt(authenticatedDeviceId: string, incident: WorkerRouteIncidentV1): string {
  return [
    "You are diagnosing one OpenDelegate system transport incident, not a user Task.",
    "Deterministic retry and fallback were exhausted before this authenticated Device reconnected.",
    "Do not use tools, inspect the operating system, or propose executing network, VPN, firewall, route, or OS mutations.",
    "Use only the bounded evidence below. Do not invent endpoint addresses, labels, credentials, paths, logs, or commands.",
    "Return exactly one JSON object and no Markdown fence.",
    'Schema: {"recommendation":"concise owner-visible recommendation","ownerQuestion":"one targeted question for the owner"}.',
    JSON.stringify({
      authenticatedDeviceId,
      profileRevision: incident.profileRevision,
      fingerprint: incident.fingerprint,
      attempts: incident.attempts,
    }),
  ].join("\n");
}

async function rejectToolUse(handle: AgentRunHandle): Promise<void> {
  for await (const event of handle.events) {
    if (event.type === "tool_request" || event.type === "approval_request") {
      await safeCancel(handle);
      throw new Error("The reasoning-only route diagnostic Agent requested a tool.");
    }
  }
}

async function safeCancel(handle: AgentRunHandle): Promise<void> {
  await handle.cancel("The reasoning-only route diagnosis was rejected.").catch(() => undefined);
}

function validateAgentLimits(input: AgentRunLimits): AgentRunLimits {
  const fields = [
    "wallTimeoutMs",
    "idleTimeoutMs",
    "cancellationGraceMs",
    "leaseTtlMs",
    "leaseRenewIntervalMs",
    "maxBufferedEvents",
    "maxLineBytes",
    "maxDiagnosticBytes",
  ] as const;
  for (const field of fields) {
    if (!Number.isSafeInteger(input[field]) || input[field] <= 0) {
      throw new TypeError(`Route diagnostic Agent ${field} must be a positive safe integer.`);
    }
  }
  if (input.wallTimeoutMs > 120_000 || input.idleTimeoutMs > input.wallTimeoutMs) {
    throw new TypeError("Route diagnostic Agent time limits exceed the bounded incident policy.");
  }
  return Object.freeze({ ...input });
}

function assertEventStore(value: EventStore): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.append !== "function" ||
    typeof value.readStream !== "function" ||
    typeof value.readAll !== "function"
  ) {
    throw new TypeError("A durable Event Store is required for route incident diagnosis.");
  }
}

function incidentStreamId(deviceId: string, fingerprint: string): string {
  return `route_incident_${digest(`${deviceId}\u0000${fingerprint}`)}`;
}

function claimEventId(deviceId: string, incidentId: string): string {
  return `route_incident_claim_${digest(`${deviceId}\u0000${incidentId}`)}`;
}

function completedEventId(deviceId: string, incidentId: string): string {
  return `route_incident_completed_${digest(`${deviceId}\u0000${incidentId}`)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameClaim(left: RouteIncidentClaimPayload, right: RouteIncidentClaimPayload): boolean {
  return (
    left.authenticatedDeviceId === right.authenticatedDeviceId &&
    JSON.stringify(left.incident) === JSON.stringify(right.incident)
  );
}

function sameResult(
  left: RouteIncidentDiagnosisResult,
  right: RouteIncidentDiagnosisResult,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireExactRecord(value: unknown, exactKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The route incident durable document is not an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== exactKeys.length || keys.some((key) => !exactKeys.includes(key))) {
    throw new Error("The route incident durable document has an unexpected shape.");
  }
  return record;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertTimestamp(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("The route incident receive timestamp is invalid.");
  }
}

function readBoundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint === 0 || codePoint === 127);
    })
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertWorkspace(value: WorkspaceBinding): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.workspaceId !== "string" ||
    value.workspaceId.length === 0 ||
    typeof value.cwd !== "string" ||
    value.cwd.length === 0
  ) {
    throw new TypeError("The route diagnostic Agent Workspace is invalid.");
  }
}
