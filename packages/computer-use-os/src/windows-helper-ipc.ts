import { createHmac, hkdfSync, randomBytes, timingSafeEqual, type BinaryLike } from "node:crypto";
import { connect, type Socket } from "node:net";

import type { FixtureObservation } from "./contracts.ts";
import type {
  WindowsAuthenticatedHelperCommand,
  WindowsAuthenticatedHelperPort,
  WindowsAuthenticatedHelperResponse,
  WindowsHelperCapture,
  WindowsHelperObservation,
} from "./windows-native-driver.ts";

const PROTOCOL_VERSION = 1 as const;
const NONCE_BYTES = 32;
const KEY_BYTES = 32;
const MAC_BYTES = 32;
const AUTHENTICATED_HEADER_BYTES = 14;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_PIPE_FRAME_BYTES = MAX_RESPONSE_BYTES + AUTHENTICATED_HEADER_BYTES + MAC_BYTES;
const HELPER_LABEL = Buffer.from("OpenDelegate Windows helper IPC v1\0helper\0", "utf8");
const CORE_LABEL = Buffer.from("OpenDelegate Windows helper IPC v1\0core\0", "utf8");
const SESSION_INFO = Buffer.from("OpenDelegate Windows helper IPC v1\0session", "utf8");
const CORE_TO_HELPER_INFO = Buffer.from(
  "OpenDelegate Windows helper IPC v1\0core-to-helper",
  "utf8",
);
const HELPER_TO_CORE_INFO = Buffer.from(
  "OpenDelegate Windows helper IPC v1\0helper-to-core",
  "utf8",
);
const LOCAL_PIPE_PATTERN =
  /^\\\\\.\\pipe\\OpenDelegate(?:\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?){1,4}$/u;

export interface WindowsHelperIpcSecretPort {
  /**
   * Returns a disposable 32-byte copy. The named-pipe port zeroes the returned
   * buffer after every connection.
   */
  resolve(reference: string): Promise<Uint8Array>;
}

export interface WindowsHelperIpcDuplex {
  writeFrame(frame: Uint8Array): Promise<void>;
  readFrame(maxBytes?: number): Promise<Uint8Array>;
  close(): void;
}

export interface WindowsHelperIpcDialer {
  connect(pipePath: string, timeoutMs: number): Promise<WindowsHelperIpcDuplex>;
}

export interface WindowsNamedPipeAuthenticatedHelperPortOptions {
  readonly pipePath: string;
  readonly deviceId: string;
  readonly secretReference: string;
  readonly secrets: WindowsHelperIpcSecretPort;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly nonceSource?: () => Uint8Array;
  readonly dialer?: WindowsHelperIpcDialer;
}

export function createWindowsNamedPipeAuthenticatedHelperPort(
  options: WindowsNamedPipeAuthenticatedHelperPortOptions,
): WindowsAuthenticatedHelperPort {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new TypeError("The Windows named-pipe helper port can only be composed on Windows.");
  }
  if (!LOCAL_PIPE_PATTERN.test(options.pipePath)) {
    throw new TypeError("The helper endpoint must be a local Windows named pipe.");
  }
  requireIdentifier(options.deviceId, "Device ID");
  requireIdentifier(options.secretReference, "IPC Secret reference");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError("The Windows helper IPC timeout is invalid.");
  }
  return new WindowsNamedPipeAuthenticatedHelperPort({
    pipePath: options.pipePath,
    deviceId: options.deviceId,
    secretReference: options.secretReference,
    secrets: options.secrets,
    timeoutMs,
    nonceSource: options.nonceSource ?? (() => randomBytes(NONCE_BYTES)),
    dialer: options.dialer ?? createNodeWindowsNamedPipeDialer(),
  });
}

interface ResolvedOptions {
  readonly pipePath: string;
  readonly deviceId: string;
  readonly secretReference: string;
  readonly secrets: WindowsHelperIpcSecretPort;
  readonly timeoutMs: number;
  readonly nonceSource: () => Uint8Array;
  readonly dialer: WindowsHelperIpcDialer;
}

class WindowsNamedPipeAuthenticatedHelperPort implements WindowsAuthenticatedHelperPort {
  readonly #options: ResolvedOptions;

  public constructor(options: ResolvedOptions) {
    this.#options = options;
  }

  public async execute(
    command: WindowsAuthenticatedHelperCommand,
    signal?: AbortSignal,
  ): Promise<WindowsAuthenticatedHelperResponse> {
    if (isAborted(signal)) {
      throw new Error("The Windows helper IPC command was cancelled.");
    }
    validateCommandBinding(command);
    let duplex: WindowsHelperIpcDuplex | undefined;
    let secret: Uint8Array | undefined;
    let clientNonce: Uint8Array | undefined;
    let sessionKey: Buffer | undefined;
    let coreToHelperKey: Buffer | undefined;
    let helperToCoreKey: Buffer | undefined;
    let diagnosticStage = 0;
    let abandoned = false;
    let rejectDeadline: (error: Error) => void = () => {};
    let rejectCancellation: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const timeout = setTimeout(() => {
      abandoned = true;
      duplex?.close();
      rejectDeadline(new Error("The Windows helper IPC operation timed out."));
    }, this.#options.timeoutMs);
    const withinBound = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, deadline, cancellation]);
    const closeOnAbort = () => {
      abandoned = true;
      duplex?.close();
      rejectCancellation(new Error("The Windows helper IPC command was cancelled."));
    };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      if (isAborted(signal)) {
        closeOnAbort();
      }
      const secretResolution = this.#options.secrets
        .resolve(this.#options.secretReference)
        .then((value) => {
          if (abandoned && value instanceof Uint8Array) {
            value.fill(0);
          }
          return value;
        });
      const resolvedSecret = await withinBound(secretResolution);
      if (!(resolvedSecret instanceof Uint8Array) || resolvedSecret.length !== KEY_BYTES) {
        if (resolvedSecret instanceof Uint8Array) {
          resolvedSecret.fill(0);
        }
        throw new Error("The Windows helper IPC Secret is unavailable.");
      }
      secret = resolvedSecret;
      const resolvedClientNonce = this.#options.nonceSource();
      if (
        !(resolvedClientNonce instanceof Uint8Array) ||
        resolvedClientNonce.length !== NONCE_BYTES
      ) {
        if (resolvedClientNonce instanceof Uint8Array) {
          resolvedClientNonce.fill(0);
        }
        throw new Error("The Windows helper IPC nonce source is invalid.");
      }
      clientNonce = resolvedClientNonce;

      diagnosticStage = 1;
      const connection = this.#options.dialer
        .connect(this.#options.pipePath, this.#options.timeoutMs)
        .then((value) => {
          if (abandoned) {
            value.close();
          }
          return value;
        });
      duplex = await withinBound(connection);
      const hello = encodeJson({
        type: "client-hello",
        protocolVersion: PROTOCOL_VERSION,
        deviceId: this.#options.deviceId,
        helperInstanceId: command.expectedHelperInstanceId,
        serviceEpoch: command.expectedServiceEpoch,
        sessionIdentity: command.expectedSessionIdentity,
        releaseVersion: command.expectedReleaseVersion,
        clientNonce: Buffer.from(clientNonce).toString("base64url"),
      });
      diagnosticStage = 2;
      await withinBound(duplex.writeFrame(hello));
      diagnosticStage = 3;
      const helperProofFrame = await withinBound(duplex.readFrame(MAX_HANDSHAKE_BYTES));
      diagnosticStage = 4;
      const helperProof = parseHelperProof(helperProofFrame);
      const expectedHelperProof = handshakeProof(
        secret,
        HELPER_LABEL,
        hello,
        helperProof.serverNonce,
      );
      const proofMatches =
        helperProof.proof.length === expectedHelperProof.length &&
        timingSafeEqual(helperProof.proof, expectedHelperProof);
      if (!proofMatches) {
        expectedHelperProof.fill(0);
        throw new Error("The Windows user-session helper could not be authenticated.");
      }
      expectedHelperProof.fill(0);

      diagnosticStage = 5;
      const coreProof = handshakeProof(secret, CORE_LABEL, hello, helperProof.serverNonce);
      try {
        await withinBound(
          duplex.writeFrame(
            encodeJson({
              type: "core-proof",
              protocolVersion: PROTOCOL_VERSION,
              proof: coreProof.toString("base64url"),
            }),
          ),
        );
      } finally {
        coreProof.fill(0);
      }

      sessionKey = Buffer.from(
        hkdfSync(
          "sha256",
          secret,
          Buffer.concat([Buffer.from(clientNonce), helperProof.serverNonce]),
          SESSION_INFO,
          KEY_BYTES,
        ),
      );
      coreToHelperKey = deriveDirectionKey(sessionKey, CORE_TO_HELPER_INFO);
      helperToCoreKey = deriveDirectionKey(sessionKey, HELPER_TO_CORE_INFO);

      const commandPayload = encodeJson(serializeCommand(command));
      if (commandPayload.length > MAX_COMMAND_BYTES) {
        throw new Error("The Windows helper IPC command exceeds the bounded frame size.");
      }
      diagnosticStage = 6;
      await withinBound(
        duplex.writeFrame(encodeAuthenticatedFrame(0, 1, commandPayload, coreToHelperKey)),
      );
      diagnosticStage = 7;
      const responseFrame = await withinBound(duplex.readFrame(MAX_PIPE_FRAME_BYTES));
      diagnosticStage = 8;
      const responsePayload = decodeAuthenticatedFrame(responseFrame, 1, 1, helperToCoreKey);
      const response = parseResponse(responsePayload);
      return Object.freeze({
        ...response,
        protocolVersion: PROTOCOL_VERSION,
        authenticated: true,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.message === "The Windows user-session helper could not be authenticated." ||
          error.message === "The Windows helper IPC command exceeds the bounded frame size." ||
          error.message === "The Windows helper IPC command was cancelled." ||
          error.message === "The Windows helper IPC operation timed out.")
      ) {
        throw error;
      }
      // Do not attach the untrusted native/transport error as `cause`: this is
      // the protocol's deliberate redaction boundary.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `The authenticated Windows helper IPC operation failed at redacted stage ${diagnosticStage}.`,
      );
    } finally {
      abandoned = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", closeOnAbort);
      duplex?.close();
      secret?.fill(0);
      clientNonce?.fill(0);
      sessionKey?.fill(0);
      coreToHelperKey?.fill(0);
      helperToCoreKey?.fill(0);
    }
  }
}

export function createNodeWindowsNamedPipeDialer(): WindowsHelperIpcDialer {
  return Object.freeze({
    connect(pipePath: string, timeoutMs: number) {
      return connectNodeWindowsNamedPipe(pipePath, timeoutMs);
    },
  });
}

interface HelperProof {
  readonly serverNonce: Buffer;
  readonly proof: Buffer;
}

function parseHelperProof(frame: Uint8Array): HelperProof {
  const parsed = parseJsonRecord(frame);
  if (
    parsed["type"] !== "helper-proof" ||
    parsed["protocolVersion"] !== PROTOCOL_VERSION ||
    typeof parsed["serverNonce"] !== "string" ||
    typeof parsed["proof"] !== "string"
  ) {
    throw new Error("Invalid Windows helper proof.");
  }
  const serverNonce = decodeBase64Url(parsed["serverNonce"], NONCE_BYTES);
  const proof = decodeBase64Url(parsed["proof"], MAC_BYTES);
  return { serverNonce, proof };
}

function handshakeProof(
  secret: Uint8Array,
  label: BinaryLike,
  hello: Uint8Array,
  serverNonce: Uint8Array,
): Buffer {
  return createHmac("sha256", secret)
    .update(label)
    .update(hello)
    .update(Uint8Array.of(0))
    .update(serverNonce)
    .digest();
}

function deriveDirectionKey(sessionKey: Uint8Array, info: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionKey, Buffer.alloc(0), info, KEY_BYTES));
}

function encodeAuthenticatedFrame(
  direction: 0 | 1,
  sequence: number,
  payload: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  const header = Buffer.alloc(AUTHENTICATED_HEADER_BYTES);
  header.writeUInt8(PROTOCOL_VERSION, 0);
  header.writeUInt8(direction, 1);
  header.writeBigUInt64BE(BigInt(sequence), 2);
  header.writeUInt32BE(payload.length, 10);
  const unsigned = Buffer.concat([header, payload]);
  const mac = createHmac("sha256", key).update(unsigned).digest();
  return Buffer.concat([unsigned, mac]);
}

function decodeAuthenticatedFrame(
  frame: Uint8Array,
  expectedDirection: 0 | 1,
  expectedSequence: number,
  key: Uint8Array,
): Uint8Array {
  const value = Buffer.from(frame);
  if (value.length < AUTHENTICATED_HEADER_BYTES + MAC_BYTES) {
    throw new Error("The Windows helper IPC response frame is truncated.");
  }
  const version = value.readUInt8(0);
  const direction = value.readUInt8(1);
  const sequence = value.readBigUInt64BE(2);
  const payloadLength = value.readUInt32BE(10);
  const expectedLength = AUTHENTICATED_HEADER_BYTES + payloadLength + MAC_BYTES;
  if (
    version !== PROTOCOL_VERSION ||
    direction !== expectedDirection ||
    sequence !== BigInt(expectedSequence) ||
    expectedLength !== value.length ||
    payloadLength > MAX_RESPONSE_BYTES
  ) {
    throw new Error("The Windows helper IPC response frame binding is invalid.");
  }
  const unsigned = value.subarray(0, AUTHENTICATED_HEADER_BYTES + payloadLength);
  const actualMac = value.subarray(AUTHENTICATED_HEADER_BYTES + payloadLength);
  const expectedMac = createHmac("sha256", key).update(unsigned).digest();
  const validMac = timingSafeEqual(actualMac, expectedMac);
  expectedMac.fill(0);
  if (!validMac) {
    throw new Error("The Windows helper IPC response frame authentication failed.");
  }
  return value.subarray(AUTHENTICATED_HEADER_BYTES, AUTHENTICATED_HEADER_BYTES + payloadLength);
}

function serializeCommand(command: WindowsAuthenticatedHelperCommand): unknown {
  return command;
}

function parseResponse(
  payload: Uint8Array,
): Omit<WindowsAuthenticatedHelperResponse, "authenticated" | "protocolVersion"> {
  const parsed = parseJsonRecord(payload);
  const kind = parsed["kind"];
  const helperInstanceId = parsed["helperInstanceId"];
  const serviceEpoch = parsed["serviceEpoch"];
  const sessionIdentity = parsed["sessionIdentity"];
  const releaseVersion = parsed["releaseVersion"];
  const displayFingerprint = parsed["displayFingerprint"];
  if (
    !["probe", "observe", "capture", "act", "cancel", "emergency-stop"].includes(
      typeof kind === "string" ? kind : "",
    ) ||
    typeof helperInstanceId !== "string" ||
    !Number.isSafeInteger(serviceEpoch) ||
    typeof sessionIdentity !== "string" ||
    typeof releaseVersion !== "string" ||
    (displayFingerprint !== null && typeof displayFingerprint !== "string")
  ) {
    throw new Error("The Windows helper IPC response schema is invalid.");
  }

  const capture = parseCapture(parsed["capture"]);
  const readiness = parsed["readiness"];
  const observation = parseObservation(parsed["observation"]);
  return {
    kind: kind as WindowsAuthenticatedHelperCommand["kind"],
    helperInstanceId,
    serviceEpoch: serviceEpoch as number,
    sessionIdentity,
    releaseVersion,
    displayFingerprint,
    ...(typeof parsed["sequence"] === "number" ? { sequence: parsed["sequence"] } : {}),
    ...(isRecord(readiness)
      ? {
          readiness: readiness as unknown as NonNullable<
            WindowsAuthenticatedHelperResponse["readiness"]
          >,
        }
      : {}),
    ...(observation === undefined ? {} : { observation }),
    ...(capture === undefined ? {} : { capture }),
  };
}

function parseObservation(value: unknown): WindowsHelperObservation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const tree = value["accessibilityTree"];
  if (!Array.isArray(tree) || tree.length > 10_000) {
    throw new Error("The Windows helper observation response is invalid.");
  }
  const accessibilityTree = tree.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["controlId"] !== "string" ||
      !["button", "radio", "textbox"].includes(
        typeof entry["role"] === "string" ? entry["role"] : "",
      ) ||
      typeof entry["label"] !== "string" ||
      (entry["value"] !== undefined && typeof entry["value"] !== "string") ||
      (entry["selected"] !== undefined && typeof entry["selected"] !== "boolean")
    ) {
      throw new Error("The Windows helper accessibility response is invalid.");
    }
    return {
      controlId: entry["controlId"],
      role: entry["role"] as "button" | "radio" | "textbox",
      label: entry["label"],
      ...(typeof entry["value"] === "string" ? { value: entry["value"] } : {}),
      ...(typeof entry["selected"] === "boolean" ? { selected: entry["selected"] } : {}),
    };
  });

  const fixtureValue = value["fixture"];
  if (fixtureValue === undefined) {
    return { accessibilityTree };
  }
  if (
    !isRecord(fixtureValue) ||
    typeof fixtureValue["runIdentifier"] !== "string" ||
    !["editing", "success"].includes(
      typeof fixtureValue["state"] === "string" ? fixtureValue["state"] : "",
    ) ||
    typeof fixtureValue["textValue"] !== "string" ||
    ![null, "Alpha", "Beta"].includes(fixtureValue["selectedOption"] as null | string)
  ) {
    throw new Error("The Windows helper fixture observation is invalid.");
  }
  const resultValue = fixtureValue["resultFile"];
  let resultFile: FixtureObservation["resultFile"];
  if (resultValue === null) {
    resultFile = null;
  } else if (
    isRecord(resultValue) &&
    typeof resultValue["filename"] === "string" &&
    resultValue["mediaType"] === "application/json" &&
    typeof resultValue["bytesBase64Url"] === "string"
  ) {
    const bytes = Buffer.from(resultValue["bytesBase64Url"], "base64url");
    if (bytes.length === 0 || bytes.length > 1024 * 1024) {
      throw new Error("The Windows helper fixture result exceeds its bound.");
    }
    resultFile = {
      filename: resultValue["filename"],
      mediaType: "application/json",
      bytes,
    };
  } else {
    throw new Error("The Windows helper fixture result response is invalid.");
  }
  return {
    accessibilityTree,
    fixture: {
      runIdentifier: fixtureValue["runIdentifier"],
      state: fixtureValue["state"] as "editing" | "success",
      textValue: fixtureValue["textValue"],
      selectedOption: fixtureValue["selectedOption"] as "Alpha" | "Beta" | null,
      resultFile,
    },
  };
}

function parseCapture(value: unknown): WindowsHelperCapture | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value["mediaType"] !== "image/png" ||
    !Number.isSafeInteger(value["width"]) ||
    !Number.isSafeInteger(value["height"]) ||
    typeof value["bytesBase64Url"] !== "string"
  ) {
    throw new Error("The Windows helper capture response is invalid.");
  }
  const bytes = Buffer.from(value["bytesBase64Url"], "base64url");
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error("The Windows helper capture response exceeds the bounded evidence size.");
  }
  return {
    mediaType: "image/png",
    width: value["width"] as number,
    height: value["height"] as number,
    bytes,
  };
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function parseJsonRecord(value: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(value).toString("utf8"));
  if (!isRecord(parsed)) {
    throw new Error("The Windows helper IPC JSON frame is invalid.");
  }
  return parsed;
}

function decodeBase64Url(value: string, expectedLength: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== expectedLength ||
    decoded.toString("base64url") !== value.replace(/=+$/u, "")
  ) {
    decoded.fill(0);
    throw new Error("The Windows helper IPC proof encoding is invalid.");
  }
  return decoded;
}

function validateCommandBinding(command: WindowsAuthenticatedHelperCommand): void {
  if (
    command.protocolVersion !== PROTOCOL_VERSION ||
    !Number.isSafeInteger(command.expectedServiceEpoch) ||
    command.expectedServiceEpoch <= 0
  ) {
    throw new TypeError("The Windows helper IPC command binding is invalid.");
  }
  requireIdentifier(command.expectedHelperInstanceId, "helper instance ID");
  requireIdentifier(command.expectedSessionIdentity, "session identity");
  requireIdentifier(command.expectedReleaseVersion, "release version");
}

function requireIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new TypeError(`The Windows helper ${label} is invalid.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function connectNodeWindowsNamedPipe(
  pipePath: string,
  timeoutMs: number,
): Promise<WindowsHelperIpcDuplex> {
  return await new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("The Windows helper named-pipe connection timed out."));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(new NodeWindowsNamedPipeDuplex(socket));
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("The Windows helper named-pipe connection failed."));
    });
  });
}

class NodeWindowsNamedPipeDuplex implements WindowsHelperIpcDuplex {
  readonly #socket: Socket;
  readonly #frames: Buffer[] = [];
  readonly #readers: Array<{
    readonly maximum: number;
    readonly resolve: (value: Uint8Array) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #buffer = Buffer.alloc(0);
  #failure: Error | undefined;
  #closed = false;

  public constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#parseFrames();
    });
    socket.once("error", () => {
      this.#fail(new Error("The Windows helper named-pipe connection failed."));
    });
    socket.once("close", () => {
      this.#fail(new Error("The Windows helper named-pipe connection closed."));
    });
  }

  public async writeFrame(frame: Uint8Array): Promise<void> {
    if (this.#closed || frame.length > MAX_PIPE_FRAME_BYTES) {
      throw new Error("The Windows helper named-pipe frame cannot be written.");
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(frame.length);
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(Buffer.concat([header, frame]), (error) => {
        if (error != null) {
          reject(new Error("The Windows helper named-pipe frame write failed."));
          return;
        }
        resolve();
      });
    });
  }

  public async readFrame(maxBytes = MAX_PIPE_FRAME_BYTES): Promise<Uint8Array> {
    const queued = this.#frames.shift();
    if (queued !== undefined) {
      if (queued.length > maxBytes) {
        throw new Error("The Windows helper named-pipe frame exceeds its bound.");
      }
      return queued;
    }
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    return await new Promise<Uint8Array>((resolve, reject) => {
      this.#readers.push({ maximum: maxBytes, resolve, reject });
    });
  }

  public close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#socket.destroy();
    }
  }

  #parseFrames(): void {
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_PIPE_FRAME_BYTES) {
        this.#fail(new Error("The Windows helper named-pipe frame length is invalid."));
        this.close();
        return;
      }
      if (this.#buffer.length < length + 4) {
        return;
      }
      const frame = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      const reader = this.#readers.shift();
      if (reader === undefined) {
        this.#frames.push(Buffer.from(frame));
      } else if (frame.length > reader.maximum) {
        reader.reject(new Error("The Windows helper named-pipe frame exceeds its bound."));
      } else {
        reader.resolve(Buffer.from(frame));
      }
    }
  }

  #fail(error: Error): void {
    if (this.#failure === undefined) {
      this.#failure = error;
      for (const reader of this.#readers.splice(0)) {
        reader.reject(error);
      }
    }
  }
}
