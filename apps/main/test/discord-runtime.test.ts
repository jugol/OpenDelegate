import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DiscordApiError,
  DiscordForumAdapter,
  InMemoryDiscordStateRepository,
  type DiscordApiPort,
  type DiscordGatewayConnectOptions,
  type DiscordGatewayConnection,
  type DiscordGatewayDispatch,
  type DiscordGatewayPort,
  type DiscordInstallationProbe,
  type DiscordMessage,
  type DiscordMessagePayload,
  type TaskChannelProjection,
  type DiscordThread,
} from "@opendelegate/discord-adapter";
import { InMemoryEventStore } from "@opendelegate/event-store";
import {
  SecretError,
  type ManagedSecretDeletion,
  type ManagedSecretMutation,
  type ManagedSecretStore,
  type ManagedSecretStoreHealth,
  type SecretAvailability,
} from "@opendelegate/secrets";
import { TaskService } from "@opendelegate/task-service";

import {
  DiscordMainRuntime,
  ManagedDiscordBotCredentialProvider,
  ManagedDiscordInteractionTokenVault,
} from "../src/discord-runtime.ts";
import { createMainRuntime, initializeMainHome } from "../src/index.ts";

const NOW = "2026-07-25T12:00:00.000Z";
const APPLICATION_ID = "100000000000000001";
const GUILD_ID = "100000000000000002";
const FORUM_ID = "100000000000000003";
const OWNER_ID = "100000000000000004";
const BOT_ID = "100000000000000005";
const THREAD_ID = "100000000000000006";
const REPLY_ID = "100000000000000007";
const STATUS_TAGS = {
  intake: "200000000000000001",
  running: "200000000000000002",
  waiting: "200000000000000003",
  review: "200000000000000004",
  done: "200000000000000005",
  failed: "200000000000000006",
} as const;

test("Main Discord runtime adds a Task Artifact link without making status projection depend on it", async () => {
  const projections: TaskChannelProjection[] = [];
  let artifactAvailable = true;
  const runtime = new DiscordMainRuntime({
    adapter: {
      start: () => Promise.resolve(),
      close: () => Promise.resolve(),
      flushOutbox: () => Promise.resolve(),
      publishTaskProjection: (projection) => {
        projections.push(structuredClone(projection));
        return Promise.resolve();
      },
    },
    repository: {
      getGatewayCursor: () => Promise.resolve(undefined),
      listBindings: () =>
        Promise.resolve([
          {
            guildId: GUILD_ID,
            forumChannelId: FORUM_ID,
            threadId: THREAD_ID,
            starterMessageId: THREAD_ID,
            taskId: "task-artifact",
            externalState: "available",
            archived: false,
            locked: false,
            revision: 1,
          },
        ]),
    },
    tasks: {
      get: () =>
        Promise.resolve({
          taskId: "task-artifact",
          state: "completed",
          objective: "Build a report.",
          updatedAt: NOW,
          messages: [
            {
              messageId: "event-completed",
              role: "agent",
              content: "The report is ready.",
              occurredAt: NOW,
            },
          ],
          events: [
            {
              eventId: "event-completed",
              type: "task.execution-recorded",
              occurredAt: NOW,
              streamVersion: 1,
            },
          ],
        }),
    },
    artifactPresentation: {
      forTask: () =>
        artifactAvailable
          ? Promise.resolve({
              label: "Open report",
              url: "https://reports.example.test/artifacts/artifact-report",
            })
          : Promise.reject(new Error("Artifact metadata is offline.")),
    },
    clock: new TestClock(),
    synchronizationIntervalMs: 60_000,
  });

  await runtime.start();
  assert.deepEqual(projections.at(-1)?.artifact, {
    label: "Open report",
    url: "https://reports.example.test/artifacts/artifact-report",
  });

  artifactAvailable = false;
  await runtime.synchronizeNow();
  assert.equal(projections.at(-1)?.artifact, undefined);
  assert.equal(runtime.diagnostics.at(-1)?.event, "discord.runtime.artifact_projection_failed");
  await runtime.close();
});

test("Main Discord runtime keeps one Forum Task across replies and publishes its public result", async () => {
  const clock = new TestClock();
  const repository = new InMemoryDiscordStateRepository();
  const tasks = new TaskService({
    clock: { now: () => NOW },
    eventStore: new InMemoryEventStore({ clock: { now: () => NOW } }),
  });
  const api = new TestDiscordApi();
  const gateway = new TestDiscordGateway();
  const adapter = new DiscordForumAdapter({
    config: discordConfiguration(),
    repository,
    api,
    tasks: {
      createTask: async (input) =>
        tasks.create({
          principalId: input.principalId,
          idempotencyKey: input.idempotencyKey,
          objective: input.objective,
          completionCriteria: input.completionCriteria,
          constraints: input.constraints,
          selectedInputRefs: input.selectedInputRefs,
        }),
      appendTaskInput: async (input) => {
        await tasks.appendInput({
          taskId: input.taskId,
          principalId: input.principalId,
          idempotencyKey: input.idempotencyKey,
          message: input.message,
          selectedInputRefs: input.selectedInputRefs,
        });
      },
      commandTask: async (input) => {
        await tasks.command(input);
      },
      resolveApproval: async (input) => {
        await tasks.resolveApproval(input);
      },
    },
    clock,
    gateway,
  });
  const runtime = new DiscordMainRuntime({
    adapter,
    repository,
    tasks,
    clock,
    synchronizationIntervalMs: 60_000,
  });

  assert.equal((await runtime.start()).status, "ready");
  await gateway.dispatch(messageDispatch(api.reply));

  const listed = await tasks.list();
  assert.equal(listed.length, 1);
  const taskId = listed[0]?.taskId;
  assert.ok(taskId);
  const afterReply = await tasks.get(taskId);
  assert.deepEqual(
    afterReply.messages.map((message) => [message.role, message.content]),
    [["owner", "Keep this in the same native Task session."]],
  );

  await tasks.recordExecution({
    taskId,
    idempotencyKey: "discord-test:queued",
    state: "queued",
  });
  await tasks.recordExecution({
    taskId,
    idempotencyKey: "discord-test:running",
    state: "running",
  });
  await tasks.recordExecution({
    taskId,
    idempotencyKey: "discord-test:complete",
    state: "completed",
    verifiedCompletionCriteria: ["Complete the requested work and report the observable result."],
    publicMessage: "The cross-device report is ready.",
  });

  await runtime.synchronizeNow();

  const binding = await repository.getBindingByThread(THREAD_ID);
  assert.equal(binding?.taskId, taskId);
  assert.equal(api.appliedTags.at(-1)?.[0], STATUS_TAGS.done);
  assert.match(JSON.stringify(api.createdMessages), /The cross-device report is ready\./);

  const firstResultCount = api.createdMessages.filter((payload) =>
    JSON.stringify(payload).includes("## Result"),
  ).length;
  await tasks.appendInput({
    taskId,
    principalId: `discord:${OWNER_ID}`,
    idempotencyKey: "discord-test:repeat-owner-input",
    message: "Run the same verification again.",
    selectedInputRefs: [],
  });
  await tasks.recordExecution({
    taskId,
    idempotencyKey: "discord-test:repeat-running",
    state: "running",
  });
  await tasks.recordExecution({
    taskId,
    idempotencyKey: "discord-test:repeat-complete",
    state: "completed",
    verifiedCompletionCriteria: ["Complete the requested work and report the observable result."],
    publicMessage: "The cross-device report is ready.",
  });
  await runtime.synchronizeNow();
  assert.equal(
    api.createdMessages.filter((payload) => JSON.stringify(payload).includes("## Result")).length,
    firstResultCount + 1,
  );

  await runtime.close();
  assert.equal(gateway.closed, true);
  assert.equal(runtime.status.status, "unavailable");
  assert.equal(runtime.status.code, "DISCORD_STOPPED");
});

test("Main Discord runtime remains available for repair and retries an unavailable installation", async () => {
  const clock = new TestClock();
  const repository = new InMemoryDiscordStateRepository();
  const tasks = new TaskService({
    clock: { now: () => NOW },
    eventStore: new InMemoryEventStore({ clock: { now: () => NOW } }),
  });
  const api = new TestDiscordApi();
  api.online = false;
  const gateway = new TestDiscordGateway();
  const adapter = new DiscordForumAdapter({
    config: discordConfiguration(),
    repository,
    api,
    tasks: {
      createTask: async (input) =>
        tasks.create({
          principalId: input.principalId,
          idempotencyKey: input.idempotencyKey,
          objective: input.objective,
          completionCriteria: input.completionCriteria,
          constraints: input.constraints,
          selectedInputRefs: input.selectedInputRefs,
        }),
      appendTaskInput: async (input) => {
        await tasks.appendInput({
          taskId: input.taskId,
          principalId: input.principalId,
          idempotencyKey: input.idempotencyKey,
          message: input.message,
          selectedInputRefs: input.selectedInputRefs,
        });
      },
      commandTask: async (input) => {
        await tasks.command(input);
      },
      resolveApproval: async (input) => {
        await tasks.resolveApproval(input);
      },
    },
    clock,
    gateway,
  });
  const runtime = new DiscordMainRuntime({
    adapter,
    repository,
    tasks,
    clock,
    synchronizationIntervalMs: 60_000,
  });

  assert.equal((await runtime.start()).status, "unavailable");
  assert.equal(gateway.connections, 0);

  api.online = true;
  await runtime.synchronizeNow();

  assert.equal(runtime.status.status, "ready");
  assert.equal(gateway.connections, 1);
  await runtime.close();
});

test("Main process owns production Discord startup, dynamic feature state, and shutdown", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-discord-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const adminRoot = join(home, "admin");
  await mkdir(adminRoot);
  await writeFile(join(adminRoot, "index.html"), "<!doctype html><title>OpenDelegate</title>");
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
  });
  const api = new TestDiscordApi();
  const gateway = new TestDiscordGateway();
  const secretStore = new TestManagedSecretStore(
    "discord.bot.token.fixture",
    initialized.configuration.deviceId,
  );
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "discord-runtime-composition" },
    releaseChannel: "development",
    sourceCheckout: resolve("."),
    discord: {
      config: discordConfiguration(),
      botTokenAlias: "discord-bot-token",
      secretStore,
      api,
      gateway,
      synchronizationIntervalMs: 60_000,
    },
  });

  assert.equal(runtime.discord?.status.status, "ready");
  assert.equal(gateway.connections, 1);
  runtime.discord?.observeGatewayDiagnostic("discord.gateway.closed_reconnecting");
  assert.equal(runtime.discord?.status.code, "DISCORD_RECONNECTING");
  await runtime.discord?.synchronizeNow();
  assert.equal(runtime.discord?.status.code, "DISCORD_RECONNECTING");
  runtime.discord?.observeGatewaySessionEstablished();
  assert.equal(runtime.discord?.status.code, "DISCORD_READY");

  await runtime.close();
  assert.equal(gateway.closed, true);
});

test("Main finishes Discord reconciliation before dispatching recovered Forum Tasks", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-discord-ordering-"));
  const cleanup: {
    runtime?: Awaited<ReturnType<typeof createMainRuntime>>;
  } = {};
  t.after(async () => {
    await cleanup.runtime?.close();
    await rm(home, { force: true, recursive: true });
  });
  const adminRoot = join(home, "admin");
  await mkdir(adminRoot);
  await writeFile(join(adminRoot, "index.html"), "<!doctype html><title>OpenDelegate</title>");
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
  });
  const api = new TestDiscordApi();
  const gateway = new TestDiscordGateway();
  const observations: boolean[] = [];
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "discord-before-dispatch" },
    releaseChannel: "development",
    sourceCheckout: resolve("."),
    taskExecution: {
      retryDelayMs: 0,
      executor: {
        async execute(request) {
          observations.push(api.statusPanelWritten);
          return {
            state: "completed",
            verifiedCompletionCriteria: [...request.task.completionCriteria],
          };
        },
      },
    },
    discord: {
      config: discordConfiguration(),
      botTokenAlias: "discord-bot-token",
      secretStore: new TestManagedSecretStore(
        "discord.bot.token.fixture",
        initialized.configuration.deviceId,
      ),
      api,
      gateway,
      synchronizationIntervalMs: 60_000,
    },
  });
  cleanup.runtime = runtime;

  await runtime.taskExecution?.waitForIdle();
  assert.deepEqual(observations, [true]);
  assert.equal((await runtime.tasks.list()).length, 1);
});

test("Discord bot credentials are read only through the scoped platform Secret Store", async () => {
  const token = "discord.bot.token.fixture";
  const store = new TestManagedSecretStore(token);
  const provider = new ManagedDiscordBotCredentialProvider({
    alias: "discord-bot-token",
    deviceId: "device_main",
    secretStore: store,
  });

  const result = await provider.withBotToken(async (value) => {
    assert.equal(value, token);
    return "called";
  });
  assert.equal(result, "called");
  assert.equal(store.executions, 1);

  const boundaryError = new DiscordApiError("FORBIDDEN", "Discord denied the operation.");
  await assert.rejects(
    provider.withBotToken(async () => {
      throw boundaryError;
    }),
    (error) => error === boundaryError,
  );
  assert.equal(store.executions, 2);
});

test("deferred Discord interaction credentials survive runtime replacement in the platform Secret Store", async () => {
  const clock = new TestClock();
  const store = new TestManagedSecretStore("discord.bot.token.fixture");
  const firstRuntimeVault = new ManagedDiscordInteractionTokenVault({
    deviceId: "device_main",
    secretStore: store,
    nowMs: () => clock.value,
    createReference: () => "discord-interaction-ref:fixture_reference",
  });
  const stored = await firstRuntimeVault.store({
    applicationId: APPLICATION_ID,
    interactionToken: "interaction.token.fixture",
    lifetimeMs: 15 * 60_000,
  });

  assert.equal(stored.responseRef, "discord-interaction-ref:fixture_reference");
  assert.doesNotMatch(stored.responseRef, /interaction\.token/);

  const replacementVault = new ManagedDiscordInteractionTokenVault({
    deviceId: "device_main",
    secretStore: store,
    nowMs: () => clock.value,
  });
  const used = await replacementVault.use(stored.responseRef, async (entry) => {
    assert.deepEqual(entry, {
      applicationId: APPLICATION_ID,
      interactionToken: "interaction.token.fixture",
    });
    return "edited";
  });
  assert.deepEqual(used, { found: true, value: "edited" });
  assert.deepEqual(await replacementVault.use(stored.responseRef, async () => "must-not-run"), {
    found: false,
  });

  clock.value += 15 * 60_000;
  assert.deepEqual(await replacementVault.use(stored.responseRef, async () => "must-not-run"), {
    found: false,
  });
});

class TestClock {
  public value = 1_000;

  public nowMs(): number {
    return this.value;
  }
}

class TestDiscordGateway implements DiscordGatewayPort {
  public connections = 0;
  public closed = false;
  #options: DiscordGatewayConnectOptions | undefined;

  public async connect(options: DiscordGatewayConnectOptions): Promise<DiscordGatewayConnection> {
    this.connections += 1;
    this.#options = options;
    await options.onSessionEstablished({
      sessionId: "discord-session",
      resumeGatewayUrl: "wss://gateway.discord.gg",
      sequence: 1,
    });
    return {
      close: async () => {
        this.closed = true;
      },
    };
  }

  public async dispatch(dispatch: DiscordGatewayDispatch): Promise<void> {
    assert.ok(this.#options);
    await this.#options.onDispatch(dispatch);
  }
}

class TestDiscordApi implements DiscordApiPort {
  public online = true;
  public statusPanelWritten = false;
  public readonly appliedTags: Array<readonly string[]> = [];
  public readonly createdMessages: DiscordMessagePayload[] = [];
  public readonly thread: DiscordThread = {
    id: THREAD_ID,
    guildId: GUILD_ID,
    parentId: FORUM_ID,
    type: 11,
    name: "Prepare the cross-device report",
    ownerId: OWNER_ID,
    appliedTagIds: [],
    archived: false,
    locked: false,
  };
  public readonly starter: DiscordMessage = {
    id: THREAD_ID,
    guildId: GUILD_ID,
    channelId: THREAD_ID,
    author: { id: OWNER_ID, bot: false, roleIds: [] },
    content: "Prepare the cross-device report.",
    attachments: [],
    createdAtMs: 1_000,
  };
  public readonly reply: DiscordMessage = {
    id: REPLY_ID,
    guildId: GUILD_ID,
    channelId: THREAD_ID,
    author: { id: OWNER_ID, bot: false, roleIds: [] },
    content: "Keep this in the same native Task session.",
    attachments: [],
    createdAtMs: 2_000,
  };
  #nextMessageId = 900_000_000_000_000_000n;

  public async probeInstallation(): Promise<DiscordInstallationProbe> {
    this.#requireOnline();
    return {
      applicationId: APPLICATION_ID,
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
  }

  public async getThread(): Promise<DiscordThread> {
    this.#requireOnline();
    return structuredClone(this.thread);
  }

  public async getMessage(_threadId: string, messageId: string): Promise<DiscordMessage> {
    this.#requireOnline();
    if (messageId !== THREAD_ID) {
      throw new DiscordApiError("NOT_FOUND", "The message does not exist.");
    }
    return structuredClone(this.starter);
  }

  public async listActiveThreads(): Promise<readonly DiscordThread[]> {
    this.#requireOnline();
    return [structuredClone(this.thread)];
  }

  public async listArchivedPublicThreads(): Promise<{
    readonly threads: readonly DiscordThread[];
    readonly hasMore: boolean;
  }> {
    this.#requireOnline();
    return { threads: [], hasMore: false };
  }

  public async listMessages(
    _threadId: string,
    after?: string,
  ): Promise<{
    readonly messages: readonly DiscordMessage[];
    readonly hasMore: boolean;
    readonly nextAfter?: string;
  }> {
    this.#requireOnline();
    return {
      messages:
        after === undefined || BigInt(after) < BigInt(THREAD_ID)
          ? [structuredClone(this.starter)]
          : [],
      hasMore: false,
    };
  }

  public async updateThreadTags(
    _threadId: string,
    appliedTagIds: readonly string[],
  ): Promise<void> {
    this.#requireOnline();
    this.appliedTags.push([...appliedTagIds]);
  }

  public async upsertStatusPanel(input: {
    readonly payload: DiscordMessagePayload;
    readonly messageId?: string;
  }): Promise<{ readonly messageId: string }> {
    this.#requireOnline();
    this.statusPanelWritten = true;
    this.createdMessages.push(structuredClone(input.payload));
    return { messageId: input.messageId ?? this.#nextMessage() };
  }

  public async createMessage(input: {
    readonly payload: DiscordMessagePayload;
  }): Promise<{ readonly messageId: string }> {
    this.#requireOnline();
    this.createdMessages.push(structuredClone(input.payload));
    return { messageId: this.#nextMessage() };
  }

  public async deferInteraction(): Promise<{ readonly responseRef: string }> {
    throw new Error("No interaction is expected in this test.");
  }

  public async editDeferredInteraction(): Promise<void> {
    throw new Error("No interaction is expected in this test.");
  }

  #nextMessage(): string {
    this.#nextMessageId += 1n;
    return this.#nextMessageId.toString();
  }

  #requireOnline(): void {
    if (!this.online) {
      throw new DiscordApiError("OFFLINE", "Discord is unavailable.");
    }
  }
}

class TestManagedSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-dpapi" as const;
  public readonly deviceId: string;
  public executions = 0;
  readonly #values = new Map<string, Buffer>();

  public constructor(token: string, deviceId = "device_main") {
    this.deviceId = deviceId;
    this.#values.set("discord-bot-token", Buffer.from(token, "utf8"));
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    return { backend: this.backend, deviceId: this.deviceId, status: "ready" };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: this.#values.has(alias) };
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    if (this.#values.has(alias)) {
      throw new SecretError("SECRET_ALIAS_CONFLICT", "The Secret already exists.");
    }
    this.#values.set(alias, Buffer.from(value));
    return { status: "stored" };
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    this.#values.set(alias, Buffer.from(value));
    return { status: "rotated" };
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    return { status: this.#values.delete(alias) ? "deleted" : "absent" };
  }

  public async executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    this.executions += 1;
    const stored = this.#values.get(alias);
    if (stored === undefined) {
      throw new SecretError("SECRET_ALIAS_UNAVAILABLE", "The Secret does not exist.");
    }
    const material = Buffer.from(stored);
    try {
      await executor(material);
    } catch {
      throw new SecretError("SECRET_EXECUTOR_FAILED", "The scoped Secret executor failed.");
    } finally {
      material.fill(0);
    }
  }
}

function discordConfiguration() {
  return {
    applicationId: APPLICATION_ID,
    botUserId: BOT_ID,
    guildId: GUILD_ID,
    forumBindings: [{ channelId: FORUM_ID, workflowTagIds: STATUS_TAGS }],
    ownerUserIds: [OWNER_ID],
    allowedRoleIds: [],
  } as const;
}

function messageDispatch(message: DiscordMessage): DiscordGatewayDispatch {
  return {
    type: "MESSAGE_CREATE",
    sessionId: "discord-session",
    resumeGatewayUrl: "wss://gateway.discord.gg",
    sequence: 2,
    message,
  };
}
