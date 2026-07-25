import { constants as fileConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  ManagedDeviceIdentitySecretStore,
  SystemdCredentialKeyProvider,
  createPlatformManagedSecretStore,
  type PlatformManagedSecretStoreConfig,
} from "@opendelegate/secrets";

import type {
  MainDeviceChannelConfiguration,
  MainDeviceListenerConfiguration,
  MainWorkerChannelListenerConfiguration,
} from "./device-channel-runtime.ts";
import { readStableRegularFile } from "./stable-file.ts";

const CONFIGURATION_SCHEMA_VERSION = 1;
const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;
const ENROLLMENT_PATH = "/api/v1/device/enroll";
const DEFAULT_WORKER_CHANNEL_PATH = "/api/v1/device/channel";

export type MainDeviceIdentitySecretBackendConfiguration =
  | {
      readonly backend: "windows-dpapi";
      readonly vaultRoot: string;
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
      readonly vaultRoot: string;
    };

/**
 * Secret-free source and persisted composition for Main's enrollment HTTPS and
 * mutually authenticated Worker WSS listeners. Secret values never belong here:
 * only OS Secret Store backend locations and public listener paths are accepted.
 */
export interface MainDeviceEnrollmentConfiguration extends MainDeviceChannelConfiguration {
  readonly schemaVersion: typeof CONFIGURATION_SCHEMA_VERSION;
  readonly enabled: true;
  readonly secretBackend: MainDeviceIdentitySecretBackendConfiguration;
}

export class MainDeviceEnrollmentConfigurationError extends Error {
  public readonly code = "CONFIG_INVALID";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MainDeviceEnrollmentConfigurationError";
  }
}

export async function loadMainDeviceEnrollmentConfigurationSource(
  path: string,
  options: {
    readonly sourceCheckout: string;
  },
): Promise<MainDeviceEnrollmentConfiguration> {
  const sourceCheckout = requireAbsolutePath(options.sourceCheckout, "source checkout");
  if (!isAbsolute(path)) {
    throw configurationInvalid();
  }
  let parsed: unknown;
  try {
    const bytes = await readStableRegularFile(path, MAXIMUM_CONFIGURATION_BYTES);
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    throw configurationInvalid(error);
  }
  return validateMainDeviceEnrollmentConfiguration(parsed, { sourceCheckout });
}

export async function loadPersistedMainDeviceEnrollmentConfiguration(
  path: string,
  options: {
    readonly sourceCheckout: string;
  },
): Promise<MainDeviceEnrollmentConfiguration> {
  return loadMainDeviceEnrollmentConfigurationSource(path, options);
}

export async function persistMainDeviceEnrollmentConfiguration(
  path: string,
  input: MainDeviceEnrollmentConfiguration,
  options: {
    readonly sourceCheckout: string;
  },
): Promise<"created" | "unchanged"> {
  const sourceCheckout = requireAbsolutePath(options.sourceCheckout, "source checkout");
  const target = requireOutsideSourcePath(path, sourceCheckout, "Device enrollment configuration");
  const configuration = validateMainDeviceEnrollmentConfiguration(input, { sourceCheckout });
  const serialized = Buffer.from(`${JSON.stringify(configuration, undefined, 2)}\n`, "utf8");
  try {
    await ensurePrivateParent(target, sourceCheckout);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        target,
        fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertRestrictedRegularFile(target);
      return "created";
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }

    await assertRestrictedRegularFile(target);
    const existing = await loadPersistedMainDeviceEnrollmentConfiguration(target, {
      sourceCheckout,
    });
    if (JSON.stringify(existing) !== JSON.stringify(configuration)) {
      throw new MainDeviceEnrollmentConfigurationError(
        "Main is already initialized with a different Device enrollment composition.",
      );
    }
    return "unchanged";
  } catch (error) {
    if (error instanceof MainDeviceEnrollmentConfigurationError) {
      throw error;
    }
    throw configurationInvalid(error);
  } finally {
    serialized.fill(0);
  }
}

export function validateMainDeviceEnrollmentConfiguration(
  input: unknown,
  options: {
    readonly sourceCheckout: string;
  },
): MainDeviceEnrollmentConfiguration {
  const sourceCheckout = requireAbsolutePath(options.sourceCheckout, "source checkout");
  const record = requireRecord(input);
  assertExactKeys(record, [
    "schemaVersion",
    "enabled",
    "enrollment",
    "workerChannel",
    "secretBackend",
  ]);
  if (record["schemaVersion"] !== CONFIGURATION_SCHEMA_VERSION || record["enabled"] !== true) {
    throw configurationInvalid();
  }
  const enrollment = validateListener(
    record["enrollment"],
    sourceCheckout,
    "https:",
    ENROLLMENT_PATH,
    false,
  );
  const workerChannel = validateListener(
    record["workerChannel"],
    sourceCheckout,
    "wss:",
    DEFAULT_WORKER_CHANNEL_PATH,
    true,
  ) as MainWorkerChannelListenerConfiguration;
  if (enrollment.host === workerChannel.host && enrollment.port === workerChannel.port) {
    throw new MainDeviceEnrollmentConfigurationError(
      "Enrollment HTTPS and Worker WSS require separate listener addresses.",
    );
  }
  if (
    enrollment.tlsCertificatePath === workerChannel.tlsCertificatePath &&
    enrollment.tlsPrivateKeyPath !== workerChannel.tlsPrivateKeyPath
  ) {
    throw new MainDeviceEnrollmentConfigurationError(
      "One TLS certificate path cannot be paired with different private-key paths.",
    );
  }
  if (
    enrollment.tlsPrivateKeyPath === workerChannel.tlsPrivateKeyPath &&
    enrollment.tlsCertificatePath !== workerChannel.tlsCertificatePath
  ) {
    throw new MainDeviceEnrollmentConfigurationError(
      "One TLS private-key path cannot be paired with different certificate paths.",
    );
  }
  assertNoManagedTlsPathCollisions([enrollment, workerChannel]);
  const secretBackend = validateSecretBackend(record["secretBackend"], sourceCheckout);
  return deepFreeze({
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    enabled: true,
    enrollment,
    workerChannel,
    secretBackend,
  });
}

function assertNoManagedTlsPathCollisions(
  listeners: readonly MainDeviceListenerConfiguration[],
): void {
  const pairs = new Map<string, readonly [string, string]>();
  for (const listener of listeners) {
    const pair = [listener.tlsCertificatePath, listener.tlsPrivateKeyPath] as const;
    pairs.set(`${pair[0]}\0${pair[1]}`, pair);
  }
  const claimedPaths = new Set<string>();
  for (const [certificatePath, privateKeyPath] of pairs.values()) {
    const manifestPath = `${certificatePath}.opendelegate-managed.json`;
    for (const path of [certificatePath, privateKeyPath, manifestPath]) {
      if (claimedPaths.has(path)) {
        throw new MainDeviceEnrollmentConfigurationError(
          "Managed listener TLS certificate, private-key, and ownership paths must be disjoint.",
        );
      }
      claimedPaths.add(path);
    }
  }
}

export function createMainDeviceIdentitySecretStore(input: {
  readonly configuration: MainDeviceEnrollmentConfiguration;
  readonly deviceId: string;
  readonly sourceCheckout: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): ManagedDeviceIdentitySecretStore {
  const sourceCheckout = requireAbsolutePath(input.sourceCheckout, "source checkout");
  const configuration = validateMainDeviceEnrollmentConfiguration(input.configuration, {
    sourceCheckout,
  });
  const managed = createPlatformManagedSecretStore(
    secretStoreConfiguration({
      backend: configuration.secretBackend,
      deviceId: requireIdentifier(input.deviceId, "Main Device ID"),
      sourceCheckout,
      environment: input.environment ?? process.env,
    }),
  );
  return new ManagedDeviceIdentitySecretStore(managed);
}

function validateListener(
  input: unknown,
  sourceCheckout: string,
  protocol: "https:" | "wss:",
  requiredPath: string,
  allowPathField: boolean,
): MainDeviceListenerConfiguration | MainWorkerChannelListenerConfiguration {
  const record = requireRecord(input);
  const expectedKeys = [
    "advertisedUrl",
    "host",
    "port",
    "tlsCertificatePath",
    "tlsPrivateKeyPath",
    ...(allowPathField ? ["path"] : []),
  ];
  assertExactKeys(record, expectedKeys);
  if (
    typeof record["host"] !== "string" ||
    record["host"].length < 1 ||
    record["host"].length > 253 ||
    record["host"] !== record["host"].trim() ||
    containsControl(record["host"]) ||
    !Number.isSafeInteger(record["port"]) ||
    (record["port"] as number) < 1 ||
    (record["port"] as number) > 65_535
  ) {
    throw configurationInvalid();
  }
  const port = record["port"] as number;
  const configuredPath = allowPathField
    ? requireChannelPath(record["path"], requiredPath)
    : requiredPath;
  let advertised: URL;
  try {
    advertised = new URL(requireString(record["advertisedUrl"]));
  } catch {
    throw configurationInvalid();
  }
  if (
    advertised.protocol !== protocol ||
    advertised.username !== "" ||
    advertised.password !== "" ||
    advertised.search !== "" ||
    advertised.hash !== "" ||
    advertised.pathname !== configuredPath ||
    Number(advertised.port || "443") !== port
  ) {
    throw configurationInvalid();
  }
  const tlsCertificatePath = requireOutsideSourcePath(
    record["tlsCertificatePath"],
    sourceCheckout,
    "TLS certificate",
  );
  const tlsPrivateKeyPath = requireOutsideSourcePath(
    record["tlsPrivateKeyPath"],
    sourceCheckout,
    "TLS private key",
  );
  if (tlsCertificatePath === tlsPrivateKeyPath) {
    throw configurationInvalid();
  }
  return Object.freeze({
    advertisedUrl: advertised.toString(),
    host: record["host"],
    port,
    tlsCertificatePath,
    tlsPrivateKeyPath,
    ...(allowPathField ? { path: configuredPath } : {}),
  });
}

function validateSecretBackend(
  input: unknown,
  sourceCheckout: string,
): MainDeviceIdentitySecretBackendConfiguration {
  const record = requireRecord(input);
  switch (record["backend"]) {
    case "windows-dpapi":
      assertExactKeys(record, ["backend", "vaultRoot"]);
      return Object.freeze({
        backend: "windows-dpapi",
        vaultRoot: requireOutsideSourcePath(
          record["vaultRoot"],
          sourceCheckout,
          "Windows identity vault",
        ),
      });
    case "macos-keychain":
      assertExactKeys(record, ["backend", "helperPath", "expectedHelperSha256"]);
      if (
        typeof record["expectedHelperSha256"] !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(record["expectedHelperSha256"])
      ) {
        throw configurationInvalid();
      }
      return Object.freeze({
        backend: "macos-keychain",
        helperPath: requireAbsolutePath(record["helperPath"], "macOS Keychain helper"),
        expectedHelperSha256: record["expectedHelperSha256"],
      });
    case "linux-secret-service":
      assertExactKeys(record, ["backend", "secretToolPath"]);
      return Object.freeze({
        backend: "linux-secret-service",
        secretToolPath: requireAbsolutePath(record["secretToolPath"], "secret-tool"),
      });
    case "linux-systemd-credential-vault":
      assertExactKeys(record, ["backend", "credentialName", "vaultRoot"]);
      return Object.freeze({
        backend: "linux-systemd-credential-vault",
        credentialName: requireIdentifier(record["credentialName"], "credential name"),
        vaultRoot: requireOutsideSourcePath(
          record["vaultRoot"],
          sourceCheckout,
          "systemd identity vault",
        ),
      });
    default:
      throw configurationInvalid();
  }
}

function secretStoreConfiguration(input: {
  readonly backend: MainDeviceIdentitySecretBackendConfiguration;
  readonly deviceId: string;
  readonly sourceCheckout: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): PlatformManagedSecretStoreConfig {
  switch (input.backend.backend) {
    case "windows-dpapi":
      return {
        backend: "windows-dpapi",
        deviceId: input.deviceId,
        sourceCheckoutRoot: input.sourceCheckout,
        vaultRoot: input.backend.vaultRoot,
      };
    case "macos-keychain":
      return {
        backend: "macos-keychain",
        deviceId: input.deviceId,
        helperPath: input.backend.helperPath,
        expectedHelperSha256: input.backend.expectedHelperSha256,
      };
    case "linux-secret-service":
      return {
        backend: "linux-secret-service",
        deviceId: input.deviceId,
        secretToolPath: input.backend.secretToolPath,
      };
    case "linux-systemd-credential-vault": {
      const credentialDirectory = input.environment["CREDENTIALS_DIRECTORY"];
      if (credentialDirectory === undefined || credentialDirectory.trim().length === 0) {
        throw new MainDeviceEnrollmentConfigurationError(
          "The configured systemd credential directory is unavailable.",
        );
      }
      return {
        backend: "linux-systemd-credential-vault",
        deviceId: input.deviceId,
        sourceCheckoutRoot: input.sourceCheckout,
        vaultRoot: input.backend.vaultRoot,
        keyProvider: new SystemdCredentialKeyProvider({
          credentialDirectory,
          credentialName: input.backend.credentialName,
          sourceCheckoutRoot: input.sourceCheckout,
        }),
      };
    }
  }
}

async function ensurePrivateParent(path: string, sourceCheckout: string): Promise<void> {
  const parent = dirname(path);
  await assertNoPathLinks(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoPathLinks(parent);
  const metadata = await lstat(parent);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw configurationInvalid();
  }
  const canonical = await realpath(parent);
  if (!pathsEqual(canonical, parent)) {
    throw configurationInvalid();
  }
  requireOutsideSourcePath(canonical, sourceCheckout, "Device enrollment configuration parent");
}

async function assertNoPathLinks(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw configurationInvalid();
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function assertRestrictedRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw configurationInvalid();
  }
}

function requireChannelPath(value: unknown, expected: string): string {
  if (
    typeof value !== "string" ||
    value !== expected ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1023}$/u.test(value)
  ) {
    throw configurationInvalid();
  }
  return value;
}

function requireOutsideSourcePath(value: unknown, sourceCheckout: string, label: string): string {
  const path = requireAbsolutePath(value, label);
  const relationship = relative(resolve(sourceCheckout), path);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw new MainDeviceEnrollmentConfigurationError(
      `${label} must remain outside the source checkout.`,
    );
  }
  return path;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new MainDeviceEnrollmentConfigurationError(`${label} must be an absolute path.`);
  }
  return resolve(value);
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new MainDeviceEnrollmentConfigurationError(`The ${label} is invalid.`);
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw configurationInvalid();
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw configurationInvalid();
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  if (Object.keys(record).sort().join(",") !== [...expected].sort().join(",")) {
    throw configurationInvalid();
  }
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function configurationInvalid(cause?: unknown): MainDeviceEnrollmentConfigurationError {
  return new MainDeviceEnrollmentConfigurationError(
    "The Device enrollment configuration is invalid and no Secret value may appear in it.",
    cause === undefined ? undefined : { cause },
  );
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
