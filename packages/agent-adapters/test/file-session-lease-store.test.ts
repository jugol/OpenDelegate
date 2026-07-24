import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
