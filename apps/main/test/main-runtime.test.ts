import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { arch, hostname, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";
import {
  ConfigurationService,
  STANDARD_CONFIGURATION_DEFINITIONS,
} from "@opendelegate/configuration";
import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  SecretAvailability,
} from "@opendelegate/secrets";
import { SqlConfigurationRepository } from "@opendelegate/storage-sql";

import { browserOpenCommand, openBrowser, parseArguments } from "../src/cli.ts";
import {
  inspectPersistedMainConfiguration,
  listenMainRuntime,
  loadMainConfiguration,
  MainSingletonOwnershipError,
  MainRuntimeError,
  resolveRuntimePaths,
  type MainSingletonOwnership,
} from "../src/index.ts";
import { createMainTestSecretContext } from "../test-fixtures/main-test-secrets.ts";
import { createMainRuntime, initializeMainHome } from "../test-fixtures/portable-main-runtime.ts";

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const DEVELOPMENT_RELEASE_IDENTITY = {
  declaredReleaseChannel: "development",
  releaseChannel: "development",
  releaseVerification: { status: "not-applicable" },
} as const;

test("CLI init accepts secret-free database and exact HTTPS listener configuration", () => {
  const parsed = parseArguments([
    "init",
    "--database",
    "postgresql",
    "--database-uri-ref",
    "secret://main/database-primary",
    "--database-uri-stdin",
    "--secret-backend-config",
    "secret-backend.json",
    "--database-schema",
    "opendelegate",
    "--agent",
    "claude",
    "--admin-auto-open",
    "enabled",
    "--artifact-config",
    "artifacts.json",
    "--discord-config",
    "discord.json",
    "--listen-host",
    "100.64.0.10",
    "--listen-port",
    "443",
    "--listen-origin",
    "https://main.example.test",
    "--tls-certificate",
    "certificate.pem",
    "--tls-private-key",
    "private-key.pem",
  ]);

  assert.deepEqual(parsed.database, {
    adapter: "postgresql",
    uriRef: "secret://main/database-primary",
    schema: "opendelegate",
  });
  assert.deepEqual(parsed.listener, {
    host: "100.64.0.10",
    port: 443,
    origin: "https://main.example.test",
    tls: {
      certificatePath: resolve("certificate.pem"),
      privateKeyPath: resolve("private-key.pem"),
    },
  });
  assert.equal(parsed.agentProvider, "claude");
  assert.equal(parsed.adminAutoOpen, true);
  assert.equal(parsed.artifactConfigurationFile, resolve("artifacts.json"));
  assert.equal(parsed.discordConfigurationFile, resolve("discord.json"));
  assert.equal(parsed.databaseUriStdin, true);
  assert.equal(parsed.secretBackendConfigurationFile, resolve("secret-backend.json"));
  assert.equal(
    parseArguments(["init", "--discord-config", "discord.json", "--discord-token-stdin"])
      .discordTokenStdin,
    true,
  );
  assert.throws(
    () => parseArguments(["serve", "--database", "sqlite"]),
    /available only with init/,
  );
  for (const retired of [
    ["init", "--database-uri-environment", "OPENDELEGATE_DATABASE_URI"],
    ["init", "--discord-token-environment", "OPENDELEGATE_DISCORD_TOKEN"],
  ]) {
    assert.throws(
      () => parseArguments(retired),
      (error: unknown) =>
        error instanceof MainRuntimeError && error.code === "CONFIG_MIGRATION_REQUIRED",
    );
  }
  assert.throws(() => parseArguments(["init", "--database", "postgresql"]), /database-uri-ref/);
  assert.throws(() => parseArguments(["serve", "--agent", "codex"]), /available only with init/);
  assert.throws(
    () => parseArguments(["serve", "--admin-auto-open", "enabled"]),
    /available only with init/,
  );
  assert.throws(
    () => parseArguments(["init", "--admin-auto-open", "sometimes"]),
    /enabled or disabled/,
  );
  assert.throws(() => parseArguments(["init", "--agent", "unknown"]), /must be auto/);
  const sharedCodex = parseArguments([
    "init",
    "--agent",
    "codex",
    "--codex-home",
    "/srv/codex-ssot",
  ]);
  assert.equal(sharedCodex.agentProvider, "codex");
  assert.equal(sharedCodex.codexHome, resolve("/srv/codex-ssot"));
  assert.throws(
    () => parseArguments(["init", "--agent", "auto", "--codex-home", "/srv/codex-ssot"]),
    /requires --agent codex/,
  );
  assert.throws(
    () => parseArguments(["serve", "--codex-home", "/srv/codex-ssot"]),
    /available only with init/,
  );
  assert.throws(
    () => parseArguments(["init", "--discord-token-stdin"]),
    /requires --discord-config/,
  );
  assert.throws(
    () => parseArguments(["serve", "--discord-config", "discord.json"]),
    /available only with init/,
  );
  assert.throws(
    () => parseArguments(["serve", "--artifact-config", "artifacts.json"]),
    /available only with init/,
  );
});

test("browser opener commands are explicit for Windows, macOS, and Linux", () => {
  assert.deepEqual(browserOpenCommand("win32", "http://127.0.0.1:4381"), {
    file: "powershell.exe",
    arguments: [
      "-NoProfile",
      "-Command",
      "Start-Process -FilePath $args[0]",
      "http://127.0.0.1:4381",
    ],
  });
  assert.deepEqual(browserOpenCommand("darwin", "http://127.0.0.1:4381"), {
    file: "open",
    arguments: ["http://127.0.0.1:4381"],
  });
  assert.deepEqual(browserOpenCommand("linux", "http://127.0.0.1:4381"), {
    file: "xdg-open",
    arguments: ["http://127.0.0.1:4381"],
  });
  assert.equal(
    browserOpenCommand("win32", "http://127.0.0.1:4381").arguments.some((argument) =>
      argument.includes("-LiteralPath"),
    ),
    false,
  );
});

test("a missing browser opener records only bounded diagnostics and does not escape", () => {
  const events: Array<{
    readonly event: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }> = [];
  assert.doesNotThrow(() =>
    openBrowser("http://127.0.0.1:4381", {
      hostPlatform: "linux",
      spawnProcess() {
        throw new Error("secret://main/browser-opener-must-not-leak");
      },
      recordEvent(event, fields) {
        events.push({ event, fields });
      },
    }),
  );

  assert.deepEqual(events, [
    {
      event: "main.admin-browser.open-failed",
      fields: {
        code: "BROWSER_OPEN_UNAVAILABLE",
        hostPlatform: "linux",
        phase: "spawn-threw",
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /secret|127\.0\.0\.1/iu);
  assert.doesNotThrow(() =>
    openBrowser("http://127.0.0.1:4381", {
      hostPlatform: "linux",
      spawnProcess() {
        throw new Error("missing xdg-open");
      },
      recordEvent() {
        throw new Error("closed diagnostic sink");
      },
    }),
  );
});

test("an asynchronous browser spawn error is contained after the child is unreferenced", () => {
  const events: Array<{
    readonly event: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }> = [];
  let errorListener: ((error: Error) => void) | undefined;
  let unrefCount = 0;
  openBrowser("http://127.0.0.1:4381", {
    hostPlatform: "linux",
    spawnProcess() {
      return {
        once(event, listener) {
          assert.equal(event, "error");
          errorListener = listener;
          return this;
        },
        unref() {
          unrefCount += 1;
        },
      };
    },
    recordEvent(event, fields) {
      events.push({ event, fields });
    },
  });

  assert.equal(unrefCount, 1);
  assert.equal(events.length, 0);
  errorListener?.(new Error("DATABASE_URI=postgresql://secret"));
  assert.deepEqual(events, [
    {
      event: "main.admin-browser.open-failed",
      fields: {
        code: "BROWSER_OPEN_UNAVAILABLE",
        hostPlatform: "linux",
        phase: "child-error",
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /database|postgresql|secret|127\.0\.0\.1/iu);
});

test("init creates a secret-free SQLite Main outside the source checkout", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-init-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const adminRoot = await createAdminFixture(home);
  const mainSecrets = createMainTestSecretContext(home);

  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  assert.equal(initialized.created, true);
  assert.equal(initialized.configuration.database.adapter, "sqlite");
  assert.equal(initialized.configuration.main.origin, "http://127.0.0.1:4380");
  assert.equal(initialized.configuration.main.host, "127.0.0.1");
  assert.equal(initialized.configuration.discord, undefined);
  assert.notEqual(initialized.configuration.instanceId, initialized.configuration.deviceId);

  const serialized = await readFile(join(home, "config", "main.json"), "utf8");
  assert.doesNotMatch(serialized, /password|token|secretValue|databaseUri/i);
  assert.equal(await readFile(join(home, "state", "main.sqlite3")).then(Boolean), true);

  const second = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  assert.equal(second.created, false);
  assert.deepEqual(second.configuration, initialized.configuration);
  await assert.rejects(
    initializeMainHome({
      home,
      adminRoot,
      database: {
        adapter: "postgresql",
        uriRef: "secret://main/database-primary",
      },
      sourceCheckout: resolve("."),
      managedSecretStore: mainSecrets.store,
    }),
    (error: unknown) => error instanceof MainRuntimeError && error.code === "CONFIG_EXISTS",
  );

  await rm(initialized.paths.sqliteFile);
  const resumed = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  assert.equal(resumed.created, false);
  assert.equal(await readFile(resumed.paths.sqliteFile).then(Boolean), true);
});

test("a pre-dynamic Configuration database migrates Discord to explicit disabled state", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-discord-migration-"));
  const cleanup: { runtime?: Awaited<ReturnType<typeof createMainRuntime>> } = {};
  t.after(async () => {
    await cleanup.runtime?.close();
    await rm(home, { force: true, recursive: true });
  });
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot: await createAdminFixture(home),
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
    discord: {
      schemaVersion: 1,
      enabled: true,
      botTokenAlias: "legacy-discord-token",
      forum: {
        applicationId: "11111111111111111",
        botUserId: "22222222222222222",
        guildId: "33333333333333333",
        forumBindings: [
          {
            channelId: "44444444444444444",
            workflowTagIds: {
              done: "50000000000000001",
              failed: "50000000000000002",
              intake: "50000000000000003",
              review: "50000000000000004",
              running: "50000000000000005",
              waiting: "50000000000000006",
            },
          },
        ],
        ownerUserIds: ["60000000000000001"],
        allowedRoleIds: [],
      },
      secretBackend: {
        backend: "windows-dpapi",
        vaultRoot: join(home, "legacy-discord-vault"),
      },
    },
  });
  const repository = await SqlConfigurationRepository.openSqlite({
    filename: initialized.paths.sqliteFile,
    migrationMode: "verify",
  });
  try {
    let sequence = 0;
    const legacyService = new ConfigurationService({
      definitions: STANDARD_CONFIGURATION_DEFINITIONS,
      repository,
      idSource: () => `legacy_configuration_${++sequence}`,
      clock: () => new Date().toISOString(),
    });
    const proposal = await legacyService.propose({
      actor: "legacy-opendelegate-init",
      reason: "Create a pre-dynamic Configuration revision.",
      changes: [
        {
          operation: "set",
          key: "database.adapter",
          scope: { kind: "main", id: initialized.configuration.deviceId },
          value: "sqlite",
        },
      ],
    });
    await legacyService.apply({
      proposalId: proposal.id,
      expectedRevision: 0,
      actor: "legacy-opendelegate-init",
    });
  } finally {
    await repository.close();
  }

  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "discord-migration" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  cleanup.runtime = runtime;
  assert.equal(runtime.discord, undefined);
  const persisted = await inspectPersistedMainConfiguration({
    configuration: initialized.configuration,
    home,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  assert.equal(persisted["discord.binding"]?.value, null);
  assert.equal(persisted["discord.binding"]?.candidates.length, 1);
  assert.equal(
    persisted["discord.binding"]?.candidates[0]?.scope.id,
    initialized.configuration.deviceId,
  );
});

test("runtime state rejects a managed symlink or Windows junction before writing through it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-links-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const outside = join(root, "outside");
  await Promise.all([mkdir(home), mkdir(outside)]);
  await symlink(outside, join(home, "config"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    initializeMainHome({
      home,
      adminRoot: await createAdminFixture(root),
      sourceCheckout: resolve("."),
    }),
    (error: unknown) => error instanceof MainRuntimeError && error.code === "RUNTIME_PATH_UNSAFE",
  );
  assert.deepEqual(await readFile(join(outside, "main.json"), "utf8").catch(() => null), null);
});

test("runtime serves Admin and a durable authenticated Task API across restart", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-runtime-"));
  const cleanup: {
    runtime?: Awaited<ReturnType<typeof createMainRuntime>>;
  } = {};
  t.after(async () => {
    await cleanup.runtime?.close();
    await rm(home, { force: true, recursive: true });
  });
  const adminRoot = await createAdminFixture(home);
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });

  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "release-candidate-spoof" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  const initialConfiguration = await inspectPersistedMainConfiguration({
    configuration: initialized.configuration,
    home,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  assert.equal(initialConfiguration["discord.binding"]?.value, null);
  assert.deepEqual(initialConfiguration["discord.binding"]?.candidates, [
    {
      scope: { kind: "main", id: initialized.configuration.deviceId },
      value: null,
    },
  ]);
  if (process.platform === "win32") {
    const stateEntries = await readdir(initialized.paths.stateDirectory);
    assert.ok(stateEntries.includes("main.sqlite3-wal"));
    assert.ok(stateEntries.includes("main.sqlite3-shm"));
  }
  const claim = await runtime.ownerAuth.issueInitialClaim({ channel: "local-bootstrap" });
  const claimed = await runtime.ownerAuth.claimOwner({
    channel: "local-bootstrap",
    claimToken: claim.claimToken,
    passphrase: "correct horse battery staple",
  });
  const login = await runtime.ownerAuth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "127.0.0.1",
  });
  const cookie = `__Host-opendelegate_session=${login.sessionToken}`;

  const devices = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/devices",
    headers: {
      host: "127.0.0.1:4380",
      cookie,
    },
  });
  assert.equal(devices.statusCode, 200);
  assert.deepEqual(devices.json(), {
    devices: [
      {
        deviceId: initialized.configuration.deviceId,
        name: hostname(),
        osFamily: expectedOsFamily(),
        platformRelease: release(),
        architecture: arch(),
        role: "main",
        connection: "online",
        runtime: "healthy",
        serviceMode: "foreground",
        roles: ["main-coordinator"],
        instructions: [],
        policies: [
          {
            policyId: "policy.official-package-install",
            actionCategory: "configured-official-package-install",
            decision: "allow",
            source: "built-in",
            effectiveScope: "instance",
          },
          {
            policyId: "policy.network-change",
            actionCategory: "os-network-change",
            decision: "require-approval",
            source: "built-in",
            effectiveScope: "instance",
          },
          {
            policyId: "built-in-secret-export",
            actionCategory: "secret-export",
            decision: "deny",
            source: "built-in",
            effectiveScope: "instance",
          },
          {
            policyId: "built-in-cross-device-knowledge-transfer",
            actionCategory: "cross-device-knowledge-transfer",
            decision: "deny",
            source: "built-in",
            effectiveScope: "instance",
          },
          {
            policyId: "built-in-policy-bypass-attempt",
            actionCategory: "policy-bypass-attempt",
            decision: "deny",
            source: "built-in",
            effectiveScope: "instance",
          },
        ],
        routes: [
          {
            routeId: `main-local:${initialized.configuration.deviceId}`,
            label: "Main-local",
            priority: 0,
            health: "healthy",
          },
        ],
        knowledgeHealth: "unknown",
      },
    ],
  });

  const runtimeFeatures = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/runtime/features",
    headers: {
      host: "127.0.0.1:4380",
      cookie,
    },
  });
  assert.equal(runtimeFeatures.statusCode, 200);
  assert.deepEqual(runtimeFeatures.json(), {
    declaredReleaseChannel: "development",
    releaseChannel: "development",
    releaseVerification: { status: "not-applicable" },
    taskExecution: { status: "unavailable", code: "ORCHESTRATION_NOT_CONNECTED" },
    configurationAgent: {
      status: "unavailable",
      code: "CONFIGURATION_AGENT_NOT_CONNECTED",
    },
    discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
  });

  const admin = await runtime.app.inject({
    method: "GET",
    url: "/",
    headers: { host: "127.0.0.1:4380" },
  });
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /OpenDelegate test shell/);

  for (const url of ["/api/v1/not-a-route", "/health/ready"]) {
    const missingServiceRoute = await runtime.app.inject({
      method: "GET",
      url,
      headers: { host: "127.0.0.1:4380" },
    });
    assert.equal(missingServiceRoute.statusCode, 404);
    assert.match(missingServiceRoute.headers["content-type"] ?? "", /^application\/problem\+json/);
    assert.equal(missingServiceRoute.json().code, "ROUTE_NOT_FOUND");
  }

  const adminClientRoute = await runtime.app.inject({
    method: "GET",
    url: "/tasks/example-task",
    headers: { host: "127.0.0.1:4380" },
  });
  assert.equal(adminClientRoute.statusCode, 200);
  assert.match(adminClientRoute.headers["content-type"] ?? "", /^text\/html/);
  assert.match(adminClientRoute.body, /OpenDelegate test shell/);

  const created = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: {
      host: "127.0.0.1:4380",
      origin: "http://127.0.0.1:4380",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie,
      "x-opendelegate-csrf": login.csrfToken,
      "idempotency-key": "restart-task-1",
    },
    payload: {
      objective: "Survive Main restart.",
      completionCriteria: ["The Task is restored."],
      constraints: [],
      selectedInputRefs: [],
    },
  });
  assert.equal(created.statusCode, 503);
  assert.equal(created.json().code, "TASK_EXECUTION_UNAVAILABLE");
  const durableTask = await runtime.tasks.create({
    objective: "Survive Main restart.",
    completionCriteria: ["The Task is restored."],
    constraints: [],
    selectedInputRefs: [],
    principalId: claimed.ownerId,
    idempotencyKey: "restart-task-internal-1",
  });
  const taskId = durableTask.taskId;
  assert.equal(durableTask.mode, "auto");
  const blockedResume = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/actions`,
    headers: {
      host: "127.0.0.1:4380",
      origin: "http://127.0.0.1:4380",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie,
      "x-opendelegate-csrf": login.csrfToken,
      "idempotency-key": "restart-task-resume-1",
    },
    payload: { command: "resume" },
  });
  assert.equal(blockedResume.statusCode, 503);
  assert.equal(blockedResume.json().code, "TASK_EXECUTION_UNAVAILABLE");
  assert.equal(claimed.recoveryCodes.length, 10);
  await runtime.close();

  const restarted = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "test-build-0001" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  cleanup.runtime = restarted;
  const restoredLogin = await restarted.ownerAuth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "127.0.0.1",
  });
  const restored = await restarted.app.inject({
    method: "GET",
    url: `/api/v1/tasks/${taskId}`,
    headers: {
      host: "127.0.0.1:4380",
      cookie: `__Host-opendelegate_session=${restoredLogin.sessionToken}`,
    },
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().objective, "Survive Main restart.");
});

test("one Main owns an installation and restart reconciliation begins only after release", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-singleton-runtime-"));
  const mainSecrets = createMainTestSecretContext(home);
  const runtimes: Array<Awaited<ReturnType<typeof createMainRuntime>>> = [];
  t.after(async () => {
    await Promise.allSettled(runtimes.map(async (runtime) => runtime.close()));
    await rm(home, { force: true, recursive: true });
  });
  const initialized = await initializeMainHome({
    home,
    adminRoot: await createAdminFixture(home),
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  const first = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "singleton-first" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  runtimes.push(first);
  await first.tasks.create({
    principalId: "owner_singleton_test",
    idempotencyKey: "singleton-restart-task",
    objective: "Resume only under the next exclusive Main.",
    completionCriteria: ["Exactly one exclusive Main executes the Task."],
    constraints: [],
    selectedInputRefs: [],
  });

  let executions = 0;
  await assert.rejects(
    createMainRuntime({
      configuration: initialized.configuration,
      home,
      build: { version: "0.1.0-test", buildId: "singleton-rejected" },
      releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
      sourceCheckout: resolve("."),
      managedSecretStore: mainSecrets.store,
      taskExecution: {
        executor: {
          async execute(request) {
            executions += 1;
            return {
              state: "completed",
              verifiedCompletionCriteria: [...request.task.completionCriteria],
            };
          },
        },
      },
    }),
    isRuntimeError("MAIN_ALREADY_RUNNING"),
  );
  assert.equal(executions, 0);

  await first.close();
  const restarted = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "singleton-restarted" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
    taskExecution: {
      retryDelayMs: 0,
      executor: {
        async execute(request) {
          executions += 1;
          return {
            state: "completed",
            verifiedCompletionCriteria: [...request.task.completionCriteria],
          };
        },
      },
    },
  });
  runtimes.push(restarted);
  await restarted.taskExecution?.waitForIdle();
  assert.equal(executions, 1);
});

test("losing singleton authority closes Main and prevents a listener from starting", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-singleton-loss-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot: await createAdminFixture(home),
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  const ownership = new ControllableMainSingletonOwnership();
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "singleton-loss" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
    mainSingletonOwnershipFactory: async () => ownership,
  });

  ownership.lose();
  await ownership.released;
  assert.equal(ownership.releaseCalls, 1);
  await assert.rejects(listenMainRuntime(runtime), isRuntimeError("MAIN_OWNERSHIP_LOST"));
  await runtime.close();
  assert.equal(ownership.releaseCalls, 1);
});

test("an injected production Task executor makes the authenticated Task API executable", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-task-executor-"));
  const cleanup: {
    runtime?: Awaited<ReturnType<typeof createMainRuntime>>;
  } = {};
  t.after(async () => {
    await cleanup.runtime?.close();
    await rm(home, { force: true, recursive: true });
  });
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot: await createAdminFixture(home),
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "task-executor-composition" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
    taskExecution: {
      retryDelayMs: 0,
      executor: {
        async execute(request) {
          return {
            state: "completed",
            verifiedCompletionCriteria: [...request.task.completionCriteria],
          };
        },
      },
    },
  });
  cleanup.runtime = runtime;
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
  const headers = {
    host: "127.0.0.1:4380",
    cookie: `__Host-opendelegate_session=${login.sessionToken}`,
  };

  const features = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/runtime/features",
    headers,
  });
  assert.deepEqual(features.json().taskExecution, {
    status: "ready",
    code: "TASK_EXECUTION_READY",
  });

  const created = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: {
      ...headers,
      origin: "http://127.0.0.1:4380",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-opendelegate-csrf": login.csrfToken,
      "idempotency-key": "executable-task-1",
    },
    payload: {
      objective: "Execute through Main.",
      completionCriteria: ["Main records verified completion."],
      constraints: [],
      selectedInputRefs: [],
    },
  });
  assert.equal(created.statusCode, 201);
  await runtime.taskExecution?.waitForIdle();
  assert.equal((await runtime.tasks.get(created.json().taskId)).state, "completed");
});

test("an injected Configuration Agent is exposed only through the authenticated Device route", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-configuration-agent-"));
  const cleanup: {
    runtime?: Awaited<ReturnType<typeof createMainRuntime>>;
  } = {};
  t.after(async () => {
    await cleanup.runtime?.close();
    await rm(home, { force: true, recursive: true });
  });
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot: await createAdminFixture(home),
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  const calls: unknown[] = [];
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "configuration-agent-composition" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
    configurationAgent: {
      async sendMessage(input) {
        calls.push(input);
        return {
          messageId: "configuration_message_main_001",
          sessionId: "configuration_session_main",
          content: "The Main Device configuration has been inspected.",
          occurredAt: "2026-07-24T00:00:00.000Z",
        };
      },
    },
  });
  cleanup.runtime = runtime;
  const claim = await runtime.ownerAuth.issueInitialClaim({ channel: "local-bootstrap" });
  const owner = await runtime.ownerAuth.claimOwner({
    channel: "local-bootstrap",
    claimToken: claim.claimToken,
    passphrase: "correct horse battery staple",
  });
  const login = await runtime.ownerAuth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "127.0.0.1",
  });
  const headers = {
    host: "127.0.0.1:4380",
    cookie: `__Host-opendelegate_session=${login.sessionToken}`,
  };

  const features = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/runtime/features",
    headers,
  });
  assert.deepEqual(features.json().configurationAgent, {
    status: "ready",
    code: "CONFIGURATION_AGENT_READY",
  });

  const response = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/devices/${initialized.configuration.deviceId}/configuration/messages`,
    headers: {
      ...headers,
      origin: "http://127.0.0.1:4380",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-opendelegate-csrf": login.csrfToken,
      "idempotency-key": "main-configuration-message-1",
    },
    payload: { message: "Inspect the Main Device configuration." },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().content, "The Main Device configuration has been inspected.");
  assert.deepEqual(calls, [
    {
      deviceId: initialized.configuration.deviceId,
      principalId: owner.ownerId,
      idempotencyKey: "main-configuration-message-1",
      message: "Inspect the Main Device configuration.",
    },
  ]);
});

test(
  "production Main composes PostgreSQL through a managed Secret reference",
  { skip: postgresUri === undefined ? "OPENDELEGATE_TEST_POSTGRES_URI is not configured" : false },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "opendelegate-main-postgres-"));
    const cleanup: {
      runtime?: Awaited<ReturnType<typeof createMainRuntime>>;
    } = {};
    const adminPool = new Pool({ connectionString: postgresUri });
    const schema = `main_${randomUUID().replaceAll("-", "")}`;
    t.after(async () => {
      try {
        await cleanup.runtime?.close();
      } finally {
        try {
          await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await adminPool.end();
          await rm(home, { force: true, recursive: true });
        }
      }
    });
    const adminRoot = await createAdminFixture(home);
    const mainSecrets = createMainTestSecretContext(home, {
      deviceId: "device_postgres",
    });
    const secretStore = mainSecrets.store;
    const initialized = await initializeMainHome({
      home,
      adminRoot,
      sourceCheckout: resolve("."),
      database: {
        adapter: "postgresql",
        uriRef: "secret://main/database-primary",
        schema,
      },
      databaseSecret: Buffer.from(postgresUri!, "utf8"),
      secretBackend: mainSecrets.configuration,
      managedSecretStore: secretStore,
    });
    const serialized = await readFile(initialized.paths.configurationFile, "utf8");
    assert.match(serialized, /secret:\/\/main\/database-primary/);
    assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//i);

    const runtime = await createMainRuntime({
      configuration: initialized.configuration,
      home,
      build: { version: "0.1.0-test", buildId: "postgres-composition" },
      releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
      sourceCheckout: resolve("."),
      managedSecretStore: secretStore,
    });
    cleanup.runtime = runtime;
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
    const readiness = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/readiness",
      headers: {
        host: "127.0.0.1:4380",
        cookie: `__Host-opendelegate_session=${login.sessionToken}`,
      },
    });
    assert.equal(readiness.statusCode, 200);
    assert.deepEqual(
      readiness.json().checks.map((check: { code: string }) => check.code),
      ["DATABASE_READY", "CONTROL_PLANE_READY"],
    );
  },
);

test("Main ignores database and Discord credentials placed in process-style environment fields", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-no-env-secrets-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const adminRoot = await createAdminFixture(home);
  const environmentUri =
    "postgresql://environment-owner:must-not-import@environment.example.test/opendelegate";
  const environmentToken = "must.not.import.discord.token";

  await assert.rejects(
    initializeMainHome({
      home,
      adminRoot,
      sourceCheckout: resolve("."),
      database: {
        adapter: "postgresql",
        uriRef: "secret://main/database-primary",
      },
      secretBackend: {
        backend: "windows-dpapi",
        vaultRoot: join(home, "secrets", "main"),
      },
      managedSecretStore: new RuntimeManagedSecretStore("device_environment_negative"),
      environment: {
        OPENDELEGATE_DATABASE_URI: environmentUri,
        DATABASE_URL: environmentUri,
        OPENDELEGATE_DISCORD_TOKEN: environmentToken,
        DISCORD_TOKEN: environmentToken,
      },
    }),
    isRuntimeError("DATABASE_SECRET_UNAVAILABLE"),
  );

  const persisted = await readFile(join(home, "config", "main.json"), "utf8");
  assert.match(persisted, /secret:\/\/main\/database-primary/u);
  assert.doesNotMatch(
    persisted,
    /must-not-import|environment\.example\.test|must\.not\.import\.discord\.token/u,
  );
});

test("configuration rejects remote cleartext binding, unknown fields, and checkout state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-config-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const adminRoot = await createAdminFixture(root);
  const sourceCheckout = join(root, "checkout");
  await mkdir(sourceCheckout, { recursive: true });
  const paths = resolveRuntimePaths({
    home: join(root, "home"),
    sourceCheckout,
  });
  assert.equal(paths.home, resolve(root, "home"));

  await assert.rejects(
    initializeMainHome({
      home: join(root, "checkout", "runtime"),
      adminRoot,
      sourceCheckout: join(root, "checkout"),
    }),
    isRuntimeError("RUNTIME_PATH_UNSAFE"),
  );

  const configDirectory = join(root, "bad-config");
  await mkdir(configDirectory, { recursive: true });
  const configPath = join(configDirectory, "main.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      instanceId: "instance_1",
      deviceId: "device_1",
      main: {
        host: "0.0.0.0",
        port: 4380,
        origin: "http://example.test:4380",
      },
      database: { adapter: "sqlite" },
      secretBackend: {
        backend: "windows-dpapi",
        vaultRoot: join(root, "secrets"),
      },
      adminRoot,
      rawToken: "must-fail",
    }),
  );
  await assert.rejects(loadMainConfiguration(configPath), isRuntimeError("CONFIG_INVALID"));

  const legacyConfigPath = join(configDirectory, "legacy-main.json");
  await writeFile(
    legacyConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      instanceId: "instance_legacy",
      deviceId: "device_legacy",
      main: {
        host: "127.0.0.1",
        port: 4380,
        origin: "http://127.0.0.1:4380",
      },
      database: {
        adapter: "postgresql",
        uriEnvironment: "OPENDELEGATE_DATABASE_URI",
      },
      secretBackend: {
        backend: "windows-dpapi",
        vaultRoot: join(root, "secrets"),
      },
      adminRoot,
    }),
  );
  await assert.rejects(
    loadMainConfiguration(legacyConfigPath),
    isRuntimeError("CONFIG_MIGRATION_REQUIRED"),
  );
});

class RuntimeManagedSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-dpapi";
  readonly deviceId: string;
  #value: Buffer | undefined;

  public constructor(deviceId: string, value?: string) {
    this.deviceId = deviceId;
    this.#value = value === undefined ? undefined : Buffer.from(value, "utf8");
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    return { backend: this.backend, deviceId: this.deviceId, status: "ready" };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: this.#value !== undefined };
  }

  public async store(_alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    this.#value?.fill(0);
    this.#value = Buffer.from(value);
    return { status: "stored" };
  }

  public async rotate(_alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    this.#value?.fill(0);
    this.#value = Buffer.from(value);
    return { status: "rotated" };
  }

  public async delete(_alias: string): Promise<ManagedSecretDeletion> {
    const status = this.#value === undefined ? "absent" : "deleted";
    this.#value?.fill(0);
    this.#value = undefined;
    return { status };
  }

  public async executeWithSecretBytes(
    _alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    if (this.#value === undefined) {
      throw new Error("Secret is unavailable.");
    }
    const copy = Buffer.from(this.#value);
    try {
      await executor(copy);
    } finally {
      copy.fill(0);
    }
  }
}

class ControllableMainSingletonOwnership implements MainSingletonOwnership {
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
      "The test authority was lost.",
    );
    for (const listener of this.#listeners) {
      listener(this.#loss);
    }
  }
}

async function createAdminFixture(parent: string): Promise<string> {
  const root = join(parent, "admin-dist");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><title>OpenDelegate test shell</title><div id="root"></div>',
  );
  await writeFile(join(root, "assets", "app.js"), "console.log('test');");
  return root;
}

function isRuntimeError(code: string) {
  return (error: unknown): boolean => error instanceof MainRuntimeError && error.code === code;
}

function expectedOsFamily(): "macos" | "windows" | "linux" {
  switch (platform()) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
