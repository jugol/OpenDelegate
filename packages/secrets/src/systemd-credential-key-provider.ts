import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { SecretKeyProvider, SystemdCredentialKeyProviderConfig } from "./contracts.ts";
import { SecretError } from "./secret-error.ts";

const KEY_BYTES = 32;
const DEFAULT_CREDENTIAL_ROOT = "/run/credentials";

export class SystemdCredentialKeyProvider implements SecretKeyProvider {
  readonly #allowedCredentialRoot: string;
  readonly #credentialDirectory: string;
  readonly #credentialName: string;
  readonly #sourceCheckoutRoot: string;

  public constructor(config: SystemdCredentialKeyProviderConfig) {
    if ((config.hostPlatform ?? process.platform) !== "linux") {
      throw configurationInvalid();
    }
    this.#allowedCredentialRoot = validateAbsolutePath(
      config.allowedCredentialRoot ?? DEFAULT_CREDENTIAL_ROOT,
    );
    this.#credentialDirectory = validateAbsolutePath(config.credentialDirectory);
    this.#sourceCheckoutRoot = validateAbsolutePath(config.sourceCheckoutRoot);
    if (
      typeof config.credentialName !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(config.credentialName)
    ) {
      throw configurationInvalid();
    }
    this.#credentialName = config.credentialName;
    assertContained(this.#allowedCredentialRoot, this.#credentialDirectory);
    assertOutside(this.#sourceCheckoutRoot, this.#credentialDirectory);
  }

  public async executeWithKey(
    executor: (key: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    let handle;
    let key: Buffer | undefined;
    try {
      const canonicalRoot = await realpath(this.#allowedCredentialRoot);
      const canonicalDirectory = await realpath(this.#credentialDirectory);
      const canonicalSourceCheckout = await canonicalizeIfPresent(this.#sourceCheckoutRoot);
      if (
        !pathsEqual(canonicalRoot, this.#allowedCredentialRoot) ||
        !pathsEqual(canonicalDirectory, this.#credentialDirectory)
      ) {
        throw backendUnavailable();
      }
      assertContained(canonicalRoot, canonicalDirectory);
      assertOutside(canonicalSourceCheckout, canonicalDirectory);
      const directoryMetadata = await lstat(canonicalDirectory);
      if (
        !directoryMetadata.isDirectory() ||
        directoryMetadata.isSymbolicLink() ||
        (process.platform !== "win32" && (directoryMetadata.mode & 0o077) !== 0)
      ) {
        throw backendUnavailable();
      }

      const credentialPath = join(canonicalDirectory, this.#credentialName);
      const flags =
        process.platform === "win32"
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NOFOLLOW;
      handle = await open(credentialPath, flags);
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size !== KEY_BYTES ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      ) {
        throw backendUnavailable();
      }
      key = await handle.readFile();
      if (key.byteLength !== KEY_BYTES) {
        throw backendUnavailable();
      }
      try {
        await executor(key);
      } catch (error) {
        if (error instanceof SecretError) {
          throw error;
        }
        throw new SecretError(
          "SECRET_EXECUTOR_FAILED",
          "The scoped systemd credential executor failed.",
        );
      }
    } catch (error) {
      if (error instanceof SecretError) {
        throw error;
      }
      throw backendUnavailable();
    } finally {
      key?.fill(0);
      await handle?.close().catch(() => undefined);
    }
  }
}

async function canonicalizeIfPresent(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return path;
    }
    throw error;
  }
}

function validateAbsolutePath(value: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw configurationInvalid();
  }
  return resolve(value);
}

function assertContained(parent: string, child: string): void {
  const relationship = relative(resolve(parent), resolve(child));
  if (relationship === "" || relationship.startsWith("..") || isAbsolute(relationship)) {
    throw configurationInvalid();
  }
}

function assertOutside(parent: string, child: string): void {
  const relationship = relative(resolve(parent), resolve(child));
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw configurationInvalid();
  }
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function configurationInvalid(): SecretError {
  return new SecretError(
    "SECRET_CONFIGURATION_INVALID",
    "The systemd credential path configuration is invalid.",
  );
}

function backendUnavailable(): SecretError {
  return new SecretError(
    "SECRET_BACKEND_UNAVAILABLE",
    "The systemd runtime credential is unavailable or insecure.",
  );
}
