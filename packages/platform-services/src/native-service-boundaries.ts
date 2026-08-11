import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  constants as fileConstants,
  chmod,
  chown,
  copyFile,
  lchmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import type { PlatformFamily } from "./types.ts";

const MAXIMUM_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAXIMUM_HTTP_BODY_BYTES = 64 * 1024;

export type NativePathKind = "directory" | "missing" | "regular-file" | "special" | "symbolic-link";

export interface NativePathMetadata {
  readonly kind: NativePathKind;
  readonly size?: number;
  readonly modifiedAtMs?: number;
  readonly mode?: number;
}

export interface NativeDirectoryEntry {
  readonly name: string;
  readonly kind: Exclude<NativePathKind, "missing">;
}

export interface NativeFileSystemBoundary {
  inspect(path: string): Promise<NativePathMetadata>;
  realPath(path: string): Promise<string>;
  list(path: string): Promise<readonly NativeDirectoryEntry[]>;
  read(path: string, maximumBytes: number): Promise<Buffer>;
  ensureDirectory(path: string, mode: number): Promise<"changed" | "unchanged">;
  writeAtomic(path: string, bytes: Buffer, mode: number): Promise<"changed" | "unchanged">;
  copyRegularFile(source: string, destination: string): Promise<void>;
  renameAtomic(source: string, destination: string, replace: boolean): Promise<void>;
  createDirectoryLinkAtomic(
    target: string,
    linkPath: string,
    platform: PlatformFamily,
  ): Promise<"changed" | "unchanged">;
  readDirectoryLink(path: string): Promise<string | undefined>;
  remove(path: string, recursive: boolean): Promise<"changed" | "unchanged">;
  setPosixOwnershipAndMode(path: string, uid: number, gid: number, mode: number): Promise<void>;
  sameVolume(left: string, right: string): Promise<boolean>;
}

export interface NativeProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface NativeProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface NativeProcessBoundary {
  isExecutable(path: string): Promise<boolean>;
  isProcessAlive(processId: number): Promise<boolean>;
  run(request: NativeProcessRequest): Promise<NativeProcessResult>;
}

export interface NativePrivilegeBoundary {
  isElevated(platform: PlatformFamily, process: NativeProcessBoundary): Promise<boolean>;
}

export interface NativeClockBoundary {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface NativeHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface NativeHttpBoundary {
  get(url: string, timeoutMs: number): Promise<NativeHttpResponse>;
}

export interface NativeSessionBoundary {
  isOwnerLoggedIn(input: {
    readonly platform: PlatformFamily;
    readonly userName: string;
    readonly stableUserId: string;
    readonly uid?: number;
  }): Promise<boolean>;
}

export interface NativeServiceBoundaries {
  readonly fileSystem: NativeFileSystemBoundary;
  readonly process: NativeProcessBoundary;
  readonly privilege: NativePrivilegeBoundary;
  readonly clock: NativeClockBoundary;
  readonly http: NativeHttpBoundary;
  readonly session: NativeSessionBoundary;
}

export class NativeBoundaryError extends Error {
  public readonly code:
    "NATIVE_FILESYSTEM_UNSAFE" | "NATIVE_OUTPUT_LIMIT" | "NATIVE_PROCESS_FAILED";

  public constructor(code: NativeBoundaryError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeBoundaryError";
    this.code = code;
  }
}

export function createNodeNativeServiceBoundaries(): NativeServiceBoundaries {
  const process = new NodeNativeProcessBoundary();
  return {
    fileSystem: new NodeNativeFileSystemBoundary(),
    process,
    privilege: new NodeNativePrivilegeBoundary(),
    clock: {
      now: () => new Date(),
      sleep: async (milliseconds) =>
        new Promise<void>((resolveSleep) => {
          setTimeout(resolveSleep, milliseconds);
        }),
    },
    http: {
      async get(url, timeoutMs) {
        const response = await fetch(url, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return {
          status: response.status,
          body: await readBoundedHttpBody(response),
        };
      },
    },
    session: new NodeNativeSessionBoundary(process),
  };
}

class NodeNativeFileSystemBoundary implements NativeFileSystemBoundary {
  public async inspect(path: string): Promise<NativePathMetadata> {
    try {
      const metadata = await lstat(path);
      return {
        kind: metadata.isSymbolicLink()
          ? "symbolic-link"
          : metadata.isDirectory()
            ? "directory"
            : metadata.isFile()
              ? "regular-file"
              : "special",
        size: metadata.size,
        modifiedAtMs: metadata.mtimeMs,
        mode: metadata.mode & 0o777,
      };
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return { kind: "missing" };
      }
      throw error;
    }
  }

  public async realPath(path: string): Promise<string> {
    return await realpath(path);
  }

  public async list(path: string): Promise<readonly NativeDirectoryEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .map((entry): NativeDirectoryEntry => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? "symbolic-link"
          : entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "regular-file"
              : "special",
      }))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
  }

  public async read(path: string, maximumBytes: number): Promise<Buffer> {
    return await readStableRegularFile(path, maximumBytes);
  }

  public async ensureDirectory(path: string, mode: number): Promise<"changed" | "unchanged"> {
    const before = await this.inspect(path);
    if (before.kind === "directory") {
      await chmod(path, mode);
      return "unchanged";
    }
    if (before.kind !== "missing") {
      throw unsafePath("A native service directory path is occupied by a non-directory.");
    }
    await mkdir(path, { recursive: true, mode });
    const after = await this.inspect(path);
    if (after.kind !== "directory") {
      throw unsafePath("A native service directory was replaced during creation.");
    }
    await chmod(path, mode);
    return "changed";
  }

  public async writeAtomic(
    path: string,
    bytes: Buffer,
    mode: number,
  ): Promise<"changed" | "unchanged"> {
    const before = await this.inspect(path);
    if (before.kind === "regular-file") {
      const existing = await this.read(path, Math.max(bytes.length, 1) + 1);
      if (existing.equals(bytes)) {
        await chmod(path, mode);
        return "unchanged";
      }
    } else if (before.kind !== "missing") {
      throw unsafePath("An atomic service file path is occupied by a link or special file.");
    }

    const temporary = join(dirname(path), `.${randomUUID()}.opendelegate.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY,
        mode,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      await chmod(path, mode);
      await syncNativeDirectory(dirname(path));
      return "changed";
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  public async copyRegularFile(source: string, destination: string): Promise<void> {
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw unsafePath("Release staging accepts only regular source files.");
    }
    await copyFile(source, destination, fileConstants.COPYFILE_EXCL);
    const copied = await lstat(destination);
    if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== metadata.size) {
      throw unsafePath("A staged release file did not remain a regular file.");
    }
  }

  public async renameAtomic(source: string, destination: string, replace: boolean): Promise<void> {
    if (!replace && (await this.inspect(destination)).kind !== "missing") {
      throw unsafePath("An atomic promotion destination already exists.");
    }
    await rename(source, destination);
    await syncNativeDirectory(dirname(destination));
    if (dirname(source) !== dirname(destination)) {
      await syncNativeDirectory(dirname(source));
    }
  }

  public async createDirectoryLinkAtomic(
    target: string,
    linkPath: string,
    platform: PlatformFamily,
  ): Promise<"changed" | "unchanged"> {
    const currentTarget = await this.readDirectoryLink(linkPath);
    const normalizedTarget = resolve(target);
    const existing = await this.inspect(linkPath);
    if (
      currentTarget !== undefined &&
      resolve(dirname(linkPath), currentTarget) === normalizedTarget
    ) {
      if (platform === "macos" && existing.mode !== 0o750) {
        await lchmod(linkPath, 0o750);
        await syncNativeDirectory(dirname(linkPath));
        return "changed";
      }
      return "unchanged";
    }
    if (existing.kind !== "missing" && existing.kind !== "symbolic-link") {
      throw unsafePath("The stable service activation path is not a directory link.");
    }
    const temporary = `${linkPath}.${randomUUID()}.opendelegate-link`;
    try {
      await symlink(target, temporary, platform === "windows" ? "junction" : "dir");
      if (platform === "macos") {
        await lchmod(temporary, 0o750);
      }
      if (platform === "windows" && existing.kind === "symbolic-link") {
        await replaceWindowsDirectoryLink(temporary, linkPath);
      } else {
        await rename(temporary, linkPath);
      }
      await syncNativeDirectory(dirname(linkPath));
      return "changed";
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  public async readDirectoryLink(path: string): Promise<string | undefined> {
    const metadata = await this.inspect(path);
    if (metadata.kind === "missing") {
      return undefined;
    }
    if (metadata.kind !== "symbolic-link") {
      throw unsafePath("The stable service activation path is not a symbolic directory link.");
    }
    return await readlink(path);
  }

  public async remove(path: string, recursive: boolean): Promise<"changed" | "unchanged"> {
    const metadata = await this.inspect(path);
    if (metadata.kind === "missing") {
      return "unchanged";
    }
    if (recursive && metadata.kind === "directory") {
      await assertLinkFreeTree(this, path);
    } else if (
      metadata.kind !== "regular-file" &&
      metadata.kind !== "symbolic-link" &&
      metadata.kind !== "directory"
    ) {
      throw unsafePath("The native service adapter refused to remove a special file.");
    }
    await rm(path, {
      force: false,
      recursive,
    });
    await syncNativeDirectory(dirname(path));
    return "changed";
  }

  public async setPosixOwnershipAndMode(
    path: string,
    uid: number,
    gid: number,
    mode: number,
  ): Promise<void> {
    await chown(path, uid, gid);
    await chmod(path, mode);
  }

  public async sameVolume(left: string, right: string): Promise<boolean> {
    const [leftExisting, rightExisting] = await Promise.all([
      nearestExistingPath(this, left),
      nearestExistingPath(this, right),
    ]);
    const [leftMetadata, rightMetadata] = await Promise.all([
      stat(leftExisting),
      stat(rightExisting),
    ]);
    return leftMetadata.dev === rightMetadata.dev;
  }
}

async function replaceWindowsDirectoryLink(source: string, destination: string): Promise<void> {
  const previous = `${destination}.${randomUUID()}.opendelegate-previous-link`;
  await rename(destination, previous);
  try {
    await rename(source, destination);
  } catch (error) {
    try {
      await rename(previous, destination);
    } catch (restoreError) {
      throw unsafePath(
        `The Windows activation pointer could not be installed or restored (${safeErrorCode(error)}/${safeErrorCode(restoreError)}).`,
      );
    }
    throw error;
  }

  try {
    await rm(previous, { force: true });
  } catch (error) {
    const rejected = `${destination}.${randomUUID()}.opendelegate-rejected-link`;
    try {
      await rename(destination, rejected);
      await rename(previous, destination);
      await rm(rejected, { force: true });
    } catch (restoreError) {
      throw unsafePath(
        `The Windows activation pointer cleanup could not be rolled back (${safeErrorCode(error)}/${safeErrorCode(restoreError)}).`,
      );
    }
    throw error;
  }
}

function safeErrorCode(error: unknown): string {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

class NodeNativeProcessBoundary implements NativeProcessBoundary {
  public async isExecutable(path: string): Promise<boolean> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return false;
      }
      await import("node:fs/promises").then(({ access }) =>
        access(path, hostPlatform() === "win32" ? fileConstants.F_OK : fileConstants.X_OK),
      );
      return true;
    } catch {
      return false;
    }
  }

  public async isProcessAlive(processId: number): Promise<boolean> {
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      return false;
    }
    try {
      globalThis.process.kill(processId, 0);
      return true;
    } catch (error: unknown) {
      const code = safeErrorCode(error);
      if (code === "ESRCH") {
        return false;
      }
      if (code === "EPERM") {
        return true;
      }
      throw new NativeBoundaryError(
        "NATIVE_PROCESS_FAILED",
        "A native process lifetime could not be inspected.",
        { cause: error },
      );
    }
  }

  public async run(request: NativeProcessRequest): Promise<NativeProcessResult> {
    assertProcessRequest(request);
    return await new Promise<NativeProcessResult>((resolveRun, rejectRun) => {
      const child = spawn(request.executable, [...request.arguments], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: createChildEnvironment(request.environment),
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let timedOut = false;
      let settled = false;
      let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
      let abandonmentTimeout: ReturnType<typeof setTimeout> | undefined;
      const clearTimers = (): void => {
        clearTimeout(timeout);
        if (forceKillTimeout !== undefined) {
          clearTimeout(forceKillTimeout);
        }
        if (abandonmentTimeout !== undefined) {
          clearTimeout(abandonmentTimeout);
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 1_000);
        abandonmentTimeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            clearTimers();
            resolveRun({
              exitCode: -1,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
              timedOut: true,
            });
          }
        }, 5_000);
      }, request.timeoutMs);
      const collect = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > MAXIMUM_PROCESS_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          if (!settled) {
            settled = true;
            clearTimers();
            rejectRun(
              new NativeBoundaryError(
                "NATIVE_OUTPUT_LIMIT",
                "A native service command exceeded its bounded output limit.",
              ),
            );
          }
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimers();
          rejectRun(
            new NativeBoundaryError(
              "NATIVE_PROCESS_FAILED",
              "A native service command could not be started.",
              { cause: error },
            ),
          );
        }
      });
      child.once("close", (exitCode) => {
        if (!settled) {
          settled = true;
          clearTimers();
          resolveRun({
            exitCode: exitCode ?? -1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            timedOut,
          });
        }
      });
    });
  }
}

class NodeNativePrivilegeBoundary implements NativePrivilegeBoundary {
  public async isElevated(
    platform: PlatformFamily,
    process: NativeProcessBoundary,
  ): Promise<boolean> {
    if (platform !== "windows") {
      return globalThis.process.getuid?.() === 0;
    }
    const systemRoot = globalThis.process.env["SystemRoot"] ?? "C:\\Windows";
    const whoami = join(systemRoot, "System32", "whoami.exe");
    if (!(await process.isExecutable(whoami))) {
      return false;
    }
    const result = await process.run({
      executable: whoami,
      arguments: ["/groups", "/fo", "csv", "/nh"],
      timeoutMs: 10_000,
    });
    return result.exitCode === 0 && /S-1-16-(?:12288|16384)(?:"|,|\r|\n)/u.test(result.stdout);
  }
}

class NodeNativeSessionBoundary implements NativeSessionBoundary {
  private readonly processBoundary: NativeProcessBoundary;

  public constructor(processBoundary: NativeProcessBoundary) {
    this.processBoundary = processBoundary;
  }

  public async isOwnerLoggedIn(input: {
    readonly platform: PlatformFamily;
    readonly userName: string;
    readonly stableUserId: string;
    readonly uid?: number;
  }): Promise<boolean> {
    const invocation =
      input.platform === "windows"
        ? windowsLoginProbe(input.userName)
        : input.platform === "macos"
          ? macOsLoginProbe(input.uid)
          : linuxLoginProbe(input.uid, input.userName);
    if (
      invocation === undefined ||
      !(await this.processBoundary.isExecutable(invocation.executable))
    ) {
      return false;
    }
    const result = await this.processBoundary.run(invocation);
    return input.platform === "windows"
      ? windowsOwnerSessionProbeSucceeded(input.userName, result)
      : result.exitCode === 0;
  }
}

/**
 * `query.exe user <name>` can return exit code 1 on localized Windows builds
 * even while stdout contains the matching interactive session row. Treat that
 * narrow, observable result as logged in without accepting the command's
 * similarly worded "No User exists" diagnostic.
 */
export function windowsOwnerSessionProbeSucceeded(
  userName: string,
  result: Pick<NativeProcessResult, "exitCode" | "stdout" | "timedOut">,
): boolean {
  if (result.timedOut) {
    return false;
  }
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode !== 1) {
    return false;
  }
  const queryUserName = userName.slice(userName.lastIndexOf("\\") + 1);
  const escapedUserName = queryUserName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const sessionRow = new RegExp(`^\\s*>?\\s*${escapedUserName}(?:\\s{2,}|\\t|$)`, "iu");
  return result.stdout.split(/\r?\n/u).some((line) => sessionRow.test(line));
}

function windowsLoginProbe(userName: string): NativeProcessRequest {
  const systemRoot = globalThis.process.env["SystemRoot"] ?? "C:\\Windows";
  const queryUserName = userName.slice(userName.lastIndexOf("\\") + 1);
  return {
    executable: join(systemRoot, "System32", "query.exe"),
    arguments: ["user", queryUserName],
    timeoutMs: 10_000,
  };
}

function macOsLoginProbe(uid: number | undefined): NativeProcessRequest | undefined {
  return uid === undefined
    ? undefined
    : {
        executable: "/bin/launchctl",
        arguments: ["print", `gui/${String(uid)}`],
        timeoutMs: 10_000,
      };
}

function linuxLoginProbe(
  uid: number | undefined,
  userName: string,
): NativeProcessRequest | undefined {
  return uid === undefined
    ? undefined
    : {
        executable: "/usr/sbin/runuser",
        arguments: ["-u", userName, "--", "/usr/bin/systemctl", "--user", "show-environment"],
        timeoutMs: 10_000,
        environment: {
          XDG_RUNTIME_DIR: `/run/user/${String(uid)}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${String(uid)}/bus`,
        },
      };
}

async function assertLinkFreeTree(
  fileSystem: NativeFileSystemBoundary,
  root: string,
): Promise<void> {
  for (const entry of await fileSystem.list(root)) {
    const path = join(root, entry.name);
    if (entry.kind === "symbolic-link" || entry.kind === "special") {
      throw unsafePath("Recursive native service removal refused a link or special entry.");
    }
    if (entry.kind === "directory") {
      await assertLinkFreeTree(fileSystem, path);
    }
  }
}

async function readStableRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw unsafePath("The native service file byte limit is invalid.");
  }
  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fileConstants.O_NONBLOCK ?? 0;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fileConstants.O_RDONLY | noFollow | nonBlocking);
  } catch (error) {
    if (isErrorCode(error, "ELOOP")) {
      throw unsafePath("The native service adapter refused a linked file.");
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const openedPath = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      !sameFile(opened, openedPath)
    ) {
      throw unsafePath("The native service adapter refused an unstable or non-regular file.");
    }
    if (opened.size > BigInt(maximumBytes)) {
      throw unsafePath("The native service adapter refused an oversized file.");
    }
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) {
        throw unsafePath("The native service adapter observed a file shrinking during a read.");
      }
      offset += result.bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    if ((await handle.read(overflowProbe, 0, 1, offset)).bytesRead !== 0) {
      throw unsafePath("The native service adapter observed a file growing past its byte limit.");
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameSnapshot(opened, after) ||
      !sameSnapshot(after, afterPath)
    ) {
      throw unsafePath("The native service adapter observed an unstable file.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readBoundedHttpBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAXIMUM_HTTP_BODY_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new NativeBoundaryError(
      "NATIVE_OUTPUT_LIMIT",
      "A native health response exceeded its bounded body limit.",
    );
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        return Buffer.concat(chunks, total).toString("utf8");
      }
      total += result.value.byteLength;
      if (total > MAXIMUM_HTTP_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new NativeBoundaryError(
          "NATIVE_OUTPUT_LIMIT",
          "A native health response exceeded its bounded body limit.",
        );
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino === right.ino &&
    (left.dev === right.dev ||
      (hostPlatform() === "win32" &&
        (left.dev === 0n || right.dev === 0n) &&
        left.birthtimeNs === right.birthtimeNs))
  );
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function nearestExistingPath(
  fileSystem: NativeFileSystemBoundary,
  path: string,
): Promise<string> {
  let candidate = resolve(path);
  for (;;) {
    if ((await fileSystem.inspect(candidate)).kind !== "missing") {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw unsafePath("No existing volume ancestor could be resolved.");
    }
    candidate = parent;
  }
}

async function syncNativeDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (
      hostPlatform() !== "win32" &&
      !isErrorCode(error, "EINVAL") &&
      !isErrorCode(error, "EISDIR")
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertProcessRequest(request: NativeProcessRequest): void {
  if (
    request.executable.trim() === "" ||
    request.executable.includes("\0") ||
    request.arguments.some(
      (argument) =>
        argument === "" ||
        argument.includes("\0") ||
        argument.includes("\n") ||
        argument.includes("secret://"),
    ) ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1_000 ||
    request.timeoutMs > 120_000
  ) {
    throw new NativeBoundaryError(
      "NATIVE_PROCESS_FAILED",
      "A native process request failed strict argv validation.",
    );
  }
}

function createChildEnvironment(
  additional: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv =
    hostPlatform() === "win32"
      ? {
          SystemRoot: globalThis.process.env["SystemRoot"] ?? "C:\\Windows",
          WINDIR: globalThis.process.env["WINDIR"] ?? "C:\\Windows",
          TEMP: globalThis.process.env["TEMP"],
          TMP: globalThis.process.env["TMP"],
        }
      : {
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C",
          LC_ALL: "C",
        };
  for (const [name, value] of Object.entries(additional ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) || value.includes("\0") || value.includes("\n")) {
      throw new NativeBoundaryError(
        "NATIVE_PROCESS_FAILED",
        "A native process environment override is invalid.",
      );
    }
    environment[name] = value;
  }
  return environment;
}

function unsafePath(message: string): NativeBoundaryError {
  return new NativeBoundaryError("NATIVE_FILESYSTEM_UNSAFE", message);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
