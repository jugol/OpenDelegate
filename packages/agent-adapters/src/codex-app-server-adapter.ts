import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { createProviderToolAuthorizationRequest } from "./action-authorization.ts";
import {
  assertProviderHomeNotInSecretEnvironment,
  prepareControlledProviderHome,
  resolveControlledProviderHome,
} from "./controlled-provider-home.ts";
import {
  type AgentAdapter,
  type AgentAdapterProbe,
  type AgentAdapterProbeInput,
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentStartRequest,
  type AgentSteerRequest,
  type AgentToolServer,
  type AgentUsage,
} from "./contracts.ts";
import { probeCli } from "./cli-probe.ts";
import { AgentAdapterError } from "./errors.ts";
import {
  type ProgrammaticProviderEvent,
  type ProgrammaticProviderResult,
  startProgrammaticTurn,
} from "./programmatic-turn.ts";
import { readBoundedLines, spawnCommand, type SpawnCommand } from "./process-utils.ts";
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

export const CODEX_APP_SERVER_TESTED_VERSIONS = ["0.145.0"] as const;

const CODEX_APP_SERVER_DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "external_agent_memory_import",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "network_proxy",
  "plugin_sharing",
  "request_permissions_tool",
  "skill_mcp_dependency_install",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "workspace_dependencies",
] as const;

const BENIGN_NOTIFICATION_METHODS = new Set([
  "account/rateLimits/updated",
  "account/updated",
  "configWarning",
  "deprecationNotice",
  "item/agentMessage/delta",
  "item/autoApprovalReview/completed",
  "item/autoApprovalReview/started",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "mcpServer/startupStatus/updated",
  "model/rerouted",
  "model/safetyBuffering/updated",
  "model/verification",
  "rawResponse/completed",
  "rawResponseItem/completed",
  "serverRequest/resolved",
  "thread/compacted",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/diff/updated",
  "turn/moderationMetadata",
  "turn/plan/updated",
  "turn/started",
  "warning",
]);

export interface CodexAppServerAdapterOptions {
  readonly codexHome: string;
  readonly executable?: string;
  readonly prefixArgs?: readonly string[];
  readonly testedVersions?: readonly string[];
  readonly allowUntestedVersion?: boolean;
  readonly leaseStore?: SessionLeaseStore;
  readonly now?: () => number;
  readonly lineageId?: () => string;
}

export class CodexAppServerAdapter implements AgentAdapter {
  readonly adapterId = "codex-app-server";
  readonly provider = "codex" as const;
  readonly #codexHome: string;
  readonly #executable: string;
  readonly #prefixArgs: readonly string[];
  readonly #testedVersions: readonly string[];
  readonly #allowUntestedVersion: boolean;
  readonly #leaseStore: SessionLeaseStore;
  readonly #now: () => number;
  readonly #lineageId: () => string;

  public constructor(options: CodexAppServerAdapterOptions) {
    const command =
      options.executable === undefined && options.prefixArgs === undefined
        ? defaultCodexCommand()
        : {
            executable: options.executable ?? "codex",
            prefixArgs: options.prefixArgs ?? [],
          };
    this.#codexHome = resolveControlledProviderHome(options.codexHome, "Codex App Server");
    this.#executable = command.executable;
    this.#prefixArgs = command.prefixArgs;
    this.#testedVersions = options.testedVersions ?? CODEX_APP_SERVER_TESTED_VERSIONS;
    this.#allowUntestedVersion = options.allowUntestedVersion ?? false;
    this.#leaseStore = options.leaseStore ?? processSessionLeaseStore;
    this.#now = options.now ?? Date.now;
    this.#lineageId = options.lineageId ?? randomUUID;
  }

  public async probe(input: AgentAdapterProbeInput = {}): Promise<AgentAdapterProbe> {
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
    try {
      await prepareControlledProviderHome(this.#codexHome, "Codex");
    } catch {
      return {
        contractVersion: 1,
        adapterId: this.adapterId,
        provider: this.provider,
        installed: true,
        compatibility: "incompatible",
        auth: { state: "unknown" },
        capabilities,
        diagnostics: [
          {
            code: "CONTROLLED_PROVIDER_HOME_UNSAFE",
            message: "The OpenDelegate-controlled Codex home is unavailable or unsafe.",
          },
        ],
      };
    }
    return await probeCli({
      adapterId: this.adapterId,
      provider: this.provider,
      providerLabel: "Codex App Server",
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
      parseVersion: parseCodexVersion,
    });
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
    if (request.permissions.mode !== "allow-listed" && request.permissions.mode !== "deny") {
      throw new AgentAdapterError(
        "PERMISSION_MODE_UNSUPPORTED",
        "Codex App Server execution requires deny mode or the OpenDelegate allow-list approval bridge.",
      );
    }
    if (
      request.permissions.mode === "allow-listed" &&
      request.permissions.actionAuthorization === undefined
    ) {
      throw new AgentAdapterError(
        "ACTION_AUTHORIZATION_REQUIRED",
        "Codex App Server execution requires Main's exact-action authorization port.",
      );
    }
    if (request.sandbox === "container" || request.sandbox === "custom") {
      throw new AgentAdapterError(
        "SANDBOX_MODE_UNSUPPORTED",
        "Codex App Server does not expose the requested sandbox mode.",
      );
    }
    const workspace = await canonicalizeWorkspace(request.workspace);
    if (request.operation === "resume") {
      validateResumeReference(request, workspace, this.provider, this.adapterId);
    }
    await prepareControlledProviderHome(this.#codexHome, "Codex");
    const probe = await this.probe({
      ...(request.environment === undefined ? {} : { environment: request.environment }),
      ...(request.secretEnvironment === undefined
        ? {}
        : { secretEnvironment: request.secretEnvironment }),
    });
    requireRunnableProbe(probe, this.#allowUntestedVersion);
    const adapterVersion = probe.version!;
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
          adapterVersion,
          nativeSessionId,
          request,
          workspace,
          lineageId: this.#lineageId,
          now: this.#now,
        }),
      run: async ({ emit, signal }) => {
        try {
          return await this.#runAppServerTurn(
            request,
            workspace.cwd,
            adapterVersion,
            emit,
            signal,
            steering,
          );
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

  async #runAppServerTurn(
    request: AgentStartRequest | AgentResumeRequest,
    cwd: string,
    adapterVersion: string,
    emit: (event: ProgrammaticProviderEvent) => Promise<void>,
    signal: AbortSignal,
    steering: ActiveRunSteeringController,
  ): Promise<ProgrammaticProviderResult> {
    const child = spawnCommand(
      this.#command(
        [
          ...this.#prefixArgs,
          "app-server",
          "--stdio",
          "--strict-config",
          ...CODEX_APP_SERVER_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
        ],
        cwd,
        request.environment,
        request.secretEnvironment,
      ),
    );
    const connection = new CodexJsonlConnection({
      child,
      maxLineBytes: request.limits.maxLineBytes,
      maxDiagnosticBytes: request.limits.maxDiagnosticBytes,
      cancellationGraceMs: request.limits.cancellationGraceMs,
    });
    let threadId: string | undefined;
    let turnId: string | undefined;
    let finalText: string | undefined;
    let usage: AgentUsage | undefined;
    const privateKnowledgeItemIds = new Set<string>();
    let turnResult:
      | {
          readonly status: string;
          readonly error?: string;
        }
      | undefined;
    connection.onServerMessage = async (message) => {
      if (isServerRequest(message)) {
        await handleCodexApprovalRequest({
          message,
          request,
          emit,
          connection,
          signal,
          now: this.#now,
        });
        return;
      }
      if (!isNotification(message)) {
        throw new AgentAdapterError(
          "MALFORMED_PROVIDER_OUTPUT",
          "Codex App Server emitted an invalid JSON-RPC message.",
        );
      }
      if (!BENIGN_NOTIFICATION_METHODS.has(message.method)) {
        throw new AgentAdapterError(
          "UNKNOWN_PROVIDER_MESSAGE",
          `Codex App Server emitted unsupported notification ${message.method}.`,
        );
      }
      if (message.method === "item/agentMessage/delta") {
        const delta = readStringField(message.params, "delta");
        await emit({ kind: "message_delta", text: delta });
        return;
      }
      if (message.method === "item/started") {
        const item = readRecordField(message.params, "item");
        const tool = codexItemTool(item);
        if (tool !== undefined) {
          if (tool.privateInput && typeof item["id"] === "string") {
            privateKnowledgeItemIds.add(item["id"]);
          }
          await emit({
            kind: "tool_request",
            toolName: tool.name,
            ...(tool.privateInput ? {} : { input: tool.input }),
          });
        }
        return;
      }
      if (message.method === "item/completed") {
        const item = readRecordField(message.params, "item");
        if (item["type"] === "agentMessage") {
          finalText = readStringField(item, "text");
          await emit({ kind: "public_message", text: finalText });
          return;
        }
        const tool = codexItemTool(item);
        if (tool !== undefined) {
          await emit({
            kind: "tool_result",
            toolName: tool.name,
            status: codexItemSucceeded(item) ? "succeeded" : "failed",
          });
          if (typeof item["id"] === "string") {
            privateKnowledgeItemIds.delete(item["id"]);
          }
        }
        return;
      }
      if (message.method === "item/mcpToolCall/progress") {
        const itemId =
          isRecord(message.params) && typeof message.params["itemId"] === "string"
            ? message.params["itemId"]
            : undefined;
        await emit({
          kind: "progress",
          message:
            itemId !== undefined && privateKnowledgeItemIds.has(itemId)
              ? "Device-local Knowledge operation is in progress."
              : readStringField(message.params, "message"),
        });
        return;
      }
      if (message.method === "thread/tokenUsage/updated") {
        usage = parseCodexUsage(message.params) ?? usage;
        if (usage !== undefined) {
          await emit({ kind: "usage", usage });
        }
        return;
      }
      if (message.method === "warning" || message.method === "configWarning") {
        await emit({
          kind: "diagnostic",
          level: "warning",
          code: message.method === "warning" ? "CODEX_WARNING" : "CODEX_CONFIG_WARNING",
          message: presentationMessage(message.params),
        });
        return;
      }
      if (message.method === "turn/started") {
        const notificationThreadId = readStringField(message.params, "threadId");
        const turn = readRecordField(message.params, "turn");
        turnId = readStringField(turn, "id");
        if (threadId === undefined || notificationThreadId !== threadId) {
          throw new AgentAdapterError(
            "NATIVE_SESSION_ID_CHANGED",
            "Codex App Server started the turn on a different native thread.",
          );
        }
        const activeTurnId = turnId;
        steering.activate({
          nativeSessionId: threadId,
          send: async (steerRequest) => {
            const response = await connection.request("turn/steer", {
              threadId,
              expectedTurnId: activeTurnId,
              input: [
                {
                  type: "text",
                  text: steerRequest.instruction,
                  text_elements: [],
                },
              ],
              clientUserMessageId: steerRequest.requestId,
            });
            const responseTurnId = readStringField(response, "turnId");
            if (responseTurnId !== activeTurnId) {
              throw new AgentAdapterError(
                "STEERING_PROVIDER_TURN_MISMATCH",
                "Codex App Server accepted steering for a different provider turn.",
              );
            }
            await emit({
              kind: "steering_accepted",
              requestId: steerRequest.requestId,
              requestedBy: steerRequest.requestedBy,
            });
            return { providerTurnId: responseTurnId };
          },
        });
        return;
      }
      if (message.method === "turn/completed") {
        const notificationThreadId = readStringField(message.params, "threadId");
        const turn = readRecordField(message.params, "turn");
        turnId = readStringField(turn, "id");
        if (threadId === undefined || notificationThreadId !== threadId) {
          throw new AgentAdapterError(
            "NATIVE_SESSION_ID_CHANGED",
            "Codex App Server completed the turn on a different native thread.",
          );
        }
        steering.complete();
        turnResult = {
          status: readStringField(turn, "status"),
          ...(isRecord(turn["error"]) && typeof turn["error"]["message"] === "string"
            ? { error: turn["error"]["message"] }
            : {}),
        };
      }
    };

    const onAbort = (): void => {
      if (threadId !== undefined && turnId !== undefined) {
        void connection.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      }
      connection.stopAfterGrace();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await connection.start();
      await connection.request("initialize", {
        clientInfo: {
          name: "opendelegate",
          title: "OpenDelegate",
          version: adapterVersion,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      });
      connection.notify("initialized", {});
      const threadResponse = await connection.request(
        request.operation === "start" ? "thread/start" : "thread/resume",
        request.operation === "start"
          ? codexThreadParameters(request, cwd)
          : {
              threadId: request.session.nativeSessionId,
              ...codexThreadParameters(request, cwd),
            },
      );
      const thread = readRecordField(threadResponse, "thread");
      threadId = readStringField(thread, "id");
      await emit({ kind: "session", nativeSessionId: threadId });
      await connection.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      });
      while (turnResult === undefined) {
        await connection.nextMessage();
      }
      if (turnResult.status === "completed") {
        return {
          status: "succeeded",
          nativeSessionId: threadId,
          ...(finalText === undefined ? {} : { finalText }),
          ...(usage === undefined ? {} : { usage }),
        };
      }
      return {
        status: "failed",
        nativeSessionId: threadId,
        ...(finalText === undefined ? {} : { finalText }),
        ...(usage === undefined ? {} : { usage }),
        error: {
          code:
            turnResult.status === "interrupted" ? "CODEX_TURN_INTERRUPTED" : "CODEX_TURN_FAILED",
          message: turnResult.error ?? "Codex App Server did not complete the turn.",
          retryable: turnResult.status === "interrupted",
        },
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      await connection.close();
    }
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
        ...(environment ?? {}),
        CODEX_HOME: this.#codexHome,
        NO_COLOR: "1",
      },
      ...(secretEnvironment === undefined ? {} : { secretEnvironment }),
    };
  }
}

interface JsonRpcMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface CodexJsonlConnectionOptions {
  readonly child: ReturnType<typeof spawnCommand>;
  readonly maxLineBytes: number;
  readonly maxDiagnosticBytes: number;
  readonly cancellationGraceMs: number;
}

class CodexJsonlConnection {
  public onServerMessage: (message: JsonRpcMessage) => Promise<void> = async () => undefined;
  readonly #options: CodexJsonlConnectionOptions;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  #nextRequestId = 1;
  #reader: AsyncIterator<string> | undefined;
  #diagnosticPromise: Promise<void> | undefined;
  #readTail: Promise<void> = Promise.resolve();
  #closed = false;
  #forceTimer: NodeJS.Timeout | undefined;

  public constructor(options: CodexJsonlConnectionOptions) {
    this.#options = options;
  }

  public async start(): Promise<void> {
    if (this.#reader !== undefined) {
      throw new AgentAdapterError(
        "PROVIDER_PROTOCOL_STATE_INVALID",
        "Codex App Server connection was started more than once.",
      );
    }
    this.#reader = readBoundedLines(this.#options.child.stdout, this.#options.maxLineBytes)[
      Symbol.asyncIterator
    ]();
    this.#diagnosticPromise = drainBounded(
      this.#options.child.stderr,
      this.#options.maxDiagnosticBytes,
    );
  }

  public request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#write({ method, id, params });
    void this.#pumpUntil(() => !this.#pending.has(id)).catch((error) => {
      this.#pending.get(id)?.reject(error);
      this.#pending.delete(id);
    });
    return result;
  }

  public notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  public async nextMessage(): Promise<void> {
    await this.#readOne();
  }

  public respond(id: string | number, result: unknown): void {
    this.#write({ id, result });
  }

  public respondError(id: string | number, code: number, message: string): void {
    this.#write({ id, error: { code, message } });
  }

  public stopAfterGrace(): void {
    if (this.#closed || this.#forceTimer !== undefined) {
      return;
    }
    this.#forceTimer = setTimeout(() => {
      if (this.#options.child.exitCode === null && this.#options.child.signalCode === null) {
        this.#options.child.kill();
      }
    }, this.#options.cancellationGraceMs);
    this.#forceTimer.unref();
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#forceTimer !== undefined) {
      clearTimeout(this.#forceTimer);
    }
    for (const pending of this.#pending.values()) {
      pending.reject(
        new AgentAdapterError(
          "PROVIDER_CONNECTION_CLOSED",
          "Codex App Server connection closed before its response.",
          true,
        ),
      );
    }
    this.#pending.clear();
    this.#options.child.stdin.end();
    if (this.#options.child.exitCode === null && this.#options.child.signalCode === null) {
      this.#options.child.kill();
    }
    await Promise.allSettled([
      waitForChild(this.#options.child),
      this.#diagnosticPromise ?? Promise.resolve(),
    ]);
  }

  async #pumpUntil(done: () => boolean): Promise<void> {
    while (!done()) {
      await this.#readOne();
    }
  }

  async #readOne(): Promise<void> {
    const read = this.#readTail.then(async () => {
      await this.#readOneSerialized();
    });
    this.#readTail = read.catch(() => undefined);
    await read;
  }

  async #readOneSerialized(): Promise<void> {
    const next = await this.#reader?.next();
    if (next === undefined || next.done) {
      throw new AgentAdapterError(
        "PROVIDER_CONNECTION_CLOSED",
        "Codex App Server closed its protocol stream unexpectedly.",
        true,
      );
    }
    let message: unknown;
    try {
      message = JSON.parse(next.value);
    } catch {
      throw new AgentAdapterError(
        "MALFORMED_PROVIDER_OUTPUT",
        "Codex App Server emitted invalid JSONL.",
      );
    }
    if (!isRecord(message)) {
      throw new AgentAdapterError(
        "MALFORMED_PROVIDER_OUTPUT",
        "Codex App Server emitted a non-object JSON-RPC message.",
      );
    }
    const rpc = message as JsonRpcMessage;
    if (rpc.id !== undefined && rpc.method === undefined) {
      if (typeof rpc.id !== "number") {
        throw new AgentAdapterError(
          "MALFORMED_PROVIDER_OUTPUT",
          "Codex App Server response ID was invalid.",
        );
      }
      const pending = this.#pending.get(rpc.id);
      if (pending === undefined) {
        throw new AgentAdapterError(
          "UNKNOWN_PROVIDER_MESSAGE",
          "Codex App Server returned an unknown response ID.",
        );
      }
      this.#pending.delete(rpc.id);
      if (rpc.error !== undefined) {
        pending.reject(
          new AgentAdapterError(
            "PROVIDER_REQUEST_FAILED",
            "Codex App Server rejected a protocol request.",
            true,
          ),
        );
      } else {
        pending.resolve(rpc.result);
      }
      return;
    }
    await this.onServerMessage(rpc);
  }

  #write(message: unknown): void {
    if (this.#closed || !this.#options.child.stdin.writable) {
      throw new AgentAdapterError(
        "PROVIDER_CONNECTION_CLOSED",
        "Codex App Server protocol input is unavailable.",
        true,
      );
    }
    this.#options.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }
}

async function handleCodexApprovalRequest(input: {
  readonly message: JsonRpcMessage;
  readonly request: AgentStartRequest | AgentResumeRequest;
  readonly emit: (event: ProgrammaticProviderEvent) => Promise<void>;
  readonly connection: CodexJsonlConnection;
  readonly signal: AbortSignal;
  readonly now: () => number;
}): Promise<void> {
  const id = input.message.id;
  const method = input.message.method;
  if (id === undefined || method === undefined) {
    throw new AgentAdapterError(
      "MALFORMED_PROVIDER_OUTPUT",
      "Codex App Server approval request was incomplete.",
    );
  }
  if (
    method !== "item/commandExecution/requestApproval" &&
    method !== "item/fileChange/requestApproval" &&
    method !== "item/permissions/requestApproval"
  ) {
    input.connection.respondError(id, -32_604, "OpenDelegate does not expose this callback.");
    throw new AgentAdapterError(
      "UNKNOWN_PROVIDER_REQUEST",
      `Codex App Server requested unsupported callback ${method}.`,
    );
  }
  const params = requireRecord(input.message.params);
  const itemId = readStringField(params, "itemId");
  const toolName =
    method === "item/commandExecution/requestApproval"
      ? "shell"
      : method === "item/fileChange/requestApproval"
        ? "file-change"
        : "permission-profile";
  const exactInput =
    method === "item/commandExecution/requestApproval"
      ? {
          command: typeof params["command"] === "string" ? params["command"] : "unknown-command",
          cwd: typeof params["cwd"] === "string" ? params["cwd"] : null,
          reason: typeof params["reason"] === "string" ? params["reason"] : null,
          networkApprovalContext: params["networkApprovalContext"] ?? null,
        }
      : method === "item/fileChange/requestApproval"
        ? {
            reason: typeof params["reason"] === "string" ? params["reason"] : null,
            grantRoot: typeof params["grantRoot"] === "string" ? params["grantRoot"] : null,
          }
        : { permissions: params["permissions"] ?? null, cwd: params["cwd"] ?? null };
  if (input.request.permissions.mode === "deny") {
    if (method === "item/permissions/requestApproval") {
      input.connection.respond(id, {
        permissions: {},
        scope: "turn",
        strictAutoReview: true,
      });
    } else {
      input.connection.respond(id, { decision: "decline" });
    }
    return;
  }
  const authorization = createProviderToolAuthorizationRequest({
    provider: "codex",
    runId: input.request.runId,
    toolName,
    toolUseId:
      typeof params["approvalId"] === "string" ? `${itemId}:${params["approvalId"]}` : itemId,
    input: exactInput,
    requestedAtMs: input.now(),
    signal: input.signal,
    ...(typeof params["reason"] === "string" ? { decisionReason: params["reason"] } : {}),
    ...(typeof params["cwd"] === "string" ? { blockedPath: params["cwd"] } : {}),
    ...(method === "item/permissions/requestApproval"
      ? { categoryHint: "sandbox-boundary-escalation" }
      : {}),
  });
  await input.emit({
    kind: "approval_request",
    requestId: authorization.authorizationRequestId,
    actionType: authorization.actionType,
    summary: approvalSummary(authorization.actionCategory, toolName),
    scope: {
      actionFingerprint: authorization.actionFingerprint,
      actionCategory: authorization.actionCategory,
    },
  });
  const decision =
    await input.request.permissions.actionAuthorization!.authorizeAndConsume(authorization);
  if (method === "item/permissions/requestApproval") {
    const requested = isRecord(params["permissions"]) ? params["permissions"] : {};
    const granted =
      decision.decision === "allow"
        ? {
            ...(isRecord(requested["network"]) ? { network: requested["network"] } : {}),
            ...(isRecord(requested["fileSystem"]) ? { fileSystem: requested["fileSystem"] } : {}),
          }
        : {};
    input.connection.respond(id, {
      permissions: granted,
      scope: "turn",
      strictAutoReview: true,
    });
    return;
  }
  input.connection.respond(id, {
    decision: decision.decision === "allow" ? "accept" : "decline",
  });
}

function codexThreadParameters(
  request: AgentStartRequest | AgentResumeRequest,
  cwd: string,
): Readonly<Record<string, unknown>> {
  return {
    cwd,
    approvalPolicy: request.permissions.mode === "deny" ? "never" : "on-request",
    approvalsReviewer: "user",
    sandbox: request.sandbox === "provider-default" ? "read-only" : request.sandbox,
    ephemeral: false,
    config: {
      mcp_servers: codexMcpServers(request.toolServers),
    },
  };
}

function codexMcpServers(
  servers: readonly AgentToolServer[] | undefined,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    (servers ?? []).map((server) => [
      server.serverName,
      {
        command: server.command,
        args: [...server.args],
        enabled_tools: [...server.enabledTools],
        startup_timeout_sec: Math.ceil(server.startupTimeoutMs / 1_000),
        tool_timeout_sec: Math.ceil(server.toolTimeoutMs / 1_000),
        required: true,
      },
    ]),
  );
}

function codexItemTool(item: Readonly<Record<string, unknown>>):
  | {
      readonly name: string;
      readonly input: unknown;
      readonly privateInput: boolean;
    }
  | undefined {
  const type = item["type"];
  if (type === "commandExecution") {
    return {
      name: "shell",
      input: {
        command: typeof item["command"] === "string" ? item["command"] : "",
        cwd: typeof item["cwd"] === "string" ? item["cwd"] : "",
      },
      privateInput: false,
    };
  }
  if (type === "fileChange") {
    return {
      name: "file-change",
      input: { changeCount: Array.isArray(item["changes"]) ? item["changes"].length : 0 },
      privateInput: false,
    };
  }
  if (type === "mcpToolCall") {
    const server = typeof item["server"] === "string" ? item["server"] : "mcp";
    const tool = typeof item["tool"] === "string" ? item["tool"] : "tool";
    const name = `mcp__${server}__${tool}`;
    return {
      name,
      input: item["arguments"] ?? {},
      privateInput: /(?:^|[_:.-])knowledge(?:[_:.-]|$)/iu.test(name),
    };
  }
  if (type === "dynamicToolCall") {
    return {
      name: typeof item["tool"] === "string" ? item["tool"] : "dynamic-tool",
      input: item["arguments"] ?? {},
      privateInput: false,
    };
  }
  return undefined;
}

function codexItemSucceeded(item: Readonly<Record<string, unknown>>): boolean {
  const status = item["status"];
  if (typeof item["success"] === "boolean") {
    return item["success"];
  }
  return (
    status === "completed" ||
    status === "success" ||
    status === "succeeded" ||
    (item["type"] === "commandExecution" && item["exitCode"] === 0)
  );
}

function parseCodexUsage(params: unknown): AgentUsage | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const usage =
    (isRecord(params["tokenUsage"]) && params["tokenUsage"]) ||
    (isRecord(params["usage"]) && params["usage"]);
  if (!usage) {
    return undefined;
  }
  const inputTokens = nonNegativeNumber(
    usage["inputTokens"] ?? usage["input_tokens"] ?? usage["totalInputTokens"],
  );
  const outputTokens = nonNegativeNumber(
    usage["outputTokens"] ?? usage["output_tokens"] ?? usage["totalOutputTokens"],
  );
  const cachedInputTokens = nonNegativeNumber(
    usage["cachedInputTokens"] ?? usage["cached_input_tokens"],
  );
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function presentationMessage(params: unknown): string {
  if (isRecord(params)) {
    for (const field of ["message", "text", "warning"]) {
      if (typeof params[field] === "string") {
        return params[field];
      }
    }
  }
  return "Codex App Server reported a warning.";
}

function approvalSummary(category: string, toolName: string): string {
  return `${toolName} requests ${category.replaceAll("-", " ")} authorization.`;
}

function isServerRequest(
  message: JsonRpcMessage,
): message is JsonRpcMessage & { readonly id: string | number; readonly method: string } {
  return message.id !== undefined && typeof message.method === "string";
}

function isNotification(
  message: JsonRpcMessage,
): message is JsonRpcMessage & { readonly method: string } {
  return message.id === undefined && typeof message.method === "string";
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new AgentAdapterError(
      "MALFORMED_PROVIDER_OUTPUT",
      "Codex App Server protocol fields were invalid.",
    );
  }
  return value;
}

function readRecordField(value: unknown, field: string): Readonly<Record<string, unknown>> {
  const record = requireRecord(value);
  return requireRecord(record[field]);
}

function readStringField(value: unknown, field: string): string {
  const record = requireRecord(value);
  const result = record[field];
  if (typeof result !== "string" || result.length === 0 || result.includes("\0")) {
    throw new AgentAdapterError(
      "MALFORMED_PROVIDER_OUTPUT",
      `Codex App Server field ${field} was invalid.`,
    );
  }
  return result;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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

function requireRunnableProbe(probe: AgentAdapterProbe, allowUntestedVersion: boolean): void {
  if (!probe.installed) {
    throw new AgentAdapterError("ADAPTER_UNAVAILABLE", "Codex App Server is unavailable.", true);
  }
  if (probe.auth.state !== "ready") {
    throw new AgentAdapterError(
      "ADAPTER_AUTH_NOT_READY",
      "Codex authentication is not ready in the OpenDelegate-controlled home.",
      true,
    );
  }
  if (probe.version === undefined || (probe.compatibility !== "tested" && !allowUntestedVersion)) {
    throw new AgentAdapterError(
      "ADAPTER_VERSION_UNSUPPORTED",
      "Codex App Server version has not passed the configured compatibility policy.",
    );
  }
}

async function drainBounded(stream: NodeJS.ReadableStream, maxBytes: number): Promise<void> {
  let read = 0;
  for await (const value of stream) {
    const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value), "utf8");
    read = Math.min(maxBytes, read + bytes);
  }
}

async function waitForChild(child: ReturnType<typeof spawnCommand>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolveChild) => {
    child.once("close", () => resolveChild());
    child.once("error", () => resolveChild());
  });
}

function defaultCodexCommand(): {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
} {
  if (process.platform === "win32") {
    const pathEntries = (process.env.PATH ?? "")
      .split(delimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
      .filter((entry) => entry.length > 0);
    for (const directory of pathEntries) {
      const entrypoint = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      try {
        if (statSync(entrypoint).isFile()) {
          return {
            executable: process.execPath,
            prefixArgs: [realpathSync(entrypoint)],
          };
        }
      } catch {
        // Continue to the next PATH entry.
      }
    }
  }
  return { executable: "codex", prefixArgs: [] };
}
