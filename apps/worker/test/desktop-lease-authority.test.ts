import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  SqliteWorkerDesktopLeaseAuthority,
  type WorkerDesktopLeaseClaimInput,
} from "../src/desktop-lease-authority.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SqliteWorkerDesktopLeaseAuthority", () => {
  it("idempotently grants one desktop owner and rejects a concurrent Run", async () => {
    const fixture = await createFixture();
    const first = await fixture.authority.claim(claimInput());
    assert.equal(first.disposition, "acquired");
    assert.deepEqual(await fixture.authority.resourceLockProjection(), {
      resourceName: "desktop-session",
      capacity: 1,
      holders: [
        {
          taskId: "task-release",
          runId: "run-release",
          expiresAtMs: 2_000,
        },
      ],
    });
    assert.equal(
      JSON.stringify(await fixture.authority.resourceLockProjection()).includes("desktop-lease"),
      false,
    );

    const replay = await fixture.authority.claim(claimInput());
    assert.deepEqual(replay, {
      disposition: "current",
      lease: first.lease,
    });

    const competing = await fixture.authority.claim(
      claimInput({
        taskId: "task-competing",
        runId: "run-competing",
        runLeaseId: "run-lease-competing",
      }),
    );
    assert.deepEqual(competing, {
      disposition: "busy",
      retryAfterMs: 1_000,
    });

    assert.deepEqual(
      await fixture.authority.verify({
        taskId: "task-release",
        deviceId: "device-windows",
        runId: "run-release",
        lease: first.lease,
      }),
      {
        status: "current",
        leaseId: first.lease.leaseId,
        fencingToken: 1,
        verifiedAtMs: 1_000,
      },
    );
    fixture.authority.close();
  });

  it("projects an expired desktop lease as an available named resource", async () => {
    const fixture = await createFixture();
    await fixture.authority.claim(claimInput());
    fixture.clock.nowMs = 2_000;
    assert.deepEqual(await fixture.authority.resourceLockProjection(), {
      resourceName: "desktop-session",
      capacity: 1,
      holders: [],
    });
    fixture.authority.close();
  });

  it("persists fencing across restart and reclaims only after expiry", async () => {
    const fixture = await createFixture();
    const first = await fixture.authority.claim(claimInput());
    assert.notEqual(first.disposition, "busy");
    fixture.authority.close();

    fixture.clock.nowMs = 2_001;
    const restarted = new SqliteWorkerDesktopLeaseAuthority({
      filename: fixture.filename,
      sourceCheckoutDirectory: resolve("."),
      clock: fixture.clock,
      idSource: {
        nextLeaseId: () => "desktop-lease-2",
      },
    });
    const second = await restarted.claim(
      claimInput({
        taskId: "task-next",
        runId: "run-next",
        runLeaseId: "run-lease-next",
        runLeaseExpiresAtMs: 3_000,
      }),
    );
    assert.deepEqual(second, {
      disposition: "acquired",
      lease: {
        resourceName: "desktop-session",
        capacity: 1,
        leaseId: "desktop-lease-2",
        fencingToken: 2,
        expiresAtMs: 3_000,
      },
    });
    restarted.close();
  });

  it("releases only the exact current lease and fails stale verification closed", async () => {
    const fixture = await createFixture();
    const claim = await fixture.authority.claim(claimInput());
    if (claim.disposition === "busy") {
      assert.fail("The first claim must acquire the desktop.");
    }

    assert.equal(
      await fixture.authority.release({
        taskId: "task-release",
        deviceId: "device-windows",
        runId: "run-release",
        lease: {
          ...claim.lease,
          fencingToken: claim.lease.fencingToken + 1,
        },
      }),
      "stale",
    );
    assert.equal(
      (
        await fixture.authority.verify({
          taskId: "task-other",
          deviceId: "device-windows",
          runId: "run-release",
          lease: claim.lease,
        })
      ).status,
      "stale",
    );
    assert.equal(
      await fixture.authority.release({
        taskId: "task-release",
        deviceId: "device-windows",
        runId: "run-release",
        lease: claim.lease,
      }),
      "released",
    );
    assert.equal(
      (
        await fixture.authority.verify({
          taskId: "task-release",
          deviceId: "device-windows",
          runId: "run-release",
          lease: claim.lease,
        })
      ).status,
      "stale",
    );
    fixture.authority.close();
  });

  it("rejects rollback, unsafe paths, invalid claims, and use after close", async () => {
    const fixture = await createFixture();
    await fixture.authority.claim(claimInput());
    fixture.clock.nowMs = 999;
    assert.deepEqual(
      await fixture.authority.verify({
        taskId: "task-release",
        deviceId: "device-windows",
        runId: "run-release",
        lease: {
          resourceName: "desktop-session",
          capacity: 1,
          leaseId: "desktop-lease-1",
          fencingToken: 1,
          expiresAtMs: 2_000,
        },
      }),
      {
        status: "unavailable",
        reason: "The desktop authority clock moved backwards.",
        verifiedAtMs: 999,
      },
    );
    await assert.rejects(
      fixture.authority.claim(
        claimInput({
          runLeaseExpiresAtMs: 999,
        }),
      ),
      /Run lease must remain current/u,
    );
    fixture.authority.close();
    await assert.rejects(fixture.authority.claim(claimInput()), /closed/u);

    assert.throws(
      () =>
        new SqliteWorkerDesktopLeaseAuthority({
          filename: join(resolve("."), "unsafe-desktop.sqlite3"),
          sourceCheckoutDirectory: resolve("."),
          clock: fixture.clock,
        }),
      /outside the source checkout/u,
    );
    const unsafeDirectory = join(resolve("."), ".desktop-authority-must-not-exist");
    assert.throws(
      () =>
        new SqliteWorkerDesktopLeaseAuthority({
          filename: join(unsafeDirectory, "state.sqlite3"),
          sourceCheckoutDirectory: resolve("."),
          clock: fixture.clock,
        }),
      /outside the source checkout/u,
    );
    await assert.rejects(access(unsafeDirectory));
  });
});

async function createFixture(): Promise<{
  readonly authority: SqliteWorkerDesktopLeaseAuthority;
  readonly clock: { nowMs: number; now(): number };
  readonly filename: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-desktop-authority-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "desktop.sqlite3");
  const clock = {
    nowMs: 1_000,
    now() {
      return this.nowMs;
    },
  };
  return {
    authority: new SqliteWorkerDesktopLeaseAuthority({
      filename,
      sourceCheckoutDirectory: resolve("."),
      clock,
      idSource: {
        nextLeaseId: () => "desktop-lease-1",
      },
    }),
    clock,
    filename,
  };
}

function claimInput(
  overrides: Partial<WorkerDesktopLeaseClaimInput> = {},
): WorkerDesktopLeaseClaimInput {
  return {
    taskId: "task-release",
    deviceId: "device-windows",
    runId: "run-release",
    runLeaseId: "run-lease-release",
    runFencingToken: 7,
    runLeaseExpiresAtMs: 2_000,
    ...overrides,
  };
}
