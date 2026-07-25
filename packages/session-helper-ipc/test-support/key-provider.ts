import type { SessionHelperIpcKeyLease, SessionHelperIpcKeyProvider } from "../src/index.ts";

export class StaticKeyProvider implements SessionHelperIpcKeyProvider {
  public readonly acquired: Buffer[] = [];
  public acquireCalls = 0;
  readonly #keyId: string;
  readonly #key: Buffer;

  public constructor(keyId: string, key: Buffer) {
    this.#keyId = keyId;
    this.#key = Buffer.from(key);
  }

  public async acquire(
    _reference: string,
    request: { readonly mode: "initiate" } | { readonly mode: "verify"; readonly keyId: string },
  ): Promise<SessionHelperIpcKeyLease | null> {
    this.acquireCalls += 1;
    if (request.mode === "verify" && request.keyId !== this.#keyId) {
      return null;
    }
    const material = Buffer.from(this.#key);
    this.acquired.push(material);
    return {
      keyId: this.#keyId,
      material,
      usage: "active",
    };
  }
}

export class RotatingKeyProvider implements SessionHelperIpcKeyProvider {
  public readonly acquired: Buffer[] = [];
  public consumeCalls = 0;
  #migrationAvailable = true;
  readonly #activeKeyId: string;
  readonly #activeKey: Buffer;
  readonly #migrationKeyId: string;
  readonly #migrationKey: Buffer;

  public constructor(options: {
    readonly activeKeyId: string;
    readonly activeKey: Buffer;
    readonly migrationKeyId: string;
    readonly migrationKey: Buffer;
  }) {
    this.#activeKeyId = options.activeKeyId;
    this.#activeKey = Buffer.from(options.activeKey);
    this.#migrationKeyId = options.migrationKeyId;
    this.#migrationKey = Buffer.from(options.migrationKey);
  }

  public async acquire(
    _reference: string,
    request: { readonly mode: "initiate" } | { readonly mode: "verify"; readonly keyId: string },
  ): Promise<SessionHelperIpcKeyLease | null> {
    if (request.mode === "initiate") {
      const material = Buffer.from(this.#activeKey);
      this.acquired.push(material);
      return {
        keyId: this.#activeKeyId,
        material,
        usage: "active",
      };
    }
    if (request.keyId === this.#activeKeyId) {
      const material = Buffer.from(this.#activeKey);
      this.acquired.push(material);
      return {
        keyId: this.#activeKeyId,
        material,
        usage: "active",
      };
    }
    if (request.keyId !== this.#migrationKeyId) {
      return null;
    }
    const material = Buffer.from(this.#migrationKey);
    this.acquired.push(material);
    return {
      keyId: this.#migrationKeyId,
      material,
      usage: "migration",
      consumeMigration: async () => {
        this.consumeCalls += 1;
        if (!this.#migrationAvailable) {
          return false;
        }
        this.#migrationAvailable = false;
        return true;
      },
    };
  }
}
