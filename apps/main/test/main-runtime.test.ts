import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { arch, hostname, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Pool } from "pg";

import { parseArguments } from "../src/cli.ts";
import {
  createMainRuntime,
  initializeMainHome,
  loadMainConfiguration,
  MainRuntimeError,
  resolveRuntimePaths,
} from "../src/index.ts";

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const execFileAsync = promisify(execFile);

test("CLI init accepts secret-free database and exact HTTPS listener configuration", () => {
  const parsed = parseArguments([
    "init",
    "--database",
    "postgresql",
    "--database-uri-environment",
    "OPENDELEGATE_DATABASE_URI",
    "--database-schema",
    "opendelegate",
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
    uriEnvironment: "OPENDELEGATE_DATABASE_URI",
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
  assert.throws(
    () => parseArguments(["serve", "--database", "sqlite"]),
    /available only with init/,
  );
  assert.throws(
    () => parseArguments(["init", "--database", "postgresql"]),
    /database-uri-environment/,
  );
});

test("init creates a secret-free SQLite Main outside the source checkout", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-init-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const adminRoot = await createAdminFixture(home);

  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
  });
  await assertWindowsRuntimeOwnership(home);

  assert.equal(initialized.created, true);
  assert.equal(initialized.configuration.database.adapter, "sqlite");
  assert.equal(initialized.configuration.main.origin, "http://127.0.0.1:4380");
  assert.equal(initialized.configuration.main.host, "127.0.0.1");
  assert.notEqual(initialized.configuration.instanceId, initialized.configuration.deviceId);

  const serialized = await readFile(join(home, "config", "main.json"), "utf8");
  assert.doesNotMatch(serialized, /password|token|secretValue|databaseUri/i);
  assert.equal(await readFile(join(home, "state", "main.sqlite3")).then(Boolean), true);

  const second = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
  });
  assert.equal(second.created, false);
  assert.deepEqual(second.configuration, initialized.configuration);
  await assert.rejects(
    initializeMainHome({
      home,
      adminRoot,
      database: {
        adapter: "postgresql",
        uriEnvironment: "OPENDELEGATE_DATABASE_URI",
      },
      sourceCheckout: resolve("."),
    }),
    (error: unknown) => error instanceof MainRuntimeError && error.code === "CONFIG_EXISTS",
  );

  await rm(initialized.paths.sqliteFile);
  const resumed = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
  });
  assert.equal(resumed.created, false);
  assert.equal(await readFile(resumed.paths.sqliteFile).then(Boolean), true);
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
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
  });

  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "release-candidate-spoof" },
    releaseChannel: "development",
    sourceCheckout: resolve("."),
  });
  if (process.platform === "win32") {
    const stateEntries = await readdir(initialized.paths.stateDirectory);
    assert.ok(stateEntries.includes("main.sqlite3-wal"));
    assert.ok(stateEntries.includes("main.sqlite3-shm"));
  }
  await assertWindowsRuntimeOwnership(home);
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
    releaseChannel: "development",
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
    releaseChannel: "development",
    sourceCheckout: resolve("."),
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

test(
  "production Main composes PostgreSQL through an environment reference",
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
    const environment = {
      ...process.env,
      OPENDELEGATE_TEST_POSTGRES_URI: postgresUri,
    };
    const initialized = await initializeMainHome({
      home,
      adminRoot,
      sourceCheckout: resolve("."),
      database: {
        adapter: "postgresql",
        uriEnvironment: "OPENDELEGATE_TEST_POSTGRES_URI",
        schema,
      },
      environment,
    });

    const serialized = await readFile(initialized.paths.configurationFile, "utf8");
    assert.match(serialized, /OPENDELEGATE_TEST_POSTGRES_URI/);
    assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//i);

    const runtime = await createMainRuntime({
      configuration: initialized.configuration,
      home,
      build: { version: "0.1.0-test", buildId: "postgres-composition" },
      releaseChannel: "development",
      sourceCheckout: resolve("."),
      environment,
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
      adminRoot,
      rawToken: "must-fail",
    }),
  );
  await assert.rejects(loadMainConfiguration(configPath), isRuntimeError("CONFIG_INVALID"));
});

async function assertWindowsRuntimeOwnership(root: string): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const verificationScript = String.raw`
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1")
$root = $env:OPENDELEGATE_TEST_ACL_ROOT
$currentSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$items = @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Force -Recurse)
foreach ($item in $items) {
  $ownerSid = (Get-Acl -LiteralPath $item.FullName).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ne $currentSid) {
    throw "Expected '$($item.FullName)' to be owned by '$currentSid', but found '$ownerSid'."
  }
}
`;
  await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", verificationScript],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENDELEGATE_TEST_ACL_ROOT: root,
      },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
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
