import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  LinuxSecretServiceSecretStoreConfig,
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

const DEFAULT_SECRET_TOOL_PATH = "/usr/bin/secret-tool";
const DEFAULT_MAXIMUM_SECRET_BYTES = 786_432;
const COMMAND_TIMEOUT_MS = 30_000;
const FORMAT_PREFIX = "ODSS1:";
const ALLOWED_ENVIRONMENT_NAMES = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "LANG",
  "LC_ALL",
  "XDG_RUNTIME_DIR",
]);

export class LinuxSecretServiceSecretStore implements ManagedSecretStore {
  public readonly backend = "linux-secret-service" as const;
  readonly #attributes: readonly string[];
  readonly #deviceId: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #maximumSecretBytes: number;
  readonly #runner: NativeSecretCommandRunner;
  readonly #secretToolPath: string;

  public constructor(config: LinuxSecretServiceSecretStoreConfig) {
    assertSecretIdentifier(config.deviceId, "Device ID");
    if ((config.hostPlatform ?? process.platform) !== "linux") {
      throw configurationInvalid();
    }
    this.#deviceId = config.deviceId;
    this.#environment = validateEnvironment(
      config.environment ?? defaultSecretServiceEnvironment(),
    );
    this.#maximumSecretBytes = validateMaximumSecretBytes(
      config.maximumSecretBytes ?? DEFAULT_MAXIMUM_SECRET_BYTES,
    );
    this.#runner = config.runner ?? new NodeNativeSecretCommandRunner();
    this.#secretToolPath = validateExecutablePath(
      config.secretToolPath ?? DEFAULT_SECRET_TOOL_PATH,
    );
    this.#attributes = Object.freeze(["opendelegate-device", stableIdentifier(config.deviceId)]);
  }

  public get deviceId(): string {
    return this.#deviceId;
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    try {
      await this.#verifyExecutable();
      const result = await this.#run(
        ["search", "--all", "opendelegate-health-probe", stableIdentifier(this.#deviceId)],
        new Uint8Array(),
        4_096,
      );
      result.stdout.fill(0);
      if (result.exitCode !== 0) {
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
        reasonCode: "secret-service-session-unavailable",
        status: "unavailable" as const,
      });
    }
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#verifyExecutable();
    const result = await this.#lookup(alias);
    if (result.exitCode === 1) {
      result.stdout.fill(0);
      return Object.freeze({ alias, ready: false });
    }
    if (result.exitCode !== 0) {
      result.stdout.fill(0);
      throw storeAccessFailed();
    }
    try {
      const material = decodeSecretToolValue(result.stdout, this.#maximumSecretBytes);
      material.fill(0);
      return Object.freeze({ alias, ready: true });
    } finally {
      result.stdout.fill(0);
    }
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    assertSecretIdentifier(alias, "Secret alias");
    if ((await this.availability(alias)).ready) {
      throw new SecretError(
        "SECRET_ALIAS_CONFLICT",
        "The Secret alias already exists on this Device.",
      );
    }
    await this.#write(alias, value);
    return Object.freeze({ status: "stored" as const });
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    assertSecretIdentifier(alias, "Secret alias");
    if (!(await this.availability(alias)).ready) {
      throw aliasUnavailable();
    }
    await this.#write(alias, value);
    return Object.freeze({ status: "rotated" as const });
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    assertSecretIdentifier(alias, "Secret alias");
    if (!(await this.availability(alias)).ready) {
      return Object.freeze({ status: "absent" as const });
    }
    const result = await this.#run(["clear", ...this.#aliasAttributes(alias)], new Uint8Array(), 0);
    result.stdout.fill(0);
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
    await this.#verifyExecutable();
    const result = await this.#lookup(alias);
    if (result.exitCode === 1) {
      result.stdout.fill(0);
      throw aliasUnavailable();
    }
    if (result.exitCode !== 0) {
      result.stdout.fill(0);
      throw storeAccessFailed();
    }
    let material: Buffer | undefined;
    try {
      material = decodeSecretToolValue(result.stdout, this.#maximumSecretBytes);
      try {
        await executor(material);
      } catch {
        throw new SecretError("SECRET_EXECUTOR_FAILED", "The scoped Secret executor failed.");
      }
    } finally {
      result.stdout.fill(0);
      material?.fill(0);
    }
  }

  async #write(alias: string, value: Uint8Array): Promise<void> {
    const material = copySecretMaterial(value, this.#maximumSecretBytes);
    const encoded = Buffer.from(`${FORMAT_PREFIX}${material.toString("base64")}`, "utf8");
    try {
      const result = await this.#run(
        ["store", "--label=OpenDelegate Device Secret", ...this.#aliasAttributes(alias)],
        encoded,
        0,
      );
      result.stdout.fill(0);
      if (result.exitCode !== 0) {
        throw storeAccessFailed();
      }
    } finally {
      material.fill(0);
      encoded.fill(0);
    }
  }

  async #lookup(alias: string): Promise<NativeSecretCommandResult> {
    return this.#run(
      ["lookup", ...this.#aliasAttributes(alias)],
      new Uint8Array(),
      encodedMaximum(this.#maximumSecretBytes),
    );
  }

  #aliasAttributes(alias: string): readonly string[] {
    return [...this.#attributes, "opendelegate-alias", stableIdentifier(alias)];
  }

  async #verifyExecutable(): Promise<void> {
    try {
      const metadata = await lstat(this.#secretToolPath);
      const canonical = await realpath(this.#secretToolPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        canonical !== resolve(this.#secretToolPath) ||
        (process.platform !== "win32" && (metadata.mode & 0o111) === 0)
      ) {
        throw backendUnavailable();
      }
    } catch (error) {
      if (error instanceof SecretError) {
        throw error;
      }
      throw backendUnavailable();
    }
  }

  async #run(
    args: readonly string[],
    stdin: Uint8Array,
    maximumStdoutBytes: number,
  ): Promise<NativeSecretCommandResult> {
    try {
      return await this.#runner.run({
        args,
        environment: this.#environment,
        executable: this.#secretToolPath,
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

function decodeSecretToolValue(value: Buffer, maximumSecretBytes: number): Buffer {
  const copy = Buffer.from(value);
  try {
    const encodedValue = copy.at(-1) === 0x0a ? copy.subarray(0, copy.byteLength - 1) : copy;
    const text = encodedValue.toString("utf8");
    if (!text.startsWith(FORMAT_PREFIX)) {
      throw corruptedSecret();
    }
    const encoded = text.slice(FORMAT_PREFIX.length);
    if (
      encoded.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
    ) {
      throw corruptedSecret();
    }
    const decoded = Buffer.from(encoded, "base64");
    if (
      decoded.byteLength === 0 ||
      decoded.byteLength > maximumSecretBytes ||
      decoded.toString("base64") !== encoded
    ) {
      decoded.fill(0);
      throw corruptedSecret();
    }
    return decoded;
  } finally {
    copy.fill(0);
  }
}

function validateEnvironment(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!ALLOWED_ENVIRONMENT_NAMES.has(name)) {
      throw configurationInvalid();
    }
    result[name] = entry;
  }
  return Object.freeze(result);
}

function defaultSecretServiceEnvironment(): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of ALLOWED_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
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

function stableIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodedMaximum(maximumSecretBytes: number): number {
  return FORMAT_PREFIX.length + Math.ceil(maximumSecretBytes / 3) * 4 + 1;
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
    "The Linux Secret Service configuration is invalid.",
  );
}

function backendUnavailable(): SecretError {
  return new SecretError(
    "SECRET_BACKEND_UNAVAILABLE",
    "The graphical Linux Secret Service session is unavailable.",
  );
}

function storeAccessFailed(): SecretError {
  return new SecretError(
    "SECRET_STORE_ACCESS_FAILED",
    "Linux Secret Service could not complete the Device-local Secret operation.",
  );
}

function aliasUnavailable(): SecretError {
  return new SecretError(
    "SECRET_ALIAS_UNAVAILABLE",
    "The Secret alias is unavailable on this Device.",
  );
}

function corruptedSecret(): SecretError {
  return new SecretError(
    "SECRET_CORRUPTED",
    "The Device-local Secret record has an invalid authenticated format.",
  );
}
