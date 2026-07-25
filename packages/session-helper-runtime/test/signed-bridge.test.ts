import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createFixtureNativeDriver } from "@opendelegate/computer-use-os";
import {
  createNodeSessionHelperIpcTransport,
  type SessionHelperIpcEndpoint,
  type SessionHelperPeerPublicKey,
  type SessionHelperSigningKeyProvider,
} from "@opendelegate/session-helper-ipc";

import {
  PersistentDesktopAuthorityStore,
  SignedSessionHelperCoreBridge,
  SignedSessionHelperPlaneHost,
  type AuthoritySigningKeyProvider,
  type SessionHelperRuntimeLease,
} from "../src/index.ts";

describe("signed two-plane runtime", () => {
  it("keeps the headless core alive across helper loss and fences a replacement helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-signed-bridge-"));
    const checkout = join(root, "checkout");
    const runtimeRoot = join(root, "run");
    const authorityRoot = join(root, "authority");
    await Promise.all([
      mkdir(checkout),
      mkdir(runtimeRoot, { mode: 0o700 }),
      mkdir(authorityRoot, { mode: 0o700 }),
    ]);
    const coreKey = signingFixture();
    const helperKey = signingFixture();
    const endpoint: SessionHelperIpcEndpoint =
      process.platform === "win32"
        ? {
            kind: "windows-named-pipe",
            path: String.raw`\\.\pipe\OpenDelegate\signed-bridge-test`,
          }
        : {
            kind: "unix-domain-socket",
            path: join(runtimeRoot, "helper.sock"),
          };
    const transport = createNodeSessionHelperIpcTransport();
    const authority = await PersistentDesktopAuthorityStore.openCore({
      authorityRoot,
      sourceCheckoutRoot: checkout,
      deviceId: "device-signed-bridge",
      instanceId: "personal",
      releaseVersion: "0.1.0-alpha.1",
      keys: new StaticAuthorityKeyProvider(),
    });
    const bridge = await SignedSessionHelperCoreBridge.start({
      instanceId: "personal",
      deviceId: "device-signed-bridge",
      releaseVersion: "0.1.0-alpha.1",
      runtimeRoot,
      osFamily: process.platform === "win32" ? "windows" : "linux",
      backendId: "signed-bridge-test",
      endpoint,
      transport,
      privateKeyReference: "secret://core/signing-v2",
      localKeyId: coreKey.keyId,
      signingKeyProvider: coreKey.provider,
      helperPublicKey: helperKey.pin,
      peerAuthorizer: { authorize: () => true },
      authority,
      reconnectIntervalMs: 100,
    });
    let helper: SignedSessionHelperPlaneHost | undefined;
    let replacement: SignedSessionHelperPlaneHost | undefined;
    try {
      helper = await startHelper({
        helperInstanceId: "helper-first",
        root: runtimeRoot,
        endpoint,
        transport,
        coreKey,
        helperKey,
      });
      const first = await waitForLease(bridge, "helper-first");
      const firstGeneration = first.binding.persistenceGeneration;
      assert.equal((await first.driver.probe()).helperInstanceId, "helper-first");
      await first.release();

      await helper.close();
      helper = undefined;
      await waitForUnavailable(bridge);

      replacement = await startHelper({
        helperInstanceId: "helper-replacement",
        root: runtimeRoot,
        endpoint,
        transport,
        coreKey,
        helperKey,
      });
      const second = await waitForLease(bridge, "helper-replacement");
      assert.ok(second.binding.persistenceGeneration > firstGeneration);
      assert.equal((await second.driver.probe()).helperInstanceId, "helper-replacement");
      await second.release();
    } finally {
      await helper?.close().catch(() => undefined);
      await replacement?.close().catch(() => undefined);
      await bridge.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function startHelper(input: {
  readonly helperInstanceId: string;
  readonly root: string;
  readonly endpoint: SessionHelperIpcEndpoint;
  readonly transport: ReturnType<typeof createNodeSessionHelperIpcTransport>;
  readonly coreKey: SigningFixture;
  readonly helperKey: SigningFixture;
}): Promise<SignedSessionHelperPlaneHost> {
  const fixture = createFixtureNativeDriver({
    osFamily: process.platform === "win32" ? "windows" : "linux",
    runIdentifier: input.helperInstanceId,
  });
  return await SignedSessionHelperPlaneHost.start({
    instanceId: "personal",
    deviceId: "device-signed-bridge",
    releaseVersion: "0.1.0-alpha.1",
    runtimeRoot: input.root,
    helperInstanceId: input.helperInstanceId,
    sessionId: "owner-session-test",
    endpoint: input.endpoint,
    transport: input.transport,
    privateKeyReference: "secret://helper/signing-v2",
    localKeyId: input.helperKey.keyId,
    signingKeyProvider: input.helperKey.provider,
    corePublicKey: input.coreKey.pin,
    peerAuthorizer: { authorize: () => true },
    createDriver: async () => fixture.driver,
    corePollIntervalMs: 100,
  });
}

async function waitForLease(
  bridge: SignedSessionHelperCoreBridge,
  helperInstanceId: string,
): Promise<SessionHelperRuntimeLease> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const lease = await bridge.acquire();
    if (lease?.binding.helperInstanceId === helperInstanceId) {
      return lease;
    }
    await lease?.release();
    await delay(25);
  }
  throw new Error(`The ${helperInstanceId} helper did not become available.`);
}

async function waitForUnavailable(bridge: SignedSessionHelperCoreBridge): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const lease = await bridge.acquire();
    if (lease === undefined) {
      return;
    }
    await lease.release();
    await delay(25);
  }
  throw new Error("The lost helper remained available.");
}

interface SigningFixture {
  readonly keyId: `sha256:${string}`;
  readonly pin: SessionHelperPeerPublicKey;
  readonly provider: SessionHelperSigningKeyProvider;
}

function signingFixture(): SigningFixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const keyId = `sha256:${createHash("sha256").update(spki).digest("hex")}` as const;
  return {
    keyId,
    pin: {
      keyId,
      publicKeySpkiBase64Url: spki.toString("base64url"),
      usage: "active",
    },
    provider: new StaticSigningProvider(privateKey, keyId),
  };
}

class StaticSigningProvider implements SessionHelperSigningKeyProvider {
  readonly #privateKey: KeyObject;
  readonly #keyId: string;

  public constructor(privateKey: KeyObject, keyId: string) {
    this.#privateKey = privateKey;
    this.#keyId = keyId;
  }

  public async sign(_privateKeyReference: string, keyId: string, message: Buffer): Promise<Buffer> {
    if (keyId !== this.#keyId) {
      throw new Error("wrong key");
    }
    return sign(null, message, this.#privateKey);
  }
}

class StaticAuthorityKeyProvider implements AuthoritySigningKeyProvider {
  readonly #key = Buffer.alloc(32, 0x51);

  public async executeWithKey<T>(operation: (key: Buffer) => Promise<T> | T): Promise<T> {
    const key = Buffer.from(this.#key);
    try {
      return await operation(key);
    } finally {
      key.fill(0);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
