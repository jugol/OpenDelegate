import type {
  InMemorySecretStoreConfig,
  SecretAvailability,
  SecretStore,
  SecretStoreHealth,
} from "./contracts.ts";
import { SecretError } from "./secret-error.ts";
import { assertSecretIdentifier } from "./secret-validation.ts";

export class InMemorySecretStore implements SecretStore {
  readonly #deviceId: string;
  readonly #secrets: ReadonlyMap<string, string>;

  public constructor(config: InMemorySecretStoreConfig) {
    assertSecretIdentifier(config.deviceId, "Device ID");
    for (const alias of Object.keys(config.secrets)) {
      assertSecretIdentifier(alias, "Secret alias");
    }

    this.#deviceId = config.deviceId;
    this.#secrets = new Map(Object.entries(config.secrets));
  }

  public get deviceId(): string {
    return this.#deviceId;
  }

  public health(): SecretStoreHealth {
    return Object.freeze({
      status: "ready",
      deviceId: this.#deviceId,
      aliases: Object.freeze(
        [...this.#secrets.keys()].sort(compareStableString).map((alias) =>
          Object.freeze({
            alias,
            ready: true,
          }),
        ),
      ),
    });
  }

  public availability(alias: string): SecretAvailability {
    assertSecretIdentifier(alias, "Secret alias");
    return Object.freeze({
      alias,
      ready: this.#secrets.has(alias),
    });
  }

  public async executeWithSecret(
    alias: string,
    executor: (value: string) => unknown | Promise<unknown>,
  ): Promise<void> {
    assertSecretIdentifier(alias, "Secret alias");
    const value = this.#secrets.get(alias);

    if (value === undefined) {
      throw new SecretError(
        "SECRET_ALIAS_UNAVAILABLE",
        `Secret alias ${alias} is unavailable on this Device.`,
      );
    }

    await executor(value);
  }
}

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
