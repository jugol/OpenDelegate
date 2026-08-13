import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
import {
  type WorkerEgressBlockReason,
  type WorkerEgressGuard,
  type WorkerRunAssignmentV1,
  type WorkerRunCapabilityLease,
  type WorkerRunCapabilityProvider,
  type WorkerRunLeaseAuthority,
} from "@opendelegate/worker-runtime";

import { isPortableArtifactRelativePath } from "./artifact-path.ts";

export const WORKSPACE_FILE_INSPECT_TOOL_NAME = "workspace_file_inspect";
export const WORKSPACE_FILE_TOOL_NAMES = Object.freeze([WORKSPACE_FILE_INSPECT_TOOL_NAME]);

const WORKSPACE_FILE_CAPABILITY = "worker-workspace-file-inspector";
const WORKSPACE_FILE_METADATA_SCHEMA_VERSION = 1;
const MAXIMUM_FILE_BYTES = 1024 * 1024;
const MAXIMUM_INSPECTIONS = 64;

export type WorkspaceFileToolErrorCode =
  | "BUDGET_EXHAUSTED"
  | "CANCELLED"
  | "CHANGED"
  | "EGRESS_DENIED"
  | "FAILED"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "STALE_AUTHORITY";

export class WorkspaceFileToolError extends Error {
  public readonly code: WorkspaceFileToolErrorCode;
  public readonly egressReason: WorkerEgressBlockReason | undefined;

  public constructor(code: WorkspaceFileToolErrorCode, egressReason?: WorkerEgressBlockReason) {
    super(publicWorkspaceFileErrorMessage(code));
    this.name = "WorkspaceFileToolError";
    this.code = code;
    this.egressReason = egressReason;
  }
}

export interface WorkspaceFileRunAuthority {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly deviceId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs: number;
}

export interface WorkspaceFileToolContext {
  readonly authority: WorkspaceFileRunAuthority;
  readonly signal: AbortSignal;
}

export interface WorkspaceFileInspectInput {
  readonly relativePath: string;
}

export interface WorkspaceFileInspectResult {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly utf8Valid: boolean;
  readonly bom: "none" | "utf-8" | "utf-16le" | "utf-16be";
  readonly finalLf: boolean;
  readonly text: string | null;
}

export interface WorkspaceFileToolPort {
  inspect(
    context: WorkspaceFileToolContext,
    input: WorkspaceFileInspectInput,
  ): Promise<WorkspaceFileInspectResult>;
}

export interface WorkerWorkspaceFileRunCapabilityProviderOptions {
  readonly broker: LocalRunCapabilityBroker;
  readonly toolServerCommand: string;
  readonly toolServerArgsPrefix?: readonly string[];
}

/**
 * Gives a file-authoring Run a bounded read-only view of its already-resolved
 * Workspace. The Agent supplies only a portable relative path; the Workspace
 * root and current lease stay inside the Worker daemon.
 */
export class WorkerWorkspaceFileRunCapabilityProvider implements WorkerRunCapabilityProvider {
  readonly #options: WorkerWorkspaceFileRunCapabilityProviderOptions;

  public constructor(options: WorkerWorkspaceFileRunCapabilityProviderOptions) {
    validateProviderOptions(options);
    this.#options = options;
  }

  public async prepare(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspace: {
      readonly workspaceId: string;
      readonly cwd: string;
      readonly worktreePath?: string;
      readonly isolation:
        "none" | "agent-native-worktree" | "opendelegate-worktree" | "container" | "custom";
    };
    readonly egressGuard: WorkerEgressGuard;
    readonly maxConcurrentConnections?: number;
    readonly leaseAuthority: WorkerRunLeaseAuthority;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<WorkerRunCapabilityLease | undefined> {
    if (!context.assignment.workOrder.requiredCapabilities.includes("file-authoring")) {
      return undefined;
    }
    if (!(await safeCurrent(context.isExecutionCurrent))) {
      throw new WorkspaceFileToolError("STALE_AUTHORITY");
    }
    const workspaceRoot = await resolveWorkspaceRoot(context.workspace.cwd);
    const binding = runCapabilityBinding(context.assignment);
    const handler = await CurrentRunWorkspaceFileHandler.create({
      binding,
      workspaceRoot,
      egressGuard: context.egressGuard,
      isExecutionCurrent: context.isExecutionCurrent,
    });
    let brokerLease: RunCapabilityLease | undefined;
    try {
      brokerLease = await this.#options.broker.register({
        capability: WORKSPACE_FILE_CAPABILITY,
        maxConcurrentConnections: context.maxConcurrentConnections ?? 1,
        binding,
        metadata: capabilityMetadata(),
        expiresAtMs: context.assignment.leaseExpiresAtMs,
        currentBinding: () =>
          bindingWithLeaseExpiry(binding, context.leaseAuthority.snapshot().leaseExpiresAtMs),
        isExecutionCurrent: context.isExecutionCurrent,
        handler: (request, requestContext) =>
          handler.dispatch(request.method, request.payload, requestContext),
      });
      const lease = brokerLease;
      let disposed = false;
      return Object.freeze({
        toolServers: Object.freeze([
          Object.freeze({
            serverName: "opendelegate-workspace-file",
            command: this.#options.toolServerCommand,
            args: Object.freeze([
              ...(this.#options.toolServerArgsPrefix ?? []),
              "workspace-file-mcp-bridge",
              "--capability-file",
              lease.capabilityFile,
            ]),
            enabledTools: WORKSPACE_FILE_TOOL_NAMES,
            startupTimeoutMs: 15_000,
            toolTimeoutMs: 30_000,
          }),
        ]),
        async dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          await lease.dispose().catch(() => undefined);
          handler.close();
        },
      });
    } catch (error) {
      await brokerLease?.dispose().catch(() => undefined);
      handler.close();
      throw error;
    }
  }
}

export interface ConsumedWorkspaceFileRunCapability {
  readonly authority: WorkspaceFileRunAuthority;
  readonly limits: {
    readonly maximumFileBytes: number;
    readonly maximumInspections: number;
  };
  readonly port: WorkspaceFileToolPort;
  close(): Promise<void>;
}

export async function consumeWorkspaceFileRunCapabilityFile(
  filename: string,
): Promise<ConsumedWorkspaceFileRunCapability> {
  const client = await consumeRunCapabilityFile({
    filename,
    expectedCapability: WORKSPACE_FILE_CAPABILITY,
  });
  try {
    const limits = parseCapabilityMetadata(client.metadata);
    const authority = authorityFromBinding(client.binding);
    return Object.freeze({
      authority,
      limits,
      port: new BrokerWorkspaceFileToolPort(client, authority),
      close: () => client.close(),
    });
  } catch (error) {
    await client.close();
    throw error;
  }
}

interface WorkspaceRootIdentity {
  readonly path: string;
  readonly stats: BigIntStats;
}

class CurrentRunWorkspaceFileHandler {
  readonly #binding: RunCapabilityBinding;
  readonly #workspaceRoot: WorkspaceRootIdentity;
  readonly #egressGuard: WorkerEgressGuard;
  readonly #isExecutionCurrent: () => Promise<boolean>;
  #dispatchTail: Promise<void> = Promise.resolve();
  #inspectionCount = 0;
  #closed = false;

  private constructor(options: {
    readonly binding: RunCapabilityBinding;
    readonly workspaceRoot: WorkspaceRootIdentity;
    readonly egressGuard: WorkerEgressGuard;
    isExecutionCurrent(): Promise<boolean>;
  }) {
    this.#binding = options.binding;
    this.#workspaceRoot = options.workspaceRoot;
    this.#egressGuard = options.egressGuard;
    this.#isExecutionCurrent = options.isExecutionCurrent;
  }

  public static async create(options: {
    readonly binding: RunCapabilityBinding;
    readonly workspaceRoot: string;
    readonly egressGuard: WorkerEgressGuard;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<CurrentRunWorkspaceFileHandler> {
    const stats = await requireDirectory(options.workspaceRoot);
    return new CurrentRunWorkspaceFileHandler({
      ...options,
      workspaceRoot: { path: options.workspaceRoot, stats },
    });
  }

  public async dispatch(
    method: string,
    payload: RunCapabilityJsonValue,
    requestContext: RunCapabilityRequestContext,
  ): Promise<RunCapabilityJsonValue> {
    const prior = this.#dispatchTail;
    let release!: () => void;
    this.#dispatchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      await this.#assertCurrent(requestContext);
      if (method !== "inspect") {
        throw new WorkspaceFileToolError("INVALID_REQUEST");
      }
      if (this.#inspectionCount >= MAXIMUM_INSPECTIONS) {
        throw new WorkspaceFileToolError("BUDGET_EXHAUSTED");
      }
      const input = parseWorkspaceFileInspectInput(payload);
      this.#inspectionCount += 1;
      const value = await this.#inspect(input, requestContext);
      return { ok: true, value: toJsonValue(value) };
    } catch (error) {
      const publicError =
        error instanceof WorkspaceFileToolError ? error : new WorkspaceFileToolError("FAILED");
      return {
        ok: false,
        code: publicError.code,
        ...(publicError.egressReason === undefined
          ? {}
          : { egressReason: publicError.egressReason }),
      };
    } finally {
      release();
    }
  }

  public close(): void {
    this.#closed = true;
  }

  async #inspect(
    input: WorkspaceFileInspectInput,
    requestContext: RunCapabilityRequestContext,
  ): Promise<WorkspaceFileInspectResult> {
    const pathInspection = this.#egressGuard.inspectText(input.relativePath);
    if (!pathInspection.safe) {
      throw new WorkspaceFileToolError("EGRESS_DENIED", pathInspection.reason);
    }
    await requireSameDirectory(this.#workspaceRoot);
    const segments = input.relativePath.split("/");
    let current = this.#workspaceRoot.path;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      await requireDirectory(current);
    }
    const targetPath = join(this.#workspaceRoot.path, ...segments);
    await requireCanonicalContainedPath(this.#workspaceRoot.path, targetPath);
    const pathStats = await requireRegularFile(targetPath);
    let handle: FileHandle | undefined;
    try {
      handle = await open(targetPath, "r");
      const before = await handle.stat({ bigint: true });
      if (!sameFileIdentity(pathStats, before) || !before.isFile()) {
        throw new WorkspaceFileToolError("CHANGED");
      }
      if (before.size > BigInt(MAXIMUM_FILE_BYTES)) {
        throw new WorkspaceFileToolError("BUDGET_EXHAUSTED");
      }
      const bytes = await readExactFile(handle, Number(before.size));
      const after = await handle.stat({ bigint: true });
      if (!sameStableFile(before, after)) {
        throw new WorkspaceFileToolError("CHANGED");
      }
      await requireCanonicalContainedPath(this.#workspaceRoot.path, targetPath);
      const finalPathStats = await requireRegularFile(targetPath);
      if (!sameFileIdentity(after, finalPathStats)) {
        throw new WorkspaceFileToolError("CHANGED");
      }
      await requireSameDirectory(this.#workspaceRoot);
      await this.#assertCurrent(requestContext);
      this.#inspectEgress(bytes);
      const text = decodeUtf8(bytes);
      return Object.freeze({
        relativePath: input.relativePath,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        utf8Valid: text !== null,
        bom: detectBom(bytes),
        finalLf: bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0a,
        text,
      });
    } catch (error) {
      throw mapFileError(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  #inspectEgress(bytes: Buffer): void {
    const byteScanner = this.#egressGuard.createByteScanner();
    const pushed = byteScanner.push(bytes);
    const finished = byteScanner.finish();
    if (!pushed.safe || !finished.safe) {
      throw new WorkspaceFileToolError(
        "EGRESS_DENIED",
        !pushed.safe ? pushed.reason : !finished.safe ? finished.reason : undefined,
      );
    }
    const text = decodeUtf8(bytes);
    if (text === null) {
      return;
    }
    const textScanner = this.#egressGuard.createTextScanner();
    const textPushed = textScanner.push(text);
    const textFinished = textScanner.finish();
    if (!textPushed.safe || !textFinished.safe) {
      throw new WorkspaceFileToolError(
        "EGRESS_DENIED",
        !textPushed.safe ? textPushed.reason : !textFinished.safe ? textFinished.reason : undefined,
      );
    }
  }

  async #assertCurrent(context: RunCapabilityRequestContext): Promise<void> {
    if (
      this.#closed ||
      context.signal.aborted ||
      !hasSameRunIdentity(context.binding, this.#binding) ||
      context.binding.leaseExpiresAtMs < this.#binding.leaseExpiresAtMs ||
      !(await safeCurrent(this.#isExecutionCurrent))
    ) {
      throw new WorkspaceFileToolError(context.signal.aborted ? "CANCELLED" : "STALE_AUTHORITY");
    }
  }
}

class BrokerWorkspaceFileToolPort implements WorkspaceFileToolPort {
  readonly #client: RunCapabilityClient;
  readonly #authority: WorkspaceFileRunAuthority;

  public constructor(client: RunCapabilityClient, authority: WorkspaceFileRunAuthority) {
    this.#client = client;
    this.#authority = authority;
  }

  public async inspect(
    context: WorkspaceFileToolContext,
    input: WorkspaceFileInspectInput,
  ): Promise<WorkspaceFileInspectResult> {
    requireExactAuthority(context, this.#authority);
    try {
      return parseWorkspaceFileInspectResult(
        parseBrokerEnvelope(
          await this.#client.request({
            method: "inspect",
            payload: toJsonValue(input),
            signal: context.signal,
          }),
        ),
      );
    } catch (error) {
      throw mapBrokerError(error);
    }
  }
}

export function parseWorkspaceFileInspectInput(value: unknown): WorkspaceFileInspectInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["relativePath"]);
  if (!isPortableArtifactRelativePath(record["relativePath"])) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
  return Object.freeze({ relativePath: record["relativePath"] });
}

function parseWorkspaceFileInspectResult(
  value: RunCapabilityJsonValue,
): WorkspaceFileInspectResult {
  const record = requireRecord(value);
  requireExactKeys(record, [
    "relativePath",
    "sizeBytes",
    "sha256",
    "utf8Valid",
    "bom",
    "finalLf",
    "text",
  ]);
  const input = parseWorkspaceFileInspectInput({ relativePath: record["relativePath"] });
  if (
    !Number.isSafeInteger(record["sizeBytes"]) ||
    (record["sizeBytes"] as number) < 0 ||
    (record["sizeBytes"] as number) > MAXIMUM_FILE_BYTES ||
    typeof record["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record["sha256"]) ||
    typeof record["utf8Valid"] !== "boolean" ||
    (record["bom"] !== "none" &&
      record["bom"] !== "utf-8" &&
      record["bom"] !== "utf-16le" &&
      record["bom"] !== "utf-16be") ||
    typeof record["finalLf"] !== "boolean" ||
    (record["text"] !== null && typeof record["text"] !== "string") ||
    (record["utf8Valid"] === true) !== (typeof record["text"] === "string")
  ) {
    throw new WorkspaceFileToolError("FAILED");
  }
  return Object.freeze({
    relativePath: input.relativePath,
    sizeBytes: record["sizeBytes"] as number,
    sha256: record["sha256"],
    utf8Valid: record["utf8Valid"],
    bom: record["bom"],
    finalLf: record["finalLf"],
    text: record["text"],
  });
}

async function resolveWorkspaceRoot(value: string): Promise<string> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
  const original = await lstat(value, { bigint: true }).catch(() => undefined);
  if (original === undefined || original.isSymbolicLink() || !original.isDirectory()) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
  const path = await realpath(value).catch(() => undefined);
  if (path === undefined) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
  await requireDirectory(path);
  return path;
}

async function requireCanonicalContainedPath(root: string, target: string): Promise<void> {
  const relationship = relative(root, target);
  if (relationship === ".." || relationship.startsWith(`..${sep}`) || isAbsolute(relationship)) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
  const canonical = await realpath(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new WorkspaceFileToolError("NOT_FOUND");
    }
    throw error;
  });
  if (!samePath(canonical, target)) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
}

async function requireDirectory(path: string): Promise<BigIntStats> {
  const stats = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new WorkspaceFileToolError("NOT_FOUND");
    }
    throw error;
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
  return stats;
}

async function requireRegularFile(path: string): Promise<BigIntStats> {
  const stats = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new WorkspaceFileToolError("NOT_FOUND");
    }
    throw error;
  });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
  if (stats.size > BigInt(MAXIMUM_FILE_BYTES)) {
    throw new WorkspaceFileToolError("BUDGET_EXHAUSTED");
  }
  return stats;
}

async function requireSameDirectory(expected: WorkspaceRootIdentity): Promise<void> {
  const current = await requireDirectory(expected.path);
  if (!sameFileIdentity(current, expected.stats)) {
    throw new WorkspaceFileToolError("CHANGED");
  }
}

async function readExactFile(handle: FileHandle, expectedBytes: number): Promise<Buffer> {
  const bytes = Buffer.alloc(expectedBytes + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  if (offset !== expectedBytes) {
    throw new WorkspaceFileToolError("CHANGED");
  }
  return bytes.subarray(0, expectedBytes);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  // Node reports lstat().dev as zero for some Windows filesystems while the
  // same file handle carries the volume serial. The file index (ino) remains
  // stable across both observations and is the authoritative Windows identity.
  return (
    left.ino === right.ino &&
    left.mode === right.mode &&
    (process.platform === "win32" || left.dev === right.dev)
  );
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function detectBom(bytes: Buffer): WorkspaceFileInspectResult["bom"] {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  return "none";
}

function capabilityMetadata(): RunCapabilityJsonValue {
  return {
    schemaVersion: WORKSPACE_FILE_METADATA_SCHEMA_VERSION,
    limits: {
      maximumFileBytes: MAXIMUM_FILE_BYTES,
      maximumInspections: MAXIMUM_INSPECTIONS,
    },
  };
}

function parseCapabilityMetadata(value: RunCapabilityJsonValue): {
  readonly maximumFileBytes: number;
  readonly maximumInspections: number;
} {
  const record = requireRecord(value);
  requireExactKeys(record, ["schemaVersion", "limits"]);
  if (record["schemaVersion"] !== WORKSPACE_FILE_METADATA_SCHEMA_VERSION) {
    throw new WorkspaceFileToolError("FAILED");
  }
  const limits = requireRecord(record["limits"]);
  requireExactKeys(limits, ["maximumFileBytes", "maximumInspections"]);
  if (
    limits["maximumFileBytes"] !== MAXIMUM_FILE_BYTES ||
    limits["maximumInspections"] !== MAXIMUM_INSPECTIONS
  ) {
    throw new WorkspaceFileToolError("FAILED");
  }
  return Object.freeze({
    maximumFileBytes: MAXIMUM_FILE_BYTES,
    maximumInspections: MAXIMUM_INSPECTIONS,
  });
}

function runCapabilityBinding(assignment: WorkerRunAssignmentV1): RunCapabilityBinding {
  return Object.freeze({
    taskId: assignment.taskId,
    workOrderId: assignment.workOrder.workOrderId,
    runId: assignment.runId,
    deviceId: assignment.deviceId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
    leaseExpiresAtMs: assignment.leaseExpiresAtMs,
  });
}

function bindingWithLeaseExpiry(
  binding: RunCapabilityBinding,
  leaseExpiresAtMs: number,
): RunCapabilityBinding {
  return Object.freeze({ ...binding, leaseExpiresAtMs });
}

function hasSameRunIdentity(
  candidate: RunCapabilityBinding,
  expected: RunCapabilityBinding,
): boolean {
  return (
    candidate.taskId === expected.taskId &&
    candidate.workOrderId === expected.workOrderId &&
    candidate.runId === expected.runId &&
    candidate.deviceId === expected.deviceId &&
    candidate.leaseId === expected.leaseId &&
    candidate.fencingToken === expected.fencingToken
  );
}

function authorityFromBinding(binding: RunCapabilityBinding): WorkspaceFileRunAuthority {
  return Object.freeze({ ...binding });
}

function requireExactAuthority(
  context: WorkspaceFileToolContext,
  authority: WorkspaceFileRunAuthority,
): void {
  if (context.signal.aborted) {
    throw new WorkspaceFileToolError("CANCELLED");
  }
  if (!isDeepStrictEqual(context.authority, authority)) {
    throw new WorkspaceFileToolError("STALE_AUTHORITY");
  }
}

function parseBrokerEnvelope(value: RunCapabilityJsonValue): RunCapabilityJsonValue {
  const envelope = requireRecord(value);
  if (envelope["ok"] === true) {
    requireExactKeys(envelope, ["ok", "value"]);
    return envelope["value"] as RunCapabilityJsonValue;
  }
  if (envelope["ok"] === false) {
    requireExactKeys(envelope, ["ok", "code"], ["egressReason"]);
    const code = envelope["code"];
    const reason = envelope["egressReason"];
    if (!isWorkspaceFileToolErrorCode(code) || !isOptionalEgressReason(reason)) {
      throw new WorkspaceFileToolError("FAILED");
    }
    throw new WorkspaceFileToolError(code, reason);
  }
  throw new WorkspaceFileToolError("FAILED");
}

function mapBrokerError(error: unknown): WorkspaceFileToolError {
  if (error instanceof WorkspaceFileToolError) {
    return error;
  }
  if (error instanceof RunCapabilityBrokerError) {
    if (error.code === "REQUEST_CANCELLED") {
      return new WorkspaceFileToolError("CANCELLED");
    }
    if (
      error.code === "CAPABILITY_REVOKED" ||
      error.code === "CAPABILITY_EXPIRED" ||
      error.code === "CONNECTION_FAILED"
    ) {
      return new WorkspaceFileToolError("STALE_AUTHORITY");
    }
  }
  return new WorkspaceFileToolError("FAILED");
}

function mapFileError(error: unknown): WorkspaceFileToolError {
  if (error instanceof WorkspaceFileToolError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new WorkspaceFileToolError("NOT_FOUND");
  }
  return new WorkspaceFileToolError("FAILED");
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
}

function toJsonValue(value: unknown): RunCapabilityJsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as RunCapabilityJsonValue;
  } catch {
    throw new WorkspaceFileToolError("INVALID_REQUEST");
  }
}

function isWorkspaceFileToolErrorCode(value: unknown): value is WorkspaceFileToolErrorCode {
  return (
    value === "BUDGET_EXHAUSTED" ||
    value === "CANCELLED" ||
    value === "CHANGED" ||
    value === "EGRESS_DENIED" ||
    value === "FAILED" ||
    value === "INVALID_REQUEST" ||
    value === "NOT_FOUND" ||
    value === "STALE_AUTHORITY"
  );
}

function isOptionalEgressReason(value: unknown): value is WorkerEgressBlockReason | undefined {
  return (
    value === undefined ||
    value === "device-local-knowledge" ||
    value === "device-local-secret" ||
    value === "unscannable-artifact" ||
    value === "unverifiable-knowledge-history" ||
    value === "unverifiable-secret-history"
  );
}

function validateProviderOptions(options: WorkerWorkspaceFileRunCapabilityProviderOptions): void {
  if (
    options.broker === null ||
    typeof options.broker !== "object" ||
    typeof options.broker.register !== "function" ||
    typeof options.toolServerCommand !== "string" ||
    !isAbsolute(options.toolServerCommand) ||
    options.toolServerCommand.includes("\0") ||
    (options.toolServerArgsPrefix !== undefined &&
      (!Array.isArray(options.toolServerArgsPrefix) ||
        options.toolServerArgsPrefix.length > 32 ||
        options.toolServerArgsPrefix.some(
          (value) =>
            typeof value !== "string" ||
            value.length === 0 ||
            value.length > 8_192 ||
            value.includes("\0"),
        )))
  ) {
    throw new TypeError("The Worker Workspace file Run capability configuration is invalid.");
  }
}

async function safeCurrent(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}

function publicWorkspaceFileErrorMessage(code: WorkspaceFileToolErrorCode): string {
  switch (code) {
    case "BUDGET_EXHAUSTED":
      return "The Workspace file inspection budget is exhausted.";
    case "CANCELLED":
      return "The Workspace file inspection was cancelled.";
    case "CHANGED":
      return "The Workspace file changed during inspection.";
    case "EGRESS_DENIED":
      return "The Workspace file was denied by the Worker egress guard.";
    case "INVALID_REQUEST":
      return "The Workspace file inspection request is invalid.";
    case "NOT_FOUND":
      return "The Workspace file does not exist.";
    case "STALE_AUTHORITY":
      return "The Workspace file Run authority is no longer current.";
    case "FAILED":
      return "The Workspace file inspection failed.";
  }
}
