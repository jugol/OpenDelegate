import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants, type BigIntStats } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import type { ManagedSecretStore } from "@opendelegate/secrets";

import {
  type MainArtifactConfiguration,
  validateMainArtifactConfiguration,
} from "./artifact-runtime.ts";
import {
  type MainDeviceEnrollmentConfiguration,
  validateMainDeviceEnrollmentConfiguration,
} from "./device-enrollment-configuration.ts";
import type { MainDeviceChannelConfiguration } from "./device-channel-runtime.ts";
import {
  type MainDiscordConfiguration,
  validateMainDiscordConfiguration,
} from "./discord-configuration.ts";
import { readStableRegularFile } from "./stable-file.ts";
import {
  MainDatabaseSecretError,
  executeWithPostgresUri,
  mainSecretAlias,
  validateMainSecretReference,
  validatePostgresSecretMaterial,
} from "./database-secret.ts";
import {
  createMainManagedSecretStore,
  validateMainSecretBackendConfiguration,
  type MainSecretBackendConfiguration,
} from "./main-secret-backend.ts";

const execFileAsync = promisify(execFile);
const BACKUP_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CONFIGURATION_BYTES = 256 * 1024;
const MAX_AGENT_SELECTION_BYTES = 4 * 1024;
const MAX_DEVICE_ENROLLMENT_BYTES = 64 * 1024;
const BACKUP_EXCLUSIONS = Object.freeze([
  "managed-secret-values-and-private-keys",
  "device-knowledge",
  "generated-artifacts",
  "logs-and-diagnostics",
] as const);

export type MainBackupDatabaseConfiguration =
  | {
      readonly adapter: "sqlite";
    }
  | {
      readonly adapter: "postgresql";
      readonly uriRef: string;
      readonly schema?: string;
    };

export interface MainBackupConfiguration {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly main: {
    readonly host: string;
    readonly port: number;
    readonly origin: string;
    readonly tls?: {
      readonly certificatePath: string;
      readonly privateKeyPath: string;
    };
  };
  readonly database: MainBackupDatabaseConfiguration;
  readonly secretBackend: MainSecretBackendConfiguration;
  readonly adminRoot: string;
  readonly discord?: MainDiscordConfiguration;
  readonly artifacts?: MainArtifactConfiguration;
  readonly deviceChannel?: MainDeviceChannelConfiguration;
}

export interface MainBackupSource {
  readonly home: string;
  readonly configurationFile: string;
  readonly agentConfigurationFile?: string;
  readonly deviceEnrollmentConfigurationFile?: string;
  readonly sqliteFile: string;
  readonly configuration: MainBackupConfiguration;
  readonly sourceCheckout: string;
}

export interface BackupFileRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface AgentSelectionConfiguration {
  readonly schemaVersion: 1;
  readonly provider: "codex" | "claude" | "disabled";
}

export interface MainBackupManifest {
  readonly schemaVersion: 1;
  readonly product: "OpenDelegate";
  readonly kind: "main-metadata-backup";
  readonly createdAt: string;
  readonly source: {
    readonly instanceId: string;
    readonly deviceId: string;
    readonly databaseAdapter: "postgresql" | "sqlite";
  };
  readonly files: {
    readonly configuration: BackupFileRecord;
    readonly database: BackupFileRecord;
    readonly agentSelection?: BackupFileRecord;
    readonly deviceEnrollment?: BackupFileRecord;
  };
  readonly exclusions: readonly [
    "managed-secret-values-and-private-keys",
    "device-knowledge",
    "generated-artifacts",
    "logs-and-diagnostics",
  ];
}

export interface MainBackupToolRunner {
  dumpPostgres(input: {
    readonly destination: string;
    readonly connection: PostgresBackupToolConnection;
    readonly schema?: string;
  }): Promise<void>;
  verifyPostgresArchive(input: { readonly archive: string }): Promise<void>;
  assertPostgresTargetEmpty(input: {
    readonly connection: PostgresBackupToolConnection;
    readonly schema?: string;
  }): Promise<void>;
  restorePostgres(input: {
    readonly archive: string;
    readonly connection: PostgresBackupToolConnection;
    readonly schema?: string;
  }): Promise<void>;
}

export interface PostgresBackupToolConnection {
  readonly serviceFile: string;
  readonly serviceName: "opendelegate";
}

export interface CreateMainBackupOptions {
  readonly source: MainBackupSource;
  readonly destination: string;
  readonly managedSecretStore?: ManagedSecretStore;
  readonly now?: () => Date;
  readonly tools?: MainBackupToolRunner;
}

export interface VerifyMainBackupOptions {
  readonly backupDirectory: string;
  readonly sourceCheckout: string;
  readonly tools?: MainBackupToolRunner;
}

export interface RestoreMainBackupOptions {
  readonly backupDirectory: string;
  readonly targetHome: string;
  readonly sourceCheckout: string;
  readonly adminRoot?: string;
  readonly postgresTarget?: {
    readonly uriRef: string;
    readonly schema?: string;
  };
  readonly postgresSecret?: Uint8Array;
  readonly secretBackend?: MainSecretBackendConfiguration;
  readonly managedSecretStore?: ManagedSecretStore;
  readonly tools?: MainBackupToolRunner;
}

export type MainBackupErrorCode =
  | "BACKUP_CONFIGURATION_INVALID"
  | "BACKUP_CORRUPT"
  | "BACKUP_DESTINATION_EXISTS"
  | "BACKUP_PATH_UNSAFE"
  | "BACKUP_POSTGRES_SECRET_MISSING"
  | "BACKUP_SOURCE_INVALID"
  | "BACKUP_TOOL_FAILED"
  | "RESTORE_TARGET_EXISTS"
  | "RESTORE_TARGET_NOT_EMPTY";

export class MainBackupError extends Error {
  public readonly code: MainBackupErrorCode;

  public constructor(code: MainBackupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MainBackupError";
    this.code = code;
  }
}

export async function createMainBackup(
  options: CreateMainBackupOptions,
): Promise<MainBackupManifest> {
  const destination = await resolveAbsentSafeTarget(
    options.destination,
    options.source.sourceCheckout,
    options.source.home,
  );
  const parent = dirname(destination);
  const temporaryDirectory = join(
    parent,
    `.opendelegate-backup-${randomUUID().replaceAll("-", "")}`,
  );
  await assertPathAbsent(temporaryDirectory, "BACKUP_DESTINATION_EXISTS");

  const deviceEnrollment =
    options.source.deviceEnrollmentConfigurationFile === undefined
      ? undefined
      : await readOptionalDeviceEnrollment(
          options.source.deviceEnrollmentConfigurationFile,
          options.source.sourceCheckout,
        );
  const configuration = validateBackupConfiguration(options.source.configuration, deviceEnrollment);
  const expectedConfiguration = await readBoundedRegularFile(
    options.source.configurationFile,
    MAX_CONFIGURATION_BYTES,
    "BACKUP_SOURCE_INVALID",
  );
  let parsedConfiguration: unknown;
  try {
    parsedConfiguration = JSON.parse(expectedConfiguration.toString("utf8"));
  } catch {
    throw new MainBackupError(
      "BACKUP_SOURCE_INVALID",
      "The Main configuration file is not valid JSON.",
    );
  }
  if (
    canonicalJson(validateBackupConfiguration(parsedConfiguration, deviceEnrollment)) !==
    canonicalJson(configuration)
  ) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The loaded Main configuration does not match the configuration file.",
    );
  }
  const agentSelection =
    options.source.agentConfigurationFile === undefined
      ? undefined
      : await readOptionalAgentSelection(options.source.agentConfigurationFile);

  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    const configurationPath = join(temporaryDirectory, "main.json");
    const databasePath =
      configuration.database.adapter === "sqlite"
        ? join(temporaryDirectory, "main.sqlite3")
        : join(temporaryDirectory, "main.postgresql.dump");
    await writeFile(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const agentSelectionPath =
      agentSelection === undefined ? undefined : join(temporaryDirectory, "agent.json");
    if (agentSelectionPath !== undefined) {
      await writeFile(agentSelectionPath, `${JSON.stringify(agentSelection, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    const deviceEnrollmentPath =
      deviceEnrollment === undefined
        ? undefined
        : join(temporaryDirectory, "device-enrollment.json");
    if (deviceEnrollmentPath !== undefined) {
      await writeFile(deviceEnrollmentPath, `${JSON.stringify(deviceEnrollment, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }

    if (configuration.database.adapter === "sqlite") {
      await createSqliteSnapshot(options.source.sqliteFile, databasePath);
    } else {
      const postgresConfiguration = configuration.database;
      const secretStore =
        options.managedSecretStore ??
        createMainManagedSecretStore({
          configuration: configuration.secretBackend,
          deviceId: configuration.deviceId,
          sourceCheckout: options.source.sourceCheckout,
        });
      if (secretStore.deviceId !== configuration.deviceId) {
        throw new MainBackupError(
          "BACKUP_POSTGRES_SECRET_MISSING",
          "The configured Main Secret Store belongs to another Device.",
        );
      }
      const tools = options.tools ?? defaultMainBackupToolRunner;
      await executeBackupWithPostgresUri(secretStore, postgresConfiguration.uriRef, async (uri) => {
        await executeWithEphemeralPostgresService(temporaryDirectory, uri, async (connection) =>
          runInjectedBackupTool("dump", () =>
            tools.dumpPostgres({
              destination: databasePath,
              connection,
              ...(postgresConfiguration.schema === undefined
                ? {}
                : { schema: postgresConfiguration.schema }),
            }),
          ),
        );
      });
      await assertRegularFile(databasePath, "BACKUP_TOOL_FAILED");
      await runInjectedBackupTool("verify", () =>
        tools.verifyPostgresArchive({
          archive: databasePath,
        }),
      );
    }

    const manifest: MainBackupManifest = Object.freeze({
      schemaVersion: BACKUP_SCHEMA_VERSION,
      product: "OpenDelegate",
      kind: "main-metadata-backup",
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      source: Object.freeze({
        instanceId: configuration.instanceId,
        deviceId: configuration.deviceId,
        databaseAdapter: configuration.database.adapter,
      }),
      files: Object.freeze({
        configuration: await fileRecord(configurationPath, "main.json"),
        database: await fileRecord(databasePath, databasePath.slice(temporaryDirectory.length + 1)),
        ...(agentSelectionPath === undefined
          ? {}
          : { agentSelection: await fileRecord(agentSelectionPath, "agent.json") }),
        ...(deviceEnrollmentPath === undefined
          ? {}
          : {
              deviceEnrollment: await fileRecord(deviceEnrollmentPath, "device-enrollment.json"),
            }),
      }),
      exclusions: BACKUP_EXCLUSIONS,
    });
    await writeFile(
      join(temporaryDirectory, "backup-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    await rename(temporaryDirectory, destination);
    return manifest;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof MainBackupError) {
      throw error;
    }
    throw new MainBackupError(
      "BACKUP_TOOL_FAILED",
      "OpenDelegate could not create the Main metadata backup.",
      { cause: error },
    );
  }
}

export async function verifyMainBackup(
  options: VerifyMainBackupOptions,
): Promise<MainBackupManifest> {
  const backupDirectory = await resolveExistingSafeDirectory(
    options.backupDirectory,
    options.sourceCheckout,
  );
  const manifestPath = join(backupDirectory, "backup-manifest.json");
  const rawManifest = await readBoundedRegularFile(
    manifestPath,
    MAX_MANIFEST_BYTES,
    "BACKUP_CORRUPT",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest.toString("utf8"));
  } catch {
    throw new MainBackupError("BACKUP_CORRUPT", "The backup manifest is not valid JSON.");
  }
  const manifest = parseBackupManifest(parsed);
  await verifyFileRecord(backupDirectory, manifest.files.configuration);
  await verifyFileRecord(backupDirectory, manifest.files.database);
  if (manifest.files.agentSelection !== undefined) {
    await verifyFileRecord(backupDirectory, manifest.files.agentSelection);
    await readRequiredAgentSelection(
      join(backupDirectory, manifest.files.agentSelection.path),
      "BACKUP_CORRUPT",
    );
  }
  const deviceEnrollment =
    manifest.files.deviceEnrollment === undefined
      ? undefined
      : await readManifestDeviceEnrollment(
          backupDirectory,
          manifest.files.deviceEnrollment,
          options.sourceCheckout,
        );

  const configurationPath = join(backupDirectory, manifest.files.configuration.path);
  const configurationBytes = await readBoundedRegularFile(
    configurationPath,
    MAX_CONFIGURATION_BYTES,
    "BACKUP_CORRUPT",
  );
  let configuration: MainBackupConfiguration;
  try {
    configuration = validateBackupConfiguration(
      JSON.parse(configurationBytes.toString("utf8")),
      deviceEnrollment,
    );
  } catch (error) {
    if (error instanceof MainBackupError) {
      throw new MainBackupError("BACKUP_CORRUPT", "The backup configuration is invalid.", {
        cause: error,
      });
    }
    throw error;
  }
  if (
    configuration.instanceId !== manifest.source.instanceId ||
    configuration.deviceId !== manifest.source.deviceId ||
    configuration.database.adapter !== manifest.source.databaseAdapter
  ) {
    throw new MainBackupError(
      "BACKUP_CORRUPT",
      "The backup configuration does not match its manifest identity.",
    );
  }
  if (configuration.database.adapter === "sqlite") {
    await assertSqliteSnapshot(join(backupDirectory, manifest.files.database.path));
  } else {
    await runInjectedBackupTool("verify", () =>
      (options.tools ?? defaultMainBackupToolRunner).verifyPostgresArchive({
        archive: join(backupDirectory, manifest.files.database.path),
      }),
    );
  }
  return manifest;
}

export async function restoreMainBackup(
  options: RestoreMainBackupOptions,
): Promise<MainBackupConfiguration> {
  try {
    return await restoreMainBackupInternal(options);
  } finally {
    options.postgresSecret?.fill(0);
  }
}

async function restoreMainBackupInternal(
  options: RestoreMainBackupOptions,
): Promise<MainBackupConfiguration> {
  const targetHome = await resolveAbsentSafeTarget(options.targetHome, options.sourceCheckout);
  const manifest = await verifyMainBackup({
    backupDirectory: options.backupDirectory,
    sourceCheckout: options.sourceCheckout,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  const backupDirectory = resolve(options.backupDirectory);
  const configurationBytes = await readBoundedRegularFile(
    join(backupDirectory, manifest.files.configuration.path),
    MAX_CONFIGURATION_BYTES,
    "BACKUP_CORRUPT",
  );
  const deviceEnrollment =
    manifest.files.deviceEnrollment === undefined
      ? undefined
      : await readManifestDeviceEnrollment(
          backupDirectory,
          manifest.files.deviceEnrollment,
          options.sourceCheckout,
        );
  const original = validateBackupConfiguration(
    JSON.parse(configurationBytes.toString("utf8")),
    deviceEnrollment,
  );
  if (
    original.database.adapter === "sqlite" &&
    (options.postgresTarget !== undefined || options.postgresSecret !== undefined)
  ) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "A SQLite backup does not accept PostgreSQL restore options.",
    );
  }
  if (
    original.database.adapter === "postgresql" &&
    options.postgresTarget?.schema !== undefined &&
    options.postgresTarget.schema !== original.database.schema
  ) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "PostgreSQL restore cannot remap the archived schema.",
    );
  }
  const restoredConfiguration: MainBackupConfiguration =
    original.database.adapter === "sqlite"
      ? {
          ...original,
          secretBackend: options.secretBackend ?? original.secretBackend,
          ...(options.adminRoot === undefined ? {} : { adminRoot: resolve(options.adminRoot) }),
        }
      : {
          ...original,
          secretBackend: options.secretBackend ?? original.secretBackend,
          database: {
            adapter: "postgresql",
            uriRef: options.postgresTarget?.uriRef ?? original.database.uriRef,
            ...(options.postgresTarget?.schema === undefined
              ? original.database.schema === undefined
                ? {}
                : { schema: original.database.schema }
              : { schema: options.postgresTarget.schema }),
          },
          ...(options.adminRoot === undefined ? {} : { adminRoot: resolve(options.adminRoot) }),
        };
  validateBackupConfiguration(restoredConfiguration, deviceEnrollment);

  const parent = dirname(targetHome);
  const temporaryHome = join(parent, `.opendelegate-restore-${randomUUID().replaceAll("-", "")}`);
  await assertPathAbsent(temporaryHome, "RESTORE_TARGET_EXISTS");
  await mkdir(join(temporaryHome, "config"), { recursive: true, mode: 0o700 });
  await mkdir(join(temporaryHome, "state"), { recursive: true, mode: 0o700 });
  await mkdir(join(temporaryHome, "logs"), { recursive: true, mode: 0o700 });

  try {
    if (original.database.adapter === "sqlite") {
      const archive = join(backupDirectory, manifest.files.database.path);
      const restoredDatabase = join(temporaryHome, "state", "main.sqlite3");
      await copyFile(archive, restoredDatabase, 1);
      await assertSqliteSnapshot(restoredDatabase);
    } else {
      const restoredDatabase = restoredConfiguration.database;
      if (restoredDatabase.adapter !== "postgresql") {
        throw new MainBackupError(
          "BACKUP_CONFIGURATION_INVALID",
          "The PostgreSQL backup resolved to a non-PostgreSQL target.",
        );
      }
      const secretStore =
        options.managedSecretStore ??
        createMainManagedSecretStore({
          configuration: restoredConfiguration.secretBackend,
          deviceId: restoredConfiguration.deviceId,
          sourceCheckout: options.sourceCheckout,
        });
      if (secretStore.deviceId !== restoredConfiguration.deviceId) {
        throw new MainBackupError(
          "BACKUP_POSTGRES_SECRET_MISSING",
          "The configured Main Secret Store belongs to another Device.",
        );
      }
      await provisionPostgresSecret(
        secretStore,
        restoredConfiguration.deviceId,
        restoredDatabase.uriRef,
        options.postgresSecret,
      );
      const tools = options.tools ?? defaultMainBackupToolRunner;
      await executeBackupWithPostgresUri(secretStore, restoredDatabase.uriRef, async (uri) => {
        await executeWithEphemeralPostgresService(
          join(temporaryHome, "state"),
          uri,
          async (connection) => {
            await runInjectedBackupTool("preflight", () =>
              tools.assertPostgresTargetEmpty({
                connection,
                ...(restoredDatabase.schema === undefined
                  ? {}
                  : { schema: restoredDatabase.schema }),
              }),
            );
            await runInjectedBackupTool("restore", () =>
              tools.restorePostgres({
                archive: join(backupDirectory, manifest.files.database.path),
                connection,
                ...(restoredDatabase.schema === undefined
                  ? {}
                  : { schema: restoredDatabase.schema }),
              }),
            );
          },
        );
      });
    }
    await writeFile(
      join(temporaryHome, "config", "main.json"),
      `${JSON.stringify(restoredConfiguration, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    if (manifest.files.agentSelection !== undefined) {
      const agentSelection = await readRequiredAgentSelection(
        join(backupDirectory, manifest.files.agentSelection.path),
        "BACKUP_CORRUPT",
      );
      await writeFile(
        join(temporaryHome, "config", "agent.json"),
        `${JSON.stringify(agentSelection, null, 2)}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
    }
    if (deviceEnrollment !== undefined) {
      await writeFile(
        join(temporaryHome, "config", "device-enrollment.json"),
        `${JSON.stringify(deviceEnrollment, null, 2)}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
    }
    await rename(temporaryHome, targetHome);
    return Object.freeze(restoredConfiguration);
  } catch (error) {
    await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof MainBackupError) {
      throw error;
    }
    throw new MainBackupError(
      "BACKUP_TOOL_FAILED",
      "OpenDelegate could not restore the Main metadata backup.",
      { cause: error },
    );
  }
}

const defaultMainBackupTools: MainBackupToolRunner = {
  async dumpPostgres(input) {
    await runPostgresTool(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        `--file=${input.destination}`,
        ...(input.schema === undefined ? [] : [`--schema=${input.schema}`]),
      ],
      input.connection,
    );
  },
  async verifyPostgresArchive(input) {
    await runPostgresTool("pg_restore", ["--list", input.archive]);
  },
  async assertPostgresTargetEmpty(input) {
    await assertPostgresTargetEmpty(input);
  },
  async restorePostgres(input) {
    await runPostgresTool(
      "pg_restore",
      [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        `--dbname=service=${input.connection.serviceName}`,
        ...(input.schema === undefined ? [] : [`--schema=${input.schema}`]),
        input.archive,
      ],
      input.connection,
    );
  },
};

export const defaultMainBackupToolRunner: MainBackupToolRunner =
  Object.freeze(defaultMainBackupTools);

async function createSqliteSnapshot(source: string, destination: string): Promise<void> {
  await assertRegularFile(source, "BACKUP_SOURCE_INVALID");
  let database: Database.Database | undefined;
  try {
    database = new Database(source, {
      fileMustExist: true,
      readonly: true,
    });
    const integrity = database.pragma("quick_check", { simple: true });
    if (integrity !== "ok") {
      throw new MainBackupError(
        "BACKUP_SOURCE_INVALID",
        "The source SQLite database failed its integrity check.",
      );
    }
    await database.backup(destination);
  } catch (error) {
    if (error instanceof MainBackupError) {
      throw error;
    }
    throw new MainBackupError(
      "BACKUP_SOURCE_INVALID",
      "The source SQLite database could not be backed up.",
      { cause: error },
    );
  } finally {
    database?.close();
  }
  await assertSqliteSnapshot(destination);
}

async function assertSqliteSnapshot(filename: string): Promise<void> {
  let database: Database.Database | undefined;
  try {
    database = new Database(filename, { fileMustExist: true, readonly: true });
    const integrity = database.pragma("quick_check", { simple: true });
    if (integrity !== "ok") {
      throw new MainBackupError("BACKUP_CORRUPT", "The SQLite backup failed integrity checking.");
    }
  } catch (error) {
    if (error instanceof MainBackupError) {
      throw error;
    }
    throw new MainBackupError("BACKUP_CORRUPT", "The SQLite backup is not a readable database.", {
      cause: error,
    });
  } finally {
    database?.close();
  }
}

async function runPostgresTool(
  executable: "pg_dump" | "pg_restore" | "psql",
  arguments_: readonly string[],
  connection?: PostgresBackupToolConnection,
): Promise<string> {
  try {
    const result = await execFileAsync(executable, [...arguments_], {
      env: postgresToolEnvironment(connection),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    throw new MainBackupError(
      "BACKUP_TOOL_FAILED",
      `${executable} could not complete the requested metadata operation.`,
    );
  }
}

async function runInjectedBackupTool(
  operation: "dump" | "preflight" | "restore" | "verify",
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    if (error instanceof MainBackupError) {
      throw error;
    }
    throw new MainBackupError(
      operation === "verify" ? "BACKUP_CORRUPT" : "BACKUP_TOOL_FAILED",
      operation === "verify"
        ? "The PostgreSQL backup is not a valid custom archive."
        : `The PostgreSQL ${operation} operation failed.`,
    );
  }
}

export function postgresToolEnvironment(
  connection?: PostgresBackupToolConnection,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  if (connection !== undefined) {
    environment.PGSERVICEFILE = connection.serviceFile;
    environment.PGSERVICE = connection.serviceName;
  }
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "HOME"]) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

async function assertPostgresTargetEmpty(input: {
  readonly connection: PostgresBackupToolConnection;
  readonly schema?: string;
}): Promise<void> {
  const query =
    input.schema === undefined
      ? `
          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname <> 'information_schema'
              AND namespace.nspname NOT LIKE 'pg_%'
            UNION ALL
            SELECT 1
            FROM pg_catalog.pg_proc AS routine
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = routine.pronamespace
            WHERE namespace.nspname <> 'information_schema'
              AND namespace.nspname NOT LIKE 'pg_%'
            UNION ALL
            SELECT 1
            FROM pg_catalog.pg_namespace AS namespace
            WHERE namespace.nspname <> 'public'
              AND namespace.nspname <> 'information_schema'
              AND namespace.nspname NOT LIKE 'pg_%'
          ) THEN 'occupied' ELSE 'empty' END;
        `
      : `
          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM pg_catalog.pg_namespace
            WHERE nspname = '${input.schema.replaceAll("'", "''")}'
          ) THEN 'occupied' ELSE 'empty' END;
        `;
  try {
    const stdout = await runPostgresTool(
      "psql",
      ["--no-psqlrc", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", `--command=${query}`],
      input.connection,
    );
    const result = stdout.trim();
    if (result !== "empty" && result !== "occupied") {
      throw new Error("PostgreSQL returned invalid restore preflight metadata.");
    }
    if (result === "occupied") {
      throw new MainBackupError(
        "RESTORE_TARGET_NOT_EMPTY",
        input.schema === undefined
          ? "The PostgreSQL restore database contains user-defined objects."
          : "The PostgreSQL restore schema already exists.",
      );
    }
  } catch (error) {
    if (error instanceof MainBackupError) {
      throw error;
    }
    throw new MainBackupError(
      "BACKUP_TOOL_FAILED",
      "OpenDelegate could not verify that the PostgreSQL restore target is empty.",
    );
  }
}

async function executeWithEphemeralPostgresService(
  ownerOnlyRoot: string,
  uri: string,
  executor: (connection: PostgresBackupToolConnection) => void | Promise<void>,
): Promise<void> {
  const root = resolve(ownerOnlyRoot);
  if (process.platform === "win32") {
    await enforceWindowsOwnerOnlyDirectory(root);
  }
  const rootMetadata = await lstat(root).catch(() => undefined);
  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (
    rootMetadata === undefined ||
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    canonicalRoot === undefined ||
    !samePath(canonicalRoot, root) ||
    (process.platform !== "win32" && (rootMetadata.mode & 0o077) !== 0)
  ) {
    throw new MainBackupError(
      "BACKUP_PATH_UNSAFE",
      "The PostgreSQL credential-file directory is not owner-only.",
    );
  }
  const path = join(root, `.postgres-service-${randomUUID().replaceAll("-", "")}.conf`);
  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    handle = await open(
      path,
      fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY | noFollow,
      0o600,
    );
    created = true;
    const service = Buffer.from(`[opendelegate]\ndbname='${escapeServiceValue(uri)}'\n`, "utf8");
    try {
      await handle.writeFile(service);
      await handle.sync();
    } finally {
      service.fill(0);
    }
    const opened = await handle.stat();
    const named = await lstat(path);
    const currentRoot = await lstat(root);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      opened.ino !== named.ino ||
      (opened.dev !== 0 && named.dev !== 0 && opened.dev !== named.dev) ||
      currentRoot.ino !== rootMetadata.ino ||
      (currentRoot.dev !== 0 && rootMetadata.dev !== 0 && currentRoot.dev !== rootMetadata.dev) ||
      (process.platform !== "win32" && (opened.mode & 0o077) !== 0)
    ) {
      throw new MainBackupError(
        "BACKUP_PATH_UNSAFE",
        "The PostgreSQL credential file failed its owner-only identity check.",
      );
    }
    await executor(Object.freeze({ serviceFile: path, serviceName: "opendelegate" as const }));
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const closeFailed = await handle?.close().then(
    () => false,
    () => true,
  );
  let unlinkFailed = false;
  if (created) {
    try {
      await unlink(path);
    } catch (error) {
      unlinkFailed = !isNodeError(error) || error.code !== "ENOENT";
    }
  }
  if (closeFailed === true || unlinkFailed) {
    throw new MainBackupError(
      "BACKUP_PATH_UNSAFE",
      "OpenDelegate could not securely remove the ephemeral PostgreSQL credential file.",
    );
  }
  if (operationFailed) {
    throw operationError;
  }
}

async function enforceWindowsOwnerOnlyDirectory(root: string): Promise<void> {
  let sid: string | undefined;
  try {
    const identity = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
      env: nativeToolEnvironment(),
    });
    sid = identity.stdout.match(/S-\d(?:-\d+)+/u)?.[0];
    if (sid === undefined) {
      throw new Error("identity unavailable");
    }
    for (const arguments_ of [
      [root, "/inheritance:r", "/L", "/Q"],
      [root, "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/L", "/Q"],
    ]) {
      await execFileAsync("icacls.exe", arguments_, {
        encoding: "utf8",
        windowsHide: true,
        env: nativeToolEnvironment(),
      });
    }
    const script = String.raw`
$ErrorActionPreference = "Stop"
$path = $env:OPENDELEGATE_PRIVATE_PATH
$ownerSid = $env:OPENDELEGATE_PRIVATE_SID
$systemSid = "S-1-5-18"
$acl = Get-Acl -LiteralPath $path
if (-not $acl.AreAccessRulesProtected) { throw "ACL inheritance remains enabled." }
foreach ($rule in @($acl.Access)) {
  $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if (($ruleSid -ne $ownerSid -and $ruleSid -ne $systemSid) -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
    throw "Unexpected ACL entry."
  }
}
`;
    await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...nativeToolEnvironment(),
          OPENDELEGATE_PRIVATE_PATH: root,
          OPENDELEGATE_PRIVATE_SID: sid,
        },
      },
    );
  } catch {
    throw new MainBackupError(
      "BACKUP_PATH_UNSAFE",
      "OpenDelegate could not enforce an owner-only PostgreSQL credential directory.",
    );
  }
}

function nativeToolEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

async function executeBackupWithPostgresUri(
  store: ManagedSecretStore,
  reference: string,
  executor: (uri: string) => void | Promise<void>,
): Promise<void> {
  try {
    await executeWithPostgresUri(store, reference, executor);
  } catch (error) {
    if (error instanceof MainDatabaseSecretError && error.cause instanceof MainBackupError) {
      throw error.cause;
    }
    throw new MainBackupError(
      "BACKUP_POSTGRES_SECRET_MISSING",
      `The PostgreSQL Secret reference ${reference} is unavailable or invalid.`,
    );
  }
}

async function provisionPostgresSecret(
  store: ManagedSecretStore,
  deviceId: string,
  reference: string,
  secret: Uint8Array | undefined,
): Promise<void> {
  if (secret === undefined) {
    return;
  }
  let material: Buffer | undefined;
  try {
    if (store.deviceId !== deviceId) {
      throw new MainDatabaseSecretError(
        "The configured Main Secret Store belongs to another Device.",
      );
    }
    validatePostgresSecretMaterial(secret);
    const alias = mainSecretAlias(reference);
    material = Buffer.from(secret);
    const availability = await store.availability(alias);
    if (availability.alias !== alias) {
      throw new MainDatabaseSecretError(
        "The managed Secret Store returned an invalid PostgreSQL alias.",
      );
    }
    if (availability.ready) {
      await store.rotate(alias, material);
    } else {
      await store.store(alias, material);
    }
  } catch {
    throw new MainBackupError(
      "BACKUP_POSTGRES_SECRET_MISSING",
      `The PostgreSQL Secret reference ${reference} could not be provisioned.`,
    );
  } finally {
    material?.fill(0);
    secret.fill(0);
  }
}

function escapeServiceValue(value: string): string {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new MainBackupError(
      "BACKUP_POSTGRES_SECRET_MISSING",
      "The PostgreSQL Secret is invalid.",
    );
  }
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function validateBackupConfiguration(
  input: unknown,
  deviceEnrollment?: MainDeviceEnrollmentConfiguration,
): MainBackupConfiguration {
  if (isRecord(input)) {
    const database = input["database"];
    if (
      isRecord(database) &&
      database["adapter"] === "postgresql" &&
      "uriEnvironment" in database
    ) {
      throw new MainBackupError(
        "BACKUP_CONFIGURATION_INVALID",
        "This backup uses the retired PostgreSQL uriEnvironment field. Migrate Main to a canonical database.uriRef before creating or restoring backups.",
      );
    }
  }
  if (
    !isRecord(input) ||
    !hasAllowedKeys(input, [
      "schemaVersion",
      "instanceId",
      "deviceId",
      "main",
      "database",
      "secretBackend",
      "adminRoot",
      "discord",
      "artifacts",
      "deviceChannel",
    ]) ||
    !hasRequiredKeys(input, [
      "schemaVersion",
      "instanceId",
      "deviceId",
      "main",
      "database",
      "secretBackend",
      "adminRoot",
    ])
  ) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Main backup configuration is invalid.",
    );
  }
  assertIdentifier(input["instanceId"]);
  assertIdentifier(input["deviceId"]);
  if (input["schemaVersion"] !== 1 || !isAbsolutePathString(input["adminRoot"])) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Main backup configuration is invalid.",
    );
  }
  const main = input["main"];
  if (
    !isRecord(main) ||
    !hasAllowedKeys(main, ["host", "port", "origin", "tls"]) ||
    typeof main["host"] !== "string" ||
    main["host"].trim() === "" ||
    !Number.isSafeInteger(main["port"]) ||
    (main["port"] as number) < 1 ||
    (main["port"] as number) > 65_535 ||
    typeof main["origin"] !== "string"
  ) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Main listener backup configuration is invalid.",
    );
  }
  let origin: URL;
  try {
    origin = new URL(main["origin"]);
  } catch {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Main listener origin is invalid.",
    );
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Main listener origin is invalid.",
    );
  }
  const tls = parseTlsConfiguration(main["tls"]);
  const database = parseDatabaseConfiguration(input["database"]);
  const secretBackend = validateBackupSubconfiguration(
    () => validateMainSecretBackendConfiguration(input["secretBackend"]),
    "Secret backend",
  );
  const discord =
    input["discord"] === undefined
      ? undefined
      : validateBackupSubconfiguration(
          () => validateMainDiscordConfiguration(input["discord"]),
          "Discord",
        );
  const artifacts =
    input["artifacts"] === undefined
      ? undefined
      : validateBackupSubconfiguration(
          () => validateMainArtifactConfiguration(input["artifacts"]),
          "Artifact",
        );
  const deviceChannel =
    input["deviceChannel"] === undefined
      ? undefined
      : validateBackedDeviceChannel(input["deviceChannel"], deviceEnrollment);
  if (deviceEnrollment !== undefined && deviceChannel === undefined) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Device enrollment backup configuration is not enabled by Main.",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    instanceId: input["instanceId"],
    deviceId: input["deviceId"],
    main: Object.freeze({
      host: main["host"],
      port: main["port"] as number,
      origin: main["origin"],
      ...(tls === undefined ? {} : { tls }),
    }),
    database,
    secretBackend,
    adminRoot: resolve(input["adminRoot"]),
    ...(discord === undefined ? {} : { discord }),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(deviceChannel === undefined ? {} : { deviceChannel }),
  });
}

function validateBackupSubconfiguration<T>(operation: () => T, label: string): T {
  try {
    return operation();
  } catch (error) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      `The Main ${label} backup configuration is invalid.`,
      { cause: error },
    );
  }
}

function validateBackedDeviceChannel(
  input: unknown,
  deviceEnrollment: MainDeviceEnrollmentConfiguration | undefined,
): MainDeviceChannelConfiguration {
  if (deviceEnrollment === undefined) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Main Device channel requires its secret-free enrollment composition.",
    );
  }
  const expected: MainDeviceChannelConfiguration = Object.freeze({
    enrollment: deviceEnrollment.enrollment,
    workerChannel: deviceEnrollment.workerChannel,
  });
  if (canonicalJson(input) !== canonicalJson(expected)) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Main Device channel does not match its enrollment composition.",
    );
  }
  return expected;
}

function parseTlsConfiguration(input: unknown): MainBackupConfiguration["main"]["tls"] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["certificatePath", "privateKeyPath"]) ||
    !isAbsolutePathString(input["certificatePath"]) ||
    !isAbsolutePathString(input["privateKeyPath"])
  ) {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Main TLS backup configuration is invalid.",
    );
  }
  return Object.freeze({
    certificatePath: resolve(input["certificatePath"]),
    privateKeyPath: resolve(input["privateKeyPath"]),
  });
}

function parseDatabaseConfiguration(input: unknown): MainBackupDatabaseConfiguration {
  if (!isRecord(input) || typeof input["adapter"] !== "string") {
    throw new MainBackupError(
      "BACKUP_CONFIGURATION_INVALID",
      "The Main database backup configuration is invalid.",
    );
  }
  if (input["adapter"] === "sqlite" && hasExactKeys(input, ["adapter"])) {
    return Object.freeze({ adapter: "sqlite" });
  }
  if (
    input["adapter"] === "postgresql" &&
    hasAllowedKeys(input, ["adapter", "uriRef", "schema"]) &&
    typeof input["uriRef"] === "string" &&
    (input["schema"] === undefined ||
      (typeof input["schema"] === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(input["schema"])))
  ) {
    return Object.freeze({
      adapter: "postgresql",
      uriRef: validateMainSecretReference(input["uriRef"]),
      ...(input["schema"] === undefined ? {} : { schema: input["schema"] as string }),
    });
  }
  throw new MainBackupError(
    "BACKUP_CONFIGURATION_INVALID",
    "The Main database backup configuration is invalid.",
  );
}

function parseBackupManifest(input: unknown): MainBackupManifest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "product",
      "kind",
      "createdAt",
      "source",
      "files",
      "exclusions",
    ]) ||
    input["schemaVersion"] !== 1 ||
    input["product"] !== "OpenDelegate" ||
    input["kind"] !== "main-metadata-backup" ||
    typeof input["createdAt"] !== "string" ||
    Number.isNaN(Date.parse(input["createdAt"]))
  ) {
    throw new MainBackupError("BACKUP_CORRUPT", "The backup manifest is invalid.");
  }
  const source = input["source"];
  const files = input["files"];
  const exclusions = input["exclusions"];
  if (
    !isRecord(source) ||
    !hasExactKeys(source, ["instanceId", "deviceId", "databaseAdapter"]) ||
    !isIdentifier(source["instanceId"]) ||
    !isIdentifier(source["deviceId"]) ||
    (source["databaseAdapter"] !== "sqlite" && source["databaseAdapter"] !== "postgresql") ||
    !isRecord(files) ||
    !hasAllowedKeys(files, ["configuration", "database", "agentSelection", "deviceEnrollment"]) ||
    !hasRequiredKeys(files, ["configuration", "database"]) ||
    !Array.isArray(exclusions) ||
    canonicalJson(exclusions) !==
      canonicalJson([
        "managed-secret-values-and-private-keys",
        "device-knowledge",
        "generated-artifacts",
        "logs-and-diagnostics",
      ])
  ) {
    throw new MainBackupError("BACKUP_CORRUPT", "The backup manifest is invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    product: "OpenDelegate",
    kind: "main-metadata-backup",
    createdAt: input["createdAt"],
    source: Object.freeze({
      instanceId: source["instanceId"],
      deviceId: source["deviceId"],
      databaseAdapter: source["databaseAdapter"],
    }),
    files: Object.freeze({
      configuration: parseFileRecord(files["configuration"]),
      database: parseFileRecord(files["database"]),
      ...(files["agentSelection"] === undefined
        ? {}
        : { agentSelection: parseFileRecord(files["agentSelection"]) }),
      ...(files["deviceEnrollment"] === undefined
        ? {}
        : { deviceEnrollment: parseFileRecord(files["deviceEnrollment"]) }),
    }),
    exclusions: BACKUP_EXCLUSIONS,
  });
}

function parseFileRecord(input: unknown): BackupFileRecord {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["path", "bytes", "sha256"]) ||
    typeof input["path"] !== "string" ||
    input["path"] === "" ||
    isAbsolute(input["path"]) ||
    input["path"].includes("/") ||
    input["path"].includes("\\") ||
    input["path"] === "." ||
    input["path"] === ".." ||
    !Number.isSafeInteger(input["bytes"]) ||
    (input["bytes"] as number) < 0 ||
    typeof input["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input["sha256"])
  ) {
    throw new MainBackupError("BACKUP_CORRUPT", "The backup file manifest is invalid.");
  }
  return Object.freeze({
    path: input["path"],
    bytes: input["bytes"] as number,
    sha256: input["sha256"],
  });
}

async function verifyFileRecord(directory: string, record: BackupFileRecord): Promise<void> {
  const filename = join(directory, record.path);
  await assertRegularFile(filename, "BACKUP_CORRUPT");
  const actual = await fileRecord(filename, record.path);
  if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) {
    throw new MainBackupError(
      "BACKUP_CORRUPT",
      `Backup file ${record.path} does not match its manifest.`,
    );
  }
}

async function fileRecord(filename: string, path: string): Promise<BackupFileRecord> {
  const hashed = await hashStableRegularFile(filename);
  return Object.freeze({
    path,
    bytes: hashed.bytes,
    sha256: hashed.sha256,
  });
}

async function hashStableRegularFile(
  filename: string,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fileConstants.O_NONBLOCK ?? 0;
  const handle = await open(filename, fileConstants.O_RDONLY | noFollow | nonBlocking).catch(
    (error: unknown) => {
      throw new MainBackupError(
        "BACKUP_CORRUPT",
        "A Main backup path could not be opened safely.",
        { cause: error },
      );
    },
  );
  try {
    const openedStat = await handle.stat({ bigint: true });
    const pathStat = await lstat(filename, { bigint: true });
    if (
      !openedStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !sameBackupFile(openedStat, pathStat) ||
      openedStat.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new MainBackupError(
        "BACKUP_CORRUPT",
        "A Main backup file changed while it was opened.",
      );
    }
    const sha256 = createHash("sha256");
    let bytes = 0n;
    const stream = handle.createReadStream({
      autoClose: false,
      start: 0,
    });
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += BigInt(buffer.byteLength);
      sha256.update(buffer);
    }
    const finalStat = await handle.stat({ bigint: true });
    const finalPathStat = await lstat(filename, { bigint: true });
    if (
      finalPathStat.isSymbolicLink() ||
      !finalPathStat.isFile() ||
      !sameBackupSnapshot(openedStat, finalStat) ||
      !sameBackupSnapshot(finalStat, finalPathStat) ||
      bytes !== finalStat.size
    ) {
      throw new MainBackupError(
        "BACKUP_CORRUPT",
        "A Main backup file changed while it was hashed.",
      );
    }
    return {
      bytes: Number(finalStat.size),
      sha256: sha256.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function sameBackupFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino === right.ino &&
    (left.dev === right.dev ||
      (process.platform === "win32" &&
        (left.dev === 0n || right.dev === 0n) &&
        left.birthtimeNs === right.birthtimeNs))
  );
}

function sameBackupSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameBackupFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedRegularFile(
  filename: string,
  maximumBytes: number,
  code: MainBackupErrorCode,
): Promise<Buffer> {
  try {
    return await readStableRegularFile(filename, maximumBytes);
  } catch (error) {
    throw new MainBackupError(code, "A Main backup metadata file is invalid or unstable.", {
      cause: error,
    });
  }
}

async function readOptionalAgentSelection(
  filename: string,
): Promise<AgentSelectionConfiguration | undefined> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw new MainBackupError(
      "BACKUP_SOURCE_INVALID",
      "The Main Agent selection could not be inspected safely.",
      { cause: error },
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new MainBackupError(
      "BACKUP_SOURCE_INVALID",
      "The Main Agent selection must be a regular file.",
    );
  }
  return readRequiredAgentSelection(filename, "BACKUP_SOURCE_INVALID");
}

async function readRequiredAgentSelection(
  filename: string,
  code: Extract<MainBackupErrorCode, "BACKUP_CORRUPT" | "BACKUP_SOURCE_INVALID">,
): Promise<AgentSelectionConfiguration> {
  let value: unknown;
  try {
    value = JSON.parse(
      (await readBoundedRegularFile(filename, MAX_AGENT_SELECTION_BYTES, code)).toString("utf8"),
    );
  } catch (error) {
    if (error instanceof MainBackupError) {
      throw error;
    }
    throw new MainBackupError(code, "The Main Agent selection is not valid JSON.", {
      cause: error,
    });
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "provider"]) ||
    value["schemaVersion"] !== 1 ||
    (value["provider"] !== "codex" &&
      value["provider"] !== "claude" &&
      value["provider"] !== "disabled")
  ) {
    throw new MainBackupError(code, "The Main Agent selection is invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    provider: value["provider"],
  });
}

async function readOptionalDeviceEnrollment(
  filename: string,
  sourceCheckout: string,
): Promise<MainDeviceEnrollmentConfiguration | undefined> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw new MainBackupError(
      "BACKUP_SOURCE_INVALID",
      "The Main Device enrollment composition could not be inspected safely.",
      { cause: error },
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new MainBackupError(
      "BACKUP_SOURCE_INVALID",
      "The Main Device enrollment composition must be a regular file.",
    );
  }
  return readRequiredDeviceEnrollment(filename, sourceCheckout, "BACKUP_SOURCE_INVALID");
}

async function readManifestDeviceEnrollment(
  backupDirectory: string,
  record: BackupFileRecord,
  sourceCheckout: string,
): Promise<MainDeviceEnrollmentConfiguration> {
  await verifyFileRecord(backupDirectory, record);
  return readRequiredDeviceEnrollment(
    join(backupDirectory, record.path),
    sourceCheckout,
    "BACKUP_CORRUPT",
  );
}

async function readRequiredDeviceEnrollment(
  filename: string,
  sourceCheckout: string,
  code: Extract<MainBackupErrorCode, "BACKUP_CORRUPT" | "BACKUP_SOURCE_INVALID">,
): Promise<MainDeviceEnrollmentConfiguration> {
  const bytes = await readBoundedRegularFile(filename, MAX_DEVICE_ENROLLMENT_BYTES, code);
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new MainBackupError(code, "The Main Device enrollment composition is not valid JSON.", {
        cause: error,
      });
    }
    try {
      return validateMainDeviceEnrollmentConfiguration(parsed, { sourceCheckout });
    } catch (error) {
      throw new MainBackupError(code, "The Main Device enrollment composition is invalid.", {
        cause: error,
      });
    }
  } finally {
    bytes.fill(0);
  }
}

async function assertRegularFile(filename: string, code: MainBackupErrorCode): Promise<void> {
  let fileStat;
  try {
    fileStat = await lstat(filename);
  } catch (error) {
    throw new MainBackupError(code, "A required Main backup file is missing.", { cause: error });
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new MainBackupError(code, "A Main backup path is not a regular file.");
  }
}

async function assertExistingDirectory(directory: string): Promise<string> {
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    throw new MainBackupError("BACKUP_PATH_UNSAFE", "The backup parent directory does not exist.", {
      cause: error,
    });
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new MainBackupError(
      "BACKUP_PATH_UNSAFE",
      "The backup parent must be a real local directory.",
    );
  }
  return realpath(directory);
}

async function assertPathAbsent(
  filename: string,
  code: Extract<MainBackupErrorCode, "BACKUP_DESTINATION_EXISTS" | "RESTORE_TARGET_EXISTS">,
): Promise<void> {
  try {
    await lstat(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw new MainBackupError("BACKUP_PATH_UNSAFE", "The target path could not be inspected.", {
      cause: error,
    });
  }
  throw new MainBackupError(code, "The target path already exists.");
}

function assertAbsoluteSafePath(
  value: string,
  sourceCheckout: string,
  runtimeHome?: string,
): string {
  if (!isAbsolute(value)) {
    throw new MainBackupError("BACKUP_PATH_UNSAFE", "The backup path must be absolute.");
  }
  const target = resolve(value);
  const source = resolve(sourceCheckout);
  if (
    target === source ||
    isWithin(source, target) ||
    (runtimeHome !== undefined &&
      (target === resolve(runtimeHome) || isWithin(resolve(runtimeHome), target)))
  ) {
    throw new MainBackupError(
      "BACKUP_PATH_UNSAFE",
      "Backup and restore paths must stay outside source and runtime state.",
    );
  }
  return target;
}

async function resolveAbsentSafeTarget(
  value: string,
  sourceCheckout: string,
  runtimeHome?: string,
): Promise<string> {
  const lexicalTarget = assertAbsoluteSafePath(value, sourceCheckout, runtimeHome);
  const name = basename(lexicalTarget);
  if (name === "" || name === "." || name === "..") {
    throw new MainBackupError("BACKUP_PATH_UNSAFE", "The backup target name is invalid.");
  }
  const canonicalParent = await assertExistingDirectory(dirname(lexicalTarget));
  const canonicalTarget = join(canonicalParent, name);
  const canonicalSource = await realpath(sourceCheckout);
  const canonicalHome = runtimeHome === undefined ? undefined : await realpath(runtimeHome);
  assertAbsoluteSafePath(canonicalTarget, canonicalSource, canonicalHome);
  await assertPathAbsent(
    canonicalTarget,
    runtimeHome === undefined ? "RESTORE_TARGET_EXISTS" : "BACKUP_DESTINATION_EXISTS",
  );
  return canonicalTarget;
}

async function resolveExistingSafeDirectory(
  value: string,
  sourceCheckout: string,
): Promise<string> {
  const lexicalDirectory = assertAbsoluteSafePath(value, sourceCheckout);
  const canonicalDirectory = await assertExistingDirectory(lexicalDirectory);
  const canonicalSource = await realpath(sourceCheckout);
  assertAbsoluteSafePath(canonicalDirectory, canonicalSource);
  return canonicalDirectory;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function assertIdentifier(value: unknown): asserts value is string {
  if (!isIdentifier(value)) {
    throw new MainBackupError("BACKUP_CONFIGURATION_INVALID", "A Main backup identity is invalid.");
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function isAbsolutePathString(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
