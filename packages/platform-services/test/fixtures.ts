import type {
  LinuxServiceConfiguration,
  MacOsServiceConfiguration,
  WindowsServiceConfiguration,
} from "../src/index.ts";

const CHECKSUM = `sha256:${"a".repeat(64)}`;

export function windowsConfiguration(
  overrides: Partial<WindowsServiceConfiguration> = {},
): WindowsServiceConfiguration {
  return {
    platform: "windows",
    instanceId: "personal",
    role: "worker",
    bundle: {
      version: "1.2.3",
      sourceDirectory: "C:\\release-input\\opendelegate-1.2.3",
      checksum: CHECKSUM,
    },
    paths: {
      sourceCheckoutDirectory: "C:\\src\\OpenDelegate",
      installRoot: "C:\\Program Files\\OpenDelegate",
      stateRoot: "C:\\ProgramData\\OpenDelegate\\state",
      runtimeRoot: "C:\\ProgramData\\OpenDelegate\\run",
      logRoot: "C:\\ProgramData\\OpenDelegate\\logs",
    },
    ownerSession: {
      userName: "WORKSTATION\\owner",
      stableUserId: "S-1-5-21-1000",
    },
    secretReferences: {
      deviceIdentity: "secret://windows/device-identity",
      helperIpc: "secret://windows/helper-ipc",
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
      runtimeRoot: "/var/run/opendelegate",
      logRoot: "/Library/Logs/OpenDelegate",
    },
    ownerSession: {
      userName: "owner",
      stableUserId: "501",
      uid: 501,
      homeDirectory: "/Users/owner",
    },
    serviceIdentity: {
      userName: "_opendelegate",
      groupName: "_opendelegate",
    },
    secretReferences: {
      deviceIdentity: "secret://macos/device-identity",
      helperIpc: "secret://macos/helper-ipc",
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
      runtimeRoot: "/run/opendelegate",
      logRoot: "/var/log/opendelegate",
    },
    ownerSession: {
      userName: "owner",
      stableUserId: "1000",
      uid: 1000,
      homeDirectory: "/home/owner",
    },
    serviceIdentity: {
      userName: "opendelegate",
      groupName: "opendelegate",
    },
    secretReferences: {
      deviceIdentity: "secret://linux/device-identity",
      helperIpc: "secret://linux/helper-ipc",
    },
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 30_000,
    },
    retainPreviousVersions: 2,
    ...overrides,
  };
}
