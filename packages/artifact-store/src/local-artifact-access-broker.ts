import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";

import type {
  ArtifactChecksum,
  ArtifactClock,
  ArtifactExposurePolicy,
  ArtifactMutationContext,
  ArtifactPresentation,
  ArtifactRandomSource,
  ArtifactRetentionPolicy,
  ArtifactStore,
  StoredArtifactMetadata,
  StoredArtifactProvenance,
} from "./contracts.ts";
import {
  constantTimeTextEqual,
  NodeArtifactRandomSource,
  secureRandomBase64Url,
  sha256Hex,
} from "./crypto.ts";
import { ArtifactStoreError } from "./error.ts";

const ACCESS_SCHEMA_VERSION = 1;
const DEFAULT_MAXIMUM_GRANT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_CHUNKS = 4_096;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_TRANSFER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const TOKEN_SECRET = /^[A-Za-z0-9_-]{43}$/u;

export type ArtifactAccessErrorCode =
  | "ACCESS_STORAGE_CORRUPT"
  | "ACCESS_STORAGE_UNAVAILABLE"
  | "BROWSER_GRANT_INVALID"
  | "UPLOAD_CHECKSUM_MISMATCH"
  | "UPLOAD_CHUNK_INVALID"
  | "UPLOAD_GRANT_EXPIRED"
  | "UPLOAD_GRANT_INVALID"
  | "UPLOAD_IDEMPOTENCY_CONFLICT"
  | "UPLOAD_OFFSET_MISMATCH"
  | "UPLOAD_PUBLICATION_CONFLICT";

export class ArtifactAccessError extends Error {
  public readonly code: ArtifactAccessErrorCode;
  public readonly expectedOffsetBytes: number | undefined;

  public constructor(
    code: ArtifactAccessErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly expectedOffsetBytes?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArtifactAccessError";
    this.code = code;
    this.expectedOffsetBytes = options?.expectedOffsetBytes;
  }
}

export interface IssueArtifactUploadGrant {
  readonly artifactId: string;
  readonly taskId: string;
  readonly producingRunId: string;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly declaredSizeBytes: number;
  readonly expectedChecksum: ArtifactChecksum;
  readonly createdAtMs: number;
  readonly retentionPolicy: ArtifactRetentionPolicy;
  readonly exposurePolicy: ArtifactExposurePolicy;
  readonly provenance: StoredArtifactProvenance;
  readonly presentation?: ArtifactPresentation;
  readonly expiresAtMs: number;
  readonly context: ArtifactMutationContext;
}

export interface IssuedArtifactUploadGrant {
  readonly protocolVersion: 1;
  readonly uploadId: string;
  readonly artifactId: string;
  readonly credential: string;
  readonly expiresAtMs: number;
  readonly maximumChunkBytes: number;
}

export interface ProbeArtifactUpload {
  readonly uploadId: string;
  readonly credential: string;
}

export interface ArtifactUploadProgress {
  readonly uploadId: string;
  readonly artifactId: string;
  readonly nextOffsetBytes: number;
  readonly complete: boolean;
  readonly replayed: boolean;
  readonly metadata?: StoredArtifactMetadata;
}

export interface AppendArtifactUploadChunk extends ProbeArtifactUpload {
  readonly idempotencyKey: string;
  readonly offsetBytes: number;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly correlationId: string;
}

export type ArtifactGatewayPlane = "static" | "interactive";

export interface IssueBrowserArtifactGrant {
  readonly artifactId: string;
  readonly expiresAtMs: number;
  readonly context: ArtifactMutationContext;
}

export interface IssuedBrowserArtifactGrant {
  readonly artifactId: string;
  readonly plane: ArtifactGatewayPlane;
  readonly credential: string;
  readonly expiresAtMs: number;
}

export interface ExchangedBrowserArtifactSession {
  readonly artifactId: string;
  readonly sessionCredential: string;
  readonly expiresAtMs: number;
}

export interface LocalArtifactAccessBrokerOptions {
  readonly rootDirectory: string;
  readonly store: ArtifactStore;
  readonly clock: ArtifactClock;
  readonly maximumArtifactBytes: number;
  readonly maximumChunkBytes: number;
  readonly maximumGrantTtlMs?: number;
  readonly maximumChunksPerUpload?: number;
  readonly random?: ArtifactRandomSource;
}

interface UploadChunkOutcome {
  readonly idempotencyKey: string;
  readonly offsetBytes: number;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly nextOffsetBytes: number;
  readonly complete: boolean;
}

interface UploadRecord {
  readonly uploadId: string;
  readonly credentialDigest: string;
  readonly expiresAtMs: number;
  readonly publication: Omit<IssueArtifactUploadGrant, "expiresAtMs" | "context">;
  readonly nextOffsetBytes: number;
  readonly chunks: Readonly<Record<string, UploadChunkOutcome>>;
  readonly completedAtMs?: number;
  readonly failureCode?: "UPLOAD_CHECKSUM_MISMATCH";
}

interface BrowserGrantRecord {
  readonly grantId: string;
  readonly credentialDigest: string;
  readonly artifactId: string;
  readonly plane: ArtifactGatewayPlane;
  readonly expiresAtMs: number;
  readonly issuedAtMs: number;
  readonly consumedAtMs?: number;
}

interface BrowserSessionRecord {
  readonly sessionId: string;
  readonly credentialDigest: string;
  readonly artifactId: string;
  readonly expiresAtMs: number;
  readonly issuedAtMs: number;
}

interface AccessIndex {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly uploads: Readonly<Record<string, UploadRecord>>;
  readonly browserGrants: Readonly<Record<string, BrowserGrantRecord>>;
  readonly browserSessions: Readonly<Record<string, BrowserSessionRecord>>;
}

export class LocalArtifactAccessBroker {
  readonly #partialDirectory: string;
  readonly #temporaryDirectory: string;
  readonly #indexPath: string;
  readonly #store: ArtifactStore;
  readonly #clock: ArtifactClock;
  readonly #random: ArtifactRandomSource;
  readonly #maximumArtifactBytes: number;
  readonly #maximumChunkBytes: number;
  readonly #maximumGrantTtlMs: number;
  readonly #maximumChunksPerUpload: number;
  #index: AccessIndex;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    options: Required<
      Pick<
        LocalArtifactAccessBrokerOptions,
        | "rootDirectory"
        | "store"
        | "clock"
        | "maximumArtifactBytes"
        | "maximumChunkBytes"
        | "maximumGrantTtlMs"
        | "maximumChunksPerUpload"
        | "random"
      >
    >,
    index: AccessIndex,
  ) {
    this.#partialDirectory = join(options.rootDirectory, "partial");
    this.#temporaryDirectory = join(options.rootDirectory, "tmp");
    this.#indexPath = join(options.rootDirectory, "access.json");
    this.#store = options.store;
    this.#clock = options.clock;
    this.#random = options.random;
    this.#maximumArtifactBytes = options.maximumArtifactBytes;
    this.#maximumChunkBytes = options.maximumChunkBytes;
    this.#maximumGrantTtlMs = options.maximumGrantTtlMs;
    this.#maximumChunksPerUpload = options.maximumChunksPerUpload;
    this.#index = index;
  }

  public static async open(
    options: LocalArtifactAccessBrokerOptions,
  ): Promise<LocalArtifactAccessBroker> {
    validateOptions(options);
    await mkdir(options.rootDirectory, { recursive: true, mode: 0o700 });
    await assertDirectory(options.rootDirectory);
    const rootDirectory = resolve(await realpath(options.rootDirectory));
    const partialDirectory = join(rootDirectory, "partial");
    const temporaryDirectory = join(rootDirectory, "tmp");
    await mkdir(partialDirectory, { recursive: true, mode: 0o700 });
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    await assertDirectory(partialDirectory);
    await assertDirectory(temporaryDirectory);
    const indexPath = join(rootDirectory, "access.json");
    let index: AccessIndex;
    try {
      await assertRegularFile(indexPath);
      index = parseIndex(await readFile(indexPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw asAccessStorageError(error);
      }
      index = emptyIndex();
      await persistIndex(indexPath, temporaryDirectory, index, options.random);
    }
    const broker = new LocalArtifactAccessBroker(
      {
        rootDirectory,
        store: options.store,
        clock: options.clock,
        maximumArtifactBytes: options.maximumArtifactBytes,
        maximumChunkBytes: options.maximumChunkBytes,
        maximumGrantTtlMs: options.maximumGrantTtlMs ?? DEFAULT_MAXIMUM_GRANT_TTL_MS,
        maximumChunksPerUpload: options.maximumChunksPerUpload ?? DEFAULT_MAXIMUM_CHUNKS,
        random: options.random ?? new NodeArtifactRandomSource(),
      },
      index,
    );
    await broker.#pruneExpired(now(options.clock));
    return broker;
  }

  public issueUploadGrant(input: IssueArtifactUploadGrant): Promise<IssuedArtifactUploadGrant> {
    this.#requireOpen();
    const publication = validateUploadPublication(input, this.#maximumArtifactBytes);
    const issuedAtMs = now(this.#clock);
    const expiresAtMs = validateFutureExpiry(
      input.expiresAtMs,
      issuedAtMs,
      this.#maximumGrantTtlMs,
    );
    return this.#serialize(async () => {
      await this.#pruneExpired(issuedAtMs);
      const uploadId = this.#uniqueId("uploads");
      const credential = transferCredential("u1", uploadId, this.#random);
      let record: UploadRecord = Object.freeze({
        uploadId,
        credentialDigest: sha256Hex(credential),
        expiresAtMs,
        publication,
        nextOffsetBytes: 0,
        chunks: Object.freeze({}),
      });
      if (publication.declaredSizeBytes === 0) {
        await this.#publishEmptyArtifact(publication, input.context.correlationId);
        record = Object.freeze({ ...record, completedAtMs: issuedAtMs });
      }
      await this.#commit({
        ...this.#index,
        uploads: Object.freeze({ ...this.#index.uploads, [uploadId]: record }),
      });
      return Object.freeze({
        protocolVersion: 1,
        uploadId,
        artifactId: publication.artifactId,
        credential,
        expiresAtMs,
        maximumChunkBytes: this.#maximumChunkBytes,
      });
    });
  }

  public probeUpload(input: ProbeArtifactUpload): Promise<ArtifactUploadProgress> {
    this.#requireOpen();
    return this.#serialize(async () => {
      const record = this.#requireUpload(input, now(this.#clock));
      return this.#progress(record, false);
    });
  }

  public appendUploadChunk(input: AppendArtifactUploadChunk): Promise<ArtifactUploadProgress> {
    this.#requireOpen();
    requireTransferKey(input.idempotencyKey, "upload idempotency key");
    requireCorrelationId(input.correlationId);
    if (!Number.isSafeInteger(input.offsetBytes) || input.offsetBytes < 0) {
      throw new ArtifactAccessError("UPLOAD_CHUNK_INVALID", "Upload offset is invalid.");
    }
    requireAsyncBytes(input.bytes);
    return this.#serialize(async () => {
      let record = this.#requireUpload(input, now(this.#clock));
      const remaining = record.publication.declaredSizeBytes - input.offsetBytes;
      if (remaining < 0) {
        throw offsetMismatch(record.nextOffsetBytes);
      }
      const staged = await this.#stageChunk(
        input.bytes,
        Math.min(remaining, this.#maximumChunkBytes),
      );
      try {
        const replay = ownValue(record.chunks, input.idempotencyKey);
        if (replay !== undefined) {
          if (
            replay.offsetBytes !== input.offsetBytes ||
            replay.sizeBytes !== staged.sizeBytes ||
            !constantTimeTextEqual(replay.digest, staged.digest)
          ) {
            throw new ArtifactAccessError(
              "UPLOAD_IDEMPOTENCY_CONFLICT",
              "Upload idempotency key was reused for different bytes.",
            );
          }
          if (record.failureCode !== undefined) {
            throw checksumMismatch();
          }
          if (
            record.completedAtMs === undefined &&
            record.nextOffsetBytes === record.publication.declaredSizeBytes
          ) {
            record = await this.#finalizeUpload(record, input.correlationId, input.idempotencyKey);
          }
          return this.#progress(record, true);
        }
        if (
          record.completedAtMs !== undefined ||
          record.failureCode !== undefined ||
          Object.keys(record.chunks).length >= this.#maximumChunksPerUpload
        ) {
          throw new ArtifactAccessError(
            "UPLOAD_CHUNK_INVALID",
            "Upload cannot accept another chunk.",
          );
        }
        if (input.offsetBytes !== record.nextOffsetBytes) {
          throw offsetMismatch(record.nextOffsetBytes);
        }
        if (staged.sizeBytes < 1) {
          throw new ArtifactAccessError("UPLOAD_CHUNK_INVALID", "Upload chunk must not be empty.");
        }

        await this.#appendStagedChunk(record, staged.path);
        const nextOffsetBytes = record.nextOffsetBytes + staged.sizeBytes;
        const outcome: UploadChunkOutcome = Object.freeze({
          idempotencyKey: input.idempotencyKey,
          offsetBytes: input.offsetBytes,
          sizeBytes: staged.sizeBytes,
          digest: staged.digest,
          nextOffsetBytes,
          complete: false,
        });
        record = Object.freeze({
          ...record,
          nextOffsetBytes,
          chunks: Object.freeze({
            ...record.chunks,
            [input.idempotencyKey]: outcome,
          }),
        });
        await this.#replaceUpload(record);
        if (nextOffsetBytes === record.publication.declaredSizeBytes) {
          record = await this.#finalizeUpload(record, input.correlationId, input.idempotencyKey);
        }
        return this.#progress(record, false);
      } finally {
        await unlink(staged.path).catch(() => undefined);
      }
    });
  }

  public async issueBrowserGrant(
    input: IssueBrowserArtifactGrant,
  ): Promise<IssuedBrowserArtifactGrant> {
    this.#requireOpen();
    requireIdentifier(input.artifactId, "Artifact ID");
    validateContext(input.context);
    const issuedAtMs = now(this.#clock);
    const expiresAtMs = validateFutureExpiry(
      input.expiresAtMs,
      issuedAtMs,
      this.#maximumGrantTtlMs,
    );
    const metadata = await this.#store.getAvailableMetadata(input.artifactId);
    if (metadata.exposurePolicy.mode !== "authenticated") {
      throw new ArtifactAccessError(
        "BROWSER_GRANT_INVALID",
        "Browser session grants require authenticated Artifact exposure.",
      );
    }
    const plane = presentationPlane(metadata.presentation);
    return this.#serialize(async () => {
      await this.#pruneExpired(issuedAtMs);
      const grantId = this.#uniqueId("browserGrants");
      const credential = transferCredential("b1", grantId, this.#random);
      const record: BrowserGrantRecord = Object.freeze({
        grantId,
        credentialDigest: sha256Hex(credential),
        artifactId: metadata.artifactId,
        plane,
        expiresAtMs,
        issuedAtMs,
      });
      await this.#commit({
        ...this.#index,
        browserGrants: Object.freeze({
          ...this.#index.browserGrants,
          [grantId]: record,
        }),
      });
      return Object.freeze({
        artifactId: record.artifactId,
        plane,
        credential,
        expiresAtMs,
      });
    });
  }

  public exchangeBrowserGrant(input: {
    readonly credential: string;
    readonly plane: ArtifactGatewayPlane;
  }): Promise<ExchangedBrowserArtifactSession> {
    this.#requireOpen();
    return this.#serialize(async () => {
      const { identifier: grantId } = parseCredential(
        input.credential,
        "b1",
        "BROWSER_GRANT_INVALID",
      );
      const grant = ownValue(this.#index.browserGrants, grantId);
      const currentTime = now(this.#clock);
      if (
        grant === undefined ||
        grant.consumedAtMs !== undefined ||
        grant.expiresAtMs <= currentTime ||
        grant.plane !== input.plane ||
        !constantTimeTextEqual(grant.credentialDigest, sha256Hex(input.credential))
      ) {
        throw browserGrantInvalid();
      }
      await this.#store.getAvailableMetadata(grant.artifactId).catch(() => {
        throw browserGrantInvalid();
      });
      const sessionId = this.#uniqueId("browserSessions");
      const sessionCredential = transferCredential("s1", sessionId, this.#random);
      const session: BrowserSessionRecord = Object.freeze({
        sessionId,
        credentialDigest: sha256Hex(sessionCredential),
        artifactId: grant.artifactId,
        expiresAtMs: grant.expiresAtMs,
        issuedAtMs: currentTime,
      });
      const consumed = Object.freeze({ ...grant, consumedAtMs: currentTime });
      await this.#commit({
        ...this.#index,
        browserGrants: Object.freeze({
          ...this.#index.browserGrants,
          [grant.grantId]: consumed,
        }),
        browserSessions: Object.freeze({
          ...this.#index.browserSessions,
          [sessionId]: session,
        }),
      });
      return Object.freeze({
        artifactId: session.artifactId,
        sessionCredential,
        expiresAtMs: session.expiresAtMs,
      });
    });
  }

  public authorizeBrowserSession(input: {
    readonly artifactId: string;
    readonly credential: string;
  }): Promise<boolean> {
    this.#requireOpen();
    if (!SAFE_IDENTIFIER.test(input.artifactId)) {
      return Promise.resolve(false);
    }
    return this.#serialize(async () => {
      let parsed: { readonly identifier: string };
      try {
        parsed = parseCredential(input.credential, "s1", "BROWSER_GRANT_INVALID");
      } catch {
        return false;
      }
      const session = ownValue(this.#index.browserSessions, parsed.identifier);
      return (
        session !== undefined &&
        session.artifactId === input.artifactId &&
        session.expiresAtMs > now(this.#clock) &&
        constantTimeTextEqual(session.credentialDigest, sha256Hex(input.credential))
      );
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#pending;
  }

  async #publishEmptyArtifact(
    publication: UploadRecord["publication"],
    correlationId: string,
  ): Promise<void> {
    try {
      await this.#store.putStream({
        artifactId: publication.artifactId,
        taskId: publication.taskId,
        producingRunId: publication.producingRunId,
        mediaType: publication.mediaType,
        originalFilename: publication.originalFilename,
        declaredSizeBytes: 0,
        bytes: Readable.from([]),
        expectedChecksum: publication.expectedChecksum,
        createdAtMs: publication.createdAtMs,
        retentionPolicy: publication.retentionPolicy,
        exposurePolicy: publication.exposurePolicy,
        provenance: publication.provenance,
        ...(publication.presentation === undefined
          ? {}
          : { presentation: publication.presentation }),
        context: {
          actor: { type: "device", id: publication.provenance.deviceId },
          correlationId,
        },
      });
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "CHECKSUM_MISMATCH") {
        throw checksumMismatch();
      }
      if (error instanceof ArtifactStoreError && error.code === "ARTIFACT_CONFLICT") {
        throw new ArtifactAccessError(
          "UPLOAD_PUBLICATION_CONFLICT",
          "Artifact identifier already belongs to a different publication.",
        );
      }
      throw error;
    }
  }

  async #finalizeUpload(
    record: UploadRecord,
    correlationId: string,
    finalIdempotencyKey: string,
  ): Promise<UploadRecord> {
    const partialPath = this.#partialPath(record.uploadId);
    await assertRegularFile(partialPath);
    if ((await stat(partialPath)).size !== record.publication.declaredSizeBytes) {
      throw new ArtifactAccessError(
        "ACCESS_STORAGE_CORRUPT",
        "Partial Artifact size does not match durable upload progress.",
      );
    }
    if (
      !constantTimeTextEqual(
        await sha256File(partialPath),
        record.publication.expectedChecksum.value,
      )
    ) {
      const failed: UploadRecord = Object.freeze({
        ...record,
        failureCode: "UPLOAD_CHECKSUM_MISMATCH",
      });
      await this.#replaceUpload(failed);
      throw checksumMismatch();
    }
    const publication = record.publication;
    let metadata: StoredArtifactMetadata;
    try {
      metadata = await this.#store.putStream({
        artifactId: publication.artifactId,
        taskId: publication.taskId,
        producingRunId: publication.producingRunId,
        mediaType: publication.mediaType,
        originalFilename: publication.originalFilename,
        declaredSizeBytes: publication.declaredSizeBytes,
        bytes: fileBytes(partialPath),
        expectedChecksum: publication.expectedChecksum,
        createdAtMs: publication.createdAtMs,
        retentionPolicy: publication.retentionPolicy,
        exposurePolicy: publication.exposurePolicy,
        provenance: publication.provenance,
        ...(publication.presentation === undefined
          ? {}
          : { presentation: publication.presentation }),
        context: {
          actor: { type: "device", id: publication.provenance.deviceId },
          correlationId,
        },
      });
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "CHECKSUM_MISMATCH") {
        throw checksumMismatch();
      }
      if (error instanceof ArtifactStoreError && error.code === "ARTIFACT_CONFLICT") {
        throw new ArtifactAccessError(
          "UPLOAD_PUBLICATION_CONFLICT",
          "Artifact identifier already belongs to a different publication.",
        );
      }
      throw error;
    }
    const finalOutcome = ownValue(record.chunks, finalIdempotencyKey);
    if (finalOutcome === undefined) {
      throw new ArtifactAccessError(
        "ACCESS_STORAGE_CORRUPT",
        "Final upload chunk outcome is missing.",
      );
    }
    const completed: UploadRecord = Object.freeze({
      ...record,
      completedAtMs: now(this.#clock),
      chunks: Object.freeze({
        ...record.chunks,
        [finalIdempotencyKey]: Object.freeze({ ...finalOutcome, complete: true }),
      }),
    });
    await this.#replaceUpload(completed);
    await unlink(partialPath).catch(() => undefined);
    void metadata;
    return completed;
  }

  async #appendStagedChunk(record: UploadRecord, stagedPath: string): Promise<void> {
    const partialPath = this.#partialPath(record.uploadId);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      try {
        await assertRegularFile(partialPath);
        handle = await open(partialPath, "r+");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || record.nextOffsetBytes !== 0) {
          throw error;
        }
        handle = await open(partialPath, "wx+", 0o600);
      }
      const physicalSize = (await handle.stat()).size;
      if (physicalSize < record.nextOffsetBytes) {
        throw new ArtifactAccessError(
          "ACCESS_STORAGE_CORRUPT",
          "Partial Artifact is shorter than durable upload progress.",
        );
      }
      if (physicalSize > record.nextOffsetBytes) {
        await handle.truncate(record.nextOffsetBytes);
      }
      let position = record.nextOffsetBytes;
      for await (const chunk of createReadStream(stagedPath)) {
        const bytes = Buffer.from(chunk);
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await handle.write(
            bytes,
            written,
            bytes.byteLength - written,
            position + written,
          );
          if (result.bytesWritten < 1) {
            throw new ArtifactAccessError(
              "ACCESS_STORAGE_UNAVAILABLE",
              "Partial Artifact write made no progress.",
            );
          }
          written += result.bytesWritten;
        }
        position += bytes.byteLength;
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertRegularFile(partialPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw asAccessStorageError(error);
    }
  }

  async #stageChunk(
    bytes: AsyncIterable<Uint8Array>,
    maximumExpectedBytes: number,
  ): Promise<{ readonly path: string; readonly sizeBytes: number; readonly digest: string }> {
    const path = join(
      this.#temporaryDirectory,
      `chunk-${secureRandomBase64Url(this.#random, 12)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      handle = await open(path, "wx", 0o600);
      for await (const chunk of bytes) {
        if (!(chunk instanceof Uint8Array)) {
          throw new ArtifactAccessError(
            "UPLOAD_CHUNK_INVALID",
            "Upload chunks must contain bytes.",
          );
        }
        sizeBytes += chunk.byteLength;
        if (sizeBytes > this.#maximumChunkBytes || sizeBytes > maximumExpectedBytes) {
          throw new ArtifactAccessError(
            "UPLOAD_CHUNK_INVALID",
            "Upload chunk exceeds its bounded transfer window.",
          );
        }
        if (chunk.byteLength > 0) {
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertRegularFile(path);
      return Object.freeze({ path, sizeBytes, digest: hash.digest("hex") });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  #requireUpload(input: ProbeArtifactUpload, currentTime: number): UploadRecord {
    requireIdentifier(input.uploadId, "upload ID");
    const parsed = parseCredential(input.credential, "u1", "UPLOAD_GRANT_INVALID");
    const record = ownValue(this.#index.uploads, input.uploadId);
    if (
      parsed.identifier !== input.uploadId ||
      record === undefined ||
      !constantTimeTextEqual(record.credentialDigest, sha256Hex(input.credential))
    ) {
      throw uploadGrantInvalid();
    }
    if (record.expiresAtMs <= currentTime) {
      throw new ArtifactAccessError("UPLOAD_GRANT_EXPIRED", "Artifact upload grant expired.");
    }
    if (record.failureCode !== undefined) {
      throw checksumMismatch();
    }
    return record;
  }

  async #progress(record: UploadRecord, replayed: boolean): Promise<ArtifactUploadProgress> {
    const complete = record.completedAtMs !== undefined;
    const metadata = complete
      ? await this.#store.getMetadata(record.publication.artifactId)
      : undefined;
    return Object.freeze({
      uploadId: record.uploadId,
      artifactId: record.publication.artifactId,
      nextOffsetBytes: record.nextOffsetBytes,
      complete,
      replayed,
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  #partialPath(uploadId: string): string {
    requireIdentifier(uploadId, "upload ID");
    return join(this.#partialDirectory, `${uploadId}.part`);
  }

  #uniqueId(collection: "uploads" | "browserGrants" | "browserSessions"): string {
    const prefix =
      collection === "uploads" ? "upload" : collection === "browserGrants" ? "grant" : "session";
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = `${prefix}-${secureRandomBase64Url(this.#random, 16)}`;
      if (!Object.prototype.hasOwnProperty.call(this.#index[collection], candidate)) {
        return candidate;
      }
    }
    throw new ArtifactAccessError(
      "ACCESS_STORAGE_UNAVAILABLE",
      "Unable to allocate a unique Artifact access identifier.",
    );
  }

  async #replaceUpload(record: UploadRecord): Promise<void> {
    await this.#commit({
      ...this.#index,
      uploads: Object.freeze({ ...this.#index.uploads, [record.uploadId]: record }),
    });
  }

  async #pruneExpired(currentTime: number): Promise<void> {
    const expiredUploadIds = Object.values(this.#index.uploads)
      .filter((record) => record.expiresAtMs <= currentTime)
      .map((record) => record.uploadId);
    const expiredUploadIdSet = new Set(expiredUploadIds);
    const uploads = Object.fromEntries(
      Object.entries(this.#index.uploads).filter(([uploadId]) => !expiredUploadIdSet.has(uploadId)),
    );
    const browserGrants = Object.fromEntries(
      Object.entries(this.#index.browserGrants).filter(
        ([, record]) => record.expiresAtMs > currentTime,
      ),
    );
    const browserSessions = Object.fromEntries(
      Object.entries(this.#index.browserSessions).filter(
        ([, record]) => record.expiresAtMs > currentTime,
      ),
    );
    if (
      Object.keys(uploads).length === Object.keys(this.#index.uploads).length &&
      Object.keys(browserGrants).length === Object.keys(this.#index.browserGrants).length &&
      Object.keys(browserSessions).length === Object.keys(this.#index.browserSessions).length
    ) {
      return;
    }
    await this.#commit({
      ...this.#index,
      uploads: Object.freeze(uploads),
      browserGrants: Object.freeze(browserGrants),
      browserSessions: Object.freeze(browserSessions),
    });
    await Promise.all(
      expiredUploadIds.map((uploadId) =>
        unlink(this.#partialPath(uploadId)).catch(() => undefined),
      ),
    );
  }

  async #commit(input: AccessIndex): Promise<void> {
    const next: AccessIndex = Object.freeze({
      ...input,
      schemaVersion: ACCESS_SCHEMA_VERSION,
      generation: this.#index.generation + 1,
    });
    await persistIndex(this.#indexPath, this.#temporaryDirectory, next, this.#random);
    this.#index = next;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new ArtifactAccessError("ACCESS_STORAGE_UNAVAILABLE", "Artifact access is closed.");
    }
  }
}

function validateUploadPublication(
  input: IssueArtifactUploadGrant,
  maximumArtifactBytes: number,
): UploadRecord["publication"] {
  if (!isRecord(input)) {
    throw uploadGrantInvalid();
  }
  assertInputExactKeys(
    input,
    [
      "artifactId",
      "taskId",
      "producingRunId",
      "mediaType",
      "originalFilename",
      "declaredSizeBytes",
      "expectedChecksum",
      "createdAtMs",
      "retentionPolicy",
      "exposurePolicy",
      "provenance",
      "expiresAtMs",
      "context",
    ],
    ["presentation"],
  );
  requireIdentifier(input.artifactId, "Artifact ID");
  requireIdentifier(input.taskId, "Task ID");
  requireIdentifier(input.producingRunId, "Run ID");
  validateProvenance(input.provenance);
  if (
    typeof input.originalFilename !== "string" ||
    input.originalFilename.length < 1 ||
    Buffer.byteLength(input.originalFilename) > 255 ||
    input.originalFilename === "." ||
    input.originalFilename === ".." ||
    input.originalFilename.includes("/") ||
    input.originalFilename.includes("\\") ||
    containsControl(input.originalFilename)
  ) {
    throw uploadGrantInvalid();
  }
  if (typeof input.mediaType !== "string") {
    throw uploadGrantInvalid();
  }
  const mediaType = input.mediaType.toLowerCase();
  if (input.mediaType !== mediaType || !MEDIA_TYPE.test(mediaType)) {
    throw uploadGrantInvalid();
  }
  validateChecksum(input.expectedChecksum);
  if (
    !Number.isSafeInteger(input.declaredSizeBytes) ||
    input.declaredSizeBytes < 0 ||
    input.declaredSizeBytes > maximumArtifactBytes ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0
  ) {
    throw uploadGrantInvalid();
  }
  validateContext(input.context);
  validateRetention(input.retentionPolicy, input.createdAtMs);
  validateExposure(input.exposurePolicy);
  validatePresentation(input.presentation, mediaType);
  return Object.freeze({
    artifactId: input.artifactId,
    taskId: input.taskId,
    producingRunId: input.producingRunId,
    mediaType,
    originalFilename: input.originalFilename,
    declaredSizeBytes: input.declaredSizeBytes,
    expectedChecksum: Object.freeze({ ...input.expectedChecksum }),
    createdAtMs: input.createdAtMs,
    retentionPolicy: Object.freeze({ ...input.retentionPolicy }),
    exposurePolicy: Object.freeze({ ...input.exposurePolicy }),
    provenance: Object.freeze({ ...input.provenance }),
    ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
  });
}

function validateChecksum(checksum: ArtifactChecksum): void {
  if (!isRecord(checksum)) {
    throw uploadGrantInvalid();
  }
  assertInputExactKeys(checksum, ["algorithm", "value"]);
  if (
    checksum.algorithm !== "sha256" ||
    typeof checksum.value !== "string" ||
    !SHA256.test(checksum.value)
  ) {
    throw uploadGrantInvalid();
  }
}

function validateProvenance(provenance: StoredArtifactProvenance): void {
  if (!isRecord(provenance)) {
    throw uploadGrantInvalid();
  }
  assertInputExactKeys(provenance, ["deviceId", "source"], ["workspaceId"]);
  requireIdentifier(provenance.deviceId, "Device ID");
  if (provenance.workspaceId !== undefined) {
    requireIdentifier(provenance.workspaceId, "Workspace ID");
  }
  if (
    typeof provenance.source !== "string" ||
    provenance.source.trim() === "" ||
    Buffer.byteLength(provenance.source) > 256 ||
    containsControl(provenance.source)
  ) {
    throw uploadGrantInvalid();
  }
}

function validatePresentation(
  presentation: ArtifactPresentation | undefined,
  mediaType: string,
): void {
  const selected =
    presentation ??
    (mediaType === "text/html"
      ? "static-html"
      : mediaType === "image/svg+xml"
        ? "download"
        : "inline");
  if (
    (selected === "static-html" || selected === "interactive-html") !==
      (mediaType === "text/html") ||
    (mediaType === "image/svg+xml" && selected !== "download") ||
    (selected !== "inline" &&
      selected !== "download" &&
      selected !== "static-html" &&
      selected !== "interactive-html")
  ) {
    throw uploadGrantInvalid();
  }
}

function validateRetention(policy: ArtifactRetentionPolicy, createdAtMs: number): void {
  if (!isRecord(policy)) {
    throw uploadGrantInvalid();
  }
  if (policy.kind === "task" || policy.kind === "pinned") {
    assertInputExactKeys(policy, ["kind"]);
    return;
  }
  if (policy.kind !== "temporary") {
    throw uploadGrantInvalid();
  }
  assertInputExactKeys(policy, ["kind", "expiresAtMs"]);
  if (!Number.isSafeInteger(policy.expiresAtMs) || policy.expiresAtMs <= createdAtMs) {
    throw uploadGrantInvalid();
  }
}

function validateExposure(policy: ArtifactExposurePolicy): void {
  if (!isRecord(policy)) {
    throw uploadGrantInvalid();
  }
  if (
    policy.mode === "private-network" ||
    policy.mode === "authenticated" ||
    policy.mode === "signed-link" ||
    policy.mode === "public"
  ) {
    assertInputExactKeys(policy, ["mode"]);
    return;
  }
  if (policy.mode !== "custom") {
    throw uploadGrantInvalid();
  }
  assertInputExactKeys(policy, ["mode", "customPolicyId"]);
  if (typeof policy.customPolicyId !== "string" || !SAFE_IDENTIFIER.test(policy.customPolicyId)) {
    throw uploadGrantInvalid();
  }
}

function validateContext(context: ArtifactMutationContext): void {
  if (!isRecord(context) || !isRecord(context.actor)) {
    throw uploadGrantInvalid();
  }
  assertInputExactKeys(context, ["actor", "correlationId"]);
  assertInputExactKeys(context.actor, ["type", "id"]);
  requireIdentifier(context.actor.id, "actor ID");
  requireCorrelationId(context.correlationId);
  if (
    context.actor.type !== "owner" &&
    context.actor.type !== "main-agent" &&
    context.actor.type !== "worker-agent" &&
    context.actor.type !== "system" &&
    context.actor.type !== "device"
  ) {
    throw uploadGrantInvalid();
  }
}

function assertInputExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...keys, ...optional]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    keys.some((key) => !(key in record))
  ) {
    throw uploadGrantInvalid();
  }
}

function validateFutureExpiry(value: number, currentTime: number, maximumTtlMs: number): number {
  if (!Number.isSafeInteger(value) || value <= currentTime || value - currentTime > maximumTtlMs) {
    throw uploadGrantInvalid();
  }
  return value;
}

function validateOptions(options: LocalArtifactAccessBrokerOptions): void {
  if (
    typeof options.rootDirectory !== "string" ||
    !isAbsolute(options.rootDirectory) ||
    resolve(options.rootDirectory) !== options.rootDirectory ||
    !Number.isSafeInteger(options.maximumArtifactBytes) ||
    options.maximumArtifactBytes < 1 ||
    !Number.isSafeInteger(options.maximumChunkBytes) ||
    options.maximumChunkBytes < 1 ||
    options.maximumChunkBytes > options.maximumArtifactBytes ||
    (options.maximumGrantTtlMs !== undefined &&
      (!Number.isSafeInteger(options.maximumGrantTtlMs) || options.maximumGrantTtlMs < 1)) ||
    (options.maximumChunksPerUpload !== undefined &&
      (!Number.isSafeInteger(options.maximumChunksPerUpload) || options.maximumChunksPerUpload < 1))
  ) {
    throw new ArtifactAccessError(
      "ACCESS_STORAGE_UNAVAILABLE",
      "Artifact access configuration is invalid.",
    );
  }
  now(options.clock);
}

function requireIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new ArtifactAccessError("UPLOAD_GRANT_INVALID", `${label} is invalid.`);
  }
}

function requireTransferKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_TRANSFER_KEY.test(value)) {
    throw new ArtifactAccessError("UPLOAD_CHUNK_INVALID", `${label} is invalid.`);
  }
}

function requireCorrelationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_TRANSFER_KEY.test(value)) {
    throw new ArtifactAccessError("UPLOAD_CHUNK_INVALID", "Correlation ID is invalid.");
  }
}

function requireAsyncBytes(value: unknown): asserts value is AsyncIterable<Uint8Array> {
  if (typeof value !== "object" || value === null || !(Symbol.asyncIterator in value)) {
    throw new ArtifactAccessError("UPLOAD_CHUNK_INVALID", "Upload body is not a byte stream.");
  }
}

function transferCredential(
  version: "u1" | "b1" | "s1",
  identifier: string,
  random: ArtifactRandomSource,
): string {
  return `${version}.${identifier}.${secureRandomBase64Url(random, 32)}`;
}

function parseCredential(
  credential: unknown,
  expectedVersion: "u1" | "b1" | "s1",
  errorCode: "UPLOAD_GRANT_INVALID" | "BROWSER_GRANT_INVALID",
): { readonly identifier: string } {
  if (typeof credential !== "string" || credential.length > 256 || containsControl(credential)) {
    throw new ArtifactAccessError(errorCode, "Artifact access credential is invalid.");
  }
  const [version, identifier, secret, extra] = credential.split(".");
  if (
    version !== expectedVersion ||
    identifier === undefined ||
    !SAFE_IDENTIFIER.test(identifier) ||
    secret === undefined ||
    !TOKEN_SECRET.test(secret) ||
    extra !== undefined
  ) {
    throw new ArtifactAccessError(errorCode, "Artifact access credential is invalid.");
  }
  return { identifier };
}

function presentationPlane(presentation: ArtifactPresentation): ArtifactGatewayPlane {
  return presentation === "interactive-html" ? "interactive" : "static";
}

function now(clock: ArtifactClock): number {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactAccessError("ACCESS_STORAGE_UNAVAILABLE", "Artifact clock is invalid.");
  }
  return value;
}

function uploadGrantInvalid(): ArtifactAccessError {
  return new ArtifactAccessError("UPLOAD_GRANT_INVALID", "Artifact upload grant is invalid.");
}

function browserGrantInvalid(): ArtifactAccessError {
  return new ArtifactAccessError("BROWSER_GRANT_INVALID", "Browser Artifact grant is invalid.");
}

function checksumMismatch(): ArtifactAccessError {
  return new ArtifactAccessError(
    "UPLOAD_CHECKSUM_MISMATCH",
    "Uploaded Artifact does not match the granted checksum.",
  );
}

function offsetMismatch(expectedOffsetBytes: number): ArtifactAccessError {
  return new ArtifactAccessError(
    "UPLOAD_OFFSET_MISMATCH",
    "Upload offset does not match durable progress.",
    { expectedOffsetBytes },
  );
}

async function* fileBytes(path: string): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(path)) {
    yield Buffer.from(chunk);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ArtifactAccessError(
      "ACCESS_STORAGE_UNAVAILABLE",
      "Artifact access directory is unsafe.",
    );
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ArtifactAccessError("ACCESS_STORAGE_UNAVAILABLE", "Artifact access file is unsafe.");
  }
}

function emptyIndex(): AccessIndex {
  return Object.freeze({
    schemaVersion: ACCESS_SCHEMA_VERSION,
    generation: 0,
    uploads: Object.freeze({}),
    browserGrants: Object.freeze({}),
    browserSessions: Object.freeze({}),
  });
}

async function persistIndex(
  indexPath: string,
  temporaryDirectory: string,
  index: AccessIndex,
  random: ArtifactRandomSource | undefined,
): Promise<void> {
  await assertDirectory(temporaryDirectory);
  const source = random ?? new NodeArtifactRandomSource();
  const temporaryPath = join(temporaryDirectory, `access-${secureRandomBase64Url(source, 12)}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(index)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, indexPath);
    await assertRegularFile(indexPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw asAccessStorageError(error);
  }
}

function parseIndex(serialized: string): AccessIndex {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw corruptAccessIndex();
  }
  if (!isRecord(value) || value["schemaVersion"] !== ACCESS_SCHEMA_VERSION) {
    throw corruptAccessIndex();
  }
  assertExactKeys(value, [
    "schemaVersion",
    "generation",
    "uploads",
    "browserGrants",
    "browserSessions",
  ]);
  if (
    !Number.isSafeInteger(value["generation"]) ||
    (value["generation"] as number) < 0 ||
    !isRecord(value["uploads"]) ||
    !isRecord(value["browserGrants"]) ||
    !isRecord(value["browserSessions"])
  ) {
    throw corruptAccessIndex();
  }
  const uploads: Record<string, UploadRecord> = Object.create(null);
  for (const [key, raw] of Object.entries(value["uploads"])) {
    uploads[key] = parseUploadRecord(key, raw);
  }
  const browserGrants: Record<string, BrowserGrantRecord> = Object.create(null);
  for (const [key, raw] of Object.entries(value["browserGrants"])) {
    browserGrants[key] = parseBrowserGrantRecord(key, raw);
  }
  const browserSessions: Record<string, BrowserSessionRecord> = Object.create(null);
  for (const [key, raw] of Object.entries(value["browserSessions"])) {
    browserSessions[key] = parseBrowserSessionRecord(key, raw);
  }
  return Object.freeze({
    schemaVersion: ACCESS_SCHEMA_VERSION,
    generation: value["generation"] as number,
    uploads: Object.freeze(uploads),
    browserGrants: Object.freeze(browserGrants),
    browserSessions: Object.freeze(browserSessions),
  });
}

function parseUploadRecord(uploadId: string, raw: unknown): UploadRecord {
  if (!isRecord(raw)) {
    throw corruptAccessIndex();
  }
  assertExactKeys(
    raw,
    [
      "uploadId",
      "credentialDigest",
      "expiresAtMs",
      "publication",
      "nextOffsetBytes",
      "chunks",
      "completedAtMs",
      "failureCode",
    ],
    ["completedAtMs", "failureCode"],
  );
  if (
    raw["uploadId"] !== uploadId ||
    !SAFE_IDENTIFIER.test(uploadId) ||
    typeof raw["credentialDigest"] !== "string" ||
    !SHA256.test(raw["credentialDigest"]) ||
    !Number.isSafeInteger(raw["expiresAtMs"]) ||
    !Number.isSafeInteger(raw["nextOffsetBytes"]) ||
    (raw["nextOffsetBytes"] as number) < 0 ||
    !isRecord(raw["publication"]) ||
    !isRecord(raw["chunks"]) ||
    (raw["completedAtMs"] !== undefined && !Number.isSafeInteger(raw["completedAtMs"])) ||
    (raw["failureCode"] !== undefined && raw["failureCode"] !== "UPLOAD_CHECKSUM_MISMATCH")
  ) {
    throw corruptAccessIndex();
  }
  const publication = parsePublication(raw["publication"]);
  if ((raw["nextOffsetBytes"] as number) > publication.declaredSizeBytes) {
    throw corruptAccessIndex();
  }
  const chunks: Record<string, UploadChunkOutcome> = Object.create(null);
  for (const [key, chunk] of Object.entries(raw["chunks"])) {
    chunks[key] = parseChunkOutcome(key, chunk);
  }
  const orderedChunks = Object.values(chunks).sort(
    (left, right) => left.offsetBytes - right.offsetBytes,
  );
  let provenOffset = 0;
  let completedOutcomes = 0;
  for (const chunk of orderedChunks) {
    if (
      chunk.offsetBytes !== provenOffset ||
      chunk.nextOffsetBytes > publication.declaredSizeBytes
    ) {
      throw corruptAccessIndex();
    }
    provenOffset = chunk.nextOffsetBytes;
    if (chunk.complete) {
      completedOutcomes += 1;
    }
  }
  const completed = raw["completedAtMs"] !== undefined;
  if (
    provenOffset !== raw["nextOffsetBytes"] ||
    (completed &&
      (provenOffset !== publication.declaredSizeBytes ||
        completedOutcomes !== (publication.declaredSizeBytes === 0 ? 0 : 1))) ||
    (!completed && completedOutcomes !== 0) ||
    (raw["failureCode"] !== undefined &&
      (provenOffset !== publication.declaredSizeBytes || completed))
  ) {
    throw corruptAccessIndex();
  }
  return Object.freeze({
    uploadId,
    credentialDigest: raw["credentialDigest"],
    expiresAtMs: raw["expiresAtMs"] as number,
    publication,
    nextOffsetBytes: raw["nextOffsetBytes"] as number,
    chunks: Object.freeze(chunks),
    ...(raw["completedAtMs"] === undefined
      ? {}
      : { completedAtMs: raw["completedAtMs"] as number }),
    ...(raw["failureCode"] === undefined
      ? {}
      : { failureCode: "UPLOAD_CHECKSUM_MISMATCH" as const }),
  });
}

function parsePublication(raw: Record<string, unknown>): UploadRecord["publication"] {
  assertExactKeys(
    raw,
    [
      "artifactId",
      "taskId",
      "producingRunId",
      "mediaType",
      "originalFilename",
      "declaredSizeBytes",
      "expectedChecksum",
      "createdAtMs",
      "retentionPolicy",
      "exposurePolicy",
      "provenance",
      "presentation",
    ],
    ["presentation"],
  );
  try {
    return validateUploadPublication(
      {
        ...raw,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        context: {
          actor: { type: "system", id: "artifact-access-restore" },
          correlationId: "artifact-access-restore",
        },
      } as unknown as IssueArtifactUploadGrant,
      Number.MAX_SAFE_INTEGER,
    );
  } catch {
    throw corruptAccessIndex();
  }
}

function parseChunkOutcome(key: string, raw: unknown): UploadChunkOutcome {
  if (!isRecord(raw)) {
    throw corruptAccessIndex();
  }
  assertExactKeys(raw, [
    "idempotencyKey",
    "offsetBytes",
    "sizeBytes",
    "digest",
    "nextOffsetBytes",
    "complete",
  ]);
  if (
    raw["idempotencyKey"] !== key ||
    !SAFE_TRANSFER_KEY.test(key) ||
    !Number.isSafeInteger(raw["offsetBytes"]) ||
    !Number.isSafeInteger(raw["sizeBytes"]) ||
    !Number.isSafeInteger(raw["nextOffsetBytes"]) ||
    (raw["offsetBytes"] as number) < 0 ||
    (raw["sizeBytes"] as number) < 1 ||
    raw["nextOffsetBytes"] !== (raw["offsetBytes"] as number) + (raw["sizeBytes"] as number) ||
    typeof raw["digest"] !== "string" ||
    !SHA256.test(raw["digest"]) ||
    typeof raw["complete"] !== "boolean"
  ) {
    throw corruptAccessIndex();
  }
  return Object.freeze(raw as unknown as UploadChunkOutcome);
}

function parseBrowserGrantRecord(key: string, raw: unknown): BrowserGrantRecord {
  if (!isRecord(raw)) {
    throw corruptAccessIndex();
  }
  assertExactKeys(
    raw,
    [
      "grantId",
      "credentialDigest",
      "artifactId",
      "plane",
      "expiresAtMs",
      "issuedAtMs",
      "consumedAtMs",
    ],
    ["consumedAtMs"],
  );
  if (
    raw["grantId"] !== key ||
    !SAFE_IDENTIFIER.test(key) ||
    typeof raw["credentialDigest"] !== "string" ||
    !SHA256.test(raw["credentialDigest"]) ||
    typeof raw["artifactId"] !== "string" ||
    !SAFE_IDENTIFIER.test(raw["artifactId"]) ||
    (raw["plane"] !== "static" && raw["plane"] !== "interactive") ||
    !Number.isSafeInteger(raw["expiresAtMs"]) ||
    !Number.isSafeInteger(raw["issuedAtMs"]) ||
    (raw["expiresAtMs"] as number) <= (raw["issuedAtMs"] as number) ||
    (raw["consumedAtMs"] !== undefined && !Number.isSafeInteger(raw["consumedAtMs"]))
  ) {
    throw corruptAccessIndex();
  }
  return Object.freeze(raw as unknown as BrowserGrantRecord);
}

function parseBrowserSessionRecord(key: string, raw: unknown): BrowserSessionRecord {
  if (!isRecord(raw)) {
    throw corruptAccessIndex();
  }
  assertExactKeys(raw, [
    "sessionId",
    "credentialDigest",
    "artifactId",
    "expiresAtMs",
    "issuedAtMs",
  ]);
  if (
    raw["sessionId"] !== key ||
    !SAFE_IDENTIFIER.test(key) ||
    typeof raw["credentialDigest"] !== "string" ||
    !SHA256.test(raw["credentialDigest"]) ||
    typeof raw["artifactId"] !== "string" ||
    !SAFE_IDENTIFIER.test(raw["artifactId"]) ||
    !Number.isSafeInteger(raw["expiresAtMs"]) ||
    !Number.isSafeInteger(raw["issuedAtMs"]) ||
    (raw["expiresAtMs"] as number) <= (raw["issuedAtMs"] as number)
  ) {
    throw corruptAccessIndex();
  }
  return Object.freeze(raw as unknown as BrowserSessionRecord);
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set(keys);
  const optionalSet = new Set(optional);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    keys.some((key) => !optionalSet.has(key) && !(key in record))
  ) {
    throw corruptAccessIndex();
  }
}

function corruptAccessIndex(): ArtifactAccessError {
  return new ArtifactAccessError(
    "ACCESS_STORAGE_CORRUPT",
    "Artifact access journal failed validation.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function asAccessStorageError(error: unknown): ArtifactAccessError {
  if (error instanceof ArtifactAccessError) {
    return error;
  }
  return new ArtifactAccessError(
    "ACCESS_STORAGE_UNAVAILABLE",
    "Artifact access storage operation failed.",
    { cause: error },
  );
}
