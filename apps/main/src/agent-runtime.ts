import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  ClaudeAgentSdkAdapter,
  CodexAppServerAdapter,
  FileSessionLeaseStore,
  type AgentAdapter,
  type AgentAdapterProbe,
  type AgentRunLimits,
  type SessionLeaseStore,
  type WorkspaceBinding,
} from "@opendelegate/agent-adapters";

import type { AgentBackedConfigurationAgentOptions } from "./agent-configuration-agent.ts";
import type { AgentBackedTaskExecutorOptions } from "./agent-task-executor.ts";

export type MainAgentProviderPreference = "auto" | "codex" | "claude" | "disabled";
export type SelectedMainAgentProvider = Exclude<MainAgentProviderPreference, "auto">;

interface SelectedAgentConfiguration {
  readonly schemaVersion: 1;
  readonly provider: SelectedMainAgentProvider;
}

export interface MainAgentRuntimePaths {
  readonly home: string;
  readonly configDirectory: string;
  readonly stateDirectory: string;
}

export interface MainAgentCompositionReady {
  readonly status: "ready";
  readonly provider: Exclude<SelectedMainAgentProvider, "disabled">;
  readonly probe: AgentAdapterProbe;
  readonly taskExecution: Omit<
    AgentBackedTaskExecutorOptions,
    "checkpoints" | "deviceId" | "sessionRepository"
  > & {
    readonly maximumConcurrentTasks: number;
    readonly maximumAutomaticAttempts: number;
    readonly retryDelayMs: number;
  };
  readonly configurationAgent: Omit<
    AgentBackedConfigurationAgentOptions,
    "clock" | "eventStore" | "mainDeviceId" | "sessionRepository" | "toolBroker"
  >;
}

export interface MainAgentCompositionUnavailable {
  readonly status: "unavailable";
  readonly provider?: SelectedMainAgentProvider;
  readonly code:
    | "AGENT_DISABLED"
    | "AGENT_NOT_INSTALLED"
    | "AGENT_AUTH_NOT_READY"
    | "AGENT_VERSION_UNSUPPORTED"
    | "AGENT_CAPABILITY_MISSING"
    | "AGENT_PROBE_FAILED";
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}

export type MainAgentComposition = MainAgentCompositionReady | MainAgentCompositionUnavailable;

export interface ResolveMainAgentCompositionOptions {
  readonly paths: MainAgentRuntimePaths;
  readonly requestedProvider?: MainAgentProviderPreference;
  readonly createAdapter?: (
    provider: Exclude<SelectedMainAgentProvider, "disabled">,
    leaseStore: SessionLeaseStore,
  ) => AgentAdapter;
}

export type MainAgentRuntimeErrorCode = "AGENT_CONFIGURATION_CORRUPT" | "AGENT_PROVIDER_CONFLICT";

export class MainAgentRuntimeError extends Error {
  readonly code: MainAgentRuntimeErrorCode;

  constructor(code: MainAgentRuntimeErrorCode, message: string) {
    super(message);
    this.name = "MainAgentRuntimeError";
    this.code = code;
  }
}

const selectionFilename = "agent.json";
const maximumSelectionBytes = 4 * 1024;
const providerPreference = ["codex", "claude"] as const;

export const DEFAULT_MAIN_AGENT_LIMITS: AgentRunLimits = Object.freeze({
  wallTimeoutMs: 30 * 60 * 1_000,
  idleTimeoutMs: 5 * 60 * 1_000,
  cancellationGraceMs: 5_000,
  leaseTtlMs: 30_000,
  leaseRenewIntervalMs: 10_000,
  maxBufferedEvents: 256,
  maxLineBytes: 1024 * 1024,
  maxDiagnosticBytes: 256 * 1024,
});

export async function resolveMainAgentComposition(
  options: ResolveMainAgentCompositionOptions,
): Promise<MainAgentComposition> {
  const selectionPath = join(options.paths.configDirectory, selectionFilename);
  const existing = await readSelectedAgentConfiguration(selectionPath);
  const requested = options.requestedProvider ?? "auto";
  const reenableFromDisabled =
    existing?.provider === "disabled" && requested !== "auto" && requested !== "disabled";
  if (
    existing !== undefined &&
    requested !== "auto" &&
    requested !== existing.provider &&
    !reenableFromDisabled
  ) {
    throw new MainAgentRuntimeError(
      "AGENT_PROVIDER_CONFLICT",
      "Main already has a different fixed Agent provider. Change it through the authenticated configuration flow.",
    );
  }

  if (
    (existing?.provider === "disabled" && !reenableFromDisabled) ||
    (existing === undefined && requested === "disabled")
  ) {
    if (existing === undefined) {
      await persistSelection(selectionPath, { schemaVersion: 1, provider: "disabled" });
    }
    return {
      status: "unavailable",
      provider: "disabled",
      code: "AGENT_DISABLED",
      diagnostics: [],
    };
  }

  const leaseStore = new FileSessionLeaseStore({
    statePath: join(options.paths.stateDirectory, "native-session-leases.json"),
  });
  const candidates =
    existing === undefined || reenableFromDisabled
      ? requested === "auto"
        ? providerPreference
        : [requested]
      : [existing.provider];

  const outcomes: {
    readonly provider: Exclude<SelectedMainAgentProvider, "disabled">;
    readonly adapter: AgentAdapter;
    readonly probe?: AgentAdapterProbe;
    readonly error?: unknown;
  }[] = [];
  for (const provider of candidates) {
    if (provider === "disabled") {
      continue;
    }
    const adapter =
      options.createAdapter?.(provider, leaseStore) ??
      createProductionAdapter(provider, leaseStore, options.paths);
    try {
      outcomes.push({
        provider,
        adapter,
        probe: await adapter.probe(),
      });
    } catch (error) {
      outcomes.push({ provider, adapter, error });
    }
  }

  const selected = outcomes.find(
    (outcome): outcome is typeof outcome & { readonly probe: AgentAdapterProbe } =>
      outcome.probe !== undefined && isReadyProbe(outcome.probe),
  );
  if (selected === undefined) {
    const preferred = outcomes[0];
    const unavailableProvider = reenableFromDisabled
      ? requested
      : (existing?.provider ?? (requested === "auto" ? undefined : requested));
    return {
      status: "unavailable",
      ...(unavailableProvider === undefined ? {} : { provider: unavailableProvider }),
      code: preferred === undefined ? "AGENT_PROBE_FAILED" : unavailableCode(preferred),
      diagnostics: Object.freeze(
        outcomes.flatMap((outcome) =>
          outcome.probe === undefined
            ? [
                {
                  code: "AGENT_PROBE_FAILED",
                  message: `${outcome.provider} Agent probe failed without exposing process output.`,
                },
              ]
            : outcome.probe.diagnostics.map((diagnostic) => ({
                code: diagnostic.code,
                message: diagnostic.message,
              })),
        ),
      ),
    };
  }

  if (existing === undefined) {
    await persistSelection(selectionPath, {
      schemaVersion: 1,
      provider: selected.provider,
    });
  } else if (reenableFromDisabled) {
    await replaceDisabledSelection(selectionPath, {
      schemaVersion: 1,
      provider: selected.provider,
    });
  }
  const agentWorkspace = await ensureAgentWorkspace(options.paths);
  return createReadyComposition(
    agentWorkspace,
    selected.provider,
    selected.adapter,
    selected.probe,
  );
}

function createReadyComposition(
  agentWorkspace: string,
  provider: Exclude<SelectedMainAgentProvider, "disabled">,
  adapter: AgentAdapter,
  probe: AgentAdapterProbe,
): MainAgentCompositionReady {
  const workspace: WorkspaceBinding = Object.freeze({
    workspaceId: "workspace_main_runtime",
    cwd: agentWorkspace,
    isolation: "none",
  });
  const sandbox = "read-only" as const;
  const execution = {
    adapter,
    workspace,
    sandbox,
    permissions: Object.freeze({ mode: "deny" as const }),
    limits: DEFAULT_MAIN_AGENT_LIMITS,
  };
  return Object.freeze({
    status: "ready",
    provider,
    probe: structuredClone(probe),
    taskExecution: Object.freeze({
      ...execution,
      maximumConcurrentTasks: 4,
      maximumAutomaticAttempts: 3,
      retryDelayMs: 2_000,
    }),
    configurationAgent: Object.freeze({ ...execution }),
  });
}

async function ensureAgentWorkspace(paths: MainAgentRuntimePaths): Promise<string> {
  const workspaceRoot = join(paths.home, "workspaces");
  const workspace = join(workspaceRoot, "main-agent");
  for (const path of [workspaceRoot, workspace]) {
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw corruptSelection();
      }
    }
    let metadata;
    try {
      metadata = await lstat(path);
    } catch {
      throw corruptSelection();
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw corruptSelection();
    }
  }
  return workspace;
}

function createProductionAdapter(
  provider: Exclude<SelectedMainAgentProvider, "disabled">,
  leaseStore: SessionLeaseStore,
  paths: MainAgentRuntimePaths,
): AgentAdapter {
  return provider === "codex"
    ? new CodexAppServerAdapter({
        codexHome: join(paths.stateDirectory, "providers", "codex"),
        leaseStore,
      })
    : new ClaudeAgentSdkAdapter({
        claudeHome: join(paths.stateDirectory, "providers", "claude"),
        leaseStore,
      });
}

function isReadyProbe(probe: AgentAdapterProbe): boolean {
  return (
    probe.installed &&
    probe.compatibility === "tested" &&
    probe.auth.state === "ready" &&
    probe.capabilities.start &&
    probe.capabilities.resume &&
    probe.capabilities.streaming &&
    probe.capabilities.cancellation
  );
}

function unavailableCode(outcome: {
  readonly probe?: AgentAdapterProbe;
  readonly error?: unknown;
}): MainAgentCompositionUnavailable["code"] {
  const probe = outcome.probe;
  if (probe === undefined || outcome.error !== undefined) {
    return "AGENT_PROBE_FAILED";
  }
  if (!probe.installed) {
    return "AGENT_NOT_INSTALLED";
  }
  if (probe.auth.state !== "ready") {
    return "AGENT_AUTH_NOT_READY";
  }
  if (probe.compatibility !== "tested") {
    return "AGENT_VERSION_UNSUPPORTED";
  }
  return "AGENT_CAPABILITY_MISSING";
}

async function readSelectedAgentConfiguration(
  path: string,
): Promise<SelectedAgentConfiguration | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw corruptSelection();
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumSelectionBytes
  ) {
    throw corruptSelection();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw corruptSelection();
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["schemaVersion", "provider"]) ||
    parsed["schemaVersion"] !== 1 ||
    (parsed["provider"] !== "codex" &&
      parsed["provider"] !== "claude" &&
      parsed["provider"] !== "disabled")
  ) {
    throw corruptSelection();
  }
  return Object.freeze({
    schemaVersion: 1,
    provider: parsed["provider"],
  });
}

async function persistSelection(
  path: string,
  configuration: SelectedAgentConfiguration,
): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(configuration, undefined, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw corruptSelection();
    }
    const existing = await readSelectedAgentConfiguration(path);
    if (existing?.provider !== configuration.provider) {
      throw new MainAgentRuntimeError(
        "AGENT_PROVIDER_CONFLICT",
        "Another Main process fixed a different Agent provider.",
      );
    }
  }
}

async function replaceDisabledSelection(
  path: string,
  configuration: SelectedAgentConfiguration,
): Promise<void> {
  const lockPath = `${path}.lock`;
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new MainAgentRuntimeError(
        "AGENT_PROVIDER_CONFLICT",
        "Another Main process is changing the fixed Agent provider.",
      );
    }
    throw corruptSelection();
  }

  try {
    const current = await readSelectedAgentConfiguration(path);
    if (current?.provider !== "disabled") {
      throw new MainAgentRuntimeError(
        "AGENT_PROVIDER_CONFLICT",
        "Another Main process already changed the fixed Agent provider.",
      );
    }
    await writeFile(temporaryPath, `${JSON.stringify(configuration, undefined, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    if (error instanceof MainAgentRuntimeError) {
      throw error;
    }
    throw corruptSelection();
  } finally {
    await lock.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function corruptSelection(): MainAgentRuntimeError {
  return new MainAgentRuntimeError(
    "AGENT_CONFIGURATION_CORRUPT",
    "The fixed Main Agent provider configuration is unsafe or malformed.",
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
