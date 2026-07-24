import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_SESSION_RESOURCE, ResourceLockError, ResourceLockKernel } from "../src/index.ts";

class FakeClock {
  private currentTimeMs: number;

  public constructor(currentTimeMs: number) {
    this.currentTimeMs = currentTimeMs;
  }

  public now(): number {
    return this.currentTimeMs;
  }

  public advanceBy(durationMs: number): void {
    this.currentTimeMs += durationMs;
  }

  public set(currentTimeMs: number): void {
    this.currentTimeMs = currentTimeMs;
  }
}

test("desktop-session denies a competitor until expiry and then issues a higher fencing token", () => {
  const clock = new FakeClock(1_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });

  const firstLease = locks.acquire({
    commandId: "acquire-desktop-run-1",
    resourceName: "desktop-session",
    holderId: "run-1",
    leaseDurationMs: 100,
  });

  assert.deepEqual(firstLease, {
    resourceName: "desktop-session",
    holderId: "run-1",
    fencingToken: 1,
    acquiredAtMs: 1_000,
    expiresAtMs: 1_100,
  });
  assert.throws(
    () =>
      locks.acquire({
        commandId: "acquire-desktop-run-2",
        resourceName: "desktop-session",
        holderId: "run-2",
        leaseDurationMs: 100,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ResourceLockError, true);
      assert.equal((error as ResourceLockError).code, "RESOURCE_CAPACITY_EXHAUSTED");
      return true;
    },
  );

  clock.advanceBy(100);

  assert.deepEqual(
    locks.acquire({
      commandId: "acquire-desktop-run-2-after-expiry",
      resourceName: "desktop-session",
      holderId: "run-2",
      leaseDurationMs: 100,
    }),
    {
      resourceName: "desktop-session",
      holderId: "run-2",
      fencingToken: 2,
      acquiredAtMs: 1_100,
      expiresAtMs: 1_200,
    },
  );
});

test("release requires the current holder and fencing token before freeing capacity", () => {
  const clock = new FakeClock(2_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const lease = locks.acquire({
    commandId: "acquire-release-owner",
    resourceName: "desktop-session",
    holderId: "run-owner",
    leaseDurationMs: 500,
  });

  assert.throws(
    () =>
      locks.release({
        resourceName: "desktop-session",
        holderId: "run-intruder",
        fencingToken: lease.fencingToken,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ResourceLockError, true);
      assert.equal((error as ResourceLockError).code, "LEASE_HOLDER_MISMATCH");
      return true;
    },
  );

  locks.release({
    resourceName: "desktop-session",
    holderId: "run-owner",
    fencingToken: lease.fencingToken,
  });

  assert.equal(
    locks.acquire({
      commandId: "acquire-after-release",
      resourceName: "desktop-session",
      holderId: "run-next",
      leaseDurationMs: 500,
    }).fencingToken,
    2,
  );
});

test("renew keeps the current fence and extends expiry from the injected clock", () => {
  const clock = new FakeClock(3_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const lease = locks.acquire({
    commandId: "acquire-renew-owner",
    resourceName: "desktop-session",
    holderId: "run-owner",
    leaseDurationMs: 100,
  });

  clock.advanceBy(80);

  assert.deepEqual(
    locks.renew({
      commandId: "renew-desktop-run-owner-1",
      resourceName: "desktop-session",
      holderId: "run-owner",
      fencingToken: lease.fencingToken,
      leaseDurationMs: 200,
    }),
    {
      resourceName: "desktop-session",
      holderId: "run-owner",
      fencingToken: 1,
      acquiredAtMs: 3_000,
      expiresAtMs: 3_280,
    },
  );

  clock.advanceBy(20);

  assert.throws(
    () =>
      locks.acquire({
        commandId: "acquire-at-original-expiry",
        resourceName: "desktop-session",
        holderId: "run-competitor",
        leaseDurationMs: 100,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ResourceLockError, true);
      assert.equal((error as ResourceLockError).code, "RESOURCE_CAPACITY_EXHAUSTED");
      return true;
    },
  );

  clock.advanceBy(180);

  assert.equal(
    locks.acquire({
      commandId: "acquire-after-renewed-expiry",
      resourceName: "desktop-session",
      holderId: "run-competitor",
      leaseDurationMs: 100,
    }).fencingToken,
    2,
  );
});

test("an exact renewal command replay returns its original outcome without extending the lease again", () => {
  const clock = new FakeClock(3_500);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const lease = locks.acquire({
    commandId: "acquire-renew-replay-owner",
    resourceName: "desktop-session",
    holderId: "run-renew-replay-owner",
    leaseDurationMs: 500,
  });
  const command = {
    commandId: "renew-desktop-run-renew-replay-owner-1",
    resourceName: lease.resourceName,
    holderId: lease.holderId,
    fencingToken: lease.fencingToken,
    leaseDurationMs: 200,
  } as const;

  clock.advanceBy(50);
  const originalOutcome = locks.renew(command);
  clock.advanceBy(100);

  assert.deepEqual(locks.renew(command), originalOutcome);
  assert.deepEqual(locks.snapshot().leaseRenewals, [
    {
      renewalSequence: 1,
      input: command,
      renewedAtMs: 3_550,
      previousExpiresAtMs: 4_000,
      lease: originalOutcome,
    },
  ]);
});

test("snapshot restore preserves renewal-command replay after its lease expires", () => {
  const clock = new FakeClock(4_000);
  const original = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const lease = original.acquire({
    commandId: "acquire-renew-restart-replay-owner",
    resourceName: "desktop-session",
    holderId: "run-renew-restart-replay-owner",
    leaseDurationMs: 100,
  });
  const command = {
    commandId: "renew-desktop-run-renew-restart-replay-owner-1",
    resourceName: lease.resourceName,
    holderId: lease.holderId,
    fencingToken: lease.fencingToken,
    leaseDurationMs: 500,
  } as const;

  clock.advanceBy(50);
  const originalOutcome = original.renew(command);
  const restored = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
    restoreFrom: original.snapshot(),
  });

  clock.advanceBy(500);

  assert.deepEqual(restored.renew(command), originalOutcome);
  const replayedSnapshot = restored.snapshot();
  assert.equal(replayedSnapshot.leaseRenewals.length, 1);
  assert.deepEqual(replayedSnapshot.resources[0]?.activeLeases, []);
});

test("a restored renewal command rejects conflicting input without mutating its history", () => {
  const clock = new FakeClock(4_750);
  const original = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const lease = original.acquire({
    commandId: "acquire-renew-conflict-owner",
    resourceName: "desktop-session",
    holderId: "run-renew-conflict-owner",
    leaseDurationMs: 500,
  });
  const command = {
    commandId: "renew-desktop-run-renew-conflict-owner-1",
    resourceName: lease.resourceName,
    holderId: lease.holderId,
    fencingToken: lease.fencingToken,
    leaseDurationMs: 500,
  } as const;
  clock.advanceBy(50);
  original.renew(command);
  const restored = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
    restoreFrom: original.snapshot(),
  });

  assert.throws(
    () => restored.renew({ ...command, leaseDurationMs: 501 }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "RENEW_COMMAND_CONFLICT",
  );
  assert.equal(restored.snapshot().leaseRenewals.length, 1);
});

test("renewal-command replay still validates the monotonic clock", () => {
  const clock = new FakeClock(5_500);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const lease = locks.acquire({
    commandId: "acquire-renew-clock-owner",
    resourceName: "desktop-session",
    holderId: "run-renew-clock-owner",
    leaseDurationMs: 500,
  });
  const command = {
    commandId: "renew-desktop-run-renew-clock-owner-1",
    resourceName: lease.resourceName,
    holderId: lease.holderId,
    fencingToken: lease.fencingToken,
    leaseDurationMs: 500,
  } as const;
  locks.renew(command);
  clock.set(5_499);

  assert.throws(
    () => locks.renew(command),
    (error: unknown) => error instanceof ResourceLockError && error.code === "CLOCK_VALUE_INVALID",
  );
  clock.set(5_500);
  assert.equal(locks.snapshot().leaseRenewals.length, 1);
});

test("a configurable-capacity resource admits available holders and cancellation frees one slot", () => {
  const clock = new FakeClock(4_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [{ name: "gpu-compute", capacity: 2 }],
  });
  const firstLease = locks.acquire({
    commandId: "acquire-gpu-run-1",
    resourceName: "gpu-compute",
    holderId: "run-1",
    leaseDurationMs: 500,
  });
  locks.acquire({
    commandId: "acquire-gpu-run-2",
    resourceName: "gpu-compute",
    holderId: "run-2",
    leaseDurationMs: 500,
  });

  assert.throws(
    () =>
      locks.acquire({
        commandId: "acquire-gpu-run-3-before-cancel",
        resourceName: "gpu-compute",
        holderId: "run-3",
        leaseDurationMs: 500,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ResourceLockError, true);
      assert.equal((error as ResourceLockError).code, "RESOURCE_CAPACITY_EXHAUSTED");
      return true;
    },
  );

  locks.cancel({
    resourceName: "gpu-compute",
    holderId: "run-1",
    fencingToken: firstLease.fencingToken,
  });

  assert.equal(
    locks.acquire({
      commandId: "acquire-gpu-run-3-after-cancel",
      resourceName: "gpu-compute",
      holderId: "run-3",
      leaseDurationMs: 500,
    }).fencingToken,
    3,
  );
});

test("replaying an acquire command returns its original lease without consuming capacity or a fence", () => {
  const clock = new FakeClock(5_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [{ name: "agent-slot", capacity: 2 }],
  });
  const command = {
    commandId: "acquire-agent-run-1",
    resourceName: "agent-slot",
    holderId: "run-1",
    leaseDurationMs: 500,
  };
  const firstLease = locks.acquire(command);

  clock.advanceBy(25);

  assert.deepEqual(locks.acquire(command), firstLease);
  assert.equal(
    locks.acquire({
      commandId: "acquire-agent-run-2",
      resourceName: "agent-slot",
      holderId: "run-2",
      leaseDurationMs: 500,
    }).fencingToken,
    2,
  );
});

test("snapshots are deterministically ordered and omit leases expired at the observed time", () => {
  const clock = new FakeClock(6_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [{ name: "gpu-compute", capacity: 2 }, DESKTOP_SESSION_RESOURCE],
  });
  locks.acquire({
    commandId: "acquire-desktop-for-snapshot",
    resourceName: "desktop-session",
    holderId: "run-desktop",
    leaseDurationMs: 50,
  });
  locks.acquire({
    commandId: "acquire-gpu-z-for-snapshot",
    resourceName: "gpu-compute",
    holderId: "run-z",
    leaseDurationMs: 100,
  });
  locks.acquire({
    commandId: "acquire-gpu-a-for-snapshot",
    resourceName: "gpu-compute",
    holderId: "run-a",
    leaseDurationMs: 100,
  });

  clock.advanceBy(50);

  const expectedSnapshot = {
    observedAtMs: 6_050,
    resources: [
      {
        resourceName: "desktop-session",
        capacity: 1,
        lastIssuedFencingToken: 1,
        activeLeases: [],
      },
      {
        resourceName: "gpu-compute",
        capacity: 2,
        lastIssuedFencingToken: 2,
        activeLeases: [
          {
            resourceName: "gpu-compute",
            holderId: "run-z",
            fencingToken: 1,
            acquiredAtMs: 6_000,
            expiresAtMs: 6_100,
          },
          {
            resourceName: "gpu-compute",
            holderId: "run-a",
            fencingToken: 2,
            acquiredAtMs: 6_000,
            expiresAtMs: 6_100,
          },
        ],
      },
    ],
    acquireCommands: [
      {
        input: {
          commandId: "acquire-desktop-for-snapshot",
          resourceName: "desktop-session",
          holderId: "run-desktop",
          leaseDurationMs: 50,
        },
        lease: {
          resourceName: "desktop-session",
          holderId: "run-desktop",
          fencingToken: 1,
          acquiredAtMs: 6_000,
          expiresAtMs: 6_050,
        },
      },
      {
        input: {
          commandId: "acquire-gpu-a-for-snapshot",
          resourceName: "gpu-compute",
          holderId: "run-a",
          leaseDurationMs: 100,
        },
        lease: {
          resourceName: "gpu-compute",
          holderId: "run-a",
          fencingToken: 2,
          acquiredAtMs: 6_000,
          expiresAtMs: 6_100,
        },
      },
      {
        input: {
          commandId: "acquire-gpu-z-for-snapshot",
          resourceName: "gpu-compute",
          holderId: "run-z",
          leaseDurationMs: 100,
        },
        lease: {
          resourceName: "gpu-compute",
          holderId: "run-z",
          fencingToken: 1,
          acquiredAtMs: 6_000,
          expiresAtMs: 6_100,
        },
      },
    ],
    leaseRenewals: [],
  };

  assert.deepEqual(locks.snapshot(), expectedSnapshot);
  assert.deepEqual(locks.snapshot(), expectedSnapshot);
});

test("renew, release, and cancellation reject a stale fencing token after lease reclamation", () => {
  const clock = new FakeClock(7_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const staleLease = locks.acquire({
    commandId: "acquire-stale-owner",
    resourceName: "desktop-session",
    holderId: "run-stale",
    leaseDurationMs: 10,
  });

  clock.advanceBy(10);

  const currentLease = locks.acquire({
    commandId: "acquire-current-owner",
    resourceName: "desktop-session",
    holderId: "run-current",
    leaseDurationMs: 100,
  });
  const staleMutation = {
    resourceName: "desktop-session",
    holderId: "run-stale",
    fencingToken: staleLease.fencingToken,
  };

  for (const mutate of [
    () => locks.release(staleMutation),
    () => locks.cancel(staleMutation),
    () =>
      locks.renew({
        commandId: "renew-desktop-stale-run-1",
        ...staleMutation,
        leaseDurationMs: 100,
      }),
  ]) {
    assert.throws(mutate, (error: unknown) => {
      assert.equal(error instanceof ResourceLockError, true);
      assert.equal((error as ResourceLockError).code, "STALE_FENCING_TOKEN");
      return true;
    });
  }

  assert.throws(
    () =>
      locks.renew({
        commandId: "renew-desktop-run-intruder-1",
        resourceName: "desktop-session",
        holderId: "run-intruder",
        fencingToken: currentLease.fencingToken,
        leaseDurationMs: 100,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ResourceLockError, true);
      assert.equal((error as ResourceLockError).code, "LEASE_HOLDER_MISMATCH");
      return true;
    },
  );
});

test("an acquire command ID cannot be reused with different input", () => {
  const locks = new ResourceLockKernel({
    clock: new FakeClock(8_000),
    resources: [{ name: "agent-slot", capacity: 2 }],
  });
  locks.acquire({
    commandId: "acquire-conflict",
    resourceName: "agent-slot",
    holderId: "run-1",
    leaseDurationMs: 100,
  });

  assert.throws(
    () =>
      locks.acquire({
        commandId: "acquire-conflict",
        resourceName: "agent-slot",
        holderId: "run-2",
        leaseDurationMs: 100,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ResourceLockError, true);
      assert.equal((error as ResourceLockError).code, "ACQUIRE_COMMAND_CONFLICT");
      return true;
    },
  );
});

test("resource definitions reject duplicates, blank names, and invalid capacities", () => {
  const cases = [
    {
      resources: [
        { name: "gpu-compute", capacity: 1 },
        { name: "gpu-compute", capacity: 2 },
      ],
      code: "RESOURCE_DEFINITION_DUPLICATED",
    },
    {
      resources: [{ name: " ", capacity: 1 }],
      code: "RESOURCE_DEFINITION_INVALID",
    },
    {
      resources: [{ name: "gpu-compute", capacity: 0 }],
      code: "RESOURCE_DEFINITION_INVALID",
    },
    {
      resources: [{ name: "gpu-compute", capacity: 1.5 }],
      code: "RESOURCE_DEFINITION_INVALID",
    },
    {
      resources: [{ name: "gpu-compute", capacity: Number.POSITIVE_INFINITY }],
      code: "RESOURCE_DEFINITION_INVALID",
    },
    {
      resources: [{ name: "gpu-compute", capacity: Number.MAX_SAFE_INTEGER + 1 }],
      code: "RESOURCE_DEFINITION_INVALID",
    },
  ] as const;

  for (const fixture of cases) {
    assert.throws(
      () =>
        new ResourceLockKernel({
          clock: new FakeClock(9_000),
          resources: fixture.resources,
        }),
      (error: unknown) => {
        assert.equal(error instanceof ResourceLockError, true);
        assert.equal((error as ResourceLockError).code, fixture.code);
        return true;
      },
    );
  }
});

test("acquire rejects blank identifiers and invalid lease durations", () => {
  const locks = new ResourceLockKernel({
    clock: new FakeClock(10_000),
    resources: [{ name: "agent-slot", capacity: 1 }],
  });
  const cases = [
    {
      input: {
        commandId: " ",
        resourceName: "agent-slot",
        holderId: "run-1",
        leaseDurationMs: 100,
      },
      code: "RESOURCE_IDENTIFIER_INVALID",
    },
    {
      input: {
        commandId: "acquire-blank-resource",
        resourceName: "\t",
        holderId: "run-1",
        leaseDurationMs: 100,
      },
      code: "RESOURCE_IDENTIFIER_INVALID",
    },
    {
      input: {
        commandId: "acquire-blank-holder",
        resourceName: "agent-slot",
        holderId: "\n",
        leaseDurationMs: 100,
      },
      code: "RESOURCE_IDENTIFIER_INVALID",
    },
    {
      input: {
        commandId: "acquire-zero-duration",
        resourceName: "agent-slot",
        holderId: "run-1",
        leaseDurationMs: 0,
      },
      code: "LEASE_DURATION_INVALID",
    },
    {
      input: {
        commandId: "acquire-fractional-duration",
        resourceName: "agent-slot",
        holderId: "run-1",
        leaseDurationMs: 1.5,
      },
      code: "LEASE_DURATION_INVALID",
    },
    {
      input: {
        commandId: "acquire-infinite-duration",
        resourceName: "agent-slot",
        holderId: "run-1",
        leaseDurationMs: Number.POSITIVE_INFINITY,
      },
      code: "LEASE_DURATION_INVALID",
    },
    {
      input: {
        commandId: "acquire-unsafe-duration",
        resourceName: "agent-slot",
        holderId: "run-1",
        leaseDurationMs: Number.MAX_SAFE_INTEGER + 1,
      },
      code: "LEASE_DURATION_INVALID",
    },
  ] as const;

  for (const fixture of cases) {
    assert.throws(
      () => locks.acquire(fixture.input),
      (error: unknown) => {
        assert.equal(error instanceof ResourceLockError, true);
        assert.equal((error as ResourceLockError).code, fixture.code);
        return true;
      },
    );
  }
});

test("lease mutations reject blank identifiers and invalid renewal durations", () => {
  const locks = new ResourceLockKernel({
    clock: new FakeClock(11_000),
    resources: [{ name: "agent-slot", capacity: 1 }],
  });
  const lease = locks.acquire({
    commandId: "acquire-for-mutation-validation",
    resourceName: "agent-slot",
    holderId: "run-1",
    leaseDurationMs: 100,
  });

  for (const mutation of [
    {
      resourceName: " ",
      holderId: lease.holderId,
      fencingToken: lease.fencingToken,
    },
    {
      resourceName: lease.resourceName,
      holderId: "\t",
      fencingToken: lease.fencingToken,
    },
  ]) {
    assert.throws(
      () => locks.release(mutation),
      (error: unknown) =>
        error instanceof ResourceLockError && error.code === "RESOURCE_IDENTIFIER_INVALID",
    );
  }

  for (const leaseDurationMs of [0, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        locks.renew({
          commandId: `renew-desktop-invalid-duration-${String(leaseDurationMs)}`,
          resourceName: lease.resourceName,
          holderId: lease.holderId,
          fencingToken: lease.fencingToken,
          leaseDurationMs,
        }),
      (error: unknown) =>
        error instanceof ResourceLockError && error.code === "LEASE_DURATION_INVALID",
    );
  }

  assert.throws(
    () =>
      locks.renew({
        commandId: " ",
        resourceName: lease.resourceName,
        holderId: lease.holderId,
        fencingToken: lease.fencingToken,
        leaseDurationMs: 100,
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "RESOURCE_IDENTIFIER_INVALID",
  );
});

test("acquire rejects invalid clock values and lease-expiry overflow without issuing a fence", () => {
  for (const nowMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const locks = new ResourceLockKernel({
      clock: new FakeClock(nowMs),
      resources: [{ name: "agent-slot", capacity: 1 }],
    });

    assert.throws(
      () =>
        locks.acquire({
          commandId: `acquire-at-${String(nowMs)}`,
          resourceName: "agent-slot",
          holderId: "run-1",
          leaseDurationMs: 100,
        }),
      (error: unknown) =>
        error instanceof ResourceLockError && error.code === "CLOCK_VALUE_INVALID",
    );
  }

  const clock = new FakeClock(Number.MAX_SAFE_INTEGER - 5);
  const locks = new ResourceLockKernel({
    clock,
    resources: [{ name: "agent-slot", capacity: 1 }],
  });

  assert.throws(
    () =>
      locks.acquire({
        commandId: "acquire-overflow",
        resourceName: "agent-slot",
        holderId: "run-1",
        leaseDurationMs: 10,
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "LEASE_EXPIRY_OVERFLOW",
  );

  assert.equal(
    locks.acquire({
      commandId: "acquire-after-overflow",
      resourceName: "agent-slot",
      holderId: "run-1",
      leaseDurationMs: 5,
    }).fencingToken,
    1,
  );
});

test("renew rejects invalid clock values and expiry overflow without changing the lease", () => {
  const clock = new FakeClock(13_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [{ name: "agent-slot", capacity: 1 }],
  });
  const lease = locks.acquire({
    commandId: "acquire-for-renew-clock-validation",
    resourceName: "agent-slot",
    holderId: "run-1",
    leaseDurationMs: 1_000,
  });

  for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    clock.set(nowMs);
    assert.throws(
      () =>
        locks.renew({
          commandId: `renew-desktop-invalid-clock-${String(nowMs)}`,
          resourceName: lease.resourceName,
          holderId: lease.holderId,
          fencingToken: lease.fencingToken,
          leaseDurationMs: 100,
        }),
      (error: unknown) =>
        error instanceof ResourceLockError && error.code === "CLOCK_VALUE_INVALID",
    );
  }

  const overflowClock = new FakeClock(Number.MAX_SAFE_INTEGER - 100);
  const overflowLocks = new ResourceLockKernel({
    clock: overflowClock,
    resources: [{ name: "agent-slot", capacity: 1 }],
  });
  const overflowLease = overflowLocks.acquire({
    commandId: "acquire-for-renew-overflow",
    resourceName: "agent-slot",
    holderId: "run-1",
    leaseDurationMs: 50,
  });

  assert.throws(
    () =>
      overflowLocks.renew({
        commandId: "renew-desktop-expiry-overflow-1",
        resourceName: overflowLease.resourceName,
        holderId: overflowLease.holderId,
        fencingToken: overflowLease.fencingToken,
        leaseDurationMs: 200,
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "LEASE_EXPIRY_OVERFLOW",
  );
  assert.deepEqual(overflowLocks.snapshot().resources[0]?.activeLeases, [overflowLease]);
});

test("snapshot rejects non-finite and unsafe injected-clock values", () => {
  const clock = new FakeClock(14_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });

  for (const nowMs of [Number.NaN, Number.NEGATIVE_INFINITY, Number.MIN_SAFE_INTEGER - 1]) {
    clock.set(nowMs);
    assert.throws(
      () => locks.snapshot(),
      (error: unknown) =>
        error instanceof ResourceLockError && error.code === "CLOCK_VALUE_INVALID",
    );
  }
});

test("operations reject a regressed clock and cannot reanimate an expired lease", () => {
  const clock = new FakeClock(14_500);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const lease = locks.acquire({
    commandId: "acquire-before-clock-regression",
    resourceName: "desktop-session",
    holderId: "run-before-clock-regression",
    leaseDurationMs: 100,
  });

  clock.set(14_600);
  assert.deepEqual(locks.snapshot().resources[0]?.activeLeases, []);
  clock.set(14_550);

  const regressedOperations = [
    () => locks.snapshot(),
    () =>
      locks.acquire({
        commandId: "acquire-during-clock-regression",
        resourceName: "desktop-session",
        holderId: "run-during-clock-regression",
        leaseDurationMs: 100,
      }),
    () => locks.release(lease),
    () =>
      locks.renew({
        commandId: "renew-desktop-during-clock-regression-1",
        ...lease,
        leaseDurationMs: 100,
      }),
  ];
  for (const operation of regressedOperations) {
    assert.throws(
      operation,
      (error: unknown) =>
        error instanceof ResourceLockError && error.code === "CLOCK_VALUE_INVALID",
    );
  }

  clock.set(14_600);
  assert.deepEqual(locks.snapshot(), {
    observedAtMs: 14_600,
    resources: [
      {
        resourceName: "desktop-session",
        capacity: 1,
        lastIssuedFencingToken: 1,
        activeLeases: [],
      },
    ],
    acquireCommands: [
      {
        input: {
          commandId: "acquire-before-clock-regression",
          resourceName: "desktop-session",
          holderId: "run-before-clock-regression",
          leaseDurationMs: 100,
        },
        lease: {
          resourceName: "desktop-session",
          holderId: "run-before-clock-regression",
          fencingToken: 1,
          acquiredAtMs: 14_500,
          expiresAtMs: 14_600,
        },
      },
    ],
    leaseRenewals: [],
  });
});

test("an acquire replay still rejects an invalid injected-clock value", () => {
  const clock = new FakeClock(15_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [{ name: "agent-slot", capacity: 1 }],
  });
  const command = {
    commandId: "acquire-before-clock-failure",
    resourceName: "agent-slot",
    holderId: "run-1",
    leaseDurationMs: 100,
  } as const;
  locks.acquire(command);
  clock.set(Number.NaN);

  assert.throws(
    () => locks.acquire(command),
    (error: unknown) => error instanceof ResourceLockError && error.code === "CLOCK_VALUE_INVALID",
  );
});

test("release rejects an invalid injected-clock value without deleting the lease", () => {
  const clock = new FakeClock(16_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const lease = locks.acquire({
    commandId: "acquire-before-release-clock-failure",
    resourceName: "desktop-session",
    holderId: "run-1",
    leaseDurationMs: 100,
  });
  clock.set(Number.NaN);

  assert.throws(
    () =>
      locks.release({
        resourceName: lease.resourceName,
        holderId: lease.holderId,
        fencingToken: lease.fencingToken,
      }),
    (error: unknown) => error instanceof ResourceLockError && error.code === "CLOCK_VALUE_INVALID",
  );

  clock.set(16_001);
  assert.deepEqual(locks.snapshot().resources[0]?.activeLeases, [lease]);
});

test("snapshot restore rejects a clock observation behind the snapshot baseline", () => {
  const sourceClock = new FakeClock(19_000);
  const source = new ResourceLockKernel({
    clock: sourceClock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  source.acquire({
    commandId: "acquire-before-regressed-restore",
    resourceName: "desktop-session",
    holderId: "run-before-regressed-restore",
    leaseDurationMs: 100,
  });
  const snapshot = source.snapshot();

  assert.throws(
    () =>
      new ResourceLockKernel({
        clock: new FakeClock(18_999),
        resources: [DESKTOP_SESSION_RESOURCE],
        restoreFrom: snapshot,
      }),
    (error: unknown) => error instanceof ResourceLockError && error.code === "CLOCK_VALUE_INVALID",
  );
});

test("restoring a snapshot preserves active leases and never reissues an old fence", () => {
  const clock = new FakeClock(20_000);
  const original = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  original.acquire({
    commandId: "acquire-before-restart",
    resourceName: "desktop-session",
    holderId: "run-before-restart",
    leaseDurationMs: 100,
  });

  const restored = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
    restoreFrom: original.snapshot(),
  });

  assert.throws(
    () =>
      restored.acquire({
        commandId: "acquire-while-restored-lease-active",
        resourceName: "desktop-session",
        holderId: "run-after-restart",
        leaseDurationMs: 100,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ResourceLockError, true);
      assert.equal((error as ResourceLockError).code, "RESOURCE_CAPACITY_EXHAUSTED");
      return true;
    },
  );

  clock.advanceBy(100);
  assert.equal(
    restored.acquire({
      commandId: "acquire-after-restored-expiry",
      resourceName: "desktop-session",
      holderId: "run-after-restart",
      leaseDurationMs: 100,
    }).fencingToken,
    2,
  );
});

test("snapshot restore preserves a legitimately renewed active lease", () => {
  const clock = new FakeClock(22_000);
  const original = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const acquired = original.acquire({
    commandId: "acquire-before-renewed-restart",
    resourceName: "desktop-session",
    holderId: "run-renewed-before-restart",
    leaseDurationMs: 100,
  });
  clock.advanceBy(50);
  const renewed = original.renew({
    commandId: "renew-desktop-before-renewed-restart-1",
    resourceName: acquired.resourceName,
    holderId: acquired.holderId,
    fencingToken: acquired.fencingToken,
    leaseDurationMs: 500,
  });

  const restored = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
    restoreFrom: original.snapshot(),
  });

  assert.deepEqual(restored.snapshot().resources[0]?.activeLeases, [renewed]);
  assert.throws(
    () =>
      restored.acquire({
        commandId: "acquire-while-renewed-lease-active",
        resourceName: "desktop-session",
        holderId: "run-after-renewed-restart",
        leaseDurationMs: 100,
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "RESOURCE_CAPACITY_EXHAUSTED",
  );
});

test("snapshot restore validates and continues a complete renewal chain", () => {
  const clock = new FakeClock(23_000);
  const original = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const acquired = original.acquire({
    commandId: "acquire-before-renewal-chain",
    resourceName: "desktop-session",
    holderId: "run-renewal-chain",
    leaseDurationMs: 100,
  });
  clock.advanceBy(25);
  original.renew({
    commandId: "renew-desktop-renewal-chain-1",
    ...acquired,
    leaseDurationMs: 200,
  });
  clock.advanceBy(25);
  const secondRenewal = original.renew({
    commandId: "renew-desktop-renewal-chain-2",
    ...acquired,
    leaseDurationMs: 300,
  });

  const restored = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
    restoreFrom: original.snapshot(),
  });
  assert.deepEqual(restored.snapshot().resources[0]?.activeLeases, [secondRenewal]);

  clock.advanceBy(25);
  restored.renew({
    commandId: "renew-desktop-renewal-chain-3",
    ...acquired,
    leaseDurationMs: 400,
  });
  assert.deepEqual(
    restored.snapshot().leaseRenewals.map((renewal) => renewal.renewalSequence),
    [1, 2, 3],
  );
});

test("snapshot restore rejects a malformed or discontinuous renewal chain", () => {
  const clock = new FakeClock(24_000);
  const original = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const acquired = original.acquire({
    commandId: "acquire-before-invalid-renewal-chain",
    resourceName: "desktop-session",
    holderId: "run-invalid-renewal-chain",
    leaseDurationMs: 100,
  });
  clock.advanceBy(50);
  original.renew({
    commandId: "renew-desktop-invalid-renewal-chain-1",
    ...acquired,
    leaseDurationMs: 500,
  });
  original.renew({
    commandId: "renew-desktop-invalid-renewal-chain-2",
    ...acquired,
    leaseDurationMs: 600,
  });
  const validSnapshot = original.snapshot();

  const invalidSnapshots = [
    {
      name: "non-contiguous sequence",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.leaseRenewals[0]!, { renewalSequence: 2 });
      },
    },
    {
      name: "wrong previous expiration",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.leaseRenewals[0]!, { previousExpiresAtMs: 24_099 });
      },
    },
    {
      name: "renewal at prior expiration",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.leaseRenewals[0]!, { renewedAtMs: 24_100 });
        Object.assign(snapshot.leaseRenewals[0]!.lease, { expiresAtMs: 24_600 });
        Object.assign(snapshot.resources[0]!.activeLeases[0]!, { expiresAtMs: 24_600 });
      },
    },
    {
      name: "outcome expiration",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.leaseRenewals[0]!.lease, { expiresAtMs: 24_551 });
        Object.assign(snapshot.resources[0]!.activeLeases[0]!, { expiresAtMs: 24_551 });
      },
    },
    {
      name: "blank renewal command ID",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.leaseRenewals[0]!.input, { commandId: " " });
      },
    },
    {
      name: "duplicate renewal command ID",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.leaseRenewals[1]!.input, {
          commandId: snapshot.leaseRenewals[0]!.input.commandId,
        });
      },
    },
  ] as const;

  for (const invalid of invalidSnapshots) {
    const snapshot = structuredClone(validSnapshot);
    invalid.mutate(snapshot);
    assert.throws(
      () =>
        new ResourceLockKernel({
          clock,
          resources: [DESKTOP_SESSION_RESOURCE],
          restoreFrom: snapshot,
        }),
      (error: unknown) =>
        error instanceof ResourceLockError && error.code === "RESOURCE_SNAPSHOT_INVALID",
      invalid.name,
    );
  }
});

test("snapshot restore preserves completed acquire-command idempotency", () => {
  for (const terminalState of ["expired", "released"] as const) {
    const clock = new FakeClock(25_000);
    const original = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
    });
    const command = {
      commandId: `acquire-before-${terminalState}-restart`,
      resourceName: "desktop-session",
      holderId: `run-before-${terminalState}-restart`,
      leaseDurationMs: 100,
    } as const;
    const originalLease = original.acquire(command);
    if (terminalState === "released") {
      original.release({
        resourceName: originalLease.resourceName,
        holderId: originalLease.holderId,
        fencingToken: originalLease.fencingToken,
      });
    } else {
      clock.advanceBy(100);
    }
    const restored = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
      restoreFrom: original.snapshot(),
    });

    assert.deepEqual(restored.acquire(command), originalLease);
    assert.throws(
      () =>
        restored.acquire({
          ...command,
          holderId: `conflicting-${command.holderId}`,
        }),
      (error: unknown) =>
        error instanceof ResourceLockError && error.code === "ACQUIRE_COMMAND_CONFLICT",
    );
    assert.equal(
      restored.acquire({
        commandId: `acquire-after-${terminalState}-restart`,
        resourceName: "desktop-session",
        holderId: `run-after-${terminalState}-restart`,
        leaseDurationMs: 100,
      }).fencingToken,
      2,
    );
  }
});

test("snapshot restore rejects expired leases and incomplete fencing histories", () => {
  const clock = new FakeClock(30_000);

  assert.throws(
    () =>
      new ResourceLockKernel({
        clock,
        resources: [DESKTOP_SESSION_RESOURCE],
        restoreFrom: {
          observedAtMs: 30_000,
          resources: [
            {
              resourceName: "desktop-session",
              capacity: 1,
              lastIssuedFencingToken: 1,
              activeLeases: [
                {
                  resourceName: "desktop-session",
                  holderId: "run-expired",
                  fencingToken: 1,
                  acquiredAtMs: 29_000,
                  expiresAtMs: 30_000,
                },
              ],
            },
          ],
          acquireCommands: [
            {
              input: {
                commandId: "acquire-expired",
                resourceName: "desktop-session",
                holderId: "run-expired",
                leaseDurationMs: 1_000,
              },
              lease: {
                resourceName: "desktop-session",
                holderId: "run-expired",
                fencingToken: 1,
                acquiredAtMs: 29_000,
                expiresAtMs: 30_000,
              },
            },
          ],
          leaseRenewals: [],
        },
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "RESOURCE_SNAPSHOT_INVALID",
  );

  assert.throws(
    () =>
      new ResourceLockKernel({
        clock,
        resources: [DESKTOP_SESSION_RESOURCE],
        restoreFrom: {
          observedAtMs: 30_000,
          resources: [
            {
              resourceName: "desktop-session",
              capacity: 1,
              lastIssuedFencingToken: Number.MAX_SAFE_INTEGER,
              activeLeases: [],
            },
          ],
          acquireCommands: [],
          leaseRenewals: [],
        },
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "RESOURCE_SNAPSHOT_INVALID",
  );
});

test("snapshot restore rejects fencing histories whose acquire clock moves backward", () => {
  const clock = new FakeClock(35_000);
  const capacityTwoResource = { name: "gpu-compute", capacity: 2 } as const;
  const commandForFence = (fencingToken: number, acquiredAtMs: number) => ({
    input: {
      commandId: `acquire-gpu-fence-${fencingToken}`,
      resourceName: "gpu-compute",
      holderId: `run-gpu-fence-${fencingToken}`,
      leaseDurationMs: 100,
    },
    lease: {
      resourceName: "gpu-compute",
      holderId: `run-gpu-fence-${fencingToken}`,
      fencingToken,
      acquiredAtMs,
      expiresAtMs: acquiredAtMs + 100,
    },
  });
  const snapshot = {
    observedAtMs: 35_000,
    resources: [
      {
        resourceName: "gpu-compute",
        capacity: 2,
        lastIssuedFencingToken: 2,
        activeLeases: [],
      },
    ],
    acquireCommands: [commandForFence(2, 34_800), commandForFence(1, 34_900)],
    leaseRenewals: [],
  } as const;

  assert.throws(
    () =>
      new ResourceLockKernel({
        clock,
        resources: [capacityTwoResource],
        restoreFrom: snapshot,
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "RESOURCE_SNAPSHOT_INVALID",
  );

  assert.doesNotThrow(
    () =>
      new ResourceLockKernel({
        clock,
        resources: [capacityTwoResource],
        restoreFrom: {
          ...snapshot,
          acquireCommands: [commandForFence(2, 34_900), commandForFence(1, 34_800)],
        },
      }),
    "array order must not replace fencing-token chronology",
  );
});

test("snapshot restore rejects a stale active fence for a capacity-one resource", () => {
  const clock = new FakeClock(36_000);
  const baseSnapshot = {
    observedAtMs: 36_000,
    resources: [
      {
        resourceName: "desktop-session",
        capacity: 1,
        lastIssuedFencingToken: 2,
        activeLeases: [
          {
            resourceName: "desktop-session",
            holderId: "run-fence-1",
            fencingToken: 1,
            acquiredAtMs: 35_000,
            expiresAtMs: 37_000,
          },
        ],
      },
    ],
    acquireCommands: [
      {
        input: {
          commandId: "acquire-fence-1",
          resourceName: "desktop-session",
          holderId: "run-fence-1",
          leaseDurationMs: 100,
        },
        lease: {
          resourceName: "desktop-session",
          holderId: "run-fence-1",
          fencingToken: 1,
          acquiredAtMs: 35_000,
          expiresAtMs: 35_100,
        },
      },
      {
        input: {
          commandId: "acquire-fence-2",
          resourceName: "desktop-session",
          holderId: "run-fence-2",
          leaseDurationMs: 100,
        },
        lease: {
          resourceName: "desktop-session",
          holderId: "run-fence-2",
          fencingToken: 2,
          acquiredAtMs: 35_100,
          expiresAtMs: 35_200,
        },
      },
    ],
    leaseRenewals: [
      {
        renewalSequence: 1,
        input: {
          commandId: "renew-stale-fence-1",
          resourceName: "desktop-session",
          holderId: "run-fence-1",
          fencingToken: 1,
          leaseDurationMs: 1_950,
        },
        renewedAtMs: 35_050,
        previousExpiresAtMs: 35_100,
        lease: {
          resourceName: "desktop-session",
          holderId: "run-fence-1",
          fencingToken: 1,
          acquiredAtMs: 35_000,
          expiresAtMs: 37_000,
        },
      },
    ],
  } as const;

  assert.throws(
    () =>
      new ResourceLockKernel({
        clock,
        resources: [DESKTOP_SESSION_RESOURCE],
        restoreFrom: baseSnapshot,
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "RESOURCE_SNAPSHOT_INVALID",
  );
});

test("snapshot restore rejects renewal of a capacity-one fence after its successor was acquired", () => {
  const clock = new FakeClock(37_000);
  const snapshot = {
    observedAtMs: 37_000,
    resources: [
      {
        resourceName: "desktop-session",
        capacity: 1,
        lastIssuedFencingToken: 2,
        activeLeases: [],
      },
    ],
    acquireCommands: [
      {
        input: {
          commandId: "acquire-before-successor",
          resourceName: "desktop-session",
          holderId: "run-before-successor",
          leaseDurationMs: 500,
        },
        lease: {
          resourceName: "desktop-session",
          holderId: "run-before-successor",
          fencingToken: 1,
          acquiredAtMs: 36_000,
          expiresAtMs: 36_500,
        },
      },
      {
        input: {
          commandId: "acquire-successor",
          resourceName: "desktop-session",
          holderId: "run-successor",
          leaseDurationMs: 100,
        },
        lease: {
          resourceName: "desktop-session",
          holderId: "run-successor",
          fencingToken: 2,
          acquiredAtMs: 36_100,
          expiresAtMs: 36_200,
        },
      },
    ],
    leaseRenewals: [
      {
        renewalSequence: 1,
        input: {
          commandId: "renew-after-successor",
          resourceName: "desktop-session",
          holderId: "run-before-successor",
          fencingToken: 1,
          leaseDurationMs: 100,
        },
        renewedAtMs: 36_150,
        previousExpiresAtMs: 36_500,
        lease: {
          resourceName: "desktop-session",
          holderId: "run-before-successor",
          fencingToken: 1,
          acquiredAtMs: 36_000,
          expiresAtMs: 36_250,
        },
      },
    ],
  } as const;

  assert.throws(
    () =>
      new ResourceLockKernel({
        clock,
        resources: [DESKTOP_SESSION_RESOURCE],
        restoreFrom: snapshot,
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "RESOURCE_SNAPSHOT_INVALID",
  );
});

test("snapshot restore rejects histories that prove capacity was exceeded", () => {
  const clock = new FakeClock(38_000);
  const capacityTwoResource = { name: "gpu-compute", capacity: 2 } as const;
  const acquireCommand = (fencingToken: number, acquiredAtMs: number, durationMs: number) => ({
    input: {
      commandId: `acquire-capacity-proof-${fencingToken}`,
      resourceName: "gpu-compute",
      holderId: `run-capacity-proof-${fencingToken}`,
      leaseDurationMs: durationMs,
    },
    lease: {
      resourceName: "gpu-compute",
      holderId: `run-capacity-proof-${fencingToken}`,
      fencingToken,
      acquiredAtMs,
      expiresAtMs: acquiredAtMs + durationMs,
    },
  });
  const renewal = (fencingToken: number) => ({
    renewalSequence: 1,
    input: {
      commandId: `renew-capacity-proof-${fencingToken}`,
      resourceName: "gpu-compute",
      holderId: `run-capacity-proof-${fencingToken}`,
      fencingToken,
      leaseDurationMs: 100,
    },
    renewedAtMs: 37_100,
    previousExpiresAtMs: 37_500,
    lease: {
      resourceName: "gpu-compute",
      holderId: `run-capacity-proof-${fencingToken}`,
      fencingToken,
      acquiredAtMs: 37_000,
      expiresAtMs: 37_200,
    },
  });
  const snapshot = {
    observedAtMs: 38_000,
    resources: [
      {
        resourceName: "gpu-compute",
        capacity: 2,
        lastIssuedFencingToken: 3,
        activeLeases: [],
      },
    ],
    acquireCommands: [
      acquireCommand(1, 37_000, 500),
      acquireCommand(2, 37_000, 500),
      acquireCommand(3, 37_050, 100),
    ],
    leaseRenewals: [renewal(1), renewal(2)],
  } as const;

  assert.throws(
    () =>
      new ResourceLockKernel({
        clock,
        resources: [capacityTwoResource],
        restoreFrom: snapshot,
      }),
    (error: unknown) =>
      error instanceof ResourceLockError && error.code === "RESOURCE_SNAPSHOT_INVALID",
  );
});

test("snapshot restore rejects active leases that disagree with their acquire-command outcomes", () => {
  const clock = new FakeClock(40_000);
  const original = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  original.acquire({
    commandId: "acquire-before-cross-check",
    resourceName: "desktop-session",
    holderId: "run-authoritative",
    leaseDurationMs: 1_000,
  });
  const validSnapshot = original.snapshot();

  const mismatchedSnapshots = [
    {
      name: "holder",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.resources[0]!.activeLeases[0]!, {
          holderId: "run-conflicting",
        });
      },
    },
    {
      name: "acquisition timestamp",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.resources[0]!.activeLeases[0]!, {
          acquiredAtMs: 40_001,
          expiresAtMs: 41_001,
        });
      },
    },
    {
      name: "expiry timestamp",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.resources[0]!.activeLeases[0]!, {
          expiresAtMs: 41_001,
        });
      },
    },
    {
      name: "resource",
      mutate: (snapshot: ReturnType<ResourceLockKernel["snapshot"]>) => {
        Object.assign(snapshot.resources[0]!.activeLeases[0]!, {
          resourceName: "different-resource",
        });
      },
    },
  ] as const;

  for (const mismatch of mismatchedSnapshots) {
    const invalidSnapshot = structuredClone(validSnapshot);
    mismatch.mutate(invalidSnapshot);

    assert.throws(
      () =>
        new ResourceLockKernel({
          clock,
          resources: [DESKTOP_SESSION_RESOURCE],
          restoreFrom: invalidSnapshot,
        }),
      (error: unknown) =>
        error instanceof ResourceLockError && error.code === "RESOURCE_SNAPSHOT_INVALID",
      mismatch.name,
    );
  }
});
