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

export type ManagedSecretBackend =
  | "linux-secret-service"
  | "linux-systemd-credential-vault"
  | "macos-keychain"
  | "windows-dpapi"
  | "windows-service-dpapi";

export interface ManagedSecretStoreHealth {
  readonly backend: ManagedSecretBackend;
  readonly deviceId: string;
  readonly status: "ready" | "unavailable";
  readonly reasonCode?: string;
}

export interface ManagedSecretMutation {
  readonly status: "stored" | "rotated";
}

export interface ManagedSecretDeletion {
  readonly status: "deleted" | "absent";
}

export interface ManagedSecretStore {
  readonly backend: ManagedSecretBackend;
  readonly deviceId: string;
  health(): Promise<ManagedSecretStoreHealth>;
  availability(alias: string): Promise<SecretAvailability>;
  store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation>;
  rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation>;
  delete(alias: string): Promise<ManagedSecretDeletion>;
  executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void>;
}

export interface SecretKeyProvider {
  executeWithKey(executor: (key: Uint8Array) => unknown | Promise<unknown>): Promise<void>;
}

export interface NativeSecretCommandRequest {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly maximumStdoutBytes: number;
  readonly stdin: Uint8Array;
  readonly timeoutMs: number;
}

export interface NativeSecretCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
}

export interface NativeSecretCommandRunner {
  run(request: NativeSecretCommandRequest): Promise<NativeSecretCommandResult>;
}

export interface SystemdCredentialVaultSecretStoreConfig {
  readonly deviceId: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly keyProvider: SecretKeyProvider;
  readonly maximumSecretBytes?: number;
  readonly sourceCheckoutRoot: string;
  readonly vaultRoot: string;
}

export interface SystemdCredentialKeyProviderConfig {
  readonly allowedCredentialRoot?: string;
  readonly credentialDirectory: string;
  readonly credentialName: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly sourceCheckoutRoot: string;
}

export interface WindowsDpapiSecretStoreConfig {
  readonly deviceId: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly hostPlatform?: NodeJS.Platform;
  readonly maximumSecretBytes?: number;
  readonly expectedIdentitySid?: string;
  readonly powershellPath?: string;
  readonly runner?: NativeSecretCommandRunner;
  readonly sourceCheckoutRoot: string;
  readonly vaultRoot: string;
}

export interface WindowsServiceDpapiSecretStoreConfig {
  readonly deviceId: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly handoffRoot: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly maximumSecretBytes?: number;
  readonly powershellPath?: string;
  readonly runner?: NativeSecretCommandRunner;
  readonly serviceSid: string;
  readonly sourceCheckoutRoot: string;
  readonly vaultRoot: string;
}

export interface WindowsServiceDpapiSecretHandoffConfig {
  readonly deviceId: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly handoffRoot: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly maximumSecretBytes?: number;
  readonly powershellPath?: string;
  readonly runner?: NativeSecretCommandRunner;
  readonly serviceSid: string;
  readonly sourceCheckoutRoot: string;
}

/**
 * Which DPAPI-NG protection descriptor sealed a staged Secret.
 *
 * `service-account` restricts decryption to the service account itself. It
 * needs a domain KDS root key, which a workgroup host does not have, so those
 * hosts fall back to `machine`: any process on the same computer could decrypt
 * the blob if it could read it, leaving the handoff directory ACL as the
 * boundary that keeps other local accounts out.
 */
export type WindowsServiceSecretSealing = "machine" | "service-account";

export interface WindowsServiceSecretHandoffMutation {
  readonly status: "restaged" | "staged";
  readonly sealing: WindowsServiceSecretSealing;
}

export interface MacOsKeychainSecretStoreConfig {
  readonly codesignPath?: string;
  readonly deviceId: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly expectedHelperSha256: string;
  readonly helperPath: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly maximumSecretBytes?: number;
  readonly runner?: NativeSecretCommandRunner;
}

export interface LinuxSecretServiceSecretStoreConfig {
  readonly deviceId: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly hostPlatform?: NodeJS.Platform;
  readonly maximumSecretBytes?: number;
  readonly runner?: NativeSecretCommandRunner;
  readonly secretToolPath?: string;
}

export type PlatformManagedSecretStoreConfig =
  | ({ readonly backend: "linux-secret-service" } & LinuxSecretServiceSecretStoreConfig)
  | ({
      readonly backend: "linux-systemd-credential-vault";
    } & SystemdCredentialVaultSecretStoreConfig)
  | ({ readonly backend: "macos-keychain" } & MacOsKeychainSecretStoreConfig)
  | ({ readonly backend: "windows-dpapi" } & WindowsDpapiSecretStoreConfig)
  | ({
      readonly backend: "windows-service-dpapi";
    } & WindowsServiceDpapiSecretStoreConfig);

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
