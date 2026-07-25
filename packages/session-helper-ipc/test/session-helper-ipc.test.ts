import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryNonceReplayGuard,
  createCoreSessionHelperIpc,
  createHelperSessionHelperIpc,
  type SessionHelperBinding,
} from "../src/index.ts";
import { StaticKeyProvider } from "../test-support/key-provider.ts";
import { createControlledMemoryPair } from "../test-support/memory-transport.ts";

const BINDING: SessionHelperBinding = Object.freeze({
  protocolVersion: 1,
  deviceId: "device-1",
  helperId: "helper-1",
  sessionId: "session-owner-1",
  serviceEpoch: 7,
  releaseVersion: "0.1.0-alpha.1",
});
const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

describe("authenticated session-helper IPC", () => {
  it("mutually authenticates and exchanges only a validated capability envelope", async () => {
    const pair = createControlledMemoryPair();
    const coreKeys = new StaticKeyProvider("key-1", KEY);
    const helperKeys = new StaticKeyProvider("key-1", KEY);
    const core = createCoreSessionHelperIpc({
      keyProvider: coreKeys,
      peerAuthorizer: { authorize: () => true },
      nonceGuard: new InMemoryNonceReplayGuard(),
      nonceSource: () => Buffer.alloc(32, 0x11),
    });
    const helper = createHelperSessionHelperIpc({
      keyProvider: helperKeys,
      peerAuthorizer: { authorize: () => true },
      nonceGuard: new InMemoryNonceReplayGuard(),
      nonceSource: () => Buffer.alloc(32, 0x22),
    });

    const [coreChannel, helperChannel] = await Promise.all([
      core.connect({
        binding: BINDING,
        endpoint: {
          kind: "windows-named-pipe",
          path: String.raw`\\.\pipe\OpenDelegate\helper`,
        },
        keyReference: "secret://ipc/session-helper",
        dialer: { connect: async () => pair.core },
      }),
      helper.accept({
        binding: BINDING,
        keyReference: "secret://ipc/session-helper",
        connection: pair.helper,
      }),
    ]);

    await coreChannel.send({
      type: "request",
      requestId: "request-1",
      capability: "readiness",
      payload: {},
    });
    assert.deepEqual(await helperChannel.receive(), {
      type: "request",
      requestId: "request-1",
      capability: "readiness",
      payload: {},
    });

    await helperChannel.send({
      type: "response",
      requestId: "request-1",
      capability: "readiness",
      outcome: "ok",
      payload: {
        interactiveSession: true,
        unlockedSession: true,
        captureAvailable: true,
        observationAvailable: true,
        inputAvailable: true,
        emergencyStopAvailable: true,
        displayFingerprint: "display-1",
      },
    });
    assert.deepEqual(await coreChannel.receive(), {
      type: "response",
      requestId: "request-1",
      capability: "readiness",
      outcome: "ok",
      payload: {
        interactiveSession: true,
        unlockedSession: true,
        captureAvailable: true,
        observationAvailable: true,
        inputAvailable: true,
        emergencyStopAvailable: true,
        displayFingerprint: "display-1",
      },
    });

    const remainingCapabilities = [
      {
        type: "request",
        requestId: "request-capture",
        capability: "capture",
        payload: {
          executionHandleId: "execution-capture",
          taskId: "task-1",
          runId: "run-1",
          persistenceGeneration: "17",
          leaseId: "lease-desktop-1",
          fencingToken: "41",
          deadlineUnixMs: 2_000_000_000_000,
          displayFingerprint: "display-1",
        },
      },
      {
        type: "request",
        requestId: "request-observe",
        capability: "observe",
        payload: {
          executionHandleId: "execution-observe",
          taskId: "task-1",
          runId: "run-1",
          persistenceGeneration: "17",
          leaseId: "lease-desktop-1",
          fencingToken: "41",
          deadlineUnixMs: 2_000_000_000_000,
          displayFingerprint: "display-1",
          maxElements: 128,
        },
      },
      {
        type: "request",
        requestId: "request-input",
        capability: "exact_input",
        payload: {
          executionHandleId: "execution-input",
          taskId: "task-1",
          runId: "run-1",
          persistenceGeneration: "17",
          leaseId: "lease-desktop-1",
          fencingToken: "41",
          authorizationId: "authorization-1",
          policyFingerprint: `sha256:${"a".repeat(64)}`,
          authorizedAction: {
            kind: "type-text",
            controlId: "task-text",
            textSha256: `sha256:${"b".repeat(64)}`,
            textLength: 28,
          },
          deadlineUnixMs: 2_000_000_000_000,
          displayFingerprint: "display-1",
          action: {
            kind: "keyboard",
            operation: "text",
            text: "bounded final-boundary input",
          },
        },
      },
      {
        type: "request",
        requestId: "request-cancel",
        capability: "cancel",
        payload: { targetRequestId: "request-input" },
      },
      {
        type: "request",
        requestId: "request-stop",
        capability: "emergency_stop",
        payload: { reasonCode: "owner" },
      },
      {
        type: "request",
        requestId: "request-diagnostics",
        capability: "diagnostics",
        payload: { maxEntries: 10, maxBytes: 4_096 },
      },
    ] as const;
    for (const request of remainingCapabilities) {
      await coreChannel.send(request);
      assert.equal((await helperChannel.receive()).capability, request.capability);
    }

    assert.equal(
      [...coreKeys.acquired, ...helperKeys.acquired].every((value) =>
        value.equals(Buffer.alloc(32)),
      ),
      true,
    );
    coreChannel.close();
    helperChannel.close();
  });
});
