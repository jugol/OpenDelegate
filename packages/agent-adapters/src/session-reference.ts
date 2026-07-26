import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import {
  type AgentProvider,
  type AgentResumeRequest,
  type AgentStartRequest,
  type NativeSessionReference,
  type WorkspaceBinding,
} from "./contracts.ts";
import { AgentAdapterError } from "./errors.ts";
import { validateEnvironmentChannels } from "./process-utils.ts";

export interface CanonicalWorkspaceBinding {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly worktreePath?: string;
  readonly isolation: WorkspaceBinding["isolation"];
}

export async function canonicalizeWorkspace(
  workspace: WorkspaceBinding,
): Promise<CanonicalWorkspaceBinding> {
  const cwd = await canonicalDirectory(workspace.cwd, "Working directory");
  let worktreePath: string | undefined;
  if (workspace.worktreePath !== undefined) {
    worktreePath = await canonicalDirectory(workspace.worktreePath, "Worktree");
    const pathFromWorktree = relative(worktreePath, cwd);
    if (
      pathFromWorktree === ".." ||
      pathFromWorktree.startsWith(`..${sep}`) ||
      isAbsolute(pathFromWorktree)
    ) {
      throw new AgentAdapterError(
        "INVALID_WORKSPACE",
        "Working directory must be inside its declared worktree.",
      );
    }
  }
  return {
    workspaceId: workspace.workspaceId,
    cwd,
    ...(worktreePath === undefined ? {} : { worktreePath }),
    isolation: workspace.isolation,
  };
}

export function validateAgentRequest(request: AgentStartRequest | AgentResumeRequest): void {
  validateEnvironmentChannels(request.environment);
  validateToolServers(request.toolServers);
  const required = [
    request.requestId,
    request.runId,
    request.taskId,
    request.workstreamId,
    request.sessionKey,
    request.deviceId,
    request.workspace.workspaceId,
  ];
  if (required.some((value) => value.length === 0)) {
    throw new AgentAdapterError("INVALID_REQUEST", "Agent request identifiers are required.");
  }
  for (const [name, value] of Object.entries(request.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AgentAdapterError("INVALID_LIMIT", `${name} must be a positive integer.`);
    }
  }
  if (request.limits.leaseRenewIntervalMs >= request.limits.leaseTtlMs) {
    throw new AgentAdapterError(
      "INVALID_LIMIT",
      "Session lease renewal must occur before lease expiry.",
    );
  }
  if (request.operation === "start" && request.continuationOf !== undefined) {
    if (
      request.continuationOf.taskId !== request.taskId ||
      request.continuationOf.workstreamId !== request.workstreamId ||
      request.continuationOf.sessionKey !== request.sessionKey
    ) {
      throw new AgentAdapterError(
        "CONTINUATION_BINDING_MISMATCH",
        "Checkpoint continuation must remain in the same Task workstream.",
      );
    }
    if (
      request.continuationReason === undefined ||
      request.continuationReason.trim().length === 0
    ) {
      throw new AgentAdapterError(
        "CONTINUATION_REASON_REQUIRED",
        "Checkpoint continuation requires an explicit reason.",
      );
    }
  }
}

/**
 * A general-purpose Agent provider is not a minimal credential scope: any
 * provider-native shell or file tool could read its process environment.
 * Provider authentication belongs in the controlled provider home, while Task
 * credentials must be exposed through an exact, typed Device-local helper.
 */
export function rejectUnscopedProviderSecrets(
  request: AgentStartRequest | AgentResumeRequest,
): void {
  if (Object.keys(request.secretEnvironment ?? {}).length > 0) {
    throw new AgentAdapterError(
      "SECRET_ENVIRONMENT_SCOPE_UNSAFE",
      "Agent provider turns cannot receive credential environment variables; use the controlled provider home or a typed Run-scoped Secret helper.",
    );
  }
}

function validateToolServers(toolServers: AgentStartRequest["toolServers"]): void {
  if (toolServers === undefined) {
    return;
  }
  if (toolServers.length === 0 || toolServers.length > 8) {
    throw new AgentAdapterError(
      "INVALID_REQUEST",
      "Agent tool-server configuration must contain 1 to 8 servers.",
    );
  }
  const names = new Set<string>();
  for (const server of toolServers) {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/u.test(server.serverName) ||
      names.has(server.serverName) ||
      !isAbsolute(server.command) ||
      server.command.includes("\0") ||
      server.args.length > 64 ||
      server.args.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length > 8_192 ||
          argument.includes("\0") ||
          hasControlCharacter(argument),
      ) ||
      server.enabledTools.length === 0 ||
      server.enabledTools.length > 64 ||
      new Set(server.enabledTools).size !== server.enabledTools.length ||
      server.enabledTools.some((tool) => !/^[a-z][a-z0-9_]{0,127}$/u.test(tool)) ||
      !Number.isSafeInteger(server.startupTimeoutMs) ||
      server.startupTimeoutMs < 1_000 ||
      server.startupTimeoutMs > 120_000 ||
      !Number.isSafeInteger(server.toolTimeoutMs) ||
      server.toolTimeoutMs < 1_000 ||
      server.toolTimeoutMs > 300_000
    ) {
      throw new AgentAdapterError("INVALID_REQUEST", "Agent tool-server configuration is invalid.");
    }
    names.add(server.serverName);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || point === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function validateResumeReference(
  request: AgentResumeRequest,
  workspace: CanonicalWorkspaceBinding,
  provider: AgentProvider,
  adapterId: string,
): void {
  const session = request.session;
  if (
    session.schemaVersion !== 1 ||
    session.provider !== provider ||
    session.adapterId !== adapterId ||
    session.sessionKey !== request.sessionKey ||
    session.taskId !== request.taskId ||
    session.workstreamId !== request.workstreamId ||
    session.deviceId !== request.deviceId ||
    session.workspaceId !== workspace.workspaceId ||
    session.cwd !== workspace.cwd ||
    session.worktreePath !== workspace.worktreePath ||
    session.nativeSessionId.length === 0
  ) {
    throw new AgentAdapterError(
      "NATIVE_SESSION_BINDING_MISMATCH",
      "Native session does not match this Task, Device, Workspace, worktree, and working directory.",
    );
  }
}

export function validateDangerousGrant(request: AgentStartRequest | AgentResumeRequest): void {
  const grant = request.permissions.dangerousBypassGrant;
  if (grant === undefined || grant.scope !== "task" || grant.taskId !== request.taskId) {
    throw new AgentAdapterError(
      "DANGEROUS_BYPASS_GRANT_REQUIRED",
      "Dangerous provider bypass requires an exact Task-scoped owner or Policy grant.",
    );
  }
}

export function createNativeSessionReference(options: {
  readonly provider: AgentProvider;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly nativeSessionId: string;
  readonly request: AgentStartRequest | AgentResumeRequest;
  readonly workspace: CanonicalWorkspaceBinding;
  readonly lineageId: () => string;
  readonly now: () => number;
}): NativeSessionReference {
  const { request, workspace } = options;
  const existing = request.operation === "resume" ? request.session : undefined;
  const continuation = request.operation === "start" ? request.continuationOf : undefined;
  return {
    schemaVersion: 1,
    provider: options.provider,
    adapterId: options.adapterId,
    adapterVersion: options.adapterVersion,
    nativeSessionId: options.nativeSessionId,
    sessionKey: request.sessionKey,
    taskId: request.taskId,
    workstreamId: request.workstreamId,
    deviceId: request.deviceId,
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    ...(workspace.worktreePath === undefined ? {} : { worktreePath: workspace.worktreePath }),
    lineage:
      existing?.lineage ??
      ({
        lineageId: options.lineageId(),
        ...(continuation === undefined
          ? {}
          : { parentNativeSessionId: continuation.nativeSessionId }),
        ...(request.operation !== "start" || request.continuationReason === undefined
          ? {}
          : { continuationReason: request.continuationReason }),
      } satisfies NativeSessionReference["lineage"]),
    createdAt: existing?.createdAt ?? new Date(options.now()).toISOString(),
  };
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (path.length === 0 || !isAbsolute(path)) {
    throw new AgentAdapterError("INVALID_WORKSPACE", `${label} must be an absolute path.`);
  }
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw new AgentAdapterError("INVALID_WORKSPACE", `${label} is not a directory.`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof AgentAdapterError) {
      throw error;
    }
    throw new AgentAdapterError(
      "INVALID_WORKSPACE",
      `${label} does not exist or cannot be resolved.`,
    );
  }
}
