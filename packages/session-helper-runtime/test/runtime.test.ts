import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createActionFingerprint,
  createFixtureNativeDriver,
  describeNativeComputerUseAction,
  type NativeDriverAuthorizedInputContext,
} from "@opendelegate/computer-use-os";
import {
  SESSION_HELPER_IPC_PROTOCOL_VERSION,
  type CoreSessionHelperChannel,
  type HelperSessionHelperChannel,
  type SessionHelperBinding,
  type SessionHelperCapabilityRequest,
  type SessionHelperCapabilityResponse,
} from "@opendelegate/session-helper-ipc";

import {
  PersistentDesktopAuthorityStore,
  SessionHelperCoreClient,
  serveSessionHelperChannel,
  type AuthoritySigningKeyProvider,
} from "../src/index.ts";

const BINDING: SessionHelperBinding = {
  protocolVersion: SESSION_HELPER_IPC_PROTOCOL_VERSION,
  deviceId: "device-runtime-1",
  helperId: "helper-runtime-1",
  sessionId: "session-owner-1",
  serviceEpoch: 3,
  releaseVersion: "0.1.0-alpha.1",
};

describe("session-helper production runtime", () => {
  it("carries an exact authorization across the helper channel into native input", async () => {
    const channels = channelPair(BINDING);
    const fixture = createFixtureNativeDriver({
      osFamily: "windows",
      runIdentifier: "session-helper-runtime",
    });
    const helper = serveSessionHelperChannel({
      channel: channels.helper,
      driver: fixture.driver,
    });
    const client = new SessionHelperCoreClient({
      channel: channels.core,
      osFamily: "windows",
      backendId: "session-helper-runtime-test",
      requestTimeoutMs: 2_000,
    });
    const context = executionContext("display:fixture:320x180:1", {
      kind: "type-text",
      controlId: "task-text",
      text: "authorized over IPC",
    });
    await client.act(context, {
      kind: "type-text",
      controlId: "task-text",
      text: "authorized over IPC",
    });
    await client.observe(context);
    assert.equal(fixture.activity().actionCount, 1);

    client.close();
    await helper.close();
  });

  it("rejects mismatched post-Policy evidence before the helper mutates the desktop", async () => {
    const channels = channelPair(BINDING);
    const fixture = createFixtureNativeDriver({
      osFamily: "windows",
      runIdentifier: "session-helper-runtime-mismatch",
    });
    const helper = serveSessionHelperChannel({ channel: channels.helper, driver: fixture.driver });
    const client = new SessionHelperCoreClient({
      channel: channels.core,
      osFamily: "windows",
      backendId: "session-helper-runtime-test",
      requestTimeoutMs: 2_000,
    });
    const action = { kind: "click", controlId: "submit" } as const;
    const context = executionContext("display:fixture:320x180:1", action);
    const altered = {
      ...context,
      authorization: {
        ...context.authorization,
        fingerprint: `sha256:${"0".repeat(64)}` as const,
      },
    };
    await assert.rejects(client.act(altered, action), /authorization/u);
    assert.equal(fixture.activity().actionCount, 0);
    client.close();
    await helper.close();
  });

  it("persists monotonic epochs, fences replacement, and refuses cloned or corrupt authority", async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), "opendelegate-authority-"));
    const cloneRoot = await mkdtemp(join(tmpdir(), "opendelegate-authority-clone-"));
    const keys = new StaticSigningKeyProvider();
    try {
      const first = await PersistentDesktopAuthorityStore.openCore({
        authorityRoot,
        sourceCheckoutRoot: process.cwd(),
        deviceId: "device-runtime-1",
        instanceId: "instance-runtime-1",
        releaseVersion: "0.1.0-alpha.1",
        keys,
      });
      const firstEpoch = first.serviceEpoch;
      const initialGeneration = first.persistenceGeneration;
      await first.activateHelper({
        helperInstanceId: "helper-runtime-1",
        sessionId: "session-owner-1",
      });
      const verified = await first.verify({
        deviceId: "device-runtime-1",
        helperInstanceId: "helper-runtime-1",
        serviceEpoch: firstEpoch,
        persistenceGeneration: initialGeneration + 1,
      });
      assert.equal(verified.status, "current");
      if (verified.status === "current") {
        assert.equal(verified.helperInstanceId, "helper-runtime-1");
        assert.equal(verified.serviceEpoch, firstEpoch);
        assert.equal(verified.persistenceGeneration, initialGeneration + 1);
        assert.equal(typeof verified.verifiedAtMs, "number");
      }
      await first.close();

      const second = await PersistentDesktopAuthorityStore.openCore({
        authorityRoot,
        sourceCheckoutRoot: process.cwd(),
        deviceId: "device-runtime-1",
        instanceId: "instance-runtime-1",
        releaseVersion: "0.1.0-alpha.1",
        keys,
      });
      assert.ok(second.serviceEpoch > firstEpoch);
      assert.ok(second.persistenceGeneration > initialGeneration + 1);
      await second.close();

      const record = await readFile(join(authorityRoot, "desktop-authority.json"));
      await writeFile(join(cloneRoot, "desktop-authority.json"), record);
      await assert.rejects(
        PersistentDesktopAuthorityStore.openCore({
          authorityRoot: cloneRoot,
          sourceCheckoutRoot: process.cwd(),
          deviceId: "device-runtime-1",
          instanceId: "instance-runtime-1",
          releaseVersion: "0.1.0-alpha.1",
          keys,
        }),
        /authority/u,
      );

      await writeFile(join(authorityRoot, "desktop-authority.json"), "{corrupt");
      await assert.rejects(
        PersistentDesktopAuthorityStore.openCore({
          authorityRoot,
          sourceCheckoutRoot: process.cwd(),
          deviceId: "device-runtime-1",
          instanceId: "instance-runtime-1",
          releaseVersion: "0.1.0-alpha.1",
          keys,
        }),
        /authority/u,
      );
      assert.equal(
        await readFile(join(authorityRoot, "desktop-authority.json"), "utf8"),
        "{corrupt",
      );
    } finally {
      await rm(authorityRoot, { recursive: true, force: true });
      await rm(cloneRoot, { recursive: true, force: true });
    }
  });
});

class StaticSigningKeyProvider implements AuthoritySigningKeyProvider {
  async executeWithKey<T>(operation: (key: Buffer) => Promise<T> | T): Promise<T> {
    const key = Buffer.alloc(32, 0x42);
    try {
      return await operation(key);
    } finally {
      key.fill(0);
    }
  }
}

function executionContext(
  displayFingerprint: string,
  action: Parameters<SessionHelperCoreClient["act"]>[1],
): NativeDriverAuthorizedInputContext {
  const descriptor = describeNativeComputerUseAction(action);
  return {
    executionHandleId: "execution-runtime-1",
    taskId: "task-runtime-1",
    deviceId: BINDING.deviceId,
    runId: "run-runtime-1",
    helperInstanceId: BINDING.helperId,
    serviceEpoch: BINDING.serviceEpoch,
    persistenceGeneration: 11,
    leaseId: "lease-runtime-1",
    fencingToken: 5,
    expectedDisplayFingerprint: displayFingerprint,
    signal: new AbortController().signal,
    authorization: {
      authorizationId: "authorization-runtime-1",
      fingerprint: createActionFingerprint({
        action: descriptor,
      }),
      action: descriptor,
    },
  };
}

function channelPair(binding: SessionHelperBinding): {
  core: CoreSessionHelperChannel;
  helper: HelperSessionHelperChannel;
} {
  const requests = queue<SessionHelperCapabilityRequest>();
  const responses = queue<SessionHelperCapabilityResponse>();
  let closed = false;
  return {
    core: {
      binding,
      get isClosed() {
        return closed;
      },
      send: (request) => requests.push(request),
      receive: () => responses.shift(),
      close: () => {
        closed = true;
        requests.close();
        responses.close();
      },
    },
    helper: {
      binding,
      get isClosed() {
        return closed;
      },
      send: (response) => responses.push(response),
      receive: () => requests.shift(),
      close: () => {
        closed = true;
        requests.close();
        responses.close();
      },
    },
  };
}

function queue<T>() {
  const values: T[] = [];
  const waiters: Array<{ resolve(value: T): void; reject(error: Error): void }> = [];
  let closed = false;
  return {
    async push(value: T) {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve(value);
      } else {
        values.push(value);
      }
    },
    async shift(): Promise<T> {
      const value = values.shift();
      if (value !== undefined) {
        return value;
      }
      if (closed) {
        throw new Error("closed");
      }
      return await new Promise<T>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error("closed"));
      }
    },
  };
}
