import type {
  LinuxServiceConfiguration,
  MacOsServiceConfiguration,
  WindowsServiceConfiguration,
} from "../src/index.ts";

const CHECKSUM = `sha256:${"a".repeat(64)}`;
const IPC_TRUST = Object.freeze({
  protocolVersion: 2 as const,
  core: Object.freeze({
    keyId: "sha256:f9acccda515ce25409e456e45f25417bcda0c1cc0255490965f6ab59d5a81b48" as const,
    publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAjBmMzBDNPDdi86mu7kAWdhSpEsUBySgfGN0q2ganv5I",
  }),
  helper: Object.freeze({
    keyId: "sha256:b0308f5b2e753b15572359e7e9cd8da8400839df95052ddc21d9711554750c2f" as const,
    publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAli20Wxft7Lox4PLDh_IcMGjN265l-fNMneRfYNWYnko",
  }),
});

export function windowsConfiguration(
  overrides: Partial<WindowsServiceConfiguration> = {},
): WindowsServiceConfiguration {
  return {
    platform: "windows",
    instanceId: "personal",
    deviceId: "device-personal",
    role: "main",
    bundle: {
      version: "1.2.3",
      sourceDirectory: "C:\\release-input\\opendelegate-1.2.3",
      checksum: CHECKSUM,
    },
    paths: {
      sourceCheckoutDirectory: "C:\\src\\OpenDelegate",
      installRoot: "C:\\Program Files\\OpenDelegate",
      stateRoot: "C:\\ProgramData\\OpenDelegate\\state",
      authorityRoot: "C:\\ProgramData\\OpenDelegate\\authority",
      runtimeRoot: "C:\\ProgramData\\OpenDelegate\\run",
      logRoot: "C:\\ProgramData\\OpenDelegate\\logs",
    },
    ownerSession: {
      userName: "WORKSTATION\\owner",
      stableUserId: "S-1-5-21-1000",
      adminAutoOpen: {
        enabled: false,
      },
    },
    helperSecretBinding: {
      backend: "windows-dpapi",
      vaultRoot: "C:\\Users\\owner\\AppData\\Local\\OpenDelegate\\worker\\secrets\\dpapi",
    },
    ipcTrust: IPC_TRUST,
    secretReferences: {
      deviceIdentity: "secret://windows/device-identity",
      coreIpcSigningKey: "secret://windows/core-ipc-signing-v2",
      helperIpcSigningKey: "secret://windows/helper-ipc-signing-v2",
    },
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 30_000,
    },
    retainPreviousVersions: 2,
    ...overrides,
  };
}

export function macOsConfiguration(
  overrides: Partial<MacOsServiceConfiguration> = {},
): MacOsServiceConfiguration {
  return {
    platform: "macos",
    instanceId: "personal",
    deviceId: "device-personal",
    role: "main",
    bundle: {
      version: "1.2.3",
      sourceDirectory: "/Volumes/release-input/opendelegate-1.2.3",
      checksum: CHECKSUM,
    },
    paths: {
      sourceCheckoutDirectory: "/Users/owner/src/OpenDelegate",
      installRoot: "/Library/OpenDelegate",
      stateRoot: "/Library/Application Support/OpenDelegate/state",
      authorityRoot: "/Library/Application Support/OpenDelegate/authority",
      runtimeRoot: "/private/var/run/opendelegate",
      logRoot: "/Library/Logs/OpenDelegate",
    },
    ownerSession: {
      userName: "owner",
      stableUserId: "501",
      uid: 501,
      homeDirectory: "/Users/owner",
      adminAutoOpen: {
        enabled: false,
      },
    },
    ipcTrust: IPC_TRUST,
    serviceIdentity: {
      userName: "_opendelegate",
      groupName: "_opendelegate",
    },
    helperSecretBinding: {
      backend: "macos-keychain",
      helperPath: "/Library/OpenDelegate/current/runtime/native/opendelegate-keychain-helper",
      expectedHelperSha256: `sha256:${"b".repeat(64)}`,
    },
    secretReferences: {
      deviceIdentity: "secret://macos/device-identity",
      coreIpcSigningKey: "secret://macos/core-ipc-signing-v2",
      helperIpcSigningKey: "secret://macos/helper-ipc-signing-v2",
    },
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 30_000,
    },
    retainPreviousVersions: 2,
    ...overrides,
  };
}

export function linuxConfiguration(
  overrides: Partial<LinuxServiceConfiguration> = {},
): LinuxServiceConfiguration {
  return {
    platform: "linux",
    instanceId: "personal",
    deviceId: "device-personal",
    role: "worker",
    bundle: {
      version: "1.2.3",
      sourceDirectory: "/mnt/release-input/opendelegate-1.2.3",
      checksum: CHECKSUM,
    },
    paths: {
      sourceCheckoutDirectory: "/home/owner/src/OpenDelegate",
      installRoot: "/opt/opendelegate",
      stateRoot: "/var/lib/opendelegate",
      authorityRoot: "/var/lib/opendelegate-authority",
      runtimeRoot: "/run/opendelegate",
      logRoot: "/var/log/opendelegate",
    },
    ownerSession: {
      userName: "owner",
      stableUserId: "1000",
      uid: 1000,
      homeDirectory: "/home/owner",
      adminAutoOpen: {
        enabled: false,
      },
    },
    ipcTrust: IPC_TRUST,
    serviceIdentity: {
      userName: "opendelegate",
      groupName: "opendelegate",
    },
    helperSecretBinding: {
      backend: "linux-secret-service",
      secretToolPath: "/usr/bin/secret-tool",
    },
    systemdCredential: null,
    secretReferences: {
      deviceIdentity: "secret://linux/device-identity",
      coreIpcSigningKey: "secret://linux/core-ipc-signing-v2",
      helperIpcSigningKey: "secret://linux/helper-ipc-signing-v2",
    },
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 30_000,
    },
    retainPreviousVersions: 2,
    ...overrides,
  };
}
