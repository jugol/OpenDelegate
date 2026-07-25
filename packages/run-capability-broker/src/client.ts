import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";

import {
  RUN_CAPABILITY_PROTOCOL_VERSION,
  RunCapabilityBrokerError,
  type RunCapabilityBinding,
  type RunCapabilityClient,
  type RunCapabilityJsonValue,
} from "./contracts.ts";
import { decodeFrame, readFrames, writeFrame } from "./framing.ts";
import {
  normalizeBinding,
  normalizeJsonValue,
  requireExactKeys,
  requireIdentifier,
  requirePositiveInteger,
  requireRecord,
  requireTimestamp,
} from "./validation.ts";

const MAXIMUM_CAPABILITY_FILE_BYTES = 64 * 1024;
const MAXIMUM_FRAME_BYTES = 16 * 1024 * 1024;
const CONNECTION_TIMEOUT_MS = 15_000;

interface CapabilityDescriptor {
  readonly capabilityId: string;
  readonly capability: string;
  readonly endpoint: {
    readonly kind: "unix-domain-socket" | "windows-named-pipe";
    readonly path: string;
  };
  readonly token: string;
  readonly expiresAtMs: number;
  readonly maxFrameBytes: number;
}

interface PendingRequest {
  readonly sequence: number;
  readonly resolve: (value: RunCapabilityJsonValue) => void;
  readonly reject: (error: RunCapabilityBrokerError) => void;
}

export async function consumeRunCapabilityFile(input: {
  readonly filename: string;
  readonly expectedCapability: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly clock?: { now(): number };
  readonly signal?: AbortSignal;
}): Promise<RunCapabilityClient> {
  const expectedCapability = requireIdentifier(input.expectedCapability, 128);
  const hostPlatform = input.hostPlatform ?? process.platform;
  let handle;
  let bytes: Buffer | undefined;
  try {
    const flags =
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(input.filename, flags);
    const metadata = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(input.filename, { bigint: true });
    if (
      !metadata.isFile() ||
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      metadata.size <= 0n ||
      metadata.size > BigInt(MAXIMUM_CAPABILITY_FILE_BYTES) ||
      !sameCapabilitySnapshot(metadata, pathMetadata) ||
      (hostPlatform !== "win32" &&
        ((metadata.mode & 0o077n) !== 0n ||
          (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))))
    ) {
      throw new RunCapabilityBrokerError("CAPABILITY_FILE_UNSAFE");
    }
    bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    if (
      BigInt(bytes.byteLength) !== metadata.size ||
      !sameCapabilitySnapshot(metadata, afterRead)
    ) {
      throw new RunCapabilityBrokerError("CAPABILITY_FILE_UNSAFE");
    }
    const pathAfterRead = await lstat(input.filename, { bigint: true });
    if (
      !pathAfterRead.isFile() ||
      pathAfterRead.isSymbolicLink() ||
      !sameCapabilitySnapshot(metadata, pathAfterRead)
    ) {
      throw new RunCapabilityBrokerError("CAPABILITY_FILE_UNSAFE");
    }
    await handle.close();
    handle = undefined;
    await unlink(input.filename);
    const descriptor = parseDescriptor(JSON.parse(bytes.toString("utf8")));
    if (descriptor.capability !== expectedCapability) {
      throw new RunCapabilityBrokerError("CAPABILITY_FILE_INVALID");
    }
    if (
      (hostPlatform === "win32" && descriptor.endpoint.kind !== "windows-named-pipe") ||
      (hostPlatform !== "win32" && descriptor.endpoint.kind !== "unix-domain-socket")
    ) {
      throw new RunCapabilityBrokerError("CAPABILITY_FILE_INVALID");
    }
    const now = requireTimestamp((input.clock ?? { now: () => Date.now() }).now());
    if (now >= descriptor.expiresAtMs) {
      throw new RunCapabilityBrokerError("CAPABILITY_EXPIRED");
    }
    return await LocalRunCapabilityClient.connect(descriptor, input.signal);
  } catch (error) {
    if (error instanceof RunCapabilityBrokerError) {
      throw error;
    }
    throw new RunCapabilityBrokerError("CAPABILITY_FILE_INVALID");
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

function sameCapabilitySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameCapabilityFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameCapabilityFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino === right.ino &&
    (left.dev === right.dev ||
      (process.platform === "win32" &&
        (left.dev === 0n || right.dev === 0n) &&
        left.birthtimeNs === right.birthtimeNs))
  );
}

class LocalRunCapabilityClient implements RunCapabilityClient {
  public readonly capability: string;
  public readonly binding: RunCapabilityBinding;
  public readonly metadata: RunCapabilityJsonValue;
  readonly #socket: Socket;
  readonly #frames: AsyncGenerator<Buffer>;
  readonly #maxFrameBytes: number;
  readonly #pending = new Map<string, PendingRequest>();
  #nextSequence = 1;
  #closed = false;
  #writeQueue = Promise.resolve();

  private constructor(
    socket: Socket,
    frames: AsyncGenerator<Buffer>,
    capability: string,
    binding: RunCapabilityBinding,
    metadata: RunCapabilityJsonValue,
    maxFrameBytes: number,
  ) {
    this.#socket = socket;
    this.#frames = frames;
    this.capability = capability;
    this.binding = binding;
    this.metadata = metadata;
    this.#maxFrameBytes = maxFrameBytes;
    void this.#pump();
  }

  public static async connect(
    descriptor: CapabilityDescriptor,
    signal?: AbortSignal,
  ): Promise<LocalRunCapabilityClient> {
    const socket = createConnection({ path: descriptor.endpoint.path });
    socket.setNoDelay(true);
    await waitForConnection(socket, signal);
    const frames = readFrames(socket, descriptor.maxFrameBytes);
    try {
      await writeFrame(
        socket,
        {
          schemaVersion: RUN_CAPABILITY_PROTOCOL_VERSION,
          type: "claim",
          capabilityId: descriptor.capabilityId,
          capability: descriptor.capability,
          token: descriptor.token,
        },
        descriptor.maxFrameBytes,
      );
      const first = await frames.next();
      if (first.done) {
        throw new RunCapabilityBrokerError("CONNECTION_FAILED");
      }
      const response = parseClaimResponse(decodeFrame(first.value), descriptor.capability);
      return new LocalRunCapabilityClient(
        socket,
        frames,
        response.capability,
        response.binding,
        response.metadata,
        descriptor.maxFrameBytes,
      );
    } catch (error) {
      socket.destroy();
      if (error instanceof RunCapabilityBrokerError) {
        throw error;
      }
      throw new RunCapabilityBrokerError("CONNECTION_FAILED");
    }
  }

  public request(input: {
    readonly method: string;
    readonly payload: RunCapabilityJsonValue;
    readonly signal?: AbortSignal;
  }): Promise<RunCapabilityJsonValue> {
    if (this.#closed) {
      return Promise.reject(new RunCapabilityBrokerError("CAPABILITY_REVOKED"));
    }
    const method = requireIdentifier(input.method, 128);
    const payload = normalizeJsonValue(input.payload, this.#maxFrameBytes - 4_096);
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;
    const requestId = `${sequence}:${randomUUID()}`;
    const result = new Promise<RunCapabilityJsonValue>((resolve, reject) => {
      this.#pending.set(requestId, {
        sequence,
        resolve,
        reject,
      });
    });
    this.#writeQueue = this.#writeQueue.then(() =>
      writeFrame(
        this.#socket,
        {
          schemaVersion: RUN_CAPABILITY_PROTOCOL_VERSION,
          type: "request",
          sequence,
          requestId,
          method,
          payload,
        },
        this.#maxFrameBytes,
      ),
    );
    void this.#writeQueue.catch(() =>
      this.#failAll(new RunCapabilityBrokerError("CONNECTION_FAILED")),
    );
    if (input.signal !== undefined) {
      const cancel = (): void => {
        const pending = this.#pending.get(requestId);
        if (pending === undefined) {
          return;
        }
        this.#pending.delete(requestId);
        pending.reject(new RunCapabilityBrokerError("REQUEST_CANCELLED"));
        const cancelSequence = this.#nextSequence;
        this.#nextSequence += 1;
        this.#writeQueue = this.#writeQueue.then(() =>
          writeFrame(
            this.#socket,
            {
              schemaVersion: RUN_CAPABILITY_PROTOCOL_VERSION,
              type: "cancel",
              sequence: cancelSequence,
              requestId,
            },
            this.#maxFrameBytes,
          ),
        );
      };
      if (input.signal.aborted) {
        cancel();
      } else {
        input.signal.addEventListener("abort", cancel, { once: true });
        void result
          .finally(() => input.signal?.removeEventListener("abort", cancel))
          .catch(() => undefined);
      }
    }
    return result;
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#socket.destroy();
    this.#failAll(new RunCapabilityBrokerError("CAPABILITY_REVOKED"));
  }

  async #pump(): Promise<void> {
    try {
      for await (const bytes of this.#frames) {
        const response = parseResult(decodeFrame(bytes));
        const pending = this.#pending.get(response.requestId);
        if (pending === undefined) {
          continue;
        }
        if (pending.sequence !== response.sequence) {
          throw new RunCapabilityBrokerError("FRAME_INVALID");
        }
        this.#pending.delete(response.requestId);
        if (response.outcome === "ok") {
          pending.resolve(response.result);
        } else {
          pending.reject(new RunCapabilityBrokerError(response.error));
        }
      }
      if (!this.#closed) {
        throw new RunCapabilityBrokerError("CONNECTION_FAILED");
      }
    } catch (error) {
      this.#closed = true;
      this.#socket.destroy();
      this.#failAll(
        error instanceof RunCapabilityBrokerError
          ? error
          : new RunCapabilityBrokerError("CONNECTION_FAILED"),
      );
    }
  }

  #failAll(error: RunCapabilityBrokerError): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function parseDescriptor(value: unknown): CapabilityDescriptor {
  const record = requireRecord(value);
  requireExactKeys(record, [
    "schemaVersion",
    "capabilityId",
    "capability",
    "endpoint",
    "token",
    "expiresAtMs",
    "maxFrameBytes",
  ]);
  if (record["schemaVersion"] !== RUN_CAPABILITY_PROTOCOL_VERSION) {
    throw new RunCapabilityBrokerError("CAPABILITY_FILE_INVALID");
  }
  const endpoint = requireRecord(record["endpoint"]);
  requireExactKeys(endpoint, ["kind", "path"]);
  if (endpoint["kind"] !== "unix-domain-socket" && endpoint["kind"] !== "windows-named-pipe") {
    throw new RunCapabilityBrokerError("CAPABILITY_FILE_INVALID");
  }
  const token = record["token"];
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new RunCapabilityBrokerError("CAPABILITY_FILE_INVALID");
  }
  return {
    capabilityId: requireIdentifier(record["capabilityId"], 96),
    capability: requireIdentifier(record["capability"], 128),
    endpoint: {
      kind: endpoint["kind"],
      path: requireIdentifier(endpoint["path"], 1_024),
    },
    token,
    expiresAtMs: requireTimestamp(record["expiresAtMs"]),
    maxFrameBytes: requireBoundedFrameBytes(record["maxFrameBytes"]),
  };
}

function requireBoundedFrameBytes(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 4_096 ||
    value > MAXIMUM_FRAME_BYTES
  ) {
    throw new RunCapabilityBrokerError("CAPABILITY_FILE_INVALID");
  }
  return value;
}

function parseClaimResponse(
  value: unknown,
  expectedCapability: string,
): {
  readonly capability: string;
  readonly binding: RunCapabilityBinding;
  readonly metadata: RunCapabilityJsonValue;
} {
  const record = requireRecord(value);
  if (record["type"] === "claim-error") {
    requireExactKeys(record, ["schemaVersion", "type", "error"]);
    const error = record["error"];
    if (
      record["schemaVersion"] !== RUN_CAPABILITY_PROTOCOL_VERSION ||
      (error !== "CAPABILITY_CONSUMED" &&
        error !== "CAPABILITY_EXPIRED" &&
        error !== "CAPABILITY_REVOKED")
    ) {
      throw new RunCapabilityBrokerError("FRAME_INVALID");
    }
    throw new RunCapabilityBrokerError(error);
  }
  requireExactKeys(record, ["schemaVersion", "type", "capability", "binding", "metadata"]);
  const capability = requireIdentifier(record["capability"], 128);
  if (
    record["schemaVersion"] !== RUN_CAPABILITY_PROTOCOL_VERSION ||
    record["type"] !== "claimed" ||
    capability !== expectedCapability
  ) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  return {
    capability,
    binding: normalizeBinding(record["binding"]),
    metadata: normalizeJsonValue(record["metadata"], MAXIMUM_FRAME_BYTES / 2),
  };
}

type ParsedResult =
  | {
      readonly outcome: "ok";
      readonly sequence: number;
      readonly requestId: string;
      readonly result: RunCapabilityJsonValue;
    }
  | {
      readonly outcome: "error";
      readonly sequence: number;
      readonly requestId: string;
      readonly error: "CAPABILITY_REVOKED" | "REQUEST_CANCELLED" | "REQUEST_FAILED";
    };

function parseResult(value: unknown): ParsedResult {
  const record = requireRecord(value);
  if (record["outcome"] === "ok") {
    requireExactKeys(record, [
      "schemaVersion",
      "type",
      "sequence",
      "requestId",
      "outcome",
      "result",
    ]);
    if (
      record["schemaVersion"] !== RUN_CAPABILITY_PROTOCOL_VERSION ||
      record["type"] !== "result"
    ) {
      throw new RunCapabilityBrokerError("FRAME_INVALID");
    }
    return {
      outcome: "ok",
      sequence: requirePositiveInteger(record["sequence"]),
      requestId: requireIdentifier(record["requestId"], 128),
      result: normalizeJsonValue(record["result"], MAXIMUM_FRAME_BYTES / 2),
    };
  }
  requireExactKeys(record, ["schemaVersion", "type", "sequence", "requestId", "outcome", "error"]);
  const error = record["error"];
  if (
    record["schemaVersion"] !== RUN_CAPABILITY_PROTOCOL_VERSION ||
    record["type"] !== "result" ||
    record["outcome"] !== "error" ||
    (error !== "CAPABILITY_REVOKED" && error !== "REQUEST_CANCELLED" && error !== "REQUEST_FAILED")
  ) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  return {
    outcome: "error",
    sequence: requirePositiveInteger(record["sequence"]),
    requestId: requireIdentifier(record["requestId"], 128),
    error,
  };
}

async function waitForConnection(socket: Socket, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => fail(), CONNECTION_TIMEOUT_MS);
    timeout.unref();
    const connected = (): void => {
      cleanup();
      resolve();
    };
    const fail = (): void => {
      cleanup();
      socket.destroy();
      reject(new RunCapabilityBrokerError("CONNECTION_FAILED"));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("connect", connected);
      socket.off("error", fail);
      signal?.removeEventListener("abort", fail);
    };
    socket.once("connect", connected);
    socket.once("error", fail);
    signal?.addEventListener("abort", fail, { once: true });
    if (signal?.aborted === true) {
      fail();
    }
  });
}
