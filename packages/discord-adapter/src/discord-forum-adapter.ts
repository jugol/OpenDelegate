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

export class DiscordForumAdapter {
  readonly #config: DiscordForumAdapterConfig;
  readonly #repository: DiscordStateRepository;
  readonly #api: DiscordApiPort;
  readonly #tasks: DiscordTaskPort;
  readonly #clock: DiscordClock;
  readonly #gateway: DiscordForumAdapterOptions["gateway"];
  readonly #diagnostics: DiscordDiagnostic[] = [];
  readonly #threadWork = new Map<string, Promise<void>>();
  readonly #outboxOwner = `discord-adapter:${cryptoRandomSuffix()}`;
  #flushPromise: Promise<void> | undefined;
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #connection: DiscordGatewayConnection | undefined;

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
      if (!(error instanceof DiscordApiError && error.code === "OFFLINE")) {
        throw error;
      }
    }
  }

  async publishTaskProjection(projection: TaskChannelProjection): Promise<void> {
    // Rendering validates all owner-visible fields and URLs before durable work is queued.
    renderStatusPanel(projection);
    const binding = await this.#repository.getBindingByTask(projection.taskId);
    if (binding === undefined) {
      throw new DiscordAdapterError("PROJECTION_INVALID", "The Task has no Discord Forum binding.");
    }
    const digest = digestValue(projection);
    await this.#enqueueOutbox(`${digest}:01-tags`, {
      kind: "sync-tags",
      taskId: projection.taskId,
      state: projection.state,
    });
    await this.#enqueueOutbox(`${digest}:02-panel`, {
      kind: "upsert-status-panel",
      taskId: projection.taskId,
      projection: frozenClone(projection),
    });
    if (projection.significance !== "status") {
      await this.#enqueueOutbox(`${digest}:03-update`, {
        kind: "post-task-update",
        taskId: projection.taskId,
        projection: frozenClone(projection),
      });
    }
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
        if (
          error instanceof DiscordApiError &&
          (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
        ) {
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
    try {
      const starter = await this.#api.getMessage(thread.id, thread.id);
      if (!starter.author.bot && this.#isAuthorized(starter.author.id, starter.author.roleIds)) {
        await this.#ingestMessage(thread, starter);
      }
    } catch (error) {
      if (!(error instanceof DiscordApiError && error.code === "NOT_FOUND")) {
        throw error;
      }
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
      await this.#tasks.appendTaskInput({
        taskId: binding.taskId,
        principalId: `discord:${message.author.id}`,
        idempotencyKey: key,
        message: replyMessage(message),
        selectedInputRefs: attachmentReferences(message),
        source: taskSource(thread, message),
      });
    }
    await this.#repository.completeInbound({ key, nowMs: this.#clock.nowMs() });
  }

  async #ensureBinding(thread: DiscordThread): Promise<DiscordTaskBinding | undefined> {
    const existing = await this.#repository.getBindingByThread(thread.id);
    if (existing !== undefined) {
      return existing;
    }
    let starter: DiscordMessage;
    try {
      starter = await this.#api.getMessage(thread.id, thread.id);
    } catch (error) {
      if (error instanceof DiscordApiError && error.code === "NOT_FOUND") {
        return undefined;
      }
      throw error;
    }
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
      (binding.statusPanelMessageId !== undefined &&
        binding.statusPanelMessageId !== interaction.messageId)
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
    case "sync-tags":
    case "upsert-status-panel":
    case "post-task-update":
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
