import {
  ArtifactAccessError,
  type ArtifactExposurePolicy,
  type ArtifactPresentation,
  type ArtifactRetentionPolicy,
  type IssueArtifactUploadGrant,
} from "@opendelegate/artifact-store";
import type {
  ArtifactPrepareManifestV1,
  MainArtifactPrepareDecision,
  MainArtifactPrepareRequest,
} from "@opendelegate/device-channel";
import type { ArtifactUploadGrantV1 } from "@opendelegate/protocol";
import type {
  WorkerArtifactRunAuthorization,
  WorkerArtifactRunScope,
} from "@opendelegate/task-service";

const DEFAULT_MAXIMUM_GRANT_TTL_MS = 15 * 60_000;
const MAXIMUM_GRANT_TTL_MS = 60 * 60_000;

export interface DefaultMainArtifactPreparePolicyOptions {
  readonly exposureMode: "private-network" | "authenticated" | "signed-link" | "public" | "custom";
}

export interface MainArtifactRunAuthorityPort {
  authorizeWorkerArtifactRun(
    authenticatedDeviceId: string,
    scope: WorkerArtifactRunScope,
  ): Promise<WorkerArtifactRunAuthorization>;
}

export type MainArtifactPreparePolicyDecision =
  | {
      readonly status: "allowed";
      readonly retentionPolicy: ArtifactRetentionPolicy;
      readonly exposurePolicy: ArtifactExposurePolicy;
      readonly presentation?: ArtifactPresentation;
    }
  | {
      readonly status: "rejected";
      readonly retryable: boolean;
    };

export interface MainArtifactPreparePolicyPort {
  resolve(input: {
    readonly authenticatedDeviceId: string;
    readonly manifest: ArtifactPrepareManifestV1;
    readonly run: Extract<WorkerArtifactRunAuthorization, { readonly authorized: true }>;
  }): Promise<MainArtifactPreparePolicyDecision>;
}

export interface MainArtifactGrantRuntimePort {
  issueWorkerUploadGrant(input: IssueArtifactUploadGrant): Promise<ArtifactUploadGrantV1>;
}

export interface MainArtifactPrepareServiceOptions {
  readonly runAuthority: MainArtifactRunAuthorityPort;
  readonly policy: MainArtifactPreparePolicyPort;
  readonly artifactRuntime: MainArtifactGrantRuntimePort;
  readonly clock: { nowMs(): number };
  readonly maximumGrantTtlMs?: number;
}

/**
 * Conservative first-party policy used when the owner has not supplied a
 * richer policy adapter. A Worker may request presentation, but cannot turn a
 * report into executable HTML or choose its own exposure authority.
 */
export function createDefaultMainArtifactPreparePolicy(
  options: DefaultMainArtifactPreparePolicyOptions,
): MainArtifactPreparePolicyPort {
  if (
    !["private-network", "authenticated", "signed-link", "public", "custom"].includes(
      options.exposureMode,
    )
  ) {
    throw new TypeError("The default Artifact exposure mode is invalid.");
  }
  const policy: MainArtifactPreparePolicyPort = {
    async resolve(input): Promise<MainArtifactPreparePolicyDecision> {
      const { manifest } = input;
      if (
        options.exposureMode === "custom" ||
        manifest.requestedPresentation === "interactive-html"
      ) {
        return Object.freeze({ status: "rejected", retryable: false });
      }
      const presentation =
        manifest.requestedPresentation ??
        (manifest.mediaType === "text/html"
          ? "static-html"
          : manifest.mediaType === "image/svg+xml"
            ? "download"
            : manifest.mediaType.startsWith("image/") ||
                manifest.mediaType === "application/pdf" ||
                manifest.mediaType.startsWith("text/")
              ? "inline"
              : "download");
      return Object.freeze({
        status: "allowed",
        retentionPolicy: Object.freeze({ kind: "task" as const }),
        exposurePolicy: Object.freeze({ mode: options.exposureMode }),
        presentation,
      });
    },
  };
  return Object.freeze(policy);
}

export class MainArtifactPrepareService {
  readonly #runAuthority: MainArtifactRunAuthorityPort;
  readonly #policy: MainArtifactPreparePolicyPort;
  readonly #artifactRuntime: MainArtifactGrantRuntimePort;
  readonly #clock: { nowMs(): number };
  readonly #maximumGrantTtlMs: number;

  public constructor(options: MainArtifactPrepareServiceOptions) {
    const maximumGrantTtlMs = options.maximumGrantTtlMs ?? DEFAULT_MAXIMUM_GRANT_TTL_MS;
    if (
      !Number.isSafeInteger(maximumGrantTtlMs) ||
      maximumGrantTtlMs < 1 ||
      maximumGrantTtlMs > MAXIMUM_GRANT_TTL_MS
    ) {
      throw new TypeError("Artifact upload grant TTL must be between 1 and 3600000 milliseconds.");
    }
    this.#runAuthority = options.runAuthority;
    this.#policy = options.policy;
    this.#artifactRuntime = options.artifactRuntime;
    this.#clock = options.clock;
    this.#maximumGrantTtlMs = maximumGrantTtlMs;
  }

  public async prepare(input: MainArtifactPrepareRequest): Promise<MainArtifactPrepareDecision> {
    if (input.manifest.deviceId !== input.authenticatedDeviceId) {
      return rejected("RUN_NOT_CURRENT", false);
    }
    const scope = runScope(input.manifest);
    let run: WorkerArtifactRunAuthorization;
    try {
      run = await this.#runAuthority.authorizeWorkerArtifactRun(input.authenticatedDeviceId, scope);
    } catch {
      return rejected("SERVICE_UNAVAILABLE", true);
    }
    if (!run.authorized) {
      return rejected("RUN_NOT_CURRENT", false);
    }

    const currentTime = this.#now();
    const expiresAtMs = Math.min(run.leaseExpiresAtMs, currentTime + this.#maximumGrantTtlMs);
    if (expiresAtMs <= currentTime) {
      return rejected("RUN_NOT_CURRENT", false);
    }

    let policy: MainArtifactPreparePolicyDecision;
    try {
      policy = await this.#policy.resolve({
        authenticatedDeviceId: input.authenticatedDeviceId,
        manifest: input.manifest,
        run,
      });
    } catch {
      return rejected("SERVICE_UNAVAILABLE", true);
    }
    if (policy.status === "rejected") {
      return rejected("POLICY_REJECTED", policy.retryable);
    }

    try {
      const grant = await this.#artifactRuntime.issueWorkerUploadGrant({
        artifactId: input.manifest.artifactId,
        taskId: input.manifest.taskId,
        producingRunId: input.manifest.runId,
        mediaType: input.manifest.mediaType,
        originalFilename: input.manifest.originalFilename,
        declaredSizeBytes: input.manifest.declaredSizeBytes,
        expectedChecksum: {
          algorithm: "sha256",
          value: input.manifest.expectedSha256,
        },
        createdAtMs: currentTime,
        retentionPolicy: policy.retentionPolicy,
        exposurePolicy: policy.exposurePolicy,
        provenance: {
          deviceId: input.authenticatedDeviceId,
          ...(run.workspaceId === undefined ? {} : { workspaceId: run.workspaceId }),
          source: "worker-upload",
        },
        ...(policy.presentation === undefined ? {} : { presentation: policy.presentation }),
        expiresAtMs,
        context: {
          actor: { type: "device", id: input.authenticatedDeviceId },
          correlationId: input.correlationId,
        },
      });
      return Object.freeze({ status: "granted", grant });
    } catch (error) {
      if (
        error instanceof ArtifactAccessError &&
        (error.code === "UPLOAD_GRANT_INVALID" ||
          error.code === "UPLOAD_PUBLICATION_CONFLICT" ||
          error.code === "UPLOAD_CHECKSUM_MISMATCH")
      ) {
        return rejected("ARTIFACT_INVALID", false);
      }
      return rejected("SERVICE_UNAVAILABLE", true);
    }
  }

  #now(): number {
    const value = this.#clock.nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Artifact prepare clock must return a non-negative safe integer.");
    }
    return value;
  }
}

function runScope(manifest: ArtifactPrepareManifestV1): WorkerArtifactRunScope {
  return Object.freeze({
    taskId: manifest.taskId,
    workOrderId: manifest.workOrderId,
    deviceId: manifest.deviceId,
    workerId: manifest.workerId,
    routeId: manifest.routeId,
    runId: manifest.runId,
    leaseId: manifest.leaseId,
    fencingToken: manifest.fencingToken,
  });
}

function rejected(
  code: Extract<MainArtifactPrepareDecision, { status: "rejected" }>["code"],
  retryable: boolean,
): MainArtifactPrepareDecision {
  return Object.freeze({ status: "rejected", code, retryable });
}
