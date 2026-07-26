import { createHash } from "node:crypto";

import {
  NativeDriverError,
  type ComputerUseOsFamily,
  type NativeComputerUseDriver,
  type NativeComputerUseAction,
  type NativeDriverAuthorizedInputContext,
  type NativeDriverExecutionContext,
  type ReadinessCheckName,
} from "./contracts.ts";
import { createActionFingerprint, describeNativeComputerUseAction } from "./input-authorization.ts";

const REQUIRED_CHECKS = [
  "interactive-session",
  "unlocked-session",
  "screen-capture",
  "accessibility",
  "input",
  "helper-authentication",
] as const satisfies readonly ReadinessCheckName[];
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface NativeDriverConformanceLabOptions {
  readonly osFamily: ComputerUseOsFamily;
  readonly createDriver: () => NativeComputerUseDriver;
}

export interface NativeDriverConformanceLabReport {
  readonly passed: true;
  readonly osFamily: ComputerUseOsFamily;
  readonly backendId: string;
  readonly pngEvidence: {
    readonly mediaType: "image/png";
    readonly width: number;
    readonly height: number;
    readonly sha256: `sha256:${string}`;
    readonly bytes: Uint8Array;
  };
  readonly resultFile: {
    readonly filename: string;
    readonly mediaType: "application/json";
    readonly bytes: Uint8Array;
  };
  readonly cancellationStoppedInput: true;
  readonly emergencyStopStoppedInput: true;
}

/**
 * Runs the public native-driver contract against the deterministic graphical
 * fixture. It does not constitute live OS acceptance proof: the supplied driver
 * must itself be a real OS driver on the platform lab for that claim.
 */
export async function runNativeDriverConformanceLab(
  options: NativeDriverConformanceLabOptions,
): Promise<NativeDriverConformanceLabReport> {
  const driver = options.createDriver();
  const probe = await driver.probe();
  if (
    driver.osFamily !== options.osFamily ||
    probe.osFamily !== options.osFamily ||
    probe.displayFingerprint === null
  ) {
    throw new Error("Native driver did not expose the expected graphical OS session.");
  }
  const checkNames = new Set(probe.checks.map((check) => check.name));
  if (
    REQUIRED_CHECKS.some((name) => !checkNames.has(name)) ||
    probe.checks.some((check) => check.status !== "pass")
  ) {
    throw new Error("Native driver readiness did not pass the fixture conformance gate.");
  }

  const context = executionContext(probe.displayFingerprint, "conformance-main");
  const initial = await driver.observe(context);
  const controlIds = new Set(initial.accessibilityTree.map((control) => control.controlId));
  for (const required of ["task-text", "option-alpha", "option-beta", "submit"]) {
    if (!controlIds.has(required)) {
      throw new Error(`Native driver did not expose fixture control "${required}".`);
    }
  }

  const typeAction = {
    kind: "type-text",
    controlId: "task-text",
    text: "OpenDelegate native-driver conformance",
  } as const;
  const optionAction = { kind: "click", controlId: "option-beta" } as const;
  const submitAction = { kind: "click", controlId: "submit" } as const;
  await driver.act(authorizedContext(context, typeAction), typeAction);
  await driver.act(authorizedContext(context, optionAction), optionAction);
  await driver.act(authorizedContext(context, submitAction), submitAction);
  const completed = await driver.observe(context);
  if (
    completed.fixture?.state !== "success" ||
    completed.fixture.selectedOption !== "Beta" ||
    completed.fixture.resultFile === null
  ) {
    throw new Error("Native driver did not reach the deterministic visible success state.");
  }

  const capture = await driver.capture(context);
  if (
    capture.mediaType !== "image/png" ||
    capture.width <= 0 ||
    capture.height <= 0 ||
    capture.bytes.length < PNG_SIGNATURE.length ||
    !PNG_SIGNATURE.every((value, index) => capture.bytes[index] === value)
  ) {
    throw new Error("Native driver did not return actual PNG fixture evidence.");
  }

  await driver.cancel(controlContext("conformance-main"));
  const cancellationStoppedInput = await actionIsStopped(driver, context, "CANCELLED");

  const emergencyDriver = options.createDriver();
  const emergencyProbe = await emergencyDriver.probe();
  if (emergencyProbe.displayFingerprint === null) {
    throw new Error("Emergency-stop fixture did not expose a display.");
  }
  const emergencyContext = executionContext(
    emergencyProbe.displayFingerprint,
    "conformance-emergency",
  );
  await emergencyDriver.emergencyStop(controlContext("conformance-emergency"));
  const emergencyStopStoppedInput = await actionIsStopped(
    emergencyDriver,
    emergencyContext,
    "EMERGENCY_STOPPED",
  );

  if (!cancellationStoppedInput || !emergencyStopStoppedInput) {
    throw new Error("Native driver accepted input after cancellation or emergency stop.");
  }

  return Object.freeze({
    passed: true,
    osFamily: options.osFamily,
    backendId: probe.backendId,
    pngEvidence: Object.freeze({
      mediaType: "image/png",
      width: capture.width,
      height: capture.height,
      sha256: `sha256:${createHash("sha256").update(capture.bytes).digest("hex")}`,
      bytes: capture.bytes.slice(),
    }),
    resultFile: Object.freeze({
      filename: completed.fixture.resultFile.filename,
      mediaType: "application/json",
      bytes: completed.fixture.resultFile.bytes.slice(),
    }),
    cancellationStoppedInput: true,
    emergencyStopStoppedInput: true,
  });
}

function executionContext(
  displayFingerprint: string,
  suffix: string,
): NativeDriverExecutionContext {
  return {
    executionHandleId: `handle-${suffix}`,
    taskId: "task-native-driver-conformance",
    deviceId: "device-native-driver-conformance",
    runId: `run-${suffix}`,
    helperInstanceId: "helper-1",
    serviceEpoch: 7,
    persistenceGeneration: 11,
    leaseId: `lease-${suffix}`,
    fencingToken: 1,
    expectedDisplayFingerprint: displayFingerprint,
    signal: new AbortController().signal,
  };
}

function controlContext(suffix: string) {
  return {
    executionHandleId: `handle-${suffix}`,
    taskId: "task-native-driver-conformance",
    deviceId: "device-native-driver-conformance",
    runId: `run-${suffix}`,
  };
}

async function actionIsStopped(
  driver: NativeComputerUseDriver,
  context: NativeDriverExecutionContext,
  expectedCode: "CANCELLED" | "EMERGENCY_STOPPED",
): Promise<boolean> {
  try {
    const action = { kind: "click", controlId: "submit" } as const;
    await driver.act(authorizedContext(context, action), action);
    return false;
  } catch (error: unknown) {
    return error instanceof NativeDriverError && error.code === expectedCode;
  }
}

function authorizedContext(
  context: NativeDriverExecutionContext,
  action: NativeComputerUseAction,
): NativeDriverAuthorizedInputContext {
  const authorizedAction = describeNativeComputerUseAction(action);
  return {
    ...context,
    authorization: {
      authorizationId: `conformance:${context.executionHandleId}:${action.kind}`,
      fingerprint: createActionFingerprint({
        action: authorizedAction,
      }),
      action: authorizedAction,
    },
  };
}
