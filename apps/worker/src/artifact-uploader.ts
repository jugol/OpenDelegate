import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  parseArtifactUploadGrant,
  parseArtifactUploadProgress,
  type ArtifactUploadGrantV1,
  type ArtifactUploadProgressV1,
} from "@opendelegate/protocol";

const DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;

export type WorkerArtifactUploadErrorCode =
  | "GRANT_EXPIRED"
  | "PROGRESS_INVALID"
  | "RECOVERY_EXHAUSTED"
  | "SOURCE_CHECKSUM_MISMATCH"
  | "SOURCE_SIZE_MISMATCH"
  | "SOURCE_UNSAFE";

export class WorkerArtifactUploadError extends Error {
  public readonly code: WorkerArtifactUploadErrorCode;

  public constructor(code: WorkerArtifactUploadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerArtifactUploadError";
    this.code = code;
  }
}

export type WorkerArtifactUploadTransportErrorCode =
  | "AUTHORIZATION_REJECTED"
  | "CHECKSUM_REJECTED"
  | "OFFSET_REJECTED"
  | "REQUEST_REJECTED"
  | "SERVICE_UNAVAILABLE";

export class WorkerArtifactUploadTransportError extends Error {
  public readonly code: WorkerArtifactUploadTransportErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: WorkerArtifactUploadTransportErrorCode,
    retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "WorkerArtifactUploadTransportError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface WorkerArtifactUploadTransport {
  probe(input: {
    readonly url: string;
    readonly credential: string;
  }): Promise<ArtifactUploadProgressV1>;
  append(input: {
    readonly url: string;
    readonly credential: string;
    readonly idempotencyKey: string;
    readonly offsetBytes: number;
    readonly bytes: Uint8Array;
  }): Promise<ArtifactUploadProgressV1>;
}

export interface WorkerArtifactUploaderClock {
  nowMs(): number;
}

export interface WorkerArtifactUploaderOptions {
  readonly transport: WorkerArtifactUploadTransport;
  readonly clock?: WorkerArtifactUploaderClock;
  readonly maximumRecoveryAttempts?: number;
}

export class WorkerArtifactUploader {
  readonly #transport: WorkerArtifactUploadTransport;
  readonly #clock: WorkerArtifactUploaderClock;
  readonly #maximumRecoveryAttempts: number;

  public constructor(options: WorkerArtifactUploaderOptions) {
    this.#transport = options.transport;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    const maximumRecoveryAttempts =
      options.maximumRecoveryAttempts ?? DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS;
    if (
      !Number.isSafeInteger(maximumRecoveryAttempts) ||
      maximumRecoveryAttempts < 0 ||
      maximumRecoveryAttempts > 100
    ) {
      throw new WorkerArtifactUploadError(
        "PROGRESS_INVALID",
        "Artifact upload recovery limit is invalid.",
      );
    }
    this.#maximumRecoveryAttempts = maximumRecoveryAttempts;
  }

  public async upload(input: {
    readonly grant: ArtifactUploadGrantV1;
    readonly sourcePath: string;
  }): Promise<ArtifactUploadProgressV1> {
    const grant = parseArtifactUploadGrant(input.grant);
    requireActiveGrant(grant, this.#clock);
    const path = requireSafeAbsolutePath(input.sourcePath);
    const pathInfo = await lstat(path).catch((error: unknown) => {
      throw new WorkerArtifactUploadError("SOURCE_UNSAFE", "Artifact source is unavailable.", {
        cause: error,
      });
    });
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new WorkerArtifactUploadError(
        "SOURCE_UNSAFE",
        "Artifact source must be a regular file, not a link.",
      );
    }

    const handle = await open(path, "r").catch((error: unknown) => {
      throw new WorkerArtifactUploadError(
        "SOURCE_UNSAFE",
        "Artifact source could not be opened safely.",
        { cause: error },
      );
    });
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.size !== grant.declaredSizeBytes) {
        throw new WorkerArtifactUploadError(
          "SOURCE_SIZE_MISMATCH",
          "Artifact source size does not match the Main-issued grant.",
        );
      }
      const sourceDigest = await hashOpenFile(handle);
      if (sourceDigest !== grant.expectedSha256) {
        throw new WorkerArtifactUploadError(
          "SOURCE_CHECKSUM_MISMATCH",
          "Artifact source checksum does not match the Main-issued grant.",
        );
      }

      let recoveryAttempts = 0;
      let progress = await this.#probeWithRecovery(grant, () => {
        recoveryAttempts += 1;
        return recoveryAttempts;
      });
      validateProgress(progress, grant);
      while (!progress.complete) {
        requireActiveGrant(grant, this.#clock);
        const offsetBytes = progress.nextOffsetBytes;
        if (offsetBytes >= grant.declaredSizeBytes) {
          throw new WorkerArtifactUploadError(
            "PROGRESS_INVALID",
            "Main reported terminal upload bytes without completion.",
          );
        }
        const sizeBytes = Math.min(grant.maximumChunkBytes, grant.declaredSizeBytes - offsetBytes);
        const bytes = await readExactChunk(handle, offsetBytes, sizeBytes);
        const idempotencyKey = chunkIdempotencyKey(
          grant.uploadId,
          offsetBytes,
          bytes.byteLength,
          grant.expectedSha256,
        );
        try {
          const next = await this.#transport.append({
            url: grant.uploadUrl,
            credential: grant.credential,
            idempotencyKey,
            offsetBytes,
            bytes,
          });
          validateProgress(next, grant);
          if (!next.complete && next.nextOffsetBytes <= offsetBytes) {
            throw new WorkerArtifactUploadError(
              "PROGRESS_INVALID",
              "Artifact upload did not make durable progress.",
            );
          }
          progress = next;
          recoveryAttempts = 0;
        } catch (error) {
          if (error instanceof WorkerArtifactUploadTransportError && !error.retryable) {
            throw error;
          }
          recoveryAttempts += 1;
          if (recoveryAttempts > this.#maximumRecoveryAttempts) {
            throw new WorkerArtifactUploadError(
              "RECOVERY_EXHAUSTED",
              "Artifact upload recovery attempts were exhausted.",
              { cause: error },
            );
          }
          progress = await this.#probeWithRecovery(grant, () => {
            recoveryAttempts += 1;
            return recoveryAttempts;
          });
          validateProgress(progress, grant);
        }
      }
      const finalInfo = await handle.stat();
      if (
        finalInfo.size !== openedInfo.size ||
        finalInfo.mtimeMs !== openedInfo.mtimeMs ||
        finalInfo.ctimeMs !== openedInfo.ctimeMs
      ) {
        throw new WorkerArtifactUploadError(
          "SOURCE_UNSAFE",
          "Artifact source changed during upload.",
        );
      }
      return progress;
    } finally {
      await handle.close();
    }
  }

  async #probeWithRecovery(
    grant: ArtifactUploadGrantV1,
    nextAttempt: () => number,
  ): Promise<ArtifactUploadProgressV1> {
    while (true) {
      try {
        return await this.#transport.probe({
          url: grant.uploadUrl,
          credential: grant.credential,
        });
      } catch (error) {
        if (error instanceof WorkerArtifactUploadTransportError && !error.retryable) {
          throw error;
        }
        if (nextAttempt() > this.#maximumRecoveryAttempts) {
          throw new WorkerArtifactUploadError(
            "RECOVERY_EXHAUSTED",
            "Artifact upload progress could not be recovered.",
            { cause: error },
          );
        }
      }
    }
  }
}

export class FetchWorkerArtifactUploadTransport implements WorkerArtifactUploadTransport {
  readonly #timeoutMs: number;

  public constructor(options: { readonly timeoutMs?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5 * 60 * 1_000) {
      throw new WorkerArtifactUploadTransportError(
        "REQUEST_REJECTED",
        false,
        "Artifact upload request timeout is invalid.",
      );
    }
    this.#timeoutMs = timeoutMs;
  }

  public async probe(input: {
    readonly url: string;
    readonly credential: string;
  }): Promise<ArtifactUploadProgressV1> {
    return this.#request(input.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.credential}`,
      },
    });
  }

  public async append(input: {
    readonly url: string;
    readonly credential: string;
    readonly idempotencyKey: string;
    readonly offsetBytes: number;
    readonly bytes: Uint8Array;
  }): Promise<ArtifactUploadProgressV1> {
    return this.#request(input.url, {
      method: "PUT",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.credential}`,
        "content-length": String(input.bytes.byteLength),
        "content-type": "application/octet-stream",
        "idempotency-key": input.idempotencyKey,
        "upload-offset": String(input.offsetBytes),
      },
      body: Buffer.from(input.bytes),
    });
  }

  async #request(url: string, init: RequestInit): Promise<ArtifactUploadProgressV1> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new WorkerArtifactUploadTransportError(
        "SERVICE_UNAVAILABLE",
        true,
        "Main Artifact upload endpoint is unavailable.",
      );
    }
    if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      let responseCode: string | undefined;
      try {
        const problem = JSON.parse(
          await readBoundedResponse(response, MAXIMUM_RESPONSE_BYTES),
        ) as unknown;
        if (
          typeof problem === "object" &&
          problem !== null &&
          "code" in problem &&
          typeof problem.code === "string"
        ) {
          responseCode = problem.code;
        }
      } catch {
        responseCode = undefined;
      }
      throw transportStatusError(response.status, responseCode);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBoundedResponse(response, MAXIMUM_RESPONSE_BYTES));
    } catch {
      throw new WorkerArtifactUploadTransportError(
        "REQUEST_REJECTED",
        false,
        "Main returned an invalid Artifact upload response.",
      );
    }
    try {
      return parseArtifactUploadProgress(parsed);
    } catch {
      throw new WorkerArtifactUploadTransportError(
        "REQUEST_REJECTED",
        false,
        "Main returned Artifact upload progress outside the protocol contract.",
      );
    }
  }
}

function requireSafeAbsolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    resolve(value) !== value
  ) {
    throw new WorkerArtifactUploadError(
      "SOURCE_UNSAFE",
      "Artifact source path must be normalized and absolute.",
    );
  }
  return value;
}

function requireActiveGrant(
  grant: ArtifactUploadGrantV1,
  clock: WorkerArtifactUploaderClock,
): void {
  const currentTime = clock.nowMs();
  if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
    throw new WorkerArtifactUploadError("PROGRESS_INVALID", "Artifact upload clock is invalid.");
  }
  if (grant.expiresAtMs <= currentTime) {
    throw new WorkerArtifactUploadError("GRANT_EXPIRED", "Artifact upload grant expired.");
  }
}

function validateProgress(progress: ArtifactUploadProgressV1, grant: ArtifactUploadGrantV1): void {
  const parsed = parseArtifactUploadProgress(progress);
  if (
    parsed.uploadId !== grant.uploadId ||
    parsed.artifactId !== grant.artifactId ||
    parsed.nextOffsetBytes > grant.declaredSizeBytes ||
    (parsed.complete && parsed.nextOffsetBytes !== grant.declaredSizeBytes)
  ) {
    throw new WorkerArtifactUploadError(
      "PROGRESS_INVALID",
      "Main returned progress outside the upload grant.",
    );
  }
}

async function hashOpenFile(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const hash = createHash("sha256");
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function readExactChunk(
  handle: Awaited<ReturnType<typeof open>>,
  offsetBytes: number,
  sizeBytes: number,
): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(sizeBytes);
  let readBytes = 0;
  while (readBytes < sizeBytes) {
    const result = await handle.read(
      bytes,
      readBytes,
      sizeBytes - readBytes,
      offsetBytes + readBytes,
    );
    if (result.bytesRead < 1) {
      throw new WorkerArtifactUploadError(
        "SOURCE_SIZE_MISMATCH",
        "Artifact source ended before its granted size.",
      );
    }
    readBytes += result.bytesRead;
  }
  return bytes;
}

function chunkIdempotencyKey(
  uploadId: string,
  offsetBytes: number,
  sizeBytes: number,
  expectedSha256: string,
): string {
  return `chunk:${uploadId}:${String(offsetBytes)}:${String(sizeBytes)}:${expectedSha256.slice(0, 16)}`;
}

function transportStatusError(
  status: number,
  responseCode?: string,
): WorkerArtifactUploadTransportError {
  if (status === 404 || status === 401 || status === 403) {
    return new WorkerArtifactUploadTransportError(
      "AUTHORIZATION_REJECTED",
      false,
      "Main rejected the Artifact upload grant.",
    );
  }
  if (status === 409) {
    if (
      responseCode === "UPLOAD_PUBLICATION_CONFLICT" ||
      responseCode === "UPLOAD_IDEMPOTENCY_CONFLICT"
    ) {
      return new WorkerArtifactUploadTransportError(
        "REQUEST_REJECTED",
        false,
        "Main rejected an immutable Artifact upload identity.",
      );
    }
    return new WorkerArtifactUploadTransportError(
      "OFFSET_REJECTED",
      true,
      "Main reported different durable Artifact upload progress.",
    );
  }
  if (status === 422) {
    return new WorkerArtifactUploadTransportError(
      "CHECKSUM_REJECTED",
      false,
      "Main rejected the uploaded Artifact checksum.",
    );
  }
  if (status === 429 || status >= 500) {
    return new WorkerArtifactUploadTransportError(
      "SERVICE_UNAVAILABLE",
      true,
      "Main Artifact upload endpoint is temporarily unavailable.",
    );
  }
  return new WorkerArtifactUploadTransportError(
    "REQUEST_REJECTED",
    false,
    "Main rejected the Artifact upload request.",
  );
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) {
    throw new Error("Artifact upload response is empty.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      sizeBytes += result.value.byteLength;
      if (sizeBytes > maximumBytes) {
        throw new Error("Artifact upload response exceeded its byte limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
