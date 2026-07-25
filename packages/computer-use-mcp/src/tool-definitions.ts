import {
  COMPUTER_USE_TOOL_NAMES,
  type ComputerUseMcpProtocolVersion,
  type ComputerUseToolName,
} from "./contracts.ts";

type JsonSchema = Readonly<Record<string, unknown>>;

interface ToolDefinition {
  readonly name: ComputerUseToolName;
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

const EMPTY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false,
}) satisfies JsonSchema;

const BASE_DEFINITIONS: Readonly<
  Record<
    ComputerUseToolName,
    Readonly<{
      title: string;
      description: string;
      inputSchema: JsonSchema;
      readOnly: boolean;
      idempotent: boolean;
    }>
  >
> = Object.freeze({
  computer_use_readiness: Object.freeze({
    title: "Computer Use readiness",
    description:
      "Report whether the exact OpenDelegate Run can currently use its authenticated desktop session.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    readOnly: true,
    idempotent: true,
  }),
  computer_use_observe: Object.freeze({
    title: "Observe desktop",
    description:
      "Return a bounded accessibility-oriented observation for this Run without sending input.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    readOnly: true,
    idempotent: false,
  }),
  computer_use_capture: Object.freeze({
    title: "Capture desktop",
    description: "Capture bounded PNG evidence from the desktop session authorized for this Run.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    readOnly: true,
    idempotent: false,
  }),
  computer_use_click: Object.freeze({
    title: "Click desktop control",
    description:
      "Click one observed control after the Worker revalidates exact Run authority and executable Policy.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        controlId: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 256,
        }),
      }),
      required: Object.freeze(["controlId"]),
      additionalProperties: false,
    }),
    readOnly: false,
    idempotent: false,
  }),
  computer_use_type_text: Object.freeze({
    title: "Type text",
    description:
      "Type sensitive plaintext into one observed control after exact Run authority and Policy revalidation.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        controlId: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 256,
        }),
        text: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 16_384,
        }),
      }),
      required: Object.freeze(["controlId", "text"]),
      additionalProperties: false,
    }),
    readOnly: false,
    idempotent: false,
  }),
  computer_use_key: Object.freeze({
    title: "Send key",
    description:
      "Send one key chord after the Worker revalidates exact Run authority and executable Policy.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        key: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 64,
        }),
        modifiers: Object.freeze({
          type: "array",
          items: Object.freeze({
            type: "string",
            enum: Object.freeze(["alt", "control", "meta", "shift"]),
          }),
          uniqueItems: true,
          maxItems: 4,
        }),
      }),
      required: Object.freeze(["key"]),
      additionalProperties: false,
    }),
    readOnly: false,
    idempotent: false,
  }),
  computer_use_scroll: Object.freeze({
    title: "Scroll desktop",
    description:
      "Scroll the active desktop after the Worker revalidates exact Run authority and executable Policy.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        deltaX: Object.freeze({
          type: "integer",
          minimum: -10_000,
          maximum: 10_000,
        }),
        deltaY: Object.freeze({
          type: "integer",
          minimum: -10_000,
          maximum: 10_000,
        }),
      }),
      required: Object.freeze(["deltaX", "deltaY"]),
      additionalProperties: false,
    }),
    readOnly: false,
    idempotent: false,
  }),
  computer_use_stop: Object.freeze({
    title: "Stop Computer Use",
    description:
      "Cancel or emergency-stop only the Computer Use execution handle bound to this Run.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        mode: Object.freeze({
          type: "string",
          enum: Object.freeze(["cancel", "emergency-stop"]),
        }),
      }),
      required: Object.freeze(["mode"]),
      additionalProperties: false,
    }),
    readOnly: false,
    idempotent: true,
  }),
});

export function listComputerUseTools(
  protocolVersion: ComputerUseMcpProtocolVersion,
  enabledTools: readonly ComputerUseToolName[] = COMPUTER_USE_TOOL_NAMES,
): readonly ToolDefinition[] {
  return enabledTools.map((name) => {
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
      openWorldHint: true,
    });
    if (protocolVersion === "2025-03-26") {
      return Object.freeze({ ...common, annotations });
    }
    return Object.freeze({ ...common, title: definition.title, annotations });
  });
}
