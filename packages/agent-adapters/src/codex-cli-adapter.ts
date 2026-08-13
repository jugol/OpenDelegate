import { randomUUID } from "node:crypto";

import { resolveDefaultCodexCommand } from "./codex-command.ts";
import {
  type AgentAdapter,
  type AgentModelCatalog,
  type AgentAdapterProbe,
  type AgentAdapterProbeInput,
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentStartRequest,
  type AgentToolServer,
} from "./contracts.ts";
import { CodexAppServerAdapter } from "./codex-app-server-adapter.ts";
import {
  assertProviderHomeNotInSecretEnvironment,
  isDefaultProviderHome,
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

export const CODEX_CLI_TESTED_VERSIONS = ["0.146.0"] as const;

const CODEX_DETERMINISTIC_EXECUTION_ARGS = [
  "--ignore-user-config",
  "--ignore-rules",
  "--disable",
  "apps",
  "--disable",
  "auth_elicitation",
  "--disable",
  "browser_use",
  "--disable",
  "browser_use_external",
  "--disable",
  "browser_use_full_cdp_access",
  "--disable",
  "code_mode_host",
  "--disable",
  "computer_use",
  "--disable",
  "external_agent_memory_import",
  "--disable",
  "hooks",
  "--disable",
  "image_generation",
  "--disable",
  "in_app_browser",
  "--disable",
  "multi_agent",
  "--disable",
  "network_proxy",
  "--disable",
  "plugin_sharing",
  "--disable",
  "request_permissions_tool",
  "--disable",
  "skill_mcp_dependency_install",
  "--disable",
  "tool_call_mcp_elicitation",
  "--disable",
  "tool_suggest",
  "--disable",
  "workspace_dependencies",
] as const;

export interface CodexCliAdapterOptions {
  readonly codexHome: string;
  readonly executable?: string;
  readonly prefixArgs?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly testedVersions?: readonly string[];
  readonly allowUntestedVersion?: boolean;
  readonly skipGitRepositoryCheck?: boolean;
  readonly leaseStore?: SessionLeaseStore;
  readonly now?: () => number;
  readonly lineageId?: () => string;
}

export class CodexCliAdapter implements AgentAdapter {
  readonly adapterId = "codex-cli";
  readonly provider = "codex" as const;
  readonly #codexHome: string;
  readonly #executable: string;
  readonly #prefixArgs: readonly string[];
  readonly #testedVersions: readonly string[];
  readonly #allowUntestedVersion: boolean;
  readonly #skipGitRepositoryCheck: boolean;
  readonly #leaseStore: SessionLeaseStore;
  readonly #now: () => number;
  readonly #lineageId: () => string;

  constructor(options: CodexCliAdapterOptions) {
    this.#codexHome = resolveControlledProviderHome(options.codexHome, "Codex");
    const command =
      options.executable === undefined && options.prefixArgs === undefined
        ? resolveDefaultCodexCommand(
            options.environment === undefined ? {} : { environment: options.environment },
          )
        : {
            executable: options.executable ?? "codex",
            prefixArgs: options.prefixArgs ?? [],
          };
    this.#executable = command.executable;
    this.#prefixArgs = command.prefixArgs;
    this.#testedVersions = options.testedVersions ?? CODEX_CLI_TESTED_VERSIONS;
    this.#allowUntestedVersion = options.allowUntestedVersion ?? false;
    this.#skipGitRepositoryCheck = options.skipGitRepositoryCheck ?? false;
    this.#leaseStore = options.leaseStore ?? processSessionLeaseStore;
    this.#now = options.now ?? Date.now;
    this.#lineageId = options.lineageId ?? randomUUID;
  }

  async probe(input: AgentAdapterProbeInput = {}): Promise<AgentAdapterProbe> {
    assertProviderHomeNotInSecretEnvironment("CODEX_HOME", input.secretEnvironment);
    await prepareControlledProviderHome(this.#codexHome, "Codex");
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
      providerLabel: "Codex CLI",
      capabilities,
      versionCommand: this.#command(
        [...this.#prefixArgs, "--version"],
        process.cwd(),
        input.environment,
        input.secretEnvironment,
      ),
      authCommand: this.#command(
        [...this.#prefixArgs, "login", "status"],
        process.cwd(),
        input.environment,
        input.secretEnvironment,
      ),
      testedVersions: this.#testedVersions,
      packageName: "@openai/codex",
      signIn: {
        command: "codex login",
        homeVariable: "CODEX_HOME",
        home: this.#codexHome,
        homeIsDefault: isDefaultProviderHome("codex", this.#codexHome),
      },
      parseVersion: parseCodexVersion,
    });
  }

  async start(request: AgentStartRequest): Promise<AgentRunHandle> {
    return await this.#launch(request);
  }

  async listModels(input: AgentAdapterProbeInput = {}): Promise<AgentModelCatalog> {
    return await new CodexAppServerAdapter({
      codexHome: this.#codexHome,
      executable: this.#executable,
      prefixArgs: this.#prefixArgs,
      testedVersions: this.#testedVersions,
      allowUntestedVersion: this.#allowUntestedVersion,
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
    const probe = await this.probe({
      ...(request.environment === undefined ? {} : { environment: request.environment }),
      ...(request.secretEnvironment === undefined
        ? {}
        : { secretEnvironment: request.secretEnvironment }),
    });
    if (!probe.installed) {
      throw new AgentAdapterError("ADAPTER_UNAVAILABLE", "Codex CLI is unavailable.", true);
    }
    if (probe.auth.state !== "ready") {
      throw new AgentAdapterError(
        "ADAPTER_AUTH_NOT_READY",
        "Codex CLI authentication is not ready.",
        true,
      );
    }
    if (
      probe.version === undefined ||
      (probe.compatibility !== "tested" && !this.#allowUntestedVersion)
    ) {
      throw new AgentAdapterError(
        "ADAPTER_VERSION_UNSUPPORTED",
        "Codex CLI version has not passed the configured compatibility policy.",
      );
    }
    const adapterVersion = probe.version;
    const args = this.#invocationArgs(request, cwd);
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
      parseLine: parseCodexSignal,
    });
  }

  #invocationArgs(request: AgentStartRequest | AgentResumeRequest, cwd: string): string[] {
    if (request.permissions.mode === "allow-listed") {
      throw new AgentAdapterError(
        "PERMISSION_MODE_UNSUPPORTED",
        "Codex CLI fallback cannot bridge allow-list approvals; use the SDK/App Server adapter.",
      );
    }
    if (request.sandbox === "container" || request.sandbox === "custom") {
      throw new AgentAdapterError(
        "SANDBOX_MODE_UNSUPPORTED",
        "Codex CLI does not expose the requested sandbox mode.",
      );
    }
    const common = [
      "--json",
      ...CODEX_DETERMINISTIC_EXECUTION_ARGS,
      ...(request.modelId === undefined ? [] : ["--model", request.modelId]),
      ...codexToolServerArguments(request.toolServers),
      "-c",
      `sandbox_mode="${request.sandbox === "provider-default" ? "read-only" : request.sandbox}"`,
    ];
    if (this.#skipGitRepositoryCheck) {
      common.push("--skip-git-repo-check");
    }
    if (request.permissions.mode === "deny") {
      common.push("--disable", "shell_tool");
    } else if (request.permissions.mode === "bypass") {
      validateDangerousGrant(request);
      if (request.sandbox !== "danger-full-access") {
        throw new AgentAdapterError(
          "DANGEROUS_BYPASS_SCOPE_MISMATCH",
          "Dangerous bypass requires the explicit danger-full-access sandbox.",
        );
      }
      common.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (request.permissions.mode !== "bypass") {
      common.push("-c", 'approval_policy="never"');
    }
    if (request.operation === "start") {
      return [...this.#prefixArgs, "exec", ...common, "--color", "never", "-C", cwd, "-"];
    }
    return [...this.#prefixArgs, "exec", "resume", request.session.nativeSessionId, ...common, "-"];
  }

  #command(
    args: readonly string[],
    cwd: string,
    environment?: Readonly<Record<string, string>>,
    secretEnvironment?: Readonly<Record<string, string>>,
  ): SpawnCommand {
    assertProviderHomeNotInSecretEnvironment("CODEX_HOME", secretEnvironment);
    return {
      executable: this.#executable,
      args,
      cwd,
      environment: {
        ...environment,
        CODEX_HOME: this.#codexHome,
      },
      ...(secretEnvironment === undefined ? {} : { secretEnvironment }),
    };
  }
}

function codexToolServerArguments(toolServers: readonly AgentToolServer[] | undefined): string[] {
  return (toolServers ?? []).flatMap((server) => {
    const prefix = `mcp_servers.${server.serverName}`;
    return [
      "-c",
      `${prefix}.command=${JSON.stringify(server.command)}`,
      "-c",
      `${prefix}.args=${JSON.stringify(server.args)}`,
      "-c",
      `${prefix}.enabled_tools=${JSON.stringify(server.enabledTools)}`,
      "-c",
      `${prefix}.startup_timeout_sec=${String(Math.ceil(server.startupTimeoutMs / 1_000))}`,
      "-c",
      `${prefix}.tool_timeout_sec=${String(Math.ceil(server.toolTimeoutMs / 1_000))}`,
    ];
  });
}

function parseCodexVersion(output: string): string {
  const match = /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/iu.exec(output.trim());
  if (match?.[1] === undefined) {
    throw new AgentAdapterError(
      "UNRECOGNIZED_PROVIDER_VERSION",
      "Codex CLI returned an unrecognized version.",
    );
  }
  return match[1];
}

function parseCodexSignal(value: unknown): readonly ProviderSignal[] {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new AgentAdapterError(
      "MALFORMED_PROVIDER_OUTPUT",
      "Codex CLI event was not an object with a type.",
    );
  }
  if (value.type === "thread.started") {
    if (typeof value.thread_id !== "string" || value.thread_id.length === 0) {
      throw new AgentAdapterError(
        "MALFORMED_PROVIDER_OUTPUT",
        "Codex session event did not include a thread ID.",
      );
    }
    return [{ kind: "session", nativeSessionId: value.thread_id }];
  }
  if (value.type === "item.completed") {
    if (!isRecord(value.item) || typeof value.item.type !== "string") {
      throw new AgentAdapterError("MALFORMED_PROVIDER_OUTPUT", "Codex item was malformed.");
    }
    if (value.item.type === "agent_message") {
      if (typeof value.item.text !== "string") {
        throw new AgentAdapterError(
          "MALFORMED_PROVIDER_OUTPUT",
          "Codex agent message was malformed.",
        );
      }
      return [{ kind: "public_message", text: value.item.text }];
    }
    if (value.item.type === "command_execution") {
      const failed = value.item.status === "failed";
      return [
        {
          kind: "tool_result",
          toolName: "shell",
          status: failed ? "failed" : "succeeded",
          ...(typeof value.item.aggregated_output === "string"
            ? { summary: value.item.aggregated_output }
            : {}),
        },
      ];
    }
    if (value.item.type === "mcp_tool_call") {
      const failed = value.item.status === "failed";
      return [
        {
          kind: "tool_result",
          toolName:
            typeof value.item.tool === "string"
              ? value.item.tool
              : typeof value.item.name === "string"
                ? value.item.name
                : "mcp-tool",
          status: failed ? "failed" : "succeeded",
        },
      ];
    }
    return [];
  }
  if (value.type === "turn.completed") {
    if (!isRecord(value.usage)) {
      return [{ kind: "terminal", status: "succeeded", usage: {} }];
    }
    const inputTokens = numberValue(value.usage.input_tokens);
    const outputTokens = numberValue(value.usage.output_tokens);
    const cachedInputTokens = numberValue(value.usage.cached_input_tokens);
    return [
      {
        kind: "terminal",
        status: "succeeded",
        usage: {
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        },
      },
    ];
  }
  if (value.type === "turn.failed") {
    return [
      {
        kind: "terminal",
        status: "failed",
        error: {
          code: "CODEX_TURN_FAILED",
          message: "Codex reported a failed turn.",
          retryable: true,
        },
      },
    ];
  }
  if (value.type === "error") {
    const message = typeof value.message === "string" ? value.message : "Codex reported an error.";
    return [{ kind: "diagnostic", level: "warning", code: "CODEX_ERROR_EVENT", message }];
  }
  return [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
