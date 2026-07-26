import { isAbsolute, join, resolve } from "node:path";

import type { MainDatabaseConfiguration } from "./index.ts";
import type { ManagedSecretStore } from "@opendelegate/secrets";
import { executeWithPostgresUri } from "./database-secret.ts";
import {
  createMainManagedSecretStore,
  type MainSecretBackendConfiguration,
} from "./main-secret-backend.ts";
import {
  createMainDeviceIdentitySecretStore,
  loadPersistedMainDeviceEnrollmentConfiguration,
  type MainDeviceEnrollmentConfiguration,
} from "./device-enrollment-configuration.ts";
import {
  issueDeviceEnrollmentGrantFile,
  type IssuedDeviceEnrollmentGrantFile,
} from "./device-enrollment-lifecycle.ts";
import type {
  MainDeviceChannelConfiguration,
  MainDeviceChannelDatabase,
} from "./device-channel-runtime.ts";

const DEFAULT_GRANT_TTL_SECONDS = 5 * 60;
const MINIMUM_GRANT_TTL_SECONDS = 30;
const MAXIMUM_GRANT_TTL_SECONDS = 30 * 60;
const MAXIMUM_BOOTSTRAP_ROLES = 32;

export type ParsedDeviceEnrollmentArguments =
  | {
      readonly command: "help";
    }
  | {
      readonly command: "grant";
      readonly home?: string;
      readonly deviceId: string;
      readonly outputPath: string;
      readonly expiresInMs: number;
      readonly allowedBootstrapRoles: readonly string[];
    };

export type DeviceEnrollmentCliErrorCode =
  "DEVICE_ARGUMENT_INVALID" | "DEVICE_CHANNEL_NOT_CONFIGURED" | "DATABASE_SECRET_UNAVAILABLE";

export class DeviceEnrollmentCliError extends Error {
  public readonly code: DeviceEnrollmentCliErrorCode;

  public constructor(code: DeviceEnrollmentCliErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeviceEnrollmentCliError";
    this.code = code;
  }
}

export function parseDeviceEnrollmentArguments(
  values: readonly string[],
): ParsedDeviceEnrollmentArguments {
  const command = values[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    if (values.length !== 1 && values.length !== 0) {
      throw argumentInvalid("Device help does not accept options.");
    }
    return { command: "help" };
  }
  if (command !== "grant") {
    throw argumentInvalid(`Unknown Device command: ${command}.`);
  }
  let home: string | undefined;
  let deviceId: string | undefined;
  let outputPath: string | undefined;
  let expiresInSeconds = DEFAULT_GRANT_TTL_SECONDS;
  const roles: string[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const option = values[index];
    if (
      option !== "--home" &&
      option !== "--device-id" &&
      option !== "--output" &&
      option !== "--expires-seconds" &&
      option !== "--role"
    ) {
      throw argumentInvalid(`Unknown Device option: ${String(option)}.`);
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") {
      throw argumentInvalid(`${option} requires a value.`);
    }
    switch (option) {
      case "--home":
        if (home !== undefined) {
          throw argumentInvalid("--home may be supplied only once.");
        }
        home = resolve(value);
        break;
      case "--device-id":
        if (deviceId !== undefined) {
          throw argumentInvalid("--device-id may be supplied only once.");
        }
        deviceId = requireIdentifier(value, "Device ID");
        break;
      case "--output":
        if (outputPath !== undefined) {
          throw argumentInvalid("--output may be supplied only once.");
        }
        if (!isAbsolute(value)) {
          throw argumentInvalid("--output must be an absolute path outside the source checkout.");
        }
        outputPath = resolve(value);
        break;
      case "--expires-seconds":
        if (!/^(?:0|[1-9][0-9]{0,3})$/u.test(value)) {
          throw invalidLifetime();
        }
        expiresInSeconds = Number(value);
        if (
          expiresInSeconds < MINIMUM_GRANT_TTL_SECONDS ||
          expiresInSeconds > MAXIMUM_GRANT_TTL_SECONDS
        ) {
          throw invalidLifetime();
        }
        break;
      case "--role":
        roles.push(requireIdentifier(value, "bootstrap Role"));
        break;
    }
    index += 1;
  }
  if (deviceId === undefined || outputPath === undefined) {
    throw argumentInvalid("Device grant requires --device-id and --output.");
  }
  const allowedBootstrapRoles = roles.length === 0 ? ["worker"] : roles;
  if (
    allowedBootstrapRoles.length > MAXIMUM_BOOTSTRAP_ROLES ||
    new Set(allowedBootstrapRoles).size !== allowedBootstrapRoles.length
  ) {
    throw argumentInvalid("Bootstrap Roles must be unique and bounded.");
  }
  return Object.freeze({
    command: "grant",
    ...(home === undefined ? {} : { home }),
    deviceId,
    outputPath,
    expiresInMs: expiresInSeconds * 1_000,
    allowedBootstrapRoles: Object.freeze([...allowedBootstrapRoles]),
  });
}

export interface MainDeviceEnrollmentCliSource {
  readonly configuration: {
    readonly instanceId: string;
    readonly deviceId: string;
    readonly database: MainDatabaseConfiguration;
    readonly secretBackend: MainSecretBackendConfiguration;
    readonly deviceChannel?: MainDeviceChannelConfiguration;
  };
  readonly configDirectory: string;
  readonly sqliteFile: string;
}

export async function runDeviceEnrollmentCommand(
  command: ParsedDeviceEnrollmentArguments,
  options: {
    readonly sourceCheckout: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    loadSource(home: string | undefined): Promise<MainDeviceEnrollmentCliSource>;
  },
): Promise<IssuedDeviceEnrollmentGrantFile | { readonly status: "help"; readonly text: string }> {
  if (command.command === "help") {
    return Object.freeze({ status: "help" as const, text: deviceEnrollmentHelpText() });
  }
  const source = await options.loadSource(command.home);
  if (source.configuration.deviceChannel === undefined) {
    throw new DeviceEnrollmentCliError(
      "DEVICE_CHANNEL_NOT_CONFIGURED",
      "Main has no Device enrollment channel. Re-run agent-first setup with a Device channel configuration.",
    );
  }
  const sourceCheckout = resolve(options.sourceCheckout);
  const composition = await loadPersistedMainDeviceEnrollmentConfiguration(
    mainDeviceEnrollmentConfigurationPath(source.configDirectory),
    { sourceCheckout },
  );
  assertCompositionMatchesMain(composition, source.configuration.deviceChannel);
  const identitySecrets = createMainDeviceIdentitySecretStore({
    configuration: composition,
    deviceId: source.configuration.deviceId,
    sourceCheckout,
    environment: options.environment ?? process.env,
  });
  const secretStore = createMainManagedSecretStore({
    configuration: source.configuration.secretBackend,
    deviceId: source.configuration.deviceId,
    sourceCheckout,
    environment: options.environment ?? process.env,
  });
  let result: IssuedDeviceEnrollmentGrantFile | undefined;
  await executeWithMainDeviceChannelDatabase(
    source.configuration.database,
    source.sqliteFile,
    secretStore,
    async (database) => {
      result = await issueDeviceEnrollmentGrantFile({
        configuration: source.configuration.deviceChannel!,
        database,
        identitySecrets,
        instanceId: source.configuration.instanceId,
        mainDeviceId: source.configuration.deviceId,
        deviceId: command.deviceId,
        allowedBootstrapRoles: command.allowedBootstrapRoles,
        expiresInMs: command.expiresInMs,
        outputPath: command.outputPath,
        sourceCheckout,
      });
    },
  );
  if (result === undefined) {
    throw new DeviceEnrollmentCliError(
      "DATABASE_SECRET_UNAVAILABLE",
      "The Device enrollment database could not be opened.",
    );
  }
  return result;
}

export function mainDeviceEnrollmentConfigurationPath(configDirectory: string): string {
  return join(resolve(configDirectory), "device-enrollment.json");
}

export function assertCompositionMatchesMain(
  composition: MainDeviceEnrollmentConfiguration,
  deviceChannel: MainDeviceChannelConfiguration,
): void {
  const persistedListeners = {
    enrollment: composition.enrollment,
    workerChannel: composition.workerChannel,
  };
  if (JSON.stringify(persistedListeners) !== JSON.stringify(deviceChannel)) {
    throw new DeviceEnrollmentCliError(
      "DEVICE_CHANNEL_NOT_CONFIGURED",
      "The persisted Device enrollment composition does not match Main configuration.",
    );
  }
}

export async function executeWithMainDeviceChannelDatabase(
  database: MainDatabaseConfiguration,
  sqliteFile: string,
  secretStore: ManagedSecretStore,
  executor: (database: MainDeviceChannelDatabase) => void | Promise<void>,
): Promise<void> {
  if (database.adapter === "sqlite") {
    await executor({ adapter: "sqlite", filename: resolve(sqliteFile) });
    return;
  }
  try {
    await executeWithPostgresUri(secretStore, database.uriRef, async (connectionString) => {
      await executor({
        adapter: "postgresql",
        connectionString,
        ...(database.schema === undefined ? {} : { schema: database.schema }),
      });
    });
  } catch (error) {
    throw new DeviceEnrollmentCliError(
      "DATABASE_SECRET_UNAVAILABLE",
      `The PostgreSQL Secret reference ${database.uriRef} is unavailable.`,
      { cause: error },
    );
  }
}

export function deviceEnrollmentHelpText(): string {
  return `OpenDelegate Device enrollment

Usage:
  opendelegate device grant --device-id DEVICE_ID --output ABSOLUTE_PATH
    [--home PATH] [--expires-seconds 30..1800] [--role ROLE ...]

The command writes one exclusive mode-0600 Enrollment Grant file outside the source
checkout. The single-use token is generated internally and is never accepted on the
command line or printed to stdout. The default lifetime is 300 seconds and the
default bootstrap Role is "worker".
`;
}

function requireIdentifier(value: string, label: string): string {
  if (value.length < 1 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw argumentInvalid(`The ${label} is invalid.`);
  }
  return value;
}

function invalidLifetime(): DeviceEnrollmentCliError {
  return argumentInvalid("--expires-seconds must be an integer from 30 through 1800.");
}

function argumentInvalid(message: string): DeviceEnrollmentCliError {
  return new DeviceEnrollmentCliError("DEVICE_ARGUMENT_INVALID", message);
}
