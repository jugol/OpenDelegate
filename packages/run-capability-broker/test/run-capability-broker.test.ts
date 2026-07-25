import assert from "node:assert/strict";
import { access, chmod, copyFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const root = await mkdtemp(join(tmpdir(), "opendelegate-capability-"));
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

test("a claimed capability follows renewed binding expiry and exact Run revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-capability-expiry-"));
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
  const root = await mkdtemp(join(tmpdir(), "opendelegate-capability-cancel-"));
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
  const root = await mkdtemp(join(tmpdir(), "opendelegate-capability-restart-"));
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
  const root = await mkdtemp(join(tmpdir(), "opendelegate-capability-mode-"));
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
