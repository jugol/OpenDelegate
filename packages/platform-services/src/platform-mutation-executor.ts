import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

export type PlatformMutationActionCategory =
  | "project-dependency-install"
  | "configured-official-package-install"
  | "package-repository-addition"
  | "remote-installer-script"
  | "untrusted-installer"
  | "driver-installation"
  | "kernel-extension-installation"
  | "os-network-change"
  | "vpn-change"
  | "firewall-change";

export type PlatformPackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "pip3"
  | "cargo"
  | "apt"
  | "apt-get"
  | "dnf"
  | "yum"
  | "zypper"
  | "brew"
  | "winget"
  | "choco";

export type PlatformMutationExecutableId =
  | PlatformPackageManager
  | "add-apt-repository"
  | "apt-key"
  | "bash"
  | "devcon"
  | "dpkg"
  | "firewall-cmd"
  | "insmod"
  | "ip"
  | "iptables"
  | "kextload"
  | "kmutil"
  | "modprobe"
  | "msiexec"
  | "netsh"
  | "networksetup"
  | "nft"
  | "nmcli"
  | "openvpn"
  | "pfctl"
  | "pnputil"
  | "route"
  | "rpm"
  | "sh"
  | "socketfilterfw"
  | "tailscale"
  | "ufw"
  | "wg-quick";

export interface PlatformPackageInstallRequest {
  readonly kind: "package-install";
  readonly commandId: string;
  readonly manager: PlatformPackageManager;
  readonly scope: "project" | "system";
  readonly packages: readonly string[];
  readonly workingDirectory?: string;
  readonly signal: AbortSignal;
}

export interface PlatformProtectedCommandRequest {
  readonly kind: "protected-command";
  readonly commandId: string;
  readonly actionCategory: Exclude<
    PlatformMutationActionCategory,
    "configured-official-package-install" | "project-dependency-install"
  >;
  readonly executableId: PlatformMutationExecutableId;
  readonly arguments: readonly string[];
  readonly workingDirectory?: string;
  readonly signal: AbortSignal;
}

export type PlatformMutationRequest =
  PlatformPackageInstallRequest | PlatformProtectedCommandRequest;

export interface PlatformMutationAuthorizationRequest {
  readonly authorizationRequestId: string;
  readonly actionCategory: PlatformMutationActionCategory;
  readonly actionType: string;
  readonly actionFingerprint: `sha256:${string}`;
  readonly actionDescriptor: Readonly<Record<string, boolean | number | string | null>>;
  readonly requestedAtMs: number;
  readonly signal: AbortSignal;
}

export interface PlatformMutationAuthorizationPort {
  authorizeAndConsume(request: PlatformMutationAuthorizationRequest): Promise<{
    readonly decision: "allow" | "deny";
    readonly reasonCode: string;
  }>;
}

export interface PlatformMutationProcessRequest {
  readonly commandId: string;
  readonly actionCategory: PlatformMutationActionCategory;
  readonly executableId: PlatformMutationExecutableId;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory?: string;
  readonly signal: AbortSignal;
}

export interface PlatformMutationProcessRunner {
  run(
    request: PlatformMutationProcessRequest,
  ): Promise<{ readonly exitCode: number; readonly signal: string | null }>;
}

/**
 * A side-effect-free, repeatable safety check that runs once before the durable
 * command claim and again immediately before process spawn. The second result
 * may reject a Workspace/configuration race without leaving an uncertain native
 * mutation behind.
 */
export interface PlatformMutationProcessPreflight {
  assertSafe(request: PlatformMutationProcessRequest): Promise<void>;
}

export interface PlatformMutationReceipt {
  readonly commandId: string;
  readonly actionCategory: PlatformMutationActionCategory;
  readonly actionFingerprint: `sha256:${string}`;
  readonly outcome: "succeeded" | "failed" | "denied";
  readonly reasonCode: string;
  readonly exitCode?: number;
  readonly processSignal?: string;
  readonly completedAtMs: number;
}

export type PlatformMutationCommandJournalEntry =
  | {
      readonly commandId: string;
      readonly actionCategory: PlatformMutationActionCategory;
      readonly actionFingerprint: `sha256:${string}`;
      readonly state: "in-progress";
    }
  | {
      readonly commandId: string;
      readonly actionCategory: PlatformMutationActionCategory;
      readonly actionFingerprint: `sha256:${string}`;
      readonly state: "completed";
      readonly receipt: PlatformMutationReceipt;
    };

export type PlatformMutationCommandJournalClaim =
  | { readonly disposition: "claimed" }
  | { readonly disposition: "in-progress" }
  | { readonly disposition: "conflict" }
  | { readonly disposition: "completed"; readonly receipt: PlatformMutationReceipt };

export interface PlatformMutationCommandJournal {
  claim(
    entry: Omit<PlatformMutationCommandJournalEntry, "receipt" | "state">,
  ): Promise<PlatformMutationCommandJournalClaim>;
  complete(input: {
    readonly commandId: string;
    readonly actionFingerprint: `sha256:${string}`;
    readonly receipt: PlatformMutationReceipt;
  }): Promise<void>;
}

export type PlatformMutationErrorCode =
  | "MUTATION_AUTHORIZATION_FAILED"
  | "MUTATION_CATEGORY_EXECUTABLE_MISMATCH"
  | "MUTATION_COMMAND_CONFLICT"
  | "MUTATION_CONFIGURATION_INVALID"
  | "MUTATION_JOURNAL_UNAVAILABLE"
  | "MUTATION_OUTCOME_UNKNOWN"
  | "MUTATION_REQUEST_INVALID";

export class PlatformMutationError extends Error {
  public readonly code: PlatformMutationErrorCode;

  public constructor(code: PlatformMutationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlatformMutationError";
    this.code = code;
  }
}

export interface PlatformMutationExecutor {
  execute(request: PlatformMutationRequest): Promise<PlatformMutationReceipt>;
}

export interface CreatePlatformMutationExecutorInput {
  readonly platform: "windows" | "macos" | "linux";
  readonly executables: Readonly<Partial<Record<PlatformMutationExecutableId, string>>>;
  readonly authorization: PlatformMutationAuthorizationPort;
  readonly journal: PlatformMutationCommandJournal;
  readonly processPreflight: PlatformMutationProcessPreflight;
  readonly processRunner: PlatformMutationProcessRunner;
  readonly clock?: { now(): number };
}

interface NormalizedMutation {
  readonly commandId: string;
  readonly actionCategory: PlatformMutationActionCategory;
  readonly actionType: string;
  readonly executableId: PlatformMutationExecutableId;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory?: string;
  readonly signal: AbortSignal;
}

const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAXIMUM_ARGUMENTS = 128;
const MAXIMUM_ARGUMENT_BYTES = 4_096;
const MAXIMUM_DESCRIPTOR_BYTES = 4_096;
const PROJECT_PACKAGE_MANAGERS = new Set<PlatformPackageManager>([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "pip3",
  "cargo",
]);
const SYSTEM_PACKAGE_MANAGERS = Object.freeze({
  windows: new Set<PlatformPackageManager>(["winget", "choco"]),
  macos: new Set<PlatformPackageManager>(["brew"]),
  linux: new Set<PlatformPackageManager>(["apt", "apt-get", "dnf", "yum", "zypper"]),
});

const PROTECTED_EXECUTABLES: Readonly<
  Record<
    Exclude<
      PlatformMutationActionCategory,
      "configured-official-package-install" | "project-dependency-install"
    >,
    ReadonlySet<PlatformMutationExecutableId>
  >
> = Object.freeze({
  "package-repository-addition": new Set<PlatformMutationExecutableId>([
    "add-apt-repository",
    "apt-key",
    "brew",
    "dnf",
    "winget",
    "choco",
  ]),
  "remote-installer-script": new Set<PlatformMutationExecutableId>(["sh", "bash"]),
  "untrusted-installer": new Set<PlatformMutationExecutableId>(["dpkg", "rpm", "msiexec"]),
  "driver-installation": new Set<PlatformMutationExecutableId>([
    "pnputil",
    "devcon",
    "modprobe",
    "insmod",
  ]),
  "kernel-extension-installation": new Set<PlatformMutationExecutableId>([
    "kextload",
    "kmutil",
    "modprobe",
    "insmod",
  ]),
  "os-network-change": new Set<PlatformMutationExecutableId>([
    "netsh",
    "networksetup",
    "ip",
    "route",
    "nmcli",
  ]),
  "vpn-change": new Set<PlatformMutationExecutableId>([
    "tailscale",
    "wg-quick",
    "openvpn",
    "networksetup",
    "ip",
  ]),
  "firewall-change": new Set<PlatformMutationExecutableId>([
    "netsh",
    "ufw",
    "firewall-cmd",
    "iptables",
    "nft",
    "pfctl",
    "socketfilterfw",
  ]),
});

const EXECUTABLE_PLATFORMS: Readonly<
  Partial<
    Record<
      PlatformMutationExecutableId,
      ReadonlySet<CreatePlatformMutationExecutorInput["platform"]>
    >
  >
> = Object.freeze({
  apt: platforms("linux"),
  "apt-get": platforms("linux"),
  dnf: platforms("linux"),
  yum: platforms("linux"),
  zypper: platforms("linux"),
  brew: platforms("macos"),
  winget: platforms("windows"),
  choco: platforms("windows"),
  "add-apt-repository": platforms("linux"),
  "apt-key": platforms("linux"),
  dpkg: platforms("linux"),
  rpm: platforms("linux"),
  modprobe: platforms("linux"),
  insmod: platforms("linux"),
  ip: platforms("linux"),
  route: platforms("linux", "macos"),
  nmcli: platforms("linux"),
  ufw: platforms("linux"),
  "firewall-cmd": platforms("linux"),
  iptables: platforms("linux"),
  nft: platforms("linux"),
  "wg-quick": platforms("linux", "macos"),
  pnputil: platforms("windows"),
  devcon: platforms("windows"),
  msiexec: platforms("windows"),
  netsh: platforms("windows"),
  networksetup: platforms("macos"),
  kextload: platforms("macos"),
  kmutil: platforms("macos"),
  pfctl: platforms("macos"),
  socketfilterfw: platforms("macos"),
});

/**
 * Runs a typed package or host mutation through Main Policy immediately before
 * a shell-free process boundary.
 *
 * The durable journal is claimed before consuming authorization. An abandoned
 * in-progress claim is intentionally never retried because the external effect
 * may already have happened.
 */
export function createPlatformMutationExecutor(
  input: CreatePlatformMutationExecutorInput,
): PlatformMutationExecutor {
  const configuration = normalizeConfiguration(input);
  return Object.freeze({
    async execute(request: PlatformMutationRequest): Promise<PlatformMutationReceipt> {
      const mutation = normalizeMutation(configuration, request);
      const processRequest = toProcessRequest(mutation);
      const fingerprint = actionFingerprint(configuration.platform, mutation);
      const claim = await claimMutation(configuration.journal, mutation, fingerprint);
      switch (claim.disposition) {
        case "completed":
          return normalizeReplayReceipt(claim.receipt, mutation, fingerprint);
        case "conflict":
          throw new PlatformMutationError(
            "MUTATION_COMMAND_CONFLICT",
            "The platform mutation command ID is already bound to another action.",
          );
        case "in-progress":
          throw new PlatformMutationError(
            "MUTATION_OUTCOME_UNKNOWN",
            "The platform mutation has an in-progress durable claim and will not be retried.",
          );
        case "claimed":
          break;
      }

      try {
        await assertSafeProcess(configuration.processPreflight, processRequest);
      } catch {
        const receipt = receiptFor(
          mutation,
          fingerprint,
          "denied",
          "MUTATION_PREFLIGHT_REJECTED",
          readClock(configuration.clock),
        );
        await completeMutation(configuration.journal, receipt);
        return receipt;
      }

      const requestedAtMs = readClock(configuration.clock);
      const authorizationRequest = createAuthorizationRequest(
        configuration.platform,
        mutation,
        fingerprint,
        requestedAtMs,
      );
      let decision: Awaited<ReturnType<PlatformMutationAuthorizationPort["authorizeAndConsume"]>>;
      try {
        decision = await configuration.authorization.authorizeAndConsume(authorizationRequest);
      } catch (error) {
        throw new PlatformMutationError(
          "MUTATION_AUTHORIZATION_FAILED",
          "The platform mutation authorization boundary failed closed.",
          { cause: error },
        );
      }
      if (
        (decision.decision !== "allow" && decision.decision !== "deny") ||
        !validReasonCode(decision.reasonCode)
      ) {
        throw new PlatformMutationError(
          "MUTATION_AUTHORIZATION_FAILED",
          "The platform mutation authorization response is invalid.",
        );
      }
      if (decision.decision === "deny") {
        const receipt = receiptFor(
          mutation,
          fingerprint,
          "denied",
          decision.reasonCode,
          readClock(configuration.clock),
        );
        await completeMutation(configuration.journal, receipt);
        return receipt;
      }

      if (mutation.signal.aborted) {
        const receipt = receiptFor(
          mutation,
          fingerprint,
          "denied",
          "MUTATION_CANCELLED",
          readClock(configuration.clock),
        );
        await completeMutation(configuration.journal, receipt);
        return receipt;
      }

      try {
        await assertSafeProcess(configuration.processPreflight, processRequest);
      } catch {
        const receipt = receiptFor(
          mutation,
          fingerprint,
          "denied",
          "MUTATION_PREFLIGHT_CHANGED",
          readClock(configuration.clock),
        );
        await completeMutation(configuration.journal, receipt);
        return receipt;
      }

      let processResult: Awaited<ReturnType<PlatformMutationProcessRunner["run"]>>;
      try {
        processResult = await configuration.processRunner.run(processRequest);
      } catch (error) {
        throw new PlatformMutationError(
          "MUTATION_OUTCOME_UNKNOWN",
          "The platform mutation process outcome is unknown and will not be retried.",
          { cause: error },
        );
      }
      if (
        !Number.isSafeInteger(processResult.exitCode) ||
        processResult.exitCode < 0 ||
        (processResult.signal !== null &&
          (typeof processResult.signal !== "string" ||
            processResult.signal.length === 0 ||
            processResult.signal.length > 64))
      ) {
        throw new PlatformMutationError(
          "MUTATION_OUTCOME_UNKNOWN",
          "The platform mutation process returned an invalid outcome.",
        );
      }
      const receipt = receiptFor(
        mutation,
        fingerprint,
        processResult.exitCode === 0 ? "succeeded" : "failed",
        processResult.exitCode === 0 ? decision.reasonCode : "MUTATION_PROCESS_EXIT_NONZERO",
        readClock(configuration.clock),
        processResult,
      );
      await completeMutation(configuration.journal, receipt);
      return receipt;
    },
  });
}

/**
 * Production shell-free subprocess runner. It intentionally captures no output:
 * package-manager and host-command output can contain credentials or private
 * paths and belongs in a separate redacted diagnostic boundary.
 */
export function createNodePlatformMutationProcessRunner(options: {
  readonly environment: NodeJS.ProcessEnv;
}): PlatformMutationProcessRunner {
  const environment = normalizeProcessEnvironment(options.environment);
  return Object.freeze({
    run(
      request: PlatformMutationProcessRequest,
    ): Promise<{ readonly exitCode: number; readonly signal: string | null }> {
      validateProcessRequest(request);
      return new Promise<{ readonly exitCode: number; readonly signal: string | null }>(
        (resolve, reject) => {
          let settled = false;
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(request.executable, [...request.arguments], {
              cwd: request.workingDirectory,
              env: environment,
              shell: false,
              windowsHide: true,
              stdio: "ignore",
              signal: request.signal,
            });
          } catch (error) {
            reject(error);
            return;
          }
          child.once("error", (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
          child.once("exit", (code, signal) => {
            if (!settled) {
              settled = true;
              resolve({
                exitCode: code ?? 1,
                signal: signal === null ? null : String(signal),
              });
            }
          });
        },
      );
    },
  });
}

function platforms(
  ...values: readonly CreatePlatformMutationExecutorInput["platform"][]
): ReadonlySet<CreatePlatformMutationExecutorInput["platform"]> {
  return new Set(values);
}

function normalizeConfiguration(
  input: CreatePlatformMutationExecutorInput,
): Required<
  Pick<
    CreatePlatformMutationExecutorInput,
    "authorization" | "executables" | "journal" | "platform" | "processPreflight" | "processRunner"
  >
> & { readonly clock: { now(): number } } {
  if (
    (input.platform !== "windows" && input.platform !== "macos" && input.platform !== "linux") ||
    !isRecord(input.executables) ||
    !hasMethod(input.authorization, "authorizeAndConsume") ||
    !hasMethod(input.journal, "claim") ||
    !hasMethod(input.journal, "complete") ||
    !hasMethod(input.processPreflight, "assertSafe") ||
    !hasMethod(input.processRunner, "run") ||
    (input.clock !== undefined && !hasMethod(input.clock, "now"))
  ) {
    throw configurationError();
  }
  const normalizedExecutables: Partial<Record<PlatformMutationExecutableId, string>> = {};
  for (const [rawId, rawPath] of Object.entries(input.executables)) {
    if (
      !isExecutableId(rawId) ||
      typeof rawPath !== "string" ||
      !isAbsoluteFor(input.platform, rawPath) ||
      rawPath !== normalizePath(input.platform, rawPath) ||
      rawPath.includes("\0") ||
      Buffer.byteLength(rawPath, "utf8") > 4_096 ||
      (EXECUTABLE_PLATFORMS[rawId] !== undefined &&
        !EXECUTABLE_PLATFORMS[rawId]?.has(input.platform))
    ) {
      throw configurationError();
    }
    normalizedExecutables[rawId] = rawPath;
  }
  if (Object.keys(normalizedExecutables).length === 0) {
    throw configurationError();
  }
  return Object.freeze({
    platform: input.platform,
    executables: Object.freeze(normalizedExecutables),
    authorization: input.authorization,
    journal: input.journal,
    processPreflight: input.processPreflight,
    processRunner: input.processRunner,
    clock: input.clock ?? { now: () => Date.now() },
  });
}

function toProcessRequest(mutation: NormalizedMutation): PlatformMutationProcessRequest {
  return Object.freeze({
    commandId: mutation.commandId,
    actionCategory: mutation.actionCategory,
    executableId: mutation.executableId,
    executable: mutation.executable,
    arguments: mutation.arguments,
    ...(mutation.workingDirectory === undefined
      ? {}
      : { workingDirectory: mutation.workingDirectory }),
    signal: mutation.signal,
  });
}

async function assertSafeProcess(
  preflight: PlatformMutationProcessPreflight,
  request: PlatformMutationProcessRequest,
): Promise<void> {
  validateProcessRequest(request);
  try {
    await preflight.assertSafe(request);
  } catch (error) {
    if (error instanceof PlatformMutationError) {
      throw error;
    }
    throw new PlatformMutationError(
      "MUTATION_REQUEST_INVALID",
      "The platform mutation process did not pass its local safety preflight.",
      { cause: error },
    );
  }
}

function normalizeMutation(
  configuration: ReturnType<typeof normalizeConfiguration>,
  request: PlatformMutationRequest,
): NormalizedMutation {
  if (
    !isRecord(request) ||
    (request.kind !== "package-install" && request.kind !== "protected-command") ||
    !COMMAND_ID_PATTERN.test(request.commandId) ||
    !isAbortSignal(request.signal)
  ) {
    throw requestError();
  }
  if (request.kind === "package-install") {
    return normalizePackageMutation(configuration, request);
  }
  return normalizeProtectedMutation(configuration, request);
}

function normalizePackageMutation(
  configuration: ReturnType<typeof normalizeConfiguration>,
  request: PlatformPackageInstallRequest,
): NormalizedMutation {
  const expectedKeys = new Set([
    "kind",
    "commandId",
    "manager",
    "scope",
    "packages",
    "workingDirectory",
    "signal",
  ]);
  if (
    Object.keys(request).some((key) => !expectedKeys.has(key)) ||
    !isPackageManager(request.manager) ||
    (request.scope !== "project" && request.scope !== "system") ||
    !Array.isArray(request.packages) ||
    request.packages.length === 0 ||
    request.packages.length > 64 ||
    !request.packages.every((value) => validPackageSpec(request.manager, value))
  ) {
    throw requestError();
  }
  if (
    (request.scope === "project" && !PROJECT_PACKAGE_MANAGERS.has(request.manager)) ||
    (request.scope === "system" &&
      !SYSTEM_PACKAGE_MANAGERS[configuration.platform].has(request.manager))
  ) {
    throw requestError();
  }
  const workingDirectory =
    request.scope === "project"
      ? validateWorkingDirectory(configuration.platform, request.workingDirectory)
      : request.workingDirectory === undefined
        ? undefined
        : invalidWorkingDirectory();
  const executable = configuration.executables[request.manager];
  if (executable === undefined) {
    throw configurationError();
  }
  return Object.freeze({
    commandId: request.commandId,
    actionCategory:
      request.scope === "project"
        ? "project-dependency-install"
        : "configured-official-package-install",
    actionType:
      request.scope === "project"
        ? "platform.package.install-project-dependency"
        : "platform.package.install-configured-source",
    executableId: request.manager,
    executable,
    arguments: Object.freeze(packageArguments(request.manager, request.packages)),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    signal: request.signal,
  });
}

function normalizeProtectedMutation(
  configuration: ReturnType<typeof normalizeConfiguration>,
  request: PlatformProtectedCommandRequest,
): NormalizedMutation {
  const expectedKeys = new Set([
    "kind",
    "commandId",
    "actionCategory",
    "executableId",
    "arguments",
    "workingDirectory",
    "signal",
  ]);
  if (
    Object.keys(request).some((key) => !expectedKeys.has(key)) ||
    !isProtectedCategory(request.actionCategory) ||
    !isExecutableId(request.executableId) ||
    !PROTECTED_EXECUTABLES[request.actionCategory].has(request.executableId)
  ) {
    throw new PlatformMutationError(
      "MUTATION_CATEGORY_EXECUTABLE_MISMATCH",
      "The requested executable is not registered for this protected action category.",
    );
  }
  if (
    EXECUTABLE_PLATFORMS[request.executableId] !== undefined &&
    !EXECUTABLE_PLATFORMS[request.executableId]?.has(configuration.platform)
  ) {
    throw new PlatformMutationError(
      "MUTATION_CATEGORY_EXECUTABLE_MISMATCH",
      "The requested executable is not supported for this platform.",
    );
  }
  const executable = configuration.executables[request.executableId];
  if (executable === undefined) {
    throw configurationError();
  }
  const arguments_ = validateArguments(request.arguments);
  const workingDirectory =
    request.workingDirectory === undefined
      ? undefined
      : validateWorkingDirectory(configuration.platform, request.workingDirectory);
  return Object.freeze({
    commandId: request.commandId,
    actionCategory: request.actionCategory,
    actionType: `platform.${request.actionCategory}`,
    executableId: request.executableId,
    executable,
    arguments: arguments_,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    signal: request.signal,
  });
}

function packageArguments(
  manager: PlatformPackageManager,
  packages: readonly string[],
): readonly string[] {
  switch (manager) {
    case "npm":
      return [
        "install",
        "--save-exact",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org/",
        ...packages,
      ];
    case "pnpm":
      return [
        "add",
        "--save-exact",
        "--ignore-scripts",
        "--registry=https://registry.npmjs.org/",
        ...packages,
      ];
    case "yarn":
      return [
        "add",
        "--exact",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org/",
        ...packages,
      ];
    case "bun":
      return [
        "add",
        "--exact",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org/",
        ...packages,
      ];
    case "pip":
    case "pip3":
      return [
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--only-binary=:all:",
        "--no-input",
        "--index-url",
        "https://pypi.org/simple",
        ...packages,
      ];
    case "cargo":
      return ["add", "--locked", "--registry", "crates-io", ...packages];
    case "apt":
    case "apt-get":
      return ["install", "-y", "--no-install-recommends", ...packages];
    case "dnf":
    case "yum":
      return ["install", "-y", ...packages];
    case "zypper":
      return ["--non-interactive", "install", ...packages];
    case "brew":
      return ["install", ...packages];
    case "winget":
      if (packages.length !== 1) {
        throw requestError();
      }
      return [
        "install",
        "--exact",
        "--id",
        packages[0] as string,
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
      ];
    case "choco":
      return ["install", "-y", "--no-progress", ...packages];
  }
}

function actionFingerprint(
  platform: CreatePlatformMutationExecutorInput["platform"],
  mutation: NormalizedMutation,
): `sha256:${string}` {
  const exact = canonicalJson({
    schemaVersion: 1,
    platform,
    commandId: mutation.commandId,
    actionCategory: mutation.actionCategory,
    actionType: mutation.actionType,
    executableId: mutation.executableId,
    executable: mutation.executable,
    arguments: mutation.arguments,
    ...(mutation.workingDirectory === undefined
      ? {}
      : { workingDirectory: mutation.workingDirectory }),
  });
  return `sha256:${createHash("sha256").update(exact).digest("hex")}`;
}

function createAuthorizationRequest(
  platform: CreatePlatformMutationExecutorInput["platform"],
  mutation: NormalizedMutation,
  actionFingerprint_: `sha256:${string}`,
  requestedAtMs: number,
): PlatformMutationAuthorizationRequest {
  const digest = createHash("sha256")
    .update(`${mutation.commandId}\0${actionFingerprint_}`)
    .digest("hex");
  const actionDescriptor = Object.freeze({
    platform,
    executable: mutation.executableId,
    argumentCount: mutation.arguments.length,
    privacy: "exact-arguments-committed-on-device",
    ...(mutation.workingDirectory === undefined ? {} : { workspace: "run-workspace" }),
  });
  if (Buffer.byteLength(JSON.stringify(actionDescriptor), "utf8") > MAXIMUM_DESCRIPTOR_BYTES) {
    throw requestError();
  }
  return Object.freeze({
    authorizationRequestId: `platform-mutation:${digest}`,
    actionCategory: mutation.actionCategory,
    actionType: mutation.actionType,
    actionFingerprint: actionFingerprint_,
    actionDescriptor,
    requestedAtMs,
    signal: mutation.signal,
  });
}

async function claimMutation(
  journal: PlatformMutationCommandJournal,
  mutation: NormalizedMutation,
  fingerprint: `sha256:${string}`,
): Promise<PlatformMutationCommandJournalClaim> {
  let claim: PlatformMutationCommandJournalClaim;
  try {
    claim = await journal.claim({
      commandId: mutation.commandId,
      actionCategory: mutation.actionCategory,
      actionFingerprint: fingerprint,
    });
  } catch (error) {
    throw new PlatformMutationError(
      "MUTATION_JOURNAL_UNAVAILABLE",
      "The platform mutation journal failed closed.",
      { cause: error },
    );
  }
  if (
    claim.disposition !== "claimed" &&
    claim.disposition !== "completed" &&
    claim.disposition !== "conflict" &&
    claim.disposition !== "in-progress"
  ) {
    throw new PlatformMutationError(
      "MUTATION_JOURNAL_UNAVAILABLE",
      "The platform mutation journal returned an invalid claim.",
    );
  }
  return claim;
}

async function completeMutation(
  journal: PlatformMutationCommandJournal,
  receipt: PlatformMutationReceipt,
): Promise<void> {
  try {
    await journal.complete({
      commandId: receipt.commandId,
      actionFingerprint: receipt.actionFingerprint,
      receipt,
    });
  } catch (error) {
    throw new PlatformMutationError(
      "MUTATION_OUTCOME_UNKNOWN",
      "The platform mutation completed but its durable receipt could not be recorded.",
      { cause: error },
    );
  }
}

function normalizeReplayReceipt(
  receipt: PlatformMutationReceipt,
  mutation: NormalizedMutation,
  fingerprint: `sha256:${string}`,
): PlatformMutationReceipt {
  if (
    !isRecord(receipt) ||
    receipt.commandId !== mutation.commandId ||
    receipt.actionCategory !== mutation.actionCategory ||
    receipt.actionFingerprint !== fingerprint ||
    !HASH_PATTERN.test(receipt.actionFingerprint) ||
    (receipt.outcome !== "succeeded" &&
      receipt.outcome !== "failed" &&
      receipt.outcome !== "denied") ||
    !validReasonCode(receipt.reasonCode) ||
    !Number.isSafeInteger(receipt.completedAtMs) ||
    receipt.completedAtMs < 0
  ) {
    throw new PlatformMutationError(
      "MUTATION_JOURNAL_UNAVAILABLE",
      "The durable platform mutation receipt is invalid.",
    );
  }
  return Object.freeze({ ...receipt });
}

function receiptFor(
  mutation: NormalizedMutation,
  actionFingerprint_: `sha256:${string}`,
  outcome: PlatformMutationReceipt["outcome"],
  reasonCode: string,
  completedAtMs: number,
  processResult?: { readonly exitCode: number; readonly signal: string | null },
): PlatformMutationReceipt {
  return Object.freeze({
    commandId: mutation.commandId,
    actionCategory: mutation.actionCategory,
    actionFingerprint: actionFingerprint_,
    outcome,
    reasonCode,
    ...(processResult === undefined ? {} : { exitCode: processResult.exitCode }),
    ...(processResult?.signal === null || processResult?.signal === undefined
      ? {}
      : { processSignal: processResult.signal }),
    completedAtMs,
  });
}

function validateProcessRequest(request: PlatformMutationProcessRequest): void {
  if (
    !isRecord(request) ||
    typeof request.commandId !== "string" ||
    !COMMAND_ID_PATTERN.test(request.commandId) ||
    !isActionCategory(request.actionCategory) ||
    !isExecutableId(request.executableId) ||
    typeof request.executable !== "string" ||
    (!win32.isAbsolute(request.executable) && !posix.isAbsolute(request.executable)) ||
    !Array.isArray(request.arguments) ||
    request.arguments.length > MAXIMUM_ARGUMENTS ||
    !request.arguments.every(validArgument) ||
    (request.workingDirectory !== undefined && typeof request.workingDirectory !== "string") ||
    !isAbortSignal(request.signal)
  ) {
    throw requestError();
  }
}

function validateArguments(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAXIMUM_ARGUMENTS ||
    !value.every(validArgument)
  ) {
    throw requestError();
  }
  return Object.freeze([...value]);
}

function validArgument(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_ARGUMENT_BYTES &&
    !containsDisallowedControl(value) &&
    !containsSecretLikeArgument(value)
  );
}

function validPackageSpec(manager: PlatformPackageManager, value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.startsWith("-") ||
    containsDisallowedControl(value) ||
    /[\s;&|`$(){}[\]\\'"<>]/u.test(value)
  ) {
    return false;
  }
  if (manager === "npm" || manager === "pnpm" || manager === "yarn" || manager === "bun") {
    return /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9.*+^~<>=|-]+)?$/iu.test(value);
  }
  if (manager === "pip" || manager === "pip3") {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?(?:(?:==|~=|>=|<=|>|<)[A-Za-z0-9.*+!_-]+)?$/u.test(
      value,
    );
  }
  if (manager === "cargo") {
    return /^[A-Za-z0-9][A-Za-z0-9_-]*(?:@[A-Za-z0-9.*+^~<>=|-]+)?$/u.test(value);
  }
  return /^[A-Za-z0-9][A-Za-z0-9._+@:-]*$/u.test(value);
}

function validateWorkingDirectory(
  platform: CreatePlatformMutationExecutorInput["platform"],
  value: unknown,
): string {
  if (
    typeof value !== "string" ||
    !isAbsoluteFor(platform, value) ||
    value !== normalizePath(platform, value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4_096
  ) {
    return invalidWorkingDirectory();
  }
  return value;
}

function invalidWorkingDirectory(): never {
  throw requestError();
}

function containsSecretLikeArgument(value: string): boolean {
  return (
    /secret:\/\//iu.test(value) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /^Bearer\s+/iu.test(value) ||
    /^tskey-/iu.test(value) ||
    /^(?:--?)?(?:access[_-]?token|auth(?:entication)?[_-]?key|api[_-]?key|password|passwd|secret|token)(?:=|:|$)/iu.test(
      value,
    ) ||
    /[?&](?:access[_-]?token|auth(?:entication)?[_-]?key|api[_-]?key|password|passwd|secret|token)=/iu.test(
      value,
    )
  );
}

function normalizeProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!isRecord(environment) || Object.keys(environment).length > 256) {
    throw configurationError();
  }
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      name.length === 0 ||
      name.includes("\0") ||
      name.includes("=") ||
      Buffer.byteLength(name, "utf8") > 256 ||
      (value !== undefined &&
        (typeof value !== "string" ||
          value.includes("\0") ||
          Buffer.byteLength(value, "utf8") > 32_768))
    ) {
      throw configurationError();
    }
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return Object.freeze(result);
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw requestError();
}

function readClock(clock: { now(): number }): number {
  const value = clock.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw configurationError();
  }
  return value;
}

function validReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(value);
}

function isPackageManager(value: unknown): value is PlatformPackageManager {
  return (
    typeof value === "string" &&
    (PROJECT_PACKAGE_MANAGERS.has(value as PlatformPackageManager) ||
      Object.values(SYSTEM_PACKAGE_MANAGERS).some((managers) =>
        managers.has(value as PlatformPackageManager),
      ))
  );
}

function isProtectedCategory(
  value: unknown,
): value is PlatformProtectedCommandRequest["actionCategory"] {
  return typeof value === "string" && Object.hasOwn(PROTECTED_EXECUTABLES, value);
}

function isActionCategory(value: unknown): value is PlatformMutationActionCategory {
  return (
    value === "project-dependency-install" ||
    value === "configured-official-package-install" ||
    isProtectedCategory(value)
  );
}

function isExecutableId(value: unknown): value is PlatformMutationExecutableId {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(value) &&
    (isPackageManager(value) ||
      Object.values(PROTECTED_EXECUTABLES).some((executables) =>
        executables.has(value as PlatformMutationExecutableId),
      ))
  );
}

function isAbsoluteFor(
  platform: CreatePlatformMutationExecutorInput["platform"],
  value: string,
): boolean {
  return platform === "windows" ? win32.isAbsolute(value) : posix.isAbsolute(value);
}

function normalizePath(
  platform: CreatePlatformMutationExecutorInput["platform"],
  value: string,
): string {
  return platform === "windows" ? win32.normalize(value) : posix.normalize(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly aborted?: unknown }).aborted === "boolean" &&
    typeof (value as { readonly addEventListener?: unknown }).addEventListener === "function"
  );
}

function containsDisallowedControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === undefined || codePoint < 32 || codePoint === 127;
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasMethod(value: unknown, method: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Readonly<Record<string, unknown>>)[method] === "function"
  );
}

function configurationError(): PlatformMutationError {
  return new PlatformMutationError(
    "MUTATION_CONFIGURATION_INVALID",
    "The platform mutation executor configuration is invalid.",
  );
}

function requestError(): PlatformMutationError {
  return new PlatformMutationError(
    "MUTATION_REQUEST_INVALID",
    "The platform mutation request is invalid.",
  );
}
