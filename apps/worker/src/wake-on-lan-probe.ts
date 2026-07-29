import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { win32 } from "node:path";

import type {
  WorkerWakeOnLanObservationV1,
  WorkerWakeOnLanTargetStateV1,
} from "@opendelegate/worker-runtime";

const PROBE_TIMEOUT_MS = 3_000;
const MAXIMUM_PROBE_OUTPUT_BYTES = 32 * 1024;
const MAXIMUM_INTERFACES = 32;

const WINDOWS_WAKE_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "$states = @(Get-NetAdapter -Physical -ErrorAction Stop | ForEach-Object {",
  "  $power = Get-NetAdapterPowerManagement -Name $_.Name -ErrorAction Stop",
  "  [string]$power.WakeOnMagicPacket",
  "})",
  "ConvertTo-Json -Compress -InputObject $states",
].join("\n");

export interface WakeOnLanCommandRunner {
  run(executable: string, arguments_: readonly string[], timeoutMs: number): Promise<string>;
}

export interface SystemWakeOnLanProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly runner?: WakeOnLanCommandRunner;
  readonly windowsPowerShellPath?: string;
  readonly linuxEttoolExecutable?: string;
  readonly linuxInterfaceNames?: () => readonly string[];
}

/**
 * Reduces platform Wake-on-LAN settings to a bounded, non-secret observation.
 *
 * This probe says only whether the target OS/network adapter was armed for a
 * magic packet. It does not claim that Main owns a relay path and deliberately
 * never returns an interface name, MAC address, SecureOn value, or raw output.
 */
export class SystemWakeOnLanProbe {
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #runner: WakeOnLanCommandRunner;
  readonly #windowsPowerShellPath: string;
  readonly #linuxEttoolExecutable: string;
  readonly #linuxInterfaceNames: () => readonly string[];

  public constructor(options: SystemWakeOnLanProbeOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? Date.now;
    this.#runner = options.runner ?? nodeWakeOnLanCommandRunner;
    this.#windowsPowerShellPath =
      options.windowsPowerShellPath ?? defaultWindowsPowerShellPath(process.env);
    this.#linuxEttoolExecutable = options.linuxEttoolExecutable ?? defaultLinuxEttoolExecutable();
    this.#linuxInterfaceNames = options.linuxInterfaceNames ?? localLinuxInterfaceNames;
  }

  public async probe(): Promise<WorkerWakeOnLanObservationV1> {
    const observedAtMs = this.#readNow();
    try {
      if (this.#platform === "win32") {
        const output = await this.#runner.run(
          this.#windowsPowerShellPath,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_WAKE_QUERY],
          PROBE_TIMEOUT_MS,
        );
        return observation(windowsState(output), "windows-netadapter-power", observedAtMs);
      }
      if (this.#platform === "darwin") {
        const output = await this.#runner.run("/usr/bin/pmset", ["-g", "custom"], PROBE_TIMEOUT_MS);
        return observation(macOsState(output), "macos-pmset", observedAtMs);
      }
      if (this.#platform === "linux") {
        const state = await this.#probeLinux();
        return observation(state, "linux-ethtool", observedAtMs);
      }
    } catch {
      // Raw platform diagnostics may contain interface or network identifiers.
      // They remain Device-local and collapse to one owner-safe state.
    }
    return observation("unknown", "probe-unavailable", observedAtMs);
  }

  async #probeLinux(): Promise<WorkerWakeOnLanTargetStateV1> {
    const candidateNames = [...new Set(this.#linuxInterfaceNames())]
      .filter(isBoundedInterfaceName)
      .sort((left, right) => left.localeCompare(right, "en"));
    const scanWasTruncated = candidateNames.length > MAXIMUM_INTERFACES;
    const names = candidateNames.slice(0, MAXIMUM_INTERFACES);
    if (names.length === 0) {
      return "unknown";
    }
    const outcomes = await Promise.allSettled(
      names.map((name) => this.#runner.run(this.#linuxEttoolExecutable, [name], PROBE_TIMEOUT_MS)),
    );
    const states = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [linuxInterfaceState(outcome.value)] : [],
    );
    if (states.length === 0) {
      throw new Error("No Linux Wake-on-LAN probe completed.");
    }
    if (states.includes("enabled")) {
      return "enabled";
    }
    if (
      scanWasTruncated ||
      outcomes.some((outcome) => outcome.status === "rejected") ||
      states.includes("unknown")
    ) {
      return "unknown";
    }
    if (states.includes("disabled")) {
      return "disabled";
    }
    return "unsupported";
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
      throw new TypeError("Wake-on-LAN probe clock is invalid.");
    }
    return now;
  }
}

const nodeWakeOnLanCommandRunner: WakeOnLanCommandRunner = Object.freeze({
  run(executable: string, arguments_: readonly string[], timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        [...arguments_],
        {
          encoding: "utf8",
          maxBuffer: MAXIMUM_PROBE_OUTPUT_BYTES,
          timeout: timeoutMs,
          windowsHide: true,
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
});

function windowsState(output: string): WorkerWakeOnLanTargetStateV1 {
  const parsed: unknown = JSON.parse(output);
  if (
    !Array.isArray(parsed) ||
    parsed.length > MAXIMUM_INTERFACES ||
    !parsed.every((value) => value === "Enabled" || value === "Disabled" || value === "Unsupported")
  ) {
    throw new Error("Windows returned an invalid Wake-on-LAN observation.");
  }
  if (parsed.includes("Enabled")) {
    return "enabled";
  }
  if (parsed.includes("Disabled")) {
    return "disabled";
  }
  return "unsupported";
}

function macOsState(output: string): WorkerWakeOnLanTargetStateV1 {
  const values = [...output.matchAll(/^\s*womp\s+([01])\s*$/gmu)].map((match) => match[1]);
  if (values.includes("1")) {
    return "enabled";
  }
  if (values.includes("0")) {
    return "disabled";
  }
  return "unsupported";
}

function linuxInterfaceState(output: string): WorkerWakeOnLanTargetStateV1 {
  const supported = /^\s*Supports Wake-on:\s*([a-z]+)\s*$/imu.exec(output)?.[1];
  const active = /^\s*Wake-on:\s*([a-z]+)\s*$/imu.exec(output)?.[1];
  if (supported === undefined || active === undefined) {
    return "unknown";
  }
  if (active.includes("g")) {
    return "enabled";
  }
  return supported.includes("g") ? "disabled" : "unsupported";
}

function observation(
  state: WorkerWakeOnLanTargetStateV1,
  source: WorkerWakeOnLanObservationV1["source"],
  observedAtMs: number,
): WorkerWakeOnLanObservationV1 {
  return Object.freeze({ state, source, observedAtMs });
}

function localLinuxInterfaceNames(): readonly string[] {
  try {
    return readdirSync("/sys/class/net", { encoding: "utf8" })
      .filter(isBoundedInterfaceName)
      .filter((name) => name !== "lo" && existsSync(`/sys/class/net/${name}/device`));
  } catch {
    // Without complete physical-interface enumeration, any supported/unsupported
    // conclusion would be an inference from partial evidence.
    return Object.freeze([]);
  }
}

function isBoundedInterfaceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 128 &&
    value === value.trim() &&
    !value.startsWith("-") &&
    !value.includes("\0")
  );
}

function defaultLinuxEttoolExecutable(): string {
  return existsSync("/usr/sbin/ethtool")
    ? "/usr/sbin/ethtool"
    : existsSync("/sbin/ethtool")
      ? "/sbin/ethtool"
      : existsSync("/usr/bin/ethtool")
        ? "/usr/bin/ethtool"
        : "/usr/sbin/ethtool";
}

function defaultWindowsPowerShellPath(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const systemRoot = environment["SystemRoot"] ?? environment["WINDIR"] ?? String.raw`C:\Windows`;
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
