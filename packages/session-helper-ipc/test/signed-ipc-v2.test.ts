import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION,
  SessionHelperIpcError,
  createSignedCoreSessionHelperIpc,
  createSignedHelperSessionHelperIpc,
  type SignedCoreSessionHelperChannel,
  type SignedHelperSessionHelperChannel,
  type SignedSessionHelperBinding,
} from "../src/index.ts";
import {
  createControlledMemoryPair,
  type ControlledMemoryPair,
} from "../test-support/memory-transport.ts";
import { createEd25519SigningFixture } from "../test-support/signing-key-provider.ts";

const BINDING: SignedSessionHelperBinding = Object.freeze({
  protocolVersion: SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION,
  deviceId: "device-signed-v2",
  helperId: "helper-owner-session",
  sessionId: "windows-session-4",
  serviceEpoch: 93,
  releaseVersion: "0.1.0-alpha.1",
});
const ENDPOINT = Object.freeze({
  kind: "windows-named-pipe" as const,
  path: String.raw`\\.\pipe\OpenDelegate\signed-v2`,
});

describe("Ed25519 session-helper IPC v2", () => {
  it("keeps plane-private keys separate and signs the handshake plus every capability frame", async () => {
    const harness = await establish();
    await harness.coreChannel.send(readinessRequest("signed-request"));
    assert.deepEqual(await harness.helperChannel.receive(), readinessRequest("signed-request"));
    await harness.helperChannel.send(readinessResponse("signed-request"));
    assert.equal((await harness.coreChannel.receive()).requestId, "signed-request");

    assert.equal(harness.core.provider.signedMessages.length, 3);
    assert.equal(harness.helper.provider.signedMessages.length, 2);
    assert.equal(
      harness.core.provider.signedMessages.every((message) => {
        const helperMessage = harness.helper.provider.signedMessages[0];
        return helperMessage === undefined || !message.equals(helperMessage);
      }),
      true,
    );
    harness.coreChannel.close();
    harness.helperChannel.close();
  });

  it("rejects a different helper private key even when the transport principal is allowed", async () => {
    const core = createEd25519SigningFixture();
    const expectedHelper = createEd25519SigningFixture();
    const actualHelper = createEd25519SigningFixture();
    const pair = createControlledMemoryPair();
    const results = await Promise.allSettled([
      createSignedCoreSessionHelperIpc({
        localPrivateKeyReference: "secret://core/signing-v2",
        localKeyId: core.keyId,
        signingKeyProvider: core.provider,
        acceptedPeerKeys: [expectedHelper.pin],
        peerAuthorizer: { authorize: () => true },
        nonceSource: () => Buffer.alloc(32, 0x31),
      }).connect({
        binding: BINDING,
        endpoint: ENDPOINT,
        dialer: { connect: async () => pair.core },
      }),
      createSignedHelperSessionHelperIpc({
        localPrivateKeyReference: "secret://helper/signing-v2",
        localKeyId: actualHelper.keyId,
        signingKeyProvider: actualHelper.provider,
        acceptedPeerKeys: [core.pin],
        peerAuthorizer: { authorize: () => true },
        nonceSource: () => Buffer.alloc(32, 0x41),
      }).accept({ binding: BINDING, connection: pair.helper }),
    ]);

    assert.equal(results[0]?.status, "rejected");
    if (results[0]?.status === "rejected") {
      assertIpcCode(results[0].reason, "AUTHENTICATION_FAILED");
    }
    assert.equal(pair.closed, true);
  });

  it("binds every frame to direction, exact sequence, service epoch, and handshake nonces", async () => {
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
});

async function establish(): Promise<{
  readonly pair: ControlledMemoryPair;
  readonly core: ReturnType<typeof createEd25519SigningFixture>;
  readonly helper: ReturnType<typeof createEd25519SigningFixture>;
  readonly coreChannel: SignedCoreSessionHelperChannel;
  readonly helperChannel: SignedHelperSessionHelperChannel;
}> {
  const pair = createControlledMemoryPair();
  const core = createEd25519SigningFixture();
  const helper = createEd25519SigningFixture();
  const [coreChannel, helperChannel] = await Promise.all([
    createSignedCoreSessionHelperIpc({
      localPrivateKeyReference: "secret://core/signing-v2",
      localKeyId: core.keyId,
      signingKeyProvider: core.provider,
      acceptedPeerKeys: [helper.pin],
      peerAuthorizer: {
        authorize: (request) => request.peerIdentity.principalId === "helper-owner",
      },
      nonceSource: () => Buffer.alloc(32, 0x11),
    }).connect({
      binding: BINDING,
      endpoint: ENDPOINT,
      dialer: { connect: async () => pair.core },
    }),
    createSignedHelperSessionHelperIpc({
      localPrivateKeyReference: "secret://helper/signing-v2",
      localKeyId: helper.keyId,
      signingKeyProvider: helper.provider,
      acceptedPeerKeys: [core.pin],
      peerAuthorizer: {
        authorize: (request) => request.peerIdentity.principalId === "core-service",
      },
      nonceSource: () => Buffer.alloc(32, 0x22),
    }).accept({ binding: BINDING, connection: pair.helper }),
  ]);
  return { pair, core, helper, coreChannel, helperChannel };
}

function readinessRequest(requestId: string) {
  return {
    type: "request" as const,
    requestId,
    capability: "readiness" as const,
    payload: {},
  };
}

function readinessResponse(requestId: string) {
  return {
    type: "response" as const,
    requestId,
    capability: "readiness" as const,
    outcome: "ok" as const,
    payload: {
      interactiveSession: true,
      unlockedSession: true,
      captureAvailable: true,
      observationAvailable: true,
      inputAvailable: true,
      emergencyStopAvailable: true,
      displayFingerprint: "display-signed-v2",
    },
  };
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
