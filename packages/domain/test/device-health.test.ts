import assert from "node:assert/strict";
import test from "node:test";

import { DeviceHealth, DeviceId, DomainError } from "../src/index.ts";

test("Device health separates daemon connectivity from desktop readiness", () => {
  const health = DeviceHealth.create({
    deviceId: DeviceId.from("device-linux-nas"),
    sequence: 1,
    observedAtMs: 1_000,
    connection: "online",
    desktop: {
      state: "no-session",
      reason: "headless device",
    },
    load: {
      activeRuns: 0,
      runCapacity: 4,
      heldResourceLocks: [],
    },
  });

  assert.equal(health.eligibleForNewWork, true);
  assert.deepEqual(health.snapshot.desktop, {
    state: "no-session",
    reason: "headless device",
  });
  assert.equal(health.snapshot.connection, "online");
  assert.equal(Object.isFrozen(health.snapshot), true);
  assert.equal(Object.isFrozen(health.snapshot.desktop), true);
  assert.equal(Object.isFrozen(health.snapshot.load.heldResourceLocks), true);
});

test("stale Device reports cannot overwrite current health and draining stops new assignment", () => {
  const health = DeviceHealth.create({
    deviceId: DeviceId.from("device-windows"),
    sequence: 4,
    observedAtMs: 4_000,
    connection: "online",
    desktop: { state: "ready" },
    load: {
      activeRuns: 1,
      runCapacity: 4,
      heldResourceLocks: ["desktop-session"],
    },
  });

  health.drain("owner maintenance");
  assert.equal(health.eligibleForNewWork, false);
  assert.equal(health.snapshot.operationalState, "draining");

  assert.throws(
    () =>
      health.recordReport({
        sequence: 3,
        observedAtMs: 3_000,
        connection: "online",
        desktop: { state: "ready" },
        load: {
          activeRuns: 0,
          runCapacity: 4,
          heldResourceLocks: [],
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "DEVICE_HEALTH_REPORT_STALE");
      return true;
    },
  );
  assert.equal(health.snapshot.sequence, 4);
});

test("revocation is terminal even if a later heartbeat arrives", () => {
  const health = DeviceHealth.create({
    deviceId: DeviceId.from("device-lost"),
    sequence: 1,
    observedAtMs: 1_000,
    connection: "offline",
    desktop: { state: "unavailable" },
    load: {
      activeRuns: 0,
      runCapacity: 1,
      heldResourceLocks: [],
    },
  });
  health.revoke("device lost");

  assert.throws(
    () =>
      health.recordReport({
        sequence: 2,
        observedAtMs: 2_000,
        connection: "online",
        desktop: { state: "ready" },
        load: {
          activeRuns: 0,
          runCapacity: 1,
          heldResourceLocks: [],
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "DEVICE_OPERATION_TRANSITION_INVALID");
      return true;
    },
  );
  assert.equal(health.snapshot.operationalState, "revoked");
});

test("Device health rejects non-finite or internally impossible load reports", () => {
  const createInvalid = (activeRuns: number, runCapacity: number) =>
    DeviceHealth.create({
      deviceId: DeviceId.from("device-invalid-load"),
      sequence: 1,
      observedAtMs: 1_000,
      connection: "online",
      desktop: { state: "ready" },
      load: {
        activeRuns,
        runCapacity,
        heldResourceLocks: [],
      },
    });

  for (const input of [
    () => createInvalid(Number.NaN, 1),
    () => createInvalid(0, Number.POSITIVE_INFINITY),
    () => createInvalid(2, 1),
    () =>
      DeviceHealth.create({
        deviceId: DeviceId.from("device-invalid-sequence"),
        sequence: Number.NaN,
        observedAtMs: 1_000,
        connection: "online",
        desktop: { state: "ready" },
        load: { activeRuns: 0, runCapacity: 1, heldResourceLocks: [] },
      }),
  ]) {
    assert.throws(input, (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "DEVICE_HEALTH_REPORT_INVALID");
      return true;
    });
  }
});
