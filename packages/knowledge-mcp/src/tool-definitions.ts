import type { KnowledgeMcpProtocolVersion, KnowledgeToolName } from "./contracts.ts";
import { KNOWLEDGE_TOOL_NAMES } from "./contracts.ts";

type JsonSchema = Readonly<Record<string, unknown>>;

interface ToolDefinition {
  readonly name: KnowledgeToolName;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: Readonly<{
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  }>;
}

const NOTE_ID = Object.freeze({
  type: "string",
  minLength: 4,
  maxLength: 512,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.md$",
});

const QUALIFICATION = Object.freeze({
  type: "object",
  properties: Object.freeze({
    deviceSpecific: Object.freeze({ type: "boolean" }),
    repeatedlyUseful: Object.freeze({ type: "boolean" }),
    expensiveToRediscover: Object.freeze({ type: "boolean" }),
    actionable: Object.freeze({ type: "boolean" }),
  }),
  required: Object.freeze([
    "deviceSpecific",
    "repeatedlyUseful",
    "expensiveToRediscover",
    "actionable",
  ]),
  additionalProperties: false,
});

const BASE_DEFINITIONS: Readonly<
  Record<
    KnowledgeToolName,
    Readonly<{
      title: string;
      description: string;
      inputSchema: JsonSchema;
      readOnly: boolean;
      idempotent: boolean;
    }>
  >
> = Object.freeze({
  knowledge_search: Object.freeze({
    title: "Search device Knowledge",
    description:
      "Search the current device's local Knowledge index and return a bounded candidate list.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        query: Object.freeze({ type: "string", minLength: 1, maxLength: 1_024 }),
        limit: Object.freeze({ type: "integer", minimum: 1, maximum: 20 }),
      }),
      required: Object.freeze(["query"]),
      additionalProperties: false,
    }),
    readOnly: true,
    idempotent: true,
  }),
  knowledge_open: Object.freeze({
    title: "Open device Knowledge",
    description:
      "Open selected local Knowledge notes within an explicit per-call and cumulative character budget.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        noteIds: Object.freeze({
          type: "array",
          items: NOTE_ID,
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
        }),
        totalCharacterBudget: Object.freeze({
          type: "integer",
          minimum: 1,
          maximum: 12_000,
        }),
      }),
      required: Object.freeze(["noteIds", "totalCharacterBudget"]),
      additionalProperties: false,
    }),
    readOnly: true,
    idempotent: true,
  }),
  knowledge_relationships: Object.freeze({
    title: "Read Knowledge relationships",
    description:
      "Read bounded outgoing references and backlinks for one device-local Knowledge note.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ noteId: NOTE_ID }),
      required: Object.freeze(["noteId"]),
      additionalProperties: false,
    }),
    readOnly: true,
    idempotent: true,
  }),
  knowledge_upsert: Object.freeze({
    title: "Upsert durable device Knowledge",
    description:
      "Create or update a qualified local Markdown note through the deterministic Knowledge admission path.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        noteId: NOTE_ID,
        contentKind: Object.freeze({
          type: "string",
          enum: Object.freeze([
            "durable-device-knowledge",
            "credential",
            "raw-transcript",
            "raw-log",
            "temporary-task-state",
            "common-fact",
          ]),
        }),
        content: Object.freeze({ type: "string", minLength: 1, maxLength: 20_000 }),
        qualification: QUALIFICATION,
      }),
      required: Object.freeze(["noteId", "contentKind", "content", "qualification"]),
      additionalProperties: false,
    }),
    readOnly: false,
    idempotent: true,
  }),
});

export function listKnowledgeTools(
  protocolVersion: KnowledgeMcpProtocolVersion,
): readonly ToolDefinition[] {
  return KNOWLEDGE_TOOL_NAMES.map((name) => {
    const definition = BASE_DEFINITIONS[name];
    const common = {
      name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    };
    if (protocolVersion === "2024-11-05") {
      return Object.freeze(common);
    }
    const annotations = Object.freeze({
      title: definition.title,
      readOnlyHint: definition.readOnly,
      destructiveHint: !definition.readOnly,
      idempotentHint: definition.idempotent,
      openWorldHint: false,
    });
    return protocolVersion === "2025-03-26"
      ? Object.freeze({ ...common, annotations })
      : Object.freeze({ ...common, title: definition.title, annotations });
  });
}
