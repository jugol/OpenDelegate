import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type {
  AgentAdapter,
  AgentResumeRequest,
  AgentRunHandle,
  AgentStartRequest,
  NativeSessionReference,
  NormalizedAgentEvent,
} from "@opendelegate/agent-adapters";
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
import type { MainDiscordBindingConfiguration } from "../src/discord-configuration.ts";
import {
  inspectPersistedMainConfiguration,
  MainSingletonOwnershipError,
  type MainSingletonOwnership,
} from "../src/index.ts";
import { createMainTestSecretContext } from "../test-fixtures/main-test-secrets.ts";
import { createMainRuntime, initializeMainHome } from "../test-fixtures/portable-main-runtime.ts";

const NOW = "2026-07-25T12:00:00.000Z";
const APPLICATION_ID = "100000000000000001";
const GUILD_ID = "100000000000000002";
const FORUM_ID = "100000000000000003";
const OWNER_ID = "100000000000000004";
const DEVELOPMENT_RELEASE_IDENTITY = {
  declaredReleaseChannel: "development",
  releaseChannel: "development",
  releaseVerification: { status: "not-applicable" },
} as const;
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
const AGENT_LIMITS = {
  wallTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  cancellationGraceMs: 100,
  leaseTtlMs: 1_000,
  leaseRenewIntervalMs: 250,
  maxBufferedEvents: 8,
  maxLineBytes: 64 * 1024,
  maxDiagnosticBytes: 64 * 1024,
} as const;

test("Main Discord runtime adds a Task Artifact link without making status projection depend on it", async () => {
  const projections: TaskChannelProjection[] = [];
  let artifactAvailable = true;
  let approvalAvailable = true;
  const runtime = new DiscordMainRuntime({
    adapter: {
      start: () => Promise.resolve(),
      close: () => Promise.resolve(),
      createTaskThread: (projection) =>
        Promise.resolve({
          guildId: GUILD_ID,
          forumChannelId: FORUM_ID,
          threadId: THREAD_ID,
          starterMessageId: THREAD_ID,
          taskId: projection.taskId,
          externalState: "available" as const,
          archived: false,
          locked: false,
          revision: 1,
        }),
      flushOutbox: () => Promise.resolve(),
      reconcilePending: () => Promise.resolve(),
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
    taskApproval: {
      current: () =>
        approvalAvailable
          ? Promise.resolve({
              approvalId: "approval-worker-action",
              description: "Windows Worker wants to install a required package.",
            })
          : Promise.resolve(undefined),
      resolve: () => Promise.resolve(false),
    },
    clock: new TestClock(),
    synchronizationIntervalMs: 60_000,
  });

  await runtime.start();
  assert.deepEqual(projections.at(-1)?.artifact, {
    label: "Open report",
    url: "https://reports.example.test/artifacts/artifact-report",
  });
  assert.deepEqual(projections.at(-1)?.approval, {
    approvalId: "approval-worker-action",
    description: "Windows Worker wants to install a required package.",
  });

  artifactAvailable = false;
  approvalAvailable = false;
  await runtime.synchronizeNow();
  assert.equal(projections.at(-1)?.artifact, undefined);
  assert.equal(projections.at(-1)?.approval, undefined);
  assert.equal(runtime.diagnostics.at(-1)?.event, "discord.runtime.artifact_projection_failed");
  await runtime.close();
});

test("Main Discord runtime keeps a pending Worker approval actionable without an activity snapshot", async () => {
  const projections: TaskChannelProjection[] = [];
  let approvalAvailable = true;
  const clock = new TestClock();
  clock.value = 4_200;
  const runtime = new DiscordMainRuntime({
    adapter: {
      start: () => Promise.resolve(),
      close: () => Promise.resolve(),
      createTaskThread: () => Promise.reject(new Error("not used")),
      flushOutbox: () => Promise.resolve(),
      reconcilePending: () => Promise.resolve(),
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
            taskId: "task-running-approval",
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
          taskId: "task-running-approval",
          state: "running",
          objective: "Inspect a registered Device without changing it.",
          updatedAt: NOW,
          messages: [],
          events: [],
        }),
    },
    taskActivity: { activity: () => Promise.resolve(undefined) },
    taskApproval: {
      current: () =>
        Promise.resolve(
          approvalAvailable
            ? {
                approvalId: "approval-read-only-escalation",
                description: "NAS wants to expand its sandbox for one command.",
              }
            : undefined,
        ),
      resolve: () => Promise.resolve(false),
    },
    clock,
    synchronizationIntervalMs: 60_000,
  });

  await runtime.start();
  assert.deepEqual(projections.at(-1)?.activity, {
    cycleId: "approval_approval-read-only-escalation",
    revision: 1,
    updatedAtMs: Date.parse(NOW),
    phase: "working",
    completedWorkOrders: 0,
    totalWorkOrders: 0,
    milestones: [
      {
        key: "owner-approval:task-running-approval",
        status: "active",
        summary: "A Worker is waiting for owner approval before it can continue.",
      },
    ],
  });
  assert.equal(projections.at(-1)?.approval?.approvalId, "approval-read-only-escalation");

  clock.value = 9_000;
  await runtime.synchronizeNow();
  assert.equal(projections.at(-1)?.activity?.updatedAtMs, Date.parse(NOW));

  approvalAvailable = false;
  await runtime.synchronizeNow();
  assert.equal(projections.at(-1)?.approval, undefined);
  assert.equal(projections.at(-1)?.activity?.phase, "planning");
  assert.equal(projections.at(-1)?.activity?.cycleId, "running_task-running-approval");
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
  assert.deepEqual(api.acknowledgedMessages, [THREAD_ID, REPLY_ID]);
  assert.doesNotMatch(JSON.stringify(api.createdMessages), /Message received/u);

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
  assert.equal(
    api.createdMessages.filter((payload) =>
      JSON.stringify(payload).includes("The cross-device report is ready."),
    ).length,
    1,
  );
  assert.deepEqual(api.completedAcknowledgements.at(-1), {
    messageId: REPLY_ID,
    outcome: "success",
  });

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

test("Main Discord runtime replays a tagless Forum post without advancing its cursor during a resource race", async () => {
  const clock = new TestClock();
  const repository = new InMemoryDiscordStateRepository();
  const tasks = new TaskService({
    clock: { now: () => NOW },
    eventStore: new InMemoryEventStore({ clock: { now: () => NOW } }),
  });
  const api = new TestDiscordApi();
  api.resourcesVisible = false;
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

  await runtime.start();
  await assert.rejects(gateway.dispatch(messageDispatch(api.starter)), {
    code: "NOT_FOUND",
  });
  await gateway.dispatch(threadDispatch(api.thread, 3));
  assert.equal((await tasks.list()).length, 0);
  assert.equal((await repository.getGatewayCursor())?.sequence, 1);

  api.resourcesVisible = true;
  await gateway.dispatch(messageDispatch(api.starter));
  await gateway.dispatch(threadDispatch(api.thread, 3));
  await runtime.synchronizeNow();

  assert.equal((await tasks.list()).length, 1);
  assert.equal((await repository.getGatewayCursor())?.sequence, 3);
  assert.deepEqual(api.appliedTags.at(-1), [STATUS_TAGS.intake]);
  await runtime.close();
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
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
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
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
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

test("singleton loss during Discord startup cancels and closes the in-flight runtime", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-discord-singleton-loss-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const adminRoot = join(home, "admin");
  await mkdir(adminRoot);
  await writeFile(join(adminRoot, "index.html"), "<!doctype html><title>OpenDelegate</title>");
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  const gateway = new DeferredStartupDiscordGateway();
  const ownership = new TestMainSingletonOwnership();
  const creating = createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "discord-singleton-loss-startup" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
    mainSingletonOwnershipFactory: async () => ownership,
    discord: {
      config: discordConfiguration(),
      botTokenAlias: "discord-bot-token",
      secretStore: new TestManagedSecretStore(
        "discord.bot.token.fixture",
        initialized.configuration.deviceId,
      ),
      api: new TestDiscordApi(),
      gateway,
      synchronizationIntervalMs: 60_000,
    },
  });
  await gateway.waitUntilConnecting();

  ownership.lose();
  gateway.releaseConnect();

  await assert.rejects(
    creating,
    (error: unknown) =>
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "MAIN_OWNERSHIP_LOST",
  );
  await ownership.released;
  assert.equal(gateway.closed, true);
  assert.equal(ownership.releaseCalls, 1);
});

test("an owner-approved Discord replacement commits one READY Gateway and survives restart", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-discord-rebinding-"));
  const cleanup: { runtime?: Awaited<ReturnType<typeof createMainRuntime>> } = {};
  t.after(async () => {
    await cleanup.runtime?.close();
    await rm(home, { force: true, recursive: true });
  });
  const adminRoot = join(home, "admin");
  await mkdir(adminRoot);
  await writeFile(join(adminRoot, "index.html"), "<!doctype html><title>OpenDelegate</title>");
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  await mainSecrets.store.store(
    "discord-bot-token",
    Buffer.from("discord.bot.token.fixture", "utf8"),
  );
  let replacement: MainDiscordBindingConfiguration = {
    schemaVersion: 1,
    enabled: true,
    botTokenAlias: "pending-secure-discord-alias",
    forum: discordConfiguration(),
  };
  const configurationAdapter = new DiscordReplacementConfigurationAdapter(replacement);
  const gateway = new TestDiscordGateway();
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "discord-rebinding" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
    agentConfiguration: {
      adapter: configurationAdapter,
      workspace: {
        workspaceId: "workspace_discord_rebinding",
        cwd: await realpath("."),
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: { mode: "deny" },
      limits: AGENT_LIMITS,
    },
    discord: {
      config: discordConfiguration(),
      botTokenAlias: "discord-bot-token",
      secretStore: mainSecrets.store,
      api: new TestDiscordApi(),
      gateway,
      synchronizationIntervalMs: 60_000,
    },
  });
  cleanup.runtime = runtime;
  assert.equal(gateway.connections, 1);

  const claim = await runtime.ownerAuth.issueInitialClaim({ channel: "local-bootstrap" });
  await runtime.ownerAuth.claimOwner({
    channel: "local-bootstrap",
    claimToken: claim.claimToken,
    passphrase: "correct horse battery staple",
  });
  const login = await runtime.ownerAuth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "127.0.0.1",
  });
  const cookie = `__Host-opendelegate_session=${login.sessionToken}`;
  const replacementToken = Buffer.from("discord.bot.token.replacement", "utf8");
  const ingested = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/secrets/ingest",
    headers: {
      host: "127.0.0.1:4380",
      origin: "http://127.0.0.1:4380",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie,
      "x-opendelegate-csrf": login.csrfToken,
      "idempotency-key": "discord-rebinding-secret",
    },
    payload: {
      purpose: "discord-bot-token",
      secretBase64: replacementToken.toString("base64"),
    },
  });
  replacementToken.fill(0);
  assert.equal(ingested.statusCode, 201, ingested.body);
  const replacementAlias = (ingested.json().secretRef as string).slice("secret://main/".length);
  replacement = { ...replacement, botTokenAlias: replacementAlias };
  configurationAdapter.setReplacement(replacement);
  const proposed = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/devices/${initialized.configuration.deviceId}/configuration/messages`,
    headers: {
      host: "127.0.0.1:4380",
      origin: "http://127.0.0.1:4380",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie,
      "x-opendelegate-csrf": login.csrfToken,
      "idempotency-key": "discord-rebinding-proposal",
    },
    payload: { message: "Replace the Discord bot using the securely stored alias." },
  });
  assert.equal(proposed.statusCode, 200, proposed.body);
  assert.match(proposed.json().content, /awaits owner approval/u);

  const listed = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/approvals",
    headers: { host: "127.0.0.1:4380", cookie },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  const approvals = listed.json().approvals as Array<{ readonly approvalId: string }>;
  assert.equal(approvals.length, 1);
  const approvalId = approvals[0]?.approvalId;
  assert.ok(approvalId);
  const decisionRequest = {
    method: "POST" as const,
    url: `/api/v1/approvals/${approvalId}/decision`,
    headers: {
      host: "127.0.0.1:4380",
      origin: "http://127.0.0.1:4380",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie,
      "x-opendelegate-csrf": login.csrfToken,
      "idempotency-key": "discord-rebinding-approval",
    },
    payload: { decision: "approve", scope: "once" },
  };
  const decided = await runtime.app.inject(decisionRequest);
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal(decided.json().executionStatus, "succeeded");
  assert.equal(runtime.discord?.status.code, "DISCORD_READY");
  assert.equal(gateway.connections, 2);

  const persisted = await inspectPersistedMainConfiguration({
    configuration: initialized.configuration,
    home,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  assert.deepEqual(persisted["discord.binding"]?.value, replacement);

  const replay = await runtime.app.inject(decisionRequest);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), decided.json());
  assert.equal(gateway.connections, 2);

  await runtime.close();
  delete cleanup.runtime;
  const restartedGateway = new TestDiscordGateway();
  const restarted = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "discord-rebinding-restart" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
    discord: {
      config: discordConfiguration(),
      botTokenAlias: "discord-bot-token",
      secretStore: mainSecrets.store,
      api: new TestDiscordApi(),
      gateway: restartedGateway,
      synchronizationIntervalMs: 60_000,
    },
  });
  cleanup.runtime = restarted;
  assert.equal(restarted.discord?.status.code, "DISCORD_READY");
  assert.equal(restartedGateway.connections, 1);
  const restartedPersisted = await inspectPersistedMainConfiguration({
    configuration: initialized.configuration,
    home,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  assert.equal(
    (restartedPersisted["discord.binding"]?.value as { readonly botTokenAlias?: unknown })
      .botTokenAlias,
    replacementAlias,
  );
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
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  const api = new TestDiscordApi();
  const gateway = new TestDiscordGateway();
  const observations: boolean[] = [];
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "discord-before-dispatch" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
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

class DiscordReplacementConfigurationAdapter implements AgentAdapter {
  public readonly adapterId = "fixture-discord-replacement-configuration";
  public readonly provider = "generic" as const;
  #replacement: MainDiscordBindingConfiguration;

  public constructor(replacement: MainDiscordBindingConfiguration) {
    this.#replacement = structuredClone(replacement);
  }

  public setReplacement(replacement: MainDiscordBindingConfiguration): void {
    this.#replacement = structuredClone(replacement);
  }

  public async probe() {
    return {
      contractVersion: 1 as const,
      adapterId: this.adapterId,
      provider: this.provider,
      installed: true,
      version: "1.0.0",
      compatibility: "tested" as const,
      auth: { state: "ready" as const },
      capabilities: {
        start: true,
        resume: true,
        streaming: true,
        cancellation: true,
        approvalBridge: true,
        steering: false,
        checkpointContinuation: true,
        workspaceIsolation: ["none" as const],
      },
      diagnostics: [],
    };
  }

  public async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    return discordAgentHandle(
      discordConfigurationSession(input, this.adapterId),
      JSON.stringify({
        schemaVersion: 1,
        type: "tool",
        toolCallId: "inspect-discord-binding",
        request: { tool: "inspect" },
      }),
    );
  }

  public async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    const line = input.prompt.split("\n")[2];
    assert.ok(line);
    const result = JSON.parse(line) as {
      readonly tool: "apply" | "inspect" | "propose";
      readonly status: "failed" | "succeeded";
      readonly error?: {
        readonly code?: string;
        readonly approvalId?: string;
      };
      readonly receipt?: {
        readonly result?: {
          readonly revision?: number;
          readonly proposal?: {
            readonly id?: string;
            readonly baseRevision?: number;
          };
        };
      };
    };
    if (result.tool === "inspect") {
      assert.equal(result.status, "succeeded");
      assert.equal(typeof result.receipt?.result?.revision, "number");
      return discordAgentHandle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "propose-discord-binding",
          request: {
            tool: "propose",
            expectedRevision: result.receipt?.result?.revision,
            reason: "Replace the Discord binding using a securely stored bot credential alias.",
            changes: [
              {
                operation: "set",
                key: "discord.binding",
                scope: {
                  kind: "main",
                  id: input.session.taskId.slice("configuration:".length),
                },
                value: this.#replacement,
              },
            ],
          },
        }),
      );
    }
    if (result.tool === "propose") {
      assert.equal(result.status, "succeeded");
      assert.ok(result.receipt?.result?.proposal?.id);
      assert.equal(typeof result.receipt.result.proposal.baseRevision, "number");
      return discordAgentHandle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "apply-discord-binding",
          request: {
            tool: "apply",
            proposalId: result.receipt.result.proposal.id,
            expectedRevision: result.receipt.result.proposal.baseRevision,
          },
        }),
      );
    }
    assert.equal(result.tool, "apply");
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "CONFIGURATION_TOOL_APPROVAL_REQUIRED");
    assert.match(result.error?.approvalId ?? "", /^approval_/u);
    return discordAgentHandle(
      input.session,
      JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content: "The Discord replacement awaits owner approval.",
        claimReceiptIds: [],
      }),
    );
  }
}

function discordConfigurationSession(
  input: AgentStartRequest,
  adapterId: string,
): NativeSessionReference {
  return {
    schemaVersion: 1,
    provider: "generic",
    adapterId,
    adapterVersion: "1.0.0",
    nativeSessionId: "native-discord-rebinding-configuration",
    sessionKey: input.sessionKey,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    deviceId: input.deviceId,
    workspaceId: input.workspace.workspaceId,
    cwd: input.workspace.cwd,
    lineage: { lineageId: "lineage-discord-rebinding-configuration" },
    createdAt: new Date().toISOString(),
  };
}

function discordAgentHandle(reference: NativeSessionReference, finalText: string): AgentRunHandle {
  const events: readonly NormalizedAgentEvent[] = [
    {
      sequence: 1,
      observedAt: new Date().toISOString(),
      type: "session_started",
      session: reference,
    },
  ];
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    result: Promise.resolve({
      status: "succeeded" as const,
      session: reference,
      finalText,
    }),
    async cancel() {},
  };
}

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

class DeferredStartupDiscordGateway implements DiscordGatewayPort {
  public closed = false;
  readonly #connecting: Promise<void>;
  readonly #connectGate: Promise<void>;
  #resolveConnecting!: () => void;
  #resolveConnectGate!: () => void;

  public constructor() {
    this.#connecting = new Promise<void>((resolve) => {
      this.#resolveConnecting = resolve;
    });
    this.#connectGate = new Promise<void>((resolve) => {
      this.#resolveConnectGate = resolve;
    });
  }

  public waitUntilConnecting(): Promise<void> {
    return this.#connecting;
  }

  public releaseConnect(): void {
    this.#resolveConnectGate();
  }

  public async connect(): Promise<DiscordGatewayConnection> {
    this.#resolveConnecting();
    await this.#connectGate;
    return {
      close: async () => {
        this.closed = true;
      },
    };
  }
}

class TestDiscordApi implements DiscordApiPort {
  public online = true;
  public resourcesVisible = true;
  public statusPanelWritten = false;
  public readonly appliedTags: Array<readonly string[]> = [];
  public readonly createdMessages: DiscordMessagePayload[] = [];
  public readonly acknowledgedMessages: string[] = [];
  public readonly completedAcknowledgements: Array<{
    readonly messageId: string;
    readonly outcome: "success" | "failure";
  }> = [];
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
  readonly #messageByRequestKey = new Map<string, string>();
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
    this.#requireResourcesVisible();
    return structuredClone(this.thread);
  }

  public async getMessage(_threadId: string, messageId: string): Promise<DiscordMessage> {
    this.#requireOnline();
    this.#requireResourcesVisible();
    if (messageId !== THREAD_ID) {
      throw new DiscordApiError("NOT_FOUND", "The message does not exist.");
    }
    return structuredClone(this.starter);
  }

  public async listActiveThreads(): Promise<readonly DiscordThread[]> {
    this.#requireOnline();
    if (!this.resourcesVisible) {
      return [];
    }
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
    this.#requireResourcesVisible();
    return {
      messages:
        after === undefined || BigInt(after) < BigInt(THREAD_ID)
          ? [structuredClone(this.starter)]
          : [],
      hasMore: false,
    };
  }

  public async createForumPost(input: {
    forumChannelId: string;
    requestKey: string;
    name: string;
    content: string;
    appliedTagIds: readonly string[];
  }): Promise<{ thread: DiscordThread; starterMessage: DiscordMessage }> {
    this.#requireOnline();
    const threadId = (850_000_000_000_000_000n + this.#nextMessageId++).toString();
    return {
      thread: {
        id: threadId,
        guildId: GUILD_ID,
        parentId: input.forumChannelId,
        type: 11,
        name: input.name,
        ownerId: BOT_ID,
        appliedTagIds: [...input.appliedTagIds],
        archived: false,
        locked: false,
      },
      starterMessage: {
        id: threadId,
        guildId: GUILD_ID,
        channelId: threadId,
        author: { id: BOT_ID, bot: true, roleIds: [] },
        content: input.content,
        attachments: [],
        createdAtMs: 3_000,
      },
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
    readonly requestKey: string;
    readonly payload: DiscordMessagePayload;
  }): Promise<{ readonly messageId: string }> {
    this.#requireOnline();
    const existing = this.#messageByRequestKey.get(input.requestKey);
    if (existing !== undefined) {
      return { messageId: existing };
    }
    this.createdMessages.push(structuredClone(input.payload));
    const messageId = this.#nextMessage();
    this.#messageByRequestKey.set(input.requestKey, messageId);
    return { messageId };
  }

  public async editMessage(input: { readonly payload: DiscordMessagePayload }): Promise<void> {
    this.#requireOnline();
    this.createdMessages.push(structuredClone(input.payload));
  }

  public async deleteMessage(): Promise<void> {
    this.#requireOnline();
  }

  public async acknowledgeMessage(input: {
    readonly messageId: string;
  }): Promise<{ readonly reactionVisible: boolean; readonly typingVisible: boolean }> {
    this.#requireOnline();
    this.acknowledgedMessages.push(input.messageId);
    return { reactionVisible: true, typingVisible: true };
  }

  public async refreshTyping(): Promise<boolean> {
    this.#requireOnline();
    return true;
  }

  public async completeMessageAcknowledgement(input: {
    readonly messageId: string;
    readonly outcome: "success" | "failure";
  }): Promise<{ readonly acknowledgementRemoved: boolean; readonly outcomeVisible: boolean }> {
    this.#requireOnline();
    this.completedAcknowledgements.push({
      messageId: input.messageId,
      outcome: input.outcome,
    });
    return { acknowledgementRemoved: true, outcomeVisible: true };
  }

  public async deferInteraction(): Promise<{ readonly responseRef: string }> {
    throw new Error("No interaction is expected in this test.");
  }

  public async editDeferredInteraction(): Promise<void> {
    throw new Error("No interaction is expected in this test.");
  }

  public async deleteDeferredInteraction(): Promise<void> {
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

  #requireResourcesVisible(): void {
    if (!this.resourcesVisible) {
      throw new DiscordApiError("NOT_FOUND", "Discord has not exposed the resource yet.");
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

class TestMainSingletonOwnership implements MainSingletonOwnership {
  public readonly backend = "sqlite" as const;
  public releaseCalls = 0;
  readonly #listeners = new Set<(error: MainSingletonOwnershipError) => void>();
  readonly #released: Promise<void>;
  #resolveReleased!: () => void;
  #loss: MainSingletonOwnershipError | undefined;

  public constructor() {
    this.#released = new Promise<void>((resolve) => {
      this.#resolveReleased = resolve;
    });
  }

  public get released(): Promise<void> {
    return this.#released;
  }

  public assertCurrent(): void {
    if (this.#loss !== undefined) {
      throw this.#loss;
    }
  }

  public onLost(listener: (error: MainSingletonOwnershipError) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async release(): Promise<void> {
    this.releaseCalls += 1;
    this.#resolveReleased();
  }

  public lose(): void {
    this.#loss = new MainSingletonOwnershipError(
      "MAIN_OWNERSHIP_LOST",
      "The test Main singleton authority was lost.",
    );
    for (const listener of this.#listeners) {
      listener(this.#loss);
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

function threadDispatch(thread: DiscordThread, sequence: number): DiscordGatewayDispatch {
  return {
    type: "THREAD_CREATE",
    sessionId: "discord-session",
    resumeGatewayUrl: "wss://gateway.discord.gg",
    sequence,
    thread,
  };
}
