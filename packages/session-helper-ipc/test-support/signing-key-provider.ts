import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import type { SessionHelperPeerPublicKey, SessionHelperSigningKeyProvider } from "../src/index.ts";

export class StaticEd25519SigningKeyProvider implements SessionHelperSigningKeyProvider {
  public readonly signedMessages: Buffer[] = [];
  readonly #privateKey: KeyObject;
  readonly #keyId: `sha256:${string}`;

  public constructor(privateKey: KeyObject, keyId: `sha256:${string}`) {
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    this.#privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    pkcs8.fill(0);
    this.#keyId = keyId;
  }

  public async sign(_privateKeyReference: string, keyId: string, message: Buffer): Promise<Buffer> {
    if (keyId !== this.#keyId) {
      throw new Error("wrong key");
    }
    this.signedMessages.push(Buffer.from(message));
    return sign(null, message, this.#privateKey);
  }
}

export function createEd25519SigningFixture(): {
  readonly provider: StaticEd25519SigningKeyProvider;
  readonly pin: SessionHelperPeerPublicKey;
  readonly privateKey: KeyObject;
  readonly keyId: `sha256:${string}`;
} {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = `sha256:${createHash("sha256").update(spki).digest("hex")}` as const;
  const pin: SessionHelperPeerPublicKey = Object.freeze({
    keyId,
    publicKeySpkiBase64Url: spki.toString("base64url"),
    usage: "active",
  });
  spki.fill(0);
  return {
    provider: new StaticEd25519SigningKeyProvider(pair.privateKey, keyId),
    pin,
    privateKey: pair.privateKey,
    keyId,
  };
}
