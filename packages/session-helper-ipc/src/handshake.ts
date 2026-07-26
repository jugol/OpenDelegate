import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import {
  createAuthenticatedCoreChannel,
  createAuthenticatedHelperChannel,
  type DirectionKeys,
} from "./authenticated-channel.ts";
import type {
  AcceptHelperSessionOptions,
  ConnectCoreSessionHelperOptions,
  CoreSessionHelperChannel,
  CoreSessionHelperIpc,
  HelperSessionHelperChannel,
  HelperSessionHelperIpc,
  SessionHelperBinding,
  SessionHelperIpcConnection,
  SessionHelperIpcFactoryOptions,
  SessionHelperIpcKeyLease,
  SessionHelperIpcNonceReplayGuard,
} from "./contracts.ts";
import { SessionHelperIpcError } from "./error.ts";
import { InMemoryNonceReplayGuard } from "./nonce-replay-guard.ts";
import {
  bindingMatches,
  createCoreHello,
  createHelperChallenge,
  decodeMac,
  decodeNonce,
  encodeCoreProof,
  encodeJson,
  parseCoreHello,
  parseCoreProof,
  parseHelperChallenge,
  validateBinding,
  type CoreHello,
} from "./schemas.ts";

const KEY_BYTES = 32;
const NONCE_BYTES = 32;
const HANDSHAKE_FRAME_BYTES = 16 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MIN_FRAME_BYTES = 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const HELPER_PROOF_LABEL = Buffer.from(
  "OpenDelegate session-helper IPC v1\0helper-proof\0",
  "utf8",
);
const CORE_PROOF_LABEL = Buffer.from("OpenDelegate session-helper IPC v1\0core-proof\0", "utf8");
const CORE_TO_HELPER_INFO = Buffer.from(
  "OpenDelegate session-helper IPC v1\0core-to-helper\0",
  "utf8",
);
const HELPER_TO_CORE_INFO = Buffer.from(
  "OpenDelegate session-helper IPC v1\0helper-to-core\0",
  "utf8",
);

interface ResolvedFactoryOptions {
  readonly keyProvider: SessionHelperIpcFactoryOptions["keyProvider"];
  readonly peerAuthorizer: SessionHelperIpcFactoryOptions["peerAuthorizer"];
  readonly nonceGuard: SessionHelperIpcNonceReplayGuard;
  readonly nonceSource: () => Buffer;
  readonly handshakeTimeoutMs: number;
  readonly maxFrameBytes: number;
}

export function createCoreSessionHelperIpc(
  options: SessionHelperIpcFactoryOptions,
): CoreSessionHelperIpc {
  const resolved = resolveFactoryOptions(options);
  return Object.freeze({
    async connect(
      connectOptions: ConnectCoreSessionHelperOptions,
    ): Promise<CoreSessionHelperChannel> {
      return await connectCore(resolved, connectOptions);
    },
  });
}

export function createHelperSessionHelperIpc(
  options: SessionHelperIpcFactoryOptions,
): HelperSessionHelperIpc {
  const resolved = resolveFactoryOptions(options);
  return Object.freeze({
    async accept(acceptOptions: AcceptHelperSessionOptions): Promise<HelperSessionHelperChannel> {
      return await acceptHelper(resolved, acceptOptions);
    },
  });
}

async function connectCore(
  factory: ResolvedFactoryOptions,
  options: ConnectCoreSessionHelperOptions,
): Promise<CoreSessionHelperChannel> {
  const binding = validateBinding(options.binding);
  validateKeyReference(options.keyReference);
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
        if (signal.aborted) {
          connection.close();
          throw new SessionHelperIpcError("TRANSPORT_FAILURE");
        }
        await authorizePeer(factory, "core", binding, connection);
        const channel = await performCoreHandshake(
          factory,
          connection,
          binding,
          options.keyReference,
          signal,
        );
        handedOff = true;
        return channel;
      },
    );
  } catch (error: unknown) {
    throw sanitizeHandshakeError(error);
  } finally {
    if (!handedOff) {
      connection?.close();
    }
  }
}

async function acceptHelper(
  factory: ResolvedFactoryOptions,
  options: AcceptHelperSessionOptions,
): Promise<HelperSessionHelperChannel> {
  const binding = validateBinding(options.binding);
  validateKeyReference(options.keyReference);
  assertConnection(options.connection);
  let handedOff = false;
  try {
    return await withHandshakeDeadline(
      factory.handshakeTimeoutMs,
      options.signal,
      () => options.connection.close(),
      async (signal) => {
        if (signal.aborted) {
          throw new SessionHelperIpcError("TRANSPORT_FAILURE");
        }
        await authorizePeer(factory, "helper", binding, options.connection);
        if (signal.aborted) {
          throw new SessionHelperIpcError("TRANSPORT_FAILURE");
        }
        const channel = await performHelperHandshake(
          factory,
          options.connection,
          binding,
          options.keyReference,
          signal,
        );
        handedOff = true;
        return channel;
      },
    );
  } catch (error: unknown) {
    throw sanitizeHandshakeError(error);
  } finally {
    if (!handedOff) {
      options.connection.close();
    }
  }
}

async function performCoreHandshake(
  factory: ResolvedFactoryOptions,
  connection: SessionHelperIpcConnection,
  binding: SessionHelperBinding,
  keyReference: string,
  signal: AbortSignal,
): Promise<CoreSessionHelperChannel> {
  let lease: SessionHelperIpcKeyLease | undefined;
  let coreNonce: Buffer | undefined;
  let helperNonce: Buffer | undefined;
  let transcript: Buffer | undefined;
  let keys: DirectionKeys | undefined;
  let handedOff = false;
  try {
    lease = await acquireKey(factory, keyReference, { mode: "initiate" }, signal);
    if (lease.usage !== "active") {
      throw new SessionHelperIpcError("KEY_UNAVAILABLE");
    }
    coreNonce = await createFreshNonce(factory, "core", binding);
    const hello = createCoreHello(binding, lease.keyId, coreNonce);
    await writeHandshakeFrame(connection, encodeJson(hello), signal);

    const challengeFrame = await readHandshakeFrame(connection, signal);
    let challenge;
    try {
      challenge = parseHelperChallenge(challengeFrame);
    } finally {
      challengeFrame.fill(0);
    }
    if (
      !bindingMatches(binding, challenge) ||
      challenge.keyId !== lease.keyId ||
      challenge.coreNonce !== hello.coreNonce
    ) {
      throw new SessionHelperIpcError("BINDING_MISMATCH");
    }
    helperNonce = decodeNonce(challenge.helperNonce);
    if (coreNonce.equals(helperNonce)) {
      throw new SessionHelperIpcError("NONCE_REPLAY");
    }
    await claimNonce(factory, "helper", binding, helperNonce);
    transcript = createHandshakeTranscript(hello, challenge.helperNonce);
    const receivedHelperProof = decodeMac(challenge.proof);
    const expectedHelperProof = createProof(lease.material, HELPER_PROOF_LABEL, transcript);
    const helperAuthenticated = timingSafeEqual(receivedHelperProof, expectedHelperProof);
    receivedHelperProof.fill(0);
    expectedHelperProof.fill(0);
    if (!helperAuthenticated) {
      throw new SessionHelperIpcError("AUTHENTICATION_FAILED");
    }

    const coreProof = createProof(lease.material, CORE_PROOF_LABEL, transcript);
    try {
      await writeHandshakeFrame(connection, encodeCoreProof(coreProof), signal);
    } finally {
      coreProof.fill(0);
    }
    keys = deriveDirectionKeys(lease.material, transcript);
    const channel = createAuthenticatedCoreChannel(
      connection,
      binding,
      keys,
      factory.maxFrameBytes,
    );
    await channel.receiveAuthenticationAck();
    handedOff = true;
    return channel;
  } finally {
    disposeKeyLease(lease);
    coreNonce?.fill(0);
    helperNonce?.fill(0);
    transcript?.fill(0);
    if (!handedOff) {
      keys?.coreToHelper.fill(0);
      keys?.helperToCore.fill(0);
    }
  }
}

async function performHelperHandshake(
  factory: ResolvedFactoryOptions,
  connection: SessionHelperIpcConnection,
  binding: SessionHelperBinding,
  keyReference: string,
  signal: AbortSignal,
): Promise<HelperSessionHelperChannel> {
  let lease: SessionHelperIpcKeyLease | undefined;
  let coreNonce: Buffer | undefined;
  let helperNonce: Buffer | undefined;
  let transcript: Buffer | undefined;
  let keys: DirectionKeys | undefined;
  let handedOff = false;
  try {
    const helloFrame = await readHandshakeFrame(connection, signal);
    let hello: CoreHello;
    try {
      hello = parseCoreHello(helloFrame);
    } finally {
      helloFrame.fill(0);
    }
    if (!bindingMatches(binding, hello)) {
      throw new SessionHelperIpcError("BINDING_MISMATCH");
    }
    coreNonce = decodeNonce(hello.coreNonce);
    await claimNonce(factory, "core", binding, coreNonce);
    lease = await acquireKey(factory, keyReference, { mode: "verify", keyId: hello.keyId }, signal);
    helperNonce = await createFreshNonce(factory, "helper", binding);
    if (coreNonce.equals(helperNonce)) {
      throw new SessionHelperIpcError("NONCE_REPLAY");
    }
    const helperNonceEncoded = helperNonce.toString("base64url");
    transcript = createHandshakeTranscript(hello, helperNonceEncoded);
    const helperProof = createProof(lease.material, HELPER_PROOF_LABEL, transcript);
    try {
      const challenge = createHelperChallenge(hello, helperNonce, helperProof);
      await writeHandshakeFrame(connection, encodeJson(challenge), signal);
    } finally {
      helperProof.fill(0);
    }

    const coreProofFrame = await readHandshakeFrame(connection, signal);
    let coreProof;
    try {
      coreProof = parseCoreProof(coreProofFrame);
    } finally {
      coreProofFrame.fill(0);
    }
    const receivedCoreProof = decodeMac(coreProof.proof);
    const expectedCoreProof = createProof(lease.material, CORE_PROOF_LABEL, transcript);
    const coreAuthenticated = timingSafeEqual(receivedCoreProof, expectedCoreProof);
    receivedCoreProof.fill(0);
    expectedCoreProof.fill(0);
    if (!coreAuthenticated) {
      throw new SessionHelperIpcError("AUTHENTICATION_FAILED");
    }
    if (lease.usage === "migration") {
      if (lease.consumeMigration === undefined) {
        throw new SessionHelperIpcError("KEY_ROTATION_REJECTED");
      }
      let consumed = false;
      try {
        consumed = await lease.consumeMigration();
      } catch {
        consumed = false;
      }
      if (!consumed) {
        throw new SessionHelperIpcError("KEY_ROTATION_REJECTED");
      }
    }

    keys = deriveDirectionKeys(lease.material, transcript);
    const channel = createAuthenticatedHelperChannel(
      connection,
      binding,
      keys,
      factory.maxFrameBytes,
    );
    await channel.sendAuthenticationAck();
    handedOff = true;
    return channel;
  } finally {
    disposeKeyLease(lease);
    coreNonce?.fill(0);
    helperNonce?.fill(0);
    transcript?.fill(0);
    if (!handedOff) {
      keys?.coreToHelper.fill(0);
      keys?.helperToCore.fill(0);
    }
  }
}

function resolveFactoryOptions(options: SessionHelperIpcFactoryOptions): ResolvedFactoryOptions {
  if (
    options === null ||
    typeof options !== "object" ||
    options.keyProvider === undefined ||
    options.peerAuthorizer === undefined
  ) {
    throw new TypeError("The session-helper IPC dependencies are required.");
  }
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs <= 0 ||
    handshakeTimeoutMs > 60_000
  ) {
    throw new TypeError("The session-helper IPC handshake timeout is invalid.");
  }
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < MIN_FRAME_BYTES ||
    maxFrameBytes > MAX_FRAME_BYTES
  ) {
    throw new TypeError("The session-helper IPC frame bound is invalid.");
  }
  return {
    keyProvider: options.keyProvider,
    peerAuthorizer: options.peerAuthorizer,
    nonceGuard: options.nonceGuard ?? new InMemoryNonceReplayGuard(),
    nonceSource: options.nonceSource ?? (() => randomBytes(NONCE_BYTES)),
    handshakeTimeoutMs,
    maxFrameBytes,
  };
}

async function authorizePeer(
  factory: ResolvedFactoryOptions,
  localRole: "core" | "helper",
  binding: SessionHelperBinding,
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
    throw new SessionHelperIpcError("PEER_REJECTED");
  }
  if (!allowed) {
    throw new SessionHelperIpcError("PEER_REJECTED");
  }
}

async function acquireKey(
  factory: ResolvedFactoryOptions,
  reference: string,
  request: { readonly mode: "initiate" } | { readonly mode: "verify"; readonly keyId: string },
  signal: AbortSignal,
): Promise<SessionHelperIpcKeyLease> {
  let lease: SessionHelperIpcKeyLease | null;
  try {
    lease = await factory.keyProvider.acquire(reference, request);
  } catch {
    throw new SessionHelperIpcError("KEY_UNAVAILABLE");
  }
  if (signal.aborted) {
    disposeKeyLease(lease ?? undefined);
    throw new SessionHelperIpcError("TRANSPORT_FAILURE");
  }
  if (
    lease === null ||
    !isKeyId(lease.keyId) ||
    !Buffer.isBuffer(lease.material) ||
    lease.material.length !== KEY_BYTES ||
    (lease.usage !== "active" && lease.usage !== "migration") ||
    (request.mode === "verify" && lease.keyId !== request.keyId)
  ) {
    disposeKeyLease(lease ?? undefined);
    throw new SessionHelperIpcError("KEY_UNAVAILABLE");
  }
  return lease;
}

async function createFreshNonce(
  factory: ResolvedFactoryOptions,
  role: "core" | "helper",
  binding: SessionHelperBinding,
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
  try {
    await claimNonce(factory, role, binding, nonce);
    return nonce;
  } catch (error: unknown) {
    nonce.fill(0);
    throw error;
  }
}

async function claimNonce(
  factory: ResolvedFactoryOptions,
  role: "core" | "helper",
  binding: SessionHelperBinding,
  nonce: Buffer,
): Promise<void> {
  let claimed: boolean;
  try {
    claimed = await factory.nonceGuard.claim(role, binding, nonce);
  } catch {
    throw new SessionHelperIpcError("NONCE_REPLAY");
  }
  if (!claimed) {
    throw new SessionHelperIpcError("NONCE_REPLAY");
  }
}

function createHandshakeTranscript(hello: CoreHello, helperNonce: string): Buffer {
  return encodeJson({
    protocol: "opendelegate-session-helper-ipc",
    protocolVersion: hello.protocolVersion,
    deviceId: hello.deviceId,
    helperId: hello.helperId,
    sessionId: hello.sessionId,
    serviceEpoch: hello.serviceEpoch,
    releaseVersion: hello.releaseVersion,
    keyId: hello.keyId,
    coreNonce: hello.coreNonce,
    helperNonce,
  });
}

function createProof(key: Buffer, label: Buffer, transcript: Buffer): Buffer {
  return createHmac("sha256", key).update(label).update(transcript).digest();
}

function deriveDirectionKeys(key: Buffer, transcript: Buffer): DirectionKeys {
  const salt = createHash("sha256").update(transcript).digest();
  try {
    return {
      coreToHelper: Buffer.from(hkdfSync("sha256", key, salt, CORE_TO_HELPER_INFO, KEY_BYTES)),
      helperToCore: Buffer.from(hkdfSync("sha256", key, salt, HELPER_TO_CORE_INFO, KEY_BYTES)),
    };
  } finally {
    salt.fill(0);
  }
}

async function readHandshakeFrame(
  connection: SessionHelperIpcConnection,
  signal: AbortSignal,
): Promise<Buffer> {
  let frame: Buffer | null;
  try {
    frame = await connection.readFrame(HANDSHAKE_FRAME_BYTES, signal);
  } catch {
    throw new SessionHelperIpcError("TRANSPORT_FAILURE");
  }
  if (frame === null) {
    throw new SessionHelperIpcError("CONNECTION_CLOSED");
  }
  if (!Buffer.isBuffer(frame)) {
    throw new SessionHelperIpcError("PROTOCOL_ERROR");
  }
  if (frame.length === 0 || frame.length > HANDSHAKE_FRAME_BYTES) {
    frame.fill(0);
    throw new SessionHelperIpcError(
      frame.length > HANDSHAKE_FRAME_BYTES ? "FRAME_TOO_LARGE" : "PROTOCOL_ERROR",
    );
  }
  return frame;
}

async function writeHandshakeFrame(
  connection: SessionHelperIpcConnection,
  frame: Buffer,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (frame.length === 0 || frame.length > HANDSHAKE_FRAME_BYTES) {
      throw new SessionHelperIpcError("FRAME_TOO_LARGE");
    }
    await connection.writeFrame(frame, signal);
  } catch (error: unknown) {
    if (error instanceof SessionHelperIpcError) {
      throw error;
    }
    throw new SessionHelperIpcError("TRANSPORT_FAILURE");
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
  const timeout = setTimeout(abort, timeoutMs);
  externalSignal?.addEventListener("abort", abort, { once: true });
  if (externalSignal?.aborted === true) {
    abort();
  }
  const pending = operation(controller.signal);
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    clearTimeout(timeout);
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

function validateKeyReference(reference: string): void {
  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    reference.length > 512 ||
    reference !== reference.trim() ||
    hasControlCharacter(reference)
  ) {
    throw new TypeError("The opaque local IPC key reference is invalid.");
  }
}

function isKeyId(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function disposeKeyLease(lease: SessionHelperIpcKeyLease | undefined): void {
  if (lease !== undefined && Buffer.isBuffer(lease.material)) {
    lease.material.fill(0);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

function sanitizeHandshakeError(error: unknown): SessionHelperIpcError {
  return error instanceof SessionHelperIpcError
    ? error
    : new SessionHelperIpcError("PROTOCOL_ERROR");
}
