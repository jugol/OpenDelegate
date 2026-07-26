import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import type {
  NativeSecretCommandRequest,
  NativeSecretCommandResult,
  NativeSecretCommandRunner,
} from "./contracts.ts";
import { SecretError } from "./secret-error.ts";

const MAXIMUM_INPUT_BYTES = 16_777_216;
const MAXIMUM_OUTPUT_BYTES = 16_777_216;
const MAXIMUM_STDERR_BYTES = 65_536;
const MAXIMUM_TIMEOUT_MS = 120_000;
const MAXIMUM_ARGUMENTS = 128;
const MAXIMUM_ARGUMENT_BYTES = 65_536;

export class NodeNativeSecretCommandRunner implements NativeSecretCommandRunner {
  public async run(request: NativeSecretCommandRequest): Promise<NativeSecretCommandResult> {
    validateRequest(request);
    const input = Buffer.from(request.stdin);

    return new Promise<NativeSecretCommandResult>((resolvePromise, rejectPromise) => {
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let failure: SecretError | undefined;
      let inputZeroed = false;

      const child = spawn(request.executable, [...request.args], {
        env: { ...request.environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const zeroInput = (): void => {
        if (!inputZeroed) {
          input.fill(0);
          inputZeroed = true;
        }
      };

      const discardOutput = (): void => {
        for (const chunk of stdoutChunks) {
          chunk.fill(0);
        }
        stdoutChunks.length = 0;
      };

      const fail = (): void => {
        failure ??= nativeCommandFailed();
        zeroInput();
        child.kill(process.platform === "win32" ? undefined : "SIGKILL");
      };

      const timer = setTimeout(fail, request.timeoutMs);

      child.once("error", () => {
        failure ??= backendUnavailable();
        zeroInput();
      });
      child.stdin.once("error", fail);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > request.maximumStdoutBytes) {
          chunk.fill(0);
          fail();
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        chunk.fill(0);
        if (stderrBytes > MAXIMUM_STDERR_BYTES) {
          fail();
        }
      });
      child.once("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        zeroInput();

        if (failure !== undefined || exitCode === null) {
          discardOutput();
          rejectPromise(failure ?? nativeCommandFailed());
          return;
        }

        const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
        discardOutput();
        resolvePromise(
          Object.freeze({
            exitCode,
            stdout,
          }),
        );
      });

      try {
        child.stdin.end(input, zeroInput);
      } catch {
        fail();
      }
    });
  }
}

function validateRequest(request: NativeSecretCommandRequest): void {
  if (
    typeof request.executable !== "string" ||
    !isAbsolute(request.executable) ||
    request.executable.includes("\0") ||
    request.executable !== request.executable.trim()
  ) {
    throw configurationInvalid();
  }
  if (!Array.isArray(request.args) || request.args.length > MAXIMUM_ARGUMENTS) {
    throw configurationInvalid();
  }
  for (const argument of request.args) {
    if (
      typeof argument !== "string" ||
      argument.includes("\0") ||
      Buffer.byteLength(argument, "utf8") > MAXIMUM_ARGUMENT_BYTES
    ) {
      throw configurationInvalid();
    }
  }
  if (
    !(request.stdin instanceof Uint8Array) ||
    request.stdin.byteLength > MAXIMUM_INPUT_BYTES ||
    !Number.isSafeInteger(request.maximumStdoutBytes) ||
    request.maximumStdoutBytes < 0 ||
    request.maximumStdoutBytes > MAXIMUM_OUTPUT_BYTES ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > MAXIMUM_TIMEOUT_MS
  ) {
    throw configurationInvalid();
  }
  for (const [name, value] of Object.entries(request.environment)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > 16_384
    ) {
      throw configurationInvalid();
    }
  }
}

function configurationInvalid(): SecretError {
  return new SecretError(
    "SECRET_CONFIGURATION_INVALID",
    "The native Secret helper command configuration is invalid.",
  );
}

function backendUnavailable(): SecretError {
  return new SecretError(
    "SECRET_BACKEND_UNAVAILABLE",
    "The native Device-local Secret helper is unavailable.",
  );
}

function nativeCommandFailed(): SecretError {
  return new SecretError(
    "SECRET_STORE_ACCESS_FAILED",
    "The native Device-local Secret helper could not complete the operation.",
  );
}
