import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import type { AgentAdapterProbe, AgentAdapterRemediation } from "@opendelegate/agent-adapters";

const UPGRADE_TIMEOUT_MS = 10 * 60_000;
const MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

export type AgentProviderUpgradeOutcome =
  | {
      readonly status: "upgraded";
      readonly adapterId: string;
      readonly packageName: string;
      readonly fromVersion?: string;
      readonly toVersion: string;
    }
  | {
      readonly status: "unavailable";
      readonly adapterId: string;
      readonly reasonCode: AgentProviderUpgradeReasonCode;
      readonly reason: string;
    };

export type AgentProviderUpgradeReasonCode =
  | "PACKAGE_MANAGER_UNAVAILABLE"
  | "REMEDIATION_INVALID"
  | "UPGRADE_COMMAND_FAILED"
  | "VERSION_NOT_APPLIED";

/**
 * Installs the exact provider version an adapter's own pin requires.
 *
 * This is deliberately narrower than the platform-mutation capability, which
 * cannot serve an owner who has configured nothing: the package name and the
 * version both come from the adapter, never from the owner or the network, so
 * the only thing discovered on the Device is where npm lives. The install runs
 * through the Worker's own pinned Node rather than a shell wrapper, and the
 * adapter is re-probed afterwards so a command that reported success without
 * changing the installed version is still reported as a failure.
 */
export async function upgradeAgentProvider(input: {
  readonly adapterId: string;
  readonly remediation: AgentAdapterRemediation;
  readonly reprobe: () => Promise<AgentAdapterProbe>;
  readonly nodeExecutable?: string;
  /** Pins npm's entry script instead of discovering it beside the launcher. */
  readonly npmCliPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runCommand?: (command: {
    readonly executable: string;
    readonly args: readonly string[];
  }) => Promise<{ readonly exitCode: number | null; readonly output: string }>;
}): Promise<AgentProviderUpgradeOutcome> {
  const { adapterId, remediation } = input;
  if (
    remediation.kind !== "upgrade-provider" ||
    remediation.packageManager !== "npm" ||
    !PACKAGE_NAME.test(remediation.packageName) ||
    !PACKAGE_VERSION.test(remediation.targetVersion)
  ) {
    return unavailable(adapterId, "REMEDIATION_INVALID", "The declared upgrade is not usable.");
  }

  const nodeExecutable = input.nodeExecutable ?? process.execPath;
  const npmCli = input.npmCliPath ?? (await locateNpmCli(input.environment ?? process.env));
  if (npmCli === undefined) {
    return unavailable(
      adapterId,
      "PACKAGE_MANAGER_UNAVAILABLE",
      "npm could not be located on this Device.",
    );
  }

  const run = input.runCommand ?? runBoundedCommand;
  const result = await run({
    executable: nodeExecutable,
    args: [
      npmCli,
      "install",
      "--global",
      "--no-fund",
      "--no-audit",
      `${remediation.packageName}@${remediation.targetVersion}`,
    ],
  });
  if (result.exitCode !== 0) {
    return unavailable(
      adapterId,
      "UPGRADE_COMMAND_FAILED",
      `npm exited with ${result.exitCode === null ? "no status" : String(result.exitCode)}.`,
    );
  }

  // Trust the probe, not the exit code: npm reports success for installs that
  // leave a different version on PATH.
  const probe = await input.reprobe();
  if (probe.version !== remediation.targetVersion) {
    return unavailable(
      adapterId,
      "VERSION_NOT_APPLIED",
      `The Device still reports ${probe.version ?? "no version"} after the upgrade.`,
    );
  }
  return Object.freeze({
    status: "upgraded" as const,
    adapterId,
    packageName: remediation.packageName,
    ...(remediation.installedVersion === undefined
      ? {}
      : { fromVersion: remediation.installedVersion }),
    toVersion: remediation.targetVersion,
  });
}

/**
 * Finds npm's own entry script beside the npm launcher on PATH. The launcher is
 * a shell wrapper that cannot be spawned without a shell, so the script it would
 * have run is located instead and handed to Node directly.
 */
export async function locateNpmCli(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const launcherNames = process.platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"];
  for (const directory of (environment["PATH"] ?? environment["Path"] ?? "").split(delimiter)) {
    const trimmed = directory.trim();
    if (trimmed.length === 0 || !isAbsolute(trimmed)) {
      continue;
    }
    for (const launcher of launcherNames) {
      if (!(await isRegularFile(join(trimmed, launcher)))) {
        continue;
      }
      const candidate = await resolveNpmCliNear(join(trimmed, launcher));
      if (candidate !== undefined) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function resolveNpmCliNear(launcherPath: string): Promise<string | undefined> {
  let root: string;
  try {
    root = dirname(await realpath(launcherPath));
  } catch {
    return undefined;
  }
  // The launcher sits beside npm's install root on Windows and one level above
  // it under a POSIX bin directory.
  for (const relative of [
    ["node_modules", "npm", "bin", "npm-cli.js"],
    ["..", "lib", "node_modules", "npm", "bin", "npm-cli.js"],
  ]) {
    const candidate = join(root, ...relative);
    if (await isRegularFile(candidate)) {
      try {
        return await realpath(candidate);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function runBoundedCommand(command: {
  readonly executable: string;
  readonly args: readonly string[];
}): Promise<{ readonly exitCode: number | null; readonly output: string }> {
  const child = spawn(command.executable, [...command.args], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const append = (chunk: Buffer): void => {
    if (output.length < MAXIMUM_OUTPUT_BYTES) {
      output += chunk.subarray(0, MAXIMUM_OUTPUT_BYTES - output.length).toString("utf8");
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const timer = setTimeout(() => child.kill(), UPGRADE_TIMEOUT_MS);
  timer.unref();
  try {
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolvePromise(code));
    });
    return { exitCode, output };
  } catch {
    return { exitCode: null, output };
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(
  adapterId: string,
  reasonCode: AgentProviderUpgradeReasonCode,
  reason: string,
): AgentProviderUpgradeOutcome {
  return Object.freeze({ status: "unavailable" as const, adapterId, reasonCode, reason });
}
