import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";

import type {
  PlatformMutationExecutableId,
  PlatformPackageManager,
} from "@opendelegate/platform-services";

import type { WorkerSystemPackageSourceVerifier } from "./platform-mutation-safety-boundary.ts";

const MAXIMUM_MANAGER_EXECUTABLE_BYTES = 128 * 1_048_576;

const SYSTEM_PACKAGE_MANAGERS: Readonly<
  Record<"linux" | "macos" | "windows", ReadonlySet<PlatformPackageManager>>
> = Object.freeze({
  linux: new Set<PlatformPackageManager>(["apt", "apt-get", "dnf", "yum", "zypper"]),
  macos: new Set<PlatformPackageManager>(["brew"]),
  windows: new Set<PlatformPackageManager>(["winget", "choco"]),
});

interface ExecutablePin {
  readonly path: string;
  readonly identity: string;
  readonly digest: string;
}

export interface CreateConfiguredSystemPackageVerifierOptions {
  readonly platform: "linux" | "macos" | "windows";
  readonly executables: Readonly<Partial<Record<PlatformMutationExecutableId, string>>>;
}

/**
 * Pins the exact owner-configured system package-manager executable for this
 * Worker process. Package requests are already normalized to manager-specific
 * install-only arguments by platform-services; repository additions and remote
 * installers use separate protected action categories.
 *
 * A manager update during the process lifetime fails closed until Worker restart
 * re-pins the new executable. This prevents a configured path from being swapped
 * for unrelated code between setup and automatic execution.
 */
export async function createConfiguredSystemPackageVerifier(
  options: CreateConfiguredSystemPackageVerifierOptions,
): Promise<WorkerSystemPackageSourceVerifier> {
  const managers = SYSTEM_PACKAGE_MANAGERS[options.platform];
  const pins = new Map<PlatformPackageManager, ExecutablePin>();
  for (const manager of [...managers].sort()) {
    const executable = options.executables[manager];
    if (executable === undefined) {
      continue;
    }
    pins.set(manager, await pinExecutable(executable));
  }

  return Object.freeze({
    async verify(input: {
      readonly executable: string;
      readonly manager: PlatformMutationExecutableId;
    }) {
      if (!managers.has(input.manager as PlatformPackageManager)) {
        return false;
      }
      const manager = input.manager as PlatformPackageManager;
      const pin = pins.get(manager);
      if (pin === undefined || input.executable !== pin.path) {
        return false;
      }
      try {
        const observed = await pinExecutable(input.executable);
        return observed.identity === pin.identity && observed.digest === pin.digest;
      } catch {
        return false;
      }
    },
  });
}

async function pinExecutable(path: string): Promise<ExecutablePin> {
  const canonical = await realpath(path);
  if (canonical !== path) {
    throw new Error("A configured package-manager executable must already be canonical.");
  }
  const before = await lstat(canonical);
  assertSafeExecutable(before);
  const digest = await hashFile(canonical);
  const after = await lstat(canonical);
  assertSafeExecutable(after);
  if (fileIdentity(before) !== fileIdentity(after)) {
    throw new Error("The configured package-manager executable changed while it was pinned.");
  }
  return Object.freeze({
    path: canonical,
    identity: fileIdentity(after),
    digest,
  });
}

function assertSafeExecutable(metadata: Stats): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size <= 0 ||
    metadata.size > MAXIMUM_MANAGER_EXECUTABLE_BYTES ||
    (process.platform !== "win32" &&
      ((metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0))
  ) {
    throw new Error("The configured package-manager executable is not a stable private file.");
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  let observedBytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1_024 })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    observedBytes += bytes.byteLength;
    if (observedBytes > MAXIMUM_MANAGER_EXECUTABLE_BYTES) {
      throw new Error("The configured package-manager executable exceeded its size limit.");
    }
    hash.update(bytes);
  }
  if (observedBytes === 0) {
    throw new Error("The configured package-manager executable is empty.");
  }
  return `sha256:${hash.digest("hex")}`;
}

function fileIdentity(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.nlink,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
  ].join(":");
}
