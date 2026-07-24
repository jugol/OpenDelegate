import type { DeviceIdentitySecretStore, IdentityRandomSource } from "./contracts.ts";
import { DeviceIdentityError } from "./error.ts";

const P256_KEY_ALGORITHM = Object.freeze({
  name: "ECDSA",
  namedCurve: "P-256",
});

export class NodeIdentityRandomSource implements IdentityRandomSource {
  public bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new DeviceIdentityError(
        "IDENTITY_CONFIGURATION_INVALID",
        "Random byte length must be a positive safe integer.",
      );
    }
    return identityWebCrypto.getRandomValues(new Uint8Array(length));
  }
}

export class InMemoryDeviceIdentitySecretStore implements DeviceIdentitySecretStore {
  private readonly keys = new Map<string, CryptoKeyPair>();

  public async createP256KeyPair(keyId: string): Promise<CryptoKeyPair> {
    if (this.keys.has(keyId)) {
      throw new DeviceIdentityError(
        "IDENTITY_KEY_CONFLICT",
        "The identity key identifier already exists.",
      );
    }
    const keys = await identityWebCrypto.subtle.generateKey(P256_KEY_ALGORITHM, false, [
      "sign",
      "verify",
    ]);
    this.keys.set(keyId, keys);
    return keys;
  }

  public async getPrivateKey(keyId: string): Promise<CryptoKey | null> {
    return this.keys.get(keyId)?.privateKey ?? null;
  }

  public async signP256(keyId: string, value: BufferSource): Promise<Uint8Array> {
    const privateKey = this.keys.get(keyId)?.privateKey;
    if (privateKey === undefined) {
      throw new DeviceIdentityError(
        "DEVICE_KEY_UNAVAILABLE",
        "The requested Device identity key is unavailable.",
      );
    }
    const signature = await identityWebCrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      value,
    );
    return new Uint8Array(signature);
  }

  public async has(keyId: string): Promise<boolean> {
    return this.keys.has(keyId);
  }
}

export const identityWebCrypto: Crypto = globalThis.crypto;
