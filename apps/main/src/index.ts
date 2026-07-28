import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { arch, homedir, hostname, platform, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createMainControlPlaneApp,
  type ConfigurationAgentPort,
  type MainControlPlaneAppOptions,
} from "@opendelegate/control-plane";
import type { AgentAdapterProbe } from "@opendelegate/agent-adapters";
import {
  ConfigurationService,
  STANDARD_CONFIGURATION_DEFINITIONS,
  type ConfigurationChange,
  type ConfigurationSecretReferenceAvailabilityInput,
  type EffectiveConfigurationValue,
} from "@opendelegate/configuration";
import {
  Argon2idPasswordHasher,
  NodeCryptoRandomSource,
  OwnerAuth,
  type OwnerAuthClock,
} from "@opendelegate/owner-auth";
import {
  SqlActionAuthorizationRepository,
  SqlApprovalRepository,
  SqlArtifactIndexRepository,
  SqlConfigurationRepository,
  SqlDeviceObservationRepository,
  SqlEventStore,
  SqlOwnerAuthRepository,
  type SqlMigrationMode,
} from "@opendelegate/storage-sql";
import {
  AuthoritativeWorkerTaskExecutor,
  DEFAULT_AUTONOMOUS_TASK_BUDGET_LIMITS,
  DEFAULT_INSTANCE_BUDGET_LIMITS,
  DEFAULT_PROVIDER_USAGE_PROXY,
  DEFAULT_REQUESTED_TASK_BUDGET_LIMITS,
  DurableTaskContinuationCheckpointService,
  DurableTaskBudgetEnforcer,
  TaskExecutionCoordinator,
  TaskService,
  type TaskBudgetAdministrationPort,
  type TaskExecutionCoordinatorOptions,
  type TaskExecutor,
} from "@opendelegate/task-service";
import type { DeviceIdentitySecretStore } from "@opendelegate/device-identity";
import type { ManagedSecretStore } from "@opendelegate/secrets";

import type { RuntimeReleaseIdentity } from "./release-identity.ts";

import {
  AgentBackedConfigurationAgent,
  ConfigurationServiceAgentToolBroker,
  ManagedSecretExactMatchGuard,
  type AgentBackedConfigurationAgentOptions,
} from "./agent-configuration-agent.ts";
import {
  LateBoundApprovalExecutionPort,
  LateBoundMainActionRunAuthorityPort,
} from "./action-authorization-composition.ts";
import { MainActionAuthorizationRuntime } from "./action-authorization-runtime.ts";
import { createMainAdminOperations } from "./admin-operations.ts";
import {
  AgentBackedTaskExecutor,
  EventStoreMainNativeSessionRepository,
  type AgentBackedTaskExecutorOptions,
} from "./agent-task-executor.ts";
import {
  createProductionMainArtifactRuntime,
  validateMainArtifactConfiguration,
  type MainArtifactConfiguration,
  type MainArtifactRuntime,
} from "./artifact-runtime.ts";
import { DiscordArtifactPresentation } from "./discord-artifact-presentation.ts";
import { DiscordBindingConfigurationLifecycle } from "./discord-binding-configuration-lifecycle.ts";
import {
  DiscordBindingController,
  type DiscordBindingStatus,
} from "./discord-binding-controller.ts";
import {
  MainArtifactPrepareService,
  type MainArtifactPreparePolicyPort,
} from "./artifact-prepare-service.ts";
import {
  createProductionDiscordRuntime,
  type CreateProductionDiscordRuntimeOptions,
  type DiscordMainRuntime,
} from "./discord-runtime.ts";
import {
  MAIN_DISCORD_BINDING_CONFIGURATION_DEFINITION,
  MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
  toMainDiscordBindingConfiguration,
  validateMainDiscordBindingConfiguration,
  validateMainDiscordConfiguration,
  type MainDiscordBindingConfiguration,
  type MainDiscordConfiguration,
} from "./discord-configuration.ts";
import {
  createProductionMainDeviceChannelRuntime,
  type MainDeviceChannelConfiguration,
  type MainDeviceChannelListenerFactory,
  type ProductionMainDeviceChannelRuntime,
} from "./device-channel-runtime.ts";
import { MainDeviceChannelWorkerRunDispatchPort } from "./device-worker-dispatch.ts";
import { mergeMainDeviceSummary } from "./device-directory-projection.ts";
import {
  MainWorkerFleetProjection,
  type MainOwnedDeviceProfile,
} from "./worker-fleet-projection.ts";
import { DeterministicWorkerTargetResolver } from "./worker-target-resolver.ts";
import { closeAfterPrimaryFailure, closeMainResources } from "./shutdown.ts";
import { readStableRegularFile, StableFileError } from "./stable-file.ts";
import { createMainTaskBudgetAdmin } from "./task-budget-admin.ts";
import { authorizeMainConfigurationMutation } from "./configuration-policy.ts";
import {
  MAIN_OWNER_TASK_DEFAULT_SCOPE_ID,
  MainConfigurationRuntimePolicy,
  createConfigurationControlledRouteDiagnosticAgent,
  createConfigurationMainActionPolicy,
  createConfigurationMainArtifactPreparePolicy,
} from "./configuration-runtime-policy.ts";
import { MainSecureSecretIngestService } from "./secure-secret-ingest.ts";
import {
  createMainManagedSecretStore,
  defaultMainSecretBackendConfiguration,
  validateMainSecretBackendConfiguration,
  type MainSecretBackendConfiguration,
} from "./main-secret-backend.ts";
import {
  MainDatabaseSecretError,
  executeWithPostgresUri,
  mainSecretAlias,
  validateMainSecretReference,
  validatePostgresSecretMaterial,
} from "./database-secret.ts";
import {
  createConfigurationApprovalRuntime,
  type ConfigurationApprovalRuntime,
} from "./configuration-approval.ts";
import {
  AgentBackedRouteIncidentDiagnostic,
  MainRouteIncidentDiagnosisService,
} from "./route-incident-diagnosis.ts";
import {
  acquireMainSingletonOwnership,
  MainSingletonOwnershipError,
  type MainSingletonOwnership,
  type MainSingletonOwnershipFactory,
} from "./main-singleton-ownership.ts";
import {
  EventStoreMainDeviceAssessmentRepository,
  MainDeviceAssessmentService,
  projectMainDeviceAssessment,
  type CapabilityAssessmentProbe,
} from "./main-device-assessment.ts";
import {
  enforceHostRuntimePermissions,
  RuntimePermissionEnforcementError,
} from "./internal/runtime-permissions.ts";

export {
  AgentBackedConfigurationAgent,
  ManagedSecretExactMatchGuard,
  type AgentBackedConfigurationAgentClock,
  type AgentBackedConfigurationAgentOptions,
  type ConfigurationAgentSecretLeakGuardPort,
} from "./agent-configuration-agent.ts";
export {
  DEFAULT_MAIN_AGENT_LIMITS,
  MainAgentRuntimeError,
  resolveMainAgentComposition,
  type MainAgentComposition,
  type MainAgentCompositionReady,
  type MainAgentCompositionUnavailable,
  type MainAgentProviderPreference,
  type MainAgentRuntimeErrorCode,
  type MainAgentRuntimePaths,
  type ResolveMainAgentCompositionOptions,
  type SelectedMainAgentProvider,
} from "./agent-runtime.ts";
export {
  AgentBackedTaskExecutor,
  EventStoreMainNativeSessionRepository,
} from "./agent-task-executor.ts";
export type {
  AgentBackedTaskExecutorOptions,
  MainNativeSessionRepository,
  NativeSessionEventStore,
} from "./agent-task-executor.ts";
export {
  MainArtifactPrepareService,
  createDefaultMainArtifactPreparePolicy,
} from "./artifact-prepare-service.ts";
export {
  MAIN_OWNER_TASK_DEFAULT_SCOPE_ID,
  MainConfigurationRuntimePolicy,
  MainConfigurationRuntimePolicyError,
  createConfigurationControlledRouteDiagnosticAgent,
  createConfigurationMainActionPolicy,
  createConfigurationMainArtifactPreparePolicy,
} from "./configuration-runtime-policy.ts";
export type {
  MainArtifactExposureMode,
  MainAutonomyProfile,
  MainConfigurationRuntimePolicyOptions,
  MainProactiveDisposition,
  MainProactiveWorkKind,
  MainRouteAgentEscalation,
  MainTaskDefaultMode,
} from "./configuration-runtime-policy.ts";
export type {
  DefaultMainArtifactPreparePolicyOptions,
  MainArtifactGrantRuntimePort,
  MainArtifactPreparePolicyDecision,
  MainArtifactPreparePolicyPort,
  MainArtifactPrepareServiceOptions,
  MainArtifactRunAuthorityPort,
} from "./artifact-prepare-service.ts";
export {
  MainArtifactRuntimeError,
  createProductionMainArtifactRuntime,
  defaultMainArtifactConfiguration,
  loadMainArtifactConfigurationSource,
  validateMainArtifactConfiguration,
} from "./artifact-runtime.ts";
export type {
  ArtifactListenerConfiguration,
  ArtifactListenerFactory,
  ArtifactListenerHandle,
  MainArtifactConfiguration,
  MainArtifactRuntime,
  MainArtifactRuntimeErrorCode,
  MainArtifactRuntimeHealth,
  MainArtifactSecretBackendConfiguration,
} from "./artifact-runtime.ts";
export {
  DiscordMainRuntime,
  ManagedDiscordBotCredentialProvider,
  ManagedDiscordInteractionTokenVault,
  createProductionDiscordRuntime,
} from "./discord-runtime.ts";
export {
  DiscordArtifactPresentation,
  type DiscordArtifactPresentationOptions,
} from "./discord-artifact-presentation.ts";
export {
  DiscordBindingController,
  DiscordBindingControllerError,
  type DiscordBindingControllerErrorCode,
  type DiscordBindingControllerOptions,
  type DiscordBindingRuntime,
  type DiscordBindingStatus,
  type PreparedDiscordBindingTransition,
} from "./discord-binding-controller.ts";
export { mergeMainDeviceSummary } from "./device-directory-projection.ts";
export {
  MAIN_DISCORD_BINDING_CONFIGURATION_DEFINITION,
  MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
  MainDiscordConfigurationError,
  createMainDiscordComposition,
  isMainDiscordBindingConfiguration,
  loadMainDiscordConfigurationSource,
  provisionMainDiscordBotCredential,
  toMainDiscordBindingConfiguration,
  validateMainDiscordBindingConfiguration,
  validateMainDiscordConfiguration,
} from "./discord-configuration.ts";
export {
  MainSecureSecretIngestService,
  createDefaultMainManagedSecretStore,
  type MainSecureSecretIngestServiceOptions,
} from "./secure-secret-ingest.ts";
export {
  MainSecretBackendConfigurationError,
  createMainManagedSecretStore,
  defaultMainSecretBackendConfiguration,
  loadMainSecretBackendConfigurationSource,
  validateMainSecretBackendConfiguration,
  type MainSecretBackendConfiguration,
} from "./main-secret-backend.ts";
export {
  MainDatabaseSecretError,
  executeWithPostgresUri,
  mainSecretAlias,
  validateMainSecretReference,
} from "./database-secret.ts";
export type {
  MainDiscordBindingConfiguration,
  MainDiscordComposition,
  MainDiscordConfiguration,
  MainDiscordSecretBackendConfiguration,
} from "./discord-configuration.ts";
export type {
  CreateProductionDiscordRuntimeOptions,
  DiscordMainRuntimeOptions,
  DiscordProjectionTask,
  DiscordProjectionTaskPort,
  DiscordRuntimeDatabase,
  DiscordRuntimeDiagnostic,
  DiscordRuntimeScheduler,
  DiscordRuntimeStatus,
  DiscordRuntimeTaskServicePort,
  ManagedDiscordBotCredentialProviderOptions,
  ManagedDiscordInteractionTokenVaultOptions,
} from "./discord-runtime.ts";
export {
  AgentBackedRouteIncidentDiagnostic,
  MainRouteIncidentDiagnosisService,
  ROUTE_INCIDENT_DIAGNOSIS_COMPLETED_EVENT_TYPE,
  ROUTE_DIAGNOSTIC_AGENT_LIMITS,
  parseStoredRouteIncidentDiagnosisResult,
} from "./route-incident-diagnosis.ts";
export {
  acquireMainSingletonOwnership,
  MainSingletonOwnershipError,
} from "./main-singleton-ownership.ts";
export {
  MAIN_SERVICE_READY_MESSAGE_TYPE,
  createMainServiceReadyMessage,
  isMainServiceReadyMessage,
  type ExpectedMainServiceReadyIdentity,
  type MainServiceReadyMessageV1,
} from "./service-readiness.ts";
export type {
  AcquireMainSingletonOwnershipInput,
  MainSingletonOwnership,
  MainSingletonOwnershipDatabase,
  MainSingletonOwnershipDependencies,
  MainSingletonOwnershipErrorCode,
  MainSingletonOwnershipFactory,
  PostgreSqlOwnershipClient,
} from "./main-singleton-ownership.ts";
export type {
  AgentBackedRouteIncidentDiagnosticOptions,
  MainRouteIncidentDiagnosisReceipt,
  MainRouteIncidentDiagnosisServiceOptions,
  RouteIncidentDiagnosisResult,
  RouteIncidentDiagnosticAgentInput,
  RouteIncidentDiagnosticAgentOutput,
  RouteIncidentDiagnosticAgentPort,
  RouteIncidentNotificationPort,
} from "./route-incident-diagnosis.ts";

const CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_MAIN_PORT = 4380;
const MAX_ADMIN_FILES = 2_000;
const MAX_ADMIN_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ADMIN_TOTAL_BYTES = 64 * 1024 * 1024;
const MAIN_CONFIGURATION_DEFINITIONS = Object.freeze([
  ...STANDARD_CONFIGURATION_DEFINITIONS,
  MAIN_DISCORD_BINDING_CONFIGURATION_DEFINITION,
]);
export interface MainListenerConfiguration {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly tls?: {
    readonly certificatePath: string;
    readonly privateKeyPath: string;
  };
}

export type MainDatabaseConfiguration =
  | {
      readonly adapter: "sqlite";
    }
  | {
      readonly adapter: "postgresql";
      readonly uriRef: string;
      readonly schema?: string;
    };

export interface MainConfiguration {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly main: MainListenerConfiguration;
  readonly database: MainDatabaseConfiguration;
  readonly secretBackend: MainSecretBackendConfiguration;
  readonly adminRoot: string;
  readonly discord?: MainDiscordConfiguration;
  readonly artifacts?: MainArtifactConfiguration;
  readonly deviceChannel?: MainDeviceChannelConfiguration;
}

export interface RuntimePaths {
  readonly home: string;
  readonly configDirectory: string;
  readonly configurationFile: string;
  readonly stateDirectory: string;
  readonly sqliteFile: string;
  readonly logsDirectory: string;
  readonly knowledgeDirectory: string;
}

export type MainRuntimeErrorCode =
  | "ADMIN_ASSET_INVALID"
  | "CONFIG_EXISTS"
  | "CONFIG_INVALID"
  | "CONFIG_MIGRATION_REQUIRED"
  | "DATABASE_SECRET_UNAVAILABLE"
  | "MAIN_ALREADY_RUNNING"
  | "MAIN_LISTENER_UNAVAILABLE"
  | "MAIN_OWNERSHIP_LOST"
  | "MAIN_OWNERSHIP_UNAVAILABLE"
  | "RUNTIME_PATH_UNSAFE";

export class MainRuntimeError extends Error {
  readonly code: MainRuntimeErrorCode;

  constructor(code: MainRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MainRuntimeError";
    this.code = code;
  }
}

export interface InitializeMainHomeOptions {
  readonly home?: string;
  readonly adminRoot: string;
  readonly expectedAdminRoot?: string;
  readonly sourceCheckout: string;
  readonly database?: MainDatabaseConfiguration;
  readonly secretBackend?: MainSecretBackendConfiguration;
  readonly databaseSecret?: Uint8Array;
  readonly listener?: MainListenerConfiguration;
  readonly discord?: MainDiscordConfiguration;
  readonly artifacts?: MainArtifactConfiguration;
  readonly deviceChannel?: MainDeviceChannelConfiguration;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly managedSecretStore?: ManagedSecretStore;
}

export interface InitializedMainHome {
  readonly created: boolean;
  readonly configuration: MainConfiguration;
  readonly paths: RuntimePaths;
}

function projectRuntimeReleaseIdentity(identity: RuntimeReleaseIdentity): RuntimeReleaseIdentity {
  switch (identity.releaseChannel) {
    case "development":
      return {
        declaredReleaseChannel: identity.declaredReleaseChannel,
        releaseChannel: identity.releaseChannel,
        releaseVerification: identity.releaseVerification,
      };
    case "internal-preview":
      return {
        declaredReleaseChannel: identity.declaredReleaseChannel,
        releaseChannel: identity.releaseChannel,
        releaseVerification: identity.releaseVerification,
      };
    case "release-candidate":
      return {
        declaredReleaseChannel: identity.declaredReleaseChannel,
        releaseChannel: identity.releaseChannel,
        releaseVerification: identity.releaseVerification,
      };
    case "released":
      return {
        declaredReleaseChannel: identity.declaredReleaseChannel,
        releaseChannel: identity.releaseChannel,
        releaseVerification: identity.releaseVerification,
      };
  }
}

export interface CreateMainRuntimeOptions {
  readonly home?: string;
  readonly configuration: MainConfiguration;
  readonly build: MainControlPlaneAppOptions["build"];
  readonly releaseIdentity: RuntimeReleaseIdentity;
  readonly sourceCheckout: string;
  readonly initialAdminAutoOpen?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly taskExecution?: {
    readonly executor: TaskExecutor;
    readonly maximumConcurrentTasks?: number;
    readonly maximumAutomaticAttempts?: number;
    readonly retryDelayMs?: number;
  };
  readonly agentExecution?: Omit<
    AgentBackedTaskExecutorOptions,
    "checkpoints" | "deviceId" | "sessionRepository"
  > & {
    readonly maximumConcurrentTasks?: number;
    readonly maximumAutomaticAttempts?: number;
    readonly retryDelayMs?: number;
  };
  readonly configurationAgent?: ConfigurationAgentPort;
  readonly managedSecretStore?: ManagedSecretStore;
  readonly mainSingletonOwnershipFactory?: MainSingletonOwnershipFactory;
  readonly agentConfiguration?: Omit<
    AgentBackedConfigurationAgentOptions,
    "clock" | "eventStore" | "mainDeviceId" | "secretLeakGuard" | "sessionRepository" | "toolBroker"
  >;
  readonly discord?: Omit<
    CreateProductionDiscordRuntimeOptions,
    | "artifactPresentation"
    | "database"
    | "mainDeviceId"
    | "onStatusChange"
    | "productVersion"
    | "tasks"
  > & {
    readonly onStatusChange?: (status: DiscordBindingStatus) => void;
  };
  readonly artifactPreparePolicy?: MainArtifactPreparePolicyPort;
  readonly deviceChannel?: {
    readonly identitySecrets: DeviceIdentitySecretStore;
    readonly listenerFactory?: MainDeviceChannelListenerFactory;
    readonly runtimeFactory?: typeof createProductionMainDeviceChannelRuntime;
  };
  readonly mainDeviceAssessment?: {
    readonly probeAgentAdapters: () => Promise<readonly AgentAdapterProbe[]>;
    readonly probeBrowserAutomation?: () => Promise<CapabilityAssessmentProbe>;
    readonly probeComputerUse?: () => Promise<CapabilityAssessmentProbe>;
  };
}

export interface MainRuntime {
  readonly app: Awaited<ReturnType<typeof createMainControlPlaneApp>>;
  readonly configuration: MainConfiguration;
  readonly ownerAuth: OwnerAuth;
  readonly paths: RuntimePaths;
  readonly tasks: TaskService | TaskExecutionCoordinator;
  readonly taskExecution?: TaskExecutionCoordinator;
  readonly discord?: DiscordMainRuntime | undefined;
  readonly artifacts?: MainArtifactRuntime;
  readonly deviceChannel?: ProductionMainDeviceChannelRuntime;
  readonly budget?: TaskBudgetAdministrationPort;
  readonly readiness: NonNullable<MainControlPlaneAppOptions["readiness"]>;
  close(): Promise<void>;
}

export interface ListeningMainRuntime extends MainRuntime {
  readonly address: string;
}

const singletonOwnershipByRuntime = new WeakMap<MainRuntime, MainSingletonOwnership>();

export function resolveRuntimePaths(input: {
  readonly home?: string;
  readonly sourceCheckout: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): RuntimePaths {
  const sourceCheckout = resolve(input.sourceCheckout);
  const home = resolve(input.home ?? defaultRuntimeHome(input.environment ?? process.env));
  if (isWithin(sourceCheckout, home)) {
    throw new MainRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      "Runtime state must live outside the OpenDelegate source checkout.",
    );
  }
  const configDirectory = join(home, "config");
  const stateDirectory = join(home, "state");
  return Object.freeze({
    home,
    configDirectory,
    configurationFile: join(configDirectory, "main.json"),
    stateDirectory,
    sqliteFile: join(stateDirectory, "main.sqlite3"),
    logsDirectory: join(home, "logs"),
    knowledgeDirectory: join(home, "knowledge"),
  });
}

export async function initializeMainHome(
  options: InitializeMainHomeOptions,
): Promise<InitializedMainHome> {
  try {
    return await initializeMainHomeInternal(options);
  } finally {
    options.databaseSecret?.fill(0);
  }
}

async function initializeMainHomeInternal(
  options: InitializeMainHomeOptions,
): Promise<InitializedMainHome> {
  const paths = resolveRuntimePaths(options);
  const environment = options.environment ?? process.env;
  await ensureRuntimeDirectories(paths, options.sourceCheckout);

  if (await exists(paths.configurationFile)) {
    const configuration = await loadMainConfiguration(paths.configurationFile);
    assertExistingConfigurationMatches(configuration, options);
    await validateAdminRoot(configuration.adminRoot);
    const managedSecretStore = resolveMainManagedSecretStore({
      configuration,
      sourceCheckout: options.sourceCheckout,
      environment,
      ...(options.managedSecretStore === undefined ? {} : { injected: options.managedSecretStore }),
    });
    await provisionDatabaseSecret(
      configuration.database,
      managedSecretStore,
      options.databaseSecret,
    );
    await applyInitialMigrations({
      configuration,
      paths,
      managedSecretStore,
    });
    await sealRuntimeState(paths);
    return {
      created: false,
      configuration,
      paths,
    };
  }

  const secretBackend =
    options.secretBackend ??
    (await defaultMainSecretBackendConfiguration({
      home: paths.home,
      sourceCheckout: options.sourceCheckout,
      environment,
    }));
  const configuration = validateMainConfiguration({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    instanceId: `instance_${randomUUID()}`,
    deviceId: options.managedSecretStore?.deviceId ?? `device_${randomUUID()}`,
    main:
      options.listener ??
      ({
        host: "127.0.0.1",
        port: DEFAULT_MAIN_PORT,
        origin: `http://127.0.0.1:${DEFAULT_MAIN_PORT}`,
      } satisfies MainListenerConfiguration),
    database: options.database ?? { adapter: "sqlite" },
    secretBackend,
    adminRoot: resolve(options.adminRoot),
    ...(options.discord === undefined ? {} : { discord: options.discord }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.deviceChannel === undefined ? {} : { deviceChannel: options.deviceChannel }),
  });
  await validateAdminRoot(configuration.adminRoot);
  const managedSecretStore = resolveMainManagedSecretStore({
    configuration,
    sourceCheckout: options.sourceCheckout,
    environment,
    ...(options.managedSecretStore === undefined ? {} : { injected: options.managedSecretStore }),
  });
  await provisionDatabaseSecret(configuration.database, managedSecretStore, options.databaseSecret);

  await writeFile(paths.configurationFile, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await applyInitialMigrations({
    configuration,
    paths,
    managedSecretStore,
  });
  await sealRuntimeState(paths);

  return {
    created: true,
    configuration,
    paths,
  };
}

function assertExistingConfigurationMatches(
  configuration: MainConfiguration,
  options: InitializeMainHomeOptions,
): void {
  const requested = validateMainConfiguration({
    ...configuration,
    ...(options.listener === undefined ? {} : { main: options.listener }),
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.secretBackend === undefined ? {} : { secretBackend: options.secretBackend }),
    ...(options.discord === undefined ? {} : { discord: options.discord }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.deviceChannel === undefined ? {} : { deviceChannel: options.deviceChannel }),
    ...(options.expectedAdminRoot === undefined
      ? {}
      : { adminRoot: resolve(options.expectedAdminRoot) }),
  });
  const conflicts =
    (options.listener !== undefined &&
      JSON.stringify(requested.main) !== JSON.stringify(configuration.main)) ||
    (options.database !== undefined &&
      JSON.stringify(requested.database) !== JSON.stringify(configuration.database)) ||
    (options.secretBackend !== undefined &&
      JSON.stringify(requested.secretBackend) !== JSON.stringify(configuration.secretBackend)) ||
    (options.discord !== undefined &&
      JSON.stringify(requested.discord) !== JSON.stringify(configuration.discord)) ||
    (options.artifacts !== undefined &&
      JSON.stringify(requested.artifacts) !== JSON.stringify(configuration.artifacts)) ||
    (options.deviceChannel !== undefined &&
      JSON.stringify(requested.deviceChannel) !== JSON.stringify(configuration.deviceChannel)) ||
    (options.expectedAdminRoot !== undefined && requested.adminRoot !== configuration.adminRoot);
  if (conflicts) {
    throw new MainRuntimeError(
      "CONFIG_EXISTS",
      "Main is already initialized with different requested settings. Existing configuration was not changed.",
    );
  }
}

export async function loadMainConfiguration(path: string): Promise<MainConfiguration> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new MainRuntimeError("CONFIG_INVALID", "Main configuration is not valid JSON.");
  }
  return validateMainConfiguration(parsed);
}

export async function inspectPersistedMainConfiguration(input: {
  readonly home?: string;
  readonly configuration: MainConfiguration;
  readonly sourceCheckout: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly managedSecretStore?: ManagedSecretStore;
}): Promise<Readonly<Record<string, EffectiveConfigurationValue>>> {
  const configuration = validateMainConfiguration(input.configuration);
  const paths = resolveRuntimePaths(input);
  const managedSecretStore = resolveMainManagedSecretStore({
    configuration,
    sourceCheckout: input.sourceCheckout,
    environment: input.environment ?? process.env,
    ...(input.managedSecretStore === undefined ? {} : { injected: input.managedSecretStore }),
  });
  const repository = await openConfigurationRepository(
    configuration.database,
    paths,
    "verify",
    managedSecretStore,
  );
  try {
    const service = new ConfigurationService({
      definitions: MAIN_CONFIGURATION_DEFINITIONS,
      repository,
      idSource: () => `configuration_inspect_${randomUUID()}`,
      clock: () => new Date().toISOString(),
    });
    return await service.inspect({
      instanceId: configuration.instanceId,
      mainId: configuration.deviceId,
      deviceId: configuration.deviceId,
    });
  } finally {
    await repository.close();
  }
}

export async function createMainRuntime(options: CreateMainRuntimeOptions): Promise<MainRuntime> {
  if (options.taskExecution !== undefined && options.agentExecution !== undefined) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "Main accepts either a custom Task executor or an Agent-backed executor, not both.",
    );
  }
  if (options.configurationAgent !== undefined && options.agentConfiguration !== undefined) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "Main accepts either a custom Configuration Agent or an Agent-backed Configuration Agent, not both.",
    );
  }
  const configuration = validateMainConfiguration(options.configuration);
  const paths = resolveRuntimePaths(options);
  await ensureRuntimeDirectories(paths, options.sourceCheckout);
  await validateAdminRoot(configuration.adminRoot);

  const environment = options.environment ?? process.env;
  const managedSecretStore = resolveMainManagedSecretStore({
    configuration,
    sourceCheckout: options.sourceCheckout,
    environment,
    ...(options.managedSecretStore === undefined ? {} : { injected: options.managedSecretStore }),
  });
  const clock = new SystemClock();
  const eventStore = await openEventStore(
    configuration.database,
    paths,
    clock,
    "verify",
    managedSecretStore,
  );
  const mainDeviceAssessmentRepository = new EventStoreMainDeviceAssessmentRepository(eventStore);
  let ownerRepository: SqlOwnerAuthRepository | undefined;
  let approvalRepository: SqlApprovalRepository | undefined;
  let actionAuthorizationRepository: SqlActionAuthorizationRepository | undefined;
  let configurationRepository: SqlConfigurationRepository | undefined;
  let deviceObservationRepository: SqlDeviceObservationRepository | undefined;
  let approvalRuntime: ConfigurationApprovalRuntime | undefined;
  let actionAuthorization: MainActionAuthorizationRuntime | undefined;
  let app: Awaited<ReturnType<typeof createMainControlPlaneApp>> | undefined;
  let taskExecution: TaskExecutionCoordinator | undefined;
  let discordBindingController: DiscordBindingController<DiscordMainRuntime> | undefined;
  let artifacts: MainArtifactRuntime | undefined;
  let artifactPrepare: MainArtifactPrepareService | undefined;
  let deviceChannel: ProductionMainDeviceChannelRuntime | undefined;
  let fleet: MainWorkerFleetProjection | undefined;
  let authoritativeWorkerExecutor: AuthoritativeWorkerTaskExecutor | undefined;
  let mainSingletonOwnership: MainSingletonOwnership | undefined;
  let ownershipLossUnsubscribe: (() => void) | undefined;
  let closeAfterOwnershipLoss: (() => Promise<void>) | undefined;
  let ownershipLossPending = false;
  try {
    try {
      mainSingletonOwnership = validateMainSingletonOwnership(
        await (options.mainSingletonOwnershipFactory ?? acquireMainSingletonOwnership)({
          database: configuration.database,
          stateDirectory: paths.stateDirectory,
          secretStore: managedSecretStore,
        }),
      );
    } catch (error) {
      throw normalizeMainSingletonOwnershipError(error);
    }
    ownershipLossUnsubscribe = mainSingletonOwnership.onLost(() => {
      ownershipLossPending = true;
      if (discordBindingController !== undefined) {
        void discordBindingController.close().catch(() => undefined);
      }
      if (closeAfterOwnershipLoss !== undefined) {
        void closeAfterOwnershipLoss().catch(() => undefined);
      }
    });
    assertMainSingletonOwnership(mainSingletonOwnership);
    ownerRepository = await openOwnerRepository(
      configuration.database,
      paths,
      "verify",
      managedSecretStore,
    );
    const ownerAuth = new OwnerAuth({
      allowedOrigins: [configuration.main.origin],
      clock,
      passwordHasher: new Argon2idPasswordHasher(),
      random: new NodeCryptoRandomSource(),
      repository: ownerRepository,
    });
    configurationRepository = await openConfigurationRepository(
      configuration.database,
      paths,
      "verify",
      managedSecretStore,
    );
    const secretIngest = await MainSecureSecretIngestService.open({
      mainDeviceId: configuration.deviceId,
      ledgerDirectory: join(paths.stateDirectory, "secure-secret-ingest"),
      secretStore: managedSecretStore,
    });
    const configuredDatabaseReference =
      configuration.database.adapter === "postgresql" ? configuration.database.uriRef : undefined;
    const configurationService = new ConfigurationService({
      definitions: MAIN_CONFIGURATION_DEFINITIONS,
      repository: configurationRepository,
      idSource: () => `configuration_${randomUUID()}`,
      clock: () => clock.asEventClock().now(),
      secretReferenceAuthority: {
        isAvailable(input: ConfigurationSecretReferenceAvailabilityInput): boolean {
          return (
            secretIngest.isAvailable(input) ||
            (configuredDatabaseReference !== undefined &&
              input.key === "database.uri-ref" &&
              input.locality === "main" &&
              input.scope.kind === "main" &&
              input.scope.id === configuration.deviceId &&
              input.secretRef === configuredDatabaseReference)
          );
        },
      },
    });
    const initialBinding = initialDiscordBinding(configuration, options.discord);
    await seedInitialMainConfiguration(
      configurationService,
      configuration,
      options.initialAdminAutoOpen,
      initialBinding,
      async () => {
        if (initialBinding !== null) {
          await secretIngest.registerInitialDiscordBotTokenAlias(initialBinding.botTokenAlias);
        }
      },
    );
    const runtimePolicy = new MainConfigurationRuntimePolicy({
      service: configurationService,
      instanceId: configuration.instanceId,
      mainDeviceId: configuration.deviceId,
      taskDefaultId: MAIN_OWNER_TASK_DEFAULT_SCOPE_ID,
    });
    const taskService = new TaskService({
      clock: clock.asEventClock(),
      eventStore,
      resolveDefaultMode: () => runtimePolicy.taskDefaultMode(),
    });
    const continuationCheckpoints = new DurableTaskContinuationCheckpointService({
      eventStore,
      tasks: taskService,
    });
    const budget = new DurableTaskBudgetEnforcer({
      eventStore,
      clock,
      instanceLimits: DEFAULT_INSTANCE_BUDGET_LIMITS,
      requestedTaskDefaults: DEFAULT_REQUESTED_TASK_BUDGET_LIMITS,
      autonomousTaskDefaults: DEFAULT_AUTONOMOUS_TASK_BUDGET_LIMITS,
      usageProxy: DEFAULT_PROVIDER_USAGE_PROXY,
    });
    const budgetAdmin = createMainTaskBudgetAdmin(budget);
    approvalRepository = await openApprovalRepository(
      configuration.database,
      paths,
      "verify",
      managedSecretStore,
    );
    const actionApprovalExecutor = new LateBoundApprovalExecutionPort();
    const actionRunAuthority = new LateBoundMainActionRunAuthorityPort();
    const discordBindingLifecycle = new DiscordBindingConfigurationLifecycle(
      configuration.deviceId,
    );
    approvalRuntime = createConfigurationApprovalRuntime({
      configuration: configurationService,
      repository: approvalRepository,
      clock,
      idSource: {
        nextId: () => `approval_${randomUUID()}`,
      },
      lifecycle: discordBindingLifecycle,
      ...(configuration.deviceChannel === undefined
        ? {}
        : {
            additionalExecutors: [
              {
                kind: "worker-action.authorize",
                executor: actionApprovalExecutor,
              },
            ],
          }),
    });
    if (configuration.deviceChannel !== undefined) {
      actionAuthorizationRepository = await openActionAuthorizationRepository(
        configuration.database,
        paths,
        "verify",
        managedSecretStore,
      );
      actionAuthorization = new MainActionAuthorizationRuntime({
        repository: actionAuthorizationRepository,
        runAuthority: actionRunAuthority,
        clock,
        configuredPolicy: createConfigurationMainActionPolicy(runtimePolicy),
      });
      actionAuthorization.attachApprovalService(approvalRuntime.service);
      actionApprovalExecutor.bind(actionAuthorization);
    }
    const deviceProfiles = {
      get: async (deviceId: string): Promise<MainOwnedDeviceProfile | undefined> =>
        projectMainOwnedDeviceProfile(
          await configurationService.inspect({
            instanceId: configuration.instanceId,
            mainId: configuration.deviceId,
            deviceId,
          }),
        ),
    };
    let configurationToolBroker: ConfigurationServiceAgentToolBroker | undefined;
    if (options.agentConfiguration !== undefined) {
      configurationToolBroker = new ConfigurationServiceAgentToolBroker({
        service: configurationService,
        contextForDevice: (targetDeviceId) => ({
          instanceId: configuration.instanceId,
          mainId: configuration.deviceId,
          deviceId: targetDeviceId,
        }),
        authorizeMutation: authorizeMainConfigurationMutation,
        approvalRequester: approvalRuntime.requester,
      });
    }
    const configuredConfigurationAgent =
      options.configurationAgent ??
      (options.agentConfiguration === undefined
        ? undefined
        : new AgentBackedConfigurationAgent({
            adapter: options.agentConfiguration.adapter,
            sessionRepository: new EventStoreMainNativeSessionRepository(eventStore),
            eventStore,
            mainDeviceId: configuration.deviceId,
            workspace: options.agentConfiguration.workspace,
            sandbox: options.agentConfiguration.sandbox,
            permissions: options.agentConfiguration.permissions,
            limits: options.agentConfiguration.limits,
            toolBroker: configurationToolBroker!,
            secretLeakGuard: new ManagedSecretExactMatchGuard({
              secretStore: managedSecretStore,
              aliases: () =>
                Object.freeze([
                  ...secretIngest.managedSecretAliases(),
                  ...(configuration.database.adapter === "postgresql"
                    ? [mainSecretAlias(configuration.database.uriRef)]
                    : []),
                  ...(configuration.discord === undefined
                    ? []
                    : [configuration.discord.botTokenAlias]),
                ]),
            }),
            clock: clock.asEventClock(),
            ...(options.agentConfiguration.maximumPromptBytes === undefined
              ? {}
              : { maximumPromptBytes: options.agentConfiguration.maximumPromptBytes }),
            ...(options.agentConfiguration.maximumToolTurns === undefined
              ? {}
              : { maximumToolTurns: options.agentConfiguration.maximumToolTurns }),
          }));
    const agentReasoner =
      options.agentExecution === undefined
        ? undefined
        : new AgentBackedTaskExecutor({
            adapter: options.agentExecution.adapter,
            sessionRepository: new EventStoreMainNativeSessionRepository(eventStore),
            checkpoints: continuationCheckpoints,
            deviceId: configuration.deviceId,
            workspace: options.agentExecution.workspace,
            sandbox: options.agentExecution.sandbox,
            permissions: options.agentExecution.permissions,
            limits: options.agentExecution.limits,
            ...(options.agentExecution.maximumPromptBytes === undefined
              ? {}
              : { maximumPromptBytes: options.agentExecution.maximumPromptBytes }),
          });
    const routeIncidentDiagnosis =
      configuration.deviceChannel === undefined
        ? undefined
        : new MainRouteIncidentDiagnosisService({
            eventStore,
            ...(options.agentExecution === undefined
              ? {}
              : {
                  agent: createConfigurationControlledRouteDiagnosticAgent({
                    runtime: runtimePolicy,
                    agent: new AgentBackedRouteIncidentDiagnostic({
                      adapter: options.agentExecution.adapter,
                      deviceId: configuration.deviceId,
                      workspace: options.agentExecution.workspace,
                    }),
                  }),
                }),
          });
    assertMainSingletonOwnership(mainSingletonOwnership);
    await routeIncidentDiagnosis?.recoverInterrupted();
    assertMainSingletonOwnership(mainSingletonOwnership);
    let configuredTaskExecution = options.taskExecution;
    if (configuration.deviceChannel === undefined && agentReasoner !== undefined) {
      configuredTaskExecution = {
        executor: budgetedMainAgentExecutor(agentReasoner, budget),
        ...(options.agentExecution?.maximumConcurrentTasks === undefined
          ? {}
          : { maximumConcurrentTasks: options.agentExecution.maximumConcurrentTasks }),
        ...(options.agentExecution?.maximumAutomaticAttempts === undefined
          ? {}
          : {
              maximumAutomaticAttempts: options.agentExecution.maximumAutomaticAttempts,
            }),
        ...(options.agentExecution?.retryDelayMs === undefined
          ? {}
          : { retryDelayMs: options.agentExecution.retryDelayMs }),
      };
    }
    if (configuration.deviceChannel !== undefined) {
      if (options.deviceChannel === undefined) {
        throw new MainRuntimeError(
          "CONFIG_INVALID",
          "Configured Device channels require a Device identity Secret Store.",
        );
      }
      if (actionAuthorization === undefined) {
        throw new MainRuntimeError(
          "CONFIG_INVALID",
          "Configured Device channels require the Worker action authorization runtime.",
        );
      }
      const activeActionAuthorization = actionAuthorization;
      const channelReference: { current?: ProductionMainDeviceChannelRuntime } = {};
      deviceObservationRepository = await openDeviceObservationRepository(
        configuration.database,
        paths,
        "verify",
        managedSecretStore,
      );
      const durableDeviceObservations = deviceObservationRepository;
      fleet = new MainWorkerFleetProjection({
        identities: {
          list: async () => (await channelReference.current?.listDeviceIdentities()) ?? [],
        },
        observations: durableDeviceObservations,
        profiles: deviceProfiles,
        clock,
      });
      const runtimeFactory =
        options.deviceChannel.runtimeFactory ?? createProductionMainDeviceChannelRuntime;
      assertMainSingletonOwnership(mainSingletonOwnership);
      deviceChannel = await createDeviceChannelRuntimeWithDatabase({
        configuration: configuration.database,
        paths,
        secretStore: managedSecretStore,
        create: (database) =>
          runtimeFactory({
            clock,
            configuration: configuration.deviceChannel!,
            database,
            identitySecrets: options.deviceChannel!.identitySecrets,
            instanceId: configuration.instanceId,
            mainDeviceId: configuration.deviceId,
            sourceCheckout: options.sourceCheckout,
            ...(options.deviceChannel?.listenerFactory === undefined
              ? {}
              : { listenerFactory: options.deviceChannel.listenerFactory }),
            onHeartbeat: (deviceId, heartbeat) => fleet!.observeHeartbeat(deviceId, heartbeat),
            onEvents: async (deviceId, events) => {
              if (authoritativeWorkerExecutor === undefined) {
                throw new Error("The authoritative Worker executor is not ready.");
              }
              await authoritativeWorkerExecutor.acceptWorkerEvents(deviceId, events);
            },
            onArtifactPrepare: async (input) =>
              artifactPrepare?.prepare(input) ?? {
                status: "rejected",
                code: "SERVICE_UNAVAILABLE",
                retryable: true,
              },
            onActionAuthorize: (input) => activeActionAuthorization.authorize(input),
            onActionConsume: (input) => activeActionAuthorization.consume(input),
            onRunLeaseRenew: async (input) => {
              if (authoritativeWorkerExecutor === undefined) {
                throw new Error("The authoritative Worker executor is not ready.");
              }
              return await authoritativeWorkerExecutor.renewWorkerRunLease(
                input.authenticatedDeviceId,
                input.request,
              );
            },
            onRouteIncident: async (input) => {
              if (routeIncidentDiagnosis === undefined) {
                throw new Error("The route incident diagnosis service is not ready.");
              }
              await routeIncidentDiagnosis.handle(input);
            },
          }),
      });
      assertMainSingletonOwnership(mainSingletonOwnership);
      channelReference.current = deviceChannel;
      if (agentReasoner !== undefined) {
        authoritativeWorkerExecutor = new AuthoritativeWorkerTaskExecutor({
          eventStore,
          checkpoints: continuationCheckpoints,
          planner: agentReasoner,
          verifier: agentReasoner,
          targetResolver: new DeterministicWorkerTargetResolver({ candidates: fleet }),
          dispatch: new MainDeviceChannelWorkerRunDispatchPort(deviceChannel.workerChannel),
          clock,
          idSource: {
            nextId: (kind) => `${kind}_${randomUUID()}`,
          },
          budget,
        });
        actionRunAuthority.bind(authoritativeWorkerExecutor);
        configuredTaskExecution = {
          executor: authoritativeWorkerExecutor,
          ...(options.agentExecution?.maximumConcurrentTasks === undefined
            ? {}
            : { maximumConcurrentTasks: options.agentExecution.maximumConcurrentTasks }),
          ...(options.agentExecution?.maximumAutomaticAttempts === undefined
            ? {}
            : {
                maximumAutomaticAttempts: options.agentExecution.maximumAutomaticAttempts,
              }),
          ...(options.agentExecution?.retryDelayMs === undefined
            ? {}
            : { retryDelayMs: options.agentExecution.retryDelayMs }),
        };
      }
    }
    if (configuredTaskExecution !== undefined) {
      const taskExecutionOptions: TaskExecutionCoordinatorOptions = {
        taskService,
        executor: configuredTaskExecution.executor,
        budget,
        deferExecutionUntilStart: true,
        ...(configuredTaskExecution.maximumConcurrentTasks === undefined
          ? {}
          : { maximumConcurrentTasks: configuredTaskExecution.maximumConcurrentTasks }),
        ...(configuredTaskExecution.maximumAutomaticAttempts === undefined
          ? {}
          : { maximumAutomaticAttempts: configuredTaskExecution.maximumAutomaticAttempts }),
        ...(configuredTaskExecution.retryDelayMs === undefined
          ? {}
          : { retryDelayMs: configuredTaskExecution.retryDelayMs }),
      };
      taskExecution = new TaskExecutionCoordinator(taskExecutionOptions);
    }
    const tasks = taskExecution ?? taskService;
    const runtimeFeatures: NonNullable<MainControlPlaneAppOptions["runtimeFeatures"]> = {
      ...projectRuntimeReleaseIdentity(options.releaseIdentity),
      taskExecution:
        taskExecution === undefined
          ? {
              status: "unavailable" as const,
              code: "ORCHESTRATION_NOT_CONNECTED",
            }
          : {
              status: "ready" as const,
              code: "TASK_EXECUTION_READY",
            },
      configurationAgent:
        configuredConfigurationAgent === undefined
          ? {
              status: "unavailable" as const,
              code: "CONFIGURATION_AGENT_NOT_CONNECTED",
            }
          : {
              status: "ready" as const,
              code: "CONFIGURATION_AGENT_READY",
            },
      discord: {
        status: "unavailable" as const,
        code: "DISCORD_NOT_CONFIGURED",
      },
    };
    if (configuration.artifacts !== undefined) {
      assertMainSingletonOwnership(mainSingletonOwnership);
      artifacts = await createProductionMainArtifactRuntime({
        configuration: configuration.artifacts,
        home: paths.home,
        sourceCheckout: options.sourceCheckout,
        deviceId: configuration.deviceId,
        adminListeners: [
          {
            host: configuration.main.host,
            port: configuration.main.port,
            origin: configuration.main.origin,
          },
        ],
        environment,
        indexRepositoryFactory: () =>
          openArtifactIndexRepository(configuration.database, paths, "verify", managedSecretStore),
      });
      assertMainSingletonOwnership(mainSingletonOwnership);
      if (authoritativeWorkerExecutor !== undefined) {
        artifactPrepare = new MainArtifactPrepareService({
          runAuthority: authoritativeWorkerExecutor,
          artifactRuntime: artifacts,
          policy:
            options.artifactPreparePolicy ??
            createConfigurationMainArtifactPreparePolicy(runtimePolicy),
          clock: { nowMs: () => clock.now() },
        });
      }
    }
    const ownerDiscordStatusObserver = options.discord?.onStatusChange;
    const discordSecretStore = options.discord?.secretStore ?? managedSecretStore;
    discordBindingController = new DiscordBindingController<DiscordMainRuntime>({
      credentialCapability: async (alias) => {
        if (!secretIngest.hasAliasPurpose(alias, "discord-bot-token")) {
          return undefined;
        }
        const availability = await discordSecretStore.availability(alias).catch(() => undefined);
        return {
          purpose: "discord-bot-token",
          available: availability?.alias === alias && availability.ready,
        };
      },
      createRuntime: (binding, observeRuntimeStatus) =>
        createDiscordRuntimeWithDatabase({
          configuration: configuration.database,
          paths,
          secretStore: managedSecretStore,
          create: (database) =>
            createProductionDiscordRuntime({
              ...(options.discord ?? {}),
              config: binding.forum,
              botTokenAlias: binding.botTokenAlias,
              secretStore: discordSecretStore,
              mainDeviceId: configuration.deviceId,
              productVersion: options.build.version,
              database,
              tasks,
              ...(artifacts === undefined
                ? {}
                : {
                    artifactPresentation: new DiscordArtifactPresentation({
                      adminOrigin: configuration.main.origin,
                      configuration: artifacts.configuration,
                      store: artifacts.store,
                    }),
                  }),
              onStatusChange: observeRuntimeStatus,
            }),
        }),
      onStatusChange: (status) => {
        runtimeFeatures.discord = Object.freeze({
          status: status.status,
          code: status.code,
        });
        ownerDiscordStatusObserver?.(status);
      },
    });
    if (ownershipLossPending) {
      void discordBindingController.close().catch(() => undefined);
    }
    discordBindingLifecycle.bind(discordBindingController);
    const discordBinding = await resolveEffectiveDiscordBinding({
      service: configurationService,
      configuration,
    });
    try {
      assertMainSingletonOwnership(mainSingletonOwnership);
      await discordBindingController.start(discordBinding);
      assertMainSingletonOwnership(mainSingletonOwnership);
    } catch (error) {
      if (isMainSingletonOwnershipFailure(error)) {
        throw mapMainSingletonOwnershipError(error);
      }
      runtimeFeatures.discord = {
        status: "unavailable",
        code: "DISCORD_COMPOSITION_UNAVAILABLE",
      };
    }
    assertMainSingletonOwnership(mainSingletonOwnership);
    await approvalRuntime.service.reconcileInterruptedExecutions();
    assertMainSingletonOwnership(mainSingletonOwnership);
    if (taskExecution !== undefined) {
      assertMainSingletonOwnership(mainSingletonOwnership);
      await taskExecution.start();
      assertMainSingletonOwnership(mainSingletonOwnership);
    }
    const tls =
      configuration.main.tls === undefined
        ? undefined
        : {
            certificate: await readFile(configuration.main.tls.certificatePath),
            privateKey: await readFile(configuration.main.tls.privateKeyPath),
          };
    const adminOperations = createMainAdminOperations({
      mainDeviceId: configuration.deviceId,
      idempotencyDirectory: join(paths.stateDirectory, "admin-operation-idempotency"),
      eventStore,
      clock,
      ownerAuthAudits: ownerRepository,
      ...(actionAuthorization === undefined
        ? {}
        : { actionAuthorizationAudits: actionAuthorization }),
      configurationAudits: configurationService,
      approvalAudits: approvalRuntime.service,
      ...(deviceChannel === undefined ? {} : { deviceChannel }),
      ...(configuration.deviceChannel === undefined
        ? {}
        : { deviceChannelConfiguration: configuration.deviceChannel }),
      ...(artifacts === undefined ? {} : { artifacts }),
    });
    assertMainSingletonOwnership(mainSingletonOwnership);
    const readiness: NonNullable<MainControlPlaneAppOptions["readiness"]> = async () => {
      try {
        assertMainSingletonOwnership(mainSingletonOwnership);
      } catch (error) {
        const ownershipError = normalizeMainSingletonOwnershipError(error);
        return {
          status: "not-ready" as const,
          checks: [
            {
              status: "not-ready" as const,
              code: ownershipError.code,
            },
          ],
        };
      }
      await eventStore.streamVersion("opendelegate:readiness");
      const artifactHealth = await artifacts?.health();
      const artifactReady = artifactHealth === undefined || artifactHealth.status === "ready";
      return {
        status: artifactReady ? ("ready" as const) : ("not-ready" as const),
        checks: [
          { status: "ready" as const, code: "DATABASE_READY" },
          { status: "ready" as const, code: "CONTROL_PLANE_READY" },
          ...(deviceChannel === undefined
            ? []
            : [{ status: "ready" as const, code: "DEVICE_CHANNEL_READY" }]),
          ...(artifactHealth === undefined
            ? []
            : [
                {
                  status: artifactReady ? ("ready" as const) : ("not-ready" as const),
                  code: artifactHealth.code,
                },
              ]),
        ],
      };
    };
    const probeConnectedMainWorkerCapability = async (
      name: "browser-automation" | "computer-use",
    ): Promise<CapabilityAssessmentProbe> => {
      const worker = ((await fleet?.deviceSummaries()) ?? []).find(
        (candidate) =>
          candidate.deviceId === configuration.deviceId &&
          candidate.role === "worker" &&
          candidate.connection === "online",
      );
      const capability = worker?.capabilities?.find((candidate) => candidate.name === name);
      if (worker === undefined || capability === undefined) {
        return { verification: "unavailable" };
      }
      return {
        verification: capability.verification,
        ...(capability.observedAtMs === undefined
          ? worker.lastObservation === undefined
            ? {}
            : { observedAtMs: worker.lastObservation.observedAtMs }
          : { observedAtMs: capability.observedAtMs }),
        ...(capability.version === undefined ? {} : { version: capability.version }),
      };
    };
    const mainDeviceAssessment =
      options.mainDeviceAssessment === undefined
        ? undefined
        : new MainDeviceAssessmentService({
            deviceId: configuration.deviceId,
            knowledgeDirectory: paths.knowledgeDirectory,
            repository: mainDeviceAssessmentRepository,
            probeAgentAdapters: options.mainDeviceAssessment.probeAgentAdapters,
            probeBrowserAutomation:
              options.mainDeviceAssessment.probeBrowserAutomation ??
              (() => probeConnectedMainWorkerCapability("browser-automation")),
            probeComputerUse:
              options.mainDeviceAssessment.probeComputerUse ??
              (() => probeConnectedMainWorkerCapability("computer-use")),
            clock,
          });
    app = await createMainControlPlaneApp({
      ownerAuth,
      allowedOrigins: [configuration.main.origin],
      build: options.build,
      runtimeFeatures,
      deviceDirectory: {
        list: async () => {
          const mainProfile = await deviceProfiles.get(configuration.deviceId);
          const [mergedMain, ...remoteWorkers] = mergeMainDeviceSummary(
            {
              deviceId: configuration.deviceId,
              name: mainProfile?.displayName ?? hostname(),
              osFamily: currentOsFamily(),
              platformRelease: release(),
              architecture: arch(),
              role: "main",
              connection: "online",
              runtime: "healthy",
              serviceMode: "foreground",
              roles: [...(mainProfile?.roles ?? ["main-coordinator"])],
              instructions: [...(mainProfile?.instructions ?? [])],
              policies: [...(mainProfile?.policies ?? [])],
              routes: [
                {
                  routeId: `main-local:${configuration.deviceId}`,
                  label: "Main-local",
                  priority: 0,
                  health: "healthy" as const,
                },
              ],
              knowledgeHealth: "unknown" as const,
            },
            (await fleet?.deviceSummaries()) ?? [],
          );
          if (mergedMain === undefined) {
            throw new Error("The Device directory did not retain Main's Device.");
          }
          return [
            projectMainDeviceAssessment(
              mergedMain,
              await mainDeviceAssessmentRepository.latest(configuration.deviceId),
            ),
            ...remoteWorkers,
          ];
        },
      },
      ...(mainDeviceAssessment === undefined
        ? {}
        : {
            deviceAssessment: {
              canAssess: (deviceId: string) => deviceId === configuration.deviceId,
              assess: async ({
                deviceId,
                principalId,
                idempotencyKey,
              }: {
                readonly deviceId: string;
                readonly principalId: string;
                readonly idempotencyKey: string;
              }) => {
                if (deviceId !== configuration.deviceId) return;
                await mainDeviceAssessment.assess({ principalId, idempotencyKey });
              },
            },
          }),
      tasks,
      budgets: budgetAdmin,
      approvals: approvalRuntime.controlPlane,
      enrollment: adminOperations.enrollment,
      artifacts: adminOperations.artifacts,
      audit: adminOperations.audit,
      ...(secretIngest === undefined ? {} : { secretIngest }),
      ...(configuredConfigurationAgent === undefined
        ? {}
        : { configurationAgent: configuredConfigurationAgent }),
      ...(tls === undefined ? {} : { tls }),
      readiness,
    });
    assertMainSingletonOwnership(mainSingletonOwnership);
    await registerAdminAssets(app, configuration.adminRoot);
    await app.ready();
    assertMainSingletonOwnership(mainSingletonOwnership);
    await sealRuntimeState(paths);
    assertMainSingletonOwnership(mainSingletonOwnership);

    const activeMainSingletonOwnership = requireMainSingletonOwnership(mainSingletonOwnership);
    const cleanupOperations = (): Parameters<typeof closeMainResources>[0] => [
      { operation: "discord", close: () => discordBindingController?.close() },
      { operation: "control-plane", close: () => app?.close() },
      { operation: "artifacts", close: () => artifacts?.close() },
      { operation: "task-execution", close: () => taskExecution?.close() },
      {
        operation: "device-channel-and-action-authorization",
        close: async () => {
          try {
            await deviceChannel?.close();
          } finally {
            if (actionAuthorization === undefined) {
              await actionAuthorizationRepository?.close();
            } else {
              await actionAuthorization.close();
            }
          }
        },
      },
      {
        operation: "approval-repository",
        close: () => approvalRepository?.close(),
      },
      {
        operation: "device-observation-repository",
        close: () => deviceObservationRepository?.close(),
      },
      {
        operation: "configuration-repository",
        close: () => configurationRepository?.close(),
      },
      { operation: "event-store", close: () => eventStore.close() },
      { operation: "owner-auth-repository", close: () => ownerRepository?.close() },
    ];
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= closeMainSingletonOwnedResources(
        activeMainSingletonOwnership,
        ownershipLossUnsubscribe,
        cleanupOperations(),
      );
      return closePromise;
    };
    closeAfterOwnershipLoss = close;
    const runtime: MainRuntime = {
      app,
      configuration,
      ownerAuth,
      paths,
      tasks,
      ...(taskExecution === undefined ? {} : { taskExecution }),
      get discord() {
        return discordBindingController?.runtime;
      },
      ...(artifacts === undefined ? {} : { artifacts }),
      ...(deviceChannel === undefined ? {} : { deviceChannel }),
      budget,
      readiness,
      close,
    };
    singletonOwnershipByRuntime.set(runtime, activeMainSingletonOwnership);
    if (ownershipLossPending) {
      void close().catch(() => undefined);
    }
    return runtime;
  } catch (error) {
    const primaryError = mapMainSingletonOwnershipError(error);
    const cleanupOperations: Parameters<typeof closeMainResources>[0] = [
      { operation: "discord", close: () => discordBindingController?.close() },
      { operation: "control-plane", close: () => app?.close() },
      { operation: "artifacts", close: () => artifacts?.close() },
      { operation: "task-execution", close: () => taskExecution?.close() },
      {
        operation: "device-channel-and-action-authorization",
        close: async () => {
          try {
            await deviceChannel?.close();
          } finally {
            if (actionAuthorization === undefined) {
              await actionAuthorizationRepository?.close();
            } else {
              await actionAuthorization.close();
            }
          }
        },
      },
      {
        operation: "approval-repository",
        close: () => approvalRepository?.close(),
      },
      {
        operation: "device-observation-repository",
        close: () => deviceObservationRepository?.close(),
      },
      {
        operation: "configuration-repository",
        close: () => configurationRepository?.close(),
      },
      { operation: "event-store", close: () => eventStore.close() },
      { operation: "owner-auth-repository", close: () => ownerRepository?.close() },
    ];
    if (mainSingletonOwnership === undefined) {
      return closeAfterPrimaryFailure(primaryError, cleanupOperations);
    }
    const activeMainSingletonOwnership = mainSingletonOwnership;
    return closeAfterPrimaryFailure(primaryError, [
      {
        operation: "singleton-owned-main-runtime",
        close: () =>
          closeMainSingletonOwnedResources(
            activeMainSingletonOwnership,
            ownershipLossUnsubscribe,
            cleanupOperations,
          ),
      },
    ]);
  }
}

function currentOsFamily(): "macos" | "windows" | "linux" {
  switch (platform()) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      throw new MainRuntimeError(
        "CONFIG_INVALID",
        "This OpenDelegate release supports macOS, Windows, and Linux.",
      );
  }
}

function budgetedMainAgentExecutor(
  executor: AgentBackedTaskExecutor,
  budget: TaskBudgetAdministrationPort,
): TaskExecutor {
  const wrapped: TaskExecutor = {
    execute: async (request) => {
      await budget.beginNativeTurn({
        taskId: request.task.taskId,
        operationId: `${request.executionKey}:main-agent-native-turn`,
        source: "main-planner",
      });
      return executor.execute(request);
    },
    cancel: (request) => executor.cancel(request),
  };
  return Object.freeze(wrapped);
}

export function projectMainOwnedDeviceProfile(
  values: Readonly<Record<string, EffectiveConfigurationValue>>,
): MainOwnedDeviceProfile | undefined {
  const displayName = explicitConfigurationValue(values, "device.display-name");
  const roles = explicitConfigurationValue(values, "device.roles");
  const instructions = explicitConfigurationValue(values, "device.instructions");
  const policies: NonNullable<MainOwnedDeviceProfile["policies"]> = Object.freeze([
    effectiveDevicePolicy(
      values,
      "policy.official-package-install",
      "configured-official-package-install",
      "allow",
    ),
    effectiveDevicePolicy(values, "policy.network-change", "os-network-change", "require-approval"),
    Object.freeze({
      policyId: "built-in-secret-export",
      actionCategory: "secret-export",
      decision: "deny" as const,
      source: "built-in" as const,
      effectiveScope: "instance" as const,
    }),
    Object.freeze({
      policyId: "built-in-cross-device-knowledge-transfer",
      actionCategory: "cross-device-knowledge-transfer",
      decision: "deny" as const,
      source: "built-in" as const,
      effectiveScope: "instance" as const,
    }),
    Object.freeze({
      policyId: "built-in-policy-bypass-attempt",
      actionCategory: "policy-bypass-attempt",
      decision: "deny" as const,
      source: "built-in" as const,
      effectiveScope: "instance" as const,
    }),
  ]);
  return Object.freeze({
    ...(displayName === null || displayName === undefined
      ? {}
      : { displayName: requireProfileString(displayName, "Device display name") }),
    ...(roles === undefined ? {} : { roles: requireProfileStringList(roles, "Device roles") }),
    ...(instructions === undefined
      ? {}
      : {
          instructions: requireProfileStringList(instructions, "Device instructions"),
        }),
    policies,
  });
}

function effectiveDevicePolicy(
  values: Readonly<Record<string, EffectiveConfigurationValue>>,
  key: string,
  actionCategory: string,
  defaultDecision: "allow" | "require-approval" | "deny",
): NonNullable<MainOwnedDeviceProfile["policies"]>[number] {
  const effective = values[key];
  const decision = effective?.value ?? defaultDecision;
  if (decision !== "allow" && decision !== "require-approval" && decision !== "deny") {
    throw new MainRuntimeError("CONFIG_INVALID", `${key} is invalid.`);
  }
  const source = effective?.source;
  const effectiveScope =
    source === undefined || source === "default"
      ? "instance"
      : source.kind === "instance" || source.kind === "main" || source.kind === "device"
        ? source.kind
        : "instance";
  return Object.freeze({
    policyId: key,
    actionCategory,
    decision,
    source: source === undefined || source === "default" ? "built-in" : "configuration",
    effectiveScope,
  });
}

function explicitConfigurationValue(
  values: Readonly<Record<string, EffectiveConfigurationValue>>,
  key: string,
): unknown | undefined {
  const value = values[key];
  return value === undefined || value.source === "default" ? undefined : value.value;
}

function requireProfileString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new MainRuntimeError("CONFIG_INVALID", `${label} is invalid.`);
  }
  return value;
}

function requireProfileStringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new MainRuntimeError("CONFIG_INVALID", `${label} are invalid.`);
  }
  return Object.freeze([...value] as string[]);
}

export async function listenMainRuntime(runtime: MainRuntime): Promise<ListeningMainRuntime> {
  try {
    const ownership = requireMainSingletonOwnership(singletonOwnershipByRuntime.get(runtime));
    assertMainSingletonOwnership(ownership);
    const address = await runtime.app.listen({
      host: runtime.configuration.main.host,
      port: runtime.configuration.main.port,
      listenTextResolver: (value) => value,
    });
    assertMainSingletonOwnership(ownership);
    return Object.assign(runtime, { address });
  } catch (error) {
    return closeAfterPrimaryFailure(mapMainSingletonOwnershipError(error), [
      {
        operation: "main-runtime",
        close: () => runtime.close(),
      },
    ]);
  }
}

function validateMainSingletonOwnership(value: unknown): MainSingletonOwnership {
  if (
    !isRecord(value) ||
    (value["backend"] !== "sqlite" && value["backend"] !== "postgresql") ||
    typeof value["assertCurrent"] !== "function" ||
    typeof value["onLost"] !== "function" ||
    typeof value["release"] !== "function"
  ) {
    throw new MainRuntimeError(
      "MAIN_OWNERSHIP_UNAVAILABLE",
      "The Main singleton ownership provider returned an invalid authority.",
    );
  }
  return value as unknown as MainSingletonOwnership;
}

function requireMainSingletonOwnership(
  ownership: MainSingletonOwnership | undefined,
): MainSingletonOwnership {
  if (ownership === undefined) {
    throw new MainRuntimeError(
      "MAIN_OWNERSHIP_UNAVAILABLE",
      "Main has no exclusive singleton authority.",
    );
  }
  return ownership;
}

function assertMainSingletonOwnership(ownership: MainSingletonOwnership | undefined): void {
  try {
    requireMainSingletonOwnership(ownership).assertCurrent();
  } catch (error) {
    throw normalizeMainSingletonOwnershipError(error);
  }
}

function isMainSingletonOwnershipFailure(error: unknown): boolean {
  return (
    error instanceof MainSingletonOwnershipError ||
    (error instanceof MainRuntimeError &&
      (error.code === "MAIN_ALREADY_RUNNING" ||
        error.code === "MAIN_OWNERSHIP_LOST" ||
        error.code === "MAIN_OWNERSHIP_UNAVAILABLE"))
  );
}

function mapMainSingletonOwnershipError(error: unknown): unknown {
  if (error instanceof MainSingletonOwnershipError) {
    return new MainRuntimeError(error.code, error.message, { cause: error });
  }
  return error;
}

function normalizeMainSingletonOwnershipError(error: unknown): MainRuntimeError {
  const mapped = mapMainSingletonOwnershipError(error);
  if (mapped instanceof MainRuntimeError && isMainSingletonOwnershipFailure(mapped)) {
    return mapped;
  }
  return new MainRuntimeError(
    "MAIN_OWNERSHIP_UNAVAILABLE",
    "Main could not verify its exclusive singleton authority.",
    { cause: error },
  );
}

async function closeMainSingletonOwnedResources(
  ownership: MainSingletonOwnership,
  unsubscribe: (() => void) | undefined,
  operations: Parameters<typeof closeMainResources>[0],
): Promise<void> {
  await closeMainResources(operations);
  unsubscribe?.();
  await ownership.release();
}

async function resolveEffectiveDiscordBinding(input: {
  readonly service: ConfigurationService;
  readonly configuration: MainConfiguration;
}): Promise<MainDiscordBindingConfiguration | null> {
  const effective = await input.service.inspect({
    instanceId: input.configuration.instanceId,
    mainId: input.configuration.deviceId,
    deviceId: input.configuration.deviceId,
  });
  const configured = effective[MAIN_DISCORD_BINDING_CONFIGURATION_KEY];
  if (configured !== undefined && configured.candidates.length > 0) {
    return configured.value === null
      ? null
      : validateMainDiscordBindingConfiguration(configured.value);
  }
  throw new MainRuntimeError(
    "CONFIG_MIGRATION_REQUIRED",
    "The durable Discord binding marker is missing. Restart Main with a compatible release before changing Discord configuration.",
  );
}

function initialDiscordBinding(
  configuration: MainConfiguration,
  runtimeOptions: CreateMainRuntimeOptions["discord"],
): MainDiscordBindingConfiguration | null {
  if (configuration.discord !== undefined) {
    return toMainDiscordBindingConfiguration(configuration.discord);
  }
  return runtimeOptions === undefined
    ? null
    : validateMainDiscordBindingConfiguration({
        schemaVersion: 1,
        enabled: true,
        botTokenAlias: runtimeOptions.botTokenAlias,
        forum: runtimeOptions.config,
      });
}

async function createDiscordRuntimeWithDatabase(input: {
  readonly configuration: MainDatabaseConfiguration;
  readonly paths: RuntimePaths;
  readonly secretStore: ManagedSecretStore;
  readonly create: (
    database: CreateProductionDiscordRuntimeOptions["database"],
  ) => Promise<DiscordMainRuntime>;
}): Promise<DiscordMainRuntime> {
  if (input.configuration.adapter === "sqlite") {
    return input.create({
      adapter: "sqlite",
      filename: input.paths.sqliteFile,
      migrationMode: "verify",
    });
  }
  const postgresql = input.configuration;
  let runtime: DiscordMainRuntime | undefined;
  await executeMainWithPostgresUri(input.secretStore, postgresql.uriRef, async (uri) => {
    runtime = await input.create({
      adapter: "postgresql",
      connectionString: uri,
      migrationMode: "verify",
      ...(postgresql.schema === undefined ? {} : { schema: postgresql.schema }),
    });
  });
  if (runtime === undefined) {
    throw databaseSecretUnavailable();
  }
  return runtime;
}

async function createDeviceChannelRuntimeWithDatabase(input: {
  readonly configuration: MainDatabaseConfiguration;
  readonly paths: RuntimePaths;
  readonly secretStore: ManagedSecretStore;
  readonly create: (
    database: Parameters<typeof createProductionMainDeviceChannelRuntime>[0]["database"],
  ) => Promise<ProductionMainDeviceChannelRuntime>;
}): Promise<ProductionMainDeviceChannelRuntime> {
  if (input.configuration.adapter === "sqlite") {
    return input.create({
      adapter: "sqlite",
      filename: input.paths.sqliteFile,
    });
  }
  const postgresql = input.configuration;
  let runtime: ProductionMainDeviceChannelRuntime | undefined;
  await executeMainWithPostgresUri(input.secretStore, postgresql.uriRef, async (uri) => {
    runtime = await input.create({
      adapter: "postgresql",
      connectionString: uri,
      ...(postgresql.schema === undefined ? {} : { schema: postgresql.schema }),
    });
  });
  if (runtime === undefined) {
    throw databaseSecretUnavailable();
  }
  return runtime;
}

async function applyInitialMigrations(input: {
  readonly configuration: MainConfiguration;
  readonly paths: RuntimePaths;
  readonly managedSecretStore: ManagedSecretStore;
}): Promise<void> {
  const clock = new SystemClock();
  const store = await openEventStore(
    input.configuration.database,
    input.paths,
    clock,
    "apply",
    input.managedSecretStore,
  );
  await store.close();
}

async function openEventStore(
  configuration: MainDatabaseConfiguration,
  paths: RuntimePaths,
  clock: SystemClock,
  migrationMode: SqlMigrationMode,
  secretStore: ManagedSecretStore,
): Promise<SqlEventStore> {
  if (configuration.adapter === "sqlite") {
    return SqlEventStore.openSqlite({
      clock: clock.asEventClock(),
      filename: paths.sqliteFile,
      migrationMode,
    });
  }
  let repository: SqlEventStore | undefined;
  await executeMainWithPostgresUri(secretStore, configuration.uriRef, async (uri) => {
    repository = await SqlEventStore.openPostgres({
      clock: clock.asEventClock(),
      connectionString: uri,
      migrationMode,
      ...(configuration.schema === undefined ? {} : { schema: configuration.schema }),
    });
  });
  if (repository === undefined) {
    throw databaseSecretUnavailable();
  }
  return repository;
}

async function openOwnerRepository(
  configuration: MainDatabaseConfiguration,
  paths: RuntimePaths,
  migrationMode: SqlMigrationMode,
  secretStore: ManagedSecretStore,
): Promise<SqlOwnerAuthRepository> {
  if (configuration.adapter === "sqlite") {
    return SqlOwnerAuthRepository.openSqlite({
      filename: paths.sqliteFile,
      migrationMode,
    });
  }
  let repository: SqlOwnerAuthRepository | undefined;
  await executeMainWithPostgresUri(secretStore, configuration.uriRef, async (uri) => {
    repository = await SqlOwnerAuthRepository.openPostgres({
      connectionString: uri,
      migrationMode,
      ...(configuration.schema === undefined ? {} : { schema: configuration.schema }),
    });
  });
  if (repository === undefined) {
    throw databaseSecretUnavailable();
  }
  return repository;
}

async function openConfigurationRepository(
  configuration: MainDatabaseConfiguration,
  paths: RuntimePaths,
  migrationMode: SqlMigrationMode,
  secretStore: ManagedSecretStore,
): Promise<SqlConfigurationRepository> {
  if (configuration.adapter === "sqlite") {
    return SqlConfigurationRepository.openSqlite({
      filename: paths.sqliteFile,
      migrationMode,
    });
  }
  let repository: SqlConfigurationRepository | undefined;
  await executeMainWithPostgresUri(secretStore, configuration.uriRef, async (uri) => {
    repository = await SqlConfigurationRepository.openPostgres({
      connectionString: uri,
      migrationMode,
      ...(configuration.schema === undefined ? {} : { schema: configuration.schema }),
    });
  });
  if (repository === undefined) {
    throw databaseSecretUnavailable();
  }
  return repository;
}

async function openDeviceObservationRepository(
  configuration: MainDatabaseConfiguration,
  paths: RuntimePaths,
  migrationMode: SqlMigrationMode,
  secretStore: ManagedSecretStore,
): Promise<SqlDeviceObservationRepository> {
  if (configuration.adapter === "sqlite") {
    return SqlDeviceObservationRepository.openSqlite({
      filename: paths.sqliteFile,
      migrationMode,
    });
  }
  let repository: SqlDeviceObservationRepository | undefined;
  await executeMainWithPostgresUri(secretStore, configuration.uriRef, async (uri) => {
    repository = await SqlDeviceObservationRepository.openPostgres({
      connectionString: uri,
      migrationMode,
      ...(configuration.schema === undefined ? {} : { schema: configuration.schema }),
    });
  });
  if (repository === undefined) {
    throw databaseSecretUnavailable();
  }
  return repository;
}

async function openApprovalRepository(
  configuration: MainDatabaseConfiguration,
  paths: RuntimePaths,
  migrationMode: SqlMigrationMode,
  secretStore: ManagedSecretStore,
): Promise<SqlApprovalRepository> {
  if (configuration.adapter === "sqlite") {
    return SqlApprovalRepository.openSqlite({
      filename: paths.sqliteFile,
      migrationMode,
    });
  }
  let repository: SqlApprovalRepository | undefined;
  await executeMainWithPostgresUri(secretStore, configuration.uriRef, async (uri) => {
    repository = await SqlApprovalRepository.openPostgres({
      connectionString: uri,
      migrationMode,
      ...(configuration.schema === undefined ? {} : { schema: configuration.schema }),
    });
  });
  if (repository === undefined) {
    throw databaseSecretUnavailable();
  }
  return repository;
}

async function openActionAuthorizationRepository(
  configuration: MainDatabaseConfiguration,
  paths: RuntimePaths,
  migrationMode: SqlMigrationMode,
  secretStore: ManagedSecretStore,
): Promise<SqlActionAuthorizationRepository> {
  if (configuration.adapter === "sqlite") {
    return SqlActionAuthorizationRepository.openSqlite({
      filename: paths.sqliteFile,
      migrationMode,
    });
  }
  let repository: SqlActionAuthorizationRepository | undefined;
  await executeMainWithPostgresUri(secretStore, configuration.uriRef, async (uri) => {
    repository = await SqlActionAuthorizationRepository.openPostgres({
      connectionString: uri,
      migrationMode,
      ...(configuration.schema === undefined ? {} : { schema: configuration.schema }),
    });
  });
  if (repository === undefined) {
    throw databaseSecretUnavailable();
  }
  return repository;
}

async function openArtifactIndexRepository(
  configuration: MainDatabaseConfiguration,
  paths: RuntimePaths,
  migrationMode: SqlMigrationMode,
  secretStore: ManagedSecretStore,
): Promise<SqlArtifactIndexRepository> {
  if (configuration.adapter === "sqlite") {
    return SqlArtifactIndexRepository.openSqlite({
      filename: paths.sqliteFile,
      migrationMode,
    });
  }
  let repository: SqlArtifactIndexRepository | undefined;
  await executeMainWithPostgresUri(secretStore, configuration.uriRef, async (uri) => {
    repository = await SqlArtifactIndexRepository.openPostgres({
      connectionString: uri,
      migrationMode,
      ...(configuration.schema === undefined ? {} : { schema: configuration.schema }),
    });
  });
  if (repository === undefined) {
    throw databaseSecretUnavailable();
  }
  return repository;
}

async function seedInitialMainConfiguration(
  service: ConfigurationService,
  configuration: MainConfiguration,
  initialAdminAutoOpen?: boolean,
  initialDiscordBindingConfiguration: MainDiscordBindingConfiguration | null = null,
  beforeInitialApply?: () => Promise<void>,
): Promise<void> {
  const revision = await service.getRevision();
  if (revision !== 0) {
    const effective = await service.inspect({
      instanceId: configuration.instanceId,
      mainId: configuration.deviceId,
      deviceId: configuration.deviceId,
    });
    if (initialAdminAutoOpen !== undefined) {
      if (effective["admin.open-on-login"]?.value !== initialAdminAutoOpen) {
        throw new MainRuntimeError(
          "CONFIG_EXISTS",
          "Main already has a different durable Admin auto-open preference. Change it through Configuration Chat and the explicit service reconfigure flow.",
        );
      }
    }
    if (effective[MAIN_DISCORD_BINDING_CONFIGURATION_KEY]?.candidates.length === 0) {
      const proposal = await service.propose({
        actor: "opendelegate-runtime-migration",
        reason:
          "Mark the pre-dynamic Discord state as disabled; a new binding requires normal owner Approval.",
        changes: [
          {
            operation: "set",
            key: MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
            scope: { kind: "main", id: configuration.deviceId },
            value: null,
          },
        ],
      });
      await service.apply({
        proposalId: proposal.id,
        expectedRevision: revision,
        actor: "opendelegate-runtime-migration",
      });
    }
    return;
  }
  await beforeInitialApply?.();
  const changes: ConfigurationChange[] = [
    {
      operation: "set",
      key: "database.adapter",
      scope: { kind: "main", id: configuration.deviceId },
      value: configuration.database.adapter,
    },
    ...(initialAdminAutoOpen === undefined
      ? []
      : [
          {
            operation: "set" as const,
            key: "admin.open-on-login",
            scope: { kind: "main" as const, id: configuration.deviceId },
            value: initialAdminAutoOpen,
          },
        ]),
    ...(configuration.database.adapter === "postgresql"
      ? [
          {
            operation: "set" as const,
            key: "database.uri-ref",
            scope: { kind: "main" as const, id: configuration.deviceId },
            value: { secretRef: configuration.database.uriRef },
          },
        ]
      : []),
    ...(configuration.artifacts === undefined
      ? []
      : [
          {
            operation: "set" as const,
            key: "artifact.exposure",
            scope: { kind: "instance" as const, id: configuration.instanceId },
            value: configuration.artifacts.exposure.defaultMode,
          },
        ]),
    {
      operation: "set",
      key: MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
      scope: { kind: "main", id: configuration.deviceId },
      value: initialDiscordBindingConfiguration,
    },
  ];
  const proposal = await service.propose({
    actor: "opendelegate-init",
    reason: "Record the owner-selected installation settings as runtime Configuration.",
    changes,
  });
  await service.apply({
    proposalId: proposal.id,
    expectedRevision: 0,
    actor: "opendelegate-init",
  });
}

function resolveMainManagedSecretStore(input: {
  readonly configuration: MainConfiguration;
  readonly sourceCheckout: string;
  environment: Readonly<Record<string, string | undefined>>;
  readonly injected?: ManagedSecretStore;
}): ManagedSecretStore {
  const store =
    input.injected ??
    createMainManagedSecretStore({
      configuration: input.configuration.secretBackend,
      deviceId: input.configuration.deviceId,
      sourceCheckout: input.sourceCheckout,
      environment: input.environment,
    });
  if (store.deviceId !== input.configuration.deviceId) {
    throw new MainRuntimeError(
      "DATABASE_SECRET_UNAVAILABLE",
      "The configured Main Secret Store belongs to another Device.",
    );
  }
  return store;
}

async function executeMainWithPostgresUri(
  store: ManagedSecretStore,
  reference: string,
  executor: (uri: string) => void | Promise<void>,
): Promise<void> {
  try {
    await executeWithPostgresUri(store, reference, executor);
  } catch (error) {
    throw databaseSecretUnavailable(error);
  }
}

async function provisionDatabaseSecret(
  configuration: MainDatabaseConfiguration,
  store: ManagedSecretStore,
  secret: Uint8Array | undefined,
): Promise<void> {
  if (secret === undefined) {
    return;
  }
  if (configuration.adapter !== "postgresql") {
    secret.fill(0);
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "A database Secret can be provisioned only for PostgreSQL.",
    );
  }
  let material: Buffer | undefined;
  try {
    validatePostgresSecretMaterial(secret);
    const alias = mainSecretAlias(configuration.uriRef);
    material = Buffer.from(secret);
    const availability = await store.availability(alias);
    if (availability.alias !== alias) {
      throw new MainDatabaseSecretError("The managed Secret Store returned an invalid alias.");
    }
    if (availability.ready) {
      await store.rotate(alias, material);
    } else {
      await store.store(alias, material);
    }
  } catch (error) {
    throw databaseSecretUnavailable(error);
  } finally {
    material?.fill(0);
    secret.fill(0);
  }
}

function databaseSecretUnavailable(cause?: unknown): MainRuntimeError {
  const source =
    cause instanceof MainDatabaseSecretError
      ? cause
      : new MainDatabaseSecretError("The PostgreSQL Secret is unavailable.", {
          cause,
        });
  return new MainRuntimeError("DATABASE_SECRET_UNAVAILABLE", source.message, { cause: source });
}

async function registerAdminAssets(
  app: Awaited<ReturnType<typeof createMainControlPlaneApp>>,
  adminRoot: string,
): Promise<void> {
  const assets = await loadAdminAssets(adminRoot);
  const index = assets.get("index.html");
  if (index === undefined) {
    throw new MainRuntimeError("ADMIN_ASSET_INVALID", "The Admin Web bundle has no index.html.");
  }

  app.get("/", async (_request, reply) => {
    setAdminHeaders(reply, "index.html");
    return reply.send(index);
  });
  app.get("/*", async (request, reply) => {
    const wildcard = (request.params as { "*": string })["*"];
    const path = normalizeAssetRequestPath(wildcard);
    if (isControlPlaneNamespace(path)) {
      return reply.callNotFound();
    }
    const asset = assets.get(path);
    if (asset !== undefined) {
      setAdminHeaders(reply, path);
      return reply.send(asset);
    }
    if (path.includes(".")) {
      return reply.callNotFound();
    }
    setAdminHeaders(reply, "index.html");
    return reply.send(index);
  });
}

function isControlPlaneNamespace(path: string): boolean {
  return (
    path === "api" || path.startsWith("api/") || path === "health" || path.startsWith("health/")
  );
}

async function loadAdminAssets(root: string): Promise<ReadonlyMap<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new MainRuntimeError(
          "ADMIN_ASSET_INVALID",
          "Admin Web assets cannot contain symbolic links.",
        );
      }
      const absolute = join(directory, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(absolute, relativePath);
        continue;
      }
      if (!entry.isFile() || files.size >= MAX_ADMIN_FILES) {
        throw new MainRuntimeError(
          "ADMIN_ASSET_INVALID",
          "The Admin Web bundle contains unsupported or too many entries.",
        );
      }
      let bytes: Buffer;
      try {
        bytes = await readStableRegularFile(absolute, MAX_ADMIN_FILE_BYTES);
      } catch (error) {
        throw new MainRuntimeError(
          "ADMIN_ASSET_INVALID",
          error instanceof StableFileError && error.code === "TOO_LARGE"
            ? "An Admin Web asset exceeds the size limit."
            : "An Admin Web asset is not a stable regular file.",
          { cause: error },
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_ADMIN_TOTAL_BYTES) {
        throw new MainRuntimeError(
          "ADMIN_ASSET_INVALID",
          "The Admin Web bundle exceeds the total size limit.",
        );
      }
      files.set(relativePath.replaceAll("\\", "/"), bytes);
    }
  };

  await visit(root, "");
  return files;
}

function setAdminHeaders(
  reply: {
    header(name: string, value: string): unknown;
    type(contentType: string): unknown;
  },
  path: string,
): void {
  void reply.type(contentType(path));
  void reply.header(
    "cache-control",
    path === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
  );
  void reply.header("x-content-type-options", "nosniff");
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const types: Readonly<Record<string, string>> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  };
  return types[extension] ?? "application/octet-stream";
}

function normalizeAssetRequestPath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return "__invalid__";
  }
  return value;
}

async function validateAdminRoot(root: string): Promise<void> {
  if (!isAbsolute(root)) {
    throw new MainRuntimeError("CONFIG_INVALID", "The Admin Web bundle path must be absolute.");
  }
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("not a directory");
    }
    await access(join(root, "index.html"));
  } catch {
    throw new MainRuntimeError(
      "ADMIN_ASSET_INVALID",
      "The Admin Web bundle path is not a readable directory with index.html.",
    );
  }
}

async function ensureRuntimeDirectories(
  paths: RuntimePaths,
  sourceCheckout: string,
): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(paths.home, "runtime home");
  for (const [path, label] of [
    [paths.configDirectory, "runtime config directory"],
    [paths.stateDirectory, "runtime state directory"],
    [paths.logsDirectory, "runtime logs directory"],
    [paths.knowledgeDirectory, "runtime Knowledge directory"],
  ] as const) {
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
    await assertPrivateDirectory(path, label);
  }

  const [actualHome, actualCheckout] = await Promise.all([
    realpath(paths.home),
    realpath(sourceCheckout),
  ]);
  if (isWithin(actualCheckout, actualHome)) {
    throw new MainRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      "Resolved runtime state must live outside the OpenDelegate source checkout.",
    );
  }
  await sealRuntimeState(paths, actualHome);
}

async function sealRuntimeState(paths: RuntimePaths, resolvedHome?: string): Promise<void> {
  const actualHome = resolvedHome ?? (await realpath(paths.home));
  const opaqueDirectories = await existingControlledProviderHomes(paths);
  await assertManagedTreeHasNoLinks(actualHome, opaqueDirectories);
  try {
    await enforceHostRuntimePermissions({
      root: actualHome,
      ...(opaqueDirectories.length === 0 ? {} : { opaqueDirectories }),
    });
  } catch (error) {
    if (error instanceof RuntimePermissionEnforcementError) {
      throw new MainRuntimeError("RUNTIME_PATH_UNSAFE", error.message, { cause: error });
    }
    throw error;
  }
}

async function existingControlledProviderHomes(paths: RuntimePaths): Promise<readonly string[]> {
  const providerRoot = join(paths.stateDirectory, "providers");
  const homes = [join(providerRoot, "codex"), join(providerRoot, "claude")];
  const existing: string[] = [];
  for (const home of homes) {
    if (await exists(home)) {
      existing.push(home);
    }
  }
  return existing;
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("not a private directory");
    }
  } catch {
    throw new MainRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      `The ${label} must be a real directory, not a symlink or reparse point.`,
    );
  }
}

async function assertManagedTreeHasNoLinks(
  root: string,
  opaqueDirectories: readonly string[] = [],
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new MainRuntimeError(
        "RUNTIME_PATH_UNSAFE",
        "Runtime state cannot contain symlinks or reparse points.",
      );
    }
    if (metadata.isDirectory()) {
      if (opaqueDirectories.some((opaque) => sameRuntimePath(path, opaque))) {
        continue;
      }
      await assertManagedTreeHasNoLinks(path, opaqueDirectories);
    }
  }
}

function sameRuntimePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLocaleLowerCase("en-US") === resolvedRight.toLocaleLowerCase("en-US")
    : resolvedLeft === resolvedRight;
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

function validateMainConfiguration(input: unknown): MainConfiguration {
  if (isRecord(input)) {
    const database = input["database"];
    if (
      isRecord(database) &&
      database["adapter"] === "postgresql" &&
      "uriEnvironment" in database
    ) {
      throw legacyDatabaseConfiguration();
    }
    if (!("secretBackend" in input)) {
      throw new MainRuntimeError(
        "CONFIG_MIGRATION_REQUIRED",
        "This Main configuration predates the required persisted secretBackend descriptor. Run init again with --secret-backend-config before serving it.",
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
    ]) ||
    input["schemaVersion"] !== CONFIG_SCHEMA_VERSION ||
    typeof input["instanceId"] !== "string" ||
    typeof input["deviceId"] !== "string" ||
    input["instanceId"] === input["deviceId"] ||
    !isOpaqueId(input["instanceId"]) ||
    !isOpaqueId(input["deviceId"]) ||
    typeof input["adminRoot"] !== "string" ||
    !isAbsolute(input["adminRoot"])
  ) {
    throw configInvalid();
  }

  const main = validateListener(input["main"]);
  const database = validateDatabase(input["database"]);
  let secretBackend: MainSecretBackendConfiguration;
  try {
    secretBackend = validateMainSecretBackendConfiguration(input["secretBackend"]);
  } catch (error) {
    throw configInvalid(error);
  }
  const discord =
    input["discord"] === undefined ? undefined : validateMainDiscordConfiguration(input["discord"]);
  const artifacts =
    input["artifacts"] === undefined
      ? undefined
      : validateMainArtifactConfiguration(input["artifacts"]);
  const deviceChannel =
    input["deviceChannel"] === undefined
      ? undefined
      : validateStoredDeviceChannelConfiguration(input["deviceChannel"]);
  return Object.freeze({
    schemaVersion: 1,
    instanceId: input["instanceId"],
    deviceId: input["deviceId"],
    main,
    database,
    secretBackend,
    adminRoot: resolve(input["adminRoot"]),
    ...(discord === undefined ? {} : { discord }),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(deviceChannel === undefined ? {} : { deviceChannel }),
  });
}

function validateListener(input: unknown): MainListenerConfiguration {
  if (
    !isRecord(input) ||
    !hasAllowedKeys(input, ["host", "port", "origin", "tls"]) ||
    !hasRequiredKeys(input, ["host", "port", "origin"]) ||
    typeof input["host"] !== "string" ||
    typeof input["port"] !== "number" ||
    !Number.isSafeInteger(input["port"]) ||
    input["port"] < 1 ||
    input["port"] > 65_535 ||
    typeof input["origin"] !== "string"
  ) {
    throw configInvalid();
  }

  let origin: URL;
  try {
    origin = new URL(input["origin"]);
  } catch {
    throw configInvalid();
  }
  if (
    origin.origin !== input["origin"] ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    Number(origin.port || defaultPort(origin.protocol)) !== input["port"]
  ) {
    throw configInvalid();
  }

  const tls = validateTls(input["tls"]);
  if (tls === undefined) {
    if (
      origin.protocol !== "http:" ||
      !isLoopbackHost(input["host"]) ||
      !isLoopbackHost(origin.hostname)
    ) {
      throw new MainRuntimeError(
        "CONFIG_INVALID",
        "Cleartext Main listeners are allowed only on loopback.",
      );
    }
  } else if (origin.protocol !== "https:") {
    throw configInvalid();
  }

  return Object.freeze({
    host: input["host"],
    port: input["port"],
    origin: origin.origin,
    ...(tls === undefined ? {} : { tls }),
  });
}

function validateStoredDeviceChannelConfiguration(input: unknown): MainDeviceChannelConfiguration {
  if (
    !isRecord(input) ||
    !hasAllowedKeys(input, ["enrollment", "workerChannel"]) ||
    !hasRequiredKeys(input, ["enrollment", "workerChannel"])
  ) {
    throw configInvalid();
  }
  const enrollment = validateStoredDeviceListener(
    input["enrollment"],
    "https:",
    "/api/v1/device/enroll",
    false,
  );
  const workerInput = input["workerChannel"];
  if (!isRecord(workerInput)) {
    throw configInvalid();
  }
  const path =
    workerInput["path"] === undefined
      ? "/api/v1/device/channel"
      : validateDeviceChannelPath(workerInput["path"]);
  const workerChannel = {
    ...validateStoredDeviceListener(workerInput, "wss:", path, true),
    ...(workerInput["path"] === undefined ? {} : { path }),
  };
  if (
    (enrollment.host === workerChannel.host && enrollment.port === workerChannel.port) ||
    enrollment.advertisedUrl === workerChannel.advertisedUrl
  ) {
    throw configInvalid();
  }
  return Object.freeze({ enrollment, workerChannel });
}

function validateStoredDeviceListener(
  input: unknown,
  protocol: "https:" | "wss:",
  requiredPath: string,
  acceptsPath: boolean,
): MainDeviceChannelConfiguration["enrollment"] {
  if (
    !isRecord(input) ||
    !hasAllowedKeys(
      input,
      acceptsPath
        ? ["advertisedUrl", "host", "port", "tlsCertificatePath", "tlsPrivateKeyPath", "path"]
        : ["advertisedUrl", "host", "port", "tlsCertificatePath", "tlsPrivateKeyPath"],
    ) ||
    !hasRequiredKeys(input, [
      "advertisedUrl",
      "host",
      "port",
      "tlsCertificatePath",
      "tlsPrivateKeyPath",
    ]) ||
    typeof input["advertisedUrl"] !== "string" ||
    typeof input["host"] !== "string" ||
    input["host"].trim() !== input["host"] ||
    input["host"].length === 0 ||
    input["host"].length > 253 ||
    typeof input["port"] !== "number" ||
    !Number.isSafeInteger(input["port"]) ||
    input["port"] < 1 ||
    input["port"] > 65_535 ||
    typeof input["tlsCertificatePath"] !== "string" ||
    !isAbsolute(input["tlsCertificatePath"]) ||
    typeof input["tlsPrivateKeyPath"] !== "string" ||
    !isAbsolute(input["tlsPrivateKeyPath"])
  ) {
    throw configInvalid();
  }
  let advertised: URL;
  try {
    advertised = new URL(input["advertisedUrl"]);
  } catch {
    throw configInvalid();
  }
  if (
    advertised.protocol !== protocol ||
    advertised.username !== "" ||
    advertised.password !== "" ||
    advertised.search !== "" ||
    advertised.hash !== "" ||
    advertised.pathname !== requiredPath ||
    Number(advertised.port || "443") !== input["port"]
  ) {
    throw configInvalid();
  }
  return Object.freeze({
    advertisedUrl: advertised.toString(),
    host: input["host"],
    port: input["port"],
    tlsCertificatePath: resolve(input["tlsCertificatePath"]),
    tlsPrivateKeyPath: resolve(input["tlsPrivateKeyPath"]),
  });
}

function validateDeviceChannelPath(input: unknown): string {
  if (typeof input !== "string" || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1023}$/u.test(input)) {
    throw configInvalid();
  }
  return input;
}

function validateTls(input: unknown): MainListenerConfiguration["tls"] {
  if (input === undefined) {
    return undefined;
  }
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["certificatePath", "privateKeyPath"]) ||
    typeof input["certificatePath"] !== "string" ||
    typeof input["privateKeyPath"] !== "string" ||
    !isAbsolute(input["certificatePath"]) ||
    !isAbsolute(input["privateKeyPath"])
  ) {
    throw configInvalid();
  }
  return Object.freeze({
    certificatePath: resolve(input["certificatePath"]),
    privateKeyPath: resolve(input["privateKeyPath"]),
  });
}

function validateDatabase(input: unknown): MainDatabaseConfiguration {
  if (!isRecord(input) || typeof input["adapter"] !== "string") {
    throw configInvalid();
  }
  if (input["adapter"] === "postgresql" && "uriEnvironment" in input) {
    throw legacyDatabaseConfiguration();
  }
  if (input["adapter"] === "sqlite" && hasExactKeys(input, ["adapter"])) {
    return Object.freeze({ adapter: "sqlite" });
  }
  if (
    input["adapter"] === "postgresql" &&
    hasAllowedKeys(input, ["adapter", "uriRef", "schema"]) &&
    hasRequiredKeys(input, ["adapter", "uriRef"]) &&
    typeof input["uriRef"] === "string" &&
    (input["schema"] === undefined ||
      (typeof input["schema"] === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input["schema"])))
  ) {
    return Object.freeze({
      adapter: "postgresql",
      uriRef: validateMainSecretReference(input["uriRef"]),
      ...(input["schema"] === undefined ? {} : { schema: input["schema"] }),
    });
  }
  throw configInvalid();
}

function legacyDatabaseConfiguration(): MainRuntimeError {
  return new MainRuntimeError(
    "CONFIG_MIGRATION_REQUIRED",
    "This Main configuration uses the retired PostgreSQL uriEnvironment field. Provision the URI in the Device-local Secret Store and replace it with a canonical uriRef such as secret://main/database-primary.",
  );
}

function defaultRuntimeHome(environment: Readonly<Record<string, string | undefined>>): string {
  const explicit = environment["OPENDELEGATE_HOME"];
  if (explicit !== undefined && explicit.trim().length > 0) {
    if (!isAbsolute(explicit)) {
      throw new MainRuntimeError(
        "RUNTIME_PATH_UNSAFE",
        "OPENDELEGATE_HOME must be an absolute path.",
      );
    }
    return explicit;
  }
  switch (platform()) {
    case "win32":
      return join(
        environment["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
        "OpenDelegate",
      );
    case "darwin":
      return join(homedir(), "Library", "Application Support", "OpenDelegate");
    default:
      return join(
        environment["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
        "opendelegate",
      );
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}

function isOpaqueId(value: string): boolean {
  return value.length >= 1 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
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

function configInvalid(cause?: unknown): MainRuntimeError {
  return new MainRuntimeError(
    "CONFIG_INVALID",
    "Main configuration does not match schema version 1.",
    cause === undefined ? undefined : { cause },
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

class SystemClock implements OwnerAuthClock {
  now(): number {
    return Date.now();
  }

  asEventClock(): { readonly now: () => string } {
    return {
      now: () => new Date(this.now()).toISOString(),
    };
  }
}

export function mainConfigurationDirectory(configurationFile: string): string {
  return dirname(configurationFile);
}

export {
  BackupCliError,
  backupHelpText,
  parseBackupArguments,
  runBackupLifecycleCommand,
  type BackupCliErrorCode,
  type BackupLifecycleAdapters,
  type BackupLifecycleCommand,
  type BackupLifecycleResult,
  type ParsedBackupArguments,
} from "./backup-cli.ts";
export {
  MainBackupError,
  createMainBackup,
  defaultMainBackupToolRunner,
  restoreMainBackup,
  verifyMainBackup,
  type BackupFileRecord,
  type CreateMainBackupOptions,
  type MainBackupConfiguration,
  type MainBackupDatabaseConfiguration,
  type MainBackupErrorCode,
  type MainBackupManifest,
  type MainBackupSource,
  type MainBackupToolRunner,
  type RestoreMainBackupOptions,
  type VerifyMainBackupOptions,
} from "./backup.ts";
export {
  ServiceLifecycleCliError,
  createDefaultServiceLifecycleAdapters,
  loadServiceConfigurationFile,
  parseServiceLifecycleArguments,
  runServiceLifecycleCommand,
  serviceLifecycleHelpText,
  type ParsedServiceLifecycleArguments,
  type ServiceConfigurationReader,
  type ServiceReconfigurationReader,
  type ServiceLifecycleAdapters,
  type ServiceLifecycleCliErrorCode,
  type ServiceLifecycleCommand,
  type ServiceLifecycleExecutor,
  type ServiceLifecycleInspector,
  type ServiceLifecycleResult,
  type ServiceMutationObserver,
} from "./service-lifecycle.ts";
export {
  resolveEffectiveMainServiceConfiguration,
  type EffectiveMainServiceConfiguration,
  type EffectiveMainServiceConfigurationInput,
} from "./main-service-configuration.ts";
export {
  MainActionAuthorizationRuntime,
  type MainActionAuthorizationRuntimeOptions,
  type MainActionRunAuthorityPort,
} from "./action-authorization-runtime.ts";
