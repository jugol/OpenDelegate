import type {
  ExecuteSecretLease,
  IssueSecretLease,
  SecretAvailability,
  SecretExecutionReceipt,
  SecretLeaseBrokerConfig,
  SecretLeaseReference,
  SecretLeaseRevocation,
  SecretStoreHealth,
} from "./contracts.ts";
import { SecretError } from "./secret-error.ts";
import { assertSecretIdentifier } from "./secret-validation.ts";

interface SecretLeaseRecord {
  readonly leaseId: string;
  readonly deviceId: string;
  readonly consumerId: string;
  readonly runId: string;
  readonly secretAlias: string;
  readonly expiresAt: number;
  consumed: boolean;
  revoked: boolean;
}

export class SecretLeaseBroker {
  readonly #config: SecretLeaseBrokerConfig;
  readonly #leases = new Map<string, SecretLeaseRecord>();

  public constructor(config: SecretLeaseBrokerConfig) {
    assertSecretIdentifier(config.deviceId, "Device ID");
    assertSecretIdentifier(config.store.deviceId, "Secret Store Device ID");

    if (config.store.deviceId !== config.deviceId) {
      throw new SecretError(
        "SECRET_LEASE_DEVICE_MISMATCH",
        "The Secret Store belongs to a different Device.",
      );
    }

    this.#config = Object.freeze({
      deviceId: config.deviceId,
      store: config.store,
      clock: config.clock,
      ids: config.ids,
    });
  }

  public health(): SecretStoreHealth {
    try {
      const health = this.#config.store.health();
      if (
        health.status !== "ready" ||
        health.deviceId !== this.#config.deviceId ||
        !Array.isArray(health.aliases)
      ) {
        throw new Error("Invalid Secret Store health metadata.");
      }

      const aliases = health.aliases.map((availability) =>
        snapshotAvailability(availability, availability.alias),
      );
      if (new Set(aliases.map(({ alias }) => alias)).size !== aliases.length) {
        throw new Error("Duplicate Secret alias metadata.");
      }

      return Object.freeze({
        status: "ready",
        deviceId: this.#config.deviceId,
        aliases: Object.freeze(
          aliases.sort((left, right) => compareAlias(left.alias, right.alias)),
        ),
      });
    } catch {
      throw new SecretError(
        "SECRET_STORE_ACCESS_FAILED",
        "The Device-local Secret Store returned invalid health metadata.",
      );
    }
  }

  public availability(alias: string): SecretAvailability {
    assertSecretIdentifier(alias, "Secret alias");
    try {
      return snapshotAvailability(this.#config.store.availability(alias), alias);
    } catch {
      throw new SecretError(
        "SECRET_STORE_ACCESS_FAILED",
        "The Device-local Secret Store returned invalid availability metadata.",
      );
    }
  }

  public issueLease(input: IssueSecretLease): SecretLeaseReference {
    assertSecretIdentifier(input.deviceId, "Device ID");
    assertSecretIdentifier(input.consumerId, "consumer ID");
    assertSecretIdentifier(input.runId, "Run ID");
    assertSecretIdentifier(input.secretAlias, "Secret alias");

    if (input.deviceId !== this.#config.deviceId) {
      throw new SecretError(
        "SECRET_LEASE_DEVICE_MISMATCH",
        "A Secret lease cannot be issued for another Device.",
      );
    }

    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new SecretError(
        "SECRET_LEASE_TTL_INVALID",
        "A Secret lease requires a positive safe-integer lifetime.",
      );
    }

    const now = readSafeClock(this.#config.clock);

    if (!this.availability(input.secretAlias).ready) {
      throw new SecretError(
        "SECRET_ALIAS_UNAVAILABLE",
        `Secret alias ${input.secretAlias} is unavailable on this Device.`,
      );
    }

    const leaseId = this.#config.ids.nextLeaseId();
    assertSecretIdentifier(leaseId, "Secret lease ID");

    if (this.#leases.has(leaseId)) {
      throw new SecretError(
        "SECRET_LEASE_ID_DUPLICATED",
        "The Secret lease ID source returned a duplicate identifier.",
      );
    }

    const expiresAt = now + input.ttlMs;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      throw new SecretError(
        "SECRET_LEASE_EXPIRY_INVALID",
        "The Secret lease expiration is outside the supported clock range.",
      );
    }

    this.#leases.set(leaseId, {
      leaseId,
      deviceId: input.deviceId,
      consumerId: input.consumerId,
      runId: input.runId,
      secretAlias: input.secretAlias,
      expiresAt,
      consumed: false,
      revoked: false,
    });

    return Object.freeze({
      leaseId,
      expiresAt,
    });
  }

  public revokeLease(leaseId: string): SecretLeaseRevocation {
    assertSecretIdentifier(leaseId, "Secret lease ID");
    const lease = this.#leases.get(leaseId);

    if (lease === undefined) {
      throw new SecretError("SECRET_LEASE_NOT_FOUND", "The Secret lease does not exist.");
    }

    lease.revoked = true;
    return Object.freeze({ status: "revoked" });
  }

  public async executeWithLease(
    input: ExecuteSecretLease,
    executor: (value: string) => unknown | Promise<unknown>,
  ): Promise<SecretExecutionReceipt> {
    assertSecretIdentifier(input.leaseId, "Secret lease ID");
    assertSecretIdentifier(input.deviceId, "Device ID");
    assertSecretIdentifier(input.consumerId, "consumer ID");
    assertSecretIdentifier(input.runId, "Run ID");

    const lease = this.#leases.get(input.leaseId);

    if (lease === undefined) {
      throw new SecretError("SECRET_LEASE_NOT_FOUND", "The Secret lease does not exist.");
    }

    const now = readSafeClock(this.#config.clock);

    if (lease.consumed) {
      throw new SecretError("SECRET_LEASE_REPLAYED", "The Secret lease has already been consumed.");
    }

    if (lease.revoked) {
      throw new SecretError("SECRET_LEASE_REVOKED", "The Secret lease has been revoked.");
    }

    if (now >= lease.expiresAt) {
      throw new SecretError("SECRET_LEASE_EXPIRED", "The Secret lease has expired.");
    }

    if (input.deviceId !== lease.deviceId) {
      throw new SecretError(
        "SECRET_LEASE_DEVICE_MISMATCH",
        "The Secret lease belongs to a different Device.",
      );
    }

    if (input.consumerId !== lease.consumerId) {
      throw new SecretError(
        "SECRET_LEASE_CONSUMER_MISMATCH",
        "The Secret lease belongs to a different consumer.",
      );
    }

    if (input.runId !== lease.runId) {
      throw new SecretError(
        "SECRET_LEASE_RUN_MISMATCH",
        "The Secret lease belongs to a different Run.",
      );
    }

    lease.consumed = true;
    let executorInvoked = false;
    let executorFailed = false;
    let storeContractViolated = false;
    let scopeOpen = true;
    let execution: Promise<void> | undefined;

    try {
      await this.#config.store.executeWithSecret(lease.secretAlias, (value) => {
        if (!scopeOpen || executorInvoked) {
          storeContractViolated = true;
          return Promise.resolve();
        }

        executorInvoked = true;
        execution = (async () => {
          try {
            await executor(value);
          } catch {
            executorFailed = true;
          }
        })();
        return execution;
      });
    } catch {
      scopeOpen = false;
      await execution;
      throw new SecretError(
        "SECRET_STORE_ACCESS_FAILED",
        "The Device-local Secret Store could not complete scoped access.",
      );
    }
    scopeOpen = false;
    await execution;

    if (executorFailed) {
      throw new SecretError("SECRET_EXECUTOR_FAILED", "The scoped Secret executor failed.");
    }

    if (!executorInvoked || storeContractViolated) {
      throw new SecretError(
        "SECRET_STORE_ACCESS_FAILED",
        "The Device-local Secret Store violated the scoped access contract.",
      );
    }

    return Object.freeze({ status: "executed" });
  }
}

function readSafeClock(clock: SecretLeaseBrokerConfig["clock"]): number {
  let now: number;
  try {
    now = clock.now();
  } catch {
    throw new SecretError(
      "SECRET_CLOCK_INVALID",
      "The Secret lease clock failed to return a timestamp.",
    );
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new SecretError(
      "SECRET_CLOCK_INVALID",
      "The Secret lease clock must return a non-negative safe-integer timestamp.",
    );
  }

  return now;
}

function snapshotAvailability(
  availability: SecretAvailability,
  expectedAlias: string,
): SecretAvailability {
  assertSecretIdentifier(availability.alias, "Secret alias");
  if (availability.alias !== expectedAlias || typeof availability.ready !== "boolean") {
    throw new Error("Invalid Secret availability metadata.");
  }

  return Object.freeze({
    alias: availability.alias,
    ready: availability.ready,
  });
}

function compareAlias(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
