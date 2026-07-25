import { createHash } from "node:crypto";

import {
  AgentAdapterError,
  type AgentAdapter,
  type AgentPermissionInput,
  type AgentRunHandle,
  type AgentRunLimits,
  type AgentSandbox,
  type NativeSessionReference,
  type WorkspaceBinding,
} from "@opendelegate/agent-adapters";
import {
  ConfigurationAgentPortError,
  type ConfigurationAgentMessageInput,
  type ConfigurationAgentPort,
} from "@opendelegate/control-plane";
import {
  ConfigurationError,
  type ConfigurationChange,
  type ConfigurationContext,
  type ConfigurationMutationAuthorizer,
  type ConfigurationScope,
  type ConfigurationService,
  type ConfigurationToolReceipt,
  type ConfigurationToolRequest,
} from "@opendelegate/configuration";
import type { ManagedSecretStore } from "@opendelegate/secrets";

import type {
  MainNativeSessionRepository,
  NativeSessionEventStore,
} from "./agent-task-executor.ts";

type ConfigurationAgentMessageResponse = Awaited<ReturnType<ConfigurationAgentPort["sendMessage"]>>;

interface ConfigurationResponseEventPayload {
  readonly schemaVersion: 1;
  readonly requestDigest: string;
  readonly response: ConfigurationAgentMessageResponse;
}

export interface AgentBackedConfigurationAgentClock {
  now(): string;
}

export interface ConfigurationAgentToolBrokerInput {
  readonly operationId: string;
  readonly principalId: string;
  readonly targetDeviceId: string;
  readonly request: ConfigurationToolRequest;
}

export interface ConfigurationAgentToolBroker {
  execute(input: ConfigurationAgentToolBrokerInput): Promise<ConfigurationToolReceipt>;
}

export interface ConfigurationApprovalRequestInput {
  readonly operationId: string;
  readonly principalId: string;
  readonly targetDeviceId: string;
  readonly expectedRevision: number;
  readonly proposalId: string;
  readonly authorization: Parameters<ConfigurationMutationAuthorizer>[0];
}

export interface ConfigurationApprovalRequester {
  request(input: ConfigurationApprovalRequestInput): Promise<{
    readonly approvalId: string;
  }>;
}

export interface ConfigurationServiceAgentToolBrokerOptions {
  readonly service: ConfigurationService;
  readonly contextForDevice: (
    targetDeviceId: string,
  ) => ConfigurationContext | Promise<ConfigurationContext>;
  readonly authorizeMutation: ConfigurationMutationAuthorizer;
  readonly approvalRequester?: ConfigurationApprovalRequester;
}

export class ConfigurationAgentToolBrokerError extends Error {
  readonly code:
    | "CONFIGURATION_TOOL_REJECTED"
    | "CONFIGURATION_TOOL_APPROVAL_REQUIRED"
    | "CONFIGURATION_TOOL_DENIED"
    | "CONFIGURATION_TOOL_UNAVAILABLE";
  readonly detailCode: string | undefined;
  readonly approvalId: string | undefined;

  constructor(
    code:
      | "CONFIGURATION_TOOL_REJECTED"
      | "CONFIGURATION_TOOL_APPROVAL_REQUIRED"
      | "CONFIGURATION_TOOL_DENIED"
      | "CONFIGURATION_TOOL_UNAVAILABLE",
    message: string,
    detailCode?: string,
    approvalId?: string,
  ) {
    super(message);
    this.name = "ConfigurationAgentToolBrokerError";
    this.code = code;
    this.detailCode = detailCode;
    this.approvalId = approvalId;
  }
}

export class ConfigurationServiceAgentToolBroker implements ConfigurationAgentToolBroker {
  readonly #service: ConfigurationService;
  readonly #contextForDevice: ConfigurationServiceAgentToolBrokerOptions["contextForDevice"];
  readonly #authorizeMutation: ConfigurationMutationAuthorizer;
  readonly #approvalRequester: ConfigurationApprovalRequester | undefined;

  constructor(options: ConfigurationServiceAgentToolBrokerOptions) {
    if (
      options.service === null ||
      typeof options.service !== "object" ||
      typeof options.service.executeTool !== "function" ||
      typeof options.contextForDevice !== "function" ||
      typeof options.authorizeMutation !== "function"
    ) {
      throw new TypeError("A valid Configuration Service tool broker configuration is required.");
    }
    this.#service = options.service;
    this.#contextForDevice = options.contextForDevice;
    this.#authorizeMutation = options.authorizeMutation;
    this.#approvalRequester = options.approvalRequester;
  }

  async execute(input: ConfigurationAgentToolBrokerInput): Promise<ConfigurationToolReceipt> {
    let context: ConfigurationContext;
    try {
      context = structuredClone(await this.#contextForDevice(input.targetDeviceId));
    } catch {
      throw new ConfigurationAgentToolBrokerError(
        "CONFIGURATION_TOOL_UNAVAILABLE",
        "The target Device configuration context is unavailable.",
      );
    }
    if (
      context === null ||
      typeof context !== "object" ||
      Array.isArray(context) ||
      context.deviceId !== input.targetDeviceId
    ) {
      throw new ConfigurationAgentToolBrokerError(
        "CONFIGURATION_TOOL_UNAVAILABLE",
        "The target Device configuration context is invalid.",
      );
    }
    let protectedMutation: Parameters<ConfigurationMutationAuthorizer>[0] | undefined;
    try {
      return await this.#service.executeTool({
        operationId: input.operationId,
        actor: input.principalId,
        context,
        request: structuredClone(input.request),
        authorizeMutation: (authorizationInput) => {
          const authorization = this.#authorizeMutation(authorizationInput);
          if (authorization.decision === "require-approval") {
            protectedMutation = structuredClone(authorizationInput);
          }
          return authorization;
        },
      });
    } catch (error) {
      if (!(error instanceof ConfigurationError)) {
        throw new ConfigurationAgentToolBrokerError(
          "CONFIGURATION_TOOL_UNAVAILABLE",
          "The deterministic configuration service is unavailable.",
        );
      }
      if (error.code === "mutation-denied") {
        throw new ConfigurationAgentToolBrokerError(
          "CONFIGURATION_TOOL_DENIED",
          "Executable policy denied the configuration mutation.",
          error.code,
        );
      }
      if (error.code === "mutation-requires-approval") {
        let approvalId: string | undefined;
        if (
          this.#approvalRequester !== undefined &&
          input.request.tool === "apply" &&
          protectedMutation !== undefined
        ) {
          try {
            approvalId = (
              await this.#approvalRequester.request({
                operationId: input.operationId,
                principalId: input.principalId,
                targetDeviceId: input.targetDeviceId,
                expectedRevision: input.request.expectedRevision,
                proposalId: input.request.proposalId,
                authorization: protectedMutation,
              })
            ).approvalId;
          } catch {
            throw new ConfigurationAgentToolBrokerError(
              "CONFIGURATION_TOOL_UNAVAILABLE",
              "The durable owner Approval request could not be created.",
            );
          }
        }
        throw new ConfigurationAgentToolBrokerError(
          "CONFIGURATION_TOOL_APPROVAL_REQUIRED",
          "The configuration mutation requires owner approval.",
          error.code,
          approvalId,
        );
      }
      if (error.code === "mutation-authorization-unavailable") {
        throw new ConfigurationAgentToolBrokerError(
          "CONFIGURATION_TOOL_UNAVAILABLE",
          "Executable configuration policy is unavailable.",
          error.code,
        );
      }
      throw new ConfigurationAgentToolBrokerError(
        "CONFIGURATION_TOOL_REJECTED",
        "The deterministic configuration service rejected the typed request.",
        error.code,
      );
    }
  }
}

export interface AgentBackedConfigurationAgentOptions {
  readonly adapter: AgentAdapter;
  readonly sessionRepository: MainNativeSessionRepository;
  readonly eventStore: NativeSessionEventStore;
  readonly mainDeviceId: string;
  readonly workspace: WorkspaceBinding;
  readonly sandbox: AgentSandbox;
  readonly permissions: AgentPermissionInput;
  readonly limits: AgentRunLimits;
  readonly toolBroker: ConfigurationAgentToolBroker;
  readonly clock?: AgentBackedConfigurationAgentClock;
  readonly maximumPromptBytes?: number;
  readonly maximumToolTurns?: number;
  readonly secretLeakGuard?: ConfigurationAgentSecretLeakGuardPort;
}

export interface ConfigurationAgentSecretLeakGuardPort {
  containsManagedSecret(message: string): Promise<boolean>;
}

export class ManagedSecretExactMatchGuard implements ConfigurationAgentSecretLeakGuardPort {
  readonly #secretStore: ManagedSecretStore;
  readonly #aliases: () => readonly string[];

  public constructor(input: {
    readonly secretStore: ManagedSecretStore;
    readonly aliases: () => readonly string[];
  }) {
    if (
      input.secretStore === null ||
      typeof input.secretStore !== "object" ||
      typeof input.secretStore.executeWithSecretBytes !== "function" ||
      typeof input.aliases !== "function"
    ) {
      throw new TypeError("A managed Secret Store and alias registry are required.");
    }
    this.#secretStore = input.secretStore;
    this.#aliases = input.aliases;
  }

  public async containsManagedSecret(message: string): Promise<boolean> {
    const input = Buffer.from(message, "utf8");
    try {
      const aliases = [...new Set(this.#aliases())].sort();
      for (const alias of aliases) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(alias)) {
          throw new TypeError("The managed Secret alias registry is invalid.");
        }
        const availability = await this.#secretStore.availability(alias).catch(() => undefined);
        if (availability?.ready !== true || availability.alias !== alias) {
          continue;
        }
        let matched = false;
        await this.#secretStore.executeWithSecretBytes(alias, (secret) => {
          const material = Buffer.from(secret);
          try {
            matched =
              material.byteLength > 0 &&
              material.byteLength <= input.byteLength &&
              input.indexOf(material) !== -1;
          } finally {
            material.fill(0);
          }
        });
        if (matched) {
          return true;
        }
      }
      return false;
    } finally {
      input.fill(0);
    }
  }
}

interface ActiveRequest {
  readonly requestDigest: string;
  readonly result: Promise<ConfigurationAgentMessageResponse>;
}

type ConfigurationAgentTurnResult =
  | {
      readonly schemaVersion: 1;
      readonly type: "tool";
      readonly toolCallId: string;
      readonly request: ConfigurationToolRequest;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "final";
      readonly content: string;
      readonly claimReceiptIds: readonly string[];
    };

type ConfigurationAgentToolTurnResult =
  | {
      readonly schemaVersion: 1;
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly tool: ConfigurationToolRequest["tool"];
      readonly status: "succeeded";
      readonly receipt: ConfigurationToolReceipt;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly tool: ConfigurationToolRequest["tool"];
      readonly status: "failed";
      readonly error: {
        readonly code: ConfigurationAgentToolBrokerError["code"];
        readonly detailCode?: string;
        readonly approvalId?: string;
      };
    };

const DEFAULT_MAXIMUM_PROMPT_BYTES = 64 * 1024;
const DEFAULT_MAXIMUM_TOOL_TURNS = 8;
const CONFIGURATION_RESPONSE_EVENT = "configuration-agent.response-recorded";
const DATABASE_URI_MATERIAL =
  /\b(?:amqps?|mariadb|mongodb(?:\+srv)?|mysql|postgres(?:ql)?|rediss?):\/\/[^\s<>"']+/iu;
const USERINFO_URI_MATERIAL = /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/:@]+:[^\s/@]+@[^\s<>"']+/iu;
const PEM_MATERIAL =
  /-----BEGIN (?:[A-Z0-9 ]{0,48})?(?:PRIVATE KEY|CERTIFICATE|PGP PRIVATE KEY BLOCK)-----/u;
const NAMED_SECRET_MATERIAL =
  /(?:^|[\s{,;"'])(?:api[-_ ]?key|authorization|bearer|credential|grant(?:[-_ ]?token)?|password|passwd|private[-_ ]?key|secret|token)["']?\s*(?::|=)\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s,;}]{8,})/iu;
const WELL_KNOWN_TOKEN_MATERIAL =
  /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/u;
const DISCORD_TOKEN_MATERIAL = /\b[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,110}\b/u;
const AWS_ACCESS_KEY_MATERIAL = /\b(?:AIDA|AIPA|AKIA|ANPA|ANVA|AROA|ASIA)[A-Z0-9]{16}\b/u;
const GOOGLE_API_KEY_MATERIAL = /\bAIza[A-Za-z0-9_-]{30,}\b/u;
const SAFE_OPAQUE_REFERENCE =
  /(?:secret:\/\/main\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}|sha256:[a-f0-9]{64})/giu;
const OPAQUE_TOKEN_CANDIDATE = /\b[A-Za-z0-9_-]{40,256}\b/gu;

/**
 * Maintains one native Agent conversation per target Device while making each
 * public HTTP mutation durably idempotent.
 *
 * This port is deliberately advisory. It never applies configuration directly.
 * Configuration changes become real only through separately authorized,
 * deterministic OpenDelegate tools.
 */
export class AgentBackedConfigurationAgent implements ConfigurationAgentPort {
  readonly #adapter: AgentAdapter;
  readonly #sessionRepository: MainNativeSessionRepository;
  readonly #eventStore: NativeSessionEventStore;
  readonly #mainDeviceId: string;
  readonly #workspace: WorkspaceBinding;
  readonly #sandbox: AgentSandbox;
  readonly #permissions: AgentPermissionInput;
  readonly #limits: AgentRunLimits;
  readonly #toolBroker: ConfigurationAgentToolBroker;
  readonly #clock: AgentBackedConfigurationAgentClock;
  readonly #maximumPromptBytes: number;
  readonly #maximumToolTurns: number;
  readonly #secretLeakGuard: ConfigurationAgentSecretLeakGuardPort | undefined;
  readonly #activeRequests = new Map<string, ActiveRequest>();
  readonly #deviceTails = new Map<string, Promise<void>>();

  constructor(options: AgentBackedConfigurationAgentOptions) {
    assertAdapter(options.adapter);
    assertRepository(options.sessionRepository);
    assertEventStore(options.eventStore);
    assertIdentifier(options.mainDeviceId, "Main Device ID", 160);
    assertWorkspace(options.workspace);
    assertExecutionOptions(options.sandbox, options.permissions, options.limits);
    assertToolBroker(options.toolBroker);
    const maximumPromptBytes = options.maximumPromptBytes ?? DEFAULT_MAXIMUM_PROMPT_BYTES;
    if (!Number.isSafeInteger(maximumPromptBytes) || maximumPromptBytes < 4_096) {
      throw new TypeError("maximumPromptBytes must be a safe integer of at least 4096.");
    }
    const maximumToolTurns = options.maximumToolTurns ?? DEFAULT_MAXIMUM_TOOL_TURNS;
    if (!Number.isSafeInteger(maximumToolTurns) || maximumToolTurns < 1 || maximumToolTurns > 32) {
      throw new TypeError("maximumToolTurns must be a safe integer between 1 and 32.");
    }

    this.#adapter = options.adapter;
    this.#sessionRepository = options.sessionRepository;
    this.#eventStore = options.eventStore;
    this.#mainDeviceId = options.mainDeviceId;
    this.#workspace = structuredClone(options.workspace);
    this.#sandbox = options.sandbox;
    this.#permissions = structuredClone(options.permissions);
    this.#limits = { ...options.limits };
    this.#toolBroker = options.toolBroker;
    this.#clock = options.clock ?? { now: () => new Date().toISOString() };
    this.#maximumPromptBytes = maximumPromptBytes;
    this.#maximumToolTurns = maximumToolTurns;
    this.#secretLeakGuard = options.secretLeakGuard;
  }

  async sendMessage(
    input: ConfigurationAgentMessageInput,
  ): Promise<ConfigurationAgentMessageResponse> {
    const request = validateInput(input);
    if (await this.#secretLeakGuard?.containsManagedSecret(request.message)) {
      throw secretMaterialRequiresSecureIngest();
    }
    if (containsRawSecretMaterial(request.message)) {
      throw secretMaterialRequiresSecureIngest();
    }
    const operationKey = digest(
      `${request.principalId}\u0000${request.deviceId}\u0000${request.idempotencyKey}`,
    );
    const requestDigest = digest(request.message);
    const active = this.#activeRequests.get(operationKey);
    if (active !== undefined) {
      if (active.requestDigest !== requestDigest) {
        throw idempotencyConflict();
      }
      return active.result;
    }

    const result = this.#enqueue(request.deviceId, async () => {
      const stored = await this.#loadStoredResponse(operationKey, requestDigest);
      if (stored !== undefined) {
        return stored;
      }
      return this.#runAndRecord(request, operationKey, requestDigest);
    });
    this.#activeRequests.set(operationKey, { requestDigest, result });
    const cleanup = (): void => {
      if (this.#activeRequests.get(operationKey)?.result === result) {
        this.#activeRequests.delete(operationKey);
      }
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  #enqueue<TResult>(deviceId: string, operation: () => Promise<TResult>): Promise<TResult> {
    const previous = this.#deviceTails.get(deviceId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#deviceTails.set(deviceId, tail);
    void tail.finally(() => {
      if (this.#deviceTails.get(deviceId) === tail) {
        this.#deviceTails.delete(deviceId);
      }
    });
    return result;
  }

  async #runAndRecord(
    input: ConfigurationAgentMessageInput,
    operationKey: string,
    requestDigest: string,
  ): Promise<ConfigurationAgentMessageResponse> {
    const sessionKey = configurationSessionKey(input.deviceId, this.#adapter.adapterId);
    let session: NativeSessionReference | undefined;
    try {
      session = await this.#sessionRepository.load(sessionKey);
      if (session !== undefined) {
        assertSessionBinding(session, {
          adapter: this.#adapter,
          mainDeviceId: this.#mainDeviceId,
          targetDeviceId: input.deviceId,
          workspace: this.#workspace,
          sessionKey,
        });
      }
    } catch (error) {
      if (error instanceof ConfigurationAgentPortError) {
        throw error;
      }
      throw unavailable("The Configuration Agent session state could not be read safely.");
    }

    const baseRunId = `configuration_${operationKey.slice("sha256:".length)}`;
    let prompt = buildConfigurationPrompt(input, this.#maximumPromptBytes);
    let toolCallCount = 0;
    const receipts = new Map<string, ConfigurationToolReceipt>();

    try {
      for (let turnIndex = 0; turnIndex <= this.#maximumToolTurns; turnIndex += 1) {
        const turn = await this.#runTurn({
          baseRunId,
          turnIndex,
          prompt,
          session,
          targetDeviceId: input.deviceId,
          sessionKey,
        });
        session = turn.session;
        const parsed = parseConfigurationTurnResult(turn.finalText);
        if (parsed.type === "final") {
          const content = finalizeOwnerResponse(parsed, [...receipts.values()]);
          const occurredAt = this.#clock.now();
          if (!isRfc3339Instant(occurredAt)) {
            throw unavailable("The Configuration Agent clock returned an invalid instant.");
          }
          const response = {
            messageId: `message_${digest(`${operationKey}\u0000${requestDigest}`)
              .slice("sha256:".length)
              .slice(0, 64)}`,
            sessionId: `configuration_${digest(sessionKey).slice("sha256:".length).slice(0, 64)}`,
            content,
            occurredAt,
          } satisfies ConfigurationAgentMessageResponse;
          return await this.#recordResponse(operationKey, requestDigest, response);
        }

        if (toolCallCount >= this.#maximumToolTurns) {
          throw unavailable("The Configuration Agent exceeded its typed tool-turn budget.");
        }
        toolCallCount += 1;
        const toolOperationId = configurationToolOperationId(operationKey, parsed.toolCallId);
        let toolResult: ConfigurationAgentToolTurnResult;
        try {
          const receipt = await this.#toolBroker.execute({
            operationId: toolOperationId,
            principalId: input.principalId,
            targetDeviceId: input.deviceId,
            request: parsed.request,
          });
          if (receipt.operationId !== toolOperationId || receipt.tool !== parsed.request.tool) {
            throw unavailable("The Configuration Agent tool broker returned an invalid receipt.");
          }
          receipts.set(receipt.receiptId, receipt);
          toolResult = {
            schemaVersion: 1,
            type: "tool-result",
            toolCallId: parsed.toolCallId,
            tool: parsed.request.tool,
            status: "succeeded",
            receipt,
          };
        } catch (error) {
          if (error instanceof ConfigurationAgentPortError) {
            throw error;
          }
          if (!(error instanceof ConfigurationAgentToolBrokerError)) {
            throw unavailable("The Configuration Agent tool broker failed unexpectedly.");
          }
          toolResult = {
            schemaVersion: 1,
            type: "tool-result",
            toolCallId: parsed.toolCallId,
            tool: parsed.request.tool,
            status: "failed",
            error: {
              code: error.code,
              ...(error.detailCode === undefined ? {} : { detailCode: error.detailCode }),
              ...(error.approvalId === undefined ? {} : { approvalId: error.approvalId }),
            },
          };
        }
        prompt = buildToolResultPrompt(toolResult, this.#maximumPromptBytes);
      }
    } catch (error) {
      if (error instanceof ConfigurationAgentPortError) {
        throw error;
      }
      throw mapAdapterFailure(error, "The Configuration Agent turn failed.");
    }

    throw unavailable("The Configuration Agent exceeded its typed tool-turn budget.");
  }

  async #runTurn(input: {
    readonly baseRunId: string;
    readonly turnIndex: number;
    readonly prompt: string;
    readonly session: NativeSessionReference | undefined;
    readonly targetDeviceId: string;
    readonly sessionKey: string;
  }): Promise<{
    readonly session: NativeSessionReference;
    readonly finalText: string | undefined;
  }> {
    const runId = `${input.baseRunId}_turn_${input.turnIndex}`;
    const common = {
      requestId: `${runId}:request`,
      runId,
      taskId: configurationTaskId(input.targetDeviceId),
      workstreamId: "configuration",
      sessionKey: input.sessionKey,
      deviceId: this.#mainDeviceId,
      prompt: input.prompt,
      workspace: structuredClone(this.#workspace),
      sandbox: this.#sandbox,
      permissions: structuredClone(this.#permissions),
      limits: { ...this.#limits },
    } as const;

    let handle: AgentRunHandle;
    try {
      handle =
        input.session === undefined
          ? await this.#adapter.start({ operation: "start", ...common })
          : await this.#adapter.resume({
              operation: "resume",
              ...common,
              session: input.session,
            });
    } catch (error) {
      throw mapAdapterFailure(error, "The Configuration Agent could not start.");
    }

    const eventCompletion = this.#consumeEvents(handle, input.targetDeviceId, input.sessionKey);
    const [eventResult, runResult] = await Promise.allSettled([eventCompletion, handle.result]);
    if (eventResult.status === "rejected") {
      throw unavailable("The Configuration Agent event stream failed.");
    }
    if (runResult.status === "rejected") {
      throw unavailable("The Configuration Agent returned no terminal result.");
    }
    const terminal = runResult.value;
    if (terminal.session !== undefined) {
      assertSessionBinding(terminal.session, {
        adapter: this.#adapter,
        mainDeviceId: this.#mainDeviceId,
        targetDeviceId: input.targetDeviceId,
        workspace: this.#workspace,
        sessionKey: input.sessionKey,
      });
      await this.#sessionRepository.save(terminal.session);
    }
    if (terminal.status !== "succeeded") {
      throw unavailable("The Configuration Agent did not complete its turn.");
    }
    if (terminal.session === undefined) {
      throw unavailable("The Configuration Agent completed without a durable native session.");
    }
    return {
      session: terminal.session,
      finalText: terminal.finalText,
    };
  }

  async #consumeEvents(
    handle: AgentRunHandle,
    targetDeviceId: string,
    sessionKey: string,
  ): Promise<void> {
    for await (const event of handle.events) {
      if (event.type !== "session_started") {
        continue;
      }
      assertSessionBinding(event.session, {
        adapter: this.#adapter,
        mainDeviceId: this.#mainDeviceId,
        targetDeviceId,
        workspace: this.#workspace,
        sessionKey,
      });
      await this.#sessionRepository.save(event.session);
    }
  }

  async #recordResponse(
    operationKey: string,
    requestDigest: string,
    response: ConfigurationAgentMessageResponse,
  ): Promise<ConfigurationAgentMessageResponse> {
    const streamId = responseStreamId(operationKey);
    const payload = {
      schemaVersion: 1,
      requestDigest,
      response,
    } satisfies ConfigurationResponseEventPayload;
    try {
      await this.#eventStore.append({
        streamId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event_${digest(`${streamId}\u0000${requestDigest}`)
              .slice("sha256:".length)
              .slice(0, 64)}`,
            type: CONFIGURATION_RESPONSE_EVENT,
            payload,
          },
        ],
      });
      return structuredClone(response);
    } catch {
      const stored = await this.#loadStoredResponse(operationKey, requestDigest);
      if (stored !== undefined) {
        return stored;
      }
      throw unavailable("The Configuration Agent response could not be stored durably.");
    }
  }

  async #loadStoredResponse(
    operationKey: string,
    requestDigest: string,
  ): Promise<ConfigurationAgentMessageResponse | undefined> {
    let events: readonly {
      readonly streamVersion: number;
      readonly type: string;
      readonly payload: unknown;
    }[];
    try {
      events = await this.#eventStore.readStream(responseStreamId(operationKey));
    } catch {
      throw unavailable("The Configuration Agent response state could not be read.");
    }
    if (events.length === 0) {
      return undefined;
    }
    if (
      events.length !== 1 ||
      events[0]?.streamVersion !== 1 ||
      events[0].type !== CONFIGURATION_RESPONSE_EVENT
    ) {
      throw unavailable("The Configuration Agent response state is corrupt.");
    }
    const payload = validateResponseEventPayload(events[0].payload);
    if (payload.requestDigest !== requestDigest) {
      throw idempotencyConflict();
    }
    return structuredClone(payload.response);
  }
}

interface ExpectedSessionBinding {
  readonly adapter: AgentAdapter;
  readonly mainDeviceId: string;
  readonly targetDeviceId: string;
  readonly workspace: WorkspaceBinding;
  readonly sessionKey: string;
}

function assertSessionBinding(
  session: NativeSessionReference,
  expected: ExpectedSessionBinding,
): void {
  if (
    session.schemaVersion !== 1 ||
    session.provider !== expected.adapter.provider ||
    session.adapterId !== expected.adapter.adapterId ||
    session.deviceId !== expected.mainDeviceId ||
    session.taskId !== configurationTaskId(expected.targetDeviceId) ||
    session.workstreamId !== "configuration" ||
    session.sessionKey !== expected.sessionKey ||
    session.workspaceId !== expected.workspace.workspaceId ||
    session.cwd !== expected.workspace.cwd ||
    session.worktreePath !== expected.workspace.worktreePath
  ) {
    throw unavailable(
      "The Configuration Agent native session does not belong to this Device conversation.",
    );
  }
}

function buildConfigurationPrompt(
  input: ConfigurationAgentMessageInput,
  maximumBytes: number,
): string {
  const prompt = [
    "You are the OpenDelegate Configuration Agent for one target Device.",
    "Keep this Device conversation isolated from Tasks and every other Device.",
    "OpenDelegate provides exactly six deterministic typed tools: inspect, validate, propose, diff, apply, and rollback.",
    'A tool turn is one exact JSON object: {"schemaVersion":1,"type":"tool","toolCallId":"stable call ID","request":{...typed request...}}.',
    'Inspect has {"tool":"inspect"}. Validate has tool, expectedRevision, and changes. Propose also has reason. Diff and apply have tool, proposalId, and expectedRevision. Rollback has tool, changeSetId, expectedRevision, and reason.',
    'A change is exactly either {"operation":"set","key":"setting.key","scope":{"kind":"scope-kind","id":"scope-id"},"value":...} or the same shape without value and operation unset.',
    "Inspect before changing configuration. Use the returned revision in every later typed request. Never invent proposal, change-set, revision, or receipt identifiers.",
    "The Main-scoped boolean admin.open-on-login controls whether the owner-session helper opens the canonical Admin origin once per login session. It is discoverable through inspect and changeable through the normal propose/apply flow.",
    "After applying or rolling back admin.open-on-login, explain that the installed helper still needs the separately elevated service reconfigure flow. Configuration Chat never elevates or restarts native services.",
    "Mutation claims must reference the exact successful durable receipt returned by OpenDelegate. Failed tool results prove that no requested mutation occurred.",
    "Never request or repeat a raw secret, private key, enrollment grant, database URI, or Agent credential. Direct the owner to the platform secret-store flow instead.",
    "There is no generic shell, file-edit, network, or arbitrary tool in this conversation.",
    "Do not expose private chain-of-thought.",
    'When finished, return one exact JSON object and no Markdown fence: {"schemaVersion":1,"type":"final","content":"owner-visible response","claimReceiptIds":["every successful apply or rollback receipt, and no other receipt"]}.',
    "",
    `Target Device ID: ${input.deviceId}`,
    `Owner message: ${input.message}`,
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > maximumBytes) {
    throw unavailable("The Configuration Agent message exceeds its prompt budget.");
  }
  return prompt;
}

function buildToolResultPrompt(
  result: ConfigurationAgentToolTurnResult,
  maximumBytes: number,
): string {
  const prompt = [
    "OpenDelegate executed the requested deterministic typed configuration tool.",
    "The following JSON is authoritative. A succeeded result is backed by the included durable receipt. A failed result made no requested configuration mutation.",
    JSON.stringify(result),
    "Continue with one typed tool JSON object, or return the exact final JSON object. Never invent or alter identifiers. The final claimReceiptIds must contain every successful apply or rollback receipt and no other receipt.",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > maximumBytes) {
    throw unavailable("The Configuration Agent tool result exceeds its prompt budget.");
  }
  return prompt;
}

function parseConfigurationTurnResult(value: string | undefined): ConfigurationAgentTurnResult {
  if (value === undefined || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw unavailable("The Configuration Agent returned an invalid public response.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw unavailable("The Configuration Agent returned an invalid public response.");
  }
  if (
    !isRecord(parsed) ||
    parsed["schemaVersion"] !== 1 ||
    (parsed["type"] !== "tool" && parsed["type"] !== "final")
  ) {
    throw unavailable("The Configuration Agent returned an invalid public response.");
  }
  if (parsed["type"] === "final") {
    if (
      !hasExactKeys(parsed, ["schemaVersion", "type", "content", "claimReceiptIds"]) ||
      typeof parsed["content"] !== "string" ||
      !Array.isArray(parsed["claimReceiptIds"]) ||
      parsed["claimReceiptIds"].length > 32
    ) {
      throw unavailable("The Configuration Agent returned an invalid public response.");
    }
    assertIdentifier(parsed["content"], "Configuration Agent response", 32_768);
    const claimReceiptIds = parsed["claimReceiptIds"].map((receiptId) => {
      assertIdentifier(receiptId, "Configuration receipt ID", 500);
      return receiptId;
    });
    if (new Set(claimReceiptIds).size !== claimReceiptIds.length) {
      throw unavailable("The Configuration Agent returned duplicate mutation claims.");
    }
    return {
      schemaVersion: 1,
      type: "final",
      content: parsed["content"],
      claimReceiptIds,
    };
  }
  if (!hasExactKeys(parsed, ["schemaVersion", "type", "toolCallId", "request"])) {
    throw unavailable("The Configuration Agent returned an invalid typed tool request.");
  }
  assertIdentifier(parsed["toolCallId"], "Configuration tool call ID", 160);
  return {
    schemaVersion: 1,
    type: "tool",
    toolCallId: parsed["toolCallId"],
    request: parseConfigurationToolRequest(parsed["request"]),
  };
}

function parseConfigurationToolRequest(value: unknown): ConfigurationToolRequest {
  if (!isRecord(value) || typeof value["tool"] !== "string") {
    throw unavailable("The Configuration Agent returned an invalid typed tool request.");
  }
  switch (value["tool"]) {
    case "inspect":
      if (!hasExactKeys(value, ["tool"])) {
        break;
      }
      return { tool: "inspect" };
    case "validate":
      if (
        !hasExactKeys(value, ["tool", "expectedRevision", "changes"]) ||
        !isRevision(value["expectedRevision"])
      ) {
        break;
      }
      return {
        tool: "validate",
        expectedRevision: value["expectedRevision"],
        changes: parseConfigurationChanges(value["changes"]),
      };
    case "propose":
      if (
        !hasExactKeys(value, ["tool", "expectedRevision", "reason", "changes"]) ||
        !isRevision(value["expectedRevision"])
      ) {
        break;
      }
      assertIdentifier(value["reason"], "Configuration proposal reason", 500);
      return {
        tool: "propose",
        expectedRevision: value["expectedRevision"],
        reason: value["reason"],
        changes: parseConfigurationChanges(value["changes"]),
      };
    case "diff":
    case "apply":
      if (
        !hasExactKeys(value, ["tool", "proposalId", "expectedRevision"]) ||
        !isRevision(value["expectedRevision"])
      ) {
        break;
      }
      assertIdentifier(value["proposalId"], "Configuration proposal ID", 500);
      return {
        tool: value["tool"],
        proposalId: value["proposalId"],
        expectedRevision: value["expectedRevision"],
      };
    case "rollback":
      if (
        !hasExactKeys(value, ["tool", "changeSetId", "expectedRevision", "reason"]) ||
        !isRevision(value["expectedRevision"])
      ) {
        break;
      }
      assertIdentifier(value["changeSetId"], "Configuration change-set ID", 500);
      assertIdentifier(value["reason"], "Configuration rollback reason", 500);
      return {
        tool: "rollback",
        changeSetId: value["changeSetId"],
        expectedRevision: value["expectedRevision"],
        reason: value["reason"],
      };
  }
  throw unavailable("The Configuration Agent returned an invalid typed tool request.");
}

function parseConfigurationChanges(value: unknown): readonly ConfigurationChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw unavailable("The Configuration Agent returned an invalid typed tool request.");
  }
  return value.map((change) => {
    if (!isRecord(change) || (change["operation"] !== "set" && change["operation"] !== "unset")) {
      throw unavailable("The Configuration Agent returned an invalid typed tool request.");
    }
    const expectedKeys =
      change["operation"] === "set"
        ? ["operation", "key", "scope", "value"]
        : ["operation", "key", "scope"];
    if (!hasExactKeys(change, expectedKeys) || !isRecord(change["scope"])) {
      throw unavailable("The Configuration Agent returned an invalid typed tool request.");
    }
    assertIdentifier(change["key"], "Configuration setting key", 500);
    const scope = parseConfigurationScope(change["scope"]);
    if (change["operation"] === "set") {
      assertJsonValue(change["value"]);
      return {
        operation: "set" as const,
        key: change["key"],
        scope,
        value: structuredClone(change["value"]),
      };
    }
    return {
      operation: "unset" as const,
      key: change["key"],
      scope,
    };
  });
}

function parseConfigurationScope(value: Record<string, unknown>): ConfigurationScope {
  const kinds = [
    "instance",
    "main",
    "device",
    "agent-adapter",
    "transport",
    "channel-binding",
    "task-default",
    "artifact",
  ] as const;
  if (
    !hasExactKeys(value, ["kind", "id"]) ||
    typeof value["kind"] !== "string" ||
    !kinds.includes(value["kind"] as (typeof kinds)[number])
  ) {
    throw unavailable("The Configuration Agent returned an invalid typed tool request.");
  }
  assertIdentifier(value["id"], "Configuration scope ID", 500);
  return {
    kind: value["kind"] as (typeof kinds)[number],
    id: value["id"],
  };
}

function assertJsonValue(value: unknown, active = new WeakSet<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object" || active.has(value)) {
    throw unavailable("The Configuration Agent returned an invalid typed tool request.");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        assertJsonValue(item, active);
      }
      return;
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw unavailable("The Configuration Agent returned an invalid typed tool request.");
    }
    for (const nested of Object.values(value)) {
      assertJsonValue(nested, active);
    }
  } finally {
    active.delete(value);
  }
}

function finalizeOwnerResponse(
  final: Extract<ConfigurationAgentTurnResult, { type: "final" }>,
  receipts: readonly ConfigurationToolReceipt[],
): string {
  const mutationReceipts = receipts.filter(
    (receipt): receipt is Extract<ConfigurationToolReceipt, { tool: "apply" | "rollback" }> =>
      receipt.tool === "apply" || receipt.tool === "rollback",
  );
  const actual = new Set(mutationReceipts.map((receipt) => receipt.receiptId));
  if (
    final.claimReceiptIds.length !== actual.size ||
    final.claimReceiptIds.some((receiptId) => !actual.has(receiptId))
  ) {
    throw unavailable(
      "The Configuration Agent final mutation claims do not match durable receipts.",
    );
  }
  const attestations = mutationReceipts.map((receipt) => {
    const verb = receipt.tool === "apply" ? "applied" : "rolled back to";
    return `Verified configuration change: ${verb} revision ${receipt.result.commit.revision} (receipt ${receipt.receiptId}, change set ${receipt.result.commit.changeSetId}).`;
  });
  const adminAutoOpenChanged = mutationReceipts.some((receipt) =>
    receipt.result.commit.audit.diff.some((diff) => diff.key === "admin.open-on-login"),
  );
  const serviceNotice = adminAutoOpenChanged
    ? "Admin auto-open service reconfiguration is pending. Run the elevated `opendelegate service reconfigure --home MAIN_HOME --config PLATFORM_CONFIG --active-version VERSION --command-id UNIQUE_ID` flow; Configuration Chat never elevates or restarts native services."
    : undefined;
  const additions = [...attestations, ...(serviceNotice === undefined ? [] : [serviceNotice])];
  const content =
    additions.length === 0 ? final.content : `${final.content}\n\n${additions.join("\n")}`;
  if (Buffer.byteLength(content, "utf8") > 32_768) {
    throw unavailable("The Configuration Agent returned an invalid public response.");
  }
  return content;
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateResponseEventPayload(value: unknown): ConfigurationResponseEventPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "requestDigest", "response"]) ||
    value["schemaVersion"] !== 1 ||
    typeof value["requestDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value["requestDigest"]) ||
    !isRecord(value["response"]) ||
    !hasExactKeys(value["response"], ["messageId", "sessionId", "content", "occurredAt"])
  ) {
    throw unavailable("The Configuration Agent response state is corrupt.");
  }
  const response = value["response"];
  assertIdentifier(response["messageId"], "Message ID", 160);
  assertIdentifier(response["sessionId"], "Session ID", 160);
  assertIdentifier(response["content"], "Configuration Agent response", 32_768);
  if (typeof response["occurredAt"] !== "string" || !isRfc3339Instant(response["occurredAt"])) {
    throw unavailable("The Configuration Agent response state is corrupt.");
  }
  return structuredClone(value) as unknown as ConfigurationResponseEventPayload;
}

function validateInput(input: ConfigurationAgentMessageInput): ConfigurationAgentMessageInput {
  if (!isRecord(input)) {
    throw unavailable("The Configuration Agent request is invalid.");
  }
  assertIdentifier(input.deviceId, "Target Device ID", 160);
  assertIdentifier(input.principalId, "Principal ID", 160);
  assertIdentifier(input.idempotencyKey, "Idempotency key", 160);
  assertIdentifier(input.message, "Owner message", 8_192);
  return {
    deviceId: input.deviceId,
    principalId: input.principalId,
    idempotencyKey: input.idempotencyKey,
    message: input.message,
  };
}

function assertAdapter(adapter: AgentAdapter): void {
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    typeof adapter.adapterId !== "string" ||
    typeof adapter.start !== "function" ||
    typeof adapter.resume !== "function"
  ) {
    throw new TypeError("A valid Agent Adapter is required.");
  }
}

function assertRepository(repository: MainNativeSessionRepository): void {
  if (
    repository === null ||
    typeof repository !== "object" ||
    typeof repository.load !== "function" ||
    typeof repository.save !== "function"
  ) {
    throw new TypeError("A durable Main native-session repository is required.");
  }
}

function assertEventStore(eventStore: NativeSessionEventStore): void {
  if (
    eventStore === null ||
    typeof eventStore !== "object" ||
    typeof eventStore.readStream !== "function" ||
    typeof eventStore.append !== "function"
  ) {
    throw new TypeError("A durable Configuration Agent event store is required.");
  }
}

function assertToolBroker(toolBroker: ConfigurationAgentToolBroker): void {
  if (
    toolBroker === null ||
    typeof toolBroker !== "object" ||
    typeof toolBroker.execute !== "function"
  ) {
    throw new TypeError("A deterministic Configuration Agent tool broker is required.");
  }
}

function assertWorkspace(workspace: WorkspaceBinding): void {
  assertIdentifier(workspace.workspaceId, "Workspace ID", 160);
  assertIdentifier(workspace.cwd, "Workspace cwd", 32_768);
}

function assertExecutionOptions(
  sandbox: AgentSandbox,
  permissions: AgentPermissionInput,
  limits: AgentRunLimits,
): void {
  if (
    typeof sandbox !== "string" ||
    permissions === null ||
    typeof permissions !== "object" ||
    typeof permissions.mode !== "string" ||
    limits === null ||
    typeof limits !== "object" ||
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError("Agent execution policy and limits are invalid.");
  }
}

function mapAdapterFailure(error: unknown, message: string): ConfigurationAgentPortError {
  const detail =
    error instanceof AgentAdapterError && error.retryable
      ? `${message} The Agent Adapter reported a retryable failure.`
      : message;
  return unavailable(detail);
}

function unavailable(message: string): ConfigurationAgentPortError {
  return new ConfigurationAgentPortError("CONFIGURATION_AGENT_UNAVAILABLE", message);
}

function idempotencyConflict(): ConfigurationAgentPortError {
  return new ConfigurationAgentPortError(
    "IDEMPOTENCY_CONFLICT",
    "The idempotency key was already used for a different Configuration Agent message.",
  );
}

function secretMaterialRequiresSecureIngest(): ConfigurationAgentPortError {
  return new ConfigurationAgentPortError(
    "SECRET_MATERIAL_REQUIRES_SECURE_INGEST",
    "Raw Secret material must be submitted through the secure Secret ingest flow.",
  );
}

function containsRawSecretMaterial(message: string): boolean {
  const inspectable = message.replace(SAFE_OPAQUE_REFERENCE, " ");
  return (
    DATABASE_URI_MATERIAL.test(inspectable) ||
    USERINFO_URI_MATERIAL.test(inspectable) ||
    PEM_MATERIAL.test(inspectable) ||
    NAMED_SECRET_MATERIAL.test(inspectable) ||
    WELL_KNOWN_TOKEN_MATERIAL.test(inspectable) ||
    DISCORD_TOKEN_MATERIAL.test(inspectable) ||
    AWS_ACCESS_KEY_MATERIAL.test(inspectable) ||
    GOOGLE_API_KEY_MATERIAL.test(inspectable) ||
    containsHighEntropyOpaqueToken(inspectable)
  );
}

function containsHighEntropyOpaqueToken(message: string): boolean {
  for (const match of message.matchAll(OPAQUE_TOKEN_CANDIDATE)) {
    const candidate = match[0];
    if (
      !/[a-z]/u.test(candidate) ||
      !/[A-Z]/u.test(candidate) ||
      !/[0-9]/u.test(candidate) ||
      /^[a-f0-9]+$/iu.test(candidate) ||
      isUuid(candidate)
    ) {
      continue;
    }
    if (new Set(candidate).size >= 16 && shannonEntropy(candidate) >= 4.3) {
      return true;
    }
  }
  return false;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}

function configurationSessionKey(targetDeviceId: string, adapterId: string): string {
  return `configuration:${targetDeviceId}:${adapterId}`;
}

function configurationTaskId(targetDeviceId: string): string {
  return `configuration:${targetDeviceId}`;
}

function responseStreamId(operationKey: string): string {
  return `configuration-response:${operationKey.slice("sha256:".length)}`;
}

function configurationToolOperationId(operationKey: string, toolCallId: string): string {
  return `configuration-tool:${digest(`${operationKey}\u0000${toolCallId}`)
    .slice("sha256:".length)
    .slice(0, 64)}`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function assertIdentifier(
  value: unknown,
  label: string,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    value.includes("\u0000")
  ) {
    throw unavailable(`${label} is invalid.`);
  }
}

function isRfc3339Instant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
