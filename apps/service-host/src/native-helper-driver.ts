import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { arch, platform } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  LinuxNativeComputerUseDriver,
  MacOsNativeComputerUseDriver,
  createWindowsNamedPipeAuthenticatedHelperPort,
  createWindowsNativeComputerUseDriver,
  startLinuxNativeHelperChildProcess,
  startMacOsNativeHelperChildProcess,
  type NativeComputerUseDriver,
} from "@opendelegate/computer-use-os";
import type { SessionHelperNativeDriverBinding } from "@opendelegate/session-helper-runtime";

import { ServiceHostError, type ServiceHostConfiguration } from "./configuration.ts";

const MAX_NATIVE_MANIFEST_BYTES = 1024 * 1024;
const MAX_NATIVE_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const WINDOWS_NATIVE_SECRET_REFERENCE = "secret://session-helper/windows-native-child-v1";

interface NativeComponent {
  readonly path: string;
  readonly sha256: `sha256:${string}`;
}

export async function createNativeSessionHelperDriver(
  configuration: ServiceHostConfiguration,
  binding: SessionHelperNativeDriverBinding,
): Promise<NativeComputerUseDriver> {
  const component = await loadComputerUseHelperComponent(configuration);
  if (configuration.platform === "macos") {
    const helper = await startMacOsNativeHelperChildProcess({
      authenticatedSession: {
        authentication: "adr-0011-ed25519-v2",
        helperInstanceId: binding.helperInstanceId,
        osSessionIdentity: binding.osSessionIdentity,
        releaseVersion: binding.releaseVersion,
        serviceEpoch: binding.serviceEpoch,
      },
      executablePath: component.path,
      expectedExecutableSha256: component.sha256,
      parentProcessId: process.pid,
    });
    const driver = new MacOsNativeComputerUseDriver({ helper });
    return attachClose(driver, () => helper.close());
  }
  if (configuration.platform === "linux") {
    const helper = await startLinuxNativeHelperChildProcess({
      authenticatedSession: {
        authentication: "adr-0011-ed25519-v2",
        helperInstanceId: binding.helperInstanceId,
        osSessionIdentity: binding.osSessionIdentity,
        releaseVersion: binding.releaseVersion,
        serviceEpoch: binding.serviceEpoch,
      },
      executablePath: component.path,
      expectedExecutableSha256: component.sha256,
      desktopEnvironment: process.env,
      parentProcessId: process.pid,
    });
    const driver = new LinuxNativeComputerUseDriver({ helper });
    return attachClose(driver, () => helper.close());
  }
  return await startWindowsNativeDriver(configuration, binding, component);
}

async function startWindowsNativeDriver(
  configuration: ServiceHostConfiguration,
  binding: SessionHelperNativeDriverBinding,
  component: NativeComponent,
): Promise<NativeComputerUseDriver> {
  if (process.platform !== "win32") {
    throw new ServiceHostError("The Windows native helper requires Windows.");
  }
  const pipeRoot = configuration.localIpc.endpoint.slice(
    0,
    configuration.localIpc.endpoint.lastIndexOf("\\"),
  );
  const pipePath = `${pipeRoot}\\computer-use-${binding.helperInstanceId}`;
  const secret = randomBytes(32);
  let child: ChildProcess | undefined;
  let closed = false;
  try {
    child = spawn(
      component.path,
      [
        "serve",
        "--pipe",
        pipePath,
        "--device-id",
        configuration.deviceId,
        "--helper-instance-id",
        binding.helperInstanceId,
        "--service-epoch",
        String(binding.serviceEpoch),
        "--session-identity",
        binding.osSessionIdentity,
        "--release-version",
        binding.releaseVersion,
        "--capture-mode",
        "picker",
        "--secret-descriptor",
        "3",
        "--parent-process-id",
        String(process.pid),
      ],
      {
        cwd: configuration.releaseRoot,
        env: Object.freeze({}),
        stdio: ["ignore", "ignore", "pipe", "pipe"],
        windowsHide: false,
      },
    );
    await waitForSpawn(child);
    discardBounded(child.stderr, 64 * 1024);
    const bootstrap = child.stdio[3];
    if (bootstrap === null || typeof (bootstrap as Writable).write !== "function") {
      throw new ServiceHostError("The Windows native helper bootstrap pipe is unavailable.");
    }
    await writeBootstrapSecret(bootstrap as Writable, secret);
    const helper = createWindowsNamedPipeAuthenticatedHelperPort({
      pipePath,
      deviceId: configuration.deviceId,
      secretReference: WINDOWS_NATIVE_SECRET_REFERENCE,
      secrets: {
        async resolve(reference) {
          if (closed || reference !== WINDOWS_NATIVE_SECRET_REFERENCE) {
            throw new Error("The private Windows native helper Secret is unavailable.");
          }
          return Buffer.from(secret);
        },
      },
    });
    const driver = createWindowsNativeComputerUseDriver({
      helper,
      expectedHelperInstanceId: binding.helperInstanceId,
      expectedServiceEpoch: binding.serviceEpoch,
      expectedSessionIdentity: binding.osSessionIdentity,
      releaseVersion: binding.releaseVersion,
    });
    binding.signal.addEventListener(
      "abort",
      () => {
        closed = true;
        secret.fill(0);
        terminateChild(child);
      },
      { once: true },
    );
    return attachClose(driver, async () => {
      if (closed) {
        return;
      }
      closed = true;
      secret.fill(0);
      await terminateChild(child);
    });
  } catch (error: unknown) {
    closed = true;
    secret.fill(0);
    await terminateChild(child);
    if (error instanceof ServiceHostError) {
      throw error;
    }
    throw new ServiceHostError("The Windows native helper could not start safely.");
  }
}

async function loadComputerUseHelperComponent(
  configuration: ServiceHostConfiguration,
): Promise<NativeComponent> {
  const manifestPath = join(configuration.releaseRoot, "native-components.json");
  const manifest = await readStableJson(manifestPath, MAX_NATIVE_MANIFEST_BYTES);
  const record = requireRecord(manifest);
  if (
    !hasExactKeys(record, ["schemaVersion", "platform", "architecture", "components"]) ||
    record["schemaVersion"] !== 1 ||
    record["platform"] !== platform() ||
    record["architecture"] !== arch() ||
    !Array.isArray(record["components"])
  ) {
    throw new ServiceHostError("The native component manifest is invalid.");
  }
  const matches = record["components"].filter((entry) => {
    const component = requireRecord(entry);
    return component["kind"] === "computer-use-helper";
  });
  if (matches.length !== 1) {
    throw new ServiceHostError("The native Computer Use helper is not uniquely declared.");
  }
  const component = requireRecord(matches[0]);
  if (
    !hasExactKeys(component, ["kind", "path", "sha256"]) ||
    typeof component["path"] !== "string" ||
    !/^[A-Za-z0-9._/-]+$/u.test(component["path"]) ||
    isAbsolute(component["path"]) ||
    component["path"].split("/").includes("..") ||
    typeof component["sha256"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(component["sha256"])
  ) {
    throw new ServiceHostError("The native Computer Use helper declaration is invalid.");
  }
  const expectedRelativePath =
    configuration.platform === "windows"
      ? "libexec/opendelegate-windows-computer-use-helper.exe"
      : configuration.platform === "macos"
        ? "libexec/opendelegate-macos-computer-use"
        : "libexec/opendelegate-linux-computer-use";
  if (component["path"] !== expectedRelativePath) {
    throw new ServiceHostError("The native Computer Use helper path is invalid.");
  }
  const executablePath = resolve(configuration.releaseRoot, ...component["path"].split("/"));
  await verifyPinnedFile(
    configuration.releaseRoot,
    executablePath,
    component["sha256"] as `sha256:${string}`,
  );
  return Object.freeze({
    path: executablePath,
    sha256: component["sha256"] as `sha256:${string}`,
  });
}

async function readStableJson(path: string, maximumBytes: number): Promise<unknown> {
  let handle;
  try {
    if ((await realpath(path)) !== resolve(path)) {
      throw new Error("linked");
    }
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      throw new Error("invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      bytes.fill(0);
      throw new Error("unstable");
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new ServiceHostError("The native component manifest is unavailable.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyPinnedFile(
  releaseRoot: string,
  path: string,
  expectedSha256: `sha256:${string}`,
): Promise<void> {
  let handle;
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(releaseRoot),
      realpath(path),
    ]);
    const relationship = relative(canonicalRoot, canonicalPath);
    if (
      relationship === "" ||
      isAbsolute(relationship) ||
      relationship === ".." ||
      relationship.startsWith(`..\\`) ||
      relationship.startsWith("../")
    ) {
      throw new Error("escaped");
    }
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_NATIVE_EXECUTABLE_BYTES) {
      throw new Error("invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    try {
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expectedSha256
      ) {
        throw new Error("changed");
      }
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new ServiceHostError("The native Computer Use helper failed integrity verification.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function attachClose(
  driver: NativeComputerUseDriver,
  close: () => Promise<void>,
): NativeComputerUseDriver {
  Object.defineProperty(driver, "close", {
    configurable: false,
    enumerable: false,
    value: close,
    writable: false,
  });
  return driver;
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) {
    return;
  }
  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
}

async function writeBootstrapSecret(stream: Writable, secret: Buffer): Promise<void> {
  const bootstrap = Buffer.from(secret);
  try {
    await new Promise<void>((resolveWrite, reject) => {
      stream.end(bootstrap, (error?: Error | null) => {
        if (error === null || error === undefined) {
          resolveWrite();
        } else {
          reject(error);
        }
      });
    });
  } finally {
    bootstrap.fill(0);
  }
}

function discardBounded(stream: Readable | null, maximumBytes: number): void {
  let bytes = 0;
  stream?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    chunk.fill(0);
    if (bytes > maximumBytes) {
      stream.destroy();
    }
  });
}

async function terminateChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([waitForExit(child), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child).catch(() => undefined);
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceHostError("The native component manifest is invalid.");
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}
