#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalClaimApp } from "@opendelegate/control-plane";
import { OwnerAuthError } from "@opendelegate/owner-auth";
import {
  PlatformServiceError,
  ServiceCommandExecutionError,
} from "@opendelegate/platform-services";

import {
  createMainManagedSecretStore,
  createMainRuntime,
  createMainServiceReadyMessage,
  initializeMainHome,
  inspectPersistedMainConfiguration,
  listenMainRuntime,
  loadMainArtifactConfigurationSource,
  loadMainDiscordConfigurationSource,
  loadMainConfiguration,
  loadMainSecretBackendConfigurationSource,
  MainDiscordConfigurationError,
  MainRuntimeError,
  MainSecretBackendConfigurationError,
  provisionMainDiscordBotCredential,
  resolveRuntimePaths,
  validateMainSecretReference,
  type MainDatabaseConfiguration,
  type MainListenerConfiguration,
  type MainRuntime,
  type MainSecretBackendConfiguration,
} from "./index.ts";
import {
  MainAgentRuntimeError,
  probeMainAgentAdapters,
  resolveMainAgentComposition,
  type MainAgentProviderPreference,
} from "./agent-runtime.ts";
import {
  BackupCliError,
  backupHelpText,
  parseBackupArguments,
  runBackupLifecycleCommand,
  type ParsedBackupArguments,
} from "./backup-cli.ts";
import { MainBackupError } from "./backup.ts";
import {
  ReleaseIdentityError,
  resolveRuntimeIdentity,
  type RuntimeIdentity,
} from "./release-identity.ts";
import {
  cleanupFailureFor,
  closeAfterPrimaryFailure,
  closeMainResources,
  MainShutdownError,
} from "./shutdown.ts";
import {
  createDefaultServiceLifecycleAdapters,
  parseServiceLifecycleArguments,
  runServiceLifecycleCommand,
  serviceLifecycleHelpText,
  ServiceLifecycleCliError,
  type ParsedServiceLifecycleArguments,
} from "./service-lifecycle.ts";
import {
  resolveEffectiveMainServiceConfiguration,
  resolveMainServiceHomeBinding,
} from "./main-service-configuration.ts";
import {
  assertCompositionMatchesMain,
  DeviceEnrollmentCliError,
  executeWithMainDeviceChannelDatabase,
  mainDeviceEnrollmentConfigurationPath,
  parseDeviceEnrollmentArguments,
  runDeviceEnrollmentCommand,
  type ParsedDeviceEnrollmentArguments,
} from "./device-enrollment-cli.ts";
import {
  createMainDeviceIdentitySecretStore,
  loadMainDeviceEnrollmentConfigurationSource,
  loadPersistedMainDeviceEnrollmentConfiguration,
  MainDeviceEnrollmentConfigurationError,
  persistMainDeviceEnrollmentConfiguration,
} from "./device-enrollment-configuration.ts";
import {
  MainDeviceEnrollmentLifecycleError,
  provisionMainDeviceListenerTls,
} from "./device-enrollment-lifecycle.ts";

const cliPath = fileURLToPath(import.meta.url);
const cliDirectory = dirname(cliPath);
const bundledRelease = extname(cliPath) !== ".ts";
const installationRoot = bundledRelease
  ? resolve(cliDirectory, "../..")
  : resolve(cliDirectory, "../../..");
const defaultAdminRoot = bundledRelease
  ? resolve(installationRoot, "apps/admin-web/dist")
  : resolve(cliDirectory, "../../admin-web/dist");

export async function runCli(arguments_: readonly string[]): Promise<void> {
  const parsed = parseArguments(arguments_);
  switch (parsed.command) {
    case "backup":
      await runBackupLifecycleFromCli(parsed);
      return;
    case "device":
      await runDeviceEnrollmentFromCli(parsed);
      return;
    case "init": {
      const identity = await runtimeIdentity(parsed.home);
      await runInit(parsed, identity);
      return;
    }
    case "serve": {
      const identity = await runtimeIdentity(parsed.home);
      await runServe(parsed, identity);
      return;
    }
    case "status":
      await runStatus(parsed);
      return;
    case "service":
      await runServiceLifecycleFromCli(parsed);
      return;
    case "version": {
      const identity = await runtimeIdentity(parsed.home);
      printVersion(identity);
      return;
    }
    case "help":
      printHelp();
      return;
  }
}

export interface ParsedArguments {
  readonly command:
    "backup" | "device" | "help" | "init" | "serve" | "service" | "status" | "version";
  readonly home?: string;
  readonly adminRoot?: string;
  readonly backup?: ParsedBackupArguments;
  readonly device?: ParsedDeviceEnrollmentArguments;
  readonly database?: MainDatabaseConfiguration;
  readonly listener?: MainListenerConfiguration;
  readonly agentProvider?: MainAgentProviderPreference;
  readonly codexHome?: string;
  readonly claudeHome?: string;
  readonly adminAutoOpen?: boolean;
  readonly artifactConfigurationFile?: string;
  readonly discordConfigurationFile?: string;
  readonly discordTokenStdin?: true;
  readonly databaseUriStdin?: true;
  readonly secretBackendConfigurationFile?: string;
  readonly deviceEnrollmentConfigurationFile?: string;
  readonly service?: ParsedServiceLifecycleArguments;
  readonly open: boolean;
}

export function parseArguments(values: readonly string[]): ParsedArguments {
  const commandValue = values[0] ?? "help";
  if (commandValue === "backup") {
    return {
      command: "backup",
      backup: parseBackupArguments(values.slice(1)),
      open: false,
    };
  }
  if (commandValue === "device") {
    return {
      command: "device",
      device: parseDeviceEnrollmentArguments(values.slice(1)),
      open: false,
    };
  }
  if (commandValue === "service") {
    return {
      command: "service",
      service: parseServiceLifecycleArguments(values.slice(1)),
      open: false,
    };
  }
  const command =
    commandValue === "init" || commandValue === "serve" || commandValue === "status"
      ? commandValue
      : commandValue === "help" || commandValue === "--help" || commandValue === "-h"
        ? "help"
        : commandValue === "--version" || commandValue === "-v" || commandValue === "version"
          ? "version"
          : undefined;
  if (command === undefined) {
    throw new MainRuntimeError("CONFIG_INVALID", `Unknown command: ${commandValue}.`);
  }

  let home: string | undefined;
  let adminRoot: string | undefined;
  let databaseAdapter: "sqlite" | "postgresql" | undefined;
  let databaseUriRef: string | undefined;
  let databaseUriStdin = false;
  let databaseSchema: string | undefined;
  let listenHost: string | undefined;
  let listenPort: number | undefined;
  let listenOrigin: string | undefined;
  let tlsCertificatePath: string | undefined;
  let tlsPrivateKeyPath: string | undefined;
  let agentProvider: MainAgentProviderPreference | undefined;
  let codexHome: string | undefined;
  let claudeHome: string | undefined;
  let adminAutoOpen: boolean | undefined;
  let artifactConfigurationFile: string | undefined;
  let discordConfigurationFile: string | undefined;
  let discordTokenStdin = false;
  let secretBackendConfigurationFile: string | undefined;
  let deviceEnrollmentConfigurationFile: string | undefined;
  let open = false;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--open") {
      open = true;
      continue;
    }
    if (value === "--database-uri-stdin") {
      databaseUriStdin = true;
      continue;
    }
    if (value === "--discord-token-stdin") {
      discordTokenStdin = true;
      continue;
    }
    if (value === "--database-uri-environment" || value === "--discord-token-environment") {
      throw new MainRuntimeError(
        "CONFIG_MIGRATION_REQUIRED",
        `${value} was retired because process environments are not a Secret transport. Use --database-uri-ref with --database-uri-stdin, or --discord-token-stdin.`,
      );
    }
    if (
      value === "--home" ||
      value === "--admin-root" ||
      value === "--database" ||
      value === "--database-uri-ref" ||
      value === "--database-schema" ||
      value === "--secret-backend-config" ||
      value === "--agent" ||
      value === "--codex-home" ||
      value === "--claude-home" ||
      value === "--admin-auto-open" ||
      value === "--artifact-config" ||
      value === "--discord-config" ||
      value === "--device-channel-config" ||
      value === "--listen-host" ||
      value === "--listen-port" ||
      value === "--listen-origin" ||
      value === "--tls-certificate" ||
      value === "--tls-private-key"
    ) {
      const target = values[index + 1];
      if (target === undefined || target.startsWith("--") || target.trim() === "") {
        throw new MainRuntimeError("CONFIG_INVALID", `${value} requires a value.`);
      }
      switch (value) {
        case "--home":
          home = resolve(target);
          break;
        case "--admin-root":
          adminRoot = resolve(target);
          break;
        case "--database":
          if (target !== "sqlite" && target !== "postgresql") {
            throw new MainRuntimeError(
              "CONFIG_INVALID",
              "--database must be sqlite or postgresql.",
            );
          }
          databaseAdapter = target;
          break;
        case "--database-uri-ref":
          try {
            databaseUriRef = validateMainSecretReference(target);
          } catch {
            throw new MainRuntimeError(
              "CONFIG_INVALID",
              "--database-uri-ref must be a canonical secret://main/ALIAS reference.",
            );
          }
          break;
        case "--database-schema":
          databaseSchema = target;
          break;
        case "--secret-backend-config":
          secretBackendConfigurationFile = resolve(target);
          break;
        case "--agent":
          if (
            target !== "auto" &&
            target !== "codex" &&
            target !== "claude" &&
            target !== "disabled"
          ) {
            throw new MainRuntimeError(
              "CONFIG_INVALID",
              "--agent must be auto, codex, claude, or disabled.",
            );
          }
          agentProvider = target;
          break;
        case "--codex-home":
          codexHome = resolve(target);
          break;
        case "--claude-home":
          claudeHome = resolve(target);
          break;
        case "--admin-auto-open":
          if (target !== "enabled" && target !== "disabled") {
            throw new MainRuntimeError(
              "CONFIG_INVALID",
              "--admin-auto-open must be enabled or disabled.",
            );
          }
          adminAutoOpen = target === "enabled";
          break;
        case "--artifact-config":
          artifactConfigurationFile = resolve(target);
          break;
        case "--discord-config":
          discordConfigurationFile = resolve(target);
          break;
        case "--device-channel-config":
          deviceEnrollmentConfigurationFile = resolve(target);
          break;
        case "--listen-host":
          listenHost = target;
          break;
        case "--listen-port": {
          const parsedPort = Number(target);
          if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
            throw new MainRuntimeError(
              "CONFIG_INVALID",
              "--listen-port must be an integer from 1 through 65535.",
            );
          }
          listenPort = parsedPort;
          break;
        }
        case "--listen-origin":
          listenOrigin = target;
          break;
        case "--tls-certificate":
          tlsCertificatePath = resolve(target);
          break;
        case "--tls-private-key":
          tlsPrivateKeyPath = resolve(target);
          break;
      }
      index += 1;
      continue;
    }
    throw new MainRuntimeError("CONFIG_INVALID", `Unknown option: ${String(value)}.`);
  }
  const database = parseDatabaseOptions({
    databaseAdapter,
    databaseSchema,
    databaseUriRef,
  });
  const listener = parseListenerOptions({
    listenHost,
    listenOrigin,
    listenPort,
    tlsCertificatePath,
    tlsPrivateKeyPath,
  });
  if (
    command !== "init" &&
    (adminRoot !== undefined ||
      database !== undefined ||
      listener !== undefined ||
      agentProvider !== undefined ||
      codexHome !== undefined ||
      claudeHome !== undefined ||
      adminAutoOpen !== undefined ||
      artifactConfigurationFile !== undefined ||
      discordConfigurationFile !== undefined ||
      discordTokenStdin ||
      databaseUriStdin ||
      secretBackendConfigurationFile !== undefined ||
      deviceEnrollmentConfigurationFile !== undefined)
  ) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "Agent, Admin auto-open, Artifact, Device channel, Discord, database, listener, TLS, and Admin bundle options are available only with init.",
    );
  }
  if (codexHome !== undefined && agentProvider !== "codex") {
    throw new MainRuntimeError("CONFIG_INVALID", "--codex-home requires --agent codex.");
  }
  if (claudeHome !== undefined && (agentProvider === undefined || agentProvider === "disabled")) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "--claude-home requires an explicit non-disabled --agent selection.",
    );
  }
  if (discordTokenStdin && discordConfigurationFile === undefined) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "--discord-token-stdin requires --discord-config.",
    );
  }
  if (databaseUriStdin && database?.adapter !== "postgresql") {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "--database-uri-stdin requires --database postgresql and --database-uri-ref.",
    );
  }
  if (databaseUriStdin && discordTokenStdin) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "Provision one bounded stdin Secret per init invocation.",
    );
  }
  if (command !== "init" && command !== "serve" && open) {
    throw new MainRuntimeError("CONFIG_INVALID", "--open is available only with init or serve.");
  }
  return {
    command,
    open,
    ...(databaseUriStdin ? { databaseUriStdin: true as const } : {}),
    ...(discordTokenStdin ? { discordTokenStdin: true as const } : {}),
    ...(home === undefined ? {} : { home }),
    ...(adminRoot === undefined ? {} : { adminRoot }),
    ...(database === undefined ? {} : { database }),
    ...(listener === undefined ? {} : { listener }),
    ...(agentProvider === undefined ? {} : { agentProvider }),
    ...(codexHome === undefined ? {} : { codexHome }),
    ...(claudeHome === undefined ? {} : { claudeHome }),
    ...(adminAutoOpen === undefined ? {} : { adminAutoOpen }),
    ...(artifactConfigurationFile === undefined ? {} : { artifactConfigurationFile }),
    ...(discordConfigurationFile === undefined ? {} : { discordConfigurationFile }),
    ...(secretBackendConfigurationFile === undefined ? {} : { secretBackendConfigurationFile }),
    ...(deviceEnrollmentConfigurationFile === undefined
      ? {}
      : { deviceEnrollmentConfigurationFile }),
  };
}

async function runtimeIdentity(home: string | undefined): Promise<RuntimeIdentity> {
  if (!bundledRelease) {
    return resolveRuntimeIdentity({
      installationRoot,
      bundled: false,
    });
  }
  const paths = resolveRuntimePaths({
    ...(home === undefined ? {} : { home }),
    sourceCheckout: installationRoot,
  });
  return resolveRuntimeIdentity({
    installationRoot,
    bundled: true,
    stateRoot: paths.home,
  });
}

function parseDatabaseOptions(input: {
  readonly databaseAdapter: "sqlite" | "postgresql" | undefined;
  readonly databaseSchema: string | undefined;
  readonly databaseUriRef: string | undefined;
}): MainDatabaseConfiguration | undefined {
  if (
    input.databaseAdapter === undefined &&
    input.databaseSchema === undefined &&
    input.databaseUriRef === undefined
  ) {
    return undefined;
  }
  if (input.databaseAdapter === "sqlite") {
    if (input.databaseSchema !== undefined || input.databaseUriRef !== undefined) {
      throw new MainRuntimeError(
        "CONFIG_INVALID",
        "SQLite does not accept PostgreSQL Secret-reference or schema options.",
      );
    }
    return { adapter: "sqlite" };
  }
  if (
    input.databaseAdapter !== "postgresql" ||
    input.databaseUriRef === undefined ||
    (input.databaseSchema !== undefined &&
      !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input.databaseSchema))
  ) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "PostgreSQL requires --database postgresql and a canonical --database-uri-ref.",
    );
  }
  return {
    adapter: "postgresql",
    uriRef: input.databaseUriRef,
    ...(input.databaseSchema === undefined ? {} : { schema: input.databaseSchema }),
  };
}

function parseListenerOptions(input: {
  readonly listenHost: string | undefined;
  readonly listenOrigin: string | undefined;
  readonly listenPort: number | undefined;
  readonly tlsCertificatePath: string | undefined;
  readonly tlsPrivateKeyPath: string | undefined;
}): MainListenerConfiguration | undefined {
  if (Object.values(input).every((value) => value === undefined)) {
    return undefined;
  }
  if (
    input.listenHost === undefined ||
    input.listenOrigin === undefined ||
    input.listenPort === undefined
  ) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "A custom listener requires --listen-host, --listen-port, and --listen-origin together.",
    );
  }
  if ((input.tlsCertificatePath === undefined) !== (input.tlsPrivateKeyPath === undefined)) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "--tls-certificate and --tls-private-key must be supplied together.",
    );
  }
  return {
    host: input.listenHost,
    port: input.listenPort,
    origin: input.listenOrigin,
    ...(input.tlsCertificatePath === undefined || input.tlsPrivateKeyPath === undefined
      ? {}
      : {
          tls: {
            certificatePath: input.tlsCertificatePath,
            privateKeyPath: input.tlsPrivateKeyPath,
          },
        }),
  };
}

async function runInit(options: ParsedArguments, identity: RuntimeIdentity): Promise<void> {
  const secretBackend: MainSecretBackendConfiguration | undefined =
    options.secretBackendConfigurationFile === undefined
      ? undefined
      : await loadMainSecretBackendConfigurationSource(options.secretBackendConfigurationFile);
  const artifacts =
    options.artifactConfigurationFile === undefined
      ? undefined
      : await loadMainArtifactConfigurationSource(options.artifactConfigurationFile);
  const discord =
    options.discordConfigurationFile === undefined
      ? undefined
      : await loadMainDiscordConfigurationSource(options.discordConfigurationFile);
  const deviceEnrollment =
    options.deviceEnrollmentConfigurationFile === undefined
      ? undefined
      : await loadMainDeviceEnrollmentConfigurationSource(
          options.deviceEnrollmentConfigurationFile,
          { sourceCheckout: installationRoot },
        );
  const stdinSecret =
    options.databaseUriStdin === true
      ? await readBoundedSecretFromStdin(8 * 1024, "PostgreSQL URI")
      : options.discordTokenStdin === true
        ? await readBoundedSecretFromStdin(4 * 1024, "Discord bot token")
        : undefined;
  let initialized: Awaited<ReturnType<typeof initializeMainHome>>;
  try {
    initialized = await initializeMainHome({
      ...(options.home === undefined ? {} : { home: options.home }),
      adminRoot: options.adminRoot ?? defaultAdminRoot,
      ...(options.adminRoot === undefined ? {} : { expectedAdminRoot: options.adminRoot }),
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(secretBackend === undefined ? {} : { secretBackend }),
      ...(options.databaseUriStdin !== true || stdinSecret === undefined
        ? {}
        : { databaseSecret: stdinSecret }),
      ...(options.listener === undefined ? {} : { listener: options.listener }),
      ...(discord === undefined ? {} : { discord }),
      ...(artifacts === undefined ? {} : { artifacts }),
      ...(deviceEnrollment === undefined
        ? {}
        : {
            deviceChannel: {
              enrollment: deviceEnrollment.enrollment,
              workerChannel: deviceEnrollment.workerChannel,
            },
          }),
      sourceCheckout: installationRoot,
    });
  } catch (error) {
    stdinSecret?.fill(0);
    throw error;
  }
  try {
    if (deviceEnrollment !== undefined) {
      const persistence = await persistMainDeviceEnrollmentConfiguration(
        mainDeviceEnrollmentConfigurationPath(initialized.paths.configDirectory),
        deviceEnrollment,
        { sourceCheckout: installationRoot },
      );
      writeEvent("main.device-enrollment.configured", {
        status: persistence,
        enrollmentUrl: deviceEnrollment.enrollment.advertisedUrl,
        workerChannelUrl: deviceEnrollment.workerChannel.advertisedUrl,
      });
    }
    writeEvent("main.initialized", {
      created: initialized.created,
      configurationFile: initialized.paths.configurationFile,
      origin: initialized.configuration.main.origin,
    });
  } catch (error) {
    stdinSecret?.fill(0);
    throw error;
  }
  if (initialized.configuration.discord !== undefined && options.discordTokenStdin === true) {
    if (stdinSecret === undefined) {
      throw new MainRuntimeError(
        "DATABASE_SECRET_UNAVAILABLE",
        "The bounded Discord credential input is unavailable.",
      );
    }
    try {
      const secretStore = createMainManagedSecretStore({
        configuration: initialized.configuration.secretBackend,
        deviceId: initialized.configuration.deviceId,
        sourceCheckout: installationRoot,
        environment: process.env,
      });
      await provisionMainDiscordBotCredential({
        composition: {
          config: initialized.configuration.discord.forum,
          botTokenAlias: initialized.configuration.discord.botTokenAlias,
          secretStore,
        },
        secret: stdinSecret,
      });
    } finally {
      stdinSecret.fill(0);
    }
    writeEvent("main.discord.credential-provisioned", {
      alias: initialized.configuration.discord.botTokenAlias,
    });
  }

  const runtime = await createAndListen(
    initialized.configuration,
    initialized.paths.home,
    identity,
    options.agentProvider,
    options.adminAutoOpen,
    options.codexHome,
    options.claudeHome,
  );
  let claimListener: Awaited<ReturnType<typeof startClaimListener>>;
  try {
    claimListener = await startClaimListener(runtime);
  } catch (error) {
    await closeAfterPrimaryFailure(error, [
      { operation: "main-runtime", close: () => runtime.close() },
    ]);
  }
  if (claimListener !== undefined && options.open) {
    openBrowser(claimListener.origin);
  }
  await waitForShutdown(runtime, claimListener?.close);
}

async function runServe(options: ParsedArguments, identity: RuntimeIdentity): Promise<void> {
  const paths = resolveRuntimePaths({
    ...(options.home === undefined ? {} : { home: options.home }),
    sourceCheckout: installationRoot,
  });
  const configuration = await loadMainConfiguration(paths.configurationFile);
  const runtime = await createAndListen(configuration, paths.home, identity);
  await reportMainServiceReadiness(runtime, identity);
  if (options.open) {
    openBrowser(configuration.main.origin);
  }
  await waitForShutdown(runtime);
}

async function reportMainServiceReadiness(
  runtime: MainRuntime,
  identity: RuntimeIdentity,
): Promise<void> {
  const readiness = await runtime.readiness();
  const message = createMainServiceReadyMessage({
    instanceId: runtime.configuration.instanceId,
    deviceId: runtime.configuration.deviceId,
    releaseVersion: identity.build.version,
    buildId: identity.build.buildId,
    origin: runtime.configuration.main.origin,
    readiness,
  });
  if (typeof process.send !== "function" || !process.connected) {
    return;
  }
  await new Promise<void>((resolveSend, rejectSend) => {
    process.send!(message, (error) => {
      if (error === null) {
        resolveSend();
      } else {
        rejectSend(error);
      }
    });
  });
}

async function runStatus(options: ParsedArguments): Promise<void> {
  const paths = resolveRuntimePaths({
    ...(options.home === undefined ? {} : { home: options.home }),
    sourceCheckout: installationRoot,
  });
  const configuration = await loadMainConfiguration(paths.configurationFile);
  const response = await fetch(`${configuration.main.origin}/health/live`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body: unknown = await response.json();
  process.stdout.write(
    `${JSON.stringify({
      reachable: response.ok,
      status: response.status,
      health: body,
    })}\n`,
  );
  if (!response.ok) {
    process.exitCode = 1;
  }
}

async function runBackupLifecycleFromCli(options: ParsedArguments): Promise<void> {
  const parsed = options.backup;
  if (parsed === undefined) {
    throw new BackupCliError("BACKUP_ARGUMENT_INVALID", "The backup command is missing.");
  }
  if (parsed.command === "help") {
    process.stdout.write(backupHelpText());
    return;
  }
  const restoreSecretBackend =
    parsed.secretBackendConfigurationFile === undefined
      ? undefined
      : await loadMainSecretBackendConfigurationSource(parsed.secretBackendConfigurationFile);
  const postgresSecret =
    parsed.databaseUriStdin === true
      ? await readBoundedSecretFromStdin(8 * 1024, "PostgreSQL URI")
      : undefined;
  try {
    const result = await runBackupLifecycleCommand(parsed, {
      sourceCheckout: installationRoot,
      loadSource: async (home) => {
        const paths = resolveRuntimePaths({
          ...(home === undefined ? {} : { home }),
          sourceCheckout: installationRoot,
        });
        const configuration = await loadMainConfiguration(paths.configurationFile);
        return {
          home: paths.home,
          configurationFile: paths.configurationFile,
          agentConfigurationFile: resolve(paths.configDirectory, "agent.json"),
          deviceEnrollmentConfigurationFile: mainDeviceEnrollmentConfigurationPath(
            paths.configDirectory,
          ),
          sqliteFile: paths.sqliteFile,
          configuration,
          sourceCheckout: installationRoot,
        };
      },
      ...(postgresSecret === undefined ? {} : { postgresSecret }),
      ...(restoreSecretBackend === undefined ? {} : { restoreSecretBackend }),
    });
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
  } finally {
    postgresSecret?.fill(0);
  }
}

async function runServiceLifecycleFromCli(options: ParsedArguments): Promise<void> {
  const parsed = options.service;
  if (parsed === undefined) {
    throw new ServiceLifecycleCliError(
      "SERVICE_ARGUMENT_INVALID",
      "The service command is missing.",
    );
  }
  if (parsed.command === "help") {
    process.stdout.write(serviceLifecycleHelpText());
    return;
  }
  const baseAdapters = createDefaultServiceLifecycleAdapters();
  let resolvedConfiguration:
    | Promise<{
        readonly configuration: Awaited<ReturnType<typeof baseAdapters.configurationReader.read>>;
        readonly previousConfiguration?: Awaited<
          ReturnType<typeof baseAdapters.configurationReader.read>
        >;
      }>
    | undefined;
  const resolveConfiguration = () => {
    resolvedConfiguration ??= (async () => {
      if (parsed.configurationPath === undefined) {
        throw new ServiceLifecycleCliError(
          "SERVICE_ARGUMENT_INVALID",
          "The service configuration path is missing.",
        );
      }
      const template = await baseAdapters.configurationReader.read(parsed.configurationPath);
      if (template.role !== "main") {
        return { configuration: template };
      }
      if (parsed.home === undefined) {
        throw new ServiceLifecycleCliError(
          "SERVICE_CONFIGURATION_INVALID",
          "Main service commands require --home so the effective durable Admin preference can be rendered.",
        );
      }
      try {
        const requestedPaths = resolveRuntimePaths({
          home: parsed.home,
          sourceCheckout: installationRoot,
        });
        const boundHome = await resolveMainServiceHomeBinding({
          command: parsed.command,
          home: requestedPaths.home,
          hostPlatform: baseAdapters.hostPlatform,
          template,
        });
        const paths = resolveRuntimePaths({
          home: boundHome,
          sourceCheckout: installationRoot,
        });
        const main = await loadMainConfiguration(paths.configurationFile);
        const values = await inspectPersistedMainConfiguration({
          configuration: main,
          home: paths.home,
          sourceCheckout: installationRoot,
          environment: process.env,
        });
        const effective = await resolveEffectiveMainServiceConfiguration({
          command: parsed.command,
          home: paths.home,
          hostPlatform: baseAdapters.hostPlatform,
          service: {
            inspect: async () => values,
          },
          main,
          template,
        });
        return {
          configuration: effective.configuration,
          previousConfiguration: effective.alternateConfiguration,
        };
      } catch (error) {
        if (error instanceof ServiceLifecycleCliError) {
          throw error;
        }
        throw new ServiceLifecycleCliError(
          "SERVICE_CONFIGURATION_INVALID",
          "The effective persisted Main service configuration could not be resolved.",
          { cause: error },
        );
      }
    })();
    return resolvedConfiguration;
  };
  const result = await runServiceLifecycleCommand(parsed, {
    ...baseAdapters,
    configurationReader: {
      async read() {
        return (await resolveConfiguration()).configuration;
      },
    },
    reconfigurationReader: {
      async readPrevious() {
        const previous = (await resolveConfiguration()).previousConfiguration;
        if (previous === undefined) {
          throw new ServiceLifecycleCliError(
            "SERVICE_CONFIGURATION_INVALID",
            "Only the fixed Main Admin auto-open preference can be reconfigured.",
          );
        }
        return previous;
      },
    },
  });
  process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
  if (result.kind === "operation" && result.report.outcome !== "succeeded") {
    process.exitCode = 1;
  }
}

async function runDeviceEnrollmentFromCli(options: ParsedArguments): Promise<void> {
  const command = options.device;
  if (command === undefined) {
    throw new DeviceEnrollmentCliError("DEVICE_ARGUMENT_INVALID", "The Device command is missing.");
  }
  const result = await runDeviceEnrollmentCommand(command, {
    sourceCheckout: installationRoot,
    environment: process.env,
    loadSource: async (home) => {
      const paths = resolveRuntimePaths({
        ...(home === undefined ? {} : { home }),
        sourceCheckout: installationRoot,
      });
      return {
        configuration: await loadMainConfiguration(paths.configurationFile),
        configDirectory: paths.configDirectory,
        sqliteFile: paths.sqliteFile,
      };
    },
  });
  if (result.status === "help") {
    process.stdout.write(result.text);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
}

async function createAndListen(
  configuration: Awaited<ReturnType<typeof loadMainConfiguration>>,
  home: string,
  identity: RuntimeIdentity,
  requestedAgentProvider?: MainAgentProviderPreference,
  initialAdminAutoOpen?: boolean,
  requestedCodexHome?: string,
  requestedClaudeHome?: string,
): Promise<MainRuntime> {
  const paths = resolveRuntimePaths({
    home,
    sourceCheckout: installationRoot,
  });
  const agent = await resolveMainAgentComposition({
    paths: {
      ...paths,
      sourceCheckoutRoot: installationRoot,
    },
    ...(requestedAgentProvider === undefined ? {} : { requestedProvider: requestedAgentProvider }),
    ...(requestedCodexHome === undefined ? {} : { requestedCodexHome }),
    ...(requestedClaudeHome === undefined ? {} : { requestedClaudeHome }),
  });
  if (agent.status === "ready") {
    writeEvent("main.agent.ready", {
      provider: agent.provider,
      adapterId: agent.probe.adapterId,
      version: agent.probe.version,
    });
  } else {
    writeEvent("main.agent.unavailable", {
      code: agent.code,
      ...(agent.provider === undefined ? {} : { provider: agent.provider }),
      diagnosticCodes: agent.diagnostics.map((diagnostic) => diagnostic.code),
    });
  }
  const managedSecretStore = createMainManagedSecretStore({
    configuration: configuration.secretBackend,
    deviceId: configuration.deviceId,
    sourceCheckout: installationRoot,
    environment: process.env,
  });
  const discord =
    configuration.discord === undefined
      ? undefined
      : {
          config: configuration.discord.forum,
          botTokenAlias: configuration.discord.botTokenAlias,
          secretStore: managedSecretStore,
        };
  let deviceChannel:
    | {
        readonly identitySecrets: ReturnType<typeof createMainDeviceIdentitySecretStore>;
      }
    | undefined;
  if (configuration.deviceChannel !== undefined) {
    const composition = await loadPersistedMainDeviceEnrollmentConfiguration(
      mainDeviceEnrollmentConfigurationPath(paths.configDirectory),
      { sourceCheckout: installationRoot },
    );
    assertCompositionMatchesMain(composition, configuration.deviceChannel);
    const identitySecrets = createMainDeviceIdentitySecretStore({
      configuration: composition,
      deviceId: configuration.deviceId,
      sourceCheckout: installationRoot,
      environment: process.env,
    });
    let tls: Awaited<ReturnType<typeof provisionMainDeviceListenerTls>> | undefined;
    await executeWithMainDeviceChannelDatabase(
      configuration.database,
      paths.sqliteFile,
      managedSecretStore,
      async (database) => {
        tls = await provisionMainDeviceListenerTls({
          configuration: configuration.deviceChannel!,
          database,
          identitySecrets,
          instanceId: configuration.instanceId,
          sourceCheckout: installationRoot,
        });
      },
    );
    if (tls === undefined) {
      throw new DeviceEnrollmentCliError(
        "DATABASE_SECRET_UNAVAILABLE",
        "The Device channel database could not be opened for TLS provisioning.",
      );
    }
    writeEvent("main.device-enrollment.tls", {
      status: tls.status,
      listeners: tls.listenerIdentities.map((listener) => ({
        hostnames: listener.hostnames,
        notAfter: new Date(listener.notAfter).toISOString(),
      })),
    });
    deviceChannel = { identitySecrets };
  }
  const runtime = await createMainRuntime({
    configuration,
    home,
    build: identity.build,
    releaseIdentity: identity,
    sourceCheckout: installationRoot,
    managedSecretStore,
    mainDeviceAssessment: {
      probeAgentAdapters: () =>
        probeMainAgentAdapters({
          paths: {
            ...paths,
            sourceCheckoutRoot: installationRoot,
          },
        }),
    },
    ...(initialAdminAutoOpen === undefined ? {} : { initialAdminAutoOpen }),
    ...(agent.status === "ready"
      ? {
          agentExecution: agent.taskExecution,
          agentConfiguration: agent.configurationAgent,
        }
      : {}),
    ...(discord === undefined ? {} : { discord }),
    ...(deviceChannel === undefined ? {} : { deviceChannel }),
  });
  try {
    const listening = await listenMainRuntime(runtime);
    writeEvent("main.listening", {
      address: listening.address,
      origin: configuration.main.origin,
    });
    return listening;
  } catch (error) {
    return closeAfterPrimaryFailure(error, [
      { operation: "main-runtime", close: () => runtime.close() },
    ]);
  }
}

async function readBoundedSecretFromStdin(maximumBytes: number, label: string): Promise<Buffer> {
  if (process.stdin.isTTY === true) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      `${label} input must be piped through stdin so it is not exposed by terminal echo, argv, or process environment.`,
    );
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
      chunks.push(bytes);
      totalBytes += bytes.byteLength;
      if (totalBytes > maximumBytes + 2) {
        throw new MainRuntimeError(
          "CONFIG_INVALID",
          `${label} input exceeds its bounded stdin limit.`,
        );
      }
    }
    const combined = Buffer.concat(chunks, totalBytes);
    try {
      const hasCrLf =
        combined.byteLength >= 2 &&
        combined[combined.byteLength - 2] === 0x0d &&
        combined[combined.byteLength - 1] === 0x0a;
      const hasLf = combined.byteLength >= 1 && combined[combined.byteLength - 1] === 0x0a;
      const contentBytes = hasCrLf
        ? combined.byteLength - 2
        : hasLf
          ? combined.byteLength - 1
          : combined.byteLength;
      if (contentBytes < 1 || contentBytes > maximumBytes) {
        throw new MainRuntimeError(
          "CONFIG_INVALID",
          `${label} input is empty or exceeds its bounded stdin limit.`,
        );
      }
      return Buffer.from(combined.subarray(0, contentBytes));
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

async function startClaimListener(runtime: MainRuntime): Promise<
  | {
      readonly origin: string;
      readonly close: () => Promise<void>;
    }
  | undefined
> {
  let issued;
  try {
    issued = await runtime.ownerAuth.issueInitialClaim({
      channel: "local-bootstrap",
    });
  } catch (error) {
    if (error instanceof OwnerAuthError && error.code === "CLAIM_INVALID") {
      writeEvent("owner.claim.skipped", { reason: "owner-already-claimed" });
      return undefined;
    }
    if (error instanceof OwnerAuthError && error.code === "CLAIM_ALREADY_ACTIVE") {
      issued = await runtime.ownerAuth.replaceInitialClaim({
        channel: "local-bootstrap",
      });
      writeEvent("owner.claim.replaced", {
        reason: "unclaimed-local-bootstrap-restarted",
      });
    } else {
      throw error;
    }
  }

  const port = runtime.configuration.main.port + 1;
  if (port > 65_535) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "The Main port leaves no adjacent local owner-claim port.",
    );
  }
  const origin = `http://127.0.0.1:${port}`;
  const claimListener: {
    app?: Awaited<ReturnType<typeof createLocalClaimApp>>;
  } = {};
  const claimApp = await createLocalClaimApp({
    ownerAuth: runtime.ownerAuth,
    allowedOrigins: [origin],
    onClaimed: async () => {
      writeEvent("owner.claim.completed", {
        redirectOrigin: runtime.configuration.main.origin,
      });
      await claimListener.app?.close();
    },
  });
  claimListener.app = claimApp;
  registerClaimPage(claimApp, issued.claimToken, runtime.configuration.main.origin);
  try {
    await claimApp.listen({ host: "127.0.0.1", port });
  } catch (error) {
    await closeAfterPrimaryFailure(error, [
      { operation: "owner-claim-listener", close: () => claimApp.close() },
    ]);
  }
  writeEvent("owner.claim.ready", {
    expiresAt: new Date(issued.expiresAt).toISOString(),
    origin,
  });
  return {
    origin,
    close: async () => {
      await claimListener.app?.close();
    },
  };
}

function registerClaimPage(
  app: Awaited<ReturnType<typeof createLocalClaimApp>>,
  claimToken: string,
  mainOrigin: string,
): void {
  app.get("/", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("referrer-policy", "no-referrer");
    void reply.type("text/html; charset=utf-8");
    return reply.send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claim OpenDelegate</title>
<body>
  <main>
    <h1>Claim this OpenDelegate Main</h1>
    <p><strong>Pre-release software:</strong> no supported OpenDelegate release is published.</p>
    <p>Create the local owner credential. Save the recovery codes shown next.</p>
    <form id="claim" data-claim="${escapeHtml(claimToken)}" data-main="${escapeHtml(mainOrigin)}">
      <label>Passphrase <input name="passphrase" type="password" required autocomplete="new-password"></label>
      <button type="submit">Create owner</button>
    </form>
    <pre id="result" aria-live="polite"></pre>
  </main>
  <script src="/claim.js" defer></script>
</body>
</html>`);
  });
  app.get("/claim.js", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("referrer-policy", "no-referrer");
    void reply.type("text/javascript; charset=utf-8");
    return reply.send(`"use strict";
const form = document.querySelector("#claim");
const result = document.querySelector("#result");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const passphrase = new FormData(form).get("passphrase");
  const response = await fetch("/api/v1/auth/claim", {
    method: "POST",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin"
    },
    body: JSON.stringify({ claimToken: form.dataset.claim, passphrase })
  });
  const body = await response.json();
  if (!response.ok) {
    result.textContent = body.title || "Claim failed.";
    return;
  }
  form.remove();
  result.textContent = "Save these recovery codes now:\\n\\n" +
    body.recoveryCodes.join("\\n") +
    "\\n\\nThen open " + form.dataset.main;
});`);
  });
}

export async function waitForShutdown(
  runtime: Pick<MainRuntime, "close">,
  closeClaim?: () => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const watchStdin = process.env["OPENDELEGATE_TEST_EXIT_ON_STDIN_END"] === "1";
    const stdinWasFlowing = process.stdin.readableFlowing === true;
    let triggered = false;
    const stop = (): void => {
      if (triggered) {
        return;
      }
      triggered = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (watchStdin) {
        process.stdin.off("end", stop);
        if (!stdinWasFlowing) {
          process.stdin.pause();
        }
      }
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (watchStdin) {
      process.stdin.once("end", stop);
      process.stdin.resume();
    }
  });
  await shutdownMainRuntime(runtime, closeClaim);
}

export async function shutdownMainRuntime(
  runtime: Pick<MainRuntime, "close">,
  closeClaim?: () => Promise<void>,
): Promise<void> {
  await closeMainResources([
    { operation: "main-runtime", close: () => runtime.close() },
    ...(closeClaim === undefined ? [] : [{ operation: "owner-claim-listener", close: closeClaim }]),
  ]);
  writeEvent("main.stopped", {});
}

export function browserOpenCommand(
  hostPlatform: NodeJS.Platform,
  url: string,
): {
  readonly file: string;
  readonly arguments: readonly string[];
} {
  return hostPlatform === "win32"
    ? {
        file: "powershell.exe",
        arguments: ["-NoProfile", "-Command", "Start-Process -FilePath $args[0]", url],
      }
    : hostPlatform === "darwin"
      ? { file: "open", arguments: [url] }
      : { file: "xdg-open", arguments: [url] };
}

export interface BrowserOpenChild {
  once(event: "error", listener: (error: Error) => void): BrowserOpenChild;
  unref(): void;
}

export interface BrowserOpenRuntime {
  readonly hostPlatform?: NodeJS.Platform;
  readonly spawnProcess?: (
    file: string,
    arguments_: readonly string[],
    options: {
      readonly detached: true;
      readonly stdio: "ignore";
      readonly windowsHide: true;
    },
  ) => BrowserOpenChild;
  readonly recordEvent?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}

export function openBrowser(url: string, runtime: BrowserOpenRuntime = {}): void {
  const hostPlatform = runtime.hostPlatform ?? process.platform;
  const command = browserOpenCommand(hostPlatform, url);
  const spawnProcess =
    runtime.spawnProcess ?? ((file, arguments_, options) => spawn(file, [...arguments_], options));
  const recordEvent = runtime.recordEvent ?? writeEvent;
  let child: BrowserOpenChild;
  try {
    child = spawnProcess(command.file, command.arguments, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    recordBrowserOpenFailure(recordEvent, hostPlatform, "spawn-threw");
    return;
  }
  child.once("error", () => {
    recordBrowserOpenFailure(recordEvent, hostPlatform, "child-error");
  });
  child.unref();
}

function recordBrowserOpenFailure(
  recordEvent: (event: string, fields: Readonly<Record<string, unknown>>) => void,
  hostPlatform: NodeJS.Platform,
  phase: "child-error" | "spawn-threw",
): void {
  try {
    recordEvent("main.admin-browser.open-failed", {
      code: "BROWSER_OPEN_UNAVAILABLE",
      hostPlatform,
      phase,
    });
  } catch {
    // Browser availability and its diagnostic sink never own the Main lifecycle.
  }
}

function writeEvent(event: string, fields: Readonly<Record<string, unknown>>): void {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event,
      ...fields,
    })}\n`,
  );
}

function sanitizeCliError(error: unknown): {
  readonly level: "error";
  readonly code: string;
  readonly message: string;
  readonly mutationMayHaveOccurred?: boolean;
  readonly requiresElevation?: boolean;
} {
  if (error instanceof BackupCliError || error instanceof MainBackupError) {
    return {
      level: "error",
      code: error.code,
      message: error.message,
      mutationMayHaveOccurred: false,
      requiresElevation: false,
    };
  }
  if (error instanceof ServiceLifecycleCliError) {
    return {
      level: "error",
      code: error.code,
      message: error.message,
      mutationMayHaveOccurred: error.mutationMayHaveOccurred,
      requiresElevation: error.requiresElevation,
    };
  }
  if (error instanceof ServiceCommandExecutionError) {
    return {
      level: "error",
      code: error.code,
      message: error.message,
      mutationMayHaveOccurred: error.mutationMayHaveOccurred,
      requiresElevation: true,
    };
  }
  if (error instanceof PlatformServiceError) {
    return {
      level: "error",
      code: error.code,
      message: error.message,
      mutationMayHaveOccurred: false,
      requiresElevation: false,
    };
  }
  if (
    error instanceof MainRuntimeError ||
    error instanceof MainDiscordConfigurationError ||
    error instanceof MainSecretBackendConfigurationError ||
    error instanceof DeviceEnrollmentCliError ||
    error instanceof MainDeviceEnrollmentConfigurationError ||
    error instanceof MainDeviceEnrollmentLifecycleError ||
    error instanceof MainAgentRuntimeError ||
    error instanceof OwnerAuthError ||
    error instanceof MainShutdownError ||
    error instanceof ReleaseIdentityError
  ) {
    return {
      level: "error",
      code: error.code,
      message: error.message,
    };
  }
  return {
    level: "error",
    code: "INTERNAL_ERROR",
    message: "OpenDelegate could not complete the command.",
  };
}

export function reportCliFailure(error: unknown): void {
  const publicError = sanitizeCliError(error);
  process.stderr.write(`${JSON.stringify(publicError)}\n`);
  const cleanupError = cleanupFailureFor(error);
  if (cleanupError !== undefined) {
    process.stderr.write(`${JSON.stringify(sanitizeCliError(cleanupError))}\n`);
  }
  process.exitCode = 1;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function printHelp(): void {
  process.stdout.write(`OpenDelegate

Usage:
  opendelegate backup help
  opendelegate backup create --destination ABSOLUTE_PATH [--home PATH]
  opendelegate backup verify --source ABSOLUTE_PATH
  opendelegate backup restore --source ABSOLUTE_PATH --home NEW_ABSOLUTE_PATH
  opendelegate device help
  opendelegate device grant --device-id DEVICE_ID --output ABSOLUTE_PATH
    [--home PATH] [--expires-seconds 30..1800] [--role ROLE ...]
  opendelegate init [--home PATH] [--admin-root PATH] [--open]
    [--agent auto|codex|claude|disabled]
    [--codex-home ABSOLUTE_PATH]
    [--claude-home ABSOLUTE_PATH]
    [--admin-auto-open enabled|disabled]
    [--artifact-config ABSOLUTE_PATH]
    [--discord-config ABSOLUTE_PATH [--discord-token-stdin]]
    [--device-channel-config ABSOLUTE_PATH]
    [--secret-backend-config ABSOLUTE_PATH]
    [--database sqlite]
    [--database postgresql --database-uri-ref secret://main/ALIAS
      [--database-uri-stdin] [--database-schema NAME]]
    [--listen-host HOST --listen-port PORT --listen-origin ORIGIN]
    [--tls-certificate PATH --tls-private-key PATH]
  opendelegate serve [--home PATH] [--open]
  opendelegate status [--home PATH]
  opendelegate service help
  opendelegate service render --config PATH [--home MAIN_HOME]
  opendelegate service plan OPERATION --config PATH [--home MAIN_HOME]
    [--active-version VERSION]
  opendelegate service install|reconfigure|start|stop|restart|uninstall ...
  opendelegate service status|diagnose --config PATH [--home MAIN_HOME]
  opendelegate version

Runtime state and credentials are never written into the source checkout.
Bounded stdin Secret provisioning accepts one Secret per init invocation and never
uses argv or the process environment.
Artifact configuration contains listener, exposure, and Secret Store aliases only.
Discord configuration contains IDs, tag bindings, backend paths, and a Secret Store alias only.
Device channel configuration contains listener paths and a managed Secret Store backend only.
Run "opendelegate backup help" for metadata scope, integrity, and fresh-target restore details.
Run "opendelegate service help" for privilege, idempotency, and two-plane service details.
Run "opendelegate device help" for single-use enrollment Grant details.
`);
}

function printVersion(identity: RuntimeIdentity): void {
  process.stdout.write(`OpenDelegate ${identity.build.version}\n`);
}

const invokedFile = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedFile === resolve(cliPath)) {
  void runCli(process.argv.slice(2)).catch(reportCliFailure);
}
