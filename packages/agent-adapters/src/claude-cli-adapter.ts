import { randomUUID } from "node:crypto";

import {
  type AgentAdapter,
  type AgentModelCatalog,
  type AgentAdapterProbe,
  type AgentAdapterProbeInput,
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentStartRequest,
  type AgentToolServer,
  type AgentUsage,
} from "./contracts.ts";
import { ClaudeAgentSdkAdapter, type ClaudeAgentSdkPort } from "./claude-agent-sdk-adapter.ts";
import {
  assertProviderHomeNotInSecretEnvironment,
  prepareControlledProviderHome,
  resolveControlledProviderHome,
} from "./controlled-provider-home.ts";
import { probeCli } from "./cli-probe.ts";
import { AgentAdapterError } from "./errors.ts";
import { type SpawnCommand } from "./process-utils.ts";
import { isRecord } from "./redaction.ts";
import { processSessionLeaseStore, type SessionLeaseStore } from "./session-leases.ts";
import {
  canonicalizeWorkspace,
  createNativeSessionReference,
  rejectUnscopedProviderSecrets,
  validateAgentRequest,
  validateDangerousGrant,
  validateResumeReference,
} from "./session-reference.ts";
import { startSubprocessTurn, type ProviderSignal } from "./subprocess-turn.ts";

export const CLAUDE_CLI_TESTED_VERSIONS = ["2.1.220"] as const;

export interface ClaudeCliAdapterOptions {
  readonly claudeHome: string;
  readonly executable?: string;
  readonly prefixArgs?: readonly string[];
  readonly testedVersions?: readonly string[];
  readonly allowUntestedVersion?: boolean;
  readonly leaseStore?: SessionLeaseStore;
  readonly modelCatalogSdk?: ClaudeAgentSdkPort;
  readonly now?: () => number;
  readonly lineageId?: () => string;
}

export class ClaudeCliAdapter implements AgentAdapter {
  readonly adapterId = "claude-cli";
  readonly provider = "claude" as const;
  readonly #claudeHome: string;
  readonly #executable: string;
  readonly #prefixArgs: readonly string[];
  readonly #testedVersions: readonly string[];
  readonly #allowUntestedVersion: boolean;
  readonly #leaseStore: SessionLeaseStore;
  readonly #modelCatalogSdk: ClaudeAgentSdkPort | undefined;
  readonly #now: () => number;
  readonly #lineageId: () => string;

  constructor(options: ClaudeCliAdapterOptions) {
    this.#claudeHome = resolveControlledProviderHome(options.claudeHome, "Claude");
    this.#executable = options.executable ?? "claude";
    this.#prefixArgs = options.prefixArgs ?? [];
    this.#testedVersions = options.testedVersions ?? CLAUDE_CLI_TESTED_VERSIONS;
    this.#allowUntestedVersion = options.allowUntestedVersion ?? false;
    this.#leaseStore = options.leaseStore ?? processSessionLeaseStore;
    this.#modelCatalogSdk = options.modelCatalogSdk;
    this.#now = options.now ?? Date.now;
    this.#lineageId = options.lineageId ?? randomUUID;
  }

  async probe(input: AgentAdapterProbeInput = {}): Promise<AgentAdapterProbe> {
    assertProviderHomeNotInSecretEnvironment("CLAUDE_CONFIG_DIR", input.secretEnvironment);
    await prepareControlledProviderHome(this.#claudeHome, "Claude");
    const capabilities = {
      start: true,
      resume: true,
      streaming: true,
      cancellation: true,
      approvalBridge: false,
      steering: false,
      checkpointContinuation: true,
      workspaceIsolation: [
        "none",
        "agent-native-worktree",
        "opendelegate-worktree",
        "container",
        "custom",
      ],
    } as const;
    return await probeCli({
      adapterId: this.adapterId,
      provider: this.provider,
      providerLabel: "Claude CLI",
      capabilities,
      versionCommand: this.#command(
        [...this.#prefixArgs, "--version"],
        process.cwd(),
        input.environment,
        input.secretEnvironment,
      ),
      authCommand: this.#command(
        [...this.#prefixArgs, "auth", "status", "--json"],
        process.cwd(),
        input.environment,
        input.secretEnvironment,
      ),
      testedVersions: this.#testedVersions,
      parseVersion: parseClaudeVersion,
    });
  }

  async start(request: AgentStartRequest): Promise<AgentRunHandle> {
    return await this.#launch(request);
  }

  async listModels(input: AgentAdapterProbeInput = {}): Promise<AgentModelCatalog> {
    return await new ClaudeAgentSdkAdapter({
      claudeHome: this.#claudeHome,
      authExecutable: this.#executable,
      authPrefixArgs: this.#prefixArgs,
      ...(this.#modelCatalogSdk === undefined ? {} : { sdk: this.#modelCatalogSdk }),
      leaseStore: this.#leaseStore,
      now: this.#now,
    }).listModels(input);
  }

  async resume(request: AgentResumeRequest): Promise<AgentRunHandle> {
    return await this.#launch(request);
  }

  async #launch(request: AgentStartRequest | AgentResumeRequest): Promise<AgentRunHandle> {
    validateAgentRequest(request);
    rejectUnscopedProviderSecrets(request);
    const workspace = await canonicalizeWorkspace(request.workspace);
    const { cwd } = workspace;
    if (request.operation === "resume") {
      validateResumeReference(request, workspace, this.provider, this.adapterId);
    }
    if (request.sandbox !== "provider-default") {
      throw new AgentAdapterError(
        "SANDBOX_MODE_UNSUPPORTED",
        "Claude CLI does not expose the requested sandbox; use an external sandbox or provider-default.",
      );
    }
    const probe = await this.probe({
      ...(request.environment === undefined ? {} : { environment: request.environment }),
      ...(request.secretEnvironment === undefined
        ? {}
        : { secretEnvironment: request.secretEnvironment }),
    });
    if (!probe.installed) {
      throw new AgentAdapterError("ADAPTER_UNAVAILABLE", "Claude CLI is unavailable.", true);
    }
    if (probe.auth.state !== "ready") {
      throw new AgentAdapterError(
        "ADAPTER_AUTH_NOT_READY",
        "Claude CLI authentication is not ready.",
        true,
      );
    }
    if (
      probe.version === undefined ||
      (probe.compatibility !== "tested" && !this.#allowUntestedVersion)
    ) {
      throw new AgentAdapterError(
        "ADAPTER_VERSION_UNSUPPORTED",
        "Claude CLI version has not passed the configured compatibility policy.",
      );
    }
    const adapterVersion = probe.version;
    const args = this.#invocationArgs(request);
    return await startSubprocessTurn({
      adapterId: this.adapterId,
      adapterVersion,
      request,
      cwd,
      command: this.#command(args, cwd, request.environment, request.secretEnvironment),
      stdin: request.prompt,
      leaseStore: this.#leaseStore,
      now: this.#now,
      createSession: (nativeSessionId) =>
        createNativeSessionReference({
          provider: this.provider,
          adapterId: this.adapterId,
          adapterVersion,
          nativeSessionId,
          request,
          workspace,
          lineageId: this.#lineageId,
          now: this.#now,
        }),
      parseLine: createClaudeSignalParser(),
    });
  }

  #invocationArgs(request: AgentStartRequest | AgentResumeRequest): string[] {
    const args = [
      ...this.#prefixArgs,
      "-p",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-chrome",
      "--disable-slash-commands",
      "--prompt-suggestions",
      "false",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      ...(request.modelId === undefined ? [] : ["--model", request.modelId]),
    ];
    const toolServerTools = claudeToolServerTools(request.toolServers);
    if (request.toolServers !== undefined) {
      args.push("--mcp-config", renderClaudeMcpConfiguration(request.toolServers));
    }
    if (request.operation === "resume") {
      args.push("--resume", request.session.nativeSessionId);
    }
    if (request.permissions.mode === "deny") {
      args.push(
        "--permission-mode",
        "dontAsk",
        "--tools",
        toolServerTools.join(","),
        ...(toolServerTools.length === 0 ? [] : ["--allowedTools", toolServerTools.join(",")]),
      );
    } else if (request.permissions.mode === "allow-listed") {
      const allowedTools = normalizeTools([
        ...(request.permissions.allowedTools ?? []),
        ...toolServerTools,
      ]);
      if (allowedTools.length === 0) {
        throw new AgentAdapterError(
          "EMPTY_TOOL_ALLOWLIST",
          "Claude allow-listed mode requires at least one allowed tool.",
        );
      }
      args.push(
        "--permission-mode",
        "dontAsk",
        "--tools",
        allowedTools.join(","),
        "--allowedTools",
        allowedTools.join(","),
      );
      const deniedTools = normalizeTools(request.permissions.deniedTools);
      if (deniedTools.length > 0) {
        args.push("--disallowedTools", deniedTools.join(","));
      }
    } else {
      validateDangerousGrant(request);
      args.push("--allow-dangerously-skip-permissions", "--dangerously-skip-permissions");
    }
    return args;
  }

  #command(
    args: readonly string[],
    cwd: string,
    environment?: Readonly<Record<string, string>>,
    secretEnvironment?: Readonly<Record<string, string>>,
  ): SpawnCommand {
    assertProviderHomeNotInSecretEnvironment("CLAUDE_CONFIG_DIR", secretEnvironment);
    return {
      executable: this.#executable,
      args,
      cwd,
      environment: {
        ...environment,
        CLAUDE_CONFIG_DIR: this.#claudeHome,
      },
      ...(secretEnvironment === undefined ? {} : { secretEnvironment }),
    };
  }
}

function renderClaudeMcpConfiguration(toolServers: readonly AgentToolServer[]): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      toolServers.map((server) => [
        server.serverName,
        {
          type: "stdio",
          command: server.command,
          args: [...server.args],
        },
      ]),
    ),
  });
}

function claudeToolServerTools(
  toolServers: readonly AgentToolServer[] | undefined,
): readonly string[] {
  return (toolServers ?? []).flatMap((server) =>
    server.enabledTools.map((tool) => `mcp__${server.serverName}__${tool}`),
  );
}

function parseClaudeVersion(output: string): string {
  const match = /(\d+\.\d+\.\d+)/u.exec(output.trim());
  if (match?.[1] === undefined) {
    throw new AgentAdapterError(
      "UNRECOGNIZED_PROVIDER_VERSION",
      "Claude CLI returned an unrecognized version.",
    );
  }
  return match[1];
}

function createClaudeSignalParser(): (value: unknown) => readonly ProviderSignal[] {
  const toolNamesByUseId = new Map<string, string>();
  return (value) => parseClaudeSignals(value, toolNamesByUseId);
}

function parseClaudeSignals(
  value: unknown,
  toolNamesByUseId: Map<string, string>,
): readonly ProviderSignal[] {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new AgentAdapterError(
      "MALFORMED_PROVIDER_OUTPUT",
      "Claude CLI event was not an object with a type.",
    );
  }
  if (value.type === "system" && value.subtype === "init") {
    if (typeof value.session_id !== "string" || value.session_id.length === 0) {
      throw new AgentAdapterError(
        "MALFORMED_PROVIDER_OUTPUT",
        "Claude init event did not include a session ID.",
      );
    }
    return [{ kind: "session", nativeSessionId: value.session_id }];
  }
  if (value.type === "stream_event") {
    if (
      isRecord(value.event) &&
      value.event.type === "content_block_delta" &&
      isRecord(value.event.delta) &&
      value.event.delta.type === "text_delta" &&
      typeof value.event.delta.text === "string"
    ) {
      return [{ kind: "message_delta", text: value.event.delta.text }];
    }
    return [];
  }
  if (value.type === "assistant") {
    if (!isRecord(value.message) || !Array.isArray(value.message.content)) {
      throw new AgentAdapterError(
        "MALFORMED_PROVIDER_OUTPUT",
        "Claude assistant message was malformed.",
      );
    }
    const signals: ProviderSignal[] = [];
    const text: string[] = [];
    for (const block of value.message.content) {
      if (!isRecord(block) || typeof block.type !== "string") {
        throw new AgentAdapterError(
          "MALFORMED_PROVIDER_OUTPUT",
          "Claude content block was malformed.",
        );
      }
      if (block.type === "text" && typeof block.text === "string") {
        text.push(block.text);
      } else if (
        block.type === "tool_use" &&
        typeof block.name === "string" &&
        block.name.length > 0
      ) {
        if (typeof block.id === "string" && block.id.length > 0) {
          toolNamesByUseId.set(block.id, block.name);
        }
        signals.push({
          kind: "tool_request",
          toolName: block.name,
          ...(block.input === undefined || isPrivateOpenDelegateTool(block.name)
            ? {}
            : { input: block.input }),
        });
      }
    }
    if (text.length > 0) {
      signals.unshift({ kind: "public_message", text: text.join("") });
    }
    return signals;
  }
  if (value.type === "user") {
    if (!isRecord(value.message) || !Array.isArray(value.message.content)) {
      return [];
    }
    const signals: ProviderSignal[] = [];
    for (const block of value.message.content) {
      if (isRecord(block) && block.type === "tool_result") {
        const toolUseId =
          typeof block.tool_use_id === "string" && block.tool_use_id.length > 0
            ? block.tool_use_id
            : undefined;
        const correlatedToolName =
          toolUseId === undefined ? undefined : toolNamesByUseId.get(toolUseId);
        const toolName =
          typeof block.tool_name === "string"
            ? block.tool_name
            : (correlatedToolName ?? "provider-tool");
        const redactSummary =
          isPrivateOpenDelegateTool(toolName) ||
          (toolUseId !== undefined && correlatedToolName === undefined);
        const summary = redactSummary
          ? undefined
          : typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? "[structured tool result]"
              : undefined;
        if (toolUseId !== undefined) {
          toolNamesByUseId.delete(toolUseId);
        }
        signals.push({
          kind: "tool_result",
          toolName,
          status: block.is_error === true ? "failed" : "succeeded",
          ...(summary === undefined ? {} : { summary }),
        });
      }
    }
    return signals;
  }
  if (value.type === "result") {
    if (typeof value.session_id !== "string" || value.session_id.length === 0) {
      throw new AgentAdapterError(
        "MALFORMED_PROVIDER_OUTPUT",
        "Claude result did not include a session ID.",
      );
    }
    const usage = parseClaudeUsage(value.usage, value.total_cost_usd);
    const failed = value.is_error === true || value.subtype !== "success";
    return [
      { kind: "session", nativeSessionId: value.session_id },
      {
        kind: "terminal",
        status: failed ? "failed" : "succeeded",
        ...(typeof value.result === "string" ? { finalText: value.result } : {}),
        ...(usage === undefined ? {} : { usage }),
        ...(failed
          ? {
              error: {
                code: "CLAUDE_TURN_FAILED",
                message: "Claude reported a failed turn.",
                retryable: true,
              },
            }
          : {}),
      },
    ];
  }
  return [];
}

function isPrivateOpenDelegateTool(toolName: string): boolean {
  return /^mcp__opendelegate(?:-[A-Za-z0-9_-]+)?__(?:knowledge_|computer_use_)/u.test(toolName);
}

function parseClaudeUsage(value: unknown, cost: unknown): AgentUsage | undefined {
  const usage = isRecord(value) ? value : {};
  const inputTokens = nonNegativeNumber(usage.input_tokens);
  const outputTokens = nonNegativeNumber(usage.output_tokens);
  const cachedInputTokens =
    nonNegativeNumber(usage.cache_read_input_tokens) ??
    nonNegativeNumber(usage.cached_input_tokens);
  const costUsd = nonNegativeNumber(cost);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeTools(tools: readonly string[] | undefined): readonly string[] {
  return [...new Set((tools ?? []).map((tool) => tool.trim()).filter((tool) => tool.length > 0))];
}
