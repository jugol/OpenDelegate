import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { platform } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createArtifactGatewayApp,
  type ArtifactAuthorizationPort,
  type ArtifactGatewayApp,
  type ArtifactGatewayPlane,
} from "@opendelegate/artifact-gateway";
import {
  LocalArtifactAccessBroker,
  LocalArtifactStore,
  type ArtifactIndexRepository,
  type IssueArtifactUploadGrant,
  type IssueBrowserArtifactGrant,
} from "@opendelegate/artifact-store";
import {
  SystemdCredentialKeyProvider,
  createPlatformManagedSecretStore,
  type ManagedSecretStore,
  type PlatformManagedSecretStoreConfig,
} from "@opendelegate/secrets";
import { parseArtifactUploadGrant, type ArtifactUploadGrantV1 } from "@opendelegate/protocol";

import { closeAfterPrimaryFailure, closeMainResources } from "./shutdown.ts";
import { readStableRegularFile } from "./stable-file.ts";

const ARTIFACT_CONFIGURATION_SCHEMA_VERSION = 1;
const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const SIGNING_KEY_BYTES = 32;
const MAXIMUM_SECRET_BYTES = 4_096;
const DEFAULT_STATIC_PORT_OFFSET = 2;
const DEFAULT_INTERACTIVE_PORT_OFFSET = 3;
const EXPOSURE_MODES = new Set([
  "private-network",
  "authenticated",
  "signed-link",
  "public",
  "custom",
]);

export interface ArtifactListenerConfiguration {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly reverseProxy?: {
    readonly trustedProxyNetworks: readonly string[];
  };
}

export type MainArtifactSecretBackendConfiguration =
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
      readonly vaultRoot: string;
    };

export interface MainArtifactConfiguration {
  readonly schemaVersion: typeof ARTIFACT_CONFIGURATION_SCHEMA_VERSION;
  readonly enabled: true;
  readonly listeners: {
    readonly static: ArtifactListenerConfiguration;
    readonly interactive: ArtifactListenerConfiguration;
  };
  readonly storage: {
    readonly maximumArtifactBytes: number;
  };
  readonly exposure: {
    readonly defaultMode: "private-network" | "authenticated" | "signed-link" | "public" | "custom";
    readonly privateNetworks: readonly string[];
    readonly authenticatedBearerAlias: string;
    readonly authenticatedSessionAlias: string;
    readonly customPolicyAliases: Readonly<Record<string, string>>;
  };
  readonly signingKeyAlias: string;
  readonly secretBackend: MainArtifactSecretBackendConfiguration;
}

export interface ArtifactListenerHandle {
  readonly address: ArtifactListenerConfiguration;
  close(): Promise<void>;
}

export interface ArtifactListenerFactory {
  listen(input: {
    readonly plane: ArtifactGatewayPlane;
    readonly configuration: ArtifactListenerConfiguration;
    readonly app: ArtifactGatewayApp;
  }): Promise<ArtifactListenerHandle>;
}

export interface MainArtifactRuntimeHealth {
  readonly status: "ready" | "unavailable";
  readonly code:
    "ARTIFACT_RUNTIME_READY" | "ARTIFACT_RUNTIME_CLOSED" | "ARTIFACT_SECRET_UNAVAILABLE";
  readonly listeners: {
    readonly static: ArtifactListenerConfiguration;
    readonly interactive: ArtifactListenerConfiguration;
  };
}

export interface MainArtifactRuntime {
  readonly configuration: MainArtifactConfiguration;
  readonly store: LocalArtifactStore;
  readonly access: LocalArtifactAccessBroker;
  readonly staticApp: ArtifactGatewayApp;
  readonly interactiveApp: ArtifactGatewayApp;
  readonly listeners: {
    readonly static: ArtifactListenerHandle;
    readonly interactive: ArtifactListenerHandle;
  };
  issueWorkerUploadGrant(input: IssueArtifactUploadGrant): Promise<ArtifactUploadGrantV1>;
  issueBrowserAccessGrant(input: IssueBrowserArtifactGrant): Promise<{
    readonly method: "POST";
    readonly actionUrl: string;
    readonly fieldName: "grant";
    readonly fieldValue: string;
    readonly artifactId: string;
    readonly expiresAtMs: number;
  }>;
  health(): Promise<MainArtifactRuntimeHealth>;
  close(): Promise<void>;
}

export type MainArtifactRuntimeErrorCode =
  "CONFIG_INVALID" | "EXTERNAL_INGRESS_UNVERIFIED" | "RUNTIME_PATH_UNSAFE" | "SECRET_UNAVAILABLE";

export interface ArtifactExternalIngressVerification {
  readonly status: "verified" | "unavailable";
  readonly checkedAtMs: number;
  readonly code?: string;
}

export interface ArtifactExternalIngressVerifier {
  verify(input: {
    readonly plane: ArtifactGatewayPlane;
    readonly externalOrigin: string;
    readonly upstreamHost: string;
    readonly upstreamPort: number;
    readonly expectedService: string;
  }): Promise<ArtifactExternalIngressVerification>;
}

export class MainArtifactRuntimeError extends Error {
  public readonly code: MainArtifactRuntimeErrorCode;

  public constructor(code: MainArtifactRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MainArtifactRuntimeError";
    this.code = code;
  }
}

export async function loadMainArtifactConfigurationSource(
  path: string,
): Promise<MainArtifactConfiguration> {
  if (!isAbsolute(path)) {
    throw configurationInvalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      (await readStableRegularFile(path, MAXIMUM_CONFIGURATION_BYTES)).toString("utf8"),
    );
  } catch (error) {
    throw configurationInvalid(error);
  }
  return validateMainArtifactConfiguration(parsed);
}

export async function defaultMainArtifactConfiguration(input: {
  readonly home: string;
  readonly installationRoot: string;
  readonly mainListener: ArtifactListenerConfiguration;
  readonly hostPlatform?: NodeJS.Platform;
  readonly secretBackend?: MainArtifactSecretBackendConfiguration;
}): Promise<MainArtifactConfiguration> {
  const home = requireAbsolutePath(input.home);
  requireAbsolutePath(input.installationRoot);
  const mainListener = validateAdminListener(input.mainListener);
  const mainOrigin = parseOrigin(mainListener.origin);
  if (!isLoopbackHostname(mainOrigin.hostname)) {
    throw new MainArtifactRuntimeError(
      "CONFIG_INVALID",
      "External Artifact listeners require explicit origins and cannot be inferred from the Admin origin.",
    );
  }
  const staticPort = offsetPort(mainListener.port, DEFAULT_STATIC_PORT_OFFSET);
  const interactivePort = offsetPort(mainListener.port, DEFAULT_INTERACTIVE_PORT_OFFSET);
  const secretBackend =
    input.secretBackend ?? defaultSecretBackend(input.hostPlatform ?? platform(), home);
  return validateMainArtifactConfiguration({
    schemaVersion: ARTIFACT_CONFIGURATION_SCHEMA_VERSION,
    enabled: true,
    listeners: {
      static: {
        host: "127.0.0.1",
        port: staticPort,
        origin: `http://static.artifacts.localhost:${String(staticPort)}`,
      },
      interactive: {
        host: "127.0.0.1",
        port: interactivePort,
        origin: `http://interactive.artifacts.localhost:${String(interactivePort)}`,
      },
    },
    storage: {
      maximumArtifactBytes: 256 * 1024 * 1024,
    },
    exposure: {
      defaultMode: "private-network",
      privateNetworks: ["127.0.0.0/8", "::1/128", "::ffff:127.0.0.0/104"],
      authenticatedBearerAlias: "artifact.owner.bearer",
      authenticatedSessionAlias: "artifact.owner.session",
      customPolicyAliases: {},
    },
    signingKeyAlias: "artifact.signing.v1",
    secretBackend,
  });
}

export function validateMainArtifactConfiguration(input: unknown): MainArtifactConfiguration {
  const record = requireRecord(input);
  assertExactKeys(record, [
    "schemaVersion",
    "enabled",
    "listeners",
    "storage",
    "exposure",
    "signingKeyAlias",
    "secretBackend",
  ]);
  if (
    record["schemaVersion"] !== ARTIFACT_CONFIGURATION_SCHEMA_VERSION ||
    record["enabled"] !== true
  ) {
    throw configurationInvalid();
  }

  const listenersRecord = requireRecord(record["listeners"]);
  assertExactKeys(listenersRecord, ["static", "interactive"]);
  const staticListener = validateArtifactListener(listenersRecord["static"]);
  const interactiveListener = validateArtifactListener(listenersRecord["interactive"]);
  assertDistinctOrigins([
    configuredArtifactOrigin(staticListener),
    configuredArtifactOrigin(interactiveListener),
  ]);

  const storage = requireRecord(record["storage"]);
  assertExactKeys(storage, ["maximumArtifactBytes"]);
  const maximumArtifactBytes = storage["maximumArtifactBytes"];
  if (
    typeof maximumArtifactBytes !== "number" ||
    !Number.isSafeInteger(maximumArtifactBytes) ||
    maximumArtifactBytes < 1 ||
    maximumArtifactBytes > MAXIMUM_ARTIFACT_BYTES
  ) {
    throw configurationInvalid();
  }

  const exposure = requireRecord(record["exposure"]);
  assertExactKeys(exposure, [
    "defaultMode",
    "privateNetworks",
    "authenticatedBearerAlias",
    "authenticatedSessionAlias",
    "customPolicyAliases",
  ]);
  if (typeof exposure["defaultMode"] !== "string" || !EXPOSURE_MODES.has(exposure["defaultMode"])) {
    throw configurationInvalid();
  }
  const privateNetworks = requireArray(exposure["privateNetworks"]).map(requireCidr);
  if (
    privateNetworks.length > 128 ||
    new Set(privateNetworks).size !== privateNetworks.length ||
    (exposure["defaultMode"] === "private-network" && privateNetworks.length === 0)
  ) {
    throw configurationInvalid();
  }
  const customPoliciesRecord = requireRecord(exposure["customPolicyAliases"]);
  if (Object.keys(customPoliciesRecord).length > 128) {
    throw configurationInvalid();
  }
  const customPolicyAliases: Record<string, string> = Object.create(null);
  for (const [policyId, alias] of Object.entries(customPoliciesRecord)) {
    customPolicyAliases[requireIdentifier(policyId, "custom Artifact Policy ID")] =
      requireIdentifier(alias, "custom Artifact Policy Secret alias");
  }

  return Object.freeze({
    schemaVersion: ARTIFACT_CONFIGURATION_SCHEMA_VERSION,
    enabled: true,
    listeners: Object.freeze({
      static: staticListener,
      interactive: interactiveListener,
    }),
    storage: Object.freeze({ maximumArtifactBytes }),
    exposure: Object.freeze({
      defaultMode: exposure["defaultMode"] as MainArtifactConfiguration["exposure"]["defaultMode"],
      privateNetworks: Object.freeze(privateNetworks),
      authenticatedBearerAlias: requireIdentifier(
        exposure["authenticatedBearerAlias"],
        "Artifact owner bearer alias",
      ),
      authenticatedSessionAlias: requireIdentifier(
        exposure["authenticatedSessionAlias"],
        "Artifact owner session alias",
      ),
      customPolicyAliases: Object.freeze({ ...customPolicyAliases }),
    }),
    signingKeyAlias: requireIdentifier(record["signingKeyAlias"], "Artifact signing-key alias"),
    secretBackend: validateSecretBackend(record["secretBackend"]),
  });
}

export async function createProductionMainArtifactRuntime(input: {
  readonly configuration: MainArtifactConfiguration;
  readonly home: string;
  readonly sourceCheckout: string;
  readonly deviceId: string;
  readonly adminListeners: readonly ArtifactListenerConfiguration[];
  readonly secretStore?: ManagedSecretStore;
  readonly listenerFactory?: ArtifactListenerFactory;
  readonly externalIngressVerifier?: ArtifactExternalIngressVerifier;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Production Main must inject the repository backed by its configured Main
   * database. The local-file default exists only for standalone compatibility and
   * focused runtime tests.
   */
  readonly indexRepositoryFactory?: () => Promise<ArtifactIndexRepository>;
}): Promise<MainArtifactRuntime> {
  const configuration = validateMainArtifactConfiguration(input.configuration);
  const externalListeners = (
    [
      ["static", configuration.listeners.static],
      ["interactive", configuration.listeners.interactive],
    ] as const
  ).filter((entry) => entry[1].reverseProxy !== undefined);
  if (externalListeners.length > 0 && input.externalIngressVerifier === undefined) {
    throw new MainArtifactRuntimeError(
      "EXTERNAL_INGRESS_UNVERIFIED",
      "Reverse-proxied Artifact listeners require explicit external HTTPS verification.",
    );
  }
  const home = requireAbsolutePath(input.home);
  const sourceCheckout = requireAbsolutePath(input.sourceCheckout);
  const [resolvedHome, resolvedSourceCheckout] = await Promise.all([
    realpath(home),
    realpath(sourceCheckout),
  ]);
  if (isWithin(resolvedSourceCheckout, resolvedHome)) {
    throw new MainArtifactRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      "Artifact runtime state must live outside the OpenDelegate source checkout.",
    );
  }
  const deviceId = requireIdentifier(input.deviceId, "Main Device ID");
  const adminListeners = input.adminListeners.map(validateAdminListener);
  if (adminListeners.length === 0) {
    throw configurationInvalid();
  }
  assertDistinctOrigins([
    configuredArtifactOrigin(configuration.listeners.static),
    configuredArtifactOrigin(configuration.listeners.interactive),
    ...adminListeners.map((listener) => parseOrigin(listener.origin)),
  ]);

  const secretStore =
    input.secretStore ??
    createPlatformManagedSecretStore(
      secretStoreConfiguration({
        backend: configuration.secretBackend,
        deviceId,
        sourceCheckout,
        environment: input.environment ?? process.env,
      }),
    );
  if (
    secretStore.deviceId !== deviceId ||
    secretStore.backend !== configuration.secretBackend.backend
  ) {
    throw new MainArtifactRuntimeError(
      "SECRET_UNAVAILABLE",
      "The Artifact Secret Store does not belong to the configured Main Device and backend.",
    );
  }
  const secretHealth = await secretStore.health();
  if (secretHealth.status !== "ready") {
    throw new MainArtifactRuntimeError(
      "SECRET_UNAVAILABLE",
      "The Main Device Artifact Secret Store is unavailable.",
    );
  }

  await ensureSigningKey(secretStore, configuration.signingKeyAlias);
  const signingKey = await copySecret(secretStore, configuration.signingKeyAlias);
  if (signingKey.byteLength !== SIGNING_KEY_BYTES) {
    signingKey.fill(0);
    throw new MainArtifactRuntimeError(
      "SECRET_UNAVAILABLE",
      "The Artifact signing key is unavailable or malformed.",
    );
  }

  let store: LocalArtifactStore | undefined;
  let access: LocalArtifactAccessBroker | undefined;
  let staticApp: ArtifactGatewayApp | undefined;
  let interactiveApp: ArtifactGatewayApp | undefined;
  let staticListener: ArtifactListenerHandle | undefined;
  let interactiveListener: ArtifactListenerHandle | undefined;
  try {
    const indexRepository = await input.indexRepositoryFactory?.();
    store = await LocalArtifactStore.open({
      rootDirectory: join(resolvedHome, "state", "artifacts"),
      maxArtifactBytes: configuration.storage.maximumArtifactBytes,
      clock: new SystemArtifactClock(),
      signingKey,
      ...(indexRepository === undefined ? {} : { indexRepository }),
    });
    access = await LocalArtifactAccessBroker.open({
      rootDirectory: join(resolvedHome, "state", "artifact-access"),
      store,
      clock: new SystemArtifactClock(),
      maximumArtifactBytes: configuration.storage.maximumArtifactBytes,
      maximumChunkBytes: Math.min(configuration.storage.maximumArtifactBytes, 8 * 1024 * 1024),
    });
    const authorization = new ManagedArtifactAuthorization({
      configuration,
      secretStore,
      access,
    });
    const commonAppOptions = {
      store,
      authorization,
      adminOrigins: adminListeners.map((listener) => listener.origin),
      workerUploads: access,
      browserSessions: access,
      maximumUploadChunkBytes: Math.min(
        configuration.storage.maximumArtifactBytes,
        8 * 1024 * 1024,
      ),
    } as const;
    staticApp = await createArtifactGatewayApp({
      ...commonAppOptions,
      plane: "static",
      staticOrigin: configuration.listeners.static.origin,
      interactiveOrigin: configuration.listeners.interactive.origin,
      ...gatewayProxyOptions(configuration.listeners.static),
    });
    interactiveApp = await createArtifactGatewayApp({
      ...commonAppOptions,
      plane: "interactive",
      staticOrigin: configuration.listeners.static.origin,
      interactiveOrigin: configuration.listeners.interactive.origin,
      ...gatewayProxyOptions(configuration.listeners.interactive),
    });
    const listenerFactory = input.listenerFactory ?? new FastifyArtifactListenerFactory();
    staticListener = await listenerFactory.listen({
      plane: "static",
      configuration: configuration.listeners.static,
      app: staticApp,
    });
    interactiveListener = await listenerFactory.listen({
      plane: "interactive",
      configuration: configuration.listeners.interactive,
      app: interactiveApp,
    });
    for (const [plane, listener] of externalListeners) {
      const verification = await input.externalIngressVerifier?.verify({
        plane,
        externalOrigin: listener.origin,
        upstreamHost: listener.host,
        upstreamPort: listener.port,
        expectedService: `opendelegate-artifact-${plane}`,
      });
      if (
        verification?.status !== "verified" ||
        !Number.isSafeInteger(verification.checkedAtMs) ||
        verification.checkedAtMs < 0
      ) {
        throw new MainArtifactRuntimeError(
          "EXTERNAL_INGRESS_UNVERIFIED",
          `The ${plane} Artifact reverse proxy did not pass live external HTTPS verification.`,
        );
      }
    }

    const activeStore = store;
    const activeAccess = access;
    const activeStaticListener = staticListener;
    const activeInteractiveListener = interactiveListener;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    const listeners = Object.freeze({
      static: activeStaticListener,
      interactive: activeInteractiveListener,
    });
    return Object.freeze({
      configuration,
      store,
      access,
      staticApp,
      interactiveApp,
      listeners,
      issueWorkerUploadGrant: async (
        grantInput: IssueArtifactUploadGrant,
      ): Promise<ArtifactUploadGrantV1> => {
        const issued = await activeAccess.issueUploadGrant(grantInput);
        return parseArtifactUploadGrant({
          protocolVersion: "v1",
          uploadId: issued.uploadId,
          artifactId: issued.artifactId,
          uploadUrl: new URL(
            `/worker-uploads/${encodeURIComponent(issued.uploadId)}`,
            configuration.listeners.static.origin,
          ).href,
          credential: issued.credential,
          expiresAtMs: issued.expiresAtMs,
          maximumChunkBytes: issued.maximumChunkBytes,
          declaredSizeBytes: grantInput.declaredSizeBytes,
          expectedSha256: grantInput.expectedChecksum.value,
        });
      },
      issueBrowserAccessGrant: async (grantInput: IssueBrowserArtifactGrant) => {
        const issued = await activeAccess.issueBrowserGrant(grantInput);
        const origin =
          issued.plane === "interactive"
            ? configuration.listeners.interactive.origin
            : configuration.listeners.static.origin;
        return Object.freeze({
          method: "POST" as const,
          actionUrl: new URL("/owner-session/exchange", origin).href,
          fieldName: "grant" as const,
          fieldValue: issued.credential,
          artifactId: issued.artifactId,
          expiresAtMs: issued.expiresAtMs,
        });
      },
      health: async (): Promise<MainArtifactRuntimeHealth> => {
        if (closed) {
          return artifactHealth("unavailable", "ARTIFACT_RUNTIME_CLOSED", listeners);
        }
        const health = await secretStore.health();
        return health.status === "ready"
          ? artifactHealth("ready", "ARTIFACT_RUNTIME_READY", listeners)
          : artifactHealth("unavailable", "ARTIFACT_SECRET_UNAVAILABLE", listeners);
      },
      close: (): Promise<void> => {
        if (closePromise === undefined) {
          closed = true;
          closePromise = closeArtifactRuntimeResources({
            staticListener: activeStaticListener,
            interactiveListener: activeInteractiveListener,
            access: activeAccess,
            store: activeStore,
          });
        }
        return closePromise;
      },
    });
  } catch (error) {
    return closeAfterPrimaryFailure(error, [
      {
        operation: "artifact-interactive-listener",
        close: () => interactiveListener?.close(),
      },
      { operation: "artifact-static-listener", close: () => staticListener?.close() },
      {
        operation: "artifact-interactive-app",
        close: () => (interactiveListener === undefined ? interactiveApp?.close() : undefined),
      },
      {
        operation: "artifact-static-app",
        close: () => (staticListener === undefined ? staticApp?.close() : undefined),
      },
      {
        operation: "artifact-access",
        close: () => access?.close(),
      },
      { operation: "artifact-store", close: () => store?.close() },
    ]);
  } finally {
    signingKey.fill(0);
  }
}

async function closeArtifactRuntimeResources(input: {
  readonly staticListener: ArtifactListenerHandle;
  readonly interactiveListener: ArtifactListenerHandle;
  readonly access: LocalArtifactAccessBroker;
  readonly store: LocalArtifactStore;
}): Promise<void> {
  try {
    await closeMainResources([
      { operation: "artifact-static-listener", close: () => input.staticListener.close() },
      {
        operation: "artifact-interactive-listener",
        close: () => input.interactiveListener.close(),
      },
    ]);
  } catch (error) {
    return closeAfterPrimaryFailure(error, [
      { operation: "artifact-access", close: () => input.access.close() },
      { operation: "artifact-store", close: () => input.store.close() },
    ]);
  }
  await closeMainResources([
    { operation: "artifact-access", close: () => input.access.close() },
    { operation: "artifact-store", close: () => input.store.close() },
  ]);
}

class SystemArtifactClock {
  public nowMs(): number {
    return Date.now();
  }
}

export class FetchArtifactExternalIngressVerifier implements ArtifactExternalIngressVerifier {
  readonly #timeoutMs: number;

  public constructor(input: { readonly timeoutMs?: number } = {}) {
    const timeoutMs = input.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new MainArtifactRuntimeError(
        "CONFIG_INVALID",
        "Artifact external HTTPS verification timeout is invalid.",
      );
    }
    this.#timeoutMs = timeoutMs;
  }

  public async verify(
    input: Parameters<ArtifactExternalIngressVerifier["verify"]>[0],
  ): Promise<ArtifactExternalIngressVerification> {
    const checkedAtMs = Date.now();
    try {
      const origin = parseOrigin(input.externalOrigin);
      if (origin.protocol !== "https:") {
        return { status: "unavailable", checkedAtMs, code: "HTTPS_REQUIRED" };
      }
      const response = await fetch(new URL("/health/live", origin), {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok || response.url !== new URL("/health/live", origin).href) {
        return { status: "unavailable", checkedAtMs, code: "HEALTH_HTTP_INVALID" };
      }
      const content = await readBoundedResponse(response, 8 * 1024);
      const health = JSON.parse(content) as unknown;
      if (
        !isPlainRecord(health) ||
        health["status"] !== "ok" ||
        health["service"] !== input.expectedService
      ) {
        return { status: "unavailable", checkedAtMs, code: "HEALTH_BODY_INVALID" };
      }
      return { status: "verified", checkedAtMs };
    } catch {
      return { status: "unavailable", checkedAtMs, code: "HTTPS_PROBE_FAILED" };
    }
  }
}

class FastifyArtifactListenerFactory implements ArtifactListenerFactory {
  public async listen(input: {
    readonly plane: ArtifactGatewayPlane;
    readonly configuration: ArtifactListenerConfiguration;
    readonly app: ArtifactGatewayApp;
  }): Promise<ArtifactListenerHandle> {
    await input.app.listen({
      host: input.configuration.host,
      port: input.configuration.port,
      listenTextResolver: (address) => address,
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      address: input.configuration,
      close: () => {
        closePromise ??= input.app.close();
        return closePromise;
      },
    });
  }
}

class ManagedArtifactAuthorization implements ArtifactAuthorizationPort {
  readonly #configuration: MainArtifactConfiguration;
  readonly #privateNetworks: BlockList;
  readonly #secretStore: ManagedSecretStore;
  readonly #access: LocalArtifactAccessBroker;

  public constructor(input: {
    readonly configuration: MainArtifactConfiguration;
    readonly secretStore: ManagedSecretStore;
    readonly access: LocalArtifactAccessBroker;
  }) {
    this.#configuration = input.configuration;
    this.#privateNetworks = createNetworkBlockList(input.configuration.exposure.privateNetworks);
    this.#secretStore = input.secretStore;
    this.#access = input.access;
  }

  public async authorizeOwner(input: {
    readonly artifactId: string;
    readonly credential: string;
    readonly credentialKind: "bearer" | "artifact-session";
  }): Promise<boolean> {
    if (
      input.credentialKind === "artifact-session" &&
      (await this.#access.authorizeBrowserSession({
        artifactId: input.artifactId,
        credential: input.credential,
      }))
    ) {
      return true;
    }
    const alias =
      input.credentialKind === "bearer"
        ? this.#configuration.exposure.authenticatedBearerAlias
        : this.#configuration.exposure.authenticatedSessionAlias;
    return secretMatches(this.#secretStore, alias, input.credential);
  }

  public async authorizePrivateNetwork(input: {
    readonly remoteAddress: string;
  }): Promise<boolean> {
    const family = isIP(input.remoteAddress);
    return (
      family !== 0 &&
      this.#privateNetworks.check(input.remoteAddress, family === 4 ? "ipv4" : "ipv6")
    );
  }

  public async authorizeCustom(input: {
    readonly customPolicyId: string;
    readonly bearerToken?: string;
  }): Promise<boolean> {
    const alias = ownValue(this.#configuration.exposure.customPolicyAliases, input.customPolicyId);
    return alias !== undefined && input.bearerToken !== undefined
      ? secretMatches(this.#secretStore, alias, input.bearerToken)
      : false;
  }
}

function gatewayProxyOptions(listener: ArtifactListenerConfiguration):
  | {
      readonly requireForwardedHttps: true;
      readonly trustProxyAddress: (remoteAddress: string) => boolean;
    }
  | Record<string, never> {
  if (listener.reverseProxy === undefined) {
    return {};
  }
  const trusted = createNetworkBlockList(listener.reverseProxy.trustedProxyNetworks);
  return {
    requireForwardedHttps: true,
    trustProxyAddress: (remoteAddress: string): boolean => {
      const family = isIP(remoteAddress);
      return family !== 0 && trusted.check(remoteAddress, family === 4 ? "ipv4" : "ipv6");
    },
  };
}

async function ensureSigningKey(store: ManagedSecretStore, alias: string): Promise<void> {
  if ((await store.availability(alias)).ready) {
    return;
  }
  const generated = randomBytes(SIGNING_KEY_BYTES);
  try {
    try {
      await store.store(alias, generated);
    } catch (error) {
      if (!(await store.availability(alias)).ready) {
        throw new MainArtifactRuntimeError(
          "SECRET_UNAVAILABLE",
          "The Artifact signing key could not be provisioned.",
          { cause: error },
        );
      }
    }
  } finally {
    generated.fill(0);
  }
}

async function copySecret(store: ManagedSecretStore, alias: string): Promise<Buffer> {
  let copied: Buffer | undefined;
  try {
    await store.executeWithSecretBytes(alias, (value) => {
      if (value.byteLength < 1 || value.byteLength > MAXIMUM_SECRET_BYTES) {
        return;
      }
      copied = Buffer.from(value);
    });
  } catch (error) {
    throw new MainArtifactRuntimeError(
      "SECRET_UNAVAILABLE",
      "The configured Artifact Secret is unavailable.",
      { cause: error },
    );
  }
  if (copied === undefined) {
    throw new MainArtifactRuntimeError(
      "SECRET_UNAVAILABLE",
      "The configured Artifact Secret is unavailable.",
    );
  }
  return copied;
}

async function secretMatches(
  store: ManagedSecretStore,
  alias: string,
  candidate: string,
): Promise<boolean> {
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.length > MAXIMUM_SECRET_BYTES ||
    containsControl(candidate)
  ) {
    return false;
  }
  const candidateBytes = Buffer.from(candidate, "utf8");
  let matches = false;
  try {
    await store.executeWithSecretBytes(alias, (stored) => {
      matches =
        stored.byteLength === candidateBytes.byteLength && timingSafeEqual(stored, candidateBytes);
    });
  } catch {
    return false;
  } finally {
    candidateBytes.fill(0);
  }
  return matches;
}

function createNetworkBlockList(networks: readonly string[]): BlockList {
  const list = new BlockList();
  for (const network of networks) {
    const { address, family, prefix } = parseCidr(network);
    list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

function requireCidr(input: unknown): string {
  if (typeof input !== "string") {
    throw configurationInvalid();
  }
  parseCidr(input);
  return input;
}

function parseCidr(value: string): {
  readonly address: string;
  readonly family: 4 | 6;
  readonly prefix: number;
} {
  if (value.length < 3 || value.length > 128 || containsControl(value)) {
    throw configurationInvalid();
  }
  const separatorIndex = value.lastIndexOf("/");
  const address = value.slice(0, separatorIndex);
  const prefixText = value.slice(separatorIndex + 1);
  const family = isIP(address);
  const prefix = Number(prefixText);
  if (
    (family !== 4 && family !== 6) ||
    !/^(?:0|[1-9][0-9]{0,2})$/u.test(prefixText) ||
    !Number.isSafeInteger(prefix) ||
    prefix < 0 ||
    prefix > (family === 4 ? 32 : 128)
  ) {
    throw configurationInvalid();
  }
  return { address, family, prefix };
}

function validateArtifactListener(input: unknown): ArtifactListenerConfiguration {
  const listener = validateListenerShape(input);
  if (listener.reverseProxy === undefined) {
    const origin = parseArtifactOrigin(listener.origin);
    if (
      !isLoopbackHostname(listener.host) ||
      Number(origin.port || defaultPort(origin.protocol)) !== listener.port
    ) {
      throw new MainArtifactRuntimeError(
        "CONFIG_INVALID",
        "Built-in direct Artifact listeners require loopback HTTP and a matching port.",
      );
    }
    return listener;
  }
  if (!isLoopbackHostname(listener.host)) {
    throw new MainArtifactRuntimeError(
      "CONFIG_INVALID",
      "Built-in Artifact listeners bind to loopback only.",
    );
  }
  const origin = parseOrigin(listener.origin);
  if (origin.protocol !== "https:") {
    throw new MainArtifactRuntimeError(
      "CONFIG_INVALID",
      "Reverse-proxied Artifact origins require externally verified HTTPS.",
    );
  }
  return listener;
}

function configuredArtifactOrigin(listener: ArtifactListenerConfiguration): URL {
  return listener.reverseProxy === undefined
    ? parseArtifactOrigin(listener.origin)
    : parseOrigin(listener.origin);
}

function validateAdminListener(input: unknown): ArtifactListenerConfiguration {
  const listener = validateListenerShape(input);
  const origin = parseOrigin(listener.origin);
  if (Number(origin.port || defaultPort(origin.protocol)) !== listener.port) {
    throw configurationInvalid();
  }
  return listener;
}

function validateListenerShape(input: unknown): ArtifactListenerConfiguration {
  const record = requireRecord(input);
  const hasReverseProxy = Object.prototype.hasOwnProperty.call(record, "reverseProxy");
  assertExactKeys(
    record,
    hasReverseProxy ? ["host", "port", "origin", "reverseProxy"] : ["host", "port", "origin"],
  );
  if (
    typeof record["host"] !== "string" ||
    record["host"].length < 1 ||
    record["host"].length > 253 ||
    containsControl(record["host"]) ||
    typeof record["port"] !== "number" ||
    !Number.isSafeInteger(record["port"]) ||
    record["port"] < 1 ||
    record["port"] > 65_535 ||
    typeof record["origin"] !== "string"
  ) {
    throw configurationInvalid();
  }
  let reverseProxy: ArtifactListenerConfiguration["reverseProxy"];
  if (hasReverseProxy) {
    const proxy = requireRecord(record["reverseProxy"]);
    assertExactKeys(proxy, ["trustedProxyNetworks"]);
    const trustedProxyNetworks = requireArray(proxy["trustedProxyNetworks"]).map(requireCidr);
    if (
      trustedProxyNetworks.length < 1 ||
      trustedProxyNetworks.length > 128 ||
      new Set(trustedProxyNetworks).size !== trustedProxyNetworks.length
    ) {
      throw configurationInvalid();
    }
    reverseProxy = Object.freeze({
      trustedProxyNetworks: Object.freeze(trustedProxyNetworks),
    });
  }
  return Object.freeze({
    host: record["host"],
    port: record["port"],
    origin: record["origin"],
    ...(reverseProxy === undefined ? {} : { reverseProxy }),
  });
}

function parseArtifactOrigin(value: string): URL {
  const origin = parseOrigin(value);
  if (origin.protocol !== "http:" || !isLoopbackHostname(origin.hostname)) {
    throw new MainArtifactRuntimeError(
      "CONFIG_INVALID",
      "Built-in Artifact listeners support direct loopback HTTP only; HTTPS origins require a TLS-capable listener composition.",
    );
  }
  return origin;
}

function parseOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw configurationInvalid();
  }
  if (
    value !== origin.origin ||
    origin.username !== "" ||
    origin.password !== "" ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && isLoopbackHostname(origin.hostname)))
  ) {
    throw new MainArtifactRuntimeError(
      "CONFIG_INVALID",
      "Artifact origins must be exact HTTPS origins (or loopback HTTP origins).",
    );
  }
  return origin;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}

function assertDistinctOrigins(origins: readonly URL[]): void {
  const authority = origins.map((origin) => origin.origin);
  const cookieHosts = origins.map((origin) => origin.hostname);
  if (
    new Set(authority).size !== authority.length ||
    new Set(cookieHosts).size !== cookieHosts.length
  ) {
    throw new MainArtifactRuntimeError(
      "CONFIG_INVALID",
      "Artifact and Admin origins and cookie hosts must be distinct.",
    );
  }
}

function defaultSecretBackend(
  hostPlatform: NodeJS.Platform,
  home: string,
): MainArtifactSecretBackendConfiguration {
  if (hostPlatform === "win32") {
    return Object.freeze({
      backend: "windows-dpapi",
      vaultRoot: join(home, "secrets", "main"),
    });
  }
  throw new MainArtifactRuntimeError(
    "CONFIG_INVALID",
    "macOS and Linux Artifact setup requires an explicit secure Secret Store backend.",
  );
}

function validateSecretBackend(input: unknown): MainArtifactSecretBackendConfiguration {
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
      if (
        typeof record["serviceSid"] !== "string" ||
        !/^S-1-(?:[0-9]+-){1,14}[0-9]+$/u.test(record["serviceSid"])
      ) {
        throw configurationInvalid();
      }
      return Object.freeze({
        backend: "windows-service-dpapi",
        vaultRoot: requireAbsolutePath(record["vaultRoot"]),
        handoffRoot: requireAbsolutePath(record["handoffRoot"]),
        serviceSid: record["serviceSid"],
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
      assertExactKeys(record, ["backend", "credentialName", "vaultRoot"]);
      return Object.freeze({
        backend: "linux-systemd-credential-vault",
        credentialName: requireIdentifier(record["credentialName"], "credential name"),
        vaultRoot: requireAbsolutePath(record["vaultRoot"]),
      });
    default:
      throw configurationInvalid();
  }
}

function secretStoreConfiguration(input: {
  readonly backend: MainArtifactSecretBackendConfiguration;
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
    case "windows-service-dpapi":
      return {
        backend: "windows-service-dpapi",
        deviceId: input.deviceId,
        sourceCheckoutRoot: input.sourceCheckout,
        vaultRoot: input.backend.vaultRoot,
        handoffRoot: input.backend.handoffRoot,
        serviceSid: input.backend.serviceSid,
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
        throw new MainArtifactRuntimeError(
          "SECRET_UNAVAILABLE",
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

function artifactHealth(
  status: MainArtifactRuntimeHealth["status"],
  code: MainArtifactRuntimeHealth["code"],
  listeners: MainArtifactRuntime["listeners"],
): MainArtifactRuntimeHealth {
  return Object.freeze({
    status,
    code,
    listeners: Object.freeze({
      static: listeners.static.address,
      interactive: listeners.interactive.address,
    }),
  });
}

function offsetPort(port: number, offset: number): number {
  const selected = port + offset;
  if (selected > 65_535) {
    throw new MainArtifactRuntimeError(
      "CONFIG_INVALID",
      "The Main listener port leaves no room for the default Artifact listeners.",
    );
  }
  return selected;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function requireAbsolutePath(input: unknown): string {
  if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0")) {
    throw configurationInvalid();
  }
  return resolve(input);
}

function requireIdentifier(input: unknown, label: string): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input)
  ) {
    throw new MainArtifactRuntimeError("CONFIG_INVALID", `The ${label} is invalid.`);
  }
  return input;
}

function requireArray(input: unknown): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw configurationInvalid();
  }
  return input;
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw configurationInvalid();
  }
  return input as Record<string, unknown>;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype
  );
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) {
    throw new Error("Artifact external health response has no body.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      size += result.value.byteLength;
      if (size > maximumBytes) {
        throw new Error("Artifact external health response exceeded its byte limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function assertExactKeys(
  input: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  if (Object.keys(input).sort().join(",") !== [...expected].sort().join(",")) {
    throw configurationInvalid();
  }
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function ownValue<TValue>(
  record: Readonly<Record<string, TValue>>,
  key: string,
): TValue | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function configurationInvalid(cause?: unknown): MainArtifactRuntimeError {
  return new MainArtifactRuntimeError(
    "CONFIG_INVALID",
    "The Artifact Gateway configuration is invalid and no credential value may appear in it.",
    cause === undefined ? undefined : { cause },
  );
}
