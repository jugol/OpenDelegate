import { isDeepStrictEqual } from "node:util";

import type {
  KnowledgeCandidate,
  KnowledgeRelationships,
  LocalKnowledgeService,
  OpenedKnowledge,
  UpsertKnowledgeNote,
  UpsertKnowledgeResult,
} from "@opendelegate/knowledge";
import {
  KNOWLEDGE_TOOL_NAMES,
  KnowledgeToolPortError,
  type KnowledgeMcpLimits,
  type KnowledgeOpenInput,
  type KnowledgeRelationshipsInput,
  type KnowledgeRunAuthority,
  type KnowledgeSearchInput,
  type KnowledgeToolContext,
  type KnowledgeToolPort,
  type KnowledgeUpsertInput,
} from "@opendelegate/knowledge-mcp";
import {
  RunCapabilityBrokerError,
  consumeRunCapabilityFile,
  type LocalRunCapabilityBroker,
  type RunCapabilityBinding,
  type RunCapabilityClient,
  type RunCapabilityJsonValue,
  type RunCapabilityLease,
  type RunCapabilityRequestContext,
} from "@opendelegate/run-capability-broker";
import type {
  WorkerEgressGuard,
  WorkerRunAssignmentV1,
  WorkerRunCapabilityLease,
  WorkerRunCapabilityProvider,
  WorkerRunLeaseAuthority,
} from "@opendelegate/worker-runtime";

const KNOWLEDGE_CAPABILITY = "device-local-knowledge";
const KNOWLEDGE_METADATA_SCHEMA_VERSION = 1;

export interface WorkerKnowledgeRunBudgets {
  readonly maxCumulativeSearchCandidates: number;
  readonly maxCumulativeOpenCharacters: number;
  readonly maxCumulativeContextCharacters: number;
}

export const DEFAULT_WORKER_KNOWLEDGE_RUN_BUDGETS: WorkerKnowledgeRunBudgets = Object.freeze({
  maxCumulativeSearchCandidates: 20,
  maxCumulativeOpenCharacters: 24_000,
  maxCumulativeContextCharacters: 48_000,
});

type WorkerLocalKnowledgePort = Pick<
  LocalKnowledgeService,
  "health" | "openNotes" | "relationships" | "search" | "upsertNote"
>;

export interface WorkerKnowledgeRunCapabilityProviderOptions {
  readonly broker: LocalRunCapabilityBroker;
  readonly knowledge: WorkerLocalKnowledgePort;
  readonly toolServerCommand: string;
  readonly toolServerArgsPrefix?: readonly string[];
  readonly budgets?: Partial<WorkerKnowledgeRunBudgets>;
}

/**
 * Exposes only the current Device's local Knowledge service to one exact Worker
 * Run. It claims no Computer Use or Device-wide mutable authority.
 */
export class WorkerKnowledgeRunCapabilityProvider implements WorkerRunCapabilityProvider {
  readonly #options: WorkerKnowledgeRunCapabilityProviderOptions;
  readonly #budgets: WorkerKnowledgeRunBudgets;

  public constructor(options: WorkerKnowledgeRunCapabilityProviderOptions) {
    validateProviderOptions(options);
    this.#options = options;
    this.#budgets = resolveBudgets(options.budgets);
  }

  public supports(_assignment: WorkerRunAssignmentV1): boolean {
    return this.#options.knowledge.health().status === "ready";
  }

  public async prepare(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly egressGuard: WorkerEgressGuard;
    readonly maxConcurrentConnections?: number;
    readonly leaseAuthority?: WorkerRunLeaseAuthority;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<WorkerRunCapabilityLease | undefined> {
    if (!this.supports(context.assignment)) {
      return undefined;
    }
    if (!(await safeCurrent(context.isExecutionCurrent))) {
      throw new KnowledgeToolPortError("STALE_AUTHORITY");
    }
    const binding = runCapabilityBinding(
      context.assignment,
      context.leaseAuthority?.snapshot().leaseExpiresAtMs ?? context.assignment.leaseExpiresAtMs,
    );
    const handler = new CurrentRunKnowledgeHandler({
      binding,
      knowledge: this.#options.knowledge,
      budgets: this.#budgets,
      egressGuard: context.egressGuard,
      isExecutionCurrent: context.isExecutionCurrent,
    });
    let brokerLease: RunCapabilityLease | undefined;
    try {
      brokerLease = await this.#options.broker.register({
        capability: KNOWLEDGE_CAPABILITY,
        maxConcurrentConnections: context.maxConcurrentConnections ?? 1,
        binding,
        metadata: knowledgeCapabilityMetadata(this.#budgets) as unknown as RunCapabilityJsonValue,
        expiresAtMs: binding.leaseExpiresAtMs,
        currentBinding: () =>
          runCapabilityBinding(
            context.assignment,
            context.leaseAuthority?.snapshot().leaseExpiresAtMs ??
              context.assignment.leaseExpiresAtMs,
          ),
        isExecutionCurrent: context.isExecutionCurrent,
        handler: (request, requestContext) =>
          handler.dispatch(request.method, request.payload, requestContext),
      });
      const lease = brokerLease;
      let disposed = false;
      return Object.freeze({
        toolServers: Object.freeze([
          Object.freeze({
            serverName: "opendelegate-knowledge",
            command: this.#options.toolServerCommand,
            args: Object.freeze([
              ...(this.#options.toolServerArgsPrefix ?? []),
              "knowledge-mcp-bridge",
              "--capability-file",
              lease.capabilityFile,
            ]),
            enabledTools: KNOWLEDGE_TOOL_NAMES,
            startupTimeoutMs: 15_000,
            toolTimeoutMs: 30_000,
          }),
        ]),
        async dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          await lease.dispose().catch(() => undefined);
        },
      });
    } catch (error) {
      await brokerLease?.dispose().catch(() => undefined);
      throw error;
    }
  }
}

export interface ConsumedKnowledgeRunCapability {
  readonly authority: KnowledgeRunAuthority;
  readonly limits: Required<
    Pick<
      KnowledgeMcpLimits,
      | "maxCumulativeSearchCandidates"
      | "maxCumulativeOpenCharacters"
      | "maxCumulativeContextCharacters"
    >
  >;
  readonly port: KnowledgeToolPort;
  close(): Promise<void>;
}

/**
 * Consumes a one-time 0600 capability file and returns the single authenticated
 * MCP connection. The descriptor never contains a Knowledge root or note data.
 */
export async function consumeKnowledgeRunCapabilityFile(
  filename: string,
): Promise<ConsumedKnowledgeRunCapability> {
  const client = await consumeRunCapabilityFile({
    filename,
    expectedCapability: KNOWLEDGE_CAPABILITY,
  });
  try {
    const authority = authorityFromBinding(client.binding);
    const limits = parseKnowledgeCapabilityMetadata(client.metadata);
    return Object.freeze({
      authority,
      limits,
      port: new BrokerKnowledgeToolPort(client, authority),
      close: () => client.close(),
    });
  } catch (error) {
    await client.close();
    throw error;
  }
}

class CurrentRunKnowledgeHandler {
  readonly #binding: RunCapabilityBinding;
  readonly #knowledge: WorkerLocalKnowledgePort;
  readonly #budgets: WorkerKnowledgeRunBudgets;
  readonly #egressGuard: WorkerEgressGuard;
  readonly #isExecutionCurrent: () => Promise<boolean>;
  #searchCandidatesUsed = 0;
  #openCharactersUsed = 0;
  #contextCharactersUsed = 0;

  public constructor(options: {
    readonly binding: RunCapabilityBinding;
    readonly knowledge: WorkerLocalKnowledgePort;
    readonly budgets: WorkerKnowledgeRunBudgets;
    readonly egressGuard: WorkerEgressGuard;
    isExecutionCurrent(): Promise<boolean>;
  }) {
    this.#binding = options.binding;
    this.#knowledge = options.knowledge;
    this.#budgets = options.budgets;
    this.#egressGuard = options.egressGuard;
    this.#isExecutionCurrent = options.isExecutionCurrent;
  }

  public async dispatch(
    method: string,
    payload: RunCapabilityJsonValue,
    context: RunCapabilityRequestContext,
  ): Promise<RunCapabilityJsonValue> {
    await this.#assertCurrent(context);
    let result: RunCapabilityJsonValue;
    switch (method) {
      case "search": {
        const input = parseSearchPayload(payload);
        this.#reserveSearch(input.limit ?? 5);
        const candidates = await this.#knowledge.search(input.query, {
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
        await this.#egressGuard.protectKnowledge({
          noteIds: candidates.map(({ noteId }) => noteId),
          titles: candidates.map(({ title }) => title),
          contents: candidates.map(({ preview }) => preview),
        });
        result = toJsonValue(candidates);
        break;
      }
      case "open": {
        const input = parseOpenPayload(payload);
        this.#reserveOpen(input.totalCharacterBudget);
        const opened = await this.#knowledge.openNotes(input.noteIds, {
          totalCharacterBudget: input.totalCharacterBudget,
        });
        await this.#egressGuard.protectKnowledge({
          noteIds: [...opened.notes.map(({ noteId }) => noteId), ...opened.omittedNoteIds],
          titles: opened.notes.map(({ title }) => title),
          contents: opened.notes.map(({ content }) => content),
        });
        result = toJsonValue(opened);
        break;
      }
      case "relationships": {
        const input = parseRelationshipsPayload(payload);
        const relationships = await this.#knowledge.relationships(input.noteId);
        await this.#egressGuard.protectKnowledge({
          noteIds: [input.noteId, ...relationships.outgoing, ...relationships.backlinks],
          titles: [],
          contents: [],
        });
        result = toJsonValue(relationships);
        break;
      }
      case "upsert": {
        const input = parseUpsertPayload(payload);
        const upserted = await this.#knowledge.upsertNote(input, {
          // The Knowledge service invokes this after its temporary write and
          // immediately before the atomic rename that makes the note visible.
          beforeCommit: () => this.#assertCurrent(context),
        });
        await this.#egressGuard.protectKnowledge({
          noteIds: [input.noteId, upserted.noteId],
          titles: [],
          contents: [input.content],
        });
        result = toJsonValue(upserted);
        break;
      }
      default:
        throw new KnowledgeToolPortError("FAILED");
    }
    await this.#assertCurrent(context);
    this.#reserveContext(JSON.stringify(result).length);
    return result;
  }

  async #assertCurrent(context: RunCapabilityRequestContext): Promise<void> {
    if (context.signal.aborted) {
      throw new KnowledgeToolPortError("CANCELLED");
    }
    if (
      !sameRunBinding(context.binding, this.#binding) ||
      !(await safeCurrent(this.#isExecutionCurrent))
    ) {
      throw new KnowledgeToolPortError("STALE_AUTHORITY");
    }
  }

  #reserveSearch(requested: number): void {
    if (this.#searchCandidatesUsed + requested > this.#budgets.maxCumulativeSearchCandidates) {
      this.#searchCandidatesUsed = this.#budgets.maxCumulativeSearchCandidates;
      throw new KnowledgeToolPortError("BUDGET_EXHAUSTED");
    }
    this.#searchCandidatesUsed += requested;
  }

  #reserveOpen(requested: number): void {
    if (this.#openCharactersUsed + requested > this.#budgets.maxCumulativeOpenCharacters) {
      this.#openCharactersUsed = this.#budgets.maxCumulativeOpenCharacters;
      throw new KnowledgeToolPortError("BUDGET_EXHAUSTED");
    }
    this.#openCharactersUsed += requested;
  }

  #reserveContext(characters: number): void {
    if (this.#contextCharactersUsed + characters > this.#budgets.maxCumulativeContextCharacters) {
      this.#contextCharactersUsed = this.#budgets.maxCumulativeContextCharacters;
      throw new KnowledgeToolPortError("BUDGET_EXHAUSTED");
    }
    this.#contextCharactersUsed += characters;
  }
}

class BrokerKnowledgeToolPort implements KnowledgeToolPort {
  readonly #client: RunCapabilityClient;
  readonly #authority: KnowledgeRunAuthority;

  public constructor(client: RunCapabilityClient, authority: KnowledgeRunAuthority) {
    this.#client = client;
    this.#authority = authority;
  }

  public async search(
    context: KnowledgeToolContext,
    input: KnowledgeSearchInput,
  ): Promise<readonly KnowledgeCandidate[]> {
    return parseCandidates(
      await this.#request(context, "search", toJsonValue(input)),
      input.limit ?? 5,
    );
  }

  public async open(
    context: KnowledgeToolContext,
    input: KnowledgeOpenInput,
  ): Promise<OpenedKnowledge> {
    return parseOpened(await this.#request(context, "open", toJsonValue(input)), input);
  }

  public async relationships(
    context: KnowledgeToolContext,
    input: KnowledgeRelationshipsInput,
  ): Promise<KnowledgeRelationships> {
    return parseRelationships(await this.#request(context, "relationships", toJsonValue(input)));
  }

  public async upsert(
    context: KnowledgeToolContext,
    input: KnowledgeUpsertInput,
  ): Promise<UpsertKnowledgeResult> {
    return parseUpsertResult(
      await this.#request(context, "upsert", toJsonValue(input)),
      input.noteId,
    );
  }

  async #request(
    context: KnowledgeToolContext,
    method: string,
    payload: RunCapabilityJsonValue,
  ): Promise<RunCapabilityJsonValue> {
    requireExactAuthority(context, this.#authority);
    try {
      return await this.#client.request({
        method,
        payload,
        signal: context.signal,
      });
    } catch (error) {
      throw mapBrokerError(error);
    }
  }
}

function knowledgeCapabilityMetadata(
  budgets: WorkerKnowledgeRunBudgets,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: KNOWLEDGE_METADATA_SCHEMA_VERSION,
    limits: Object.freeze({ ...budgets }),
  });
}

function parseKnowledgeCapabilityMetadata(
  input: RunCapabilityJsonValue,
): WorkerKnowledgeRunBudgets {
  const record = requireRecord(input);
  requireExactKeys(record, ["schemaVersion", "limits"]);
  if (record["schemaVersion"] !== KNOWLEDGE_METADATA_SCHEMA_VERSION) {
    throw new KnowledgeToolPortError("FAILED");
  }
  const limits = requireRecord(record["limits"]);
  requireExactKeys(limits, [
    "maxCumulativeSearchCandidates",
    "maxCumulativeOpenCharacters",
    "maxCumulativeContextCharacters",
  ]);
  return resolveBudgets({
    maxCumulativeSearchCandidates: requireInteger(
      limits["maxCumulativeSearchCandidates"],
      1,
      1_000,
    ),
    maxCumulativeOpenCharacters: requireInteger(
      limits["maxCumulativeOpenCharacters"],
      1,
      1_000_000,
    ),
    maxCumulativeContextCharacters: requireInteger(
      limits["maxCumulativeContextCharacters"],
      1,
      2_000_000,
    ),
  });
}

function runCapabilityBinding(
  assignment: WorkerRunAssignmentV1,
  leaseExpiresAtMs: number,
): RunCapabilityBinding {
  return Object.freeze({
    taskId: assignment.taskId,
    workOrderId: assignment.workOrder.workOrderId,
    runId: assignment.runId,
    deviceId: assignment.deviceId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
    leaseExpiresAtMs,
  });
}

function sameRunBinding(current: RunCapabilityBinding, initial: RunCapabilityBinding): boolean {
  return (
    current.taskId === initial.taskId &&
    current.workOrderId === initial.workOrderId &&
    current.runId === initial.runId &&
    current.deviceId === initial.deviceId &&
    current.leaseId === initial.leaseId &&
    current.fencingToken === initial.fencingToken &&
    current.leaseExpiresAtMs >= initial.leaseExpiresAtMs
  );
}

function authorityFromBinding(binding: RunCapabilityBinding): KnowledgeRunAuthority {
  return Object.freeze({ ...binding });
}

function requireExactAuthority(
  context: KnowledgeToolContext,
  authority: KnowledgeRunAuthority,
): void {
  if (context.signal.aborted) {
    throw new KnowledgeToolPortError("CANCELLED");
  }
  if (!isDeepStrictEqual(context.authority, authority)) {
    throw new KnowledgeToolPortError("STALE_AUTHORITY");
  }
}

function parseSearchPayload(value: RunCapabilityJsonValue): KnowledgeSearchInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["query"], ["limit"]);
  const query = requireString(record["query"], 1_024);
  if (query !== query.trim()) {
    throw new KnowledgeToolPortError("FAILED");
  }
  return Object.freeze({
    query,
    ...(record["limit"] === undefined ? {} : { limit: requireInteger(record["limit"], 1, 20) }),
  });
}

function parseOpenPayload(value: RunCapabilityJsonValue): KnowledgeOpenInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["noteIds", "totalCharacterBudget"]);
  const noteIds = requireNoteIds(record["noteIds"], 32);
  return Object.freeze({
    noteIds,
    totalCharacterBudget: requireInteger(record["totalCharacterBudget"], 1, 12_000),
  });
}

function parseRelationshipsPayload(value: RunCapabilityJsonValue): KnowledgeRelationshipsInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["noteId"]);
  return Object.freeze({ noteId: requireNoteId(record["noteId"]) });
}

function parseUpsertPayload(value: RunCapabilityJsonValue): UpsertKnowledgeNote {
  const record = requireRecord(value);
  requireExactKeys(record, ["noteId", "contentKind", "content", "qualification"]);
  const contentKind = record["contentKind"];
  if (
    contentKind !== "durable-device-knowledge" &&
    contentKind !== "credential" &&
    contentKind !== "raw-transcript" &&
    contentKind !== "raw-log" &&
    contentKind !== "temporary-task-state" &&
    contentKind !== "common-fact"
  ) {
    throw new KnowledgeToolPortError("FAILED");
  }
  const qualification = requireRecord(record["qualification"]);
  requireExactKeys(qualification, [
    "deviceSpecific",
    "repeatedlyUseful",
    "expensiveToRediscover",
    "actionable",
  ]);
  return Object.freeze({
    noteId: requireNoteId(record["noteId"]),
    contentKind,
    content: requireString(record["content"], 20_000, false),
    qualification: Object.freeze({
      deviceSpecific: requireBoolean(qualification["deviceSpecific"]),
      repeatedlyUseful: requireBoolean(qualification["repeatedlyUseful"]),
      expensiveToRediscover: requireBoolean(qualification["expensiveToRediscover"]),
      actionable: requireBoolean(qualification["actionable"]),
    }),
  });
}

function parseCandidates(
  value: RunCapabilityJsonValue,
  maximumCandidates: number,
): readonly KnowledgeCandidate[] {
  if (!Array.isArray(value) || value.length > maximumCandidates) {
    throw new KnowledgeToolPortError("FAILED");
  }
  const candidates = Object.freeze(
    value.map((entry) => {
      const candidate = requireRecord(entry);
      requireExactKeys(candidate, ["noteId", "title", "preview"]);
      return Object.freeze({
        noteId: requireNoteId(candidate["noteId"]),
        title: requireString(candidate["title"], 512),
        preview: requireString(candidate["preview"], 2_048, true),
      });
    }),
  );
  if (new Set(candidates.map(({ noteId }) => noteId)).size !== candidates.length) {
    throw new KnowledgeToolPortError("FAILED");
  }
  return candidates;
}

function parseOpened(value: RunCapabilityJsonValue, input: KnowledgeOpenInput): OpenedKnowledge {
  const opened = requireRecord(value);
  requireExactKeys(opened, ["characterBudget", "usedCharacters", "notes", "omittedNoteIds"]);
  const characterBudget = requireInteger(opened["characterBudget"], 0, input.totalCharacterBudget);
  const usedCharacters = requireInteger(opened["usedCharacters"], 0, characterBudget);
  const notesValue = opened["notes"];
  if (!Array.isArray(notesValue) || notesValue.length > 32) {
    throw new KnowledgeToolPortError("FAILED");
  }
  const notes = notesValue.map((entry) => {
    const note = requireRecord(entry);
    requireExactKeys(note, ["noteId", "title", "content", "truncated"]);
    return Object.freeze({
      noteId: requireNoteId(note["noteId"]),
      title: requireString(note["title"], 512),
      content: requireString(note["content"], 12_000, true),
      truncated: requireBoolean(note["truncated"]),
    });
  });
  if (notes.reduce((total, note) => total + note.content.length, 0) !== usedCharacters) {
    throw new KnowledgeToolPortError("FAILED");
  }
  const omittedNoteIds = requireNoteIds(opened["omittedNoteIds"], 32, true);
  const returnedNoteIds = [...notes.map(({ noteId }) => noteId), ...omittedNoteIds];
  if (
    new Set(returnedNoteIds).size !== returnedNoteIds.length ||
    returnedNoteIds.length !== input.noteIds.length ||
    returnedNoteIds.some((noteId) => !input.noteIds.includes(noteId))
  ) {
    throw new KnowledgeToolPortError("FAILED");
  }
  return Object.freeze({
    characterBudget,
    usedCharacters,
    notes: Object.freeze(notes),
    omittedNoteIds,
  });
}

function parseRelationships(value: RunCapabilityJsonValue): KnowledgeRelationships {
  const relationships = requireRecord(value);
  requireExactKeys(relationships, ["outgoing", "backlinks"]);
  return Object.freeze({
    outgoing: requireNoteIds(relationships["outgoing"], 128, true),
    backlinks: requireNoteIds(relationships["backlinks"], 128, true),
  });
}

function parseUpsertResult(
  value: RunCapabilityJsonValue,
  expectedNoteId: string,
): UpsertKnowledgeResult {
  const result = requireRecord(value);
  requireExactKeys(result, ["noteId", "operation"]);
  if (
    result["noteId"] !== expectedNoteId ||
    (result["operation"] !== "created" && result["operation"] !== "updated")
  ) {
    throw new KnowledgeToolPortError("FAILED");
  }
  return Object.freeze({
    noteId: requireNoteId(result["noteId"]),
    operation: result["operation"],
  });
}

function resolveBudgets(
  input: Partial<WorkerKnowledgeRunBudgets> | undefined,
): WorkerKnowledgeRunBudgets {
  return Object.freeze({
    maxCumulativeSearchCandidates: requireInteger(
      input?.maxCumulativeSearchCandidates ??
        DEFAULT_WORKER_KNOWLEDGE_RUN_BUDGETS.maxCumulativeSearchCandidates,
      1,
      1_000,
    ),
    maxCumulativeOpenCharacters: requireInteger(
      input?.maxCumulativeOpenCharacters ??
        DEFAULT_WORKER_KNOWLEDGE_RUN_BUDGETS.maxCumulativeOpenCharacters,
      1,
      1_000_000,
    ),
    maxCumulativeContextCharacters: requireInteger(
      input?.maxCumulativeContextCharacters ??
        DEFAULT_WORKER_KNOWLEDGE_RUN_BUDGETS.maxCumulativeContextCharacters,
      1,
      2_000_000,
    ),
  });
}

function validateProviderOptions(options: WorkerKnowledgeRunCapabilityProviderOptions): void {
  const knowledge = options.knowledge as unknown;
  if (
    options.broker === null ||
    typeof options.broker !== "object" ||
    typeof options.broker.register !== "function" ||
    knowledge === null ||
    typeof knowledge !== "object" ||
    !["health", "openNotes", "relationships", "search", "upsertNote"].every(
      (method) => typeof (knowledge as Readonly<Record<string, unknown>>)[method] === "function",
    ) ||
    !validCommand(options.toolServerCommand) ||
    (options.toolServerArgsPrefix !== undefined &&
      (!Array.isArray(options.toolServerArgsPrefix) ||
        options.toolServerArgsPrefix.length > 32 ||
        !options.toolServerArgsPrefix.every(validCommand)))
  ) {
    throw new TypeError("The Worker Knowledge Run capability configuration is invalid.");
  }
}

function mapBrokerError(error: unknown): KnowledgeToolPortError {
  if (error instanceof KnowledgeToolPortError) {
    return error;
  }
  if (error instanceof RunCapabilityBrokerError) {
    if (error.code === "REQUEST_CANCELLED") {
      return new KnowledgeToolPortError("CANCELLED");
    }
    if (
      error.code === "CAPABILITY_REVOKED" ||
      error.code === "CAPABILITY_EXPIRED" ||
      error.code === "CONNECTION_FAILED"
    ) {
      return new KnowledgeToolPortError("STALE_AUTHORITY");
    }
  }
  return new KnowledgeToolPortError("FAILED");
}

function toJsonValue(value: unknown): RunCapabilityJsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as RunCapabilityJsonValue;
  } catch {
    throw new KnowledgeToolPortError("FAILED");
  }
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeToolPortError("FAILED");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new KnowledgeToolPortError("FAILED");
  }
}

function requireString(value: unknown, maximumCharacters: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumCharacters ||
    [...value].some((character) => {
      const point = character.codePointAt(0);
      return (
        point === undefined ||
        (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
        point === 127
      );
    })
  ) {
    throw new KnowledgeToolPortError("FAILED");
  }
  return value;
}

function requireNoteId(value: unknown): string {
  const noteId = requireString(value, 512);
  if (
    noteId !== noteId.trim() ||
    noteId.startsWith("/") ||
    noteId.includes("\\") ||
    !noteId.toLocaleLowerCase("en-US").endsWith(".md") ||
    noteId
      .split("/")
      .some(
        (component) =>
          component.length === 0 ||
          component === "." ||
          component === ".." ||
          /[<>:"|?*]/u.test(component),
      )
  ) {
    throw new KnowledgeToolPortError("FAILED");
  }
  return noteId;
}

function requireNoteIds(value: unknown, maximum: number, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new KnowledgeToolPortError("FAILED");
  }
  const noteIds = value.map(requireNoteId);
  if (new Set(noteIds).size !== noteIds.length) {
    throw new KnowledgeToolPortError("FAILED");
  }
  return Object.freeze(noteIds);
}

function requireInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new KnowledgeToolPortError("FAILED");
  }
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new KnowledgeToolPortError("FAILED");
  }
  return value;
}

function validCommand(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 4_096
  );
}

async function safeCurrent(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}
