import { randomUUID } from "node:crypto";
import { chmod, lstat, rm } from "node:fs/promises";

import { createPlatformManagedSecretStore, type ManagedSecretStore } from "@opendelegate/secrets";
import {
  createNodeSessionHelperIpcTransport,
  type SessionHelperIpcEndpoint,
} from "@opendelegate/session-helper-ipc";
import {
  ManagedSecretEd25519SigningKeyProvider,
  SignedSessionHelperPlaneHost,
  readHelperPlanePresence,
} from "@opendelegate/session-helper-runtime";
import {
  WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS,
  readWorkerSessionHelperOwnerKeyBinding,
} from "@opendelegate/worker";

import {
  loadServiceHostConfiguration,
  parseServiceHostArguments,
  ServiceHostError,
  type ServiceHostConfiguration,
} from "./configuration.ts";
import {
  autoOpenAdminForOwnerSession,
  type AdminAutoOpenInput,
  type AdminAutoOpenResult,
} from "./admin-auto-open.ts";
import { verifyServiceHostReleaseIdentity } from "./core-host.ts";
import { createNativeSessionHelperDriver } from "./native-helper-driver.ts";

export interface RunSessionHelperServiceHostOptions {
  readonly arguments: readonly string[];
  readonly createStore?: (configuration: ServiceHostConfiguration) => ManagedSecretStore;
  readonly autoOpenAdmin?: (input: AdminAutoOpenInput) => Promise<AdminAutoOpenResult>;
}

export async function runSessionHelperServiceHost(
  options: RunSessionHelperServiceHostOptions,
): Promise<void> {
  const parsed = parseServiceHostArguments(options.arguments);
  if (parsed.plane !== "session-helper") {
    throw new ServiceHostError("The session helper received the wrong runtime plane.");
  }
  const configuration = await loadServiceHostConfiguration(parsed.configPath);
  if (configuration.role !== parsed.role) {
    throw new ServiceHostError("The session-helper role does not match its durable configuration.");
  }
  if (
    configuration.helperSecretBinding === null ||
    configuration.localIpc.sessionHelper !== "enabled"
  ) {
    throw new ServiceHostError("This headless Linux service has no owner-session helper.");
  }
  await verifyServiceHostReleaseIdentity(configuration);
  const sessionId = requireNativeSessionIdentity(configuration);
  const store = (options.createStore ?? createOwnerSessionStore)(configuration);
  if ((await store.health()).status !== "ready") {
    throw new ServiceHostError("The owner-session Secret Store is unavailable.");
  }
  const helperKey = await readWorkerSessionHelperOwnerKeyBinding(store);
  if (
    helperKey.alias !== WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS ||
    helperKey.keyId !== configuration.localIpc.helper.keyId ||
    helperKey.publicKeySpkiBase64Url !== configuration.localIpc.helper.publicKeySpkiBase64Url
  ) {
    throw new ServiceHostError("The owner-session helper signing key does not match its pin.");
  }

  const signing = new ManagedSecretEd25519SigningKeyProvider({
    store,
    references: {
      [configuration.localIpc.helper.privateKeyReference]:
        WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS,
    },
  });
  const controller = new AbortController();
  const removeStopSignals = installStopSignals(controller);
  let host: SignedSessionHelperPlaneHost | undefined;
  let adminAutoOpen: Promise<AdminAutoOpenResult> | undefined;
  try {
    const endpoint = sessionHelperEndpoint(configuration);
    host = await SignedSessionHelperPlaneHost.start({
      instanceId: configuration.instanceId,
      deviceId: configuration.deviceId,
      releaseVersion: configuration.releaseVersion,
      runtimeRoot: configuration.runtimeRoot,
      helperInstanceId: randomUUID(),
      sessionId,
      endpoint,
      transport: createNodeSessionHelperIpcTransport(),
      privateKeyReference: configuration.localIpc.helper.privateKeyReference,
      localKeyId: configuration.localIpc.helper.keyId,
      signingKeyProvider: signing,
      corePublicKey: {
        keyId: configuration.localIpc.helper.peerKeyId,
        publicKeySpkiBase64Url: configuration.localIpc.helper.peerPublicKeySpkiBase64Url,
        usage: "active",
      },
      peerAuthorizer: {
        authorize: (request) =>
          request.peerIdentity.transport ===
          (configuration.platform === "windows" ? "windows-named-pipe" : "unix-domain-socket"),
      },
      createDriver: async (binding) =>
        await createNativeSessionHelperDriver(configuration, binding),
      prepareEndpoint: async () => await prepareEndpoint(configuration),
      secureEndpoint: async () => await secureEndpoint(configuration),
      signal: controller.signal,
    });
    adminAutoOpen = (options.autoOpenAdmin ?? autoOpenAdminForOwnerSession)({
      instanceId: configuration.instanceId,
      deviceId: configuration.deviceId,
      platform: configuration.platform,
      role: configuration.role,
      runtimeRoot: configuration.runtimeRoot,
      ownerStableId: configuration.ownerSession.stableUserId,
      sessionId,
      adminAutoOpen: configuration.ownerSession.adminAutoOpen,
      health: configuration.health,
      signal: controller.signal,
    }).catch(() => ({ status: "launch-failed" }));
    await waitForAbort(controller.signal);
  } finally {
    controller.abort();
    await adminAutoOpen?.catch(() => undefined);
    await host?.close().catch(() => undefined);
    removeStopSignals();
  }
}

function createOwnerSessionStore(configuration: ServiceHostConfiguration): ManagedSecretStore {
  const binding = configuration.helperSecretBinding;
  if (binding === null) {
    throw new ServiceHostError("This headless Linux service has no owner-session Secret Store.");
  }
  if (binding.backend === "windows-dpapi") {
    return createPlatformManagedSecretStore({
      backend: binding.backend,
      deviceId: configuration.deviceId,
      expectedIdentitySid: configuration.ownerSession.stableUserId,
      sourceCheckoutRoot: configuration.releaseRoot,
      vaultRoot: binding.vaultRoot,
    });
  }
  if (binding.backend === "macos-keychain") {
    return createPlatformManagedSecretStore({
      backend: binding.backend,
      deviceId: configuration.deviceId,
      expectedHelperSha256: binding.expectedHelperSha256,
      helperPath: binding.helperPath,
    });
  }
  return createPlatformManagedSecretStore({
    backend: binding.backend,
    deviceId: configuration.deviceId,
    secretToolPath: binding.secretToolPath,
  });
}

function requireNativeSessionIdentity(configuration: ServiceHostConfiguration): string {
  const value = process.env["OPENDELEGATE_NATIVE_SESSION_ID"];
  if (
    process.env["OPENDELEGATE_NATIVE_SERVICE"] !== "1" ||
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^(?:windows:[0-9]+(?::logon:[0-9]+-[0-9]+)?|unix:[0-9]+(?::(?:audit:[0-9]+|xdg:[A-Za-z0-9._-]{1,128}))?)$/u.test(
      value,
    )
  ) {
    throw new ServiceHostError("The native owner-session identity is unavailable.");
  }
  if (
    configuration.platform !== "windows" &&
    ((value !== `unix:${String(configuration.ownerSession.uid)}` &&
      !value.startsWith(`unix:${String(configuration.ownerSession.uid)}:`)) ||
      typeof process.getuid !== "function" ||
      process.getuid() !== configuration.ownerSession.uid)
  ) {
    throw new ServiceHostError("The native owner-session identity does not match configuration.");
  }
  return value;
}

async function prepareEndpoint(configuration: ServiceHostConfiguration): Promise<void> {
  if (configuration.localIpc.sessionHelper !== "enabled") {
    throw new ServiceHostError("This headless Linux service has no owner-session IPC endpoint.");
  }
  const existing = await readHelperPlanePresence({
    runtimeRoot: configuration.runtimeRoot,
    expected: {
      instanceId: configuration.instanceId,
      deviceId: configuration.deviceId,
      releaseVersion: configuration.releaseVersion,
    },
    peerKey: {
      keyId: configuration.localIpc.helper.keyId,
      publicKeySpkiBase64Url: configuration.localIpc.helper.publicKeySpkiBase64Url,
      usage: "active",
    },
    processIsAlive: () => true,
  });
  if (existing !== null && processIsAlive(existing.processId)) {
    throw new ServiceHostError("Another signed owner-session helper is already active.");
  }
  if (configuration.localIpc.kind === "named-pipe") {
    return;
  }
  try {
    const metadata = await lstat(configuration.localIpc.endpoint);
    if (existing === null || !metadata.isSocket() || metadata.isSymbolicLink()) {
      throw new ServiceHostError("The local IPC endpoint is occupied by an unsafe entry.");
    }
    await rm(configuration.localIpc.endpoint);
  } catch (error: unknown) {
    if (
      error instanceof ServiceHostError ||
      !(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

async function secureEndpoint(configuration: ServiceHostConfiguration): Promise<void> {
  if (configuration.localIpc.kind === "unix-domain-socket") {
    await chmod(configuration.localIpc.endpoint, 0o660);
  }
}

function sessionHelperEndpoint(configuration: ServiceHostConfiguration): SessionHelperIpcEndpoint {
  return configuration.localIpc.kind === "named-pipe"
    ? {
        kind: "windows-named-pipe",
        path: configuration.localIpc.endpoint,
      }
    : {
        kind: "unix-domain-socket",
        path: configuration.localIpc.endpoint,
      };
}

function installStopSignals(controller: AbortController): () => void {
  const stop = () => controller.abort();
  const onInput = (bytes: Buffer) => {
    if (bytes.toString("utf8").split(/\r?\n/u).includes("stop")) {
      stop();
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGBREAK", stop);
  process.stdin.on("data", onInput);
  process.stdin.resume();
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGBREAK", stop);
    process.stdin.off("data", onInput);
    process.stdin.pause();
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveAbort) =>
    signal.addEventListener("abort", () => resolveAbort(), { once: true }),
  );
}
