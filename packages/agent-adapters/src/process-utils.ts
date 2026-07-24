import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

import { AgentAdapterError } from "./errors.ts";

const DEFAULT_INHERITED_ENVIRONMENT = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "TMP",
  "TEMP",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;

const SECRET_LIKE_NAME =
  /(?:^|[_-])(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH(?:ORIZATION)?|DATABASE[_-]?(?:URL|URI)|DB[_-]?URI|CONNECTION[_-]?STRING|PAT)(?:$|[_-])/iu;

export interface SpawnCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly secretEnvironment?: Readonly<Record<string, string>>;
}

export interface CaptureResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export function buildChildEnvironment(
  environment?: Readonly<Record<string, string>>,
  secretEnvironment?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  validateEnvironmentChannels(environment);
  const result: NodeJS.ProcessEnv = {};
  for (const key of DEFAULT_INHERITED_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(environment ?? {})) {
    result[key] = value;
  }
  for (const [key, value] of Object.entries(secretEnvironment ?? {})) {
    result[key] = value;
  }
  return result;
}

export function validateEnvironmentChannels(environment?: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(environment ?? {})) {
    if (SECRET_LIKE_NAME.test(key)) {
      throw new AgentAdapterError(
        "SECRET_IN_PLAIN_ENVIRONMENT",
        `Environment variable ${key} must be supplied through secretEnvironment.`,
      );
    }
  }
}

export function spawnCommand(command: SpawnCommand): ChildProcessWithoutNullStreams {
  if (
    command.executable.length === 0 ||
    command.executable.includes("\0") ||
    command.args.some((argument) => argument.includes("\0"))
  ) {
    throw new AgentAdapterError("INVALID_COMMAND", "Executable and arguments must be explicit.");
  }
  const environment = buildChildEnvironment(command.environment, command.secretEnvironment);
  const executable = resolveExecutableForSpawn(command.executable, environment);
  return spawn(executable, [...command.args], {
    cwd: command.cwd,
    env: environment,
    shell: false,
    stdio: "pipe",
    windowsHide: true,
  });
}

function resolveExecutableForSpawn(executable: string, environment: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") {
    return executable;
  }
  const extension = extname(executable).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    throw new AgentAdapterError(
      "SHELL_WRAPPER_UNSUPPORTED",
      "Windows command and batch wrappers are not executable without a shell; configure a native executable.",
    );
  }
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    return executable;
  }
  const pathEntries = (environment.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter((entry) => entry.length > 0);
  const names = extension.length === 0 ? [`${executable}.exe`, `${executable}.com`] : [executable];
  for (const name of names) {
    for (const directory of pathEntries) {
      const candidate = join(directory, name);
      try {
        if (statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Continue searching PATH without exposing filesystem detail.
      }
    }
  }
  return executable;
}

export async function captureCommand(
  command: SpawnCommand,
  timeoutMs: number,
  maxBytes: number,
): Promise<CaptureResult> {
  const child = spawnCommand(command);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const append = (current: string, chunk: Buffer): string => {
    if (Buffer.byteLength(current) >= maxBytes) {
      return current;
    }
    const remaining = maxBytes - Buffer.byteLength(current);
    return current + chunk.subarray(0, remaining).toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  child.stdin.end();
  let forceTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 250);
    forceTimer.unref();
  }, timeoutMs);
  timer.unref();
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    },
  ).finally(() => {
    clearTimeout(timer);
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer);
    }
  });
  return {
    exitCode: outcome.code,
    signal: outcome.signal,
    stdout,
    stderr,
    timedOut,
  };
}

export async function* readBoundedLines(
  stream: NodeJS.ReadableStream,
  maxLineBytes: number,
): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    pending = Buffer.concat([pending, chunk]);
    let newlineIndex = pending.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const line = pending.subarray(0, newlineIndex);
      if (line.length > maxLineBytes) {
        throw new AgentAdapterError(
          "PROVIDER_LINE_TOO_LARGE",
          "Provider output exceeded the configured line limit.",
        );
      }
      const end = line.at(-1) === 0x0d ? -1 : undefined;
      yield line.subarray(0, end).toString("utf8");
      pending = pending.subarray(newlineIndex + 1);
      newlineIndex = pending.indexOf(0x0a);
    }
    if (pending.length > maxLineBytes) {
      throw new AgentAdapterError(
        "PROVIDER_LINE_TOO_LARGE",
        "Provider output exceeded the configured line limit.",
      );
    }
  }
  if (pending.length > 0) {
    yield pending.toString("utf8");
  }
}
