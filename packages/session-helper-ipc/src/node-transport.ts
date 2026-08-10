import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isAbsolute } from "node:path";

import type {
  SessionHelperIpcConnection,
  SessionHelperIpcEndpoint,
  SessionHelperIpcListener,
  SessionHelperIpcPeerIdentity,
  SessionHelperIpcTransport,
} from "./contracts.ts";
import { SessionHelperIpcError } from "./error.ts";

const LENGTH_PREFIX_BYTES = 4;
const ABSOLUTE_MAX_WIRE_FRAME_BYTES = 64 * 1024 * 1024 + 128;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const LOCAL_PIPE_PATTERN =
  /^\\\\\.\\pipe\\OpenDelegate(?:\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)+$/u;

export interface NodeSessionHelperIpcTransportOptions {
  readonly platform?: NodeJS.Platform;
}

export function createNodeSessionHelperIpcTransport(
  options: NodeSessionHelperIpcTransportOptions = {},
): SessionHelperIpcTransport {
  const platform = options.platform ?? process.platform;
  return Object.freeze({
    async connect(
      endpoint: SessionHelperIpcEndpoint,
      signal?: AbortSignal,
    ): Promise<SessionHelperIpcConnection> {
      const path = validateEndpoint(endpoint, platform);
      if (signal?.aborted === true) {
        throw new SessionHelperIpcError("TRANSPORT_FAILURE");
      }
      const socket = createConnection({ path });
      return await waitForConnection(socket, endpoint.kind, signal);
    },
    async listen(
      endpoint: SessionHelperIpcEndpoint,
      onConnection: (connection: SessionHelperIpcConnection) => void | Promise<void>,
    ): Promise<SessionHelperIpcListener> {
      const path = validateEndpoint(endpoint, platform);
      if (typeof onConnection !== "function") {
        throw new TypeError("The local IPC connection handler is required.");
      }
      const server = createServer((socket) => {
        const connection = new NodeFramedConnection(
          socket,
          Object.freeze({ transport: endpoint.kind }),
        );
        let accepted: void | Promise<void>;
        try {
          accepted = onConnection(connection);
        } catch {
          connection.close();
          return;
        }
        Promise.resolve(accepted).catch(() => {
          connection.close();
        });
      });
      await listenServer(server, path, endpoint.kind);
      return createListener(server);
    },
  });
}

function validateEndpoint(endpoint: SessionHelperIpcEndpoint, platform: NodeJS.Platform): string {
  if (endpoint === null || typeof endpoint !== "object") {
    throw new TypeError("The local IPC endpoint is invalid.");
  }
  if (endpoint.kind === "windows-named-pipe") {
    if (platform !== "win32" || !LOCAL_PIPE_PATTERN.test(endpoint.path)) {
      throw new TypeError("The endpoint must be a local OpenDelegate Windows named pipe.");
    }
    return endpoint.path;
  }
  if (endpoint.kind === "unix-domain-socket") {
    if (
      platform === "win32" ||
      typeof endpoint.path !== "string" ||
      !isAbsolute(endpoint.path) ||
      endpoint.path.includes("\u0000") ||
      Buffer.byteLength(endpoint.path, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES
    ) {
      throw new TypeError("The endpoint must be a bounded absolute Unix-domain socket path.");
    }
    return endpoint.path;
  }
  throw new TypeError("The local IPC endpoint kind is invalid.");
}

async function waitForConnection(
  socket: Socket,
  transport: "unix-domain-socket" | "windows-named-pipe",
  signal?: AbortSignal,
): Promise<SessionHelperIpcConnection> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onConnect = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(new NodeFramedConnection(socket, Object.freeze({ transport })));
    };
    const onError = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      reject(new SessionHelperIpcError("TRANSPORT_FAILURE"));
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      reject(new SessionHelperIpcError("TRANSPORT_FAILURE"));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function listenServer(
  server: Server,
  path: string,
  transport: "unix-domain-socket" | "windows-named-pipe",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      server.removeListener("listening", onListening);
      server.removeListener("error", onError);
    };
    const onListening = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      // Retain a redacting error handler for errors after the listener is active.
      server.on("error", () => {});
      resolve();
    };
    const onError = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new SessionHelperIpcError("TRANSPORT_FAILURE"));
    };
    server.once("listening", onListening);
    server.once("error", onError);
    // The Windows helper runs in the interactive owner session while the core
    // connects as a virtual-service account. Node's default named-pipe DACL is
    // scoped to the creating user and otherwise makes that required cross-plane
    // connection read-only. The pipe carries no ambient authority: both peers
    // still have to complete the pinned Ed25519 mutual-signature handshake
    // before any frame is accepted.
    server.listen(
      transport === "windows-named-pipe"
        ? { path, readableAll: true, writableAll: true }
        : { path },
    );
  });
}

function createListener(server: Server): SessionHelperIpcListener {
  let closed = false;
  return Object.freeze({
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  });
}

interface PendingReader {
  readonly maxBytes: number;
  readonly resolve: (frame: Buffer | null) => void;
  readonly reject: (error: SessionHelperIpcError) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

class NodeFramedConnection implements SessionHelperIpcConnection {
  public readonly peerIdentity: SessionHelperIpcPeerIdentity;
  readonly #socket: Socket;
  readonly #frames: Buffer[] = [];
  readonly #readers: PendingReader[] = [];
  #buffer = Buffer.alloc(0);
  #closed = false;
  #failure: SessionHelperIpcError | undefined;

  public constructor(socket: Socket, peerIdentity: SessionHelperIpcPeerIdentity) {
    this.#socket = socket;
    this.peerIdentity = peerIdentity;
    socket.on("data", (chunk: Buffer) => this.#acceptBytes(chunk));
    socket.on("end", () => this.#finish());
    socket.on("close", () => this.#finish());
    socket.on("error", () => this.#fail(new SessionHelperIpcError("TRANSPORT_FAILURE")));
  }

  public async readFrame(maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > ABSOLUTE_MAX_WIRE_FRAME_BYTES
    ) {
      throw new SessionHelperIpcError("FRAME_TOO_LARGE");
    }
    const queued = this.#frames.shift();
    if (queued !== undefined) {
      if (queued.length > maxBytes) {
        queued.fill(0);
        this.#fail(new SessionHelperIpcError("FRAME_TOO_LARGE"));
        throw new SessionHelperIpcError("FRAME_TOO_LARGE");
      }
      return queued;
    }
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#closed) {
      return null;
    }
    if (signal?.aborted === true) {
      throw new SessionHelperIpcError("TRANSPORT_FAILURE");
    }
    return await new Promise<Buffer | null>((resolve, reject) => {
      const pending: PendingReader = {
        maxBytes,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(signal === undefined
          ? {}
          : {
              onAbort: () => {
                const index = this.#readers.indexOf(pending);
                if (index >= 0) {
                  this.#readers.splice(index, 1);
                }
                reject(new SessionHelperIpcError("TRANSPORT_FAILURE"));
              },
            }),
      };
      this.#readers.push(pending);
      if (pending.onAbort !== undefined) {
        signal?.addEventListener("abort", pending.onAbort, { once: true });
      }
    });
  }

  public async writeFrame(frame: Buffer, signal?: AbortSignal): Promise<void> {
    if (
      this.#closed ||
      !Buffer.isBuffer(frame) ||
      frame.length === 0 ||
      frame.length > ABSOLUTE_MAX_WIRE_FRAME_BYTES ||
      signal?.aborted === true
    ) {
      throw new SessionHelperIpcError(
        frame.length > ABSOLUTE_MAX_WIRE_FRAME_BYTES ? "FRAME_TOO_LARGE" : "TRANSPORT_FAILURE",
      );
    }
    const prefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
    prefix.writeUInt32BE(frame.length);
    const wire = Buffer.concat([prefix, frame]);
    prefix.fill(0);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          this.close();
          reject(new SessionHelperIpcError("TRANSPORT_FAILURE"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.#socket.write(wire, (error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          if (error !== null && error !== undefined) {
            reject(new SessionHelperIpcError("TRANSPORT_FAILURE"));
          } else {
            resolve();
          }
        });
      });
    } finally {
      wire.fill(0);
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#socket.destroy();
    this.#drainReaders(null);
    this.#zeroBufferedData();
  }

  #acceptBytes(chunk: Buffer): void {
    if (this.#closed) {
      chunk.fill(0);
      return;
    }
    const previous = this.#buffer;
    this.#buffer = Buffer.concat([previous, chunk]);
    previous.fill(0);
    chunk.fill(0);
    this.#parseFrames();
  }

  #parseFrames(): void {
    while (this.#buffer.length >= LENGTH_PREFIX_BYTES) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > ABSOLUTE_MAX_WIRE_FRAME_BYTES) {
        this.#fail(
          new SessionHelperIpcError(
            length > ABSOLUTE_MAX_WIRE_FRAME_BYTES ? "FRAME_TOO_LARGE" : "PROTOCOL_ERROR",
          ),
        );
        return;
      }
      if (this.#buffer.length < LENGTH_PREFIX_BYTES + length) {
        return;
      }
      const frame = Buffer.from(
        this.#buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length),
      );
      const consumed = this.#buffer;
      this.#buffer = Buffer.from(consumed.subarray(LENGTH_PREFIX_BYTES + length));
      consumed.fill(0);
      const reader = this.#readers.shift();
      if (reader === undefined) {
        this.#frames.push(frame);
      } else {
        this.#removeAbortListener(reader);
        if (frame.length > reader.maxBytes) {
          frame.fill(0);
          reader.reject(new SessionHelperIpcError("FRAME_TOO_LARGE"));
          this.#fail(new SessionHelperIpcError("FRAME_TOO_LARGE"));
          return;
        }
        reader.resolve(frame);
      }
    }
  }

  #finish(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#drainReaders(null);
    this.#zeroBufferedData();
  }

  #fail(error: SessionHelperIpcError): void {
    if (this.#failure !== undefined) {
      return;
    }
    this.#failure = error;
    this.#closed = true;
    this.#socket.destroy();
    for (const reader of this.#readers.splice(0)) {
      this.#removeAbortListener(reader);
      reader.reject(error);
    }
    this.#zeroBufferedData();
  }

  #drainReaders(value: null): void {
    for (const reader of this.#readers.splice(0)) {
      this.#removeAbortListener(reader);
      reader.resolve(value);
    }
  }

  #removeAbortListener(reader: PendingReader): void {
    if (reader.signal !== undefined && reader.onAbort !== undefined) {
      reader.signal.removeEventListener("abort", reader.onAbort);
    }
  }

  #zeroBufferedData(): void {
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    for (const frame of this.#frames.splice(0)) {
      frame.fill(0);
    }
  }
}
