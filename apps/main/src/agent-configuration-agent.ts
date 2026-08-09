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
  isAgentExecutionProfile,
  type ConfigurationChange,
  type ConfigurationContext,
  type ConfigurationMutationAuthorizer,
  type ConfigurationScope,
  type ConfigurationService,
  type ConfigurationToolReceipt,
  type ConfigurationToolRequest,
} from "@opendelegate/configuration";
import type {
  ConfigurationAgentConversationMessageV1,
  ConfigurationAgentConversationResponseV1,
  ConfigurationAgentSuggestedActionV1,
} from "@opendelegate/protocol";
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

interface LegacyConfigurationToolAttemptEventPayload {
  readonly schemaVersion: 1;
  readonly requestDigest: string;
  readonly toolOperationId: string;
  readonly tool: ConfigurationToolRequest["tool"];
}

interface ConfigurationToolAttemptEventPayload {
  readonly schemaVersion: 2;
  readonly requestDigest: string;
  readonly toolOperationId: string;
  readonly tool: ConfigurationToolRequest["tool"];
}

type StoredConfigurationToolAttemptEventPayload =
  LegacyConfigurationToolAttemptEventPayload | ConfigurationToolAttemptEventPayload;

interface ConfigurationContinuationReservationEventPayload {
  readonly schemaVersion: 1;
  readonly requestDigest: string;
}

interface ConfigurationConversationExchangeEventPayload {
  readonly schemaVersion: 1;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly ownerMessage: ConfigurationAgentConversationMessageV1;
  readonly response: ConfigurationAgentMessageResponse;
}

interface ConfigurationConversationOwnerMessageEventPayload {
  readonly schemaVersion: 1;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly ownerMessage: ConfigurationAgentConversationMessageV1;
}

interface ConfigurationConversationTurn {
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly ownerMessage: ConfigurationAgentConversationMessageV1;
  readonly response?: ConfigurationAgentMessageResponse;
}

interface StoredConfigurationConversationEvent {
  readonly streamVersion: number;
  readonly type: string;
  readonly payload: unknown;
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
  readonly onConfigurationApplied?: () => void;
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
  readonly #onConfigurationApplied: (() => void) | undefined;

  constructor(options: ConfigurationServiceAgentToolBrokerOptions) {
    if (
      options.service === null ||
      typeof options.service !== "object" ||
      typeof options.service.executeTool !== "function" ||
      typeof options.contextForDevice !== "function" ||
      typeof options.authorizeMutation !== "function" ||
      (options.onConfigurationApplied !== undefined &&
        typeof options.onConfigurationApplied !== "function")
    ) {
      throw new TypeError("A valid Configuration Service tool broker configuration is required.");
    }
    this.#service = options.service;
    this.#contextForDevice = options.contextForDevice;
    this.#authorizeMutation = options.authorizeMutation;
    this.#approvalRequester = options.approvalRequester;
    this.#onConfigurationApplied = options.onConfigurationApplied;
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
    const revisionBeforeApply =
      input.request.tool === "apply" ? await this.#service.getRevision() : undefined;
    try {
      const receipt = await this.#service.executeTool({
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
      if (
        receipt.tool === "apply" &&
        revisionBeforeApply !== undefined &&
        receipt.result.commit.revision > revisionBeforeApply
      ) {
        this.#onConfigurationApplied?.();
      }
      return receipt;
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
      readonly suggestedActions: readonly ConfigurationAgentSuggestedActionV1[];
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
const CONFIGURATION_TOOL_ATTEMPT_EVENT = "configuration-agent.tool-attempted";
const CONFIGURATION_CONTINUATION_RESERVATION_EVENT = "configuration-agent.continuation-reserved";
const CONFIGURATION_CONVERSATION_OWNER_MESSAGE_EVENT =
  "configuration-agent.conversation-owner-message-recorded";
const CONFIGURATION_CONVERSATION_EXCHANGE_EVENT =
  "configuration-agent.conversation-exchange-recorded";
const MAXIMUM_CONFIGURATION_CONVERSATION_EXCHANGES = 1_000;
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
    const requestDigest = digest(
      `${request.message}\u0000response-locale:${request.responseLocale ?? "en"}`,
    );
    const active = this.#activeRequests.get(operationKey);
    if (active !== undefined) {
      if (active.requestDigest !== requestDigest) {
        throw idempotencyConflict();
      }
      return active.result;
    }

    const result = (async () => {
      const ownerMessage = await this.#recordConversationOwnerMessage({
        deviceId: request.deviceId,
        operationKey,
        ownerMessage: request.message,
        requestDigest,
      });
      return this.#enqueue(request.deviceId, async () => {
        const stored = await this.#loadStoredResponse(operationKey, requestDigest);
        if (stored !== undefined) {
          return stored;
        }
        const storedExchange = await this.#loadStoredConversationExchange(
          request.deviceId,
          operationKey,
          requestDigest,
        );
        if (storedExchange !== undefined) {
          return storedExchange;
        }
        return this.#runAndRecord(request, operationKey, requestDigest, ownerMessage);
      });
    })();
    this.#activeRequests.set(operationKey, { requestDigest, result });
    const cleanup = (): void => {
      if (this.#activeRequests.get(operationKey)?.result === result) {
        this.#activeRequests.delete(operationKey);
      }
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  async listMessages(input: {
    readonly deviceId: string;
    readonly principalId: string;
  }): Promise<ConfigurationAgentConversationResponseV1> {
    assertIdentifier(input.deviceId, "Target Device ID", 160);
    assertIdentifier(input.principalId, "Owner principal ID", 160);
    let events: readonly StoredConfigurationConversationEvent[];
    try {
      events = await this.#eventStore.readStream(
        conversationStreamId(input.deviceId, this.#adapter.adapterId),
      );
    } catch {
      throw unavailable(
        "The Configuration Chat history could not be read.",
        "CONFIGURATION_HISTORY_UNREADABLE",
      );
    }
    const turns = projectConversationTurns(events).slice(
      -MAXIMUM_CONFIGURATION_CONVERSATION_EXCHANGES,
    );
    return {
      messages: turns.flatMap((turn) => {
        const active = this.#activeRequests.get(turn.operationKey);
        const responseStatus =
          turn.response !== undefined
            ? ("completed" as const)
            : active?.requestDigest === turn.requestDigest
              ? ("pending" as const)
              : ("interrupted" as const);
        return [
          {
            ...structuredClone(turn.ownerMessage),
            responseStatus,
          },
          ...(turn.response === undefined
            ? []
            : [
                {
                  messageId: turn.response.messageId,
                  role: "agent" as const,
                  content: turn.response.content,
                  ...(turn.response.suggestedActions === undefined
                    ? {}
                    : { suggestedActions: [...turn.response.suggestedActions] }),
                  ...(turn.response.pendingApprovalId === undefined
                    ? {}
                    : { pendingApprovalId: turn.response.pendingApprovalId }),
                  occurredAt: turn.response.occurredAt,
                },
              ]),
        ];
      }),
    };
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
    ownerMessage: ConfigurationAgentConversationMessageV1,
  ): Promise<ConfigurationAgentMessageResponse> {
    await this.#assertInterruptedAttemptIsRecoverable(operationKey, requestDigest);
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
      throw unavailable(
        "The Configuration Agent session state could not be read safely.",
        "CONFIGURATION_SESSION_STATE_UNREADABLE",
      );
    }

    const baseRunId = `configuration_${operationKey.slice("sha256:".length)}`;
    const currentRequestPrompt = buildConfigurationPrompt(input, this.#maximumPromptBytes);
    let prompt = currentRequestPrompt;
    let toolCallCount = 0;
    let replayUnsafeToolAttempted = false;
    let continuationStarted = false;
    const receipts = new Map<string, ConfigurationToolReceipt>();
    const proposedProposalIds = new Set<string>();
    const applyAttemptedProposalIds = new Set<string>();
    let proposalCompletionCorrectionIssued = false;
    let pendingApprovalId: string | undefined;

    try {
      for (let turnIndex = 0; turnIndex <= this.#maximumToolTurns; turnIndex += 1) {
        let turn: {
          readonly session: NativeSessionReference;
          readonly finalText: string | undefined;
        };
        try {
          turn = await this.#runTurn({
            baseRunId,
            turnIndex,
            prompt,
            session,
            targetDeviceId: input.deviceId,
            sessionKey,
          });
        } catch (error) {
          if (
            continuationStarted ||
            replayUnsafeToolAttempted ||
            session === undefined ||
            !(error instanceof ConfigurationAgentPortError) ||
            error.code !== "CONFIGURATION_AGENT_UNAVAILABLE"
          ) {
            throw error;
          }
          const conversation = await this.listMessages({
            deviceId: input.deviceId,
            principalId: input.principalId,
          });
          await this.#recordContinuationReservation(operationKey, requestDigest);
          continuationStarted = true;
          turn = await this.#runTurn({
            baseRunId: `${baseRunId}_continuation`,
            turnIndex,
            prompt: buildConfigurationContinuationPrompt(
              currentRequestPrompt,
              conversation.messages.filter(
                (message) => message.role !== "owner" || message.responseStatus !== "pending",
              ),
              this.#maximumPromptBytes,
            ),
            session: undefined,
            continuationOf: session,
            continuationReason:
              turnIndex === 0
                ? "Initial Configuration Agent native resume was unavailable before tool execution."
                : "Configuration Agent native session became unavailable after read-only inspection and before mutation-capable tool execution.",
            targetDeviceId: input.deviceId,
            sessionKey,
          });
        }
        session = turn.session;
        const parsed = parseConfigurationTurnResult(turn.finalText);
        if (parsed.type === "final") {
          const incompleteProposalIds = [...proposedProposalIds].filter(
            (proposalId) => !applyAttemptedProposalIds.has(proposalId),
          );
          if (incompleteProposalIds.length > 0) {
            if (proposalCompletionCorrectionIssued) {
              throw unavailable(
                "The Configuration Agent stopped before creating the required owner Approval.",
                "CONFIGURATION_PROPOSAL_APPROVAL_NOT_CREATED",
              );
            }
            proposalCompletionCorrectionIssued = true;
            prompt = buildProposalCompletionPrompt(incompleteProposalIds, this.#maximumPromptBytes);
            continue;
          }
          const content = finalizeOwnerResponse(parsed, [...receipts.values()]);
          const occurredAt = this.#clock.now();
          if (!isRfc3339Instant(occurredAt)) {
            throw unavailable(
              "The Configuration Agent clock returned an invalid instant.",
              "CONFIGURATION_CLOCK_INVALID",
            );
          }
          const response = {
            messageId: `message_${digest(`${operationKey}\u0000${requestDigest}`)
              .slice("sha256:".length)
              .slice(0, 64)}`,
            sessionId: `configuration_${digest(sessionKey).slice("sha256:".length).slice(0, 64)}`,
            content,
            ...(parsed.suggestedActions.length === 0
              ? {}
              : { suggestedActions: [...parsed.suggestedActions] }),
            ...(pendingApprovalId === undefined ? {} : { pendingApprovalId }),
            occurredAt,
          } satisfies ConfigurationAgentMessageResponse;
          await this.#recordConversationExchange({
            deviceId: input.deviceId,
            operationKey,
            ownerMessage,
            requestDigest,
            response,
          });
          return await this.#recordResponse(operationKey, requestDigest, response);
        }

        if (toolCallCount >= this.#maximumToolTurns) {
          throw unavailable(
            "The Configuration Agent exceeded its typed tool-turn budget.",
            "CONFIGURATION_TOOL_TURN_BUDGET_EXCEEDED",
          );
        }
        toolCallCount += 1;
        if (parsed.request.tool === "apply") {
          applyAttemptedProposalIds.add(parsed.request.proposalId);
        }
        const toolOperationId = configurationToolOperationId(operationKey, parsed.toolCallId);
        await this.#recordToolAttempt({
          operationKey,
          requestDigest,
          toolOperationId,
          tool: parsed.request.tool,
        });
        replayUnsafeToolAttempted ||= isReplayUnsafeConfigurationTool(parsed.request.tool);
        let toolResult: ConfigurationAgentToolTurnResult;
        try {
          const receipt = await this.#toolBroker.execute({
            operationId: toolOperationId,
            principalId: input.principalId,
            targetDeviceId: input.deviceId,
            request: parsed.request,
          });
          if (receipt.operationId !== toolOperationId || receipt.tool !== parsed.request.tool) {
            throw unavailable(
              "The Configuration Agent tool broker returned an invalid receipt.",
              "CONFIGURATION_TOOL_RECEIPT_INVALID",
            );
          }
          receipts.set(receipt.receiptId, receipt);
          if (receipt.tool === "propose") {
            proposedProposalIds.add(receipt.result.proposal.id);
          }
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
            throw unavailable(
              "The Configuration Agent tool broker failed unexpectedly.",
              "CONFIGURATION_TOOL_BROKER_FAILED",
            );
          }
          if (
            error.code === "CONFIGURATION_TOOL_APPROVAL_REQUIRED" &&
            error.approvalId !== undefined
          ) {
            pendingApprovalId = error.approvalId;
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

    throw unavailable(
      "The Configuration Agent exceeded its typed tool-turn budget.",
      "CONFIGURATION_TOOL_TURN_BUDGET_EXCEEDED",
    );
  }

  async #runTurn(input: {
    readonly baseRunId: string;
    readonly turnIndex: number;
    readonly prompt: string;
    readonly session: NativeSessionReference | undefined;
    readonly continuationOf?: NativeSessionReference;
    readonly continuationReason?: string;
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
          ? await this.#adapter.start({
              operation: "start",
              ...common,
              ...(input.continuationOf === undefined
                ? {}
                : {
                    continuationOf: input.continuationOf,
                    continuationReason: input.continuationReason,
                  }),
            })
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
      throw mapAdapterFailure(eventResult.reason, "The Configuration Agent event stream failed.");
    }
    if (runResult.status === "rejected") {
      throw mapAdapterFailure(
        runResult.reason,
        "The Configuration Agent returned no terminal result.",
      );
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
      const failureCode = safeDiagnosticCode(
        terminal.error?.code,
        "CONFIGURATION_AGENT_TURN_FAILED",
      );
      throw unavailable(
        `The Configuration Agent did not complete its turn. Diagnostic code: ${failureCode}.`,
        failureCode,
      );
    }
    if (terminal.session === undefined) {
      throw unavailable(
        "The Configuration Agent completed without a durable native session.",
        "CONFIGURATION_NATIVE_SESSION_MISSING",
      );
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
      // The Device-scoped conversation stream is the canonical durable copy.
      // This per-operation stream is only a fast idempotency lookup.
      return structuredClone(response);
    }
  }

  async #recordConversationOwnerMessage(input: {
    readonly deviceId: string;
    readonly operationKey: string;
    readonly ownerMessage: string;
    readonly requestDigest: string;
  }): Promise<ConfigurationAgentConversationMessageV1> {
    const streamId = conversationStreamId(input.deviceId, this.#adapter.adapterId);
    const occurredAt = this.#clock.now();
    if (!isRfc3339Instant(occurredAt)) {
      throw unavailable(
        "The Configuration Agent clock returned an invalid instant.",
        "CONFIGURATION_CLOCK_INVALID",
      );
    }
    const ownerMessage: ConfigurationAgentConversationMessageV1 = {
      messageId: `owner_${digest(`${input.operationKey}\u0000owner`)
        .slice("sha256:".length)
        .slice(0, 64)}`,
      role: "owner",
      content: input.ownerMessage,
      occurredAt,
    };
    const payload = {
      schemaVersion: 1,
      operationKey: input.operationKey,
      requestDigest: input.requestDigest,
      ownerMessage,
    } satisfies ConfigurationConversationOwnerMessageEventPayload;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const events = await this.#eventStore.readStream(streamId);
      const existing = findConversationOwnerMessage(events, input.operationKey);
      if (existing !== undefined) {
        if (
          existing.requestDigest !== input.requestDigest ||
          existing.ownerMessage.content !== input.ownerMessage
        ) {
          throw idempotencyConflict();
        }
        return structuredClone(existing.ownerMessage);
      }
      try {
        await this.#eventStore.append({
          streamId,
          expectedVersion: events.length,
          events: [
            {
              eventId: `event_${digest(`${streamId}\u0000${input.operationKey}\u0000owner`)
                .slice("sha256:".length)
                .slice(0, 64)}`,
              type: CONFIGURATION_CONVERSATION_OWNER_MESSAGE_EVENT,
              payload,
            },
          ],
        });
        return structuredClone(ownerMessage);
      } catch {
        // Re-read to distinguish a concurrent idempotent append from storage failure.
      }
    }
    throw unavailable(
      "The Configuration Chat owner message could not be stored durably.",
      "CONFIGURATION_OWNER_MESSAGE_NOT_STORED",
    );
  }

  async #recordConversationExchange(input: {
    readonly deviceId: string;
    readonly operationKey: string;
    readonly ownerMessage: ConfigurationAgentConversationMessageV1;
    readonly requestDigest: string;
    readonly response: ConfigurationAgentMessageResponse;
  }): Promise<void> {
    const streamId = conversationStreamId(input.deviceId, this.#adapter.adapterId);
    const payload = {
      schemaVersion: 1,
      operationKey: input.operationKey,
      requestDigest: input.requestDigest,
      ownerMessage: input.ownerMessage,
      response: input.response,
    } satisfies ConfigurationConversationExchangeEventPayload;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const events = await this.#eventStore.readStream(streamId);
      const existing = findConversationExchange(events, input.operationKey);
      if (existing !== undefined) {
        if (
          existing.requestDigest !== input.requestDigest ||
          JSON.stringify(existing.response) !== JSON.stringify(input.response)
        ) {
          throw idempotencyConflict();
        }
        return;
      }
      try {
        await this.#eventStore.append({
          streamId,
          expectedVersion: events.length,
          events: [
            {
              eventId: `event_${digest(`${streamId}\u0000${input.operationKey}`)
                .slice("sha256:".length)
                .slice(0, 64)}`,
              type: CONFIGURATION_CONVERSATION_EXCHANGE_EVENT,
              payload,
            },
          ],
        });
        return;
      } catch {
        // Re-read to distinguish a concurrent idempotent append from storage failure.
      }
    }
    throw unavailable(
      "The Configuration Chat exchange could not be stored durably.",
      "CONFIGURATION_EXCHANGE_NOT_STORED",
    );
  }

  async #loadStoredConversationExchange(
    deviceId: string,
    operationKey: string,
    requestDigest: string,
  ): Promise<ConfigurationAgentMessageResponse | undefined> {
    let events: readonly StoredConfigurationConversationEvent[];
    try {
      events = await this.#eventStore.readStream(
        conversationStreamId(deviceId, this.#adapter.adapterId),
      );
    } catch {
      throw unavailable(
        "The Configuration Chat history could not be read.",
        "CONFIGURATION_HISTORY_UNREADABLE",
      );
    }
    const existing = findConversationExchange(events, operationKey);
    if (existing === undefined) {
      return undefined;
    }
    if (existing.requestDigest !== requestDigest) {
      throw idempotencyConflict();
    }
    return structuredClone(existing.response);
  }

  async #assertInterruptedAttemptIsRecoverable(
    operationKey: string,
    requestDigest: string,
  ): Promise<void> {
    const attempts = await this.#loadToolAttempts(operationKey, requestDigest);
    if (attempts.some((attempt) => attempt.schemaVersion === 1)) {
      throw unavailable(
        "A previous Configuration Agent attempt used a legacy tool-attempt boundary whose later mutation state is unknown. OpenDelegate did not replay it.",
        "CONFIGURATION_LEGACY_TOOL_ATTEMPT_NOT_REPLAYABLE",
      );
    }
    if (attempts.some((attempt) => isReplayUnsafeConfigurationTool(attempt.tool))) {
      throw unavailable(
        "A previous Configuration Agent attempt reached a mutation-capable tool without recording a final response. OpenDelegate did not replay it.",
        "CONFIGURATION_MUTATION_ATTEMPT_NOT_REPLAYABLE",
      );
    }
    if ((await this.#loadContinuationReservation(operationKey, requestDigest)) !== undefined) {
      throw unavailable(
        "A previous Configuration Agent attempt already reserved its one native continuation without recording a final response. OpenDelegate did not start another continuation.",
        "CONFIGURATION_CONTINUATION_NOT_REPLAYABLE",
      );
    }
  }

  async #recordToolAttempt(input: {
    readonly operationKey: string;
    readonly requestDigest: string;
    readonly toolOperationId: string;
    readonly tool: ConfigurationToolRequest["tool"];
  }): Promise<void> {
    const streamId = toolAttemptStreamId(input.operationKey);
    const payload = {
      schemaVersion: 2,
      requestDigest: input.requestDigest,
      toolOperationId: input.toolOperationId,
      tool: input.tool,
    } satisfies ConfigurationToolAttemptEventPayload;
    for (let appendAttempt = 0; appendAttempt < 2; appendAttempt += 1) {
      const attempts = await this.#loadToolAttempts(input.operationKey, input.requestDigest);
      if (attempts.some((attempt) => attempt.schemaVersion === 1)) {
        throw unavailable(
          "The Configuration Agent cannot extend a legacy tool-attempt boundary safely.",
          "CONFIGURATION_LEGACY_TOOL_ATTEMPT_NOT_EXTENDABLE",
        );
      }
      const existing = attempts.find(
        (attempt) => attempt.toolOperationId === input.toolOperationId,
      );
      if (existing !== undefined) {
        if (existing.tool !== input.tool) {
          throw unavailable(
            "The Configuration Agent tool-attempt state is corrupt.",
            "CONFIGURATION_TOOL_ATTEMPT_STATE_CORRUPT",
          );
        }
        return;
      }
      if (
        attempts.some((attempt) => isReplayUnsafeConfigurationTool(attempt.tool)) ||
        (attempts.length > 0 && !isReplayUnsafeConfigurationTool(input.tool))
      ) {
        return;
      }
      try {
        await this.#eventStore.append({
          streamId,
          expectedVersion: attempts.length,
          events: [
            {
              eventId: `event_${digest(
                `${streamId}\u0000${input.requestDigest}\u0000${input.toolOperationId}`,
              )
                .slice("sha256:".length)
                .slice(0, 64)}`,
              type: CONFIGURATION_TOOL_ATTEMPT_EVENT,
              payload,
            },
          ],
        });
        return;
      } catch {
        // Re-read once to distinguish an idempotent concurrent append from storage failure.
      }
    }
    throw unavailable(
      "The Configuration Agent tool-attempt boundary could not be stored durably.",
      "CONFIGURATION_TOOL_ATTEMPT_NOT_STORED",
    );
  }

  async #loadToolAttempts(
    operationKey: string,
    requestDigest: string,
  ): Promise<readonly StoredConfigurationToolAttemptEventPayload[]> {
    let events: readonly {
      readonly streamVersion: number;
      readonly type: string;
      readonly payload: unknown;
    }[];
    try {
      events = await this.#eventStore.readStream(toolAttemptStreamId(operationKey));
    } catch {
      throw unavailable(
        "The Configuration Agent tool-attempt state could not be read.",
        "CONFIGURATION_TOOL_ATTEMPT_STATE_UNREADABLE",
      );
    }
    return events.map((event, index) => {
      if (event.streamVersion !== index + 1 || event.type !== CONFIGURATION_TOOL_ATTEMPT_EVENT) {
        throw unavailable(
          "The Configuration Agent tool-attempt state is corrupt.",
          "CONFIGURATION_TOOL_ATTEMPT_STATE_CORRUPT",
        );
      }
      const payload = validateToolAttemptEventPayload(event.payload);
      if (payload.requestDigest !== requestDigest) {
        throw idempotencyConflict();
      }
      return payload;
    });
  }

  async #recordContinuationReservation(operationKey: string, requestDigest: string): Promise<void> {
    if ((await this.#loadContinuationReservation(operationKey, requestDigest)) !== undefined) {
      throw unavailable(
        "The Configuration Agent already reserved its one native continuation for this request.",
        "CONFIGURATION_CONTINUATION_RESERVATION_DUPLICATE",
      );
    }
    const streamId = continuationReservationStreamId(operationKey);
    try {
      await this.#eventStore.append({
        streamId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event_${digest(`${streamId}\u0000${requestDigest}`)
              .slice("sha256:".length)
              .slice(0, 64)}`,
            type: CONFIGURATION_CONTINUATION_RESERVATION_EVENT,
            payload: {
              schemaVersion: 1,
              requestDigest,
            } satisfies ConfigurationContinuationReservationEventPayload,
          },
        ],
      });
    } catch {
      throw unavailable(
        "The Configuration Agent continuation boundary could not be stored durably.",
        "CONFIGURATION_CONTINUATION_NOT_STORED",
      );
    }
  }

  async #loadContinuationReservation(
    operationKey: string,
    requestDigest: string,
  ): Promise<ConfigurationContinuationReservationEventPayload | undefined> {
    let events: readonly {
      readonly streamVersion: number;
      readonly type: string;
      readonly payload: unknown;
    }[];
    try {
      events = await this.#eventStore.readStream(continuationReservationStreamId(operationKey));
    } catch {
      throw unavailable(
        "The Configuration Agent continuation boundary could not be read.",
        "CONFIGURATION_CONTINUATION_UNREADABLE",
      );
    }
    if (events.length === 0) {
      return undefined;
    }
    if (
      events.length !== 1 ||
      events[0]?.streamVersion !== 1 ||
      events[0].type !== CONFIGURATION_CONTINUATION_RESERVATION_EVENT
    ) {
      throw unavailable(
        "The Configuration Agent continuation boundary is corrupt.",
        "CONFIGURATION_CONTINUATION_CORRUPT",
      );
    }
    const payload = validateContinuationReservationEventPayload(events[0].payload);
    if (payload.requestDigest !== requestDigest) {
      throw idempotencyConflict();
    }
    return payload;
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
      throw unavailable(
        "The Configuration Agent response state could not be read.",
        "CONFIGURATION_RESPONSE_STATE_UNREADABLE",
      );
    }
    if (events.length === 0) {
      return undefined;
    }
    if (
      events.length !== 1 ||
      events[0]?.streamVersion !== 1 ||
      events[0].type !== CONFIGURATION_RESPONSE_EVENT
    ) {
      throw unavailable(
        "The Configuration Agent response state is corrupt.",
        "CONFIGURATION_RESPONSE_STATE_CORRUPT",
      );
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
      "CONFIGURATION_SESSION_BINDING_MISMATCH",
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
    configurationResponseLocaleInstruction(input.responseLocale),
    "OpenDelegate provides exactly six deterministic typed tools: inspect, validate, propose, diff, apply, and rollback.",
    'A tool turn is one exact JSON object: {"schemaVersion":1,"type":"tool","toolCallId":"stable call ID","request":{...typed request...}}.',
    'Inspect has {"tool":"inspect"}. Validate has tool, expectedRevision, and changes. Propose also has reason. Diff and apply have tool, proposalId, and expectedRevision. Rollback has tool, changeSetId, expectedRevision, and reason.',
    'A change is exactly either {"operation":"set","key":"setting.key","scope":{"kind":"scope-kind","id":"scope-id"},"value":...} or the same shape without value and operation unset.',
    "Inspect before changing configuration. Use the returned revision in every later typed request. Never invent proposal, change-set, revision, or receipt identifiers.",
    "When the owner asks to change Configuration, complete inspect, validate when useful, propose, diff, and one apply attempt in the same turn. A protected apply result with an approvalId means the owner Approval was created successfully; report that exact Approval and stop. Never stop immediately after propose or tell the owner to approve a proposal that has no approvalId. If the owner explicitly asks for a draft or preview only, use validate without creating a proposal.",
    "The Main-scoped boolean admin.open-on-login controls whether the owner-session helper opens the canonical Admin origin once per login session. It is discoverable through inspect and changeable through the normal propose/apply flow.",
    "After applying or rolling back admin.open-on-login, explain that the installed helper still needs the separately elevated service reconfigure flow. Configuration Chat never elevates or restarts native services.",
    "autonomy.profile sets the broad proactive default: reactive, assisted, or autonomous. Each proactive category can independently inherit that profile or be disabled, proposed, or executed through autonomy.incident-recovery, autonomy.maintenance, autonomy.capability-expansion, autonomy.cleanup, autonomy.cost-incurring-work, and autonomy.general-improvement.",
    "Explain proactive authority in outcome terms. A deterministic monitor may originate an ordinary auditable Task and Discord Forum post without continuously running an LLM. proposed creates a manual review Task; executed creates an auto Task, but Action Policy, approvals, budgets, resource locks, and Secret boundaries still apply. Never imply that autonomous mode bypasses them.",
    'The Device-scoped agent.worker-profile is exactly {"schemaVersion":1,"mode":"auto"}, {"schemaVersion":1,"mode":"pinned","primary":{"provider":"codex|claude|generic","adapterId":"exact ID","modelId":"exact provider-native ID when the provider exposes models"}}, or {"schemaVersion":1,"mode":"prefer","primary":BINDING,"fallbacks":[BINDING,...]}. Prefer has no implicit fallback. Pinned fails closed.',
    'A BINDING may also carry "effort", the provider tuning for that exact model. Use only a value the model advertises in the catalog below; a model with no advertised efforts takes none. Effort is per binding, so a fallback may differ from the primary. Omit it to keep the provider default rather than inventing one.',
    "The Main-scoped agent.coordinator-profile uses the same shape and controls Main planning only. Main's agent.worker-profile separately controls ordinary Work Orders executed by its co-located Worker. If the owner says Main Agent or Coordinator, change coordinator only; if they say work on Main, change the Worker profile; if they clearly say every Agent on Main, propose both changes in one diff.",
    "A Coordinator model change on the active Main Agent Adapter applies to new Task sessions through configuration alone. A Coordinator provider or adapter change also requires the authenticated Main Agent reconfiguration flow and service restart; do not claim that changing agent.coordinator-profile by itself replaced the running Coordinator.",
    "Resolve friendly model names only against the target Device's authoritative ready adapter model catalog below. Persist the exact modelId and adapterId; never invent, shorten, or transfer a model ID from another Device. If no exact unambiguous match exists, explain the available choices and ask one focused question.",
    "Changing an Agent profile affects only new Task or workstream sessions. Existing native sessions and any checkpoint continuation created from them retain their recorded provider, adapter, and model binding. Explain this when it matters.",
    'The Main-scoped discord.binding controls the live Discord Forum connection. Its value is null when disabled, or exactly {"schemaVersion":1,"enabled":true,"botTokenAlias":"opaque managed-store alias","forum":{"applicationId":"17-20 digit ID","botUserId":"17-20 digit ID","guildId":"17-20 digit ID","forumBindings":[{"channelId":"17-20 digit ID","workflowTagIds":{"done":"ID","failed":"ID","intake":"ID","review":"ID","running":"ID","waiting":"ID"}}],"ownerUserIds":["ID"],"allowedRoleIds":["ID"]}}.',
    "Disable Discord by setting discord.binding to explicit null. Never unset this key; null is the durable disabled-state marker.",
    "Adding another Forum means preserving the existing object and adding a distinct forumBindings entry. Replacing the bot, guild, or Forum means proposing the complete replacement object. Disabling means setting discord.binding to null. Durable Tasks and native Agent sessions remain in Main; Discord thread identities are not silently migrated.",
    "A secure Discord token intake returns secret://main/ALIAS. Store only ALIAS as botTokenAlias after removing the exact secret://main/ prefix. Never put the token or the secret:// reference itself in discord.binding. Applying, replacing, or disabling Discord requires the normal owner Approval; the runtime validates the credential and installation and restores the previous binding if activation fails.",
    "Approving a Configuration Approval executes that exact proposal immediately; the owner does not need to return to chat to trigger apply. If the owner says an Approval was completed, inspect current durable configuration first. Never submit apply again merely because the owner said approved. If inspection does not show the requested value, ask the owner to inspect that Approval's execution status and error instead of creating a replacement Approval blindly.",
    "Guide Discord setup in dependency order: inspect the current binding; guide the owner through creating or selecting an Application and bot in the Discord Developer Portal; confirm the server has Community enabled and a Forum channel; confirm the required Gateway intents and least-privilege bot permissions; collect only missing non-secret Application, bot user, Guild, Forum, workflow tag, owner, and optional role IDs; direct token entry to the secure token form; then propose the complete discord.binding for Approval. Discord-side browser actions remain owner actions, so never claim you completed them.",
    "Assume the owner may be creating a Discord bot for the first time. Use reassuring plain language, answer in the owner's language when it is evident, and define Application, bot, server or Guild, Forum, tag, and ID when each term first appears.",
    "Before giving setup steps, explain the outcome: one Discord Forum post becomes one OpenDelegate Task, replies continue the same Task, and the Forum list plus workflow tags form a task dashboard. Inspect first, then summarize what is already connected and what is still missing without leading with raw configuration fields.",
    "After inspection, give a brief roadmap of only the missing stages and clearly label the single current stage. Explain only that current stage in detail: where to go, what to do, why it is needed, how to verify it worked, and what, if anything, to send back to OpenDelegate. End with an explicit completion check and wait for the owner to confirm before advancing to the next stage. Do not present an unexplained wall of identifiers or a full manual in one response.",
    "Use Discord's current setup boundaries accurately: create or select the Application in the Developer Portal; configure the bot and privileged MESSAGE_CONTENT toggle on its Bot page; configure Guild Install scopes and least-privilege permissions on Installation or OAuth2; open the resulting install link, add the bot to the selected server, and verify that it appears in the member list and can see the Forum; enable Community in Discord Server Settings before creating a Forum; create the workflow tags intake, running, waiting, review, done, and failed; then enable Developer Mode in User Settings > Advanced and use Copy ID for the required non-secret IDs. Explain that IDs are safe to provide in chat but the bot token is a secret and must only use the secure token form.",
    "For Discord, explain that the OpenDelegate runtime uses the GUILDS, GUILD_MESSAGES, and MESSAGE_CONTENT Gateway intents, while only privileged MESSAGE_CONTENT needs the Developer Portal toggle for an unverified personal bot. Prefer VIEW_CHANNEL, READ_MESSAGE_HISTORY, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS, ATTACH_FILES, and MANAGE_THREADS; explain the reason for each permission and request MANAGE_CHANNELS only when OpenDelegate must create or configure the Forum.",
    "SQLite is the default and needs no database URI. Treat external PostgreSQL as an explicit owner opt-in. Before proposing database.adapter or database.uri-ref, explain that storing a URI or changing durable Configuration does not migrate the live database: the owner needs the supported backup/restore and service reconfiguration path. Never claim that the active database changed without a deterministic runtime receipt that proves it.",
    "Mutation claims must reference the exact successful durable receipt returned by OpenDelegate. Failed tool results prove that no requested mutation occurred.",
    "Never request or repeat a raw secret, Discord bot token, private key, enrollment grant, database URI, or Agent credential. Direct the owner to the platform secret-store flow instead.",
    "Device assessment is a separate deterministic Admin action. You cannot run it with any of your six tools and must never claim that you did.",
    input.deviceObservation === undefined
      ? "No deterministic Device observation was supplied. Ask the owner to run Assess device before making capability recommendations."
      : `The following bounded Device observation is authoritative for this turn. Explain it when useful, but do not invent missing capabilities: ${JSON.stringify(input.deviceObservation)}`,
    "There is no generic shell, file-edit, network, or arbitrary tool in this conversation.",
    'You may attach only these context-sensitive suggestedActions to a final response: "guide-discord", "guide-external-postgresql", "ingest-discord-bot-token", and "ingest-database-uri". These are owner-facing UI suggestions, not proof that any configuration changed.',
    'Offer "guide-discord" or "guide-external-postgresql" only when that next conversation is relevant. Offer a secure ingest action only when its credential is the actual next missing value after explaining prerequisites. Never offer a Main-service action for a Worker Device.',
    "Do not expose private chain-of-thought.",
    'When finished, return one exact JSON object and no Markdown fence: {"schemaVersion":1,"type":"final","content":"owner-visible response","claimReceiptIds":["every successful apply or rollback receipt, and no other receipt"],"suggestedActions":["zero or more context-sensitive actions from the allowlist"]}.',
    "",
    `Target Device ID: ${input.deviceId}`,
    `Owner message: ${input.message}`,
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > maximumBytes) {
    throw unavailable(
      "The Configuration Agent message exceeds its prompt budget.",
      "CONFIGURATION_PROMPT_BUDGET_EXCEEDED",
    );
  }
  return prompt;
}

function buildConfigurationContinuationPrompt(
  prompt: string,
  messages: readonly ConfigurationAgentConversationMessageV1[],
  maximumBytes: number,
): string {
  const prefix = [
    "Native session recovery notice: the prior provider-native Configuration Agent session is unavailable.",
    "Briefly tell the owner that you recovered in a new native session. Accepted visible owner messages and completed Agent responses are durable and supplied below; provider-only hidden context may still be unavailable.",
    "Use the durable visible-conversation excerpt as context, but re-inspect durable configuration before proposing a change. Reconfirm any required value or choice that is absent from the excerpt.",
  ];
  const suffix = ["", "Complete current request:", prompt];
  const fixedBytes = Buffer.byteLength(
    [...prefix, "Durable visible conversation:", ...suffix].join("\n"),
    "utf8",
  );
  let remainingBytes = maximumBytes - fixedBytes;
  const selected: string[] = [];
  let omitted = 0;
  for (const message of [...messages].reverse()) {
    const line = JSON.stringify({ role: message.role, content: message.content });
    const bytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes > remainingBytes) {
      omitted += 1;
      continue;
    }
    selected.unshift(line);
    remainingBytes -= bytes;
  }
  const history =
    selected.length === 0
      ? [`No durable visible message fits the continuation budget; ${String(omitted)} omitted.`]
      : [
          ...selected,
          ...(omitted === 0 ? [] : [`${String(omitted)} older message(s) omitted by budget.`]),
        ];
  const continuationPrompt = [
    ...prefix,
    "Durable visible conversation:",
    ...history,
    ...suffix,
  ].join("\n");
  if (Buffer.byteLength(continuationPrompt, "utf8") > maximumBytes) {
    throw unavailable(
      "The Configuration Agent continuation exceeds its prompt budget.",
      "CONFIGURATION_CONTINUATION_PROMPT_BUDGET_EXCEEDED",
    );
  }
  return continuationPrompt;
}

function buildToolResultPrompt(
  result: ConfigurationAgentToolTurnResult,
  maximumBytes: number,
): string {
  const prompt = [
    "OpenDelegate executed the requested deterministic typed configuration tool.",
    "The following JSON is authoritative. A succeeded result is backed by the included durable receipt. A failed result made no requested configuration mutation.",
    JSON.stringify(result),
    "Continue with one typed tool JSON object, or return the exact final JSON object. Never invent or alter identifiers. The final claimReceiptIds must contain every successful apply or rollback receipt and no other receipt. suggestedActions may contain only the documented context-sensitive UI suggestions.",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > maximumBytes) {
    throw unavailable(
      "The Configuration Agent tool result exceeds its prompt budget.",
      "CONFIGURATION_TOOL_RESULT_PROMPT_BUDGET_EXCEEDED",
    );
  }
  return prompt;
}

function buildProposalCompletionPrompt(
  proposalIds: readonly string[],
  maximumBytes: number,
): string {
  const prompt = [
    "OpenDelegate rejected the premature final response because a durable Configuration proposal was created without entering its execution or Approval flow.",
    `Pending proposal IDs: ${proposalIds.join(", ")}`,
    "Continue with typed tools. Preview the exact proposal with diff, then call apply exactly once with its recorded proposal ID and revision. If policy returns CONFIGURATION_TOOL_APPROVAL_REQUIRED with an approvalId, that is the expected successful handoff to owner review. Return a final response only after that apply result. Never invent a replacement proposal or identifier.",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > maximumBytes) {
    throw unavailable(
      "The Configuration Agent proposal completion prompt exceeds its budget.",
      "CONFIGURATION_PROPOSAL_PROMPT_BUDGET_EXCEEDED",
    );
  }
  return prompt;
}

function configurationResponseLocaleInstruction(
  locale: ConfigurationAgentMessageInput["responseLocale"],
): string {
  const language =
    locale === "ko"
      ? "Korean"
      : locale === "ja"
        ? "Japanese"
        : locale === "fr"
          ? "French"
          : locale === "es"
            ? "Spanish"
            : locale === "zh-CN"
              ? "Simplified Chinese"
              : "English";
  return `Respond to the owner in ${language} (${locale ?? "en"}) even when the owner message is in another language. This controls only newly generated owner-visible prose. Preserve exact identifiers, provider-native model IDs, commands, code, configuration keys, and raw values; never translate or rewrite durable conversation history.`;
}

/**
 * Reads the one typed JSON object a Configuration Agent turn must return.
 *
 * The prompt demands exactly that object with nothing around it, but a
 * provider-native runner sometimes appends its own prose after it, which made a
 * correct typed request unusable. Recovering the object from the first `{`
 * through the last `}` keeps that turn usable. It does not relax the contract:
 * the caller still validates every key, type, and identifier, so text outside
 * the object cannot introduce a field or widen what the request may do. A
 * response holding anything other than one balanced object still fails closed.
 */
function parseSoleJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Fall through to the bounded single-object recovery below.
  }
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function parseConfigurationTurnResult(value: string | undefined): ConfigurationAgentTurnResult {
  if (value === undefined || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw unavailable(
      "The Configuration Agent returned an invalid public response.",
      "CONFIGURATION_AGENT_RESPONSE_INVALID",
    );
  }
  const parsed = parseSoleJsonObject(value);
  if (
    !isRecord(parsed) ||
    parsed["schemaVersion"] !== 1 ||
    (parsed["type"] !== "tool" && parsed["type"] !== "final")
  ) {
    throw unavailable(
      "The Configuration Agent returned an invalid public response.",
      "CONFIGURATION_AGENT_RESPONSE_INVALID",
    );
  }
  if (parsed["type"] === "final") {
    if (
      (!hasExactKeys(parsed, ["schemaVersion", "type", "content", "claimReceiptIds"]) &&
        !hasExactKeys(parsed, [
          "schemaVersion",
          "type",
          "content",
          "claimReceiptIds",
          "suggestedActions",
        ])) ||
      typeof parsed["content"] !== "string" ||
      !Array.isArray(parsed["claimReceiptIds"]) ||
      parsed["claimReceiptIds"].length > 32
    ) {
      throw unavailable(
        "The Configuration Agent returned an invalid public response.",
        "CONFIGURATION_AGENT_RESPONSE_INVALID",
      );
    }
    assertIdentifier(parsed["content"], "Configuration Agent response", 32_768);
    const claimReceiptIds = parsed["claimReceiptIds"].map((receiptId) => {
      assertIdentifier(receiptId, "Configuration receipt ID", 500);
      return receiptId;
    });
    if (new Set(claimReceiptIds).size !== claimReceiptIds.length) {
      throw unavailable(
        "The Configuration Agent returned duplicate mutation claims.",
        "CONFIGURATION_CLAIM_DUPLICATE",
      );
    }
    const suggestedActions =
      parsed["suggestedActions"] === undefined
        ? []
        : parseSuggestedActions(parsed["suggestedActions"]);
    return {
      schemaVersion: 1,
      type: "final",
      content: parsed["content"],
      claimReceiptIds,
      suggestedActions,
    };
  }
  if (!hasExactKeys(parsed, ["schemaVersion", "type", "toolCallId", "request"])) {
    throw unavailable(
      "The Configuration Agent returned an invalid typed tool request.",
      "CONFIGURATION_TOOL_REQUEST_INVALID",
    );
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
    throw unavailable(
      "The Configuration Agent returned an invalid typed tool request.",
      "CONFIGURATION_TOOL_REQUEST_INVALID",
    );
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
  throw unavailable(
    "The Configuration Agent returned an invalid typed tool request.",
    "CONFIGURATION_TOOL_REQUEST_INVALID",
  );
}

function parseConfigurationChanges(value: unknown): readonly ConfigurationChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw unavailable(
      "The Configuration Agent returned an invalid typed tool request.",
      "CONFIGURATION_TOOL_REQUEST_INVALID",
    );
  }
  return value.map((change) => {
    if (!isRecord(change) || (change["operation"] !== "set" && change["operation"] !== "unset")) {
      throw unavailable(
        "The Configuration Agent returned an invalid typed tool request.",
        "CONFIGURATION_TOOL_REQUEST_INVALID",
      );
    }
    const expectedKeys =
      change["operation"] === "set"
        ? ["operation", "key", "scope", "value"]
        : ["operation", "key", "scope"];
    if (!hasExactKeys(change, expectedKeys) || !isRecord(change["scope"])) {
      throw unavailable(
        "The Configuration Agent returned an invalid typed tool request.",
        "CONFIGURATION_TOOL_REQUEST_INVALID",
      );
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
    throw unavailable(
      "The Configuration Agent returned an invalid typed tool request.",
      "CONFIGURATION_TOOL_REQUEST_INVALID",
    );
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
    throw unavailable(
      "The Configuration Agent returned an invalid typed tool request.",
      "CONFIGURATION_TOOL_REQUEST_INVALID",
    );
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
      throw unavailable(
        "The Configuration Agent returned an invalid typed tool request.",
        "CONFIGURATION_TOOL_REQUEST_INVALID",
      );
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
      "CONFIGURATION_CLAIM_RECEIPT_MISMATCH",
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
    throw unavailable(
      "The Configuration Agent returned an invalid public response.",
      "CONFIGURATION_AGENT_RESPONSE_INVALID",
    );
  }
  return content;
}

function parseSuggestedActions(value: unknown): readonly ConfigurationAgentSuggestedActionV1[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw unavailable(
      "The Configuration Agent returned invalid suggested actions.",
      "CONFIGURATION_SUGGESTED_ACTION_INVALID",
    );
  }
  const actions = value.map((action): ConfigurationAgentSuggestedActionV1 => {
    if (
      action !== "guide-discord" &&
      action !== "guide-external-postgresql" &&
      action !== "ingest-discord-bot-token" &&
      action !== "ingest-database-uri"
    ) {
      throw unavailable(
        "The Configuration Agent returned invalid suggested actions.",
        "CONFIGURATION_SUGGESTED_ACTION_INVALID",
      );
    }
    return action;
  });
  if (new Set(actions).size !== actions.length) {
    throw unavailable(
      "The Configuration Agent returned duplicate suggested actions.",
      "CONFIGURATION_SUGGESTED_ACTION_DUPLICATE",
    );
  }
  return Object.freeze(actions);
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
    (!hasExactKeys(value["response"], ["messageId", "sessionId", "content", "occurredAt"]) &&
      !hasExactKeys(value["response"], [
        "messageId",
        "sessionId",
        "content",
        "suggestedActions",
        "occurredAt",
      ]) &&
      !hasExactKeys(value["response"], [
        "messageId",
        "sessionId",
        "content",
        "pendingApprovalId",
        "occurredAt",
      ]) &&
      !hasExactKeys(value["response"], [
        "messageId",
        "sessionId",
        "content",
        "suggestedActions",
        "pendingApprovalId",
        "occurredAt",
      ]))
  ) {
    throw unavailable(
      "The Configuration Agent response state is corrupt.",
      "CONFIGURATION_RESPONSE_STATE_CORRUPT",
    );
  }
  const response = value["response"];
  assertIdentifier(response["messageId"], "Message ID", 160);
  assertIdentifier(response["sessionId"], "Session ID", 160);
  assertIdentifier(response["content"], "Configuration Agent response", 32_768);
  if (response["suggestedActions"] !== undefined) {
    parseSuggestedActions(response["suggestedActions"]);
  }
  if (response["pendingApprovalId"] !== undefined) {
    assertIdentifier(response["pendingApprovalId"], "Approval ID", 160);
  }
  if (typeof response["occurredAt"] !== "string" || !isRfc3339Instant(response["occurredAt"])) {
    throw unavailable(
      "The Configuration Agent response state is corrupt.",
      "CONFIGURATION_RESPONSE_STATE_CORRUPT",
    );
  }
  return structuredClone(value) as unknown as ConfigurationResponseEventPayload;
}

function validateConversationExchangeEvent(
  event: StoredConfigurationConversationEvent,
): ConfigurationConversationExchangeEventPayload {
  if (
    !Number.isSafeInteger(event.streamVersion) ||
    event.streamVersion < 1 ||
    event.type !== CONFIGURATION_CONVERSATION_EXCHANGE_EVENT ||
    !isRecord(event.payload) ||
    !hasExactKeys(event.payload, [
      "schemaVersion",
      "operationKey",
      "requestDigest",
      "ownerMessage",
      "response",
    ]) ||
    event.payload["schemaVersion"] !== 1 ||
    typeof event.payload["operationKey"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(event.payload["operationKey"]) ||
    typeof event.payload["requestDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(event.payload["requestDigest"]) ||
    !isRecord(event.payload["ownerMessage"]) ||
    !hasExactKeys(event.payload["ownerMessage"], ["messageId", "role", "content", "occurredAt"])
  ) {
    throw unavailable(
      "The Configuration Chat history is corrupt.",
      "CONFIGURATION_HISTORY_CORRUPT",
    );
  }
  const ownerMessage = event.payload["ownerMessage"];
  assertIdentifier(ownerMessage["messageId"], "Configuration owner message ID", 160);
  if (ownerMessage["role"] !== "owner") {
    throw unavailable(
      "The Configuration Chat history is corrupt.",
      "CONFIGURATION_HISTORY_CORRUPT",
    );
  }
  assertIdentifier(ownerMessage["content"], "Configuration owner message", 8_192);
  if (
    typeof ownerMessage["occurredAt"] !== "string" ||
    !isRfc3339Instant(ownerMessage["occurredAt"])
  ) {
    throw unavailable(
      "The Configuration Chat history is corrupt.",
      "CONFIGURATION_HISTORY_CORRUPT",
    );
  }
  const response = validateResponseEventPayload({
    schemaVersion: 1,
    requestDigest: event.payload["requestDigest"],
    response: event.payload["response"],
  }).response;
  return {
    schemaVersion: 1,
    operationKey: event.payload["operationKey"],
    requestDigest: event.payload["requestDigest"],
    ownerMessage: structuredClone(ownerMessage) as ConfigurationAgentConversationMessageV1,
    response,
  };
}

function validateConversationOwnerMessageEvent(
  event: StoredConfigurationConversationEvent,
): ConfigurationConversationOwnerMessageEventPayload {
  if (
    !Number.isSafeInteger(event.streamVersion) ||
    event.streamVersion < 1 ||
    event.type !== CONFIGURATION_CONVERSATION_OWNER_MESSAGE_EVENT ||
    !isRecord(event.payload) ||
    !hasExactKeys(event.payload, [
      "schemaVersion",
      "operationKey",
      "requestDigest",
      "ownerMessage",
    ]) ||
    event.payload["schemaVersion"] !== 1 ||
    typeof event.payload["operationKey"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(event.payload["operationKey"]) ||
    typeof event.payload["requestDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(event.payload["requestDigest"]) ||
    !isRecord(event.payload["ownerMessage"]) ||
    !hasExactKeys(event.payload["ownerMessage"], ["messageId", "role", "content", "occurredAt"])
  ) {
    throw unavailable(
      "The Configuration Chat history is corrupt.",
      "CONFIGURATION_HISTORY_CORRUPT",
    );
  }
  const ownerMessage = event.payload["ownerMessage"];
  assertIdentifier(ownerMessage["messageId"], "Configuration owner message ID", 160);
  if (ownerMessage["role"] !== "owner") {
    throw unavailable(
      "The Configuration Chat history is corrupt.",
      "CONFIGURATION_HISTORY_CORRUPT",
    );
  }
  assertIdentifier(ownerMessage["content"], "Configuration owner message", 8_192);
  if (
    typeof ownerMessage["occurredAt"] !== "string" ||
    !isRfc3339Instant(ownerMessage["occurredAt"])
  ) {
    throw unavailable(
      "The Configuration Chat history is corrupt.",
      "CONFIGURATION_HISTORY_CORRUPT",
    );
  }
  return {
    schemaVersion: 1,
    operationKey: event.payload["operationKey"],
    requestDigest: event.payload["requestDigest"],
    ownerMessage: structuredClone(ownerMessage) as ConfigurationAgentConversationMessageV1,
  };
}

function projectConversationTurns(
  events: readonly StoredConfigurationConversationEvent[],
): readonly ConfigurationConversationTurn[] {
  const turns: ConfigurationConversationTurn[] = [];
  const indexes = new Map<string, number>();
  for (const event of events) {
    const projected:
      | ConfigurationConversationExchangeEventPayload
      | ConfigurationConversationOwnerMessageEventPayload =
      event.type === CONFIGURATION_CONVERSATION_OWNER_MESSAGE_EVENT
        ? validateConversationOwnerMessageEvent(event)
        : validateConversationExchangeEvent(event);
    const existingIndex = indexes.get(projected.operationKey);
    if (existingIndex === undefined) {
      indexes.set(projected.operationKey, turns.length);
      turns.push({
        operationKey: projected.operationKey,
        requestDigest: projected.requestDigest,
        ownerMessage: structuredClone(projected.ownerMessage),
        ...(isConversationExchange(projected)
          ? { response: structuredClone(projected.response) }
          : {}),
      });
      continue;
    }
    const existing = turns[existingIndex];
    if (
      existing === undefined ||
      existing.requestDigest !== projected.requestDigest ||
      JSON.stringify(existing.ownerMessage) !== JSON.stringify(projected.ownerMessage) ||
      !isConversationExchange(projected) ||
      existing.response !== undefined
    ) {
      throw unavailable(
        "The Configuration Chat history is corrupt.",
        "CONFIGURATION_HISTORY_CORRUPT",
      );
    }
    turns[existingIndex] = {
      ...existing,
      response: structuredClone(projected.response),
    };
  }
  return turns;
}

function isConversationExchange(
  event:
    | ConfigurationConversationExchangeEventPayload
    | ConfigurationConversationOwnerMessageEventPayload,
): event is ConfigurationConversationExchangeEventPayload {
  return "response" in event;
}

function findConversationExchange(
  events: readonly StoredConfigurationConversationEvent[],
  operationKey: string,
): ConfigurationConversationExchangeEventPayload | undefined {
  return events
    .filter((event) => event.type === CONFIGURATION_CONVERSATION_EXCHANGE_EVENT)
    .map((event) => validateConversationExchangeEvent(event))
    .find((exchange) => exchange.operationKey === operationKey);
}

function findConversationOwnerMessage(
  events: readonly StoredConfigurationConversationEvent[],
  operationKey: string,
): ConfigurationConversationTurn | undefined {
  return projectConversationTurns(events).find((turn) => turn.operationKey === operationKey);
}

function validateToolAttemptEventPayload(
  value: unknown,
): StoredConfigurationToolAttemptEventPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "requestDigest", "toolOperationId", "tool"]) ||
    (value["schemaVersion"] !== 1 && value["schemaVersion"] !== 2) ||
    typeof value["requestDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value["requestDigest"])
  ) {
    throw unavailable(
      "The Configuration Agent tool-attempt state is corrupt.",
      "CONFIGURATION_TOOL_ATTEMPT_STATE_CORRUPT",
    );
  }
  assertIdentifier(value["toolOperationId"], "Configuration tool operation ID", 160);
  if (
    value["tool"] !== "inspect" &&
    value["tool"] !== "validate" &&
    value["tool"] !== "propose" &&
    value["tool"] !== "diff" &&
    value["tool"] !== "apply" &&
    value["tool"] !== "rollback"
  ) {
    throw unavailable(
      "The Configuration Agent tool-attempt state is corrupt.",
      "CONFIGURATION_TOOL_ATTEMPT_STATE_CORRUPT",
    );
  }
  return structuredClone(value) as unknown as StoredConfigurationToolAttemptEventPayload;
}

function validateContinuationReservationEventPayload(
  value: unknown,
): ConfigurationContinuationReservationEventPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "requestDigest"]) ||
    value["schemaVersion"] !== 1 ||
    typeof value["requestDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value["requestDigest"])
  ) {
    throw unavailable(
      "The Configuration Agent continuation boundary is corrupt.",
      "CONFIGURATION_CONTINUATION_CORRUPT",
    );
  }
  return structuredClone(value) as unknown as ConfigurationContinuationReservationEventPayload;
}

function isReplayUnsafeConfigurationTool(
  tool: ConfigurationToolRequest["tool"],
): tool is "propose" | "apply" | "rollback" {
  return tool === "propose" || tool === "apply" || tool === "rollback";
}

function validateInput(input: ConfigurationAgentMessageInput): ConfigurationAgentMessageInput {
  if (!isRecord(input)) {
    throw unavailable(
      "The Configuration Agent request is invalid.",
      "CONFIGURATION_REQUEST_INVALID",
    );
  }
  assertIdentifier(input.deviceId, "Target Device ID", 160);
  assertIdentifier(input.principalId, "Principal ID", 160);
  assertIdentifier(input.idempotencyKey, "Idempotency key", 160);
  assertIdentifier(input.message, "Owner message", 8_192);
  if (
    input.responseLocale !== undefined &&
    input.responseLocale !== "en" &&
    input.responseLocale !== "es" &&
    input.responseLocale !== "fr" &&
    input.responseLocale !== "ja" &&
    input.responseLocale !== "ko" &&
    input.responseLocale !== "zh-CN"
  ) {
    throw unavailable(
      "The Configuration Agent response locale is invalid.",
      "CONFIGURATION_RESPONSE_LOCALE_INVALID",
    );
  }
  const deviceObservation =
    input.deviceObservation === undefined
      ? undefined
      : validateDeviceObservation(input.deviceObservation);
  return {
    deviceId: input.deviceId,
    principalId: input.principalId,
    idempotencyKey: input.idempotencyKey,
    message: input.message,
    ...(input.responseLocale === undefined ? {} : { responseLocale: input.responseLocale }),
    ...(deviceObservation === undefined ? {} : { deviceObservation }),
  };
}

function validateDeviceObservation(
  value: ConfigurationAgentMessageInput["deviceObservation"],
): NonNullable<ConfigurationAgentMessageInput["deviceObservation"]> {
  if (
    !isRecord(value) ||
    (value.osFamily !== "linux" && value.osFamily !== "macos" && value.osFamily !== "windows") ||
    (value.role !== "main" && value.role !== "worker") ||
    (value.knowledgeHealth !== "healthy" &&
      value.knowledgeHealth !== "degraded" &&
      value.knowledgeHealth !== "unknown") ||
    !Array.isArray(value.capabilities) ||
    !Array.isArray(value.agentAdapters)
  ) {
    throw unavailable(
      "The Device observation supplied to Configuration Agent is invalid.",
      "CONFIGURATION_OBSERVATION_INVALID",
    );
  }
  const observedAtMs = optionalObservationTime(value.observedAtMs);
  assertIdentifier(value.name, "Observed Device name", 256);
  assertIdentifier(value.platformRelease, "Observed platform release", 256);
  assertIdentifier(value.architecture, "Observed architecture", 256);
  const capabilities = value.capabilities.map((capability) =>
    sanitizeObservedCapability(capability),
  );
  const agentAdapters = value.agentAdapters.map((adapter) => sanitizeObservedAgentAdapter(adapter));
  if (
    (value.agentExecutionProfile !== undefined &&
      !isAgentExecutionProfile(value.agentExecutionProfile)) ||
    (value.coordinatorAgentExecutionProfile !== undefined &&
      !isAgentExecutionProfile(value.coordinatorAgentExecutionProfile))
  ) {
    throw unavailable(
      "The Device Agent Execution Profile observation is invalid.",
      "CONFIGURATION_OBSERVED_PROFILE_INVALID",
    );
  }
  const sanitized: NonNullable<ConfigurationAgentMessageInput["deviceObservation"]> = {
    name: value.name,
    osFamily: value.osFamily,
    platformRelease: value.platformRelease,
    architecture: value.architecture,
    role: value.role,
    ...(observedAtMs === undefined ? {} : { observedAtMs }),
    capabilities,
    agentAdapters,
    ...(value.agentExecutionProfile === undefined
      ? {}
      : { agentExecutionProfile: structuredClone(value.agentExecutionProfile) }),
    ...(value.coordinatorAgentExecutionProfile === undefined
      ? {}
      : {
          coordinatorAgentExecutionProfile: structuredClone(value.coordinatorAgentExecutionProfile),
        }),
    knowledgeHealth: value.knowledgeHealth,
  };
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > 64 * 1024) {
    throw unavailable(
      "The Device observation supplied to Configuration Agent is too large.",
      "CONFIGURATION_OBSERVATION_TOO_LARGE",
    );
  }
  return sanitized;
}

function sanitizeObservedCapability(
  value: unknown,
): NonNullable<ConfigurationAgentMessageInput["deviceObservation"]>["capabilities"][number] {
  if (
    !isRecord(value) ||
    (value.verification !== "detected" &&
      value.verification !== "verified" &&
      value.verification !== "degraded" &&
      value.verification !== "unavailable" &&
      value.verification !== "disabled") ||
    (value.evidenceSource !== undefined &&
      value.evidenceSource !== "agent-adapter" &&
      value.evidenceSource !== "capability-probe" &&
      value.evidenceSource !== "workspace-registry") ||
    (value.blockedBy !== undefined && value.blockedBy !== "session-helper-absent")
  ) {
    throw unavailable(
      "The Device capability observation is invalid.",
      "CONFIGURATION_OBSERVED_CAPABILITY_INVALID",
    );
  }
  const observedAtMs = optionalObservationTime(value.observedAtMs);
  assertIdentifier(value.name, "Observed capability name", 256);
  if (value.version !== undefined) {
    assertIdentifier(value.version, "Observed capability version", 256);
  }
  return {
    name: value.name,
    verification: value.verification,
    ...(observedAtMs === undefined ? {} : { observedAtMs }),
    ...(value.evidenceSource === undefined ? {} : { evidenceSource: value.evidenceSource }),
    ...(value.version === undefined ? {} : { version: value.version }),
    ...(value.blockedBy === undefined ? {} : { blockedBy: value.blockedBy }),
  };
}

function sanitizeObservedAgentAdapter(
  value: unknown,
): NonNullable<ConfigurationAgentMessageInput["deviceObservation"]>["agentAdapters"][number] {
  if (
    !isRecord(value) ||
    (value.provider !== "codex" &&
      value.provider !== "claude" &&
      value.provider !== "generic-command") ||
    (value.readiness !== "ready" &&
      value.readiness !== "degraded" &&
      value.readiness !== "unavailable") ||
    (value.compatibility !== "tested" &&
      value.compatibility !== "compatible" &&
      value.compatibility !== "untested" &&
      value.compatibility !== "incompatible") ||
    (value.blockedBy !== undefined &&
      value.blockedBy !== "provider-home-unavailable" &&
      value.blockedBy !== "executable-unavailable" &&
      value.blockedBy !== "authentication-required" &&
      value.blockedBy !== "version-unsupported" &&
      value.blockedBy !== "platform-incompatible" &&
      value.blockedBy !== "probe-failed") ||
    typeof value.observedAtMs !== "number" ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 0
  ) {
    throw unavailable(
      "The Device Agent Adapter observation is invalid.",
      "CONFIGURATION_OBSERVED_ADAPTER_INVALID",
    );
  }
  assertIdentifier(value.adapterId, "Observed Agent Adapter ID", 160);
  if (value.version !== undefined) {
    assertIdentifier(value.version, "Observed Agent Adapter version", 256);
  }
  const modelCatalogObservedAtMs = optionalObservationTime(value.modelCatalogObservedAtMs);
  const models = value.models === undefined ? undefined : sanitizeObservedAgentModels(value.models);
  if ((modelCatalogObservedAtMs === undefined) !== (models === undefined)) {
    throw unavailable(
      "The Device Agent model catalog observation is incomplete.",
      "CONFIGURATION_OBSERVED_CATALOG_INCOMPLETE",
    );
  }
  return {
    provider: value.provider,
    adapterId: value.adapterId,
    readiness: value.readiness,
    compatibility: value.compatibility,
    ...(value.blockedBy === undefined ? {} : { blockedBy: value.blockedBy }),
    ...(value.version === undefined ? {} : { version: value.version }),
    observedAtMs: value.observedAtMs,
    ...(modelCatalogObservedAtMs === undefined
      ? {}
      : { modelCatalogObservedAtMs, models: models! }),
  };
}

function sanitizeObservedAgentModels(
  value: unknown,
): NonNullable<
  NonNullable<
    ConfigurationAgentMessageInput["deviceObservation"]
  >["agentAdapters"][number]["models"]
> {
  if (!Array.isArray(value) || value.length > 128) {
    throw unavailable(
      "The Device Agent model catalog is invalid.",
      "CONFIGURATION_OBSERVED_CATALOG_INVALID",
    );
  }
  const seen = new Set<string>();
  return value.map((model) => {
    if (!isRecord(model)) {
      throw unavailable(
        "The Device Agent model catalog is invalid.",
        "CONFIGURATION_OBSERVED_CATALOG_INVALID",
      );
    }
    assertIdentifier(model.modelId, "Observed Agent model ID", 256);
    assertIdentifier(model.displayName, "Observed Agent model display name", 256);
    if (seen.has(model.modelId)) {
      throw unavailable(
        "The Device Agent model catalog contains duplicate IDs.",
        "CONFIGURATION_OBSERVED_CATALOG_DUPLICATE",
      );
    }
    seen.add(model.modelId);
    if (model.isDefault !== undefined && typeof model.isDefault !== "boolean") {
      throw unavailable(
        "The Device Agent model default marker is invalid.",
        "CONFIGURATION_OBSERVED_CATALOG_DEFAULT_INVALID",
      );
    }
    const supportedEfforts =
      model.supportedEfforts === undefined
        ? undefined
        : sanitizeObservedEfforts(model.supportedEfforts);
    return {
      modelId: model.modelId,
      displayName: model.displayName,
      ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
      ...(supportedEfforts === undefined ? {} : { supportedEfforts }),
    };
  });
}

function sanitizeObservedEfforts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw unavailable(
      "The Device Agent model effort catalog is invalid.",
      "CONFIGURATION_OBSERVED_EFFORT_INVALID",
    );
  }
  const efforts = value.map((effort) => {
    assertIdentifier(effort, "Observed Agent model effort", 160);
    return effort;
  });
  if (new Set(efforts).size !== efforts.length) {
    throw unavailable(
      "The Device Agent model effort catalog contains duplicates.",
      "CONFIGURATION_OBSERVED_EFFORT_DUPLICATE",
    );
  }
  return efforts;
}

function optionalObservationTime(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw unavailable(
      "The Device observation time is invalid.",
      "CONFIGURATION_OBSERVATION_TIME_INVALID",
    );
  }
  return value;
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
  return unavailable(
    detail,
    error instanceof AgentAdapterError
      ? safeDiagnosticCode(error.code, "CONFIGURATION_AGENT_ADAPTER_FAILED")
      : "CONFIGURATION_ADAPTER_FAILURE_UNTYPED",
  );
}

function safeDiagnosticCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(value) ? value : fallback;
}

/**
 * Every unavailability carries a stable diagnostic code. The owner-facing
 * failure message is deliberately generic, so the code is the only durable
 * handle on which internal boundary refused the request.
 */
function unavailable(message: string, diagnosticCode: string): ConfigurationAgentPortError {
  return new ConfigurationAgentPortError(
    "CONFIGURATION_AGENT_UNAVAILABLE",
    message,
    diagnosticCode,
  );
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

function conversationStreamId(targetDeviceId: string, adapterId: string): string {
  return `configuration-conversation:${digest(`${targetDeviceId}\u0000${adapterId}`).slice(
    "sha256:".length,
  )}`;
}

function configurationTaskId(targetDeviceId: string): string {
  return `configuration:${targetDeviceId}`;
}

function responseStreamId(operationKey: string): string {
  return `configuration-response:${operationKey.slice("sha256:".length)}`;
}

function toolAttemptStreamId(operationKey: string): string {
  return `configuration-tool-attempt:${operationKey.slice("sha256:".length)}`;
}

function continuationReservationStreamId(operationKey: string): string {
  return `configuration-continuation:${operationKey.slice("sha256:".length)}`;
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
    throw unavailable(`${label} is invalid.`, "CONFIGURATION_IDENTIFIER_INVALID");
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
