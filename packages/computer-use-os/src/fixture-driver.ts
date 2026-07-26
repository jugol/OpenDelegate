import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import {
  NativeDriverError,
  SUPPORTED_GRAPHICAL_LINUX_TARGET,
  type ComputerUseOsFamily,
  type GraphicalLinuxTarget,
  type NativeCapture,
  type NativeComputerUseAction,
  type NativeComputerUseDriver,
  type NativeDriverAuthorizedInputContext,
  type NativeDriverControlContext,
  type NativeDriverExecutionContext,
  type NativeDriverProbe,
  type NativeObservation,
  type ReadinessCheck,
} from "./contracts.ts";
import { requireExactNativeInputAuthorization } from "./input-authorization.ts";

const WIDTH = 320;
const HEIGHT = 180;
const DISPLAY_FINGERPRINT = "display:fixture:320x180:1";

export interface FixtureNativeDriverOptions {
  readonly osFamily: ComputerUseOsFamily;
  readonly runIdentifier: string;
  readonly linuxTarget?: GraphicalLinuxTarget;
}

export interface FixtureNativeDriverHarness {
  readonly driver: NativeComputerUseDriver;
  setDisplayFingerprint(value: string): void;
  crashHelper(): void;
  lockSession(): void;
  denyPermission(name: "accessibility" | "input" | "screen-capture"): void;
  activity(): {
    readonly actionCount: number;
    readonly cancelCount: number;
    readonly emergencyStopCount: number;
  };
  readonly controls: {
    readonly text: { readonly id: "task-text"; readonly label: "Task text" };
    readonly alpha: { readonly id: "option-alpha"; readonly label: "Alpha" };
    readonly beta: { readonly id: "option-beta"; readonly label: "Beta" };
    readonly submit: { readonly id: "submit"; readonly label: "Submit" };
  };
}

export function createFixtureNativeDriver(
  options: FixtureNativeDriverOptions,
): FixtureNativeDriverHarness {
  let displayFingerprint = DISPLAY_FINGERPRINT;
  let helperCrashed = false;
  let sessionLocked = false;
  const deniedPermissions = new Set<string>();
  let textValue = "";
  let selectedOption: "Alpha" | "Beta" | null = null;
  let state: "editing" | "success" = "editing";
  let actionSequence = 0;
  let stopped = false;
  let stopReason: "cancelled" | "emergency-stopped" | null = null;
  let cancelCount = 0;
  let emergencyStopCount = 0;

  const driver: NativeComputerUseDriver = {
    osFamily: options.osFamily,

    async probe(): Promise<NativeDriverProbe> {
      const permission = (name: "accessibility" | "input" | "screen-capture"): ReadinessCheck => ({
        name,
        status: deniedPermissions.has(name) ? "fail" : "pass",
        evidence: deniedPermissions.has(name)
          ? `Fixture ${name} permission is denied.`
          : `Fixture ${name} permission is verified.`,
        ...(deniedPermissions.has(name)
          ? { remediation: `Grant ${name} permission to the user-session helper.` }
          : {}),
      });
      const checks: ReadinessCheck[] = [
        {
          name: "interactive-session",
          status: helperCrashed ? "fail" : "pass",
          evidence: helperCrashed
            ? "The fixture helper is unavailable."
            : "A fixture interactive session is present.",
          ...(helperCrashed ? { remediation: "Restart the logged-in user-session helper." } : {}),
        },
        {
          name: "unlocked-session",
          status: sessionLocked ? "fail" : "pass",
          evidence: sessionLocked
            ? "The fixture session is locked."
            : "The fixture session is unlocked.",
          ...(sessionLocked ? { remediation: "Unlock the graphical session." } : {}),
        },
        permission("screen-capture"),
        permission("accessibility"),
        permission("input"),
        {
          name: "helper-authentication",
          status: helperCrashed ? "fail" : "pass",
          evidence: helperCrashed
            ? "The fixture helper authentication channel is unavailable."
            : "The fixture helper challenge is authenticated.",
          ...(helperCrashed ? { remediation: "Re-establish authenticated local helper IPC." } : {}),
        },
      ];
      return {
        osFamily: options.osFamily,
        backendId: `fixture-${options.osFamily}-native-driver`,
        helperInstanceId: "helper-1",
        serviceEpoch: 7,
        displayFingerprint: helperCrashed ? null : displayFingerprint,
        ...(options.osFamily === "linux"
          ? { linuxTarget: options.linuxTarget ?? SUPPORTED_GRAPHICAL_LINUX_TARGET }
          : {}),
        checks: Object.freeze(checks.map((check) => Object.freeze(check))),
      };
    },

    async observe(context: NativeDriverExecutionContext): Promise<NativeObservation> {
      requireActive(context);
      return createObservation();
    },

    async capture(context: NativeDriverExecutionContext): Promise<NativeCapture> {
      requireActive(context);
      const fixtureState = JSON.stringify({
        runIdentifier: options.runIdentifier,
        state,
        textValue,
        selectedOption,
      });
      return {
        displayFingerprint,
        mediaType: "image/png",
        width: WIDTH,
        height: HEIGHT,
        bytes: encodeFixturePng(fixtureState),
      };
    },

    async act(
      context: NativeDriverAuthorizedInputContext,
      action: NativeComputerUseAction,
    ): Promise<{ readonly displayFingerprint: string; readonly sequence: number }> {
      requireActive(context);
      requireExactNativeInputAuthorization(context, action);
      if (action.kind === "type-text" && action.controlId === "task-text") {
        textValue += action.text;
      } else if (action.kind === "click" && action.controlId === "option-alpha") {
        selectedOption = "Alpha";
      } else if (action.kind === "click" && action.controlId === "option-beta") {
        selectedOption = "Beta";
      } else if (
        action.kind === "click" &&
        action.controlId === "submit" &&
        textValue.length > 0 &&
        selectedOption !== null
      ) {
        state = "success";
      }
      actionSequence += 1;
      return { displayFingerprint, sequence: actionSequence };
    },

    async cancel(_context: NativeDriverControlContext): Promise<void> {
      stopped = true;
      stopReason = "cancelled";
      cancelCount += 1;
    },

    async emergencyStop(_context: NativeDriverControlContext): Promise<void> {
      stopped = true;
      stopReason = "emergency-stopped";
      emergencyStopCount += 1;
    },
  };

  function requireActive(context: NativeDriverExecutionContext): void {
    if (context.signal.aborted || stopped) {
      throw new NativeDriverError(
        stopReason === "emergency-stopped" ? "EMERGENCY_STOPPED" : "CANCELLED",
        "Fixture driver is stopped.",
      );
    }
    if (helperCrashed) {
      throw new NativeDriverError("HELPER_CRASHED", "Fixture helper crashed.");
    }
    if (sessionLocked) {
      throw new NativeDriverError("SESSION_LOCKED", "Fixture session is locked.");
    }
    if (deniedPermissions.size > 0) {
      throw new NativeDriverError("PERMISSION_DENIED", "Fixture permission is denied.");
    }
    if (context.expectedDisplayFingerprint !== displayFingerprint) {
      throw new NativeDriverError("DISPLAY_CHANGED", "Fixture display changed.");
    }
  }

  function createObservation(): NativeObservation {
    const resultFile =
      state === "success"
        ? {
            filename: `fixture-result-${safeToken(options.runIdentifier)}.json`,
            mediaType: "application/json" as const,
            bytes: Buffer.from(
              JSON.stringify(
                {
                  runIdentifier: options.runIdentifier,
                  selectedOption,
                  textValue,
                  success: true,
                },
                null,
                2,
              ),
              "utf8",
            ),
          }
        : null;
    return {
      displayFingerprint,
      accessibilityTree: Object.freeze([
        Object.freeze({
          controlId: "task-text",
          role: "textbox" as const,
          label: "Task text",
          value: textValue,
        }),
        Object.freeze({
          controlId: "option-alpha",
          role: "radio" as const,
          label: "Alpha",
          selected: selectedOption === "Alpha",
        }),
        Object.freeze({
          controlId: "option-beta",
          role: "radio" as const,
          label: "Beta",
          selected: selectedOption === "Beta",
        }),
        Object.freeze({
          controlId: "submit",
          role: "button" as const,
          label: "Submit",
        }),
      ]),
      fixture: Object.freeze({
        runIdentifier: options.runIdentifier,
        state,
        textValue,
        selectedOption,
        resultFile: resultFile === null ? null : Object.freeze(resultFile),
      }),
    };
  }

  return {
    driver,
    setDisplayFingerprint(value) {
      displayFingerprint = value;
    },
    crashHelper() {
      helperCrashed = true;
    },
    lockSession() {
      sessionLocked = true;
    },
    denyPermission(name) {
      deniedPermissions.add(name);
    },
    activity() {
      return Object.freeze({
        actionCount: actionSequence,
        cancelCount,
        emergencyStopCount,
      });
    },
    controls: Object.freeze({
      text: Object.freeze({ id: "task-text", label: "Task text" }),
      alpha: Object.freeze({ id: "option-alpha", label: "Alpha" }),
      beta: Object.freeze({ id: "option-beta", label: "Beta" }),
      submit: Object.freeze({ id: "submit", label: "Submit" }),
    }),
  };
}

export function createHeadlessLinuxNativeDriver(): NativeComputerUseDriver {
  const unavailable = async (): Promise<never> => {
    throw new NativeDriverError("UNAVAILABLE", "No graphical session exists.");
  };
  return {
    osFamily: "linux",
    async probe() {
      return {
        osFamily: "linux",
        backendId: "linux-headless-unavailable",
        helperInstanceId: "headless-no-helper",
        serviceEpoch: 1,
        displayFingerprint: null,
        linuxTarget: "headless",
        checks: Object.freeze([
          unavailableCheck(
            "interactive-session",
            "No interactive graphical session is present.",
            "Log in to the declared graphical Linux environment to enable Computer Use.",
          ),
          unavailableCheck(
            "unlocked-session",
            "No graphical session can be unlocked.",
            "Computer Use remains unavailable on a headless Device.",
          ),
          unavailableCheck(
            "screen-capture",
            "No graphical display is available for capture.",
            "Keep non-graphical Worker capabilities enabled.",
          ),
          unavailableCheck(
            "accessibility",
            "No graphical accessibility backend is active.",
            "Keep non-graphical Worker capabilities enabled.",
          ),
          unavailableCheck(
            "input",
            "No graphical input backend is active.",
            "Keep non-graphical Worker capabilities enabled.",
          ),
          unavailableCheck(
            "helper-authentication",
            "No logged-in user-session helper exists.",
            "A headless Device does not need a desktop helper.",
          ),
        ]),
      };
    },
    observe: unavailable,
    capture: unavailable,
    act: unavailable,
    cancel: async () => {},
    emergencyStop: async () => {},
  };
}

function unavailableCheck(
  name: ReadinessCheck["name"],
  evidence: string,
  remediation: string,
): ReadinessCheck {
  return Object.freeze({ name, status: "fail", evidence, remediation });
}

function safeToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function encodeFixturePng(state: string): Uint8Array {
  const digest = createHash("sha256").update(state).digest();
  const rowLength = WIDTH * 4 + 1;
  const raw = Buffer.alloc(rowLength * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const rowOffset = y * rowLength;
    raw[rowOffset] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const pixelOffset = rowOffset + 1 + x * 4;
      const band = Math.floor(x / 20) + Math.floor(y / 20);
      raw[pixelOffset] = digest[(band * 3) % digest.length] ?? 0;
      raw[pixelOffset + 1] = digest[(band * 3 + 1) % digest.length] ?? 0;
      raw[pixelOffset + 2] = digest[(band * 3 + 2) % digest.length] ?? 0;
      raw[pixelOffset + 3] = 255;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
  return chunk;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
