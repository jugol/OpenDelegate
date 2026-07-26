import { createInterface } from "node:readline";

import type { PlatformMutationExecutableId } from "@opendelegate/platform-services";

import {
  PLATFORM_MUTATION_TOOL_NAME,
  PlatformMutationToolError,
  parsePlatformMutationToolInput,
  type PlatformMutationRunAuthority,
  type PlatformMutationToolPort,
} from "./platform-mutation-run-capability.ts";

type JsonRpcId = number | string;
const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const MAXIMUM_LINE_BYTES = 64 * 1024;
const MAXIMUM_CONCURRENT_CALLS = 1;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;

export interface PlatformMutationMcpServerOptions {
  readonly authority: PlatformMutationRunAuthority;
  readonly platform: "windows" | "macos" | "linux";
  readonly executableIds: readonly PlatformMutationExecutableId[];
  readonly port: PlatformMutationToolPort;
  readonly toolTimeoutMs?: number;
}

interface ActiveCall {
  readonly controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}

/**
 * Small internal MCP server for one typed mutation tool. It deliberately has no
 * resource, prompt, sampling, root, or arbitrary command surface.
 */
export class PlatformMutationMcpServer {
  readonly #authority: PlatformMutationRunAuthority;
  readonly #platform: PlatformMutationMcpServerOptions["platform"];
  readonly #executableIds: readonly PlatformMutationExecutableId[];
  readonly #port: PlatformMutationToolPort;
  readonly #toolTimeoutMs: number;
  readonly #active = new Map<string, ActiveCall>();
  #state: "new" | "awaiting-initialized" | "operational" | "closed" = "new";
  #protocolVersion: (typeof MCP_PROTOCOL_VERSIONS)[number] | undefined;

  public constructor(options: PlatformMutationMcpServerOptions) {
    validateOptions(options);
    this.#authority = Object.freeze({ ...options.authority });
    this.#platform = options.platform;
    this.#executableIds = Object.freeze([...options.executableIds]);
    this.#port = options.port;
    this.#toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async handleLine(line: string): Promise<string | undefined> {
    if (this.#state === "closed") {
      return undefined;
    }
    if (Buffer.byteLength(line, "utf8") > MAXIMUM_LINE_BYTES) {
      return serialize(errorResponse(null, -32600, "Input line exceeds the configured limit."));
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return serialize(errorResponse(null, -32700, "Parse error."));
    }
    if (
      !isRecord(value) ||
      value["jsonrpc"] !== "2.0" ||
      typeof value["method"] !== "string" ||
      value["method"].length === 0 ||
      value["method"].length > 128
    ) {
      return serialize(
        errorResponse(
          readId(isRecord(value) ? value["id"] : undefined),
          -32600,
          "Invalid request.",
        ),
      );
    }
    const hasId = Object.prototype.hasOwnProperty.call(value, "id");
    if (!hasId) {
      this.#handleNotification(value);
      return undefined;
    }
    const id = readId(value["id"]);
    if (id === null) {
      return serialize(errorResponse(null, -32600, "Invalid request identifier."));
    }
    if (value["method"] === "initialize") {
      return serialize(this.#initialize(id, value["params"]));
    }
    if (value["method"] === "ping") {
      return serialize(successResponse(id, {}));
    }
    if (this.#state !== "operational") {
      return serialize(errorResponse(id, -32002, "The MCP server is not initialized."));
    }
    if (value["method"] === "tools/list") {
      return serialize(
        successResponse(id, { tools: [toolDefinition(this.#platform, this.#executableIds)] }),
      );
    }
    if (value["method"] !== "tools/call") {
      return serialize(errorResponse(id, -32601, "Method not found."));
    }
    return this.#callTool(id, value["params"]);
  }

  public close(): void {
    this.#state = "closed";
    for (const active of this.#active.values()) {
      active.cancelled = true;
      active.controller.abort();
    }
    this.#active.clear();
  }

  #initialize(id: JsonRpcId, params: unknown): Readonly<Record<string, unknown>> {
    if (this.#state !== "new" || !isRecord(params)) {
      return errorResponse(id, -32600, "Invalid initialize request.");
    }
    const protocolVersion = params["protocolVersion"];
    if (
      typeof protocolVersion !== "string" ||
      !MCP_PROTOCOL_VERSIONS.includes(protocolVersion as (typeof MCP_PROTOCOL_VERSIONS)[number]) ||
      !isRecord(params["capabilities"]) ||
      !isClientInfo(params["clientInfo"])
    ) {
      return errorResponse(id, -32602, "Unsupported or invalid MCP initialization.");
    }
    this.#protocolVersion = protocolVersion as (typeof MCP_PROTOCOL_VERSIONS)[number];
    this.#state = "awaiting-initialized";
    return successResponse(id, {
      protocolVersion: this.#protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "@opendelegate/worker-platform-mutation",
        version: "0.0.0",
      },
      instructions:
        "One exact OpenDelegate Worker Run may request typed package and protected platform mutations. Policy remains external.",
    });
  }

  #handleNotification(notification: Readonly<Record<string, unknown>>): void {
    if (
      notification["method"] === "notifications/initialized" &&
      this.#state === "awaiting-initialized"
    ) {
      this.#state = "operational";
      return;
    }
    if (notification["method"] === "notifications/cancelled" && isRecord(notification["params"])) {
      const id = readId(notification["params"]["requestId"]);
      const active = id === null ? undefined : this.#active.get(requestKey(id));
      if (active !== undefined) {
        active.cancelled = true;
        active.controller.abort();
      }
    }
  }

  async #callTool(id: JsonRpcId, params: unknown): Promise<string | undefined> {
    if (
      !isRecord(params) ||
      params["name"] !== PLATFORM_MUTATION_TOOL_NAME ||
      this.#active.size >= MAXIMUM_CONCURRENT_CALLS
    ) {
      return serialize(errorResponse(id, -32602, "Invalid platform mutation tool call."));
    }
    let input: ReturnType<typeof parsePlatformMutationToolInput>;
    try {
      input = parsePlatformMutationToolInput(params["arguments"] as never);
      const executableId = input.kind === "package-install" ? input.manager : input.executableId;
      if (!this.#executableIds.includes(executableId)) {
        throw new PlatformMutationToolError("INVALID_REQUEST");
      }
    } catch {
      return serialize(errorResponse(id, -32602, "Invalid platform mutation tool parameters."));
    }

    const controller = new AbortController();
    const active: ActiveCall = { controller, cancelled: false, timedOut: false };
    const key = requestKey(id);
    this.#active.set(key, active);
    const operation = this.#port.execute(
      { authority: this.#authority, signal: controller.signal },
      input,
    );
    void operation.catch(() => undefined);
    let timeout: NodeJS.Timeout | undefined;
    try {
      timeout = setTimeout(() => {
        active.timedOut = true;
        controller.abort();
      }, this.#toolTimeoutMs);
      const receipt = await operation;
      if (active.cancelled) {
        return undefined;
      }
      return serialize(
        successResponse(id, {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
        }),
      );
    } catch (error) {
      if (active.cancelled) {
        return undefined;
      }
      return serialize(
        successResponse(id, {
          content: [
            {
              type: "text",
              text: active.timedOut
                ? "The platform mutation timed out and its external outcome is treated as unknown."
                : publicErrorMessage(error),
            },
          ],
          isError: true,
        }),
      );
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      this.#active.delete(key);
    }
  }
}

export async function runPlatformMutationMcpStdioServer(
  options: PlatformMutationMcpServerOptions,
): Promise<void> {
  const server = new PlatformMutationMcpServer(options);
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: false,
  });
  const pending = new Set<Promise<void>>();
  const write = async (line: string): Promise<void> => {
    const response = await server.handleLine(line);
    if (response !== undefined) {
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${response}\n`, (error) =>
          error === null || error === undefined ? resolve() : reject(error),
        );
      });
    }
  };
  try {
    for await (const line of lines) {
      const operation = write(line).finally(() => pending.delete(operation));
      pending.add(operation);
      void operation.catch(() => {
        lines.close();
      });
    }
    await Promise.allSettled(pending);
  } finally {
    server.close();
    lines.close();
  }
}

function toolDefinition(
  platform: PlatformMutationMcpServerOptions["platform"],
  executableIds: readonly PlatformMutationExecutableId[],
): Readonly<Record<string, unknown>> {
  return {
    name: PLATFORM_MUTATION_TOOL_NAME,
    description:
      "Install a package from an existing configured source or request an exact Policy-gated OS mutation on this Device.",
    inputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "commandId", "manager", "scope", "packages"],
          properties: {
            kind: { const: "package-install" },
            commandId: { type: "string", minLength: 8, maxLength: 128 },
            manager: { type: "string", enum: executableIds },
            scope: { type: "string", enum: ["project", "system"] },
            packages: {
              type: "array",
              minItems: 1,
              maxItems: 64,
              items: { type: "string", minLength: 1, maxLength: 256 },
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "commandId", "actionCategory", "executableId", "arguments"],
          properties: {
            kind: { const: "protected-command" },
            commandId: { type: "string", minLength: 8, maxLength: 128 },
            actionCategory: {
              type: "string",
              enum: [
                "package-repository-addition",
                "remote-installer-script",
                "untrusted-installer",
                "driver-installation",
                "kernel-extension-installation",
                "os-network-change",
                "vpn-change",
                "firewall-change",
              ],
            },
            executableId: { type: "string", enum: executableIds },
            arguments: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: { type: "string", minLength: 1, maxLength: 4_096 },
            },
          },
        },
      ],
    },
    annotations: {
      title: `OpenDelegate ${platform} platform mutation`,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

function validateOptions(options: PlatformMutationMcpServerOptions): void {
  if (
    options.authority === null ||
    typeof options.authority !== "object" ||
    (options.platform !== "windows" &&
      options.platform !== "macos" &&
      options.platform !== "linux") ||
    !Array.isArray(options.executableIds) ||
    options.executableIds.length === 0 ||
    options.executableIds.length > 64 ||
    new Set(options.executableIds).size !== options.executableIds.length ||
    options.port === null ||
    typeof options.port !== "object" ||
    typeof options.port.execute !== "function" ||
    (options.toolTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.toolTimeoutMs) ||
        options.toolTimeoutMs < 1_000 ||
        options.toolTimeoutMs > DEFAULT_TIMEOUT_MS))
  ) {
    throw new TypeError("The platform mutation MCP configuration is invalid.");
  }
}

function isClientInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    value["name"].length > 0 &&
    value["name"].length <= 128 &&
    typeof value["version"] === "string" &&
    value["version"].length > 0 &&
    value["version"].length <= 128
  );
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof PlatformMutationToolError) {
    return error.message;
  }
  return "The platform mutation failed.";
}

function successResponse(
  id: JsonRpcId,
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function serialize(value: Readonly<Record<string, unknown>>): string {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, "utf8") <= MAXIMUM_LINE_BYTES
    ? serialized
    : JSON.stringify(errorResponse(readId(value["id"]), -32603, "Response too large."));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readId(value: unknown): JsonRpcId | null {
  return (typeof value === "string" && value.length > 0 && value.length <= 128) ||
    (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : null;
}

function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}
