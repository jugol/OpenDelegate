import type { SessionHelperIpcConnection, SessionHelperIpcPeerIdentity } from "../src/index.ts";

export interface ControlledMemoryPair {
  readonly core: SessionHelperIpcConnection;
  readonly helper: SessionHelperIpcConnection;
  readonly coreToHelper: AsyncFrameQueue;
  readonly helperToCore: AsyncFrameQueue;
  readonly closed: boolean;
  readonly closeCount: number;
  disconnect(): void;
  pushToCore(frame: Buffer): void;
  pushToHelper(frame: Buffer): void;
}

export function createControlledMemoryPair(): ControlledMemoryPair {
  const coreToHelper = new AsyncFrameQueue();
  const helperToCore = new AsyncFrameQueue();
  let closed = false;
  let closeCount = 0;
  const disconnect = () => {
    if (!closed) {
      closed = true;
      closeCount += 1;
      coreToHelper.close();
      helperToCore.close();
    }
  };
  const createConnection = (
    incoming: AsyncFrameQueue,
    outgoing: AsyncFrameQueue,
    peerIdentity: SessionHelperIpcPeerIdentity,
  ): SessionHelperIpcConnection => ({
    peerIdentity,
    async readFrame() {
      return await incoming.read();
    },
    async writeFrame(frame) {
      if (closed) {
        throw new Error("transport secret=must-not-escape");
      }
      outgoing.write(frame);
    },
    close: disconnect,
  });
  return {
    core: createConnection(
      helperToCore,
      coreToHelper,
      Object.freeze({ transport: "memory", principalId: "helper-owner" }),
    ),
    helper: createConnection(
      coreToHelper,
      helperToCore,
      Object.freeze({ transport: "memory", principalId: "core-service" }),
    ),
    coreToHelper,
    helperToCore,
    get closed() {
      return closed;
    },
    get closeCount() {
      return closeCount;
    },
    disconnect,
    pushToCore(frame) {
      helperToCore.write(frame);
    },
    pushToHelper(frame) {
      coreToHelper.write(frame);
    },
  };
}

export class AsyncFrameQueue {
  readonly #frames: Buffer[] = [];
  readonly #readers: Array<(frame: Buffer | null) => void> = [];
  #closed = false;

  public write(frame: Buffer): void {
    if (this.#closed) {
      throw new Error("closed");
    }
    const copy = Buffer.from(frame);
    const reader = this.#readers.shift();
    if (reader === undefined) {
      this.#frames.push(copy);
    } else {
      reader(copy);
    }
  }

  public async read(): Promise<Buffer | null> {
    const frame = this.#frames.shift();
    if (frame !== undefined) {
      return frame;
    }
    if (this.#closed) {
      return null;
    }
    return await new Promise((resolve) => {
      this.#readers.push(resolve);
    });
  }

  public async take(): Promise<Buffer> {
    const frame = await this.read();
    if (frame === null) {
      throw new Error("The memory wire closed before a frame was available.");
    }
    return frame;
  }

  public close(): void {
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) {
      reader(null);
    }
  }
}
