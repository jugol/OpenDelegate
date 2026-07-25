import {
  ComputerUseOsBackend,
  MacOsNativeComputerUseDriver,
  startMacOsNativeHelperChildProcess,
  type ComputerUseClock,
  type ComputerUseInputAuthorizer,
  type ComputerUseLogger,
  type ComputerUseReadinessReport,
  type ComputerUseStartHistory,
  type DesktopAuthorityPort,
  type DesktopLeasePort,
  type MacOsAuthenticatedHelperSession,
  type MacOsNativeHelperBinaryVerifier,
  type MacOsNativeHelperChildTransportFactory,
  type MacOsNativeHelperPort,
  type MacOsNativeHelperRequestIdSource,
} from "@opendelegate/computer-use-os";

import type { WorkerComputerUseCapabilityProbe } from "./worker-app.ts";

export interface MacOsWorkerComputerUseHelperConfiguration {
  readonly executablePath: string;
  readonly expectedExecutableSha256: `sha256:${string}`;
  readonly fixtureResultDirectory?: string;
}

export interface MacOsWorkerComputerUseCompositionOptions {
  readonly authenticatedSession: MacOsAuthenticatedHelperSession;
  readonly deviceId: string;
  readonly persistenceGeneration: number;
  readonly helperConfiguration: MacOsWorkerComputerUseHelperConfiguration;
  readonly authority: DesktopAuthorityPort;
  readonly leases: DesktopLeasePort;
  readonly startHistory: ComputerUseStartHistory;
  readonly authorizer: ComputerUseInputAuthorizer;
  readonly clock: ComputerUseClock;
  readonly logger: ComputerUseLogger;
  readonly operationTimeoutMs?: number;
  readonly hostPlatform?: NodeJS.Platform;
  readonly binaryVerifier?: MacOsNativeHelperBinaryVerifier;
  readonly transportFactory?: MacOsNativeHelperChildTransportFactory;
  readonly requestIdSource?: MacOsNativeHelperRequestIdSource;
  /**
   * Explicit native boundary for platform-lab and composition tests. Production
   * receives this port only from the authenticated Aqua session helper.
   */
  readonly nativeHelper?: MacOsNativeHelperPort;
}

export interface MacOsWorkerComputerUseComposition {
  readonly backend: ComputerUseOsBackend;
  readonly capabilityProbe: WorkerComputerUseCapabilityProbe;
  readiness(): Promise<ComputerUseReadinessReport>;
  close(): Promise<void>;
}

/**
 * Composes the signed macOS AX/ScreenCaptureKit/CGEvent child behind the
 * authenticated ADR-0011 Aqua session boundary.
 */
export async function createMacOsWorkerComputerUseComposition(
  options: MacOsWorkerComputerUseCompositionOptions,
): Promise<MacOsWorkerComputerUseComposition> {
  validateOptions(options);
  const helper =
    options.nativeHelper ??
    (await startMacOsNativeHelperChildProcess({
      authenticatedSession: options.authenticatedSession,
      executablePath: options.helperConfiguration.executablePath,
      expectedExecutableSha256: options.helperConfiguration.expectedExecutableSha256,
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
  const driver = new MacOsNativeComputerUseDriver({ helper });
  const backend = new ComputerUseOsBackend({
    osFamily: "macos",
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
  let closed = false;
  return Object.freeze({
    backend,
    capabilityProbe: capabilityProbe(readiness),
    readiness,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      const close = (helper as MacOsNativeHelperPort & { close?: () => Promise<void> }).close;
      if (typeof close === "function") {
        await close.call(helper).catch(() => undefined);
      }
    },
  });
}

function capabilityProbe(
  readiness: () => Promise<ComputerUseReadinessReport>,
): WorkerComputerUseCapabilityProbe {
  return Object.freeze({
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
}

function validateOptions(options: MacOsWorkerComputerUseCompositionOptions): void {
  if (
    !validIdentifier(options.deviceId) ||
    !Number.isSafeInteger(options.persistenceGeneration) ||
    options.persistenceGeneration <= 0 ||
    options.authenticatedSession.authentication !== "adr-0011-ed25519-v2" ||
    !validIdentifier(options.authenticatedSession.helperInstanceId) ||
    !validIdentifier(options.authenticatedSession.osSessionIdentity) ||
    !validIdentifier(options.authenticatedSession.releaseVersion) ||
    !Number.isSafeInteger(options.authenticatedSession.serviceEpoch) ||
    options.authenticatedSession.serviceEpoch <= 0
  ) {
    throw new TypeError("The macOS Computer Use helper authority binding is invalid.");
  }
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 512
  );
}
