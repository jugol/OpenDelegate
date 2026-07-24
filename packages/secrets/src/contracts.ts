export interface Clock {
  now(): number;
}

export interface SecretLeaseIdSource {
  nextLeaseId(): string;
}

export interface SecretAvailability {
  readonly alias: string;
  readonly ready: boolean;
}

export interface SecretStoreHealth {
  readonly status: "ready";
  readonly deviceId: string;
  readonly aliases: readonly SecretAvailability[];
}

export interface SecretStore {
  readonly deviceId: string;
  health(): SecretStoreHealth;
  availability(alias: string): SecretAvailability;
  executeWithSecret(
    alias: string,
    executor: (value: string) => unknown | Promise<unknown>,
  ): Promise<void>;
}

export interface InMemorySecretStoreConfig {
  readonly deviceId: string;
  readonly secrets: Readonly<Record<string, string>>;
}

export interface SecretLeaseBrokerConfig {
  readonly deviceId: string;
  readonly store: SecretStore;
  readonly clock: Clock;
  readonly ids: SecretLeaseIdSource;
}

export interface IssueSecretLease {
  readonly deviceId: string;
  readonly consumerId: string;
  readonly runId: string;
  readonly secretAlias: string;
  readonly ttlMs: number;
}

export interface SecretLeaseReference {
  readonly leaseId: string;
  readonly expiresAt: number;
}

export interface ExecuteSecretLease {
  readonly leaseId: string;
  readonly deviceId: string;
  readonly consumerId: string;
  readonly runId: string;
}

export interface SecretExecutionReceipt {
  readonly status: "executed";
}

export interface SecretLeaseRevocation {
  readonly status: "revoked";
}
