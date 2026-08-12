import { spawn, type ChildProcess } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, resolve, win32 } from "node:path";

import { isMainServiceReadyMessage, loadMainConfiguration } from "@opendelegate/main";
import { parseWindowsOwnerHome } from "@opendelegate/platform-services";
import {
  createNodeSessionHelperIpcTransport,
  type SessionHelperIpcEndpoint,
} from "@opendelegate/session-helper-ipc";
import {
  ManagedSecretAuthoritySigningKeyProvider,
  ManagedSecretEd25519SigningKeyProvider,
  PersistentDesktopAuthorityStore,
  SignedSessionHelperCoreBridge,
} from "@opendelegate/session-helper-runtime";
import {
  WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS,
  WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
  createWorkerManagedSecretStore,
  inspectConfiguredWorkerIdentityKey,
  loadWorkerConfiguration,
  readWorkerComputerUseCoreKeyBinding,
  resolveWorkerPaths,
  runWorkerDaemon,
  type WorkerCertificateRenewalOutcome,
  type WorkerConnectionDiagnostic,
  type WorkerComputerUseRuntimePort,
} from "@opendelegate/worker";

import {
  loadServiceHostConfiguration,
  parseServiceHostArguments,
  ServiceHostError,
  type ServiceHostConfiguration,
} from "./configuration.ts";
import { CoreHealthServer } from "./health.ts";

export interface CoreWorkloadHandle {
  readonly ready: Promise<void>;
  readonly completed: Promise<void>;
  stop(): Promise<void>;
}

export interface RunCoreServiceHostOptions {
  readonly arguments: readonly string[];
  readonly startMain?: (
    configuration: ServiceHostConfiguration,
    signal: AbortSignal,
  ) => Promise<CoreWorkloadHandle>;
  readonly startWorker?: (
    configuration: ServiceHostConfiguration,
    signal: AbortSignal,
  ) => Promise<CoreWorkloadHandle>;
}

export interface StartCoLocatedMainDeviceWorkloadOptions {
  readonly startMainControlPlane: (
    configuration: ServiceHostConfiguration,
    signal: AbortSignal,
  ) => Promise<CoreWorkloadHandle>;
  readonly startLocalWorker: (
    configuration: ServiceHostConfiguration,
    signal: AbortSignal,
  ) => Promise<CoreWorkloadHandle>;
}

export async function runCoreServiceHost(options: RunCoreServiceHostOptions): Promise<void> {
  const parsed = parseServiceHostArguments(options.arguments);
  if (parsed.plane !== "core") {
    throw new ServiceHostError("The core service host received the wrong runtime plane.");
  }
  const configuration = await loadServiceHostConfiguration(parsed.configPath);
  if (configuration.role !== parsed.role) {
    throw new ServiceHostError("The core service role does not match its durable configuration.");
  }
  await verifyServiceHostReleaseIdentity(configuration);

  const controller = new AbortController();
  const health = new CoreHealthServer({
    endpoint: configuration.health.endpoint,
    instanceId: configuration.instanceId,
    deviceId: configuration.deviceId,
    role: configuration.role,
    releaseVersion: configuration.releaseVersion,
  });
  const stopSignals = installStopSignals(controller);
  let workload: CoreWorkloadHandle | undefined;
  try {
    await health.listen();
    workload =
      configuration.role === "main"
        ? await (options.startMain ?? startMainWorkload)(configuration, controller.signal)
        : await (options.startWorker ?? startWorkerWorkload)(configuration, controller.signal);
    if (
      !(await waitForCoreWorkloadReadiness(
        workload,
        configuration.health.timeoutMs,
        controller.signal,
      ))
    ) {
      health.markStopping();
      return;
    }
    health.markRunning();
    await Promise.race([workload.completed, waitForAbort(controller.signal)]);
    if (!controller.signal.aborted) {
      health.markFailed();
      throw new ServiceHostError("The core workload exited unexpectedly.");
    }
    health.markStopping();
  } catch (error) {
    health.markFailed();
    throw error;
  } finally {
    controller.abort();
    await workload?.stop().catch(() => undefined);
    await health.close().catch(() => undefined);
    stopSignals();
  }
}

async function startMainWorkload(
  configuration: ServiceHostConfiguration,
  signal: AbortSignal,
): Promise<CoreWorkloadHandle> {
  return startCoLocatedMainDeviceWorkload(configuration, signal, {
    startMainControlPlane: startMainControlPlaneWorkload,
    startLocalWorker: startWorkerWorkload,
  });
}

export async function startCoLocatedMainDeviceWorkload(
  configuration: ServiceHostConfiguration,
  signal: AbortSignal,
  options: StartCoLocatedMainDeviceWorkloadOptions,
): Promise<CoreWorkloadHandle> {
  const main = await options.startMainControlPlane(configuration, signal);
  let localWorker: CoreWorkloadHandle;
  try {
    localWorker = await options.startLocalWorker(configuration, signal);
  } catch (error: unknown) {
    await main.stop().catch(() => undefined);
    throw error;
  }
  return {
    ready: Promise.all([main.ready, localWorker.ready]).then(() => undefined),
    completed: Promise.race([main.completed, localWorker.completed]),
    stop: async () => {
      await localWorker.stop().catch(() => undefined);
      await main.stop().catch(() => undefined);
    },
  };
}

async function startMainControlPlaneWorkload(
  configuration: ServiceHostConfiguration,
  signal: AbortSignal,
): Promise<CoreWorkloadHandle> {
  const mainConfiguration = await loadMainConfiguration(
    join(configuration.stateRoot, "config", "main.json"),
  );
  if (
    mainConfiguration.instanceId !== configuration.instanceId ||
    mainConfiguration.deviceId !== configuration.deviceId
  ) {
    throw new ServiceHostError(
      "The Main workload identity does not match its native service configuration.",
    );
  }
  const nodePath = join(
    configuration.releaseRoot,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const entryPath = join(configuration.releaseRoot, "apps", "main", "opendelegate.mjs");
  const child = spawn(nodePath, [entryPath, "serve", "--home", configuration.stateRoot], {
    cwd: configuration.releaseRoot,
    env: buildCoreChildServiceEnvironment(scrubIdentityEnvironment(process.env), configuration),
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
  const completed = childCompletion(child);
  const ready = mainChildReadiness(child, completed, {
    instanceId: configuration.instanceId,
    deviceId: configuration.deviceId,
    releaseVersion: configuration.releaseVersion,
    origin: mainConfiguration.main.origin,
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    await Promise.race([completed.catch(() => undefined), delay(30_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await completed.catch(() => undefined);
    }
  };
  signal.addEventListener("abort", () => void stop(), { once: true });
  return { ready, completed, stop };
}

async function startWorkerWorkload(
  configuration: ServiceHostConfiguration,
  signal: AbortSignal,
): Promise<CoreWorkloadHandle> {
  const workerController = new AbortController();
  const stopWorker = () => workerController.abort();
  if (signal.aborted) {
    workerController.abort();
  } else {
    signal.addEventListener("abort", stopWorker, { once: true });
  }
  const workerReleaseRoot = await resolveWorkerReleaseRoot(configuration.releaseRoot);
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: workerReleaseRoot,
    home: configuration.stateRoot,
  });
  await verifyWorkerServiceSecretBinding(configuration, paths);
  const identityKeyStatus = await inspectConfiguredWorkerIdentityKey({
    paths,
    environment: buildCoreChildServiceEnvironment(process.env, configuration),
  });
  writeWorkerServiceEvent("worker.identity-key-diagnostic", {
    status: identityKeyStatus,
  });
  const computerUseRuntime = await tryStartWorkerComputerUseRuntime(
    configuration,
    paths,
    workerController.signal,
  );
  const readiness = Promise.withResolvers<void>();
  let readySettled = false;
  const resolveReady = () => {
    if (!readySettled) {
      readySettled = true;
      readiness.resolve();
    }
  };
  const rejectReady = (error: unknown) => {
    if (!readySettled) {
      readySettled = true;
      readiness.reject(
        error instanceof Error
          ? error
          : new ServiceHostError("The Worker workload failed before becoming ready."),
      );
    }
  };
  const completed = runWorkerDaemon({
    paths,
    releaseVersion: configuration.releaseVersion,
    environment: buildCoreChildServiceEnvironment(process.env, configuration),
    signal: workerController.signal,
    onReady: resolveReady,
    onConnectionDiagnostic: (diagnostic: WorkerConnectionDiagnostic) => {
      writeWorkerServiceEvent("worker.connection-diagnostic", {
        code: diagnostic.code,
        retryable: diagnostic.retryable,
      });
      if (workerServiceReadinessDisposition(diagnostic) === "ready") {
        // The reconnect loop itself is the healthy persistent workload while
        // Main or its route is temporarily unavailable. Main still treats this
        // Device as offline until an authenticated heartbeat arrives.
        resolveReady();
      } else {
        rejectReady(new ServiceHostError(`The Worker connection is blocked (${diagnostic.code}).`));
      }
    },
    onCertificateRenewal: (outcome: WorkerCertificateRenewalOutcome) => {
      if (outcome.status === "not-due") {
        return;
      }
      writeWorkerServiceEvent(
        outcome.status === "renewed"
          ? "worker.certificate-renewed"
          : "worker.certificate-renewal-deferred",
        outcome.status === "renewed"
          ? {
              certificateGeneration: outcome.generation,
              expiresAt: new Date(outcome.notAfter).toISOString(),
            }
          : { reason: outcome.reason },
      );
    },
    ...(computerUseRuntime === undefined ? {} : { computerUseRuntime }),
  }).finally(async () => {
    signal.removeEventListener("abort", stopWorker);
    await computerUseRuntime?.close().catch(() => undefined);
  });
  void completed.then(
    () => rejectReady(new ServiceHostError("The Worker workload exited before becoming ready.")),
    rejectReady,
  );
  return {
    ready: readiness.promise,
    completed,
    stop: async () => {
      workerController.abort();
      await computerUseRuntime?.close().catch(() => undefined);
      await completed.catch(() => undefined);
    },
  };
}

export function workerServiceReadinessDisposition(
  diagnostic: WorkerConnectionDiagnostic,
): "blocked" | "ready" {
  return diagnostic.retryable ? "ready" : "blocked";
}

async function verifyWorkerServiceSecretBinding(
  configuration: ServiceHostConfiguration,
  paths: ReturnType<typeof resolveWorkerPaths>,
): Promise<void> {
  if (configuration.platform !== "macos") {
    return;
  }
  const worker = await loadWorkerConfiguration(paths);
  const runtimeBinding = configuration.serviceSecretBinding;
  if (
    runtimeBinding === undefined ||
    runtimeBinding["backend"] !== "macos-system-keychain" ||
    worker.secretBackend.backend !== "macos-system-keychain" ||
    worker.secretBackend.bindingPath !== runtimeBinding["bindingPath"] ||
    worker.secretBackend.helperPath !== runtimeBinding["helperPath"] ||
    worker.secretBackend.expectedHelperSha256 !== runtimeBinding["expectedHelperSha256"] ||
    worker.secretBackend.servicePreparation.serviceIdentity.userName !==
      runtimeBinding["serviceUserName"]
  ) {
    throw new ServiceHostError(
      "The Worker System Keychain binding does not match its native service configuration.",
    );
  }
}

/**
 * Native service hosts must not look like foreground Workers to Main. Keep the
 * marker explicit because Windows SCM and launchd do not expose systemd's
 * INVOCATION_ID convention.
 */
export function buildCoreChildServiceEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  configuration?: Pick<
    ServiceHostConfiguration,
    "agentProviderAccess" | "ownerSession" | "platform"
  >,
): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {
    ...environment,
    OPENDELEGATE_SERVICE_MODE: "system-service",
  };
  const ownerHome = parseWindowsOwnerHome(configuration?.ownerSession.homeDirectory);
  if (configuration?.platform === "windows" && ownerHome !== undefined) {
    const setBoundValue = (name: string, value: string): void => {
      for (const key of Object.keys(result)) {
        if (key !== name && key.toLowerCase() === name.toLowerCase()) {
          delete result[key];
        }
      }
      result[name] = value;
    };
    if (configuration.agentProviderAccess !== undefined) {
      setBoundValue("CODEX_HOME", configuration.agentProviderAccess.codexServiceHomeDirectory);
      setBoundValue("CLAUDE_CONFIG_DIR", configuration.agentProviderAccess.claudeHomeDirectory);
    }
    const pathKey = Object.keys(result).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const existingEntries = (result[pathKey] ?? "")
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const entries = [
      win32.join(ownerHome, ".local", "bin"),
      win32.join(ownerHome, "AppData", "Roaming", "npm"),
      ...existingEntries,
    ];
    const observed = new Set<string>();
    result[pathKey] = entries
      .filter((entry) => {
        const key = win32.normalize(entry).toLocaleLowerCase("en-US");
        if (observed.has(key)) {
          return false;
        }
        observed.add(key);
        return true;
      })
      .join(";");
  }
  return Object.freeze(result);
}

function writeWorkerServiceEvent(event: string, fields: Readonly<Record<string, unknown>>): void {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event,
      ...fields,
    })}\n`,
  );
}

export async function waitForCoreWorkloadReadiness(
  workload: CoreWorkloadHandle,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ServiceHostError("The core workload readiness timeout is invalid.");
  }
  if (signal.aborted) {
    return false;
  }
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new ServiceHostError("The core workload did not become ready before timeout."));
      }, timeoutMs);
    });
    const aborted = new Promise<"aborted">((resolveAbort) => {
      onAbort = () => resolveAbort("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const completedBeforeReady = workload.completed.then(
      () => {
        throw new ServiceHostError("The core workload exited before becoming ready.");
      },
      (error: unknown) => {
        throw error;
      },
    );
    const result = await Promise.race([
      workload.ready.then(() => "ready" as const),
      completedBeforeReady,
      aborted,
      timeoutFailure,
    ]);
    return result === "ready";
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function mainChildReadiness(
  child: ChildProcess,
  completed: Promise<void>,
  expected: {
    readonly instanceId: string;
    readonly deviceId: string;
    readonly releaseVersion: string;
    readonly origin: string;
  },
): Promise<void> {
  const readiness = Promise.withResolvers<void>();
  let settled = false;
  const finish = (error?: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    child.off("message", onMessage);
    if (error === undefined) {
      readiness.resolve();
      return;
    }
    readiness.reject(
      error instanceof Error
        ? error
        : new ServiceHostError("The Main workload readiness signal was invalid."),
    );
  };
  const onMessage = (message: unknown) => {
    if (!isMainServiceReadyMessage(message, expected)) {
      finish(new ServiceHostError("The Main workload readiness identity is invalid."));
      return;
    }
    finish();
  };
  child.on("message", onMessage);
  void completed.then(
    () => finish(new ServiceHostError("The Main workload exited before becoming ready.")),
    finish,
  );
  return readiness.promise;
}

async function tryStartWorkerComputerUseRuntime(
  configuration: ServiceHostConfiguration,
  paths: ReturnType<typeof resolveWorkerPaths>,
  signal: AbortSignal,
): Promise<(WorkerComputerUseRuntimePort & { close(): Promise<void> }) | undefined> {
  if (configuration.localIpc.sessionHelper === "disabled") {
    return undefined;
  }
  let authority: PersistentDesktopAuthorityStore | undefined;
  try {
    const workerConfiguration = await loadWorkerConfiguration(paths);
    if (workerConfiguration.deviceId !== configuration.deviceId) {
      return undefined;
    }
    const store = createWorkerManagedSecretStore(
      workerConfiguration.secretBackend,
      workerConfiguration.deviceId,
      paths,
      process.env,
    );
    if ((await store.health()).status !== "ready") {
      writeWorkerServiceEvent("worker.computer-use-runtime-unavailable", {
        reason: "secret-store-unavailable",
      });
      return undefined;
    }
    const coreKey = await readWorkerComputerUseCoreKeyBinding(store);
    if (
      coreKey.alias !== WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS ||
      coreKey.keyId !== configuration.localIpc.core.keyId ||
      coreKey.publicKeySpkiBase64Url !== configuration.localIpc.core.publicKeySpkiBase64Url
    ) {
      writeWorkerServiceEvent("worker.computer-use-runtime-unavailable", {
        reason: "core-signing-key-mismatch",
      });
      return undefined;
    }
    if (!(await store.availability(WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS)).ready) {
      writeWorkerServiceEvent("worker.computer-use-runtime-unavailable", {
        reason: "desktop-authority-secret-unavailable",
      });
      return undefined;
    }
    const signing = new ManagedSecretEd25519SigningKeyProvider({
      store,
      references: {
        [configuration.localIpc.core.privateKeyReference]:
          WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
      },
    });
    authority = await PersistentDesktopAuthorityStore.openCore({
      authorityRoot: configuration.authorityRoot,
      sourceCheckoutRoot: paths.sourceCheckoutRoot,
      deviceId: configuration.deviceId,
      instanceId: configuration.instanceId,
      releaseVersion: configuration.releaseVersion,
      keys: new ManagedSecretAuthoritySigningKeyProvider({
        store,
        alias: WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS,
      }),
    });
    return await SignedSessionHelperCoreBridge.start({
      instanceId: configuration.instanceId,
      deviceId: configuration.deviceId,
      releaseVersion: configuration.releaseVersion,
      runtimeRoot: configuration.runtimeRoot,
      osFamily: configuration.platform,
      backendId: `${configuration.platform}-signed-session-helper-v2`,
      endpoint: sessionHelperEndpoint(configuration),
      transport: createNodeSessionHelperIpcTransport(),
      privateKeyReference: configuration.localIpc.core.privateKeyReference,
      localKeyId: configuration.localIpc.core.keyId,
      signingKeyProvider: signing,
      helperPublicKey: {
        keyId: configuration.localIpc.core.peerKeyId,
        publicKeySpkiBase64Url: configuration.localIpc.core.peerPublicKeySpkiBase64Url,
        usage: "active",
      },
      peerAuthorizer: {
        authorize: (request) =>
          request.peerIdentity.transport ===
          (configuration.platform === "windows" ? "windows-named-pipe" : "unix-domain-socket"),
      },
      authority,
      signal,
    });
  } catch (error: unknown) {
    writeWorkerServiceEvent("worker.computer-use-runtime-unavailable", {
      reason: "initialization-failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
      detail:
        error instanceof Error && error.message.length > 0
          ? error.message.slice(0, 512)
          : "The Computer Use runtime could not be initialized.",
    });
    await authority?.close().catch(() => undefined);
    return undefined;
  }
}

export async function resolveWorkerReleaseRoot(
  releaseRoot: string,
  canonicalize: (path: string) => Promise<string> = realpath,
): Promise<string> {
  return resolve(await canonicalize(releaseRoot));
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

export async function verifyServiceHostReleaseIdentity(
  configuration: ServiceHostConfiguration,
): Promise<void> {
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      await readFile(join(configuration.releaseRoot, "release-metadata.json"), "utf8"),
    );
  } catch {
    throw new ServiceHostError("The active release identity is unavailable.");
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>)["product"] !== "OpenDelegate" ||
    (metadata as Record<string, unknown>)["productVersion"] !== configuration.releaseVersion ||
    (metadata as Record<string, unknown>)["platform"] !== platform() ||
    (metadata as Record<string, unknown>)["architecture"] !== arch()
  ) {
    throw new ServiceHostError("The active release identity does not match service configuration.");
  }
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

function childCompletion(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new ServiceHostError("The Main workload could not start.")));
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM" || signal === "SIGKILL") {
        resolve();
      } else {
        reject(new ServiceHostError("The Main workload exited unexpectedly."));
      }
    });
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function scrubIdentityEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result["OPENDELEGATE_BUILD_ID"];
  delete result["OPENDELEGATE_VERSION"];
  return result;
}
