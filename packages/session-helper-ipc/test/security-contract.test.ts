import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryNonceReplayGuard,
  SessionHelperIpcError,
  createCoreSessionHelperIpc,
  createHelperSessionHelperIpc,
  type CoreSessionHelperChannel,
  type HelperSessionHelperChannel,
  type SessionHelperBinding,
  type SessionHelperCapabilityResponse,
  type SessionHelperIpcPeerAuthorizer,
} from "../src/index.ts";
import { RotatingKeyProvider, StaticKeyProvider } from "../test-support/key-provider.ts";
import {
  createControlledMemoryPair,
  type ControlledMemoryPair,
} from "../test-support/memory-transport.ts";

const BINDING: SessionHelperBinding = Object.freeze({
  protocolVersion: 1,
  deviceId: "device-security",
  helperId: "helper-owner-session",
  sessionId: "owner-session-4",
  serviceEpoch: 91,
  releaseVersion: "0.1.0-alpha.1",
});
const KEY = Buffer.alloc(32, 0x41);
const ENDPOINT = Object.freeze({
  kind: "windows-named-pipe" as const,
  path: String.raw`\\.\pipe\OpenDelegate\SecurityContract`,
});
const KEY_REFERENCE = "secret://ipc/session-helper";

describe("session-helper IPC failure-close contract", () => {
  it("rejects a wrong HMAC key despite an authorized transport peer and redacts all Secret material", async () => {
    const coreKeys = new StaticKeyProvider("key-current", Buffer.alloc(32, 0x53));
    const helperKeys = new StaticKeyProvider("key-current", Buffer.alloc(32, 0x48));
    let authorizationCalls = 0;
    const authorizer: SessionHelperIpcPeerAuthorizer = {
      authorize: () => {
        authorizationCalls += 1;
        return true;
      },
    };
    const pair = createControlledMemoryPair();
    const results = await Promise.allSettled([
      createCoreSessionHelperIpc({
        keyProvider: coreKeys,
        peerAuthorizer: authorizer,
        nonceSource: () => Buffer.alloc(32, 0x11),
      }).connect({
        binding: BINDING,
        endpoint: ENDPOINT,
        keyReference: KEY_REFERENCE,
        dialer: { connect: async () => pair.core },
      }),
      createHelperSessionHelperIpc({
        keyProvider: helperKeys,
        peerAuthorizer: authorizer,
        nonceSource: () => Buffer.alloc(32, 0x22),
      }).accept({
        binding: BINDING,
        keyReference: KEY_REFERENCE,
        connection: pair.helper,
      }),
    ]);

    assert.equal(authorizationCalls, 2);
    assert.equal(
      results.every((result) => result.status === "rejected"),
      true,
    );
    const serialized = results
      .map((result) =>
        result.status === "rejected"
          ? `${String(result.reason)}\n${String((result.reason as Error).stack)}`
          : "",
      )
      .join("\n");
    assert.equal(serialized.includes("SSSSSSSS"), false);
    assert.equal(serialized.includes("HHHHHHHH"), false);
    assert.equal(serialized.includes(KEY_REFERENCE), false);
    assert.equal(serialized.includes("transport secret"), false);
    assert.equal(
      [...coreKeys.acquired, ...helperKeys.acquired].every((value) =>
        value.equals(Buffer.alloc(32)),
      ),
      true,
    );
    assert.equal(pair.closed, true);
  });

  it("invokes PeerAuthorizer for every connection and resolves no verification key for a rejected peer", async () => {
    const helperKeys = new StaticKeyProvider("key-current", KEY);
    const pair = createControlledMemoryPair();
    let helperAuthorizations = 0;
    const helperPending = createHelperSessionHelperIpc({
      keyProvider: helperKeys,
      peerAuthorizer: {
        authorize(request) {
          helperAuthorizations += 1;
          assert.equal(request.localRole, "helper");
          assert.equal(request.peerIdentity.principalId, "core-service");
          return false;
        },
      },
    }).accept({
      binding: BINDING,
      keyReference: KEY_REFERENCE,
      connection: pair.helper,
    });

    await expectCode(helperPending, "PEER_REJECTED");
    assert.equal(helperAuthorizations, 1);
    assert.equal(helperKeys.acquireCalls, 0);
    assert.equal(pair.closed, true);
  });

  it("rejects replay of a core nonce across otherwise fresh connections", async () => {
    const helperGuard = new InMemoryNonceReplayGuard();
    let helperNonce = 0x20;
    const helper = createHelperSessionHelperIpc({
      keyProvider: new StaticKeyProvider("key-current", KEY),
      peerAuthorizer: { authorize: () => true },
      nonceGuard: helperGuard,
      nonceSource: () => Buffer.alloc(32, helperNonce++),
    });

    const first = await establishWithHelper(helper, () => Buffer.alloc(32, 0x10));
    first.coreChannel.close();
    first.helperChannel.close();

    const pair = createControlledMemoryPair();
    const secondCore = createCoreSessionHelperIpc({
      keyProvider: new StaticKeyProvider("key-current", KEY),
      peerAuthorizer: { authorize: () => true },
      nonceGuard: new InMemoryNonceReplayGuard(),
      nonceSource: () => Buffer.alloc(32, 0x10),
    }).connect({
      binding: BINDING,
      endpoint: ENDPOINT,
      keyReference: KEY_REFERENCE,
      dialer: { connect: async () => pair.core },
    });
    const secondHelper = helper.accept({
      binding: BINDING,
      keyReference: KEY_REFERENCE,
      connection: pair.helper,
    });
    const results = await Promise.allSettled([secondCore, secondHelper]);

    assert.equal(results[1]?.status, "rejected");
    if (results[1]?.status === "rejected") {
      assertIpcCode(results[1].reason, "NONCE_REPLAY");
    }
    assert.equal(pair.closed, true);
  });

  it("rejects replay of a helper nonce even when the core nonce is fresh", async () => {
    const core = createCoreSessionHelperIpc({
      keyProvider: new StaticKeyProvider("key-current", KEY),
      peerAuthorizer: { authorize: () => true },
      nonceGuard: new InMemoryNonceReplayGuard(),
      nonceSource: createIncrementingNonceSource(0x31),
    });
    const connectOnce = async () => {
      const pair = createControlledMemoryPair();
      const results = await Promise.allSettled([
        core.connect({
          binding: BINDING,
          endpoint: ENDPOINT,
          keyReference: KEY_REFERENCE,
          dialer: { connect: async () => pair.core },
        }),
        createHelperSessionHelperIpc({
          keyProvider: new StaticKeyProvider("key-current", KEY),
          peerAuthorizer: { authorize: () => true },
          nonceGuard: new InMemoryNonceReplayGuard(),
          nonceSource: () => Buffer.alloc(32, 0x52),
        }).accept({
          binding: BINDING,
          keyReference: KEY_REFERENCE,
          connection: pair.helper,
        }),
      ]);
      return { pair, results };
    };

    const first = await connectOnce();
    assert.equal(
      first.results.every((result) => result.status === "fulfilled"),
      true,
    );
    for (const result of first.results) {
      if (result.status === "fulfilled") {
        result.value.close();
      }
    }

    const second = await connectOnce();
    assert.equal(second.results[0]?.status, "rejected");
    if (second.results[0]?.status === "rejected") {
      assertIpcCode(second.results[0].reason, "NONCE_REPLAY");
    }
    assert.equal(second.pair.closed, true);
  });

  it("fails closed on stale service epoch, owner session, or release version", async () => {
    const staleBindings: SessionHelperBinding[] = [
      { ...BINDING, serviceEpoch: BINDING.serviceEpoch - 1 },
      { ...BINDING, sessionId: "owner-session-stale" },
      { ...BINDING, releaseVersion: "0.0.9-stale" },
    ];

    for (const coreBinding of staleBindings) {
      const pair = createControlledMemoryPair();
      const results = await Promise.allSettled([
        createCoreSessionHelperIpc({
          keyProvider: new StaticKeyProvider("key-current", KEY),
          peerAuthorizer: { authorize: () => true },
          nonceSource: createIncrementingNonceSource(0x30),
        }).connect({
          binding: coreBinding,
          endpoint: ENDPOINT,
          keyReference: KEY_REFERENCE,
          dialer: { connect: async () => pair.core },
        }),
        createHelperSessionHelperIpc({
          keyProvider: new StaticKeyProvider("key-current", KEY),
          peerAuthorizer: { authorize: () => true },
          nonceSource: createIncrementingNonceSource(0x40),
        }).accept({
          binding: BINDING,
          keyReference: KEY_REFERENCE,
          connection: pair.helper,
        }),
      ]);
      assert.equal(results[1]?.status, "rejected");
      if (results[1]?.status === "rejected") {
        assertIpcCode(results[1].reason, "BINDING_MISMATCH");
      }
      assert.equal(pair.closed, true);
    }
  });

  it("rejects direction reflection before an application payload is accepted", async () => {
    const harness = await establish();
    await harness.coreChannel.send(readinessRequest("reflection"));
    const reflected = await harness.pair.coreToHelper.take();
    harness.pair.pushToCore(reflected);
    reflected.fill(0);

    await expectCode(harness.coreChannel.receive(), "PROTOCOL_ERROR");
    assert.equal(harness.coreChannel.isClosed, true);
    assert.equal(harness.pair.closed, true);
  });

  it("accepts a frame once, then rejects its exact sequence replay", async () => {
    const harness = await establish();
    await harness.helperChannel.send(readinessResponse("replay"));
    const frame = await harness.pair.helperToCore.take();
    harness.pair.pushToCore(frame);
    harness.pair.pushToCore(frame);
    frame.fill(0);

    assert.equal((await harness.coreChannel.receive()).requestId, "replay");
    await expectCode(harness.coreChannel.receive(), "SEQUENCE_VIOLATION");
    assert.equal(harness.pair.closed, true);
  });

  it("rejects a valid authenticated sequence gap", async () => {
    const harness = await establish();
    await harness.helperChannel.send(readinessResponse("dropped"));
    await harness.helperChannel.send(readinessResponse("gap"));
    const dropped = await harness.pair.helperToCore.take();
    const gap = await harness.pair.helperToCore.take();
    dropped.fill(0);
    harness.pair.pushToCore(gap);
    gap.fill(0);

    await expectCode(harness.coreChannel.receive(), "SEQUENCE_VIOLATION");
    assert.equal(harness.pair.closed, true);
  });

  it("rejects a tampered authenticated frame with a timing-safe MAC comparison", async () => {
    const harness = await establish();
    await harness.helperChannel.send(readinessResponse("tamper"));
    const frame = await harness.pair.helperToCore.take();
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 0xff;
    harness.pair.pushToCore(frame);
    frame.fill(0);

    await expectCode(harness.coreChannel.receive(), "AUTHENTICATION_FAILED");
    assert.equal(harness.pair.closed, true);
  });

  it("rejects an oversized wire frame before parsing its payload", async () => {
    const harness = await establish({ maxFrameBytes: 1_024 });
    harness.pair.pushToCore(Buffer.alloc(1_075, 0x61));

    await expectCode(harness.coreChannel.receive(), "FRAME_TOO_LARGE");
    assert.equal(harness.pair.closed, true);
  });

  it("rejects strict-schema violations and every non-capability proxy kind", async () => {
    const pair = createControlledMemoryPair();
    const helperPending = createHelperSessionHelperIpc({
      keyProvider: new StaticKeyProvider("key-current", KEY),
      peerAuthorizer: { authorize: () => true },
    }).accept({
      binding: BINDING,
      keyReference: KEY_REFERENCE,
      connection: pair.helper,
    });
    await pair.core.writeFrame(
      Buffer.from(
        JSON.stringify({
          type: "core_hello",
          protocolVersion: 1,
          deviceId: BINDING.deviceId,
          helperId: BINDING.helperId,
          sessionId: BINDING.sessionId,
          serviceEpoch: BINDING.serviceEpoch,
          releaseVersion: BINDING.releaseVersion,
          keyId: "key-current",
          coreNonce: Buffer.alloc(32, 0x55).toString("base64url"),
          unexpected: "general-proxy",
        }),
        "utf8",
      ),
    );
    await expectCode(helperPending, "MALFORMED_MESSAGE");
    assert.equal(pair.closed, true);

    for (const capability of ["shell", "filesystem", "general_proxy"]) {
      const harness = await establish();
      await expectCode(
        harness.coreChannel.send({
          type: "request",
          requestId: "forbidden",
          capability,
          payload: { command: "must-not-run" },
        } as never),
        "MALFORMED_MESSAGE",
      );
      assert.equal(harness.pair.closed, true);
    }
  });

  it("allows one explicit migration-key overlap handshake and rejects reuse", async () => {
    const oldKey = Buffer.alloc(32, 0x4f);
    const newKey = Buffer.alloc(32, 0x4e);
    const helperKeys = new RotatingKeyProvider({
      activeKeyId: "key-new",
      activeKey: newKey,
      migrationKeyId: "key-old",
      migrationKey: oldKey,
    });
    let helperNonce = 0x60;
    const helper = createHelperSessionHelperIpc({
      keyProvider: helperKeys,
      peerAuthorizer: { authorize: () => true },
      nonceGuard: new InMemoryNonceReplayGuard(),
      nonceSource: () => Buffer.alloc(32, helperNonce++),
    });

    const first = await establishWithHelper(
      helper,
      createIncrementingNonceSource(0x70),
      new StaticKeyProvider("key-old", oldKey),
    );
    first.coreChannel.close();
    first.helperChannel.close();
    assert.equal(helperKeys.consumeCalls, 1);

    const pair = createControlledMemoryPair();
    const results = await Promise.allSettled([
      createCoreSessionHelperIpc({
        keyProvider: new StaticKeyProvider("key-old", oldKey),
        peerAuthorizer: { authorize: () => true },
        nonceSource: createIncrementingNonceSource(0x71),
      }).connect({
        binding: BINDING,
        endpoint: ENDPOINT,
        keyReference: KEY_REFERENCE,
        dialer: { connect: async () => pair.core },
      }),
      helper.accept({
        binding: BINDING,
        keyReference: KEY_REFERENCE,
        connection: pair.helper,
      }),
    ]);

    assert.equal(results[1]?.status, "rejected");
    if (results[1]?.status === "rejected") {
      assertIpcCode(results[1].reason, "KEY_ROTATION_REJECTED");
    }
    assert.equal(helperKeys.consumeCalls, 2);
    assert.equal(
      helperKeys.acquired.every((value) => value.equals(Buffer.alloc(32))),
      true,
    );
    assert.equal(pair.closed, true);
  });

  it("zeroizes disposable keys and closes both directions after disconnect without leaking transport errors", async () => {
    const coreKeys = new StaticKeyProvider("key-current", KEY);
    const helperKeys = new StaticKeyProvider("key-current", KEY);
    const harness = await establish({ coreKeys, helperKeys });
    assert.equal(
      [...coreKeys.acquired, ...helperKeys.acquired].every((value) =>
        value.equals(Buffer.alloc(32)),
      ),
      true,
    );

    harness.pair.disconnect();
    let serialized = "";
    await assert.rejects(harness.coreChannel.receive(), (error: unknown) => {
      assertIpcCode(error, "CONNECTION_CLOSED");
      serialized = `${String(error)}\n${String((error as Error).stack)}`;
      return true;
    });
    assert.equal(serialized.includes("transport secret"), false);
    assert.equal(serialized.includes(KEY_REFERENCE), false);
    assert.equal(harness.coreChannel.isClosed, true);
    await expectCode(
      harness.coreChannel.send(readinessRequest("after-close")),
      "CONNECTION_CLOSED",
    );
    assert.equal(harness.pair.closeCount, 1);
  });

  it("zeroizes a disposable key that resolves after the bounded handshake has timed out", async () => {
    const pair = createControlledMemoryPair();
    let resolveKey: (lease: {
      readonly keyId: string;
      readonly material: Buffer;
      readonly usage: "active";
    }) => void = () => {};
    const delayedKey = new Promise<{
      readonly keyId: string;
      readonly material: Buffer;
      readonly usage: "active";
    }>((resolve) => {
      resolveKey = resolve;
    });
    const pending = createCoreSessionHelperIpc({
      keyProvider: {
        async acquire() {
          return await delayedKey;
        },
      },
      peerAuthorizer: { authorize: () => true },
      handshakeTimeoutMs: 20,
      nonceSource: () => Buffer.alloc(32, 0x12),
    }).connect({
      binding: BINDING,
      endpoint: ENDPOINT,
      keyReference: KEY_REFERENCE,
      dialer: { connect: async () => pair.core },
    });

    await expectCode(pending, "TRANSPORT_FAILURE");
    const lateMaterial = Buffer.from(KEY);
    resolveKey({
      keyId: "key-current",
      material: lateMaterial,
      usage: "active",
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(lateMaterial.equals(Buffer.alloc(32)), true);
    assert.equal(pair.closed, true);
  });
});

interface EstablishedHarness {
  readonly pair: ControlledMemoryPair;
  readonly coreChannel: CoreSessionHelperChannel;
  readonly helperChannel: HelperSessionHelperChannel;
}

async function establish(
  options: {
    readonly maxFrameBytes?: number;
    readonly coreKeys?: StaticKeyProvider;
    readonly helperKeys?: StaticKeyProvider;
  } = {},
): Promise<EstablishedHarness> {
  const pair = createControlledMemoryPair();
  const coreKeys = options.coreKeys ?? new StaticKeyProvider("key-current", KEY);
  const helperKeys = options.helperKeys ?? new StaticKeyProvider("key-current", KEY);
  const shared = {
    peerAuthorizer: { authorize: () => true },
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  };
  const [coreChannel, helperChannel] = await Promise.all([
    createCoreSessionHelperIpc({
      ...shared,
      keyProvider: coreKeys,
      nonceSource: createIncrementingNonceSource(0x11),
    }).connect({
      binding: BINDING,
      endpoint: ENDPOINT,
      keyReference: KEY_REFERENCE,
      dialer: { connect: async () => pair.core },
    }),
    createHelperSessionHelperIpc({
      ...shared,
      keyProvider: helperKeys,
      nonceSource: createIncrementingNonceSource(0x22),
    }).accept({
      binding: BINDING,
      keyReference: KEY_REFERENCE,
      connection: pair.helper,
    }),
  ]);
  return { pair, coreChannel, helperChannel };
}

async function establishWithHelper(
  helper: ReturnType<typeof createHelperSessionHelperIpc>,
  coreNonceSource: () => Buffer,
  coreKeys = new StaticKeyProvider("key-current", KEY),
): Promise<EstablishedHarness> {
  const pair = createControlledMemoryPair();
  const [coreChannel, helperChannel] = await Promise.all([
    createCoreSessionHelperIpc({
      keyProvider: coreKeys,
      peerAuthorizer: { authorize: () => true },
      nonceGuard: new InMemoryNonceReplayGuard(),
      nonceSource: coreNonceSource,
    }).connect({
      binding: BINDING,
      endpoint: ENDPOINT,
      keyReference: KEY_REFERENCE,
      dialer: { connect: async () => pair.core },
    }),
    helper.accept({
      binding: BINDING,
      keyReference: KEY_REFERENCE,
      connection: pair.helper,
    }),
  ]);
  return { pair, coreChannel, helperChannel };
}

function readinessRequest(requestId: string) {
  return {
    type: "request" as const,
    requestId,
    capability: "readiness" as const,
    payload: {},
  };
}

function readinessResponse(requestId: string): SessionHelperCapabilityResponse {
  return {
    type: "response",
    requestId,
    capability: "readiness",
    outcome: "ok",
    payload: {
      interactiveSession: true,
      unlockedSession: true,
      captureAvailable: true,
      observationAvailable: true,
      inputAvailable: true,
      emergencyStopAvailable: true,
      displayFingerprint: "display-security",
    },
  };
}

function createIncrementingNonceSource(initial: number): () => Buffer {
  let value = initial;
  return () => Buffer.alloc(32, value++);
}

async function expectCode(
  promise: Promise<unknown>,
  code: SessionHelperIpcError["code"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assertIpcCode(error, code);
    return true;
  });
}

function assertIpcCode(
  error: unknown,
  code: SessionHelperIpcError["code"],
): asserts error is SessionHelperIpcError {
  assert.equal(error instanceof SessionHelperIpcError, true);
  assert.equal((error as SessionHelperIpcError).code, code);
}
