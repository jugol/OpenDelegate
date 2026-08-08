import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  SystemdCredentialKeyProvider,
  createPlatformManagedSecretStore,
  type ManagedSecretStore,
  type PlatformManagedSecretStoreConfig,
} from "@opendelegate/secrets";

import { readStableRegularFile } from "./stable-file.ts";

const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;

/**
 * Persistent, non-secret description of the Device-local Secret Store used by
 * Main. Linux intentionally has no silent headless fallback.
 */
export type MainSecretBackendConfiguration =
  | {
      readonly backend: "windows-dpapi";
      readonly vaultRoot: string;
    }
  | {
      readonly backend: "windows-service-dpapi";
      readonly vaultRoot: string;
      readonly handoffRoot: string;
      readonly serviceSid: string;
    }
  | {
      readonly backend: "macos-keychain";
      readonly helperPath: string;
      readonly expectedHelperSha256: string;
    }
  | {
      readonly backend: "linux-secret-service";
      readonly secretToolPath: string;
    }
  | {
      readonly backend: "linux-systemd-credential-vault";
      readonly credentialName: string;
      /** Public source used by the eventual systemd LoadCredentialEncrypted mapping. */
      readonly encryptedCredentialFile?: string;
      readonly vaultRoot: string;
    };

export class MainSecretBackendConfigurationError extends Error {
  public readonly code = "SECRET_BACKEND_INVALID";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MainSecretBackendConfigurationError";
  }
}

export async function loadMainSecretBackendConfigurationSource(
  path: string,
): Promise<MainSecretBackendConfiguration> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw invalidConfiguration();
  }
  let bytes: Buffer | undefined;
  try {
    bytes = await readStableRegularFile(resolve(path), MAXIMUM_CONFIGURATION_BYTES);
    return validateMainSecretBackendConfiguration(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof MainSecretBackendConfigurationError) {
      throw error;
    }
    throw invalidConfiguration(error);
  } finally {
    bytes?.fill(0);
  }
}

export function validateMainSecretBackendConfiguration(
  input: unknown,
): MainSecretBackendConfiguration {
  const record = requireRecord(input);
  switch (record["backend"]) {
    case "windows-dpapi":
      assertExactKeys(record, ["backend", "vaultRoot"]);
      return Object.freeze({
        backend: "windows-dpapi",
        vaultRoot: requireAbsolutePath(record["vaultRoot"]),
      });
    case "windows-service-dpapi":
      assertExactKeys(record, ["backend", "vaultRoot", "handoffRoot", "serviceSid"]);
      return Object.freeze({
        backend: "windows-service-dpapi",
        vaultRoot: requireAbsolutePath(record["vaultRoot"]),
        handoffRoot: requireAbsolutePath(record["handoffRoot"]),
        serviceSid: requireServiceSid(record["serviceSid"]),
      });
    case "macos-keychain":
      assertExactKeys(record, ["backend", "helperPath", "expectedHelperSha256"]);
      if (
        typeof record["expectedHelperSha256"] !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(record["expectedHelperSha256"])
      ) {
        throw invalidConfiguration();
      }
      return Object.freeze({
        backend: "macos-keychain",
        helperPath: requireAbsolutePath(record["helperPath"]),
        expectedHelperSha256: record["expectedHelperSha256"],
      });
    case "linux-secret-service":
      assertExactKeys(record, ["backend", "secretToolPath"]);
      return Object.freeze({
        backend: "linux-secret-service",
        secretToolPath: requireAbsolutePath(record["secretToolPath"]),
      });
    case "linux-systemd-credential-vault":
      assertExactKeys(
        record,
        ["backend", "credentialName", "vaultRoot"],
        ["encryptedCredentialFile"],
      );
      return Object.freeze({
        backend: "linux-systemd-credential-vault",
        credentialName: requireIdentifier(record["credentialName"], "credential name"),
        ...(record["encryptedCredentialFile"] === undefined
          ? {}
          : { encryptedCredentialFile: requireAbsolutePath(record["encryptedCredentialFile"]) }),
        vaultRoot: requireAbsolutePath(record["vaultRoot"]),
      });
    default:
      throw invalidConfiguration();
  }
}

export async function defaultMainSecretBackendConfiguration(input: {
  readonly home: string;
  readonly sourceCheckout: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<MainSecretBackendConfiguration> {
  const hostPlatform = input.hostPlatform ?? process.platform;
  switch (hostPlatform) {
    case "win32":
      return Object.freeze({
        backend: "windows-dpapi",
        vaultRoot: resolve(input.home, "secrets", "main"),
      });
    case "darwin": {
      const helperPath = resolve(
        input.sourceCheckout,
        "runtime",
        "native",
        "opendelegate-keychain-helper",
      );
      let bytes: Buffer | undefined;
      let expectedHelperSha256 = `sha256:${"0".repeat(64)}`;
      try {
        bytes = await readStableRegularFile(helperPath, 64 * 1024 * 1024);
        expectedHelperSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      } catch {
        // A missing or unverified release helper leaves the store fail-closed.
      } finally {
        bytes?.fill(0);
      }
      return Object.freeze({
        backend: "macos-keychain",
        helperPath,
        expectedHelperSha256,
      });
    }
    case "linux": {
      const environment = input.environment ?? process.env;
      if (
        nonempty(environment["DBUS_SESSION_BUS_ADDRESS"]) &&
        nonempty(environment["XDG_RUNTIME_DIR"])
      ) {
        return Object.freeze({
          backend: "linux-secret-service",
          secretToolPath: "/usr/bin/secret-tool",
        });
      }
      throw new MainSecretBackendConfigurationError(
        "Headless Linux requires an explicit linux-systemd-credential-vault Secret backend configuration. Pass --secret-backend-config during init.",
      );
    }
    default:
      throw new MainSecretBackendConfigurationError(
        `The ${hostPlatform} platform has no supported Main Secret backend.`,
      );
  }
}

export function createMainManagedSecretStore(input: {
  readonly configuration: MainSecretBackendConfiguration;
  readonly deviceId: string;
  readonly sourceCheckout: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly hostPlatform?: NodeJS.Platform;
}): ManagedSecretStore {
  const configuration = validateMainSecretBackendConfiguration(input.configuration);
  return createPlatformManagedSecretStore(
    platformConfiguration({
      configuration,
      deviceId: requireIdentifier(input.deviceId, "Device ID"),
      sourceCheckout: resolve(input.sourceCheckout),
      environment: input.environment ?? process.env,
      hostPlatform: input.hostPlatform ?? process.platform,
    }),
  );
}

function platformConfiguration(input: {
  readonly configuration: MainSecretBackendConfiguration;
  readonly deviceId: string;
  readonly sourceCheckout: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly hostPlatform: NodeJS.Platform;
}): PlatformManagedSecretStoreConfig {
  switch (input.configuration.backend) {
    case "windows-dpapi":
      return {
        backend: "windows-dpapi",
        deviceId: input.deviceId,
        hostPlatform: input.hostPlatform,
        sourceCheckoutRoot: input.sourceCheckout,
        vaultRoot: input.configuration.vaultRoot,
      };
    case "windows-service-dpapi":
      return {
        backend: "windows-service-dpapi",
        deviceId: input.deviceId,
        hostPlatform: input.hostPlatform,
        sourceCheckoutRoot: input.sourceCheckout,
        vaultRoot: input.configuration.vaultRoot,
        handoffRoot: input.configuration.handoffRoot,
        serviceSid: input.configuration.serviceSid,
      };
    case "macos-keychain":
      return {
        backend: "macos-keychain",
        deviceId: input.deviceId,
        hostPlatform: input.hostPlatform,
        helperPath: input.configuration.helperPath,
        expectedHelperSha256: input.configuration.expectedHelperSha256,
      };
    case "linux-secret-service":
      return {
        backend: "linux-secret-service",
        deviceId: input.deviceId,
        hostPlatform: input.hostPlatform,
        secretToolPath: input.configuration.secretToolPath,
        environment: selectEnvironment(input.environment, [
          "DBUS_SESSION_BUS_ADDRESS",
          "XDG_RUNTIME_DIR",
        ]),
      };
    case "linux-systemd-credential-vault": {
      const credentialDirectory = input.environment["CREDENTIALS_DIRECTORY"];
      if (!nonempty(credentialDirectory)) {
        throw new MainSecretBackendConfigurationError(
          "The configured systemd credential backend requires CREDENTIALS_DIRECTORY from systemd.",
        );
      }
      return {
        backend: "linux-systemd-credential-vault",
        deviceId: input.deviceId,
        sourceCheckoutRoot: input.sourceCheckout,
        vaultRoot: input.configuration.vaultRoot,
        keyProvider: new SystemdCredentialKeyProvider({
          credentialDirectory,
          credentialName: input.configuration.credentialName,
          sourceCheckoutRoot: input.sourceCheckout,
          hostPlatform: input.hostPlatform,
        }),
        hostPlatform: input.hostPlatform,
      };
    }
  }
}

function selectEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) {
      selected[name] = value;
    }
  }
  return selected;
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw invalidConfiguration();
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  input: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(input);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(input, key)) || keys.some((key) => !allowed.has(key))) {
    throw invalidConfiguration();
  }
}

function requireAbsolutePath(input: unknown): string {
  if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0")) {
    throw invalidConfiguration();
  }
  return resolve(input);
}

function requireIdentifier(input: unknown, label: string): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input)
  ) {
    throw new MainSecretBackendConfigurationError(`The ${label} is invalid.`);
  }
  return input;
}

function requireServiceSid(input: unknown): string {
  if (typeof input !== "string" || !/^S-1-(?:[0-9]+-){1,14}[0-9]+$/u.test(input)) {
    throw invalidConfiguration();
  }
  return input;
}

function nonempty(input: string | undefined): input is string {
  return input !== undefined && input.trim().length > 0;
}

function invalidConfiguration(cause?: unknown): MainSecretBackendConfigurationError {
  return new MainSecretBackendConfigurationError(
    "The Main Secret backend configuration is invalid. It may contain only non-secret backend descriptors and absolute paths.",
    cause === undefined ? undefined : { cause },
  );
}
