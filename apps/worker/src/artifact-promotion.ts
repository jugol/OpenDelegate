import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ArtifactPrepareManifestV1 } from "@opendelegate/device-channel";
import { parseArtifactUploadProgress, type ArtifactUploadProgressV1 } from "@opendelegate/protocol";
import {
  isScannableTextMediaType,
  workerArtifactAssignmentFingerprint,
  type WorkerEgressBlockReason,
  type WorkerEgressGuard,
  type WorkerEgressInspection,
  type WorkerArtifactLifecycle,
  type WorkerArtifactOutputPlan,
  type WorkerRunAssignmentV1,
} from "@opendelegate/worker-runtime";
import type { WorkspaceBinding } from "@opendelegate/agent-adapters";

import {
  isPortableArtifactFilename,
  isPortableArtifactRelativePath,
  portableArtifactPathKey,
} from "./artifact-path.ts";

const MANIFEST_FILENAME = "manifest.v1.json";
const MAXIMUM_MANIFEST_BYTES = 256 * 1024;
const MAXIMUM_ARTIFACTS = 64;
const MAXIMUM_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAXIMUM_TOTAL_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;

export type WorkerArtifactPromotionErrorCode =
  | "CONFIG_INVALID"
  | "DELIVERY_FAILED"
  | "EGRESS_DENIED"
  | "MANIFEST_INVALID"
  | "OUTPUT_ROOT_UNSAFE"
  | "RUN_AUTHORITY_LOST"
  | "SOURCE_UNSAFE";

export class WorkerArtifactPromotionError extends Error {
  public readonly code: WorkerArtifactPromotionErrorCode;
  public readonly retryable: boolean;
  public readonly egressReason: WorkerEgressBlockReason | undefined;

  public constructor(
    code: WorkerArtifactPromotionErrorCode,
    message: string,
    retryable = false,
    options?: ErrorOptions,
    egressReason?: WorkerEgressBlockReason,
  ) {
    super(message, options);
    this.name = "WorkerArtifactPromotionError";
    this.code = code;
    this.retryable = retryable;
    this.egressReason = egressReason;
  }
}

export interface WorkerArtifactPromotionDeliveryPort {
  deliver(input: {
    readonly manifest: ArtifactPrepareManifestV1;
    readonly sourcePath: string;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<ArtifactUploadProgressV1>;
}

export interface FileManifestWorkerArtifactLifecycleOptions {
  readonly stagingRoot: string;
  readonly sourceCheckoutRoot: string;
  readonly delivery: WorkerArtifactPromotionDeliveryPort;
  readonly maximumManifestBytes?: number;
  readonly maximumArtifactBytes?: number;
  readonly maximumTotalArtifactBytes?: number;
  readonly maximumArtifacts?: number;
}

interface ArtifactPromotionLimits {
  readonly maximumManifestBytes: number;
  readonly maximumArtifactBytes: number;
  readonly maximumTotalArtifactBytes: number;
  readonly maximumArtifacts: number;
}

interface ArtifactDeclaration {
  readonly relativePath: string;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly requestedPresentation?: "download" | "inline" | "interactive-html" | "static-html";
}

interface PreparedArtifact {
  readonly artifactId: string;
  readonly sourcePath: string;
  readonly declaration: ArtifactDeclaration;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export class FileManifestWorkerArtifactLifecycle implements WorkerArtifactLifecycle {
  readonly #stagingRoot: string;
  readonly #delivery: WorkerArtifactPromotionDeliveryPort;
  readonly #limits: ArtifactPromotionLimits;

  private constructor(
    stagingRoot: string,
    delivery: WorkerArtifactPromotionDeliveryPort,
    limits: ArtifactPromotionLimits,
  ) {
    this.#stagingRoot = stagingRoot;
    this.#delivery = delivery;
    this.#limits = limits;
  }

  public static async create(
    options: FileManifestWorkerArtifactLifecycleOptions,
  ): Promise<FileManifestWorkerArtifactLifecycle> {
    if (
      options.delivery === null ||
      typeof options.delivery !== "object" ||
      typeof options.delivery.deliver !== "function"
    ) {
      throw configurationInvalid();
    }
    const limits = validateLimits(options);
    const sourceCheckoutRoot = await canonicalExistingDirectory(
      options.sourceCheckoutRoot,
      "CONFIG_INVALID",
    );
    const configuredStagingRoot = normalizedAbsolutePath(options.stagingRoot, "CONFIG_INVALID");
    if (isWithinOrEqual(sourceCheckoutRoot, configuredStagingRoot)) {
      throw configurationInvalid();
    }
    await mkdir(configuredStagingRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = await canonicalExistingDirectory(
      configuredStagingRoot,
      "OUTPUT_ROOT_UNSAFE",
    );
    if (stagingRoot !== configuredStagingRoot || isWithinOrEqual(sourceCheckoutRoot, stagingRoot)) {
      throw new WorkerArtifactPromotionError(
        "OUTPUT_ROOT_UNSAFE",
        "Artifact staging must be a real directory outside the source checkout.",
      );
    }
    if (platform() !== "win32") {
      await chmod(stagingRoot, 0o700);
    }
    return new FileManifestWorkerArtifactLifecycle(stagingRoot, options.delivery, limits);
  }

  public async prepare(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspace: WorkspaceBinding;
    readonly assignmentFingerprint: string;
  }): Promise<WorkerArtifactOutputPlan> {
    validateWorkspaceBinding(context.assignment, context.workspace);
    const expectedFingerprint = workerArtifactAssignmentFingerprint(
      context.assignment,
      context.workspace.workspaceId,
    );
    if (
      context.assignmentFingerprint !== expectedFingerprint ||
      !SHA256.test(context.assignmentFingerprint)
    ) {
      throw new WorkerArtifactPromotionError(
        "CONFIG_INVALID",
        "Artifact output authority does not match the current Worker assignment.",
      );
    }
    const outputRoot = join(this.#stagingRoot, `run-${expectedFingerprint}`);
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const canonicalOutputRoot = await canonicalExistingDirectory(outputRoot, "OUTPUT_ROOT_UNSAFE");
    if (canonicalOutputRoot !== outputRoot || !isStrictlyWithin(this.#stagingRoot, outputRoot)) {
      throw new WorkerArtifactPromotionError(
        "OUTPUT_ROOT_UNSAFE",
        "The per-Run Artifact output root is unsafe.",
      );
    }
    if (platform() !== "win32") {
      await chmod(outputRoot, 0o700);
    }
    return Object.freeze({
      schemaVersion: 1,
      outputRoot,
      manifestPath: join(outputRoot, MANIFEST_FILENAME),
      assignmentFingerprint: expectedFingerprint,
    });
  }

  public async promote(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspace: WorkspaceBinding;
    readonly plan: WorkerArtifactOutputPlan;
    readonly egressGuard: WorkerEgressGuard;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<readonly string[]> {
    validateWorkspaceBinding(context.assignment, context.workspace);
    const expectedFingerprint = workerArtifactAssignmentFingerprint(
      context.assignment,
      context.workspace.workspaceId,
    );
    const expectedRoot = join(this.#stagingRoot, `run-${expectedFingerprint}`);
    if (
      context.plan.schemaVersion !== 1 ||
      context.plan.assignmentFingerprint !== expectedFingerprint ||
      context.plan.outputRoot !== expectedRoot ||
      context.plan.manifestPath !== join(expectedRoot, MANIFEST_FILENAME)
    ) {
      throw new WorkerArtifactPromotionError(
        "OUTPUT_ROOT_UNSAFE",
        "Artifact promotion plan does not belong to the current Worker assignment.",
      );
    }
    await requireExecutionCurrent(context.isExecutionCurrent);
    await canonicalExistingDirectory(expectedRoot, "OUTPUT_ROOT_UNSAFE");

    let manifestBytes: Buffer;
    try {
      manifestBytes = await readStableRegularFile(
        context.plan.manifestPath,
        this.#limits.maximumManifestBytes,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze([]);
      }
      if (error instanceof WorkerArtifactPromotionError) {
        throw error;
      }
      throw new WorkerArtifactPromotionError(
        "MANIFEST_INVALID",
        "The Artifact output manifest could not be read safely.",
        false,
        { cause: error },
      );
    }
    const declarations = parseManifest(manifestBytes, expectedFingerprint, this.#limits);
    const sealedRoot = await mkdtemp(join(this.#stagingRoot, ".sealed-artifacts-"));
    try {
      const prepared: PreparedArtifact[] = [];
      let totalBytes = 0;
      for (const [index, declaration] of declarations.entries()) {
        await requireExecutionCurrent(context.isExecutionCurrent);
        const file = await inspectArtifactFile(
          expectedRoot,
          declaration,
          context.egressGuard,
          join(sealedRoot, `${String(index).padStart(3, "0")}.sealed`),
        );
        if (file.sizeBytes > this.#limits.maximumArtifactBytes) {
          throw new WorkerArtifactPromotionError(
            "SOURCE_UNSAFE",
            "A declared Artifact exceeds the per-file byte limit.",
          );
        }
        totalBytes += file.sizeBytes;
        if (
          !Number.isSafeInteger(totalBytes) ||
          totalBytes > this.#limits.maximumTotalArtifactBytes
        ) {
          throw new WorkerArtifactPromotionError(
            "SOURCE_UNSAFE",
            "Declared Artifacts exceed the per-Run byte limit.",
          );
        }
        const artifactId = deterministicArtifactId({
          assignmentFingerprint: expectedFingerprint,
          declaration,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
        });
        prepared.push(
          Object.freeze({
            artifactId,
            sourcePath: file.sourcePath,
            declaration,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          }),
        );
      }

      const completedArtifactIds: string[] = [];
      for (const artifact of prepared) {
        await requireExecutionCurrent(context.isExecutionCurrent);
        let progress: ArtifactUploadProgressV1;
        try {
          progress = parseArtifactUploadProgress(
            await this.#delivery.deliver({
              manifest: artifactPrepareManifest(context.assignment, artifact),
              sourcePath: artifact.sourcePath,
              isExecutionCurrent: context.isExecutionCurrent,
            }),
          );
        } catch (error) {
          if (!(await safeExecutionCurrent(context.isExecutionCurrent))) {
            throw new WorkerArtifactPromotionError(
              "RUN_AUTHORITY_LOST",
              "Artifact delivery stopped because the Worker Run authority was lost.",
              true,
            );
          }
          throw new WorkerArtifactPromotionError(
            "DELIVERY_FAILED",
            "A declared Artifact could not reach Main's durable store.",
            true,
            { cause: error },
          );
        }
        if (
          !progress.complete ||
          progress.artifactId !== artifact.artifactId ||
          progress.nextOffsetBytes !== artifact.sizeBytes
        ) {
          throw new WorkerArtifactPromotionError(
            "DELIVERY_FAILED",
            "Main did not confirm the declared Artifact at its durable upload boundary.",
            true,
          );
        }
        completedArtifactIds.push(artifact.artifactId);
      }
      await requireExecutionCurrent(context.isExecutionCurrent);
      return Object.freeze(completedArtifactIds);
    } finally {
      await rm(sealedRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function artifactPrepareManifest(
  assignment: WorkerRunAssignmentV1,
  artifact: PreparedArtifact,
): ArtifactPrepareManifestV1 {
  return Object.freeze({
    artifactId: artifact.artifactId,
    taskId: assignment.taskId,
    workOrderId: assignment.workOrder.workOrderId,
    deviceId: assignment.deviceId,
    workerId: assignment.workerId,
    routeId: assignment.routeId,
    runId: assignment.runId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
    mediaType: artifact.declaration.mediaType,
    originalFilename: artifact.declaration.originalFilename,
    declaredSizeBytes: artifact.sizeBytes,
    expectedSha256: artifact.sha256,
    ...(artifact.declaration.requestedPresentation === undefined
      ? {}
      : { requestedPresentation: artifact.declaration.requestedPresentation }),
  });
}

function parseManifest(
  bytes: Buffer,
  expectedFingerprint: string,
  limits: ArtifactPromotionLimits,
): readonly ArtifactDeclaration[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw manifestInvalid();
  }
  const record = exactRecord(parsed, ["schemaVersion", "assignmentFingerprint", "artifacts"]);
  if (
    record["schemaVersion"] !== 1 ||
    record["assignmentFingerprint"] !== expectedFingerprint ||
    !Array.isArray(record["artifacts"]) ||
    record["artifacts"].length > limits.maximumArtifacts
  ) {
    throw manifestInvalid();
  }
  const seenPaths = new Set<string>();
  const declarations = record["artifacts"].map((value) => {
    const artifact = exactRecord(
      value,
      ["relativePath", "mediaType", "originalFilename"],
      ["requestedPresentation"],
    );
    const relativePath = artifactRelativePath(artifact["relativePath"]);
    const portablePath = portableArtifactPathKey(relativePath);
    if (
      portablePath === portableArtifactPathKey(MANIFEST_FILENAME) ||
      seenPaths.has(portablePath)
    ) {
      throw manifestInvalid();
    }
    seenPaths.add(portablePath);
    const mediaType = mediaTypeValue(artifact["mediaType"]);
    const originalFilename = artifactFilename(artifact["originalFilename"]);
    const requestedPresentation = presentationValue(artifact["requestedPresentation"], mediaType);
    return Object.freeze({
      relativePath,
      mediaType,
      originalFilename,
      ...(requestedPresentation === undefined ? {} : { requestedPresentation }),
    });
  });
  return Object.freeze(declarations);
}

async function inspectArtifactFile(
  outputRoot: string,
  declaration: ArtifactDeclaration,
  egressGuard: WorkerEgressGuard,
  sealedPath: string,
): Promise<{
  readonly sourcePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}> {
  inspectArtifactMetadata(declaration, egressGuard);
  const relativePathValue = declaration.relativePath;
  const segments = relativePathValue.split("/");
  let candidate = outputRoot;
  for (const [index, segment] of segments.entries()) {
    candidate = join(candidate, segment);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      throw new WorkerArtifactPromotionError(
        "SOURCE_UNSAFE",
        "A declared Artifact source is unavailable.",
        false,
        { cause: error },
      );
    }
    if (
      info.isSymbolicLink() ||
      (index === segments.length - 1 ? !info.isFile() : !info.isDirectory())
    ) {
      throw new WorkerArtifactPromotionError(
        "SOURCE_UNSAFE",
        "Declared Artifact paths may contain only real directories and a regular file.",
      );
    }
  }
  const sourcePath = resolve(await realpath(candidate));
  if (!isStrictlyWithin(outputRoot, sourcePath)) {
    throw new WorkerArtifactPromotionError(
      "SOURCE_UNSAFE",
      "A declared Artifact source escaped its per-Run output root.",
    );
  }
  const handle = await openRegularFile(sourcePath);
  let sealedHandle: FileHandle | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 0 || !Number.isSafeInteger(before.size)) {
      throw sourceUnsafe();
    }
    try {
      sealedHandle = await open(sealedPath, "wx+", 0o400);
    } catch (error) {
      throw new WorkerArtifactPromotionError(
        "SOURCE_UNSAFE",
        "A private Artifact snapshot could not be created safely.",
        false,
        { cause: error },
      );
    }
    const hash = createHash("sha256");
    const byteScanner = egressGuard.createByteScanner();
    const egressSnapshot = egressGuard.snapshot();
    const knowledgeProtected =
      egressSnapshot.mode === "opaque" ||
      egressSnapshot.exactFingerprints.some(
        ({ category }) => category === "device-local-knowledge",
      ) ||
      egressSnapshot.fragmentFingerprints.some(
        ({ category }) => category === "device-local-knowledge",
      );
    if (knowledgeProtected && !isScannableTextMediaType(declaration.mediaType)) {
      throw egressDenied("unscannable-artifact");
    }
    const textScanner = knowledgeProtected ? egressGuard.createTextScanner() : undefined;
    const decoder =
      textScanner === undefined ? undefined : new TextDecoder("utf-8", { fatal: true });
    let sealedOffset = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      hash.update(chunk);
      requireSafeInspection(byteScanner.push(chunk));
      if (decoder !== undefined && textScanner !== undefined) {
        let text: string;
        try {
          text = decoder.decode(chunk, { stream: true });
        } catch {
          throw egressDenied("unscannable-artifact");
        }
        if (text.length > 0) {
          requireSafeInspection(textScanner.push(text));
        }
      }
      const written = await sealedHandle.write(chunk, 0, chunk.byteLength, sealedOffset);
      if (written.bytesWritten !== chunk.byteLength) {
        throw sourceUnsafe();
      }
      sealedOffset += written.bytesWritten;
    }
    requireSafeInspection(byteScanner.finish());
    if (decoder !== undefined && textScanner !== undefined) {
      let finalText: string;
      try {
        finalText = decoder.decode();
      } catch {
        throw egressDenied("unscannable-artifact");
      }
      if (finalText.length > 0) {
        requireSafeInspection(textScanner.push(finalText));
      }
      requireSafeInspection(textScanner.finish());
    }
    const after = await handle.stat();
    if (!sameFileSnapshot(before, after)) {
      throw new WorkerArtifactPromotionError(
        "SOURCE_UNSAFE",
        "A declared Artifact source changed during validation.",
      );
    }
    await sealedHandle.sync();
    const sealedInfo = await sealedHandle.stat();
    if (!sealedInfo.isFile() || sealedInfo.size !== before.size || sealedOffset !== before.size) {
      throw sourceUnsafe();
    }
    await sealedHandle.close();
    sealedHandle = undefined;
    if (platform() !== "win32") {
      await chmod(sealedPath, 0o400);
    }
    return Object.freeze({
      sourcePath: sealedPath,
      sizeBytes: before.size,
      sha256: hash.digest("hex"),
    });
  } finally {
    await sealedHandle?.close().catch(() => undefined);
    await handle.close();
  }
}

function inspectArtifactMetadata(
  declaration: ArtifactDeclaration,
  egressGuard: WorkerEgressGuard,
): void {
  for (const value of [
    declaration.relativePath,
    declaration.originalFilename,
    declaration.mediaType,
  ]) {
    requireSafeInspection(egressGuard.inspectText(value));
  }
}

function requireSafeInspection(inspection: WorkerEgressInspection): void {
  if (!inspection.safe) {
    throw egressDenied(inspection.reason);
  }
}

function egressDenied(reason: WorkerEgressBlockReason): WorkerArtifactPromotionError {
  return new WorkerArtifactPromotionError(
    "EGRESS_DENIED",
    "Artifact promotion was denied by the Worker egress guard.",
    false,
    undefined,
    reason,
  );
}

async function readStableRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > maximumBytes) {
    throw manifestInvalid();
  }
  const handle = await openRegularFile(path);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw manifestInvalid();
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead < 1) {
        throw manifestInvalid();
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileSnapshot(before, after)) {
      throw manifestInvalid();
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function openRegularFile(path: string): Promise<FileHandle> {
  const flags =
    platform() === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  return open(path, flags).catch((error: unknown) => {
    throw new WorkerArtifactPromotionError(
      "SOURCE_UNSAFE",
      "A declared Artifact file could not be opened safely.",
      false,
      { cause: error },
    );
  });
}

function sameFileSnapshot(
  before: Awaited<ReturnType<FileHandle["stat"]>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function deterministicArtifactId(input: {
  readonly assignmentFingerprint: string;
  readonly declaration: ArtifactDeclaration;
  readonly sizeBytes: number;
  readonly sha256: string;
}): string {
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        schema: "opendelegate.worker-artifact.v1",
        assignmentFingerprint: input.assignmentFingerprint,
        relativePath: input.declaration.relativePath,
        mediaType: input.declaration.mediaType,
        originalFilename: input.declaration.originalFilename,
        requestedPresentation: input.declaration.requestedPresentation ?? null,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
      }),
    )
    .digest("hex");
  return `artifact-${digest}`;
}

function validateWorkspaceBinding(
  assignment: WorkerRunAssignmentV1,
  workspace: WorkspaceBinding,
): void {
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    Array.isArray(workspace) ||
    typeof workspace.workspaceId !== "string" ||
    workspace.workspaceId.length < 1 ||
    (assignment.workOrder.workspaceId !== undefined &&
      assignment.workOrder.workspaceId !== workspace.workspaceId) ||
    normalizedAbsolutePath(workspace.cwd, "CONFIG_INVALID") !== workspace.cwd
  ) {
    throw configurationInvalid();
  }
}

function validateLimits(
  options: FileManifestWorkerArtifactLifecycleOptions,
): ArtifactPromotionLimits {
  const limits = {
    maximumManifestBytes: options.maximumManifestBytes ?? MAXIMUM_MANIFEST_BYTES,
    maximumArtifactBytes: options.maximumArtifactBytes ?? MAXIMUM_ARTIFACT_BYTES,
    maximumTotalArtifactBytes: options.maximumTotalArtifactBytes ?? MAXIMUM_TOTAL_ARTIFACT_BYTES,
    maximumArtifacts: options.maximumArtifacts ?? MAXIMUM_ARTIFACTS,
  };
  if (
    !boundedInteger(limits.maximumManifestBytes, 1, 16 * 1024 * 1024) ||
    !boundedInteger(limits.maximumArtifactBytes, 1, 8 * 1024 * 1024 * 1024) ||
    !boundedInteger(limits.maximumTotalArtifactBytes, 1, 8 * 1024 * 1024 * 1024) ||
    limits.maximumTotalArtifactBytes < limits.maximumArtifactBytes ||
    !boundedInteger(limits.maximumArtifacts, 1, 256)
  ) {
    throw configurationInvalid();
  }
  return Object.freeze(limits);
}

async function canonicalExistingDirectory(
  value: unknown,
  errorCode: "CONFIG_INVALID" | "OUTPUT_ROOT_UNSAFE",
): Promise<string> {
  const path = normalizedAbsolutePath(value, errorCode);
  let info;
  try {
    info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("unsafe directory");
    }
    return resolve(await realpath(path));
  } catch (error) {
    throw new WorkerArtifactPromotionError(
      errorCode,
      errorCode === "CONFIG_INVALID"
        ? "Artifact staging configuration is invalid."
        : "Artifact staging directory is unsafe.",
      false,
      { cause: error },
    );
  }
}

function normalizedAbsolutePath(
  value: unknown,
  errorCode: "CONFIG_INVALID" | "OUTPUT_ROOT_UNSAFE",
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 32_768 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new WorkerArtifactPromotionError(
      errorCode,
      "Artifact staging paths must be normalized absolute paths.",
    );
  }
  return value;
}

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw manifestInvalid();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))
  ) {
    throw manifestInvalid();
  }
  return record;
}

function artifactRelativePath(value: unknown): string {
  if (!isPortableArtifactRelativePath(value)) {
    throw manifestInvalid();
  }
  return value;
}

function mediaTypeValue(value: unknown): string {
  if (typeof value !== "string" || !MEDIA_TYPE.test(value)) {
    throw manifestInvalid();
  }
  return value;
}

function artifactFilename(value: unknown): string {
  if (!isPortableArtifactFilename(value)) {
    throw manifestInvalid();
  }
  return value;
}

function presentationValue(
  value: unknown,
  mediaType: string,
): ArtifactDeclaration["requestedPresentation"] {
  if (value === undefined) {
    return undefined;
  }
  if (
    value !== "download" &&
    value !== "inline" &&
    value !== "interactive-html" &&
    value !== "static-html"
  ) {
    throw manifestInvalid();
  }
  if (
    ((value === "interactive-html" || value === "static-html") && mediaType !== "text/html") ||
    (mediaType === "image/svg+xml" && value !== "download")
  ) {
    throw manifestInvalid();
  }
  return value;
}

async function requireExecutionCurrent(isExecutionCurrent: () => Promise<boolean>): Promise<void> {
  if (!(await safeExecutionCurrent(isExecutionCurrent))) {
    throw new WorkerArtifactPromotionError(
      "RUN_AUTHORITY_LOST",
      "Artifact promotion stopped because the Worker Run authority is no longer current.",
      true,
    );
  }
}

async function safeExecutionCurrent(isExecutionCurrent: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await isExecutionCurrent()) === true;
  } catch {
    return false;
  }
}

function isWithinOrEqual(parent: string, child: string): boolean {
  return parent === child || isStrictlyWithin(parent, child);
}

function isStrictlyWithin(parent: string, child: string): boolean {
  const relationship = relative(resolve(parent), resolve(child));
  return (
    relationship !== "" &&
    relationship !== ".." &&
    !relationship.startsWith(`..${sep}`) &&
    !isAbsolute(relationship)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function sourceUnsafe(): WorkerArtifactPromotionError {
  return new WorkerArtifactPromotionError("SOURCE_UNSAFE", "A declared Artifact source is unsafe.");
}

function manifestInvalid(): WorkerArtifactPromotionError {
  return new WorkerArtifactPromotionError(
    "MANIFEST_INVALID",
    "The Artifact output manifest is invalid.",
  );
}

function configurationInvalid(): WorkerArtifactPromotionError {
  return new WorkerArtifactPromotionError(
    "CONFIG_INVALID",
    "Artifact promotion configuration is invalid.",
  );
}
