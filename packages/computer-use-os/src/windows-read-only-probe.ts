import { execFile } from "node:child_process";

import type { ComputerUseClock, ComputerUseReadinessReport, ReadinessCheck } from "./contracts.ts";

const WINDOWS_SESSION_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sessionId = (Get-Process -Id $PID).SessionId
$logonUi = @(Get-Process -Name LogonUI -ErrorAction SilentlyContinue |
  Where-Object { $_.SessionId -eq $sessionId }).Count
[ordered]@{
  userInteractive = [Environment]::UserInteractive
  sessionId = $sessionId
  logonUiVisible = ($logonUi -gt 0)
} | ConvertTo-Json -Compress
`.trim();

export interface WindowsReadOnlyCommandPort {
  runPowerShell(script: string, timeoutMs: number): Promise<string>;
}

export interface WindowsCurrentSessionProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly clock?: ComputerUseClock;
  readonly commands?: WindowsReadOnlyCommandPort;
}

interface WindowsSessionEvidence {
  readonly userInteractive: boolean;
  readonly sessionId: number;
  readonly logonUiVisible: boolean;
}

/**
 * Collects safe, read-only evidence from the current Windows process session.
 * It intentionally never reports Computer Use ready because it does not exercise
 * capture, accessibility/input, helper authentication, or service-epoch authority.
 */
export async function probeCurrentWindowsSessionReadOnly(
  options: WindowsCurrentSessionProbeOptions = {},
): Promise<ComputerUseReadinessReport> {
  const platform = options.platform ?? process.platform;
  const clock = options.clock ?? { now: () => Date.now() };
  const commands = options.commands ?? createWindowsReadOnlyCommandPort();
  const observedAtMs = clock.now();
  let evidence: WindowsSessionEvidence | undefined;
  let probeFailure: string | undefined;

  if (platform === "win32") {
    try {
      evidence = parseWindowsSessionEvidence(
        await commands.runPowerShell(WINDOWS_SESSION_SCRIPT, 3_000),
      );
    } catch {
      probeFailure = "The read-only Windows session query did not complete.";
    }
  } else {
    probeFailure = "The current host is not Windows.";
  }

  const interactive: ReadinessCheck =
    evidence?.userInteractive === true
      ? {
          name: "interactive-session",
          status: "pass",
          evidence: `Windows reports an interactive process session (session ${evidence.sessionId}) at ${observedAtMs}.`,
        }
      : {
          name: "interactive-session",
          status: evidence === undefined ? "unknown" : "fail",
          evidence:
            probeFailure ??
            `Windows reports process session ${evidence?.sessionId ?? "unknown"} as non-interactive.`,
          remediation: "Start the per-user helper inside the logged-in interactive session.",
        };
  const unlocked: ReadinessCheck =
    evidence === undefined
      ? {
          name: "unlocked-session",
          status: "unknown",
          evidence: "The current session lock state could not be established.",
          remediation: "Log in and unlock the Windows desktop before Computer Use.",
        }
      : evidence.logonUiVisible
        ? {
            name: "unlocked-session",
            status: "fail",
            evidence: `LogonUI is visible in process session ${evidence.sessionId}.`,
            remediation: "Unlock the Windows desktop before Computer Use.",
          }
        : {
            name: "unlocked-session",
            status: "unknown",
            evidence: `LogonUI is not visible in process session ${evidence.sessionId}, which is not sufficient to prove the desktop is unlocked.`,
            remediation: "Use the authenticated native helper to verify unlocked state.",
          };

  const checks: ReadinessCheck[] = [
    interactive,
    unlocked,
    unverified(
      "screen-capture",
      "The read-only probe does not capture the screen.",
      "Run the authenticated native-driver capture probe.",
    ),
    unverified(
      "accessibility",
      "The read-only probe does not exercise Windows UI Automation.",
      "Run the native-driver accessibility fixture.",
    ),
    unverified(
      "input",
      "The read-only probe never injects input.",
      "Authorize and run the native-driver input fixture.",
    ),
    {
      name: "helper-authentication",
      status: "fail",
      evidence: "No authenticated local-helper challenge is performed by this read-only probe.",
      remediation: "Start and authenticate the per-user session helper.",
    },
    {
      name: "service-epoch",
      status: "fail",
      evidence: "No exclusive Device-service epoch is verified by this read-only probe.",
      remediation: "Verify the current helper against the external monotonic desktop authority.",
    },
  ];
  return Object.freeze({
    status: "unavailable",
    osFamily: "windows",
    backendId: "windows-current-session-read-only",
    displayFingerprint: null,
    checks: Object.freeze(checks.map((check) => Object.freeze(check))),
  });
}

export function createWindowsReadOnlyCommandPort(): WindowsReadOnlyCommandPort {
  return {
    runPowerShell(script, timeoutMs) {
      return new Promise((resolve, reject) => {
        execFile(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          {
            encoding: "utf8",
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 64 * 1024,
          },
          (error, stdout) => {
            if (error !== null) {
              reject(error);
              return;
            }
            resolve(stdout);
          },
        );
      });
    },
  };
}

function parseWindowsSessionEvidence(value: string): WindowsSessionEvidence {
  const parsed: unknown = JSON.parse(value.replace(/^\uFEFF/u, "").trim());
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>)["userInteractive"] !== "boolean" ||
    !Number.isSafeInteger((parsed as Record<string, unknown>)["sessionId"]) ||
    typeof (parsed as Record<string, unknown>)["logonUiVisible"] !== "boolean"
  ) {
    throw new Error("Windows session evidence is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  return {
    userInteractive: record["userInteractive"] as boolean,
    sessionId: record["sessionId"] as number,
    logonUiVisible: record["logonUiVisible"] as boolean,
  };
}

function unverified(
  name: ReadinessCheck["name"],
  evidence: string,
  remediation: string,
): ReadinessCheck {
  return { name, status: "unknown", evidence, remediation };
}
