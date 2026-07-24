import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentAdapterError, FileSessionLeaseStore } from "../src/index.ts";

test("file lease store keeps one writer and monotonic fencing across store instances", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-agent-leases-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const statePath = join(directory, "native-session-leases.json");
  const firstStore = new FileSessionLeaseStore({ statePath });
  const first = await firstStore.acquire("task-a/worker", "run-1", 1_000, 10_000);

  const reopened = new FileSessionLeaseStore({ statePath });
  await assert.rejects(
    reopened.acquire("task-a/worker", "run-2", 1_000, 10_100),
    (error: unknown) => error instanceof AgentAdapterError && error.code === "NATIVE_SESSION_BUSY",
  );

  const renewed = await reopened.renew(first, 1_000, 10_200);
  assert.equal(renewed.fence, 1);
  assert.equal(renewed.expiresAt, 11_200);
  await reopened.release(renewed);

  const second = await firstStore.acquire("task-a/worker", "run-2", 1_000, 10_300);
  assert.equal(second.fence, 2);
  const afterExpiry = await reopened.acquire("task-a/worker", "run-3", 1_000, 11_301);
  assert.equal(afterExpiry.fence, 3);
  await assert.rejects(
    reopened.renew(afterExpiry, 1_000, 11_000),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "LEASE_CLOCK_REGRESSION",
  );

  const raw = await readFile(statePath, "utf8");
  assert.doesNotMatch(raw, /task-a\/worker/u);
  assert.match(raw, /"fence":3/u);
});

test("file lease store serializes concurrent acquisition and fails closed on corruption", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-agent-leases-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const statePath = join(directory, "native-session-leases.json");
  const left = new FileSessionLeaseStore({ statePath });
  const right = new FileSessionLeaseStore({ statePath });

  const outcomes = await Promise.allSettled([
    left.acquire("same-session", "run-left", 1_000, 20_000),
    right.acquire("same-session", "run-right", 1_000, 20_000),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof AgentAdapterError);
  assert.equal(rejected.reason.code, "NATIVE_SESSION_BUSY");

  await writeFile(statePath, '{"schemaVersion":1,"records":{"bad":"state"}}', "utf8");
  const corrupt = new FileSessionLeaseStore({ statePath });
  await assert.rejects(
    corrupt.acquire("another-session", "run-3", 1_000, 21_000),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "SESSION_LEASE_STORE_CORRUPT",
  );

  await writeFile(
    statePath,
    '{"schemaVersion":1,"records":{"__proto__":{"fence":1,"lastObservedAt":21000}}}',
    "utf8",
  );
  assert.equal(Object.hasOwn(Object.prototype, "fence"), false);
  await assert.rejects(
    corrupt.acquire("another-session", "run-3", 1_000, 21_000),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "SESSION_LEASE_STORE_CORRUPT",
  );
  assert.equal(Object.hasOwn(Object.prototype, "fence"), false);
});

test("file lease store elects one recovery leader before removing an abandoned lock", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-agent-leases-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const statePath = join(directory, "native-session-leases.json");
  const lockPath = `${statePath}.mutation.lock`;
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: 2_147_483_647,
      token: randomUUID(),
      createdAt: Date.now() - 60_000,
    }),
    { encoding: "utf8", mode: 0o600 },
  );

  const left = new FileSessionLeaseStore({ statePath });
  const right = new FileSessionLeaseStore({ statePath });
  const outcomes = await Promise.allSettled([
    left.acquire("recovered-session", "run-left", 1_000, 30_000),
    right.acquire("recovered-session", "run-right", 1_000, 30_000),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof AgentAdapterError);
  assert.equal(rejected.reason.code, "NATIVE_SESSION_BUSY");
  await assert.rejects(
    lstat(lockPath),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("file lease store never auto-deletes malformed or uncertain recovery locks", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-agent-leases-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const statePath = join(directory, "native-session-leases.json");
  const lockPath = `${statePath}.mutation.lock`;
  const malformed = '{"pid":"not-a-process"}';
  await writeFile(lockPath, malformed, { encoding: "utf8", mode: 0o600 });
  await utimes(lockPath, new Date(0), new Date(0));

  const store = new FileSessionLeaseStore({
    statePath,
    mutationTimeoutMs: 50,
    staleMutationLockMs: 1,
  });
  await assert.rejects(
    store.acquire("malformed-lock", "run-1", 1_000, 40_000),
    (error: unknown) =>
      error instanceof AgentAdapterError &&
      error.code === "SESSION_LEASE_STORE_LOCK_CORRUPT" &&
      error.retryable === false,
  );
  assert.equal(await readFile(lockPath, "utf8"), malformed);

  const recoveryBytes = JSON.stringify({
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  });
  const primaryBytes = JSON.stringify({
    pid: 2_147_483_647,
    token: randomUUID(),
    createdAt: Date.now() - 60_000,
  });
  await writeFile(`${lockPath}.recovery`, recoveryBytes, { encoding: "utf8", mode: 0o600 });
  await writeFile(lockPath, primaryBytes, "utf8");
  await assert.rejects(
    store.acquire("uncertain-recovery", "run-2", 1_000, 40_100),
    (error: unknown) =>
      error instanceof AgentAdapterError &&
      error.code === "SESSION_LEASE_STORE_BUSY" &&
      error.retryable,
  );
  assert.equal(await readFile(lockPath, "utf8"), primaryBytes);
  assert.equal(await readFile(`${lockPath}.recovery`, "utf8"), recoveryBytes);
});

test("file lease store preserves a lock when process liveness is uncertain", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-agent-leases-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const statePath = join(directory, "native-session-leases.json");
  const lockPath = `${statePath}.mutation.lock`;
  const primaryBytes = JSON.stringify({
    pid: 2_147_483_647,
    token: randomUUID(),
    createdAt: Date.now() - 60_000,
  });
  await writeFile(lockPath, primaryBytes, { encoding: "utf8", mode: 0o600 });
  context.mock.method(
    process,
    "kill",
    function uncertainProcessProbe(_pid: number, _signal?: NodeJS.Signals | number): true {
      throw Object.assign(new Error("The process probe is unavailable."), { code: "EACCES" });
    },
  );

  const store = new FileSessionLeaseStore({
    statePath,
    mutationTimeoutMs: 25,
    staleMutationLockMs: 1,
  });
  await assert.rejects(
    store.acquire("unknown-process", "run-1", 1_000, 50_000),
    (error: unknown) =>
      error instanceof AgentAdapterError &&
      error.code === "SESSION_LEASE_STORE_BUSY" &&
      error.retryable,
  );
  assert.equal(await readFile(lockPath, "utf8"), primaryBytes);
});

test("stale recovery never deletes a replacement lock created by a new owner", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-agent-leases-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const statePath = join(directory, "native-session-leases.json");
  const lockPath = `${statePath}.mutation.lock`;
  const staleBytes = JSON.stringify({
    pid: 2_147_483_647,
    token: randomUUID(),
    createdAt: Date.now() - 60_000,
  });
  const replacementBytes = JSON.stringify({
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  });
  await writeFile(lockPath, staleBytes, { encoding: "utf8", mode: 0o600 });

  let probes = 0;
  context.mock.method(
    process,
    "kill",
    function replaceBetweenProbeAndDelete(_pid: number, _signal?: NodeJS.Signals | number): true {
      probes += 1;
      if (probes === 1) {
        unlinkSync(lockPath);
        writeFileSync(lockPath, replacementBytes, { encoding: "utf8", mode: 0o600 });
        throw Object.assign(new Error("The stale owner exited."), { code: "ESRCH" });
      }
      return true;
    },
  );

  const store = new FileSessionLeaseStore({
    statePath,
    mutationTimeoutMs: 25,
    staleMutationLockMs: 1,
  });
  await assert.rejects(
    store.acquire("replacement-race", "run-1", 1_000, 60_000),
    (error: unknown) =>
      error instanceof AgentAdapterError &&
      error.code === "SESSION_LEASE_STORE_BUSY" &&
      error.retryable,
  );
  assert.ok(probes >= 2);
  assert.equal(await readFile(lockPath, "utf8"), replacementBytes);
});
