import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  SecretAvailability,
  SecretKeyProvider,
  SystemdCredentialVaultSecretStoreConfig,
} from "./contracts.ts";
import { SecureFileVault } from "./secure-file-vault.ts";
import { SecretError } from "./secret-error.ts";
import { assertSecretIdentifier } from "./secret-validation.ts";

const FORMAT_MAGIC = Buffer.from("ODSV\x01\0\0\0", "binary");
const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const DEFAULT_MAXIMUM_SECRET_BYTES = 1_048_576;
const KEY_BYTES = 32;

export class SystemdCredentialVaultSecretStore implements ManagedSecretStore {
  public readonly backend = "linux-systemd-credential-vault" as const;
  readonly #deviceId: string;
  readonly #keyProvider: SecretKeyProvider;
  readonly #maximumSecretBytes: number;
  readonly #vault: SecureFileVault;

  public constructor(config: SystemdCredentialVaultSecretStoreConfig) {
    assertSecretIdentifier(config.deviceId, "Device ID");
    if ((config.hostPlatform ?? process.platform) !== "linux") {
      throw new SecretError(
        "SECRET_CONFIGURATION_INVALID",
        "The systemd credential-backed vault is available only on Linux.",
      );
    }
    this.#deviceId = config.deviceId;
    this.#keyProvider = config.keyProvider;
    this.#maximumSecretBytes = validateMaximumSecretBytes(
      config.maximumSecretBytes ?? DEFAULT_MAXIMUM_SECRET_BYTES,
    );
    this.#vault = new SecureFileVault({
      maximumBlobBytes:
        this.#maximumSecretBytes + FORMAT_MAGIC.byteLength + NONCE_BYTES + AUTHENTICATION_TAG_BYTES,
      namespace: config.deviceId,
      sourceCheckoutRoot: config.sourceCheckoutRoot,
      vaultRoot: config.vaultRoot,
    });
  }

  public get deviceId(): string {
    return this.#deviceId;
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    try {
      await this.#vault.initialize();
      await this.#withKey(async () => undefined);
      return Object.freeze({
        backend: this.backend,
        deviceId: this.#deviceId,
        status: "ready" as const,
      });
    } catch {
      return Object.freeze({
        backend: this.backend,
        deviceId: this.#deviceId,
        reasonCode: "credential-or-vault-unavailable",
        status: "unavailable" as const,
      });
    }
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    assertSecretIdentifier(alias, "Secret alias");
    const health = await this.health();
    return Object.freeze({
      alias,
      ready: health.status === "ready" && (await this.#vault.has(alias)),
    });
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    assertSecretIdentifier(alias, "Secret alias");
    const material = copySecretMaterial(value, this.#maximumSecretBytes);
    try {
      const sealed = await this.#seal(alias, material);
      try {
        await this.#vault.create(alias, sealed);
      } finally {
        sealed.fill(0);
      }
      return Object.freeze({ status: "stored" as const });
    } finally {
      material.fill(0);
    }
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    assertSecretIdentifier(alias, "Secret alias");
    const material = copySecretMaterial(value, this.#maximumSecretBytes);
    try {
      const sealed = await this.#seal(alias, material);
      try {
        await this.#vault.replace(alias, sealed);
      } finally {
        sealed.fill(0);
      }
      return Object.freeze({ status: "rotated" as const });
    } finally {
      material.fill(0);
    }
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    assertSecretIdentifier(alias, "Secret alias");
    const status = await this.#vault.delete(alias);
    return Object.freeze({ status });
  }

  public async executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    assertSecretIdentifier(alias, "Secret alias");
    const sealed = await this.#vault.read(alias);
    let material: Uint8Array | undefined;
    try {
      material = await this.#open(alias, sealed);
      try {
        await executor(material);
      } catch {
        throw new SecretError("SECRET_EXECUTOR_FAILED", "The scoped Secret executor failed.");
      }
    } finally {
      sealed.fill(0);
      material?.fill(0);
    }
  }

  async #seal(alias: string, material: Uint8Array): Promise<Uint8Array> {
    let result: Uint8Array | undefined;
    await this.#withKey(async (key) => {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: AUTHENTICATION_TAG_BYTES,
      });
      cipher.setAAD(this.#additionalAuthenticatedData(alias), {
        plaintextLength: material.byteLength,
      });
      const ciphertext = Buffer.concat([cipher.update(material), cipher.final()]);
      const authenticationTag = cipher.getAuthTag();
      result = Buffer.concat([FORMAT_MAGIC, nonce, authenticationTag, ciphertext]);
      ciphertext.fill(0);
      authenticationTag.fill(0);
      nonce.fill(0);
    });
    if (result === undefined) {
      throw keyProviderFailed();
    }
    return result;
  }

  async #open(alias: string, sealed: Uint8Array): Promise<Uint8Array> {
    if (
      sealed.byteLength <= FORMAT_MAGIC.byteLength + NONCE_BYTES + AUTHENTICATION_TAG_BYTES ||
      sealed.byteLength >
        this.#maximumSecretBytes + FORMAT_MAGIC.byteLength + NONCE_BYTES + AUTHENTICATION_TAG_BYTES
    ) {
      throw corruptedSecret();
    }
    const bytes = Buffer.from(sealed);
    if (!bytes.subarray(0, FORMAT_MAGIC.byteLength).equals(FORMAT_MAGIC)) {
      bytes.fill(0);
      throw corruptedSecret();
    }
    const nonceStart = FORMAT_MAGIC.byteLength;
    const tagStart = nonceStart + NONCE_BYTES;
    const ciphertextStart = tagStart + AUTHENTICATION_TAG_BYTES;
    const nonce = Buffer.from(bytes.subarray(nonceStart, tagStart));
    const authenticationTag = Buffer.from(bytes.subarray(tagStart, ciphertextStart));
    const ciphertext = Buffer.from(bytes.subarray(ciphertextStart));
    bytes.fill(0);

    let result: Uint8Array | undefined;
    try {
      await this.#withKey(async (key) => {
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
            authTagLength: AUTHENTICATION_TAG_BYTES,
          });
          decipher.setAAD(this.#additionalAuthenticatedData(alias), {
            plaintextLength: ciphertext.byteLength,
          });
          decipher.setAuthTag(authenticationTag);
          const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          if (plaintext.byteLength === 0 || plaintext.byteLength > this.#maximumSecretBytes) {
            plaintext.fill(0);
            throw corruptedSecret();
          }
          result = plaintext;
        } catch (error) {
          if (error instanceof SecretError) {
            throw error;
          }
          throw corruptedSecret();
        }
      });
    } catch (error) {
      result?.fill(0);
      throw error;
    } finally {
      nonce.fill(0);
      authenticationTag.fill(0);
      ciphertext.fill(0);
    }
    if (result === undefined) {
      throw keyProviderFailed();
    }
    return result;
  }

  async #withKey(executor: (key: Uint8Array) => unknown | Promise<unknown>): Promise<void> {
    let callbackCount = 0;
    try {
      await this.#keyProvider.executeWithKey(async (key) => {
        callbackCount += 1;
        if (callbackCount !== 1 || !(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
          throw keyProviderFailed();
        }
        await executor(key);
      });
    } catch (error) {
      if (error instanceof SecretError) {
        throw error;
      }
      throw keyProviderFailed();
    }
    if (callbackCount !== 1) {
      throw keyProviderFailed();
    }
  }

  #additionalAuthenticatedData(alias: string): Buffer {
    return Buffer.from(["OpenDelegate Secret vault v1", this.#deviceId, alias].join("\n"), "utf8");
  }
}

function copySecretMaterial(value: Uint8Array, maximumSecretBytes: number): Uint8Array {
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
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_048_576) {
    throw new SecretError(
      "SECRET_CONFIGURATION_INVALID",
      "The maximum Secret size must be a positive safe integer of at most one MiB.",
    );
  }
  return value;
}

function keyProviderFailed(): SecretError {
  return new SecretError(
    "SECRET_BACKEND_UNAVAILABLE",
    "The systemd credential-backed vault key is unavailable.",
  );
}

function corruptedSecret(): SecretError {
  return new SecretError(
    "SECRET_CORRUPTED",
    "The Device-local Secret record failed authenticated decryption.",
  );
}
