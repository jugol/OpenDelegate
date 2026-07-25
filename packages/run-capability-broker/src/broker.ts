import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import {
  RUN_CAPABILITY_PROTOCOL_VERSION,
  RunCapabilityBrokerError,
  type LocalRunCapabilityBrokerOptions,
  type RunCapabilityBinding,
  type RunCapabilityJsonValue,
  type RunCapabilityLease,
  type RunCapabilityRegistration,
} from "./contracts.ts";
import { decodeFrame, readFrames, writeFrame } from "./framing.ts";
import {
  normalizeBinding,
  normalizeJsonValue,
  requireAbsoluteExternalPath,
  requireExactKeys,
  requireIdentifier,
  requirePositiveInteger,
  requireRecord,
  requireTimestamp,
} from "./validation.ts";

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const MAXIMUM_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 16;
const CAPABILITY_FILE_BYTES = 64 * 1024;

interface RegisteredCapability {
  readonly capabilityId: string;
  readonly capability: string;
  readonly token: Buffer;
  readonly binding: RunCapabilityBinding;
  readonly metadata: RunCapabilityJsonValue;
  readonly expiresAtMs: number;
  readonly capabilityFile: string;
  readonly currentBinding: RunCapabilityRegistration["currentBinding"];
  readonly isExecutionCurrent: RunCapabilityRegistration["isExecutionCurrent"];
  readonly handler: RunCapabilityRegistration["handler"];
  readonly sockets: Set<Socket>;
  consumed: boolean;
  disposed: boolean;
}

interface ResolvedBrokerOptions {
  readonly runtimeDirectory: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly clock: { now(): number };
  readonly idSource: { nextId(): string };
  readonly tokenSource: { nextToken(): Buffer };
  readonly maxFrameBytes: number;
  readonly maxInFlightRequests: number;
}

export class LocalRunCapabilityBroker {
  readonly #options: ResolvedBrokerOptions;
  readonly #server: Server;
  readonly #endpoint: string;
  readonly #registrations = new Map<string, RegisteredCapability>();
  #closed = false;

  private constructor(options: ResolvedBrokerOptions, server: Server, endpoint: string) {
    this.#options = options;
    this.#server = server;
    this.#endpoint = endpoint;
  }

  public static async listen(
    options: LocalRunCapabilityBrokerOptions,
  ): Promise<LocalRunCapabilityBroker> {
    const resolved = await resolveOptions(options);
    const endpoint =
      resolved.hostPlatform === "win32"
        ? `\\\\.\\pipe\\opendelegate-capability-${requireIdentifier(resolved.idSource.nextId(), 96)}`
        : join(
            resolved.runtimeDirectory,
            `cap-${requireIdentifier(resolved.idSource.nextId(), 48)}.sock`,
          );
    if (resolved.hostPlatform !== "win32" && Buffer.byteLength(endpoint, "utf8") > 100) {
      throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
    }
    const server = createServer();
    const broker = new LocalRunCapabilityBroker(resolved, server, endpoint);
    server.on("connection", (socket) => {
      void broker.#accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => {
        cleanup();
        reject(new RunCapabilityBrokerError("CONNECTION_FAILED"));
      };
      const listening = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        server.off("error", fail);
        server.off("listening", listening);
      };
      server.once("error", fail);
      server.once("listening", listening);
      server.listen(endpoint);
    });
    if (resolved.hostPlatform !== "win32") {
      await chmod(endpoint, 0o600).catch(async () => {
        await broker.close();
        throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
      });
    }
    return broker;
  }

  public async register(input: RunCapabilityRegistration): Promise<RunCapabilityLease> {
    this.#assertOpen();
    const capability = requireIdentifier(input.capability, 128);
    const binding = normalizeBinding(input.binding);
    const metadata = normalizeJsonValue(input.metadata, this.#options.maxFrameBytes / 2);
    const expiresAtMs = requireTimestamp(input.expiresAtMs);
    const now = readClock(this.#options.clock);
    if (
      expiresAtMs <= now ||
      expiresAtMs > binding.leaseExpiresAtMs ||
      typeof input.currentBinding !== "function" ||
      typeof input.isExecutionCurrent !== "function" ||
      typeof input.handler !== "function"
    ) {
      throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
    }
    const capabilityId = requireIdentifier(this.#options.idSource.nextId(), 96);
    if (this.#registrations.has(capabilityId)) {
      throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
    }
    const token = Buffer.from(this.#options.tokenSource.nextToken());
    if (token.byteLength !== 32) {
      token.fill(0);
      throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
    }
    const capabilityFile = join(this.#options.runtimeDirectory, `capability-${capabilityId}.json`);
    const descriptor = {
      schemaVersion: RUN_CAPABILITY_PROTOCOL_VERSION,
      capabilityId,
      capability,
      endpoint:
        this.#options.hostPlatform === "win32"
          ? { kind: "windows-named-pipe", path: this.#endpoint }
          : { kind: "unix-domain-socket", path: this.#endpoint },
      token: token.toString("base64url"),
      expiresAtMs,
      maxFrameBytes: this.#options.maxFrameBytes,
    };
    const registration: RegisteredCapability = {
      capabilityId,
      capability,
      token,
      binding,
      metadata,
      expiresAtMs,
      capabilityFile,
      currentBinding: input.currentBinding,
      isExecutionCurrent: input.isExecutionCurrent,
      handler: input.handler,
      sockets: new Set(),
      consumed: false,
      disposed: false,
    };
    if (safeCurrentBinding(registration) === undefined) {
      token.fill(0);
      throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
    }
    try {
      await writeFile(capabilityFile, `${JSON.stringify(descriptor)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (this.#options.hostPlatform !== "win32") {
        await chmod(capabilityFile, 0o600);
      }
      const metadata = await lstat(capabilityFile);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > CAPABILITY_FILE_BYTES
      ) {
        throw new RunCapabilityBrokerError("CAPABILITY_FILE_UNSAFE");
      }
    } catch (error) {
      token.fill(0);
      await unlink(capabilityFile).catch(() => undefined);
      throw error instanceof RunCapabilityBrokerError
        ? error
        : new RunCapabilityBrokerError("CAPABILITY_FILE_UNSAFE");
    }
    this.#registrations.set(capabilityId, registration);
    let disposed = false;
    return Object.freeze({
      capabilityFile,
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        await this.#disposeRegistration(registration);
      },
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.all(
      [...this.#registrations.values()].map((registration) =>
        this.#disposeRegistration(registration),
      ),
    );
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    }).catch(() => undefined);
    if (this.#options.hostPlatform !== "win32") {
      await unlink(this.#endpoint).catch(() => undefined);
    }
  }

  async #accept(socket: Socket): Promise<void> {
    socket.setNoDelay(true);
    let registration: RegisteredCapability | undefined;
    try {
      const frames = readFrames(socket, this.#options.maxFrameBytes);
      const first = await frames.next();
      if (first.done) {
        throw new RunCapabilityBrokerError("FRAME_INVALID");
      }
      const claim = parseClaim(decodeFrame(first.value));
      registration = this.#registrations.get(claim.capabilityId);
      const now = readClock(this.#options.clock);
      if (
        registration === undefined ||
        registration.disposed ||
        registration.consumed ||
        registration.capability !== claim.capability
      ) {
        await writeClaimError(socket, "CAPABILITY_CONSUMED", this.#options.maxFrameBytes);
        return;
      }
      const receivedToken = Buffer.from(claim.token, "base64url");
      const tokenMatches =
        receivedToken.byteLength === registration.token.byteLength &&
        timingSafeEqual(receivedToken, registration.token);
      receivedToken.fill(0);
      if (!tokenMatches) {
        throw new RunCapabilityBrokerError("CAPABILITY_CONSUMED");
      }
      if (now >= registration.expiresAtMs) {
        await writeClaimError(socket, "CAPABILITY_EXPIRED", this.#options.maxFrameBytes);
        await this.#disposeRegistration(registration);
        return;
      }
      if (!(await safeCurrent(registration))) {
        await writeClaimError(socket, "CAPABILITY_REVOKED", this.#options.maxFrameBytes);
        await this.#disposeRegistration(registration);
        return;
      }
      const currentBinding = safeCurrentBinding(registration);
      if (currentBinding === undefined) {
        await writeClaimError(socket, "CAPABILITY_REVOKED", this.#options.maxFrameBytes);
        await this.#disposeRegistration(registration);
        return;
      }
      registration.consumed = true;
      registration.token.fill(0);
      registration.sockets.add(socket);
      await unlink(registration.capabilityFile).catch(() => undefined);
      await writeFrame(
        socket,
        {
          schemaVersion: RUN_CAPABILITY_PROTOCOL_VERSION,
          type: "claimed",
          capability: registration.capability,
          binding: currentBinding,
          metadata: registration.metadata,
        },
        this.#options.maxFrameBytes,
      );
      await this.#serveClaimedConnection(registration, socket, frames);
    } catch {
      socket.destroy();
    } finally {
      registration?.sockets.delete(socket);
      socket.destroy();
    }
  }

  async #serveClaimedConnection(
    registration: RegisteredCapability,
    socket: Socket,
    frames: AsyncGenerator<Buffer>,
  ): Promise<void> {
    let expectedSequence = 1;
    const active = new Map<string, AbortController>();
    const writes: Promise<void>[] = [];
    try {
      for await (const bytes of frames) {
        const frame = parseClientFrame(
          decodeFrame(bytes),
          expectedSequence,
          this.#options.maxFrameBytes,
        );
        expectedSequence += 1;
        if (frame.type === "cancel") {
          active.get(frame.requestId)?.abort();
          continue;
        }
        if (active.size >= this.#options.maxInFlightRequests || active.has(frame.requestId)) {
          throw new RunCapabilityBrokerError("FRAME_INVALID");
        }
        const controller = new AbortController();
        active.set(frame.requestId, controller);
        const task = this.#executeRequest(registration, frame, controller.signal)
          .then((response) => writeFrame(socket, response, this.#options.maxFrameBytes))
          .finally(() => active.delete(frame.requestId));
        writes.push(task);
        void task.catch(() => socket.destroy());
      }
      await Promise.all(writes);
    } finally {
      for (const controller of active.values()) {
        controller.abort();
      }
    }
  }

  async #executeRequest(
    registration: RegisteredCapability,
    frame: ParsedRequestFrame,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const base = {
      schemaVersion: RUN_CAPABILITY_PROTOCOL_VERSION,
      type: "result",
      sequence: frame.sequence,
      requestId: frame.requestId,
    };
    if (registration.disposed || !(await safeCurrent(registration))) {
      return { ...base, outcome: "error", error: "CAPABILITY_REVOKED" };
    }
    const currentBinding = safeCurrentBinding(registration);
    if (currentBinding === undefined) {
      return { ...base, outcome: "error", error: "CAPABILITY_REVOKED" };
    }
    try {
      const result = await registration.handler(
        { method: frame.method, payload: frame.payload },
        Object.freeze({ binding: currentBinding, signal }),
      );
      if (signal.aborted) {
        return { ...base, outcome: "error", error: "REQUEST_CANCELLED" };
      }
      return {
        ...base,
        outcome: "ok",
        result: normalizeJsonValue(result, this.#options.maxFrameBytes - 4_096),
      };
    } catch {
      return {
        ...base,
        outcome: "error",
        error: signal.aborted ? "REQUEST_CANCELLED" : "REQUEST_FAILED",
      };
    }
  }

  async #disposeRegistration(registration: RegisteredCapability): Promise<void> {
    if (registration.disposed) {
      return;
    }
    registration.disposed = true;
    registration.token.fill(0);
    this.#registrations.delete(registration.capabilityId);
    await unlink(registration.capabilityFile).catch(() => undefined);
    for (const socket of registration.sockets) {
      socket.destroy();
    }
    registration.sockets.clear();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RunCapabilityBrokerError("CAPABILITY_REVOKED");
    }
  }
}

interface ParsedRequestFrame {
  readonly type: "request";
  readonly sequence: number;
  readonly requestId: string;
  readonly method: string;
  readonly payload: RunCapabilityJsonValue;
}

function parseClaim(value: unknown): {
  readonly capabilityId: string;
  readonly capability: string;
  readonly token: string;
} {
  const record = requireRecord(value);
  requireExactKeys(record, ["schemaVersion", "type", "capabilityId", "capability", "token"]);
  if (record["schemaVersion"] !== RUN_CAPABILITY_PROTOCOL_VERSION || record["type"] !== "claim") {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  const token = record["token"];
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
  return {
    capabilityId: requireIdentifier(record["capabilityId"], 96),
    capability: requireIdentifier(record["capability"], 128),
    token,
  };
}

function parseClientFrame(
  value: unknown,
  expectedSequence: number,
  maximumFrameBytes: number,
):
  | ParsedRequestFrame
  | { readonly type: "cancel"; readonly sequence: number; readonly requestId: string } {
  const record = requireRecord(value);
  const type = record["type"];
  if (type === "request") {
    requireExactKeys(record, [
      "schemaVersion",
      "type",
      "sequence",
      "requestId",
      "method",
      "payload",
    ]);
    if (
      record["schemaVersion"] !== RUN_CAPABILITY_PROTOCOL_VERSION ||
      requirePositiveInteger(record["sequence"]) !== expectedSequence
    ) {
      throw new RunCapabilityBrokerError("FRAME_INVALID");
    }
    return {
      type,
      sequence: expectedSequence,
      requestId: requireIdentifier(record["requestId"], 128),
      method: requireIdentifier(record["method"], 128),
      payload: normalizeJsonValue(record["payload"], maximumFrameBytes / 2),
    };
  }
  if (type === "cancel") {
    requireExactKeys(record, ["schemaVersion", "type", "sequence", "requestId"]);
    if (
      record["schemaVersion"] !== RUN_CAPABILITY_PROTOCOL_VERSION ||
      requirePositiveInteger(record["sequence"]) !== expectedSequence
    ) {
      throw new RunCapabilityBrokerError("FRAME_INVALID");
    }
    return {
      type,
      sequence: expectedSequence,
      requestId: requireIdentifier(record["requestId"], 128),
    };
  }
  throw new RunCapabilityBrokerError("FRAME_INVALID");
}

async function writeClaimError(
  socket: Socket,
  code: "CAPABILITY_CONSUMED" | "CAPABILITY_EXPIRED" | "CAPABILITY_REVOKED",
  maximumFrameBytes: number,
): Promise<void> {
  await writeFrame(
    socket,
    {
      schemaVersion: RUN_CAPABILITY_PROTOCOL_VERSION,
      type: "claim-error",
      error: code,
    },
    maximumFrameBytes,
  );
}

async function safeCurrent(registration: RegisteredCapability): Promise<boolean> {
  try {
    return (await registration.isExecutionCurrent()) === true;
  } catch {
    return false;
  }
}

function safeCurrentBinding(registration: RegisteredCapability): RunCapabilityBinding | undefined {
  try {
    const current = normalizeBinding(registration.currentBinding());
    const initial = registration.binding;
    if (
      current.taskId !== initial.taskId ||
      current.workOrderId !== initial.workOrderId ||
      current.runId !== initial.runId ||
      current.deviceId !== initial.deviceId ||
      current.leaseId !== initial.leaseId ||
      current.fencingToken !== initial.fencingToken ||
      current.leaseExpiresAtMs < initial.leaseExpiresAtMs
    ) {
      return undefined;
    }
    return current;
  } catch {
    return undefined;
  }
}

async function resolveOptions(
  input: LocalRunCapabilityBrokerOptions,
): Promise<ResolvedBrokerOptions> {
  const runtimeDirectory = requireAbsoluteExternalPath(
    input.runtimeDirectory,
    input.sourceCheckoutDirectory,
  );
  const hostPlatform = input.hostPlatform ?? process.platform;
  if (hostPlatform !== "win32" && hostPlatform !== "darwin" && hostPlatform !== "linux") {
    throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
  }
  const maxFrameBytes = boundedInteger(
    input.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    4_096,
    MAXIMUM_MAX_FRAME_BYTES,
  );
  const maxInFlightRequests = boundedInteger(
    input.maxInFlightRequests ?? DEFAULT_MAX_IN_FLIGHT_REQUESTS,
    1,
    64,
  );
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(runtimeDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
  }
  if (hostPlatform !== "win32") {
    await chmod(runtimeDirectory, 0o700);
  }
  const canonical = await realpath(runtimeDirectory);
  if (canonical !== runtimeDirectory) {
    throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
  }
  return {
    runtimeDirectory,
    hostPlatform,
    clock: input.clock ?? { now: () => Date.now() },
    idSource: input.idSource ?? { nextId: () => randomUUID() },
    tokenSource: input.tokenSource ?? { nextToken: () => randomBytes(32) },
    maxFrameBytes,
    maxInFlightRequests,
  };
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
  }
  return value;
}

function readClock(clock: { now(): number }): number {
  try {
    return requireTimestamp(clock.now());
  } catch {
    throw new RunCapabilityBrokerError("INVALID_CONFIGURATION");
  }
}
