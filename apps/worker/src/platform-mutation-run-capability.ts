import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { WorkspaceBinding } from "@opendelegate/agent-adapters";
import {
  type PlatformMutationActionCategory,
  type PlatformMutationExecutableId,
  type PlatformMutationExecutor,
  type PlatformMutationProcessRequest,
  type PlatformMutationProcessRunner,
  type PlatformMutationReceipt,
  type PlatformMutationRequest,
  type PlatformPackageManager,
} from "@opendelegate/platform-services";
import {
  RunCapabilityBrokerError,
  consumeRunCapabilityFile,
  type LocalRunCapabilityBroker,
  type RunCapabilityBinding,
  type RunCapabilityClient,
  type RunCapabilityJsonValue,
  type RunCapabilityLease,
  type RunCapabilityRequestContext,
} from "@opendelegate/run-capability-broker";
import type {
  WorkerRunAssignmentV1,
  WorkerRunCapabilityLease,
  WorkerRunCapabilityProvider,
  WorkerRunLeaseAuthority,
} from "@opendelegate/worker-runtime";

export const PLATFORM_MUTATION_TOOL_NAME = "platform_mutation_execute" as const;
const PLATFORM_MUTATION_CAPABILITY = "platform-mutation";
const PLATFORM_MUTATION_SCHEMA_VERSION = 1;
type ProtectedPlatformMutationCategory = Exclude<
  PlatformMutationActionCategory,
  "configured-official-package-install" | "project-dependency-install"
>;

export interface PlatformMutationRunAuthority {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly deviceId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs: number;
}

export type PlatformMutationToolInput =
  | {
      readonly kind: "package-install";
      readonly commandId: string;
      readonly manager: PlatformPackageManager;
      readonly scope: "project" | "system";
      readonly packages: readonly string[];
    }
  | {
      readonly kind: "protected-command";
      readonly commandId: string;
      readonly actionCategory: ProtectedPlatformMutationCategory;
      readonly executableId: PlatformMutationExecutableId;
      readonly arguments: readonly string[];
    };

export interface PlatformMutationToolContext {
  readonly authority: PlatformMutationRunAuthority;
  readonly signal: AbortSignal;
}

export interface PlatformMutationToolPort {
  execute(
    context: PlatformMutationToolContext,
    input: PlatformMutationToolInput,
  ): Promise<PlatformMutationReceipt>;
}

export class PlatformMutationToolError extends Error {
  public readonly code: "CANCELLED" | "FAILED" | "INVALID_REQUEST" | "STALE_AUTHORITY";

  public constructor(code: PlatformMutationToolError["code"], options?: ErrorOptions) {
    super(
      code === "STALE_AUTHORITY"
        ? "The platform mutation Run authority is no longer current."
        : code === "CANCELLED"
          ? "The platform mutation was cancelled."
          : code === "INVALID_REQUEST"
            ? "The platform mutation request is invalid."
            : "The platform mutation failed.",
      options,
    );
    this.name = "PlatformMutationToolError";
    this.code = code;
  }
}

export interface WorkerPlatformMutationRunCapabilityProviderOptions {
  readonly broker: LocalRunCapabilityBroker;
  readonly platform: "windows" | "macos" | "linux";
  readonly executableIds: readonly PlatformMutationExecutableId[];
  executorFactory(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspace: PlatformMutationWorkspaceAuthority;
    readonly leaseAuthority: WorkerRunLeaseAuthority;
    isExecutionCurrent(): Promise<boolean>;
  }): PlatformMutationExecutor;
  readonly toolServerCommand: string;
  readonly toolServerArgsPrefix?: readonly string[];
}

export interface PlatformMutationWorkspaceAuthority {
  readonly cwd: string;
  /**
   * Revalidates the canonical directory chain and its pinned filesystem identity.
   * A supplied process cwd must either be omitted for a system package operation
   * or match this exact Run Workspace.
   */
  assertCurrent(processWorkingDirectory?: string): Promise<void>;
}

export function bindPlatformMutationProcessRunnerToWorkspace(
  runner: PlatformMutationProcessRunner,
  workspace: PlatformMutationWorkspaceAuthority,
): PlatformMutationProcessRunner {
  if (
    runner === null ||
    typeof runner !== "object" ||
    typeof runner.run !== "function" ||
    workspace === null ||
    typeof workspace !== "object" ||
    typeof workspace.assertCurrent !== "function"
  ) {
    throw new TypeError("The Workspace-bound platform mutation runner is invalid.");
  }
  return Object.freeze({
    async run(request: PlatformMutationProcessRequest) {
      // This is the final check after exact Policy consumption and immediately
      // before the underlying shell-free process boundary.
      await workspace.assertCurrent(request.workingDirectory);
      return runner.run(request);
    },
  });
}

/**
 * Exposes a typed, shell-free platform mutation boundary to one exact Worker Run.
 * The capability contains no host credential, executable path, or Main credential.
 */
export class WorkerPlatformMutationRunCapabilityProvider implements WorkerRunCapabilityProvider {
  readonly #options: WorkerPlatformMutationRunCapabilityProviderOptions;

  public constructor(options: WorkerPlatformMutationRunCapabilityProviderOptions) {
    validateProviderOptions(options);
    this.#options = options;
  }

  public async prepare(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspace: WorkspaceBinding;
    readonly leaseAuthority?: WorkerRunLeaseAuthority;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<WorkerRunCapabilityLease | undefined> {
    if (!(await safeCurrent(context.isExecutionCurrent))) {
      throw new PlatformMutationToolError("STALE_AUTHORITY");
    }
    const binding = runCapabilityBinding(
      context.assignment,
      context.leaseAuthority?.snapshot().leaseExpiresAtMs ?? context.assignment.leaseExpiresAtMs,
    );
    const workspace = await pinWorkspace(context.assignment, context.workspace);
    const executor = this.#options.executorFactory({
      assignment: context.assignment,
      workspace,
      leaseAuthority: context.leaseAuthority ?? staticRunLeaseAuthority(context.assignment),
      isExecutionCurrent: context.isExecutionCurrent,
    });
    if (
      executor === null ||
      typeof executor !== "object" ||
      typeof executor.execute !== "function"
    ) {
      throw new PlatformMutationToolError("FAILED");
    }
    const handler = new CurrentRunPlatformMutationHandler({
      binding,
      executor,
      workspace,
      isExecutionCurrent: context.isExecutionCurrent,
    });
    let brokerLease: RunCapabilityLease | undefined;
    try {
      brokerLease = await this.#options.broker.register({
        capability: PLATFORM_MUTATION_CAPABILITY,
        binding,
        metadata: {
          schemaVersion: PLATFORM_MUTATION_SCHEMA_VERSION,
          platform: this.#options.platform,
          executableIds: this.#options.executableIds,
        },
        expiresAtMs: binding.leaseExpiresAtMs,
        currentBinding: () =>
          runCapabilityBinding(
            context.assignment,
            context.leaseAuthority?.snapshot().leaseExpiresAtMs ??
              context.assignment.leaseExpiresAtMs,
          ),
        isExecutionCurrent: context.isExecutionCurrent,
        handler: (request, requestContext) =>
          handler.dispatch(request.method, request.payload, requestContext),
      });
      const lease = brokerLease;
      let disposed = false;
      return Object.freeze({
        toolServers: Object.freeze([
          Object.freeze({
            serverName: "opendelegate-platform-mutation",
            command: this.#options.toolServerCommand,
            args: Object.freeze([
              ...(this.#options.toolServerArgsPrefix ?? []),
              "platform-mutation-mcp-bridge",
              "--capability-file",
              lease.capabilityFile,
            ]),
            enabledTools: Object.freeze([PLATFORM_MUTATION_TOOL_NAME]),
            startupTimeoutMs: 15_000,
            toolTimeoutMs: 2 * 60 * 60_000,
          }),
        ]),
        async dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          await lease.dispose().catch(() => undefined);
        },
      });
    } catch (error) {
      await brokerLease?.dispose().catch(() => undefined);
      throw error;
    }
  }
}

export interface ConsumedPlatformMutationRunCapability {
  readonly authority: PlatformMutationRunAuthority;
  readonly platform: "windows" | "macos" | "linux";
  readonly executableIds: readonly PlatformMutationExecutableId[];
  readonly port: PlatformMutationToolPort;
  close(): Promise<void>;
}

export async function consumePlatformMutationRunCapabilityFile(
  filename: string,
): Promise<ConsumedPlatformMutationRunCapability> {
  const client = await consumeRunCapabilityFile({
    filename,
    expectedCapability: PLATFORM_MUTATION_CAPABILITY,
  });
  try {
    const metadata = parseMetadata(client.metadata);
    const authority = authorityFromBinding(client.binding);
    return Object.freeze({
      authority,
      ...metadata,
      port: new BrokerPlatformMutationToolPort(client, authority),
      close: () => client.close(),
    });
  } catch (error) {
    await client.close();
    throw error;
  }
}

class CurrentRunPlatformMutationHandler {
  readonly #binding: RunCapabilityBinding;
  readonly #executor: PlatformMutationExecutor;
  readonly #workspace: PlatformMutationWorkspaceAuthority;
  readonly #isExecutionCurrent: () => Promise<boolean>;

  public constructor(options: {
    readonly binding: RunCapabilityBinding;
    readonly executor: PlatformMutationExecutor;
    readonly workspace: PlatformMutationWorkspaceAuthority;
    isExecutionCurrent(): Promise<boolean>;
  }) {
    this.#binding = options.binding;
    this.#executor = options.executor;
    this.#workspace = options.workspace;
    this.#isExecutionCurrent = options.isExecutionCurrent;
  }

  public async dispatch(
    method: string,
    payload: RunCapabilityJsonValue,
    context: RunCapabilityRequestContext,
  ): Promise<RunCapabilityJsonValue> {
    await this.#assertCurrent(context);
    if (method !== "execute") {
      throw new PlatformMutationToolError("INVALID_REQUEST");
    }
    const input = parsePlatformMutationToolInput(payload);
    await this.#workspace.assertCurrent();
    const request = Object.freeze({
      ...input,
      commandId: namespacedCommandId(this.#binding, input.commandId),
      ...(input.kind === "package-install" && input.scope === "system"
        ? {}
        : { workingDirectory: this.#workspace.cwd }),
      signal: context.signal,
    }) as PlatformMutationRequest;
    const receipt = await this.#executor.execute(request);
    await this.#workspace.assertCurrent();
    await this.#assertCurrent(context);
    return toJsonValue(receipt);
  }

  async #assertCurrent(context: RunCapabilityRequestContext): Promise<void> {
    if (context.signal.aborted) {
      throw new PlatformMutationToolError("CANCELLED");
    }
    if (
      !sameRunBinding(context.binding, this.#binding) ||
      !(await safeCurrent(this.#isExecutionCurrent))
    ) {
      throw new PlatformMutationToolError("STALE_AUTHORITY");
    }
  }
}

class BrokerPlatformMutationToolPort implements PlatformMutationToolPort {
  readonly #client: RunCapabilityClient;
  readonly #authority: PlatformMutationRunAuthority;

  public constructor(client: RunCapabilityClient, authority: PlatformMutationRunAuthority) {
    this.#client = client;
    this.#authority = authority;
  }

  public async execute(
    context: PlatformMutationToolContext,
    input: PlatformMutationToolInput,
  ): Promise<PlatformMutationReceipt> {
    requireExactAuthority(context, this.#authority);
    try {
      return parseReceipt(
        await this.#client.request({
          method: "execute",
          payload: toJsonValue(input),
          signal: context.signal,
        }),
      );
    } catch (error) {
      throw mapBrokerError(error);
    }
  }
}

export function parsePlatformMutationToolInput(
  value: RunCapabilityJsonValue,
): PlatformMutationToolInput {
  const record = requireRecord(value);
  if (record["kind"] === "package-install") {
    requireExactKeys(record, ["kind", "commandId", "manager", "scope", "packages"]);
    if (
      typeof record["manager"] !== "string" ||
      typeof record["scope"] !== "string" ||
      !Array.isArray(record["packages"])
    ) {
      throw new PlatformMutationToolError("INVALID_REQUEST");
    }
    return Object.freeze({
      kind: "package-install",
      commandId: boundedString(record["commandId"], 128),
      manager: record["manager"] as PlatformPackageManager,
      scope: record["scope"] as "project" | "system",
      packages: Object.freeze(record["packages"].map((entry) => boundedString(entry, 256))),
    });
  }
  if (record["kind"] === "protected-command") {
    requireExactKeys(record, ["kind", "commandId", "actionCategory", "executableId", "arguments"]);
    if (
      typeof record["actionCategory"] !== "string" ||
      typeof record["executableId"] !== "string" ||
      !Array.isArray(record["arguments"])
    ) {
      throw new PlatformMutationToolError("INVALID_REQUEST");
    }
    return Object.freeze({
      kind: "protected-command",
      commandId: boundedString(record["commandId"], 128),
      actionCategory: record["actionCategory"] as ProtectedPlatformMutationCategory,
      executableId: record["executableId"] as PlatformMutationExecutableId,
      arguments: Object.freeze(record["arguments"].map((entry) => boundedString(entry, 4_096))),
    });
  }
  throw new PlatformMutationToolError("INVALID_REQUEST");
}

interface WorkspaceIdentity {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly birthtimeMs: number;
}

async function pinWorkspace(
  assignment: WorkerRunAssignmentV1,
  workspace: WorkspaceBinding,
): Promise<PlatformMutationWorkspaceAuthority> {
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    Array.isArray(workspace) ||
    typeof workspace.workspaceId !== "string" ||
    workspace.workspaceId.length === 0 ||
    (assignment.workOrder.workspaceId !== undefined &&
      workspace.workspaceId !== assignment.workOrder.workspaceId) ||
    typeof workspace.cwd !== "string" ||
    !isAbsolute(workspace.cwd) ||
    resolve(workspace.cwd) !== workspace.cwd ||
    (workspace.worktreePath !== undefined &&
      (!isAbsolute(workspace.worktreePath) ||
        resolve(workspace.worktreePath) !== workspace.worktreePath ||
        !sameFileSystemPath(workspace.worktreePath, workspace.cwd)))
  ) {
    throw new PlatformMutationToolError("INVALID_REQUEST");
  }
  let pinned: WorkspaceIdentity;
  try {
    pinned = await inspectCanonicalDirectory(workspace.cwd);
  } catch (error) {
    throw new PlatformMutationToolError("INVALID_REQUEST", { cause: error });
  }
  return Object.freeze({
    cwd: pinned.canonicalPath,
    async assertCurrent(processWorkingDirectory?: string) {
      if (
        processWorkingDirectory !== undefined &&
        !sameFileSystemPath(processWorkingDirectory, pinned.canonicalPath)
      ) {
        throw new PlatformMutationToolError("STALE_AUTHORITY");
      }
      try {
        const current = await inspectCanonicalDirectory(pinned.canonicalPath);
        if (
          !sameFileSystemPath(current.canonicalPath, pinned.canonicalPath) ||
          current.device !== pinned.device ||
          current.inode !== pinned.inode ||
          current.birthtimeMs !== pinned.birthtimeMs
        ) {
          throw new Error("workspace identity changed");
        }
      } catch (error) {
        throw new PlatformMutationToolError("STALE_AUTHORITY", { cause: error });
      }
    },
  });
}

async function inspectCanonicalDirectory(path: string): Promise<WorkspaceIdentity> {
  const canonicalPath = await realpath(path);
  if (!sameFileSystemPath(canonicalPath, path)) {
    throw new Error("workspace path is not canonical");
  }
  let current = canonicalPath;
  let target:
    | {
        readonly dev: number;
        readonly ino: number;
        readonly birthtimeMs: number;
      }
    | undefined;
  for (;;) {
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("workspace path contains a link or non-directory");
    }
    if (!sameFileSystemPath(await realpath(current), current)) {
      throw new Error("workspace path contains a reparse or link boundary");
    }
    if (target === undefined) {
      target = metadata;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  if (target === undefined) {
    throw new Error("workspace identity is unavailable");
  }
  return Object.freeze({
    canonicalPath,
    device: target.dev,
    inode: target.ino,
    birthtimeMs: target.birthtimeMs,
  });
}

function sameFileSystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function parseMetadata(value: RunCapabilityJsonValue): {
  readonly platform: "windows" | "macos" | "linux";
  readonly executableIds: readonly PlatformMutationExecutableId[];
} {
  const record = requireRecord(value);
  requireExactKeys(record, ["schemaVersion", "platform", "executableIds"]);
  if (
    record["schemaVersion"] !== PLATFORM_MUTATION_SCHEMA_VERSION ||
    (record["platform"] !== "windows" &&
      record["platform"] !== "macos" &&
      record["platform"] !== "linux") ||
    !Array.isArray(record["executableIds"]) ||
    record["executableIds"].length > 64
  ) {
    throw new PlatformMutationToolError("INVALID_REQUEST");
  }
  const executableIds = record["executableIds"].map(
    (value_) => boundedString(value_, 64) as PlatformMutationExecutableId,
  );
  if (new Set(executableIds).size !== executableIds.length) {
    throw new PlatformMutationToolError("INVALID_REQUEST");
  }
  return Object.freeze({
    platform: record["platform"],
    executableIds: Object.freeze(executableIds),
  });
}

function parseReceipt(value: RunCapabilityJsonValue): PlatformMutationReceipt {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    ["commandId", "actionCategory", "actionFingerprint", "outcome", "reasonCode", "completedAtMs"],
    ["exitCode", "processSignal"],
  );
  if (
    typeof record["actionCategory"] !== "string" ||
    typeof record["actionFingerprint"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record["actionFingerprint"]) ||
    (record["outcome"] !== "succeeded" &&
      record["outcome"] !== "failed" &&
      record["outcome"] !== "denied") ||
    typeof record["completedAtMs"] !== "number" ||
    !Number.isSafeInteger(record["completedAtMs"]) ||
    record["completedAtMs"] < 0 ||
    (record["exitCode"] !== undefined &&
      (typeof record["exitCode"] !== "number" ||
        !Number.isSafeInteger(record["exitCode"]) ||
        record["exitCode"] < 0))
  ) {
    throw new PlatformMutationToolError("FAILED");
  }
  return Object.freeze({
    commandId: boundedString(record["commandId"], 128),
    actionCategory: record["actionCategory"] as PlatformMutationActionCategory,
    actionFingerprint: record["actionFingerprint"] as `sha256:${string}`,
    outcome: record["outcome"],
    reasonCode: boundedString(record["reasonCode"], 128),
    ...(record["exitCode"] === undefined ? {} : { exitCode: record["exitCode"] }),
    ...(record["processSignal"] === undefined
      ? {}
      : { processSignal: boundedString(record["processSignal"], 64) }),
    completedAtMs: record["completedAtMs"],
  });
}

function namespacedCommandId(binding: RunCapabilityBinding, commandId: string): string {
  const digest = createHash("sha256")
    .update(
      `${binding.taskId}\0${binding.workOrderId}\0${binding.runId}\0${binding.leaseId}\0${binding.fencingToken}\0${commandId}`,
    )
    .digest("hex");
  return `run-mutation:${digest}`;
}

function runCapabilityBinding(
  assignment: WorkerRunAssignmentV1,
  leaseExpiresAtMs: number,
): RunCapabilityBinding {
  return Object.freeze({
    taskId: assignment.taskId,
    workOrderId: assignment.workOrder.workOrderId,
    runId: assignment.runId,
    deviceId: assignment.deviceId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
    leaseExpiresAtMs,
  });
}

function sameRunBinding(current: RunCapabilityBinding, initial: RunCapabilityBinding): boolean {
  return (
    current.taskId === initial.taskId &&
    current.workOrderId === initial.workOrderId &&
    current.runId === initial.runId &&
    current.deviceId === initial.deviceId &&
    current.leaseId === initial.leaseId &&
    current.fencingToken === initial.fencingToken &&
    current.leaseExpiresAtMs >= initial.leaseExpiresAtMs
  );
}

function authorityFromBinding(binding: RunCapabilityBinding): PlatformMutationRunAuthority {
  return Object.freeze({ ...binding });
}

function requireExactAuthority(
  context: PlatformMutationToolContext,
  authority: PlatformMutationRunAuthority,
): void {
  if (context.signal.aborted) {
    throw new PlatformMutationToolError("CANCELLED");
  }
  if (!isDeepStrictEqual(context.authority, authority)) {
    throw new PlatformMutationToolError("STALE_AUTHORITY");
  }
}

function validateProviderOptions(
  options: WorkerPlatformMutationRunCapabilityProviderOptions,
): void {
  if (
    options.broker === null ||
    typeof options.broker !== "object" ||
    typeof options.broker.register !== "function" ||
    (options.platform !== "windows" &&
      options.platform !== "macos" &&
      options.platform !== "linux") ||
    !Array.isArray(options.executableIds) ||
    options.executableIds.length === 0 ||
    options.executableIds.length > 64 ||
    new Set(options.executableIds).size !== options.executableIds.length ||
    !options.executableIds.every(
      (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value),
    ) ||
    typeof options.executorFactory !== "function" ||
    !validCommand(options.toolServerCommand) ||
    (options.toolServerArgsPrefix !== undefined &&
      (!Array.isArray(options.toolServerArgsPrefix) ||
        options.toolServerArgsPrefix.length > 32 ||
        !options.toolServerArgsPrefix.every(validCommand)))
  ) {
    throw new TypeError("The Worker platform mutation Run capability configuration is invalid.");
  }
}

function mapBrokerError(error: unknown): PlatformMutationToolError {
  if (error instanceof PlatformMutationToolError) {
    return error;
  }
  if (error instanceof RunCapabilityBrokerError) {
    if (error.code === "REQUEST_CANCELLED") {
      return new PlatformMutationToolError("CANCELLED", { cause: error });
    }
    if (
      error.code === "CAPABILITY_REVOKED" ||
      error.code === "CAPABILITY_EXPIRED" ||
      error.code === "CONNECTION_FAILED"
    ) {
      return new PlatformMutationToolError("STALE_AUTHORITY", { cause: error });
    }
  }
  return new PlatformMutationToolError("FAILED", { cause: error });
}

function toJsonValue(value: unknown): RunCapabilityJsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as RunCapabilityJsonValue;
  } catch (error) {
    throw new PlatformMutationToolError("INVALID_REQUEST", { cause: error });
  }
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformMutationToolError("INVALID_REQUEST");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new PlatformMutationToolError("INVALID_REQUEST");
  }
}

function boundedString(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new PlatformMutationToolError("INVALID_REQUEST");
  }
  return value;
}

function validCommand(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 4_096
  );
}

function staticRunLeaseAuthority(assignment: WorkerRunAssignmentV1): WorkerRunLeaseAuthority {
  return Object.freeze({
    snapshot: () =>
      Object.freeze({
        leaseExpiresAtMs: assignment.leaseExpiresAtMs,
        conservativeDeadlineMonotonicMs: assignment.leaseExpiresAtMs,
      }),
    isCurrent: () => true,
    renewIfDue: async () => undefined,
  });
}

async function safeCurrent(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}
