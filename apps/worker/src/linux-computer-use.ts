import {
  ComputerUseOsBackend,
  LinuxNativeComputerUseDriver,
  startLinuxNativeHelperChildProcess,
  type ComputerUseClock,
  type ComputerUseInputAuthorizer,
  type ComputerUseLogger,
  type ComputerUseReadinessReport,
  type ComputerUseStartHistory,
  type DesktopAuthorityPort,
  type DesktopLeasePort,
  type LinuxAuthenticatedHelperSession,
  type LinuxNativeHelperBinaryVerifier,
  type LinuxNativeHelperChildTransportFactory,
  type LinuxNativeHelperDesktopEnvironment,
  type LinuxNativeHelperPort,
  type LinuxNativeHelperRequestIdSource,
} from "@opendelegate/computer-use-os";

import type { WorkerComputerUseCapabilityProbe } from "./worker-app.ts";

export interface LinuxWorkerComputerUseHelperConfiguration {
  readonly executablePath: string;
  readonly expectedExecutableSha256: `sha256:${string}`;
  readonly desktopEnvironment: LinuxNativeHelperDesktopEnvironment;
  readonly fixtureResultDirectory?: string;
}

export interface LinuxWorkerComputerUseCompositionOptions {
  readonly authenticatedSession: LinuxAuthenticatedHelperSession;
  readonly deviceId: string;
  readonly persistenceGeneration: number;
  readonly helperConfiguration: LinuxWorkerComputerUseHelperConfiguration;
  readonly authority: DesktopAuthorityPort;
  readonly leases: DesktopLeasePort;
  readonly startHistory: ComputerUseStartHistory;
  readonly authorizer: ComputerUseInputAuthorizer;
  readonly clock: ComputerUseClock;
  readonly logger: ComputerUseLogger;
  readonly operationTimeoutMs?: number;
  readonly hostPlatform?: NodeJS.Platform;
  readonly binaryVerifier?: LinuxNativeHelperBinaryVerifier;
  readonly transportFactory?: LinuxNativeHelperChildTransportFactory;
  readonly requestIdSource?: LinuxNativeHelperRequestIdSource;
  /**
   * Explicit native boundary for platform-lab and composition tests. A production
   * core must receive this only from the ADR-0011 authenticated user-session
   * helper; arbitrary Worker Runs never construct it.
   */
  readonly nativeHelper?: LinuxNativeHelperPort;
}

export interface LinuxWorkerComputerUseComposition {
  readonly backend: ComputerUseOsBackend;
  readonly capabilityProbe: WorkerComputerUseCapabilityProbe;
  readiness(): Promise<ComputerUseReadinessReport>;
  close(): Promise<void>;
}

/**
 * Composes the target-native helper with deterministic authority, Policy, durable
 * start history, and lease/fence verification. It does not acquire a desktop lease
 * or relax Policy; those remain Worker-owned boundaries.
 */
export async function createLinuxWorkerComputerUseComposition(
  options: LinuxWorkerComputerUseCompositionOptions,
): Promise<LinuxWorkerComputerUseComposition> {
  validateCompositionIdentity(options);
  const helper =
    options.nativeHelper ??
    (await startLinuxNativeHelperChildProcess({
      authenticatedSession: options.authenticatedSession,
      executablePath: options.helperConfiguration.executablePath,
      expectedExecutableSha256: options.helperConfiguration.expectedExecutableSha256,
      desktopEnvironment: { ...options.helperConfiguration.desktopEnvironment },
      ...(options.helperConfiguration.fixtureResultDirectory === undefined
        ? {}
        : { fixtureResultDirectory: options.helperConfiguration.fixtureResultDirectory }),
      ...(options.hostPlatform === undefined ? {} : { hostPlatform: options.hostPlatform }),
      ...(options.binaryVerifier === undefined ? {} : { binaryVerifier: options.binaryVerifier }),
      ...(options.transportFactory === undefined
        ? {}
        : { transportFactory: options.transportFactory }),
      ...(options.requestIdSource === undefined
        ? {}
        : { requestIdSource: options.requestIdSource }),
    }));
  const driver = new LinuxNativeComputerUseDriver({ helper });
  const backend = new ComputerUseOsBackend({
    osFamily: "linux",
    driver,
    authority: options.authority,
    leases: options.leases,
    startHistory: options.startHistory,
    authorizer: options.authorizer,
    clock: options.clock,
    logger: options.logger,
    ...(options.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: options.operationTimeoutMs }),
  });
  const readiness = (): Promise<ComputerUseReadinessReport> =>
    backend.readiness({
      deviceId: options.deviceId,
      helperInstanceId: options.authenticatedSession.helperInstanceId,
      serviceEpoch: options.authenticatedSession.serviceEpoch,
      persistenceGeneration: options.persistenceGeneration,
    });
  const capabilityProbe: WorkerComputerUseCapabilityProbe = Object.freeze({
    async probe() {
      const report = await readiness();
      if (
        report.status === "ready" &&
        report.displayFingerprint !== null &&
        report.checks.every((check) => check.status === "pass")
      ) {
        return Object.freeze({ verification: "verified" as const });
      }
      const check = (name: string): string | undefined =>
        report.checks.find((candidate) => candidate.name === name)?.status;
      return Object.freeze({
        verification:
          check("interactive-session") === "pass" && check("helper-authentication") === "pass"
            ? ("degraded" as const)
            : ("unavailable" as const),
      });
    },
  });
  let closed = false;
  return Object.freeze({
    backend,
    capabilityProbe,
    readiness,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await helper.close?.().catch(() => undefined);
    },
  });
}

function validateCompositionIdentity(options: LinuxWorkerComputerUseCompositionOptions): void {
  if (
    typeof options.deviceId !== "string" ||
    options.deviceId.length === 0 ||
    options.deviceId !== options.deviceId.trim() ||
    !Number.isSafeInteger(options.persistenceGeneration) ||
    options.persistenceGeneration <= 0
  ) {
    throw new TypeError("The Linux Computer Use Device authority binding is invalid.");
  }
}
