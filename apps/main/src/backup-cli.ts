import { resolve } from "node:path";
import type { ManagedSecretStore } from "@opendelegate/secrets";
import { validateMainSecretReference } from "./database-secret.ts";

import {
  createMainBackup,
  restoreMainBackup,
  verifyMainBackup,
  type MainBackupConfiguration,
  type MainBackupManifest,
  type MainBackupSource,
  type MainBackupToolRunner,
} from "./backup.ts";
import type { MainSecretBackendConfiguration } from "./main-secret-backend.ts";

export type BackupLifecycleCommand = "create" | "help" | "restore" | "verify";

export interface ParsedBackupArguments {
  readonly command: BackupLifecycleCommand;
  readonly home?: string;
  readonly source?: string;
  readonly destination?: string;
  readonly adminRoot?: string;
  readonly databaseUriRef?: string;
  readonly databaseUriStdin?: true;
  readonly databaseSchema?: string;
  readonly secretBackendConfigurationFile?: string;
}

export interface BackupLifecycleAdapters {
  readonly sourceCheckout: string;
  loadSource(home?: string): Promise<MainBackupSource>;
  readonly managedSecretStore?: ManagedSecretStore;
  readonly postgresSecret?: Uint8Array;
  readonly restoreSecretBackend?: MainSecretBackendConfiguration;
  readonly tools?: MainBackupToolRunner;
}

export type BackupLifecycleResult =
  | {
      readonly kind: "created";
      readonly destination: string;
      readonly manifest: MainBackupManifest;
      readonly secretValuesIncluded: false;
    }
  | {
      readonly kind: "verified";
      readonly source: string;
      readonly manifest: MainBackupManifest;
      readonly secretValuesIncluded: false;
    }
  | {
      readonly kind: "restored";
      readonly source: string;
      readonly home: string;
      readonly instanceId: string;
      readonly deviceId: string;
      readonly databaseAdapter: MainBackupConfiguration["database"]["adapter"];
      readonly secretValuesIncluded: false;
    };

export type BackupCliErrorCode = "BACKUP_ARGUMENT_INVALID" | "BACKUP_HELP_NOT_EXECUTABLE";

export class BackupCliError extends Error {
  public readonly code: BackupCliErrorCode;

  public constructor(code: BackupCliErrorCode, message: string) {
    super(message);
    this.name = "BackupCliError";
    this.code = code;
  }
}

export function parseBackupArguments(values: readonly string[]): ParsedBackupArguments {
  const commandValue = values[0] ?? "help";
  if (commandValue === "help" || commandValue === "--help" || commandValue === "-h") {
    if (values.length > 1) {
      throw argumentError("Backup help does not accept options.");
    }
    return { command: "help" };
  }
  if (commandValue !== "create" && commandValue !== "verify" && commandValue !== "restore") {
    throw argumentError(`Unknown backup command: ${commandValue}.`);
  }

  const options = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--home",
    "--source",
    "--destination",
    "--admin-root",
    "--database-uri-ref",
    "--database-schema",
    "--secret-backend-config",
  ]);
  const flagOptions = new Set(["--database-uri-stdin"]);
  for (let index = 1; index < values.length; index += 1) {
    const option = values[index];
    if (option === "--database-uri-environment") {
      throw argumentError(
        "--database-uri-environment was retired because process environments are not a Secret transport. Use --database-uri-ref.",
      );
    }
    if (option === undefined || (!valueOptions.has(option) && !flagOptions.has(option))) {
      throw argumentError(`Unknown backup option: ${String(option)}.`);
    }
    if (options.has(option) || flags.has(option)) {
      throw argumentError(`${option} cannot be repeated.`);
    }
    if (flagOptions.has(option)) {
      flags.add(option);
      continue;
    }
    const target = values[index + 1];
    if (target === undefined || target.startsWith("--") || target.trim() === "") {
      throw argumentError(`${option} requires a value.`);
    }
    options.set(option, target);
    index += 1;
  }

  const home = optionalPath(options.get("--home"));
  const source = optionalPath(options.get("--source"));
  const destination = optionalPath(options.get("--destination"));
  const adminRoot = optionalPath(options.get("--admin-root"));
  const databaseUriRef = options.get("--database-uri-ref");
  const databaseUriStdin = flags.has("--database-uri-stdin");
  const databaseSchema = options.get("--database-schema");
  const secretBackendConfigurationFile = optionalPath(options.get("--secret-backend-config"));
  if (databaseUriRef !== undefined) {
    try {
      validateMainSecretReference(databaseUriRef);
    } catch {
      throw argumentError("--database-uri-ref must be a canonical secret://main/ALIAS reference.");
    }
  }
  if (databaseSchema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(databaseSchema)) {
    throw argumentError("--database-schema is invalid.");
  }

  if (commandValue === "create") {
    if (
      destination === undefined ||
      source !== undefined ||
      adminRoot !== undefined ||
      databaseUriRef !== undefined ||
      databaseUriStdin ||
      databaseSchema !== undefined ||
      secretBackendConfigurationFile !== undefined
    ) {
      throw argumentError("backup create requires --destination and accepts only optional --home.");
    }
    return {
      command: "create",
      destination,
      ...(home === undefined ? {} : { home }),
    };
  }
  if (commandValue === "verify") {
    if (
      source === undefined ||
      home !== undefined ||
      destination !== undefined ||
      adminRoot !== undefined ||
      databaseUriRef !== undefined ||
      databaseUriStdin ||
      databaseSchema !== undefined ||
      secretBackendConfigurationFile !== undefined
    ) {
      throw argumentError("backup verify accepts exactly --source.");
    }
    return { command: "verify", source };
  }
  if (
    source === undefined ||
    home === undefined ||
    destination !== undefined ||
    (databaseSchema !== undefined && databaseUriRef === undefined) ||
    (databaseUriStdin && databaseUriRef === undefined)
  ) {
    throw argumentError(
      "backup restore requires --source and --home; PostgreSQL stdin or a database schema requires a PostgreSQL Secret reference.",
    );
  }
  return {
    command: "restore",
    source,
    home,
    ...(adminRoot === undefined ? {} : { adminRoot }),
    ...(databaseUriRef === undefined ? {} : { databaseUriRef }),
    ...(databaseUriStdin ? { databaseUriStdin: true as const } : {}),
    ...(databaseSchema === undefined ? {} : { databaseSchema }),
    ...(secretBackendConfigurationFile === undefined ? {} : { secretBackendConfigurationFile }),
  };
}

export async function runBackupLifecycleCommand(
  options: ParsedBackupArguments,
  adapters: BackupLifecycleAdapters,
): Promise<BackupLifecycleResult> {
  if (options.command === "help") {
    throw new BackupCliError(
      "BACKUP_HELP_NOT_EXECUTABLE",
      "Backup help is rendered directly and cannot be executed.",
    );
  }
  if (options.command === "create") {
    if (options.destination === undefined) {
      throw argumentError("The backup destination is missing.");
    }
    const source = await adapters.loadSource(options.home);
    const manifest = await createMainBackup({
      source,
      destination: options.destination,
      ...(adapters.managedSecretStore === undefined
        ? {}
        : { managedSecretStore: adapters.managedSecretStore }),
      ...(adapters.tools === undefined ? {} : { tools: adapters.tools }),
    });
    return {
      kind: "created",
      destination: options.destination,
      manifest,
      secretValuesIncluded: false,
    };
  }
  if (options.command === "verify") {
    if (options.source === undefined) {
      throw argumentError("The backup source is missing.");
    }
    const manifest = await verifyMainBackup({
      backupDirectory: options.source,
      sourceCheckout: adapters.sourceCheckout,
      ...(adapters.tools === undefined ? {} : { tools: adapters.tools }),
    });
    return {
      kind: "verified",
      source: options.source,
      manifest,
      secretValuesIncluded: false,
    };
  }
  if (options.source === undefined || options.home === undefined) {
    throw argumentError("The backup restore source or target home is missing.");
  }
  if (options.databaseUriStdin === true && adapters.postgresSecret === undefined) {
    throw argumentError("The bounded PostgreSQL credential input is missing.");
  }
  if (
    options.secretBackendConfigurationFile !== undefined &&
    adapters.restoreSecretBackend === undefined
  ) {
    throw argumentError("The persisted Main Secret backend configuration is missing.");
  }
  const configuration = await restoreMainBackup({
    backupDirectory: options.source,
    targetHome: options.home,
    sourceCheckout: adapters.sourceCheckout,
    ...(options.adminRoot === undefined ? {} : { adminRoot: options.adminRoot }),
    ...(options.databaseUriRef === undefined
      ? {}
      : {
          postgresTarget: {
            uriRef: options.databaseUriRef,
            ...(options.databaseSchema === undefined ? {} : { schema: options.databaseSchema }),
          },
        }),
    ...(adapters.postgresSecret === undefined ? {} : { postgresSecret: adapters.postgresSecret }),
    ...(adapters.restoreSecretBackend === undefined
      ? {}
      : { secretBackend: adapters.restoreSecretBackend }),
    ...(adapters.managedSecretStore === undefined
      ? {}
      : { managedSecretStore: adapters.managedSecretStore }),
    ...(adapters.tools === undefined ? {} : { tools: adapters.tools }),
  });
  return {
    kind: "restored",
    source: options.source,
    home: options.home,
    instanceId: configuration.instanceId,
    deviceId: configuration.deviceId,
    databaseAdapter: configuration.database.adapter,
    secretValuesIncluded: false,
  };
}

export function backupHelpText(): string {
  return `OpenDelegate Main metadata backup

Usage:
  opendelegate backup create --destination ABSOLUTE_PATH [--home PATH]
  opendelegate backup verify --source ABSOLUTE_PATH
  opendelegate backup restore --source ABSOLUTE_PATH --home NEW_ABSOLUTE_PATH
    [--admin-root PATH]
    [--secret-backend-config ABSOLUTE_JSON_PATH]
    [--database-uri-ref secret://main/ALIAS
      [--database-uri-stdin] [--database-schema NAME]]

Backups contain Main metadata and checksums, never managed Secret Store values,
Worker Knowledge, Artifact bytes, or logs. Create and restore paths must stay outside the source
checkout and live runtime home. Restore always requires a new absent target home. PostgreSQL
credentials may be pre-provisioned or read once from bounded, non-interactive stdin.
`;
}

function optionalPath(value: string | undefined): string | undefined {
  return value === undefined ? undefined : resolve(value);
}

function argumentError(message: string): BackupCliError {
  return new BackupCliError("BACKUP_ARGUMENT_INVALID", message);
}
