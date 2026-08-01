import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { AgentAdapterError } from "./errors.ts";

export type AgentProviderHomeOwner = "claude" | "codex";

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

export async function prepareControlledProviderHome(path: string, provider: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  const canonical = await realpath(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameFilesystemPath(canonical, path)
  ) {
    throw new AgentAdapterError(
      "CONTROLLED_PROVIDER_HOME_UNSAFE",
      `The configured ${provider} provider home is unsafe.`,
    );
  }
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
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
