import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  CoreSessionHelperChannel,
  HelperSessionHelperChannel,
  SessionHelperBinding,
  SessionHelperCapabilityRequest,
  SessionHelperCapabilityResponse,
  SessionHelperIpcConnection,
} from "./contracts.ts";
import { SESSION_HELPER_IPC_PROTOCOL_VERSION } from "./contracts.ts";
import { SessionHelperIpcError } from "./error.ts";
import { encodeJson, parseCapabilityRequest, parseCapabilityResponse } from "./schemas.ts";

const MAGIC = Buffer.from("ODHI", "ascii");
const HEADER_BYTES = 18;
const MAC_BYTES = 32;
const MAX_SEQUENCE = (1n << 64n) - 1n;
const CORE_TO_HELPER = 1;
const HELPER_TO_CORE = 2;

type ChannelRole = "core" | "helper";

export interface DirectionKeys {
  readonly coreToHelper: Buffer;
  readonly helperToCore: Buffer;
}

export function createAuthenticatedCoreChannel(
  connection: SessionHelperIpcConnection,
  binding: SessionHelperBinding,
  keys: DirectionKeys,
  maxFrameBytes: number,
): CoreSessionHelperChannel & { receiveAuthenticationAck(): Promise<void> } {
  const channel = new AuthenticatedChannel(
    "core",
    connection,
    keys.coreToHelper,
    keys.helperToCore,
    maxFrameBytes,
  );
  return Object.freeze({
    binding,
    get isClosed() {
      return channel.isClosed;
    },
    send: (request: SessionHelperCapabilityRequest, signal?: AbortSignal) =>
      channel.sendRequest(request, signal),
    receive: (signal?: AbortSignal) => channel.receiveResponse(signal),
    close: () => channel.close(),
    receiveAuthenticationAck: () => channel.receiveAuthenticationAck(),
  });
}

export function createAuthenticatedHelperChannel(
  connection: SessionHelperIpcConnection,
  binding: SessionHelperBinding,
  keys: DirectionKeys,
  maxFrameBytes: number,
): HelperSessionHelperChannel & { sendAuthenticationAck(): Promise<void> } {
  const channel = new AuthenticatedChannel(
    "helper",
    connection,
    keys.helperToCore,
    keys.coreToHelper,
    maxFrameBytes,
  );
  return Object.freeze({
    binding,
    get isClosed() {
      return channel.isClosed;
    },
    send: (response: SessionHelperCapabilityResponse, signal?: AbortSignal) =>
      channel.sendResponse(response, signal),
    receive: (signal?: AbortSignal) => channel.receiveRequest(signal),
    close: () => channel.close(),
    sendAuthenticationAck: () => channel.sendAuthenticationAck(),
  });
}

class AuthenticatedChannel {
  readonly #role: ChannelRole;
  readonly #connection: SessionHelperIpcConnection;
  readonly #sendKey: Buffer;
  readonly #receiveKey: Buffer;
  readonly #maxFrameBytes: number;
  #sendSequence = 1n;
  #receiveSequence = 1n;
  #closed = false;
  #sendTail: Promise<void> = Promise.resolve();
  #receiveTail: Promise<unknown> = Promise.resolve();

  public constructor(
    role: ChannelRole,
    connection: SessionHelperIpcConnection,
    sendKey: Buffer,
    receiveKey: Buffer,
    maxFrameBytes: number,
  ) {
    this.#role = role;
    this.#connection = connection;
    this.#sendKey = sendKey;
    this.#receiveKey = receiveKey;
    this.#maxFrameBytes = maxFrameBytes;
  }

  public get isClosed(): boolean {
    return this.#closed;
  }

  public async sendRequest(
    request: SessionHelperCapabilityRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#role !== "core") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    let validated: SessionHelperCapabilityRequest;
    try {
      validated = parseCapabilityRequest(request);
    } catch (error: unknown) {
      return await this.#fail(asIpcError(error, "MALFORMED_MESSAGE"));
    }
    await this.#enqueueSend(validated, signal);
  }

  public async sendResponse(
    response: SessionHelperCapabilityResponse,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#role !== "helper") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    let validated: SessionHelperCapabilityResponse;
    try {
      validated = parseCapabilityResponse(response);
    } catch (error: unknown) {
      return await this.#fail(asIpcError(error, "MALFORMED_MESSAGE"));
    }
    await this.#enqueueSend(validated, signal);
  }

  public async receiveRequest(signal?: AbortSignal): Promise<SessionHelperCapabilityRequest> {
    if (this.#role !== "helper") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    return await this.#enqueueReceive(async () => {
      const value = await this.#readAuthenticatedPayload(signal);
      return parseCapabilityRequest(value);
    });
  }

  public async receiveResponse(signal?: AbortSignal): Promise<SessionHelperCapabilityResponse> {
    if (this.#role !== "core") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    return await this.#enqueueReceive(async () => {
      const value = await this.#readAuthenticatedPayload(signal);
      return parseCapabilityResponse(value);
    });
  }

  public async sendAuthenticationAck(): Promise<void> {
    if (this.#role !== "helper") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    await this.#sendPayload({ type: "authenticated" }, 0n);
  }

  public async receiveAuthenticationAck(): Promise<void> {
    if (this.#role !== "core") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    const frame = await this.#readFrame();
    const payload = decodeAuthenticatedFrame(
      frame,
      HELPER_TO_CORE,
      0n,
      this.#receiveKey,
      this.#maxFrameBytes,
    );
    try {
      const value: unknown = JSON.parse(payload.toString("utf8"));
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        (value as Record<string, unknown>)["type"] !== "authenticated"
      ) {
        throw new SessionHelperIpcError("MALFORMED_MESSAGE");
      }
    } catch (error: unknown) {
      await this.#fail(asIpcError(error, "MALFORMED_MESSAGE"));
    } finally {
      payload.fill(0);
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#sendKey.fill(0);
    this.#receiveKey.fill(0);
    this.#connection.close();
  }

  async #enqueueSend(value: unknown, signal?: AbortSignal): Promise<void> {
    const operation = this.#sendTail.then(async () => {
      if (this.#sendSequence > MAX_SEQUENCE) {
        await this.#fail(new SessionHelperIpcError("SEQUENCE_VIOLATION"));
      }
      const sequence = this.#sendSequence;
      await this.#sendPayload(value, sequence, signal);
      this.#sendSequence = sequence + 1n;
    });
    this.#sendTail = operation.catch(() => {});
    return await operation;
  }

  async #enqueueReceive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#receiveTail.then(operation);
    this.#receiveTail = next.catch(() => {});
    try {
      return await next;
    } catch (error: unknown) {
      return await this.#fail(asIpcError(error, "PROTOCOL_ERROR"));
    }
  }

  async #sendPayload(value: unknown, sequence: bigint, signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    if (signal?.aborted === true) {
      await this.#fail(new SessionHelperIpcError("TRANSPORT_FAILURE"));
    }
    const payload = encodeJson(value);
    let frame: Buffer | undefined;
    try {
      frame = encodeAuthenticatedFrame(
        payload,
        this.#role === "core" ? CORE_TO_HELPER : HELPER_TO_CORE,
        sequence,
        this.#sendKey,
        this.#maxFrameBytes,
      );
      await this.#connection.writeFrame(frame, signal);
    } catch (error: unknown) {
      await this.#fail(asIpcError(error, "TRANSPORT_FAILURE"));
    } finally {
      payload.fill(0);
      frame?.fill(0);
    }
  }

  async #readAuthenticatedPayload(signal?: AbortSignal): Promise<unknown> {
    this.#assertOpen();
    const sequence = this.#receiveSequence;
    if (sequence > MAX_SEQUENCE) {
      await this.#fail(new SessionHelperIpcError("SEQUENCE_VIOLATION"));
    }
    const frame = await this.#readFrame(signal);
    const payload = decodeAuthenticatedFrame(
      frame,
      this.#role === "core" ? HELPER_TO_CORE : CORE_TO_HELPER,
      sequence,
      this.#receiveKey,
      this.#maxFrameBytes,
    );
    this.#receiveSequence = sequence + 1n;
    try {
      return JSON.parse(payload.toString("utf8")) as unknown;
    } catch {
      throw new SessionHelperIpcError("MALFORMED_MESSAGE");
    } finally {
      payload.fill(0);
    }
  }

  async #readFrame(signal?: AbortSignal): Promise<Buffer> {
    this.#assertOpen();
    if (signal?.aborted === true) {
      await this.#fail(new SessionHelperIpcError("TRANSPORT_FAILURE"));
    }
    let frame: Buffer | null;
    try {
      frame = await this.#connection.readFrame(
        HEADER_BYTES + this.#maxFrameBytes + MAC_BYTES,
        signal,
      );
    } catch {
      return await this.#fail(new SessionHelperIpcError("TRANSPORT_FAILURE"));
    }
    if (frame === null) {
      return await this.#fail(new SessionHelperIpcError("CONNECTION_CLOSED"));
    }
    if (!Buffer.isBuffer(frame)) {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    if (frame.length > HEADER_BYTES + this.#maxFrameBytes + MAC_BYTES) {
      frame.fill(0);
      return await this.#fail(new SessionHelperIpcError("FRAME_TOO_LARGE"));
    }
    return frame;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SessionHelperIpcError("CONNECTION_CLOSED");
    }
  }

  async #fail<T>(error: SessionHelperIpcError): Promise<T> {
    this.close();
    throw error;
  }
}

function encodeAuthenticatedFrame(
  payload: Buffer,
  direction: number,
  sequence: bigint,
  key: Buffer,
  maxFrameBytes: number,
): Buffer {
  if (payload.length > maxFrameBytes) {
    throw new SessionHelperIpcError("FRAME_TOO_LARGE");
  }
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt8(SESSION_HELPER_IPC_PROTOCOL_VERSION, 4);
  header.writeUInt8(direction, 5);
  header.writeBigUInt64BE(sequence, 6);
  header.writeUInt32BE(payload.length, 14);
  const unsigned = Buffer.concat([header, payload]);
  const mac = createHmac("sha256", key).update(unsigned).digest();
  try {
    return Buffer.concat([unsigned, mac]);
  } finally {
    header.fill(0);
    unsigned.fill(0);
    mac.fill(0);
  }
}

function decodeAuthenticatedFrame(
  frame: Buffer,
  expectedDirection: number,
  expectedSequence: bigint,
  key: Buffer,
  maxFrameBytes: number,
): Buffer {
  try {
    if (frame.length < HEADER_BYTES + MAC_BYTES) {
      throw new SessionHelperIpcError("PROTOCOL_ERROR");
    }
    if (
      !timingSafeEqual(frame.subarray(0, MAGIC.length), MAGIC) ||
      frame.readUInt8(4) !== SESSION_HELPER_IPC_PROTOCOL_VERSION ||
      frame.readUInt8(5) !== expectedDirection
    ) {
      throw new SessionHelperIpcError("PROTOCOL_ERROR");
    }
    const sequence = frame.readBigUInt64BE(6);
    if (sequence !== expectedSequence) {
      throw new SessionHelperIpcError("SEQUENCE_VIOLATION");
    }
    const payloadLength = frame.readUInt32BE(14);
    if (
      payloadLength > maxFrameBytes ||
      frame.length !== HEADER_BYTES + payloadLength + MAC_BYTES
    ) {
      throw new SessionHelperIpcError(
        payloadLength > maxFrameBytes ? "FRAME_TOO_LARGE" : "PROTOCOL_ERROR",
      );
    }
    const unsigned = frame.subarray(0, HEADER_BYTES + payloadLength);
    const actualMac = frame.subarray(HEADER_BYTES + payloadLength);
    const expectedMac = createHmac("sha256", key).update(unsigned).digest();
    const authenticated = timingSafeEqual(actualMac, expectedMac);
    expectedMac.fill(0);
    if (!authenticated) {
      throw new SessionHelperIpcError("AUTHENTICATION_FAILED");
    }
    return Buffer.from(frame.subarray(HEADER_BYTES, HEADER_BYTES + payloadLength));
  } finally {
    frame.fill(0);
  }
}

function asIpcError(
  error: unknown,
  fallback: ConstructorParameters<typeof SessionHelperIpcError>[0],
): SessionHelperIpcError {
  return error instanceof SessionHelperIpcError ? error : new SessionHelperIpcError(fallback);
}
