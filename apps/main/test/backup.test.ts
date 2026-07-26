import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  SecretAvailability,
} from "@opendelegate/secrets";

import {
  MainBackupError,
  createMainBackup,
  postgresToolEnvironment,
  restoreMainBackup,
  verifyMainBackup,
  type MainBackupConfiguration,
  type MainBackupToolRunner,
} from "../src/backup.ts";

const execFileAsync = promisify(execFile);

test("PostgreSQL child environment contains only a non-secret service selector", () => {
  const environment = postgresToolEnvironment({
    serviceFile: join(tmpdir(), "opendelegate-test-service.conf"),
    serviceName: "opendelegate",
  });
  assert.equal(environment["PGDATABASE"], undefined);
  assert.equal(environment["PGPASSWORD"], undefined);
  assert.equal(environment["PGSERVICE"], "opendelegate");
  assert.equal(environment["PGSERVICEFILE"], join(tmpdir(), "opendelegate-test-service.conf"));
});

test(
  "Windows backup ACL removes explicit third-party grants before secret access",
  { skip: process.platform !== "win32" },
  async (t) => {
    const fixture = await createFixture("postgresql");
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const exportsRoot = join(fixture.root, "exports");
    const destination = join(exportsRoot, "windows-private-backup");
    let stagedRoot: string | undefined;
    const store = new BackupSecretStore(
      fixture.configuration.deviceId,
      "postgresql://owner:password@db.example.test:5432/opendelegate",
      async () => {
        const candidates = (await readdir(exportsRoot, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && entry.name.startsWith(".opendelegate-backup-"),
        );
        assert.equal(candidates.length, 1);
        stagedRoot = join(exportsRoot, candidates[0]!.name);
        await execFileAsync(
          "icacls.exe",
          [stagedRoot, "/grant", "*S-1-5-11:(OI)(CI)RX", "/L", "/Q"],
          {
            encoding: "utf8",
            windowsHide: true,
          },
        );
      },
    );
    const tools: MainBackupToolRunner = {
      async dumpPostgres(input) {
        await writeFile(input.destination, "postgres-custom-archive", {
          flag: "wx",
          mode: 0o600,
        });
      },
      async verifyPostgresArchive() {},
      async assertPostgresTargetEmpty() {},
      async restorePostgres() {},
    };

    await createMainBackup({
      source: fixture.source,
      destination,
      managedSecretStore: store,
      tools,
    });

    assert.notEqual(stagedRoot, undefined);
    await assertWindowsOwnerOnlyTree(destination);
  },
);

test("backup preserves every secret-free production composition including Device enrollment", async (t) => {
  const fixture = await createFixture("sqlite");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const enrollment = {
    schemaVersion: 1 as const,
    enabled: true as const,
    enrollment: {
      advertisedUrl: "https://main.example.test:45443/api/v1/device/enroll",
      host: "0.0.0.0",
      port: 45_443,
      tlsCertificatePath: join(fixture.runtimeHome, "tls", "enrollment.pem"),
      tlsPrivateKeyPath: join(fixture.runtimeHome, "tls", "enrollment-key.pem"),
    },
    workerChannel: {
      advertisedUrl: "wss://main.example.test:45444/api/v1/device/channel",
      host: "0.0.0.0",
      port: 45_444,
      path: "/api/v1/device/channel",
      tlsCertificatePath: join(fixture.runtimeHome, "tls", "worker.pem"),
      tlsPrivateKeyPath: join(fixture.runtimeHome, "tls", "worker-key.pem"),
    },
    secretBackend: {
      backend: "windows-dpapi" as const,
      vaultRoot: join(fixture.runtimeHome, "secrets", "device-identity"),
    },
  };
  const configuration: MainBackupConfiguration = {
    ...fixture.configuration,
    discord: {
      schemaVersion: 1,
      enabled: true,
      botTokenAlias: "discord-bot",
      forum: {
        applicationId: "100000000000000001",
        botUserId: "100000000000000002",
        guildId: "100000000000000003",
        forumBindings: [
          {
            channelId: "100000000000000005",
            workflowTagIds: {
              intake: "200000000000000001",
              running: "200000000000000002",
              waiting: "200000000000000003",
              review: "200000000000000004",
              done: "200000000000000005",
              failed: "200000000000000006",
            },
          },
        ],
        ownerUserIds: ["100000000000000004"],
        allowedRoleIds: [],
      },
      secretBackend: {
        backend: "windows-dpapi",
        vaultRoot: join(fixture.runtimeHome, "secrets", "discord"),
      },
    },
    artifacts: {
      schemaVersion: 1,
      enabled: true,
      listeners: {
        static: {
          host: "127.0.0.1",
          port: 4_382,
          origin: "http://static.artifacts.localhost:4382",
        },
        interactive: {
          host: "127.0.0.1",
          port: 4_383,
          origin: "http://interactive.artifacts.localhost:4383",
        },
      },
      storage: { maximumArtifactBytes: 1024 * 1024 },
      exposure: {
        defaultMode: "private-network",
        privateNetworks: ["127.0.0.0/8"],
        authenticatedBearerAlias: "artifact.owner.bearer",
        authenticatedSessionAlias: "artifact.owner.session",
        customPolicyAliases: {},
      },
      signingKeyAlias: "artifact.signing.v1",
      secretBackend: {
        backend: "windows-dpapi",
        vaultRoot: join(fixture.runtimeHome, "secrets", "artifacts"),
      },
    },
    deviceChannel: {
      enrollment: enrollment.enrollment,
      workerChannel: enrollment.workerChannel,
    },
  };
  await writeFile(fixture.source.configurationFile, `${JSON.stringify(configuration, null, 2)}\n`, {
    mode: 0o600,
  });
  const enrollmentFile = join(fixture.runtimeHome, "config", "device-enrollment.json");
  await writeFile(enrollmentFile, `${JSON.stringify(enrollment, null, 2)}\n`, { mode: 0o600 });

  const destination = join(fixture.root, "exports", "composed-main");
  const manifest = await createMainBackup({
    source: {
      ...fixture.source,
      configuration,
      deviceEnrollmentConfigurationFile: enrollmentFile,
    },
    destination,
  });
  assert.equal(manifest.files.deviceEnrollment?.path, "device-enrollment.json");
  assert.deepEqual(
    (
      await verifyMainBackup({
        backupDirectory: destination,
        sourceCheckout: fixture.checkout,
      })
    ).files.deviceEnrollment,
    manifest.files.deviceEnrollment,
  );

  const restoredHome = join(fixture.root, "restored-composed-main");
  const restored = await restoreMainBackup({
    backupDirectory: destination,
    targetHome: restoredHome,
    sourceCheckout: fixture.checkout,
  });
  assert.deepEqual(restored, configuration);
  assert.deepEqual(
    JSON.parse(await readFile(join(restoredHome, "config", "device-enrollment.json"), "utf8")),
    enrollment,
  );
});

test("SQLite Main metadata backs up, verifies, and restores into a new home", async (t) => {
  const fixture = await createFixture("sqlite");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const destination = join(fixture.root, "exports", "main-backup");
  const manifest = await createMainBackup({
    source: fixture.source,
    destination,
    now: () => new Date("2026-07-25T10:00:00.000Z"),
  });

  assert.equal(manifest.createdAt, "2026-07-25T10:00:00.000Z");
  assert.equal(manifest.source.databaseAdapter, "sqlite");
  assert.equal(manifest.files.agentSelection?.path, "agent.json");
  assert.deepEqual(manifest.exclusions, [
    "managed-secret-values-and-private-keys",
    "device-knowledge",
    "generated-artifacts",
    "logs-and-diagnostics",
  ]);
  assert.equal(
    (
      await verifyMainBackup({
        backupDirectory: destination,
        sourceCheckout: fixture.checkout,
      })
    ).files.database.sha256,
    manifest.files.database.sha256,
  );

  const restoredHome = join(fixture.root, "restored-main");
  const restoredConfiguration = await restoreMainBackup({
    backupDirectory: destination,
    targetHome: restoredHome,
    sourceCheckout: fixture.checkout,
    adminRoot: fixture.adminRoot,
  });
  assert.deepEqual(restoredConfiguration, fixture.configuration);

  const restoredDatabase = new Database(join(restoredHome, "state", "main.sqlite3"), {
    readonly: true,
  });
  try {
    assert.deepEqual(restoredDatabase.prepare("SELECT value FROM durable_state").all(), [
      { value: "preserved" },
    ]);
  } finally {
    restoredDatabase.close();
  }

  const restoredConfigText = await readFile(join(restoredHome, "config", "main.json"), "utf8");
  assert.doesNotMatch(restoredConfigText, /password|secretValue|knowledge|postgres(?:ql)?:\/\//iu);
  assert.deepEqual(JSON.parse(await readFile(join(restoredHome, "config", "agent.json"), "utf8")), {
    schemaVersion: 1,
    provider: "codex",
  });
  await assert.rejects(stat(join(destination, "logs")), { code: "ENOENT" });
  await assert.rejects(stat(join(destination, "knowledge")), { code: "ENOENT" });
  await assert.rejects(stat(join(destination, "artifacts")), { code: "ENOENT" });
});

test("verification rejects changed backup bytes and restore never overwrites a home", async (t) => {
  const fixture = await createFixture("sqlite");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const destination = join(fixture.root, "exports", "tamper-backup");
  await createMainBackup({ source: fixture.source, destination });

  await appendFile(join(destination, "main.sqlite3"), "tamper");
  await assert.rejects(
    verifyMainBackup({
      backupDirectory: destination,
      sourceCheckout: fixture.checkout,
    }),
    (error: unknown) =>
      error instanceof MainBackupError &&
      error.code === "BACKUP_CORRUPT" &&
      !error.message.includes("tamper"),
  );

  const existingHome = join(fixture.root, "existing-main");
  await mkdir(existingHome);
  await assert.rejects(
    restoreMainBackup({
      backupDirectory: destination,
      targetHome: existingHome,
      sourceCheckout: fixture.checkout,
    }),
    (error: unknown) => error instanceof MainBackupError && error.code === "RESTORE_TARGET_EXISTS",
  );
});

test("restore rejects database-adapter changes and PostgreSQL schema remapping", async (t) => {
  const sqliteFixture = await createFixture("sqlite");
  const postgresFixture = await createFixture("postgresql");
  t.after(() => rm(sqliteFixture.root, { recursive: true, force: true }));
  t.after(() => rm(postgresFixture.root, { recursive: true, force: true }));

  const sqliteBackup = join(sqliteFixture.root, "exports", "sqlite-backup");
  await createMainBackup({ source: sqliteFixture.source, destination: sqliteBackup });
  await assert.rejects(
    restoreMainBackup({
      backupDirectory: sqliteBackup,
      targetHome: join(sqliteFixture.root, "restore"),
      sourceCheckout: sqliteFixture.checkout,
      postgresTarget: { uriRef: "secret://main/database-target" },
    }),
    (error: unknown) =>
      error instanceof MainBackupError && error.code === "BACKUP_CONFIGURATION_INVALID",
  );

  const postgresBackup = join(postgresFixture.root, "exports", "postgres-backup");
  const tools: MainBackupToolRunner = {
    async dumpPostgres(input) {
      await writeFile(input.destination, "archive", { flag: "wx" });
    },
    async verifyPostgresArchive() {},
    async assertPostgresTargetEmpty() {},
    async restorePostgres() {
      assert.fail("Schema remapping must fail before pg_restore.");
    },
  };
  await createMainBackup({
    source: postgresFixture.source,
    destination: postgresBackup,
    managedSecretStore: new BackupSecretStore(
      postgresFixture.configuration.deviceId,
      "postgresql://owner:password@db.example.test:5432/opendelegate",
    ),
    tools,
  });
  await assert.rejects(
    restoreMainBackup({
      backupDirectory: postgresBackup,
      targetHome: join(postgresFixture.root, "restore"),
      sourceCheckout: postgresFixture.checkout,
      postgresTarget: {
        uriRef: "secret://main/database-target",
        schema: "different_schema",
      },
      managedSecretStore: new BackupSecretStore(
        postgresFixture.configuration.deviceId,
        "postgresql://owner:password@restore.example.test:5432/opendelegate",
      ),
      tools,
    }),
    (error: unknown) =>
      error instanceof MainBackupError && error.code === "BACKUP_CONFIGURATION_INVALID",
  );
});

test("backup paths cannot enter the source checkout or live runtime home", async (t) => {
  const fixture = await createFixture("sqlite");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  for (const destination of [
    join(fixture.checkout, "backup"),
    join(fixture.runtimeHome, "backup"),
  ]) {
    await assert.rejects(
      createMainBackup({ source: fixture.source, destination }),
      (error: unknown) => error instanceof MainBackupError && error.code === "BACKUP_PATH_UNSAFE",
    );
  }
});

test("PostgreSQL tools receive credentials only through the injected boundary", async (t) => {
  const fixture = await createFixture("postgresql");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceUri = "postgresql://owner:source-password@db.example.test:5432/opendelegate";
  const targetUri = "postgresql://owner:target-password@restore.example.test:5432/opendelegate";
  const observations: {
    dump?: Parameters<MainBackupToolRunner["dumpPostgres"]>[0];
    verify?: Parameters<MainBackupToolRunner["verifyPostgresArchive"]>[0];
    preflight?: Parameters<MainBackupToolRunner["assertPostgresTargetEmpty"]>[0];
    restore?: Parameters<MainBackupToolRunner["restorePostgres"]>[0];
    dumpServiceContents?: string;
    preflightServiceContents?: string;
  } = {};
  const tools: MainBackupToolRunner = {
    async dumpPostgres(input) {
      observations.dump = input;
      const serviceHandle = await open(input.connection.serviceFile, "r");
      try {
        const metadata = await serviceHandle.stat();
        assert.equal(metadata.isFile(), true);
        if (process.platform !== "win32") {
          assert.equal(metadata.mode & 0o077, 0);
        }
        observations.dumpServiceContents = await serviceHandle.readFile("utf8");
      } finally {
        await serviceHandle.close();
      }
      await writeFile(input.destination, Buffer.from("postgres-custom-archive", "utf8"), {
        flag: "wx",
        mode: 0o600,
      });
    },
    async verifyPostgresArchive(input) {
      observations.verify = input;
    },
    async assertPostgresTargetEmpty(input) {
      observations.preflight = input;
      const serviceHandle = await open(input.connection.serviceFile, "r");
      try {
        observations.preflightServiceContents = await serviceHandle.readFile("utf8");
      } finally {
        await serviceHandle.close();
      }
    },
    async restorePostgres(input) {
      observations.restore = input;
    },
  };
  const destination = join(fixture.root, "exports", "postgres-backup");
  await createMainBackup({
    source: fixture.source,
    destination,
    managedSecretStore: new BackupSecretStore(fixture.configuration.deviceId, sourceUri),
    tools,
  });

  assert.doesNotMatch(JSON.stringify(observations.dump), /source-password|db\.example\.test/u);
  assert.match(observations.dumpServiceContents ?? "", /source-password/u);
  await assert.rejects(stat(observations.dump!.connection.serviceFile));
  assert.equal(observations.dump?.schema, "opendelegate");
  assert.equal(observations.verify?.archive.endsWith("main.postgresql.dump"), true);
  const serializedBackup = [
    await readFile(join(destination, "backup-manifest.json"), "utf8"),
    await readFile(join(destination, "main.json"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(serializedBackup, /source-password|db\.example\.test/u);
  assert.match(serializedBackup, /secret:\/\/main\/database-source/u);

  const restoredHome = join(fixture.root, "restored-postgres-main");
  const targetSecret = Buffer.from(targetUri, "utf8");
  const restored = await restoreMainBackup({
    backupDirectory: destination,
    targetHome: restoredHome,
    sourceCheckout: fixture.checkout,
    postgresTarget: {
      uriRef: "secret://main/database-target",
      schema: "opendelegate",
    },
    postgresSecret: targetSecret,
    managedSecretStore: new BackupSecretStore(fixture.configuration.deviceId),
    tools,
  });
  assert.equal(
    targetSecret.every((byte) => byte === 0),
    true,
  );
  assert.doesNotMatch(JSON.stringify(observations.preflight), /target-password|restore\.example/u);
  assert.match(observations.preflightServiceContents ?? "", /target-password/u);
  await assert.rejects(stat(observations.preflight!.connection.serviceFile));
  assert.equal(observations.preflight?.schema, "opendelegate");
  assert.doesNotMatch(JSON.stringify(observations.restore), /target-password|restore\.example/u);
  assert.equal(restored.database.adapter, "postgresql");
  if (restored.database.adapter === "postgresql") {
    assert.equal(restored.database.uriRef, "secret://main/database-target");
  }
  assert.doesNotMatch(
    await readFile(join(restoredHome, "config", "main.json"), "utf8"),
    /target-password|restore\.example\.test/u,
  );
});

test("PostgreSQL verification rejects an invalid archive and restore preflights an empty target", async (t) => {
  const fixture = await createFixture("postgresql");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceUri = "postgresql://owner:source-password@db.example.test:5432/opendelegate";
  const targetUri = "postgresql://owner:target-password@restore.example.test:5432/opendelegate";
  const destination = join(fixture.root, "exports", "postgres-validation-backup");
  let archiveValid = true;
  let restoreCalls = 0;
  const tools: MainBackupToolRunner = {
    async dumpPostgres(input) {
      await writeFile(input.destination, "postgres-custom-archive", {
        flag: "wx",
        mode: 0o600,
      });
    },
    async verifyPostgresArchive() {
      if (!archiveValid) {
        throw new MainBackupError("BACKUP_CORRUPT", "The PostgreSQL archive is invalid.");
      }
    },
    async assertPostgresTargetEmpty() {
      throw new MainBackupError(
        "RESTORE_TARGET_NOT_EMPTY",
        "The PostgreSQL restore target is not empty.",
      );
    },
    async restorePostgres() {
      restoreCalls += 1;
    },
  };

  await createMainBackup({
    source: fixture.source,
    destination,
    managedSecretStore: new BackupSecretStore(fixture.configuration.deviceId, sourceUri),
    tools,
  });

  archiveValid = false;
  await assert.rejects(
    verifyMainBackup({
      backupDirectory: destination,
      sourceCheckout: fixture.checkout,
      tools,
    }),
    (error: unknown) =>
      error instanceof MainBackupError &&
      error.code === "BACKUP_CORRUPT" &&
      !error.message.includes("source-password"),
  );

  archiveValid = true;
  await assert.rejects(
    restoreMainBackup({
      backupDirectory: destination,
      targetHome: join(fixture.root, "postgres-restore-target"),
      sourceCheckout: fixture.checkout,
      postgresTarget: {
        uriRef: "secret://main/database-target",
        schema: "opendelegate",
      },
      managedSecretStore: new BackupSecretStore(fixture.configuration.deviceId, targetUri),
      tools,
    }),
    (error: unknown) =>
      error instanceof MainBackupError &&
      error.code === "RESTORE_TARGET_NOT_EMPTY" &&
      !error.message.includes("target-password"),
  );
  assert.equal(restoreCalls, 0);
});

test("PostgreSQL tool failures cannot surface connection credentials", async (t) => {
  const fixture = await createFixture("postgresql");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceUri = "postgresql://owner:never-log-this@db.example.test:5432/opendelegate";
  let serviceFile: string | undefined;
  const tools: MainBackupToolRunner = {
    async dumpPostgres(input) {
      serviceFile = input.connection.serviceFile;
      await writeFile(input.destination, "postgres-custom-archive", {
        flag: "wx",
        mode: 0o600,
      });
    },
    async verifyPostgresArchive() {
      throw new Error(`driver echoed ${sourceUri}`);
    },
    async assertPostgresTargetEmpty() {},
    async restorePostgres() {},
  };

  await assert.rejects(
    createMainBackup({
      source: fixture.source,
      destination: join(fixture.root, "exports", "sanitized-postgres-backup"),
      managedSecretStore: new BackupSecretStore(fixture.configuration.deviceId, sourceUri),
      tools,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MainBackupError);
      assert.equal(error.code, "BACKUP_CORRUPT");
      const exposed = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}\n${String(error.cause)}`;
      assert.doesNotMatch(exposed, /never-log-this|db\.example\.test/u);
      return true;
    },
  );
  assert.notEqual(serviceFile, undefined);
  await assert.rejects(stat(serviceFile!), { code: "ENOENT" });
});

async function createFixture(adapter: "postgresql" | "sqlite"): Promise<{
  readonly root: string;
  readonly checkout: string;
  readonly runtimeHome: string;
  readonly adminRoot: string;
  readonly configuration: MainBackupConfiguration;
  readonly source: {
    readonly home: string;
    readonly configurationFile: string;
    readonly agentConfigurationFile: string;
    readonly sqliteFile: string;
    readonly configuration: MainBackupConfiguration;
    readonly sourceCheckout: string;
  };
}> {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-backup-test-"));
  const checkout = join(root, "checkout");
  const runtimeHome = join(root, "runtime");
  const adminRoot = join(root, "admin");
  await mkdir(checkout);
  await mkdir(join(runtimeHome, "config"), { recursive: true });
  await mkdir(join(runtimeHome, "state"), { recursive: true });
  await mkdir(join(runtimeHome, "logs"), { recursive: true });
  await mkdir(join(runtimeHome, "knowledge"), { recursive: true });
  await mkdir(join(runtimeHome, "artifacts"), { recursive: true });
  await mkdir(adminRoot);
  await mkdir(join(root, "exports"));

  const configuration: MainBackupConfiguration = {
    schemaVersion: 1,
    instanceId: "instance_backup_test",
    deviceId: "device_backup_test",
    main: {
      host: "127.0.0.1",
      port: 4380,
      origin: "http://127.0.0.1:4380",
    },
    database:
      adapter === "sqlite"
        ? { adapter: "sqlite" }
        : {
            adapter: "postgresql",
            uriRef: "secret://main/database-source",
            schema: "opendelegate",
          },
    secretBackend: {
      backend: "windows-dpapi",
      vaultRoot: join(runtimeHome, "secrets", "main"),
    },
    adminRoot,
  };
  const configurationFile = join(runtimeHome, "config", "main.json");
  await writeFile(configurationFile, `${JSON.stringify(configuration, null, 2)}\n`, {
    mode: 0o600,
  });
  const agentConfigurationFile = join(runtimeHome, "config", "agent.json");
  await writeFile(
    agentConfigurationFile,
    `${JSON.stringify({ schemaVersion: 1, provider: "codex" }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const sqliteFile = join(runtimeHome, "state", "main.sqlite3");
  if (adapter === "sqlite") {
    const sqlite = new Database(sqliteFile);
    try {
      sqlite.exec("CREATE TABLE durable_state (value TEXT NOT NULL)");
      sqlite.prepare("INSERT INTO durable_state (value) VALUES (?)").run("preserved");
    } finally {
      sqlite.close();
    }
  }
  await writeFile(join(runtimeHome, "logs", "runtime.log"), "must-not-copy\n");
  await writeFile(join(runtimeHome, "knowledge", "private.md"), "must-not-copy\n");
  await writeFile(join(runtimeHome, "artifacts", "report.html"), "must-not-copy\n");

  return {
    root,
    checkout,
    runtimeHome,
    adminRoot,
    configuration,
    source: {
      home: runtimeHome,
      configurationFile,
      agentConfigurationFile,
      sqliteFile,
      configuration,
      sourceCheckout: checkout,
    },
  };
}

class BackupSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-dpapi";
  public readonly deviceId: string;
  readonly #beforeExecute: (() => void | Promise<void>) | undefined;
  #value: Buffer | undefined;

  public constructor(deviceId: string, value?: string, beforeExecute?: () => void | Promise<void>) {
    this.deviceId = deviceId;
    this.#value = value === undefined ? undefined : Buffer.from(value, "utf8");
    this.#beforeExecute = beforeExecute;
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    return { backend: this.backend, deviceId: this.deviceId, status: "ready" };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: this.#value !== undefined };
  }

  public async store(_alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    this.#replaceValue(value);
    return { status: "stored" };
  }

  public async rotate(_alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    this.#replaceValue(value);
    return { status: "rotated" };
  }

  public async delete(): Promise<ManagedSecretDeletion> {
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
    await this.#beforeExecute?.();
    const copy = Buffer.from(this.#value);
    try {
      await executor(copy);
    } finally {
      copy.fill(0);
    }
  }

  #replaceValue(value: Uint8Array): void {
    this.#value?.fill(0);
    this.#value = Buffer.from(value);
  }
}

async function assertWindowsOwnerOnlyTree(root: string): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1")
$root = $env:OPENDELEGATE_TEST_PRIVATE_ROOT
$ownerSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$systemSid = "S-1-5-18"
$items = @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Force -Recurse)
foreach ($item in $items) {
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The private backup contains a reparse point."
  }
  $acl = Get-Acl -LiteralPath $item.FullName
  if ($item.FullName -eq $root -and -not $acl.AreAccessRulesProtected) {
    throw "The private backup still inherits access rules."
  }
  $observed = @{}
  foreach ($rule in @($acl.Access)) {
    $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if (($ruleSid -ne $ownerSid -and $ruleSid -ne $systemSid) -or
        $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
          [System.Security.AccessControl.FileSystemRights]::FullControl)) {
      throw "The private backup grants access outside its owner boundary."
    }
    $observed[$ruleSid] = $true
  }
  if (-not $observed.ContainsKey($ownerSid) -or -not $observed.ContainsKey($systemSid)) {
    throw "The private backup is missing an owner boundary entry."
  }
}
`;
  await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENDELEGATE_TEST_PRIVATE_ROOT: root,
      },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
}
