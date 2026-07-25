import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  BackupCliError,
  backupHelpText,
  parseBackupArguments,
  runBackupLifecycleCommand,
} from "../src/backup-cli.ts";
import type { MainBackupConfiguration, MainBackupSource } from "../src/backup.ts";

test("backup CLI parsing keeps create, verify, and restore intent exact", () => {
  assert.deepEqual(
    parseBackupArguments(["create", "--destination", "backup-main", "--home", "runtime-main"]),
    {
      command: "create",
      destination: resolve("backup-main"),
      home: resolve("runtime-main"),
    },
  );
  assert.deepEqual(parseBackupArguments(["verify", "--source", "backup-main"]), {
    command: "verify",
    source: resolve("backup-main"),
  });
  assert.deepEqual(
    parseBackupArguments([
      "restore",
      "--source",
      "backup-main",
      "--home",
      "restored-main",
      "--database-uri-ref",
      "secret://main/database-restore",
      "--database-uri-stdin",
      "--database-schema",
      "restored",
      "--secret-backend-config",
      "restore-secret-backend.json",
    ]),
    {
      command: "restore",
      source: resolve("backup-main"),
      home: resolve("restored-main"),
      databaseUriRef: "secret://main/database-restore",
      databaseUriStdin: true,
      databaseSchema: "restored",
      secretBackendConfigurationFile: resolve("restore-secret-backend.json"),
    },
  );
  assert.match(backupHelpText(), /never managed Secret Store values/u);
  assert.match(backupHelpText(), /bounded, non-interactive stdin/u);
});

test("backup CLI rejects ambiguous, repeated, and destructive-looking combinations", () => {
  for (const values of [
    ["create"],
    ["create", "--destination", "C:/one", "--destination", "C:/two"],
    ["create", "--destination", "C:/one", "--source", "C:/source"],
    ["verify", "--source", "C:/source", "--home", "C:/main"],
    ["restore", "--source", "C:/source"],
    ["restore", "--source", "C:/source", "--home", "C:/main", "--database-schema", "only"],
    ["restore", "--source", "C:/source", "--home", "C:/main", "--database-uri-stdin"],
    ["create", "--destination", "C:/one", "--database-uri-stdin"],
    ["verify", "--source", "C:/source", "--secret-backend-config", "backend.json"],
    ["restore", "--source", "C:/source", "--home", "C:/main", "--unknown", "value"],
  ]) {
    assert.throws(
      () => parseBackupArguments(values),
      (error: unknown) =>
        error instanceof BackupCliError && error.code === "BACKUP_ARGUMENT_INVALID",
    );
  }
});

test("backup CLI executes the verified fresh-home SQLite lifecycle", async (t) => {
  const fixture = await createCliFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const destination = join(fixture.root, "exports", "backup");
  const adapters = {
    sourceCheckout: fixture.checkout,
    loadSource: async (home?: string): Promise<MainBackupSource> => {
      assert.equal(home, fixture.runtimeHome);
      return fixture.source;
    },
  };

  const created = await runBackupLifecycleCommand(
    {
      command: "create",
      home: fixture.runtimeHome,
      destination,
    },
    adapters,
  );
  assert.equal(created.kind, "created");
  assert.equal(created.secretValuesIncluded, false);

  const verified = await runBackupLifecycleCommand(
    { command: "verify", source: destination },
    adapters,
  );
  assert.equal(verified.kind, "verified");

  const restoredHome = join(fixture.root, "restored");
  const restored = await runBackupLifecycleCommand(
    {
      command: "restore",
      source: destination,
      home: restoredHome,
      adminRoot: fixture.adminRoot,
    },
    adapters,
  );
  assert.deepEqual(restored, {
    kind: "restored",
    source: destination,
    home: restoredHome,
    instanceId: "instance_backup_cli",
    deviceId: "device_backup_cli",
    databaseAdapter: "sqlite",
    secretValuesIncluded: false,
  });
  await assert.rejects(
    runBackupLifecycleCommand({ command: "help" }, adapters),
    (error: unknown) =>
      error instanceof BackupCliError && error.code === "BACKUP_HELP_NOT_EXECUTABLE",
  );
});

async function createCliFixture(): Promise<{
  readonly root: string;
  readonly checkout: string;
  readonly runtimeHome: string;
  readonly adminRoot: string;
  readonly source: MainBackupSource;
}> {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-backup-cli-test-"));
  const checkout = join(root, "checkout");
  const runtimeHome = join(root, "runtime");
  const adminRoot = join(root, "admin");
  await mkdir(checkout);
  await mkdir(join(runtimeHome, "config"), { recursive: true });
  await mkdir(join(runtimeHome, "state"), { recursive: true });
  await mkdir(adminRoot);
  await mkdir(join(root, "exports"));
  const configuration: MainBackupConfiguration = {
    schemaVersion: 1,
    instanceId: "instance_backup_cli",
    deviceId: "device_backup_cli",
    main: {
      host: "127.0.0.1",
      port: 4380,
      origin: "http://127.0.0.1:4380",
    },
    database: { adapter: "sqlite" },
    secretBackend: {
      backend: "windows-dpapi",
      vaultRoot: join(runtimeHome, "secrets", "main"),
    },
    adminRoot,
  };
  const configurationFile = join(runtimeHome, "config", "main.json");
  await writeFile(configurationFile, `${JSON.stringify(configuration, null, 2)}\n`);
  const sqliteFile = join(runtimeHome, "state", "main.sqlite3");
  const sqlite = new Database(sqliteFile);
  try {
    sqlite.exec("CREATE TABLE metadata (value TEXT NOT NULL)");
  } finally {
    sqlite.close();
  }
  return {
    root,
    checkout,
    runtimeHome,
    adminRoot,
    source: {
      home: runtimeHome,
      configurationFile,
      sqliteFile,
      configuration,
      sourceCheckout: checkout,
    },
  };
}
