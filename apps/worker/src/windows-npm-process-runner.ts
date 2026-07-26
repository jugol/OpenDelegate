import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  PlatformMutationError,
  type PlatformMutationProcessRequest,
  type PlatformMutationProcessRunner,
} from "@opendelegate/platform-services";

const MAXIMUM_NPM_COMMAND_BYTES = 64 * 1024;
const MAXIMUM_NODE_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_NPM_CLI_BYTES = 4 * 1024 * 1024;

interface PinnedRegularFile {
  readonly path: string;
  readonly digest: `sha256:${string}`;
  readonly identity: string;
  readonly maximumBytes: number;
}

export interface CreatePinnedWindowsNpmProcessRunnerOptions {
  readonly npmCommandPath: string;
  readonly runner: PlatformMutationProcessRunner;
}

/**
 * Converts the Windows npm.cmd installation entry point into a shell-free,
 * typed Node launch. The exact command, node.exe, and npm-cli.js files are
 * pinned at composition time and revalidated at the final process seam.
 */
export async function createPinnedWindowsNpmProcessRunner(
  options: CreatePinnedWindowsNpmProcessRunnerOptions,
): Promise<PlatformMutationProcessRunner> {
  if (
    !isAbsolute(options.npmCommandPath) ||
    basename(options.npmCommandPath).toLocaleLowerCase("en-US") !== "npm.cmd" ||
    options.runner === null ||
    typeof options.runner !== "object" ||
    typeof options.runner.run !== "function"
  ) {
    throw unsafeLauncher();
  }
  const npmCommand = await pinRegularFile(options.npmCommandPath, MAXIMUM_NPM_COMMAND_BYTES, false);
  const installationRoot = dirname(npmCommand.path);
  const nodeExecutable = await pinRegularFile(
    join(installationRoot, "node.exe"),
    MAXIMUM_NODE_EXECUTABLE_BYTES,
    true,
  );
  const npmCli = await pinRegularFile(
    join(installationRoot, "node_modules", "npm", "bin", "npm-cli.js"),
    MAXIMUM_NPM_CLI_BYTES,
    false,
  );

  return Object.freeze({
    async run(request: PlatformMutationProcessRequest) {
      if (request.executableId !== "npm") {
        return options.runner.run(request);
      }
      if (
        request.executable !== npmCommand.path ||
        request.actionCategory !== "project-dependency-install"
      ) {
        throw unsafeLauncher();
      }
      await Promise.all([
        assertPinned(npmCommand),
        assertPinned(nodeExecutable),
        assertPinned(npmCli),
      ]);
      await Promise.all([
        assertPinnedIdentity(npmCommand),
        assertPinnedIdentity(nodeExecutable),
        assertPinnedIdentity(npmCli),
      ]);
      return options.runner.run(
        Object.freeze({
          ...request,
          executable: nodeExecutable.path,
          arguments: Object.freeze([npmCli.path, ...request.arguments]),
        }),
      );
    },
  });
}

async function pinRegularFile(
  path: string,
  maximumBytes: number,
  requirePosixExecutable: boolean,
): Promise<PinnedRegularFile> {
  const canonical = await canonicalExactPath(path);
  const inspection = await inspectStableRegularFile(
    canonical,
    maximumBytes,
    requirePosixExecutable,
  );
  return Object.freeze({
    path: canonical,
    digest: inspection.digest,
    identity: inspection.identity,
    maximumBytes,
  });
}

async function assertPinned(file: PinnedRegularFile): Promise<void> {
  const inspection = await inspectStableRegularFile(
    file.path,
    file.maximumBytes,
    basename(file.path).toLocaleLowerCase("en-US") === "node.exe",
  );
  if (inspection.identity !== file.identity || inspection.digest !== file.digest) {
    throw unsafeLauncher();
  }
}

async function assertPinnedIdentity(file: PinnedRegularFile): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(file.path);
  } catch (error) {
    throw unsafeLauncher(error);
  }
  if (
    !safeRegularFile(metadata, file.maximumBytes, false) ||
    identity(metadata) !== file.identity
  ) {
    throw unsafeLauncher();
  }
}

async function inspectStableRegularFile(
  path: string,
  maximumBytes: number,
  requirePosixExecutable: boolean,
): Promise<{ readonly digest: `sha256:${string}`; readonly identity: string }> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    throw unsafeLauncher(error);
  }
  if (!safeRegularFile(before, maximumBytes, requirePosixExecutable)) {
    throw unsafeLauncher();
  }
  const digest = createHash("sha256");
  let bytesRead = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += bytes.byteLength;
      if (bytesRead > maximumBytes) {
        throw unsafeLauncher();
      }
      digest.update(bytes);
    }
  } catch (error) {
    if (error instanceof PlatformMutationError) {
      throw error;
    }
    throw unsafeLauncher(error);
  }
  let after: Stats;
  try {
    after = await lstat(path);
  } catch (error) {
    throw unsafeLauncher(error);
  }
  if (
    !safeRegularFile(after, maximumBytes, requirePosixExecutable) ||
    bytesRead !== before.size ||
    identity(before) !== identity(after)
  ) {
    throw unsafeLauncher();
  }
  return Object.freeze({
    digest: `sha256:${digest.digest("hex")}`,
    identity: identity(after),
  });
}

function safeRegularFile(
  metadata: Stats,
  maximumBytes: number,
  requirePosixExecutable: boolean,
): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    metadata.size > 0 &&
    metadata.size <= maximumBytes &&
    (!requirePosixExecutable || process.platform === "win32" || (metadata.mode & 0o111) !== 0)
  );
}

async function canonicalExactPath(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw unsafeLauncher(error);
  }
  const expected = resolve(path);
  const same =
    process.platform === "win32"
      ? canonical.toLocaleLowerCase("en-US") === expected.toLocaleLowerCase("en-US")
      : canonical === expected;
  if (!same) {
    throw unsafeLauncher();
  }
  return canonical;
}

function identity(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.nlink,
    metadata.size,
    metadata.birthtimeMs,
    metadata.ctimeMs,
    metadata.mtimeMs,
  ].join(":");
}

function unsafeLauncher(cause?: unknown): PlatformMutationError {
  return new PlatformMutationError(
    "MUTATION_REQUEST_INVALID",
    "The Windows npm launcher did not satisfy the pinned shell-free process boundary.",
    cause === undefined ? undefined : { cause },
  );
}
