import { posix, win32 } from "node:path";

import { parsePlatformServiceConfiguration } from "./configuration.ts";
import {
  PlatformServiceError,
  type DeviceRuntimeRole,
  type LocalIpcPublicKeyPin,
  type OwnerSessionIdentity,
  type PlatformFamily,
  type PlatformServiceConfiguration,
  type ReleaseBundle,
  type ServiceIdentity,
} from "./types.ts";

export interface ComposeServiceConfigurationInput {
  readonly platform: PlatformFamily;
  readonly role: DeviceRuntimeRole;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly bundle: ReleaseBundle;
  /** The source checkout or packaged launcher root, which installed state must never live inside. */
  readonly sourceCheckoutDirectory: string;
  /** Where versioned bundles land. `current` and `releases/` are created beneath it. */
  readonly installRoot: string;
  /** The one root the four runtime directories are derived from. */
  readonly dataRoot: string;
  readonly ownerSession: OwnerSessionIdentity;
  /**
   * Pins for identities the Device already holds, never freshly minted ones. The
   * core key lives in the core Secret Store and the helper key in the owner-session
   * store, and the session helper refuses to start when a pin does not match the
   * key it holds — a mismatch surfaces far from whatever substituted it.
   */
  readonly ipcTrust: {
    readonly core: LocalIpcPublicKeyPin;
    readonly helper: LocalIpcPublicKeyPin;
  };
  readonly secretReferences: {
    readonly coreIpcSigningKey: string;
    readonly helperIpcSigningKey: string;
  };
  /** Loopback port for the core plane's liveness endpoint. */
  readonly healthPort: number;
  /** Required off Windows, where the service runs under its own account. */
  readonly serviceIdentity?: ServiceIdentity;
  /** Required on macOS, where the Keychain helper is pinned by digest. */
  readonly macOsKeychainHelper?: {
    readonly helperPath: string;
    readonly expectedHelperSha256: `sha256:${string}`;
  };
  /** Required on Linux, where owner Secrets go through the Secret Service tool. */
  readonly linuxSecretToolPath?: string;
  /**
   * The staged Windows handoff, when one exists. The core service runs under its
   * own account and cannot read Secrets sealed to the owner, so an install without
   * this binding produces a service that starts and then cannot open its own store.
   */
  readonly windowsServiceSecretBinding?: {
    readonly backend: "windows-service-dpapi";
    readonly handoffRoot: string;
    readonly serviceName: string;
    readonly serviceSid: string;
    readonly vaultRoot: string;
  };
  /** Existing owner DPAPI vault that retains only the session-helper identity. */
  readonly windowsOwnerHelperVaultRoot?: string;
  /** Optional encrypted core credential used by a headless systemd service. */
  readonly systemdCredential?: {
    readonly credentialName: string;
    readonly encryptedSourcePath: string;
  } | null;
  readonly retainPreviousVersions?: number;
  readonly healthTimeoutMs?: number;
}

const DEFAULT_RETAINED_VERSIONS = 2;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;

/**
 * Builds a complete, validated native service document from the few facts a host
 * actually knows.
 *
 * The schema is strict on purpose — disjoint roots, a vault that must sit under
 * the state root, cross-pinned signing identities — and every one of those rules
 * is a way for a hand-written document to be wrong in a manner the owner cannot
 * debug. Deriving the whole shape from one data root and one install root leaves
 * only choices a person can reasonably make, and validating before returning means
 * an invalid combination fails here rather than midway through an install.
 */
export function composeServiceConfiguration(
  input: ComposeServiceConfigurationInput,
): PlatformServiceConfiguration {
  const path = input.platform === "windows" ? win32 : posix;
  const dataRoot = stripTrailingSeparators(input.dataRoot);
  const stateRoot = path.join(dataRoot, "state");
  const paths = {
    sourceCheckoutDirectory: input.sourceCheckoutDirectory,
    installRoot: input.installRoot,
    stateRoot,
    authorityRoot: path.join(dataRoot, "authority"),
    runtimeRoot: path.join(dataRoot, "run"),
    logRoot: path.join(dataRoot, "logs"),
  };
  const base = {
    instanceId: input.instanceId,
    deviceId: input.deviceId,
    role: input.role,
    bundle: input.bundle,
    paths,
    ownerSession: input.ownerSession,
    ipcTrust: {
      protocolVersion: 2 as const,
      core: input.ipcTrust.core,
      helper: input.ipcTrust.helper,
    },
    secretReferences: {
      coreIpcSigningKey: input.secretReferences.coreIpcSigningKey,
      helperIpcSigningKey: input.secretReferences.helperIpcSigningKey,
    },
    health: {
      endpoint: healthEndpoint(input.healthPort),
      timeoutMs: input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    },
    retainPreviousVersions: input.retainPreviousVersions ?? DEFAULT_RETAINED_VERSIONS,
  };

  if (input.platform === "windows") {
    return parsePlatformServiceConfiguration({
      platform: "windows",
      ...base,
      helperSecretBinding: {
        backend: "windows-dpapi",
        vaultRoot: required(
          input.windowsOwnerHelperVaultRoot,
          "The existing Windows owner-session DPAPI vault is required.",
        ),
      },
      ...(input.windowsServiceSecretBinding === undefined
        ? {}
        : { serviceSecretBinding: input.windowsServiceSecretBinding }),
    });
  }
  const serviceIdentity = required(
    input.serviceIdentity,
    "A service account identity is required off Windows.",
  );
  if (input.platform === "macos") {
    const helper = required(
      input.macOsKeychainHelper,
      "The pinned macOS Keychain helper is required.",
    );
    return parsePlatformServiceConfiguration({
      platform: "macos",
      ...base,
      serviceIdentity,
      helperSecretBinding: {
        backend: "macos-keychain",
        helperPath: helper.helperPath,
        expectedHelperSha256: helper.expectedHelperSha256,
      },
    });
  }
  return parsePlatformServiceConfiguration({
    platform: "linux",
    ...base,
    serviceIdentity,
    helperSecretBinding: {
      backend: "linux-secret-service",
      secretToolPath: required(
        input.linuxSecretToolPath,
        "The Linux Secret Service tool path is required.",
      ),
    },
    systemdCredential: input.systemdCredential ?? null,
  });
}

function healthEndpoint(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new PlatformServiceError(
      "INVALID_HEALTH_ENDPOINT",
      "The local health port must be a usable TCP port.",
    );
  }
  return `http://127.0.0.1:${port}/health/live`;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new PlatformServiceError("INVALID_CONFIGURATION", message);
  }
  return value;
}

function stripTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) {
    end -= 1;
  }
  return value.slice(0, end);
}
