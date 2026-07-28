import { createHash, randomUUID } from "node:crypto";

import {
  DISCORD_API_VERSION,
  DISCORD_GATEWAY_INTENTS,
  type DiscordApiPort,
  type DiscordClock,
  type DiscordDiagnostic,
  type DiscordForumAdapterConfig,
  type DiscordForumAdapterOptions,
  type DiscordGatewayConnection,
  type DiscordGatewayCursor,
  type DiscordGatewayDispatch,
  type DiscordInboundRecord,
  type DiscordInstallationStatus,
  type DiscordInteraction,
  type DiscordMessage,
  type DiscordOutboxAction,
  type DiscordOutboxItem,
  type DiscordStateRepository,
  type DiscordTaskBinding,
  type DiscordTaskPort,
  type DiscordThread,
  type TaskChannelProjection,
} from "./contracts.ts";
import { DiscordAdapterError, DiscordApiError } from "./errors.ts";
import {
  renderInteractionResult,
  renderResolvedOwnerPrompt,
  renderStatusPanel,
  renderTaskUpdate,
  workflowStatusForTaskState,
} from "./presentation.ts";
import { redactDiscordSecrets } from "./redaction.ts";

const REQUIRED_INTENTS = ["GUILDS", "GUILD_MESSAGES", "MESSAGE_CONTENT"] as const;
const REQUIRED_PERMISSIONS = [
  "ATTACH_FILES",
  "MANAGE_THREADS",
  "READ_MESSAGE_HISTORY",
  "SEND_MESSAGES",
  "SEND_MESSAGES_IN_THREADS",
  "VIEW_CHANNEL",
] as const;
const OUTBOX_LEASE_MS = 30_000;
const MAX_RECONCILIATION_PAGES = 1_000;
const TYPING_REFRESH_INTERVAL_MS = 7_000;

interface OwnerMessageActivity {
  readonly threadId: string;
  readonly messageId: string;
  readonly lastTypingAtMs: number;
}

export class DiscordForumAdapter {
  readonly #config: DiscordForumAdapterConfig;
  readonly #repository: DiscordStateRepository;
  readonly #api: DiscordApiPort;
  readonly #tasks: DiscordTaskPort;
  readonly #clock: DiscordClock;
  readonly #gateway: DiscordForumAdapterOptions["gateway"];
  readonly #diagnostics: DiscordDiagnostic[] = [];
  readonly #threadWork = new Map<string, Promise<void>>();
  readonly #ownerActivityByTask = new Map<string, OwnerMessageActivity>();
  readonly #outboxOwner = `discord-adapter:${cryptoRandomSuffix()}`;
  #flushPromise: Promise<void> | undefined;
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #connection: DiscordGatewayConnection | undefined;
  #reconciliationPending = false;

  constructor(options: DiscordForumAdapterOptions) {
    validateConfig(options.config);
    this.#config = frozenClone(options.config);
    this.#repository = options.repository;
    this.#api = options.api;
    this.#tasks = options.tasks;
    this.#clock = options.clock;
    this.#gateway = options.gateway;
  }

  async verifyInstallation(): Promise<DiscordInstallationStatus> {
    const issues: string[] = [];
    try {
      const probe = await this.#api.probeInstallation({
        applicationId: this.#config.applicationId,
        guildId: this.#config.guildId,
        forumChannelIds: forumChannelIds(this.#config),
      });
      if (probe.applicationId !== this.#config.applicationId) {
        issues.push("The connected Discord Application does not match the configured Application.");
      }
      if (probe.botUserId !== this.#config.botUserId) {
        issues.push("The connected Discord bot identity does not match the configured bot.");
      }
      if (probe.guildId !== this.#config.guildId) {
        issues.push("The connected Discord guild does not match the approved guild.");
      }
      if (!probe.guildFeatures.includes("COMMUNITY")) {
        issues.push("The approved guild is not Community-enabled.");
      }
      for (const intent of REQUIRED_INTENTS) {
        if (!probe.enabledIntents.includes(intent)) {
          issues.push(`The ${intent} Gateway intent is not enabled.`);
        }
      }
      for (const configuredForum of this.#config.forumBindings) {
        const forumChannelId = configuredForum.channelId;
        const forum = probe.forums.find((candidate) => candidate.channelId === forumChannelId);
        if (forum === undefined) {
          issues.push(`Channel ${forumChannelId} was not returned by Discord.`);
          continue;
        }
        if (forum.channelType !== 15) {
          issues.push(`Channel ${forumChannelId} is not a Discord Forum.`);
        } else {
          const missingTags = Object.values(configuredForum.workflowTagIds).filter(
            (tagId) => !forum.availableTagIds.includes(tagId),
          );
          if (missingTags.length > 0) {
            issues.push(
              `Channel ${forumChannelId} lacks configured workflow tags: ${missingTags.join(", ")}.`,
            );
          }
        }
        const missing = REQUIRED_PERMISSIONS.filter(
          (permission) => !forum.permissions.includes(permission),
        );
        if (missing.length > 0) {
          issues.push(`Channel ${forumChannelId} lacks permissions: ${missing.join(", ")}.`);
        }
      }
    } catch (error) {
      this.#recordDiagnostic("discord.installation_probe_failed", {
        error: errorText(error),
      });
      issues.push("Discord installation could not be verified.");
    }
    return Object.freeze({
      ready: issues.length === 0,
      apiVersion: DISCORD_API_VERSION,
      gatewayIntentBitfield: DISCORD_GATEWAY_INTENTS,
      issues: Object.freeze(issues),
    });
  }

  async start(): Promise<void> {
    if (this.#connection !== undefined) {
      return;
    }
    if (this.#startPromise === undefined) {
      this.#startPromise = this.#startLiveDelivery().finally(() => {
        this.#startPromise = undefined;
      });
    }
    return this.#startPromise;
  }

  async #startLiveDelivery(): Promise<void> {
    await this.#closePromise;
    if (this.#gateway === undefined) {
      throw new DiscordAdapterError(
        "CONFIG_INVALID",
        "A Discord Gateway port is required to start live delivery.",
      );
    }
    const status = await this.verifyInstallation();
    if (!status.ready) {
      throw new DiscordAdapterError(
        "CONFIG_INVALID",
        `Discord installation is not ready: ${status.issues.join(" ")}`,
      );
    }
    const resume = await this.#repository.getGatewayCursor();
    const connection = await this.#gateway.connect({
      apiVersion: DISCORD_API_VERSION,
      intentBitfield: DISCORD_GATEWAY_INTENTS,
      resume,
      onDispatch: async (dispatch) => this.handleGatewayDispatch(dispatch),
      onSessionEstablished: async (session) => {
        await this.#repository.saveGatewayCursor({
          ...session,
          updatedAtMs: this.#clock.nowMs(),
        });
      },
      onReconcileRequired: async () => this.reconcile(),
    });
    try {
      await this.reconcile();
      this.#connection = connection;
    } catch (error) {
      try {
        await connection.close();
      } catch {
        // Preserve the reconciliation failure that prevented safe startup.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closePromise = this.#closeLiveDelivery().finally(() => {
        this.#closePromise = undefined;
      });
    }
    return this.#closePromise;
  }

  async #closeLiveDelivery(): Promise<void> {
    await this.#startPromise?.catch(() => undefined);
    const connection = this.#connection;
    this.#connection = undefined;
    await connection?.close();
  }

  async handleGatewayDispatch(dispatch: DiscordGatewayDispatch): Promise<void> {
    validateDispatchEnvelope(dispatch);
    switch (dispatch.type) {
      case "MESSAGE_CREATE":
        await this.#handleMessage(dispatch.message);
        break;
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        await this.#withThread(dispatch.thread.id, async () => {
          await this.#handleThread(dispatch.thread);
        });
        break;
      case "THREAD_DELETE":
        if (
          dispatch.guildId === this.#config.guildId &&
          forumChannelIds(this.#config).includes(dispatch.parentId)
        ) {
          const binding = await this.#repository.getBindingByThread(dispatch.threadId);
          if (binding !== undefined) {
            await this.#repository.updateBinding(dispatch.threadId, {
              externalState: "deleted",
            });
          }
        }
        break;
      case "INTERACTION_CREATE":
        await this.#withThread(dispatch.interaction.channelId, async () => {
          await this.#handleInteraction(dispatch.interaction);
        });
        break;
    }
    await this.#saveCursor(dispatch);
    if (dispatch.type !== "INTERACTION_CREATE") {
      await this.flushOutbox();
    }
  }

  async reconcile(): Promise<void> {
    const threads = new Map<string, DiscordThread>();
    try {
      for (const thread of await this.#api.listActiveThreads(this.#config.guildId)) {
        if (this.#isApprovedThread(thread)) {
          threads.set(thread.id, thread);
        }
      }
      for (const forumChannelId of forumChannelIds(this.#config)) {
        let before: string | undefined;
        for (let pageNumber = 0; pageNumber < MAX_RECONCILIATION_PAGES; pageNumber += 1) {
          const page = await this.#api.listArchivedPublicThreads(forumChannelId, before);
          for (const thread of page.threads) {
            if (this.#isApprovedThread(thread)) {
              threads.set(thread.id, thread);
            }
          }
          if (!page.hasMore) {
            break;
          }
          if (page.nextBefore === undefined || page.nextBefore === before) {
            throw new DiscordApiError(
              "INVALID_RESPONSE",
              "Archived-thread pagination did not advance.",
            );
          }
          before = page.nextBefore;
          if (pageNumber === MAX_RECONCILIATION_PAGES - 1) {
            throw new DiscordApiError(
              "INVALID_RESPONSE",
              "Archived-thread reconciliation exceeded its page bound.",
            );
          }
        }
      }
      for (const thread of threads.values()) {
        await this.#withThread(thread.id, async () => {
          await this.#reconcileThread(thread);
        });
      }
      const knownBindings = await this.#repository.listBindings();
      for (const binding of knownBindings) {
        if (threads.has(binding.threadId)) {
          continue;
        }
        try {
          const thread = await this.#api.getThread(binding.threadId);
          if (this.#isApprovedThread(thread)) {
            await this.#withThread(thread.id, async () => {
              await this.#reconcileThread(thread);
            });
          }
        } catch (error) {
          if (error instanceof DiscordApiError && error.code === "NOT_FOUND") {
            await this.#repository.updateBinding(binding.threadId, {
              externalState: "deleted",
            });
            continue;
          }
          if (error instanceof DiscordApiError && error.code === "FORBIDDEN") {
            await this.#repository.updateBinding(binding.threadId, {
              externalState: "inaccessible",
            });
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      this.#recordDiagnostic("discord.reconciliation_failed", { error: errorText(error) });
      if (error instanceof DiscordApiError && error.code === "OFFLINE") {
        this.#reconciliationPending = true;
        return;
      }
      throw error;
    }
  }

  async reconcilePending(): Promise<void> {
    if (!this.#reconciliationPending) {
      return;
    }
    this.#reconciliationPending = false;
    await this.reconcile();
  }

  async publishTaskProjection(projection: TaskChannelProjection): Promise<void> {
    // Rendering validates all owner-visible fields and URLs before durable work is queued.
    renderStatusPanel(projection);
    const binding = await this.#repository.getBindingByTask(projection.taskId);
    if (binding === undefined) {
      throw new DiscordAdapterError("PROJECTION_INVALID", "The Task has no Discord Forum binding.");
    }
    await this.#refreshOwnerActivity(projection, binding);
    const projectionDigest = digestValue(projection);
    const ownerMessageCompletion = await this.#ownerMessageCompletion(projection, binding);
    const panelRequestKey = `${projectionDigest}:02-panel`;
    await this.#enqueueOutbox(`${projectionDigest}:01-tags`, {
      kind: "sync-tags",
      taskId: projection.taskId,
      state: projection.state,
    });
    await this.#enqueueOutbox(panelRequestKey, {
      kind: "upsert-status-panel",
      taskId: projection.taskId,
      projection: frozenClone(projection),
    });
    if (projection.significance !== "status") {
      const sourceEventId = projection.sourceEventId;
      if (sourceEventId === undefined) {
        throw new DiscordAdapterError(
          "PROJECTION_INVALID",
          "A significant chronological Task update requires a stable source event ID.",
        );
      }
      const priorUpdateRequestKey = await this.#significantUpdateRequestKey(projection);
      const updateRequestKey =
        priorUpdateRequestKey ??
        `${digestValue({
          taskId: projection.taskId,
          sourceEventId,
          significance: projection.significance,
        })}:03-update`;
      if (priorUpdateRequestKey === undefined) {
        await this.#enqueueOutbox(updateRequestKey, {
          kind: "post-task-update",
          taskId: projection.taskId,
          projection: chronologicalProjection(projection),
        });
      }
      if (ownerMessageCompletion !== undefined) {
        await this.#enqueueOwnerMessageCompletion(
          projection,
          ownerMessageCompletion,
          updateRequestKey,
        );
      }
    } else if (ownerMessageCompletion !== undefined) {
      await this.#enqueueOwnerMessageCompletion(
        projection,
        ownerMessageCompletion,
        panelRequestKey,
      );
    }
  }

  async createTaskThread(projection: TaskChannelProjection): Promise<DiscordTaskBinding> {
    renderStatusPanel(projection);
    let result: DiscordTaskBinding | undefined;
    await this.#withThread(`outbound-task:${projection.taskId}`, async () => {
      const existing = await this.#repository.getBindingByTask(projection.taskId);
      if (existing !== undefined) {
        result = existing;
        return;
      }
      const forum = this.#config.forumBindings[0];
      if (forum === undefined) {
        throw new DiscordAdapterError(
          "CONFIG_INVALID",
          "No configured Discord Forum can present the Task.",
        );
      }
      const name = outboundTaskThreadName(projection);
      const content = outboundTaskStarterContent(projection);
      const recovered = await this.#findOutboundTaskThread(forum.channelId, name, content);
      const created =
        recovered ??
        (await this.#api.createForumPost({
          forumChannelId: forum.channelId,
          requestKey: `outbound-task:${projection.taskId}`,
          name,
          content,
          appliedTagIds: [forum.workflowTagIds.intake],
        }));
      if (
        !this.#isApprovedThread(created.thread) ||
        created.thread.parentId !== forum.channelId ||
        created.thread.ownerId !== this.#config.botUserId ||
        created.starterMessage.id !== created.thread.id ||
        created.starterMessage.channelId !== created.thread.id ||
        created.starterMessage.guildId !== this.#config.guildId ||
        created.starterMessage.content !== content
      ) {
        throw new DiscordAdapterError(
          "PERSISTENCE_CONFLICT",
          "Discord returned an invalid outbound Forum Task.",
        );
      }
      result = await this.#repository.bindTask({
        guildId: created.thread.guildId,
        forumChannelId: created.thread.parentId,
        threadId: created.thread.id,
        starterMessageId: created.starterMessage.id,
        taskId: projection.taskId,
        externalState: "available",
        archived: created.thread.archived,
        locked: created.thread.locked,
      });
    });
    if (result === undefined) {
      throw new DiscordAdapterError(
        "PERSISTENCE_CONFLICT",
        "The outbound Forum Task binding was not recorded.",
      );
    }
    await this.publishTaskProjection(projection);
    return result;
  }

  async #findOutboundTaskThread(
    forumChannelId: string,
    name: string,
    content: string,
  ): Promise<
    | {
        readonly thread: DiscordThread;
        readonly starterMessage: DiscordMessage;
      }
    | undefined
  > {
    const candidates: DiscordThread[] = [];
    for (const thread of await this.#api.listActiveThreads(this.#config.guildId)) {
      if (
        thread.parentId === forumChannelId &&
        thread.ownerId === this.#config.botUserId &&
        thread.name === name
      ) {
        candidates.push(thread);
      }
    }
    let before: string | undefined;
    for (let page = 0; page < MAX_RECONCILIATION_PAGES; page += 1) {
      const archived = await this.#api.listArchivedPublicThreads(forumChannelId, before);
      for (const thread of archived.threads) {
        if (thread.ownerId === this.#config.botUserId && thread.name === name) {
          candidates.push(thread);
        }
      }
      if (!archived.hasMore) {
        break;
      }
      if (archived.nextBefore === undefined || archived.nextBefore === before) {
        throw new DiscordAdapterError(
          "PERSISTENCE_CONFLICT",
          "Discord outbound Task reconciliation did not advance.",
        );
      }
      before = archived.nextBefore;
    }
    const matches: {
      readonly thread: DiscordThread;
      readonly starterMessage: DiscordMessage;
    }[] = [];
    for (const thread of candidates) {
      try {
        const starterMessage = await this.#api.getMessage(thread.id, thread.id);
        if (starterMessage.content === content) {
          matches.push({ thread, starterMessage });
        }
      } catch (error) {
        if (!(error instanceof DiscordApiError && error.code === "NOT_FOUND")) {
          throw error;
        }
      }
    }
    if (matches.length > 1) {
      throw new DiscordAdapterError(
        "PERSISTENCE_CONFLICT",
        "Discord contains duplicate outbound Forum posts for one Task.",
      );
    }
    return matches[0];
  }

  async flushOutbox(): Promise<void> {
    if (this.#flushPromise !== undefined) {
      return this.#flushPromise;
    }
    this.#flushPromise = this.#drainOutbox().finally(() => {
      this.#flushPromise = undefined;
    });
    return this.#flushPromise;
  }

  async getDiagnostics(): Promise<readonly DiscordDiagnostic[]> {
    return Object.freeze(this.#diagnostics.map(frozenClone));
  }

  async #handleMessage(message: DiscordMessage): Promise<void> {
    if (
      message.guildId !== this.#config.guildId ||
      message.author.bot ||
      !this.#isAuthorized(message.author.id, message.author.roleIds)
    ) {
      return;
    }
    await this.#withThread(message.channelId, async () => {
      let thread: DiscordThread;
      try {
        thread = await this.#api.getThread(message.channelId);
      } catch (error) {
        if (error instanceof DiscordApiError && error.code === "FORBIDDEN") {
          return;
        }
        throw error;
      }
      if (!this.#isApprovedThread(thread)) {
        return;
      }
      await this.#ingestMessage(thread, message);
    });
  }

  async #handleThread(thread: DiscordThread): Promise<void> {
    if (!this.#isApprovedThread(thread)) {
      return;
    }
    const binding = await this.#repository.getBindingByThread(thread.id);
    if (binding !== undefined) {
      if (binding.externalState === "deleted") {
        return;
      }
      await this.#repository.updateBinding(thread.id, {
        archived: thread.archived,
        locked: thread.locked,
        externalState: "available",
      });
      return;
    }
    const starter = await this.#api.getMessage(thread.id, thread.id);
    if (!starter.author.bot && this.#isAuthorized(starter.author.id, starter.author.roleIds)) {
      await this.#ingestMessage(thread, starter);
    }
  }

  async #ingestMessage(thread: DiscordThread, message: DiscordMessage): Promise<void> {
    if (
      message.guildId !== this.#config.guildId ||
      message.channelId !== thread.id ||
      message.author.bot ||
      !this.#isAuthorized(message.author.id, message.author.roleIds)
    ) {
      return;
    }
    if (
      message.id !== thread.id &&
      message.content.trim().length === 0 &&
      message.attachments.length === 0
    ) {
      return;
    }
    const key = `discord-message:${message.id}`;
    const claim = await this.#repository.claimInbound({
      key,
      digest: digestValue({
        id: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        content: message.content,
        attachments: message.attachments,
      }),
      nowMs: this.#clock.nowMs(),
    });
    if (claim.outcome === "completed") {
      return;
    }
    let taskId: string;
    if (message.id === thread.id) {
      const objective =
        message.content.trim().length === 0
          ? `Discord Forum post: ${thread.name}`
          : message.content.trim();
      const created = await this.#tasks.createTask({
        principalId: `discord:${message.author.id}`,
        idempotencyKey: key,
        objective,
        completionCriteria: ["Complete the requested work and report the observable result."],
        constraints: [],
        selectedInputRefs: attachmentReferences(message),
        source: taskSource(thread, message),
      });
      taskId = created.taskId;
      await this.#repository.bindTask({
        guildId: thread.guildId,
        forumChannelId: thread.parentId,
        threadId: thread.id,
        starterMessageId: message.id,
        taskId: created.taskId,
        externalState: "available",
        archived: thread.archived,
        locked: thread.locked,
      });
    } else {
      const binding = await this.#ensureBinding(thread);
      if (binding === undefined) {
        return;
      }
      taskId = binding.taskId;
      await this.#tasks.appendTaskInput({
        taskId: binding.taskId,
        principalId: `discord:${message.author.id}`,
        idempotencyKey: key,
        message: replyMessage(message),
        selectedInputRefs: attachmentReferences(message),
        source: taskSource(thread, message),
      });
      await this.#enqueueOwnerPromptResolution(binding.taskId, key);
    }
    await this.#enqueueOutbox(`${key}:02-acknowledgement`, {
      kind: "acknowledge-owner-message",
      taskId,
      messageId: message.id,
    });
    await this.#repository.completeInbound({ key, nowMs: this.#clock.nowMs() });
  }

  async #enqueueOwnerPromptResolution(taskId: string, ownerMessageKey: string): Promise<void> {
    const outbox = await this.#repository.listOutbox();
    const resolvedPromptKeys = new Set(
      outbox
        .filter((item) => item.action.kind === "resolve-owner-prompt")
        .map((item) =>
          item.action.kind === "resolve-owner-prompt" ? item.action.promptRequestKey : "",
        ),
    );
    const latestPrompt = [...outbox]
      .reverse()
      .find(
        (item) =>
          item.delivered &&
          item.action.kind === "post-task-update" &&
          item.action.taskId === taskId &&
          item.action.projection.significance === "question" &&
          !resolvedPromptKeys.has(item.id),
      );
    if (latestPrompt === undefined || latestPrompt.action.kind !== "post-task-update") {
      return;
    }
    const sourceEventId = latestPrompt.action.projection.sourceEventId;
    const matchingPrompts = outbox.filter(
      (item) =>
        item.delivered &&
        item.action.kind === "post-task-update" &&
        item.action.taskId === taskId &&
        item.action.projection.significance === "question" &&
        !resolvedPromptKeys.has(item.id) &&
        (sourceEventId === undefined
          ? item.id === latestPrompt.id
          : item.action.projection.sourceEventId === sourceEventId),
    );
    for (const prompt of matchingPrompts) {
      if (prompt.action.kind !== "post-task-update") {
        continue;
      }
      await this.#enqueueOutbox(`${ownerMessageKey}:01-resolve-prompt:${digestValue(prompt.id)}`, {
        kind: "resolve-owner-prompt",
        taskId,
        promptRequestKey: prompt.id,
        projection: frozenClone(prompt.action.projection),
      });
    }
  }

  async #significantUpdateRequestKey(
    projection: TaskChannelProjection,
  ): Promise<string | undefined> {
    const sourceEventId = projection.sourceEventId;
    if (sourceEventId === undefined) {
      return undefined;
    }
    return (await this.#repository.listOutbox()).find(
      (item) =>
        item.action.kind === "post-task-update" &&
        item.action.taskId === projection.taskId &&
        item.action.projection.sourceEventId === sourceEventId &&
        item.action.projection.significance === projection.significance,
    )?.id;
  }

  async #ensureBinding(thread: DiscordThread): Promise<DiscordTaskBinding | undefined> {
    const existing = await this.#repository.getBindingByThread(thread.id);
    if (existing !== undefined) {
      return existing;
    }
    const starter = await this.#api.getMessage(thread.id, thread.id);
    await this.#ingestMessage(thread, starter);
    return this.#repository.getBindingByThread(thread.id);
  }

  async #handleInteraction(interaction: DiscordInteraction): Promise<void> {
    if (interaction.guildId !== this.#config.guildId || interaction.author.bot) {
      return;
    }
    const key = `discord-interaction:${interaction.id}`;
    const claim = await this.#repository.claimInbound({
      key,
      digest: digestValue({
        id: interaction.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: interaction.messageId,
        messageAuthorId: interaction.messageAuthorId,
        customId: interaction.customId,
        authorId: interaction.author.id,
      }),
      nowMs: this.#clock.nowMs(),
    });
    if (claim.outcome === "completed") {
      return;
    }
    let record: DiscordInboundRecord = claim.record;
    if (!record.acknowledged) {
      if (this.#clock.nowMs() - interaction.receivedAtMs > 2_500) {
        this.#recordDiagnostic("discord.interaction_ack_late", {
          interactionId: interaction.id,
          latencyMs: this.#clock.nowMs() - interaction.receivedAtMs,
        });
      }
      const deferred = await this.#api.deferInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        ephemeral: true,
      });
      record = await this.#repository.acknowledgeInbound({
        key,
        responseRef: deferred.responseRef,
        nowMs: this.#clock.nowMs(),
      });
    }
    if (record.responseRef === undefined) {
      throw new DiscordAdapterError(
        "PERSISTENCE_CONFLICT",
        "An acknowledged Discord interaction has no response reference.",
      );
    }
    if (!this.#isAuthorized(interaction.author.id, interaction.author.roleIds)) {
      await this.#finishDeferredInteraction(
        record.responseRef,
        "This Discord identity is not allowed to control OpenDelegate.",
        false,
      );
      await this.#repository.completeInbound({ key, nowMs: this.#clock.nowMs() });
      return;
    }
    const binding = await this.#repository.getBindingByThread(interaction.channelId);
    if (
      binding === undefined ||
      binding.externalState !== "available" ||
      interaction.messageAuthorId !== this.#config.botUserId
    ) {
      await this.#finishDeferredInteraction(
        record.responseRef,
        "This Task control is no longer available.",
        false,
      );
      await this.#repository.completeInbound({ key, nowMs: this.#clock.nowMs() });
      return;
    }
    const parsed = parseControl(interaction.customId);
    if (parsed === undefined) {
      await this.#finishDeferredInteraction(
        record.responseRef,
        "This Task control is not recognized.",
        false,
      );
      await this.#repository.completeInbound({ key, nowMs: this.#clock.nowMs() });
      return;
    }
    const principalId = `discord:${interaction.author.id}`;
    const action: DiscordOutboxAction =
      parsed.kind === "command"
        ? {
            kind: "task-command",
            taskId: binding.taskId,
            principalId,
            command: parsed.command,
            idempotencyKey: key,
            responseRef: record.responseRef,
          }
        : {
            kind: "approval-decision",
            taskId: binding.taskId,
            principalId,
            approvalId: parsed.approvalId,
            decision: parsed.decision,
            idempotencyKey: key,
            responseRef: record.responseRef,
          };
    await this.#enqueueOutbox(`${digestValue(action)}:interaction`, action);
    await this.#repository.completeInbound({ key, nowMs: this.#clock.nowMs() });
  }

  async #reconcileThread(thread: DiscordThread): Promise<void> {
    await this.#handleThread(thread);
    let binding = await this.#repository.getBindingByThread(thread.id);
    if (binding === undefined || binding.externalState === "deleted") {
      return;
    }
    let after = binding.lastReconciledMessageId;
    for (let pageNumber = 0; pageNumber < MAX_RECONCILIATION_PAGES; pageNumber += 1) {
      const pageStart = after;
      const page = await this.#api.listMessages(thread.id, after);
      for (const message of [...page.messages].sort(compareMessageSnowflakes)) {
        await this.#ingestMessage(thread, message);
        after = laterSnowflake(after, message.id);
      }
      if (!page.hasMore) {
        break;
      }
      if (page.nextAfter === undefined || page.nextAfter === pageStart) {
        throw new DiscordApiError("INVALID_RESPONSE", "Message pagination did not advance.");
      }
      after = page.nextAfter;
      if (pageNumber === MAX_RECONCILIATION_PAGES - 1) {
        throw new DiscordApiError(
          "INVALID_RESPONSE",
          "Message reconciliation exceeded its page bound.",
        );
      }
    }
    binding = await this.#repository.updateBinding(thread.id, {
      ...(after === undefined ? {} : { lastReconciledMessageId: after }),
      archived: thread.archived,
      locked: thread.locked,
      externalState: "available",
    });
    void binding;
  }

  async #refreshOwnerActivity(
    projection: TaskChannelProjection,
    binding: DiscordTaskBinding,
  ): Promise<void> {
    if (!keepsOwnerActivityOpen(projection.state)) {
      return;
    }
    let activity = this.#ownerActivityByTask.get(projection.taskId);
    if (activity === undefined) {
      const latest = await this.#latestOwnerAcknowledgement(projection.taskId, true);
      if (latest === undefined) {
        return;
      }
      activity = {
        threadId: binding.threadId,
        messageId: latest.messageId,
        lastTypingAtMs: latest.createdAtMs,
      };
      this.#ownerActivityByTask.set(projection.taskId, activity);
    }
    const nowMs = this.#clock.nowMs();
    if (nowMs - activity.lastTypingAtMs < TYPING_REFRESH_INTERVAL_MS) {
      return;
    }
    try {
      const visible = await this.#api.refreshTyping({ threadId: activity.threadId });
      if (!visible) {
        this.#recordDiagnostic("discord.message_activity_typing_unavailable", {
          threadId: activity.threadId,
          messageId: activity.messageId,
        });
      }
    } catch (error) {
      this.#recordDiagnostic("discord.message_activity_refresh_failed", {
        threadId: activity.threadId,
        messageId: activity.messageId,
        error: errorText(error),
      });
    } finally {
      this.#ownerActivityByTask.set(projection.taskId, {
        ...activity,
        lastTypingAtMs: nowMs,
      });
    }
  }

  async #ownerMessageCompletion(
    projection: TaskChannelProjection,
    binding: DiscordTaskBinding,
  ): Promise<
    | {
        readonly messageId: string;
        readonly outcome: "success" | "failure";
      }
    | undefined
  > {
    if (keepsOwnerActivityOpen(projection.state)) {
      return undefined;
    }
    const activity = this.#ownerActivityByTask.get(projection.taskId);
    const latest =
      activity ??
      (await this.#latestOwnerAcknowledgement(projection.taskId, false).then((item) =>
        item === undefined
          ? undefined
          : {
              threadId: binding.threadId,
              messageId: item.messageId,
              lastTypingAtMs: item.createdAtMs,
            },
      ));
    if (latest === undefined) {
      return undefined;
    }
    return Object.freeze({
      messageId: latest.messageId,
      outcome: projection.state === "failed" ? "failure" : "success",
    });
  }

  async #latestOwnerAcknowledgement(
    taskId: string,
    deliveredOnly: boolean,
  ): Promise<{ readonly messageId: string; readonly createdAtMs: number } | undefined> {
    const item = [...(await this.#repository.listOutbox())]
      .reverse()
      .find(
        (candidate) =>
          (!deliveredOnly || candidate.delivered) &&
          candidate.action.kind === "acknowledge-owner-message" &&
          candidate.action.taskId === taskId,
      );
    if (item === undefined || item.action.kind !== "acknowledge-owner-message") {
      return undefined;
    }
    return Object.freeze({
      messageId: item.action.messageId,
      createdAtMs: item.createdAtMs,
    });
  }

  async #completeOwnerActivity(
    taskId: string,
    threadId: string,
    completion: {
      readonly messageId: string;
      readonly outcome: "success" | "failure";
    },
  ): Promise<void> {
    const result = await this.#api.completeMessageAcknowledgement({
      threadId,
      messageId: completion.messageId,
      outcome: completion.outcome,
    });
    if (!result.acknowledgementRemoved) {
      this.#recordDiagnostic("discord.message_acknowledgement_remove_unavailable", {
        threadId,
        messageId: completion.messageId,
      });
    }
    if (!result.outcomeVisible) {
      this.#recordDiagnostic("discord.message_acknowledgement_outcome_unavailable", {
        threadId,
        messageId: completion.messageId,
      });
    }
    const active = this.#ownerActivityByTask.get(taskId);
    if (active?.messageId === completion.messageId) {
      this.#ownerActivityByTask.delete(taskId);
    }
  }

  async #enqueueOwnerMessageCompletion(
    projection: TaskChannelProjection,
    completion: {
      readonly messageId: string;
      readonly outcome: "success" | "failure";
    },
    afterRequestKey: string,
  ): Promise<void> {
    await this.#enqueueOutbox(`${afterRequestKey}:04-complete-owner-message`, {
      kind: "complete-owner-message",
      taskId: projection.taskId,
      completion: Object.freeze({ ...completion }),
      afterRequestKey,
    });
  }

  async #enqueueOutbox(id: string, action: DiscordOutboxAction): Promise<void> {
    const nowMs = this.#clock.nowMs();
    await this.#repository.enqueueOutbox({
      id,
      action,
      createdAtMs: nowMs,
      notBeforeMs: nowMs,
    });
  }

  async #drainOutbox(): Promise<void> {
    for (;;) {
      const items = await this.#repository.claimReadyOutbox({
        owner: this.#outboxOwner,
        nowMs: this.#clock.nowMs(),
        leaseMs: OUTBOX_LEASE_MS,
        limit: 25,
      });
      if (items.length === 0) {
        return;
      }
      for (const item of items) {
        await this.#deliverOutbox(item);
      }
    }
  }

  async #deliverOutbox(item: DiscordOutboxItem): Promise<void> {
    try {
      await this.#executeOutbox(item);
      await this.#repository.completeOutbox({ id: item.id, owner: this.#outboxOwner });
    } catch (error) {
      const binding = await bindingForAction(this.#repository, item.action);
      if (error instanceof DiscordApiError && binding !== undefined) {
        if (error.code === "NOT_FOUND") {
          await this.#repository.updateBinding(binding.threadId, { externalState: "deleted" });
          await this.#repository.completeOutbox({ id: item.id, owner: this.#outboxOwner });
          return;
        }
        if (error.code === "FORBIDDEN") {
          await this.#repository.updateBinding(binding.threadId, {
            externalState: "inaccessible",
          });
          await this.#repository.completeOutbox({ id: item.id, owner: this.#outboxOwner });
          return;
        }
      }
      const errorCode = error instanceof DiscordApiError ? error.code : "TASK_CALLBACK_FAILED";
      const retryAfterMs =
        error instanceof DiscordApiError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : Math.min(60_000, 1_000 * 2 ** Math.min(item.attempts, 6));
      await this.#repository.retryOutbox({
        id: item.id,
        owner: this.#outboxOwner,
        notBeforeMs: this.#clock.nowMs() + retryAfterMs,
        errorCode,
      });
      this.#recordDiagnostic("discord.outbox_delivery_failed", {
        outboxId: item.id,
        errorCode,
        error: errorText(error),
      });
    }
  }

  async #executeOutbox(item: DiscordOutboxItem): Promise<void> {
    const action = item.action;
    switch (action.kind) {
      case "acknowledge-owner-message": {
        const binding = await requiredBinding(this.#repository, action.taskId);
        const prior =
          this.#ownerActivityByTask.get(action.taskId) ??
          (await this.#latestOwnerAcknowledgement(action.taskId, true).then((item) =>
            item === undefined
              ? undefined
              : {
                  threadId: binding.threadId,
                  messageId: item.messageId,
                  lastTypingAtMs: item.createdAtMs,
                },
          ));
        const acknowledgement = await this.#api.acknowledgeMessage({
          threadId: binding.threadId,
          messageId: action.messageId,
        });
        if (!acknowledgement.reactionVisible) {
          this.#recordDiagnostic("discord.message_acknowledgement_reaction_unavailable", {
            threadId: binding.threadId,
            messageId: action.messageId,
          });
        }
        if (!acknowledgement.typingVisible) {
          this.#recordDiagnostic("discord.message_acknowledgement_typing_unavailable", {
            threadId: binding.threadId,
            messageId: action.messageId,
          });
        }
        if (prior !== undefined && prior.messageId !== action.messageId) {
          await this.#completeOwnerActivity(action.taskId, prior.threadId, {
            messageId: prior.messageId,
            outcome: "success",
          });
        }
        this.#ownerActivityByTask.set(action.taskId, {
          threadId: binding.threadId,
          messageId: action.messageId,
          lastTypingAtMs: this.#clock.nowMs(),
        });
        return;
      }
      case "sync-tags": {
        const binding = await requiredBinding(this.#repository, action.taskId);
        const thread = await this.#api.getThread(binding.threadId);
        const workflowTagIds = requiredForumConfig(
          this.#config,
          binding.forumChannelId,
        ).workflowTagIds;
        const statusTagIds = new Set(Object.values(workflowTagIds));
        const facetTags = thread.appliedTagIds
          .filter((tagId) => !statusTagIds.has(tagId))
          .slice(0, 4);
        const status = workflowStatusForTaskState(action.state);
        await this.#api.updateThreadTags(binding.threadId, [...facetTags, workflowTagIds[status]]);
        await this.#repository.updateBinding(binding.threadId, {
          archived: thread.archived,
          locked: thread.locked,
          externalState: "available",
        });
        return;
      }
      case "upsert-status-panel": {
        const binding = await requiredBinding(this.#repository, action.taskId);
        const payload = renderStatusPanel(action.projection);
        let result: { readonly messageId: string };
        try {
          result = await this.#api.upsertStatusPanel({
            threadId: binding.threadId,
            requestKey: item.id,
            payload,
            ...(binding.statusPanelMessageId === undefined
              ? {}
              : { messageId: binding.statusPanelMessageId }),
          });
        } catch (error) {
          if (
            !(error instanceof DiscordApiError) ||
            error.code !== "NOT_FOUND" ||
            binding.statusPanelMessageId === undefined
          ) {
            throw error;
          }
          result = await this.#api.upsertStatusPanel({
            threadId: binding.threadId,
            requestKey: item.id,
            payload,
          });
        }
        await this.#repository.updateBinding(binding.threadId, {
          statusPanelMessageId: result.messageId,
          externalState: "available",
        });
        return;
      }
      case "post-task-update": {
        const binding = await requiredBinding(this.#repository, action.taskId);
        await this.#api.createMessage({
          threadId: binding.threadId,
          requestKey: item.id,
          payload: renderTaskUpdate(action.projection),
        });
        return;
      }
      case "resolve-owner-prompt": {
        const binding = await requiredBinding(this.#repository, action.taskId);
        const prompt = await this.#api.createMessage({
          threadId: binding.threadId,
          requestKey: action.promptRequestKey,
          payload: renderTaskUpdate(action.projection),
        });
        try {
          await this.#api.editMessage({
            threadId: binding.threadId,
            messageId: prompt.messageId,
            payload: renderResolvedOwnerPrompt(action.projection),
          });
        } catch (error) {
          if (!(error instanceof DiscordApiError) || error.code !== "NOT_FOUND") {
            throw error;
          }
          this.#recordDiagnostic("discord.owner_prompt_message_missing", {
            threadId: binding.threadId,
            messageId: prompt.messageId,
          });
        }
        return;
      }
      case "complete-owner-message": {
        const dependency = (await this.#repository.listOutbox()).find(
          (candidate) => candidate.id === action.afterRequestKey,
        );
        if (dependency?.delivered !== true) {
          throw new DiscordApiError(
            "OFFLINE",
            "The owner-message outcome is waiting for its durable Discord reply.",
          );
        }
        const binding = await requiredBinding(this.#repository, action.taskId);
        await this.#completeOwnerActivity(action.taskId, binding.threadId, action.completion);
        return;
      }
      case "task-command":
        await this.#tasks.commandTask({
          taskId: action.taskId,
          principalId: action.principalId,
          idempotencyKey: action.idempotencyKey,
          command: action.command,
        });
        await this.#finishDeferredInteraction(
          action.responseRef,
          `${capitalize(action.command)} was accepted for this Task.`,
        );
        return;
      case "approval-decision":
        await this.#tasks.resolveApproval({
          taskId: action.taskId,
          approvalId: action.approvalId,
          principalId: action.principalId,
          idempotencyKey: action.idempotencyKey,
          decision: action.decision,
        });
        await this.#finishDeferredInteraction(
          action.responseRef,
          action.decision === "approve"
            ? "The approval was granted for its exact recorded scope."
            : "The approval was rejected.",
        );
        return;
    }
  }

  async #finishDeferredInteraction(
    responseRef: string,
    message: string,
    success = true,
  ): Promise<void> {
    try {
      await this.#api.editDeferredInteraction({
        responseRef,
        payload: renderInteractionResult(message, success),
      });
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
      ) {
        this.#recordDiagnostic("discord.interaction_followup_unavailable", {
          errorCode: error.code,
        });
        return;
      }
      throw error;
    }
  }

  async #saveCursor(dispatch: DiscordGatewayDispatch): Promise<void> {
    const cursor: DiscordGatewayCursor = {
      sessionId: dispatch.sessionId,
      resumeGatewayUrl: dispatch.resumeGatewayUrl,
      sequence: dispatch.sequence,
      updatedAtMs: this.#clock.nowMs(),
    };
    await this.#repository.saveGatewayCursor(cursor);
  }

  #isApprovedThread(thread: DiscordThread): boolean {
    return (
      thread.guildId === this.#config.guildId &&
      thread.type === 11 &&
      forumChannelIds(this.#config).includes(thread.parentId)
    );
  }

  #isAuthorized(authorId: string, roleIds: readonly string[]): boolean {
    return (
      this.#config.ownerUserIds.includes(authorId) ||
      roleIds.some((roleId) => this.#config.allowedRoleIds.includes(roleId))
    );
  }

  async #withThread(threadId: string, work: () => Promise<void>): Promise<void> {
    const prior = this.#threadWork.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => gate);
    this.#threadWork.set(threadId, tail);
    await prior.catch(() => undefined);
    try {
      await work();
    } finally {
      release();
      if (this.#threadWork.get(threadId) === tail) {
        this.#threadWork.delete(threadId);
      }
    }
  }

  #recordDiagnostic(
    event: string,
    fields: Readonly<Record<string, string | number | boolean>>,
  ): void {
    const redactedFields: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      redactedFields[key] = typeof value === "string" ? redactDiscordSecrets(value) : value;
    }
    this.#diagnostics.push(
      Object.freeze({
        event,
        atMs: this.#clock.nowMs(),
        fields: Object.freeze(redactedFields),
      }),
    );
    if (this.#diagnostics.length > 200) {
      this.#diagnostics.shift();
    }
  }
}

function validateConfig(config: DiscordForumAdapterConfig): void {
  const forumIds = forumChannelIds(config);
  for (const value of [
    config.applicationId,
    config.botUserId,
    config.guildId,
    ...forumIds,
    ...config.ownerUserIds,
    ...config.allowedRoleIds,
    ...config.forumBindings.flatMap((binding) => Object.values(binding.workflowTagIds)),
  ]) {
    if (!/^\d{17,20}$/.test(value)) {
      throw configInvalid();
    }
  }
  if (
    config.forumBindings.length === 0 ||
    config.ownerUserIds.length === 0 ||
    new Set(forumIds).size !== forumIds.length ||
    new Set(config.ownerUserIds).size !== config.ownerUserIds.length ||
    new Set(config.allowedRoleIds).size !== config.allowedRoleIds.length ||
    config.forumBindings.some(
      (binding) =>
        Object.keys(binding).sort().join(",") !== "channelId,workflowTagIds" ||
        new Set(Object.values(binding.workflowTagIds)).size !== 6 ||
        Object.keys(binding.workflowTagIds).sort().join(",") !==
          "done,failed,intake,review,running,waiting",
    )
  ) {
    throw configInvalid();
  }
  const keys = Object.keys(config);
  if (
    keys.some((key) => /token|secret|credential/iu.test(key)) ||
    keys.sort().join(",") !==
      "allowedRoleIds,applicationId,botUserId,forumBindings,guildId,ownerUserIds"
  ) {
    throw configInvalid();
  }
}

function forumChannelIds(config: DiscordForumAdapterConfig): readonly string[] {
  return config.forumBindings.map((binding) => binding.channelId);
}

function requiredForumConfig(
  config: DiscordForumAdapterConfig,
  channelId: string,
): DiscordForumAdapterConfig["forumBindings"][number] {
  const forum = config.forumBindings.find((candidate) => candidate.channelId === channelId);
  if (forum === undefined) {
    throw new DiscordAdapterError(
      "PERSISTENCE_CONFLICT",
      "A Discord binding references an unconfigured Forum.",
    );
  }
  return forum;
}

function validateDispatchEnvelope(dispatch: DiscordGatewayDispatch): void {
  if (
    dispatch.sessionId.length === 0 ||
    !URL.canParse(dispatch.resumeGatewayUrl) ||
    !dispatch.resumeGatewayUrl.startsWith("wss://") ||
    !Number.isSafeInteger(dispatch.sequence) ||
    dispatch.sequence < 0
  ) {
    throw new DiscordAdapterError("CONFIG_INVALID", "The Gateway dispatch is invalid.");
  }
}

function parseControl(value: string):
  | {
      readonly kind: "command";
      readonly command: "pause" | "resume" | "cancel" | "retry";
    }
  | {
      readonly kind: "approval";
      readonly decision: "approve" | "reject";
      readonly approvalId: string;
    }
  | undefined {
  if (value === "od:v1:pause") {
    return { kind: "command", command: "pause" };
  }
  if (value === "od:v1:resume") {
    return { kind: "command", command: "resume" };
  }
  if (value === "od:v1:cancel") {
    return { kind: "command", command: "cancel" };
  }
  if (value === "od:v1:retry") {
    return { kind: "command", command: "retry" };
  }
  const match = /^od:v1:(approve|reject):([A-Za-z0-9._-]{1,70})$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const decision = match[1];
  const approvalId = match[2];
  if ((decision !== "approve" && decision !== "reject") || approvalId === undefined) {
    return undefined;
  }
  return { kind: "approval", decision, approvalId };
}

async function requiredBinding(
  repository: DiscordStateRepository,
  taskId: string,
): Promise<DiscordTaskBinding> {
  const binding = await repository.getBindingByTask(taskId);
  if (binding === undefined) {
    throw new DiscordAdapterError(
      "PERSISTENCE_CONFLICT",
      "Discord outbox work has no Task binding.",
    );
  }
  return binding;
}

async function bindingForAction(
  repository: DiscordStateRepository,
  action: DiscordOutboxAction,
): Promise<DiscordTaskBinding | undefined> {
  switch (action.kind) {
    case "acknowledge-owner-message":
    case "sync-tags":
    case "upsert-status-panel":
    case "post-task-update":
    case "resolve-owner-prompt":
    case "complete-owner-message":
      return repository.getBindingByTask(action.taskId);
    case "task-command":
    case "approval-decision":
      return undefined;
  }
}

function taskSource(thread: DiscordThread, message: DiscordMessage) {
  return Object.freeze({
    kind: "discord-forum" as const,
    guildId: thread.guildId,
    forumChannelId: thread.parentId,
    threadId: thread.id,
    messageId: message.id,
    authorId: message.author.id,
  });
}

function keepsOwnerActivityOpen(state: TaskChannelProjection["state"]): boolean {
  return state === "intake" || state === "queued" || state === "running";
}

function chronologicalProjection(projection: TaskChannelProjection): TaskChannelProjection {
  return Object.freeze({
    taskId: projection.taskId,
    ...(projection.sourceEventId === undefined ? {} : { sourceEventId: projection.sourceEventId }),
    state: projection.state,
    objective: projection.objective,
    summary: projection.summary,
    significance: projection.significance,
    ...(projection.approval === undefined
      ? {}
      : { approval: Object.freeze({ ...projection.approval }) }),
  });
}

function attachmentReferences(message: DiscordMessage): readonly string[] {
  return Object.freeze(
    message.attachments.map((attachment) => `discord-attachment:${attachment.id}`),
  );
}

function replyMessage(message: DiscordMessage): string {
  if (message.content.trim().length > 0) {
    return message.content;
  }
  const count = message.attachments.length;
  return `The owner attached ${count.toString()} ${count === 1 ? "file" : "files"} through Discord.`;
}

function outboundTaskThreadName(projection: TaskChannelProjection): string {
  const marker = `OD-${digestValue(projection.taskId).slice(-10)}`;
  const objective = projection.objective.replace(/\s+/gu, " ").trim();
  return truncateCodePoints(`${marker} ${objective}`, 100);
}

function outboundTaskStarterContent(projection: TaskChannelProjection): string {
  return truncateCodePoints(
    `OpenDelegate Task ${projection.taskId}\n\n${projection.objective.trim()}`,
    2_000,
  );
}

function truncateCodePoints(value: string, maximum: number): string {
  const points = Array.from(value);
  if (points.length <= maximum) {
    return value;
  }
  return `${points.slice(0, maximum - 1).join("")}…`;
}

function digestValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function compareMessageSnowflakes(left: DiscordMessage, right: DiscordMessage): number {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function laterSnowflake(current: string | undefined, candidate: string): string {
  if (current === undefined) {
    return candidate;
  }
  return BigInt(candidate) > BigInt(current) ? candidate : current;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Discord adapter failure.";
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function cryptoRandomSuffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

function frozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function configInvalid(): DiscordAdapterError {
  return new DiscordAdapterError(
    "CONFIG_INVALID",
    "Discord Forum configuration is invalid or contains a forbidden credential field.",
  );
}
