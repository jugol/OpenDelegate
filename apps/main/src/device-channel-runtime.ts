import { X509Certificate, createPrivateKey, createPublicKey, timingSafeEqual } from "node:crypto";
import type { RequestListener } from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";

import {
  MainDeviceChannelServer,
  createEnrollmentRequestHandler,
  type CreateMainDeviceChannelServerOptions,
  type MainDeviceChannelCallbacks,
} from "@opendelegate/device-channel";
import {
  DeviceIdentityAuthority,
  type DeviceIdentityAuditRecord,
  type DeviceIdentitySecretStore,
  type IdentityClock,
  type PersistedDeviceIdentity,
  type PersistedEnrollmentGrant,
} from "@opendelegate/device-identity";
import { SqlDeviceChannelRepository, SqlDeviceIdentityRepository } from "@opendelegate/storage-sql";

import { readStableRegularFile } from "./stable-file.ts";

const ENROLLMENT_PATH = "/api/v1/device/enroll";
const DEFAULT_CHANNEL_PATH = "/api/v1/device/channel";
const MAXIMUM_TLS_FILE_BYTES = 256 * 1024;

export type MainDeviceChannelDatabase =
  | {
      readonly adapter: "sqlite";
      readonly filename: string;
    }
  | {
      readonly adapter: "postgresql";
      readonly connectionString: string;
      readonly schema?: string;
    };

export interface MainDeviceListenerConfiguration {
  readonly advertisedUrl: string;
  readonly host: string;
  readonly port: number;
  readonly tlsCertificatePath: string;
  readonly tlsPrivateKeyPath: string;
}

export interface MainWorkerChannelListenerConfiguration extends MainDeviceListenerConfiguration {
  readonly path?: string;
}

export interface MainDeviceChannelConfiguration {
  readonly enrollment: MainDeviceListenerConfiguration;
  readonly workerChannel: MainWorkerChannelListenerConfiguration;
}

export interface MainEnrollmentListenerAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface MainEnrollmentListener {
  address(): MainEnrollmentListenerAddress;
  close(): Promise<void>;
}

export interface MainWorkerChannelListener extends Pick<
  MainDeviceChannelServer,
  "control" | "dispatch" | "steerRun"
> {
  address(): {
    readonly host: string;
    readonly port: number;
    readonly url: string;
  };
  close(): Promise<void>;
}

export interface MainDeviceChannelListenerFactory {
  listenEnrollment(input: {
    readonly certificate: Buffer;
    readonly host: string;
    readonly port: number;
    readonly privateKey: Buffer;
    readonly requestListener: RequestListener;
  }): Promise<MainEnrollmentListener>;
  listenWorkerChannel(
    input: CreateMainDeviceChannelServerOptions,
  ): Promise<MainWorkerChannelListener>;
}

export interface CreateProductionMainDeviceChannelRuntimeOptions extends MainDeviceChannelCallbacks {
  readonly clock: IdentityClock;
  readonly configuration: MainDeviceChannelConfiguration;
  readonly database: MainDeviceChannelDatabase;
  readonly identitySecrets: DeviceIdentitySecretStore;
  readonly instanceId: string;
  readonly listenerFactory?: MainDeviceChannelListenerFactory;
  readonly mainDeviceId: string;
  readonly sourceCheckout: string;
}

export interface ProductionMainDeviceChannelRuntime {
  readonly authority: DeviceIdentityAuthority;
  readonly certificateAuthorityPem: string;
  readonly certificateAuthoritySpkiSha256: string;
  readonly enrollmentAddress: MainEnrollmentListenerAddress;
  readonly workerChannel: MainWorkerChannelListener;
  listEnrollmentGrants(): Promise<readonly PersistedEnrollmentGrant[]>;
  listIdentityAuditRecords(): Promise<readonly DeviceIdentityAuditRecord[]>;
  listDeviceIdentities(): Promise<readonly PersistedDeviceIdentity[]>;
  close(): Promise<void>;
}

export type MainDeviceChannelRuntimeErrorCode =
  | "DEVICE_CHANNEL_CONFIGURATION_INVALID"
  | "DEVICE_CHANNEL_LISTENER_UNAVAILABLE"
  | "DEVICE_CHANNEL_TLS_INVALID";

export class MainDeviceChannelRuntimeError extends Error {
  public readonly code: MainDeviceChannelRuntimeErrorCode;

  public constructor(
    code: MainDeviceChannelRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MainDeviceChannelRuntimeError";
    this.code = code;
  }
}

export async function openMainDeviceChannelRepository(
  database: MainDeviceChannelDatabase,
): Promise<SqlDeviceChannelRepository> {
  return database.adapter === "sqlite"
    ? SqlDeviceChannelRepository.openSqlite({
        filename: database.filename,
        migrationMode: "verify",
      })
    : SqlDeviceChannelRepository.openPostgres({
        connectionString: database.connectionString,
        migrationMode: "verify",
        ...(database.schema === undefined ? {} : { schema: database.schema }),
      });
}

export async function createProductionMainDeviceChannelRuntime(
  options: CreateProductionMainDeviceChannelRuntimeOptions,
): Promise<ProductionMainDeviceChannelRuntime> {
  const configuration = validateConfiguration(options.configuration, options.sourceCheckout);
  validateIdentifier(options.instanceId, "Instance ID");
  validateIdentifier(options.mainDeviceId, "Main Device ID");
  const factory = options.listenerFactory ?? NODE_LISTENER_FACTORY;
  const channelRepository = await openMainDeviceChannelRepository(options.database);
  let identityRepository: SqlDeviceIdentityRepository | undefined;
  let enrollmentListener: MainEnrollmentListener | undefined;
  let workerChannel: MainWorkerChannelListener | undefined;
  try {
    identityRepository = await openMainDeviceIdentityRepository(options.database);
    const activeIdentityRepository = identityRepository;
    const authority = new DeviceIdentityAuthority({
      clock: options.clock,
      repository: activeIdentityRepository,
      secrets: options.identitySecrets,
    });
    const certificateAuthority = await authority.bootstrapCertificateAuthority({
      instanceId: options.instanceId,
    });
    const enrollmentTls = await readAndValidateListenerTls(
      configuration.enrollment,
      certificateAuthority.certificatePem,
    );
    const workerTls = await readAndValidateListenerTls(
      configuration.workerChannel,
      certificateAuthority.certificatePem,
    );
    try {
      enrollmentListener = await factory.listenEnrollment({
        certificate: enrollmentTls.certificate,
        host: configuration.enrollment.host,
        port: configuration.enrollment.port,
        privateKey: enrollmentTls.privateKey,
        requestListener: createEnrollmentRequestHandler({ authority }),
      });
      workerChannel = await factory.listenWorkerChannel({
        mainDeviceId: options.mainDeviceId,
        authority,
        repository: channelRepository,
        tls: {
          certificateAuthorityPem: certificateAuthority.certificatePem,
          certificate: workerTls.certificate,
          privateKey: workerTls.privateKey,
        },
        host: configuration.workerChannel.host,
        port: configuration.workerChannel.port,
        ...(configuration.workerChannel.path === undefined
          ? {}
          : { path: configuration.workerChannel.path }),
        ...(options.onEvents === undefined ? {} : { onEvents: options.onEvents }),
        ...(options.onHeartbeat === undefined ? {} : { onHeartbeat: options.onHeartbeat }),
        ...(options.onArtifactPrepare === undefined
          ? {}
          : { onArtifactPrepare: options.onArtifactPrepare }),
        ...(options.onActionAuthorize === undefined
          ? {}
          : { onActionAuthorize: options.onActionAuthorize }),
        ...(options.onActionConsume === undefined
          ? {}
          : { onActionConsume: options.onActionConsume }),
        ...(options.onRunLeaseRenew === undefined
          ? {}
          : { onRunLeaseRenew: options.onRunLeaseRenew }),
        ...(options.onRunSteeringReceipt === undefined
          ? {}
          : { onRunSteeringReceipt: options.onRunSteeringReceipt }),
        ...(options.onRouteIncident === undefined
          ? {}
          : { onRouteIncident: options.onRouteIncident }),
      });
    } finally {
      enrollmentTls.privateKey.fill(0);
      workerTls.privateKey.fill(0);
    }
    assertListenerAddress(enrollmentListener.address(), configuration.enrollment, "enrollment");
    assertListenerAddress(workerChannel.address(), configuration.workerChannel, "Worker channel");
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      authority,
      certificateAuthorityPem: certificateAuthority.certificatePem,
      certificateAuthoritySpkiSha256: certificateAuthority.spkiSha256,
      enrollmentAddress: enrollmentListener.address(),
      workerChannel,
      listEnrollmentGrants: async () =>
        Object.freeze(
          (await activeIdentityRepository.snapshot()).enrollmentGrants.map((grant) =>
            Object.freeze(structuredClone(grant)),
          ),
        ),
      listIdentityAuditRecords: async () =>
        Object.freeze(
          (await activeIdentityRepository.snapshot()).auditRecords.map((record) =>
            Object.freeze(structuredClone(record)),
          ),
        ),
      listDeviceIdentities: async () =>
        Object.freeze(
          (await activeIdentityRepository.snapshot()).devices.map((device) =>
            Object.freeze(structuredClone(device)),
          ),
        ),
      close: () => {
        closePromise ??= closeAll([
          ["Worker channel listener", () => workerChannel?.close()],
          ["Enrollment listener", () => enrollmentListener?.close()],
          ["Device channel repository", () => channelRepository.close()],
          ["Device identity repository", () => identityRepository?.close()],
        ]);
        return closePromise;
      },
    });
  } catch (error) {
    try {
      await closeAll([
        ["Worker channel listener", () => workerChannel?.close()],
        ["Enrollment listener", () => enrollmentListener?.close()],
        ["Device channel repository", () => channelRepository.close()],
        ["Device identity repository", () => identityRepository?.close()],
      ]);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Device channel startup and rollback both failed.",
        { cause: closeError },
      );
    }
    if (error instanceof MainDeviceChannelRuntimeError) {
      throw error;
    }
    throw new MainDeviceChannelRuntimeError(
      "DEVICE_CHANNEL_LISTENER_UNAVAILABLE",
      "The Main Device channel runtime could not start.",
      { cause: error },
    );
  }
}

async function openMainDeviceIdentityRepository(
  database: MainDeviceChannelDatabase,
): Promise<SqlDeviceIdentityRepository> {
  return database.adapter === "sqlite"
    ? SqlDeviceIdentityRepository.openSqlite({
        filename: database.filename,
        migrationMode: "verify",
      })
    : SqlDeviceIdentityRepository.openPostgres({
        connectionString: database.connectionString,
        migrationMode: "verify",
        ...(database.schema === undefined ? {} : { schema: database.schema }),
      });
}

const NODE_LISTENER_FACTORY: MainDeviceChannelListenerFactory = Object.freeze({
  listenEnrollment: async (
    input: Parameters<MainDeviceChannelListenerFactory["listenEnrollment"]>[0],
  ) => {
    const server = createServer(
      {
        cert: input.certificate,
        key: input.privateKey,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        requestCert: false,
      },
      input.requestListener,
    );
    await listenHttps(server, input.port, input.host);
    return nodeEnrollmentListener(server, input.host);
  },
  listenWorkerChannel: (
    input: Parameters<MainDeviceChannelListenerFactory["listenWorkerChannel"]>[0],
  ) => MainDeviceChannelServer.listen(input),
});

async function readAndValidateListenerTls(
  configuration: MainDeviceListenerConfiguration,
  certificateAuthorityPem: string,
): Promise<{ readonly certificate: Buffer; readonly privateKey: Buffer }> {
  let certificate: Buffer | undefined;
  let privateKey: Buffer | undefined;
  try {
    [certificate, privateKey] = await Promise.all([
      readStableRegularFile(configuration.tlsCertificatePath, MAXIMUM_TLS_FILE_BYTES),
      readStableRegularFile(configuration.tlsPrivateKeyPath, MAXIMUM_TLS_FILE_BYTES),
    ]);
    validateTlsIdentity(
      certificate,
      privateKey,
      certificateAuthorityPem,
      new URL(configuration.advertisedUrl).hostname,
    );
    return { certificate, privateKey };
  } catch (error) {
    privateKey?.fill(0);
    throw new MainDeviceChannelRuntimeError(
      "DEVICE_CHANNEL_TLS_INVALID",
      "A Device listener TLS identity is invalid or unavailable.",
      { cause: error },
    );
  }
}

function validateTlsIdentity(
  certificatePem: Buffer,
  privateKeyPem: Buffer,
  certificateAuthorityPem: string,
  advertisedHostname: string,
): void {
  const certificate = new X509Certificate(certificatePem);
  const certificateAuthority = new X509Certificate(certificateAuthorityPem);
  const privateKey = createPrivateKey(privateKeyPem);
  const certificatePublicKey = certificate.publicKey.export({
    format: "der",
    type: "spki",
  });
  const privatePublicKey = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  if (
    certificatePublicKey.byteLength !== privatePublicKey.byteLength ||
    !timingSafeEqual(certificatePublicKey, privatePublicKey) ||
    !certificate.checkIssued(certificateAuthority) ||
    !certificate.verify(certificateAuthority.publicKey)
  ) {
    throw new Error("TLS identity does not match its key or Device identity authority.");
  }
  const hostnameMatches = isIpLiteral(advertisedHostname)
    ? certificate.checkIP(advertisedHostname) !== undefined
    : certificate.checkHost(advertisedHostname) !== undefined;
  if (!hostnameMatches) {
    throw new Error("TLS identity does not cover the advertised listener hostname.");
  }
}

function validateConfiguration(
  input: MainDeviceChannelConfiguration,
  sourceCheckout: string,
): Required<MainDeviceChannelConfiguration> {
  const enrollment = validateListener(input.enrollment, sourceCheckout, "https:", ENROLLMENT_PATH);
  const workerPath = validateChannelPath(input.workerChannel.path ?? DEFAULT_CHANNEL_PATH);
  const workerChannel = {
    ...validateListener(input.workerChannel, sourceCheckout, "wss:", workerPath),
    path: workerPath,
  };
  if (enrollment.host === workerChannel.host && enrollment.port === workerChannel.port) {
    throw configurationError(
      "Enrollment HTTPS and mutual-TLS Worker WSS require separate listener addresses.",
    );
  }
  if (enrollment.advertisedUrl === workerChannel.advertisedUrl) {
    throw configurationError(
      "Enrollment HTTPS and mutual-TLS Worker WSS require distinct advertised URLs.",
    );
  }
  return Object.freeze({ enrollment, workerChannel });
}

function validateListener(
  input: MainDeviceListenerConfiguration,
  sourceCheckout: string,
  protocol: "https:" | "wss:",
  requiredPath: string,
): MainDeviceListenerConfiguration {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.host !== "string" ||
    input.host.length === 0 ||
    input.host.length > 253 ||
    input.host !== input.host.trim() ||
    containsControlCharacter(input.host) ||
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535
  ) {
    throw configurationError("A Device listener address is invalid.");
  }
  let advertised: URL;
  try {
    advertised = new URL(input.advertisedUrl);
  } catch {
    throw configurationError("A Device listener advertised URL is invalid.");
  }
  if (
    advertised.protocol !== protocol ||
    advertised.username !== "" ||
    advertised.password !== "" ||
    advertised.search !== "" ||
    advertised.hash !== "" ||
    advertised.pathname !== requiredPath ||
    Number(advertised.port || defaultTlsPort(advertised.protocol)) !== input.port
  ) {
    throw configurationError(
      `The Device listener advertised URL must be ${protocol}//host:${String(input.port)}${requiredPath}.`,
    );
  }
  return Object.freeze({
    advertisedUrl: advertised.toString(),
    host: input.host,
    port: input.port,
    tlsCertificatePath: validateRuntimePath(
      input.tlsCertificatePath,
      sourceCheckout,
      "TLS certificate path",
    ),
    tlsPrivateKeyPath: validateRuntimePath(
      input.tlsPrivateKeyPath,
      sourceCheckout,
      "TLS private-key path",
    ),
  });
}

function validateRuntimePath(value: string, sourceCheckout: string, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw configurationError(`${label} must be absolute.`);
  }
  const resolved = resolve(value);
  const relationship = relative(resolve(sourceCheckout), resolved);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw configurationError(`${label} must remain outside the source checkout.`);
  }
  return resolved;
}

function validateChannelPath(value: string): string {
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1023}$/u.test(value)) {
    throw configurationError("The Worker channel path is invalid.");
  }
  return value;
}

function validateIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    containsControlCharacter(value)
  ) {
    throw configurationError(`${label} is invalid.`);
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function assertListenerAddress(
  address: { readonly host: string; readonly port: number },
  configuration: MainDeviceListenerConfiguration,
  label: string,
): void {
  if (address.port !== configuration.port) {
    throw new MainDeviceChannelRuntimeError(
      "DEVICE_CHANNEL_LISTENER_UNAVAILABLE",
      `${label} bound an unexpected port.`,
    );
  }
}

function nodeEnrollmentListener(
  server: HttpsServer,
  configuredHost: string,
): MainEnrollmentListener {
  return {
    address: () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new MainDeviceChannelRuntimeError(
          "DEVICE_CHANNEL_LISTENER_UNAVAILABLE",
          "The Enrollment listener is not active.",
        );
      }
      const host = normalizeAddressHost(address, configuredHost);
      return Object.freeze({
        host,
        port: address.port,
        url: `https://${formatUrlHost(host)}:${String(address.port)}${ENROLLMENT_PATH}`,
      });
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => {
        const timeout = setTimeout(() => {
          server.closeAllConnections();
          resolveClose();
        }, 2_000);
        server.close(() => {
          clearTimeout(timeout);
          resolveClose();
        });
      });
    },
  };
}

async function listenHttps(server: HttpsServer, port: number, host: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectListen(error);
    };
    const onListening = (): void => {
      cleanup();
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeAll(
  resources: readonly [label: string, close: () => Promise<void> | undefined][],
): Promise<void> {
  const failures: Error[] = [];
  for (const [label, close] of resources) {
    try {
      await close();
    } catch (error) {
      failures.push(
        new Error(`${label} could not close.`, {
          cause: error,
        }),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more Device channel resources could not close.");
  }
}

function normalizeAddressHost(address: AddressInfo, configuredHost: string): string {
  if (configuredHost === "0.0.0.0" || configuredHost === "::") {
    return address.family === "IPv6" ? "::1" : "127.0.0.1";
  }
  return configuredHost;
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function isIpLiteral(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value) || value.includes(":");
}

function defaultTlsPort(protocol: string): string {
  return protocol === "https:" || protocol === "wss:" ? "443" : "";
}

function configurationError(message: string): MainDeviceChannelRuntimeError {
  return new MainDeviceChannelRuntimeError("DEVICE_CHANNEL_CONFIGURATION_INVALID", message);
}
