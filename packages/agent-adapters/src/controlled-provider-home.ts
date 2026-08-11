import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { AgentAdapterError } from "./errors.ts";

export type AgentProviderHomeOwner = "claude" | "codex";

interface ControlledProviderHomeMetadata {
  readonly canonicalPath?: string;
  readonly kind: "directory" | "missing" | "unsafe";
  readonly mode?: number;
}

export interface ControlledProviderHomeFileSystem {
  inspect(path: string): Promise<ControlledProviderHomeMetadata>;
  ensureDirectory(path: string, mode: number): Promise<void>;
  setMode(path: string, mode: number): Promise<void>;
}

export interface PrepareControlledProviderHomeOptions {
  readonly fileSystem?: ControlledProviderHomeFileSystem;
  readonly hostPlatform?: NodeJS.Platform;
}

const nativeProviderHomeFileSystem: ControlledProviderHomeFileSystem = {
  async inspect(path) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        return { kind: "unsafe" };
      }
      return {
        canonicalPath: await realpath(path),
        kind: "directory",
        mode: metadata.mode & 0o777,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "missing" };
      }
      throw error;
    }
  },
  async ensureDirectory(path, mode) {
    await mkdir(path, { recursive: true, mode });
  },
  async setMode(path, mode) {
    await chmod(path, mode);
  },
};

/**
 * The provider home the owner already authenticated on this Device.
 *
 * Codex and Claude each keep authentication in one directory and expose no
 * separate credential selector, so a home OpenDelegate invents is a home the
 * owner has to log into a second time. Resolving the owner's existing directory
 * means one login on a Device serves every local consumer of that provider.
 *
 * Returns undefined only when the Device exposes no usable home directory, which
 * leaves the caller to fall back to a managed home.
 */
export function resolveOwnerProviderHome(
  provider: AgentProviderHomeOwner,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory: string = safeHomeDirectory(),
): string | undefined {
  const configured = environment[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"];
  if (typeof configured === "string" && configured.trim().length > 0 && isAbsolute(configured)) {
    return resolve(configured);
  }
  if (homeDirectory.length === 0 || !isAbsolute(homeDirectory)) {
    return undefined;
  }
  return join(resolve(homeDirectory), provider === "codex" ? ".codex" : ".claude");
}

/**
 * True when the provider's own default home is the one an adapter probes.
 *
 * A remedy that names an environment variable the owner does not need invites
 * them to build a command instead of running one, so it is worth knowing when
 * the bare sign-in command already lands in the right directory.
 */
export function isDefaultProviderHome(
  provider: AgentProviderHomeOwner,
  home: string,
  homeDirectory: string = safeHomeDirectory(),
): boolean {
  const fallback = resolveOwnerProviderHome(provider, {}, homeDirectory);
  return fallback !== undefined && sameFilesystemPath(fallback, resolve(home));
}

function safeHomeDirectory(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

export function resolveControlledProviderHome(path: string, provider: string): string {
  if (!isAbsolute(path)) {
    throw new AgentAdapterError(
      "CONTROLLED_PROVIDER_HOME_REQUIRED",
      `The ${provider} adapter requires an absolute configured provider home.`,
    );
  }
  return resolve(path);
}

export async function prepareControlledProviderHome(
  path: string,
  provider: string,
  options: PrepareControlledProviderHomeOptions = {},
): Promise<void> {
  const fileSystem = options.fileSystem ?? nativeProviderHomeFileSystem;
  let metadata = await fileSystem.inspect(path);
  const created = metadata.kind === "missing";
  if (created) {
    await fileSystem.ensureDirectory(path, 0o700);
    metadata = await fileSystem.inspect(path);
  }
  if (
    metadata.kind !== "directory" ||
    metadata.canonicalPath === undefined ||
    !sameFilesystemPath(metadata.canonicalPath, path)
  ) {
    throw new AgentAdapterError(
      "CONTROLLED_PROVIDER_HOME_UNSAFE",
      `The configured ${provider} provider home is unsafe.`,
    );
  }
  if ((options.hostPlatform ?? process.platform) !== "win32") {
    if (metadata.mode === undefined || (metadata.mode & 0o002) !== 0) {
      throw new AgentAdapterError(
        "CONTROLLED_PROVIDER_HOME_UNSAFE",
        `The configured ${provider} provider home has unsafe access permissions.`,
      );
    }
    if (created) {
      await fileSystem.setMode(path, 0o700);
    }
  }
}

export function assertProviderHomeNotInSecretEnvironment(
  variableName: string,
  secretEnvironment?: Readonly<Record<string, string>>,
): void {
  if (secretEnvironment?.[variableName] !== undefined) {
    throw new AgentAdapterError(
      "CONTROLLED_PROVIDER_HOME_OVERRIDE",
      `${variableName} is owned by OpenDelegate and cannot be supplied as a Run secret.`,
    );
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}
