import { createHash, createPrivateKey, createPublicKey, sign as signEd25519 } from "node:crypto";

import type { ManagedSecretStore } from "@opendelegate/secrets";
import type {
  SessionHelperIpcKeyLease,
  SessionHelperIpcKeyProvider,
  SessionHelperSigningKeyProvider,
} from "@opendelegate/session-helper-ipc";

import type { AuthoritySigningKeyProvider } from "./authority-store.ts";

const KEY_BYTES = 32;
const MAX_ED25519_PKCS8_BYTES = 256;

export const CORE_SESSION_HELPER_SIGNING_ALIAS = "opendelegate/session-helper-core-signing/v2";
export const OWNER_SESSION_HELPER_SIGNING_ALIAS = "opendelegate/session-helper-owner-signing/v2";

export interface ManagedSecretSessionHelperKeyProviderOptions {
  readonly store: ManagedSecretStore;
  readonly activeKeyId: string;
  readonly references: Readonly<Record<string, string>>;
}

export class ManagedSecretSessionHelperKeyProvider implements SessionHelperIpcKeyProvider {
  readonly #store: ManagedSecretStore;
  readonly #activeKeyId: string;
  readonly #references: Readonly<Record<string, string>>;

  public constructor(options: ManagedSecretSessionHelperKeyProviderOptions) {
    this.#store = options.store;
    this.#activeKeyId = requireIdentifier(options.activeKeyId, "active key ID");
    this.#references = Object.freeze({ ...options.references });
    for (const [reference, alias] of Object.entries(this.#references)) {
      if (!/^secret:\/\/[A-Za-z0-9._~/-]+$/u.test(reference)) {
        throw new TypeError("The session-helper Secret reference is invalid.");
      }
      requireIdentifier(alias, "managed Secret alias");
    }
  }

  public async acquire(
    reference: string,
    request: { readonly mode: "initiate" } | { readonly mode: "verify"; readonly keyId: string },
  ): Promise<SessionHelperIpcKeyLease | null> {
    if (request.mode === "verify" && request.keyId !== this.#activeKeyId) {
      return null;
    }
    const alias = this.#references[reference];
    if (alias === undefined || !(await this.#store.availability(alias)).ready) {
      return null;
    }
    let material: Buffer | undefined;
    await this.#store.executeWithSecretBytes(alias, (value) => {
      if (value.byteLength !== KEY_BYTES) {
        return;
      }
      material = Buffer.from(value);
    });
    if (material === undefined) {
      return null;
    }
    return Object.freeze({
      keyId: this.#activeKeyId,
      material,
      usage: "active" as const,
    });
  }
}

export interface ManagedSecretAuthoritySigningKeyProviderOptions {
  readonly store: ManagedSecretStore;
  readonly alias: string;
}

export class ManagedSecretAuthoritySigningKeyProvider implements AuthoritySigningKeyProvider {
  readonly #store: ManagedSecretStore;
  readonly #alias: string;

  public constructor(options: ManagedSecretAuthoritySigningKeyProviderOptions) {
    this.#store = options.store;
    this.#alias = requireIdentifier(options.alias, "authority Secret alias");
  }

  public async executeWithKey<T>(operation: (key: Buffer) => Promise<T> | T): Promise<T> {
    let result: T | undefined;
    let executed = false;
    await this.#store.executeWithSecretBytes(this.#alias, async (value) => {
      if (value.byteLength !== KEY_BYTES) {
        throw new Error("The desktop authority signing Secret is unavailable.");
      }
      const key = Buffer.from(value);
      try {
        result = await operation(key);
        executed = true;
      } finally {
        key.fill(0);
      }
    });
    if (!executed) {
      throw new Error("The desktop authority signing Secret is unavailable.");
    }
    return result as T;
  }
}

export interface ManagedSecretEd25519SigningKeyProviderOptions {
  readonly store: ManagedSecretStore;
  readonly references: Readonly<Record<string, string>>;
}

/**
 * Plane-local Ed25519 signing. The PKCS#8 value never leaves the ManagedSecretStore
 * callback and the callback result contains only the disposable signature.
 */
export class ManagedSecretEd25519SigningKeyProvider implements SessionHelperSigningKeyProvider {
  readonly #store: ManagedSecretStore;
  readonly #references: Readonly<Record<string, string>>;

  public constructor(options: ManagedSecretEd25519SigningKeyProviderOptions) {
    this.#store = options.store;
    this.#references = Object.freeze({ ...options.references });
    for (const [reference, alias] of Object.entries(this.#references)) {
      if (!/^secret:\/\/[A-Za-z0-9._~/-]+$/u.test(reference)) {
        throw new TypeError("The signed session-helper Secret reference is invalid.");
      }
      requireIdentifier(alias, "managed Secret alias");
    }
  }

  public async sign(privateKeyReference: string, keyId: string, message: Buffer): Promise<Buffer> {
    const alias = this.#references[privateKeyReference];
    if (
      alias === undefined ||
      !/^sha256:[a-f0-9]{64}$/u.test(keyId) ||
      !Buffer.isBuffer(message) ||
      message.length === 0 ||
      message.length > 64 * 1024 * 1024
    ) {
      throw new Error("The plane-local signing key is unavailable.");
    }
    let signature: Buffer | undefined;
    await this.#store.executeWithSecretBytes(alias, (value) => {
      if (value.byteLength === 0 || value.byteLength > MAX_ED25519_PKCS8_BYTES) {
        throw new Error("The plane-local signing key is unavailable.");
      }
      const pkcs8 = Buffer.from(value);
      try {
        const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
        if (privateKey.asymmetricKeyType !== "ed25519") {
          throw new Error("The plane-local signing key is unavailable.");
        }
        const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
        const actualKeyId = `sha256:${createHash("sha256").update(spki).digest("hex")}`;
        spki.fill(0);
        if (actualKeyId !== keyId) {
          throw new Error("The plane-local signing key is unavailable.");
        }
        signature = signEd25519(null, message, privateKey);
      } finally {
        pkcs8.fill(0);
      }
    });
    if (signature === undefined || signature.length !== 64) {
      signature?.fill(0);
      throw new Error("The plane-local signing key is unavailable.");
    }
    return signature;
  }
}

function requireIdentifier(value: string, label: string): string {
  if (value.length === 0 || value.length > 256 || value !== value.trim() || /\p{Cc}/u.test(value)) {
    throw new TypeError(`The ${label} is invalid.`);
  }
  return value;
}
