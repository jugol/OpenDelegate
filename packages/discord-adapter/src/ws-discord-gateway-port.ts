import WebSocket, { type RawData } from "ws";

import {
  DISCORD_API_VERSION,
  DISCORD_GATEWAY_INTENTS,
  type DiscordGatewayConnectOptions,
  type DiscordGatewayConnection,
  type DiscordGatewayCursor,
  type DiscordGatewayDispatch,
  type DiscordGatewayPort,
} from "./contracts.ts";
import type { DiscordBotCredentialProvider } from "./credentials.ts";
import type { DiscordGatewayDiscovery } from "./fetch-discord-api-port.ts";
import {
  mapDiscordInteraction,
  mapDiscordMessage,
  mapDiscordThread,
  requireBoolean,
  requireRecord,
  requireSafeInteger,
  requireSnowflake,
  requireString,
} from "./discord-wire.ts";
import { DiscordApiError } from "./errors.ts";

const DEFAULT_MAXIMUM_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const MINIMUM_HEARTBEAT_INTERVAL_MS = 100;
const MAXIMUM_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const MAXIMUM_RECONNECT_DELAY_MS = 30_000;
const TERMINAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NON_RESUMABLE_CLOSE_CODES = new Set([1000, 1001, 4007, 4009]);

export interface DiscordGatewayDiagnostic {
  readonly event: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export interface DiscordGatewayScheduler {
  nowMs(): number;
  random(): number;
  setTimeout(callback: () => void, delayMs: number): object;
  clearTimeout(handle: object): void;
}

export interface DiscordGatewaySocket {
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string | Uint8Array, isBinary: boolean) => void): void;
  onClose(listener: (code: number) => void): void;
  onError(listener: () => void): void;
  send(data: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

export interface DiscordGatewaySocketFactory {
  connect(
    url: string,
    options: {
      readonly maximumFrameBytes: number;
      readonly handshakeTimeoutMs: number;
    },
  ): DiscordGatewaySocket;
}

export interface WsDiscordGatewayPortOptions {
  readonly credentialProvider: DiscordBotCredentialProvider;
  readonly discovery: DiscordGatewayDiscovery;
  readonly socketFactory?: DiscordGatewaySocketFactory;
  readonly scheduler?: DiscordGatewayScheduler;
  readonly maximumFrameBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly onDiagnostic?: (diagnostic: DiscordGatewayDiagnostic) => void;
}

type ResolvedWsDiscordGatewayPortOptions = Omit<
  WsDiscordGatewayPortOptions,
  "maximumFrameBytes" | "handshakeTimeoutMs" | "scheduler" | "socketFactory"
> & {
  readonly maximumFrameBytes: number;
  readonly handshakeTimeoutMs: number;
  readonly scheduler: DiscordGatewayScheduler;
  readonly socketFactory: DiscordGatewaySocketFactory;
};

interface PendingGatewayShutdown {
  readonly generation: number;
  readonly socket: DiscordGatewaySocket;
  resolve(): void;
  reject(error: unknown): void;
  timer: object | undefined;
}

interface PendingGatewayOpen {
  readonly attempt: number;
  readonly promise: Promise<void>;
  cancel(): void;
}

const GATEWAY_OPEN_CANCELLED = Symbol("gateway-open-cancelled");

export class WsDiscordGatewayPort implements DiscordGatewayPort {
  readonly #options: ResolvedWsDiscordGatewayPortOptions;

  public constructor(options: WsDiscordGatewayPortOptions) {
    const maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_MAXIMUM_FRAME_BYTES;
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    assertBoundedInteger(maximumFrameBytes, 128, 16 * 1024 * 1024, "Gateway frame bound");
    assertBoundedInteger(handshakeTimeoutMs, 1_000, 60_000, "Gateway handshake timeout");
    this.#options = {
      ...options,
      maximumFrameBytes,
      handshakeTimeoutMs,
      scheduler: options.scheduler ?? new NodeDiscordGatewayScheduler(),
      socketFactory: options.socketFactory ?? new NodeWsDiscordGatewaySocketFactory(),
    };
  }

  public async connect(options: DiscordGatewayConnectOptions): Promise<DiscordGatewayConnection> {
    if (
      options.apiVersion !== DISCORD_API_VERSION ||
      options.intentBitfield !== DISCORD_GATEWAY_INTENTS
    ) {
      throw new DiscordApiError(
        "INVALID_RESPONSE",
        "The Gateway driver requires the reviewed Discord API v10 intent set.",
      );
    }
    if (options.resume !== undefined) {
      validateCursor(options.resume);
    }
    const supervisor = new GatewaySupervisor(this.#options, options);
    await supervisor.start();
    return supervisor;
  }
}

class GatewaySupervisor implements DiscordGatewayConnection {
  readonly #configuration: ResolvedWsDiscordGatewayPortOptions;
  readonly #callbacks: DiscordGatewayConnectOptions;
  #socket: DiscordGatewaySocket | undefined;
  #heartbeatTimer: object | undefined;
  #reconnectTimer: object | undefined;
  #closed = false;
  #terminal = false;
  #generation = 0;
  #ignoreCloseGeneration: number | undefined;
  #heartbeatIntervalMs: number | undefined;
  #awaitingHeartbeatAck = false;
  #receivedSequence: number | null;
  #processedSequence: number;
  #sessionId: string | undefined;
  #resumeGatewayUrl: string | undefined;
  #reconnectAttempt = 0;
  #dispatchTail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #shutdownClose: PendingGatewayShutdown | undefined;
  #openAttempt = 0;
  #pendingOpen: PendingGatewayOpen | undefined;

  public constructor(
    configuration: ResolvedWsDiscordGatewayPortOptions,
    callbacks: DiscordGatewayConnectOptions,
  ) {
    this.#configuration = configuration;
    this.#callbacks = callbacks;
    this.#receivedSequence = callbacks.resume?.sequence ?? null;
    this.#processedSequence = callbacks.resume?.sequence ?? 0;
    this.#sessionId = callbacks.resume?.sessionId;
    this.#resumeGatewayUrl = callbacks.resume?.resumeGatewayUrl;
  }

  public async start(): Promise<void> {
    try {
      await this.#openSocket();
    } catch {
      throw new DiscordApiError("OFFLINE", "The Discord Gateway is unavailable.");
    }
  }

  public close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closePromise = this.#close();
    }
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#openAttempt += 1;
    this.#clearHeartbeat();
    this.#clearReconnect();
    const pendingOpen = this.#pendingOpen;
    pendingOpen?.cancel();
    await pendingOpen?.promise.catch(() => undefined);
    const socket = this.#socket;
    if (socket !== undefined) {
      await this.#closeSocket(socket, this.#generation);
      this.#socket = undefined;
    }
    await this.#dispatchTail.catch(() => undefined);
  }

  #closeSocket(socket: DiscordGatewaySocket, generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pending: PendingGatewayShutdown = {
        generation,
        socket,
        resolve: () => {
          if (this.#shutdownClose !== pending) {
            return;
          }
          this.#clearShutdownCloseTimer(pending);
          this.#shutdownClose = undefined;
          resolve();
        },
        reject: (error: unknown) => {
          if (this.#shutdownClose !== pending) {
            return;
          }
          this.#clearShutdownCloseTimer(pending);
          this.#shutdownClose = undefined;
          reject(error);
        },
        timer: undefined,
      };
      this.#shutdownClose = pending;
      pending.timer = this.#configuration.scheduler.setTimeout(
        () => this.#forceSocketTermination(pending),
        this.#configuration.handshakeTimeoutMs,
      );
      try {
        socket.close(1000, "OpenDelegate shutdown");
      } catch {
        this.#forceSocketTermination(pending);
      }
    });
  }

  #forceSocketTermination(pending: PendingGatewayShutdown): void {
    if (this.#shutdownClose !== pending) {
      return;
    }
    this.#clearShutdownCloseTimer(pending);
    try {
      pending.socket.terminate();
    } catch {
      pending.reject(
        new DiscordApiError("OFFLINE", "Discord Gateway shutdown could not be confirmed."),
      );
      return;
    }
    if (this.#shutdownClose !== pending) {
      return;
    }
    pending.timer = this.#configuration.scheduler.setTimeout(() => {
      pending.reject(
        new DiscordApiError("OFFLINE", "Discord Gateway shutdown could not be confirmed."),
      );
    }, this.#configuration.handshakeTimeoutMs);
  }

  #clearShutdownCloseTimer(pending: PendingGatewayShutdown): void {
    if (pending.timer !== undefined) {
      this.#configuration.scheduler.clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  #openSocket(): Promise<void> {
    if (this.#closed || this.#terminal) {
      return Promise.resolve();
    }
    if (this.#pendingOpen !== undefined) {
      return this.#pendingOpen.promise;
    }
    const attempt = this.#openAttempt + 1;
    this.#openAttempt = attempt;
    let cancel = (): void => undefined;
    const cancelled = new Promise<typeof GATEWAY_OPEN_CANCELLED>((resolve) => {
      cancel = () => resolve(GATEWAY_OPEN_CANCELLED);
    });
    const promise = Promise.resolve().then(() => this.#openSocketAttempt(attempt, cancelled));
    const pending: PendingGatewayOpen = { attempt, promise, cancel };
    this.#pendingOpen = pending;
    void promise.then(
      () => {
        if (this.#pendingOpen === pending) {
          this.#pendingOpen = undefined;
        }
      },
      () => {
        if (this.#pendingOpen === pending) {
          this.#pendingOpen = undefined;
        }
      },
    );
    return promise;
  }

  async #openSocketAttempt(
    attempt: number,
    cancelled: Promise<typeof GATEWAY_OPEN_CANCELLED>,
  ): Promise<void> {
    if (!this.#canOpen(attempt)) {
      return;
    }
    const discoveredBaseUrl =
      this.#sessionId === undefined || this.#resumeGatewayUrl === undefined
        ? await Promise.race([this.#configuration.discovery.getGatewayBotUrl(), cancelled])
        : this.#resumeGatewayUrl;
    if (discoveredBaseUrl === GATEWAY_OPEN_CANCELLED || !this.#canOpen(attempt)) {
      return;
    }
    const url = gatewayUrl(discoveredBaseUrl);
    if (!this.#canOpen(attempt)) {
      return;
    }
    const generation = this.#generation + 1;
    this.#generation = generation;
    this.#clearHeartbeat();
    this.#awaitingHeartbeatAck = false;
    this.#heartbeatIntervalMs = undefined;
    const socket = this.#configuration.socketFactory.connect(url, {
      maximumFrameBytes: this.#configuration.maximumFrameBytes,
      handshakeTimeoutMs: this.#configuration.handshakeTimeoutMs,
    });
    socket.onOpen(() => {
      this.#diagnostic("discord.gateway.socket_opened", { generation });
    });
    socket.onMessage((data, isBinary) => {
      if (generation !== this.#generation || this.#closed || this.#terminal) {
        return;
      }
      this.#receiveFrame(data, isBinary, generation);
    });
    socket.onClose((code) => {
      this.#onSocketClosed(generation, code);
    });
    socket.onError(() => {
      if (generation === this.#generation && !this.#closed && !this.#terminal) {
        this.#diagnostic("discord.gateway.socket_error", { generation });
      }
    });
    if (!this.#canOpen(attempt)) {
      await this.#closeSocket(socket, generation);
      return;
    }
    this.#socket = socket;
  }

  #canOpen(attempt: number): boolean {
    return attempt === this.#openAttempt && !this.#closed && !this.#terminal;
  }

  #receiveFrame(data: string | Uint8Array, isBinary: boolean, generation: number): void {
    if (isBinary) {
      this.#invalidPayload(generation);
      return;
    }
    const size = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    if (size > this.#configuration.maximumFrameBytes) {
      this.#diagnostic("discord.gateway.frame_too_large", {
        maximumFrameBytes: this.#configuration.maximumFrameBytes,
      });
      this.#restart(true, generation);
      return;
    }
    let text: string;
    try {
      text =
        typeof data === "string" ? data : new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      this.#invalidPayload(generation);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      this.#invalidPayload(generation);
      return;
    }
    let envelope: Record<string, unknown>;
    let opcode: number;
    try {
      envelope = requireRecord(value, "Gateway payload");
      opcode = requireSafeInteger(envelope, "op");
    } catch {
      this.#invalidPayload(generation);
      return;
    }

    if (opcode === 11) {
      this.#awaitingHeartbeatAck = false;
      return;
    }
    if (opcode === 1) {
      this.#sendHeartbeat(generation);
      return;
    }
    if (opcode === 7) {
      this.#diagnostic("discord.gateway.server_requested_reconnect", { generation });
      this.#restart(true, generation);
      return;
    }
    if (opcode === 9) {
      let resumable: boolean;
      try {
        resumable = requireBoolean({ resumable: envelope["d"] }, "resumable");
      } catch {
        this.#invalidPayload(generation);
        return;
      }
      const invalidSessionRandom = this.#configuration.scheduler.random();
      const retryDelayMs =
        1_000 +
        Math.floor(
          (Number.isFinite(invalidSessionRandom) &&
          invalidSessionRandom >= 0 &&
          invalidSessionRandom <= 1
            ? invalidSessionRandom
            : 1) * 4_000,
        );
      this.#diagnostic("discord.gateway.invalid_session_reconnect", {
        generation,
        resumable,
      });
      this.#restart(resumable, generation, retryDelayMs);
      return;
    }

    this.#dispatchTail = this.#dispatchTail
      .then(async () => {
        if (generation !== this.#generation || this.#closed || this.#terminal) {
          return;
        }
        if (opcode === 10) {
          await this.#handleHello(envelope, generation);
          return;
        }
        if (opcode === 0) {
          await this.#handleDispatch(envelope);
        }
      })
      .catch((error: unknown) => {
        if (generation === this.#generation && !this.#closed && !this.#terminal) {
          this.#diagnostic(
            error instanceof DiscordApiError && error.code === "INVALID_RESPONSE"
              ? "discord.gateway.invalid_payload"
              : "discord.gateway.dispatch_failed",
            { generation },
          );
          this.#restart(true, generation);
        }
      });
  }

  async #handleHello(envelope: Record<string, unknown>, generation: number): Promise<void> {
    const data = requireRecord(envelope["d"], "Gateway Hello");
    const heartbeatIntervalMs = requireSafeInteger(data, "heartbeat_interval");
    if (
      heartbeatIntervalMs < MINIMUM_HEARTBEAT_INTERVAL_MS ||
      heartbeatIntervalMs > MAXIMUM_HEARTBEAT_INTERVAL_MS
    ) {
      throw invalidGatewayPayload();
    }
    if (this.#heartbeatIntervalMs !== undefined) {
      throw invalidGatewayPayload();
    }
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    const jitter = this.#configuration.scheduler.random();
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
      throw invalidGatewayPayload();
    }
    this.#heartbeatTimer = this.#configuration.scheduler.setTimeout(
      () => {
        this.#heartbeatTimer = undefined;
        this.#sendHeartbeat(generation);
      },
      Math.floor(heartbeatIntervalMs * jitter),
    );
    await this.#sendAuthentication(generation);
  }

  async #sendAuthentication(generation: number): Promise<void> {
    try {
      await this.#configuration.credentialProvider.withBotToken(async (botToken) => {
        assertCredential(botToken);
        if (generation !== this.#generation || this.#closed || this.#terminal) {
          return;
        }
        if (this.#sessionId !== undefined && this.#resumeGatewayUrl !== undefined) {
          this.#send({
            op: 6,
            d: {
              token: botToken,
              session_id: this.#sessionId,
              seq: this.#processedSequence,
            },
          });
          return;
        }
        this.#send({
          op: 2,
          d: {
            token: botToken,
            intents: this.#callbacks.intentBitfield,
            properties: {
              os: process.platform,
              browser: "opendelegate",
              device: "opendelegate",
            },
          },
        });
      });
    } catch {
      this.#diagnostic("discord.gateway.credential_unavailable", { generation });
      this.#restart(true, generation);
    }
  }

  async #handleDispatch(envelope: Record<string, unknown>): Promise<void> {
    const sequence = requireSafeInteger(envelope, "s");
    if (sequence < 0) {
      throw invalidGatewayPayload();
    }
    const eventName = requireString(envelope, "t", 1, 100);
    if (this.#receivedSequence !== null && sequence < this.#receivedSequence) {
      throw invalidGatewayPayload();
    }
    this.#receivedSequence = sequence;
    if (eventName === "READY") {
      const data = requireRecord(envelope["d"], "Gateway Ready");
      const sessionId = requireString(data, "session_id", 1, 512);
      const resumeGatewayUrl = requireString(data, "resume_gateway_url", 1, 2_048);
      if (!isSecureGatewayUrl(resumeGatewayUrl)) {
        throw invalidGatewayPayload();
      }
      this.#sessionId = sessionId;
      this.#resumeGatewayUrl = resumeGatewayUrl;
      await this.#callbacks.onSessionEstablished({
        sessionId,
        resumeGatewayUrl,
        sequence,
      });
      this.#processedSequence = sequence;
      this.#reconnectAttempt = 0;
      await this.#callbacks.onReconcileRequired();
      return;
    }
    if (eventName === "RESUMED") {
      if (this.#sessionId === undefined || this.#resumeGatewayUrl === undefined) {
        throw invalidGatewayPayload();
      }
      await this.#callbacks.onSessionEstablished({
        sessionId: this.#sessionId,
        resumeGatewayUrl: this.#resumeGatewayUrl,
        sequence,
      });
      this.#processedSequence = sequence;
      this.#reconnectAttempt = 0;
      return;
    }

    const dispatch = mapSupportedDispatch({
      eventName,
      data: envelope["d"],
      sessionId: this.#sessionId,
      resumeGatewayUrl: this.#resumeGatewayUrl,
      sequence,
      receivedAtMs: this.#configuration.scheduler.nowMs(),
    });
    if (dispatch !== undefined) {
      await this.#callbacks.onDispatch(dispatch);
    }
    this.#processedSequence = sequence;
  }

  #sendHeartbeat(generation: number): void {
    if (
      generation !== this.#generation ||
      this.#closed ||
      this.#terminal ||
      this.#heartbeatIntervalMs === undefined
    ) {
      return;
    }
    if (this.#awaitingHeartbeatAck) {
      this.#diagnostic("discord.gateway.heartbeat_ack_timeout", { generation });
      this.#restart(true, generation);
      return;
    }
    this.#send({ op: 1, d: this.#receivedSequence });
    this.#awaitingHeartbeatAck = true;
    this.#heartbeatTimer = this.#configuration.scheduler.setTimeout(() => {
      this.#heartbeatTimer = undefined;
      this.#sendHeartbeat(generation);
    }, this.#heartbeatIntervalMs);
  }

  #send(payload: unknown): void {
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, "utf8") > 4_096) {
      throw invalidGatewayPayload();
    }
    try {
      this.#socket?.send(encoded);
    } catch {
      throw new DiscordApiError("OFFLINE", "The Discord Gateway send failed.");
    }
  }

  #onSocketClosed(generation: number, code: number): void {
    if (generation === this.#generation) {
      this.#socket = undefined;
    }
    if (this.#shutdownClose?.generation === generation) {
      this.#shutdownClose.resolve();
      return;
    }
    if (
      generation !== this.#generation ||
      this.#closed ||
      this.#terminal ||
      this.#ignoreCloseGeneration === generation
    ) {
      if (this.#ignoreCloseGeneration === generation) {
        this.#ignoreCloseGeneration = undefined;
      }
      return;
    }
    this.#clearHeartbeat();
    if (TERMINAL_CLOSE_CODES.has(code)) {
      this.#terminal = true;
      this.#diagnostic("discord.gateway.closed_terminal", { closeCode: code });
      return;
    }
    if (NON_RESUMABLE_CLOSE_CODES.has(code)) {
      this.#clearSession();
    }
    this.#diagnostic("discord.gateway.closed_reconnecting", { closeCode: code });
    this.#scheduleReconnect(
      this.#sessionId === undefined || this.#resumeGatewayUrl === undefined ? 5_000 : undefined,
    );
  }

  #restart(resumable: boolean, generation: number, retryDelayMs?: number): void {
    if (generation !== this.#generation || this.#closed || this.#terminal) {
      return;
    }
    this.#clearHeartbeat();
    if (!resumable) {
      this.#clearSession();
    }
    this.#ignoreCloseGeneration = generation;
    try {
      this.#socket?.terminate();
    } catch {
      // Reconnect scheduling remains authoritative even if teardown already raced.
    }
    const canResume =
      resumable && this.#sessionId !== undefined && this.#resumeGatewayUrl !== undefined;
    this.#scheduleReconnect(canResume ? retryDelayMs : Math.max(5_000, retryDelayMs ?? 0));
  }

  #scheduleReconnect(delayOverrideMs?: number): void {
    if (this.#closed || this.#terminal || this.#reconnectTimer !== undefined) {
      return;
    }
    this.#reconnectAttempt += 1;
    let delayMs: number;
    if (delayOverrideMs !== undefined) {
      delayMs = Math.min(MAXIMUM_RECONNECT_DELAY_MS, Math.max(1_000, delayOverrideMs));
    } else {
      const random = this.#configuration.scheduler.random();
      const boundedRandom = Number.isFinite(random) && random >= 0 && random <= 1 ? random : 1;
      const exponential = Math.min(
        MAXIMUM_RECONNECT_DELAY_MS,
        1_000 * 2 ** Math.min(this.#reconnectAttempt - 1, 5),
      );
      delayMs = Math.min(MAXIMUM_RECONNECT_DELAY_MS, Math.ceil(exponential * (1 + boundedRandom)));
    }
    this.#reconnectTimer = this.#configuration.scheduler.setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#openSocket().catch(() => {
        this.#diagnostic("discord.gateway.reconnect_failed", {
          attempt: this.#reconnectAttempt,
        });
        this.#scheduleReconnect();
      });
    }, delayMs);
  }

  #invalidPayload(generation: number): void {
    this.#diagnostic("discord.gateway.invalid_payload", { generation });
    this.#restart(true, generation);
  }

  #clearSession(): void {
    this.#sessionId = undefined;
    this.#resumeGatewayUrl = undefined;
    this.#processedSequence = 0;
    this.#receivedSequence = null;
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) {
      this.#configuration.scheduler.clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#awaitingHeartbeatAck = false;
    this.#heartbeatIntervalMs = undefined;
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer !== undefined) {
      this.#configuration.scheduler.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }

  #diagnostic(event: string, fields: Readonly<Record<string, string | number | boolean>>): void {
    try {
      this.#configuration.onDiagnostic?.(
        Object.freeze({
          event,
          fields: Object.freeze({ ...fields }),
        }),
      );
    } catch {
      // Diagnostics must never affect the Gateway lifecycle.
    }
  }
}

function mapSupportedDispatch(input: {
  readonly eventName: string;
  readonly data: unknown;
  readonly sessionId: string | undefined;
  readonly resumeGatewayUrl: string | undefined;
  readonly sequence: number;
  readonly receivedAtMs: number;
}): DiscordGatewayDispatch | undefined {
  if (!SUPPORTED_DISPATCHES.has(input.eventName)) {
    return undefined;
  }
  if (input.sessionId === undefined || input.resumeGatewayUrl === undefined) {
    throw invalidGatewayPayload();
  }
  const base = {
    sessionId: input.sessionId,
    resumeGatewayUrl: input.resumeGatewayUrl,
    sequence: input.sequence,
  };
  switch (input.eventName) {
    case "MESSAGE_CREATE":
      return Object.freeze({
        ...base,
        type: "MESSAGE_CREATE" as const,
        message: mapDiscordMessage(input.data),
      });
    case "THREAD_CREATE":
    case "THREAD_UPDATE": {
      const data = requireRecord(input.data, "thread");
      if (requireSafeInteger(data, "type") !== 11) {
        return undefined;
      }
      return Object.freeze({
        ...base,
        type: input.eventName,
        thread: mapDiscordThread(data),
      });
    }
    case "THREAD_DELETE": {
      const data = requireRecord(input.data, "deleted thread");
      if (requireSafeInteger(data, "type") !== 11) {
        return undefined;
      }
      return Object.freeze({
        ...base,
        type: "THREAD_DELETE" as const,
        threadId: requireSnowflake(data, "id"),
        guildId: requireSnowflake(data, "guild_id"),
        parentId: requireSnowflake(data, "parent_id"),
      });
    }
    case "INTERACTION_CREATE":
      return Object.freeze({
        ...base,
        type: "INTERACTION_CREATE" as const,
        interaction: mapDiscordInteraction(input.data, input.receivedAtMs),
      });
    default:
      return undefined;
  }
}

const SUPPORTED_DISPATCHES = new Set([
  "MESSAGE_CREATE",
  "THREAD_CREATE",
  "THREAD_UPDATE",
  "THREAD_DELETE",
  "INTERACTION_CREATE",
]);

class NodeDiscordGatewayScheduler implements DiscordGatewayScheduler {
  public nowMs(): number {
    return Date.now();
  }

  public random(): number {
    return Math.random();
  }

  public setTimeout(callback: () => void, delayMs: number): object {
    return setTimeout(callback, delayMs);
  }

  public clearTimeout(handle: object): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}

class NodeWsDiscordGatewaySocketFactory implements DiscordGatewaySocketFactory {
  public connect(
    url: string,
    options: {
      readonly maximumFrameBytes: number;
      readonly handshakeTimeoutMs: number;
    },
  ): DiscordGatewaySocket {
    const socket = new WebSocket(url, {
      followRedirects: false,
      handshakeTimeout: options.handshakeTimeoutMs,
      maxPayload: options.maximumFrameBytes,
      perMessageDeflate: false,
    });
    return new NodeWsDiscordGatewaySocket(socket);
  }
}

class NodeWsDiscordGatewaySocket implements DiscordGatewaySocket {
  readonly #socket: WebSocket;

  public constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  public onOpen(listener: () => void): void {
    this.#socket.on("open", listener);
  }

  public onMessage(listener: (data: string | Uint8Array, isBinary: boolean) => void): void {
    this.#socket.on("message", (data: RawData, isBinary: boolean) => {
      listener(toUint8Array(data), isBinary);
    });
  }

  public onClose(listener: (code: number) => void): void {
    this.#socket.on("close", (code: number) => {
      listener(code);
    });
  }

  public onError(listener: () => void): void {
    this.#socket.on("error", listener);
  }

  public send(data: string): void {
    this.#socket.send(data);
  }

  public close(code: number, reason: string): void {
    this.#socket.close(code, reason);
  }

  public terminate(): void {
    this.#socket.terminate();
  }
}

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    const total = data.reduce((sum, entry) => sum + entry.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const entry of data) {
      joined.set(entry, offset);
      offset += entry.byteLength;
    }
    return joined;
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function gatewayUrl(baseUrl: string): string {
  if (!isSecureGatewayUrl(baseUrl)) {
    throw invalidGatewayPayload();
  }
  const url = new URL(baseUrl);
  url.searchParams.set("v", DISCORD_API_VERSION.toString());
  url.searchParams.set("encoding", "json");
  url.searchParams.delete("compress");
  return url.toString();
}

function validateCursor(cursor: DiscordGatewayCursor): void {
  if (
    cursor.sessionId.length < 1 ||
    cursor.sessionId.length > 512 ||
    cursor.sessionId.includes("\u0000") ||
    !isSecureGatewayUrl(cursor.resumeGatewayUrl) ||
    !Number.isSafeInteger(cursor.sequence) ||
    cursor.sequence < 0 ||
    !Number.isSafeInteger(cursor.updatedAtMs) ||
    cursor.updatedAtMs < 0
  ) {
    throw invalidGatewayPayload();
  }
}

function isSecureGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname.endsWith(".discord.gg") &&
      (url.port === "" || url.port === "443")
    );
  } catch {
    return false;
  }
}

function assertCredential(value: string): void {
  if (
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw invalidGatewayPayload();
  }
}

function assertBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DiscordApiError("INVALID_RESPONSE", `${label} is invalid.`);
  }
}

function invalidGatewayPayload(): DiscordApiError {
  return new DiscordApiError("INVALID_RESPONSE", "Discord returned an invalid Gateway payload.");
}
