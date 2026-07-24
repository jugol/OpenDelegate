import { spawn } from "node:child_process";

export interface ReadOnlyCommandResult {
  readonly exitCode: number;
}

export interface ReadOnlyCommandRunner {
  run(executable: string, arguments_: readonly string[]): Promise<ReadOnlyCommandResult>;
}

export interface WindowsHostValidationReport {
  readonly platform: "windows";
  readonly safeReadOnly: true;
  readonly tools: readonly {
    readonly name: "service-control-manager" | "task-scheduler";
    readonly available: boolean;
    readonly executableLocated: boolean;
    readonly readOnlyQuerySucceeded: boolean;
  }[];
  readonly mutationsAttempted: false;
}

export async function validateWindowsHostSupervisor(
  runner: ReadOnlyCommandRunner = createReadOnlyCommandRunner(),
): Promise<WindowsHostValidationReport> {
  const [scLocation, taskLocation, scmQuery, taskQuery] = await Promise.all([
    runner.run("where.exe", ["sc.exe"]),
    runner.run("where.exe", ["schtasks.exe"]),
    runner.run("sc.exe", ["query", "type=", "service", "state=", "all"]),
    runner.run("schtasks.exe", ["/Query", "/FO", "CSV", "/NH"]),
  ]);
  return {
    platform: "windows",
    safeReadOnly: true,
    tools: [
      {
        name: "service-control-manager",
        available: scLocation.exitCode === 0 && scmQuery.exitCode === 0,
        executableLocated: scLocation.exitCode === 0,
        readOnlyQuerySucceeded: scmQuery.exitCode === 0,
      },
      {
        name: "task-scheduler",
        available: taskLocation.exitCode === 0 && taskQuery.exitCode === 0,
        executableLocated: taskLocation.exitCode === 0,
        readOnlyQuerySucceeded: taskQuery.exitCode === 0,
      },
    ],
    mutationsAttempted: false,
  };
}

export function createReadOnlyCommandRunner(): ReadOnlyCommandRunner {
  return {
    run(executable, arguments_) {
      return new Promise((resolve) => {
        const child = spawn(executable, [...arguments_], {
          shell: false,
          stdio: ["ignore", "ignore", "ignore"],
          windowsHide: true,
        });
        const timeout = setTimeout(() => {
          child.kill();
        }, 30_000);
        child.once("error", () => {
          clearTimeout(timeout);
          resolve({ exitCode: -1 });
        });
        child.once("exit", (exitCode) => {
          clearTimeout(timeout);
          resolve({ exitCode: exitCode ?? -1 });
        });
      });
    },
  };
}
