import {
  ComputerUseOsBackend,
  createWindowsNativeComputerUseDriver,
  type ComputerUseClock,
  type ComputerUseInputAuthorizer,
  type ComputerUseLogger,
  type ComputerUseReadinessReport,
  type ComputerUseStartHistory,
  type DesktopAuthorityPort,
  type DesktopLeasePort,
  type WindowsAuthenticatedHelperPort,
} from "@opendelegate/computer-use-os";

import type { WorkerComputerUseCapabilityProbe } from "./worker-app.ts";

export interface WindowsWorkerComputerUseHelperBinding {
  readonly helperInstanceId: string;
  readonly serviceEpoch: number;
  readonly sessionIdentity: string;
  readonly releaseVersion: string;
}

export interface WindowsWorkerComputerUseCompositionOptions {
  readonly deviceId: string;
  readonly persistenceGeneration: number;
  readonly helper: WindowsAuthenticatedHelperPort;
  readonly helperBinding: WindowsWorkerComputerUseHelperBinding;
  readonly authority: DesktopAuthorityPort;
  readonly leases: DesktopLeasePort;
  readonly startHistory: ComputerUseStartHistory;
  readonly authorizer: ComputerUseInputAuthorizer;
  readonly clock: ComputerUseClock;
  readonly logger: ComputerUseLogger;
  readonly operationTimeoutMs?: number;
}

export interface WindowsWorkerComputerUseComposition {
  readonly backend: ComputerUseOsBackend;
  readonly capabilityProbe: WorkerComputerUseCapabilityProbe;
  readiness(): Promise<ComputerUseReadinessReport>;
  close(): Promise<void>;
}

/**
 * Binds the Windows UIA/WGC/SendInput driver to the already-authenticated
 * ADR-0011 session helper and the Worker-owned deterministic policy boundaries.
 */
export function createWindowsWorkerComputerUseComposition(
  options: WindowsWorkerComputerUseCompositionOptions,
): WindowsWorkerComputerUseComposition {
  validateOptions(options);
  const driver = createWindowsNativeComputerUseDriver({
    helper: options.helper,
    expectedHelperInstanceId: options.helperBinding.helperInstanceId,
    expectedServiceEpoch: options.helperBinding.serviceEpoch,
    expectedSessionIdentity: options.helperBinding.sessionIdentity,
    releaseVersion: options.helperBinding.releaseVersion,
  });
  const backend = new ComputerUseOsBackend({
    osFamily: "windows",
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
      helperInstanceId: options.helperBinding.helperInstanceId,
      serviceEpoch: options.helperBinding.serviceEpoch,
      persistenceGeneration: options.persistenceGeneration,
    });
  return Object.freeze({
    backend,
    capabilityProbe: capabilityProbe(readiness),
    readiness,
    async close() {},
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

function validateOptions(options: WindowsWorkerComputerUseCompositionOptions): void {
  if (
    !validIdentifier(options.deviceId) ||
    !Number.isSafeInteger(options.persistenceGeneration) ||
    options.persistenceGeneration <= 0 ||
    !validIdentifier(options.helperBinding.helperInstanceId) ||
    !Number.isSafeInteger(options.helperBinding.serviceEpoch) ||
    options.helperBinding.serviceEpoch <= 0 ||
    !validIdentifier(options.helperBinding.sessionIdentity) ||
    !validIdentifier(options.helperBinding.releaseVersion)
  ) {
    throw new TypeError("The Windows Computer Use helper authority binding is invalid.");
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
