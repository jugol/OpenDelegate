import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  assertNoLinkedPathComponents,
  assertPathOutsideRoots,
  assertSha256,
  hashStableRegularFile,
  requireCanonicalDirectory,
  requireExactKeys,
} from "./release-tooling-io.mjs";

const provenanceDetails = new WeakMap();
const fullCommitPattern = /^[0-9a-f]{40}$/u;
const safeRepositoryPathPattern = /^[A-Za-z0-9._/-]+$/u;
const maximumGitOutputBytes = 64 * 1024 * 1024;
const maximumGitPointerBytes = 16 * 1024;

export async function pinReleaseGitProvenance(input, dependencies = {}) {
  requireExactKeys(
    input,
    ["expectedExecutableSha256", "executablePath", "repositoryRoot"],
    "pinned release Git-provenance input",
  );
  assertSha256(input.expectedExecutableSha256, "Git executable");
  if (
    typeof input.executablePath !== "string" ||
    !isAbsolute(input.executablePath) ||
    input.executablePath.includes("\0")
  ) {
    throw new Error("The Git executable must use an explicit absolute path.");
  }
  const execute = dependencies.execute ?? executeGitProcess;
  if (typeof execute !== "function") {
    throw new Error("The pinned Git process boundary must be callable.");
  }
  const openGitMarker = dependencies.openGitMarker ?? open;
  if (typeof openGitMarker !== "function") {
    throw new Error("The pinned Git marker open boundary must be callable.");
  }

  const repositoryRoot = await requireCanonicalDirectory(
    input.repositoryRoot,
    "release source repository",
  );
  const repositoryIdentity = await requireDirectoryIdentity(
    repositoryRoot,
    "release source repository",
  );
  const executablePath = await requireCanonicalRegularFile(input.executablePath, "Git executable");
  const executable = await hashStableRegularFile(executablePath);
  if (executable.sha256 !== input.expectedExecutableSha256) {
    throw new Error("The Git executable does not match its required SHA-256 pin.");
  }
  const gitBinding = await resolveGitDirectory(repositoryRoot, openGitMarker);
  assertPathOutsideRoots(
    executablePath,
    [repositoryRoot, gitBinding.gitDirectory],
    "Git executable",
  );

  const details = {
    execute,
    executableIdentity: await lstat(executablePath, { bigint: true }),
    executablePath,
    executableSha256: executable.sha256,
    gitBinding,
    openGitMarker,
    repositoryIdentity,
    repositoryRoot,
  };
  const source = await readCurrentSourceIdentity(details);
  const description = Object.freeze({
    gitExecutableSha256: executable.sha256,
    source: Object.freeze({ ...source }),
  });
  const handle = Object.freeze({ description });
  provenanceDetails.set(handle, Object.freeze({ ...details, description }));
  return handle;
}

export async function readPinnedReleaseSourceIdentity(handle) {
  return Object.freeze({ ...(await readCurrentSourceIdentity(requireDetails(handle))) });
}

export async function revalidatePinnedReleaseGitProvenance(handle) {
  const details = requireDetails(handle);
  const source = await readCurrentSourceIdentity(details);
  if (
    source.commit !== details.description.source.commit ||
    source.commitEpoch !== details.description.source.commitEpoch ||
    source.dirty !== details.description.source.dirty
  ) {
    throw new Error("The pinned release source identity changed during authorization.");
  }
  return Object.freeze({ ...source });
}

export async function assertPinnedReleaseGitFilesMatchCommit(handle, paths) {
  const details = requireDetails(handle);
  const normalizedPaths = validateRepositoryPaths(paths);
  await revalidatePinnedReleaseGitProvenance(handle);
  for (const path of normalizedPaths) {
    const absolutePath = join(details.repositoryRoot, ...path.split("/"));
    const current = await hashStableRegularFile(absolutePath, maximumGitOutputBytes);
    const committed = await runPinnedReleaseGit(
      handle,
      ["cat-file", "blob", `${details.description.source.commit}:${path}`],
      { encoding: null, maximumOutputBytes: maximumGitOutputBytes },
    );
    const committedSha256 = createHash("sha256").update(committed.stdout).digest("hex");
    if (current.size !== committed.stdout.byteLength || current.sha256 !== committedSha256) {
      throw new Error(
        `The running release file does not match pinned commit ${details.description.source.commit}: ${path}.`,
      );
    }
  }
  await revalidatePinnedReleaseGitProvenance(handle);
}

export async function runPinnedReleaseGit(handle, arguments_, options = {}) {
  const details = requireDetails(handle);
  if (
    !Array.isArray(arguments_) ||
    arguments_.length < 1 ||
    arguments_.some(
      (argument) => typeof argument !== "string" || argument.length < 1 || argument.includes("\0"),
    )
  ) {
    throw new Error("Pinned Git arguments must be non-empty NUL-free strings.");
  }
  const encoding = options.encoding === undefined ? "utf8" : options.encoding;
  if (encoding !== "utf8" && encoding !== null) {
    throw new Error("Pinned Git output supports only UTF-8 text or raw bytes.");
  }
  const outputLimit = options.maximumOutputBytes ?? maximumGitOutputBytes;
  if (
    !Number.isSafeInteger(outputLimit) ||
    outputLimit < 1 ||
    outputLimit > maximumGitOutputBytes
  ) {
    throw new Error("Pinned Git output must use a positive bounded byte limit.");
  }

  await revalidatePhysicalBindings(details);
  const result = await details.execute({
    arguments: gitArguments(details, arguments_),
    cwd: details.repositoryRoot,
    environment: sanitizedGitEnvironment(),
    executable: details.executablePath,
    maximumOutputBytes: outputLimit,
  });
  assertGitProcessResult(result);
  await revalidatePhysicalBindings(details);
  if (encoding === null) {
    return Object.freeze({
      stderr: Buffer.from(result.stderr),
      stdout: Buffer.from(result.stdout),
    });
  }
  return Object.freeze({
    stderr: Buffer.from(result.stderr).toString("utf8"),
    stdout: Buffer.from(result.stdout).toString("utf8"),
  });
}

async function readCurrentSourceIdentity(details) {
  const handle = temporaryHandle(details);
  try {
    const commit = (
      await runPinnedReleaseGit(handle, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
    if (!fullCommitPattern.test(commit)) {
      throw new Error("Git returned an invalid full source commit.");
    }
    const status = (
      await runPinnedReleaseGit(handle, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--no-renames",
      ])
    ).stdout;
    const commitEpoch = Number(
      (await runPinnedReleaseGit(handle, ["show", "-s", "--format=%ct", commit])).stdout.trim(),
    );
    if (!Number.isSafeInteger(commitEpoch) || commitEpoch < 0) {
      throw new Error("Git returned an invalid source commit timestamp.");
    }
    return Object.freeze({ commit, commitEpoch, dirty: status !== "" });
  } finally {
    provenanceDetails.delete(handle);
  }
}

function temporaryHandle(details) {
  const handle = Object.freeze({ description: details.description });
  provenanceDetails.set(handle, details);
  return handle;
}

function requireDetails(handle) {
  const details = provenanceDetails.get(handle);
  if (details === undefined) {
    throw new Error("An opaque pinned release Git-provenance handle is required.");
  }
  return details;
}

async function revalidatePhysicalBindings(details) {
  await assertNoLinkedPathComponents(details.executablePath, "Git executable");
  const [canonicalExecutable, executableIdentity, executable, repositoryRoot] = await Promise.all([
    realpath(details.executablePath),
    lstat(details.executablePath, { bigint: true }),
    hashStableRegularFile(details.executablePath),
    requireCanonicalDirectory(details.repositoryRoot, "release source repository"),
  ]);
  if (
    comparablePath(canonicalExecutable) !== comparablePath(details.executablePath) ||
    !sameFile(executableIdentity, details.executableIdentity) ||
    executable.sha256 !== details.executableSha256
  ) {
    throw new Error("The pinned Git executable changed or no longer matches its SHA-256.");
  }
  const repositoryIdentity = await requireDirectoryIdentity(
    repositoryRoot,
    "release source repository",
  );
  if (
    comparablePath(repositoryRoot) !== comparablePath(details.repositoryRoot) ||
    !sameFile(repositoryIdentity, details.repositoryIdentity)
  ) {
    throw new Error("The pinned release checkout changed its canonical directory identity.");
  }
  const gitBinding = await resolveGitDirectory(repositoryRoot, details.openGitMarker);
  if (
    comparablePath(gitBinding.gitDirectory) !== comparablePath(details.gitBinding.gitDirectory) ||
    gitBinding.marker.kind !== details.gitBinding.marker.kind ||
    !sameFile(gitBinding.gitDirectoryIdentity, details.gitBinding.gitDirectoryIdentity) ||
    !sameGitMarker(gitBinding.marker, details.gitBinding.marker) ||
    gitBinding.marker.sha256 !== details.gitBinding.marker.sha256
  ) {
    throw new Error("The pinned release checkout Git-directory binding changed.");
  }
}

async function resolveGitDirectory(repositoryRoot, openGitMarker) {
  const markerPath = join(repositoryRoot, ".git");
  const marker = await readStableGitMarker(markerPath, maximumGitPointerBytes, openGitMarker);
  if (marker.kind === "directory") {
    const gitDirectory = await requireCanonicalDirectory(
      markerPath,
      "release checkout Git directory",
    );
    const gitDirectoryIdentity = await requireDirectoryIdentity(
      gitDirectory,
      "release checkout Git directory",
    );
    if (!sameFile(marker.identity, gitDirectoryIdentity)) {
      throw new Error("The release checkout Git directory changed during binding.");
    }
    return Object.freeze({
      gitDirectory,
      gitDirectoryIdentity,
      marker: Object.freeze({
        identity: marker.identity,
        kind: "directory",
        sha256: null,
      }),
    });
  }
  const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/u.exec(marker.bytes.toString("utf8"));
  if (match === null || match[1].trim() !== match[1] || match[1] === "") {
    throw new Error("The linked-worktree .git marker is invalid.");
  }
  const requestedGitDirectory = isAbsolute(match[1])
    ? resolve(match[1])
    : resolve(dirname(markerPath), match[1]);
  const gitDirectory = await requireCanonicalDirectory(
    requestedGitDirectory,
    "release linked-worktree Git directory",
  );
  return Object.freeze({
    gitDirectory,
    gitDirectoryIdentity: await requireDirectoryIdentity(
      gitDirectory,
      "release linked-worktree Git directory",
    ),
    marker: Object.freeze({
      identity: marker.identity,
      kind: "file",
      sha256: marker.sha256,
    }),
  });
}

async function requireCanonicalRegularFile(path, label) {
  await assertNoLinkedPathComponents(path, label);
  const canonicalPath = await realpath(path);
  await assertNoLinkedPathComponents(canonicalPath, label);
  const metadata = await lstat(canonicalPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must resolve to an unlinked regular file.`);
  }
  return canonicalPath;
}

async function requireDirectoryIdentity(path, label) {
  const identity = await lstat(path, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.ino === 0n) {
    throw new Error(`The ${label} must have a stable unlinked directory identity.`);
  }
  return identity;
}

async function readStableGitMarker(path, maximumBytes, openGitMarker) {
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await openGitMarker(path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    const kind = opened.isDirectory() ? "directory" : opened.isFile() ? "file" : null;
    if (kind === null || opened.isSymbolicLink() || opened.ino === 0n) {
      throw new Error(
        "The release checkout must have an unlinked regular .git marker or directory.",
      );
    }
    if (
      kind === "file" &&
      (opened.size < 1n ||
        opened.size > BigInt(maximumBytes) ||
        opened.size > BigInt(Number.MAX_SAFE_INTEGER))
    ) {
      throw new Error("The linked-worktree .git marker must be a bounded regular file.");
    }
    await assertStableGitMarkerBinding(path, opened, kind, "before it was read");
    if (kind === "directory") {
      const after = await handle.stat({ bigint: true });
      if (!sameFile(opened, after)) {
        throw new Error("The release checkout Git directory changed during binding.");
      }
      await assertStableGitMarkerBinding(path, after, kind, "during binding");
      return Object.freeze({
        bytes: null,
        identity: opened,
        kind,
        sha256: null,
      });
    }

    const bytes = Buffer.alloc(Number(opened.size));
    let position = 0;
    while (position < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        bytes.byteLength - position,
        position,
      );
      if (bytesRead < 1) {
        throw new Error("The linked-worktree .git marker ended while it was read.");
      }
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStableRegularFile(opened, after)) {
      throw new Error("The linked-worktree .git marker changed while it was read.");
    }
    await assertStableGitMarkerBinding(path, after, kind, "while it was read");
    return Object.freeze({
      bytes,
      identity: opened,
      kind,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function assertStableGitMarkerBinding(path, opened, kind, phase) {
  await assertNoLinkedPathComponents(path, "release checkout Git marker");
  const current = await lstat(path, { bigint: true });
  const hasExpectedKind = kind === "directory" ? current.isDirectory() : current.isFile();
  const isSame =
    kind === "directory" ? sameFile(opened, current) : sameStableRegularFile(opened, current);
  if (current.isSymbolicLink() || !hasExpectedKind || !isSame) {
    throw new Error(`The release checkout Git marker changed ${phase}.`);
  }
}

function gitArguments(details, arguments_) {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return [
    "--no-pager",
    "--no-replace-objects",
    "--no-optional-locks",
    `--git-dir=${details.gitBinding.gitDirectory}`,
    `--work-tree=${details.repositoryRoot}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${nullDevice}`,
    "-c",
    `core.attributesFile=${nullDevice}`,
    "-c",
    "diff.external=",
    ...arguments_,
  ];
}

function sanitizedGitEnvironment() {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_FLUSH: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PATH: "",
  };
}

async function executeGitProcess(input) {
  const child = spawn(input.executable, input.arguments, {
    cwd: input.cwd,
    env: input.environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > input.maximumOutputBytes) {
      overflow = true;
      child.kill();
      return;
    }
    stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > input.maximumOutputBytes) {
      overflow = true;
      child.kill();
      return;
    }
    stderr.push(Buffer.from(chunk));
  });
  const exitCode = await new Promise((resolvePromise, reject) => {
    let settled = false;
    const settle = (operation, value) => {
      if (!settled) {
        settled = true;
        operation(value);
      }
    };
    child.once("error", (error) => settle(reject, error));
    child.once("close", (code) => settle(resolvePromise, code));
  });
  if (overflow) {
    throw new Error("Pinned Git produced output beyond its release-provenance limit.");
  }
  if (exitCode !== 0) {
    const command = input.arguments.at(-1) ?? "command";
    throw new Error(
      `Pinned Git ${command} failed with exit code ${String(exitCode)}${
        stderrBytes === 0 ? "" : `:\n${Buffer.concat(stderr).toString("utf8")}`
      }`,
    );
  }
  return Object.freeze({
    stderr: Buffer.concat(stderr),
    stdout: Buffer.concat(stdout),
  });
}

function assertGitProcessResult(result) {
  if (
    typeof result !== "object" ||
    result === null ||
    !(result.stdout instanceof Uint8Array) ||
    !(result.stderr instanceof Uint8Array)
  ) {
    throw new Error("The pinned Git process boundary returned an invalid result.");
  }
}

function validateRepositoryPaths(paths) {
  if (!Array.isArray(paths) || paths.length < 1) {
    throw new Error("At least one critical release file is required.");
  }
  const unique = new Set();
  for (const path of paths) {
    const segments = typeof path === "string" ? path.split("/") : [];
    if (
      typeof path !== "string" ||
      !safeRepositoryPathPattern.test(path) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      unique.has(path)
    ) {
      throw new Error("A critical release file path is not a unique safe repository path.");
    }
    unique.add(path);
  }
  return [...unique];
}

function sameFile(left, right) {
  return (
    (left.dev === 0n || right.dev === 0n || left.dev === right.dev) &&
    left.ino !== 0n &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function sameStableRegularFile(left, right) {
  return sameFile(left, right) && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameGitMarker(left, right) {
  return left.kind === "file"
    ? sameStableRegularFile(left.identity, right.identity)
    : sameFile(left.identity, right.identity);
}

function comparablePath(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
