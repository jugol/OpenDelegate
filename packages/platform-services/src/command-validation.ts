import { PlatformServiceError, type CommandInvocation } from "./types.ts";

const ALLOWED_EXECUTABLES = new Set([
  "/bin/launchctl",
  "/usr/bin/systemctl",
  "sc.exe",
  "schtasks.exe",
]);
const PROHIBITED_EXECUTABLE_PATTERN =
  /(?:^|[\\/])(?:bash|cmd|dash|fish|powershell|pwsh|sh|zsh)(?:\.exe)?$/i;

export function validateSupervisorCommands(
  commands: readonly CommandInvocation[],
): readonly CommandInvocation[] {
  for (const invocation of commands) {
    if (
      !ALLOWED_EXECUTABLES.has(invocation.executable) ||
      PROHIBITED_EXECUTABLE_PATTERN.test(invocation.executable)
    ) {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        `Supervisor executable is not allowlisted: ${invocation.executable}.`,
      );
    }
    if (
      invocation.timeoutMs < 1_000 ||
      invocation.timeoutMs > 120_000 ||
      invocation.expectedExitCodes.length === 0 ||
      new Set(invocation.expectedExitCodes).size !== invocation.expectedExitCodes.length ||
      invocation.expectedExitCodes.some(
        (exitCode) => !Number.isSafeInteger(exitCode) || exitCode < 0,
      )
    ) {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        "Supervisor command execution policy is invalid.",
      );
    }
    for (const argument of invocation.arguments) {
      if (
        argument === "" ||
        argument.includes("\0") ||
        argument.includes("\n") ||
        argument.includes("secret://")
      ) {
        throw new PlatformServiceError(
          "INVALID_CONFIGURATION",
          "Supervisor arguments must be non-empty, non-secret argv values.",
        );
      }
    }
  }
  return commands;
}
