import {
  COMPUTER_USE_TOOL_NAMES,
  COMPUTER_USE_MCP_PROTOCOL_VERSIONS,
  type ComputerUseMcpDiagnostic,
  type ComputerUseMcpLimits,
  type ComputerUseMcpProtocolVersion,
  type ComputerUseMcpServerOptions,
  type ComputerUseRunAuthority,
  type ComputerUseToolName,
  type ComputerUseToolPort,
  ComputerUseToolPortError,
} from "./contracts.ts";
import { listComputerUseTools } from "./tool-definitions.ts";
import {
  executeComputerUseTool,
  InvalidComputerUsePortResultError,
  normalizeComputerUseRunAuthority,
  parseComputerUseToolCall,
  requireComputerUseToolPort,
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

const DEFAULT_SERVER_INFO = Object.freeze({
  name: "@opendelegate/computer-use-mcp",
  version: "0.0.0",
});

interface ResolvedLimits {
  readonly maxInputLineBytes: number;
  readonly maxOutputLineBytes: number;
  readonly maxCaptureBytes: number;
  readonly maxInFlightToolCalls: number;
  readonly toolTimeoutMs: number;
}

interface ActiveToolCall {
  readonly controller: AbortController;
  readonly tool: ComputerUseToolName;
  cancelled: boolean;
  timedOut: boolean;
}

const DEFAULT_LIMITS: ResolvedLimits = Object.freeze({
  maxInputLineBytes: 64 * 1024,
  maxOutputLineBytes: 8 * 1024 * 1024,
  maxCaptureBytes: 4 * 1024 * 1024,
  maxInFlightToolCalls: 8,
  toolTimeoutMs: 30_000,
});

export class ComputerUseMcpServer {
  private readonly limits: ResolvedLimits;
  private readonly authority: ComputerUseRunAuthority;
  private readonly port: ComputerUseToolPort;
  private readonly serverInfo: Readonly<{ name: string; version: string }>;
  private readonly diagnostic: ComputerUseMcpServerOptions["diagnostic"];
  private readonly enabledTools: ReadonlySet<ComputerUseToolName>;
  private readonly activeToolCalls = new Map<string, ActiveToolCall>();
  private state: "new" | "awaiting-initialized" | "operational" | "closed" = "new";
  private protocolVersion: ComputerUseMcpProtocolVersion | undefined;

  public constructor(options: ComputerUseMcpServerOptions) {
    this.limits = resolveLimits(options.limits);
    this.authority = normalizeComputerUseRunAuthority(options.authority);
    this.port = requireComputerUseToolPort(options.port);
    this.serverInfo = normalizeServerInfo(options.serverInfo);
    this.diagnostic = options.diagnostic;
    this.enabledTools = normalizeEnabledTools(options.enabledTools);
  }

  public async handleLine(line: string): Promise<string | undefined> {
    if (this.state === "closed") {
      return undefined;
    }
    if (Buffer.byteLength(line, "utf8") > this.limits.maxInputLineBytes) {
      this.writeDiagnostic({
        level: "warning",
        event: "computer_use_mcp.input",
        code: "input_rejected",
      });
      return this.serializeResponse(
        errorResponse(null, -32600, "Input line exceeds the configured byte limit."),
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.writeDiagnostic({
        level: "warning",
        event: "computer_use_mcp.input",
        code: "input_rejected",
      });
      return this.serializeResponse(errorResponse(null, -32700, "Parse error."));
    }
    if (!isRecord(value) || Array.isArray(value)) {
      this.writeDiagnostic({
        level: "warning",
        event: "computer_use_mcp.input",
        code: "input_rejected",
      });
      return this.serializeResponse(errorResponse(null, -32600, "Invalid JSON-RPC request."));
    }
    const hasId = hasOwn(value, "id");
    if (
      value.jsonrpc !== "2.0" ||
      !isBoundedString(value.method, 128) ||
      !hasExactKeys(
        value,
        hasId ? ["jsonrpc", "id", "method", "params"] : ["jsonrpc", "method", "params"],
      ) ||
      (hasOwn(value, "params") && !isRecord(value.params))
    ) {
      this.writeDiagnostic({
        level: "warning",
        event: "computer_use_mcp.input",
        code: "input_rejected",
      });
      return this.serializeResponse(
        errorResponse(readResponseId(value.id), -32600, "Invalid JSON-RPC request."),
      );
    }

    if (!hasId) {
      await this.handleNotification(value as unknown as JsonRpcNotification);
      return undefined;
    }
    if (!isJsonRpcId(value.id)) {
      this.writeDiagnostic({
        level: "warning",
        event: "computer_use_mcp.input",
        code: "input_rejected",
      });
      return this.serializeResponse(errorResponse(null, -32600, "Invalid JSON-RPC request."));
    }
    if (this.activeToolCalls.has(requestKey(value.id))) {
      return this.serializeResponse(
        errorResponse(value.id, -32600, "Duplicate active request ID."),
      );
    }
    const response = await this.handleRequest(value as unknown as JsonRpcRequest);
    return response === undefined ? undefined : this.serializeResponse(response);
  }

  public close(): void {
    this.state = "closed";
    for (const active of this.activeToolCalls.values()) {
      active.cancelled = true;
      active.controller.abort();
    }
  }

  public handleOversizeLine(): string {
    this.writeDiagnostic({
      level: "warning",
      event: "computer_use_mcp.input",
      code: "input_rejected",
    });
    return this.serializeResponse(
      errorResponse(null, -32600, "Input line exceeds the configured byte limit."),
    );
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (
      notification.method === "notifications/initialized" &&
      this.state === "awaiting-initialized" &&
      hasOnlyMeta(notification.params)
    ) {
      this.state = "operational";
      return;
    }
    if (
      notification.method === "notifications/cancelled" &&
      isCancellationParams(notification.params)
    ) {
      const active = this.activeToolCalls.get(requestKey(notification.params.requestId));
      if (active !== undefined) {
        active.cancelled = true;
        active.controller.abort();
        this.writeDiagnostic({
          level: "warning",
          event: "computer_use_mcp.tool",
          code: "request_cancelled",
          tool: active.tool,
        });
      }
      return;
    }
    this.writeDiagnostic({
      level: "warning",
      event: "computer_use_mcp.input",
      code: "input_rejected",
    });
  }

  private async handleRequest(
    request: JsonRpcRequest,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    if (request.method === "ping") {
      if (!hasOnlyMeta(request.params)) {
        return this.invalidParameters(request.id, "Invalid ping parameters.");
      }
      return successResponse(request.id, {});
    }
    if (request.method === "initialize") {
      return this.initialize(request);
    }
    if (this.state !== "operational" || this.protocolVersion === undefined) {
      return errorResponse(request.id, -32002, "The MCP server has not completed initialization.");
    }
    if (request.method === "tools/list") {
      if (!hasOnlyMeta(request.params)) {
        return this.invalidParameters(request.id, "Invalid tools/list parameters.");
      }
      return successResponse(request.id, {
        tools: listComputerUseTools(this.protocolVersion, [...this.enabledTools]),
      });
    }
    if (request.method === "tools/call") {
      return this.callTool(request);
    }
    return errorResponse(request.id, -32601, "Method not found.");
  }

  private initialize(request: JsonRpcRequest): Readonly<Record<string, unknown>> {
    if (this.state !== "new" || !isRecord(request.params)) {
      this.writeDiagnostic({
        level: "warning",
        event: "computer_use_mcp.input",
        code: "input_rejected",
      });
      return errorResponse(request.id, -32600, "Invalid initialize request.");
    }
    const requested = request.params.protocolVersion;
    if (
      typeof requested !== "string" ||
      !COMPUTER_USE_MCP_PROTOCOL_VERSIONS.includes(requested as ComputerUseMcpProtocolVersion)
    ) {
      return errorResponse(request.id, -32602, "Unsupported MCP protocol version.", {
        supported: COMPUTER_USE_MCP_PROTOCOL_VERSIONS,
      });
    }
    const protocolVersion = requested as ComputerUseMcpProtocolVersion;
    if (
      !hasExactKeys(request.params, ["protocolVersion", "capabilities", "clientInfo", "_meta"]) ||
      !isClientCapabilities(request.params.capabilities, protocolVersion) ||
      !isClientInfo(request.params.clientInfo, protocolVersion) ||
      !isRequestMeta(request.params._meta)
    ) {
      return this.invalidParameters(request.id, "Invalid initialize parameters.");
    }

    this.protocolVersion = protocolVersion;
    this.state = "awaiting-initialized";
    return successResponse(request.id, {
      protocolVersion: this.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo,
      instructions:
        "Computer Use tools are confined to one pre-authorized OpenDelegate Worker Run.",
    });
  }

  private invalidParameters(id: JsonRpcId, message: string): Readonly<Record<string, unknown>> {
    this.writeDiagnostic({
      level: "warning",
      event: "computer_use_mcp.input",
      code: "input_rejected",
    });
    return errorResponse(id, -32602, message);
  }

  private async callTool(
    request: JsonRpcRequest,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    if (
      !isRecord(request.params) ||
      !hasExactKeys(request.params, ["name", "arguments", "_meta"]) ||
      !isRequestMeta(request.params._meta)
    ) {
      return this.invalidParameters(request.id, "Invalid Computer Use tool arguments.");
    }
    const call = parseComputerUseToolCall(request.params.name, request.params.arguments);
    if (call === null || !this.enabledTools.has(call.name)) {
      return this.invalidParameters(request.id, "Invalid Computer Use tool arguments.");
    }
    if (this.activeToolCalls.size >= this.limits.maxInFlightToolCalls) {
      return errorResponse(request.id, -32000, "Computer Use tool capacity is exhausted.");
    }
    const key = requestKey(request.id);
    const abortController = new AbortController();
    const active: ActiveToolCall = {
      controller: abortController,
      tool: call.name,
      cancelled: false,
      timedOut: false,
    };
    this.activeToolCalls.set(key, active);
    let timeout: NodeJS.Timeout | undefined;
    const operation = executeComputerUseTool(
      this.port,
      this.authority,
      call,
      abortController.signal,
      this.limits.maxCaptureBytes,
    );
    void operation.catch(() => undefined);
    try {
      const cancellation = new Promise<never>((_resolve, reject) => {
        abortController.signal.addEventListener(
          "abort",
          () => reject(new Error("Computer Use MCP operation aborted.")),
          { once: true },
        );
      });
      timeout = setTimeout(() => {
        active.timedOut = true;
        abortController.abort();
      }, this.limits.toolTimeoutMs);
      const result = await Promise.race([operation, cancellation]);
      if (active.cancelled) {
        return undefined;
      }
      return successResponse(request.id, result);
    } catch (error: unknown) {
      if (active.cancelled) {
        return undefined;
      }
      if (active.timedOut) {
        this.writeDiagnostic({
          level: "error",
          event: "computer_use_mcp.tool",
          code: "request_timed_out",
          tool: call.name,
        });
        return successResponse(
          request.id,
          toolErrorResult("Computer Use tool execution exceeded its configured timeout."),
        );
      }
      if (error instanceof InvalidComputerUsePortResultError) {
        this.writeDiagnostic({
          level: "error",
          event: "computer_use_mcp.tool",
          code: "port_result_rejected",
          tool: call.name,
        });
        return successResponse(request.id, toolErrorResult("Computer Use tool execution failed."));
      }
      this.writeDiagnostic({
        level: "error",
        event: "computer_use_mcp.tool",
        code: "port_failure",
        tool: call.name,
      });
      return successResponse(request.id, toolErrorResult(portErrorMessage(error)));
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      this.activeToolCalls.delete(key);
    }
  }

  private serializeResponse(value: Readonly<Record<string, unknown>>): string {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") <= this.limits.maxOutputLineBytes) {
      return serialized;
    }
    return JSON.stringify(
      errorResponse(
        readResponseId(value.id),
        -32603,
        "The MCP response exceeds the configured byte limit.",
      ),
    );
  }

  private writeDiagnostic(event: ComputerUseMcpDiagnostic): void {
    try {
      this.diagnostic?.(Object.freeze(event));
    } catch {
      // Diagnostics cannot affect the protocol or execution authority path.
    }
  }
}

export function createComputerUseMcpServer(
  options: ComputerUseMcpServerOptions,
): ComputerUseMcpServer {
  return new ComputerUseMcpServer(options);
}

function normalizeEnabledTools(
  tools: readonly ComputerUseToolName[] | undefined,
): ReadonlySet<ComputerUseToolName> {
  const selected = tools ?? COMPUTER_USE_TOOL_NAMES;
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    selected.length > COMPUTER_USE_TOOL_NAMES.length ||
    selected.some((tool) => !COMPUTER_USE_TOOL_NAMES.includes(tool))
  ) {
    throw new TypeError("Computer Use MCP enabled tools are invalid.");
  }
  const normalized = new Set(selected);
  if (normalized.size !== selected.length) {
    throw new TypeError("Computer Use MCP enabled tools are invalid.");
  }
  return normalized;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function isCancellationParams(
  value: unknown,
): value is Readonly<{ requestId: JsonRpcId; reason?: string }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["requestId", "reason", "_meta"]) &&
    hasOwn(value, "requestId") &&
    isJsonRpcId(value.requestId) &&
    isRequestMeta(value._meta) &&
    (!hasOwn(value, "reason") ||
      (typeof value.reason === "string" &&
        value.reason.length <= 512 &&
        !containsDisallowedTextControl(value.reason)))
  );
}

function normalizeServerInfo(
  value: ComputerUseMcpServerOptions["serverInfo"],
): Readonly<{ name: string; version: string }> {
  if (value === undefined) {
    return DEFAULT_SERVER_INFO;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["name", "version"]) ||
    !isBoundedString(value.name, 128) ||
    !isBoundedString(value.version, 128)
  ) {
    throw new TypeError("Computer Use MCP server information is invalid.");
  }
  return Object.freeze({ name: value.name, version: value.version });
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === undefined || codePoint < 32 || codePoint === 127;
  });
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

function hasOnlyMeta(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && hasExactKeys(value, ["_meta"]) && isRequestMeta(value._meta))
  );
}

function isRequestMeta(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value) || !hasExactKeys(value, ["progressToken"])) {
    return false;
  }
  if (!hasOwn(value, "progressToken")) {
    return true;
  }
  return isJsonRpcId(value.progressToken);
}

function isClientCapabilities(
  value: unknown,
  protocolVersion: ComputerUseMcpProtocolVersion,
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
    (!isRecord(value.roots) ||
      !hasExactKeys(value.roots, ["listChanged"]) ||
      (hasOwn(value.roots, "listChanged") && typeof value.roots.listChanged !== "boolean"))
  ) {
    return false;
  }
  if (
    (hasOwn(value, "sampling") &&
      (!isRecord(value.sampling) || Object.keys(value.sampling).length !== 0)) ||
    (hasOwn(value, "elicitation") &&
      (!isRecord(value.elicitation) || Object.keys(value.elicitation).length !== 0))
  ) {
    return false;
  }
  if (hasOwn(value, "experimental") && !isBoundedExperimental(value.experimental)) {
    return false;
  }
  return true;
}

function isBoundedExperimental(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > 16) {
    return false;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) ||
      !isRecord(entry) ||
      Buffer.byteLength(JSON.stringify(entry), "utf8") > 4_096
    ) {
      return false;
    }
  }
  return true;
}

function isClientInfo(value: unknown, protocolVersion: ComputerUseMcpProtocolVersion): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const allowed =
    protocolVersion === "2025-06-18" ? ["name", "title", "version"] : ["name", "version"];
  return (
    hasExactKeys(value, allowed) &&
    isBoundedString(value.name, 128) &&
    isBoundedString(value.version, 128) &&
    (!hasOwn(value, "title") || isBoundedString(value.title, 256))
  );
}

function resolveLimits(input: ComputerUseMcpLimits | undefined): ResolvedLimits {
  const maxInputLineBytes = readLimit(
    input?.maxInputLineBytes,
    DEFAULT_LIMITS.maxInputLineBytes,
    128,
    1024 * 1024,
  );
  const maxCaptureBytes = readLimit(
    input?.maxCaptureBytes,
    DEFAULT_LIMITS.maxCaptureBytes,
    1_024,
    32 * 1024 * 1024,
  );
  const maxOutputLineBytes = readLimit(
    input?.maxOutputLineBytes,
    DEFAULT_LIMITS.maxOutputLineBytes,
    4_096,
    64 * 1024 * 1024,
  );
  const maxInFlightToolCalls = readLimit(
    input?.maxInFlightToolCalls,
    DEFAULT_LIMITS.maxInFlightToolCalls,
    1,
    64,
  );
  const toolTimeoutMs = readLimit(
    input?.toolTimeoutMs,
    DEFAULT_LIMITS.toolTimeoutMs,
    10,
    10 * 60 * 1_000,
  );
  return Object.freeze({
    maxInputLineBytes,
    maxOutputLineBytes,
    maxCaptureBytes,
    maxInFlightToolCalls,
    toolTimeoutMs,
  });
}

function readLimit(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError("Computer Use MCP limits are invalid.");
  }
  return resolved;
}

function toolErrorResult(message: string): Readonly<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function portErrorMessage(error: unknown): string {
  if (!(error instanceof ComputerUseToolPortError)) {
    return "Computer Use tool execution failed.";
  }
  switch (error.code) {
    case "UNSUPPORTED":
      return "This Computer Use operation is not supported by the active backend.";
    case "NOT_READY":
      return "Computer Use is not ready for this Run.";
    case "PERMISSION_DENIED":
      return "Computer Use permission is not available for this Run.";
    case "STALE_AUTHORITY":
      return "The Computer Use desktop authority is no longer current.";
    case "STALE_LEASE":
      return "The desktop-session lease is no longer current.";
    case "TIMEOUT":
      return "Computer Use tool execution timed out.";
    case "CANCELLED":
      return "Computer Use tool execution was cancelled.";
    case "FAILED":
      return "Computer Use tool execution failed.";
  }
}
