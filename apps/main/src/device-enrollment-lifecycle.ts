import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { EnrollmentGrantFileDocument } from "@opendelegate/device-channel";
import {
  DeviceIdentityAuthority,
  type DeviceIdentitySecretStore,
  type IdentityClock,
} from "@opendelegate/device-identity";
import { SqlDeviceIdentityRepository } from "@opendelegate/storage-sql";

import type {
  MainDeviceChannelConfiguration,
  MainDeviceChannelDatabase,
  MainDeviceListenerConfiguration,
} from "./device-channel-runtime.ts";
import { readStableRegularFile } from "./stable-file.ts";

const MINIMUM_TLS_VALIDITY_MS = 14 * 24 * 60 * 60 * 1_000;
const MAXIMUM_TLS_FILE_BYTES = 256 * 1024;
const MAXIMUM_MANIFEST_BYTES = 16 * 1024;
const MANIFEST_SCHEMA_VERSION = 1;
const PROTOCOL_VERSION = 1;

export type MainDeviceEnrollmentLifecycleErrorCode =
  "CONFIG_INVALID" | "GRANT_FILE_EXISTS" | "GRANT_ISSUANCE_FAILED" | "TLS_PROVISION_FAILED";

export class MainDeviceEnrollmentLifecycleError extends Error {
  public readonly code: MainDeviceEnrollmentLifecycleErrorCode;

  public constructor(
    code: MainDeviceEnrollmentLifecycleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MainDeviceEnrollmentLifecycleError";
    this.code = code;
  }
}

export interface ProvisionedMainDeviceListenerTls {
  readonly status: "current" | "provisioned";
  readonly certificateAuthorityPem: string;
  readonly listenerIdentities: readonly {
    readonly certificatePath: string;
    readonly privateKeyPath: string;
    readonly hostnames: readonly string[];
    readonly notAfter: number;
  }[];
}

export async function provisionMainDeviceListenerTls(input: {
  readonly configuration: MainDeviceChannelConfiguration;
  readonly database: MainDeviceChannelDatabase;
  readonly identitySecrets: DeviceIdentitySecretStore;
  readonly instanceId: string;
  readonly sourceCheckout: string;
  readonly clock?: IdentityClock;
  readonly minimumRemainingValidityMs?: number;
}): Promise<ProvisionedMainDeviceListenerTls> {
  const sourceCheckout = requireAbsolutePath(input.sourceCheckout, "source checkout");
  const instanceId = requireIdentifier(input.instanceId, "Instance ID");
  const clock = input.clock ?? { now: () => Date.now() };
  const now = readClock(clock);
  const minimumRemainingValidityMs = requireTlsRenewalWindow(
    input.minimumRemainingValidityMs ?? MINIMUM_TLS_VALIDITY_MS,
  );
  const groups = listenerIdentityGroups(input.configuration, sourceCheckout);
  assertNoManagedTlsPathCollisions(groups);
  const repository = await openIdentityRepository(input.database, "apply");
  try {
    const authority = new DeviceIdentityAuthority({
      clock,
      repository,
      secrets: input.identitySecrets,
    });
    const certificateAuthority = await authority.bootstrapCertificateAuthority({ instanceId });
    let changed = false;
    const identities: {
      certificatePath: string;
      privateKeyPath: string;
      hostnames: readonly string[];
      notAfter: number;
    }[] = [];
    for (const group of groups) {
      const manifest = managedManifest(group, instanceId);
      const ownership = await readManagedManifest(manifest.path, manifest.value).catch(
        (error: unknown) => {
          if (isNodeError(error, "ENOENT")) {
            return "absent" as const;
          }
          throw error;
        },
      );
      const current = await readCurrentIdentity(group, certificateAuthority.certificatePem, {
        now,
        minimumRemainingValidityMs,
      });
      if (current !== null) {
        if (ownership === "absent") {
          await writeManagedManifest(manifest.path, manifest.value, sourceCheckout);
        }
        identities.push({
          certificatePath: group.certificatePath,
          privateKeyPath: group.privateKeyPath,
          hostnames: group.hostnames,
          notAfter: current.notAfter,
        });
        continue;
      }
      const pathsExist = await identityPathsExist(group);
      if (pathsExist && ownership === "absent") {
        throw new MainDeviceEnrollmentLifecycleError(
          "TLS_PROVISION_FAILED",
          "OpenDelegate will not replace an unowned or invalid Main listener TLS identity.",
        );
      }
      if (ownership === "absent") {
        await writeManagedManifest(manifest.path, manifest.value, sourceCheckout);
      }
      const issued = await issueListenerIdentity(authority, group.hostnames);
      await writeManagedIdentity(
        group,
        issued.certificatePem,
        issued.privateKeyPem,
        sourceCheckout,
      );
      changed = true;
      identities.push({
        certificatePath: group.certificatePath,
        privateKeyPath: group.privateKeyPath,
        hostnames: group.hostnames,
        notAfter: issued.notAfter,
      });
    }
    return Object.freeze({
      status: changed ? "provisioned" : "current",
      certificateAuthorityPem: certificateAuthority.certificatePem,
      listenerIdentities: Object.freeze(identities.map((identity) => Object.freeze(identity))),
    });
  } catch (error) {
    if (error instanceof MainDeviceEnrollmentLifecycleError) {
      throw error;
    }
    throw new MainDeviceEnrollmentLifecycleError(
      "TLS_PROVISION_FAILED",
      "OpenDelegate could not provision the Main Device listener TLS identity.",
      { cause: error },
    );
  } finally {
    await repository.close();
  }
}

export interface IssuedDeviceEnrollmentGrantFile {
  readonly status: "issued";
  readonly grantId: string;
  readonly deviceId: string;
  readonly grantFile: string;
  readonly expiresAt: number;
}

export async function issueDeviceEnrollmentGrantFile(input: {
  readonly configuration: MainDeviceChannelConfiguration;
  readonly database: MainDeviceChannelDatabase;
  readonly identitySecrets: DeviceIdentitySecretStore;
  readonly instanceId: string;
  readonly mainDeviceId: string;
  readonly deviceId: string;
  readonly intent?: "enroll" | "recredential";
  readonly allowedBootstrapRoles: readonly string[];
  readonly expiresInMs: number;
  readonly outputPath: string;
  readonly sourceCheckout: string;
  readonly clock?: IdentityClock;
}): Promise<IssuedDeviceEnrollmentGrantFile> {
  const sourceCheckout = requireAbsolutePath(input.sourceCheckout, "source checkout");
  const outputPath = requireOutsideSourcePath(
    input.outputPath,
    sourceCheckout,
    "Enrollment Grant file",
  );
  const configuration = validateChannelConfiguration(input.configuration, sourceCheckout);
  const instanceId = requireIdentifier(input.instanceId, "Instance ID");
  const mainDeviceId = requireIdentifier(input.mainDeviceId, "Main Device ID");
  const deviceId = requireIdentifier(input.deviceId, "Device ID");
  const clock = input.clock ?? { now: () => Date.now() };
  await ensureSafeParent(outputPath, sourceCheckout, false);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    output = await open(
      outputPath,
      fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new MainDeviceEnrollmentLifecycleError(
        "GRANT_FILE_EXISTS",
        "The Enrollment Grant output file already exists; it was not overwritten.",
      );
    }
    throw new MainDeviceEnrollmentLifecycleError(
      "GRANT_ISSUANCE_FAILED",
      "The Enrollment Grant output file could not be reserved safely.",
      { cause: error },
    );
  }

  const repository = await openIdentityRepository(input.database, "apply").catch(async (error) => {
    await output?.close().catch(() => undefined);
    output = undefined;
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  });
  let serialized: Buffer | undefined;
  try {
    const authority = new DeviceIdentityAuthority({
      clock,
      repository,
      secrets: input.identitySecrets,
    });
    const certificateAuthority = await authority.bootstrapCertificateAuthority({ instanceId });
    const grant = await authority.createEnrollmentGrant({
      deviceId,
      allowedBootstrapRoles: input.allowedBootstrapRoles,
      expiresInMs: input.expiresInMs,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      protocolRange: { minimum: PROTOCOL_VERSION, maximum: PROTOCOL_VERSION },
    });
    const document: EnrollmentGrantFileDocument = {
      schemaVersion: 1,
      grantId: grant.grantId,
      token: grant.secret.reveal(),
      deviceId: grant.deviceId,
      mainDeviceId,
      expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
      certificateAuthorityPem: certificateAuthority.certificatePem,
      enrollmentUrl: configuration.enrollment.advertisedUrl,
      channelEndpoints: [
        {
          endpointId: "main-worker-channel",
          label: "Main Worker channel",
          kind: "wss",
          url: configuration.workerChannel.advertisedUrl,
        },
      ],
      protocolRange: grant.protocolRange,
      expiresAt: grant.expiresAt,
    };
    serialized = Buffer.from(`${JSON.stringify(document, undefined, 2)}\n`, "utf8");
    await output.writeFile(serialized);
    await output.sync();
    await output.close();
    output = undefined;
    await assertRestrictedRegularFile(outputPath);
    return Object.freeze({
      status: "issued" as const,
      grantId: grant.grantId,
      deviceId: grant.deviceId,
      grantFile: outputPath,
      expiresAt: grant.expiresAt,
    });
  } catch (error) {
    await output?.close().catch(() => undefined);
    output = undefined;
    await rm(outputPath, { force: true }).catch(() => undefined);
    if (error instanceof MainDeviceEnrollmentLifecycleError) {
      throw error;
    }
    throw new MainDeviceEnrollmentLifecycleError(
      "GRANT_ISSUANCE_FAILED",
      "OpenDelegate could not issue the single-use Device Enrollment Grant.",
      { cause: error },
    );
  } finally {
    serialized?.fill(0);
    await repository.close();
  }
}

async function openIdentityRepository(
  database: MainDeviceChannelDatabase,
  migrationMode: "apply" | "verify",
): Promise<SqlDeviceIdentityRepository> {
  return database.adapter === "sqlite"
    ? SqlDeviceIdentityRepository.openSqlite({
        filename: database.filename,
        migrationMode,
      })
    : SqlDeviceIdentityRepository.openPostgres({
        connectionString: database.connectionString,
        migrationMode,
        ...(database.schema === undefined ? {} : { schema: database.schema }),
      });
}

interface ListenerIdentityGroup {
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly hostnames: readonly string[];
}

function listenerIdentityGroups(
  input: MainDeviceChannelConfiguration,
  sourceCheckout: string,
): readonly ListenerIdentityGroup[] {
  const configuration = validateChannelConfiguration(input, sourceCheckout);
  const listeners = [configuration.enrollment, configuration.workerChannel];
  const byPaths = new Map<
    string,
    { certificatePath: string; privateKeyPath: string; hostnames: Set<string> }
  >();
  for (const listener of listeners) {
    const key = `${listener.tlsCertificatePath}\0${listener.tlsPrivateKeyPath}`;
    const hostname = advertisedHostname(listener.advertisedUrl);
    const existing = byPaths.get(key);
    if (existing === undefined) {
      byPaths.set(key, {
        certificatePath: listener.tlsCertificatePath,
        privateKeyPath: listener.tlsPrivateKeyPath,
        hostnames: new Set([hostname]),
      });
    } else {
      existing.hostnames.add(hostname);
    }
  }
  return Object.freeze(
    [...byPaths.values()].map((group) =>
      Object.freeze({
        certificatePath: group.certificatePath,
        privateKeyPath: group.privateKeyPath,
        hostnames: Object.freeze([...group.hostnames].sort()),
      }),
    ),
  );
}

function assertNoManagedTlsPathCollisions(groups: readonly ListenerIdentityGroup[]): void {
  const claimedPaths = new Set<string>();
  for (const group of groups) {
    for (const path of [
      group.certificatePath,
      group.privateKeyPath,
      `${group.certificatePath}.opendelegate-managed.json`,
    ]) {
      if (claimedPaths.has(path)) {
        throw invalidConfiguration();
      }
      claimedPaths.add(path);
    }
  }
}

function validateChannelConfiguration(
  input: MainDeviceChannelConfiguration,
  sourceCheckout: string,
): MainDeviceChannelConfiguration {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidConfiguration();
  }
  const enrollment = validateListener(
    input.enrollment,
    sourceCheckout,
    "https:",
    "/api/v1/device/enroll",
  );
  const workerPath = input.workerChannel.path ?? "/api/v1/device/channel";
  if (workerPath !== "/api/v1/device/channel") {
    throw invalidConfiguration();
  }
  const workerChannel = {
    ...validateListener(input.workerChannel, sourceCheckout, "wss:", workerPath),
    path: workerPath,
  };
  if (enrollment.host === workerChannel.host && enrollment.port === workerChannel.port) {
    throw invalidConfiguration();
  }
  if (
    enrollment.tlsCertificatePath === workerChannel.tlsCertificatePath &&
    enrollment.tlsPrivateKeyPath !== workerChannel.tlsPrivateKeyPath
  ) {
    throw invalidConfiguration();
  }
  if (
    enrollment.tlsPrivateKeyPath === workerChannel.tlsPrivateKeyPath &&
    enrollment.tlsCertificatePath !== workerChannel.tlsCertificatePath
  ) {
    throw invalidConfiguration();
  }
  return Object.freeze({ enrollment, workerChannel: Object.freeze(workerChannel) });
}

function validateListener(
  input: MainDeviceListenerConfiguration,
  sourceCheckout: string,
  protocol: "https:" | "wss:",
  path: string,
): MainDeviceListenerConfiguration {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.host !== "string" ||
    input.host.length < 1 ||
    input.host.length > 253 ||
    input.host !== input.host.trim() ||
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535
  ) {
    throw invalidConfiguration();
  }
  let advertised: URL;
  try {
    advertised = new URL(input.advertisedUrl);
  } catch {
    throw invalidConfiguration();
  }
  if (
    advertised.protocol !== protocol ||
    advertised.username !== "" ||
    advertised.password !== "" ||
    advertised.search !== "" ||
    advertised.hash !== "" ||
    advertised.pathname !== path ||
    Number(advertised.port || "443") !== input.port
  ) {
    throw invalidConfiguration();
  }
  const tlsCertificatePath = requireOutsideSourcePath(
    input.tlsCertificatePath,
    sourceCheckout,
    "TLS certificate",
  );
  const tlsPrivateKeyPath = requireOutsideSourcePath(
    input.tlsPrivateKeyPath,
    sourceCheckout,
    "TLS private key",
  );
  if (tlsCertificatePath === tlsPrivateKeyPath) {
    throw invalidConfiguration();
  }
  return Object.freeze({
    advertisedUrl: advertised.toString(),
    host: input.host,
    port: input.port,
    tlsCertificatePath,
    tlsPrivateKeyPath,
  });
}

async function readCurrentIdentity(
  group: ListenerIdentityGroup,
  certificateAuthorityPem: string,
  input: {
    readonly now: number;
    readonly minimumRemainingValidityMs: number;
  },
): Promise<{ readonly notAfter: number } | null> {
  let certificateBytes: Buffer | undefined;
  let privateKeyBytes: Buffer | undefined;
  try {
    [certificateBytes, privateKeyBytes] = await Promise.all([
      readRestrictedFile(group.certificatePath),
      readRestrictedFile(group.privateKeyPath),
    ]);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    return null;
  }
  try {
    const certificate = new X509Certificate(certificateBytes);
    const certificateAuthority = new X509Certificate(certificateAuthorityPem);
    const certificatePublicKey = certificate.publicKey.export({ format: "der", type: "spki" });
    const privatePublicKey = createPublicKey(createPrivateKey(privateKeyBytes)).export({
      format: "der",
      type: "spki",
    });
    const notAfter = Date.parse(certificate.validTo);
    if (
      certificatePublicKey.byteLength !== privatePublicKey.byteLength ||
      !timingSafeEqual(certificatePublicKey, privatePublicKey) ||
      !certificate.checkIssued(certificateAuthority) ||
      !certificate.verify(certificateAuthority.publicKey) ||
      !Number.isSafeInteger(notAfter) ||
      notAfter - input.now < input.minimumRemainingValidityMs ||
      group.hostnames.some((hostname) =>
        isIP(hostname) === 0
          ? certificate.checkHost(hostname) === undefined
          : certificate.checkIP(hostname) === undefined,
      )
    ) {
      return null;
    }
    return { notAfter };
  } catch {
    return null;
  } finally {
    privateKeyBytes.fill(0);
  }
}

async function issueListenerIdentity(
  authority: DeviceIdentityAuthority,
  hostnames: readonly string[],
): Promise<{
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly notAfter: number;
}> {
  const keys = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const issued = await authority.issueMainServerCertificate({
    publicKey: keys.publicKey,
    hostnames,
  });
  const pkcs8 = Buffer.from(await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey));
  try {
    return {
      certificatePem: issued.certificatePem,
      privateKeyPem: encodePem("PRIVATE KEY", pkcs8),
      notAfter: issued.notAfter,
    };
  } finally {
    pkcs8.fill(0);
  }
}

async function writeManagedIdentity(
  group: ListenerIdentityGroup,
  certificatePem: string,
  privateKeyPem: string,
  sourceCheckout: string,
): Promise<void> {
  await Promise.all([
    ensurePrivateParent(group.certificatePath, sourceCheckout),
    ensurePrivateParent(group.privateKeyPath, sourceCheckout),
  ]);
  const suffix = randomBytes(12).toString("hex");
  const certificateTemporary = `${group.certificatePath}.tmp-${suffix}`;
  const privateKeyTemporary = `${group.privateKeyPath}.tmp-${suffix}`;
  const certificate = Buffer.from(certificatePem, "utf8");
  const privateKey = Buffer.from(privateKeyPem, "utf8");
  let certificateHandle: Awaited<ReturnType<typeof open>> | undefined;
  let privateKeyHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    certificateHandle = await open(certificateTemporary, "wx", 0o600);
    privateKeyHandle = await open(privateKeyTemporary, "wx", 0o600);
    await Promise.all([
      certificateHandle.writeFile(certificate).then(() => certificateHandle?.sync()),
      privateKeyHandle.writeFile(privateKey).then(() => privateKeyHandle?.sync()),
    ]);
    await Promise.all([certificateHandle.close(), privateKeyHandle.close()]);
    certificateHandle = undefined;
    privateKeyHandle = undefined;
    await Promise.all([
      assertRestrictedRegularFile(certificateTemporary),
      assertRestrictedRegularFile(privateKeyTemporary),
    ]);
    await rename(privateKeyTemporary, group.privateKeyPath);
    await rename(certificateTemporary, group.certificatePath);
    await Promise.all([
      assertRestrictedRegularFile(group.certificatePath),
      assertRestrictedRegularFile(group.privateKeyPath),
    ]);
  } finally {
    certificate.fill(0);
    privateKey.fill(0);
    await certificateHandle?.close().catch(() => undefined);
    await privateKeyHandle?.close().catch(() => undefined);
    await Promise.all([
      rm(certificateTemporary, { force: true }).catch(() => undefined),
      rm(privateKeyTemporary, { force: true }).catch(() => undefined),
    ]);
  }
}

function managedManifest(
  group: ListenerIdentityGroup,
  instanceId: string,
): {
  readonly path: string;
  readonly value: Readonly<Record<string, unknown>>;
} {
  return {
    path: `${group.certificatePath}.opendelegate-managed.json`,
    value: Object.freeze({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      instanceId,
      certificatePath: group.certificatePath,
      privateKeyPath: group.privateKeyPath,
    }),
  };
}

async function readManagedManifest(
  path: string,
  expected: Readonly<Record<string, unknown>>,
): Promise<"owned"> {
  const bytes = await readRestrictedFile(path, MAXIMUM_MANIFEST_BYTES);
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw invalidTlsOwnership();
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== Object.keys(expected).sort().join(",") ||
      JSON.stringify(parsed) !== JSON.stringify(expected)
    ) {
      throw invalidTlsOwnership();
    }
    return "owned";
  } finally {
    bytes.fill(0);
  }
}

async function writeManagedManifest(
  path: string,
  value: Readonly<Record<string, unknown>>,
  sourceCheckout: string,
): Promise<void> {
  await ensurePrivateParent(path, sourceCheckout);
  const bytes = Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertRestrictedRegularFile(path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isNodeError(error, "EEXIST")) {
      await readManagedManifest(path, value);
      return;
    }
    throw error;
  } finally {
    bytes.fill(0);
  }
}

async function identityPathsExist(group: ListenerIdentityGroup): Promise<boolean> {
  const states = await Promise.all(
    [group.certificatePath, group.privateKeyPath].map(async (path) => {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if (isNodeError(error, "ENOENT")) {
          return false;
        }
        throw error;
      }
    }),
  );
  return states.some(Boolean);
}

async function readRestrictedFile(
  path: string,
  maximumBytes = MAXIMUM_TLS_FILE_BYTES,
): Promise<Buffer> {
  await assertRestrictedRegularFile(path);
  return readStableRegularFile(path, maximumBytes);
}

async function ensurePrivateParent(path: string, sourceCheckout: string): Promise<void> {
  await ensureSafeParent(path, sourceCheckout, true);
}

async function ensureSafeParent(
  path: string,
  sourceCheckout: string,
  requirePrivatePermissions: boolean,
): Promise<void> {
  const parent = dirname(path);
  await assertNoPathLinks(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoPathLinks(parent);
  const metadata = await lstat(parent);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (requirePrivatePermissions && process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw invalidConfiguration();
  }
  const canonical = await realpath(parent);
  if (!pathsEqual(canonical, parent)) {
    throw invalidConfiguration();
  }
  requireOutsideSourcePath(canonical, sourceCheckout, "managed TLS parent");
}

async function assertNoPathLinks(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw invalidConfiguration();
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
    throw invalidTlsOwnership();
  }
}

function encodePem(label: string, value: Uint8Array): string {
  const body =
    Buffer.from(value)
      .toString("base64")
      .match(/.{1,64}/gu)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function requireTlsRenewalWindow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 89 * 24 * 60 * 60 * 1_000) {
    throw invalidConfiguration();
  }
  return value;
}

function readClock(clock: IdentityClock): number {
  let now: number;
  try {
    now = clock.now();
  } catch {
    throw invalidConfiguration();
  }
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) {
    throw invalidConfiguration();
  }
  return now;
}

function requireOutsideSourcePath(value: unknown, sourceCheckout: string, label: string): string {
  const path = requireAbsolutePath(value, label);
  const relationship = relative(resolve(sourceCheckout), path);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw invalidConfiguration();
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
    throw new MainDeviceEnrollmentLifecycleError(
      "CONFIG_INVALID",
      `${label} must be an absolute path.`,
    );
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
    throw new MainDeviceEnrollmentLifecycleError("CONFIG_INVALID", `The ${label} is invalid.`);
  }
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function advertisedHostname(value: string): string {
  const hostname = new URL(value).hostname;
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function invalidConfiguration(): MainDeviceEnrollmentLifecycleError {
  return new MainDeviceEnrollmentLifecycleError(
    "CONFIG_INVALID",
    "The Main Device listener or Enrollment Grant configuration is invalid.",
  );
}

function invalidTlsOwnership(): MainDeviceEnrollmentLifecycleError {
  return new MainDeviceEnrollmentLifecycleError(
    "TLS_PROVISION_FAILED",
    "The managed Main listener TLS files or ownership marker are unsafe.",
  );
}
