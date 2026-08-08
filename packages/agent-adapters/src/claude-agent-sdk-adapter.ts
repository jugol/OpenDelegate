import { randomUUID } from "node:crypto";

import { createProviderToolAuthorizationRequest } from "./action-authorization.ts";
import {
  assertProviderHomeNotInSecretEnvironment,
  isDefaultProviderHome,
  prepareControlledProviderHome,
  resolveControlledProviderHome,
} from "./controlled-provider-home.ts";
import {
  AGENT_ADAPTER_CONTRACT_VERSION,
  type AgentAdapter,
  type AgentModelCatalog,
  type AgentModelDescriptor,
  type AgentAdapterProbe,
  type AgentAdapterProbeInput,
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentStartRequest,
  type AgentSteerRequest,
  type AgentToolServer,
  type AgentUsage,
} from "./contracts.ts";
import { AgentAdapterError } from "./errors.ts";
import {
  type ProgrammaticProviderEvent,
  type ProgrammaticProviderResult,
  startProgrammaticTurn,
} from "./programmatic-turn.ts";
import { buildChildEnvironment, captureCommand, type SpawnCommand } from "./process-utils.ts";
import { isRecord } from "./redaction.ts";
import { processSessionLeaseStore, type SessionLeaseStore } from "./session-leases.ts";
import {
  canonicalizeWorkspace,
  createNativeSessionReference,
  rejectUnscopedProviderSecrets,
  validateAgentRequest,
  validateResumeReference,
} from "./session-reference.ts";
import { ActiveRunSteeringController } from "./steering.ts";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.220";
export const CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION = "2.1.220";
const CLAUDE_AGENT_SDK_MODULE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_NATIVE_SUBAGENT_MAX_CHILDREN = 4;

const ALLOWED_SDK_MESSAGE_TYPES = new Set([
  "assistant",
  "auth_status",
  "background_tasks_changed",
  "conversation_reset",
  "files_persisted",
  "hook_progress",
  "hook_response",
  "hook_started",
  "informational",
  "local_command_output",
  "memory_recall",
  "notification",
  "permission_denied",
  "plugin_install",
  "prompt_suggestion",
  "rate_limit_event",
  "result",
  "session_state_changed",
  "status",
  "stream_event",
  "system",
  "task_notification",
  "task_progress",
  "task_started",
  "task_updated",
  "thinking_tokens",
  "tool_progress",
  "tool_use_summary",
  "user",
  "worker_shutting_down",
]);

export interface ClaudeAgentSdkQuery {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  interrupt?(): Promise<unknown>;
  streamInput?(stream: AsyncIterable<ClaudeAgentSdkUserMessage>): Promise<void>;
  close?(): void;
  supportedModels?(): Promise<unknown>;
}

export interface ClaudeAgentSdkUserMessage {
  readonly type: "user";
  readonly message: {
    readonly role: "user";
    readonly content: string;
  };
  readonly parent_tool_use_id: null;
  readonly priority: "now" | "next" | "later";
  readonly shouldQuery: boolean;
  readonly timestamp: string;
  readonly uuid?: string;
  readonly session_id?: string;
}

export interface ClaudeAgentSdkPort {
  query(input: {
    readonly prompt: string | AsyncIterable<ClaudeAgentSdkUserMessage>;
    readonly options: Readonly<Record<string, unknown>>;
  }): ClaudeAgentSdkQuery;
}

interface ClaudePermissionCallbackOptions {
  readonly signal: AbortSignal;
  readonly toolUseID: string;
  readonly title?: string;
  readonly description?: string;
  readonly decisionReason?: string;
  readonly blockedPath?: string;
}

export interface ClaudeAgentSdkAdapterOptions {
  readonly claudeHome: string;
  readonly authExecutable?: string;
  readonly authPrefixArgs?: readonly string[];
  readonly sdk?: ClaudeAgentSdkPort;
  readonly hostPlatform?: NodeJS.Platform;
  readonly allowedNetworkDomains?: readonly string[];
  readonly leaseStore?: SessionLeaseStore;
  readonly now?: () => number;
  readonly lineageId?: () => string;
}

export class ClaudeAgentSdkAdapter implements AgentAdapter {
  readonly adapterId = "claude-agent-sdk";
  readonly provider = "claude" as const;
  readonly #claudeHome: string;
  readonly #authExecutable: string;
  readonly #authPrefixArgs: readonly string[];
  readonly #sdk: ClaudeAgentSdkPort | undefined;
  readonly #hostPlatform: NodeJS.Platform;
  readonly #allowedNetworkDomains: readonly string[];
  readonly #leaseStore: SessionLeaseStore;
  readonly #now: () => number;
  readonly #lineageId: () => string;

  public constructor(options: ClaudeAgentSdkAdapterOptions) {
    this.#claudeHome = resolveControlledProviderHome(options.claudeHome, "Claude");
    this.#authExecutable = options.authExecutable ?? "claude";
    this.#authPrefixArgs = options.authPrefixArgs ?? [];
    this.#sdk = options.sdk;
    this.#hostPlatform = options.hostPlatform ?? process.platform;
    this.#allowedNetworkDomains = Object.freeze(
      [...(options.allowedNetworkDomains ?? [])].map(validateNetworkDomain),
    );
    this.#leaseStore = options.leaseStore ?? processSessionLeaseStore;
    this.#now = options.now ?? Date.now;
    this.#lineageId = options.lineageId ?? randomUUID;
  }

  public async probe(input: AgentAdapterProbeInput = {}): Promise<AgentAdapterProbe> {
    assertProviderHomeNotInSecretEnvironment("CLAUDE_CONFIG_DIR", input.secretEnvironment);
    await prepareControlledProviderHome(this.#claudeHome, "Claude");
    const capabilities = {
      start: true,
      resume: true,
      streaming: true,
      cancellation: true,
      approvalBridge: true,
      steering: true,
      checkpointContinuation: true,
      workspaceIsolation: [
        "none",
        "agent-native-worktree",
        "opendelegate-worktree",
        "container",
        "custom",
      ],
    } as const;
    const diagnostics: { code: string; message: string }[] = [];
    let sdkInstalled = true;
    try {
      await this.#resolveSdk();
    } catch {
      sdkInstalled = false;
      diagnostics.push({
        code: "SDK_PACKAGE_UNAVAILABLE",
        message: "The pinned Claude Agent SDK package is unavailable.",
      });
    }
    const nativeWindows = this.#hostPlatform === "win32";
    if (nativeWindows) {
      diagnostics.push({
        code: "CLAUDE_SANDBOX_UNAVAILABLE_NATIVE_WINDOWS",
        message:
          "Claude Agent SDK execution is disabled in a native Windows Worker; use Codex, WSL2, or a configured container.",
      });
    }
    let authState: AgentAdapterProbe["auth"]["state"];
    const apiKey = input.secretEnvironment?.["ANTHROPIC_API_KEY"];
    if (typeof apiKey === "string" && apiKey.length > 0) {
      authState = "ready";
    } else {
      try {
        const auth = await captureCommand(
          this.#authCommand(
            [...this.#authPrefixArgs, "auth", "status", "--json"],
            input.environment,
            input.secretEnvironment,
          ),
          5_000,
          64 * 1024,
        );
        authState = !auth.timedOut && auth.exitCode === 0 ? "ready" : "not_ready";
        if (authState !== "ready") {
          diagnostics.push({
            code: auth.timedOut ? "AUTH_PROBE_TIMEOUT" : "AUTH_NOT_READY",
            message: auth.timedOut
              ? "The Claude authentication probe timed out."
              : `Claude is not signed in on this Device. Run ${
                  isDefaultProviderHome("claude", this.#claudeHome)
                    ? "claude"
                    : `claude with CLAUDE_CONFIG_DIR=${this.#claudeHome}`
                } in a terminal and complete the sign-in there. The Claude desktop app holds ` +
                "its own session and does not sign in this CLI.",
          });
        }
      } catch {
        authState = "unknown";
        diagnostics.push({
          code: "AUTH_PROBE_FAILED",
          message: "Claude authentication could not be probed safely.",
        });
      }
    }
    return {
      contractVersion: AGENT_ADAPTER_CONTRACT_VERSION,
      adapterId: this.adapterId,
      provider: this.provider,
      installed: sdkInstalled,
      version: CLAUDE_AGENT_SDK_VERSION,
      compatibility: nativeWindows || !sdkInstalled ? "incompatible" : "tested",
      auth: { state: authState },
      capabilities,
      diagnostics,
      // A native Windows Worker cannot host this adapter at any version: the SDK's
      // fail-closed sandbox needs an OS primitive Windows does not have. Signing in
      // or upgrading changes nothing, so the adapter asks not to be advertised. A
      // missing SDK package is deliberately excluded — installing it is a remedy.
      ...(nativeWindows ? { unsupportedOnDevice: true } : {}),
    };
  }

  public async listModels(input: AgentAdapterProbeInput = {}): Promise<AgentModelCatalog> {
    const probe = await this.probe(input);
    if (
      !probe.installed ||
      probe.version !== CLAUDE_AGENT_SDK_VERSION ||
      probe.auth.state !== "ready"
    ) {
      throw new AgentAdapterError(
        "ADAPTER_NOT_READY",
        "The pinned Claude Agent SDK must be installed and authenticated before listing models.",
        true,
      );
    }
    const sdk = await this.#resolveSdk();
    const query = sdk.query({
      prompt: emptyClaudeInput(),
      options: {
        cwd: process.cwd(),
        env: {
          ...buildChildEnvironment(input.environment, input.secretEnvironment),
          CLAUDE_AGENT_SDK_CLIENT_APP: `opendelegate/${CLAUDE_AGENT_SDK_VERSION}`,
          CLAUDE_CONFIG_DIR: this.#claudeHome,
        },
        settingSources: [],
        tools: [],
        strictMcpConfig: true,
      },
    });
    try {
      if (typeof query.supportedModels !== "function") {
        throw new AgentAdapterError(
          "MODEL_CATALOG_UNAVAILABLE",
          "The pinned Claude Agent SDK does not expose supportedModels().",
        );
      }
      const models = parseClaudeModelCatalog(await query.supportedModels());
      return Object.freeze({
        observedAt: new Date(this.#now()).toISOString(),
        models,
      });
    } finally {
      query.close?.();
    }
  }

  public async start(request: AgentStartRequest): Promise<AgentRunHandle> {
    return await this.#launch(request);
  }

  public async resume(request: AgentResumeRequest): Promise<AgentRunHandle> {
    return await this.#launch(request);
  }

  async #launch(request: AgentStartRequest | AgentResumeRequest): Promise<AgentRunHandle> {
    validateAgentRequest(request);
    rejectUnscopedProviderSecrets(request);
    if (this.#hostPlatform === "win32") {
      throw new AgentAdapterError(
        "SANDBOX_UNAVAILABLE",
        "Claude Agent SDK cannot satisfy OpenDelegate's fail-closed sandbox on native Windows.",
      );
    }
    if (request.permissions.mode !== "allow-listed" && request.permissions.mode !== "deny") {
      throw new AgentAdapterError(
        "PERMISSION_MODE_UNSUPPORTED",
        "Claude Agent SDK execution requires deny mode or the OpenDelegate allow-list approval bridge.",
      );
    }
    if (
      request.permissions.mode === "allow-listed" &&
      request.permissions.actionAuthorization === undefined
    ) {
      throw new AgentAdapterError(
        "ACTION_AUTHORIZATION_REQUIRED",
        "Claude Agent SDK execution requires Main's exact-action authorization port.",
      );
    }
    if (
      request.sandbox !== "provider-default" &&
      request.sandbox !== "workspace-write" &&
      request.sandbox !== "read-only"
    ) {
      throw new AgentAdapterError(
        "SANDBOX_MODE_UNSUPPORTED",
        "Claude Agent SDK does not expose the requested fail-closed sandbox mode.",
      );
    }
    const workspace = await canonicalizeWorkspace(request.workspace);
    if (request.operation === "resume") {
      validateResumeReference(request, workspace, this.provider, this.adapterId);
    }
    const probe = await this.probe({
      ...(request.environment === undefined ? {} : { environment: request.environment }),
      ...(request.secretEnvironment === undefined
        ? {}
        : { secretEnvironment: request.secretEnvironment }),
    });
    if (probe.compatibility !== "tested") {
      throw new AgentAdapterError(
        "ADAPTER_VERSION_UNSUPPORTED",
        "Claude Agent SDK is incompatible with this Worker platform.",
      );
    }
    if (probe.auth.state !== "ready") {
      throw new AgentAdapterError(
        "ADAPTER_AUTH_NOT_READY",
        "Claude authentication is not ready.",
        true,
      );
    }
    const steering = new ActiveRunSteeringController(
      {
        provider: this.provider,
        adapterId: this.adapterId,
        runId: request.runId,
        taskId: request.taskId,
        workstreamId: request.workstreamId,
        sessionKey: request.sessionKey,
        deviceId: request.deviceId,
        workspaceId: workspace.workspaceId,
      },
      this.#now,
    );
    const handle = await startProgrammaticTurn({
      request,
      leaseStore: this.#leaseStore,
      now: this.#now,
      createSession: (nativeSessionId) =>
        createNativeSessionReference({
          provider: this.provider,
          adapterId: this.adapterId,
          adapterVersion: CLAUDE_AGENT_SDK_VERSION,
          nativeSessionId,
          request,
          workspace,
          lineageId: this.#lineageId,
          now: this.#now,
        }),
      run: async ({ emit, signal }) => {
        try {
          return await this.#runSdkTurn(request, workspace.cwd, emit, signal, steering);
        } finally {
          steering.complete();
        }
      },
    });
    return {
      events: handle.events,
      result: handle.result,
      cancel: (reason?: string) => handle.cancel(reason),
      steer: async (steerRequest: AgentSteerRequest) => await steering.steer(steerRequest),
    };
  }

  async #runSdkTurn(
    request: AgentStartRequest | AgentResumeRequest,
    cwd: string,
    emit: (event: ProgrammaticProviderEvent) => Promise<void>,
    signal: AbortSignal,
    steering: ActiveRunSteeringController,
  ): Promise<ProgrammaticProviderResult> {
    const sdkAbort = new AbortController();
    let nativeSessionId: string | undefined;
    let finalText: string | undefined;
    let usage: AgentUsage | undefined;
    const nativeSubagentToolUseIds = new Set<string>();
    const streamingInput = new ClaudeStreamingInput(
      claudeUserMessage(request.prompt, "now", this.#now()),
    );
    const queryOptions = {
      abortController: sdkAbort,
      cwd,
      ...(request.modelId === undefined ? {} : { model: request.modelId }),
      ...(request.operation === "resume" ? { resume: request.session.nativeSessionId } : {}),
      env: {
        ...buildChildEnvironment(request.environment, request.secretEnvironment),
        CLAUDE_AGENT_SDK_CLIENT_APP: `opendelegate/${CLAUDE_AGENT_SDK_VERSION}`,
        CLAUDE_CONFIG_DIR: this.#claudeHome,
      },
      permissionMode: "default",
      tools:
        request.permissions.mode === "deny" ? [] : [...(request.permissions.allowedTools ?? [])],
      disallowedTools: [...(request.permissions.deniedTools ?? [])],
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      plugins: [],
      includePartialMessages: true,
      promptSuggestions: false,
      agentProgressSummaries: false,
      mcpServers: claudeMcpServers(request.toolServers),
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        allowAppleEvents: false,
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
        network: {
          allowedDomains: [...this.#allowedNetworkDomains],
          allowManagedDomainsOnly: true,
          allowUnixSockets: [],
          allowAllUnixSockets: false,
          allowLocalBinding: false,
        },
        filesystem: {
          allowWrite: request.sandbox === "read-only" ? [] : [cwd],
          allowRead: [cwd],
          allowManagedReadPathsOnly: true,
        },
      },
      canUseTool: async (
        toolName: string,
        toolInput: Record<string, unknown>,
        options: ClaudePermissionCallbackOptions,
      ) => {
        const toolUseId = requiredSdkString(options["toolUseID"], "tool-use ID");
        if (request.permissions.mode === "deny") {
          return {
            behavior: "deny",
            message: "This OpenDelegate Agent turn does not expose provider-native tools.",
            interrupt: false,
            toolUseID: toolUseId,
            decisionClassification: "user_reject",
          };
        }
        if (isAllowedClaudeNativeSubagentTool(toolName, request.permissions.allowedTools)) {
          if (
            !nativeSubagentToolUseIds.has(toolUseId) &&
            nativeSubagentToolUseIds.size >= CLAUDE_NATIVE_SUBAGENT_MAX_CHILDREN
          ) {
            return {
              behavior: "deny",
              message: `OpenDelegate allows at most ${CLAUDE_NATIVE_SUBAGENT_MAX_CHILDREN} native child Agents in one Worker Run.`,
              interrupt: false,
              toolUseID: toolUseId,
              decisionClassification: "user_reject",
            };
          }
          if (!nativeSubagentToolUseIds.has(toolUseId)) {
            nativeSubagentToolUseIds.add(toolUseId);
            await emit({
              kind: "progress",
              message: `A native child Agent was delegated inside this Worker Run (${nativeSubagentToolUseIds.size}/${CLAUDE_NATIVE_SUBAGENT_MAX_CHILDREN}).`,
            });
          }
          // Delegation itself adds no authority. The child remains in the same
          // SDK query, sandbox, Workspace, and canUseTool callback, so every
          // consequential child action still crosses OpenDelegate Policy.
          return {
            behavior: "allow",
            toolUseID: toolUseId,
            decisionClassification: "user_temporary",
          };
        }
        if (
          isConfiguredDeviceLocalKnowledgeTool(
            toolName,
            request.toolServers,
            request.permissions.allowedTools,
          ) ||
          isConfiguredPlatformMutationTool(
            toolName,
            request.toolServers,
            request.permissions.allowedTools,
          ) ||
          isConfiguredSelfAuthorizingRunTool(
            toolName,
            request.toolServers,
            request.permissions.allowedTools,
          )
        ) {
          return {
            behavior: "allow",
            toolUseID: toolUseId,
            decisionClassification: "user_temporary",
          };
        }
        const authorization = createProviderToolAuthorizationRequest({
          provider: "claude",
          runId: request.runId,
          toolName,
          toolUseId,
          input: toolInput,
          requestedAtMs: this.#now(),
          signal: options.signal instanceof AbortSignal ? options.signal : sdkAbort.signal,
          ...(typeof options.title === "string" ? { title: options.title } : {}),
          ...(typeof options.description === "string" ? { description: options.description } : {}),
          ...(typeof options.decisionReason === "string"
            ? { decisionReason: options.decisionReason }
            : {}),
          ...(typeof options.blockedPath === "string" ? { blockedPath: options.blockedPath } : {}),
        });
        await emit({
          kind: "approval_request",
          requestId: authorization.authorizationRequestId,
          actionType: authorization.actionType,
          summary: `${toolName} requests ${authorization.actionCategory.replaceAll("-", " ")} authorization.`,
          scope: {
            actionFingerprint: authorization.actionFingerprint,
            actionCategory: authorization.actionCategory,
          },
        });
        try {
          const decision =
            await request.permissions.actionAuthorization!.authorizeAndConsume(authorization);
          return decision.decision === "allow"
            ? {
                behavior: "allow",
                toolUseID: toolUseId,
                decisionClassification: "user_temporary",
              }
            : {
                behavior: "deny",
                message: decision.reasonCode,
                interrupt: false,
                toolUseID: toolUseId,
                decisionClassification: "user_reject",
              };
        } catch {
          return {
            behavior: "deny",
            message: "OpenDelegate action authorization is unavailable.",
            interrupt: false,
            toolUseID: toolUseId,
            decisionClassification: "user_reject",
          };
        }
      },
    };
    const sdk = await this.#resolveSdk();
    const query = sdk.query({
      prompt: streamingInput,
      options: queryOptions as unknown as Readonly<Record<string, unknown>>,
    });
    const onAbort = (): void => {
      void query.interrupt?.().catch(() => undefined);
      sdkAbort.abort(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      for await (const raw of query) {
        const message = requireSdkRecord(raw);
        const type = requiredSdkString(message["type"], "message type");
        if (!ALLOWED_SDK_MESSAGE_TYPES.has(type)) {
          throw new AgentAdapterError(
            "UNKNOWN_PROVIDER_MESSAGE",
            `Claude Agent SDK emitted unsupported message type ${type}.`,
          );
        }
        const sessionId =
          typeof message["session_id"] === "string" ? message["session_id"] : undefined;
        if (sessionId !== undefined) {
          if (nativeSessionId === undefined) {
            nativeSessionId = sessionId;
            await emit({ kind: "session", nativeSessionId });
            const activeNativeSessionId = nativeSessionId;
            steering.activate({
              nativeSessionId: activeNativeSessionId,
              send: async (steerRequest) => {
                await streamingInput.enqueue(
                  claudeUserMessage(
                    steerRequest.instruction,
                    "now",
                    this.#now(),
                    activeNativeSessionId,
                  ),
                );
                await emit({
                  kind: "steering_accepted",
                  requestId: steerRequest.requestId,
                  requestedBy: steerRequest.requestedBy,
                });
                return {};
              },
            });
          } else if (nativeSessionId !== sessionId) {
            throw new AgentAdapterError(
              "NATIVE_SESSION_ID_CHANGED",
              "Claude Agent SDK changed session IDs during one turn.",
            );
          }
        }
        if (type === "stream_event") {
          const delta = claudeTextDelta(message);
          if (delta !== undefined) {
            await emit({ kind: "message_delta", text: delta });
          }
          continue;
        }
        if (type === "assistant") {
          const assistant = parseClaudeAssistant(message);
          for (const event of assistant.events) {
            await emit(event);
          }
          if (assistant.text !== undefined) {
            finalText = assistant.text;
            await emit({ kind: "public_message", text: assistant.text });
          }
          continue;
        }
        if (type === "tool_progress" || type === "task_progress") {
          const progressTool =
            typeof message["tool_name"] === "string"
              ? message["tool_name"]
              : typeof message["toolName"] === "string"
                ? message["toolName"]
                : undefined;
          await emit({
            kind: "progress",
            message:
              progressTool !== undefined &&
              isConfiguredDeviceLocalKnowledgeTool(
                progressTool,
                request.toolServers,
                request.permissions.allowedTools,
              )
                ? "Device-local Knowledge operation is in progress."
                : claudeProgressMessage(message),
          });
          continue;
        }
        if (type === "task_started" || type === "task_updated" || type === "task_notification") {
          await emit({
            kind: "progress",
            message:
              type === "task_started"
                ? "A native child Agent started inside this Worker Run."
                : type === "task_updated"
                  ? "A native child Agent reported progress inside this Worker Run."
                  : "A native child Agent reported a lifecycle notification inside this Worker Run.",
          });
          continue;
        }
        if (type === "permission_denied") {
          const deniedTool = requiredSdkString(message["tool_name"], "denied tool name");
          const privateKnowledge = isConfiguredDeviceLocalKnowledgeTool(
            deniedTool,
            request.toolServers,
            request.permissions.allowedTools,
          );
          await emit({
            kind: "tool_result",
            toolName: deniedTool,
            status: "failed",
            ...(privateKnowledge
              ? {}
              : {
                  summary:
                    typeof message["message"] === "string"
                      ? message["message"]
                      : "Claude denied the tool.",
                }),
          });
          continue;
        }
        if (type === "result") {
          steering.complete();
          nativeSessionId = requiredSdkString(message["session_id"], "result session ID");
          usage = parseClaudeUsage(message);
          if (usage !== undefined) {
            await emit({ kind: "usage", usage });
          }
          if (message["subtype"] === "success" && message["is_error"] !== true) {
            finalText = typeof message["result"] === "string" ? message["result"] : finalText;
            return {
              status: "succeeded",
              nativeSessionId,
              ...(finalText === undefined ? {} : { finalText }),
              ...(usage === undefined ? {} : { usage }),
            };
          }
          return {
            status: "failed",
            nativeSessionId,
            ...(finalText === undefined ? {} : { finalText }),
            ...(usage === undefined ? {} : { usage }),
            error: {
              code: "CLAUDE_TURN_FAILED",
              message: claudeResultError(message),
              retryable: true,
            },
          };
        }
      }
      throw new AgentAdapterError(
        "INCOMPLETE_PROVIDER_OUTPUT",
        "Claude Agent SDK ended without a terminal result.",
      );
    } finally {
      steering.complete();
      streamingInput.close();
      signal.removeEventListener("abort", onAbort);
      query.close?.();
    }
  }

  #authCommand(
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
    secretEnvironment?: Readonly<Record<string, string>>,
  ): SpawnCommand {
    assertProviderHomeNotInSecretEnvironment("CLAUDE_CONFIG_DIR", secretEnvironment);
    return {
      executable: this.#authExecutable,
      args,
      cwd: process.cwd(),
      environment: {
        ...environment,
        CLAUDE_CONFIG_DIR: this.#claudeHome,
      },
      ...(secretEnvironment === undefined ? {} : { secretEnvironment }),
    };
  }

  async #resolveSdk(): Promise<ClaudeAgentSdkPort> {
    return this.#sdk ?? (await loadDefaultClaudeAgentSdk());
  }
}

function claudeMcpServers(
  servers: readonly AgentToolServer[] | undefined,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    (servers ?? []).map((server) => [
      server.serverName,
      {
        type: "stdio",
        command: server.command,
        args: [...server.args],
        env: {},
        timeout: server.toolTimeoutMs,
        alwaysLoad: true,
      },
    ]),
  );
}

async function* emptyClaudeInput(): AsyncGenerator<ClaudeAgentSdkUserMessage, void, void> {
  yield* [];
}

function parseClaudeModelCatalog(input: unknown): readonly AgentModelDescriptor[] {
  if (!Array.isArray(input) || input.length > 128) {
    throw new AgentAdapterError(
      "MALFORMED_PROVIDER_OUTPUT",
      "Claude Agent SDK returned an invalid model catalog.",
    );
  }
  const identities = new Set<string>();
  return Object.freeze(
    input.map((entry): AgentModelDescriptor => {
      if (!isRecord(entry)) {
        throw new AgentAdapterError(
          "MALFORMED_PROVIDER_OUTPUT",
          "Claude Agent SDK returned an invalid model catalog entry.",
        );
      }
      const modelId = readClaudeModelText(entry["value"], "model ID");
      const displayName = readClaudeModelText(entry["displayName"], "model display name");
      if (identities.has(modelId)) {
        throw new AgentAdapterError(
          "MALFORMED_PROVIDER_OUTPUT",
          "Claude Agent SDK returned duplicate model IDs.",
        );
      }
      identities.add(modelId);
      return Object.freeze({ modelId, displayName });
    }),
  );
}

function readClaudeModelText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  ) {
    throw new AgentAdapterError(
      "MALFORMED_PROVIDER_OUTPUT",
      `Claude Agent SDK returned an invalid ${label}.`,
    );
  }
  return value;
}

function isConfiguredDeviceLocalKnowledgeTool(
  toolName: string,
  servers: readonly AgentToolServer[] | undefined,
  allowedTools: readonly string[] | undefined,
): boolean {
  if (!(allowedTools ?? []).includes(toolName)) {
    return false;
  }
  for (const server of servers ?? []) {
    if (!/(?:^|[_-])knowledge(?:[_-]|$)/iu.test(server.serverName)) {
      continue;
    }
    if (
      server.enabledTools.some(
        (enabledTool) => toolName === `mcp__${server.serverName}__${enabledTool}`,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isAllowedClaudeNativeSubagentTool(
  toolName: string,
  allowedTools: readonly string[] | undefined,
): boolean {
  return (toolName === "Task" || toolName === "Agent") && (allowedTools ?? []).includes(toolName);
}

function isConfiguredPlatformMutationTool(
  toolName: string,
  servers: readonly AgentToolServer[] | undefined,
  allowedTools: readonly string[] | undefined,
): boolean {
  if (!(allowedTools ?? []).includes(toolName)) {
    return false;
  }
  for (const server of servers ?? []) {
    if (server.serverName !== "opendelegate-platform-mutation") {
      continue;
    }
    if (
      server.enabledTools.some(
        (enabledTool) =>
          enabledTool === "platform_mutation_execute" &&
          toolName === `mcp__${server.serverName}__${enabledTool}`,
      )
    ) {
      return true;
    }
  }
  return false;
}

const SELF_AUTHORIZING_RUN_TOOLS = Object.freeze({
  "opendelegate-artifact": new Set(["artifact_write_chunk", "artifact_commit"]),
  "opendelegate-computer-use": new Set([
    "computer_use_readiness",
    "computer_use_observe",
    "computer_use_capture",
    "computer_use_click",
    "computer_use_type_text",
    "computer_use_key",
    "computer_use_scroll",
    "computer_use_stop",
  ]),
});

function isConfiguredSelfAuthorizingRunTool(
  toolName: string,
  servers: readonly AgentToolServer[] | undefined,
  allowedTools: readonly string[] | undefined,
): boolean {
  if (!(allowedTools ?? []).includes(toolName)) {
    return false;
  }
  for (const server of servers ?? []) {
    const canonicalTools =
      SELF_AUTHORIZING_RUN_TOOLS[server.serverName as keyof typeof SELF_AUTHORIZING_RUN_TOOLS];
    if (canonicalTools === undefined) {
      continue;
    }
    for (const enabledTool of server.enabledTools) {
      if (
        canonicalTools.has(enabledTool) &&
        toolName === `mcp__${server.serverName}__${enabledTool}`
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseClaudeAssistant(message: Readonly<Record<string, unknown>>): {
  readonly text?: string;
  readonly events: readonly ProgrammaticProviderEvent[];
} {
  const envelope = requireSdkRecord(message["message"]);
  if (!Array.isArray(envelope["content"])) {
    throw malformedClaude("assistant content");
  }
  const text: string[] = [];
  const events: ProgrammaticProviderEvent[] = [];
  for (const rawBlock of envelope["content"]) {
    const block = requireSdkRecord(rawBlock);
    if (block["type"] === "text" && typeof block["text"] === "string") {
      text.push(block["text"]);
    } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
      const privateInput = /(?:^|[_:.-])knowledge(?:[_:.-]|$)/iu.test(block["name"]);
      events.push({
        kind: "tool_request",
        toolName: block["name"],
        ...(privateInput || block["input"] === undefined ? {} : { input: block["input"] }),
      });
    }
  }
  return {
    ...(text.length === 0 ? {} : { text: text.join("") }),
    events,
  };
}

function claudeTextDelta(message: Readonly<Record<string, unknown>>): string | undefined {
  if (!isRecord(message["event"])) {
    return undefined;
  }
  const event = message["event"];
  if (
    event["type"] === "content_block_delta" &&
    isRecord(event["delta"]) &&
    event["delta"]["type"] === "text_delta" &&
    typeof event["delta"]["text"] === "string"
  ) {
    return event["delta"]["text"];
  }
  return undefined;
}

function claudeProgressMessage(message: Readonly<Record<string, unknown>>): string {
  for (const field of ["summary", "description", "message", "content"]) {
    if (typeof message[field] === "string" && message[field].length > 0) {
      return message[field];
    }
  }
  return "Claude Agent SDK reported task progress.";
}

function parseClaudeUsage(message: Readonly<Record<string, unknown>>): AgentUsage | undefined {
  if (!isRecord(message["usage"])) {
    return undefined;
  }
  const raw = message["usage"];
  const inputTokens = nonNegativeNumber(raw["input_tokens"]);
  const outputTokens = nonNegativeNumber(raw["output_tokens"]);
  const cachedInputTokens = nonNegativeNumber(
    raw["cache_read_input_tokens"] ?? raw["cached_input_tokens"],
  );
  const costUsd = nonNegativeNumber(message["total_cost_usd"]);
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

function claudeResultError(message: Readonly<Record<string, unknown>>): string {
  if (Array.isArray(message["errors"])) {
    const errors = message["errors"].filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    if (errors.length > 0) {
      return errors.join("; ");
    }
  }
  return "Claude Agent SDK did not complete the turn.";
}

function requireSdkRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw malformedClaude("message");
  }
  return value;
}

function requiredSdkString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw malformedClaude(label);
  }
  return value;
}

function malformedClaude(field: string): AgentAdapterError {
  return new AgentAdapterError(
    "MALFORMED_PROVIDER_OUTPUT",
    `Claude Agent SDK emitted an invalid ${field}.`,
  );
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validateNetworkDomain(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    normalized.includes("/") ||
    normalized.includes(":") ||
    !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      normalized,
    )
  ) {
    throw new AgentAdapterError(
      "SANDBOX_NETWORK_DOMAIN_INVALID",
      "Claude sandbox network domains must be explicit DNS names.",
    );
  }
  return normalized;
}

interface ClaudeStreamingInputEntry {
  readonly message: ClaudeAgentSdkUserMessage;
  readonly consumed?: {
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  };
}

interface ClaudeStreamingInputConsumer {
  readonly resolve: (result: IteratorResult<ClaudeAgentSdkUserMessage>) => void;
}

/**
 * Keeps one SDK streaming-input channel open for the lifetime of the active
 * provider turn. A steering receipt is not returned until the SDK consumes the
 * corresponding message from this channel.
 */
class ClaudeStreamingInput implements AsyncIterable<ClaudeAgentSdkUserMessage> {
  readonly #entries: ClaudeStreamingInputEntry[];
  readonly #consumers: ClaudeStreamingInputConsumer[] = [];
  #closed = false;
  #iteratorCreated = false;

  public constructor(initial: ClaudeAgentSdkUserMessage) {
    this.#entries = [{ message: initial }];
  }

  public async enqueue(message: ClaudeAgentSdkUserMessage): Promise<void> {
    if (this.#closed) {
      throw new AgentAdapterError(
        "STEERING_TURN_COMPLETED",
        "Claude completed before it could consume the live steering instruction.",
      );
    }
    const consumer = this.#consumers.shift();
    if (consumer !== undefined) {
      consumer.resolve({ done: false, value: message });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#entries.push({ message, consumed: { resolve, reject } });
    });
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const error = new AgentAdapterError(
      "STEERING_TURN_COMPLETED",
      "Claude completed before it could consume the live steering instruction.",
    );
    for (const entry of this.#entries.splice(0)) {
      entry.consumed?.reject(error);
    }
    for (const consumer of this.#consumers.splice(0)) {
      consumer.resolve({ done: true, value: undefined });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<ClaudeAgentSdkUserMessage> {
    if (this.#iteratorCreated) {
      throw new AgentAdapterError(
        "PROVIDER_PROTOCOL_STATE_INVALID",
        "Claude streaming input was consumed more than once.",
      );
    }
    this.#iteratorCreated = true;
    return {
      next: async (): Promise<IteratorResult<ClaudeAgentSdkUserMessage>> => {
        const entry = this.#entries.shift();
        if (entry !== undefined) {
          entry.consumed?.resolve();
          return { done: false, value: entry.message };
        }
        if (this.#closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<ClaudeAgentSdkUserMessage>>((resolve) => {
          this.#consumers.push({ resolve });
        });
      },
    };
  }
}

function claudeUserMessage(
  instruction: string,
  priority: ClaudeAgentSdkUserMessage["priority"],
  now: number,
  nativeSessionId?: string,
): ClaudeAgentSdkUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: instruction,
    },
    parent_tool_use_id: null,
    priority,
    shouldQuery: true,
    timestamp: new Date(now).toISOString(),
    uuid: randomUUID(),
    ...(nativeSessionId === undefined ? {} : { session_id: nativeSessionId }),
  };
}

let defaultClaudeAgentSdk: Promise<ClaudeAgentSdkPort> | undefined;

async function loadDefaultClaudeAgentSdk(): Promise<ClaudeAgentSdkPort> {
  defaultClaudeAgentSdk ??= (async () => {
    // Keep provider types out of transitive workspace compilation. The package is
    // still exact-pinned in this package.json/lockfile and its runtime surface is
    // validated before use.
    const moduleName: string = CLAUDE_AGENT_SDK_MODULE;
    const loaded: unknown = await import(moduleName);
    if (!isRecord(loaded) || typeof loaded["query"] !== "function") {
      throw new AgentAdapterError(
        "SDK_PACKAGE_INVALID",
        "The pinned Claude Agent SDK package does not expose query().",
      );
    }
    const query = loaded["query"] as (input: {
      readonly prompt: string | AsyncIterable<ClaudeAgentSdkUserMessage>;
      readonly options: Readonly<Record<string, unknown>>;
    }) => unknown;
    const port: ClaudeAgentSdkPort = {
      query(input) {
        const result = query(input);
        if (
          result === null ||
          typeof result !== "object" ||
          !(Symbol.asyncIterator in result) ||
          typeof (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !==
            "function"
        ) {
          throw new AgentAdapterError(
            "SDK_PACKAGE_INVALID",
            "The pinned Claude Agent SDK query() result is invalid.",
          );
        }
        return result as ClaudeAgentSdkQuery;
      },
    };
    return Object.freeze(port);
  })();
  return await defaultClaudeAgentSdk;
}
