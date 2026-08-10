import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  isScannableTextMediaType,
  workerArtifactAssignmentFingerprint,
  type WorkerArtifactOutputPlan,
  type WorkerEgressBlockReason,
  type WorkerEgressByteScanner,
  type WorkerEgressGuard,
  type WorkerEgressTextScanner,
  type WorkerRunAssignmentV1,
  type WorkerRunCapabilityLease,
  type WorkerRunCapabilityProvider,
  type WorkerRunLeaseAuthority,
} from "@opendelegate/worker-runtime";

import {
  isPortableArtifactFilename,
  isPortableArtifactRelativePath,
  portableArtifactPathKey,
} from "./artifact-path.ts";

export const ARTIFACT_WRITE_CHUNK_TOOL_NAME = "artifact_write_chunk";
export const ARTIFACT_COMMIT_TOOL_NAME = "artifact_commit";
export const ARTIFACT_TOOL_NAMES = Object.freeze([
  ARTIFACT_WRITE_CHUNK_TOOL_NAME,
  ARTIFACT_COMMIT_TOOL_NAME,
]);

const ARTIFACT_CAPABILITY = "worker-artifact-writer";
const ARTIFACT_METADATA_SCHEMA_VERSION = 1;
const MANIFEST_FILENAME = "manifest.v1.json";
const MAXIMUM_ARTIFACTS = 64;
const MAXIMUM_CHUNKS = 4_096;
// The local capability protocol bounds any single JSON string to 256 KiB.
// Canonical base64 expands three bytes to four, so 192 KiB is the largest
// portable raw chunk that can actually traverse the broker.
const MAXIMUM_CHUNK_BYTES = 192 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES = 1024 * 1024 * 1024;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ArtifactToolErrorCode =
  | "BUDGET_EXHAUSTED"
  | "CANCELLED"
  | "CONFLICT"
  | "EGRESS_DENIED"
  | "FAILED"
  | "INVALID_REQUEST"
  | "STALE_AUTHORITY";

export class ArtifactToolError extends Error {
  public readonly code: ArtifactToolErrorCode;
  public readonly egressReason: WorkerEgressBlockReason | undefined;

  public constructor(code: ArtifactToolErrorCode, egressReason?: WorkerEgressBlockReason) {
    super(publicArtifactErrorMessage(code));
    this.name = "ArtifactToolError";
    this.code = code;
    this.egressReason = egressReason;
  }
}

export interface ArtifactRunAuthority {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly deviceId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs: number;
}

export interface ArtifactToolContext {
  readonly authority: ArtifactRunAuthority;
  readonly signal: AbortSignal;
}

export interface ArtifactWriteChunkInput {
  readonly commandId: string;
  readonly relativePath: string;
  readonly offsetBytes: number;
  readonly contentBase64: string;
}

export interface ArtifactWriteChunkResult {
  readonly relativePath: string;
  readonly nextOffsetBytes: number;
  readonly replayed: boolean;
}

export interface ArtifactCommitDeclaration {
  readonly relativePath: string;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly requestedPresentation?: "download" | "inline" | "interactive-html" | "static-html";
}

export interface ArtifactCommitInput {
  readonly commandId: string;
  readonly artifacts: readonly ArtifactCommitDeclaration[];
}

export interface ArtifactCommitResult {
  readonly artifactCount: number;
  readonly manifestCommitted: true;
  readonly replayed: boolean;
}

export interface ArtifactToolPort {
  writeChunk(
    context: ArtifactToolContext,
    input: ArtifactWriteChunkInput,
  ): Promise<ArtifactWriteChunkResult>;
  commit(context: ArtifactToolContext, input: ArtifactCommitInput): Promise<ArtifactCommitResult>;
}

export interface WorkerArtifactRunCapabilityProviderOptions {
  readonly broker: LocalRunCapabilityBroker;
  readonly toolServerCommand: string;
  readonly toolServerArgsPrefix?: readonly string[];
}

/**
 * Gives one exact Worker Run an append-only Artifact writer. The native provider
 * receives only an opaque one-use capability path; output paths, Secret values,
 * Main credentials, and upload authority remain in the Worker daemon.
 */
export class WorkerArtifactRunCapabilityProvider implements WorkerRunCapabilityProvider {
  readonly #options: WorkerArtifactRunCapabilityProviderOptions;

  public constructor(options: WorkerArtifactRunCapabilityProviderOptions) {
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
    readonly artifact?: {
      readonly plan: WorkerArtifactOutputPlan;
      readonly egressGuard: WorkerEgressGuard;
    };
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<WorkerRunCapabilityLease | undefined> {
    if (context.artifact === undefined) {
      return undefined;
    }
    if (
      context.artifact.egressGuard !== context.egressGuard ||
      !(await safeCurrent(context.isExecutionCurrent))
    ) {
      throw new ArtifactToolError("STALE_AUTHORITY");
    }
    const plan = await validatePlan(
      context.artifact.plan,
      context.assignment,
      context.workspace.workspaceId,
    );
    const binding = runCapabilityBinding(context.assignment);
    const handler = await CurrentRunArtifactHandler.create({
      binding,
      plan,
      egressGuard: context.egressGuard,
      isExecutionCurrent: context.isExecutionCurrent,
    });
    let brokerLease: RunCapabilityLease | undefined;
    try {
      brokerLease = await this.#options.broker.register({
        capability: ARTIFACT_CAPABILITY,
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
            serverName: "opendelegate-artifact",
            command: this.#options.toolServerCommand,
            args: Object.freeze([
              ...(this.#options.toolServerArgsPrefix ?? []),
              "artifact-mcp-bridge",
              "--capability-file",
              lease.capabilityFile,
            ]),
            enabledTools: ARTIFACT_TOOL_NAMES,
            startupTimeoutMs: 15_000,
            toolTimeoutMs: 30_000,
          }),
        ]),
        async dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          try {
            await lease.dispose().catch(() => undefined);
          } finally {
            await handler.close();
          }
        },
      });
    } catch (error) {
      await brokerLease?.dispose().catch(() => undefined);
      await handler.close();
      throw error;
    }
  }
}

export interface ConsumedArtifactRunCapability {
  readonly authority: ArtifactRunAuthority;
  readonly port: ArtifactToolPort;
  close(): Promise<void>;
}

export async function consumeArtifactRunCapabilityFile(
  filename: string,
): Promise<ConsumedArtifactRunCapability> {
  const client = await consumeRunCapabilityFile({
    filename,
    expectedCapability: ARTIFACT_CAPABILITY,
  });
  try {
    parseCapabilityMetadata(client.metadata);
    const authority = authorityFromBinding(client.binding);
    return Object.freeze({
      authority,
      port: new BrokerArtifactToolPort(client, authority),
      close: () => client.close(),
    });
  } catch (error) {
    await client.close();
    throw error;
  }
}

interface ArtifactFileState {
  readonly relativePath: string;
  readonly temporaryPath: string;
  readonly byteScanner: WorkerEgressByteScanner;
  readonly textScanner: WorkerEgressTextScanner;
  readonly decoder: TextDecoder;
  created: boolean;
  sizeBytes: number;
  textDecodingFailed: boolean;
}

interface CommandLedgerEntry {
  readonly fingerprint: string;
  readonly result: ArtifactWriteChunkResult | ArtifactCommitResult;
}

class CurrentRunArtifactHandler {
  readonly #binding: RunCapabilityBinding;
  readonly #plan: WorkerArtifactOutputPlan;
  readonly #egressGuard: WorkerEgressGuard;
  readonly #isExecutionCurrent: () => Promise<boolean>;
  readonly #temporaryRoot: string;
  readonly #files = new Map<string, ArtifactFileState>();
  readonly #commands = new Map<string, CommandLedgerEntry>();
  readonly #promotedPaths = new Set<string>();
  #dispatchTail: Promise<void> = Promise.resolve();
  #chunkCount = 0;
  #totalBytes = 0;
  #committed = false;
  #manifestPromoted = false;
  #closed = false;
  #blockedCode: ArtifactToolErrorCode | undefined;
  #blockedReason: WorkerEgressBlockReason | undefined;

  private constructor(options: {
    readonly binding: RunCapabilityBinding;
    readonly plan: WorkerArtifactOutputPlan;
    readonly egressGuard: WorkerEgressGuard;
    readonly temporaryRoot: string;
    isExecutionCurrent(): Promise<boolean>;
  }) {
    this.#binding = options.binding;
    this.#plan = options.plan;
    this.#egressGuard = options.egressGuard;
    this.#temporaryRoot = options.temporaryRoot;
    this.#isExecutionCurrent = options.isExecutionCurrent;
  }

  public static async create(options: {
    readonly binding: RunCapabilityBinding;
    readonly plan: WorkerArtifactOutputPlan;
    readonly egressGuard: WorkerEgressGuard;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<CurrentRunArtifactHandler> {
    const temporaryRoot = await mkdtemp(join(options.plan.outputRoot, ".artifact-writer-"));
    return new CurrentRunArtifactHandler({ ...options, temporaryRoot });
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
      let value: RunCapabilityJsonValue;
      if (method === "writeChunk") {
        const input = parseArtifactWriteChunkInput(payload);
        value = toJsonValue(await this.#writeChunk(input, requestContext));
      } else if (method === "commit") {
        const input = parseArtifactCommitInput(payload);
        value = toJsonValue(await this.#commit(input, requestContext));
      } else {
        throw new ArtifactToolError("INVALID_REQUEST");
      }
      return { ok: true, value };
    } catch (error) {
      const publicError =
        error instanceof ArtifactToolError ? error : new ArtifactToolError("FAILED");
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

  public async close(): Promise<void> {
    const prior = this.#dispatchTail;
    let release!: () => void;
    this.#dispatchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      if (!this.#committed) {
        await this.#cleanupPromotedPaths();
      }
      await rm(this.#temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      release();
    }
  }

  async #writeChunk(
    input: ArtifactWriteChunkInput,
    requestContext: RunCapabilityRequestContext,
  ): Promise<ArtifactWriteChunkResult> {
    const fingerprint = requestFingerprint("writeChunk", input);
    const replay = this.#replay<ArtifactWriteChunkResult>(input.commandId, fingerprint);
    if (replay !== undefined) {
      return replay;
    }
    this.#requireWritable();
    if (this.#chunkCount >= MAXIMUM_CHUNKS) {
      throw new ArtifactToolError("BUDGET_EXHAUSTED");
    }
    const bytes = decodeChunk(input.contentBase64);
    let state = this.#files.get(input.relativePath);
    if (state === undefined) {
      if (this.#files.size >= MAXIMUM_ARTIFACTS || input.offsetBytes !== 0) {
        throw new ArtifactToolError("BUDGET_EXHAUSTED");
      }
      state = {
        relativePath: input.relativePath,
        temporaryPath: join(
          this.#temporaryRoot,
          `${createHash("sha256").update(input.relativePath, "utf8").digest("hex")}.part`,
        ),
        byteScanner: this.#egressGuard.createByteScanner(),
        textScanner: this.#egressGuard.createTextScanner(),
        decoder: new TextDecoder("utf-8", { fatal: true }),
        created: false,
        sizeBytes: 0,
        textDecodingFailed: false,
      };
      this.#files.set(input.relativePath, state);
    }
    if (
      state.sizeBytes !== input.offsetBytes ||
      state.sizeBytes + bytes.byteLength > MAXIMUM_ARTIFACT_BYTES ||
      this.#totalBytes + bytes.byteLength > MAXIMUM_TOTAL_BYTES
    ) {
      throw new ArtifactToolError("CONFLICT");
    }
    await this.#scanChunk(state, bytes);
    try {
      await writeExactChunk(state, bytes);
    } catch {
      await this.#block("FAILED");
      throw new ArtifactToolError("FAILED");
    }
    state.sizeBytes += bytes.byteLength;
    this.#totalBytes += bytes.byteLength;
    this.#chunkCount += 1;
    await this.#assertCurrent(requestContext);
    const result = Object.freeze({
      relativePath: state.relativePath,
      nextOffsetBytes: state.sizeBytes,
      replayed: false,
    });
    this.#commands.set(input.commandId, { fingerprint, result });
    return result;
  }

  async #commit(
    input: ArtifactCommitInput,
    requestContext: RunCapabilityRequestContext,
  ): Promise<ArtifactCommitResult> {
    const fingerprint = requestFingerprint("commit", input);
    const replay = this.#replay<ArtifactCommitResult>(input.commandId, fingerprint);
    if (replay !== undefined) {
      return replay;
    }
    this.#requireWritable();
    if (
      input.artifacts.length !== this.#files.size ||
      input.artifacts.some(({ relativePath }) => !this.#files.has(relativePath))
    ) {
      throw new ArtifactToolError("CONFLICT");
    }
    try {
      for (const declaration of input.artifacts) {
        this.#inspectMetadata(declaration);
        await this.#finishScanning(this.#files.get(declaration.relativePath)!, declaration);
      }
    } catch (error) {
      if (error instanceof ArtifactToolError && error.code === "EGRESS_DENIED") {
        await this.#block(error.code, error.egressReason);
      }
      throw error;
    }
    await this.#assertCurrent(requestContext);
    try {
      for (const declaration of input.artifacts) {
        const state = this.#files.get(declaration.relativePath)!;
        const destination = join(this.#plan.outputRoot, ...declaration.relativePath.split("/"));
        await createSafeParents(this.#plan.outputRoot, dirname(destination));
        await requireMissingPath(destination);
        await rename(state.temporaryPath, destination);
        this.#promotedPaths.add(destination);
      }
      const temporaryManifest = join(this.#temporaryRoot, "manifest.json");
      await writeFile(
        temporaryManifest,
        `${JSON.stringify({
          schemaVersion: 1,
          assignmentFingerprint: this.#plan.assignmentFingerprint,
          artifacts: input.artifacts,
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await this.#assertCurrent(requestContext);
      await requireMissingPath(this.#plan.manifestPath);
      await rename(temporaryManifest, this.#plan.manifestPath);
      this.#manifestPromoted = true;
      this.#committed = true;
      await rm(this.#temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      await this.#block(
        error instanceof ArtifactToolError ? error.code : "FAILED",
        error instanceof ArtifactToolError ? error.egressReason : undefined,
      );
      throw error instanceof ArtifactToolError ? error : new ArtifactToolError("FAILED");
    }
    const result = Object.freeze({
      artifactCount: input.artifacts.length,
      manifestCommitted: true as const,
      replayed: false,
    });
    this.#commands.set(input.commandId, { fingerprint, result });
    return result;
  }

  async #scanChunk(state: ArtifactFileState, bytes: Buffer): Promise<void> {
    const byteInspection = state.byteScanner.push(bytes);
    if (!byteInspection.safe) {
      await this.#block("EGRESS_DENIED", byteInspection.reason);
      throw new ArtifactToolError("EGRESS_DENIED", byteInspection.reason);
    }
    if (state.textDecodingFailed) {
      return;
    }
    try {
      const text = state.decoder.decode(bytes, { stream: true });
      if (text.length > 0) {
        const textInspection = state.textScanner.push(text);
        if (!textInspection.safe) {
          await this.#block("EGRESS_DENIED", textInspection.reason);
          throw new ArtifactToolError("EGRESS_DENIED", textInspection.reason);
        }
      }
    } catch (error) {
      if (error instanceof ArtifactToolError) {
        throw error;
      }
      state.textDecodingFailed = true;
    }
  }

  async #finishScanning(
    state: ArtifactFileState,
    declaration: ArtifactCommitDeclaration,
  ): Promise<void> {
    const byteInspection = state.byteScanner.finish();
    if (!byteInspection.safe) {
      throw new ArtifactToolError("EGRESS_DENIED", byteInspection.reason);
    }
    const snapshot = this.#egressGuard.snapshot();
    const knowledgeProtected =
      snapshot.mode === "opaque" ||
      snapshot.exactFingerprints.some(({ category }) => category === "device-local-knowledge") ||
      snapshot.fragmentFingerprints.some(({ category }) => category === "device-local-knowledge");
    if (!knowledgeProtected) {
      return;
    }
    if (state.textDecodingFailed || !isScannableTextMediaType(declaration.mediaType)) {
      throw new ArtifactToolError("EGRESS_DENIED", "unscannable-artifact");
    }
    try {
      const finalText = state.decoder.decode();
      if (finalText.length > 0) {
        const finalInspection = state.textScanner.push(finalText);
        if (!finalInspection.safe) {
          throw new ArtifactToolError("EGRESS_DENIED", finalInspection.reason);
        }
      }
    } catch (error) {
      if (error instanceof ArtifactToolError) {
        throw error;
      }
      throw new ArtifactToolError("EGRESS_DENIED", "unscannable-artifact");
    }
    const textInspection = state.textScanner.finish();
    if (!textInspection.safe) {
      throw new ArtifactToolError("EGRESS_DENIED", textInspection.reason);
    }
  }

  #inspectMetadata(declaration: ArtifactCommitDeclaration): void {
    for (const value of [
      declaration.relativePath,
      declaration.originalFilename,
      declaration.mediaType,
    ]) {
      const inspection = this.#egressGuard.inspectText(value);
      if (!inspection.safe) {
        throw new ArtifactToolError("EGRESS_DENIED", inspection.reason);
      }
    }
  }

  #replay<Result extends ArtifactWriteChunkResult | ArtifactCommitResult>(
    commandId: string,
    fingerprint: string,
  ): Result | undefined {
    const prior = this.#commands.get(commandId);
    if (prior === undefined) {
      return undefined;
    }
    if (prior.fingerprint !== fingerprint) {
      throw new ArtifactToolError("CONFLICT");
    }
    return Object.freeze({ ...prior.result, replayed: true }) as Result;
  }

  #requireWritable(): void {
    if (this.#blockedCode !== undefined) {
      throw new ArtifactToolError(this.#blockedCode, this.#blockedReason);
    }
    if (this.#closed || this.#committed) {
      throw new ArtifactToolError("CONFLICT");
    }
  }

  async #assertCurrent(context: RunCapabilityRequestContext): Promise<void> {
    if (this.#blockedCode !== undefined) {
      throw new ArtifactToolError(this.#blockedCode, this.#blockedReason);
    }
    if (
      this.#closed ||
      context.signal.aborted ||
      !hasSameRunIdentity(context.binding, this.#binding) ||
      context.binding.leaseExpiresAtMs < this.#binding.leaseExpiresAtMs ||
      !(await safeCurrent(this.#isExecutionCurrent))
    ) {
      await this.#block(context.signal.aborted ? "CANCELLED" : "STALE_AUTHORITY");
      throw new ArtifactToolError(context.signal.aborted ? "CANCELLED" : "STALE_AUTHORITY");
    }
  }

  async #block(code: ArtifactToolErrorCode, reason?: WorkerEgressBlockReason): Promise<void> {
    this.#blockedCode ??= code;
    this.#blockedReason ??= reason;
    await this.#cleanupPromotedPaths();
    await rm(this.#temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  async #cleanupPromotedPaths(): Promise<void> {
    await Promise.all(
      [...this.#promotedPaths].map((path) => rm(path, { force: true }).catch(() => undefined)),
    );
    this.#promotedPaths.clear();
    if (this.#manifestPromoted) {
      await rm(this.#plan.manifestPath, { force: true }).catch(() => undefined);
      this.#manifestPromoted = false;
    }
  }
}

class BrokerArtifactToolPort implements ArtifactToolPort {
  readonly #client: RunCapabilityClient;
  readonly #authority: ArtifactRunAuthority;

  public constructor(client: RunCapabilityClient, authority: ArtifactRunAuthority) {
    this.#client = client;
    this.#authority = authority;
  }

  public async writeChunk(
    context: ArtifactToolContext,
    input: ArtifactWriteChunkInput,
  ): Promise<ArtifactWriteChunkResult> {
    requireExactAuthority(context, this.#authority);
    return parseWriteChunkResult(await this.#request(context, "writeChunk", toJsonValue(input)));
  }

  public async commit(
    context: ArtifactToolContext,
    input: ArtifactCommitInput,
  ): Promise<ArtifactCommitResult> {
    requireExactAuthority(context, this.#authority);
    return parseCommitResult(await this.#request(context, "commit", toJsonValue(input)));
  }

  async #request(
    context: ArtifactToolContext,
    method: string,
    payload: RunCapabilityJsonValue,
  ): Promise<RunCapabilityJsonValue> {
    try {
      return parseBrokerEnvelope(
        await this.#client.request({ method, payload, signal: context.signal }),
      );
    } catch (error) {
      throw mapBrokerError(error);
    }
  }
}

async function writeExactChunk(state: ArtifactFileState, bytes: Buffer): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(state.temporaryPath, state.created ? "r+" : "wx+", 0o600);
    state.created = true;
    const info = await handle.stat();
    if (!info.isFile() || info.size !== state.sizeBytes) {
      throw new ArtifactToolError("CONFLICT");
    }
    if (bytes.byteLength > 0) {
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          state.sizeBytes + written,
        );
        if (result.bytesWritten <= 0) {
          throw new ArtifactToolError("FAILED");
        }
        written += result.bytesWritten;
      }
      await handle.sync();
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validatePlan(
  plan: WorkerArtifactOutputPlan,
  assignment: WorkerRunAssignmentV1,
  workspaceId: string,
): Promise<WorkerArtifactOutputPlan> {
  if (
    plan === null ||
    typeof plan !== "object" ||
    plan.schemaVersion !== 1 ||
    plan.assignmentFingerprint !== workerArtifactAssignmentFingerprint(assignment, workspaceId) ||
    !SHA256.test(plan.assignmentFingerprint) ||
    !isNormalizedAbsolutePath(plan.outputRoot) ||
    !isNormalizedAbsolutePath(plan.manifestPath) ||
    plan.manifestPath !== join(plan.outputRoot, MANIFEST_FILENAME)
  ) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  const info = await lstat(plan.outputRoot).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return Object.freeze({ ...plan });
}

async function createSafeParents(outputRoot: string, target: string): Promise<void> {
  const relationship = relative(outputRoot, target);
  if (relationship === ".." || relationship.startsWith(`..${sep}`) || isAbsolute(relationship)) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  let current = outputRoot;
  for (const segment of relationship === "" ? [] : relationship.split(sep)) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ArtifactToolError("CONFLICT");
    }
  }
}

async function requireMissingPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new ArtifactToolError("CONFLICT");
}

export function parseArtifactWriteChunkInput(value: unknown): ArtifactWriteChunkInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["commandId", "relativePath", "offsetBytes", "contentBase64"]);
  return Object.freeze({
    commandId: requireCommandId(record["commandId"]),
    relativePath: requireRelativePath(record["relativePath"]),
    offsetBytes: requireInteger(record["offsetBytes"], 0, MAXIMUM_ARTIFACT_BYTES),
    contentBase64: requireBase64(record["contentBase64"]),
  });
}

export function parseArtifactCommitInput(value: unknown): ArtifactCommitInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["commandId", "artifacts"]);
  if (
    !Array.isArray(record["artifacts"]) ||
    record["artifacts"].length < 1 ||
    record["artifacts"].length > MAXIMUM_ARTIFACTS
  ) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  const artifacts = record["artifacts"].map(parseDeclaration);
  if (
    new Set(artifacts.map(({ relativePath }) => portableArtifactPathKey(relativePath))).size !==
    artifacts.length
  ) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return Object.freeze({
    commandId: requireCommandId(record["commandId"]),
    artifacts: Object.freeze(artifacts),
  });
}

function parseDeclaration(value: unknown): ArtifactCommitDeclaration {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    ["relativePath", "mediaType", "originalFilename"],
    ["requestedPresentation"],
  );
  const mediaType = requireMediaType(record["mediaType"]);
  const requestedPresentation = requirePresentation(record["requestedPresentation"], mediaType);
  return Object.freeze({
    relativePath: requireRelativePath(record["relativePath"]),
    mediaType,
    originalFilename: requireFilename(record["originalFilename"]),
    ...(requestedPresentation === undefined ? {} : { requestedPresentation }),
  });
}

function parseWriteChunkResult(value: RunCapabilityJsonValue): ArtifactWriteChunkResult {
  const record = requireRecord(value);
  requireExactKeys(record, ["relativePath", "nextOffsetBytes", "replayed"]);
  return Object.freeze({
    relativePath: requireRelativePath(record["relativePath"]),
    nextOffsetBytes: requireInteger(record["nextOffsetBytes"], 0, MAXIMUM_ARTIFACT_BYTES),
    replayed: requireBoolean(record["replayed"]),
  });
}

function parseCommitResult(value: RunCapabilityJsonValue): ArtifactCommitResult {
  const record = requireRecord(value);
  requireExactKeys(record, ["artifactCount", "manifestCommitted", "replayed"]);
  if (record["manifestCommitted"] !== true) {
    throw new ArtifactToolError("FAILED");
  }
  return Object.freeze({
    artifactCount: requireInteger(record["artifactCount"], 1, MAXIMUM_ARTIFACTS),
    manifestCommitted: true,
    replayed: requireBoolean(record["replayed"]),
  });
}

function capabilityMetadata(): RunCapabilityJsonValue {
  return {
    schemaVersion: ARTIFACT_METADATA_SCHEMA_VERSION,
    limits: {
      maximumArtifacts: MAXIMUM_ARTIFACTS,
      maximumChunks: MAXIMUM_CHUNKS,
      maximumChunkBytes: MAXIMUM_CHUNK_BYTES,
      maximumArtifactBytes: MAXIMUM_ARTIFACT_BYTES,
      maximumTotalBytes: MAXIMUM_TOTAL_BYTES,
    },
  };
}

function parseCapabilityMetadata(value: RunCapabilityJsonValue): void {
  const record = requireRecord(value);
  requireExactKeys(record, ["schemaVersion", "limits"]);
  if (record["schemaVersion"] !== ARTIFACT_METADATA_SCHEMA_VERSION) {
    throw new ArtifactToolError("FAILED");
  }
  const limits = requireRecord(record["limits"]);
  requireExactKeys(limits, [
    "maximumArtifacts",
    "maximumChunks",
    "maximumChunkBytes",
    "maximumArtifactBytes",
    "maximumTotalBytes",
  ]);
  const expected = capabilityMetadata() as Readonly<Record<string, unknown>>;
  if (!isDeepStrictEqual(limits, expected["limits"])) {
    throw new ArtifactToolError("FAILED");
  }
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

function authorityFromBinding(binding: RunCapabilityBinding): ArtifactRunAuthority {
  return Object.freeze({ ...binding });
}

function requireExactAuthority(
  context: ArtifactToolContext,
  authority: ArtifactRunAuthority,
): void {
  if (context.signal.aborted) {
    throw new ArtifactToolError("CANCELLED");
  }
  if (!isDeepStrictEqual(context.authority, authority)) {
    throw new ArtifactToolError("STALE_AUTHORITY");
  }
}

function decodeChunk(value: string): Buffer {
  if (value.length > Math.ceil(MAXIMUM_CHUNK_BYTES / 3) * 4) {
    throw new ArtifactToolError("BUDGET_EXHAUSTED");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > MAXIMUM_CHUNK_BYTES || bytes.toString("base64") !== value) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return bytes;
}

function requireBase64(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAXIMUM_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > MAXIMUM_CHUNK_BYTES || decoded.toString("base64") !== value) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return value;
}

function requireRelativePath(value: unknown): string {
  if (
    !isPortableArtifactRelativePath(value) ||
    value === MANIFEST_FILENAME ||
    portableArtifactPathKey(value) === portableArtifactPathKey(MANIFEST_FILENAME) ||
    portableArtifactPathKey(value.split("/")[0] ?? "").startsWith(".artifact-writer-")
  ) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return value;
}

function requireFilename(value: unknown): string {
  if (!isPortableArtifactFilename(value)) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return value;
}

function requireMediaType(value: unknown): string {
  if (typeof value !== "string" || !MEDIA_TYPE.test(value)) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return value;
}

function requirePresentation(
  value: unknown,
  mediaType: string,
): ArtifactCommitDeclaration["requestedPresentation"] {
  if (value === undefined) {
    return undefined;
  }
  if (
    value !== "download" &&
    value !== "inline" &&
    value !== "interactive-html" &&
    value !== "static-html"
  ) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  if (
    ((value === "interactive-html" || value === "static-html") && mediaType !== "text/html") ||
    (mediaType === "image/svg+xml" && value !== "download")
  ) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return value;
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactToolError("INVALID_REQUEST");
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
    throw new ArtifactToolError("INVALID_REQUEST");
  }
}

function requireCommandId(value: unknown): string {
  if (typeof value !== "string" || !COMMAND_ID.test(value)) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return value;
}

function requireInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
  return value as number;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new ArtifactToolError("FAILED");
  }
  return value;
}

function requestFingerprint(method: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([method, input]), "utf8")
    .digest("hex");
}

function isNormalizedAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32_768 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

function validateProviderOptions(options: WorkerArtifactRunCapabilityProviderOptions): void {
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
    throw new TypeError("The Worker Artifact Run capability configuration is invalid.");
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
    if (!isArtifactToolErrorCode(code)) {
      throw new ArtifactToolError("FAILED");
    }
    const reason = envelope["egressReason"];
    if (reason !== undefined && !isWorkerEgressBlockReason(reason)) {
      throw new ArtifactToolError("FAILED");
    }
    throw new ArtifactToolError(code, reason);
  }
  throw new ArtifactToolError("FAILED");
}

function mapBrokerError(error: unknown): ArtifactToolError {
  if (error instanceof ArtifactToolError) {
    return error;
  }
  if (error instanceof RunCapabilityBrokerError) {
    if (error.code === "REQUEST_CANCELLED") {
      return new ArtifactToolError("CANCELLED");
    }
    if (
      error.code === "CAPABILITY_REVOKED" ||
      error.code === "CAPABILITY_EXPIRED" ||
      error.code === "CONNECTION_FAILED"
    ) {
      return new ArtifactToolError("STALE_AUTHORITY");
    }
  }
  return new ArtifactToolError("FAILED");
}

function isArtifactToolErrorCode(value: unknown): value is ArtifactToolErrorCode {
  return (
    value === "BUDGET_EXHAUSTED" ||
    value === "CANCELLED" ||
    value === "CONFLICT" ||
    value === "EGRESS_DENIED" ||
    value === "FAILED" ||
    value === "INVALID_REQUEST" ||
    value === "STALE_AUTHORITY"
  );
}

function isWorkerEgressBlockReason(value: unknown): value is WorkerEgressBlockReason {
  return (
    value === "device-local-knowledge" ||
    value === "device-local-secret" ||
    value === "unscannable-artifact" ||
    value === "unverifiable-knowledge-history" ||
    value === "unverifiable-secret-history"
  );
}

function toJsonValue(value: unknown): RunCapabilityJsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as RunCapabilityJsonValue;
  } catch {
    throw new ArtifactToolError("INVALID_REQUEST");
  }
}

async function safeCurrent(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}

function publicArtifactErrorMessage(code: ArtifactToolErrorCode): string {
  switch (code) {
    case "BUDGET_EXHAUSTED":
      return "The Artifact Run budget is exhausted.";
    case "CANCELLED":
      return "The Artifact operation was cancelled.";
    case "CONFLICT":
      return "The Artifact operation conflicts with current Run state.";
    case "EGRESS_DENIED":
      return "The Artifact was denied by the Worker egress guard.";
    case "INVALID_REQUEST":
      return "The Artifact request is invalid.";
    case "STALE_AUTHORITY":
      return "The Artifact Run authority is no longer current.";
    case "FAILED":
      return "The Artifact operation failed.";
  }
}
