import { isAbsolute, resolve } from "node:path";

import {
  redactDiscordSecrets,
  type DiscordForumAdapterConfig,
} from "@opendelegate/discord-adapter";
import type { ConfigurationDefinition } from "@opendelegate/configuration";
import {
  SystemdCredentialKeyProvider,
  createPlatformManagedSecretStore,
  type ManagedSecretStore,
  type PlatformManagedSecretStoreConfig,
} from "@opendelegate/secrets";

import { readStableRegularFile } from "./stable-file.ts";

const DISCORD_CONFIGURATION_SCHEMA_VERSION = 1;
const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;
const WORKFLOW_STATUSES = ["done", "failed", "intake", "review", "running", "waiting"] as const;

export const MAIN_DISCORD_BINDING_CONFIGURATION_KEY = "discord.binding";

export type MainDiscordSecretBackendConfiguration =
  | {
      readonly backend: "windows-dpapi";
      readonly vaultRoot: string;
    }
  | {
      readonly backend: "macos-keychain";
      readonly helperPath: string;
      readonly expectedHelperSha256: string;
    }
  | {
      readonly backend: "linux-secret-service";
      readonly secretToolPath: string;
    }
  | {
      readonly backend: "linux-systemd-credential-vault";
      readonly credentialName: string;
      readonly vaultRoot: string;
    };

/**
 * Non-secret, owner-selected Discord binding. The bot credential is represented
 * only by an alias into the Main Device's managed Secret Store.
 */
export interface MainDiscordConfiguration {
  readonly schemaVersion: typeof DISCORD_CONFIGURATION_SCHEMA_VERSION;
  readonly enabled: true;
  readonly botTokenAlias: string;
  readonly forum: DiscordForumAdapterConfig;
  readonly secretBackend: MainDiscordSecretBackendConfiguration;
}

/**
 * Durable, runtime-changeable Discord binding. The platform Secret backend is
 * owned by Main itself, so replacing a Forum binding needs only the opaque
 * credential alias and Discord identifiers.
 */
export interface MainDiscordBindingConfiguration {
  readonly schemaVersion: typeof DISCORD_CONFIGURATION_SCHEMA_VERSION;
  readonly enabled: true;
  readonly botTokenAlias: string;
  readonly forum: DiscordForumAdapterConfig;
}

export interface MainDiscordComposition {
  readonly config: DiscordForumAdapterConfig;
  readonly botTokenAlias: string;
  readonly secretStore: ManagedSecretStore;
}

export const MAIN_DISCORD_BINDING_CONFIGURATION_DEFINITION = Object.freeze({
  key: MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
  defaultValue: null,
  scopes: ["main"] as const,
  validate: isMainDiscordBindingConfiguration,
}) satisfies ConfigurationDefinition;

export class MainDiscordConfigurationError extends Error {
  public readonly code = "CONFIG_INVALID";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MainDiscordConfigurationError";
  }
}

export async function loadMainDiscordConfigurationSource(
  path: string,
): Promise<MainDiscordConfiguration> {
  if (!isAbsolute(path)) {
    throw configurationInvalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      (await readStableRegularFile(path, MAXIMUM_CONFIGURATION_BYTES)).toString("utf8"),
    );
  } catch (error) {
    throw configurationInvalid(error);
  }
  return validateMainDiscordConfiguration(parsed);
}

export function validateMainDiscordConfiguration(input: unknown): MainDiscordConfiguration {
  const record = requireRecord(input);
  assertExactKeys(record, ["schemaVersion", "enabled", "botTokenAlias", "forum", "secretBackend"]);
  const binding = validateMainDiscordBindingFields(record);
  const secretBackend = validateSecretBackend(record["secretBackend"]);
  return Object.freeze({
    ...binding,
    secretBackend,
  });
}

export function validateMainDiscordBindingConfiguration(
  input: unknown,
): MainDiscordBindingConfiguration {
  const record = requireRecord(input);
  assertExactKeys(record, ["schemaVersion", "enabled", "botTokenAlias", "forum"]);
  return validateMainDiscordBindingFields(record);
}

export function isMainDiscordBindingConfiguration(
  input: unknown,
): input is MainDiscordBindingConfiguration | null {
  if (input === null) {
    return true;
  }
  try {
    validateMainDiscordBindingConfiguration(input);
    return true;
  } catch {
    return false;
  }
}

export function toMainDiscordBindingConfiguration(
  configuration: MainDiscordConfiguration,
): MainDiscordBindingConfiguration {
  const validated = validateMainDiscordConfiguration(configuration);
  return Object.freeze({
    schemaVersion: validated.schemaVersion,
    enabled: validated.enabled,
    botTokenAlias: validated.botTokenAlias,
    forum: validated.forum,
  });
}

export function createMainDiscordComposition(input: {
  readonly configuration: MainDiscordConfiguration;
  readonly deviceId: string;
  readonly sourceCheckout: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): MainDiscordComposition {
  const configuration = validateMainDiscordConfiguration(input.configuration);
  const secretStore = createPlatformManagedSecretStore(
    secretStoreConfiguration({
      backend: configuration.secretBackend,
      deviceId: input.deviceId,
      sourceCheckout: input.sourceCheckout,
      environment: input.environment ?? process.env,
    }),
  );
  return Object.freeze({
    config: configuration.forum,
    botTokenAlias: configuration.botTokenAlias,
    secretStore,
  });
}

/**
 * Provisions credential bytes received through a bounded local-only ingress.
 * Callers must zero their input after this operation; only the alias survives.
 */
export async function provisionMainDiscordBotCredential(input: {
  readonly composition: MainDiscordComposition;
  readonly secret: Uint8Array;
}): Promise<void> {
  if (!(input.secret instanceof Uint8Array)) {
    throw new MainDiscordConfigurationError("The Discord bot credential is invalid.");
  }
  const material = Buffer.from(input.secret);
  if (
    material.byteLength < 1 ||
    material.byteLength > 4_096 ||
    material.some((byte) => byte < 0x21 || byte > 0x7e)
  ) {
    material.fill(0);
    input.secret.fill(0);
    throw new MainDiscordConfigurationError("The Discord bot credential is invalid.");
  }
  try {
    const availability = await input.composition.secretStore.availability(
      input.composition.botTokenAlias,
    );
    if (availability.alias !== input.composition.botTokenAlias) {
      throw new MainDiscordConfigurationError(
        "The managed Secret Store returned an invalid Discord bot alias.",
      );
    }
    if (availability.ready) {
      await input.composition.secretStore.rotate(input.composition.botTokenAlias, material);
    } else {
      await input.composition.secretStore.store(input.composition.botTokenAlias, material);
    }
  } finally {
    material.fill(0);
    input.secret.fill(0);
  }
}

function secretStoreConfiguration(input: {
  readonly backend: MainDiscordSecretBackendConfiguration;
  readonly deviceId: string;
  readonly sourceCheckout: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): PlatformManagedSecretStoreConfig {
  switch (input.backend.backend) {
    case "windows-dpapi":
      return {
        backend: "windows-dpapi",
        deviceId: input.deviceId,
        sourceCheckoutRoot: input.sourceCheckout,
        vaultRoot: input.backend.vaultRoot,
      };
    case "macos-keychain":
      return {
        backend: "macos-keychain",
        deviceId: input.deviceId,
        helperPath: input.backend.helperPath,
        expectedHelperSha256: input.backend.expectedHelperSha256,
      };
    case "linux-secret-service":
      return {
        backend: "linux-secret-service",
        deviceId: input.deviceId,
        secretToolPath: input.backend.secretToolPath,
      };
    case "linux-systemd-credential-vault": {
      const credentialDirectory = input.environment["CREDENTIALS_DIRECTORY"];
      if (credentialDirectory === undefined || credentialDirectory.trim().length === 0) {
        throw new MainDiscordConfigurationError(
          "The configured systemd credential directory is unavailable.",
        );
      }
      return {
        backend: "linux-systemd-credential-vault",
        deviceId: input.deviceId,
        sourceCheckoutRoot: input.sourceCheckout,
        vaultRoot: input.backend.vaultRoot,
        keyProvider: new SystemdCredentialKeyProvider({
          credentialDirectory,
          credentialName: input.backend.credentialName,
          sourceCheckoutRoot: input.sourceCheckout,
        }),
      };
    }
  }
}

function validateMainDiscordBindingFields(
  record: Readonly<Record<string, unknown>>,
): MainDiscordBindingConfiguration {
  if (
    record["schemaVersion"] !== DISCORD_CONFIGURATION_SCHEMA_VERSION ||
    record["enabled"] !== true
  ) {
    throw configurationInvalid();
  }
  return Object.freeze({
    schemaVersion: DISCORD_CONFIGURATION_SCHEMA_VERSION,
    enabled: true,
    botTokenAlias: requireIdentifier(record["botTokenAlias"], "Discord bot token alias"),
    forum: validateForumConfiguration(record["forum"]),
  });
}

function validateForumConfiguration(input: unknown): DiscordForumAdapterConfig {
  const record = requireRecord(input);
  assertExactKeys(record, [
    "applicationId",
    "botUserId",
    "guildId",
    "forumBindings",
    "ownerUserIds",
    "allowedRoleIds",
  ]);
  const forumBindings = requireArray(record["forumBindings"]).map((value) => {
    const binding = requireRecord(value);
    assertExactKeys(binding, ["channelId", "workflowTagIds"]);
    const tags = requireRecord(binding["workflowTagIds"]);
    assertExactKeys(tags, WORKFLOW_STATUSES);
    const workflowTagIds = Object.freeze({
      done: requireSnowflake(tags["done"]),
      failed: requireSnowflake(tags["failed"]),
      intake: requireSnowflake(tags["intake"]),
      review: requireSnowflake(tags["review"]),
      running: requireSnowflake(tags["running"]),
      waiting: requireSnowflake(tags["waiting"]),
    });
    if (new Set(Object.values(workflowTagIds)).size !== WORKFLOW_STATUSES.length) {
      throw configurationInvalid();
    }
    return Object.freeze({
      channelId: requireSnowflake(binding["channelId"]),
      workflowTagIds,
    });
  });
  const ownerUserIds = requireSnowflakeList(record["ownerUserIds"], false);
  const allowedRoleIds = requireSnowflakeList(record["allowedRoleIds"], true);
  if (
    forumBindings.length < 1 ||
    forumBindings.length > 100 ||
    new Set(forumBindings.map((binding) => binding.channelId)).size !== forumBindings.length
  ) {
    throw configurationInvalid();
  }
  return Object.freeze({
    applicationId: requireSnowflake(record["applicationId"]),
    botUserId: requireSnowflake(record["botUserId"]),
    guildId: requireSnowflake(record["guildId"]),
    forumBindings: Object.freeze(forumBindings),
    ownerUserIds,
    allowedRoleIds,
  });
}

function validateSecretBackend(input: unknown): MainDiscordSecretBackendConfiguration {
  const record = requireRecord(input);
  switch (record["backend"]) {
    case "windows-dpapi":
      assertExactKeys(record, ["backend", "vaultRoot"]);
      return Object.freeze({
        backend: "windows-dpapi",
        vaultRoot: requireAbsolutePath(record["vaultRoot"]),
      });
    case "macos-keychain":
      assertExactKeys(record, ["backend", "helperPath", "expectedHelperSha256"]);
      if (
        typeof record["expectedHelperSha256"] !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(record["expectedHelperSha256"])
      ) {
        throw configurationInvalid();
      }
      return Object.freeze({
        backend: "macos-keychain",
        helperPath: requireAbsolutePath(record["helperPath"]),
        expectedHelperSha256: record["expectedHelperSha256"],
      });
    case "linux-secret-service":
      assertExactKeys(record, ["backend", "secretToolPath"]);
      return Object.freeze({
        backend: "linux-secret-service",
        secretToolPath: requireAbsolutePath(record["secretToolPath"]),
      });
    case "linux-systemd-credential-vault":
      assertExactKeys(record, ["backend", "credentialName", "vaultRoot"]);
      return Object.freeze({
        backend: "linux-systemd-credential-vault",
        credentialName: requireIdentifier(record["credentialName"], "credential name"),
        vaultRoot: requireAbsolutePath(record["vaultRoot"]),
      });
    default:
      throw configurationInvalid();
  }
}

function requireSnowflakeList(input: unknown, allowEmpty: boolean): readonly string[] {
  const values = requireArray(input).map(requireSnowflake);
  if (
    (!allowEmpty && values.length === 0) ||
    values.length > 100 ||
    new Set(values).size !== values.length
  ) {
    throw configurationInvalid();
  }
  return Object.freeze(values);
}

function requireSnowflake(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9]{17,20}$/u.test(input)) {
    throw configurationInvalid();
  }
  return input;
}

function requireAbsolutePath(input: unknown): string {
  if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0")) {
    throw configurationInvalid();
  }
  return resolve(input);
}

function requireIdentifier(input: unknown, label: string): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input)
  ) {
    throw new MainDiscordConfigurationError(`The ${label} is invalid.`);
  }
  if (redactDiscordSecrets(input) !== input) {
    throw new MainDiscordConfigurationError(`The ${label} must be an alias, not a credential.`);
  }
  return input;
}

function requireArray(input: unknown): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw configurationInvalid();
  }
  return input;
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw configurationInvalid();
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  input: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  if (Object.keys(input).sort().join(",") !== [...expected].sort().join(",")) {
    throw configurationInvalid();
  }
}

function configurationInvalid(cause?: unknown): MainDiscordConfigurationError {
  return new MainDiscordConfigurationError(
    "The Discord binding configuration is invalid and no credential value may appear in it.",
    cause === undefined ? undefined : { cause },
  );
}
