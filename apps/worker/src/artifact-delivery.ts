import type { ArtifactPrepareManifestV1 } from "@opendelegate/device-channel";
import {
  parseArtifactUploadGrant,
  parseArtifactUploadProgress,
  type ArtifactUploadGrantV1,
  type ArtifactUploadProgressV1,
} from "@opendelegate/protocol";

export interface WorkerArtifactDeliveryChannelPort {
  prepareArtifact(manifest: ArtifactPrepareManifestV1): Promise<ArtifactUploadGrantV1>;
}

export interface WorkerArtifactDeliveryUploadPort {
  upload(input: {
    readonly grant: ArtifactUploadGrantV1;
    readonly sourcePath: string;
  }): Promise<ArtifactUploadProgressV1>;
}

export interface WorkerArtifactDeliveryCoordinatorOptions {
  readonly channel: WorkerArtifactDeliveryChannelPort;
  readonly uploader: WorkerArtifactDeliveryUploadPort;
}

export type WorkerArtifactDeliveryErrorCode =
  "GRANT_SCOPE_MISMATCH" | "RUN_AUTHORITY_LOST" | "UPLOAD_INCOMPLETE";

export class WorkerArtifactDeliveryError extends Error {
  public readonly code: WorkerArtifactDeliveryErrorCode;

  public constructor(code: WorkerArtifactDeliveryErrorCode, message: string) {
    super(message);
    this.name = "WorkerArtifactDeliveryError";
    this.code = code;
  }
}

export class WorkerArtifactDeliveryCoordinator {
  readonly #channel: WorkerArtifactDeliveryChannelPort;
  readonly #uploader: WorkerArtifactDeliveryUploadPort;

  public constructor(options: WorkerArtifactDeliveryCoordinatorOptions) {
    this.#channel = options.channel;
    this.#uploader = options.uploader;
  }

  public async deliver(input: {
    readonly manifest: ArtifactPrepareManifestV1;
    readonly sourcePath: string;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<ArtifactUploadProgressV1> {
    await requireCurrentExecution(input.isExecutionCurrent);
    const grant = parseArtifactUploadGrant(await this.#channel.prepareArtifact(input.manifest));
    if (
      grant.artifactId !== input.manifest.artifactId ||
      grant.declaredSizeBytes !== input.manifest.declaredSizeBytes ||
      grant.expectedSha256 !== input.manifest.expectedSha256
    ) {
      throw new WorkerArtifactDeliveryError(
        "GRANT_SCOPE_MISMATCH",
        "Main returned an Artifact grant outside the immutable prepare manifest.",
      );
    }
    await requireCurrentExecution(input.isExecutionCurrent);
    const progress = parseArtifactUploadProgress(
      await this.#uploader.upload({
        grant,
        sourcePath: input.sourcePath,
      }),
    );
    if (
      !progress.complete ||
      progress.uploadId !== grant.uploadId ||
      progress.artifactId !== grant.artifactId ||
      progress.nextOffsetBytes !== grant.declaredSizeBytes
    ) {
      throw new WorkerArtifactDeliveryError(
        "UPLOAD_INCOMPLETE",
        "Artifact delivery did not finish at its granted durable boundary.",
      );
    }
    await requireCurrentExecution(input.isExecutionCurrent);
    return progress;
  }
}

async function requireCurrentExecution(isExecutionCurrent: () => Promise<boolean>): Promise<void> {
  try {
    if ((await isExecutionCurrent()) === true) {
      return;
    }
  } catch {
    throw runAuthorityLostError();
  }
  throw runAuthorityLostError();
}

function runAuthorityLostError(): WorkerArtifactDeliveryError {
  return new WorkerArtifactDeliveryError(
    "RUN_AUTHORITY_LOST",
    "Artifact delivery stopped because the Worker Run authority is no longer current.",
  );
}
