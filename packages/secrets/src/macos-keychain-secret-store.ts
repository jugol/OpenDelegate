import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  MacOsKeychainSecretStoreConfig,
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  NativeSecretCommandResult,
  NativeSecretCommandRunner,
  SecretAvailability,
} from "./contracts.ts";
import { NodeNativeSecretCommandRunner } from "./native-secret-command.ts";
import { SecretError } from "./secret-error.ts";
import { assertSecretIdentifier } from "./secret-validation.ts";

const DEFAULT_CODESIGN_PATH = "/usr/bin/codesign";
const DEFAULT_MAXIMUM_SECRET_BYTES = 1_048_576;
const COMMAND_TIMEOUT_MS = 30_000;
const EXIT_ALIAS_CONFLICT = 10;
const EXIT_ALIAS_UNAVAILABLE = 11;
const ALLOWED_MACOS_ENVIRONMENT = new Set(["LANG", "LC_ALL"]);
const MAXIMUM_HELPER_BYTES = 67_108_864;

export class MacOsKeychainSecretStore implements ManagedSecretStore {
  public readonly backend = "macos-keychain" as const;
  readonly #codesignPath: string;
  readonly #deviceId: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #expectedHelperSha256: string;
  readonly #helperPath: string;
  readonly #maximumSecretBytes: number;
  readonly #runner: NativeSecretCommandRunner;
  readonly #service: string;

  public constructor(config: MacOsKeychainSecretStoreConfig) {
    assertSecretIdentifier(config.deviceId, "Device ID");
    if ((config.hostPlatform ?? process.platform) !== "darwin") {
      throw configurationInvalid();
    }
    this.#codesignPath = validateExecutablePath(config.codesignPath ?? DEFAULT_CODESIGN_PATH);
    this.#deviceId = config.deviceId;
    this.#environment = validateMacOsEnvironment(config.environment ?? {});
    if (
      typeof config.expectedHelperSha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(config.expectedHelperSha256)
    ) {
      throw configurationInvalid();
    }
    this.#expectedHelperSha256 = config.expectedHelperSha256;
    this.#helperPath = validateExecutablePath(config.helperPath);
    this.#maximumSecretBytes = validateMaximumSecretBytes(
      config.maximumSecretBytes ?? DEFAULT_MAXIMUM_SECRET_BYTES,
    );
    this.#runner = config.runner ?? new NodeNativeSecretCommandRunner();
    this.#service = `io.opendelegate.secret.${createHash("sha256")
      .update(config.deviceId)
      .digest("hex")
      .slice(0, 32)}`;
  }

  public get deviceId(): string {
    return this.#deviceId;
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    try {
      await this.#verifySignedHelper();
      const result = await this.#runHelper("status", undefined, new Uint8Array(), 16);
      const ready = result.exitCode === 0 && result.stdout.equals(Buffer.from("ready"));
      result.stdout.fill(0);
      if (!ready) {
        throw backendUnavailable();
      }
      return Object.freeze({
        backend: this.backend,
        deviceId: this.#deviceId,
        status: "ready" as const,
      });
    } catch {
      return Object.freeze({
        backend: this.backend,
        deviceId: this.#deviceId,
        reasonCode: "signed-keychain-helper-unavailable",
        status: "unavailable" as const,
      });
    }
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#verifySignedHelper();
    const result = await this.#runHelper("has", alias, new Uint8Array(), 16);
    const ready = result.exitCode === 0 && result.stdout.equals(Buffer.from("ready"));
    const missing = result.exitCode === EXIT_ALIAS_UNAVAILABLE;
    result.stdout.fill(0);
    if (!ready && !missing) {
      throw storeAccessFailed();
    }
    return Object.freeze({ alias, ready });
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#verifySignedHelper();
    const material = copySecretMaterial(value, this.#maximumSecretBytes);
    try {
      const result = await this.#runHelper("create", alias, material, 0);
      result.stdout.fill(0);
      if (result.exitCode === EXIT_ALIAS_CONFLICT) {
        throw new SecretError(
          "SECRET_ALIAS_CONFLICT",
          "The Secret alias already exists on this Device.",
        );
      }
      if (result.exitCode !== 0) {
        throw storeAccessFailed();
      }
      return Object.freeze({ status: "stored" as const });
    } finally {
      material.fill(0);
    }
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#verifySignedHelper();
    const material = copySecretMaterial(value, this.#maximumSecretBytes);
    try {
      const result = await this.#runHelper("rotate", alias, material, 0);
      result.stdout.fill(0);
      if (result.exitCode === EXIT_ALIAS_UNAVAILABLE) {
        throw aliasUnavailable();
      }
      if (result.exitCode !== 0) {
        throw storeAccessFailed();
      }
      return Object.freeze({ status: "rotated" as const });
    } finally {
      material.fill(0);
    }
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#verifySignedHelper();
    const result = await this.#runHelper("delete", alias, new Uint8Array(), 0);
    result.stdout.fill(0);
    if (result.exitCode === EXIT_ALIAS_UNAVAILABLE) {
      return Object.freeze({ status: "absent" as const });
    }
    if (result.exitCode !== 0) {
      throw storeAccessFailed();
    }
    return Object.freeze({ status: "deleted" as const });
  }

  public async executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#verifySignedHelper();
    const result = await this.#runHelper("read", alias, new Uint8Array(), this.#maximumSecretBytes);
    if (result.exitCode === EXIT_ALIAS_UNAVAILABLE) {
      result.stdout.fill(0);
      throw aliasUnavailable();
    }
    if (
      result.exitCode !== 0 ||
      result.stdout.byteLength === 0 ||
      result.stdout.byteLength > this.#maximumSecretBytes
    ) {
      result.stdout.fill(0);
      throw storeAccessFailed();
    }
    try {
      await executor(result.stdout);
    } catch {
      throw new SecretError("SECRET_EXECUTOR_FAILED", "The scoped Secret executor failed.");
    } finally {
      result.stdout.fill(0);
    }
  }

  async #verifySignedHelper(): Promise<void> {
    let handle;
    let helperBytes: Buffer | undefined;
    try {
      const flags =
        process.platform === "win32"
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NOFOLLOW;
      handle = await open(this.#helperPath, flags);
      const metadata = await handle.stat({ bigint: true });
      const pathMetadata = await lstat(this.#helperPath, { bigint: true });
      const canonical = await realpath(this.#helperPath);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        metadata.size <= 0n ||
        metadata.size > BigInt(MAXIMUM_HELPER_BYTES) ||
        !pathMetadata.isFile() ||
        pathMetadata.isSymbolicLink() ||
        canonical !== resolve(this.#helperPath) ||
        (process.platform !== "win32" && (metadata.mode & 0o111n) === 0n) ||
        !sameHelperSnapshot(metadata, pathMetadata)
      ) {
        throw backendUnavailable();
      }
      helperBytes = await handle.readFile();
      const afterRead = await handle.stat({ bigint: true });
      if (
        BigInt(helperBytes.byteLength) !== metadata.size ||
        !sameHelperSnapshot(metadata, afterRead) ||
        `sha256:${createHash("sha256").update(helperBytes).digest("hex")}` !==
          this.#expectedHelperSha256
      ) {
        throw backendUnavailable();
      }
      const result = await this.#runner.run({
        args: ["--verify", "--strict", this.#helperPath],
        environment: this.#environment,
        executable: this.#codesignPath,
        maximumStdoutBytes: 0,
        stdin: new Uint8Array(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      result.stdout.fill(0);
      if (result.exitCode !== 0) {
        throw backendUnavailable();
      }
      const afterVerify = await lstat(this.#helperPath, { bigint: true });
      if (
        !afterVerify.isFile() ||
        afterVerify.isSymbolicLink() ||
        !sameHelperSnapshot(metadata, afterVerify)
      ) {
        throw backendUnavailable();
      }
    } catch (error) {
      if (error instanceof SecretError) {
        throw error;
      }
      throw backendUnavailable();
    } finally {
      helperBytes?.fill(0);
      await handle?.close().catch(() => undefined);
    }
  }

  async #runHelper(
    operation: "create" | "delete" | "has" | "read" | "rotate" | "status",
    alias: string | undefined,
    stdin: Uint8Array,
    maximumStdoutBytes: number,
  ): Promise<NativeSecretCommandResult> {
    const args =
      alias === undefined
        ? [operation]
        : [operation, "--service", this.#service, "--account", alias];
    try {
      return await this.#runner.run({
        args,
        environment: this.#environment,
        executable: this.#helperPath,
        maximumStdoutBytes,
        stdin,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof SecretError) {
        throw error;
      }
      throw storeAccessFailed();
    }
  }
}

function sameHelperSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameHelperFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameHelperFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino === right.ino &&
    (left.dev === right.dev ||
      (process.platform === "win32" &&
        (left.dev === 0n || right.dev === 0n) &&
        left.birthtimeNs === right.birthtimeNs))
  );
}

function validateExecutablePath(value: string): string {
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

function validateMacOsEnvironment(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!ALLOWED_MACOS_ENVIRONMENT.has(name)) {
      throw configurationInvalid();
    }
    environment[name] = entry;
  }
  return Object.freeze(environment);
}

function copySecretMaterial(value: Uint8Array, maximumSecretBytes: number): Buffer {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > maximumSecretBytes
  ) {
    throw new SecretError(
      "SECRET_MATERIAL_INVALID",
      "Secret material must be non-empty and within the configured size limit.",
    );
  }
  return Buffer.from(value);
}

function validateMaximumSecretBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAXIMUM_SECRET_BYTES) {
    throw configurationInvalid();
  }
  return value;
}

function configurationInvalid(): SecretError {
  return new SecretError(
    "SECRET_CONFIGURATION_INVALID",
    "The macOS Keychain Secret Store configuration is invalid.",
  );
}

function backendUnavailable(): SecretError {
  return new SecretError(
    "SECRET_BACKEND_UNAVAILABLE",
    "The signed macOS Keychain helper is unavailable.",
  );
}

function storeAccessFailed(): SecretError {
  return new SecretError(
    "SECRET_STORE_ACCESS_FAILED",
    "The macOS Keychain could not complete the Device-local Secret operation.",
  );
}

function aliasUnavailable(): SecretError {
  return new SecretError(
    "SECRET_ALIAS_UNAVAILABLE",
    "The Secret alias is unavailable on this Device.",
  );
}
