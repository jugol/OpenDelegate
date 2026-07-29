import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants as fileConstants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, homedir, hostname, platform, release, totalmem } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClaudeAgentSdkAdapter,
  ClaudeCliAdapter,
  CodexAppServerAdapter,
  CodexCliAdapter,
  FileSessionLeaseStore,
  type AgentActionAuthorizationPort,
  type AgentAdapter,
  type AgentAdapterProbe,
  type AgentModelCatalog,
  type AgentPermissionInput,
  type SessionLeaseStore,
} from "@opendelegate/agent-adapters";
import {
  ComputerUseOsBackend,
  type DesktopAuthorityPort,
  type DesktopLeasePort,
  type NativeComputerUseDriver,
} from "@opendelegate/computer-use-os";
import {
  WorkerDeviceChannelClient,
  enrollWorkerDevice,
  executeWithEnrollmentGrantFile,
  SqliteWorkerChannelState,
  type CalibratedWorkerRunLeaseAuthority,
  type MainControlFrameV1,
  type MainDispatchFrameV1,
  type MainRunSteerFrameV1,
  type WorkerRunLeaseDecisionObservation,
} from "@opendelegate/device-channel";
import { WorkerDeviceIdentity } from "@opendelegate/device-identity";
import { LocalKnowledgeService } from "@opendelegate/knowledge";
import { PROTOCOL_VERSION } from "@opendelegate/protocol";
import {
  createNativePlatformMutationJournal,
  createNodeNativeServiceJournalAtomicBoundary,
  createNodePlatformMutationProcessRunner,
  createPlatformMutationExecutor,
  type PlatformMutationExecutableId,
} from "@opendelegate/platform-services";
import {
  ManagedDeviceIdentitySecretStore,
  NodeNativeSecretCommandRunner,
  SystemdCredentialKeyProvider,
  WindowsDpapiSecretStore,
  WindowsServiceDpapiSecretHandoff,
  createPlatformManagedSecretStore,
  resolveWindowsServiceSid,
  type ManagedSecretStore,
  type NativeSecretCommandRunner,
  type PlatformManagedSecretStoreConfig,
  SecretError,
} from "@opendelegate/secrets";
import { LocalRunCapabilityBroker } from "@opendelegate/run-capability-broker";
import {
  TransportRoutesExhaustedError,
  type TransportAttemptTrace,
  type TransportProfile,
  type TransportResolution,
  type TransportResolver,
} from "@opendelegate/transport";
import {
  AgentRunProcessFactory,
  CompositeWorkerRunCapabilityProvider,
  DEFAULT_MAXIMUM_CONCURRENT_RUNS,
  LocalKnowledgeInitialContextProvider,
  RegisteredWorkerWorkspaceResolver,
  SqliteNativeSessionReferenceStore,
  SqliteWorkerStateRepository,
  SqliteWorkspaceRegistry,
  WorkerRuntime,
  type WorkerConfiguration,
  type WorkerMainConnection,
  type WorkerRunAssignmentV1,
  type WorkerRunLeaseAuthority,
  type WorkerRunCapabilityProvider,
  type WorkerSchedulingInventoryProvider,
  type WorkerSchedulingInventoryV1,
  type WorkspaceRecord,
  type WorkspaceSchedulingMetadata,
} from "@opendelegate/worker-runtime";

import { WorkerArtifactDeliveryCoordinator } from "./artifact-delivery.ts";
import { WorkerAgentActionAuthorizer } from "./agent-action-authorizer.ts";
import { FileManifestWorkerArtifactLifecycle } from "./artifact-promotion.ts";
import { WorkerArtifactRunCapabilityProvider } from "./artifact-run-capability.ts";
import { FetchWorkerArtifactUploadTransport, WorkerArtifactUploader } from "./artifact-uploader.ts";
import { WorkerComputerUseInputAuthorizer } from "./computer-use-action-authorizer.ts";
import { WorkerComputerUseRunCapabilityProvider } from "./computer-use-run-capability.ts";
import { SqliteComputerUseStartHistory } from "./computer-use-start-history.ts";
import { SqliteWorkerDesktopLeaseAuthority } from "./desktop-lease-authority.ts";
import { WorkerKnowledgeRunCapabilityProvider } from "./knowledge-run-capability.ts";
import {
  WorkerPlatformMutationRunCapabilityProvider,
  bindPlatformMutationProcessRunnerToWorkspace,
} from "./platform-mutation-run-capability.ts";
import { createWorkerPlatformMutationSafetyBoundary } from "./platform-mutation-safety-boundary.ts";
import { createPinnedWindowsNpmProcessRunner } from "./windows-npm-process-runner.ts";
import { createConfiguredSystemPackageVerifier } from "./configured-system-package-verifier.ts";
import { SystemWakeOnLanProbe } from "./wake-on-lan-probe.ts";

const CONFIG_SCHEMA_VERSION = 1;
const CONFIG_FILE_NAME = "worker.json";
const MAXIMUM_CONFIG_BYTES = 1_048_576;
const MAXIMUM_SECRET_BACKEND_CONFIG_BYTES = 65_536;
const MAXIMUM_ENCRYPTED_CREDENTIAL_BYTES = 262_144;
const PRIVATE_KEY_ALIAS_PREFIX = "identity-p256.";
const PLATFORM_MUTATION_EXECUTABLE_IDS = new Set<PlatformMutationExecutableId>([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "pip3",
  "cargo",
  "apt",
  "apt-get",
  "dnf",
  "yum",
  "zypper",
  "brew",
  "winget",
  "choco",
  "add-apt-repository",
  "apt-key",
  "bash",
  "devcon",
  "dpkg",
  "firewall-cmd",
  "insmod",
  "ip",
  "iptables",
  "kextload",
  "kmutil",
  "modprobe",
  "msiexec",
  "netsh",
  "networksetup",
  "nft",
  "nmcli",
  "openvpn",
  "pfctl",
  "pnputil",
  "route",
  "rpm",
  "sh",
  "socketfilterfw",
  "tailscale",
  "ufw",
  "wg-quick",
]);
export const WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS = "opendelegate/desktop-authority/v1";
export const WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS =
  "opendelegate/session-helper-core-signing/v2";
export const WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS =
  "opendelegate/session-helper-owner-signing/v2";

export type WorkerAppErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_MISSING"
  | "CONFIG_PATH_UNSAFE"
  | "DAEMON_FAILED"
  | "ENROLLMENT_FAILED"
  | "SECRET_BACKEND_UNAVAILABLE";

export class WorkerAppError extends Error {
  public readonly code: WorkerAppErrorCode;

  public constructor(code: WorkerAppErrorCode, message: string) {
    super(message);
    this.name = "WorkerAppError";
    this.code = code;
  }
}

export interface WorkerPaths {
  readonly home: string;
  readonly configDirectory: string;
  readonly configFile: string;
  readonly knowledgeDirectory: string;
  readonly stateDirectory: string;
  readonly workerStateFile: string;
  readonly channelStateFile: string;
  readonly sessionStateFile: string;
  readonly nativeSessionLeaseStateFile: string;
  readonly workspaceStateFile: string;
  readonly desktopLeaseStateFile: string;
  readonly computerUseStartStateFile: string;
  readonly runCapabilityDirectory: string;
  readonly artifactStagingDirectory: string;
  readonly sourceCheckoutRoot: string;
}

export type WorkerSecretBackendConfiguration =
  | {
      readonly backend: "windows-dpapi";
      readonly vaultRoot: string;
    }
  | {
      readonly backend: "windows-service-dpapi";
      readonly handoffRoot: string;
      readonly serviceName: string;
      readonly serviceSid: string;
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
      readonly encryptedCredentialFile: string;
      readonly vaultRoot: string;
    };

export interface WorkerAgentConfiguration {
  readonly provider: "auto" | "claude" | "codex";
  readonly allowUntestedVersion: boolean;
  readonly codexExecutable?: string;
  readonly codexHome?: string;
  readonly claudeExecutable?: string;
  readonly claudeHome?: string;
  readonly claudeAllowedNetworkDomains?: readonly string[];
}

export interface WorkerWorkspaceConfiguration {
  readonly workspaceId: string;
  readonly alias: string;
  readonly type: "directory" | "git" | "mounted-storage";
  readonly rootPath: string;
  readonly isolation: "agent-native-worktree" | "none";
  readonly capabilities: readonly string[];
}

export interface WorkerPlatformMutationConfiguration {
  readonly executables: Readonly<Partial<Record<PlatformMutationExecutableId, string>>>;
}

export interface WorkerConfigurationDocument {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  readonly deviceId: string;
  readonly workerId: string;
  readonly mainDeviceId: string;
  readonly keyId: string;
  readonly certificateGeneration: number;
  readonly certificatePem: string;
  readonly certificateAuthorityPem: string;
  readonly expectedMainSpkiSha256: string;
  readonly transportProfile: TransportProfile;
  readonly secretBackend: WorkerSecretBackendConfiguration;
  readonly agent: WorkerAgentConfiguration;
  readonly platformMutation?: WorkerPlatformMutationConfiguration;
  readonly workspaces: readonly WorkerWorkspaceConfiguration[];
  readonly createdAt: string;
}

export interface JoinWorkerOptions {
  readonly grantFile: string;
  readonly paths: WorkerPaths;
  readonly secretBackend: WorkerSecretBackendConfiguration;
  readonly agent?: WorkerAgentConfiguration;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface RunWorkerDaemonOptions {
  readonly paths: WorkerPaths;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly computerUseProbe?: WorkerComputerUseCapabilityProbe;
  readonly computerUseRuntime?: WorkerComputerUseRuntimePort;
  readonly signal?: AbortSignal;
  readonly reconnectMinimumMs?: number;
  readonly reconnectMaximumMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly onReady?: () => void | Promise<void>;
}

export interface WorkerComputerUseRuntimeBinding {
  readonly driver: NativeComputerUseDriver;
  readonly authority: DesktopAuthorityPort;
  readonly binding: {
    readonly helperInstanceId: string;
    readonly serviceEpoch: number;
    readonly persistenceGeneration: number;
  };
}

export interface WorkerComputerUseRuntimeLease extends WorkerComputerUseRuntimeBinding {
  release(): Promise<void>;
}

export interface WorkerComputerUseRuntimePort {
  acquire(): Promise<WorkerComputerUseRuntimeLease | undefined>;
}

export interface WorkerComputerUseCoreKeyBinding {
  readonly alias: typeof WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS;
  readonly keyId: `sha256:${string}`;
  readonly publicKeySpkiBase64Url: string;
}

export interface WorkerSessionHelperOwnerKeyBinding {
  readonly alias: typeof WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS;
  readonly keyId: `sha256:${string}`;
  readonly publicKeySpkiBase64Url: string;
}

export interface WorkerComputerUseCapabilityProbe {
  probe(): Promise<{
    readonly verification: "degraded" | "unavailable" | "verified";
  }>;
}

export interface RegisterWorkerWorkspaceOptions {
  readonly paths: WorkerPaths;
  readonly workspace: WorkerWorkspaceConfiguration;
}

export interface ProvisionHeadlessLinuxSecretBackendOptions {
  readonly configurationFile: string;
  readonly credentialName?: string;
  readonly encryptedCredentialFile: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly randomKey?: () => Uint8Array;
  readonly runner?: NativeSecretCommandRunner;
  readonly sourceCheckoutRoot: string;
  readonly systemdCredsPath?: string;
  readonly vaultRoot: string;
}

export interface PrepareWindowsServiceSecretBackendOptions {
  readonly handoffRoot: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly instanceId: string;
  readonly paths: WorkerPaths;
  readonly powershellPath?: string;
  readonly runner?: NativeSecretCommandRunner;
  readonly scPath?: string;
  readonly vaultRoot: string;
}

export interface WorkerRuntimeComposition {
  readonly configuration: WorkerConfigurationDocument;
  readonly runtime: WorkerRuntime;
  pulse(): Promise<boolean>;
  close(): Promise<void>;
}

export interface WorkerDiagnosticSnapshot {
  readonly enrolled: true;
  readonly deviceId: string;
  readonly workerId: string;
  readonly mainDeviceId: string;
  readonly certificateGeneration: number;
  readonly channelEndpointCount: number;
  readonly secretBackend: WorkerSecretBackendConfiguration["backend"];
  readonly secretStoreStatus: "ready" | "unavailable";
  readonly identityKeyReady: boolean;
  readonly agents: readonly {
    readonly adapterId: string;
    readonly provider: AgentProviderName;
    readonly installed: boolean;
    readonly authState: string;
    readonly compatibility?: string;
    readonly version?: string;
  }[];
}

type AgentProviderName = "claude" | "codex" | "generic";

export function resolveWorkerPaths(input: {
  readonly sourceCheckoutRoot: string;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly hostPlatform?: NodeJS.Platform;
}): WorkerPaths {
  const sourceCheckoutRoot = requireAbsolutePath(input.sourceCheckoutRoot, "source checkout root");
  const environment = input.environment ?? process.env;
  const hostPlatform = input.hostPlatform ?? process.platform;
  const defaultHome =
    hostPlatform === "win32"
      ? join(
          requireEnvironmentPath(environment["LOCALAPPDATA"], "LOCALAPPDATA"),
          "OpenDelegate",
          "worker",
        )
      : hostPlatform === "darwin"
        ? join(homedir(), "Library", "Application Support", "OpenDelegate", "worker")
        : join(
            environment["XDG_STATE_HOME"]?.trim() || join(homedir(), ".local", "state"),
            "opendelegate",
            "worker",
          );
  const home = requireAbsolutePath(input.home ?? defaultHome, "Worker home");
  if (isWithin(sourceCheckoutRoot, home)) {
    throw appError(
      "CONFIG_PATH_UNSAFE",
      "Worker state and configuration must remain outside the source checkout.",
    );
  }
  const configDirectory = join(home, "config");
  const stateDirectory = join(home, "state");
  return Object.freeze({
    home,
    configDirectory,
    configFile: join(configDirectory, CONFIG_FILE_NAME),
    knowledgeDirectory: join(home, "knowledge"),
    stateDirectory,
    workerStateFile: join(stateDirectory, "worker.sqlite3"),
    channelStateFile: join(stateDirectory, "channel.sqlite3"),
    sessionStateFile: join(stateDirectory, "sessions.sqlite3"),
    nativeSessionLeaseStateFile: join(stateDirectory, "native-session-leases.json"),
    workspaceStateFile: join(stateDirectory, "workspaces.sqlite3"),
    desktopLeaseStateFile: join(stateDirectory, "desktop-leases.sqlite3"),
    computerUseStartStateFile: join(stateDirectory, "computer-use-starts.sqlite3"),
    runCapabilityDirectory: join(stateDirectory, "run-capabilities"),
    artifactStagingDirectory: join(stateDirectory, "artifact-staging"),
    sourceCheckoutRoot,
  });
}

export async function joinWorker(options: JoinWorkerOptions): Promise<WorkerConfigurationDocument> {
  await prepareRuntimeDirectories(options.paths);
  const grantPath = requireAbsolutePath(options.grantFile, "Enrollment Grant file");
  const environment = options.environment ?? process.env;
  let result: {
    readonly channelVerified: boolean;
    readonly configuration: WorkerConfigurationDocument;
  };
  try {
    result = await executeWithEnrollmentGrantFile(
      grantPath,
      { sourceCheckoutRoot: options.paths.sourceCheckoutRoot },
      async (grant) => {
        const channelEndpoints = grant.channelEndpoints.filter(
          (endpoint) => endpoint.kind === "wss",
        );
        if (channelEndpoints.length === 0) {
          throw appError(
            "CONFIG_INVALID",
            "The Enrollment Grant does not contain a mutual-TLS WSS Worker endpoint.",
          );
        }
        const managedSecrets = createWorkerManagedSecretStore(
          options.secretBackend,
          grant.deviceId,
          options.paths,
          environment,
        );
        const health = await managedSecrets.health();
        if (health.status !== "ready") {
          throw appError(
            "SECRET_BACKEND_UNAVAILABLE",
            "The selected Device-local Secret Store is unavailable.",
          );
        }
        const identity = new WorkerDeviceIdentity({
          clock: { now: () => Date.now() },
          secrets: new ManagedDeviceIdentitySecretStore(managedSecrets),
        });
        const enrolled = await enrollWorkerDevice({
          grant,
          identity,
          discovery: {
            architecture: arch(),
            hostname: hostname(),
            osFamily: osFamily(platform()),
          },
        });
        await provisionWorkerComputerUseCoreSecrets(managedSecrets);
        const configuration = validateWorkerConfigurationDocument({
          schemaVersion: CONFIG_SCHEMA_VERSION,
          deviceId: enrolled.deviceId,
          workerId: "worker-primary",
          mainDeviceId: enrolled.mainDeviceId,
          keyId: enrolled.keyId,
          certificateGeneration: enrolled.generation,
          certificatePem: enrolled.certificatePem,
          certificateAuthorityPem: enrolled.certificateAuthorityPem,
          expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
          transportProfile: {
            deviceId: enrolled.mainDeviceId,
            endpoints: channelEndpoints.map((endpoint) => ({
              ...endpoint,
              credentialRef: "device-identity",
            })),
          },
          secretBackend: options.secretBackend,
          agent:
            options.agent === undefined
              ? {
                  provider: "auto",
                  allowUntestedVersion: false,
                }
              : {
                  ...options.agent,
                  ...(options.agent.codexHome === undefined
                    ? {}
                    : {
                        codexHome: requireExternalProvisioningPath(
                          options.agent.codexHome,
                          options.paths.sourceCheckoutRoot,
                          "Codex provider home",
                        ),
                      }),
                  ...(options.agent.claudeHome === undefined
                    ? {}
                    : {
                        claudeHome: requireExternalProvisioningPath(
                          options.agent.claudeHome,
                          options.paths.sourceCheckoutRoot,
                          "Claude provider home",
                        ),
                      }),
                },
          workspaces: [],
          createdAt: new Date().toISOString(),
        });
        await writeConfiguration(options.paths.configFile, configuration);
        const channelVerified = await verifyInitialWorkerChannel({
          configuration,
          managedSecrets,
          paths: options.paths,
        });
        return { channelVerified, configuration };
      },
    );
  } catch (error) {
    if (error instanceof WorkerAppError) {
      throw error;
    }
    throw appError("ENROLLMENT_FAILED", "Worker enrollment did not complete.");
  }
  if (!result.channelVerified) {
    throw appError(
      "ENROLLMENT_FAILED",
      "Enrollment completed, but the first mutual-TLS Worker channel could not be verified. The Device identity was retained; run Worker status and diagnose before starting it.",
    );
  }
  return result.configuration;
}

export async function loadWorkerConfiguration(
  paths: WorkerPaths,
): Promise<WorkerConfigurationDocument> {
  let bytes: Buffer;
  try {
    bytes = await readStableWorkerFile(paths.configFile, MAXIMUM_CONFIG_BYTES);
  } catch {
    throw appError("CONFIG_MISSING", "Worker is not enrolled. Run worker join first.");
  }
  try {
    return validateWorkerConfigurationDocument(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw appError("CONFIG_INVALID", "Worker configuration is invalid.");
  } finally {
    bytes.fill(0);
  }
}

export async function registerWorkerWorkspace(
  options: RegisterWorkerWorkspaceOptions,
): Promise<WorkspaceRecord> {
  await loadWorkerConfiguration(options.paths);
  await prepareRuntimeDirectories(options.paths);
  const workspace = validateWorkspace(options.workspace);
  const registry = new SqliteWorkspaceRegistry({
    filename: options.paths.workspaceStateFile,
    sourceCheckoutDirectory: options.paths.sourceCheckoutRoot,
  });
  try {
    return await registry.register(workspace);
  } finally {
    registry.close();
  }
}

export async function listWorkerWorkspaces(
  paths: WorkerPaths,
): Promise<readonly WorkspaceSchedulingMetadata[]> {
  await loadWorkerConfiguration(paths);
  await prepareRuntimeDirectories(paths);
  const registry = new SqliteWorkspaceRegistry({
    filename: paths.workspaceStateFile,
    sourceCheckoutDirectory: paths.sourceCheckoutRoot,
  });
  try {
    return await registry.listSchedulingMetadata();
  } finally {
    registry.close();
  }
}

export async function createWorkerRuntime(
  options: Pick<
    RunWorkerDaemonOptions,
    "computerUseProbe" | "computerUseRuntime" | "environment" | "paths"
  >,
): Promise<WorkerRuntimeComposition> {
  const configuration = await loadWorkerConfiguration(options.paths);
  await prepareRuntimeDirectories(options.paths);
  const environment = options.environment ?? process.env;
  const managedSecrets = createWorkerManagedSecretStore(
    configuration.secretBackend,
    configuration.deviceId,
    options.paths,
    environment,
  );
  if ((await managedSecrets.health()).status !== "ready") {
    throw appError(
      "SECRET_BACKEND_UNAVAILABLE",
      "The configured Device-local Secret Store is unavailable.",
    );
  }
  const channelState = await SqliteWorkerChannelState.open({
    filename: options.paths.channelStateFile,
    sourceCheckoutRoot: options.paths.sourceCheckoutRoot,
    deviceId: configuration.deviceId,
    mainDeviceId: configuration.mainDeviceId,
    certificateGeneration: configuration.certificateGeneration,
  });
  const stateRepository = new SqliteWorkerStateRepository({
    filename: options.paths.workerStateFile,
    sourceCheckoutDirectory: options.paths.sourceCheckoutRoot,
  });
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: options.paths.sessionStateFile,
    sourceCheckoutDirectory: options.paths.sourceCheckoutRoot,
  });
  const workspaceRegistry = new SqliteWorkspaceRegistry({
    filename: options.paths.workspaceStateFile,
    sourceCheckoutDirectory: options.paths.sourceCheckoutRoot,
  });
  for (const workspace of configuration.workspaces) {
    try {
      await workspaceRegistry.resolve(workspace.workspaceId);
    } catch {
      await workspaceRegistry.register(workspace);
    }
  }
  const knowledge = new LocalKnowledgeService({ root: options.paths.knowledgeDirectory });
  await knowledge.rebuild();
  const runCapabilityBroker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: options.paths.runCapabilityDirectory,
    sourceCheckoutDirectory: options.paths.sourceCheckoutRoot,
    maxFrameBytes: 8 * 1024 * 1024,
  });
  const toolServerLaunch = workerToolServerLaunch();
  const nativeSessionLeaseStore = createWorkerNativeSessionLeaseStore(options.paths);
  const adapters = createWorkerAgentAdapters(
    configuration.agent,
    options.paths,
    nativeSessionLeaseStore,
  );
  const artifactChannel: {
    current?: Pick<WorkerDeviceChannelClient, "prepareArtifact">;
  } = {};
  const actionChannel: {
    current?: Pick<WorkerDeviceChannelClient, "authorizeAction" | "consumeActionAuthorization">;
  } = {};
  const computerUse = await createWorkerComputerUseRuntime({
    configuration,
    paths: options.paths,
    actionChannel,
    broker: runCapabilityBroker,
    toolServerLaunch,
    ...(options.computerUseRuntime === undefined ? {} : { runtime: options.computerUseRuntime }),
  });
  const platformMutation = await createWorkerPlatformMutationProvider({
    configuration,
    paths: options.paths,
    environment,
    actionChannel,
    broker: runCapabilityBroker,
    toolServerLaunch,
  });
  const artifactLifecycle = await FileManifestWorkerArtifactLifecycle.create({
    stagingRoot: options.paths.artifactStagingDirectory,
    sourceCheckoutRoot: options.paths.sourceCheckoutRoot,
    delivery: new WorkerArtifactDeliveryCoordinator({
      channel: {
        prepareArtifact: (manifest) => {
          const current = artifactChannel.current;
          if (current === undefined) {
            throw appError(
              "DAEMON_FAILED",
              "The authenticated Main channel is unavailable for Artifact preparation.",
            );
          }
          return current.prepareArtifact(manifest);
        },
      },
      uploader: new WorkerArtifactUploader({
        transport: new FetchWorkerArtifactUploadTransport(),
      }),
    }),
  });
  const processFactory = new AgentRunProcessFactory({
    adapters,
    sessionStore,
    artifactLifecycle,
    workspaceResolver: new RegisteredWorkerWorkspaceResolver({
      registry: workspaceRegistry,
      ...(configuration.workspaces[0] === undefined
        ? {}
        : { defaultWorkspaceId: configuration.workspaces[0].workspaceId }),
    }),
    initialContextProvider: new LocalKnowledgeInitialContextProvider({ knowledge }),
    runCapabilityProvider: new CompositeWorkerRunCapabilityProvider([
      new WorkerArtifactRunCapabilityProvider({
        broker: runCapabilityBroker,
        toolServerCommand: toolServerLaunch.command,
        toolServerArgsPrefix: toolServerLaunch.argsPrefix,
      }),
      new WorkerKnowledgeRunCapabilityProvider({
        broker: runCapabilityBroker,
        knowledge,
        toolServerCommand: toolServerLaunch.command,
        toolServerArgsPrefix: toolServerLaunch.argsPrefix,
      }),
      ...(platformMutation === undefined ? [] : [platformMutation.provider]),
      computerUse?.provider ?? unavailableComputerUseCapabilityProvider(),
    ]),
    executionPlanResolver: {
      resolve: async ({ assignment, leaseAuthority, isExecutionCurrent }) => {
        const { adapter, probe } = await selectAgentAdapter(
          adapters,
          configuration.agent,
          assignment.agentRequirement,
        );
        const actionAuthorization = probe.capabilities.approvalBridge
          ? new WorkerAgentActionAuthorizer({
              assignment,
              leaseAuthority,
              channel: () => actionChannel.current,
              isExecutionCurrent,
            })
          : undefined;
        return {
          provider: adapter.provider,
          adapterId: adapter.adapterId,
          ...(assignment.agentRequirement?.modelId === undefined
            ? {}
            : { modelId: assignment.agentRequirement.modelId }),
          workstreamId: assignment.workOrder.workOrderId,
          prompt: renderWorkOrderPrompt(assignment),
          sandbox: resolveWorkerAgentSandbox({
            approvalBridge: probe.capabilities.approvalBridge,
            provider: adapter.provider,
          }),
          permissions: resolveWorkerAgentPermissions(probe.capabilities, actionAuthorization),
          limits: {
            wallTimeoutMs: 2 * 60 * 60_000,
            idleTimeoutMs: 20 * 60_000,
            cancellationGraceMs: 15_000,
            leaseTtlMs: 60_000,
            leaseRenewIntervalMs: 20_000,
            maxBufferedEvents: 2_048,
            maxLineBytes: 1_048_576,
            maxDiagnosticBytes: 16_384,
          },
        };
      },
    },
  });
  const runtimeReference: { current?: WorkerRuntime } = {};
  const runLeaseAuthorities = new Map<string, CalibratedWorkerRunLeaseAuthority>();
  const transportResolver = createWorkerTransportResolver({
    configuration,
    managedSecrets,
    channelState,
    artifactChannel,
    actionChannel,
    runLeaseAuthorities,
    runtime: () => runtimeReference.current,
  });
  const workerConfiguration: WorkerConfiguration = {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: configuration.deviceId,
    workerId: configuration.workerId,
    mainDeviceId: configuration.mainDeviceId,
    transportProfile: configuration.transportProfile,
    maxOutboxEntries: 10_000,
    cancelGraceMs: 15_000,
  };
  const runtime = await WorkerRuntime.create({
    configuration: workerConfiguration,
    repository: stateRepository,
    processFactory,
    transportResolver,
    maximumConcurrentRuns: DEFAULT_MAXIMUM_CONCURRENT_RUNS,
    inventoryProvider: createWorkerSchedulingInventoryProvider({
      adapters,
      ...(computerUse === undefined ? {} : { computerUseProbe: computerUse.probe }),
      wakeOnLanProbe: new SystemWakeOnLanProbe(),
      ...(computerUse === undefined
        ? {}
        : { resourceLockProjection: computerUse.resourceLockProjection }),
      environment,
      workspaceRegistry,
    }),
  });
  runtimeReference.current = runtime;
  let closed = false;
  return {
    configuration,
    runtime,
    pulse: () => runtime.pulse(),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      runLeaseAuthorities.clear();
      await runtime.close().catch(() => undefined);
      await runCapabilityBroker.close().catch(() => undefined);
      await platformMutation?.close().catch(() => undefined);
      await computerUse?.close().catch(() => undefined);
      await channelState.close().catch(() => undefined);
      sessionStore.close();
      workspaceRegistry.close();
    },
  };
}

interface WorkerComputerUseRuntimeComposition {
  readonly provider: WorkerRunCapabilityProvider;
  readonly probe: WorkerComputerUseCapabilityProbe;
  resourceLockProjection(): Promise<
    NonNullable<WorkerSchedulingInventoryV1["resourceLocks"]>[number]
  >;
  close(): Promise<void>;
}

async function createWorkerComputerUseRuntime(input: {
  readonly configuration: WorkerConfigurationDocument;
  readonly paths: WorkerPaths;
  readonly broker: LocalRunCapabilityBroker;
  readonly toolServerLaunch: {
    readonly command: string;
    readonly argsPrefix: readonly string[];
  };
  readonly actionChannel: {
    current?: Pick<WorkerDeviceChannelClient, "authorizeAction" | "consumeActionAuthorization">;
  };
  readonly runtime?: WorkerComputerUseRuntimePort;
}): Promise<WorkerComputerUseRuntimeComposition | undefined> {
  if (input.runtime === undefined) {
    return undefined;
  }
  const hostOsFamily = osFamily(platform());
  if (typeof input.runtime.acquire !== "function") {
    throw appError("CONFIG_INVALID", "The authenticated Computer Use runtime provider is invalid.");
  }
  const desktopAuthority = new SqliteWorkerDesktopLeaseAuthority({
    filename: input.paths.desktopLeaseStateFile,
    sourceCheckoutDirectory: input.paths.sourceCheckoutRoot,
  });
  const startHistory = new SqliteComputerUseStartHistory({
    filename: input.paths.computerUseStartStateFile,
    sourceCheckoutDirectory: input.paths.sourceCheckoutRoot,
  });
  try {
    const runtimePort = input.runtime;
    const provider: WorkerRunCapabilityProvider = Object.freeze({
      async prepare(context: {
        readonly assignment: WorkerRunAssignmentV1;
        readonly leaseAuthority: WorkerRunLeaseAuthority;
        isExecutionCurrent(): Promise<boolean>;
      }) {
        if (!context.assignment.workOrder.requiredCapabilities.includes("computer-use")) {
          return undefined;
        }
        const runtimeLease = await acquireComputerUseRuntimeLease(runtimePort, hostOsFamily);
        if (runtimeLease === undefined) {
          throw new Error("The authenticated user-session Computer Use helper is unavailable.");
        }
        try {
          const binding = Object.freeze({ ...runtimeLease.binding });
          const exactProvider = new WorkerComputerUseRunCapabilityProvider({
            backendFactory: (backendContext) =>
              new ComputerUseOsBackend({
                osFamily: hostOsFamily,
                driver: runtimeLease.driver,
                authority: runtimeLease.authority,
                leases: backendContext.leases,
                startHistory,
                authorizer: new WorkerComputerUseInputAuthorizer({
                  assignment: backendContext.assignment,
                  leaseAuthority: backendContext.leaseAuthority,
                  channel: () => input.actionChannel.current,
                  isExecutionCurrent: backendContext.isExecutionCurrent,
                }),
                clock: { now: () => Date.now() },
                logger: { write() {} },
              }),
            broker: input.broker,
            desktopAuthority,
            desktopBinding: binding,
            toolServerCommand: input.toolServerLaunch.command,
            toolServerArgsPrefix: input.toolServerLaunch.argsPrefix,
          });
          const capability = await exactProvider.prepare(context);
          if (capability === undefined) {
            throw new Error("The Computer Use capability provider returned no exact lease.");
          }
          let disposed = false;
          return Object.freeze({
            toolServers: capability.toolServers,
            async dispose() {
              if (disposed) {
                return;
              }
              disposed = true;
              try {
                await capability.dispose();
              } finally {
                await runtimeLease.release().catch(() => undefined);
              }
            },
          });
        } catch (error) {
          await runtimeLease.release().catch(() => undefined);
          throw error;
        }
      },
    });
    let closed = false;
    return Object.freeze({
      provider,
      resourceLockProjection: () => desktopAuthority.resourceLockProjection(),
      probe: Object.freeze({
        async probe() {
          const runtimeLease = await acquireComputerUseRuntimeLease(runtimePort, hostOsFamily);
          if (runtimeLease === undefined) {
            return Object.freeze({ verification: "unavailable" as const });
          }
          try {
            const readinessBackend = new ComputerUseOsBackend({
              osFamily: hostOsFamily,
              driver: runtimeLease.driver,
              authority: runtimeLease.authority,
              leases: readinessOnlyDesktopLeasePort(),
              startHistory,
              authorizer: readinessOnlyComputerUseAuthorizer(),
              clock: { now: () => Date.now() },
              logger: { write() {} },
            });
            const report = await readinessBackend.readiness({
              deviceId: input.configuration.deviceId,
              ...runtimeLease.binding,
            });
            return Object.freeze({
              verification:
                report.status === "ready" && report.checks.every((check) => check.status === "pass")
                  ? ("verified" as const)
                  : report.checks.some((check) => check.status === "pass")
                    ? ("degraded" as const)
                    : ("unavailable" as const),
            });
          } finally {
            await runtimeLease.release().catch(() => undefined);
          }
        },
      }),
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        startHistory.close();
        desktopAuthority.close();
      },
    });
  } catch (error) {
    startHistory.close();
    desktopAuthority.close();
    throw error;
  }
}

async function acquireComputerUseRuntimeLease(
  port: WorkerComputerUseRuntimePort,
  hostOsFamily: "linux" | "macos" | "windows",
): Promise<WorkerComputerUseRuntimeLease | undefined> {
  let lease: WorkerComputerUseRuntimeLease | undefined;
  try {
    lease = await port.acquire();
    if (lease === undefined) {
      return undefined;
    }
    if (
      lease.driver.osFamily !== hostOsFamily ||
      typeof lease.authority?.verify !== "function" ||
      typeof lease.release !== "function" ||
      !validRuntimeIdentifier(lease.binding.helperInstanceId) ||
      !Number.isSafeInteger(lease.binding.serviceEpoch) ||
      lease.binding.serviceEpoch <= 0 ||
      !Number.isSafeInteger(lease.binding.persistenceGeneration) ||
      lease.binding.persistenceGeneration <= 0
    ) {
      throw new Error("invalid");
    }
    return lease;
  } catch {
    await lease?.release().catch(() => undefined);
    throw appError(
      "DAEMON_FAILED",
      "The authenticated Computer Use helper returned an invalid runtime lease.",
    );
  }
}

function readinessOnlyDesktopLeasePort(): DesktopLeasePort {
  return Object.freeze({
    async verify() {
      return {
        status: "unavailable" as const,
        reason: "No Run-scoped desktop lease is available during readiness probing.",
        verifiedAtMs: Date.now(),
      };
    },
  });
}

function readinessOnlyComputerUseAuthorizer() {
  return Object.freeze({
    authorize(request: {
      readonly authorizationRequestId: string;
      readonly fingerprint: `sha256:${string}`;
    }) {
      return {
        decision: "deny" as const,
        authorizationId: `readiness-only:${request.authorizationRequestId}`,
        fingerprint: request.fingerprint,
        reason: "Readiness probing cannot authorize native input.",
      };
    },
    consume() {
      throw new Error("Readiness probing cannot consume native input authority.");
    },
  });
}

function unavailableComputerUseCapabilityProvider(): WorkerRunCapabilityProvider {
  return Object.freeze({
    async prepare({
      assignment,
    }: {
      readonly assignment: WorkerRunAssignmentV1;
      readonly leaseAuthority: WorkerRunLeaseAuthority;
      isExecutionCurrent(): Promise<boolean>;
    }) {
      if (assignment.workOrder.requiredCapabilities.includes("computer-use")) {
        throw new Error("The authenticated user-session Computer Use helper is unavailable.");
      }
      return undefined;
    },
  });
}

interface WorkerPlatformMutationRuntimeComposition {
  readonly provider: WorkerPlatformMutationRunCapabilityProvider;
  close(): Promise<void>;
}

async function createWorkerPlatformMutationProvider(input: {
  readonly configuration: WorkerConfigurationDocument;
  readonly paths: WorkerPaths;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly actionChannel: {
    current?: Pick<WorkerDeviceChannelClient, "authorizeAction" | "consumeActionAuthorization">;
  };
  readonly broker: LocalRunCapabilityBroker;
  readonly toolServerLaunch: {
    readonly command: string;
    readonly argsPrefix: readonly string[];
  };
}): Promise<WorkerPlatformMutationRuntimeComposition | undefined> {
  if (input.configuration.platformMutation === undefined) {
    return undefined;
  }
  const executables: Partial<Record<PlatformMutationExecutableId, string>> = {};
  const canonicalCheckout = await realpath(input.paths.sourceCheckoutRoot);
  const hostPlatform = osFamily(platform());
  for (const [executableId, configuredPath] of Object.entries(
    input.configuration.platformMutation.executables,
  ) as Array<[PlatformMutationExecutableId, string]>) {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(configuredPath);
      const metadata = await lstat(canonicalPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("not a regular executable");
      }
      if (hostPlatform !== "windows" && (metadata.mode & 0o111) === 0) {
        throw new Error("not executable by any POSIX identity");
      }
    } catch {
      throw appError(
        "CONFIG_PATH_UNSAFE",
        `The configured ${executableId} platform mutation executable is unavailable.`,
      );
    }
    if (isWithin(canonicalCheckout, canonicalPath)) {
      throw appError(
        "CONFIG_PATH_UNSAFE",
        "Platform mutation executables must remain outside the source checkout.",
      );
    }
    executables[executableId] = canonicalPath;
  }
  const executableIds = Object.freeze(
    Object.keys(executables).sort() as PlatformMutationExecutableId[],
  );
  if (executableIds.length === 0) {
    throw appError(
      "CONFIG_INVALID",
      "The platform mutation capability requires at least one configured executable.",
    );
  }
  const journal = createNativePlatformMutationJournal({
    stateRoot: input.paths.stateDirectory,
    boundary: createNodeNativeServiceJournalAtomicBoundary(),
  });
  const systemPackageSourceVerifier = await createConfiguredSystemPackageVerifier({
    platform: hostPlatform,
    executables,
  });
  const safetyBoundary = await createWorkerPlatformMutationSafetyBoundary({
    stateDirectory: input.paths.stateDirectory,
    sourceCheckoutRoot: input.paths.sourceCheckoutRoot,
    environment: input.environment,
    executablePaths: executableIds.map((id) => executables[id] as string),
    systemPackageSourceVerifier,
  });
  try {
    const nativeProcessRunner = createNodePlatformMutationProcessRunner({
      environment: safetyBoundary.environment,
    });
    const shellFreeProcessRunner =
      hostPlatform === "windows" && executables.npm !== undefined
        ? await createPinnedWindowsNpmProcessRunner({
            npmCommandPath: executables.npm,
            runner: nativeProcessRunner,
          })
        : nativeProcessRunner;
    const processRunner = safetyBoundary.wrapProcessRunner(shellFreeProcessRunner);
    const provider = new WorkerPlatformMutationRunCapabilityProvider({
      broker: input.broker,
      platform: hostPlatform,
      executableIds,
      toolServerCommand: input.toolServerLaunch.command,
      toolServerArgsPrefix: input.toolServerLaunch.argsPrefix,
      executorFactory: ({ assignment, workspace, leaseAuthority, isExecutionCurrent }) =>
        createPlatformMutationExecutor({
          platform: hostPlatform,
          executables,
          authorization: new WorkerAgentActionAuthorizer({
            assignment,
            leaseAuthority,
            channel: () => input.actionChannel.current,
            isExecutionCurrent,
          }),
          journal,
          processPreflight: safetyBoundary.processPreflight,
          processRunner: bindPlatformMutationProcessRunnerToWorkspace(processRunner, workspace),
        }),
    });
    return Object.freeze({
      provider,
      close: () => safetyBoundary.close(),
    });
  } catch (error) {
    await safetyBoundary.close().catch(() => undefined);
    throw error;
  }
}

function workerToolServerLaunch(): {
  readonly command: string;
  readonly argsPrefix: readonly string[];
} {
  const modulePath = fileURLToPath(import.meta.url);
  if (extname(modulePath).toLowerCase() === ".ts") {
    return Object.freeze({
      command: process.execPath,
      argsPrefix: Object.freeze([
        "--experimental-strip-types",
        join(dirname(modulePath), "cli.ts"),
      ]),
    });
  }
  return Object.freeze({
    command: process.execPath,
    argsPrefix: Object.freeze([modulePath]),
  });
}

function validRuntimeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 512
  );
}

export async function diagnoseWorker(input: {
  readonly paths: WorkerPaths;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<WorkerDiagnosticSnapshot> {
  const configuration = await loadWorkerConfiguration(input.paths);
  const managedSecrets = createWorkerManagedSecretStore(
    configuration.secretBackend,
    configuration.deviceId,
    input.paths,
    input.environment ?? process.env,
  );
  const [health, keyAvailability] = await Promise.all([
    managedSecrets.health(),
    managedSecrets.availability(`${PRIVATE_KEY_ALIAS_PREFIX}${configuration.keyId}`),
  ]);
  const agents = await Promise.all(
    createWorkerAgentAdapters(configuration.agent, input.paths).map(async (adapter) => {
      const probe = await adapter.probe();
      return {
        adapterId: adapter.adapterId,
        provider: adapter.provider,
        installed: probe.installed,
        authState: probe.auth.state,
        ...(probe.compatibility === undefined ? {} : { compatibility: probe.compatibility }),
        ...(probe.version === undefined ? {} : { version: probe.version }),
      };
    }),
  );
  return deepFreeze({
    enrolled: true,
    deviceId: configuration.deviceId,
    workerId: configuration.workerId,
    mainDeviceId: configuration.mainDeviceId,
    certificateGeneration: configuration.certificateGeneration,
    channelEndpointCount: configuration.transportProfile.endpoints.length,
    secretBackend: configuration.secretBackend.backend,
    secretStoreStatus: health.status,
    identityKeyReady: keyAvailability.ready,
    agents,
  });
}

export async function runWorkerDaemon(options: RunWorkerDaemonOptions): Promise<void> {
  const reconnectMinimumMs = boundedInterval(options.reconnectMinimumMs ?? 1_000);
  const reconnectMaximumMs = boundedInterval(options.reconnectMaximumMs ?? 30_000);
  const heartbeatIntervalMs = boundedInterval(options.heartbeatIntervalMs ?? 15_000);
  if (reconnectMinimumMs > reconnectMaximumMs) {
    throw appError("CONFIG_INVALID", "Worker reconnect intervals are invalid.");
  }
  const composition = await createWorkerRuntime(options);
  try {
    await runWorkerConnectionLoop(composition, {
      reconnectMinimumMs,
      reconnectMaximumMs,
      heartbeatIntervalMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
    });
  } finally {
    await composition.close();
  }
}

export async function runWorkerConnectionLoop(
  composition: Pick<WorkerRuntimeComposition, "pulse" | "runtime">,
  options: {
    readonly reconnectMinimumMs: number;
    readonly reconnectMaximumMs: number;
    readonly heartbeatIntervalMs: number;
    readonly signal?: AbortSignal;
    readonly onReady?: () => void | Promise<void>;
  },
): Promise<void> {
  let backoff = options.reconnectMinimumMs;
  let readyReported = false;
  while (!isAborted(options.signal)) {
    const result = await composition.runtime.connect();
    if (!result.connected) {
      await abortableDelay(backoff, options.signal);
      backoff = Math.min(options.reconnectMaximumMs, backoff * 2);
      continue;
    }
    backoff = options.reconnectMinimumMs;
    if (!readyReported) {
      await options.onReady?.();
      readyReported = true;
    }
    while (!isAborted(options.signal)) {
      await abortableDelay(options.heartbeatIntervalMs, options.signal);
      if (isAborted(options.signal) || !(await composition.pulse())) {
        break;
      }
    }
  }
}

export async function defaultSecretBackend(input: {
  readonly paths: WorkerPaths;
  readonly installationRoot: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly hostPlatform?: NodeJS.Platform;
}): Promise<WorkerSecretBackendConfiguration> {
  const hostPlatform = input.hostPlatform ?? process.platform;
  const environment = input.environment ?? process.env;
  if (hostPlatform === "win32") {
    return {
      backend: "windows-dpapi",
      vaultRoot: join(input.paths.home, "secrets", "dpapi"),
    };
  }
  if (hostPlatform === "darwin") {
    const helperPath = join(
      requireAbsolutePath(input.installationRoot, "installation root"),
      "runtime",
      "native",
      "opendelegate-keychain-helper",
    );
    const bytes = await readFile(helperPath).catch(() => undefined);
    if (bytes === undefined) {
      throw appError(
        "SECRET_BACKEND_UNAVAILABLE",
        "The signed macOS Keychain helper is missing from this installation.",
      );
    }
    return {
      backend: "macos-keychain",
      helperPath,
      expectedHelperSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  }
  if (hostPlatform === "linux" && environment["DBUS_SESSION_BUS_ADDRESS"]?.trim()) {
    return {
      backend: "linux-secret-service",
      secretToolPath: "/usr/bin/secret-tool",
    };
  }
  throw appError(
    "SECRET_BACKEND_UNAVAILABLE",
    hostPlatform === "linux"
      ? "Auto could not find a graphical Secret Service. A headless systemd host must use worker secret-backend-provision and pass its descriptor to worker join."
      : "Auto could not find a supported managed Secret Store for this host session.",
  );
}

export async function provisionHeadlessLinuxSecretBackend(
  options: ProvisionHeadlessLinuxSecretBackendOptions,
): Promise<
  Extract<WorkerSecretBackendConfiguration, { backend: "linux-systemd-credential-vault" }>
> {
  if ((options.hostPlatform ?? process.platform) !== "linux") {
    throw appError(
      "SECRET_BACKEND_UNAVAILABLE",
      "Headless systemd credential provisioning is available only on Linux.",
    );
  }
  const sourceCheckoutRoot = requireAbsolutePath(
    options.sourceCheckoutRoot,
    "source checkout root",
  );
  const configurationFile = requireExternalProvisioningPath(
    options.configurationFile,
    sourceCheckoutRoot,
    "Secret backend descriptor",
  );
  const encryptedCredentialFile = requireExternalProvisioningPath(
    options.encryptedCredentialFile,
    sourceCheckoutRoot,
    "encrypted systemd credential",
  );
  const vaultRoot = requireExternalProvisioningPath(
    options.vaultRoot,
    sourceCheckoutRoot,
    "vault root",
  );
  if (
    configurationFile === encryptedCredentialFile ||
    pathsEqualForCurrentHost(dirname(configurationFile), dirname(encryptedCredentialFile)) ||
    isWithin(vaultRoot, configurationFile) ||
    isWithin(vaultRoot, encryptedCredentialFile)
  ) {
    throw appError(
      "CONFIG_PATH_UNSAFE",
      "The descriptor, encrypted credential, and ciphertext vault must use disjoint paths.",
    );
  }
  const credentialName = strictCredentialName(options.credentialName ?? "opendelegate-vault-key");
  const systemdCredsPath = requireAbsolutePath(
    options.systemdCredsPath ?? "/usr/bin/systemd-creds",
    "systemd-creds executable",
  );
  await prepareProvisioningParent(configurationFile, 0o755);
  await prepareProvisioningParent(encryptedCredentialFile, 0o700);
  await assertProvisioningTargetAbsent(configurationFile);
  await assertProvisioningTargetAbsent(encryptedCredentialFile);

  const key = Buffer.from((options.randomKey ?? (() => randomBytes(32)))());
  if (key.byteLength !== 32) {
    key.fill(0);
    throw appError("CONFIG_INVALID", "The generated systemd credential key is invalid.");
  }
  let encrypted: Buffer | undefined;
  try {
    const command = await (options.runner ?? new NodeNativeSecretCommandRunner()).run({
      executable: systemdCredsPath,
      args: ["encrypt", `--name=${credentialName}`, "-", "-"],
      environment: {},
      stdin: key,
      maximumStdoutBytes: MAXIMUM_ENCRYPTED_CREDENTIAL_BYTES,
      timeoutMs: 120_000,
    });
    encrypted = command.stdout;
    if (
      command.exitCode !== 0 ||
      encrypted.byteLength === 0 ||
      encrypted.byteLength > MAXIMUM_ENCRYPTED_CREDENTIAL_BYTES ||
      encrypted.indexOf(key) !== -1
    ) {
      throw appError(
        "SECRET_BACKEND_UNAVAILABLE",
        "systemd-creds did not produce a valid encrypted credential.",
      );
    }
    await writeFile(encryptedCredentialFile, encrypted, {
      flag: "wx",
      mode: 0o600,
    });
    const descriptor = deepFreeze({
      backend: "linux-systemd-credential-vault" as const,
      credentialName,
      encryptedCredentialFile,
      vaultRoot,
    });
    try {
      await writeFile(configurationFile, `${JSON.stringify(descriptor, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
    } catch {
      await unlink(encryptedCredentialFile).catch(() => undefined);
      throw appError(
        "CONFIG_PATH_UNSAFE",
        "The headless Secret backend descriptor could not be created safely.",
      );
    }
    return descriptor;
  } catch (error) {
    if (error instanceof WorkerAppError) {
      throw error;
    }
    throw appError(
      "SECRET_BACKEND_UNAVAILABLE",
      "Headless systemd credential provisioning did not complete.",
    );
  } finally {
    key.fill(0);
    encrypted?.fill(0);
  }
}

export async function prepareWindowsServiceSecretBackend(
  options: PrepareWindowsServiceSecretBackendOptions,
): Promise<Extract<WorkerSecretBackendConfiguration, { backend: "windows-service-dpapi" }>> {
  if ((options.hostPlatform ?? process.platform) !== "win32") {
    throw appError(
      "SECRET_BACKEND_UNAVAILABLE",
      "Windows service Secret staging is available only on Windows.",
    );
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(options.instanceId)) {
    throw appError("CONFIG_INVALID", "The Windows service Instance ID is invalid.");
  }
  const configuration = await loadWorkerConfiguration(options.paths);
  const handoffRoot = requireExternalProvisioningPath(
    options.handoffRoot,
    options.paths.sourceCheckoutRoot,
    "Windows service Secret handoff root",
  );
  const vaultRoot = requireExternalProvisioningPath(
    options.vaultRoot,
    options.paths.sourceCheckoutRoot,
    "Windows service Secret vault root",
  );
  if (
    pathsEqualForCurrentHost(handoffRoot, vaultRoot) ||
    isWithin(handoffRoot, vaultRoot) ||
    isWithin(vaultRoot, handoffRoot)
  ) {
    throw appError(
      "CONFIG_PATH_UNSAFE",
      "The Windows service handoff and persistent Secret vault must be disjoint.",
    );
  }
  const serviceName = `OpenDelegate-${options.instanceId}`;
  let serviceSid: string;
  try {
    serviceSid = await resolveWindowsServiceSid({
      serviceName,
      ...(options.hostPlatform === undefined ? {} : { hostPlatform: options.hostPlatform }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(options.scPath === undefined ? {} : { scPath: options.scPath }),
    });
  } catch {
    throw appError(
      "SECRET_BACKEND_UNAVAILABLE",
      "The Windows service SID could not be resolved safely.",
    );
  }
  const target = Object.freeze({
    backend: "windows-service-dpapi" as const,
    handoffRoot,
    serviceName,
    serviceSid,
    vaultRoot,
  });
  if (configuration.secretBackend.backend === "windows-service-dpapi") {
    if (
      configuration.secretBackend.handoffRoot !== handoffRoot ||
      configuration.secretBackend.serviceName !== serviceName ||
      configuration.secretBackend.serviceSid !== serviceSid ||
      configuration.secretBackend.vaultRoot !== vaultRoot
    ) {
      throw appError(
        "CONFIG_INVALID",
        "The enrolled Worker is already bound to a different Windows service Secret backend.",
      );
    }
    return target;
  }
  if (configuration.secretBackend.backend !== "windows-dpapi") {
    throw appError(
      "CONFIG_INVALID",
      "Only a foreground Windows DPAPI enrollment can be staged for the Windows service identity.",
    );
  }
  if (
    pathsEqualForCurrentHost(configuration.secretBackend.vaultRoot, handoffRoot) ||
    pathsEqualForCurrentHost(configuration.secretBackend.vaultRoot, vaultRoot) ||
    isWithin(configuration.secretBackend.vaultRoot, handoffRoot) ||
    isWithin(configuration.secretBackend.vaultRoot, vaultRoot) ||
    isWithin(handoffRoot, configuration.secretBackend.vaultRoot) ||
    isWithin(vaultRoot, configuration.secretBackend.vaultRoot)
  ) {
    throw appError(
      "CONFIG_PATH_UNSAFE",
      "Foreground, handoff, and service Secret vaults must be disjoint.",
    );
  }

  const ownerStore = new WindowsDpapiSecretStore({
    deviceId: configuration.deviceId,
    hostPlatform: "win32",
    ...(options.powershellPath === undefined ? {} : { powershellPath: options.powershellPath }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    sourceCheckoutRoot: options.paths.sourceCheckoutRoot,
    vaultRoot: configuration.secretBackend.vaultRoot,
  });
  const handoff = new WindowsServiceDpapiSecretHandoff({
    deviceId: configuration.deviceId,
    handoffRoot,
    hostPlatform: "win32",
    ...(options.powershellPath === undefined ? {} : { powershellPath: options.powershellPath }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    serviceSid,
    sourceCheckoutRoot: options.paths.sourceCheckoutRoot,
  });
  const coreAliases = Object.freeze([
    `${PRIVATE_KEY_ALIAS_PREFIX}${configuration.keyId}`,
    WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS,
    WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
  ]);
  try {
    // The logged-in session helper owns this key. It intentionally remains in
    // the owner DPAPI vault and is never staged for or opened by the service.
    await provisionWorkerSessionHelperOwnerSigningSecret(ownerStore);

    // Phase one is copy-only. A failure leaves every source Secret intact, so a
    // later invocation can safely resume even if some handoff entries exist.
    for (const alias of coreAliases) {
      const sourceReady = (await ownerStore.availability(alias)).ready;
      const handoffReady = (await handoff.availability(alias)).ready;
      if (sourceReady) {
        await ownerStore.executeWithSecretBytes(alias, async (value) => {
          await handoff.stage(alias, value);
        });
      } else if (!handoffReady) {
        throw appError(
          "SECRET_BACKEND_UNAVAILABLE",
          "A required core Secret is unavailable from both the foreground vault and the resumable service handoff.",
        );
      }
    }
    for (const alias of coreAliases) {
      if (!(await handoff.availability(alias)).ready) {
        throw appError(
          "SECRET_BACKEND_UNAVAILABLE",
          "The Windows service Secret handoff is incomplete.",
        );
      }
    }

    // Phase two removes only core-owned source copies after every handoff entry
    // is durable. The owner helper key is deliberately not in this collection.
    for (const alias of coreAliases) {
      if ((await ownerStore.availability(alias)).ready) {
        await ownerStore.delete(alias);
      }
    }
    const updated = validateWorkerConfigurationDocument({
      ...configuration,
      secretBackend: target,
    });
    await writeConfiguration(options.paths.configFile, updated);
    return target;
  } catch (error) {
    if (error instanceof WorkerAppError) {
      throw error;
    }
    throw appError(
      "SECRET_BACKEND_UNAVAILABLE",
      "The Windows service Secret handoff did not complete.",
    );
  }
}

export async function loadWorkerSecretBackendConfiguration(
  filenameInput: string,
  sourceCheckoutRootInput: string,
): Promise<WorkerSecretBackendConfiguration> {
  const sourceCheckoutRoot = requireAbsolutePath(sourceCheckoutRootInput, "source checkout root");
  const filename = requireExternalProvisioningPath(
    filenameInput,
    sourceCheckoutRoot,
    "Secret backend descriptor",
  );
  let bytes: Buffer;
  try {
    bytes = await readStableWorkerFile(filename, MAXIMUM_SECRET_BACKEND_CONFIG_BYTES);
    if (bytes.byteLength === 0) {
      throw new Error("unsafe");
    }
  } catch {
    throw appError("CONFIG_PATH_UNSAFE", "The Secret backend descriptor is missing or unsafe.");
  }
  try {
    return validateSecretBackend(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof WorkerAppError) {
      throw error;
    }
    throw appError("CONFIG_INVALID", "The Secret backend descriptor is invalid.");
  } finally {
    bytes.fill(0);
  }
}

async function readStableWorkerFile(path: string, maximumBytes: number): Promise<Buffer> {
  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fileConstants.O_NONBLOCK ?? 0;
  const handle = await open(path, fileConstants.O_RDONLY | noFollow | nonBlocking);
  let bytes: Buffer | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      !sameWorkerFile(opened, named) ||
      opened.size > BigInt(maximumBytes)
    ) {
      throw new Error("unsafe");
    }
    bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new Error("unsafe");
      }
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterNamed = await lstat(path, { bigint: true });
    if (
      afterNamed.isSymbolicLink() ||
      !afterNamed.isFile() ||
      !sameWorkerSnapshot(opened, after) ||
      !sameWorkerSnapshot(after, afterNamed)
    ) {
      throw new Error("unsafe");
    }
    const result = bytes;
    bytes = undefined;
    return result;
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

function sameWorkerFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino === right.ino &&
    (left.dev === right.dev ||
      (process.platform === "win32" &&
        (left.dev === 0n || right.dev === 0n) &&
        left.birthtimeNs === right.birthtimeNs))
  );
}

function sameWorkerSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameWorkerFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function createWorkerTransportResolver(input: {
  readonly configuration: WorkerConfigurationDocument;
  readonly managedSecrets: ManagedSecretStore;
  readonly channelState: SqliteWorkerChannelState;
  readonly artifactChannel: {
    current?: Pick<WorkerDeviceChannelClient, "prepareArtifact">;
  };
  readonly actionChannel: {
    current?: Pick<WorkerDeviceChannelClient, "authorizeAction" | "consumeActionAuthorization">;
  };
  readonly runLeaseAuthorities: Map<string, CalibratedWorkerRunLeaseAuthority>;
  readonly runtime: () => WorkerRuntime | undefined;
}): TransportResolver<WorkerMainConnection> {
  return {
    async connect(profile): Promise<TransportResolution<WorkerMainConnection>> {
      const attempts: TransportAttemptTrace[] = [];
      for (const endpoint of profile.endpoints) {
        if (endpoint.kind !== "wss") {
          attempts.push({
            endpointId: endpoint.endpointId,
            label: endpoint.label,
            kind: endpoint.kind,
            probeSource: "not-run",
            outcome: "skipped-incompatible",
          });
          continue;
        }
        try {
          const client = await WorkerDeviceChannelClient.connect({
            endpointUrl: endpoint.url,
            deviceId: input.configuration.deviceId,
            workerId: input.configuration.workerId,
            mainDeviceId: input.configuration.mainDeviceId,
            identity: {
              certificatePem: input.configuration.certificatePem,
              certificateAuthorityPem: input.configuration.certificateAuthorityPem,
              certificateGeneration: input.configuration.certificateGeneration,
              executeWithPrivateKeyBytes: (executor) =>
                input.managedSecrets.executeWithSecretBytes(
                  `${PRIVATE_KEY_ALIAS_PREFIX}${input.configuration.keyId}`,
                  executor,
                ),
            },
            state: input.channelState,
            onDispatch: async (frame, channel) =>
              handleDispatch(input.runtime(), frame, channel, input.runLeaseAuthorities),
            onRunLeaseDecision: async (observation) =>
              acceptRunLeaseDecision(input.runLeaseAuthorities, observation),
            onRunSteer: async (frame) => handleRunSteering(input.runtime(), frame),
            onControl: async (frame) => handleControl(input.runtime(), frame),
            onRevoked: async () => {
              await input.runtime()?.setOperationalState("revoked", "Main revoked this Device.");
            },
          });
          for (const [runId, authority] of input.runLeaseAuthorities) {
            if (!authority.attach(client)) {
              input.runLeaseAuthorities.delete(runId);
            }
          }
          input.artifactChannel.current = client;
          input.actionChannel.current = client;
          const connection: WorkerMainConnection = {
            sendEvents: (events) => client.sendEvents(events),
            sendHeartbeat: (heartbeat) => client.sendHeartbeat(heartbeat),
            close: async () => {
              if (input.artifactChannel.current === client) {
                delete input.artifactChannel.current;
              }
              if (input.actionChannel.current === client) {
                delete input.actionChannel.current;
              }
              await client.close();
            },
          };
          return {
            deviceId: profile.deviceId,
            endpointId: endpoint.endpointId,
            kind: "wss",
            connection,
            attemptTrace: Object.freeze([
              ...attempts,
              {
                endpointId: endpoint.endpointId,
                label: endpoint.label,
                kind: "wss" as const,
                probeSource: "live" as const,
                outcome: "connected" as const,
              },
            ]),
          };
        } catch {
          attempts.push({
            endpointId: endpoint.endpointId,
            label: endpoint.label,
            kind: endpoint.kind,
            probeSource: "live",
            outcome: "connect-failed",
            diagnostic: { code: "TRANSPORT_BOUNDARY_ERROR" },
          });
        }
      }
      throw new TransportRoutesExhaustedError(profile.deviceId, attempts);
    },
  };
}

async function verifyInitialWorkerChannel(input: {
  readonly configuration: WorkerConfigurationDocument;
  readonly managedSecrets: ManagedSecretStore;
  readonly paths: WorkerPaths;
}): Promise<boolean> {
  let channelState: SqliteWorkerChannelState | undefined;
  try {
    channelState = await SqliteWorkerChannelState.open({
      filename: input.paths.channelStateFile,
      sourceCheckoutRoot: input.paths.sourceCheckoutRoot,
      deviceId: input.configuration.deviceId,
      mainDeviceId: input.configuration.mainDeviceId,
      certificateGeneration: input.configuration.certificateGeneration,
    });
    for (const endpoint of input.configuration.transportProfile.endpoints) {
      let client: WorkerDeviceChannelClient | undefined;
      try {
        client = await WorkerDeviceChannelClient.connect({
          endpointUrl: endpoint.url,
          deviceId: input.configuration.deviceId,
          workerId: input.configuration.workerId,
          mainDeviceId: input.configuration.mainDeviceId,
          identity: {
            certificatePem: input.configuration.certificatePem,
            certificateAuthorityPem: input.configuration.certificateAuthorityPem,
            certificateGeneration: input.configuration.certificateGeneration,
            executeWithPrivateKeyBytes: (executor) =>
              input.managedSecrets.executeWithSecretBytes(
                `${PRIVATE_KEY_ALIAS_PREFIX}${input.configuration.keyId}`,
                executor,
              ),
          },
          state: channelState,
          connectTimeoutMs: 15_000,
          onDispatch: async () => {
            throw new Error("A Worker cannot accept dispatch during enrollment validation.");
          },
          onControl: async () => {
            throw new Error("A Worker cannot accept control during enrollment validation.");
          },
          onRevoked: async () => {
            throw new Error("Main revoked the Device during enrollment validation.");
          },
        });
        await client.close();
        return true;
      } catch {
        await client?.close().catch(() => undefined);
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    await channelState?.close().catch(() => undefined);
  }
}

async function handleDispatch(
  runtime: WorkerRuntime | undefined,
  frame: MainDispatchFrameV1,
  channel: WorkerDeviceChannelClient,
  authorities: Map<string, CalibratedWorkerRunLeaseAuthority>,
): Promise<void> {
  if (runtime === undefined) {
    throw appError("DAEMON_FAILED", "Worker runtime is not ready.");
  }
  let authority = authorities.get(frame.payload.runId);
  if (authority === undefined) {
    authority = channel.createRunLeaseAuthority(frame.payload);
    authorities.set(frame.payload.runId, authority);
  } else if (!authority.attach(channel)) {
    authorities.delete(frame.payload.runId);
    throw appError("DAEMON_FAILED", "A replayed dispatch cannot revive an expired Run authority.");
  }
  const acceptance = await runtime.acceptAssignment(
    {
      protocolVersion: PROTOCOL_VERSION,
      messageId: frame.messageId,
      senderDeviceId: frame.senderDeviceId,
      correlationId: frame.correlationId,
      createdAt: frame.createdAt,
      idempotencyKey: frame.idempotencyKey,
      type: "worker.run.assign",
      payload: frame.payload,
    },
    authority,
  );
  if (acceptance.disposition === "rejected") {
    authorities.delete(frame.payload.runId);
  }
}

function acceptRunLeaseDecision(
  authorities: Map<string, CalibratedWorkerRunLeaseAuthority>,
  observation: WorkerRunLeaseDecisionObservation,
): void {
  const authority = authorities.get(observation.frame.payload.runId);
  if (authority === undefined) {
    return;
  }
  authority.acceptDecision(observation);
  if (!authority.isCurrent()) {
    authorities.delete(observation.frame.payload.runId);
  }
}

async function handleControl(
  runtime: WorkerRuntime | undefined,
  frame: MainControlFrameV1,
): Promise<void> {
  if (runtime === undefined) {
    throw appError("DAEMON_FAILED", "Worker runtime is not ready.");
  }
  if (frame.payload.action === "cancel") {
    await runtime.cancelRun(frame.payload.runId!, frame.payload.reason);
    return;
  }
  const operationalState =
    frame.payload.action === "disable"
      ? "disabled"
      : frame.payload.action === "drain"
        ? "draining"
        : "revoked";
  await runtime.setOperationalState(operationalState, frame.payload.reason);
}

async function handleRunSteering(runtime: WorkerRuntime | undefined, frame: MainRunSteerFrameV1) {
  if (runtime === undefined) {
    throw appError("DAEMON_FAILED", "Worker runtime is not ready.");
  }
  return await runtime.steerRun(frame.payload);
}

export function createWorkerNativeSessionLeaseStore(paths: WorkerPaths): FileSessionLeaseStore {
  return new FileSessionLeaseStore({
    statePath: paths.nativeSessionLeaseStateFile,
  });
}

export function createWorkerAgentAdapters(
  configuration: WorkerAgentConfiguration,
  paths: WorkerPaths,
  leaseStore: SessionLeaseStore = createWorkerNativeSessionLeaseStore(paths),
): readonly AgentAdapter[] {
  const codexHome =
    configuration.codexHome === undefined
      ? join(paths.stateDirectory, "providers", "codex")
      : requireExternalProvisioningPath(
          configuration.codexHome,
          paths.sourceCheckoutRoot,
          "Codex provider home",
        );
  const claudeHome =
    configuration.claudeHome === undefined
      ? join(paths.stateDirectory, "providers", "claude")
      : requireExternalProvisioningPath(
          configuration.claudeHome,
          paths.sourceCheckoutRoot,
          "Claude provider home",
        );
  return Object.freeze([
    new CodexAppServerAdapter({
      codexHome,
      leaseStore,
      ...(configuration.codexExecutable === undefined
        ? {}
        : { executable: configuration.codexExecutable }),
      allowUntestedVersion: configuration.allowUntestedVersion,
    }),
    new ClaudeAgentSdkAdapter({
      claudeHome,
      leaseStore,
      ...(configuration.claudeExecutable === undefined
        ? {}
        : { authExecutable: configuration.claudeExecutable }),
      ...(configuration.claudeAllowedNetworkDomains === undefined
        ? {}
        : { allowedNetworkDomains: configuration.claudeAllowedNetworkDomains }),
    }),
    new CodexCliAdapter({
      codexHome,
      leaseStore,
      ...(configuration.codexExecutable === undefined
        ? {}
        : { executable: configuration.codexExecutable }),
      allowUntestedVersion: configuration.allowUntestedVersion,
    }),
    new ClaudeCliAdapter({
      claudeHome,
      leaseStore,
      ...(configuration.claudeExecutable === undefined
        ? {}
        : { executable: configuration.claudeExecutable }),
      allowUntestedVersion: configuration.allowUntestedVersion,
    }),
  ]);
}

interface WorkerWakeOnLanCapabilityProbe {
  probe():
    | NonNullable<WorkerSchedulingInventoryV1["wakeOnLan"]>
    | Promise<NonNullable<WorkerSchedulingInventoryV1["wakeOnLan"]>>;
}

export function createWorkerSchedulingInventoryProvider(input: {
  readonly adapters: readonly AgentAdapter[];
  readonly computerUseProbe?: WorkerComputerUseCapabilityProbe;
  readonly wakeOnLanProbe?: WorkerWakeOnLanCapabilityProbe;
  readonly hardwareFactsProvider?: {
    snapshot(
      observedAtMs: number,
    ):
      | NonNullable<WorkerSchedulingInventoryV1["hardware"]>
      | Promise<NonNullable<WorkerSchedulingInventoryV1["hardware"]>>;
  };
  readonly resourceLockProjection?: () => Promise<
    NonNullable<WorkerSchedulingInventoryV1["resourceLocks"]>[number]
  >;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly workspaceRegistry: Pick<SqliteWorkspaceRegistry, "listSchedulingMetadata">;
  readonly probeCacheMs?: number;
}): WorkerSchedulingInventoryProvider {
  const probeCacheMs = input.probeCacheMs ?? 60_000;
  if (!Number.isSafeInteger(probeCacheMs) || probeCacheMs < 0 || probeCacheMs > 3_600_000) {
    throw appError("CONFIG_INVALID", "Worker capability probe cache duration is invalid.");
  }
  let cached:
    | {
        readonly expiresAt: number;
        readonly observedAtMs: number;
        readonly probes: readonly AgentAdapterProbe[];
        readonly modelCatalogs: ReadonlyMap<string, AgentModelCatalog>;
        readonly failedAdapters: readonly Pick<AgentAdapter, "adapterId" | "provider">[];
        readonly wakeOnLan?: NonNullable<WorkerSchedulingInventoryV1["wakeOnLan"]>;
      }
    | undefined;

  return Object.freeze({
    snapshot: async (): Promise<WorkerSchedulingInventoryV1> => {
      const now = Date.now();
      if (cached === undefined || cached.expiresAt <= now) {
        const outcomes = await Promise.allSettled(input.adapters.map((adapter) => adapter.probe()));
        const probes: AgentAdapterProbe[] = [];
        const failedAdapters: Pick<AgentAdapter, "adapterId" | "provider">[] = [];
        outcomes.forEach((outcome, index) => {
          const adapter = input.adapters[index]!;
          if (
            outcome.status === "fulfilled" &&
            outcome.value.contractVersion === 1 &&
            outcome.value.adapterId === adapter.adapterId &&
            outcome.value.provider === adapter.provider
          ) {
            probes.push(outcome.value);
          } else {
            failedAdapters.push({ adapterId: adapter.adapterId, provider: adapter.provider });
          }
        });
        const catalogOutcomes = await Promise.allSettled(
          input.adapters.map(async (adapter): Promise<AgentModelCatalog | undefined> => {
            const probe = probes.find(
              (candidate) =>
                candidate.provider === adapter.provider &&
                candidate.adapterId === adapter.adapterId,
            );
            if (
              probe === undefined ||
              adapter.listModels === undefined ||
              adapterReadiness(probe) !== "ready"
            ) {
              return undefined;
            }
            return await adapter.listModels();
          }),
        );
        const modelCatalogs = new Map<string, AgentModelCatalog>();
        catalogOutcomes.forEach((outcome, index) => {
          if (outcome.status === "fulfilled" && outcome.value !== undefined) {
            const adapter = input.adapters[index]!;
            modelCatalogs.set(
              agentAdapterIdentity(adapter.provider, adapter.adapterId),
              outcome.value,
            );
          }
        });
        const wakeOnLan = await probeWakeOnLanCapability(input.wakeOnLanProbe, now);
        cached = Object.freeze({
          expiresAt: now + probeCacheMs,
          observedAtMs: now,
          probes: Object.freeze(probes),
          modelCatalogs,
          failedAdapters: Object.freeze(failedAdapters),
          ...(wakeOnLan === undefined ? {} : { wakeOnLan: Object.freeze({ ...wakeOnLan }) }),
        });
      }
      const workspaces = (await input.workspaceRegistry.listSchedulingMetadata()).filter(
        (workspace) => workspace.state === "active",
      );
      const capabilityMap = new Map<string, WorkerSchedulingInventoryV1["capabilities"][number]>();
      for (const probe of cached.probes) {
        const name = probe.provider === "claude" ? "claude-code" : probe.provider;
        const verification = !probe.installed
          ? "unavailable"
          : probe.auth.state === "ready" &&
              probe.compatibility === "tested" &&
              probe.capabilities.start &&
              probe.capabilities.resume
            ? "verified"
            : probe.compatibility === "incompatible" || probe.auth.state === "not_ready"
              ? "degraded"
              : "detected";
        setStrongestCapability(capabilityMap, name, {
          name,
          verification,
          observedAtMs: cached.observedAtMs,
          evidenceSource: "agent-adapter",
          ...(probe.version === undefined ? {} : { version: probe.version }),
        });
      }
      for (const workspace of workspaces) {
        for (const capability of workspace.capabilities) {
          setStrongestCapability(capabilityMap, capability, {
            name: capability,
            verification: "verified",
            observedAtMs: now,
            evidenceSource: "workspace-registry",
          });
        }
      }
      const computerUseVerification = await probeComputerUseCapability(input.computerUseProbe);
      // Computer Use is never inferred from a Workspace declaration, installed
      // binary, or OS name. Only the authenticated live helper/authority probe can
      // establish its current verification state.
      capabilityMap.set("computer-use", {
        name: "computer-use",
        verification: computerUseVerification,
        observedAtMs: now,
        evidenceSource: "capability-probe",
      });
      const capabilities = [...capabilityMap]
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([, capability]) => Object.freeze(capability));
      const agentAdapters = [
        ...cached.probes.map((probe) => {
          const catalog = cached!.modelCatalogs.get(
            agentAdapterIdentity(probe.provider, probe.adapterId),
          );
          return Object.freeze({
            provider: schedulingProvider(probe.provider),
            adapterId: probe.adapterId,
            readiness: adapterReadiness(probe),
            compatibility: probe.compatibility,
            ...(probe.version === undefined ? {} : { version: probe.version }),
            observedAtMs: cached!.observedAtMs,
            ...(catalog === undefined
              ? {}
              : {
                  modelCatalogObservedAtMs: Date.parse(catalog.observedAt),
                  models: Object.freeze(
                    catalog.models.map((model) =>
                      Object.freeze({
                        modelId: model.modelId,
                        displayName: model.displayName,
                        ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
                        ...(model.supportedEfforts === undefined
                          ? {}
                          : { supportedEfforts: Object.freeze([...model.supportedEfforts]) }),
                      }),
                    ),
                  ),
                }),
          });
        }),
        ...cached.failedAdapters.map((adapter) =>
          Object.freeze({
            provider: schedulingProvider(adapter.provider),
            adapterId: adapter.adapterId,
            readiness: "unavailable" as const,
            compatibility: "untested" as const,
            observedAtMs: cached!.observedAtMs,
          }),
        ),
      ].sort(
        (left, right) =>
          left.provider.localeCompare(right.provider, "en") ||
          left.adapterId.localeCompare(right.adapterId, "en"),
      );
      const resourceLocks =
        input.resourceLockProjection === undefined
          ? undefined
          : Object.freeze([await input.resourceLockProjection()]);
      const hardware =
        input.hardwareFactsProvider === undefined
          ? localHardwareFacts(now)
          : await input.hardwareFactsProvider.snapshot(now);
      return Object.freeze({
        deviceName: hostname(),
        osFamily: osFamily(platform()),
        platformRelease: release(),
        architecture: arch(),
        serviceMode: workerServiceMode(input.environment),
        hardware,
        ...(cached.wakeOnLan === undefined ? {} : { wakeOnLan: cached.wakeOnLan }),
        // The provider is only composed after LocalKnowledgeService.rebuild()
        // succeeds. No Knowledge graph metadata leaves this Device.
        knowledgeHealth: "healthy",
        maximumConcurrentRuns: DEFAULT_MAXIMUM_CONCURRENT_RUNS,
        capabilities: Object.freeze(capabilities),
        agentAdapters: Object.freeze(agentAdapters),
        ...(resourceLocks === undefined ? {} : { resourceLocks }),
        workspaceIds: Object.freeze(workspaces.map((workspace) => workspace.workspaceId)),
        // Secret aliases are not enumerable through the Device-local Secret Store contract.
        // They stay empty until an owner-approved, non-secret availability registry is composed.
        availableSecretRefs: Object.freeze([]),
      });
    },
  });
}

async function probeWakeOnLanCapability(
  probe: WorkerWakeOnLanCapabilityProbe | undefined,
  observedAtMs: number,
): Promise<NonNullable<WorkerSchedulingInventoryV1["wakeOnLan"]> | undefined> {
  if (probe === undefined) {
    return undefined;
  }
  try {
    const observation = await probe.probe();
    if (
      !["enabled", "disabled", "unsupported", "unknown"].includes(observation.state) ||
      !["windows-netadapter-power", "macos-pmset", "linux-ethtool", "probe-unavailable"].includes(
        observation.source,
      ) ||
      (observation.source === "probe-unavailable" && observation.state !== "unknown") ||
      !Number.isSafeInteger(observation.observedAtMs) ||
      observation.observedAtMs < 0 ||
      observation.observedAtMs > 8_640_000_000_000_000
    ) {
      throw new TypeError("Wake-on-LAN probe returned invalid evidence.");
    }
    return Object.freeze({ ...observation });
  } catch {
    // Optional inventory evidence must never prevent an otherwise healthy
    // Worker heartbeat from reaching Main.
    return Object.freeze({
      state: "unknown",
      source: "probe-unavailable",
      observedAtMs,
    });
  }
}

function localHardwareFacts(
  observedAtMs: number,
): NonNullable<WorkerSchedulingInventoryV1["hardware"]> {
  const processors = cpus();
  const model = boundedHardwareLabel(processors[0]?.model ?? `${arch()} CPU`, "Unknown CPU");
  const memoryBytes = totalmem();
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1) {
    throw appError("CONFIG_INVALID", "The local total-memory observation is invalid.");
  }
  return Object.freeze({
    cpu: Object.freeze({
      model,
      logicalCoreCount: Math.max(1, Math.min(processors.length, 4_096)),
      observedAtMs,
      source: "node-os" as const,
      verification: "observed" as const,
    }),
    memory: Object.freeze({
      totalBytes: memoryBytes,
      observedAtMs,
      source: "node-os" as const,
      verification: "observed" as const,
    }),
    gpu: Object.freeze({
      devices: Object.freeze([]),
      observedAtMs,
      source: "node-os" as const,
      // Node's cross-platform OS contract does not expose GPU inventory. A
      // platform probe may replace this with bounded observed/verified evidence.
      verification: "not-observed" as const,
    }),
  });
}

function boundedHardwareLabel(value: string, fallback: string): string {
  const withoutControls = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
    })
    .join("");
  const normalized = withoutControls.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return fallback;
  }
  return Buffer.byteLength(normalized, "utf8") <= 256
    ? normalized
    : Buffer.from(normalized, "utf8")
        .subarray(0, 256)
        .toString("utf8")
        .replaceAll("\uFFFD", "")
        .trim() || fallback;
}

async function probeComputerUseCapability(
  probe: WorkerComputerUseCapabilityProbe | undefined,
): Promise<WorkerSchedulingInventoryV1["capabilities"][number]["verification"]> {
  if (probe === undefined) {
    return "unavailable";
  }
  try {
    const result = await probe.probe();
    if (
      result.verification !== "verified" &&
      result.verification !== "degraded" &&
      result.verification !== "unavailable"
    ) {
      return "unavailable";
    }
    return result.verification;
  } catch {
    return "unavailable";
  }
}

function setStrongestCapability(
  capabilities: Map<string, WorkerSchedulingInventoryV1["capabilities"][number]>,
  name: string,
  candidate: WorkerSchedulingInventoryV1["capabilities"][number],
): void {
  const strength = {
    unavailable: 0,
    disabled: 1,
    detected: 2,
    degraded: 3,
    verified: 4,
  } as const;
  const existing = capabilities.get(name);
  if (
    existing === undefined ||
    strength[candidate.verification] > strength[existing.verification]
  ) {
    capabilities.set(name, Object.freeze({ ...candidate }));
  }
}

function schedulingProvider(
  provider: AgentAdapter["provider"],
): NonNullable<WorkerSchedulingInventoryV1["agentAdapters"]>[number]["provider"] {
  return provider === "generic" ? "generic-command" : provider;
}

function agentAdapterIdentity(provider: AgentAdapter["provider"], adapterId: string): string {
  return `${provider}\0${adapterId}`;
}

function adapterReadiness(
  probe: AgentAdapterProbe,
): NonNullable<WorkerSchedulingInventoryV1["agentAdapters"]>[number]["readiness"] {
  if (!probe.installed) {
    return "unavailable";
  }
  return (probe.auth.state === "ready" || probe.auth.state === "not_required") &&
    probe.compatibility !== "incompatible" &&
    probe.compatibility !== "untested" &&
    probe.capabilities.start &&
    probe.capabilities.resume
    ? "ready"
    : "degraded";
}

function workerServiceMode(
  environment: Readonly<Record<string, string | undefined>>,
): WorkerSchedulingInventoryV1["serviceMode"] {
  const explicit = environment["OPENDELEGATE_SERVICE_MODE"];
  if (explicit === "foreground" || explicit === "system-service" || explicit === "user-service") {
    return explicit;
  }
  return environment["INVOCATION_ID"] === undefined ? "foreground" : "system-service";
}

/**
 * The current Worker composition contains CLI fallback adapters but no
 * OpenDelegate Policy callback bridge. A provider's unattended mode must therefore
 * remain completely tool-less. This includes provider-native child-agent, shell,
 * file mutation, web, network, and Computer Use tools.
 */
export function resolveWorkerAgentPermissions(
  capabilities: Pick<AgentAdapterProbe["capabilities"], "approvalBridge">,
  actionAuthorization?: AgentActionAuthorizationPort,
): AgentPermissionInput {
  if (typeof capabilities.approvalBridge !== "boolean") {
    throw appError("CONFIG_INVALID", "Agent approval capability metadata is invalid.");
  }
  if (!capabilities.approvalBridge) {
    return Object.freeze({ mode: "deny" as const });
  }
  if (
    actionAuthorization === undefined ||
    typeof actionAuthorization.authorizeAndConsume !== "function"
  ) {
    throw appError(
      "CONFIG_INVALID",
      "An Agent approval bridge requires the exact-action authorization port.",
    );
  }
  return Object.freeze({
    mode: "allow-listed" as const,
    allowedTools: Object.freeze([
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "Bash",
      "NotebookEdit",
      "Task",
      "Agent",
      "TodoWrite",
      "WebFetch",
      "WebSearch",
      "shell",
      "file-change",
    ]),
    actionAuthorization,
  });
}

export function resolveWorkerAgentSandbox(input: {
  readonly approvalBridge: boolean;
  readonly provider: AgentProviderName;
}): "provider-default" | "read-only" | "workspace-write" {
  if (
    typeof input.approvalBridge !== "boolean" ||
    (input.provider !== "claude" && input.provider !== "codex" && input.provider !== "generic")
  ) {
    throw appError("CONFIG_INVALID", "Agent sandbox capability metadata is invalid.");
  }
  if (input.approvalBridge) {
    return "workspace-write";
  }
  return input.provider === "claude" ? "provider-default" : "read-only";
}

export async function selectAgentAdapter(
  adapters: readonly AgentAdapter[],
  configuration: WorkerAgentConfiguration,
  requirement: WorkerRunAssignmentV1["agentRequirement"],
): Promise<{ readonly adapter: AgentAdapter; readonly probe: AgentAdapterProbe }> {
  const ordered =
    requirement === undefined
      ? configuration.provider === "auto"
        ? adapters
        : adapters.filter((adapter) => adapter.provider === configuration.provider)
      : adapters.filter(
          (adapter) =>
            (configuration.provider === "auto" ||
              configuration.provider === requirement.provider) &&
            adapter.provider === requirement.provider &&
            (requirement.adapterId === undefined || adapter.adapterId === requirement.adapterId),
        );
  const allowedCompatibilities: ReadonlySet<string> = new Set(
    requirement?.allowedCompatibilities ?? (["tested"] as const),
  );
  for (const adapter of ordered) {
    const probe = await adapter.probe();
    if (
      probe.contractVersion === 1 &&
      probe.adapterId === adapter.adapterId &&
      probe.provider === adapter.provider &&
      probe.installed &&
      probe.version !== undefined &&
      (probe.auth.state === "ready" || probe.auth.state === "not_required") &&
      probe.capabilities.start &&
      (requirement === undefined
        ? probe.compatibility === "tested" ||
          (configuration.allowUntestedVersion && probe.compatibility !== "incompatible")
        : allowedCompatibilities.has(probe.compatibility) &&
          (probe.compatibility === "tested" || configuration.allowUntestedVersion))
    ) {
      if (requirement?.modelId !== undefined) {
        if (adapter.listModels === undefined) {
          continue;
        }
        let catalog;
        try {
          catalog = await adapter.listModels();
        } catch {
          continue;
        }
        if (!catalog.models.some((model) => model.modelId === requirement.modelId)) {
          continue;
        }
      }
      return Object.freeze({ adapter, probe });
    }
  }
  throw appError(
    "DAEMON_FAILED",
    requirement === undefined
      ? "No configured Agent Adapter is installed and ready."
      : "No installed Agent Adapter satisfies the immutable Run requirement.",
  );
}

function renderWorkOrderPrompt(assignment: WorkerRunAssignmentV1): string {
  const order = assignment.workOrder;
  return [
    `# ${order.title}`,
    "",
    order.brief,
    "",
    "## Completion criteria",
    ...order.completionCriteria.map((item) => `- ${item}`),
    ...(order.constraints.length === 0
      ? []
      : ["", "## Constraints", ...order.constraints.map((item) => `- ${item}`)]),
    ...(assignment.agentRequirement === undefined
      ? []
      : [
          "",
          "## Effective Agent binding",
          `- Provider: ${assignment.agentRequirement.provider}`,
          `- Adapter: ${assignment.agentRequirement.adapterId ?? "provider default"}`,
          `- Model: ${assignment.agentRequirement.modelId ?? "adapter default"}`,
        ]),
    "",
    `Task ID: ${assignment.taskId}`,
    `Work Order ID: ${order.workOrderId}`,
  ].join("\n");
}

export function createWorkerManagedSecretStore(
  configuration: WorkerSecretBackendConfiguration,
  deviceId: string,
  paths: WorkerPaths,
  environment: Readonly<Record<string, string | undefined>>,
): ManagedSecretStore {
  let backend: PlatformManagedSecretStoreConfig;
  switch (configuration.backend) {
    case "windows-dpapi":
      backend = {
        backend: "windows-dpapi",
        deviceId,
        sourceCheckoutRoot: paths.sourceCheckoutRoot,
        vaultRoot: configuration.vaultRoot,
      };
      break;
    case "windows-service-dpapi":
      backend = {
        backend: "windows-service-dpapi",
        deviceId,
        handoffRoot: configuration.handoffRoot,
        serviceSid: configuration.serviceSid,
        sourceCheckoutRoot: paths.sourceCheckoutRoot,
        vaultRoot: configuration.vaultRoot,
      };
      break;
    case "macos-keychain":
      backend = {
        backend: "macos-keychain",
        deviceId,
        helperPath: configuration.helperPath,
        expectedHelperSha256: configuration.expectedHelperSha256,
      };
      break;
    case "linux-secret-service":
      backend = {
        backend: "linux-secret-service",
        deviceId,
        secretToolPath: configuration.secretToolPath,
      };
      break;
    case "linux-systemd-credential-vault": {
      const credentialDirectory = environment["CREDENTIALS_DIRECTORY"];
      if (credentialDirectory === undefined) {
        throw appError(
          "SECRET_BACKEND_UNAVAILABLE",
          "The systemd credential directory is unavailable.",
        );
      }
      backend = {
        backend: "linux-systemd-credential-vault",
        deviceId,
        sourceCheckoutRoot: paths.sourceCheckoutRoot,
        vaultRoot: configuration.vaultRoot,
        keyProvider: new SystemdCredentialKeyProvider({
          credentialDirectory,
          credentialName: configuration.credentialName,
          sourceCheckoutRoot: paths.sourceCheckoutRoot,
        }),
      };
      break;
    }
  }
  return createPlatformManagedSecretStore(backend);
}

/**
 * Provisions only Secrets owned by the core daemon identity. The logged-in
 * session helper has a separate Ed25519 key and Secret Store; its key is never
 * copied from or opened through this core store.
 */
export async function provisionWorkerComputerUseCoreSecrets(
  store: ManagedSecretStore,
): Promise<WorkerComputerUseCoreKeyBinding> {
  if ((await store.health()).status !== "ready") {
    throw appError(
      "SECRET_BACKEND_UNAVAILABLE",
      "The Device-local core Secret Store is unavailable.",
    );
  }
  await ensureManagedSecret(
    store,
    WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS,
    () => randomBytes(32),
    async () => {
      let valid = false;
      await store.executeWithSecretBytes(WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS, (value) => {
        valid = value.byteLength === 32;
      });
      if (!valid) {
        throw appError(
          "SECRET_BACKEND_UNAVAILABLE",
          "The desktop authority signing Secret is invalid.",
        );
      }
    },
  );
  await ensureManagedSecret(
    store,
    WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
    () => {
      const { privateKey } = generateKeyPairSync("ed25519");
      return privateKey.export({ format: "der", type: "pkcs8" });
    },
    async () => {
      await readWorkerComputerUseCoreKeyBinding(store);
    },
  );
  return await readWorkerComputerUseCoreKeyBinding(store);
}

export async function readWorkerComputerUseCoreKeyBinding(
  store: ManagedSecretStore,
): Promise<WorkerComputerUseCoreKeyBinding> {
  const binding = await readWorkerSessionHelperSigningKeyBinding(
    store,
    WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
    "The core session-helper signing Secret is unavailable or invalid.",
  );
  return Object.freeze({
    alias: WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
    ...binding,
  });
}

/**
 * Provisions the Ed25519 identity owned by the logged-in desktop session
 * helper. Callers must pass the owner/session Secret Store, never the core
 * service store. Its private key is intentionally not part of service handoff.
 */
export async function provisionWorkerSessionHelperOwnerSigningSecret(
  store: ManagedSecretStore,
): Promise<WorkerSessionHelperOwnerKeyBinding> {
  if ((await store.health()).status !== "ready") {
    throw appError(
      "SECRET_BACKEND_UNAVAILABLE",
      "The Device-local session owner Secret Store is unavailable.",
    );
  }
  await ensureManagedSecret(
    store,
    WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS,
    () => {
      const { privateKey } = generateKeyPairSync("ed25519");
      return privateKey.export({ format: "der", type: "pkcs8" });
    },
    async () => {
      await readWorkerSessionHelperOwnerKeyBinding(store);
    },
  );
  return await readWorkerSessionHelperOwnerKeyBinding(store);
}

export async function readWorkerSessionHelperOwnerKeyBinding(
  store: ManagedSecretStore,
): Promise<WorkerSessionHelperOwnerKeyBinding> {
  const binding = await readWorkerSessionHelperSigningKeyBinding(
    store,
    WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS,
    "The session owner signing Secret is unavailable or invalid.",
  );
  return Object.freeze({
    alias: WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS,
    ...binding,
  });
}

async function readWorkerSessionHelperSigningKeyBinding(
  store: ManagedSecretStore,
  alias:
    | typeof WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS
    | typeof WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS,
  unavailableMessage: string,
): Promise<{
  readonly keyId: `sha256:${string}`;
  readonly publicKeySpkiBase64Url: string;
}> {
  let binding:
    | {
        readonly keyId: `sha256:${string}`;
        readonly publicKeySpkiBase64Url: string;
      }
    | undefined;
  try {
    await store.executeWithSecretBytes(alias, (value) => {
      if (value.byteLength < 1 || value.byteLength > 256) {
        throw new Error("invalid");
      }
      const material = Buffer.from(value);
      try {
        const privateKey = createPrivateKey({
          format: "der",
          type: "pkcs8",
          key: material,
        });
        if (privateKey.asymmetricKeyType !== "ed25519") {
          throw new Error("invalid");
        }
        const canonicalPrivate = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
        try {
          if (!canonicalPrivate.equals(material)) {
            throw new Error("invalid");
          }
        } finally {
          canonicalPrivate.fill(0);
        }
        const publicKeySpki = createPublicKey(privateKey).export({
          format: "der",
          type: "spki",
        });
        const publicBytes = Buffer.from(publicKeySpki);
        binding = Object.freeze({
          keyId: `sha256:${createHash("sha256").update(publicBytes).digest("hex")}`,
          publicKeySpkiBase64Url: publicBytes.toString("base64url"),
        });
      } finally {
        material.fill(0);
      }
    });
  } catch {
    throw appError("SECRET_BACKEND_UNAVAILABLE", unavailableMessage);
  }
  if (binding === undefined) {
    throw appError("SECRET_BACKEND_UNAVAILABLE", unavailableMessage);
  }
  return binding;
}

async function ensureManagedSecret(
  store: ManagedSecretStore,
  alias: string,
  generate: () => Uint8Array,
  validate: () => Promise<void>,
): Promise<void> {
  if ((await store.availability(alias)).ready) {
    await validate();
    return;
  }
  const material = Buffer.from(generate());
  try {
    try {
      await store.store(alias, material);
    } catch (error: unknown) {
      if (!(error instanceof SecretError) || error.code !== "SECRET_ALIAS_CONFLICT") {
        throw error;
      }
    }
  } finally {
    material.fill(0);
  }
  await validate();
}

function validateWorkerConfigurationDocument(input: unknown): WorkerConfigurationDocument {
  const record = readRecord(input);
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "deviceId",
      "workerId",
      "mainDeviceId",
      "keyId",
      "certificateGeneration",
      "certificatePem",
      "certificateAuthorityPem",
      "expectedMainSpkiSha256",
      "transportProfile",
      "secretBackend",
      "agent",
      "workspaces",
      "createdAt",
    ],
    ["platformMutation"],
  );
  if (record["schemaVersion"] !== CONFIG_SCHEMA_VERSION) {
    throw appError("CONFIG_INVALID", "Worker configuration version is unsupported.");
  }
  const deviceId = identifier(record["deviceId"]);
  const mainDeviceId = identifier(record["mainDeviceId"]);
  const transport = readRecord(record["transportProfile"]);
  assertExactKeys(transport, ["deviceId", "endpoints"]);
  if (transport["deviceId"] !== mainDeviceId || !Array.isArray(transport["endpoints"])) {
    throw appError("CONFIG_INVALID", "Worker transport configuration is invalid.");
  }
  const endpoints = transport["endpoints"].map((value) => {
    const endpoint = readRecord(value);
    assertExactKeys(endpoint, ["endpointId", "label", "kind", "url", "credentialRef"]);
    if (endpoint["kind"] !== "wss") {
      throw appError("CONFIG_INVALID", "Worker channel endpoints must use wss.");
    }
    const url = text(endpoint["url"]);
    if (new URL(url).protocol !== "wss:") {
      throw appError("CONFIG_INVALID", "Worker channel endpoint is invalid.");
    }
    return {
      endpointId: identifier(endpoint["endpointId"]),
      label: text(endpoint["label"]),
      kind: "wss" as const,
      url,
      credentialRef: identifier(endpoint["credentialRef"]),
    };
  });
  if (endpoints.length === 0 || endpoints.length > 32) {
    throw appError("CONFIG_INVALID", "Worker requires 1-32 channel endpoints.");
  }
  const secretBackend = validateSecretBackend(record["secretBackend"]);
  const agent = validateAgentConfiguration(record["agent"]);
  const platformMutation =
    record["platformMutation"] === undefined
      ? undefined
      : validatePlatformMutationConfiguration(record["platformMutation"]);
  if (!Array.isArray(record["workspaces"]) || record["workspaces"].length > 128) {
    throw appError("CONFIG_INVALID", "Worker Workspace configuration is invalid.");
  }
  const workspaces = record["workspaces"].map(validateWorkspace);
  const createdAt = text(record["createdAt"]);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw appError("CONFIG_INVALID", "Worker configuration timestamp is invalid.");
  }
  const certificateGeneration = positiveInteger(record["certificateGeneration"]);
  const expectedMainSpkiSha256 = text(record["expectedMainSpkiSha256"]);
  if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(expectedMainSpkiSha256)) {
    throw appError("CONFIG_INVALID", "Worker Main identity pin is invalid.");
  }
  return deepFreeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    deviceId,
    workerId: identifier(record["workerId"]),
    mainDeviceId,
    keyId: identifier(record["keyId"]),
    certificateGeneration,
    certificatePem: certificate(text(record["certificatePem"])),
    certificateAuthorityPem: certificate(text(record["certificateAuthorityPem"])),
    expectedMainSpkiSha256,
    transportProfile: { deviceId: mainDeviceId, endpoints },
    secretBackend,
    agent,
    ...(platformMutation === undefined ? {} : { platformMutation }),
    workspaces,
    createdAt,
  });
}

function validateSecretBackend(value: unknown): WorkerSecretBackendConfiguration {
  const record = readRecord(value);
  switch (record["backend"]) {
    case "windows-dpapi":
      assertExactKeys(record, ["backend", "vaultRoot"]);
      return {
        backend: "windows-dpapi",
        vaultRoot: requireAbsolutePath(text(record["vaultRoot"]), "vault root"),
      };
    case "windows-service-dpapi":
      assertExactKeys(record, ["backend", "handoffRoot", "serviceName", "serviceSid", "vaultRoot"]);
      if (
        !/^OpenDelegate-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(text(record["serviceName"])) ||
        !/^S-1-5-80-(?:[0-9]{1,10}-){4}[0-9]{1,10}$/u.test(text(record["serviceSid"]))
      ) {
        throw appError("CONFIG_INVALID", "Windows service Secret identity is invalid.");
      }
      return {
        backend: "windows-service-dpapi",
        handoffRoot: requireAbsolutePath(text(record["handoffRoot"]), "handoff root"),
        serviceName: text(record["serviceName"]),
        serviceSid: text(record["serviceSid"]),
        vaultRoot: requireAbsolutePath(text(record["vaultRoot"]), "vault root"),
      };
    case "macos-keychain":
      assertExactKeys(record, ["backend", "helperPath", "expectedHelperSha256"]);
      if (!/^sha256:[0-9a-f]{64}$/u.test(text(record["expectedHelperSha256"]))) {
        throw appError("CONFIG_INVALID", "macOS helper fingerprint is invalid.");
      }
      return {
        backend: "macos-keychain",
        helperPath: requireAbsolutePath(text(record["helperPath"]), "Keychain helper"),
        expectedHelperSha256: text(record["expectedHelperSha256"]),
      };
    case "linux-secret-service":
      assertExactKeys(record, ["backend", "secretToolPath"]);
      return {
        backend: "linux-secret-service",
        secretToolPath: requireAbsolutePath(text(record["secretToolPath"]), "secret-tool"),
      };
    case "linux-systemd-credential-vault":
      assertExactKeys(record, [
        "backend",
        "credentialName",
        "encryptedCredentialFile",
        "vaultRoot",
      ]);
      return {
        backend: "linux-systemd-credential-vault",
        credentialName: strictCredentialName(record["credentialName"]),
        encryptedCredentialFile: requireAbsolutePath(
          text(record["encryptedCredentialFile"]),
          "encrypted systemd credential",
        ),
        vaultRoot: requireAbsolutePath(text(record["vaultRoot"]), "vault root"),
      };
    default:
      throw appError("CONFIG_INVALID", "Worker Secret Store configuration is invalid.");
  }
}

function validateAgentConfiguration(value: unknown): WorkerAgentConfiguration {
  const record = readRecord(value);
  assertExactKeys(
    record,
    ["provider", "allowUntestedVersion"],
    [
      "codexExecutable",
      "codexHome",
      "claudeExecutable",
      "claudeHome",
      "claudeAllowedNetworkDomains",
    ],
  );
  if (
    record["provider"] !== "auto" &&
    record["provider"] !== "codex" &&
    record["provider"] !== "claude"
  ) {
    throw appError("CONFIG_INVALID", "Worker Agent provider is invalid.");
  }
  if (typeof record["allowUntestedVersion"] !== "boolean") {
    throw appError("CONFIG_INVALID", "Worker Agent compatibility policy is invalid.");
  }
  return {
    provider: record["provider"],
    allowUntestedVersion: record["allowUntestedVersion"],
    ...(record["codexExecutable"] === undefined
      ? {}
      : {
          codexExecutable: requireAbsolutePath(text(record["codexExecutable"]), "Codex executable"),
        }),
    ...(record["codexHome"] === undefined
      ? {}
      : {
          codexHome: requireAbsolutePath(text(record["codexHome"]), "Codex provider home"),
        }),
    ...(record["claudeExecutable"] === undefined
      ? {}
      : {
          claudeExecutable: requireAbsolutePath(
            text(record["claudeExecutable"]),
            "Claude executable",
          ),
        }),
    ...(record["claudeHome"] === undefined
      ? {}
      : {
          claudeHome: requireAbsolutePath(text(record["claudeHome"]), "Claude provider home"),
        }),
    ...(record["claudeAllowedNetworkDomains"] === undefined
      ? {}
      : {
          claudeAllowedNetworkDomains: validateNetworkDomains(
            record["claudeAllowedNetworkDomains"],
          ),
        }),
  };
}

function validatePlatformMutationConfiguration(
  value: unknown,
): WorkerPlatformMutationConfiguration {
  const record = readRecord(value);
  assertExactKeys(record, ["executables"]);
  const executableRecord = readRecord(record["executables"]);
  const entries = Object.entries(executableRecord);
  if (entries.length === 0 || entries.length > 64) {
    throw appError("CONFIG_INVALID", "Platform mutation executable configuration is invalid.");
  }
  const executables: Partial<Record<PlatformMutationExecutableId, string>> = {};
  for (const [executableId, executablePath] of entries) {
    if (!PLATFORM_MUTATION_EXECUTABLE_IDS.has(executableId as PlatformMutationExecutableId)) {
      throw appError("CONFIG_INVALID", "Platform mutation executable configuration is invalid.");
    }
    executables[executableId as PlatformMutationExecutableId] = requireAbsolutePath(
      text(executablePath),
      `${executableId} platform mutation executable`,
    );
  }
  return Object.freeze({ executables: Object.freeze(executables) });
}

function validateNetworkDomains(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw appError("CONFIG_INVALID", "Claude sandbox network domains are invalid.");
  }
  const domains = value.map((entry) => {
    if (typeof entry !== "string") {
      throw appError("CONFIG_INVALID", "Claude sandbox network domains are invalid.");
    }
    const normalized = entry.trim().toLocaleLowerCase("en-US");
    if (
      normalized.length === 0 ||
      normalized.length > 253 ||
      normalized.includes("/") ||
      normalized.includes(":") ||
      !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
        normalized,
      )
    ) {
      throw appError("CONFIG_INVALID", "Claude sandbox network domains are invalid.");
    }
    return normalized;
  });
  if (new Set(domains).size !== domains.length) {
    throw appError("CONFIG_INVALID", "Claude sandbox network domains must be unique.");
  }
  return Object.freeze(domains);
}

function validateWorkspace(value: unknown): WorkerWorkspaceConfiguration {
  const record = readRecord(value);
  assertExactKeys(record, [
    "workspaceId",
    "alias",
    "type",
    "rootPath",
    "isolation",
    "capabilities",
  ]);
  if (
    record["type"] !== "directory" &&
    record["type"] !== "git" &&
    record["type"] !== "mounted-storage"
  ) {
    throw appError("CONFIG_INVALID", "Worker Workspace type is invalid.");
  }
  if (record["isolation"] !== "none" && record["isolation"] !== "agent-native-worktree") {
    throw appError("CONFIG_INVALID", "Worker Workspace isolation is invalid.");
  }
  if (!Array.isArray(record["capabilities"])) {
    throw appError("CONFIG_INVALID", "Worker Workspace capabilities are invalid.");
  }
  return {
    workspaceId: identifier(record["workspaceId"]),
    alias: text(record["alias"]),
    type: record["type"],
    rootPath: requireAbsolutePath(text(record["rootPath"]), "Workspace root"),
    isolation: record["isolation"],
    capabilities: record["capabilities"].map(identifier),
  };
}

async function writeConfiguration(
  filename: string,
  configuration: WorkerConfigurationDocument,
): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(filename),
    `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, filename);
  if (process.platform !== "win32") {
    await chmod(filename, 0o600);
  }
}

async function prepareRuntimeDirectories(paths: WorkerPaths): Promise<void> {
  for (const directory of [
    paths.home,
    paths.configDirectory,
    paths.stateDirectory,
    paths.knowledgeDirectory,
    paths.runCapabilityDirectory,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw appError("CONFIG_PATH_UNSAFE", "A Worker runtime directory is unsafe.");
    }
    if (process.platform !== "win32") {
      await chmod(directory, 0o700);
    }
  }
  const canonicalHome = await realpath(paths.home);
  const canonicalCheckout = await realpath(paths.sourceCheckoutRoot);
  if (isWithin(canonicalCheckout, canonicalHome)) {
    throw appError(
      "CONFIG_PATH_UNSAFE",
      "Worker runtime directories must remain outside the source checkout.",
    );
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw appError("CONFIG_INVALID", "Worker configuration must contain objects.");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw appError("CONFIG_INVALID", "Worker configuration fields are invalid.");
  }
}

function identifier(value: unknown): string {
  const result = text(value);
  if (result.length > 256 || hasControlCharacter(result)) {
    throw appError("CONFIG_INVALID", "Worker configuration identifier is invalid.");
  }
  return result;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_CONFIG_BYTES ||
    value !== value.trim()
  ) {
    throw appError("CONFIG_INVALID", "Worker configuration text is invalid.");
  }
  return value;
}

function certificate(value: string): string {
  if (!value.includes("-----BEGIN CERTIFICATE-----")) {
    throw appError("CONFIG_INVALID", "Worker certificate is invalid.");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw appError("CONFIG_INVALID", "Worker configuration integer is invalid.");
  }
  return value as number;
}

function requireAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw appError("CONFIG_PATH_UNSAFE", `The ${label} must be an absolute safe path.`);
  }
  return resolve(value);
}

function requireExternalProvisioningPath(
  value: string,
  sourceCheckoutRoot: string,
  label: string,
): string {
  const path = requireAbsolutePath(value, label);
  if (isWithin(sourceCheckoutRoot, path)) {
    throw appError("CONFIG_PATH_UNSAFE", `The ${label} must remain outside the source checkout.`);
  }
  return path;
}

async function prepareProvisioningParent(filename: string, mode: number): Promise<void> {
  const parent = dirname(filename);
  await mkdir(parent, { recursive: true, mode });
  let metadata;
  let canonical: string;
  try {
    metadata = await lstat(parent);
    canonical = await realpath(parent);
  } catch {
    throw appError("CONFIG_PATH_UNSAFE", "A provisioning directory is unavailable.");
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !pathsEqualForCurrentHost(canonical, parent)
  ) {
    throw appError("CONFIG_PATH_UNSAFE", "A provisioning directory is unsafe.");
  }
}

async function assertProvisioningTargetAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw appError("CONFIG_PATH_UNSAFE", "A provisioning target could not be inspected safely.");
  }
  throw appError(
    "CONFIG_PATH_UNSAFE",
    "Headless Secret provisioning never overwrites an existing file.",
  );
}

function strictCredentialName(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) {
    throw appError("CONFIG_INVALID", "The systemd credential name is invalid.");
  }
  return result;
}

function pathsEqualForCurrentHost(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function requireEnvironmentPath(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "" || !isAbsolute(value)) {
    throw appError("CONFIG_PATH_UNSAFE", `${name} is unavailable for the default Worker home.`);
  }
  return resolve(value);
}

function isWithin(parent: string, candidate: string): boolean {
  const relationship = relative(resolve(parent), resolve(candidate));
  return relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship));
}

function osFamily(value: NodeJS.Platform): "linux" | "macos" | "windows" {
  if (value === "win32") {
    return "windows";
  }
  if (value === "darwin") {
    return "macos";
  }
  if (value === "linux") {
    return "linux";
  }
  throw appError("CONFIG_INVALID", "This operating system is not supported.");
}

function boundedInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 3_600_000) {
    throw appError("CONFIG_INVALID", "Worker daemon interval is invalid.");
  }
  return value;
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveDelay();
      },
      { once: true },
    );
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function appError(code: WorkerAppErrorCode, message: string): WorkerAppError {
  return new WorkerAppError(code, message);
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
