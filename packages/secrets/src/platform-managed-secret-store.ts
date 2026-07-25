import type { ManagedSecretStore, PlatformManagedSecretStoreConfig } from "./contracts.ts";
import { LinuxSecretServiceSecretStore } from "./linux-secret-service-secret-store.ts";
import { MacOsKeychainSecretStore } from "./macos-keychain-secret-store.ts";
import { SystemdCredentialVaultSecretStore } from "./systemd-credential-vault-secret-store.ts";
import { WindowsDpapiSecretStore } from "./windows-dpapi-secret-store.ts";
import { WindowsServiceDpapiSecretStore } from "./windows-service-dpapi-secret-store.ts";

export function createPlatformManagedSecretStore(
  config: PlatformManagedSecretStoreConfig,
): ManagedSecretStore {
  switch (config.backend) {
    case "linux-secret-service":
      return new LinuxSecretServiceSecretStore(config);
    case "linux-systemd-credential-vault":
      return new SystemdCredentialVaultSecretStore(config);
    case "macos-keychain":
      return new MacOsKeychainSecretStore(config);
    case "windows-dpapi":
      return new WindowsDpapiSecretStore(config);
    case "windows-service-dpapi":
      return new WindowsServiceDpapiSecretStore(config);
  }
}
