import type { DesktopAuthorityPort, NativeComputerUseDriver } from "@opendelegate/computer-use-os";
import {
  SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION,
  createSignedCoreSessionHelperIpc,
  type SessionHelperIpcEndpoint,
  type SessionHelperIpcTransport,
  type SessionHelperPeerPublicKey,
  type SessionHelperSigningKeyProvider,
  type SignedSessionHelperPeerAuthorizer,
} from "@opendelegate/session-helper-ipc";

import type { PersistentDesktopAuthorityStore } from "./authority-store.ts";
import { SessionHelperCoreClient } from "./core-client.ts";
import {
  readHelperPlanePresence,
  writeCorePlanePresence,
  type CorePlanePresence,
  type OwnedPlanePresence,
} from "./signed-plane-presence.ts";

const DEFAULT_RECONNECT_INTERVAL_MS = 1_000;

export interface SessionHelperRuntimeBinding {
  readonly driver: NativeComputerUseDriver;
  readonly authority: DesktopAuthorityPort;
  readonly binding: {
    readonly helperInstanceId: string;
    readonly serviceEpoch: number;
    readonly persistenceGeneration: number;
  };
}

export interface SessionHelperRuntimeLease extends SessionHelperRuntimeBinding {
  release(): Promise<void>;
}

export interface SessionHelperRuntimePort {
  acquire(): Promise<SessionHelperRuntimeLease | undefined>;
}

export interface SignedSessionHelperCoreBridgeOptions {
  readonly instanceId: string;
  readonly deviceId: string;
  readonly releaseVersion: string;
  readonly runtimeRoot: string;
  readonly osFamily: NativeComputerUseDriver["osFamily"];
  readonly backendId: string;
  readonly endpoint: SessionHelperIpcEndpoint;
  readonly transport: SessionHelperIpcTransport;
  readonly privateKeyReference: string;
  readonly localKeyId: `sha256:${string}`;
  readonly signingKeyProvider: SessionHelperSigningKeyProvider;
  readonly helperPublicKey: SessionHelperPeerPublicKey;
  readonly peerAuthorizer: SignedSessionHelperPeerAuthorizer;
  readonly authority: PersistentDesktopAuthorityStore;
  readonly reconnectIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
  readonly processId?: number;
  readonly processIsAlive?: (processId: number) => boolean | Promise<boolean>;
}

interface ActiveRuntime {
  readonly identity: string;
  readonly client: SessionHelperCoreClient;
  readonly binding: SessionHelperRuntimeBinding["binding"];
  leases: number;
}

export class SignedSessionHelperCoreBridge implements SessionHelperRuntimePort {
  readonly #options: Required<
    Pick<SignedSessionHelperCoreBridgeOptions, "clock" | "processId" | "reconnectIntervalMs">
  > &
    Omit<SignedSessionHelperCoreBridgeOptions, "clock" | "processId" | "reconnectIntervalMs">;
  readonly #controller = new AbortController();
  readonly #ipc: ReturnType<typeof createSignedCoreSessionHelperIpc>;
  #presence: OwnedPlanePresence | undefined;
  #active: ActiveRuntime | undefined;
  #loop: Promise<void> | undefined;
  #closed = false;

  private constructor(options: SignedSessionHelperCoreBridgeOptions) {
    const reconnectIntervalMs = options.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    if (
      !Number.isSafeInteger(reconnectIntervalMs) ||
      reconnectIntervalMs < 100 ||
      reconnectIntervalMs > 60_000
    ) {
      throw new TypeError("The session-helper reconnect interval is invalid.");
    }
    this.#options = {
      ...options,
      reconnectIntervalMs,
      clock: options.clock ?? Date.now,
      processId: options.processId ?? process.pid,
    };
    this.#ipc = createSignedCoreSessionHelperIpc({
      localPrivateKeyReference: options.privateKeyReference,
      localKeyId: options.localKeyId,
      signingKeyProvider: options.signingKeyProvider,
      acceptedPeerKeys: [options.helperPublicKey],
      peerAuthorizer: options.peerAuthorizer,
    });
    options.signal?.addEventListener("abort", () => void this.close(), { once: true });
  }

  public static async start(
    options: SignedSessionHelperCoreBridgeOptions,
  ): Promise<SignedSessionHelperCoreBridge> {
    validateOptions(options);
    const bridge = new SignedSessionHelperCoreBridge(options);
    const payload: CorePlanePresence = Object.freeze({
      schemaVersion: 2,
      protocolVersion: 2,
      plane: "core",
      instanceId: options.instanceId,
      deviceId: options.deviceId,
      releaseVersion: options.releaseVersion,
      processId: bridge.#options.processId,
      updatedAtUnixMs: bridge.#options.clock(),
      serviceEpoch: options.authority.serviceEpoch,
      keyId: options.localKeyId,
    });
    bridge.#presence = await writeCorePlanePresence({
      runtimeRoot: options.runtimeRoot,
      payload,
      privateKeyReference: options.privateKeyReference,
      signingKeyProvider: options.signingKeyProvider,
    });
    bridge.#loop = bridge.#run();
    return bridge;
  }

  public async acquire(): Promise<SessionHelperRuntimeLease | undefined> {
    const active = this.#active;
    if (this.#closed || active === undefined || active.client.isClosed) {
      return undefined;
    }
    active.leases += 1;
    let released = false;
    return Object.freeze({
      driver: active.client,
      authority: this.#options.authority,
      binding: active.binding,
      async release() {
        if (released) {
          return;
        }
        released = true;
        active.leases = Math.max(0, active.leases - 1);
      },
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      await this.#loop?.catch(() => undefined);
      return;
    }
    this.#closed = true;
    this.#controller.abort();
    await this.#loop?.catch(() => undefined);
    await this.#retireActive();
    await this.#presence?.remove();
    await this.#options.authority.close();
  }

  async #run(): Promise<void> {
    while (!this.#closed && !this.#controller.signal.aborted) {
      try {
        const helper = await readHelperPlanePresence({
          runtimeRoot: this.#options.runtimeRoot,
          expected: {
            instanceId: this.#options.instanceId,
            deviceId: this.#options.deviceId,
            releaseVersion: this.#options.releaseVersion,
          },
          peerKey: this.#options.helperPublicKey,
          ...(this.#options.processIsAlive === undefined
            ? {}
            : { processIsAlive: this.#options.processIsAlive }),
        });
        const identity =
          helper === null
            ? undefined
            : `${helper.helperInstanceId}\0${helper.sessionId}\0${helper.processId}`;
        if (
          this.#active !== undefined &&
          (this.#active.client.isClosed || identity !== this.#active.identity)
        ) {
          await this.#retireActive();
        }
        if (helper !== null && this.#active === undefined) {
          await this.#connect(helper.helperInstanceId, helper.sessionId, identity!);
        }
      } catch {
        await this.#retireActive();
      }
      await abortableDelay(this.#options.reconnectIntervalMs, this.#controller.signal);
    }
  }

  async #connect(helperInstanceId: string, sessionId: string, identity: string): Promise<void> {
    const channel = await this.#ipc.connect({
      binding: {
        protocolVersion: SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION,
        deviceId: this.#options.deviceId,
        helperId: helperInstanceId,
        sessionId,
        serviceEpoch: this.#options.authority.serviceEpoch,
        releaseVersion: this.#options.releaseVersion,
      },
      endpoint: this.#options.endpoint,
      dialer: this.#options.transport,
      signal: this.#controller.signal,
    });
    const client = new SessionHelperCoreClient({
      channel,
      osFamily: this.#options.osFamily,
      backendId: this.#options.backendId,
    });
    try {
      const authority = await this.#options.authority.activateHelper({
        helperInstanceId,
        sessionId,
      });
      this.#active = {
        identity,
        client,
        binding: Object.freeze({
          helperInstanceId,
          serviceEpoch: authority.serviceEpoch,
          persistenceGeneration: authority.persistenceGeneration,
        }),
        leases: 0,
      };
    } catch (error: unknown) {
      client.close();
      throw error;
    }
  }

  async #retireActive(): Promise<void> {
    const active = this.#active;
    if (active === undefined) {
      return;
    }
    this.#active = undefined;
    active.client.close();
    await this.#options.authority
      .withdrawHelper(active.binding.helperInstanceId)
      .catch(() => undefined);
  }
}

function validateOptions(options: SignedSessionHelperCoreBridgeOptions): void {
  if (
    !isIdentifier(options.instanceId) ||
    !isIdentifier(options.deviceId) ||
    !isIdentifier(options.releaseVersion) ||
    !isIdentifier(options.backendId) ||
    !/^secret:\/\/[A-Za-z0-9._~/-]+$/u.test(options.privateKeyReference) ||
    !/^sha256:[a-f0-9]{64}$/u.test(options.localKeyId) ||
    options.helperPublicKey.usage !== "active" ||
    options.helperPublicKey.keyId === options.localKeyId ||
    options.authority.serviceEpoch <= 0 ||
    options.authority.persistenceGeneration <= 0
  ) {
    throw new TypeError("The signed session-helper core bridge configuration is invalid.");
  }
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
