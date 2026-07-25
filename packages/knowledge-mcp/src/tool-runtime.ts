import {
  KNOWLEDGE_TOOL_NAMES,
  type KnowledgeCandidate,
  type KnowledgeContentKind,
  type KnowledgeOpenInput,
  type KnowledgeRelationships,
  type KnowledgeRelationshipsInput,
  type KnowledgeRunAuthority,
  type KnowledgeSearchInput,
  type KnowledgeToolContext,
  type KnowledgeToolName,
  type KnowledgeToolPort,
  type KnowledgeUpsertInput,
} from "./contracts.ts";

const CONTENT_KINDS = new Set<KnowledgeContentKind>([
  "durable-device-knowledge",
  "credential",
  "raw-transcript",
  "raw-log",
  "temporary-task-state",
  "common-fact",
]);

export type ParsedKnowledgeToolCall =
  | { readonly name: "knowledge_search"; readonly input: KnowledgeSearchInput }
  | { readonly name: "knowledge_open"; readonly input: KnowledgeOpenInput }
  | {
      readonly name: "knowledge_relationships";
      readonly input: KnowledgeRelationshipsInput;
    }
  | { readonly name: "knowledge_upsert"; readonly input: KnowledgeUpsertInput };

export class InvalidKnowledgePortResultError extends Error {
  public constructor() {
    super("The device-local Knowledge execution port returned an invalid result.");
    this.name = "InvalidKnowledgePortResultError";
  }
}

export function normalizeKnowledgeRunAuthority(
  value: KnowledgeRunAuthority,
): KnowledgeRunAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "taskId",
      "workOrderId",
      "runId",
      "deviceId",
      "leaseId",
      "fencingToken",
      "leaseExpiresAtMs",
    ]) ||
    !isIdentifier(value.taskId, 256) ||
    !isIdentifier(value.workOrderId, 256) ||
    !isIdentifier(value.runId, 256) ||
    !isIdentifier(value.deviceId, 256) ||
    !isIdentifier(value.leaseId, 256) ||
    !isPositiveSafeInteger(value.fencingToken) ||
    !isPositiveSafeInteger(value.leaseExpiresAtMs)
  ) {
    throw new TypeError("Knowledge MCP Run authority is invalid.");
  }
  return Object.freeze({
    taskId: value.taskId,
    workOrderId: value.workOrderId,
    runId: value.runId,
    deviceId: value.deviceId,
    leaseId: value.leaseId,
    fencingToken: value.fencingToken,
    leaseExpiresAtMs: value.leaseExpiresAtMs,
  });
}

export function requireKnowledgeToolPort(value: KnowledgeToolPort): KnowledgeToolPort {
  const candidate = value as unknown;
  if (
    !isRecord(candidate) ||
    !["search", "open", "relationships", "upsert"].every(
      (name) => typeof candidate[name] === "function",
    )
  ) {
    throw new TypeError("Knowledge MCP execution port is invalid.");
  }
  return value;
}

export function parseKnowledgeToolCall(
  name: unknown,
  argumentsValue: unknown,
): ParsedKnowledgeToolCall | null {
  if (
    typeof name !== "string" ||
    !KNOWLEDGE_TOOL_NAMES.includes(name as KnowledgeToolName) ||
    !isRecord(argumentsValue)
  ) {
    return null;
  }
  switch (name as KnowledgeToolName) {
    case "knowledge_search":
      return parseSearch(argumentsValue);
    case "knowledge_open":
      return parseOpen(argumentsValue);
    case "knowledge_relationships":
      return parseRelationships(argumentsValue);
    case "knowledge_upsert":
      return parseUpsert(argumentsValue);
  }
}

export async function executeKnowledgeTool(
  port: KnowledgeToolPort,
  authority: KnowledgeRunAuthority,
  call: ParsedKnowledgeToolCall,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  const context: KnowledgeToolContext = Object.freeze({ authority, signal });
  switch (call.name) {
    case "knowledge_search":
      return textToolResult(
        normalizeCandidates(await port.search(context, call.input), call.input.limit ?? 5),
      );
    case "knowledge_open":
      return textToolResult(normalizeOpened(await port.open(context, call.input), call.input));
    case "knowledge_relationships":
      return textToolResult(normalizeRelationships(await port.relationships(context, call.input)));
    case "knowledge_upsert":
      return textToolResult(
        normalizeUpsert(await port.upsert(context, call.input), call.input.noteId),
      );
  }
}

export function toolResultText(result: Readonly<Record<string, unknown>>): string {
  const content = result["content"];
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    !isRecord(content[0]) ||
    content[0]["type"] !== "text" ||
    typeof content[0]["text"] !== "string"
  ) {
    throw new InvalidKnowledgePortResultError();
  }
  return content[0]["text"];
}

function parseSearch(value: Readonly<Record<string, unknown>>): ParsedKnowledgeToolCall | null {
  if (
    !hasExactRequiredKeys(value, ["query", "limit"], ["query"]) ||
    !isDisplayText(value["query"], 1_024) ||
    value["query"] !== value["query"].trim() ||
    (hasOwn(value, "limit") && !isIntegerInRange(value["limit"], 1, 20))
  ) {
    return null;
  }
  return {
    name: "knowledge_search",
    input: {
      query: value["query"],
      ...(hasOwn(value, "limit") ? { limit: value["limit"] as number } : {}),
    },
  };
}

function parseOpen(value: Readonly<Record<string, unknown>>): ParsedKnowledgeToolCall | null {
  if (
    !hasExactRequiredKeys(
      value,
      ["noteIds", "totalCharacterBudget"],
      ["noteIds", "totalCharacterBudget"],
    ) ||
    !Array.isArray(value["noteIds"]) ||
    value["noteIds"].length < 1 ||
    value["noteIds"].length > 32 ||
    !value["noteIds"].every(isSafeNoteId) ||
    new Set(value["noteIds"]).size !== value["noteIds"].length ||
    !isIntegerInRange(value["totalCharacterBudget"], 1, 12_000)
  ) {
    return null;
  }
  return {
    name: "knowledge_open",
    input: {
      noteIds: Object.freeze([...value["noteIds"]]),
      totalCharacterBudget: value["totalCharacterBudget"],
    },
  };
}

function parseRelationships(
  value: Readonly<Record<string, unknown>>,
): ParsedKnowledgeToolCall | null {
  return hasExactRequiredKeys(value, ["noteId"], ["noteId"]) && isSafeNoteId(value["noteId"])
    ? { name: "knowledge_relationships", input: { noteId: value["noteId"] } }
    : null;
}

function parseUpsert(value: Readonly<Record<string, unknown>>): ParsedKnowledgeToolCall | null {
  const qualification = value["qualification"];
  if (
    !hasExactRequiredKeys(
      value,
      ["noteId", "contentKind", "content", "qualification"],
      ["noteId", "contentKind", "content", "qualification"],
    ) ||
    !isSafeNoteId(value["noteId"]) ||
    typeof value["contentKind"] !== "string" ||
    !CONTENT_KINDS.has(value["contentKind"] as KnowledgeContentKind) ||
    !isDisplayText(value["content"], 20_000) ||
    !isRecord(qualification) ||
    !hasExactRequiredKeys(
      qualification,
      ["deviceSpecific", "repeatedlyUseful", "expensiveToRediscover", "actionable"],
      ["deviceSpecific", "repeatedlyUseful", "expensiveToRediscover", "actionable"],
    ) ||
    !Object.values(qualification).every((entry) => typeof entry === "boolean")
  ) {
    return null;
  }
  return {
    name: "knowledge_upsert",
    input: {
      noteId: value["noteId"],
      contentKind: value["contentKind"] as KnowledgeContentKind,
      content: value["content"],
      qualification: Object.freeze({
        deviceSpecific: qualification["deviceSpecific"] as boolean,
        repeatedlyUseful: qualification["repeatedlyUseful"] as boolean,
        expensiveToRediscover: qualification["expensiveToRediscover"] as boolean,
        actionable: qualification["actionable"] as boolean,
      }),
    },
  };
}

function normalizeCandidates(
  value: readonly KnowledgeCandidate[],
  maximumCandidates: number,
): readonly KnowledgeCandidate[] {
  if (!Array.isArray(value) || value.length > maximumCandidates) {
    throw new InvalidKnowledgePortResultError();
  }
  const noteIds = new Set<string>();
  return Object.freeze(
    value.map((candidate) => {
      if (
        !isRecord(candidate) ||
        !hasExactRequiredKeys(
          candidate,
          ["noteId", "title", "preview"],
          ["noteId", "title", "preview"],
        ) ||
        !isSafeNoteId(candidate["noteId"]) ||
        noteIds.has(candidate["noteId"]) ||
        !isDisplayText(candidate["title"], 512) ||
        !isDisplayText(candidate["preview"], 2_048, true)
      ) {
        throw new InvalidKnowledgePortResultError();
      }
      noteIds.add(candidate["noteId"]);
      return Object.freeze({
        noteId: candidate["noteId"],
        title: candidate["title"],
        preview: candidate["preview"],
      });
    }),
  );
}

function normalizeOpened(
  value: unknown,
  input: KnowledgeOpenInput,
): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    !hasExactRequiredKeys(
      value,
      ["characterBudget", "usedCharacters", "notes", "omittedNoteIds"],
      ["characterBudget", "usedCharacters", "notes", "omittedNoteIds"],
    ) ||
    !isIntegerInRange(value["characterBudget"], 0, input.totalCharacterBudget) ||
    !isIntegerInRange(value["usedCharacters"], 0, value["characterBudget"]) ||
    !Array.isArray(value["notes"]) ||
    value["notes"].length > 32 ||
    !Array.isArray(value["omittedNoteIds"]) ||
    value["omittedNoteIds"].length > 32 ||
    !value["omittedNoteIds"].every(isSafeNoteId) ||
    new Set(value["omittedNoteIds"]).size !== value["omittedNoteIds"].length
  ) {
    throw new InvalidKnowledgePortResultError();
  }
  const expectedNoteIds = new Set(input.noteIds);
  const returnedNoteIds = new Set<string>();
  const notes = value["notes"].map((note) => {
    if (
      !isRecord(note) ||
      !hasExactRequiredKeys(
        note,
        ["noteId", "title", "content", "truncated"],
        ["noteId", "title", "content", "truncated"],
      ) ||
      !isSafeNoteId(note["noteId"]) ||
      !expectedNoteIds.has(note["noteId"]) ||
      returnedNoteIds.has(note["noteId"]) ||
      !isDisplayText(note["title"], 512) ||
      !isDisplayText(note["content"], 12_000, true) ||
      typeof note["truncated"] !== "boolean"
    ) {
      throw new InvalidKnowledgePortResultError();
    }
    returnedNoteIds.add(note["noteId"]);
    return {
      noteId: note["noteId"],
      title: note["title"],
      content: note["content"],
      truncated: note["truncated"],
    };
  });
  for (const noteId of value["omittedNoteIds"]) {
    if (!expectedNoteIds.has(noteId) || returnedNoteIds.has(noteId)) {
      throw new InvalidKnowledgePortResultError();
    }
    returnedNoteIds.add(noteId);
  }
  const actualCharacters = notes.reduce((total, note) => total + note.content.length, 0);
  if (
    actualCharacters !== value["usedCharacters"] ||
    returnedNoteIds.size !== expectedNoteIds.size
  ) {
    throw new InvalidKnowledgePortResultError();
  }
  return {
    characterBudget: value["characterBudget"],
    usedCharacters: value["usedCharacters"],
    notes,
    omittedNoteIds: [...value["omittedNoteIds"]],
  };
}

function normalizeRelationships(value: KnowledgeRelationships): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    !hasExactRequiredKeys(value, ["outgoing", "backlinks"], ["outgoing", "backlinks"]) ||
    !Array.isArray(value["outgoing"]) ||
    value["outgoing"].length > 128 ||
    !value["outgoing"].every(isSafeNoteId) ||
    new Set(value["outgoing"]).size !== value["outgoing"].length ||
    !Array.isArray(value["backlinks"]) ||
    value["backlinks"].length > 128 ||
    !value["backlinks"].every(isSafeNoteId) ||
    new Set(value["backlinks"]).size !== value["backlinks"].length
  ) {
    throw new InvalidKnowledgePortResultError();
  }
  return {
    outgoing: [...value["outgoing"]],
    backlinks: [...value["backlinks"]],
  };
}

function normalizeUpsert(
  value: unknown,
  expectedNoteId: string,
): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    !hasExactRequiredKeys(value, ["noteId", "operation"], ["noteId", "operation"]) ||
    value["noteId"] !== expectedNoteId ||
    (value["operation"] !== "created" && value["operation"] !== "updated")
  ) {
    throw new InvalidKnowledgePortResultError();
  }
  return { noteId: value["noteId"], operation: value["operation"] };
}

function textToolResult(value: unknown): Readonly<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}

function hasExactRequiredKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  return hasExactKeys(value, allowed) && required.every((key) => hasOwn(value, key));
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !containsDisallowedTextControl(value)
  );
}

function isSafeNoteId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 512 ||
    value !== value.trim() ||
    value.startsWith("/") ||
    value.includes("\\") ||
    !value.toLocaleLowerCase("en-US").endsWith(".md") ||
    containsDisallowedTextControl(value)
  ) {
    return false;
  }
  const components = value.split("/");
  return components.every(
    (component) =>
      component.length > 0 &&
      component !== "." &&
      component !== ".." &&
      !/[<>:"|?*]/u.test(component),
  );
}

function isDisplayText(value: unknown, maximumLength: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximumLength &&
    !containsDisallowedTextControl(value)
  );
}

function containsDisallowedTextControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
      codePoint === 127
    );
  });
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}
