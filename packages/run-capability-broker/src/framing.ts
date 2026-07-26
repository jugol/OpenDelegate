import { once } from "node:events";
import type { Socket } from "node:net";

import { RunCapabilityBrokerError } from "./contracts.ts";

export async function* readFrames(
  socket: Socket,
  maximumFrameBytes: number,
): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0);
  for await (const raw of socket) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (length === 0 || length > maximumFrameBytes) {
        throw new RunCapabilityBrokerError(
          length > maximumFrameBytes ? "FRAME_TOO_LARGE" : "FRAME_INVALID",
        );
      }
      if (pending.length < length + 4) {
        break;
      }
      yield pending.subarray(4, length + 4);
      pending = pending.subarray(length + 4);
    }
    if (pending.length > maximumFrameBytes + 4) {
      throw new RunCapabilityBrokerError("FRAME_TOO_LARGE");
    }
  }
  if (pending.length !== 0) {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
}

export async function writeFrame(
  socket: Socket,
  value: Readonly<Record<string, unknown>>,
  maximumFrameBytes: number,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > maximumFrameBytes) {
    throw new RunCapabilityBrokerError("FRAME_TOO_LARGE");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  if (socket.write(Buffer.concat([header, payload]))) {
    return;
  }
  await once(socket, "drain");
}

export function decodeFrame(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RunCapabilityBrokerError("FRAME_INVALID");
  }
}
