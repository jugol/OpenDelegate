import assert from "node:assert/strict";
import { createHmac, hkdfSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  createWindowsNamedPipeAuthenticatedHelperPort,
  type WindowsHelperIpcDuplex,
} from "../src/index.ts";

const SECRET = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
const CLIENT_NONCE = Uint8Array.from({ length: 32 }, (_value, index) => 160 + index);
const SERVER_NONCE = Uint8Array.from({ length: 32 }, (_value, index) => 64 + index);
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

describe("Windows authenticated helper named-pipe port", () => {
  it("binds the helper transcript, authenticates every frame, and zeroes the IPC key", async () => {
    let resolvedSecret: Uint8Array | undefined;
    const duplex = new ScriptedHelperDuplex(SECRET);
    const port = createWindowsNamedPipeAuthenticatedHelperPort({
      platform: "win32",
      pipePath: String.raw`\\.\pipe\OpenDelegate\ComputerUse.instance-1`,
      deviceId: "device-windows-1",
      secretReference: "secret://local-ipc/windows-helper",
      secrets: {
        async resolve() {
          resolvedSecret = SECRET.slice();
          return resolvedSecret;
        },
      },
      nonceSource: () => CLIENT_NONCE.slice(),
      dialer: {
        async connect(path) {
          assert.equal(path, String.raw`\\.\pipe\OpenDelegate\ComputerUse.instance-1`);
          return duplex;
        },
      },
    });

    const response = await port.execute({
      protocolVersion: 1,
      expectedHelperInstanceId: "helper-windows-1",
      expectedServiceEpoch: 17,
      expectedSessionIdentity: "windows-session:2:owner-sid-digest",
      expectedReleaseVersion: "0.1.0-alpha.1",
      kind: "probe",
    });

    assert.equal(response.authenticated, true);
    assert.equal(response.kind, "probe");
    assert.equal(response.helperInstanceId, "helper-windows-1");
    assert.equal(response.displayFingerprint, "windows-display:test");
    assert.equal(duplex.coreProofVerified, true);
    assert.equal(duplex.commandFrameVerified, true);
    assert.equal(duplex.closed, true);
    assert.deepEqual(resolvedSecret, new Uint8Array(32));
  });

  it("fails closed on an invalid helper proof without sending an authenticated command", async () => {
    const duplex = new ScriptedHelperDuplex(SECRET, { corruptHelperProof: true });
    const port = createWindowsNamedPipeAuthenticatedHelperPort({
      platform: "win32",
      pipePath: String.raw`\\.\pipe\OpenDelegate\ComputerUse.instance-1`,
      deviceId: "device-windows-1",
      secretReference: "secret://local-ipc/windows-helper",
      secrets: {
        async resolve() {
          return SECRET.slice();
        },
      },
      nonceSource: () => CLIENT_NONCE.slice(),
      dialer: { connect: async () => duplex },
    });

    await assert.rejects(
      port.execute({
        protocolVersion: 1,
        expectedHelperInstanceId: "helper-windows-1",
        expectedServiceEpoch: 17,
        expectedSessionIdentity: "windows-session:2:owner-sid-digest",
        expectedReleaseVersion: "0.1.0-alpha.1",
        kind: "probe",
      }),
      /could not be authenticated/u,
    );
    assert.equal(duplex.commandFrameVerified, false);
    assert.equal(duplex.closed, true);
  });

  it("rejects remote, malformed, or non-Windows endpoints before resolving a secret", () => {
    let secretResolved = false;
    const options = {
      deviceId: "device-windows-1",
      secretReference: "secret://local-ipc/windows-helper",
      secrets: {
        async resolve() {
          secretResolved = true;
          return SECRET.slice();
        },
      },
    };

    assert.throws(
      () =>
        createWindowsNamedPipeAuthenticatedHelperPort({
          ...options,
          platform: "win32",
          pipePath: String.raw`\\remote-host\pipe\OpenDelegate\ComputerUse.instance-1`,
        }),
      /local Windows named pipe/u,
    );
    assert.throws(
      () =>
        createWindowsNamedPipeAuthenticatedHelperPort({
          ...options,
          platform: "linux",
          pipePath: String.raw`\\.\pipe\OpenDelegate\ComputerUse.instance-1`,
        }),
      /only be composed on Windows/u,
    );
    assert.equal(secretResolved, false);
  });

  it("bounds the complete helper exchange and disposes its Secret on timeout", async () => {
    let resolvedSecret: Uint8Array | undefined;
    const duplex = new HangingHelperDuplex();
    const port = createWindowsNamedPipeAuthenticatedHelperPort({
      platform: "win32",
      pipePath: String.raw`\\.\pipe\OpenDelegate\ComputerUse.timeout`,
      deviceId: "device-windows-1",
      secretReference: "secret://local-ipc/windows-helper",
      secrets: {
        async resolve() {
          resolvedSecret = SECRET.slice();
          return resolvedSecret;
        },
      },
      timeoutMs: 25,
      nonceSource: () => CLIENT_NONCE.slice(),
      dialer: { connect: async () => duplex },
    });

    await assert.rejects(
      Promise.race([
        port.execute({
          protocolVersion: 1,
          expectedHelperInstanceId: "helper-windows-1",
          expectedServiceEpoch: 17,
          expectedSessionIdentity: "windows-session:2:owner-sid-digest",
          expectedReleaseVersion: "0.1.0-alpha.1",
          kind: "probe",
        }),
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("The test deadline expired.")), 250);
        }),
      ]),
      /helper IPC operation timed out/u,
    );
    assert.equal(duplex.closed, true);
    assert.deepEqual(resolvedSecret, new Uint8Array(32));
  });

  it("zeroes a disposable Secret even when its resolver finishes after timeout", async () => {
    let finishResolution: ((value: Uint8Array) => void) | undefined;
    const delayedSecret = new Promise<Uint8Array>((resolve) => {
      finishResolution = resolve;
    });
    const port = createWindowsNamedPipeAuthenticatedHelperPort({
      platform: "win32",
      pipePath: String.raw`\\.\pipe\OpenDelegate\ComputerUse.late-secret`,
      deviceId: "device-windows-1",
      secretReference: "secret://local-ipc/windows-helper",
      secrets: {
        async resolve() {
          return await delayedSecret;
        },
      },
      timeoutMs: 25,
      nonceSource: () => CLIENT_NONCE.slice(),
      dialer: {
        async connect() {
          throw new Error("The dialer must not run.");
        },
      },
    });
    const pending = port.execute({
      protocolVersion: 1,
      expectedHelperInstanceId: "helper-windows-1",
      expectedServiceEpoch: 17,
      expectedSessionIdentity: "windows-session:2:owner-sid-digest",
      expectedReleaseVersion: "0.1.0-alpha.1",
      kind: "probe",
    });

    await assert.rejects(pending, /helper IPC operation timed out/u);
    const lateSecret = SECRET.slice();
    finishResolution?.(lateSecret);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(lateSecret, new Uint8Array(32));
  });
});

class HangingHelperDuplex implements WindowsHelperIpcDuplex {
  public closed = false;

  public async writeFrame(): Promise<void> {}

  public async readFrame(): Promise<Uint8Array> {
    return await new Promise<Uint8Array>(() => {});
  }

  public close(): void {
    this.closed = true;
  }
}

class ScriptedHelperDuplex implements WindowsHelperIpcDuplex {
  readonly #secret: Uint8Array;
  readonly #corruptHelperProof: boolean;
  readonly #reads: Uint8Array[] = [];
  #hello: Uint8Array | undefined;
  #clientNonce: Uint8Array | undefined;
  #serverProofSent = false;
  public coreProofVerified = false;
  public commandFrameVerified = false;
  public closed = false;

  public constructor(secret: Uint8Array, options: { readonly corruptHelperProof?: boolean } = {}) {
    this.#secret = secret.slice();
    this.#corruptHelperProof = options.corruptHelperProof ?? false;
  }

  public async writeFrame(frame: Uint8Array): Promise<void> {
    if (this.#hello === undefined) {
      this.#hello = frame.slice();
      const hello = JSON.parse(Buffer.from(frame).toString("utf8")) as {
        clientNonce: string;
      };
      this.#clientNonce = Buffer.from(hello.clientNonce, "base64url");
      const proof = helperProof(this.#secret, frame, SERVER_NONCE);
      if (this.#corruptHelperProof) {
        proof[0] = (proof[0] ?? 0) ^ 0xff;
      }
      this.#reads.push(
        Buffer.from(
          JSON.stringify({
            type: "helper-proof",
            protocolVersion: 1,
            serverNonce: Buffer.from(SERVER_NONCE).toString("base64url"),
            proof: Buffer.from(proof).toString("base64url"),
          }),
          "utf8",
        ),
      );
      this.#serverProofSent = true;
      return;
    }

    if (!this.coreProofVerified) {
      assert.equal(this.#serverProofSent, true);
      const proof = JSON.parse(Buffer.from(frame).toString("utf8")) as {
        type: string;
        proof: string;
      };
      assert.equal(proof.type, "core-proof");
      assert.deepEqual(
        Buffer.from(proof.proof, "base64url"),
        coreProof(this.#secret, this.#hello, SERVER_NONCE),
      );
      this.coreProofVerified = true;
      return;
    }

    const keys = deriveKeys(this.#secret, this.#clientNonce!, SERVER_NONCE);
    const command = verifyAuthenticatedFrame(frame, 0, 1, keys.coreToHelper);
    const parsed = JSON.parse(Buffer.from(command).toString("utf8")) as { kind: string };
    assert.equal(parsed.kind, "probe");
    this.commandFrameVerified = true;
    const payload = Buffer.from(
      JSON.stringify({
        kind: "probe",
        helperInstanceId: "helper-windows-1",
        serviceEpoch: 17,
        sessionIdentity: "windows-session:2:owner-sid-digest",
        releaseVersion: "0.1.0-alpha.1",
        displayFingerprint: "windows-display:test",
        readiness: {
          interactiveSession: true,
          unlockedSession: true,
          captureSupported: true,
          captureTargetSelected: true,
          frameReady: true,
          accessibilityAvailable: true,
          fixtureControlsVisible: true,
          inputAvailable: true,
          emergencyStopAvailable: true,
          targetIntegrity: "same-or-lower",
        },
      }),
      "utf8",
    );
    this.#reads.push(authenticatedFrame(1, 1, payload, keys.helperToCore));
  }

  public async readFrame(): Promise<Uint8Array> {
    const frame = this.#reads.shift();
    if (frame === undefined) {
      throw new Error("No scripted helper frame is available.");
    }
    return frame;
  }

  public close(): void {
    this.closed = true;
  }
}

function helperProof(secret: Uint8Array, hello: Uint8Array, serverNonce: Uint8Array): Buffer {
  return createHmac("sha256", secret)
    .update(HELPER_LABEL)
    .update(hello)
    .update(Uint8Array.of(0))
    .update(serverNonce)
    .digest();
}

function coreProof(secret: Uint8Array, hello: Uint8Array, serverNonce: Uint8Array): Buffer {
  return createHmac("sha256", secret)
    .update(CORE_LABEL)
    .update(hello)
    .update(Uint8Array.of(0))
    .update(serverNonce)
    .digest();
}

function deriveKeys(secret: Uint8Array, clientNonce: Uint8Array, serverNonce: Uint8Array) {
  const session = Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.concat([Buffer.from(clientNonce), Buffer.from(serverNonce)]),
      SESSION_INFO,
      32,
    ),
  );
  try {
    return {
      coreToHelper: Buffer.from(
        hkdfSync("sha256", session, Buffer.alloc(0), CORE_TO_HELPER_INFO, 32),
      ),
      helperToCore: Buffer.from(
        hkdfSync("sha256", session, Buffer.alloc(0), HELPER_TO_CORE_INFO, 32),
      ),
    };
  } finally {
    session.fill(0);
  }
}

function authenticatedFrame(
  direction: 0 | 1,
  sequence: number,
  payload: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  const header = Buffer.alloc(14);
  header.writeUInt8(1, 0);
  header.writeUInt8(direction, 1);
  header.writeBigUInt64BE(BigInt(sequence), 2);
  header.writeUInt32BE(payload.length, 10);
  const unsigned = Buffer.concat([header, payload]);
  const mac = createHmac("sha256", key).update(unsigned).digest();
  return Buffer.concat([unsigned, mac]);
}

function verifyAuthenticatedFrame(
  frame: Uint8Array,
  direction: 0 | 1,
  sequence: number,
  key: Uint8Array,
): Uint8Array {
  const value = Buffer.from(frame);
  assert.equal(value.readUInt8(0), 1);
  assert.equal(value.readUInt8(1), direction);
  assert.equal(value.readBigUInt64BE(2), BigInt(sequence));
  const payloadLength = value.readUInt32BE(10);
  const payload = value.subarray(14, 14 + payloadLength);
  const actualMac = value.subarray(14 + payloadLength);
  assert.deepEqual(
    actualMac,
    createHmac("sha256", key)
      .update(value.subarray(0, 14 + payloadLength))
      .digest(),
  );
  return payload;
}
