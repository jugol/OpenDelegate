import { resolve } from "node:path";
import { platform } from "node:os";

import {
  PlatformServiceError,
  ServiceCommandExecutionError,
  createNativeServiceCommandJournal,
  createNativeServiceExecutor,
  createNativeServiceInspector,
  createNodeNativeServiceBoundaries,
  createNodeNativeServiceJournalAtomicBoundary,
  createServicePlan,
  nativeServiceJournalRoot,
  parsePlatformServiceConfiguration,
  renderPlatformServiceArtifacts,
  type IdempotentServicePlanResult,
  type PlatformServiceArtifacts,
  type PlatformServiceConfiguration,
  type PlatformFamily,
  type ServiceDiagnostic,
  type ServiceOperation,
  type ServicePlan,
  type ServicePlanExecutionReport,
} from "@opendelegate/platform-services";

import { readStableRegularFile, StableFileError } from "./stable-file.ts";

const MAXIMUM_SERVICE_CONFIGURATION_BYTES = 256 * 1024;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PLAN_OPERATIONS = new Set<ServiceOperation>([
  "install",
  "reconfigure",
  "restart",
  "start",
  "stop",
  "uninstall",
  "upgrade",
]);
const MUTATION_COMMANDS = new Set([
  "install",
  "reconfigure",
  "restart",
  "start",
  "stop",
  "uninstall",
  "upgrade",
]);

export type ServiceLifecycleCommand =
  | "diagnose"
  | "help"
  | "install"
  | "plan"
  | "reconfigure"
  | "render"
  | "restart"
  | "start"
  | "status"
  | "stop"
  | "uninstall"
  | "upgrade";

export interface ParsedServiceLifecycleArguments {
  readonly command: ServiceLifecycleCommand;
  readonly configurationPath?: string;
  readonly home?: string;
  readonly operation?: ServiceOperation;
  readonly activeVersion?: string;
  readonly commandId?: string;
  readonly purgeState: boolean;
  readonly purgeConfirmation?: string;
}

export interface ServiceConfigurationReader {
  read(path: string): Promise<PlatformServiceConfiguration>;
}

export interface ServiceReconfigurationReader {
  readPrevious(
    path: string,
    configuration: PlatformServiceConfiguration,
  ): Promise<PlatformServiceConfiguration>;
}

export interface ServiceLifecycleExecutor {
  execute(input: {
    readonly commandId: string;
    readonly configuration: PlatformServiceConfiguration;
    readonly previousConfiguration?: PlatformServiceConfiguration;
    readonly plan: ServicePlan;
  }): Promise<IdempotentServicePlanResult>;
}

export interface ServiceLifecycleInspector {
  inspect(configuration: PlatformServiceConfiguration): Promise<ServiceDiagnostic>;
}

export interface ServiceMutationObserver {
  onMutationAttempt(input: {
    readonly commandId: string;
    readonly plan: ServicePlan;
  }): void | Promise<void>;
}

export interface ServiceLifecycleAdapters {
  readonly configurationReader: ServiceConfigurationReader;
  readonly reconfigurationReader?: ServiceReconfigurationReader;
  readonly executor?: ServiceLifecycleExecutor;
  readonly hostPlatform?: PlatformFamily;
  readonly inspector?: ServiceLifecycleInspector;
  readonly mutationObserver?: ServiceMutationObserver;
}

export type ServiceLifecycleResult =
  | {
      readonly kind: "render";
      readonly artifacts: PlatformServiceArtifacts;
      readonly mutationsAttempted: false;
    }
  | {
      readonly kind: "plan";
      readonly plan: ServicePlan;
      readonly mutationsAttempted: false;
    }
  | {
      readonly kind: "operation";
      readonly commandId: string;
      readonly replayed: boolean;
      readonly report: ServicePlanExecutionReport;
    }
  | {
      readonly kind: "status";
      readonly schemaVersion: 1;
      readonly platform: PlatformServiceConfiguration["platform"];
      readonly instanceId: string;
      readonly role: PlatformServiceConfiguration["role"];
      readonly core: ServiceDiagnostic["core"];
      readonly helper: ServiceDiagnostic["helper"];
      readonly readiness: ServiceDiagnostic["readiness"];
      readonly versions: ServiceDiagnostic["versions"];
      readonly secretValuesIncluded: false;
      readonly mutationsAttempted: false;
    }
  | {
      readonly kind: "diagnostic";
      readonly diagnostic: ServiceDiagnostic;
      readonly mutationsAttempted: false;
    };

export type ServiceLifecycleCliErrorCode =
  | "SERVICE_ARGUMENT_INVALID"
  | "SERVICE_CONFIGURATION_INVALID"
  | "SERVICE_EXECUTOR_FAILED"
  | "SERVICE_EXECUTOR_UNAVAILABLE"
  | "SERVICE_INSPECTOR_FAILED"
  | "SERVICE_INSPECTOR_INVALID"
  | "SERVICE_INSPECTOR_UNAVAILABLE"
  | "SERVICE_MUTATION_AUDIT_FAILED"
  | "SERVICE_PLATFORM_MISMATCH"
  | "SERVICE_PLATFORM_UNSUPPORTED"
  | "SERVICE_PURGE_CONFIRMATION_REQUIRED";

export class ServiceLifecycleCliError extends Error {
  public readonly code: ServiceLifecycleCliErrorCode;
  public readonly requiresElevation: boolean;
  public readonly mutationMayHaveOccurred: boolean;

  public constructor(
    code: ServiceLifecycleCliErrorCode,
    message: string,
    options: {
      readonly requiresElevation?: boolean;
      readonly mutationMayHaveOccurred?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ServiceLifecycleCliError";
    this.code = code;
    this.requiresElevation = options.requiresElevation ?? false;
    this.mutationMayHaveOccurred = options.mutationMayHaveOccurred ?? false;
  }
}

export function parseServiceLifecycleArguments(
  values: readonly string[],
): ParsedServiceLifecycleArguments {
  const commandValue = values[0] ?? "help";
  if (commandValue === "help" || commandValue === "--help" || commandValue === "-h") {
    if (values.length > 1) {
      throw argumentError("Service help does not accept options.");
    }
    return {
      command: "help",
      purgeState: false,
    };
  }
  if (!isServiceLifecycleCommand(commandValue)) {
    throw argumentError(`Unknown service command: ${commandValue}.`);
  }

  let operation: ServiceOperation | undefined;
  let optionIndex = 1;
  if (commandValue === "plan") {
    const operationValue = values[1];
    if (operationValue === undefined || !isServiceOperation(operationValue)) {
      throw argumentError(
        "service plan requires install, reconfigure, start, stop, restart, upgrade, or uninstall.",
      );
    }
    operation = operationValue;
    optionIndex = 2;
  }

  let configurationPath: string | undefined;
  let home: string | undefined;
  let activeVersion: string | undefined;
  let commandId: string | undefined;
  let purgeState = false;
  let purgeConfirmation: string | undefined;
  for (let index = optionIndex; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--purge-state") {
      purgeState = true;
      continue;
    }
    if (
      value === "--config" ||
      value === "--home" ||
      value === "--active-version" ||
      value === "--command-id" ||
      value === "--confirm-purge"
    ) {
      const target = values[index + 1];
      if (target === undefined || target.startsWith("--") || target.trim() === "") {
        throw argumentError(`${value} requires a value.`);
      }
      if (value === "--config") {
        configurationPath = resolve(target);
      } else if (value === "--home") {
        home = resolve(target);
      } else if (value === "--active-version") {
        activeVersion = target;
      } else if (value === "--command-id") {
        commandId = target;
      } else {
        purgeConfirmation = target;
      }
      index += 1;
      continue;
    }
    throw argumentError(`Unknown service option: ${String(value)}.`);
  }

  if (configurationPath === undefined) {
    throw argumentError("--config is required for service commands.");
  }
  const effectiveOperation =
    commandValue === "plan"
      ? operation
      : MUTATION_COMMANDS.has(commandValue)
        ? (commandValue as ServiceOperation)
        : undefined;
  if (activeVersion !== undefined && !VERSION_PATTERN.test(activeVersion)) {
    throw argumentError("--active-version must be a release-safe semantic version.");
  }
  if (effectiveOperation === "install" && activeVersion !== undefined) {
    throw argumentError("Install does not accept --active-version.");
  }
  if (
    effectiveOperation !== undefined &&
    effectiveOperation !== "install" &&
    activeVersion === undefined
  ) {
    throw argumentError(`${effectiveOperation} requires --active-version.`);
  }
  if (
    commandValue !== "plan" &&
    MUTATION_COMMANDS.has(commandValue) &&
    (commandId === undefined || !COMMAND_ID_PATTERN.test(commandId))
  ) {
    throw argumentError(
      "Mutating service commands require --command-id with 8 to 128 service-safe characters.",
    );
  }
  if (commandValue === "plan" && commandId !== undefined) {
    throw argumentError("service plan is read-only and does not accept --command-id.");
  }
  const uninstallIntent = effectiveOperation === "uninstall";
  if (purgeState && !uninstallIntent) {
    throw argumentError("--purge-state is available only for uninstall.");
  }
  if (purgeConfirmation !== undefined && !purgeState) {
    throw argumentError("--confirm-purge is accepted only with --purge-state.");
  }
  if (
    effectiveOperation === undefined &&
    (activeVersion !== undefined ||
      commandId !== undefined ||
      purgeState ||
      purgeConfirmation !== undefined)
  ) {
    throw argumentError("Status, diagnose, and render accept only the service configuration path.");
  }

  return {
    command: commandValue,
    configurationPath,
    purgeState,
    ...(home === undefined ? {} : { home }),
    ...(operation === undefined ? {} : { operation }),
    ...(activeVersion === undefined ? {} : { activeVersion }),
    ...(commandId === undefined ? {} : { commandId }),
    ...(purgeConfirmation === undefined ? {} : { purgeConfirmation }),
  };
}

export async function runServiceLifecycleCommand(
  options: ParsedServiceLifecycleArguments,
  adapters: ServiceLifecycleAdapters,
): Promise<ServiceLifecycleResult> {
  if (options.command === "help" || options.configurationPath === undefined) {
    throw argumentError(
      "Service help is rendered directly and cannot be executed as a lifecycle operation.",
    );
  }
  const configuration = await adapters.configurationReader.read(options.configurationPath);
  const validated = parsePlatformServiceConfiguration(configuration);

  if (options.command === "render") {
    return {
      kind: "render",
      artifacts: renderPlatformServiceArtifacts(validated),
      mutationsAttempted: false,
    };
  }
  if (options.command === "status" || options.command === "diagnose") {
    if (adapters.inspector === undefined) {
      throw new ServiceLifecycleCliError(
        "SERVICE_INSPECTOR_UNAVAILABLE",
        "This bundle has no approved native service inspector. No installed or Computer Use state was inferred.",
      );
    }
    assertHostPlatform(validated.platform, adapters.hostPlatform);
    let diagnostic: ServiceDiagnostic;
    try {
      diagnostic = await adapters.inspector.inspect(validated);
    } catch (error) {
      throw new ServiceLifecycleCliError(
        "SERVICE_INSPECTOR_FAILED",
        "The native service inspector failed without attempting a mutation.",
        { cause: error },
      );
    }
    try {
      validateDiagnostic(validated, diagnostic);
    } catch (error) {
      if (error instanceof ServiceLifecycleCliError) {
        throw error;
      }
      throw new ServiceLifecycleCliError(
        "SERVICE_INSPECTOR_INVALID",
        "The native service inspector returned a malformed diagnostic.",
        { cause: error },
      );
    }
    if (options.command === "diagnose") {
      return {
        kind: "diagnostic",
        diagnostic,
        mutationsAttempted: false,
      };
    }
    return {
      kind: "status",
      schemaVersion: 1,
      platform: diagnostic.platform,
      instanceId: diagnostic.instanceId,
      role: diagnostic.role,
      core: diagnostic.core,
      helper: diagnostic.helper,
      readiness: diagnostic.readiness,
      versions: diagnostic.versions,
      secretValuesIncluded: false,
      mutationsAttempted: false,
    };
  }

  const operation = options.command === "plan" ? options.operation : options.command;
  if (operation === undefined || !isServiceOperation(operation)) {
    throw argumentError("The service lifecycle operation is missing.");
  }
  if (
    operation === "uninstall" &&
    options.purgeState &&
    options.command !== "plan" &&
    options.purgeConfirmation !== validated.instanceId
  ) {
    throw new ServiceLifecycleCliError(
      "SERVICE_PURGE_CONFIRMATION_REQUIRED",
      `Purging persistent state requires --confirm-purge ${validated.instanceId}.`,
      { requiresElevation: true },
    );
  }
  const previousConfiguration =
    operation === "reconfigure"
      ? await readPreviousConfiguration(options.configurationPath, validated, adapters)
      : undefined;
  const plan = createPlan({
    operation,
    configuration: validated,
    ...(previousConfiguration === undefined ? {} : { previousConfiguration }),
    activeVersion: options.activeVersion,
    purgeState: options.purgeState,
  });
  if (options.command === "plan") {
    return {
      kind: "plan",
      plan,
      mutationsAttempted: false,
    };
  }

  if (adapters.executor === undefined) {
    throw new ServiceLifecycleCliError(
      "SERVICE_EXECUTOR_UNAVAILABLE",
      "This bundle has no approved privileged service executor. No filesystem, account, or supervisor mutation was attempted.",
      {
        requiresElevation: true,
      },
    );
  }
  assertHostPlatform(validated.platform, adapters.hostPlatform);
  if (options.commandId === undefined) {
    throw argumentError("The mutating service command is missing its command ID.");
  }
  try {
    await adapters.mutationObserver?.onMutationAttempt({
      commandId: options.commandId,
      plan,
    });
  } catch (error) {
    throw new ServiceLifecycleCliError(
      "SERVICE_MUTATION_AUDIT_FAILED",
      "The service mutation audit boundary failed. No privileged executor call was made.",
      {
        requiresElevation: true,
        cause: error,
      },
    );
  }
  let execution: IdempotentServicePlanResult;
  try {
    execution = await adapters.executor.execute({
      commandId: options.commandId,
      configuration: validated,
      ...(previousConfiguration === undefined ? {} : { previousConfiguration }),
      plan,
    });
  } catch (error) {
    if (error instanceof ServiceCommandExecutionError) {
      throw error;
    }
    throw new ServiceLifecycleCliError(
      "SERVICE_EXECUTOR_FAILED",
      "The privileged service executor failed without a structured terminal report. Inspect the host before recovery.",
      {
        requiresElevation: true,
        mutationMayHaveOccurred: true,
        cause: error,
      },
    );
  }
  return {
    kind: "operation",
    commandId: options.commandId,
    replayed: execution.replayed,
    report: execution.report,
  };
}

export function createDefaultServiceLifecycleAdapters(): ServiceLifecycleAdapters {
  const hostPlatform = currentPlatformFamily();
  if (hostPlatform === undefined) {
    return {
      configurationReader: {
        read: loadServiceConfigurationFile,
      },
    };
  }
  const boundaries = createNodeNativeServiceBoundaries();
  const journalBoundary = createNodeNativeServiceJournalAtomicBoundary();
  const executor = createNativeServiceExecutor({
    platform: hostPlatform,
    boundaries,
    journalFactory: {
      create(configuration) {
        return createNativeServiceCommandJournal({
          stateRoot: nativeServiceJournalRoot(configuration),
          boundary: journalBoundary,
        });
      },
    },
  });
  const inspector = createNativeServiceInspector({
    platform: hostPlatform,
    boundaries,
  });
  return {
    configurationReader: {
      read: loadServiceConfigurationFile,
    },
    hostPlatform,
    executor,
    inspector,
  };
}

export async function loadServiceConfigurationFile(
  path: string,
): Promise<PlatformServiceConfiguration> {
  let bytes: Buffer;
  try {
    bytes = await readStableRegularFile(path, MAXIMUM_SERVICE_CONFIGURATION_BYTES);
  } catch (error) {
    throw new ServiceLifecycleCliError(
      "SERVICE_CONFIGURATION_INVALID",
      error instanceof StableFileError && error.code === "TOO_LARGE"
        ? "The service configuration exceeds the 256 KiB limit."
        : "The service configuration must be a stable, readable regular file.",
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    const text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ServiceLifecycleCliError(
      "SERVICE_CONFIGURATION_INVALID",
      "The service configuration is not valid JSON.",
      { cause: error },
    );
  }
  try {
    return parsePlatformServiceConfiguration(parsed);
  } catch (error) {
    if (error instanceof PlatformServiceError) {
      throw new ServiceLifecycleCliError("SERVICE_CONFIGURATION_INVALID", error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

export function serviceLifecycleHelpText(): string {
  return `OpenDelegate native service lifecycle

Usage:
  opendelegate service document --worker-config PATH --output NEW_PATH --home MAIN_HOME
  opendelegate service render --config PATH [--home MAIN_HOME]
  opendelegate service plan OPERATION --config PATH [--home MAIN_HOME] [--active-version VERSION]
  opendelegate service install --config PATH [--home MAIN_HOME] --command-id ID
  opendelegate service reconfigure --config PATH --home MAIN_HOME --active-version VERSION --command-id ID
  opendelegate service start|stop|restart --config PATH [--home MAIN_HOME] --active-version VERSION --command-id ID
  opendelegate service upgrade --config PATH [--home MAIN_HOME] --active-version CURRENT_VERSION --command-id ID
  opendelegate service status|diagnose --config PATH [--home MAIN_HOME]
  opendelegate service uninstall --config PATH [--home MAIN_HOME] --active-version VERSION --command-id ID
    [--purge-state --confirm-purge INSTANCE_ID]

Plan operations: install, reconfigure, start, stop, restart, upgrade, uninstall.

document is create-new and derives a headless Linux Main definition from its
co-located Worker's already prepared core-only document. It never installs or elevates.
Main templates require --home so every command resolves the durable admin.open-on-login
preference and canonical Admin origin; Worker templates never read Main state. render and plan
are read-only. Lifecycle mutations require an approved platform-specific
configuration, the necessary OS privileges, and a durable command journal. The included native
executor performs every privilege, tool, path, release-integrity, and detached
publisher-attestation preflight before it claims a command or mutates the host. It never elevates
itself and fails closed before mutation when a preflight is not satisfied. Core health never
implies user-session or Computer Use readiness; status and diagnose
inspect both runtime planes separately.
`;
}

function createPlan(input: {
  readonly operation: ServiceOperation;
  readonly configuration: PlatformServiceConfiguration;
  readonly previousConfiguration?: PlatformServiceConfiguration;
  readonly activeVersion: string | undefined;
  readonly purgeState: boolean;
}): ServicePlan {
  if (input.operation === "install") {
    return createServicePlan({
      operation: "install",
      configuration: input.configuration,
    });
  }
  if (input.activeVersion === undefined) {
    throw argumentError(`${input.operation} requires --active-version.`);
  }
  if (input.operation === "reconfigure") {
    if (input.previousConfiguration === undefined) {
      throw new ServiceLifecycleCliError(
        "SERVICE_CONFIGURATION_INVALID",
        "Service reconfiguration requires the exact prior Main service configuration.",
      );
    }
    return createServicePlan({
      operation: "reconfigure",
      configuration: input.configuration,
      previousConfiguration: input.previousConfiguration,
      activeVersion: input.activeVersion,
    });
  }
  if (input.operation === "uninstall") {
    return createServicePlan({
      operation: "uninstall",
      configuration: input.configuration,
      activeVersion: input.activeVersion,
      purgeState: input.purgeState,
    });
  }
  return createServicePlan({
    operation: input.operation,
    configuration: input.configuration,
    activeVersion: input.activeVersion,
  });
}

function validateDiagnostic(
  configuration: PlatformServiceConfiguration,
  diagnostic: ServiceDiagnostic,
): void {
  const serialized = JSON.stringify(diagnostic);
  const ready = diagnostic.readiness.computerUse === "ready";
  if (
    diagnostic.schemaVersion !== 1 ||
    diagnostic.platform !== configuration.platform ||
    diagnostic.instanceId !== configuration.instanceId ||
    diagnostic.role !== configuration.role ||
    diagnostic.secretValuesIncluded !== false ||
    diagnostic.readiness.headlessWorkAvailable !== true ||
    (diagnostic.readiness.computerUse !== "ready" &&
      diagnostic.readiness.computerUse !== "unavailable") ||
    serialized.includes("secret://") ||
    (ready &&
      (diagnostic.core.status !== "running" ||
        diagnostic.helper.status !== "running" ||
        diagnostic.readiness.session !== "ready" ||
        diagnostic.readiness.helperProcess !== "running" ||
        diagnostic.readiness.loggedIn !== true ||
        diagnostic.readiness.desktopUnlocked !== true ||
        diagnostic.readiness.missingPermissions.length !== 0 ||
        Object.values(diagnostic.readiness.permissions).some(
          (permission) => permission !== "granted",
        )))
  ) {
    throw new ServiceLifecycleCliError(
      "SERVICE_INSPECTOR_INVALID",
      "The native service inspector returned a mismatched or unsafe diagnostic.",
    );
  }
}

function isServiceLifecycleCommand(value: string): value is ServiceLifecycleCommand {
  return (
    value === "diagnose" ||
    value === "install" ||
    value === "plan" ||
    value === "reconfigure" ||
    value === "render" ||
    value === "restart" ||
    value === "start" ||
    value === "status" ||
    value === "stop" ||
    value === "uninstall" ||
    value === "upgrade"
  );
}

async function readPreviousConfiguration(
  path: string,
  configuration: PlatformServiceConfiguration,
  adapters: ServiceLifecycleAdapters,
): Promise<PlatformServiceConfiguration> {
  if (adapters.reconfigurationReader === undefined) {
    throw new ServiceLifecycleCliError(
      "SERVICE_CONFIGURATION_INVALID",
      "Service reconfiguration requires the deterministic prior-configuration reader.",
    );
  }
  try {
    return parsePlatformServiceConfiguration(
      await adapters.reconfigurationReader.readPrevious(path, configuration),
    );
  } catch (error) {
    if (error instanceof ServiceLifecycleCliError) {
      throw error;
    }
    throw new ServiceLifecycleCliError(
      "SERVICE_CONFIGURATION_INVALID",
      "The prior Main service configuration is unavailable or invalid.",
      { cause: error },
    );
  }
}

function isServiceOperation(value: string): value is ServiceOperation {
  return PLAN_OPERATIONS.has(value as ServiceOperation);
}

function currentPlatformFamily(): PlatformFamily | undefined {
  const current = platform();
  return current === "win32"
    ? "windows"
    : current === "darwin"
      ? "macos"
      : current === "linux"
        ? "linux"
        : undefined;
}

function assertHostPlatform(configured: PlatformFamily, host: PlatformFamily | undefined): void {
  if (host === undefined) {
    throw new ServiceLifecycleCliError(
      "SERVICE_PLATFORM_UNSUPPORTED",
      "The current host platform has no native OpenDelegate service integration.",
      { requiresElevation: true },
    );
  }
  if (configured !== host) {
    throw new ServiceLifecycleCliError(
      "SERVICE_PLATFORM_MISMATCH",
      `The ${configured} service configuration cannot mutate or inspect a ${host} host.`,
      { requiresElevation: true },
    );
  }
}

function argumentError(message: string): ServiceLifecycleCliError {
  return new ServiceLifecycleCliError("SERVICE_ARGUMENT_INVALID", message);
}
