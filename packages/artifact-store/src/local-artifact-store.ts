import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type {
  ArtifactAuditEvent,
  ArtifactAuditEventType,
  ArtifactClock,
  ArtifactExposurePolicy,
  ArtifactIndexRepository,
  ArtifactIndexSnapshot,
  ArtifactMutationContext,
  ArtifactPresentation,
  ArtifactRandomSource,
  ArtifactRetentionPolicy,
  ArtifactStore,
  IssueSignedArtifactToken,
  IssuedSignedArtifactToken,
  PutArtifact,
  PutArtifactStream,
  RecordArtifactAccess,
  StoredArtifactContent,
  StoredArtifactMetadata,
  StoredArtifactProvenance,
  VerifySignedArtifactToken,
} from "./contracts.ts";
import {
  constantTimeTextEqual,
  hmacSha256Base64Url,
  NodeArtifactRandomSource,
  secureRandomBase64Url,
  sha256Hex,
} from "./crypto.ts";
import { ArtifactStoreError } from "./error.ts";

const INDEX_SCHEMA_VERSION = 1;
const TOKEN_VERSION = "v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const SIGNED_TOKEN_PARTS = 4;

interface PersistedArtifact extends StoredArtifactMetadata {
  readonly objectDigest: string;
}

interface PersistedSignedToken {
  readonly tokenId: string;
  readonly artifactId: string;
  readonly expiresAtMs: number;
  readonly tokenDigest: string;
  readonly issuedAtMs: number;
  readonly revokedAtMs?: number;
  readonly useCount: number;
  readonly lastUsedAtMs?: number;
}

interface PersistedIndex {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly artifacts: Readonly<Record<string, PersistedArtifact>>;
  readonly signedTokens: Readonly<Record<string, PersistedSignedToken>>;
  readonly auditEvents: readonly ArtifactAuditEvent[];
  readonly nextAuditSequence: number;
}

export interface LocalArtifactStoreOptions {
  readonly rootDirectory: string;
  readonly maxArtifactBytes: number;
  readonly clock: ArtifactClock;
  readonly signingKey: Uint8Array;
  readonly random?: ArtifactRandomSource;
  /**
   * Production Main injects its configured SQL repository here. Ownership transfers
   * to the Store and `close()` closes the repository. Omitting this option retains
   * the safe local-file index for standalone use and backward-compatible tests.
   */
  readonly indexRepository?: ArtifactIndexRepository;
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly rootDirectory: string;
  private readonly objectsDirectory: string;
  private readonly temporaryDirectory: string;
  private readonly indexPath: string;
  private readonly maxArtifactBytes: number;
  private readonly clock: ArtifactClock;
  private readonly signingKey: Uint8Array;
  private readonly random: ArtifactRandomSource;
  private readonly indexRepository: ArtifactIndexRepository | undefined;
  private index: PersistedIndex;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(options: LocalArtifactStoreOptions, index: PersistedIndex) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.objectsDirectory = join(this.rootDirectory, "objects");
    this.temporaryDirectory = join(this.rootDirectory, "tmp");
    this.indexPath = join(this.rootDirectory, "index.json");
    this.maxArtifactBytes = options.maxArtifactBytes;
    this.clock = options.clock;
    this.signingKey = Buffer.from(options.signingKey);
    this.random = options.random ?? new NodeArtifactRandomSource();
    this.indexRepository = options.indexRepository;
    this.index = index;
  }

  public static async open(options: LocalArtifactStoreOptions): Promise<LocalArtifactStore> {
    validateOptions(options);
    try {
      const configuredRootDirectory = resolve(options.rootDirectory);
      await mkdir(configuredRootDirectory, { recursive: true, mode: 0o700 });
      await assertSafeDirectory(configuredRootDirectory);
      const rootDirectory = resolve(await realpath(configuredRootDirectory));
      await assertSafeDirectory(rootDirectory);
      const objectsDirectory = join(rootDirectory, "objects");
      const temporaryDirectory = join(rootDirectory, "tmp");
      await mkdir(objectsDirectory, { recursive: true, mode: 0o700 });
      await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await assertSafeDirectory(objectsDirectory);
      await assertSafeDirectory(temporaryDirectory);

      const indexPath = join(rootDirectory, "index.json");
      let index: PersistedIndex;
      if (options.indexRepository === undefined) {
        index = await loadOrCreateFileIndex(indexPath, temporaryDirectory, options.random);
      } else {
        index = await loadRepositoryIndex(options.indexRepository, indexPath);
      }

      return new LocalArtifactStore({ ...options, rootDirectory }, index);
    } catch (error) {
      try {
        await options.indexRepository?.close();
      } catch {
        // Preserve the primary startup failure.
      }
      throw asRepositoryStorageError(error);
    }
  }

  public async put(input: PutArtifact): Promise<StoredArtifactMetadata> {
    this.requireOpen();
    const normalized = normalizePutArtifact(input, this.maxArtifactBytes);
    return this.serialize(async () => {
      const existing = ownValue(this.index.artifacts, normalized.metadata.artifactId);
      if (existing !== undefined) {
        if (samePublication(existing, normalized.metadata)) {
          return freezeMetadata(existing);
        }
        throw new ArtifactStoreError(
          "ARTIFACT_CONFLICT",
          "The Artifact identifier already belongs to different content or metadata.",
        );
      }

      await this.publishObject(normalized.digest, normalized.bytes);
      const artifact: PersistedArtifact = Object.freeze({
        ...normalized.metadata,
        objectDigest: normalized.digest,
      });
      const next = appendAudit(
        copyIndex(this.index, {
          artifacts: recordWithEntry(this.index.artifacts, artifact.artifactId, artifact),
        }),
        "artifact.stored",
        artifact.artifactId,
        normalized.context,
        validClockNow(this.clock),
        {
          exposureMode: artifact.exposurePolicy.mode,
          mediaType: artifact.mediaType,
          presentation: artifact.presentation,
          sizeBytes: artifact.sizeBytes,
        },
      );
      await this.commit(next);
      return freezeMetadata(artifact);
    });
  }

  public async putStream(input: PutArtifactStream): Promise<StoredArtifactMetadata> {
    this.requireOpen();
    const normalized = normalizePutArtifactStream(input, this.maxArtifactBytes);
    const staged = await this.stageStream(
      normalized.bytes,
      normalized.metadata.sizeBytes,
      normalized.digest,
    );
    try {
      return await this.serialize(async () => {
        const existing = ownValue(this.index.artifacts, normalized.metadata.artifactId);
        if (existing !== undefined) {
          if (samePublication(existing, normalized.metadata)) {
            return freezeMetadata(existing);
          }
          throw new ArtifactStoreError(
            "ARTIFACT_CONFLICT",
            "The Artifact identifier already belongs to different content or metadata.",
          );
        }

        await this.publishStagedObject(staged.path, staged.digest, staged.sizeBytes);
        const artifact: PersistedArtifact = Object.freeze({
          ...normalized.metadata,
          objectDigest: normalized.digest,
        });
        const next = appendAudit(
          copyIndex(this.index, {
            artifacts: recordWithEntry(this.index.artifacts, artifact.artifactId, artifact),
          }),
          "artifact.stored",
          artifact.artifactId,
          normalized.context,
          validClockNow(this.clock),
          {
            exposureMode: artifact.exposurePolicy.mode,
            mediaType: artifact.mediaType,
            presentation: artifact.presentation,
            sizeBytes: artifact.sizeBytes,
          },
        );
        await this.commit(next);
        return freezeMetadata(artifact);
      });
    } finally {
      await unlink(staged.path).catch(() => undefined);
    }
  }

  public async listMetadata(): Promise<readonly StoredArtifactMetadata[]> {
    this.requireOpen();
    return Object.freeze(
      Object.values(this.index.artifacts)
        .sort(
          (left, right) =>
            right.createdAtMs - left.createdAtMs || left.artifactId.localeCompare(right.artifactId),
        )
        .map((artifact) => freezeMetadata(artifact)),
    );
  }

  public async getMetadata(artifactId: string): Promise<StoredArtifactMetadata> {
    this.requireOpen();
    assertIdentifier(artifactId, "Artifact ID");
    return this.serialize(async () => {
      const artifact = ownValue(this.index.artifacts, artifactId);
      if (artifact === undefined) {
        throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact not found.");
      }
      return freezeMetadata(artifact);
    });
  }

  public async getAvailableMetadata(artifactId: string): Promise<StoredArtifactMetadata> {
    this.requireOpen();
    await this.expireOneIfDue(artifactId);
    const metadata = await this.getMetadata(artifactId);
    if (metadata.state !== "available") {
      throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "Artifact is unavailable.");
    }
    return metadata;
  }

  public async read(artifactId: string): Promise<StoredArtifactContent> {
    this.requireOpen();
    await this.expireOneIfDue(artifactId);
    return this.serialize(async () => {
      const artifact = requireAvailableArtifact(this.index, artifactId);
      const objectPath = this.objectPath(artifact.objectDigest);
      let bytes: Buffer;
      try {
        await this.assertObjectDirectories(artifact.objectDigest);
        await assertSafeRegularFile(objectPath);
        bytes = await readFile(objectPath);
      } catch (error) {
        throw asStorageError(error);
      }
      if (bytes.byteLength !== artifact.sizeBytes || sha256Hex(bytes) !== artifact.objectDigest) {
        throw new ArtifactStoreError(
          "ARTIFACT_STORAGE_CORRUPT",
          "Artifact bytes do not match their durable checksum.",
        );
      }
      return Object.freeze({
        metadata: freezeMetadata(artifact),
        bytes: Uint8Array.from(bytes),
      });
    });
  }

  public async pin(
    artifactId: string,
    context: ArtifactMutationContext,
  ): Promise<StoredArtifactMetadata> {
    const normalizedContext = freezeContext(context);
    await this.expireOneIfDue(artifactId);
    return this.mutateArtifact(artifactId, normalizedContext, (artifact, nowMs) => {
      if (artifact.state !== "available") {
        throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "Artifact is unavailable.");
      }
      if (artifact.retentionPolicy.kind === "pinned") {
        return undefined;
      }
      return {
        artifact: {
          ...artifact,
          retentionPolicy: { kind: "pinned" },
          pinnedAtMs: nowMs,
        },
        eventType: "artifact.pinned",
      };
    });
  }

  public async revoke(
    artifactId: string,
    context: ArtifactMutationContext,
  ): Promise<StoredArtifactMetadata> {
    const normalizedContext = freezeContext(context);
    await this.expireOneIfDue(artifactId);
    return this.mutateArtifact(artifactId, normalizedContext, (artifact, nowMs) => {
      if (artifact.state === "revoked") {
        return undefined;
      }
      if (artifact.state === "expired") {
        throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "Artifact is unavailable.");
      }
      return {
        artifact: {
          ...artifact,
          state: "revoked",
          revokedAtMs: nowMs,
        },
        eventType: "artifact.revoked",
      };
    });
  }

  public async expireDue(context: ArtifactMutationContext): Promise<readonly string[]> {
    this.requireOpen();
    const normalizedContext = freezeContext(context);
    return this.serialize(async () => {
      const nowMs = validClockNow(this.clock);
      let next = this.index;
      const expired: string[] = [];
      for (const artifact of Object.values(this.index.artifacts)) {
        if (
          artifact.state !== "available" ||
          artifact.retentionPolicy.kind !== "temporary" ||
          artifact.retentionPolicy.expiresAtMs > nowMs
        ) {
          continue;
        }
        const changed: PersistedArtifact = {
          ...artifact,
          state: "expired",
          expiredAtMs: nowMs,
        };
        next = copyIndex(next, {
          artifacts: recordWithEntry(next.artifacts, artifact.artifactId, changed),
        });
        next = appendAudit(
          next,
          "artifact.expired",
          artifact.artifactId,
          normalizedContext,
          nowMs,
          {},
        );
        expired.push(artifact.artifactId);
      }
      if (expired.length > 0) {
        await this.commit(next);
      }
      return Object.freeze(expired);
    });
  }

  public async issueSignedToken(
    input: IssueSignedArtifactToken,
  ): Promise<IssuedSignedArtifactToken> {
    this.requireOpen();
    const context = freezeContext(input.context);
    await this.expireOneIfDue(input.artifactId);
    return this.serialize(async () => {
      const nowMs = validClockNow(this.clock);
      const artifact = requireAvailableArtifact(this.index, input.artifactId);
      if (artifact.exposurePolicy.mode !== "signed-link") {
        throw new ArtifactStoreError(
          "SIGNED_TOKEN_INVALID",
          "Signed links are not enabled for this Artifact.",
        );
      }
      if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= nowMs) {
        throw new ArtifactStoreError(
          "SIGNED_TOKEN_INVALID",
          "Signed-link expiry must be a future safe timestamp.",
        );
      }

      const tokenId = this.uniqueTokenId();
      const secret = secureRandomBase64Url(this.random, 32);
      const signingInput = signedTokenInput(
        tokenId,
        artifact.artifactId,
        input.expiresAtMs,
        secret,
      );
      const signature = hmacSha256Base64Url(this.signingKey, signingInput);
      const token = `${TOKEN_VERSION}.${tokenId}.${secret}.${signature}`;
      const record: PersistedSignedToken = {
        tokenId,
        artifactId: artifact.artifactId,
        expiresAtMs: input.expiresAtMs,
        tokenDigest: sha256Hex(token),
        issuedAtMs: nowMs,
        useCount: 0,
      };
      let next = copyIndex(this.index, {
        signedTokens: recordWithEntry(this.index.signedTokens, tokenId, record),
      });
      next = appendAudit(
        next,
        "artifact.signed-token-issued",
        artifact.artifactId,
        context,
        nowMs,
        { tokenId, expiresAtMs: input.expiresAtMs },
      );
      await this.commit(next);
      return Object.freeze({
        tokenId,
        token,
        artifactId: artifact.artifactId,
        expiresAtMs: input.expiresAtMs,
      });
    });
  }

  public async verifySignedToken(input: VerifySignedArtifactToken): Promise<void> {
    this.requireOpen();
    assertIdentifier(input.artifactId, "Artifact ID");
    const context = freezeContext(input.context);
    await this.expireOneIfDue(input.artifactId);
    await this.serialize(async () => {
      const nowMs = validClockNow(this.clock);
      requireAvailableArtifact(this.index, input.artifactId);
      const parsed = parseSignedToken(input.token);
      const record = ownValue(this.index.signedTokens, parsed.tokenId);
      if (
        record === undefined ||
        record.artifactId !== input.artifactId ||
        record.revokedAtMs !== undefined ||
        record.expiresAtMs <= nowMs ||
        !constantTimeTextEqual(record.tokenDigest, sha256Hex(input.token))
      ) {
        throw invalidSignedToken();
      }
      const expectedSignature = hmacSha256Base64Url(
        this.signingKey,
        signedTokenInput(record.tokenId, record.artifactId, record.expiresAtMs, parsed.secret),
      );
      if (!constantTimeTextEqual(expectedSignature, parsed.signature)) {
        throw invalidSignedToken();
      }

      const nextRecord: PersistedSignedToken = {
        ...record,
        useCount: record.useCount + 1,
        lastUsedAtMs: nowMs,
      };
      let next = copyIndex(this.index, {
        signedTokens: recordWithEntry(this.index.signedTokens, record.tokenId, nextRecord),
      });
      next = appendAudit(next, "artifact.access-granted", record.artifactId, context, nowMs, {
        mode: "signed-link",
        tokenId: record.tokenId,
      });
      await this.commit(next);
    });
  }

  public async revokeSignedToken(tokenId: string, context: ArtifactMutationContext): Promise<void> {
    this.requireOpen();
    assertTokenId(tokenId);
    const normalizedContext = freezeContext(context);
    await this.serialize(async () => {
      const record = ownValue(this.index.signedTokens, tokenId);
      if (record === undefined) {
        throw invalidSignedToken();
      }
      if (record.revokedAtMs !== undefined) {
        return;
      }
      const nowMs = validClockNow(this.clock);
      const changed = { ...record, revokedAtMs: nowMs };
      let next = copyIndex(this.index, {
        signedTokens: recordWithEntry(this.index.signedTokens, tokenId, changed),
      });
      next = appendAudit(
        next,
        "artifact.signed-token-revoked",
        record.artifactId,
        normalizedContext,
        nowMs,
        { tokenId },
      );
      await this.commit(next);
    });
  }

  public async recordAccess(input: RecordArtifactAccess): Promise<void> {
    this.requireOpen();
    assertIdentifier(input.artifactId, "Artifact ID");
    const context = freezeContext(input.context);
    await this.serialize(async () => {
      if (ownValue(this.index.artifacts, input.artifactId) === undefined) {
        return;
      }
      const next = appendAudit(
        this.index,
        input.granted ? "artifact.access-granted" : "artifact.access-denied",
        input.artifactId,
        context,
        validClockNow(this.clock),
        { mode: input.mode },
      );
      await this.commit(next);
    });
  }

  public async listAuditEvents(artifactId?: string): Promise<readonly ArtifactAuditEvent[]> {
    this.requireOpen();
    if (artifactId !== undefined) {
      assertIdentifier(artifactId, "Artifact ID");
    }
    return this.serialize(async () =>
      Object.freeze(
        this.index.auditEvents
          .filter((event) => artifactId === undefined || event.artifactId === artifactId)
          .map(freezeAuditEvent),
      ),
    );
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pending;
    this.signingKey.fill(0);
    await this.indexRepository?.close();
  }

  private async expireOneIfDue(artifactId: string): Promise<void> {
    this.requireOpen();
    assertIdentifier(artifactId, "Artifact ID");
    await this.serialize(async () => {
      const artifact = ownValue(this.index.artifacts, artifactId);
      if (artifact === undefined) {
        throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact not found.");
      }
      const nowMs = validClockNow(this.clock);
      if (
        artifact.state !== "available" ||
        artifact.retentionPolicy.kind !== "temporary" ||
        artifact.retentionPolicy.expiresAtMs > nowMs
      ) {
        return;
      }
      const context: ArtifactMutationContext = {
        actor: { type: "system", id: "artifact-retention" },
        correlationId: `artifact-expiry:${artifactId}`,
      };
      const changed: PersistedArtifact = {
        ...artifact,
        state: "expired",
        expiredAtMs: nowMs,
      };
      let next = copyIndex(this.index, {
        artifacts: recordWithEntry(this.index.artifacts, artifactId, changed),
      });
      next = appendAudit(next, "artifact.expired", artifactId, context, nowMs, {});
      await this.commit(next);
    });
  }

  private async mutateArtifact(
    artifactId: string,
    context: ArtifactMutationContext,
    mutate: (
      artifact: PersistedArtifact,
      nowMs: number,
    ) =>
      | {
          readonly artifact: PersistedArtifact;
          readonly eventType: ArtifactAuditEventType;
        }
      | undefined,
  ): Promise<StoredArtifactMetadata> {
    this.requireOpen();
    assertIdentifier(artifactId, "Artifact ID");
    const normalizedContext = freezeContext(context);
    return this.serialize(async () => {
      const artifact = ownValue(this.index.artifacts, artifactId);
      if (artifact === undefined) {
        throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact not found.");
      }
      const nowMs = validClockNow(this.clock);
      const result = mutate(artifact, nowMs);
      if (result === undefined) {
        return freezeMetadata(artifact);
      }
      let next = copyIndex(this.index, {
        artifacts: recordWithEntry(this.index.artifacts, artifactId, result.artifact),
      });
      next = appendAudit(next, result.eventType, artifactId, normalizedContext, nowMs, {});
      await this.commit(next);
      return freezeMetadata(result.artifact);
    });
  }

  private uniqueTokenId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = secureRandomBase64Url(this.random, 16);
      if (ownValue(this.index.signedTokens, candidate) === undefined) {
        return candidate;
      }
    }
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_UNAVAILABLE",
      "Unable to allocate a unique signed-link identifier.",
    );
  }

  private async publishObject(digest: string, bytes: Uint8Array): Promise<void> {
    await assertSafeDirectory(this.objectsDirectory);
    await assertSafeDirectory(this.temporaryDirectory);
    const prefixDirectory = join(this.objectsDirectory, digest.slice(0, 2));
    await mkdir(prefixDirectory, { recursive: true, mode: 0o700 });
    await this.assertObjectDirectories(digest);
    const target = this.objectPath(digest);
    try {
      await assertSafeRegularFile(target);
      const existing = await readFile(target);
      if (existing.byteLength !== bytes.byteLength || sha256Hex(existing) !== digest) {
        throw new ArtifactStoreError(
          "ARTIFACT_STORAGE_CORRUPT",
          "A content-addressed object conflicts with its checksum.",
        );
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw asStorageError(error);
      }
    }

    const temporaryPath = join(
      this.temporaryDirectory,
      `object-${secureRandomBase64Url(this.random, 12)}.tmp`,
    );
    await writeAtomicFile(temporaryPath, target, bytes);
    await assertSafeRegularFile(target);
  }

  private async stageStream(
    bytes: AsyncIterable<Uint8Array>,
    declaredSizeBytes: number,
    expectedDigest: string,
  ): Promise<{ readonly path: string; readonly digest: string; readonly sizeBytes: number }> {
    await assertSafeDirectory(this.temporaryDirectory);
    const temporaryPath = join(
      this.temporaryDirectory,
      `stream-${secureRandomBase64Url(this.random, 12)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      for await (const chunk of bytes) {
        if (!(chunk instanceof Uint8Array)) {
          throw new ArtifactStoreError(
            "ARTIFACT_METADATA_INVALID",
            "Artifact stream chunks must be Uint8Array values.",
          );
        }
        if (chunk.byteLength === 0) {
          continue;
        }
        sizeBytes += chunk.byteLength;
        if (sizeBytes > this.maxArtifactBytes) {
          throw new ArtifactStoreError(
            "ARTIFACT_TOO_LARGE",
            "Artifact exceeds the configured local byte limit.",
          );
        }
        if (sizeBytes > declaredSizeBytes) {
          throw new ArtifactStoreError(
            "ARTIFACT_SIZE_MISMATCH",
            "Artifact bytes exceed the declared size.",
          );
        }
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      if (sizeBytes !== declaredSizeBytes) {
        throw new ArtifactStoreError(
          "ARTIFACT_SIZE_MISMATCH",
          "Artifact bytes do not match the declared size.",
        );
      }
      const digest = hash.digest("hex");
      if (!constantTimeTextEqual(digest, expectedDigest)) {
        throw new ArtifactStoreError(
          "CHECKSUM_MISMATCH",
          "Artifact bytes do not match the expected checksum.",
        );
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertSafeRegularFile(temporaryPath);
      return Object.freeze({ path: temporaryPath, digest, sizeBytes });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async publishStagedObject(
    stagedPath: string,
    digest: string,
    sizeBytes: number,
  ): Promise<void> {
    await assertSafeDirectory(this.objectsDirectory);
    await assertSafeDirectory(this.temporaryDirectory);
    await assertSafeRegularFile(stagedPath);
    const prefixDirectory = join(this.objectsDirectory, digest.slice(0, 2));
    await mkdir(prefixDirectory, { recursive: true, mode: 0o700 });
    await this.assertObjectDirectories(digest);
    const target = this.objectPath(digest);
    try {
      await assertSafeRegularFile(target);
      if ((await stat(target)).size !== sizeBytes || (await sha256File(target)) !== digest) {
        throw new ArtifactStoreError(
          "ARTIFACT_STORAGE_CORRUPT",
          "A content-addressed object conflicts with its checksum.",
        );
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw asStorageError(error);
      }
    }
    try {
      await rename(stagedPath, target);
      await assertSafeRegularFile(target);
    } catch (error) {
      throw asStorageError(error);
    }
  }

  private async assertObjectDirectories(digest: string): Promise<void> {
    await assertSafeDirectory(this.objectsDirectory);
    await assertSafeDirectory(join(this.objectsDirectory, digest.slice(0, 2)));
  }

  private objectPath(digest: string): string {
    if (!SHA256_PATTERN.test(digest)) {
      throw new ArtifactStoreError(
        "ARTIFACT_STORAGE_CORRUPT",
        "Artifact object digest is malformed.",
      );
    }
    const path = resolve(this.objectsDirectory, digest.slice(0, 2), digest);
    const expected = join(this.objectsDirectory, digest.slice(0, 2), digest);
    if (path !== expected) {
      throw new ArtifactStoreError(
        "ARTIFACT_STORAGE_UNSAFE",
        "Artifact object path escaped its managed directory.",
      );
    }
    return path;
  }

  private async commit(index: PersistedIndex): Promise<void> {
    const next: PersistedIndex = Object.freeze({
      ...index,
      generation: this.index.generation + 1,
    });
    if (this.indexRepository === undefined) {
      await persistIndex(this.indexPath, this.temporaryDirectory, next, this.random);
    } else {
      const nextSnapshot = createRepositorySnapshot(next);
      let committed: boolean;
      try {
        committed = await this.indexRepository.compareAndSet(this.index.generation, nextSnapshot);
      } catch (error) {
        try {
          const observed = await this.indexRepository.load();
          if (observed !== undefined) {
            const recovered = parseRepositorySnapshot(observed);
            if (
              observed.generation === nextSnapshot.generation &&
              constantTimeTextEqual(observed.stateSha256, nextSnapshot.stateSha256) &&
              observed.stateJson === nextSnapshot.stateJson
            ) {
              this.index = recovered;
              return;
            }
          }
        } catch (recoveryError) {
          if (
            recoveryError instanceof ArtifactStoreError ||
            (typeof recoveryError === "object" &&
              recoveryError !== null &&
              Reflect.get(recoveryError, "code") === "DATA_CORRUPT")
          ) {
            throw asRepositoryStorageError(recoveryError);
          }
        }
        throw asRepositoryStorageError(error);
      }
      if (!committed) {
        let latest: ArtifactIndexSnapshot | undefined;
        try {
          latest = await this.indexRepository.load();
        } catch (error) {
          throw asRepositoryStorageError(error);
        }
        if (latest === undefined) {
          throw new ArtifactStoreError(
            "ARTIFACT_STORAGE_CORRUPT",
            "The durable Artifact index disappeared during a commit.",
          );
        }
        const refreshed = parseRepositorySnapshot(latest);
        if (refreshed.generation <= this.index.generation) {
          throw new ArtifactStoreError(
            "ARTIFACT_STORAGE_CORRUPT",
            "The durable Artifact index rejected a current generation.",
          );
        }
        this.index = refreshed;
        throw new ArtifactStoreError(
          "ARTIFACT_STORAGE_UNAVAILABLE",
          "The durable Artifact index changed concurrently; retry the operation.",
        );
      }
    }
    this.index = next;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new ArtifactStoreError("ARTIFACT_STORAGE_UNAVAILABLE", "Artifact Store is closed.");
    }
  }
}

function normalizePutArtifact(
  input: PutArtifact,
  maxArtifactBytes: number,
): {
  readonly metadata: StoredArtifactMetadata;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly context: ArtifactMutationContext;
} {
  assertMetadataKeys(
    input,
    [
      "artifactId",
      "taskId",
      "producingRunId",
      "mediaType",
      "originalFilename",
      "bytes",
      "expectedChecksum",
      "createdAtMs",
      "retentionPolicy",
      "exposurePolicy",
      "provenance",
      "presentation",
      "context",
    ],
    ["presentation"],
    "Artifact publication",
  );
  assertMetadataKeys(
    input.provenance,
    ["deviceId", "source", "workspaceId"],
    ["workspaceId"],
    "Artifact provenance",
  );
  assertMetadataKeys(input.expectedChecksum, ["algorithm", "value"], [], "Artifact checksum");
  assertIdentifier(input.artifactId, "Artifact ID");
  assertIdentifier(input.taskId, "Task ID");
  assertIdentifier(input.producingRunId, "producing Run ID");
  assertIdentifier(input.provenance.deviceId, "provenance Device ID");
  if (input.provenance.workspaceId !== undefined) {
    assertIdentifier(input.provenance.workspaceId, "provenance Workspace ID");
  }
  assertSafeText(input.provenance.source, "provenance source", 256);
  assertSafeFilename(input.originalFilename);
  const mediaType = normalizeMediaType(input.mediaType);
  const context = freezeContext(input.context);
  if (!(input.bytes instanceof Uint8Array)) {
    throw metadataInvalid("Artifact bytes must be a Uint8Array.");
  }
  if (input.bytes.byteLength > maxArtifactBytes) {
    throw new ArtifactStoreError(
      "ARTIFACT_TOO_LARGE",
      "Artifact exceeds the configured local byte limit.",
    );
  }
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) {
    throw metadataInvalid("Artifact creation time must be a non-negative safe integer.");
  }
  const retentionPolicy = normalizeRetention(input.retentionPolicy, input.createdAtMs);
  const exposurePolicy = normalizeExposure(input.exposurePolicy);
  const presentation = normalizePresentation(input.presentation, mediaType);
  if (
    input.expectedChecksum.algorithm !== "sha256" ||
    !SHA256_PATTERN.test(input.expectedChecksum.value)
  ) {
    throw metadataInvalid("Expected checksum must be a lowercase SHA-256 digest.");
  }
  const bytes = Uint8Array.from(input.bytes);
  const digest = sha256Hex(bytes);
  if (!constantTimeTextEqual(digest, input.expectedChecksum.value)) {
    throw new ArtifactStoreError(
      "CHECKSUM_MISMATCH",
      "Artifact bytes do not match the expected checksum.",
    );
  }
  const provenance: StoredArtifactProvenance = Object.freeze({
    deviceId: input.provenance.deviceId,
    source: input.provenance.source,
    ...(input.provenance.workspaceId === undefined
      ? {}
      : { workspaceId: input.provenance.workspaceId }),
  });
  const metadata: StoredArtifactMetadata = Object.freeze({
    artifactId: input.artifactId,
    taskId: input.taskId,
    producingRunId: input.producingRunId,
    mediaType,
    originalFilename: input.originalFilename,
    sizeBytes: bytes.byteLength,
    checksum: Object.freeze({ algorithm: "sha256", value: digest }),
    createdAtMs: input.createdAtMs,
    retentionPolicy,
    exposurePolicy,
    provenance,
    presentation,
    state: "available",
  });
  return { metadata, bytes, digest, context };
}

function normalizePutArtifactStream(
  input: PutArtifactStream,
  maxArtifactBytes: number,
): {
  readonly metadata: StoredArtifactMetadata;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly digest: string;
  readonly context: ArtifactMutationContext;
} {
  assertMetadataKeys(
    input,
    [
      "artifactId",
      "taskId",
      "producingRunId",
      "mediaType",
      "originalFilename",
      "declaredSizeBytes",
      "bytes",
      "expectedChecksum",
      "createdAtMs",
      "retentionPolicy",
      "exposurePolicy",
      "provenance",
      "presentation",
      "context",
    ],
    ["presentation"],
    "Artifact stream publication",
  );
  assertMetadataKeys(
    input.provenance,
    ["deviceId", "source", "workspaceId"],
    ["workspaceId"],
    "Artifact provenance",
  );
  assertMetadataKeys(input.expectedChecksum, ["algorithm", "value"], [], "Artifact checksum");
  assertIdentifier(input.artifactId, "Artifact ID");
  assertIdentifier(input.taskId, "Task ID");
  assertIdentifier(input.producingRunId, "producing Run ID");
  assertIdentifier(input.provenance.deviceId, "provenance Device ID");
  if (input.provenance.workspaceId !== undefined) {
    assertIdentifier(input.provenance.workspaceId, "provenance Workspace ID");
  }
  assertSafeText(input.provenance.source, "provenance source", 256);
  assertSafeFilename(input.originalFilename);
  const mediaType = normalizeMediaType(input.mediaType);
  const context = freezeContext(input.context);
  if (
    typeof input.bytes !== "object" ||
    input.bytes === null ||
    !(Symbol.asyncIterator in input.bytes)
  ) {
    throw metadataInvalid("Artifact bytes must be an asynchronous byte stream.");
  }
  if (!Number.isSafeInteger(input.declaredSizeBytes) || input.declaredSizeBytes < 0) {
    throw metadataInvalid("Declared Artifact size must be a non-negative safe integer.");
  }
  if (input.declaredSizeBytes > maxArtifactBytes) {
    throw new ArtifactStoreError(
      "ARTIFACT_TOO_LARGE",
      "Artifact exceeds the configured local byte limit.",
    );
  }
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) {
    throw metadataInvalid("Artifact creation time must be a non-negative safe integer.");
  }
  const retentionPolicy = normalizeRetention(input.retentionPolicy, input.createdAtMs);
  const exposurePolicy = normalizeExposure(input.exposurePolicy);
  const presentation = normalizePresentation(input.presentation, mediaType);
  if (
    input.expectedChecksum.algorithm !== "sha256" ||
    !SHA256_PATTERN.test(input.expectedChecksum.value)
  ) {
    throw metadataInvalid("Expected checksum must be a lowercase SHA-256 digest.");
  }
  const provenance: StoredArtifactProvenance = Object.freeze({
    deviceId: input.provenance.deviceId,
    source: input.provenance.source,
    ...(input.provenance.workspaceId === undefined
      ? {}
      : { workspaceId: input.provenance.workspaceId }),
  });
  const metadata: StoredArtifactMetadata = Object.freeze({
    artifactId: input.artifactId,
    taskId: input.taskId,
    producingRunId: input.producingRunId,
    mediaType,
    originalFilename: input.originalFilename,
    sizeBytes: input.declaredSizeBytes,
    checksum: Object.freeze({
      algorithm: "sha256",
      value: input.expectedChecksum.value,
    }),
    createdAtMs: input.createdAtMs,
    retentionPolicy,
    exposurePolicy,
    provenance,
    presentation,
    state: "available",
  });
  return {
    metadata,
    bytes: input.bytes,
    digest: input.expectedChecksum.value,
    context,
  };
}

function normalizePresentation(
  requested: ArtifactPresentation | undefined,
  mediaType: string,
): ArtifactPresentation {
  const presentation =
    requested ??
    (mediaType === "text/html"
      ? "static-html"
      : mediaType === "image/svg+xml"
        ? "download"
        : "inline");
  if (
    presentation !== "inline" &&
    presentation !== "download" &&
    presentation !== "static-html" &&
    presentation !== "interactive-html"
  ) {
    throw metadataInvalid("Artifact presentation is invalid.");
  }
  if (
    mediaType === "text/html" &&
    presentation !== "static-html" &&
    presentation !== "interactive-html"
  ) {
    throw metadataInvalid("HTML Artifacts require an explicit HTML presentation mode.");
  }
  if (
    mediaType !== "text/html" &&
    (presentation === "static-html" || presentation === "interactive-html")
  ) {
    throw metadataInvalid("HTML presentation modes require text/html.");
  }
  if (mediaType === "image/svg+xml" && presentation !== "download") {
    throw metadataInvalid("SVG Artifacts must use download presentation.");
  }
  return presentation;
}

function normalizeRetention(
  policy: ArtifactRetentionPolicy,
  createdAtMs: number,
): ArtifactRetentionPolicy {
  const record = requireMetadataRecord(policy, "Artifact retention policy");
  if (record["kind"] === "temporary") {
    assertMetadataKeys(record, ["kind", "expiresAtMs"], [], "Artifact retention policy");
  } else {
    assertMetadataKeys(record, ["kind"], [], "Artifact retention policy");
  }
  if (policy.kind === "temporary") {
    if (!Number.isSafeInteger(policy.expiresAtMs) || policy.expiresAtMs <= createdAtMs) {
      throw metadataInvalid("Temporary retention expiry must follow Artifact creation.");
    }
    return Object.freeze({ kind: "temporary", expiresAtMs: policy.expiresAtMs });
  }
  if (policy.kind !== "task" && policy.kind !== "pinned") {
    throw metadataInvalid("Artifact retention policy is invalid.");
  }
  return Object.freeze({ kind: policy.kind });
}

function normalizeExposure(policy: ArtifactExposurePolicy): ArtifactExposurePolicy {
  const record = requireMetadataRecord(policy, "Artifact exposure policy");
  if (record["mode"] === "custom") {
    assertMetadataKeys(record, ["mode", "customPolicyId"], [], "Artifact exposure policy");
  } else {
    assertMetadataKeys(record, ["mode"], [], "Artifact exposure policy");
  }
  if (policy.mode === "custom") {
    assertIdentifier(policy.customPolicyId, "custom exposure Policy ID");
    return Object.freeze({ mode: "custom", customPolicyId: policy.customPolicyId });
  }
  if (
    policy.mode !== "private-network" &&
    policy.mode !== "authenticated" &&
    policy.mode !== "signed-link" &&
    policy.mode !== "public"
  ) {
    throw metadataInvalid("Artifact exposure policy is invalid.");
  }
  if ("customPolicyId" in policy && policy.customPolicyId !== undefined) {
    throw metadataInvalid("Only custom exposure can name a custom Policy.");
  }
  return Object.freeze({ mode: policy.mode });
}

function validateOptions(options: LocalArtifactStoreOptions): void {
  if (
    typeof options.rootDirectory !== "string" ||
    !isAbsolute(options.rootDirectory) ||
    resolve(options.rootDirectory) !== options.rootDirectory
  ) {
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_UNSAFE",
      "Artifact root must be a normalized absolute path.",
    );
  }
  if (!Number.isSafeInteger(options.maxArtifactBytes) || options.maxArtifactBytes < 1) {
    throw new ArtifactStoreError(
      "ARTIFACT_METADATA_INVALID",
      "Artifact byte limit must be a positive safe integer.",
    );
  }
  if (!(options.signingKey instanceof Uint8Array) || options.signingKey.byteLength < 32) {
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_UNAVAILABLE",
      "Artifact signing key must contain at least 256 bits.",
    );
  }
  if (
    options.indexRepository !== undefined &&
    (typeof options.indexRepository !== "object" ||
      options.indexRepository === null ||
      typeof options.indexRepository.load !== "function" ||
      typeof options.indexRepository.initialize !== "function" ||
      typeof options.indexRepository.compareAndSet !== "function" ||
      typeof options.indexRepository.close !== "function")
  ) {
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_UNAVAILABLE",
      "Artifact index repository is invalid.",
    );
  }
  validClockNow(options.clock);
}

function validClockNow(clock: ArtifactClock): number {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_UNAVAILABLE",
      "Artifact clock returned an invalid timestamp.",
    );
  }
  return value;
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw metadataInvalid(`${label} is invalid.`);
  }
}

function assertTokenId(value: string): void {
  if (typeof value !== "string" || !SAFE_TOKEN_ID_PATTERN.test(value)) {
    throw invalidSignedToken();
  }
}

function assertSafeText(value: string, label: string, maxBytes: number): void {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    containsControl(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw metadataInvalid(`${label} is invalid.`);
  }
}

function assertSafeFilename(value: string): void {
  assertSafeText(value, "Artifact filename", 255);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw metadataInvalid("Artifact filename must be a safe basename.");
  }
}

function normalizeMediaType(value: string): string {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    value.length > 127 ||
    !MEDIA_TYPE_PATTERN.test(value)
  ) {
    throw metadataInvalid("Artifact media type is invalid.");
  }
  return value;
}

function assertContext(context: ArtifactMutationContext): void {
  if (
    context === null ||
    typeof context !== "object" ||
    context.actor === null ||
    typeof context.actor !== "object"
  ) {
    throw metadataInvalid("Artifact mutation context is invalid.");
  }
  assertMetadataKeys(context, ["actor", "correlationId"], [], "Artifact mutation context");
  assertMetadataKeys(context.actor, ["type", "id"], [], "Artifact actor");
  const actorTypes = new Set(["owner", "main-agent", "worker-agent", "system", "device"]);
  if (!actorTypes.has(context.actor.type)) {
    throw metadataInvalid("Artifact actor type is invalid.");
  }
  assertIdentifier(context.actor.id, "Artifact actor ID");
  assertIdentifier(context.correlationId, "Artifact correlation ID");
}

function freezeContext(context: ArtifactMutationContext): ArtifactMutationContext {
  assertContext(context);
  return Object.freeze({
    actor: Object.freeze({ type: context.actor.type, id: context.actor.id }),
    correlationId: context.correlationId,
  });
}

function metadataInvalid(message: string): ArtifactStoreError {
  return new ArtifactStoreError("ARTIFACT_METADATA_INVALID", message);
}

function requireMetadataRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw metadataInvalid(`${label} must be a plain object.`);
  }
  return value;
}

function assertMetadataKeys(
  value: unknown,
  allowed: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const record = requireMetadataRecord(value, label);
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  if (
    Object.keys(record).some((key) => !allowedSet.has(key)) ||
    allowed.some((key) => !optionalSet.has(key) && !(key in record))
  ) {
    throw metadataInvalid(`${label} contains unknown or missing fields.`);
  }
}

function invalidSignedToken(): ArtifactStoreError {
  return new ArtifactStoreError("SIGNED_TOKEN_INVALID", "Signed Artifact token is invalid.");
}

function requireAvailableArtifact(index: PersistedIndex, artifactId: string): PersistedArtifact {
  assertIdentifier(artifactId, "Artifact ID");
  const artifact = ownValue(index.artifacts, artifactId);
  if (artifact === undefined) {
    throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact not found.");
  }
  if (artifact.state !== "available") {
    throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "Artifact is unavailable.");
  }
  return artifact;
}

function signedTokenInput(
  tokenId: string,
  artifactId: string,
  expiresAtMs: number,
  secret: string,
): string {
  return `${TOKEN_VERSION}\u0000${tokenId}\u0000${artifactId}\u0000${expiresAtMs}\u0000${secret}`;
}

function parseSignedToken(token: string): {
  readonly tokenId: string;
  readonly secret: string;
  readonly signature: string;
} {
  if (typeof token !== "string" || token.length > 1_024 || containsControl(token)) {
    throw invalidSignedToken();
  }
  const parts = token.split(".");
  if (
    parts.length !== SIGNED_TOKEN_PARTS ||
    parts[0] !== TOKEN_VERSION ||
    parts[1] === undefined ||
    parts[2] === undefined ||
    parts[3] === undefined
  ) {
    throw invalidSignedToken();
  }
  assertTokenId(parts[1]);
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{40,64}$/.test(parts[3])) {
    throw invalidSignedToken();
  }
  return { tokenId: parts[1], secret: parts[2], signature: parts[3] };
}

function emptyIndex(): PersistedIndex {
  return Object.freeze({
    schemaVersion: INDEX_SCHEMA_VERSION,
    generation: 0,
    artifacts: Object.freeze({}),
    signedTokens: Object.freeze({}),
    auditEvents: Object.freeze([]),
    nextAuditSequence: 1,
  });
}

function copyIndex(
  index: PersistedIndex,
  changes: Partial<
    Pick<PersistedIndex, "artifacts" | "signedTokens" | "auditEvents" | "nextAuditSequence">
  >,
): PersistedIndex {
  return Object.freeze({
    ...index,
    ...changes,
  });
}

function recordWithEntry<T>(
  source: Readonly<Record<string, T>>,
  key: string,
  value: T,
): Readonly<Record<string, T>> {
  return Object.freeze(Object.fromEntries([...Object.entries(source), [key, value]]));
}

function appendAudit(
  index: PersistedIndex,
  eventType: ArtifactAuditEventType,
  artifactId: string,
  context: ArtifactMutationContext,
  occurredAtMs: number,
  details: Record<string, string | number | boolean | null>,
): PersistedIndex {
  const event = freezeAuditEvent({
    sequence: index.nextAuditSequence,
    eventType,
    occurredAtMs,
    artifactId,
    actor: context.actor,
    correlationId: context.correlationId,
    details,
  });
  return copyIndex(index, {
    auditEvents: Object.freeze([...index.auditEvents, event]),
    nextAuditSequence: index.nextAuditSequence + 1,
  });
}

function freezeAuditEvent(event: ArtifactAuditEvent): ArtifactAuditEvent {
  return Object.freeze({
    ...event,
    actor: Object.freeze({ ...event.actor }),
    details: Object.freeze({ ...event.details }),
  });
}

function freezeMetadata(
  artifact: PersistedArtifact | StoredArtifactMetadata,
): StoredArtifactMetadata {
  return Object.freeze({
    artifactId: artifact.artifactId,
    taskId: artifact.taskId,
    producingRunId: artifact.producingRunId,
    mediaType: artifact.mediaType,
    originalFilename: artifact.originalFilename,
    sizeBytes: artifact.sizeBytes,
    checksum: Object.freeze({ ...artifact.checksum }),
    createdAtMs: artifact.createdAtMs,
    retentionPolicy: Object.freeze({ ...artifact.retentionPolicy }),
    exposurePolicy: Object.freeze({ ...artifact.exposurePolicy }),
    provenance: Object.freeze({ ...artifact.provenance }),
    presentation: artifact.presentation,
    state: artifact.state,
    ...(artifact.pinnedAtMs === undefined ? {} : { pinnedAtMs: artifact.pinnedAtMs }),
    ...(artifact.revokedAtMs === undefined ? {} : { revokedAtMs: artifact.revokedAtMs }),
    ...(artifact.expiredAtMs === undefined ? {} : { expiredAtMs: artifact.expiredAtMs }),
  });
}

function samePublication(existing: PersistedArtifact, candidate: StoredArtifactMetadata): boolean {
  const existingMetadata = freezeMetadata(existing);
  // A retry may receive a fresh grant after Main committed the Artifact but its
  // completion response was lost. Preserve the first publication timestamp while
  // comparing every immutable owner-declared field.
  return (
    existing.state === "available" &&
    JSON.stringify({ ...existingMetadata, createdAtMs: 0 }) ===
      JSON.stringify({ ...candidate, createdAtMs: 0 })
  );
}

async function loadOrCreateFileIndex(
  indexPath: string,
  temporaryDirectory: string,
  random: ArtifactRandomSource | undefined,
): Promise<PersistedIndex> {
  const existing = await loadFileIndexIfPresent(indexPath);
  if (existing !== undefined) {
    return existing;
  }
  const index = emptyIndex();
  await persistIndex(indexPath, temporaryDirectory, index, random);
  return index;
}

async function loadRepositoryIndex(
  repository: ArtifactIndexRepository,
  legacyIndexPath: string,
): Promise<PersistedIndex> {
  let snapshot = await repository.load();
  if (snapshot === undefined) {
    const legacyOrEmpty = await loadFileIndexIfPresent(legacyIndexPath);
    snapshot = await repository.initialize(createRepositorySnapshot(legacyOrEmpty ?? emptyIndex()));
    return parseRepositorySnapshot(snapshot);
  }

  const current = parseRepositorySnapshot(snapshot);
  if (!isPristineEmptyIndex(current)) {
    return current;
  }
  const legacy = await loadFileIndexIfPresent(legacyIndexPath);
  if (legacy === undefined || isPristineEmptyIndex(legacy)) {
    return current;
  }

  const migrated = Object.freeze({
    ...legacy,
    generation: current.generation + 1,
  });
  const migratedSnapshot = createRepositorySnapshot(migrated);
  try {
    if (await repository.compareAndSet(current.generation, migratedSnapshot)) {
      return migrated;
    }
  } catch (error) {
    const observed = await recoverExactRepositoryCommit(repository, migratedSnapshot);
    if (observed !== undefined) {
      return observed;
    }
    throw error;
  }
  const winner = await repository.load();
  if (winner === undefined) {
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_CORRUPT",
      "The durable Artifact index disappeared during legacy migration.",
    );
  }
  return parseRepositorySnapshot(winner);
}

async function recoverExactRepositoryCommit(
  repository: ArtifactIndexRepository,
  expected: ArtifactIndexSnapshot,
): Promise<PersistedIndex | undefined> {
  const observed = await repository.load();
  if (observed === undefined) {
    return undefined;
  }
  const recovered = parseRepositorySnapshot(observed);
  return sameRepositorySnapshot(observed, expected) ? recovered : undefined;
}

function sameRepositorySnapshot(
  left: ArtifactIndexSnapshot,
  right: ArtifactIndexSnapshot,
): boolean {
  return (
    left.generation === right.generation &&
    constantTimeTextEqual(left.stateSha256, right.stateSha256) &&
    left.stateJson === right.stateJson
  );
}

function isPristineEmptyIndex(index: PersistedIndex): boolean {
  return (
    index.generation === 0 &&
    Object.keys(index.artifacts).length === 0 &&
    Object.keys(index.signedTokens).length === 0 &&
    index.auditEvents.length === 0 &&
    index.nextAuditSequence === 1
  );
}

async function loadFileIndexIfPresent(indexPath: string): Promise<PersistedIndex | undefined> {
  try {
    await assertSafeRegularFile(indexPath);
    return parseIndex(await readFile(indexPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw asStorageError(error);
  }
}

function createRepositorySnapshot(index: PersistedIndex): ArtifactIndexSnapshot {
  const stateJson = JSON.stringify(index);
  return Object.freeze({
    schemaVersion: 1 as const,
    generation: index.generation,
    stateJson,
    stateSha256: sha256Hex(stateJson),
  });
}

function parseRepositorySnapshot(snapshot: ArtifactIndexSnapshot): PersistedIndex {
  if (!isRecord(snapshot)) {
    throw corruptIndex();
  }
  assertExactKeys(snapshot, ["schemaVersion", "generation", "stateJson", "stateSha256"]);
  if (
    snapshot["schemaVersion"] !== 1 ||
    !isNonNegativeSafeInteger(snapshot["generation"]) ||
    typeof snapshot["stateJson"] !== "string" ||
    typeof snapshot["stateSha256"] !== "string" ||
    !SHA256_PATTERN.test(snapshot["stateSha256"]) ||
    !constantTimeTextEqual(sha256Hex(snapshot["stateJson"]), snapshot["stateSha256"])
  ) {
    throw corruptIndex();
  }
  const index = parseIndex(snapshot["stateJson"]);
  if (index.generation !== snapshot["generation"]) {
    throw corruptIndex();
  }
  return index;
}

async function persistIndex(
  indexPath: string,
  temporaryDirectory: string,
  index: PersistedIndex,
  random: ArtifactRandomSource | undefined,
): Promise<void> {
  await assertSafeDirectory(temporaryDirectory);
  try {
    await assertSafeRegularFile(indexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw asStorageError(error);
    }
  }
  const source = random ?? new NodeArtifactRandomSource();
  const temporaryPath = join(temporaryDirectory, `index-${secureRandomBase64Url(source, 12)}.tmp`);
  const serialized = `${JSON.stringify(index)}\n`;
  await writeAtomicFile(temporaryPath, indexPath, serialized);
  await assertSafeRegularFile(indexPath);
}

async function writeAtomicFile(
  temporaryPath: string,
  targetPath: string,
  content: string | Uint8Array,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw asStorageError(error);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function assertSafeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_UNSAFE",
      "Artifact managed directory is not a regular directory.",
    );
  }
}

async function assertSafeRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_UNSAFE",
      "Artifact managed object is not a regular file.",
    );
  }
}

function parseIndex(serialized: string): PersistedIndex {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_CORRUPT",
      "Artifact metadata index is not valid JSON.",
    );
  }
  if (!isRecord(value)) {
    throw corruptIndex();
  }
  assertExactKeys(value, [
    "schemaVersion",
    "generation",
    "artifacts",
    "signedTokens",
    "auditEvents",
    "nextAuditSequence",
  ]);
  if (
    value["schemaVersion"] !== INDEX_SCHEMA_VERSION ||
    !isNonNegativeSafeInteger(value["generation"]) ||
    !isRecord(value["artifacts"]) ||
    !isRecord(value["signedTokens"]) ||
    !Array.isArray(value["auditEvents"]) ||
    !isPositiveSafeInteger(value["nextAuditSequence"])
  ) {
    throw corruptIndex();
  }

  const artifacts = Object.create(null) as Record<string, PersistedArtifact>;
  for (const [artifactId, raw] of Object.entries(value["artifacts"])) {
    artifacts[artifactId] = parsePersistedArtifact(artifactId, raw);
  }
  const signedTokens = Object.create(null) as Record<string, PersistedSignedToken>;
  for (const [tokenId, raw] of Object.entries(value["signedTokens"])) {
    signedTokens[tokenId] = parsePersistedToken(tokenId, raw, artifacts);
  }
  const auditEvents = value["auditEvents"].map(parseAuditEvent);
  for (let index = 0; index < auditEvents.length; index += 1) {
    const event = auditEvents[index];
    if (event?.sequence !== index + 1 || ownValue(artifacts, event.artifactId) === undefined) {
      throw corruptIndex();
    }
  }
  if (value["nextAuditSequence"] !== auditEvents.length + 1) {
    throw corruptIndex();
  }
  return Object.freeze({
    schemaVersion: INDEX_SCHEMA_VERSION,
    generation: value["generation"],
    artifacts: Object.freeze(artifacts),
    signedTokens: Object.freeze(signedTokens),
    auditEvents: Object.freeze(auditEvents),
    nextAuditSequence: value["nextAuditSequence"],
  });
}

function parsePersistedArtifact(artifactId: string, raw: unknown): PersistedArtifact {
  if (!isRecord(raw)) {
    throw corruptIndex();
  }
  assertIdentifier(artifactId, "Artifact ID");
  const required = [
    "artifactId",
    "taskId",
    "producingRunId",
    "mediaType",
    "originalFilename",
    "sizeBytes",
    "checksum",
    "createdAtMs",
    "retentionPolicy",
    "exposurePolicy",
    "provenance",
    "presentation",
    "state",
    "objectDigest",
  ];
  const optional = ["pinnedAtMs", "revokedAtMs", "expiredAtMs"];
  assertExactKeys(raw, [...required, ...optional], optional);
  if (
    raw["artifactId"] !== artifactId ||
    typeof raw["taskId"] !== "string" ||
    typeof raw["producingRunId"] !== "string" ||
    typeof raw["mediaType"] !== "string" ||
    typeof raw["originalFilename"] !== "string" ||
    !isNonNegativeSafeInteger(raw["sizeBytes"]) ||
    !isNonNegativeSafeInteger(raw["createdAtMs"]) ||
    !isRecord(raw["checksum"]) ||
    raw["checksum"]["algorithm"] !== "sha256" ||
    typeof raw["checksum"]["value"] !== "string" ||
    !SHA256_PATTERN.test(raw["checksum"]["value"]) ||
    raw["objectDigest"] !== raw["checksum"]["value"] ||
    !isRecord(raw["retentionPolicy"]) ||
    !isRecord(raw["exposurePolicy"]) ||
    !isRecord(raw["provenance"]) ||
    typeof raw["presentation"] !== "string" ||
    (raw["state"] !== "available" && raw["state"] !== "expired" && raw["state"] !== "revoked")
  ) {
    throw corruptIndex();
  }
  assertExactKeys(raw["checksum"], ["algorithm", "value"]);
  assertRetentionShape(raw["retentionPolicy"]);
  assertExposureShape(raw["exposurePolicy"]);
  assertIdentifier(raw["taskId"], "Task ID");
  assertIdentifier(raw["producingRunId"], "Run ID");
  const mediaType = normalizeMediaType(raw["mediaType"]);
  assertSafeFilename(raw["originalFilename"]);
  const retentionPolicy = normalizeRetention(
    raw["retentionPolicy"] as unknown as ArtifactRetentionPolicy,
    raw["createdAtMs"],
  );
  const exposurePolicy = normalizeExposure(
    raw["exposurePolicy"] as unknown as ArtifactExposurePolicy,
  );
  const presentation = normalizePresentation(
    raw["presentation"] as ArtifactPresentation,
    mediaType,
  );
  const provenance = parseProvenance(raw["provenance"]);
  const stateTimes = parseStateTimes(raw, raw["state"]);
  return Object.freeze({
    artifactId,
    taskId: raw["taskId"],
    producingRunId: raw["producingRunId"],
    mediaType,
    originalFilename: raw["originalFilename"],
    sizeBytes: raw["sizeBytes"],
    checksum: Object.freeze({ algorithm: "sha256", value: raw["objectDigest"] }),
    createdAtMs: raw["createdAtMs"],
    retentionPolicy,
    exposurePolicy,
    provenance,
    presentation,
    state: raw["state"],
    objectDigest: raw["objectDigest"],
    ...stateTimes,
  });
}

function parseProvenance(raw: Record<string, unknown>): StoredArtifactProvenance {
  assertExactKeys(raw, ["deviceId", "source", "workspaceId"], ["workspaceId"]);
  if (typeof raw["deviceId"] !== "string" || typeof raw["source"] !== "string") {
    throw corruptIndex();
  }
  assertIdentifier(raw["deviceId"], "Device ID");
  assertSafeText(raw["source"], "provenance source", 256);
  if (raw["workspaceId"] !== undefined) {
    if (typeof raw["workspaceId"] !== "string") {
      throw corruptIndex();
    }
    assertIdentifier(raw["workspaceId"], "Workspace ID");
  }
  return Object.freeze({
    deviceId: raw["deviceId"],
    source: raw["source"],
    ...(raw["workspaceId"] === undefined ? {} : { workspaceId: raw["workspaceId"] }),
  });
}

function parseStateTimes(
  raw: Record<string, unknown>,
  state: StoredArtifactMetadata["state"],
): Pick<StoredArtifactMetadata, "pinnedAtMs" | "revokedAtMs" | "expiredAtMs"> {
  for (const key of ["pinnedAtMs", "revokedAtMs", "expiredAtMs"]) {
    if (raw[key] !== undefined && !isNonNegativeSafeInteger(raw[key])) {
      throw corruptIndex();
    }
  }
  if (
    (state === "revoked") !== (raw["revokedAtMs"] !== undefined) ||
    (state === "expired") !== (raw["expiredAtMs"] !== undefined) ||
    (raw["pinnedAtMs"] !== undefined &&
      (raw["retentionPolicy"] as { readonly kind?: unknown }).kind !== "pinned")
  ) {
    throw corruptIndex();
  }
  const createdAtMs = raw["createdAtMs"];
  if (
    !isNonNegativeSafeInteger(createdAtMs) ||
    ["pinnedAtMs", "revokedAtMs", "expiredAtMs"].some(
      (key) => typeof raw[key] === "number" && raw[key] < createdAtMs,
    )
  ) {
    throw corruptIndex();
  }
  return {
    ...(raw["pinnedAtMs"] === undefined ? {} : { pinnedAtMs: raw["pinnedAtMs"] as number }),
    ...(raw["revokedAtMs"] === undefined ? {} : { revokedAtMs: raw["revokedAtMs"] as number }),
    ...(raw["expiredAtMs"] === undefined ? {} : { expiredAtMs: raw["expiredAtMs"] as number }),
  };
}

function parsePersistedToken(
  tokenId: string,
  raw: unknown,
  artifacts: Readonly<Record<string, PersistedArtifact>>,
): PersistedSignedToken {
  if (!isRecord(raw)) {
    throw corruptIndex();
  }
  assertExactKeys(
    raw,
    [
      "tokenId",
      "artifactId",
      "expiresAtMs",
      "tokenDigest",
      "issuedAtMs",
      "revokedAtMs",
      "useCount",
      "lastUsedAtMs",
    ],
    ["revokedAtMs", "lastUsedAtMs"],
  );
  assertTokenId(tokenId);
  if (
    raw["tokenId"] !== tokenId ||
    typeof raw["artifactId"] !== "string" ||
    ownValue(artifacts, raw["artifactId"]) === undefined ||
    !isNonNegativeSafeInteger(raw["expiresAtMs"]) ||
    !isNonNegativeSafeInteger(raw["issuedAtMs"]) ||
    raw["expiresAtMs"] <= raw["issuedAtMs"] ||
    typeof raw["tokenDigest"] !== "string" ||
    !SHA256_PATTERN.test(raw["tokenDigest"]) ||
    !isNonNegativeSafeInteger(raw["useCount"]) ||
    (raw["revokedAtMs"] !== undefined && !isNonNegativeSafeInteger(raw["revokedAtMs"])) ||
    (raw["lastUsedAtMs"] !== undefined && !isNonNegativeSafeInteger(raw["lastUsedAtMs"])) ||
    (typeof raw["revokedAtMs"] === "number" && raw["revokedAtMs"] < raw["issuedAtMs"]) ||
    (typeof raw["lastUsedAtMs"] === "number" && raw["lastUsedAtMs"] < raw["issuedAtMs"])
  ) {
    throw corruptIndex();
  }
  return Object.freeze({
    tokenId,
    artifactId: raw["artifactId"],
    expiresAtMs: raw["expiresAtMs"],
    tokenDigest: raw["tokenDigest"],
    issuedAtMs: raw["issuedAtMs"],
    useCount: raw["useCount"],
    ...(raw["revokedAtMs"] === undefined ? {} : { revokedAtMs: raw["revokedAtMs"] as number }),
    ...(raw["lastUsedAtMs"] === undefined ? {} : { lastUsedAtMs: raw["lastUsedAtMs"] as number }),
  });
}

function parseAuditEvent(raw: unknown): ArtifactAuditEvent {
  if (!isRecord(raw)) {
    throw corruptIndex();
  }
  assertExactKeys(raw, [
    "sequence",
    "eventType",
    "occurredAtMs",
    "artifactId",
    "actor",
    "correlationId",
    "details",
  ]);
  const eventTypes = new Set<unknown>([
    "artifact.stored",
    "artifact.pinned",
    "artifact.revoked",
    "artifact.expired",
    "artifact.signed-token-issued",
    "artifact.signed-token-revoked",
    "artifact.access-granted",
    "artifact.access-denied",
  ]);
  if (
    !isPositiveSafeInteger(raw["sequence"]) ||
    !eventTypes.has(raw["eventType"]) ||
    !isNonNegativeSafeInteger(raw["occurredAtMs"]) ||
    typeof raw["artifactId"] !== "string" ||
    !isRecord(raw["actor"]) ||
    typeof raw["correlationId"] !== "string" ||
    !isRecord(raw["details"])
  ) {
    throw corruptIndex();
  }
  assertExactKeys(raw["actor"], ["type", "id"]);
  const context = {
    actor: raw["actor"],
    correlationId: raw["correlationId"],
  } as unknown as ArtifactMutationContext;
  assertContext(context);
  for (const detail of Object.values(raw["details"])) {
    if (
      detail !== null &&
      typeof detail !== "string" &&
      typeof detail !== "number" &&
      typeof detail !== "boolean"
    ) {
      throw corruptIndex();
    }
  }
  assertIdentifier(raw["artifactId"], "Artifact ID");
  return freezeAuditEvent({
    sequence: raw["sequence"],
    eventType: raw["eventType"] as ArtifactAuditEventType,
    occurredAtMs: raw["occurredAtMs"],
    artifactId: raw["artifactId"],
    actor: context.actor,
    correlationId: context.correlationId,
    details: raw["details"] as Record<string, string | number | boolean | null>,
  });
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw corruptIndex();
  }
  const optionalSet = new Set(optional);
  if (allowed.some((key) => !optionalSet.has(key) && !(key in value))) {
    throw corruptIndex();
  }
}

function assertRetentionShape(value: Record<string, unknown>): void {
  if (value["kind"] === "temporary") {
    assertExactKeys(value, ["kind", "expiresAtMs"]);
    return;
  }
  assertExactKeys(value, ["kind"]);
}

function assertExposureShape(value: Record<string, unknown>): void {
  if (value["mode"] === "custom") {
    assertExactKeys(value, ["mode", "customPolicyId"]);
    return;
  }
  assertExactKeys(value, ["mode"]);
}

function corruptIndex(): ArtifactStoreError {
  return new ArtifactStoreError(
    "ARTIFACT_STORAGE_CORRUPT",
    "Artifact metadata index failed validation.",
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function ownValue<TValue>(
  record: Readonly<Record<string, TValue>>,
  key: string,
): TValue | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function asStorageError(error: unknown): ArtifactStoreError {
  if (error instanceof ArtifactStoreError) {
    return error;
  }
  return new ArtifactStoreError(
    "ARTIFACT_STORAGE_UNAVAILABLE",
    "Artifact storage operation failed.",
  );
}

function asRepositoryStorageError(error: unknown): ArtifactStoreError {
  if (error instanceof ArtifactStoreError) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "DATA_CORRUPT"
  ) {
    return new ArtifactStoreError(
      "ARTIFACT_STORAGE_CORRUPT",
      "The durable Artifact index failed integrity validation.",
    );
  }
  return asStorageError(error);
}
