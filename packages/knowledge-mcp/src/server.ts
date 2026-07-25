import {
  KNOWLEDGE_MCP_PROTOCOL_VERSIONS,
  KnowledgeToolPortError,
  type KnowledgeMcpDiagnostic,
  type KnowledgeMcpLimits,
  type KnowledgeMcpProtocolVersion,
  type KnowledgeMcpServerOptions,
  type KnowledgeRunAuthority,
  type KnowledgeToolName,
  type KnowledgeToolPort,
} from "./contracts.ts";
import { listKnowledgeTools } from "./tool-definitions.ts";
import {
  executeKnowledgeTool,
  InvalidKnowledgePortResultError,
  normalizeKnowledgeRunAuthority,
  parseKnowledgeToolCall,
  requireKnowledgeToolPort,
  toolResultText,
  type ParsedKnowledgeToolCall,
} from "./tool-runtime.ts";

type JsonRpcId = number | string;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

interface ResolvedLimits {
  readonly maxInputLineBytes: number;
  readonly maxOutputLineBytes: number;
  readonly maxInFlightToolCalls: number;
  readonly toolTimeoutMs: number;
  readonly maxCumulativeSearchCandidates: number;
  readonly maxCumulativeOpenCharacters: number;
  readonly maxCumulativeContextCharacters: number;
}

interface ActiveToolCall {
  readonly controller: AbortController;
  readonly tool: KnowledgeToolName;
  cancelled: boolean;
  timedOut: boolean;
}

const DEFAULT_SERVER_INFO = Object.freeze({
  name: "@opendelegate/knowledge-mcp",
  version: "0.0.0",
});

const DEFAULT_LIMITS: ResolvedLimits = Object.freeze({
  maxInputLineBytes: 64 * 1024,
  maxOutputLineBytes: 64 * 1024,
  maxInFlightToolCalls: 4,
  toolTimeoutMs: 15_000,
  maxCumulativeSearchCandidates: 20,
  maxCumulativeOpenCharacters: 24_000,
  maxCumulativeContextCharacters: 48_000,
});

class KnowledgeMcpBudgetError extends Error {
  public constructor() {
    super("The device-local Knowledge Run budget is exhausted.");
    this.name = "KnowledgeMcpBudgetError";
  }
}

export class KnowledgeMcpServer {
  readonly #limits: ResolvedLimits;
  readonly #authority: KnowledgeRunAuthority;
  readonly #port: KnowledgeToolPort;
  readonly #serverInfo: Readonly<{ name: string; version: string }>;
  readonly #diagnostic: KnowledgeMcpServerOptions["diagnostic"];
  readonly #activeToolCalls = new Map<string, ActiveToolCall>();
  #state: "new" | "awaiting-initialized" | "operational" | "closed" = "new";
  #protocolVersion: KnowledgeMcpProtocolVersion | undefined;
  #searchCandidatesUsed = 0;
  #openCharactersUsed = 0;
  #contextCharactersUsed = 0;

  public constructor(options: KnowledgeMcpServerOptions) {
    this.#limits = resolveLimits(options.limits);
    this.#authority = normalizeKnowledgeRunAuthority(options.authority);
    this.#port = requireKnowledgeToolPort(options.port);
    this.#serverInfo = normalizeServerInfo(options.serverInfo);
    this.#diagnostic = options.diagnostic;
  }

  public async handleLine(line: string): Promise<string | undefined> {
    if (this.#state === "closed") {
      return undefined;
    }
    if (Buffer.byteLength(line, "utf8") > this.#limits.maxInputLineBytes) {
      this.#writeDiagnostic({
        level: "warning",
        event: "knowledge_mcp.input",
        code: "input_rejected",
      });
      return this.#serialize(
        errorResponse(null, -32600, "Input line exceeds the configured byte limit."),
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#writeDiagnostic({
        level: "warning",
        event: "knowledge_mcp.input",
        code: "input_rejected",
      });
      return this.#serialize(errorResponse(null, -32700, "Parse error."));
    }
    if (!isRecord(value) || Array.isArray(value)) {
      return this.#rejectEnvelope(null);
    }
    const hasId = hasOwn(value, "id");
    if (
      value["jsonrpc"] !== "2.0" ||
      !isBoundedString(value["method"], 128) ||
      !hasExactKeys(
        value,
        hasId ? ["jsonrpc", "id", "method", "params"] : ["jsonrpc", "method", "params"],
      ) ||
      (hasOwn(value, "params") && !isRecord(value["params"]))
    ) {
      return this.#rejectEnvelope(readResponseId(value["id"]));
    }

    if (!hasId) {
      await this.#handleNotification(value as unknown as JsonRpcNotification);
      return undefined;
    }
    if (!isJsonRpcId(value["id"])) {
      return this.#rejectEnvelope(null);
    }
    if (this.#activeToolCalls.has(requestKey(value["id"]))) {
      return this.#serialize(errorResponse(value["id"], -32600, "Duplicate active request ID."));
    }
    const response = await this.#handleRequest(value as unknown as JsonRpcRequest);
    return response === undefined ? undefined : this.#serialize(response);
  }

  public handleOversizeLine(): string {
    this.#writeDiagnostic({
      level: "warning",
      event: "knowledge_mcp.input",
      code: "input_rejected",
    });
    return this.#serialize(
      errorResponse(null, -32600, "Input line exceeds the configured byte limit."),
    );
  }

  public close(): void {
    this.#state = "closed";
    for (const active of this.#activeToolCalls.values()) {
      active.cancelled = true;
      active.controller.abort();
    }
  }

  async #handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (
      notification.method === "notifications/initialized" &&
      this.#state === "awaiting-initialized" &&
      hasOnlyMeta(notification.params)
    ) {
      this.#state = "operational";
      return;
    }
    if (
      notification.method === "notifications/cancelled" &&
      isCancellationParams(notification.params)
    ) {
      const active = this.#activeToolCalls.get(requestKey(notification.params.requestId));
      if (active !== undefined) {
        active.cancelled = true;
        active.controller.abort();
        this.#writeDiagnostic({
          level: "warning",
          event: "knowledge_mcp.tool",
          code: "request_cancelled",
          tool: active.tool,
        });
      }
      return;
    }
    this.#writeDiagnostic({
      level: "warning",
      event: "knowledge_mcp.input",
      code: "input_rejected",
    });
  }

  async #handleRequest(
    request: JsonRpcRequest,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    if (request.method === "ping") {
      return hasOnlyMeta(request.params)
        ? successResponse(request.id, {})
        : this.#invalidParameters(request.id);
    }
    if (request.method === "initialize") {
      return this.#initialize(request);
    }
    if (this.#state !== "operational" || this.#protocolVersion === undefined) {
      return errorResponse(request.id, -32002, "The MCP server has not completed initialization.");
    }
    if (request.method === "tools/list") {
      return hasOnlyMeta(request.params)
        ? successResponse(request.id, { tools: listKnowledgeTools(this.#protocolVersion) })
        : this.#invalidParameters(request.id);
    }
    if (request.method === "tools/call") {
      return this.#callTool(request);
    }
    return errorResponse(request.id, -32601, "Method not found.");
  }

  #initialize(request: JsonRpcRequest): Readonly<Record<string, unknown>> {
    if (this.#state !== "new" || !isRecord(request.params)) {
      return this.#rejectInitialize(request.id);
    }
    const requested = request.params["protocolVersion"];
    if (
      typeof requested !== "string" ||
      !KNOWLEDGE_MCP_PROTOCOL_VERSIONS.includes(requested as KnowledgeMcpProtocolVersion)
    ) {
      return errorResponse(request.id, -32602, "Unsupported MCP protocol version.", {
        supported: KNOWLEDGE_MCP_PROTOCOL_VERSIONS,
      });
    }
    const protocolVersion = requested as KnowledgeMcpProtocolVersion;
    if (
      !hasExactKeys(request.params, ["protocolVersion", "capabilities", "clientInfo", "_meta"]) ||
      !isClientCapabilities(request.params["capabilities"], protocolVersion) ||
      !isClientInfo(request.params["clientInfo"], protocolVersion) ||
      !isRequestMeta(request.params["_meta"])
    ) {
      return this.#invalidParameters(request.id);
    }
    this.#protocolVersion = protocolVersion;
    this.#state = "awaiting-initialized";
    return successResponse(request.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.#serverInfo,
      instructions:
        "Knowledge tools are device-local and confined to one pre-authorized OpenDelegate Worker Run.",
    });
  }

  async #callTool(request: JsonRpcRequest): Promise<Readonly<Record<string, unknown>> | undefined> {
    if (
      !isRecord(request.params) ||
      !hasExactKeys(request.params, ["name", "arguments", "_meta"]) ||
      !isRequestMeta(request.params["_meta"])
    ) {
      return this.#invalidParameters(request.id);
    }
    const call = parseKnowledgeToolCall(request.params["name"], request.params["arguments"]);
    if (call === null) {
      return this.#invalidParameters(request.id);
    }
    if (this.#activeToolCalls.size >= this.#limits.maxInFlightToolCalls) {
      return errorResponse(request.id, -32000, "Knowledge tool capacity is exhausted.");
    }
    if (!this.#reserveSpecificBudget(call)) {
      this.#writeDiagnostic({
        level: "warning",
        event: "knowledge_mcp.tool",
        code: "budget_exhausted",
        tool: call.name,
      });
      return successResponse(request.id, toolErrorResult("Knowledge Run budget is exhausted."));
    }

    const key = requestKey(request.id);
    const controller = new AbortController();
    const active: ActiveToolCall = {
      controller,
      tool: call.name,
      cancelled: false,
      timedOut: false,
    };
    this.#activeToolCalls.set(key, active);
    let timeout: NodeJS.Timeout | undefined;
    const operation = executeKnowledgeTool(this.#port, this.#authority, call, controller.signal);
    void operation.catch(() => undefined);
    try {
      const cancellation = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new KnowledgeToolPortError("CANCELLED")),
          { once: true },
        );
      });
      timeout = setTimeout(() => {
        active.timedOut = true;
        controller.abort();
      }, this.#limits.toolTimeoutMs);
      const result = await Promise.race([operation, cancellation]);
      if (active.cancelled) {
        return undefined;
      }
      const contextCharacters = toolResultText(result).length;
      if (
        this.#contextCharactersUsed + contextCharacters >
        this.#limits.maxCumulativeContextCharacters
      ) {
        this.#contextCharactersUsed = this.#limits.maxCumulativeContextCharacters;
        throw new KnowledgeMcpBudgetError();
      }
      this.#contextCharactersUsed += contextCharacters;
      return successResponse(request.id, result);
    } catch (error: unknown) {
      if (active.cancelled) {
        return undefined;
      }
      if (active.timedOut) {
        this.#writeDiagnostic({
          level: "error",
          event: "knowledge_mcp.tool",
          code: "request_timed_out",
          tool: call.name,
        });
        return successResponse(
          request.id,
          toolErrorResult("Knowledge tool execution exceeded its configured timeout."),
        );
      }
      if (error instanceof KnowledgeMcpBudgetError) {
        this.#writeDiagnostic({
          level: "warning",
          event: "knowledge_mcp.tool",
          code: "budget_exhausted",
          tool: call.name,
        });
        return successResponse(request.id, toolErrorResult("Knowledge Run budget is exhausted."));
      }
      if (error instanceof InvalidKnowledgePortResultError) {
        this.#writeDiagnostic({
          level: "error",
          event: "knowledge_mcp.tool",
          code: "port_result_rejected",
          tool: call.name,
        });
        return successResponse(request.id, toolErrorResult("Knowledge tool execution failed."));
      }
      this.#writeDiagnostic({
        level: "error",
        event: "knowledge_mcp.tool",
        code: "port_failure",
        tool: call.name,
      });
      return successResponse(request.id, toolErrorResult(portErrorMessage(error)));
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      this.#activeToolCalls.delete(key);
    }
  }

  #reserveSpecificBudget(call: ParsedKnowledgeToolCall): boolean {
    if (call.name === "knowledge_search") {
      const requested = call.input.limit ?? 5;
      if (this.#searchCandidatesUsed + requested > this.#limits.maxCumulativeSearchCandidates) {
        this.#searchCandidatesUsed = this.#limits.maxCumulativeSearchCandidates;
        return false;
      }
      this.#searchCandidatesUsed += requested;
    }
    if (call.name === "knowledge_open") {
      if (
        this.#openCharactersUsed + call.input.totalCharacterBudget >
        this.#limits.maxCumulativeOpenCharacters
      ) {
        this.#openCharactersUsed = this.#limits.maxCumulativeOpenCharacters;
        return false;
      }
      this.#openCharactersUsed += call.input.totalCharacterBudget;
    }
    return true;
  }

  #invalidParameters(id: JsonRpcId): Readonly<Record<string, unknown>> {
    this.#writeDiagnostic({
      level: "warning",
      event: "knowledge_mcp.input",
      code: "input_rejected",
    });
    return errorResponse(id, -32602, "Invalid Knowledge tool parameters.");
  }

  #rejectInitialize(id: JsonRpcId): Readonly<Record<string, unknown>> {
    this.#writeDiagnostic({
      level: "warning",
      event: "knowledge_mcp.input",
      code: "input_rejected",
    });
    return errorResponse(id, -32600, "Invalid initialize request.");
  }

  #rejectEnvelope(id: JsonRpcId | null): string {
    this.#writeDiagnostic({
      level: "warning",
      event: "knowledge_mcp.input",
      code: "input_rejected",
    });
    return this.#serialize(errorResponse(id, -32600, "Invalid JSON-RPC request."));
  }

  #serialize(value: Readonly<Record<string, unknown>>): string {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") <= this.#limits.maxOutputLineBytes) {
      return serialized;
    }
    return JSON.stringify(
      errorResponse(
        readResponseId(value["id"]),
        -32603,
        "The MCP response exceeds the configured byte limit.",
      ),
    );
  }

  #writeDiagnostic(event: KnowledgeMcpDiagnostic): void {
    try {
      this.#diagnostic?.(Object.freeze(event));
    } catch {
      // Diagnostics cannot affect the protocol or local execution authority path.
    }
  }
}

export function createKnowledgeMcpServer(options: KnowledgeMcpServerOptions): KnowledgeMcpServer {
  return new KnowledgeMcpServer(options);
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
  data?: unknown,
): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function toolErrorResult(message: string): Readonly<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function portErrorMessage(error: unknown): string {
  if (error instanceof KnowledgeToolPortError) {
    switch (error.code) {
      case "BUDGET_EXHAUSTED":
        return "Knowledge Run budget is exhausted.";
      case "CANCELLED":
        return "Knowledge tool execution was cancelled.";
      case "NOT_READY":
        return "Device-local Knowledge is not ready.";
      case "STALE_AUTHORITY":
      case "STALE_LEASE":
        return "Knowledge Run authority is no longer current.";
      case "TIMEOUT":
        return "Knowledge tool execution timed out.";
      case "FAILED":
        return "Knowledge tool execution failed.";
    }
  }
  return "Knowledge tool execution failed.";
}

function resolveLimits(input: KnowledgeMcpLimits | undefined): ResolvedLimits {
  return Object.freeze({
    maxInputLineBytes: readLimit(
      input?.maxInputLineBytes,
      DEFAULT_LIMITS.maxInputLineBytes,
      1_024,
      1024 * 1024,
    ),
    maxOutputLineBytes: readLimit(
      input?.maxOutputLineBytes,
      DEFAULT_LIMITS.maxOutputLineBytes,
      4_096,
      1024 * 1024,
    ),
    maxInFlightToolCalls: readLimit(
      input?.maxInFlightToolCalls,
      DEFAULT_LIMITS.maxInFlightToolCalls,
      1,
      32,
    ),
    toolTimeoutMs: readLimit(input?.toolTimeoutMs, DEFAULT_LIMITS.toolTimeoutMs, 100, 120_000),
    maxCumulativeSearchCandidates: readLimit(
      input?.maxCumulativeSearchCandidates,
      DEFAULT_LIMITS.maxCumulativeSearchCandidates,
      1,
      1_000,
    ),
    maxCumulativeOpenCharacters: readLimit(
      input?.maxCumulativeOpenCharacters,
      DEFAULT_LIMITS.maxCumulativeOpenCharacters,
      1,
      1_000_000,
    ),
    maxCumulativeContextCharacters: readLimit(
      input?.maxCumulativeContextCharacters,
      DEFAULT_LIMITS.maxCumulativeContextCharacters,
      1,
      2_000_000,
    ),
  });
}

function readLimit(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError("Knowledge MCP limit is invalid.");
  }
  return resolved;
}

function normalizeServerInfo(
  value: KnowledgeMcpServerOptions["serverInfo"],
): Readonly<{ name: string; version: string }> {
  if (value === undefined) {
    return DEFAULT_SERVER_INFO;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["name", "version"]) ||
    !isBoundedString(value["name"], 128) ||
    !isBoundedString(value["version"], 128)
  ) {
    throw new TypeError("Knowledge MCP server information is invalid.");
  }
  return Object.freeze({ name: value["name"], version: value["version"] });
}

function isCancellationParams(
  value: unknown,
): value is Readonly<{ requestId: JsonRpcId; reason?: string }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["requestId", "reason", "_meta"]) &&
    hasOwn(value, "requestId") &&
    isJsonRpcId(value["requestId"]) &&
    isRequestMeta(value["_meta"]) &&
    (!hasOwn(value, "reason") ||
      (typeof value["reason"] === "string" &&
        value["reason"].length <= 512 &&
        !containsDisallowedTextControl(value["reason"])))
  );
}

function isClientCapabilities(
  value: unknown,
  protocolVersion: KnowledgeMcpProtocolVersion,
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys =
    protocolVersion === "2025-06-18"
      ? ["experimental", "roots", "sampling", "elicitation"]
      : ["experimental", "roots", "sampling"];
  if (!hasExactKeys(value, keys)) {
    return false;
  }
  if (
    hasOwn(value, "roots") &&
    (!isRecord(value["roots"]) ||
      !hasExactKeys(value["roots"], ["listChanged"]) ||
      (hasOwn(value["roots"], "listChanged") && typeof value["roots"]["listChanged"] !== "boolean"))
  ) {
    return false;
  }
  if (
    (hasOwn(value, "sampling") &&
      (!isRecord(value["sampling"]) || Object.keys(value["sampling"]).length !== 0)) ||
    (hasOwn(value, "elicitation") &&
      (!isRecord(value["elicitation"]) || Object.keys(value["elicitation"]).length !== 0))
  ) {
    return false;
  }
  return !hasOwn(value, "experimental") || isBoundedExperimental(value["experimental"]);
}

function isBoundedExperimental(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > 16) {
    return false;
  }
  return Object.entries(value).every(
    ([key, entry]) =>
      /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(key) &&
      isRecord(entry) &&
      Buffer.byteLength(JSON.stringify(entry), "utf8") <= 4_096,
  );
}

function isClientInfo(value: unknown, protocolVersion: KnowledgeMcpProtocolVersion): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const allowed =
    protocolVersion === "2025-06-18" ? ["name", "title", "version"] : ["name", "version"];
  return (
    hasExactKeys(value, allowed) &&
    isBoundedString(value["name"], 128) &&
    isBoundedString(value["version"], 128) &&
    (!hasOwn(value, "title") || isBoundedString(value["title"], 256))
  );
}

function isRequestMeta(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasExactKeys(value, ["progressToken"]) &&
      (!hasOwn(value, "progressToken") || isJsonRpcId(value["progressToken"])))
  );
}

function hasOnlyMeta(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && hasExactKeys(value, ["_meta"]) && isRequestMeta(value["_meta"]))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return isBoundedString(value, 128) || (typeof value === "number" && Number.isSafeInteger(value));
}

function readResponseId(value: unknown): JsonRpcId | null {
  return isJsonRpcId(value) ? value : null;
}

function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint < 32 || codePoint === 127;
    })
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
