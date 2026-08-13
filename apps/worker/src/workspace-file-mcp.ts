import { createInterface } from "node:readline";

import {
  WORKSPACE_FILE_INSPECT_TOOL_NAME,
  WorkspaceFileToolError,
  parseWorkspaceFileInspectInput,
  type WorkspaceFileRunAuthority,
  type WorkspaceFileToolPort,
} from "./workspace-file-run-capability.ts";

type JsonRpcId = number | string;
const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const MAXIMUM_LINE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_CONCURRENT_CALLS = 1;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface WorkspaceFileMcpServerOptions {
  readonly authority: WorkspaceFileRunAuthority;
  readonly port: WorkspaceFileToolPort;
  readonly toolTimeoutMs?: number;
}

interface ActiveCall {
  readonly controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}

/** Exact-Run MCP surface with one bounded read-only Workspace file tool. */
export class WorkspaceFileMcpServer {
  readonly #authority: WorkspaceFileRunAuthority;
  readonly #port: WorkspaceFileToolPort;
  readonly #toolTimeoutMs: number;
  readonly #active = new Map<string, ActiveCall>();
  #state: "new" | "awaiting-initialized" | "operational" | "closed" = "new";
  #protocolVersion: (typeof MCP_PROTOCOL_VERSIONS)[number] | undefined;

  public constructor(options: WorkspaceFileMcpServerOptions) {
    validateOptions(options);
    this.#authority = Object.freeze({ ...options.authority });
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
    if (!Object.prototype.hasOwnProperty.call(value, "id")) {
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
      if (!hasOnlyMeta(value["params"])) {
        return serialize(errorResponse(id, -32602, "Invalid tools/list parameters."));
      }
      return serialize(successResponse(id, { tools: toolDefinitions() }));
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
    if (
      this.#state !== "new" ||
      !isRecord(params) ||
      !hasExactKeys(params, ["protocolVersion", "capabilities", "clientInfo"]) ||
      typeof params["protocolVersion"] !== "string" ||
      !MCP_PROTOCOL_VERSIONS.includes(
        params["protocolVersion"] as (typeof MCP_PROTOCOL_VERSIONS)[number],
      ) ||
      !isRecord(params["capabilities"]) ||
      !isClientInfo(params["clientInfo"])
    ) {
      return errorResponse(id, -32602, "Unsupported or invalid MCP initialization.");
    }
    this.#protocolVersion = params["protocolVersion"] as (typeof MCP_PROTOCOL_VERSIONS)[number];
    this.#state = "awaiting-initialized";
    return successResponse(id, {
      protocolVersion: this.#protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "@opendelegate/worker-workspace-file",
        version: "0.0.0",
      },
      instructions:
        "Inspect one bounded regular file inside the exact Run Workspace and report actual bytes, hash, UTF-8, BOM, and final-LF evidence.",
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
      !hasExactKeys(params, ["name", "arguments", "_meta"]) ||
      params["name"] !== WORKSPACE_FILE_INSPECT_TOOL_NAME ||
      this.#active.size >= MAXIMUM_CONCURRENT_CALLS
    ) {
      return serialize(errorResponse(id, -32602, "Invalid Workspace file tool call."));
    }
    let input;
    try {
      input = parseWorkspaceFileInspectInput(params["arguments"]);
    } catch {
      return serialize(errorResponse(id, -32602, "Invalid Workspace file tool parameters."));
    }
    const controller = new AbortController();
    const active: ActiveCall = { controller, cancelled: false, timedOut: false };
    const key = requestKey(id);
    this.#active.set(key, active);
    const pending = this.#port.inspect(
      { authority: this.#authority, signal: controller.signal },
      input,
    );
    void pending.catch(() => undefined);
    let timeout: NodeJS.Timeout | undefined;
    try {
      timeout = setTimeout(() => {
        active.timedOut = true;
        controller.abort();
      }, this.#toolTimeoutMs);
      const result = await pending;
      if (active.cancelled) {
        return undefined;
      }
      return serialize(
        successResponse(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
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
                ? "The Workspace file inspection timed out."
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

export async function runWorkspaceFileMcpStdioServer(
  options: WorkspaceFileMcpServerOptions,
): Promise<void> {
  const server = new WorkspaceFileMcpServer(options);
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
      void operation.catch(() => lines.close());
    }
    await Promise.allSettled(pending);
  } finally {
    server.close();
    lines.close();
  }
}

function toolDefinitions(): readonly Readonly<Record<string, unknown>>[] {
  return [
    {
      name: WORKSPACE_FILE_INSPECT_TOOL_NAME,
      description:
        "Read one regular file by portable relative path from this exact Run Workspace and return actual UTF-8 text plus size, SHA-256, BOM, and final-LF evidence. Rejects absolute paths, traversal, links, and files over 1 MiB.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["relativePath"],
        properties: {
          relativePath: { type: "string", minLength: 1, maxLength: 1_024 },
        },
      },
      annotations: {
        title: "Inspect Workspace file",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

function validateOptions(options: WorkspaceFileMcpServerOptions): void {
  if (
    options.authority === null ||
    typeof options.authority !== "object" ||
    options.port === null ||
    typeof options.port !== "object" ||
    typeof options.port.inspect !== "function" ||
    (options.toolTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.toolTimeoutMs) ||
        options.toolTimeoutMs < 1_000 ||
        options.toolTimeoutMs > 300_000))
  ) {
    throw new TypeError("The Workspace file MCP configuration is invalid.");
  }
}

function publicErrorMessage(error: unknown): string {
  return error instanceof WorkspaceFileToolError
    ? error.message
    : "The Workspace file inspection failed.";
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

function isClientInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["name", "title", "version"]) &&
    typeof value["name"] === "string" &&
    value["name"].length > 0 &&
    value["name"].length <= 128 &&
    typeof value["version"] === "string" &&
    value["version"].length > 0 &&
    value["version"].length <= 128
  );
}

function hasOnlyMeta(value: unknown): boolean {
  return value === undefined || (isRecord(value) && hasExactKeys(value, ["_meta"]));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
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
