import {
  SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION,
  createSignedHelperSessionHelperIpc,
  type SessionHelperIpcConnection,
  type SessionHelperIpcEndpoint,
  type SessionHelperIpcListener,
  type SessionHelperIpcTransport,
  type SessionHelperPeerPublicKey,
  type SessionHelperSigningKeyProvider,
  type SignedSessionHelperPeerAuthorizer,
} from "@opendelegate/session-helper-ipc";
import type { NativeComputerUseDriver } from "@opendelegate/computer-use-os";

import { serveSessionHelperChannel, type SessionHelperChannelServer } from "./helper-server.ts";
import {
  readCorePlanePresence,
  writeHelperPlanePresence,
  type CorePlanePresence,
  type HelperPlanePresence,
  type OwnedPlanePresence,
} from "./signed-plane-presence.ts";

const DEFAULT_CORE_POLL_INTERVAL_MS = 1_000;

export interface SignedSessionHelperPlaneHostOptions {
  readonly instanceId: string;
  readonly deviceId: string;
  readonly releaseVersion: string;
  readonly runtimeRoot: string;
  readonly helperInstanceId: string;
  readonly sessionId: string;
  readonly endpoint: SessionHelperIpcEndpoint;
  readonly transport: SessionHelperIpcTransport;
  readonly privateKeyReference: string;
  readonly localKeyId: `sha256:${string}`;
  readonly signingKeyProvider: SessionHelperSigningKeyProvider;
  readonly corePublicKey: SessionHelperPeerPublicKey;
  readonly peerAuthorizer: SignedSessionHelperPeerAuthorizer;
  /**
   * Creates the private native capability for one exact core service epoch.
   * A core replacement closes this driver before another epoch can be served.
   */
  readonly createDriver: (
    binding: SessionHelperNativeDriverBinding,
  ) => Promise<NativeComputerUseDriver>;
  readonly corePollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
  readonly processId?: number;
  readonly processIsAlive?: (processId: number) => boolean | Promise<boolean>;
  readonly prepareEndpoint?: () => Promise<void>;
  readonly secureEndpoint?: () => Promise<void>;
}

export interface SessionHelperNativeDriverBinding {
  readonly helperInstanceId: string;
  readonly osSessionIdentity: string;
  readonly releaseVersion: string;
  readonly serviceEpoch: number;
  readonly signal: AbortSignal;
}

export class SignedSessionHelperPlaneHost {
  readonly #options: Required<
    Pick<SignedSessionHelperPlaneHostOptions, "clock" | "corePollIntervalMs" | "processId">
  > &
    Omit<SignedSessionHelperPlaneHostOptions, "clock" | "corePollIntervalMs" | "processId">;
  readonly #controller = new AbortController();
  readonly #ipc: ReturnType<typeof createSignedHelperSessionHelperIpc>;
  #listener: SessionHelperIpcListener | undefined;
  #presence: OwnedPlanePresence | undefined;
  #active: SessionHelperChannelServer | undefined;
  #driver: NativeComputerUseDriver | undefined;
  #driverAbort: AbortController | undefined;
  #driverEpoch: number | undefined;
  #driverCreation:
    | {
        readonly epoch: number;
        readonly promise: Promise<NativeComputerUseDriver>;
      }
    | undefined;
  #core: CorePlanePresence | null = null;
  #loop: Promise<void> | undefined;
  #closed = false;

  private constructor(options: SignedSessionHelperPlaneHostOptions) {
    const corePollIntervalMs = options.corePollIntervalMs ?? DEFAULT_CORE_POLL_INTERVAL_MS;
    if (
      !Number.isSafeInteger(corePollIntervalMs) ||
      corePollIntervalMs < 100 ||
      corePollIntervalMs > 60_000
    ) {
      throw new TypeError("The session-helper core poll interval is invalid.");
    }
    this.#options = {
      ...options,
      corePollIntervalMs,
      clock: options.clock ?? Date.now,
      processId: options.processId ?? process.pid,
    };
    this.#ipc = createSignedHelperSessionHelperIpc({
      localPrivateKeyReference: options.privateKeyReference,
      localKeyId: options.localKeyId,
      signingKeyProvider: options.signingKeyProvider,
      acceptedPeerKeys: [options.corePublicKey],
      peerAuthorizer: options.peerAuthorizer,
    });
    options.signal?.addEventListener("abort", () => void this.close(), { once: true });
  }

  public static async start(
    options: SignedSessionHelperPlaneHostOptions,
  ): Promise<SignedSessionHelperPlaneHost> {
    validateOptions(options);
    const host = new SignedSessionHelperPlaneHost(options);
    host.#core = await host.#readCore();
    await options.prepareEndpoint?.();
    host.#listener = await options.transport.listen(options.endpoint, (connection) =>
      host.#accept(connection),
    );
    const payload: HelperPlanePresence = Object.freeze({
      schemaVersion: 2,
      protocolVersion: 2,
      plane: "session-helper",
      instanceId: options.instanceId,
      deviceId: options.deviceId,
      releaseVersion: options.releaseVersion,
      processId: host.#options.processId,
      updatedAtUnixMs: host.#options.clock(),
      helperInstanceId: options.helperInstanceId,
      sessionId: options.sessionId,
      keyId: options.localKeyId,
    });
    try {
      await options.secureEndpoint?.();
      host.#presence = await writeHelperPlanePresence({
        runtimeRoot: options.runtimeRoot,
        payload,
        privateKeyReference: options.privateKeyReference,
        signingKeyProvider: options.signingKeyProvider,
      });
    } catch (error: unknown) {
      await host.#listener.close().catch(() => undefined);
      throw error;
    }
    host.#loop = host.#watchCore();
    return host;
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      await this.#loop?.catch(() => undefined);
      return;
    }
    this.#closed = true;
    this.#controller.abort();
    await this.#loop?.catch(() => undefined);
    await this.#active?.close().catch(() => undefined);
    this.#active = undefined;
    await this.#listener?.close().catch(() => undefined);
    this.#listener = undefined;
    await this.#presence?.remove();
    await this.#closeDriver();
  }

  async #accept(connection: SessionHelperIpcConnection): Promise<void> {
    const expectedCore = this.#core;
    if (this.#closed || expectedCore === null) {
      connection.close();
      return;
    }
    try {
      const channel = await this.#ipc.accept({
        binding: {
          protocolVersion: SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION,
          deviceId: this.#options.deviceId,
          helperId: this.#options.helperInstanceId,
          sessionId: this.#options.sessionId,
          serviceEpoch: expectedCore.serviceEpoch,
          releaseVersion: this.#options.releaseVersion,
        },
        connection,
        signal: this.#controller.signal,
      });
      if (
        this.#closed ||
        this.#core === null ||
        this.#core.processId !== expectedCore.processId ||
        this.#core.serviceEpoch !== expectedCore.serviceEpoch
      ) {
        channel.close();
        return;
      }
      const driver = await this.#driverFor(expectedCore);
      if (
        this.#closed ||
        this.#core === null ||
        this.#core.processId !== expectedCore.processId ||
        this.#core.serviceEpoch !== expectedCore.serviceEpoch
      ) {
        channel.close();
        return;
      }
      const replacement = serveSessionHelperChannel({
        channel,
        driver,
      });
      const previous = this.#active;
      this.#active = replacement;
      await previous?.close().catch(() => undefined);
    } catch {
      connection.close();
    }
  }

  async #watchCore(): Promise<void> {
    while (!this.#closed && !this.#controller.signal.aborted) {
      const next = await this.#readCore();
      if (
        this.#core !== null &&
        (next === null ||
          next.processId !== this.#core.processId ||
          next.serviceEpoch !== this.#core.serviceEpoch ||
          next.keyId !== this.#core.keyId)
      ) {
        await this.#active?.close().catch(() => undefined);
        this.#active = undefined;
        await this.#closeDriver();
      }
      this.#core = next;
      await abortableDelay(this.#options.corePollIntervalMs, this.#controller.signal);
    }
  }

  async #readCore(): Promise<CorePlanePresence | null> {
    return await readCorePlanePresence({
      runtimeRoot: this.#options.runtimeRoot,
      expected: {
        instanceId: this.#options.instanceId,
        deviceId: this.#options.deviceId,
        releaseVersion: this.#options.releaseVersion,
      },
      peerKey: this.#options.corePublicKey,
      ...(this.#options.processIsAlive === undefined
        ? {}
        : { processIsAlive: this.#options.processIsAlive }),
    });
  }

  async #driverFor(core: CorePlanePresence): Promise<NativeComputerUseDriver> {
    if (this.#driver !== undefined && this.#driverEpoch === core.serviceEpoch) {
      return this.#driver;
    }
    if (this.#driverCreation !== undefined && this.#driverCreation.epoch === core.serviceEpoch) {
      return await this.#driverCreation.promise;
    }
    await this.#closeDriver();
    const driverAbort = new AbortController();
    this.#driverAbort = driverAbort;
    if (this.#controller.signal.aborted) {
      driverAbort.abort();
    }
    const promise = this.#options.createDriver(
      Object.freeze({
        helperInstanceId: this.#options.helperInstanceId,
        osSessionIdentity: this.#options.sessionId,
        releaseVersion: this.#options.releaseVersion,
        serviceEpoch: core.serviceEpoch,
        signal: driverAbort.signal,
      }),
    );
    this.#driverCreation = { epoch: core.serviceEpoch, promise };
    try {
      const driver = await promise;
      if (
        this.#closed ||
        this.#core === null ||
        this.#core.processId !== core.processId ||
        this.#core.serviceEpoch !== core.serviceEpoch
      ) {
        await closeNativeDriver(driver);
        throw new Error("The core service epoch changed while the native driver started.");
      }
      this.#driver = driver;
      this.#driverEpoch = core.serviceEpoch;
      return driver;
    } finally {
      if (this.#driverCreation?.promise === promise) {
        this.#driverCreation = undefined;
      }
    }
  }

  async #closeDriver(): Promise<void> {
    this.#driverAbort?.abort();
    this.#driverAbort = undefined;
    const creation = this.#driverCreation;
    this.#driverCreation = undefined;
    if (creation !== undefined) {
      const pending = await creation.promise.catch(() => undefined);
      if (pending !== undefined && pending !== this.#driver) {
        await closeNativeDriver(pending);
      }
    }
    const driver = this.#driver;
    this.#driver = undefined;
    this.#driverEpoch = undefined;
    if (driver !== undefined) {
      await closeNativeDriver(driver);
    }
  }
}

function validateOptions(options: SignedSessionHelperPlaneHostOptions): void {
  if (
    !isIdentifier(options.instanceId) ||
    !isIdentifier(options.deviceId) ||
    !isIdentifier(options.releaseVersion) ||
    !isIdentifier(options.helperInstanceId) ||
    !isIdentifier(options.sessionId) ||
    !/^secret:\/\/[A-Za-z0-9._~/-]+$/u.test(options.privateKeyReference) ||
    !/^sha256:[a-f0-9]{64}$/u.test(options.localKeyId) ||
    options.corePublicKey.usage !== "active" ||
    options.corePublicKey.keyId === options.localKeyId ||
    typeof options.createDriver !== "function"
  ) {
    throw new TypeError("The signed session-helper plane host configuration is invalid.");
  }
}

async function closeNativeDriver(driver: NativeComputerUseDriver): Promise<void> {
  const close = (driver as NativeComputerUseDriver & { close?: () => Promise<void> }).close;
  await close?.call(driver).catch(() => undefined);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  );
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
