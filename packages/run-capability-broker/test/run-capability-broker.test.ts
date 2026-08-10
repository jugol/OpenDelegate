import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  LocalRunCapabilityBroker,
  RunCapabilityBrokerError,
  consumeRunCapabilityFile,
  type RunCapabilityBinding,
} from "../src/index.ts";

const binding: RunCapabilityBinding = {
  taskId: "task-1",
  workOrderId: "work-order-1",
  runId: "run-1",
  deviceId: "device-1",
  leaseId: "run-lease-1",
  fencingToken: 7,
  leaseExpiresAtMs: 4_102_444_800_000,
};

test("one protected file claims one exact Run capability and carries bounded requests", async () => {
  const root = await canonicalTemporaryDirectory("opendelegate-capability-");
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: root,
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => 4_000_000_000_000 },
  });
  try {
    const lease = await broker.register({
      capability: "fixture",
      binding,
      metadata: { version: 1, mode: "test" },
      expiresAtMs: 4_000_000_060_000,
      currentBinding: () => binding,
      isExecutionCurrent: async () => true,
      handler: async (request, context) => {
        assert.deepEqual(context.binding, binding);
        assert.equal(Object.isFrozen(context.binding), true);
        assert.equal(context.signal.aborted, false);
        return {
          method: request.method,
          payload: request.payload,
        };
      },
    });
    const descriptorCopy = join(root, "copied-capability.json");
    await copyFile(lease.capabilityFile, descriptorCopy);
    const metadata = await lstat(lease.capabilityFile);
    assert.equal(metadata.isFile(), true);
    if (process.platform !== "win32") {
      assert.equal(metadata.mode & 0o077, 0);
    }

    const client = await consumeRunCapabilityFile({
      filename: lease.capabilityFile,
      expectedCapability: "fixture",
    });
    assert.deepEqual(client.binding, binding);
    assert.deepEqual(client.metadata, { version: 1, mode: "test" });
    await assert.rejects(access(lease.capabilityFile));
    assert.deepEqual(
      await client.request({
        method: "fixture.echo",
        payload: { value: "hello" },
      }),
      {
        method: "fixture.echo",
        payload: { value: "hello" },
      },
    );

    await assert.rejects(
      consumeRunCapabilityFile({
        filename: descriptorCopy,
        expectedCapability: "fixture",
      }),
      (error: unknown) =>
        error instanceof RunCapabilityBrokerError && error.code === "CAPABILITY_CONSUMED",
    );
    await client.close();
    await lease.dispose();
    await lease.dispose();
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("one exact Run capability supports bounded provider-native child connections", async () => {
  const root = await canonicalTemporaryDirectory("opendelegate-capability-team-");
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: root,
    sourceCheckoutDirectory: process.cwd(),
  });
  try {
    const lease = await broker.register({
      capability: "fixture",
      binding,
      metadata: { mode: "native-agent-team" },
      expiresAtMs: Date.now() + 60_000,
      maxConcurrentConnections: 2,
      currentBinding: () => binding,
      isExecutionCurrent: async () => true,
      handler: async (request) => request.payload,
    });
    const parent = await consumeRunCapabilityFile({
      filename: lease.capabilityFile,
      expectedCapability: "fixture",
    });
    const child = await consumeRunCapabilityFile({
      filename: lease.capabilityFile,
      expectedCapability: "fixture",
    });
    await access(lease.capabilityFile);
    await assert.rejects(
      consumeRunCapabilityFile({
        filename: lease.capabilityFile,
        expectedCapability: "fixture",
      }),
      hasCode("CAPABILITY_CONSUMED"),
    );
    assert.deepEqual(await child.request({ method: "fixture.echo", payload: { child: true } }), {
      child: true,
    });
    await child.close();
    const replacementChild = await consumeRunCapabilityFile({
      filename: lease.capabilityFile,
      expectedCapability: "fixture",
    });
    await replacementChild.close();
    await parent.close();
    await lease.dispose();
    await assert.rejects(access(lease.capabilityFile));
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a claimed capability follows renewed binding expiry and exact Run revocation", async () => {
  const root = await canonicalTemporaryDirectory("opendelegate-capability-expiry-");
  let now = 100;
  let current = true;
  let leaseExpiresAtMs = 1_000;
  let calls = 0;
  const observedExpiries: number[] = [];
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: root,
    sourceCheckoutDirectory: process.cwd(),
    clock: { now: () => now },
  });
  try {
    const lease = await broker.register({
      capability: "fixture",
      binding: { ...binding, leaseExpiresAtMs: 1_000 },
      metadata: null,
      expiresAtMs: 900,
      currentBinding: () => ({ ...binding, leaseExpiresAtMs }),
      isExecutionCurrent: async () => current && now < leaseExpiresAtMs,
      handler: async (_request, context) => {
        calls += 1;
        observedExpiries.push(context.binding.leaseExpiresAtMs);
        return null;
      },
    });
    const client = await consumeRunCapabilityFile({
      filename: lease.capabilityFile,
      expectedCapability: "fixture",
      clock: { now: () => now },
    });
    current = false;
    await assert.rejects(
      client.request({ method: "fixture.execute", payload: null }),
      hasCode("CAPABILITY_REVOKED"),
    );
    assert.equal(calls, 0);
    current = true;
    now = 901;
    leaseExpiresAtMs = 2_000;
    assert.equal(await client.request({ method: "fixture.execute", payload: null }), null);
    assert.deepEqual(observedExpiries, [2_000]);
    assert.equal(calls, 1);
    now = 2_000;
    await assert.rejects(
      client.request({ method: "fixture.execute", payload: null }),
      hasCode("CAPABILITY_REVOKED"),
    );
    assert.equal(calls, 1);
    await client.close();
    await lease.dispose();
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("client cancellation aborts the bounded broker request without exposing payload", async () => {
  const root = await canonicalTemporaryDirectory("opendelegate-capability-cancel-");
  let observedAbort = false;
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: root,
    sourceCheckoutDirectory: process.cwd(),
  });
  try {
    const lease = await broker.register({
      capability: "fixture",
      binding,
      metadata: null,
      expiresAtMs: Date.now() + 60_000,
      currentBinding: () => binding,
      isExecutionCurrent: async () => true,
      handler: async (_request, context) =>
        await new Promise<null>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve(null);
            },
            { once: true },
          );
        }),
    });
    const client = await consumeRunCapabilityFile({
      filename: lease.capabilityFile,
      expectedCapability: "fixture",
    });
    const controller = new AbortController();
    const request = client.request({
      method: "fixture.wait",
      payload: { secret: "must-not-appear" },
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(request, hasCode("REQUEST_CANCELLED"));
    await waitUntil(() => observedAbort);
    await client.close();
    await lease.dispose();
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker restart invalidates copied capability material and descriptors are strict", async () => {
  const root = await canonicalTemporaryDirectory("opendelegate-capability-restart-");
  const broker = await LocalRunCapabilityBroker.listen({
    runtimeDirectory: root,
    sourceCheckoutDirectory: process.cwd(),
  });
  const lease = await broker.register({
    capability: "fixture",
    binding,
    metadata: null,
    expiresAtMs: Date.now() + 60_000,
    currentBinding: () => binding,
    isExecutionCurrent: async () => true,
    handler: async () => null,
  });
  const staleCopy = join(root, "stale.json");
  const malformedCopy = join(root, "malformed.json");
  await copyFile(lease.capabilityFile, staleCopy);
  const descriptor = JSON.parse(await readFile(lease.capabilityFile, "utf8")) as object;
  await writeFile(
    malformedCopy,
    JSON.stringify({ ...descriptor, unexpected: "must-be-rejected" }),
    { mode: 0o600 },
  );
  if (process.platform !== "win32") {
    await chmod(malformedCopy, 0o600);
  }
  try {
    await assert.rejects(
      consumeRunCapabilityFile({
        filename: malformedCopy,
        expectedCapability: "fixture",
      }),
      hasCode("FRAME_INVALID"),
    );
    await broker.close();
    await assert.rejects(
      consumeRunCapabilityFile({
        filename: staleCopy,
        expectedCapability: "fixture",
      }),
      hasCode("CONNECTION_FAILED"),
    );
  } finally {
    await lease.dispose();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime paths inside the source checkout and unprotected files are rejected", async () => {
  const insideCheckout = join(process.cwd(), ".unsafe-runtime");
  await assert.rejects(
    LocalRunCapabilityBroker.listen({
      runtimeDirectory: insideCheckout,
      sourceCheckoutDirectory: process.cwd(),
    }),
    hasCode("INVALID_CONFIGURATION"),
  );

  if (process.platform === "win32") {
    return;
  }
  const root = await canonicalTemporaryDirectory("opendelegate-capability-mode-");
  const filename = join(root, "capability.json");
  await writeFile(filename, "{}\n", { mode: 0o644 });
  await chmod(filename, 0o644);
  try {
    await assert.rejects(
      consumeRunCapabilityFile({ filename, expectedCapability: "fixture" }),
      hasCode("CAPABILITY_FILE_UNSAFE"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "short Unix state paths retain their protected in-place socket",
  { skip: process.platform === "win32" },
  async () => {
    const temporaryRoot = await realpath("/tmp");
    const runtimeDirectory = await mkdtemp(join(temporaryRoot, "odc-short-"));
    const broker = await LocalRunCapabilityBroker.listen({
      runtimeDirectory,
      sourceCheckoutDirectory: process.cwd(),
    });
    let endpointPath = "";
    try {
      const lease = await broker.register({
        capability: "fixture",
        binding,
        metadata: null,
        expiresAtMs: Date.now() + 60_000,
        currentBinding: () => binding,
        isExecutionCurrent: async () => true,
        handler: async () => null,
      });
      const descriptor = JSON.parse(await readFile(lease.capabilityFile, "utf8")) as {
        readonly endpoint: {
          readonly path: string;
        };
      };
      endpointPath = descriptor.endpoint.path;
      assert.equal(dirname(endpointPath), runtimeDirectory);
      assert.equal((await lstat(endpointPath)).mode & 0o077, 0);
    } finally {
      await broker.close();
      if (endpointPath !== "") {
        await assert.rejects(lstat(endpointPath), { code: "ENOENT" });
      }
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "long Unix state paths keep descriptors durable while using a short protected endpoint",
  { skip: process.platform === "win32" },
  async () => {
    const root = await canonicalTemporaryDirectory("opendelegate-capability-long-");
    const runtimeDirectory = join(root, "r".repeat(160));
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const broker = await LocalRunCapabilityBroker.listen({
      runtimeDirectory,
      sourceCheckoutDirectory: process.cwd(),
    });
    let endpointPath = "";
    let endpointDirectory = "";
    try {
      const lease = await broker.register({
        capability: "fixture",
        binding,
        metadata: null,
        expiresAtMs: Date.now() + 60_000,
        currentBinding: () => binding,
        isExecutionCurrent: async () => true,
        handler: async (request) => request.payload,
      });
      const descriptor = JSON.parse(await readFile(lease.capabilityFile, "utf8")) as {
        readonly endpoint: {
          readonly kind: string;
          readonly path: string;
        };
      };
      endpointPath = descriptor.endpoint.path;
      endpointDirectory = dirname(endpointPath);
      assert.equal(dirname(lease.capabilityFile), runtimeDirectory);
      assert.equal(descriptor.endpoint.kind, "unix-domain-socket");
      assert.ok(Buffer.byteLength(endpointPath, "utf8") <= 100);
      assert.notEqual(endpointDirectory, runtimeDirectory);
      assert.equal((await lstat(endpointDirectory)).mode & 0o077, 0);
      assert.equal((await lstat(endpointPath)).mode & 0o077, 0);

      const client = await consumeRunCapabilityFile({
        filename: lease.capabilityFile,
        expectedCapability: "fixture",
      });
      assert.deepEqual(
        await client.request({ method: "fixture.echo", payload: { value: "long-path" } }),
        { value: "long-path" },
      );
      await client.close();
    } finally {
      await broker.close();
      if (endpointPath !== "") {
        await assert.rejects(lstat(endpointPath), { code: "ENOENT" });
      }
      if (endpointDirectory !== "") {
        await assert.rejects(lstat(endpointDirectory), { code: "ENOENT" });
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a colliding Unix endpoint directory fails closed without deleting foreign state",
  { skip: process.platform === "win32" },
  async () => {
    const root = await canonicalTemporaryDirectory("opendelegate-capability-collision-");
    const runtimeDirectory = join(root, "r".repeat(160));
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const endpointId = `collision-${createHash("sha256")
      .update(runtimeDirectory, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    const endpointSlug = createHash("sha256").update(endpointId, "utf8").digest("hex").slice(0, 24);
    const temporaryRoot = await realpath("/tmp");
    const endpointDirectory = join(temporaryRoot, `odc-${endpointSlug}`);
    const marker = join(endpointDirectory, "foreign-state");
    await mkdir(endpointDirectory, { mode: 0o700 });
    await writeFile(marker, "preserve\n", { mode: 0o600 });
    try {
      await assert.rejects(
        LocalRunCapabilityBroker.listen({
          runtimeDirectory,
          sourceCheckoutDirectory: process.cwd(),
          idSource: { nextId: () => endpointId },
        }),
        hasCode("INVALID_CONFIGURATION"),
      );
      assert.equal(await readFile(marker, "utf8"), "preserve\n");
    } finally {
      await rm(endpointDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof RunCapabilityBrokerError &&
    error.code === code &&
    !error.message.includes("must-not-appear");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for the broker cancellation boundary.");
}

async function canonicalTemporaryDirectory(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}
