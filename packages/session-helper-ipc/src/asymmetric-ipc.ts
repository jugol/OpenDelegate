import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import type {
  AcceptSignedHelperSessionOptions,
  ConnectSignedCoreSessionHelperOptions,
  SessionHelperPeerPublicKey,
  SignedCoreSessionHelperChannel,
  SignedCoreSessionHelperIpc,
  SignedHelperSessionHelperChannel,
  SignedHelperSessionHelperIpc,
  SignedSessionHelperBinding,
  SignedSessionHelperIpcFactoryOptions,
} from "./asymmetric-contracts.ts";
import { SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION } from "./asymmetric-contracts.ts";
import type {
  SessionHelperCapabilityRequest,
  SessionHelperCapabilityResponse,
  SessionHelperIpcConnection,
} from "./contracts.ts";
import { SessionHelperIpcError } from "./error.ts";
import { encodeJson, parseCapabilityRequest, parseCapabilityResponse } from "./schemas.ts";

const NONCE_BYTES = 32;
const SIGNATURE_BYTES = 64;
const HANDSHAKE_MAX_BYTES = 32 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MIN_FRAME_BYTES = 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const SIGNED_FRAME_OVERHEAD_BYTES = 64 * 1024;
const MAX_SEQUENCE = (1n << 64n) - 1n;
const KEY_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const CORE_HELLO_LABEL = Buffer.from(
  "OpenDelegate session-helper signed IPC v2\0core-hello\0",
  "utf8",
);
const HELPER_CHALLENGE_LABEL = Buffer.from(
  "OpenDelegate session-helper signed IPC v2\0helper-challenge\0",
  "utf8",
);
const CORE_ACK_LABEL = Buffer.from("OpenDelegate session-helper signed IPC v2\0core-ack\0", "utf8");
const CORE_FRAME_LABEL = Buffer.from(
  "OpenDelegate session-helper signed IPC v2\0core-frame\0",
  "utf8",
);
const HELPER_FRAME_LABEL = Buffer.from(
  "OpenDelegate session-helper signed IPC v2\0helper-frame\0",
  "utf8",
);

interface ResolvedPeerKey {
  readonly keyId: `sha256:${string}`;
  readonly key: KeyObject;
  readonly usage: "active" | "migration";
  readonly consumeMigration?: () => Promise<boolean>;
}

interface ResolvedFactoryOptions {
  readonly localPrivateKeyReference: string;
  readonly localKeyId: `sha256:${string}`;
  readonly signingKeyProvider: SignedSessionHelperIpcFactoryOptions["signingKeyProvider"];
  readonly acceptedPeerKeys: ReadonlyMap<string, ResolvedPeerKey>;
  readonly peerAuthorizer: SignedSessionHelperIpcFactoryOptions["peerAuthorizer"];
  readonly nonceGuard: NonNullable<SignedSessionHelperIpcFactoryOptions["nonceGuard"]>;
  readonly nonceSource: () => Buffer;
  readonly handshakeTimeoutMs: number;
  readonly maxFrameBytes: number;
}

interface CoreHelloUnsigned extends SignedSessionHelperBinding {
  readonly type: "core_hello_v2";
  readonly coreKeyId: `sha256:${string}`;
  readonly coreNonce: string;
}

interface CoreHello extends CoreHelloUnsigned {
  readonly signature: string;
}

interface HelperChallengeUnsigned extends SignedSessionHelperBinding {
  readonly type: "helper_challenge_v2";
  readonly coreKeyId: `sha256:${string}`;
  readonly helperKeyId: `sha256:${string}`;
  readonly coreNonce: string;
  readonly helperNonce: string;
  readonly coreHelloSignature: string;
}

interface HelperChallenge extends HelperChallengeUnsigned {
  readonly signature: string;
}

interface CoreAckUnsigned {
  readonly type: "core_ack_v2";
  readonly protocolVersion: typeof SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION;
  readonly deviceId: string;
  readonly helperId: string;
  readonly sessionId: string;
  readonly serviceEpoch: number;
  readonly releaseVersion: string;
  readonly coreKeyId: `sha256:${string}`;
  readonly helperKeyId: `sha256:${string}`;
  readonly coreNonce: string;
  readonly helperNonce: string;
  readonly helperChallengeSignature: string;
}

interface CoreAck extends CoreAckUnsigned {
  readonly signature: string;
}

type ChannelRole = "core" | "helper";
type SignedDirection = "core-to-helper" | "helper-to-core";

interface SignedFrameUnsigned {
  readonly type: "signed_frame_v2";
  readonly protocolVersion: typeof SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION;
  readonly direction: SignedDirection;
  readonly sequence: string;
  readonly serviceEpoch: number;
  readonly handshakeTranscriptSha256: `sha256:${string}`;
  readonly signerKeyId: `sha256:${string}`;
  readonly payload: unknown;
}

interface SignedFrame extends SignedFrameUnsigned {
  readonly signature: string;
}

export function createSignedCoreSessionHelperIpc(
  options: SignedSessionHelperIpcFactoryOptions,
): SignedCoreSessionHelperIpc {
  const factory = resolveFactoryOptions(options);
  return Object.freeze({
    async connect(
      connectOptions: ConnectSignedCoreSessionHelperOptions,
    ): Promise<SignedCoreSessionHelperChannel> {
      return await connectCore(factory, connectOptions);
    },
  });
}

export function createSignedHelperSessionHelperIpc(
  options: SignedSessionHelperIpcFactoryOptions,
): SignedHelperSessionHelperIpc {
  const factory = resolveFactoryOptions(options);
  return Object.freeze({
    async accept(
      acceptOptions: AcceptSignedHelperSessionOptions,
    ): Promise<SignedHelperSessionHelperChannel> {
      return await acceptHelper(factory, acceptOptions);
    },
  });
}

async function connectCore(
  factory: ResolvedFactoryOptions,
  options: ConnectSignedCoreSessionHelperOptions,
): Promise<SignedCoreSessionHelperChannel> {
  const binding = validateSignedBinding(options.binding);
  let connection: SessionHelperIpcConnection | undefined;
  let handedOff = false;
  try {
    return await withHandshakeDeadline(
      factory.handshakeTimeoutMs,
      options.signal,
      () => connection?.close(),
      async (signal) => {
        try {
          connection = await options.dialer.connect(options.endpoint, signal);
        } catch {
          throw new SessionHelperIpcError("TRANSPORT_FAILURE");
        }
        assertConnection(connection);
        await authorizePeer(factory, "core", binding, connection);

        const coreNonce = await freshNonce(factory, "core", binding);
        let hello: CoreHello;
        try {
          const unsigned: CoreHelloUnsigned = {
            type: "core_hello_v2",
            ...binding,
            coreKeyId: factory.localKeyId,
            coreNonce: coreNonce.toString("base64url"),
          };
          hello = {
            ...unsigned,
            signature: await signRecord(factory, CORE_HELLO_LABEL, unsigned),
          };
          await writeHandshakeFrame(connection, hello, signal);
        } finally {
          coreNonce.fill(0);
        }

        const challenge = parseHelperChallenge(await readHandshakeFrame(connection, signal));
        assertBindingMatches(binding, challenge);
        if (
          challenge.coreKeyId !== factory.localKeyId ||
          challenge.coreNonce !== hello.coreNonce ||
          challenge.coreHelloSignature !== hello.signature
        ) {
          throw new SessionHelperIpcError("BINDING_MISMATCH");
        }
        const helperPeer = requirePeerKey(factory, challenge.helperKeyId);
        const helperNonce = decodeNonce(challenge.helperNonce);
        try {
          await claimNonce(factory, "helper", binding, helperNonce);
        } finally {
          helperNonce.fill(0);
        }
        verifyRecord(
          helperPeer,
          HELPER_CHALLENGE_LABEL,
          withoutSignature(challenge),
          challenge.signature,
        );

        const ackUnsigned: CoreAckUnsigned = {
          type: "core_ack_v2",
          protocolVersion: SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION,
          deviceId: binding.deviceId,
          helperId: binding.helperId,
          sessionId: binding.sessionId,
          serviceEpoch: binding.serviceEpoch,
          releaseVersion: binding.releaseVersion,
          coreKeyId: factory.localKeyId,
          helperKeyId: challenge.helperKeyId,
          coreNonce: hello.coreNonce,
          helperNonce: challenge.helperNonce,
          helperChallengeSignature: challenge.signature,
        };
        const ack: CoreAck = {
          ...ackUnsigned,
          signature: await signRecord(factory, CORE_ACK_LABEL, ackUnsigned),
        };
        await writeHandshakeFrame(connection, ack, signal);
        await consumeMigration(helperPeer);
        const transcript = transcriptDigest(hello, challenge, ack);
        const channel = new SignedChannel(
          "core",
          connection,
          binding,
          factory,
          helperPeer,
          transcript,
        ).asCore();
        handedOff = true;
        return channel;
      },
    );
  } catch (error: unknown) {
    throw sanitize(error);
  } finally {
    if (!handedOff) {
      connection?.close();
    }
  }
}

async function acceptHelper(
  factory: ResolvedFactoryOptions,
  options: AcceptSignedHelperSessionOptions,
): Promise<SignedHelperSessionHelperChannel> {
  const binding = validateSignedBinding(options.binding);
  assertConnection(options.connection);
  let handedOff = false;
  try {
    return await withHandshakeDeadline(
      factory.handshakeTimeoutMs,
      options.signal,
      () => options.connection.close(),
      async (signal) => {
        await authorizePeer(factory, "helper", binding, options.connection);
        const hello = parseCoreHello(await readHandshakeFrame(options.connection, signal));
        assertBindingMatches(binding, hello);
        const corePeer = requirePeerKey(factory, hello.coreKeyId);
        const coreNonce = decodeNonce(hello.coreNonce);
        try {
          await claimNonce(factory, "core", binding, coreNonce);
        } finally {
          coreNonce.fill(0);
        }
        verifyRecord(corePeer, CORE_HELLO_LABEL, withoutSignature(hello), hello.signature);

        const helperNonce = await freshNonce(factory, "helper", binding);
        let challenge: HelperChallenge;
        try {
          const unsigned: HelperChallengeUnsigned = {
            type: "helper_challenge_v2",
            ...binding,
            coreKeyId: hello.coreKeyId,
            helperKeyId: factory.localKeyId,
            coreNonce: hello.coreNonce,
            helperNonce: helperNonce.toString("base64url"),
            coreHelloSignature: hello.signature,
          };
          challenge = {
            ...unsigned,
            signature: await signRecord(factory, HELPER_CHALLENGE_LABEL, unsigned),
          };
          await writeHandshakeFrame(options.connection, challenge, signal);
        } finally {
          helperNonce.fill(0);
        }

        const ack = parseCoreAck(await readHandshakeFrame(options.connection, signal));
        assertBindingMatches(binding, ack);
        if (
          ack.coreKeyId !== hello.coreKeyId ||
          ack.helperKeyId !== factory.localKeyId ||
          ack.coreNonce !== hello.coreNonce ||
          ack.helperNonce !== challenge.helperNonce ||
          ack.helperChallengeSignature !== challenge.signature
        ) {
          throw new SessionHelperIpcError("BINDING_MISMATCH");
        }
        verifyRecord(corePeer, CORE_ACK_LABEL, withoutSignature(ack), ack.signature);
        await consumeMigration(corePeer);
        const transcript = transcriptDigest(hello, challenge, ack);
        const channel = new SignedChannel(
          "helper",
          options.connection,
          binding,
          factory,
          corePeer,
          transcript,
        ).asHelper();
        handedOff = true;
        return channel;
      },
    );
  } catch (error: unknown) {
    throw sanitize(error);
  } finally {
    if (!handedOff) {
      options.connection.close();
    }
  }
}

class SignedChannel {
  readonly #role: ChannelRole;
  readonly #connection: SessionHelperIpcConnection;
  readonly #binding: SignedSessionHelperBinding;
  readonly #factory: ResolvedFactoryOptions;
  readonly #peer: ResolvedPeerKey;
  readonly #transcript: `sha256:${string}`;
  #sendSequence = 1n;
  #receiveSequence = 1n;
  #closed = false;
  #sendTail: Promise<void> = Promise.resolve();
  #receiveTail: Promise<unknown> = Promise.resolve();

  public constructor(
    role: ChannelRole,
    connection: SessionHelperIpcConnection,
    binding: SignedSessionHelperBinding,
    factory: ResolvedFactoryOptions,
    peer: ResolvedPeerKey,
    transcript: `sha256:${string}`,
  ) {
    this.#role = role;
    this.#connection = connection;
    this.#binding = binding;
    this.#factory = factory;
    this.#peer = peer;
    this.#transcript = transcript;
  }

  public asCore(): SignedCoreSessionHelperChannel {
    if (this.#role !== "core") {
      throw new SessionHelperIpcError("PROTOCOL_ERROR");
    }
    const isClosed = () => this.#closed;
    return Object.freeze({
      binding: this.#binding,
      get isClosed() {
        return isClosed();
      },
      send: (request: SessionHelperCapabilityRequest, signal?: AbortSignal) =>
        this.#sendRequest(request, signal),
      receive: (signal?: AbortSignal) => this.#receiveResponse(signal),
      close: () => this.close(),
    });
  }

  public asHelper(): SignedHelperSessionHelperChannel {
    if (this.#role !== "helper") {
      throw new SessionHelperIpcError("PROTOCOL_ERROR");
    }
    const isClosed = () => this.#closed;
    return Object.freeze({
      binding: this.#binding,
      get isClosed() {
        return isClosed();
      },
      send: (response: SessionHelperCapabilityResponse, signal?: AbortSignal) =>
        this.#sendResponse(response, signal),
      receive: (signal?: AbortSignal) => this.#receiveRequest(signal),
      close: () => this.close(),
    });
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#connection.close();
  }

  async #sendRequest(request: SessionHelperCapabilityRequest, signal?: AbortSignal): Promise<void> {
    if (this.#role !== "core") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    await this.#enqueueSend(parseCapabilityRequest(request), signal);
  }

  async #sendResponse(
    response: SessionHelperCapabilityResponse,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#role !== "helper") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    await this.#enqueueSend(parseCapabilityResponse(response), signal);
  }

  async #receiveRequest(signal?: AbortSignal): Promise<SessionHelperCapabilityRequest> {
    if (this.#role !== "helper") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    return await this.#enqueueReceive(async () =>
      parseCapabilityRequest(await this.#receivePayload(signal)),
    );
  }

  async #receiveResponse(signal?: AbortSignal): Promise<SessionHelperCapabilityResponse> {
    if (this.#role !== "core") {
      return await this.#fail(new SessionHelperIpcError("PROTOCOL_ERROR"));
    }
    return await this.#enqueueReceive(async () =>
      parseCapabilityResponse(await this.#receivePayload(signal)),
    );
  }

  async #enqueueSend(payload: unknown, signal?: AbortSignal): Promise<void> {
    const operation = this.#sendTail.then(async () => {
      this.#assertOpen();
      if (signal?.aborted === true || this.#sendSequence > MAX_SEQUENCE) {
        throw new SessionHelperIpcError(
          signal?.aborted === true ? "TRANSPORT_FAILURE" : "SEQUENCE_VIOLATION",
        );
      }
      const sequence = this.#sendSequence;
      const direction: SignedDirection =
        this.#role === "core" ? "core-to-helper" : "helper-to-core";
      const unsigned: SignedFrameUnsigned = {
        type: "signed_frame_v2",
        protocolVersion: SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION,
        direction,
        sequence: sequence.toString(),
        serviceEpoch: this.#binding.serviceEpoch,
        handshakeTranscriptSha256: this.#transcript,
        signerKeyId: this.#factory.localKeyId,
        payload,
      };
      const payloadBytes = encodeJson(payload);
      if (payloadBytes.length > this.#factory.maxFrameBytes) {
        payloadBytes.fill(0);
        throw new SessionHelperIpcError("FRAME_TOO_LARGE");
      }
      payloadBytes.fill(0);
      const label = this.#role === "core" ? CORE_FRAME_LABEL : HELPER_FRAME_LABEL;
      const frame: SignedFrame = {
        ...unsigned,
        signature: await signRecord(this.#factory, label, unsigned),
      };
      const encoded = encodeJson(frame);
      try {
        if (encoded.length > this.#factory.maxFrameBytes + SIGNED_FRAME_OVERHEAD_BYTES) {
          throw new SessionHelperIpcError("FRAME_TOO_LARGE");
        }
        await this.#connection.writeFrame(encoded, signal);
        this.#sendSequence = sequence + 1n;
      } finally {
        encoded.fill(0);
      }
    });
    this.#sendTail = operation.catch(() => {});
    try {
      await operation;
    } catch (error: unknown) {
      return await this.#fail(sanitize(error));
    }
  }

  async #enqueueReceive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#receiveTail.then(operation);
    this.#receiveTail = next.catch(() => {});
    try {
      return await next;
    } catch (error: unknown) {
      return await this.#fail(sanitize(error));
    }
  }

  async #receivePayload(signal?: AbortSignal): Promise<unknown> {
    this.#assertOpen();
    if (signal?.aborted === true || this.#receiveSequence > MAX_SEQUENCE) {
      throw new SessionHelperIpcError(
        signal?.aborted === true ? "TRANSPORT_FAILURE" : "SEQUENCE_VIOLATION",
      );
    }
    const frameBytes = await this.#connection.readFrame(
      this.#factory.maxFrameBytes + SIGNED_FRAME_OVERHEAD_BYTES,
      signal,
    );
    if (frameBytes === null) {
      throw new SessionHelperIpcError("CONNECTION_CLOSED");
    }
    let frame: SignedFrame;
    try {
      frame = parseSignedFrame(frameBytes);
    } finally {
      frameBytes.fill(0);
    }
    const expectedDirection = this.#role === "core" ? "helper-to-core" : "core-to-helper";
    if (
      frame.direction !== expectedDirection ||
      frame.sequence !== this.#receiveSequence.toString() ||
      frame.serviceEpoch !== this.#binding.serviceEpoch ||
      frame.handshakeTranscriptSha256 !== this.#transcript ||
      frame.signerKeyId !== this.#peer.keyId
    ) {
      throw new SessionHelperIpcError("SEQUENCE_VIOLATION");
    }
    const payloadBytes = encodeJson(frame.payload);
    if (payloadBytes.length > this.#factory.maxFrameBytes) {
      payloadBytes.fill(0);
      throw new SessionHelperIpcError("FRAME_TOO_LARGE");
    }
    payloadBytes.fill(0);
    verifyRecord(
      this.#peer,
      this.#role === "core" ? HELPER_FRAME_LABEL : CORE_FRAME_LABEL,
      withoutSignature(frame),
      frame.signature,
    );
    this.#receiveSequence += 1n;
    return frame.payload;
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

function resolveFactoryOptions(
  options: SignedSessionHelperIpcFactoryOptions,
): ResolvedFactoryOptions {
  if (
    options === null ||
    typeof options !== "object" ||
    options.signingKeyProvider === undefined ||
    typeof options.signingKeyProvider.sign !== "function" ||
    options.peerAuthorizer === undefined ||
    typeof options.peerAuthorizer.authorize !== "function"
  ) {
    throw new TypeError("The signed session-helper IPC dependencies are required.");
  }
  requireSecretReference(options.localPrivateKeyReference);
  requireKeyId(options.localKeyId);
  if (
    !Array.isArray(options.acceptedPeerKeys) ||
    options.acceptedPeerKeys.length < 1 ||
    options.acceptedPeerKeys.length > 2
  ) {
    throw new TypeError("One active peer key and at most one migration key are required.");
  }
  const peers = new Map<string, ResolvedPeerKey>();
  let activeCount = 0;
  let migrationCount = 0;
  for (const pin of options.acceptedPeerKeys) {
    const peer = parsePeerKey(pin);
    if (peers.has(peer.keyId)) {
      throw new TypeError("The peer signing key pins are duplicated.");
    }
    activeCount += peer.usage === "active" ? 1 : 0;
    migrationCount += peer.usage === "migration" ? 1 : 0;
    peers.set(peer.keyId, peer);
  }
  if (activeCount !== 1 || migrationCount > 1) {
    throw new TypeError("The peer signing key rotation window is invalid.");
  }
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (
    !Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs <= 0 ||
    handshakeTimeoutMs > 60_000 ||
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < MIN_FRAME_BYTES ||
    maxFrameBytes > MAX_FRAME_BYTES
  ) {
    throw new TypeError("The signed session-helper IPC bounds are invalid.");
  }
  return {
    localPrivateKeyReference: options.localPrivateKeyReference,
    localKeyId: options.localKeyId,
    signingKeyProvider: options.signingKeyProvider,
    acceptedPeerKeys: peers,
    peerAuthorizer: options.peerAuthorizer,
    nonceGuard: options.nonceGuard ?? new InMemorySignedNonceReplayGuard(),
    nonceSource: options.nonceSource ?? (() => randomBytes(NONCE_BYTES)),
    handshakeTimeoutMs,
    maxFrameBytes,
  };
}

function parsePeerKey(pin: SessionHelperPeerPublicKey): ResolvedPeerKey {
  if (
    pin === null ||
    typeof pin !== "object" ||
    (pin.usage !== "active" && pin.usage !== "migration") ||
    (pin.usage === "active" && pin.consumeMigration !== undefined) ||
    (pin.usage === "migration" && typeof pin.consumeMigration !== "function")
  ) {
    throw new TypeError("The peer signing key pin is invalid.");
  }
  requireKeyId(pin.keyId);
  const der = decodeCanonicalBase64Url(pin.publicKeySpkiBase64Url, 256);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    der.fill(0);
    throw new TypeError("The peer signing public key is invalid.");
  }
  const actualKeyId = `sha256:${createHash("sha256").update(der).digest("hex")}`;
  der.fill(0);
  if (key.asymmetricKeyType !== "ed25519" || actualKeyId !== pin.keyId) {
    throw new TypeError("The peer signing public key pin does not match its key ID.");
  }
  return {
    keyId: pin.keyId,
    key,
    usage: pin.usage,
    ...(pin.consumeMigration === undefined ? {} : { consumeMigration: pin.consumeMigration }),
  };
}

function validateSignedBinding(value: SignedSessionHelperBinding): SignedSessionHelperBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "deviceId",
      "helperId",
      "sessionId",
      "serviceEpoch",
      "releaseVersion",
    ]) ||
    value.protocolVersion !== SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION ||
    !isIdentifier(value.deviceId) ||
    !isIdentifier(value.helperId) ||
    !isIdentifier(value.sessionId) ||
    !isPositiveInteger(value.serviceEpoch) ||
    !isReleaseVersion(value.releaseVersion)
  ) {
    throw new SessionHelperIpcError("BINDING_MISMATCH");
  }
  return Object.freeze({ ...value });
}

function parseCoreHello(bytes: Buffer): CoreHello {
  const value = parseJson(bytes);
  requireExactHandshakeKeys(value, [
    "type",
    "protocolVersion",
    "deviceId",
    "helperId",
    "sessionId",
    "serviceEpoch",
    "releaseVersion",
    "coreKeyId",
    "coreNonce",
    "signature",
  ]);
  if (
    value.type !== "core_hello_v2" ||
    !isHandshakeBinding(value) ||
    !isKeyId(value.coreKeyId) ||
    !isEncodedNonce(value.coreNonce) ||
    !isEncodedSignature(value.signature)
  ) {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return value as unknown as CoreHello;
}

function parseHelperChallenge(bytes: Buffer): HelperChallenge {
  const value = parseJson(bytes);
  requireExactHandshakeKeys(value, [
    "type",
    "protocolVersion",
    "deviceId",
    "helperId",
    "sessionId",
    "serviceEpoch",
    "releaseVersion",
    "coreKeyId",
    "helperKeyId",
    "coreNonce",
    "helperNonce",
    "coreHelloSignature",
    "signature",
  ]);
  if (
    value.type !== "helper_challenge_v2" ||
    !isHandshakeBinding(value) ||
    !isKeyId(value.coreKeyId) ||
    !isKeyId(value.helperKeyId) ||
    !isEncodedNonce(value.coreNonce) ||
    !isEncodedNonce(value.helperNonce) ||
    !isEncodedSignature(value.coreHelloSignature) ||
    !isEncodedSignature(value.signature)
  ) {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return value as unknown as HelperChallenge;
}

function parseCoreAck(bytes: Buffer): CoreAck {
  const value = parseJson(bytes);
  requireExactHandshakeKeys(value, [
    "type",
    "protocolVersion",
    "deviceId",
    "helperId",
    "sessionId",
    "serviceEpoch",
    "releaseVersion",
    "coreKeyId",
    "helperKeyId",
    "coreNonce",
    "helperNonce",
    "helperChallengeSignature",
    "signature",
  ]);
  if (
    value.type !== "core_ack_v2" ||
    !isHandshakeBinding(value) ||
    !isKeyId(value.coreKeyId) ||
    !isKeyId(value.helperKeyId) ||
    !isEncodedNonce(value.coreNonce) ||
    !isEncodedNonce(value.helperNonce) ||
    !isEncodedSignature(value.helperChallengeSignature) ||
    !isEncodedSignature(value.signature)
  ) {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return value as unknown as CoreAck;
}

function parseSignedFrame(bytes: Buffer): SignedFrame {
  const value = parseJson(bytes);
  if (
    !hasExactKeys(value, [
      "type",
      "protocolVersion",
      "direction",
      "sequence",
      "serviceEpoch",
      "handshakeTranscriptSha256",
      "signerKeyId",
      "payload",
      "signature",
    ]) ||
    value.type !== "signed_frame_v2" ||
    value.protocolVersion !== SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION ||
    (value.direction !== "core-to-helper" && value.direction !== "helper-to-core") ||
    typeof value.sequence !== "string" ||
    !DECIMAL_PATTERN.test(value.sequence) ||
    !isPositiveInteger(value.serviceEpoch) ||
    !isKeyId(value.handshakeTranscriptSha256) ||
    !isKeyId(value.signerKeyId) ||
    !isEncodedSignature(value.signature)
  ) {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return value as unknown as SignedFrame;
}

async function signRecord(
  factory: ResolvedFactoryOptions,
  label: Buffer,
  value: unknown,
): Promise<string> {
  const message = signatureInput(label, value);
  let signature: Buffer;
  try {
    signature = await factory.signingKeyProvider.sign(
      factory.localPrivateKeyReference,
      factory.localKeyId,
      message,
    );
  } catch {
    throw new SessionHelperIpcError("KEY_UNAVAILABLE");
  } finally {
    message.fill(0);
  }
  if (!Buffer.isBuffer(signature) || signature.length !== SIGNATURE_BYTES) {
    if (Buffer.isBuffer(signature)) {
      signature.fill(0);
    }
    throw new SessionHelperIpcError("KEY_UNAVAILABLE");
  }
  try {
    return signature.toString("base64url");
  } finally {
    signature.fill(0);
  }
}

function verifyRecord(
  peer: ResolvedPeerKey,
  label: Buffer,
  value: unknown,
  encodedSignature: string,
): void {
  const message = signatureInput(label, value);
  const signature = decodeSignature(encodedSignature);
  let verified: boolean;
  try {
    verified = verifySignature(null, message, peer.key, signature);
  } catch {
    verified = false;
  } finally {
    message.fill(0);
    signature.fill(0);
  }
  if (!verified) {
    throw new SessionHelperIpcError("AUTHENTICATION_FAILED");
  }
}

function signatureInput(label: Buffer, value: unknown): Buffer {
  const encoded = encodeJson(value);
  try {
    return Buffer.concat([label, encoded]);
  } finally {
    encoded.fill(0);
  }
}

function transcriptDigest(
  hello: CoreHello,
  challenge: HelperChallenge,
  ack: CoreAck,
): `sha256:${string}` {
  const bytes = encodeJson({ hello, challenge, ack });
  try {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } finally {
    bytes.fill(0);
  }
}

function withoutSignature<T extends { readonly signature: string }>(
  value: T,
): Omit<T, "signature"> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "signature")) as Omit<
    T,
    "signature"
  >;
}

async function freshNonce(
  factory: ResolvedFactoryOptions,
  role: "core" | "helper",
  binding: SignedSessionHelperBinding,
): Promise<Buffer> {
  let nonce: Buffer;
  try {
    nonce = factory.nonceSource();
  } catch {
    throw new SessionHelperIpcError("PROTOCOL_ERROR");
  }
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
    if (Buffer.isBuffer(nonce)) {
      nonce.fill(0);
    }
    throw new SessionHelperIpcError("PROTOCOL_ERROR");
  }
  let claimed: boolean;
  try {
    claimed = await factory.nonceGuard.claim(role, binding, nonce);
  } catch {
    claimed = false;
  }
  if (!claimed) {
    nonce.fill(0);
    throw new SessionHelperIpcError("NONCE_REPLAY");
  }
  return nonce;
}

async function claimNonce(
  factory: ResolvedFactoryOptions,
  role: "core" | "helper",
  binding: SignedSessionHelperBinding,
  nonce: Buffer,
): Promise<void> {
  let claimed: boolean;
  try {
    claimed = await factory.nonceGuard.claim(role, binding, nonce);
  } catch {
    claimed = false;
  }
  if (!claimed) {
    throw new SessionHelperIpcError("NONCE_REPLAY");
  }
}

async function authorizePeer(
  factory: ResolvedFactoryOptions,
  localRole: "core" | "helper",
  binding: SignedSessionHelperBinding,
  connection: SessionHelperIpcConnection,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await factory.peerAuthorizer.authorize({
      localRole,
      binding,
      peerIdentity: connection.peerIdentity,
    });
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new SessionHelperIpcError("PEER_REJECTED");
  }
}

function requirePeerKey(factory: ResolvedFactoryOptions, keyId: string): ResolvedPeerKey {
  const peer = factory.acceptedPeerKeys.get(keyId);
  if (peer === undefined) {
    throw new SessionHelperIpcError("AUTHENTICATION_FAILED");
  }
  return peer;
}

async function consumeMigration(peer: ResolvedPeerKey): Promise<void> {
  if (peer.usage !== "migration") {
    return;
  }
  let consumed: boolean;
  try {
    consumed = (await peer.consumeMigration?.()) === true;
  } catch {
    consumed = false;
  }
  if (!consumed) {
    throw new SessionHelperIpcError("KEY_ROTATION_REJECTED");
  }
}

function assertBindingMatches(
  expected: SignedSessionHelperBinding,
  actual: {
    readonly protocolVersion: number;
    readonly deviceId: string;
    readonly helperId: string;
    readonly sessionId: string;
    readonly serviceEpoch: number;
    readonly releaseVersion: string;
  },
): void {
  if (
    actual.protocolVersion !== expected.protocolVersion ||
    actual.deviceId !== expected.deviceId ||
    actual.helperId !== expected.helperId ||
    actual.sessionId !== expected.sessionId ||
    actual.serviceEpoch !== expected.serviceEpoch ||
    actual.releaseVersion !== expected.releaseVersion
  ) {
    throw new SessionHelperIpcError("BINDING_MISMATCH");
  }
}

async function readHandshakeFrame(
  connection: SessionHelperIpcConnection,
  signal: AbortSignal,
): Promise<Buffer> {
  let frame: Buffer | null;
  try {
    frame = await connection.readFrame(HANDSHAKE_MAX_BYTES, signal);
  } catch {
    throw new SessionHelperIpcError("TRANSPORT_FAILURE");
  }
  if (frame === null) {
    throw new SessionHelperIpcError("CONNECTION_CLOSED");
  }
  if (frame.length === 0 || frame.length > HANDSHAKE_MAX_BYTES) {
    frame.fill(0);
    throw new SessionHelperIpcError("FRAME_TOO_LARGE");
  }
  return frame;
}

async function writeHandshakeFrame(
  connection: SessionHelperIpcConnection,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  const frame = encodeJson(value);
  try {
    if (frame.length > HANDSHAKE_MAX_BYTES) {
      throw new SessionHelperIpcError("FRAME_TOO_LARGE");
    }
    await connection.writeFrame(frame, signal);
  } catch (error: unknown) {
    throw sanitize(error);
  } finally {
    frame.fill(0);
  }
}

async function withHandshakeDeadline<T>(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  close: () => void,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort: (error: SessionHelperIpcError) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
      close();
      rejectAbort(new SessionHelperIpcError("TRANSPORT_FAILURE"));
    }
  };
  const timer = setTimeout(abort, timeoutMs);
  externalSignal?.addEventListener("abort", abort, { once: true });
  if (externalSignal?.aborted === true) {
    abort();
  }
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

function assertConnection(
  connection: SessionHelperIpcConnection,
): asserts connection is SessionHelperIpcConnection {
  if (
    connection === null ||
    typeof connection !== "object" ||
    connection.peerIdentity === null ||
    typeof connection.peerIdentity !== "object" ||
    typeof connection.readFrame !== "function" ||
    typeof connection.writeFrame !== "function" ||
    typeof connection.close !== "function"
  ) {
    throw new SessionHelperIpcError("TRANSPORT_FAILURE");
  }
}

function parseJson(bytes: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed)) {
      throw new Error("object");
    }
    return parsed;
  } catch {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  } finally {
    bytes.fill(0);
  }
}

function decodeNonce(value: string): Buffer {
  return decodeCanonicalBase64Url(value, NONCE_BYTES, NONCE_BYTES);
}

function decodeSignature(value: string): Buffer {
  return decodeCanonicalBase64Url(value, SIGNATURE_BYTES, SIGNATURE_BYTES);
}

function decodeCanonicalBase64Url(
  value: string,
  maximumBytes: number,
  exactBytes?: number,
): Buffer {
  if (typeof value !== "string" || value.length === 0 || !BASE64URL_PATTERN.test(value)) {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > maximumBytes ||
    (exactBytes !== undefined && bytes.length !== exactBytes) ||
    bytes.toString("base64url") !== value
  ) {
    bytes.fill(0);
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
  return bytes;
}

function requireSecretReference(value: string): void {
  if (!/^secret:\/\/[A-Za-z0-9._~/-]+$/u.test(value)) {
    throw new TypeError("The plane-local signing Secret reference is invalid.");
  }
}

function requireKeyId(value: string): asserts value is `sha256:${string}` {
  if (!isKeyId(value)) {
    throw new TypeError("The Ed25519 signing key ID is invalid.");
  }
}

function isKeyId(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && KEY_ID_PATTERN.test(value);
}

function isEncodedNonce(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const bytes = decodeNonce(value);
    bytes.fill(0);
    return true;
  } catch {
    return false;
  }
}

function isEncodedSignature(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const bytes = decodeSignature(value);
    bytes.fill(0);
    return true;
  } catch {
    return false;
  }
}

function isHandshakeBinding(value: Record<string, unknown>): boolean {
  return (
    value.protocolVersion === SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION &&
    isIdentifier(value.deviceId) &&
    isIdentifier(value.helperId) &&
    isIdentifier(value.sessionId) &&
    isPositiveInteger(value.serviceEpoch) &&
    isReleaseVersion(value.releaseVersion)
  );
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

function isReleaseVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(value)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireExactHandshakeKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (!hasExactKeys(value, keys)) {
    throw new SessionHelperIpcError("MALFORMED_MESSAGE");
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitize(error: unknown): SessionHelperIpcError {
  return error instanceof SessionHelperIpcError
    ? error
    : new SessionHelperIpcError("PROTOCOL_ERROR");
}

class InMemorySignedNonceReplayGuard {
  readonly #claims = new Set<string>();

  public claim(
    role: "core" | "helper",
    binding: SignedSessionHelperBinding,
    nonce: Buffer,
  ): boolean {
    if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
      return false;
    }
    const claim = createHash("sha256")
      .update(role)
      .update("\0")
      .update(binding.deviceId)
      .update("\0")
      .update(binding.helperId)
      .update("\0")
      .update(binding.sessionId)
      .update("\0")
      .update(String(binding.serviceEpoch))
      .update("\0")
      .update(binding.releaseVersion)
      .update("\0")
      .update(nonce)
      .digest("base64url");
    if (this.#claims.has(claim) || this.#claims.size >= 65_536) {
      return false;
    }
    this.#claims.add(claim);
    return true;
  }
}
