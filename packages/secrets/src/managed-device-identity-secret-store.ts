import type { webcrypto } from "node:crypto";

import type { ManagedSecretStore } from "./contracts.ts";
import { SecretError } from "./secret-error.ts";
import { assertSecretIdentifier } from "./secret-validation.ts";

const P256_KEY_ALGORITHM = Object.freeze({
  name: "ECDSA",
  namedCurve: "P-256",
});
const ECDSA_SHA256 = Object.freeze({
  hash: "SHA-256",
  name: "ECDSA",
});
const ALIAS_PREFIX = "identity-p256.";
const MAXIMUM_KEY_ID_LENGTH = 192;

/**
 * Structurally implements DeviceIdentitySecretStore without making the Worker-local
 * Secret package depend on the enrollment package. Raw PKCS#8 exists only while it
 * crosses the ManagedSecretStore callback boundary; callers receive only
 * non-extractable CryptoKey instances.
 */
export class ManagedDeviceIdentitySecretStore {
  readonly #store: ManagedSecretStore;

  public constructor(store: ManagedSecretStore) {
    this.#store = store;
  }

  public async createP256KeyPair(keyId: string): Promise<webcrypto.CryptoKeyPair> {
    const alias = identityAlias(keyId);
    const generated = await globalThis.crypto.subtle.generateKey(P256_KEY_ALGORITHM, true, [
      "sign",
      "verify",
    ]);
    const exported = Buffer.from(
      await globalThis.crypto.subtle.exportKey("pkcs8", generated.privateKey),
    );
    try {
      await this.#store.store(alias, exported);
      const privateKey = await importPrivateKey(exported);
      return Object.freeze({
        privateKey,
        publicKey: generated.publicKey,
      });
    } finally {
      exported.fill(0);
    }
  }

  public async getPrivateKey(keyId: string): Promise<webcrypto.CryptoKey | null> {
    const alias = identityAlias(keyId);
    if (!(await this.#store.availability(alias)).ready) {
      return null;
    }
    let privateKey: webcrypto.CryptoKey | undefined;
    try {
      await this.#store.executeWithSecretBytes(alias, async (value) => {
        privateKey = await importPrivateKey(value);
      });
    } catch (error) {
      if (error instanceof SecretError && error.code === "SECRET_ALIAS_UNAVAILABLE") {
        return null;
      }
      throw error;
    }
    if (privateKey === undefined) {
      throw storeContractFailed();
    }
    return privateKey;
  }

  public async signP256(
    keyId: string,
    value: webcrypto.BufferSource,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const alias = identityAlias(keyId);
    const payload = copyBufferSource(value);
    let signature: Uint8Array<ArrayBuffer> | undefined;
    try {
      await this.#store.executeWithSecretBytes(alias, async (storedKey) => {
        const privateKey = await importPrivateKey(storedKey);
        signature = new Uint8Array(
          await globalThis.crypto.subtle.sign(ECDSA_SHA256, privateKey, payload),
        );
      });
    } finally {
      payload.fill(0);
    }
    if (signature === undefined) {
      throw storeContractFailed();
    }
    return signature;
  }

  public async has(keyId: string): Promise<boolean> {
    return (await this.#store.availability(identityAlias(keyId))).ready;
  }
}

async function importPrivateKey(value: Uint8Array): Promise<webcrypto.CryptoKey> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  try {
    return await globalThis.crypto.subtle.importKey("pkcs8", copy, P256_KEY_ALGORITHM, false, [
      "sign",
    ]);
  } catch {
    throw new SecretError(
      "SECRET_CORRUPTED",
      "The Device identity Secret is not a valid P-256 private key.",
    );
  } finally {
    copy.fill(0);
  }
}

function identityAlias(keyId: string): string {
  assertSecretIdentifier(keyId, "Device identity key ID");
  if (keyId.length > MAXIMUM_KEY_ID_LENGTH) {
    throw new SecretError(
      "SECRET_IDENTIFIER_INVALID",
      "The Device identity key ID is too long for the local Secret Store.",
    );
  }
  const alias = `${ALIAS_PREFIX}${keyId}`;
  assertSecretIdentifier(alias, "Device identity Secret alias");
  return alias;
}

function copyBufferSource(value: webcrypto.BufferSource): Uint8Array<ArrayBuffer> {
  const source =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function storeContractFailed(): SecretError {
  return new SecretError(
    "SECRET_STORE_ACCESS_FAILED",
    "The Device-local Secret Store violated the identity-key access contract.",
  );
}
