import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { SecretError } from "./secret-error.ts";
import { assertSecretIdentifier } from "./secret-validation.ts";

const DEFAULT_MAXIMUM_BLOB_BYTES = 1_048_576 + 128;
const VAULT_MARKER_NAME = ".opendelegate-secret-vault";

export interface SecureFileVaultConfig {
  readonly maximumBlobBytes?: number;
  readonly namespace: string;
  readonly sourceCheckoutRoot: string;
  readonly vaultRoot: string;
}

export class SecureFileVault {
  readonly #maximumBlobBytes: number;
  readonly #namespace: string;
  readonly #markerValue: Buffer;
  readonly #sourceCheckoutRoot: string;
  readonly #vaultRoot: string;

  public constructor(config: SecureFileVaultConfig) {
    assertSecretIdentifier(config.namespace, "Secret vault namespace");
    this.#namespace = config.namespace;
    this.#markerValue = Buffer.from(
      `OpenDelegate Secret vault v1\n${createHash("sha256")
        .update(config.namespace)
        .digest("hex")}\n`,
      "utf8",
    );
    this.#sourceCheckoutRoot = validateAbsolutePath(
      config.sourceCheckoutRoot,
      "Source checkout root",
    );
    this.#vaultRoot = validateAbsolutePath(config.vaultRoot, "Secret vault root");
    assertDisjointFromSourceCheckout(this.#sourceCheckoutRoot, this.#vaultRoot);
    this.#maximumBlobBytes = validateMaximumBlobBytes(
      config.maximumBlobBytes ?? DEFAULT_MAXIMUM_BLOB_BYTES,
    );
  }

  public async initialize(): Promise<void> {
    assertDisjointFromSourceCheckout(this.#sourceCheckoutRoot, this.#vaultRoot);
    try {
      await assertNoExistingPathLink(this.#vaultRoot);
      await mkdir(this.#vaultRoot, { mode: 0o700, recursive: true });
      await this.#assertSecureRoot();
      await this.#assertClaimedRoot();
    } catch (error) {
      if (error instanceof SecretError) {
        throw error;
      }
      throw vaultAccessFailed();
    }
  }

  public rootPath(): string {
    return this.#vaultRoot;
  }

  public async has(alias: string): Promise<boolean> {
    const target = await this.#target(alias);
    try {
      await assertRegularRestrictedFile(target);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return false;
      }
      if (error instanceof SecretError) {
        throw error;
      }
      throw vaultAccessFailed();
    }
  }

  public async create(alias: string, value: Uint8Array): Promise<void> {
    const target = await this.#target(alias);
    const copy = Buffer.from(value);
    let handle;
    try {
      handle = await open(target, "wx", 0o600);
      await handle.writeFile(copy);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertRegularRestrictedFile(target);
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (isNodeError(error, "EEXIST")) {
        throw new SecretError(
          "SECRET_ALIAS_CONFLICT",
          "The Secret alias already exists on this Device.",
        );
      }
      await rm(target, { force: true }).catch(() => undefined);
      if (error instanceof SecretError) {
        throw error;
      }
      throw vaultAccessFailed();
    } finally {
      copy.fill(0);
    }
  }

  public async replace(alias: string, value: Uint8Array): Promise<void> {
    const target = await this.#target(alias);
    try {
      await assertRegularRestrictedFile(target);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw aliasUnavailable();
      }
      if (error instanceof SecretError) {
        throw error;
      }
      throw vaultAccessFailed();
    }

    const temporary = `${target}.tmp-${randomBytes(12).toString("hex")}`;
    const copy = Buffer.from(value);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(copy);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertRegularRestrictedFile(temporary);
      await rename(temporary, target);
      await assertRegularRestrictedFile(target);
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof SecretError) {
        throw error;
      }
      throw vaultAccessFailed();
    } finally {
      copy.fill(0);
    }
  }

  public async read(alias: string): Promise<Uint8Array> {
    const target = await this.#target(alias);
    let handle;
    try {
      const flags =
        process.platform === "win32"
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NOFOLLOW;
      handle = await open(target, flags);
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size <= 0 ||
        metadata.size > this.#maximumBlobBytes ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      ) {
        throw vaultAccessFailed();
      }
      const value = await handle.readFile();
      if (value.byteLength !== metadata.size) {
        value.fill(0);
        throw vaultAccessFailed();
      }
      return value;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw aliasUnavailable();
      }
      if (error instanceof SecretError) {
        throw error;
      }
      throw vaultAccessFailed();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  public async delete(alias: string): Promise<"deleted" | "absent"> {
    const target = await this.#target(alias);
    try {
      await assertRegularRestrictedFile(target);
      await rm(target);
      return "deleted";
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return "absent";
      }
      if (error instanceof SecretError) {
        throw error;
      }
      throw vaultAccessFailed();
    }
  }

  async #target(alias: string): Promise<string> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.initialize();
    return resolve(
      this.#vaultRoot,
      `${createHash("sha256").update(this.#namespace).update("\0").update(alias).digest("hex")}.secret`,
    );
  }

  async #assertSecureRoot(): Promise<void> {
    const metadata = await lstat(this.#vaultRoot);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw vaultAccessFailed();
    }
    const canonical = await realpath(this.#vaultRoot);
    if (!pathsEqual(canonical, this.#vaultRoot)) {
      throw vaultAccessFailed();
    }
    await assertCanonicalOutsideSource(this.#sourceCheckoutRoot, canonical);
  }

  async #assertClaimedRoot(): Promise<void> {
    const markerPath = resolve(this.#vaultRoot, VAULT_MARKER_NAME);
    try {
      await this.#assertMarker(markerPath);
      return;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }

    const entries = await readdir(this.#vaultRoot);
    if (entries.length !== 0) {
      throw vaultAccessFailed();
    }

    let handle;
    try {
      handle = await open(markerPath, "wx", 0o600);
      await handle.writeFile(this.#markerValue);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (!isNodeError(error, "EEXIST")) {
        await rm(markerPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    await this.#assertMarker(markerPath);
  }

  async #assertMarker(markerPath: string): Promise<void> {
    let handle;
    let value: Buffer | undefined;
    try {
      const pathMetadata = await lstat(markerPath);
      if (
        !pathMetadata.isFile() ||
        pathMetadata.isSymbolicLink() ||
        pathMetadata.nlink !== 1 ||
        pathMetadata.size !== this.#markerValue.byteLength ||
        (process.platform !== "win32" && (pathMetadata.mode & 0o077) !== 0)
      ) {
        throw vaultAccessFailed();
      }
      const flags =
        process.platform === "win32"
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NOFOLLOW;
      handle = await open(markerPath, flags);
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size !== this.#markerValue.byteLength ||
        (process.platform !== "win32" &&
          (metadata.dev !== pathMetadata.dev || metadata.ino !== pathMetadata.ino)) ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      ) {
        throw vaultAccessFailed();
      }
      value = await handle.readFile();
      if (!value.equals(this.#markerValue)) {
        throw vaultAccessFailed();
      }
    } finally {
      value?.fill(0);
      await handle?.close().catch(() => undefined);
    }
  }
}

async function assertNoExistingPathLink(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw vaultAccessFailed();
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function assertRegularRestrictedFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw vaultAccessFailed();
  }
}

async function assertCanonicalOutsideSource(
  sourceCheckoutRoot: string,
  vaultRoot: string,
): Promise<void> {
  let canonicalSource = sourceCheckoutRoot;
  try {
    canonicalSource = await realpath(sourceCheckoutRoot);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
  assertDisjointFromSourceCheckout(canonicalSource, vaultRoot);
}

function assertDisjointFromSourceCheckout(sourceCheckoutRoot: string, vaultRoot: string): void {
  const sourceToVault = relative(resolve(sourceCheckoutRoot), resolve(vaultRoot));
  const vaultToSource = relative(resolve(vaultRoot), resolve(sourceCheckoutRoot));
  const pathsOverlap =
    sourceToVault === "" ||
    (!sourceToVault.startsWith("..") && !isAbsolute(sourceToVault)) ||
    (!vaultToSource.startsWith("..") && !isAbsolute(vaultToSource));
  if (pathsOverlap) {
    throw new SecretError(
      "SECRET_CONFIGURATION_INVALID",
      "The Device-local Secret vault and source checkout must use disjoint paths.",
    );
  }
}

function validateAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new SecretError(
      "SECRET_CONFIGURATION_INVALID",
      `${label} must be an absolute normalized path.`,
    );
  }
  return resolve(value);
}

function validateMaximumBlobBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 128 || value > 16_777_216) {
    throw new SecretError(
      "SECRET_CONFIGURATION_INVALID",
      "The maximum encrypted Secret size is invalid.",
    );
  }
  return value;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function aliasUnavailable(): SecretError {
  return new SecretError(
    "SECRET_ALIAS_UNAVAILABLE",
    "The Secret alias is unavailable on this Device.",
  );
}

function vaultAccessFailed(): SecretError {
  return new SecretError(
    "SECRET_STORE_ACCESS_FAILED",
    "The Device-local Secret vault could not complete the requested operation.",
  );
}
