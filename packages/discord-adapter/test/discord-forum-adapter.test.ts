import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DISCORD_GATEWAY_INTENTS,
  DiscordApiError,
  DiscordForumAdapter,
  DiscordTaskPortError,
  InMemoryDiscordStateRepository,
  type DiscordArtifactAttachmentContentPort,
  type DiscordApiPort,
  type DiscordGatewayDispatch,
  type DiscordGatewayPort,
  type DiscordInstallationProbe,
  type DiscordMessage,
  type DiscordMessagePayload,
  type DiscordTaskPort,
  type DiscordThread,
  type TaskChannelProjection,
  redactDiscordSecrets,
  renderStatusPanel,
  renderTaskActivity,
  renderTaskUpdate,
} from "../src/index.ts";

const GUILD_ID = "100000000000000001";
const FORUM_ID = "100000000000000002";
const OWNER_ID = "100000000000000003";
const OWNER_ROLE_ID = "100000000000000004";
const BOT_ID = "100000000000000005";
const SECOND_FORUM_ID = "100000000000000007";
const STATUS_TAGS = {
  intake: "200000000000000001",
  running: "200000000000000002",
  waiting: "200000000000000003",
  review: "200000000000000004",
  done: "200000000000000005",
  failed: "200000000000000006",
} as const;
const SECOND_STATUS_TAGS = {
  intake: "210000000000000001",
  running: "210000000000000002",
  waiting: "210000000000000003",
  review: "210000000000000004",
  done: "210000000000000005",
  failed: "210000000000000006",
} as const;

class FakeClock {
  public value = 1_000;

  public nowMs(): number {
    return this.value;
  }
}

class FakeTaskPort implements DiscordTaskPort {
  public readonly calls: Array<Record<string, unknown>> = [];
  public readonly taskByIdempotency = new Map<string, string>();
  public blockCommands: Promise<void> | undefined;
  public blockAppends: Promise<void> | undefined;
  public commandError: Error | undefined;
  public beforeAppendTaskInput: (() => void) | undefined;
  public afterAppendTaskInput: (() => void) | undefined;

  public async createTask(input: Parameters<DiscordTaskPort["createTask"]>[0]) {
    this.calls.push({ kind: "create", ...input });
    const existing = this.taskByIdempotency.get(input.idempotencyKey);
    if (existing !== undefined) {
      return { taskId: existing };
    }
    const taskId = `task-${this.taskByIdempotency.size + 1}`;
    this.taskByIdempotency.set(input.idempotencyKey, taskId);
    return { taskId };
  }

  public async appendTaskInput(input: Parameters<DiscordTaskPort["appendTaskInput"]>[0]) {
    this.beforeAppendTaskInput?.();
    await this.blockAppends;
    this.calls.push({ kind: "append", ...input });
    this.afterAppendTaskInput?.();
  }

  public async commandTask(input: Parameters<DiscordTaskPort["commandTask"]>[0]) {
    await this.blockCommands;
    this.calls.push({ kind: "command", ...input });
    if (this.commandError !== undefined) {
      throw this.commandError;
    }
  }

  public async resolveApproval(input: Parameters<DiscordTaskPort["resolveApproval"]>[0]) {
    this.calls.push({ kind: "approval", ...input });
  }
}

class FakeDiscordApi implements DiscordApiPort {
  public online = true;
  public reconciliationError: DiscordApiError | undefined;
  public deferInteractionError: DiscordApiError | undefined;
  public editDeferredError: DiscordApiError | undefined;
  public probe: DiscordInstallationProbe = {
    applicationId: "100000000000000006",
    botUserId: BOT_ID,
    guildId: GUILD_ID,
    guildFeatures: ["COMMUNITY"],
    enabledIntents: ["GUILDS", "GUILD_MESSAGES", "MESSAGE_CONTENT"],
    forums: [
      {
        channelId: FORUM_ID,
        channelType: 15,
        permissions: [
          "VIEW_CHANNEL",
          "READ_MESSAGE_HISTORY",
          "SEND_MESSAGES",
          "SEND_MESSAGES_IN_THREADS",
          "ATTACH_FILES",
          "MANAGE_THREADS",
        ],
        availableTagIds: Object.values(STATUS_TAGS),
      },
    ],
  };
  public readonly threads = new Map<string, DiscordThread>();
  public readonly messages = new Map<string, DiscordMessage[]>();
  public readonly archivedPages: DiscordThread[][] = [];
  public readonly operations: Array<Record<string, unknown>> = [];
  public readonly acknowledgedInteractions = new Set<string>();
  public readonly missingStatusPanelMessageIds = new Set<string>();
  public failTaskActivityUpserts = false;
  readonly #messageByRequestKey = new Map<string, string>();
  #nextMessage = 900;

  public forgetMessageRequestKeys(): void {
    this.#messageByRequestKey.clear();
  }

  public async probeInstallation(): Promise<DiscordInstallationProbe> {
    return this.probe;
  }

  public async getThread(threadId: string): Promise<DiscordThread> {
    this.#assertOnline();
    const thread = this.threads.get(threadId);
    if (thread === undefined) {
      throw new DiscordApiError("NOT_FOUND", "Discord thread was not found.");
    }
    return structuredClone(thread);
  }

  public async getMessage(threadId: string, messageId: string): Promise<DiscordMessage> {
    this.#assertOnline();
    const message = this.messages.get(threadId)?.find((candidate) => candidate.id === messageId);
    if (message === undefined) {
      throw new DiscordApiError("NOT_FOUND", "Discord message was not found.");
    }
    return structuredClone(message);
  }

  public async listActiveThreads(): Promise<readonly DiscordThread[]> {
    this.#assertOnline();
    if (this.reconciliationError !== undefined) {
      throw this.reconciliationError;
    }
    return [...this.threads.values()].filter((thread) => !thread.archived);
  }

  public async listArchivedPublicThreads(
    _forumChannelId: string,
    before?: string,
  ): Promise<{ threads: readonly DiscordThread[]; hasMore: boolean; nextBefore?: string }> {
    this.#assertOnline();
    const index = before === undefined ? 0 : Number(before);
    const threads = this.archivedPages[index] ?? [];
    const hasMore = index + 1 < this.archivedPages.length;
    return {
      threads,
      hasMore,
      ...(hasMore ? { nextBefore: String(index + 1) } : {}),
    };
  }

  public async listMessages(
    threadId: string,
    after?: string,
  ): Promise<{ messages: readonly DiscordMessage[]; hasMore: boolean; nextAfter?: string }> {
    this.#assertOnline();
    const candidates = this.messages.get(threadId) ?? [];
    const messages =
      after === undefined
        ? candidates
        : candidates.filter((message) => BigInt(message.id) > BigInt(after));
    return { messages, hasMore: false };
  }

  public async createForumPost(input: {
    forumChannelId: string;
    requestKey: string;
    name: string;
    content: string;
    appliedTagIds: readonly string[];
  }): Promise<{ thread: DiscordThread; starterMessage: DiscordMessage }> {
    this.#assertOnline();
    const threadId = (800_000_000_000_000_000n + BigInt(this.threads.size)).toString();
    const thread: DiscordThread = {
      id: threadId,
      guildId: GUILD_ID,
      parentId: input.forumChannelId,
      type: 11,
      name: input.name,
      ownerId: BOT_ID,
      appliedTagIds: [...input.appliedTagIds],
      archived: false,
      locked: false,
    };
    const starterMessage: DiscordMessage = {
      id: threadId,
      guildId: GUILD_ID,
      channelId: threadId,
      author: { id: BOT_ID, bot: true, roleIds: [] },
      content: input.content,
      attachments: [],
      createdAtMs: 1_000,
    };
    this.threads.set(threadId, thread);
    this.messages.set(threadId, [starterMessage]);
    this.operations.push({ kind: "forum-post", ...input, threadId });
    return { thread, starterMessage };
  }

  public async updateThreadTags(threadId: string, appliedTagIds: readonly string[]): Promise<void> {
    this.#assertOnline();
    this.operations.push({ kind: "tags", threadId, appliedTagIds: [...appliedTagIds] });
    const current = await this.getThread(threadId);
    this.threads.set(threadId, { ...current, appliedTagIds: [...appliedTagIds] });
  }

  public async upsertStatusPanel(input: {
    threadId: string;
    requestKey: string;
    payload: DiscordMessagePayload;
    messageId?: string;
  }): Promise<{ messageId: string }> {
    this.#assertOnline();
    if (this.failTaskActivityUpserts && input.requestKey.startsWith("task-activity:")) {
      throw new DiscordApiError(
        "OFFLINE",
        "The live Task activity surface is temporarily offline.",
      );
    }
    if (input.messageId !== undefined && this.missingStatusPanelMessageIds.has(input.messageId)) {
      throw new DiscordApiError("NOT_FOUND", "Discord status panel was not found.");
    }
    const messageId = input.messageId ?? String(this.#nextMessage++);
    this.operations.push({
      kind: "panel",
      ...input,
      requestedMessageId: input.messageId,
      messageId,
    });
    return { messageId };
  }

  public async createMessage(input: {
    threadId: string;
    requestKey: string;
    payload: DiscordMessagePayload;
    attachment?: Parameters<DiscordApiPort["createMessage"]>[0]["attachment"];
  }): Promise<{ messageId: string }> {
    this.#assertOnline();
    const existing = this.#messageByRequestKey.get(input.requestKey);
    if (existing !== undefined) {
      this.operations.push({ kind: "message-reconciled", ...input, messageId: existing });
      return { messageId: existing };
    }
    const messageId = String(this.#nextMessage++);
    this.#messageByRequestKey.set(input.requestKey, messageId);
    this.operations.push({ kind: "message", ...input, messageId });
    return { messageId };
  }

  public async editMessage(input: {
    threadId: string;
    messageId: string;
    payload: DiscordMessagePayload;
  }): Promise<void> {
    this.#assertOnline();
    this.operations.push({ kind: "message-edit", ...input });
  }

  public async deleteMessage(input: { threadId: string; messageId: string }): Promise<void> {
    this.#assertOnline();
    this.operations.push({ kind: "message-delete", ...input });
  }

  public async acknowledgeMessage(input: {
    threadId: string;
    messageId: string;
  }): Promise<{ reactionVisible: boolean; typingVisible: boolean }> {
    this.#assertOnline();
    this.operations.push({ kind: "message-acknowledgement", ...input });
    return { reactionVisible: true, typingVisible: true };
  }

  public async refreshTyping(input: { threadId: string }): Promise<boolean> {
    this.#assertOnline();
    this.operations.push({ kind: "typing-refresh", ...input });
    return true;
  }

  public async completeMessageAcknowledgement(input: {
    threadId: string;
    messageId: string;
    outcome: "success" | "failure";
  }): Promise<{ acknowledgementRemoved: boolean; outcomeVisible: boolean }> {
    this.#assertOnline();
    this.operations.push({ kind: "message-acknowledgement-completed", ...input });
    return { acknowledgementRemoved: true, outcomeVisible: true };
  }

  public async deferInteraction(input: {
    interactionId: string;
    interactionToken: string;
    ephemeral: boolean;
  }): Promise<{ responseRef: string }> {
    this.#assertOnline();
    if (this.deferInteractionError !== undefined) {
      throw this.deferInteractionError;
    }
    if (this.acknowledgedInteractions.has(input.interactionId)) {
      throw new DiscordApiError("NOT_FOUND", "Discord already acknowledged this interaction.");
    }
    this.acknowledgedInteractions.add(input.interactionId);
    this.operations.push({
      kind: "defer",
      interactionId: input.interactionId,
      ephemeral: input.ephemeral,
    });
    return { responseRef: `discord-interaction-ref:${input.interactionId}` };
  }

  public async editDeferredInteraction(input: {
    responseRef: string;
    payload: DiscordMessagePayload;
  }): Promise<void> {
    this.#assertOnline();
    if (this.editDeferredError !== undefined) {
      throw this.editDeferredError;
    }
    this.operations.push({ kind: "interaction-result", ...input });
  }

  public async deleteDeferredInteraction(input: { responseRef: string }): Promise<void> {
    this.#assertOnline();
    this.operations.push({ kind: "interaction-dismiss", ...input });
  }

  #assertOnline(): void {
    if (!this.online) {
      throw new DiscordApiError("OFFLINE", "Bot token abc.def.secret could not connect.");
    }
  }
}

class FakeGateway implements DiscordGatewayPort {
  public connected:
    | {
        apiVersion: number;
        intentBitfield: number;
        resumeSequence: number | undefined;
      }
    | undefined;
  public closed = false;
  public connections = 0;

  public async connect(options: Parameters<DiscordGatewayPort["connect"]>[0]) {
    this.connections += 1;
    this.connected = {
      apiVersion: options.apiVersion,
      intentBitfield: options.intentBitfield,
      resumeSequence: options.resume?.sequence,
    };
    return {
      close: async () => {
        this.closed = true;
      },
    };
  }
}

function fixture(options?: {
  repository?: InMemoryDiscordStateRepository;
  api?: FakeDiscordApi;
  tasks?: FakeTaskPort;
  clock?: FakeClock;
  gateway?: FakeGateway;
  presentationLocale?: "en" | "ko";
  artifactAttachments?: DiscordArtifactAttachmentContentPort;
}) {
  const repository = options?.repository ?? new InMemoryDiscordStateRepository();
  const api = options?.api ?? new FakeDiscordApi();
  const tasks = options?.tasks ?? new FakeTaskPort();
  const clock = options?.clock ?? new FakeClock();
  const adapter = new DiscordForumAdapter({
    config: {
      applicationId: "100000000000000006",
      botUserId: BOT_ID,
      guildId: GUILD_ID,
      forumBindings: [{ channelId: FORUM_ID, workflowTagIds: STATUS_TAGS }],
      ownerUserIds: [OWNER_ID],
      allowedRoleIds: [OWNER_ROLE_ID],
      ...(options?.presentationLocale === undefined
        ? {}
        : { presentationLocale: options.presentationLocale }),
    },
    repository,
    api,
    tasks,
    clock,
    ...(options?.gateway === undefined ? {} : { gateway: options.gateway }),
    ...(options?.artifactAttachments === undefined
      ? {}
      : { artifactAttachments: options.artifactAttachments }),
  });
  return { adapter, api, tasks, repository, clock };
}

async function recordDeliveredOutbox(
  repository: InMemoryDiscordStateRepository,
  clock: FakeClock,
  id: string,
  action: Parameters<InMemoryDiscordStateRepository["enqueueOutbox"]>[0]["action"],
): Promise<void> {
  await repository.enqueueOutbox({
    id,
    action,
    createdAtMs: clock.nowMs(),
    notBeforeMs: clock.nowMs(),
  });
  const claimed = await repository.claimReadyOutbox({
    owner: "migration-test",
    nowMs: clock.nowMs(),
    leaseMs: 30_000,
    limit: 100,
  });
  const item = claimed.find((candidate) => candidate.id === id);
  assert.notEqual(item, undefined);
  await repository.completeOutbox({ id, owner: "migration-test" });
  clock.value += 1;
}

test("installation probe requires Community, Forum type, Gateway intents, and least permissions", async () => {
  const { adapter, api } = fixture();
  const ready = await adapter.verifyInstallation();
  assert.equal(ready.ready, true);
  assert.equal(ready.gatewayIntentBitfield, DISCORD_GATEWAY_INTENTS);

  api.probe = {
    ...api.probe,
    guildFeatures: [],
    enabledIntents: ["GUILDS", "GUILD_MESSAGES"],
    forums: [
      {
        channelId: FORUM_ID,
        channelType: 0,
        permissions: ["VIEW_CHANNEL"],
        availableTagIds: [],
      },
    ],
  };
  const invalid = await adapter.verifyInstallation();
  assert.equal(invalid.ready, false);
  assert.deepEqual(invalid.issues, [
    "The approved guild is not Community-enabled.",
    "The MESSAGE_CONTENT Gateway intent is not enabled.",
    "Channel 100000000000000002 is not a Discord Forum.",
    "Channel 100000000000000002 lacks permissions: ATTACH_FILES, MANAGE_THREADS, READ_MESSAGE_HISTORY, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS.",
  ]);
  assert.equal(JSON.stringify(invalid).includes("token"), false);
});

test("a bot-originated Task creates one recoverable Forum post and durable binding", async () => {
  const initial = fixture();
  const projection: TaskChannelProjection = {
    taskId: "task-proactive-001",
    state: "intake",
    objective: "Recover the degraded Worker route.",
    summary: "A deterministic monitor created this Task.",
    sourceEventId: "event_proactive_task_created",
    significance: "decision",
  };

  const created = await initial.adapter.createTaskThread(projection);
  assert.equal(created.taskId, projection.taskId);
  assert.equal(created.forumChannelId, FORUM_ID);
  assert.equal(created.threadId, created.starterMessageId);
  assert.equal(
    initial.api.operations.filter((operation) => operation["kind"] === "forum-post").length,
    1,
  );

  const restarted = fixture({ api: initial.api });
  const recovered = await restarted.adapter.createTaskThread(projection);
  assert.equal(recovered.threadId, created.threadId);
  assert.equal(
    initial.api.operations.filter((operation) => operation["kind"] === "forum-post").length,
    1,
  );
});

test("live startup supplies the durable Resume cursor and pinned API contract to the Gateway port", async () => {
  const repository = new InMemoryDiscordStateRepository();
  await repository.saveGatewayCursor({
    sessionId: "resume-session",
    resumeGatewayUrl: "wss://gateway.discord.gg",
    sequence: 42,
    updatedAtMs: 900,
  });
  const gateway = new FakeGateway();
  const { adapter } = fixture({ repository, gateway });

  await adapter.start();
  assert.deepEqual(gateway.connected, {
    apiVersion: 10,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resumeSequence: 42,
  });
  await adapter.close();
  assert.equal(gateway.closed, true);
});

test("concurrent live startup owns exactly one Gateway connection", async () => {
  const gateway = new FakeGateway();
  const { adapter } = fixture({ gateway });

  await Promise.all([adapter.start(), adapter.start()]);

  assert.equal(gateway.connections, 1);
  await adapter.close();
});

test("failed initial reconciliation closes its Gateway before a clean retry", async () => {
  const api = new FakeDiscordApi();
  api.reconciliationError = new DiscordApiError(
    "INVALID_RESPONSE",
    "Discord returned an invalid reconciliation page.",
  );
  const gateway = new FakeGateway();
  const { adapter } = fixture({ api, gateway });

  await assert.rejects(adapter.start(), {
    code: "INVALID_RESPONSE",
  });
  assert.equal(gateway.closed, true);

  api.reconciliationError = undefined;
  gateway.closed = false;
  await adapter.start();

  assert.equal(gateway.connections, 2);
  assert.equal(gateway.closed, false);
  await adapter.close();
});

test("each approved Forum validates and projects its own channel-scoped workflow tags", async () => {
  const repository = new InMemoryDiscordStateRepository();
  const api = new FakeDiscordApi();
  const tasks = new FakeTaskPort();
  const clock = new FakeClock();
  const firstForumProbe = api.probe.forums[0];
  assert.ok(firstForumProbe);
  api.probe = {
    ...api.probe,
    forums: [
      firstForumProbe,
      {
        ...firstForumProbe,
        channelId: SECOND_FORUM_ID,
        availableTagIds: Object.values(SECOND_STATUS_TAGS),
      },
    ],
  };
  const adapter = new DiscordForumAdapter({
    config: {
      applicationId: "100000000000000006",
      botUserId: BOT_ID,
      guildId: GUILD_ID,
      forumBindings: [
        { channelId: FORUM_ID, workflowTagIds: STATUS_TAGS },
        { channelId: SECOND_FORUM_ID, workflowTagIds: SECOND_STATUS_TAGS },
      ],
      ownerUserIds: [OWNER_ID],
      allowedRoleIds: [],
    },
    repository,
    api,
    tasks,
    clock,
  });
  assert.equal((await adapter.verifyInstallation()).ready, true);
  const thread = {
    ...forumThread("300000000000000009"),
    parentId: SECOND_FORUM_ID,
    appliedTagIds: [SECOND_STATUS_TAGS.intake],
  };
  const starter = ownerMessage(thread.id, thread.id, "Use this Forum's tags");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "completed",
    objective: "Use this Forum's tags",
    summary: "Channel-specific tags were projected.",
    significance: "status",
  });
  await adapter.flushOutbox();

  assert.deepEqual(
    api.operations.find((operation) => operation["kind"] === "tags")?.["appliedTagIds"],
    [SECOND_STATUS_TAGS.done],
  );
});

test("starter message and thread events in either order create exactly one bound Task", async () => {
  const { adapter, api, tasks, repository } = fixture();
  const thread = forumThread("300000000000000001");
  const starter = ownerMessage(thread.id, thread.id, "Prepare the cross-platform release report.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);

  await adapter.handleGatewayDispatch(messageDispatch(9, starter));
  await adapter.handleGatewayDispatch(threadDispatch(8, thread));
  await adapter.handleGatewayDispatch(messageDispatch(9, starter));

  assert.deepEqual(
    tasks.calls.map((call) => call["kind"]),
    ["create"],
  );
  const binding = await repository.getBindingByThread(thread.id);
  assert.equal(binding?.taskId, "task-1");
  assert.equal(binding?.starterMessageId, thread.id);
  assert.equal((await repository.getGatewayCursor())?.sequence, 9);
});

test("a live thread-first intake uses the Gateway payload without waiting for a starter REST lookup", async () => {
  const { adapter, api, tasks, repository } = fixture();
  const thread = forumThread("300000000000000091");
  const starter = ownerMessage(thread.id, thread.id, "Acknowledge this new Post immediately.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  api.getMessage = async () => {
    throw new Error("Live intake must not refetch the starter message.");
  };

  await adapter.handleGatewayDispatch(threadDispatch(1, thread));
  await adapter.handleGatewayDispatch(messageDispatch(2, starter));
  await adapter.flushOutbox();

  assert.equal(tasks.calls.filter((call) => call["kind"] === "create").length, 1);
  assert.equal((await repository.getBindingByThread(thread.id))?.taskId, "task-1");
  assert.equal(
    api.operations.some(
      (operation) =>
        operation["kind"] === "message-acknowledgement" && operation["messageId"] === starter.id,
    ),
    true,
  );
});

test("slow Discord delivery never head-of-line blocks the next Forum Post", async () => {
  const { adapter, api, tasks } = fixture();
  const firstThread = forumThread("300000000000000092");
  const secondThread = forumThread("300000000000000093");
  const firstStarter = ownerMessage(firstThread.id, firstThread.id, "First Post");
  const secondStarter = ownerMessage(secondThread.id, secondThread.id, "Second Post");
  let releaseAcknowledgement!: () => void;
  let acknowledgementEntered!: () => void;
  const blockedAcknowledgement = new Promise<void>((resolve) => {
    releaseAcknowledgement = resolve;
  });
  const acknowledgementStarted = new Promise<void>((resolve) => {
    acknowledgementEntered = resolve;
  });
  api.acknowledgeMessage = async (input) => {
    api.operations.push({ kind: "message-acknowledgement", ...input });
    acknowledgementEntered();
    await blockedAcknowledgement;
    return { reactionVisible: true, typingVisible: true };
  };

  await adapter.handleGatewayDispatch(threadDispatch(1, firstThread));
  let firstDispatchReturned = false;
  const firstDispatch = adapter.handleGatewayDispatch(messageDispatch(2, firstStarter)).then(() => {
    firstDispatchReturned = true;
  });
  await acknowledgementStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const returnedBeforeDelivery = firstDispatchReturned;

  await adapter.handleGatewayDispatch(threadDispatch(3, secondThread));
  await adapter.handleGatewayDispatch(messageDispatch(4, secondStarter));
  const acceptedWhileDeliveryWasBlocked = tasks.calls.filter(
    (call) => call["kind"] === "create",
  ).length;

  releaseAcknowledgement();
  await firstDispatch;
  await adapter.flushOutbox();

  assert.equal(returnedBeforeDelivery, true);
  assert.equal(acceptedWhileDeliveryWasBlocked, 2);
});

test("accepted owner messages use quiet in-place acknowledgement instead of working-card spam", async () => {
  const { adapter, api, clock } = fixture();
  const thread = { ...forumThread("300000000000000002"), appliedTagIds: [] };
  const starter = ownerMessage(thread.id, thread.id, "Start without a manual Intake tag.");
  const reply = ownerMessage("300000000000000003", thread.id, "Continue with this detail.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter, reply]);

  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.flushOutbox();
  await adapter.handleGatewayDispatch(messageDispatch(2, reply));
  await adapter.flushOutbox();
  clock.value += 8_000;
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Start without a manual Intake tag.",
    summary: "OpenDelegate is working on this Task.",
    significance: "status",
  });
  await adapter.flushOutbox();
  await adapter.handleGatewayDispatch(messageDispatch(2, reply));
  await adapter.flushOutbox();

  const acknowledgements = api.operations.filter(
    (operation) => operation["kind"] === "message-acknowledgement",
  );
  assert.deepEqual(
    acknowledgements.map((operation) => operation["messageId"]),
    [starter.id, reply.id],
  );
  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 0);
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "typing-refresh").length,
    1,
  );
});

test("a new owner message closes the prior acknowledgement after an adapter restart", async () => {
  const initial = fixture();
  const thread = forumThread("300000000000000005");
  const starter = ownerMessage(thread.id, thread.id, "Start the first turn.");
  const reply = ownerMessage("300000000000000006", thread.id, "Continue after the restart.");
  initial.api.threads.set(thread.id, thread);
  initial.api.messages.set(thread.id, [starter, reply]);

  await initial.adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await initial.adapter.flushOutbox();

  const restarted = fixture({
    repository: new InMemoryDiscordStateRepository(initial.repository.snapshot()),
    api: initial.api,
    tasks: initial.tasks,
    clock: initial.clock,
  });
  await restarted.adapter.handleGatewayDispatch(messageDispatch(2, reply));
  await restarted.adapter.flushOutbox();

  assert.deepEqual(
    initial.api.operations
      .filter((operation) => operation["kind"] === "message-acknowledgement-completed")
      .map((operation) => [operation["messageId"], operation["outcome"]]),
    [[starter.id, "success"]],
  );
  assert.deepEqual(
    initial.api.operations
      .filter((operation) => operation["kind"] === "message-acknowledgement")
      .map((operation) => operation["messageId"]),
    [starter.id, reply.id],
  );
});

test("one owner answer resolves the one durable question in place and resumes once", async () => {
  const initial = fixture();
  const { adapter, api, tasks, repository, clock } = initial;
  const thread = forumThread("300000000000000004");
  const starter = ownerMessage(thread.id, thread.id, "테스트를 위한 일감");
  const answer = ownerMessage(
    "300000000000000005",
    thread.id,
    "지금 접속 가능한 디바이스가 뭐뭐가 있어?",
  );
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter, answer]);

  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "waiting_user",
    objective: "테스트를 위한 일감",
    summary: "테스트에서 수행할 구체적인 작업과 기대 결과는 무엇인가요?",
    sourceEventId: "event_initial_owner_question",
    significance: "question",
  });
  await adapter.flushOutbox();

  tasks.afterAppendTaskInput = () => {
    api.online = false;
  };
  await adapter.handleGatewayDispatch(messageDispatch(2, answer));
  await adapter.flushOutbox();
  const restartedRepository = new InMemoryDiscordStateRepository(repository.snapshot());
  const restarted = fixture({
    repository: restartedRepository,
    api,
    tasks,
    clock,
  });
  clock.value += 60_000;
  api.online = true;
  await restarted.adapter.flushOutbox();
  await restarted.adapter.handleGatewayDispatch(messageDispatch(2, answer));

  assert.equal(tasks.calls.filter((call) => call["kind"] === "append").length, 1);
  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 1);
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "message-reconciled").length,
    0,
  );
  const edit = api.operations.find((operation) => operation["kind"] === "message-edit");
  const rendered = JSON.stringify(edit?.["payload"]);
  assert.match(rendered, /Input received/u);
  assert.match(rendered, /테스트에서 수행할 구체적인 작업/u);
  assert.doesNotMatch(rendered, /od:v1:/u);
  assert.equal(
    (await restartedRepository.listOutbox()).filter(
      (item) => item.action.kind === "resolve-owner-prompt" && item.delivered,
    ).length,
    1,
  );
  assert.equal(
    (await restartedRepository.listOutbox()).filter((item) => !item.delivered).length,
    0,
  );
});

test("source-event delivery identity adopts a delivered legacy projection after upgrade", async () => {
  const { adapter, api, repository, clock } = fixture();
  const thread = forumThread("300000000000000007");
  const starter = ownerMessage(thread.id, thread.id, "Retain the delivered question.");
  const projection: TaskChannelProjection = {
    taskId: "task-1",
    state: "waiting_user",
    objective: "Retain the delivered question.",
    summary: "Which release channel should OpenDelegate use?",
    sourceEventId: "event_legacy_question",
    significance: "question",
  };
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);

  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await recordDeliveredOutbox(repository, clock, "legacy-projection-digest:03-update", {
    kind: "post-task-update",
    taskId: projection.taskId,
    projection,
  });
  await adapter.publishTaskProjection(projection);
  await adapter.flushOutbox();

  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 0);
  assert.equal(
    (await repository.listOutbox()).filter(
      (item) =>
        item.action.kind === "post-task-update" &&
        item.action.projection.sourceEventId === projection.sourceEventId,
    ).length,
    1,
  );
});

test("one owner answer resolves every duplicate projection of the same legacy prompt", async () => {
  const { adapter, api, tasks, repository, clock } = fixture();
  const thread = forumThread("300000000000000008");
  const starter = ownerMessage(thread.id, thread.id, "테스트를 위한 일감");
  const answer = ownerMessage("300000000000000010", thread.id, "현재 기기 목록을 알려줘.");
  const projection: TaskChannelProjection = {
    taskId: "task-1",
    state: "waiting_user",
    objective: "테스트를 위한 일감",
    summary: "테스트에서 수행할 구체적인 작업과 기대 결과는 무엇인가요?",
    sourceEventId: "event_duplicated_legacy_question",
    significance: "question",
  };
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter, answer]);

  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection(projection);
  await adapter.flushOutbox();
  const original = (await repository.listOutbox()).find(
    (item) =>
      item.action.kind === "post-task-update" &&
      item.action.projection.sourceEventId === projection.sourceEventId,
  );
  assert.notEqual(original, undefined);
  if (original?.action.kind !== "post-task-update") {
    throw new Error("The canonical question delivery was not recorded.");
  }
  await repository.enqueueOutbox({
    id: "duplicate-legacy-projection:03-update",
    action: {
      kind: "post-task-update",
      taskId: projection.taskId,
      projection: original.action.projection,
    },
    createdAtMs: clock.nowMs() + 1,
    notBeforeMs: clock.nowMs(),
  });
  await adapter.flushOutbox();
  await adapter.handleGatewayDispatch(messageDispatch(2, answer));
  await adapter.flushOutbox();

  assert.equal(tasks.calls.filter((call) => call["kind"] === "append").length, 1);
  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 2);
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "message-edit").length,
    2,
  );
  assert.equal(
    (await repository.listOutbox()).filter(
      (item) => item.action.kind === "resolve-owner-prompt" && item.delivered,
    ).length,
    2,
  );
});

test("replies resume only their bound Task and unauthorized content never reaches the Task port", async () => {
  const { adapter, api, tasks } = fixture();
  const firstThread = forumThread("300000000000000011");
  const secondThread = forumThread("300000000000000012");
  const firstStarter = ownerMessage(firstThread.id, firstThread.id, "First clean context");
  const secondStarter = ownerMessage(secondThread.id, secondThread.id, "Second clean context");
  api.threads.set(firstThread.id, firstThread);
  api.threads.set(secondThread.id, secondThread);
  api.messages.set(firstThread.id, [firstStarter]);
  api.messages.set(secondThread.id, [secondStarter]);

  await adapter.handleGatewayDispatch(messageDispatch(1, firstStarter));
  await adapter.handleGatewayDispatch(messageDispatch(2, secondStarter));
  await adapter.handleGatewayDispatch(
    messageDispatch(
      3,
      ownerMessage("300000000000000099", firstThread.id, "Continue only the first task"),
    ),
  );
  await adapter.handleGatewayDispatch(
    messageDispatch(4, {
      ...ownerMessage("300000000000000100", firstThread.id, "DISCORD_TOKEN=do-not-leak"),
      author: { id: "999999999999999999", bot: false, roleIds: [] },
    }),
  );

  assert.deepEqual(
    tasks.calls.map((call) => [call["kind"], call["taskId"] ?? call["objective"]]),
    [
      ["create", "First clean context"],
      ["create", "Second clean context"],
      ["append", "task-1"],
    ],
  );
  assert.equal(JSON.stringify(tasks.calls).includes("do-not-leak"), false);
});

test("an attachment-only owner reply remains valid Task input without persisting a CDN URL", async () => {
  const { adapter, api, tasks } = fixture();
  const thread = forumThread("300000000000000013");
  const starter = ownerMessage(thread.id, thread.id, "Inspect the attached report");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));

  await adapter.handleGatewayDispatch(
    messageDispatch(2, {
      ...ownerMessage("300000000000000014", thread.id, ""),
      attachments: [
        {
          id: "400000000000000001",
          filename: "report.pdf",
          size: 1_024,
          mediaType: "application/pdf",
        },
      ],
    }),
  );

  const append = tasks.calls.find((call) => call["kind"] === "append");
  assert.equal(append?.["message"], "The owner attached 1 file through Discord.");
  assert.deepEqual(append?.["selectedInputRefs"], ["discord-attachment:400000000000000001"]);
  assert.doesNotMatch(JSON.stringify(append), /cdn\.discordapp|https?:\/\//);
});

test("restart reconciliation scans active and paged archived posts without duplicating work", async () => {
  const initial = fixture();
  const active = forumThread("300000000000000021");
  const archived = { ...forumThread("300000000000000022"), archived: true };
  const activeStarter = ownerMessage(active.id, active.id, "Active work");
  const archivedStarter = ownerMessage(archived.id, archived.id, "Archived work");
  const missedReply = ownerMessage("300000000000000023", archived.id, "Missed while Main was down");
  initial.api.threads.set(active.id, active);
  initial.api.threads.set(archived.id, archived);
  initial.api.messages.set(active.id, [activeStarter]);
  initial.api.messages.set(archived.id, [archivedStarter, missedReply]);
  initial.api.archivedPages.push([archived], []);

  await initial.adapter.reconcile();
  const snapshot = initial.repository.snapshot();
  const restartedRepository = new InMemoryDiscordStateRepository(snapshot);
  const restarted = fixture({
    repository: restartedRepository,
    api: initial.api,
    tasks: initial.tasks,
    clock: initial.clock,
  });
  await restarted.adapter.reconcile();

  assert.deepEqual(
    initial.tasks.calls.map((call) => call["kind"]),
    ["create", "create", "append"],
  );
  assert.equal((await restartedRepository.getBindingByThread(archived.id))?.archived, true);
});

test("Task projection retires its bootstrap panel when chronological work begins", async () => {
  const { adapter, api, repository } = fixture();
  const thread = {
    ...forumThread("300000000000000031"),
    appliedTagIds: [
      STATUS_TAGS.intake,
      "299999999999999991",
      "299999999999999992",
      "299999999999999993",
      "299999999999999994",
    ],
  };
  const starter = ownerMessage(thread.id, thread.id, "Render the report");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "intake",
    objective: "Render the report",
    summary: "OpenDelegate is reading this Task.",
    significance: "status",
  });
  await adapter.flushOutbox();
  const bootstrapPanel = api.operations.find((operation) => operation["kind"] === "panel");
  assert.notEqual(bootstrapPanel, undefined);

  const projection: TaskChannelProjection = {
    taskId: "task-1",
    state: "completed",
    objective: "Render the report",
    summary: "The report is ready with all checks passing.",
    sourceEventId: "event_report_completed",
    significance: "final",
    artifact: {
      label: "Open report",
      url: "https://artifacts.example.test/reports/release",
    },
    inspectUrl: "https://admin.example.test/tasks/task-1",
  };
  await adapter.publishTaskProjection(projection);
  await adapter.flushOutbox();
  await adapter.publishTaskProjection(projection);
  await adapter.flushOutbox();

  const tagOperations = api.operations.filter((operation) => operation["kind"] === "tags");
  assert.deepEqual(tagOperations.at(-1)?.["appliedTagIds"], [
    "299999999999999991",
    "299999999999999992",
    "299999999999999993",
    "299999999999999994",
    STATUS_TAGS.done,
  ]);
  const panels = api.operations.filter((operation) => operation["kind"] === "panel");
  assert.equal(panels.length, 1);
  assert.deepEqual(
    api.operations
      .filter((operation) => operation["kind"] === "message-delete")
      .map((operation) => operation["messageId"]),
    [bootstrapPanel?.["messageId"]],
  );
  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 1);
  const resultPayload = api.operations.find((operation) => operation["kind"] === "message")?.[
    "payload"
  ];
  assert.match(JSON.stringify(resultPayload), /Open report/u);
  assert.match(JSON.stringify(resultPayload), /Inspect runs/u);
  assert.deepEqual(
    api.operations
      .filter((operation) => operation["kind"] === "message-acknowledgement-completed")
      .map((operation) => operation["outcome"]),
    ["success"],
  );
  assert.equal((await repository.getBindingByTask("task-1"))?.externalState, "available");
});

test("a completed Task uploads its verified small Artifact as one native Discord file", async () => {
  const bytes = new TextEncoder().encode("Native Discord result\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let reads = 0;
  const { adapter, api } = fixture({
    artifactAttachments: {
      read: async (artifactId) => {
        reads += 1;
        assert.equal(artifactId, "artifact-native-result");
        return {
          metadata: {
            artifactId,
            taskId: "task-1",
            originalFilename: "result.txt",
            mediaType: "text/plain",
            sizeBytes: bytes.byteLength,
            checksum: { algorithm: "sha256", value: sha256 },
          },
          bytes,
        };
      },
    },
  });
  const thread = forumThread("300000000000000032");
  const starter = ownerMessage(thread.id, thread.id, "Create a text result");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));

  const projection: TaskChannelProjection = {
    taskId: "task-1",
    state: "completed",
    objective: "Create a text result",
    summary: "The text result is ready.",
    sourceEventId: "event_native_result_completed",
    significance: "final",
    artifact: {
      label: "Open report",
      url: "https://artifacts.example.test/artifacts/artifact-native-result",
      nativeAttachment: {
        artifactId: "artifact-native-result",
        filename: "result.txt",
        mediaType: "text/plain",
        sizeBytes: bytes.byteLength,
        sha256,
      },
    },
  };
  await adapter.publishTaskProjection(projection);
  await adapter.flushOutbox();
  await adapter.publishTaskProjection(projection);
  await adapter.flushOutbox();

  const messages = api.operations.filter((operation) => operation["kind"] === "message");
  assert.equal(messages.length, 1);
  assert.equal(reads, 1);
  assert.deepEqual(messages[0]?.["attachment"], {
    filename: "result.txt",
    mediaType: "text/plain",
    bytes,
  });
  assert.match(JSON.stringify(messages[0]?.["payload"]), /attachment:\/\/result\.txt/u);
  assert.match(JSON.stringify(messages[0]?.["payload"]), /Open report/u);
});

test("one bounded live activity message is edited and closed for a Task cycle", async () => {
  const { adapter, api, repository } = fixture();
  const thread = forumThread("300000000000000041");
  const starter = ownerMessage(thread.id, thread.id, "Run the cross-device release.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));

  const base: TaskChannelProjection = {
    taskId: "task-1",
    state: "running",
    objective: "Run the cross-device release.",
    summary: "OpenDelegate is coordinating the release.",
    significance: "status",
    activity: {
      cycleId: "activity_cycle_1",
      revision: 1,
      updatedAtMs: 1_000,
      phase: "working",
      completedWorkOrders: 0,
      totalWorkOrders: 2,
      milestones: [
        {
          key: "work-order:windows",
          status: "active",
          summary: "The Worker is running tests.",
          deviceId: "device_windows_1",
          deviceLabel: "Windows build workstation",
        },
      ],
    },
  };
  await adapter.publishTaskProjection(base);
  await adapter.flushOutbox();
  await adapter.publishTaskProjection({
    ...base,
    approval: {
      approvalId: "approval-worker-action-first",
      description: "Windows build workstation wants approval for one protected action.",
    },
  });
  await adapter.flushOutbox();
  await adapter.publishTaskProjection({
    ...base,
    approval: {
      approvalId: "approval-worker-action-second",
      description: "Mac Studio wants to temporarily expand its sandbox for this Task.",
    },
    activity: {
      ...base.activity!,
      revision: 2,
      updatedAtMs: 11_000,
      completedWorkOrders: 1,
      milestones: [
        {
          key: "work-order:windows",
          status: "completed",
          summary: "Windows tests completed.",
          deviceId: "device_windows_1",
          deviceLabel: "Windows build workstation",
        },
        {
          key: "work-order:macos",
          status: "active",
          summary: "The Worker is building the macOS package.",
          deviceId: "device_macos_1",
          deviceLabel: "Mac Studio",
        },
      ],
    },
  });
  await adapter.flushOutbox();

  const activityWrites = api.operations.filter(
    (operation) =>
      operation["kind"] === "panel" &&
      typeof operation["requestKey"] === "string" &&
      operation["requestKey"].startsWith("task-activity:"),
  );
  assert.equal(activityWrites.length, 3);
  assert.equal(activityWrites[0]?.["messageId"], activityWrites[1]?.["messageId"]);
  assert.equal(activityWrites[1]?.["messageId"], activityWrites[2]?.["messageId"]);
  assert.match(JSON.stringify(activityWrites[1]?.["payload"]), /approval-worker-action-first/u);
  assert.match(JSON.stringify(activityWrites.at(-1)?.["payload"]), /Mac Studio/u);
  assert.match(
    JSON.stringify(activityWrites.at(-1)?.["payload"]),
    /approval-worker-action-second/u,
  );
  assert.match(JSON.stringify(activityWrites.at(-1)?.["payload"]), /Approval needed/u);
  assert.match(JSON.stringify(activityWrites.at(-1)?.["payload"]), /Approve/u);
  assert.doesNotMatch(JSON.stringify(activityWrites.at(-1)?.["payload"]), /Pause/u);
  assert.equal((await repository.getBindingByTask("task-1"))?.activitySurface?.state, "open");

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "completed",
    objective: "Run the cross-device release.",
    summary: "The cross-device release completed.",
    sourceEventId: "event_release_completed",
    significance: "final",
  });
  await adapter.flushOutbox();
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "message-delete").length,
    1,
  );
  const closedActivity = (await repository.getBindingByTask("task-1"))?.activitySurface;
  assert.equal(closedActivity?.cycleId, "activity_cycle_1");
  assert.equal(closedActivity?.revision, 3);
  assert.equal(closedActivity?.updatedAtMs, 11_000);
  assert.equal(closedActivity?.state, "closed");
  assert.equal(Number.isSafeInteger(closedActivity?.outboxCreatedAtMs), true);

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "completed",
    objective: "Run the cross-device release.",
    summary: "The cross-device release completed.",
    sourceEventId: "event_release_completed",
    significance: "final",
  });
  await adapter.flushOutbox();
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "message-delete").length,
    1,
  );
});

test("pause replaces live progress with one idempotent recovery surface", async () => {
  const { adapter, api, repository } = fixture();
  const thread = forumThread("300000000000000046");
  const starter = ownerMessage(thread.id, thread.id, "Pause and resume this Task safely.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Pause and resume this Task safely.",
    summary: "The Task is running.",
    significance: "status",
    activity: {
      cycleId: "activity_running_before_pause",
      revision: 1,
      updatedAtMs: 1_000,
      phase: "working",
      completedWorkOrders: 0,
      totalWorkOrders: 1,
      milestones: [
        {
          key: "work-order:safe-check",
          status: "active",
          summary: "The Worker is performing a read-only check.",
        },
      ],
    },
  });
  await adapter.flushOutbox();

  const paused: TaskChannelProjection = {
    taskId: "task-1",
    state: "paused",
    objective: "Pause and resume this Task safely.",
    summary: "This Task is paused.",
    significance: "status",
    activity: {
      cycleId: "paused_event_pause_1",
      revision: 1,
      updatedAtMs: 2_000,
      phase: "planning",
      completedWorkOrders: 0,
      totalWorkOrders: 0,
      milestones: [
        {
          key: "paused:task-1",
          status: "active",
          summary: "Execution is paused until the owner resumes this Task.",
        },
      ],
    },
  };
  await adapter.publishTaskProjection(paused);
  await adapter.flushOutbox();

  let activityWrites = api.operations.filter(
    (operation) =>
      operation["kind"] === "panel" &&
      typeof operation["requestKey"] === "string" &&
      operation["requestKey"].startsWith("task-activity:"),
  );
  assert.equal(activityWrites.length, 2);
  const pausedPayload = JSON.stringify(activityWrites.at(-1)?.["payload"]);
  assert.match(pausedPayload, /OpenDelegate is paused/u);
  assert.match(pausedPayload, /Resume/u);
  assert.match(pausedPayload, /Cancel/u);
  assert.doesNotMatch(pausedPayload, /Pause/u);
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "message-delete").length,
    1,
  );
  const pausedSurface = (await repository.getBindingByTask("task-1"))?.activitySurface;
  assert.equal(pausedSurface?.cycleId, "paused_event_pause_1");
  assert.equal(pausedSurface?.revision, 1);
  assert.equal(pausedSurface?.updatedAtMs, 2_000);
  assert.equal(pausedSurface?.state, "open");
  assert.equal(Number.isSafeInteger(pausedSurface?.outboxCreatedAtMs), true);
  assert.equal(typeof pausedSurface?.messageId, "string");

  await adapter.publishTaskProjection(paused);
  await adapter.flushOutbox();
  activityWrites = api.operations.filter(
    (operation) =>
      operation["kind"] === "panel" &&
      typeof operation["requestKey"] === "string" &&
      operation["requestKey"].startsWith("task-activity:"),
  );
  assert.equal(activityWrites.length, 2);

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Pause and resume this Task safely.",
    summary: "The same Task resumed.",
    significance: "status",
    activity: {
      cycleId: "activity_running_after_resume",
      revision: 1,
      updatedAtMs: 3_000,
      phase: "planning",
      completedWorkOrders: 0,
      totalWorkOrders: 0,
      milestones: [
        {
          key: "main:planning",
          status: "active",
          summary: "Main resumed the same Task.",
        },
      ],
    },
  });
  await adapter.flushOutbox();
  activityWrites = api.operations.filter(
    (operation) =>
      operation["kind"] === "panel" &&
      typeof operation["requestKey"] === "string" &&
      operation["requestKey"].startsWith("task-activity:"),
  );
  assert.equal(activityWrites.length, 3);
  const resumedPayload = JSON.stringify(activityWrites.at(-1)?.["payload"]);
  assert.match(resumedPayload, /OpenDelegate is working/u);
  assert.match(resumedPayload, /Pause/u);
  assert.doesNotMatch(resumedPayload, /Resume/u);
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "message-delete").length,
    2,
  );
});

test("live activity never exposes an opaque Device identifier when its label is unavailable", async () => {
  const { adapter, api } = fixture();
  const thread = forumThread("300000000000000044");
  const starter = ownerMessage(thread.id, thread.id, "Run on whichever Device is ready.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Run on whichever Device is ready.",
    summary: "OpenDelegate selected a Worker.",
    significance: "status",
    activity: {
      cycleId: "activity_private_device_id",
      revision: 1,
      updatedAtMs: 1_000,
      phase: "working",
      completedWorkOrders: 0,
      totalWorkOrders: 1,
      milestones: [
        {
          key: "work-order:private-device",
          status: "active",
          summary: "Worker Agent is making progress.",
          deviceId: "device_229781e7-644b-4f0e-bbd4-e881c0d4ee4c",
        },
      ],
    },
  });
  await adapter.flushOutbox();

  const payload = JSON.stringify(
    api.operations
      .filter(
        (operation) =>
          operation["kind"] === "panel" &&
          typeof operation["requestKey"] === "string" &&
          operation["requestKey"].startsWith("task-activity:"),
      )
      .at(-1)?.["payload"],
  );
  assert.match(payload, /Worker Device/u);
  assert.doesNotMatch(payload, /device_229781e7/u);
});

test("terminal delivery tombstones a delayed live activity before it can appear", async () => {
  const { adapter, api, repository, clock } = fixture();
  const thread = forumThread("300000000000000042");
  const starter = ownerMessage(thread.id, thread.id, "Finish before the live card retries.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));

  api.failTaskActivityUpserts = true;
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Finish before the live card retries.",
    summary: "The Task is running.",
    significance: "status",
    activity: {
      cycleId: "activity_delayed_cycle",
      revision: 1,
      updatedAtMs: 1_000,
      phase: "working",
      completedWorkOrders: 0,
      totalWorkOrders: 1,
      milestones: [
        {
          key: "work-order:delayed",
          status: "active",
          summary: "The Worker is completing the Work Order.",
          deviceId: "Linux Worker",
        },
      ],
    },
  });
  await adapter.flushOutbox();
  assert.equal((await repository.getBindingByTask("task-1"))?.activitySurface, undefined);

  api.failTaskActivityUpserts = false;
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "completed",
    objective: "Finish before the live card retries.",
    summary: "The Task completed.",
    sourceEventId: "event_fast_completion",
    significance: "final",
  });
  await adapter.flushOutbox();
  const tombstone = (await repository.getBindingByTask("task-1"))?.activitySurface;
  assert.equal(tombstone?.cycleId, "activity_delayed_cycle");
  assert.equal(tombstone?.revision, 2);
  assert.equal(tombstone?.updatedAtMs, 1_000);
  assert.equal(tombstone?.state, "closed");
  assert.equal(Number.isSafeInteger(tombstone?.outboxCreatedAtMs), true);

  clock.value = 2_000;
  await adapter.flushOutbox();
  assert.equal(
    api.operations.filter(
      (operation) =>
        operation["kind"] === "panel" &&
        typeof operation["requestKey"] === "string" &&
        operation["requestKey"].startsWith("task-activity:"),
    ).length,
    0,
  );
  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 1);
});

test("a restarted Main replaces an older activity cycle even when its revision resets", async () => {
  const first = fixture();
  const thread = forumThread("300000000000000043");
  const starter = ownerMessage(thread.id, thread.id, "Continue this Task after Main restarts.");
  first.api.threads.set(thread.id, thread);
  first.api.messages.set(thread.id, [starter]);
  await first.adapter.handleGatewayDispatch(messageDispatch(1, starter));
  const projection: TaskChannelProjection = {
    taskId: "task-1",
    state: "running",
    objective: "Continue this Task after Main restarts.",
    summary: "The Task is running.",
    significance: "status",
    activity: {
      cycleId: "activity_before_restart",
      revision: 9,
      updatedAtMs: 1_000,
      phase: "working",
      completedWorkOrders: 0,
      totalWorkOrders: 1,
      milestones: [
        {
          key: "work-order:restart",
          status: "active",
          summary: "The first Main process is coordinating the Worker.",
        },
      ],
    },
  };
  await first.adapter.publishTaskProjection(projection);
  await first.adapter.flushOutbox();

  const restarted = fixture({
    repository: first.repository,
    api: first.api,
    tasks: first.tasks,
    clock: first.clock,
  });
  await restarted.adapter.publishTaskProjection({
    ...projection,
    activity: {
      ...projection.activity!,
      cycleId: "activity_after_restart",
      revision: 1,
      milestones: [
        {
          key: "work-order:restart",
          status: "active",
          summary: "The restarted Main process recovered the active Worker Run.",
        },
      ],
    },
  });
  await restarted.adapter.flushOutbox();

  const activityWrites = first.api.operations.filter(
    (operation) =>
      operation["kind"] === "panel" &&
      typeof operation["requestKey"] === "string" &&
      operation["requestKey"].startsWith("task-activity:"),
  );
  assert.equal(activityWrites.length, 2);
  assert.notEqual(activityWrites[0]?.["messageId"], activityWrites[1]?.["messageId"]);
  assert.equal(
    first.api.operations.filter((operation) => operation["kind"] === "message-delete").length,
    1,
  );
  assert.equal(
    (await first.repository.getBindingByTask("task-1"))?.activitySurface?.cycleId,
    "activity_after_restart",
  );
});

test("a completed Task without links renders valid Components v2 without an empty action row", () => {
  const payload = renderStatusPanel({
    taskId: "task-complete",
    state: "completed",
    objective: "Finish cleanly",
    summary: "Nothing else needs to be opened.",
    sourceEventId: "event_task_completed",
    significance: "final",
  });
  const container = payload.components[0];
  assert.equal(container?.type, 17);
  assert.equal(
    container?.type === 17 && container.components.some((component) => component.type === 1),
    false,
  );
});

test("a review result is historical and carries no active pause or cancel controls", () => {
  const payload = renderTaskUpdate({
    taskId: "task-review-inactive",
    state: "review",
    objective: "Review the generated result.",
    summary: "The result is ready for owner review.",
    sourceEventId: "event_review_inactive",
    significance: "decision",
  });
  const rendered = JSON.stringify(payload);
  assert.doesNotMatch(rendered, /od:v1:pause/u);
  assert.doesNotMatch(rendered, /od:v1:cancel/u);
});

test("the stable status panel does not repeat the Forum title or chronological owner question", () => {
  const payload = renderStatusPanel({
    taskId: "task-waiting",
    state: "waiting_user",
    objective: "테스트를 위한 일감",
    summary: "테스트에서 수행할 구체적인 작업과 기대 결과는 무엇인가요?",
    sourceEventId: "event_owner_question",
    significance: "question",
  });
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /Task status/u);
  assert.match(rendered, /Waiting/u);
  assert.match(rendered, /latest message/u);
  assert.doesNotMatch(rendered, /테스트를 위한 일감/u);
  assert.doesNotMatch(rendered, /테스트에서 수행할 구체적인 작업/u);
  assert.doesNotMatch(rendered, /od:v1:/u);
});

test("a localized resource wait keeps the current owner controls on the stable status panel", () => {
  const payload = renderStatusPanel(
    {
      taskId: "task-waiting-resource",
      state: "waiting_resource",
      objective: "두 기기에서 안전한 읽기 전용 점검을 해줘.",
      summary:
        "No eligible Worker is online for this Work Order. OpenDelegate will continue automatically when relevant resource availability changes. Waiting does not consume the automatic retry Budget. Resource code: WORKER_OFFLINE.",
      significance: "status",
    },
    "ko",
  );
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /작업 상태/u);
  assert.match(rendered, /대기 중/u);
  assert.match(rendered, /이 작업을 맡을 수 있는 Worker가 현재 오프라인입니다/u);
  assert.match(rendered, /다시 온라인이 되면 OpenDelegate가 자동으로 계속합니다/u);
  assert.match(rendered, /일시정지/u);
  assert.match(rendered, /취소/u);
  assert.match(rendered, /od:v1:pause/u);
  assert.match(rendered, /od:v1:cancel/u);
  assert.doesNotMatch(rendered, /No eligible Worker is online/u);
});

test("a localized Workspace wait does not leak deterministic English into Korean Discord", () => {
  const payload = renderStatusPanel(
    {
      taskId: "task-waiting-workspace",
      state: "waiting_resource",
      objective: "Mac에서 읽기 전용 점검을 해줘.",
      summary:
        "The Worker could not resolve a registered Workspace for this Run. OpenDelegate will continue automatically when relevant resource availability changes. Waiting does not consume the automatic retry Budget.",
      significance: "status",
    },
    "ko",
  );
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /등록된 Workspace를 준비하지 못했어요/u);
  assert.match(rendered, /자동 재시도 횟수는 차감되지 않습니다/u);
  assert.doesNotMatch(rendered, /could not resolve a registered Workspace/u);
  assert.match(rendered, /od:v1:pause/u);
  assert.match(rendered, /od:v1:cancel/u);
});

test("a Korean resource wait localizes the deterministic suffix after an Agent-authored explanation", () => {
  const payload = renderStatusPanel(
    {
      taskId: "task-waiting-artifact",
      state: "waiting_resource",
      objective: "결과 파일을 전달해 줘.",
      summary:
        "Artifact 승격 증거를 기다리고 있습니다. OpenDelegate will continue automatically when relevant resource availability changes. Waiting does not consume the automatic retry Budget.",
      significance: "status",
    },
    "ko",
  );
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /Artifact 승격 증거를 기다리고 있습니다/u);
  assert.match(rendered, /관련 기기나 리소스 상태가 바뀌면 OpenDelegate가 자동으로 계속합니다/u);
  assert.match(rendered, /자동 재시도 횟수는 차감되지 않습니다/u);
  assert.doesNotMatch(rendered, /relevant resource availability changes/u);
});

test("sequential Worker Approvals are localized and explicitly approve once", () => {
  const payload = renderTaskActivity(
    {
      taskId: "task-sequential-approval",
      state: "running",
      objective: "Windows에서 결과 파일을 만들어 전달해 줘.",
      summary: "OpenDelegate is working on this Task.",
      significance: "status",
      activity: {
        cycleId: "activity-sequential-approval",
        revision: 9,
        updatedAtMs: 9_000,
        phase: "working",
        completedWorkOrders: 0,
        totalWorkOrders: 1,
        milestones: [
          {
            key: "worker:windows",
            status: "active",
            summary: "Worker Agent is waiting for owner approval.",
            deviceLabel: "5090White",
          },
        ],
      },
      approval: {
        approvalId: "approval-sequential-9",
        description: "English fallback must not be shown in Korean.",
        sequence: 9,
        remaining: 1,
        deviceLabel: "5090White",
        actionCategory: "sandbox-boundary-escalation",
        risk: "medium",
      },
    },
    "ko",
  );
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /이 작업의 9번째 보호 동작/u);
  assert.match(rendered, /5090White/u);
  assert.match(rendered, /Task 전용 샌드박스 범위를 일시적으로 넓히려고 해요/u);
  assert.match(rendered, /위험도: 보통/u);
  assert.match(rendered, /추가 승인 요청 1개/u);
  assert.match(rendered, /이 동작만 승인/u);
  assert.doesNotMatch(rendered, /English fallback/u);
  assert.doesNotMatch(rendered, /"label":"승인"/u);
});

test("a chronological failure update carries its Retry control", () => {
  const payload = renderTaskUpdate({
    taskId: "task-failed",
    state: "failed",
    objective: "Reach an eligible Worker.",
    summary: "No eligible Worker is online after three automatic attempts.",
    sourceEventId: "event_worker_failed",
    significance: "failure",
  });
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /Task needs attention/);
  assert.match(rendered, /No eligible Worker is online/);
  assert.match(rendered, /Retry/);
  assert.match(rendered, /od:v1:retry/);
});

test("a Korean failure update localizes deterministic diagnostics without rewriting the Worker report", () => {
  const payload = renderTaskUpdate(
    {
      taskId: "task-localized-worker-failure",
      state: "failed",
      objective: "Windows에서 결과 파일을 만들어 전달해 줘.",
      summary:
        "Worker Run failed during execution (PROCESS_FAILED). OpenDelegate did not automatically replay this process because its external outcome may be uncertain. Review Task Runs, then use Retry.\n\nLast Worker report (may be incomplete):\n파일을 만들기 전에 안전한 경로를 확인했습니다.",
      sourceEventId: "event_localized_worker_failure",
      significance: "failure",
    },
    "ko",
  );
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /실행 단계에서 실패했습니다 \(PROCESS_FAILED\)/u);
  assert.match(rendered, /자동으로 다시 실행하지 않았습니다/u);
  assert.match(rendered, /마지막 Worker 보고\(불완전할 수 있음\)/u);
  assert.match(rendered, /파일을 만들기 전에 안전한 경로를 확인했습니다/u);
  assert.doesNotMatch(rendered, /Worker Run failed during/u);
  assert.doesNotMatch(rendered, /Last Worker report/u);
  assert.match(rendered, /다시 시도/u);
});

test("a Korean Artifact failure names the owner-facing delivery stage", () => {
  const payload = renderTaskUpdate(
    {
      taskId: "task-localized-artifact-failure",
      state: "failed",
      objective: "결과 파일을 전달해 줘.",
      summary:
        "Worker Run encountered a retryable failure during artifact (ARTIFACT_PROMOTION_FAILED).\n\nLast Worker report (may be incomplete):\n파일 생성은 완료했습니다.",
      sourceEventId: "event_localized_artifact_failure",
      significance: "failure",
    },
    "ko",
  );
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /단계: 결과 파일 전달 · 코드: ARTIFACT_PROMOTION_FAILED/u);
  assert.match(rendered, /파일 생성은 완료했습니다/u);
  assert.doesNotMatch(rendered, /단계: artifact/u);
});

test("one failure card follows the current pending approval without creating message noise", async () => {
  const { adapter, api, repository } = fixture();
  const thread = forumThread("300000000000000136");
  const starter = ownerMessage(thread.id, thread.id, "Run bounded work across two Devices.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);

  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "failed",
    objective: "Run bounded work across two Devices.",
    summary: "The read-only Worker attempt needs owner attention.",
    sourceEventId: "event_multi_device_failure",
    significance: "failure",
    approval: {
      approvalId: "approval-first",
      description: "Allow the first exact read-only retry?",
    },
  });
  await adapter.flushOutbox();

  const failureMessage = api.operations.find(
    (operation) =>
      operation["kind"] === "message" &&
      JSON.stringify(operation["payload"]).includes("approval-first"),
  );
  assert.notEqual(failureMessage, undefined);
  const originalSurface = (await repository.getBindingByTask("task-1"))?.failureSurface;

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "failed",
    objective: "Run bounded work across two Devices.",
    summary: "The read-only Worker attempt needs owner attention.",
    sourceEventId: "event_multi_device_failure",
    significance: "failure",
    approval: {
      approvalId: "approval-second",
      description: "Allow the second exact read-only retry?",
    },
  });
  await adapter.flushOutbox();

  const approvalEdit = api.operations
    .filter(
      (operation) =>
        operation["kind"] === "message-edit" &&
        operation["messageId"] === failureMessage?.["messageId"],
    )
    .at(-1);
  const approvalRendered = JSON.stringify(approvalEdit?.["payload"]);
  assert.match(approvalRendered, /Approval needed/u);
  assert.match(approvalRendered, /second exact read-only retry/u);
  assert.match(approvalRendered, /approval-second/u);
  assert.doesNotMatch(approvalRendered, /approval-first/u);

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "failed",
    objective: "Run bounded work across two Devices.",
    summary: "The read-only Worker attempt needs owner attention.",
    sourceEventId: "event_multi_device_failure",
    significance: "failure",
  });
  await adapter.flushOutbox();

  const retryEdit = api.operations
    .filter(
      (operation) =>
        operation["kind"] === "message-edit" &&
        operation["messageId"] === failureMessage?.["messageId"],
    )
    .at(-1);
  const retryRendered = JSON.stringify(retryEdit?.["payload"]);
  assert.match(retryRendered, /od:v1:retry/u);
  assert.doesNotMatch(retryRendered, /Approval needed/u);
  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 1);
  assert.deepEqual((await repository.getBindingByTask("task-1"))?.failureSurface, originalSurface);
  assert.equal(
    (await repository.listOutbox()).filter(
      (item) => item.action.kind === "refresh-task-failure" && item.delivered,
    ).length,
    2,
  );
});

test("one owner prompt drops stale approval controls in place", async () => {
  const { adapter, api, repository } = fixture();
  const thread = forumThread("300000000000000137");
  const starter = ownerMessage(thread.id, thread.id, "Inspect two registered Devices.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);

  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  const waitingProjection: TaskChannelProjection = {
    taskId: "task-1",
    state: "waiting_user",
    objective: "Inspect two registered Devices.",
    summary: "The automatic retry limit was reached. Extend it only if more work is wanted.",
    sourceEventId: "event_retry_limit_reached",
    significance: "question",
    approval: {
      approvalId: "approval-stale-control",
      description: "Allow the NAS Worker to expand its sandbox?",
    },
  };
  await adapter.publishTaskProjection(waitingProjection);
  await adapter.flushOutbox();

  const promptMessage = api.operations.find(
    (operation) =>
      operation["kind"] === "message" &&
      JSON.stringify(operation["payload"]).includes("approval-stale-control"),
  );
  assert.notEqual(promptMessage, undefined);
  const promptSurface = (await repository.getBindingByTask("task-1"))?.ownerPromptSurface;
  assert.equal(promptSurface?.requestKey, promptMessage?.["requestKey"]);
  assert.equal(promptSurface?.sourceEventId, "event_retry_limit_reached");
  assert.equal(promptSurface?.messageId, promptMessage?.["messageId"]);
  assert.equal(promptSurface?.state, "open");
  assert.equal(Number.isSafeInteger(promptSurface?.outboxCreatedAtMs), true);

  await adapter.publishTaskProjection({
    taskId: waitingProjection.taskId,
    state: waitingProjection.state,
    objective: waitingProjection.objective,
    summary: waitingProjection.summary,
    sourceEventId: "event_retry_limit_reached",
    significance: waitingProjection.significance,
  });
  await adapter.flushOutbox();

  const promptEdit = api.operations
    .filter(
      (operation) =>
        operation["kind"] === "message-edit" &&
        operation["messageId"] === promptMessage?.["messageId"],
    )
    .at(-1);
  const rendered = JSON.stringify(promptEdit?.["payload"]);
  assert.match(rendered, /automatic retry limit/u);
  assert.match(rendered, /od:v1:cancel/u);
  assert.doesNotMatch(rendered, /Approval needed/u);
  assert.doesNotMatch(rendered, /approval-stale-control/u);
  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 1);
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "message-reconciled").length,
    0,
  );
  assert.equal(
    (await repository.getBindingByTask("task-1"))?.ownerPromptSurface?.messageId,
    promptMessage?.["messageId"],
  );
  assert.equal(
    (await repository.listOutbox()).filter(
      (item) => item.action.kind === "refresh-owner-prompt" && item.delivered,
    ).length,
    1,
  );
});

test("a successful retry resolves the prior failure control in place", async () => {
  const { adapter, api, repository } = fixture();
  const thread = forumThread("300000000000000134");
  const starter = ownerMessage(thread.id, thread.id, "Recover after a bounded failure.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);

  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "failed",
    objective: "Recover after a bounded failure.",
    summary: "The first attempt could not produce a valid plan.",
    sourceEventId: "event_retryable_failure",
    significance: "failure",
  });
  await adapter.flushOutbox();

  const failureMessage = api.operations.find(
    (operation) =>
      operation["kind"] === "message" &&
      JSON.stringify(operation["payload"]).includes("od:v1:retry"),
  );
  assert.notEqual(failureMessage, undefined);
  api.forgetMessageRequestKeys();

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Recover after a bounded failure.",
    summary: "The retry is now running.",
    significance: "status",
  });
  await adapter.flushOutbox();
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Recover after a bounded failure.",
    summary: "The retry is now running.",
    significance: "status",
  });
  await adapter.flushOutbox();

  const resolvedFailures = api.operations.filter(
    (operation) =>
      operation["kind"] === "message-edit" &&
      operation["messageId"] === failureMessage?.["messageId"],
  );
  assert.equal(resolvedFailures.length, 1);
  const resolvedFailure = resolvedFailures[0];
  assert.notEqual(resolvedFailure, undefined);
  const rendered = JSON.stringify(resolvedFailure?.["payload"]);
  assert.match(rendered, /Retry started/u);
  assert.doesNotMatch(rendered, /od:v1:retry/u);
  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 1);
  assert.deepEqual((await repository.getBindingByTask("task-1"))?.failureSurface, {
    requestKey: failureMessage?.["requestKey"],
    sourceEventId: "event_retryable_failure",
    messageId: failureMessage?.["messageId"],
    outboxCreatedAtMs: 1_003,
    state: "resolved",
  });
});

test("retrying a cancellation resolves its old button and keeps one localized current surface", async () => {
  const { adapter, api, repository } = fixture({ presentationLocale: "ko" });
  const thread = forumThread("300000000000000145");
  const starter = ownerMessage(thread.id, thread.id, "두 기기에서 안전한 읽기 전용 점검을 해줘.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "cancelled",
    objective: "두 기기에서 안전한 읽기 전용 점검을 해줘.",
    summary: "This Task was cancelled.",
    sourceEventId: "event_cancelled_first",
    significance: "final",
  });
  await adapter.flushOutbox();

  const cancelled = api.operations.find(
    (operation) =>
      operation["kind"] === "message" &&
      JSON.stringify(operation["payload"]).includes("od:v1:retry"),
  );
  assert.notEqual(cancelled, undefined);
  assert.match(JSON.stringify(cancelled?.["payload"]), /작업을 취소했어요/u);
  assert.match(JSON.stringify(cancelled?.["payload"]), /다시 시도/u);
  assert.equal((await repository.getBindingByTask("task-1"))?.failureSurface?.state, "open");

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "두 기기에서 안전한 읽기 전용 점검을 해줘.",
    summary: "OpenDelegate is working on this Task.",
    significance: "status",
    activity: {
      cycleId: "activity_retry_after_cancel",
      revision: 1,
      updatedAtMs: 2_000,
      phase: "working",
      completedWorkOrders: 0,
      totalWorkOrders: 2,
      milestones: [
        {
          key: "main:planning",
          status: "active",
          summary: "Main is planning the work.",
        },
        {
          key: "main:prepared",
          status: "completed",
          summary: "Main prepared 2 Work Orders.",
        },
        {
          key: "worker:progress",
          status: "active",
          summary: "Worker Agent is making progress.",
          deviceLabel: "5090White",
        },
      ],
    },
  });
  await adapter.flushOutbox();

  const resolved = api.operations.find(
    (operation) =>
      operation["kind"] === "message-edit" && operation["messageId"] === cancelled?.["messageId"],
  );
  assert.match(JSON.stringify(resolved?.["payload"]), /다시 시작했어요/u);
  assert.doesNotMatch(JSON.stringify(resolved?.["payload"]), /od:v1:retry/u);
  assert.equal((await repository.getBindingByTask("task-1"))?.failureSurface?.state, "resolved");

  const liveActivity = api.operations.find(
    (operation) =>
      operation["kind"] === "panel" && String(operation["requestKey"]).startsWith("task-activity:"),
  );
  const liveRendered = JSON.stringify(liveActivity?.["payload"]);
  assert.match(liveRendered, /OpenDelegate가 작업 중이에요/u);
  assert.match(liveRendered, /Main이 작업을 계획하고 있어요/u);
  assert.match(liveRendered, /Main이 Worker에 배정할 작업 2개를 준비했어요/u);
  assert.match(liveRendered, /Worker가 작업을 진행하고 있어요/u);
  assert.match(liveRendered, /일시정지/u);
  assert.match(liveRendered, /취소/u);
  assert.doesNotMatch(liveRendered, /OpenDelegate is working/u);
  assert.doesNotMatch(liveRendered, /Main prepared 2 Work Orders/u);
  assert.doesNotMatch(liveRendered, /Worker Agent is making progress/u);
  assert.equal(api.operations.filter((operation) => operation["kind"] === "message").length, 1);
});

test("a fast retry resolves its failure when projection coalescing observes only completion", async () => {
  const { adapter, api, repository } = fixture();
  const thread = forumThread("300000000000000135");
  const starter = ownerMessage(thread.id, thread.id, "Recover through a fast direct result.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);

  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "failed",
    objective: "Recover through a fast direct result.",
    summary: "The previous attempt failed before execution.",
    sourceEventId: "event_fast_retry_failure",
    significance: "failure",
  });
  await adapter.flushOutbox();
  const failureMessage = api.operations.find(
    (operation) =>
      operation["kind"] === "message" &&
      JSON.stringify(operation["payload"]).includes("od:v1:retry"),
  );
  assert.notEqual(failureMessage, undefined);

  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "completed",
    objective: "Recover through a fast direct result.",
    summary: "The retry completed before the next projection poll.",
    sourceEventId: "event_fast_retry_completed",
    significance: "final",
  });
  await adapter.flushOutbox();

  assert.equal(
    api.operations.filter(
      (operation) =>
        operation["kind"] === "message-edit" &&
        operation["messageId"] === failureMessage?.["messageId"],
    ).length,
    1,
  );
  assert.equal((await repository.getBindingByTask("task-1"))?.failureSurface?.state, "resolved");
});

test("a failed turn replaces the newest owner-message acknowledgement with failure", async () => {
  const { adapter, api } = fixture();
  const thread = forumThread("300000000000000034");
  const starter = ownerMessage(thread.id, thread.id, "Reach an eligible Worker.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "failed",
    objective: "Reach an eligible Worker.",
    summary: "No eligible Worker is online after three automatic attempts.",
    sourceEventId: "event_worker_failed",
    significance: "failure",
  });
  await adapter.flushOutbox();

  assert.deepEqual(
    api.operations
      .filter((operation) => operation["kind"] === "message-acknowledgement-completed")
      .map((operation) => [operation["messageId"], operation["outcome"]]),
    [[starter.id, "failure"]],
  );
});

test("pause, resume, cancel, and retry controls map to channel-neutral idempotent commands", async () => {
  const { adapter, api, tasks } = fixture();
  const thread = forumThread("300000000000000035");
  const starter = ownerMessage(thread.id, thread.id, "Control every state");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Control every state",
    summary: "Ready for controls.",
    significance: "status",
  });
  await adapter.flushOutbox();

  for (const [index, command] of ["pause", "resume", "cancel", "retry"].entries()) {
    await adapter.handleGatewayDispatch(
      interactionDispatch(index + 2, {
        id: `40000000000000002${index.toString()}`,
        token: `interaction-${command}`,
        guildId: GUILD_ID,
        channelId: thread.id,
        messageId: "900",
        customId: `od:v1:${command}`,
        author: { id: OWNER_ID, bot: false, roleIds: [] },
        receivedAtMs: 1_000,
      }),
    );
    await adapter.flushOutbox();
  }

  assert.deepEqual(
    tasks.calls.filter((call) => call["kind"] === "command").map((call) => call["command"]),
    ["pause", "resume", "cancel", "retry"],
  );
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "interaction-dismiss").length,
    4,
  );
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "interaction-result").length,
    0,
  );
});

test("a cancelled Task leaves one chronological final update with Retry", async () => {
  const { adapter, api } = fixture();
  const thread = forumThread("300000000000000037");
  const starter = ownerMessage(thread.id, thread.id, "Cancel active multi-Device work.");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));

  const cancelled = {
    taskId: "task-1",
    sourceEventId: "event-task-cancelled",
    state: "cancelled" as const,
    objective: "Cancel active multi-Device work.",
    summary: "This Task was cancelled.",
    significance: "final" as const,
  };
  await adapter.publishTaskProjection(cancelled);
  await adapter.flushOutbox();
  await adapter.publishTaskProjection(cancelled);
  await adapter.flushOutbox();

  const finalMessages = api.operations.filter(
    (operation) =>
      operation["kind"] === "message" &&
      JSON.stringify(operation["payload"]).includes("This Task was cancelled."),
  );
  assert.equal(finalMessages.length, 1);
  const rendered = JSON.stringify(finalMessages[0]?.["payload"]);
  assert.match(rendered, /## Result/u);
  assert.match(rendered, /od:v1:retry/u);
});

test("a stale Task control resolves once instead of retrying forever", async () => {
  const { adapter, api, tasks, repository, clock } = fixture();
  const thread = forumThread("300000000000000036");
  const starter = ownerMessage(thread.id, thread.id, "Control the current Task state");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  tasks.commandError = new DiscordTaskPortError(
    "CONTROL_UNAVAILABLE",
    "The Task command is not valid now.",
  );

  await adapter.handleGatewayDispatch(
    interactionDispatch(2, {
      id: "400000000000000036",
      token: "stale-control-token",
      guildId: GUILD_ID,
      channelId: thread.id,
      messageId: "900",
      customId: "od:v1:retry",
      author: { id: OWNER_ID, bot: false, roleIds: [] },
      receivedAtMs: 1_000,
    }),
  );
  await adapter.flushOutbox();
  clock.value += 60_000;
  await adapter.flushOutbox();

  assert.equal(tasks.calls.filter((call) => call["kind"] === "command").length, 1);
  assert.equal(
    (await repository.listOutbox()).every((item) => item.delivered),
    true,
  );
  const result = api.operations.find((operation) => operation["kind"] === "interaction-result");
  assert.match(JSON.stringify(result), /no longer available/iu);
});

test("Discord outage leaves an idempotent durable outbox that drains after restart", async () => {
  const initial = fixture();
  const thread = forumThread("300000000000000041");
  const starter = ownerMessage(thread.id, thread.id, "Offline projection");
  initial.api.threads.set(thread.id, thread);
  initial.api.messages.set(thread.id, [starter]);
  await initial.adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await initial.adapter.flushOutbox();
  initial.api.online = false;
  await initial.adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Offline projection",
    summary: "Work continues while Discord is unavailable.",
    significance: "status",
  });
  await initial.adapter.flushOutbox();
  assert.equal((await initial.repository.listOutbox()).filter((item) => !item.delivered).length, 1);

  const restartedRepository = new InMemoryDiscordStateRepository(initial.repository.snapshot());
  initial.api.online = true;
  const restarted = fixture({
    repository: restartedRepository,
    api: initial.api,
    tasks: initial.tasks,
    clock: initial.clock,
  });
  initial.clock.value += 60_000;
  await restarted.adapter.flushOutbox();
  assert.equal(
    (await restartedRepository.listOutbox()).filter((item) => !item.delivered).length,
    0,
  );
});

test("interactions defer before asynchronous Task controls and replay is idempotent", async () => {
  const { adapter, api, tasks, repository } = fixture();
  const thread = forumThread("300000000000000051");
  const starter = ownerMessage(thread.id, thread.id, "Control me");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Control me",
    summary: "The Task is running.",
    significance: "status",
  });
  await adapter.flushOutbox();

  let releaseCommand!: () => void;
  tasks.blockCommands = new Promise((resolve) => {
    releaseCommand = resolve;
  });
  const interaction = interactionDispatch(2, {
    id: "400000000000000001",
    token: "transient-interaction-secret",
    guildId: GUILD_ID,
    channelId: thread.id,
    messageId: "900",
    customId: "od:v1:pause",
    author: { id: OWNER_ID, bot: false, roleIds: [] },
    receivedAtMs: 1_000,
  });
  await adapter.handleGatewayDispatch(interaction);
  assert.equal(api.acknowledgedInteractions.has("400000000000000001"), true);
  assert.equal(
    tasks.calls.some((call) => call["kind"] === "command"),
    false,
  );

  const draining = adapter.flushOutbox();
  await Promise.resolve();
  assert.equal(api.acknowledgedInteractions.has("400000000000000001"), true);
  releaseCommand();
  await draining;
  await adapter.handleGatewayDispatch(interaction);
  await adapter.flushOutbox();

  assert.equal(tasks.calls.filter((call) => call["kind"] === "command").length, 1);
  assert.equal(
    JSON.stringify(repository.snapshot()).includes("transient-interaction-secret"),
    false,
  );
  assert.equal(
    JSON.stringify(await adapter.getDiagnostics()).includes("transient-interaction-secret"),
    false,
  );
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "interaction-dismiss").length,
    1,
  );
});

test("interactions defer before durable ingress and earlier work on the same Discord thread", async () => {
  const { adapter, api, tasks, repository } = fixture();
  const thread = forumThread("300000000000000052");
  const starter = ownerMessage(thread.id, thread.id, "Serialize this thread");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Serialize this thread",
    summary: "The Task is running.",
    significance: "status",
  });
  await adapter.flushOutbox();

  let releaseAppend!: () => void;
  let markAppendStarted!: () => void;
  const appendStarted = new Promise<void>((resolve) => {
    markAppendStarted = resolve;
  });
  tasks.blockAppends = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  tasks.beforeAppendTaskInput = markAppendStarted;
  const followUp = ownerMessage("300000000000000053", thread.id, "Hold the thread lock.");
  api.messages.set(thread.id, [starter, followUp]);
  const blockedMessage = adapter.handleGatewayDispatch(messageDispatch(2, followUp));
  await appendStarted;

  const originalClaimInbound = repository.claimInbound.bind(repository);
  let releaseInboundClaim!: () => void;
  let markInboundClaimStarted!: () => void;
  const inboundClaimStarted = new Promise<void>((resolve) => {
    markInboundClaimStarted = resolve;
  });
  const blockedInboundClaim = new Promise<void>((resolve) => {
    releaseInboundClaim = resolve;
  });
  Object.defineProperty(repository, "claimInbound", {
    configurable: true,
    value: async (input: Parameters<typeof originalClaimInbound>[0]) => {
      markInboundClaimStarted();
      await blockedInboundClaim;
      return originalClaimInbound(input);
    },
  });

  const interactionId = "400000000000000002";
  const handlingInteraction = adapter.handleGatewayDispatch(
    interactionDispatch(3, {
      id: interactionId,
      token: "thread-lock-interaction-secret",
      guildId: GUILD_ID,
      channelId: thread.id,
      messageId: "900",
      customId: "od:v1:pause",
      author: { id: OWNER_ID, bot: false, roleIds: [] },
      receivedAtMs: 1_000,
    }),
  );
  await inboundClaimStarted;
  assert.equal(api.acknowledgedInteractions.has(interactionId), true);

  releaseInboundClaim();
  releaseAppend();
  await Promise.all([blockedMessage, handlingInteraction]);
  await adapter.flushOutbox();
  assert.equal(tasks.calls.filter((call) => call["kind"] === "command").length, 1);
});

test("an already late unacknowledged interaction executes its durable control once", async () => {
  const { adapter, api, tasks, repository, clock } = fixture();
  const thread = forumThread("300000000000000054");
  const starter = ownerMessage(thread.id, thread.id, "Retire late interactions");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  clock.value = 4_000;
  const lateInteraction = interactionDispatch(2, {
    id: "400000000000000003",
    token: "expired-interaction-secret",
    guildId: GUILD_ID,
    channelId: thread.id,
    messageId: "900",
    customId: "od:v1:pause",
    author: { id: OWNER_ID, bot: false, roleIds: [] },
    receivedAtMs: 1_000,
  });

  await adapter.handleGatewayDispatch(lateInteraction);
  await adapter.handleGatewayDispatch(lateInteraction);

  assert.equal(api.acknowledgedInteractions.has("400000000000000003"), false);
  assert.equal(tasks.calls.filter((call) => call["kind"] === "command").length, 1);
  assert.equal(
    repository
      .snapshot()
      .inbound.find((record) => record.key === "discord-interaction:400000000000000003")?.state,
    "completed",
  );
  assert.equal(
    (await adapter.getDiagnostics()).some(
      (diagnostic) => diagnostic.event === "discord.interaction_ack_late",
    ),
    true,
  );
  assert.equal(
    (await adapter.getDiagnostics()).some(
      (diagnostic) => diagnostic.event === "discord.interaction_applied_without_ack",
    ),
    true,
  );
});

test("an already late approve-once interaction resolves the exact Approval once", async () => {
  const { adapter, api, tasks, repository, clock } = fixture();
  const thread = forumThread("300000000000000055");
  const starter = ownerMessage(thread.id, thread.id, "Approve one protected action");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  clock.value = 4_000;
  const lateInteraction = interactionDispatch(2, {
    id: "400000000000000004",
    token: "expired-approval-interaction-secret",
    guildId: GUILD_ID,
    channelId: thread.id,
    messageId: "900",
    customId: "od:v1:approve:approval-live-1",
    author: { id: OWNER_ID, bot: false, roleIds: [] },
    receivedAtMs: 1_000,
  });

  await adapter.handleGatewayDispatch(lateInteraction);
  await adapter.handleGatewayDispatch(lateInteraction);

  const approvals = tasks.calls.filter((call) => call["kind"] === "approval");
  assert.equal(api.acknowledgedInteractions.has("400000000000000004"), false);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.["approvalId"], "approval-live-1");
  assert.equal(approvals[0]?.["decision"], "approve");
  assert.equal(
    repository
      .snapshot()
      .inbound.find((record) => record.key === "discord-interaction:400000000000000004")?.state,
    "completed",
  );
});

test("a failed interaction acknowledgement still resolves the exact Approval once", async () => {
  const { adapter, api, tasks, repository } = fixture();
  const thread = forumThread("300000000000000067");
  const starter = ownerMessage(thread.id, thread.id, "Approve despite a failed acknowledgement");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  api.deferInteractionError = new DiscordApiError("OFFLINE", "Acknowledgement unavailable.");
  const interaction = interactionDispatch(2, {
    id: "400000000000000017",
    token: "failed-approval-interaction-secret",
    guildId: GUILD_ID,
    channelId: thread.id,
    messageId: "900",
    customId: "od:v1:approve:approval-live-1",
    author: { id: OWNER_ID, bot: false, roleIds: [] },
    receivedAtMs: 1_000,
  });

  await adapter.handleGatewayDispatch(interaction);
  await adapter.handleGatewayDispatch(interaction);

  const approvals = tasks.calls.filter((call) => call["kind"] === "approval");
  assert.equal(api.acknowledgedInteractions.has("400000000000000017"), false);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.["approvalId"], "approval-live-1");
  assert.equal(approvals[0]?.["decision"], "approve");
  assert.equal(
    repository
      .snapshot()
      .inbound.find((record) => record.key === "discord-interaction:400000000000000017")?.state,
    "completed",
  );
});

test("approve/reject controls use the approval callback and unauthorized controls are inert", async () => {
  const { adapter, api, tasks } = fixture();
  const thread = forumThread("300000000000000061");
  const starter = ownerMessage(thread.id, thread.id, "Approval task");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "waiting_user",
    objective: "Approval task",
    summary: "A protected action is waiting.",
    sourceEventId: "event_approval_question",
    significance: "question",
    approval: { approvalId: "approval-1", description: "Allow package repository change?" },
  });
  await adapter.flushOutbox();

  await adapter.handleGatewayDispatch(
    interactionDispatch(2, {
      id: "400000000000000011",
      token: "approval-token",
      guildId: GUILD_ID,
      channelId: thread.id,
      messageId: "900",
      customId: "od:v1:approve:approval-1",
      author: { id: OWNER_ID, bot: false, roleIds: [] },
      receivedAtMs: 1_000,
    }),
  );
  await adapter.handleGatewayDispatch(
    interactionDispatch(3, {
      id: "400000000000000012",
      token: "attacker-token",
      guildId: GUILD_ID,
      channelId: thread.id,
      messageId: "900",
      customId: "od:v1:cancel",
      author: { id: "999999999999999999", bot: false, roleIds: [] },
      receivedAtMs: 1_000,
    }),
  );
  await adapter.handleGatewayDispatch(
    interactionDispatch(4, {
      id: "400000000000000013",
      token: "forged-control-token",
      guildId: GUILD_ID,
      channelId: thread.id,
      messageId: "899",
      messageAuthorId: OWNER_ID,
      customId: "od:v1:cancel",
      author: { id: OWNER_ID, bot: false, roleIds: [] },
      receivedAtMs: 1_000,
    }),
  );
  await adapter.flushOutbox();

  assert.equal(tasks.calls.filter((call) => call["kind"] === "approval").length, 1);
  assert.equal(
    tasks.calls.some((call) => call["kind"] === "command"),
    false,
  );
  assert.equal(
    api.operations.filter((operation) => operation["kind"] === "interaction-dismiss").length,
    1,
  );
  assert.equal(
    api.operations.filter(
      (operation) =>
        operation["kind"] === "interaction-result" &&
        String(operation["responseRef"]).includes("400000000000000011"),
    ).length,
    0,
  );
});

test("an expired interaction response does not mark the underlying Forum post deleted", async () => {
  const { adapter, api, tasks, repository } = fixture();
  const thread = forumThread("300000000000000065");
  const starter = ownerMessage(thread.id, thread.id, "Keep the binding");
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [starter]);
  await adapter.handleGatewayDispatch(messageDispatch(1, starter));
  await adapter.publishTaskProjection({
    taskId: "task-1",
    state: "running",
    objective: "Keep the binding",
    summary: "The Task is running.",
    significance: "status",
  });
  await adapter.flushOutbox();
  api.editDeferredError = new DiscordApiError("NOT_FOUND", "Interaction token expired.");

  await adapter.handleGatewayDispatch(
    interactionDispatch(2, {
      id: "400000000000000015",
      token: "expired-response-token",
      guildId: GUILD_ID,
      channelId: thread.id,
      messageId: "900",
      customId: "od:v1:pause",
      author: { id: OWNER_ID, bot: false, roleIds: [] },
      receivedAtMs: 1_000,
    }),
  );
  await adapter.flushOutbox();

  assert.equal(tasks.calls.filter((call) => call["kind"] === "command").length, 1);
  assert.equal((await repository.getBindingByThread(thread.id))?.externalState, "available");
  assert.equal(
    (await repository.listOutbox()).every((item) => item.delivered),
    true,
  );
});

test("thread deletion or permission loss marks only the external binding and preserves Task identity", async () => {
  const { adapter, api, repository } = fixture();
  const deleted = forumThread("300000000000000071");
  const inaccessible = forumThread("300000000000000072");
  for (const thread of [deleted, inaccessible]) {
    const starter = ownerMessage(thread.id, thread.id, thread.name);
    api.threads.set(thread.id, thread);
    api.messages.set(thread.id, [starter]);
    await adapter.handleGatewayDispatch(messageDispatch(Number(thread.id.at(-1)), starter));
  }

  await adapter.handleGatewayDispatch({
    sessionId: "gateway-session",
    resumeGatewayUrl: "wss://gateway.discord.gg",
    sequence: 9,
    type: "THREAD_DELETE",
    threadId: deleted.id,
    guildId: GUILD_ID,
    parentId: FORUM_ID,
  });
  api.threads.delete(inaccessible.id);
  const originalGetThread = api.getThread.bind(api);
  api.getThread = async (threadId) => {
    if (threadId === inaccessible.id) {
      throw new DiscordApiError("FORBIDDEN", "Missing access.");
    }
    return originalGetThread(threadId);
  };
  await adapter.reconcile();

  assert.equal((await repository.getBindingByThread(deleted.id))?.externalState, "deleted");
  assert.equal(
    (await repository.getBindingByThread(inaccessible.id))?.externalState,
    "inaccessible",
  );
  assert.equal((await repository.getBindingByThread(deleted.id))?.taskId, "task-1");
  assert.equal((await repository.getBindingByThread(inaccessible.id))?.taskId, "task-2");
});

test("role allowlisting is explicit and Discord credential forms are redacted", async () => {
  const { adapter, api, tasks } = fixture();
  const thread = forumThread("300000000000000081");
  const roleAuthorized = {
    ...ownerMessage(thread.id, thread.id, "Role-authorized work"),
    author: {
      id: "999999999999999998",
      bot: false,
      roleIds: [OWNER_ROLE_ID],
    },
  };
  api.threads.set(thread.id, thread);
  api.messages.set(thread.id, [roleAuthorized]);
  await adapter.handleGatewayDispatch(messageDispatch(1, roleAuthorized));
  assert.equal(tasks.calls.filter((call) => call["kind"] === "create").length, 1);

  const raw =
    "Authorization: Bot MzAwMDAwMDAwMDAwMDAwMDAx.ABCDEF.abcdefghijklmnopqrstuvwxyz1 " +
    "https://discord.com/api/webhooks/123456789012345678/secret_value";
  const redacted = redactDiscordSecrets(raw);
  assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz1"), false);
  assert.equal(redacted.includes("secret_value"), false);
  assert.match(redacted, /REDACTED/);
});

function forumThread(id: string): DiscordThread {
  return {
    id,
    guildId: GUILD_ID,
    parentId: FORUM_ID,
    type: 11,
    name: `Forum post ${id}`,
    ownerId: OWNER_ID,
    appliedTagIds: [STATUS_TAGS.intake],
    archived: false,
    locked: false,
  };
}

function ownerMessage(id: string, channelId: string, content: string): DiscordMessage {
  return {
    id,
    guildId: GUILD_ID,
    channelId,
    author: { id: OWNER_ID, bot: false, roleIds: [] },
    content,
    attachments: [],
    createdAtMs: 1_000,
  };
}

function messageDispatch(sequence: number, message: DiscordMessage): DiscordGatewayDispatch {
  return {
    sessionId: "gateway-session",
    resumeGatewayUrl: "wss://gateway.discord.gg",
    sequence,
    type: "MESSAGE_CREATE",
    message,
  };
}

function threadDispatch(sequence: number, thread: DiscordThread): DiscordGatewayDispatch {
  return {
    sessionId: "gateway-session",
    resumeGatewayUrl: "wss://gateway.discord.gg",
    sequence,
    type: "THREAD_CREATE",
    thread,
  };
}

function interactionDispatch(
  sequence: number,
  interaction: Omit<
    Extract<DiscordGatewayDispatch, { type: "INTERACTION_CREATE" }>["interaction"],
    "messageAuthorId"
  > & {
    readonly messageAuthorId?: string;
  },
): DiscordGatewayDispatch {
  return {
    sessionId: "gateway-session",
    resumeGatewayUrl: "wss://gateway.discord.gg",
    sequence,
    type: "INTERACTION_CREATE",
    interaction: {
      ...interaction,
      messageAuthorId: interaction.messageAuthorId ?? BOT_ID,
    },
  };
}
