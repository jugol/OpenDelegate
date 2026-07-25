import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { AgentAdapterError } from "./errors.ts";

export function resolveControlledProviderHome(path: string, provider: string): string {
  if (!isAbsolute(path)) {
    throw new AgentAdapterError(
      "CONTROLLED_PROVIDER_HOME_REQUIRED",
      `The ${provider} adapter requires an absolute OpenDelegate-controlled home.`,
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
      `The OpenDelegate-controlled ${provider} home is unsafe.`,
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
