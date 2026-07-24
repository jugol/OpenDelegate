import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_SESSION_RESOURCE, ResourceLockKernel } from "@opendelegate/resource-locks";

import {
  ComputerUseError,
  FakeComputerUseBackend,
  type ComputerUseInputAuthorizationRequest,
  type ComputerUseInputAuthorizer,
} from "../src/index.ts";

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

function allowingAuthorizer(
  observedRequests: ComputerUseInputAuthorizationRequest[] = [],
): ComputerUseInputAuthorizer {
  return {
    authorize(request) {
      observedRequests.push(request);
      return {
        decision: "allow",
        authorizationId: "trusted-test-policy",
        fingerprint: request.fingerprint,
      };
    },
  };
}

test("a ready Computer Use run drives the deterministic fixture to visible success", () => {
  const clock = new FakeClock(10_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "macos" },
  });
  const run = backend.startRun({
    commandId: "start-computer-use-macos-1",
    taskId: "task-macos-1",
    deviceId: "device-macos",
    runId: "run-macos-1",
    leaseDurationMs: 1_000,
  });

  assert.deepEqual(run.observe(), {
    runId: "run-macos-1",
    osFamily: "macos",
    view: "computer-use-fixture",
    state: "editing",
    visibleRunId: "run-macos-1",
    textInput: {
      controlId: "text-input",
      label: "Task text",
      value: "",
    },
    options: [
      { controlId: "option-alpha", label: "Alpha", selected: false },
      { controlId: "option-beta", label: "Beta", selected: false },
    ],
    submitButton: {
      controlId: "submit",
      label: "Submit",
      enabled: false,
    },
    resultContent: null,
  });

  run.typeText({ controlId: "text-input", text: "Ship it" });
  run.click({ controlId: "option-beta" });
  run.click({ controlId: "submit" });

  assert.deepEqual(run.observe(), {
    runId: "run-macos-1",
    osFamily: "macos",
    view: "computer-use-fixture",
    state: "success",
    visibleRunId: "run-macos-1",
    textInput: {
      controlId: "text-input",
      label: "Task text",
      value: "Ship it",
    },
    options: [
      { controlId: "option-alpha", label: "Alpha", selected: false },
      { controlId: "option-beta", label: "Beta", selected: true },
    ],
    submitButton: {
      controlId: "submit",
      label: "Submit",
      enabled: true,
    },
    resultContent: "run-macos-1 | Beta | Ship it",
  });
});

test("replaying an identical start command resumes one logical Computer Use controller", () => {
  const clock = new FakeClock(15_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "windows" },
  });
  const input = {
    commandId: "start-computer-use-idempotent",
    taskId: "task-idempotent",
    deviceId: "device-windows",
    runId: "run-idempotent",
    leaseDurationMs: 1_000,
  } as const;

  const original = backend.startRun(input);
  const replay = backend.startRun(input);

  original.typeText({ controlId: "text-input", text: "Shared state" });
  assert.equal(replay.observe().textInput.value, "Shared state");

  replay.click({ controlId: "option-beta" });
  assert.equal(original.observe().options[1]?.selected, true);

  replay.cancel();
  assert.throws(
    () => original.click({ controlId: "submit" }),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "COMPUTER_USE_RUN_CANCELLED");
      return true;
    },
  );
});

test("reusing a start command for a different Computer Use scope fails closed", () => {
  const clock = new FakeClock(17_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "linux" },
  });
  const original = backend.startRun({
    commandId: "start-computer-use-conflict",
    taskId: "task-original",
    deviceId: "device-linux",
    runId: "run-conflict",
    leaseDurationMs: 1_000,
  });

  assert.throws(
    () =>
      backend.startRun({
        commandId: "start-computer-use-conflict",
        taskId: "task-conflicting",
        deviceId: "device-linux",
        runId: "run-conflict",
        leaseDurationMs: 1_000,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_COMMAND_CONFLICT");
      return true;
    },
  );

  assert.equal(locks.snapshot().resources[0]?.activeLeases.length, 1);
  assert.equal(original.observe().visibleRunId, "run-conflict");
});

test("a restarted backend cannot attach a second controller to a restored live desktop lease", () => {
  const clock = new FakeClock(18_000);
  const originalLocks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const options = {
    clock,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "macos" },
  } as const;
  const input = {
    commandId: "start-before-backend-restart",
    taskId: "task-backend-restart",
    deviceId: "device-macos",
    runId: "run-backend-restart",
    leaseDurationMs: 1_000,
  } as const;
  const originalBackend = new FakeComputerUseBackend({
    ...options,
    locks: originalLocks,
  });
  const originalRun = originalBackend.startRun(input);
  const restoredLocks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
    restoreFrom: originalLocks.snapshot(),
  });
  const restartedBackend = new FakeComputerUseBackend({
    ...options,
    locks: restoredLocks,
  });

  assert.throws(
    () => restartedBackend.startRun(input),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "DESKTOP_SESSION_BUSY");
      return true;
    },
  );
  assert.equal(originalRun.observe().visibleRunId, "run-backend-restart");
  assert.equal(restoredLocks.snapshot().resources[0]?.activeLeases.length, 1);
});

test("a second backend sharing one live lock kernel cannot attach to its cached lease", () => {
  const clock = new FakeClock(19_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const options = {
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "windows" },
  } as const;
  const input = {
    commandId: "start-shared-lock-kernel",
    taskId: "task-shared-lock-kernel",
    deviceId: "device-windows",
    runId: "run-shared-lock-kernel",
    leaseDurationMs: 1_000,
  } as const;
  const firstBackend = new FakeComputerUseBackend(options);
  const originalRun = firstBackend.startRun(input);
  const secondBackend = new FakeComputerUseBackend(options);

  assert.throws(
    () => secondBackend.startRun(input),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "DESKTOP_SESSION_BUSY");
      return true;
    },
  );
  originalRun.typeText({ controlId: "text-input", text: "only controller" });
  assert.equal(originalRun.observe().textInput.value, "only controller");
  assert.equal(locks.snapshot().resources[0]?.activeLeases.length, 1);
});

test("a second backend without durable history rejects expired fencing history", () => {
  const clock = new FakeClock(19_500);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const options = {
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "linux" },
  } as const;
  const input = {
    commandId: "start-expired-lock-cache",
    taskId: "task-expired-lock-cache",
    deviceId: "device-linux",
    runId: "run-expired-lock-cache",
    leaseDurationMs: 10,
  } as const;
  new FakeComputerUseBackend(options).startRun(input);
  clock.advanceBy(10);
  const backendWithoutHistory = new FakeComputerUseBackend(options);

  assert.throws(
    () => backendWithoutHistory.startRun(input),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_HISTORY_UNAVAILABLE");
      return true;
    },
  );
  assert.throws(
    () =>
      backendWithoutHistory.startRun({
        ...input,
        commandId: "start-fresh-without-history",
        taskId: "task-fresh-without-history",
        runId: "run-fresh-without-history",
      }),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_HISTORY_UNAVAILABLE");
      return true;
    },
  );
  assert.deepEqual(locks.snapshot().resources[0]?.activeLeases, []);
});

test("durable start history blocks released or expired command replay while permitting fresh work", () => {
  const cases = ["released", "expired"] as const;

  for (const restartCase of cases) {
    const clock = new FakeClock(restartCase === "released" ? 19_700 : 19_800);
    const locks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
    });
    const backend = new FakeComputerUseBackend({
      clock,
      locks,
      authorizer: allowingAuthorizer(),
      readiness: { status: "ready", osFamily: "linux" },
    });
    const originalInput = {
      commandId: `start-before-${restartCase}-restart`,
      taskId: `task-before-${restartCase}-restart`,
      deviceId: "device-linux",
      runId: `run-before-${restartCase}-restart`,
      leaseDurationMs: 10,
    } as const;
    const originalRun = backend.startRun(originalInput);

    if (restartCase === "released") {
      originalRun.release();
    } else {
      clock.advanceBy(10);
    }

    const backendSnapshot = backend.snapshot();
    const restoredLocks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
      restoreFrom: locks.snapshot(),
    });
    const restoredBackend = new FakeComputerUseBackend({
      clock,
      locks: restoredLocks,
      authorizer: allowingAuthorizer(),
      readiness: { status: "ready", osFamily: "linux" },
      restoreFrom: backendSnapshot,
    });

    assert.throws(
      () => restoredBackend.startRun(originalInput),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_HISTORY_UNAVAILABLE");
        return true;
      },
    );
    assert.throws(
      () =>
        restoredBackend.startRun({
          ...originalInput,
          taskId: `task-conflicting-${restartCase}-restart`,
        }),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_COMMAND_CONFLICT");
        return true;
      },
    );

    const freshRun = restoredBackend.startRun({
      commandId: `start-fresh-after-${restartCase}-restart`,
      taskId: `task-fresh-after-${restartCase}-restart`,
      deviceId: "device-linux",
      runId: `run-fresh-after-${restartCase}-restart`,
      leaseDurationMs: 100,
    });
    assert.equal(freshRun.observe().visibleRunId, `run-fresh-after-${restartCase}-restart`);
    assert.equal(restoredLocks.snapshot().resources[0]?.lastIssuedFencingToken, 2);
  }
});

test("restart rejects start history that does not match the restored fencing watermark", () => {
  const clock = new FakeClock(19_900);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "macos" },
  });
  backend
    .startRun({
      commandId: "start-before-invalid-history",
      taskId: "task-before-invalid-history",
      deviceId: "device-macos",
      runId: "run-before-invalid-history",
      leaseDurationMs: 100,
    })
    .release();
  const backendSnapshot = backend.snapshot();
  const lockSnapshot = locks.snapshot();

  for (const invalidHistory of [
    { ...backendSnapshot, desktopLastIssuedFencingToken: 0 },
    { ...backendSnapshot, startCommands: [] },
  ]) {
    const restoredLocks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
      restoreFrom: lockSnapshot,
    });

    assert.throws(
      () =>
        new FakeComputerUseBackend({
          clock,
          locks: restoredLocks,
          authorizer: allowingAuthorizer(),
          readiness: { status: "ready", osFamily: "macos" },
          restoreFrom: invalidHistory,
        }),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_HISTORY_INVALID");
        return true;
      },
    );
  }
});

test("restart rejects Computer Use start history that is unrelated to the restored desktop acquire outcome", () => {
  const clock = new FakeClock(19_950);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "windows" },
  });
  backend
    .startRun({
      commandId: "start-original",
      taskId: "task-original",
      deviceId: "device-windows",
      runId: "run-original",
      leaseDurationMs: 100,
    })
    .release();

  const backendSnapshot = backend.snapshot();
  const originalStartCommand = backendSnapshot.startCommands[0];
  assert.notEqual(originalStartCommand, undefined);
  const mismatchedStartCommands = [
    {
      ...originalStartCommand!,
      commandId: "start-unrelated",
      taskId: "task-unrelated",
      runId: "run-unrelated",
    },
    {
      ...originalStartCommand!,
      runId: "run-unrelated-holder",
    },
    {
      ...originalStartCommand!,
      leaseDurationMs: 101,
    },
  ];
  const lockSnapshot = locks.snapshot();

  for (const mismatchedStartCommand of mismatchedStartCommands) {
    const restoredLocks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
      restoreFrom: lockSnapshot,
    });

    assert.throws(
      () =>
        new FakeComputerUseBackend({
          clock,
          locks: restoredLocks,
          authorizer: allowingAuthorizer(),
          readiness: { status: "ready", osFamily: "windows" },
          restoreFrom: {
            ...backendSnapshot,
            startCommands: [mismatchedStartCommand],
          },
        }),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_HISTORY_INVALID");
        return true;
      },
    );
  }
});

test("restart rejects a newer Computer Use snapshot paired with stale pre-renewal desktop authority", () => {
  const clock = new FakeClock(5_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "linux" },
  });
  backend.startRun({
    commandId: "start-before-renewal",
    taskId: "task-before-renewal",
    deviceId: "device-linux",
    runId: "run-before-renewal",
    leaseDurationMs: 100,
  });
  const stalePreRenewalLockSnapshot = locks.snapshot();

  locks.renew({
    commandId: "renew-desktop-run-before-renewal-1",
    resourceName: "desktop-session",
    holderId: "run-before-renewal",
    fencingToken: 1,
    leaseDurationMs: 1_000,
  });
  const newerBackendSnapshot = backend.snapshot();
  const restoredStaleLocks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
    restoreFrom: stalePreRenewalLockSnapshot,
  });

  assert.throws(
    () =>
      new FakeComputerUseBackend({
        clock,
        locks: restoredStaleLocks,
        authorizer: allowingAuthorizer(),
        readiness: { status: "ready", osFamily: "linux" },
        restoreFrom: newerBackendSnapshot,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_HISTORY_INVALID");
      return true;
    },
  );
});

test("restart rejects a desktop lock history whose renewal command identity changed", () => {
  const clock = new FakeClock(5_500);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "windows" },
  });
  backend.startRun({
    commandId: "start-before-renew-command-tamper",
    taskId: "task-before-renew-command-tamper",
    deviceId: "device-windows",
    runId: "run-before-renew-command-tamper",
    leaseDurationMs: 100,
  });
  locks.renew({
    commandId: "renew-desktop-run-before-renew-command-tamper-1",
    resourceName: "desktop-session",
    holderId: "run-before-renew-command-tamper",
    fencingToken: 1,
    leaseDurationMs: 1_000,
  });
  const backendSnapshot = backend.snapshot();
  const renamedRenewalSnapshot = structuredClone(locks.snapshot());
  Object.assign(renamedRenewalSnapshot.leaseRenewals[0]!.input, {
    commandId: "renew-desktop-run-before-renew-command-tamper-renamed",
  });
  const restoredLocks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
    restoreFrom: renamedRenewalSnapshot,
  });

  assert.throws(
    () =>
      new FakeComputerUseBackend({
        clock,
        locks: restoredLocks,
        authorizer: allowingAuthorizer(),
        readiness: { status: "ready", osFamily: "windows" },
        restoreFrom: backendSnapshot,
      }),
    (error: unknown) =>
      error instanceof ComputerUseError && error.code === "COMPUTER_USE_START_HISTORY_INVALID",
  );
});

test("restart rejects malformed or mismatched desktop lock authority bindings", () => {
  const clock = new FakeClock(6_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "macos" },
  });
  backend
    .startRun({
      commandId: "start-before-binding-tamper",
      taskId: "task-before-binding-tamper",
      deviceId: "device-macos",
      runId: "run-before-binding-tamper",
      leaseDurationMs: 100,
    })
    .release();
  const backendSnapshot = backend.snapshot();
  const lockSnapshot = locks.snapshot();

  for (const tamperedBinding of ["not-a-desktop-authority-binding", `sha256:${"0".repeat(64)}`]) {
    const restoredLocks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
      restoreFrom: lockSnapshot,
    });
    const tamperedBackendSnapshot = {
      ...backendSnapshot,
      desktopLockHistoryDigest: tamperedBinding,
    } as unknown as typeof backendSnapshot;

    assert.throws(
      () =>
        new FakeComputerUseBackend({
          clock,
          locks: restoredLocks,
          authorizer: allowingAuthorizer(),
          readiness: { status: "ready", osFamily: "macos" },
          restoreFrom: tamperedBackendSnapshot,
        }),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_HISTORY_INVALID");
        return true;
      },
    );
  }
});

test("restart accepts an exact snapshot pair after its captured active desktop lease expires", () => {
  const clock = new FakeClock(7_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "windows" },
  });
  backend.startRun({
    commandId: "start-before-restart-downtime",
    taskId: "task-before-restart-downtime",
    deviceId: "device-windows",
    runId: "run-before-restart-downtime",
    leaseDurationMs: 100,
  });
  const backendSnapshot = backend.snapshot();
  const lockSnapshot = locks.snapshot();

  clock.advanceBy(100);
  const restoredLocks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
    restoreFrom: lockSnapshot,
  });
  const restoredBackend = new FakeComputerUseBackend({
    clock,
    locks: restoredLocks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "windows" },
    restoreFrom: backendSnapshot,
  });

  const freshRun = restoredBackend.startRun({
    commandId: "start-after-restart-downtime",
    taskId: "task-after-restart-downtime",
    deviceId: "device-windows",
    runId: "run-after-restart-downtime",
    leaseDurationMs: 100,
  });
  assert.equal(freshRun.observe().visibleRunId, "run-after-restart-downtime");
  assert.equal(restoredLocks.snapshot().resources[0]?.lastIssuedFencingToken, 2);
});

test("restart rejects missing or altered captured active desktop lease authority", () => {
  const clock = new FakeClock(7_500);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "linux" },
  });
  backend.startRun({
    commandId: "start-before-active-binding-tamper",
    taskId: "task-before-active-binding-tamper",
    deviceId: "device-linux",
    runId: "run-before-active-binding-tamper",
    leaseDurationMs: 1_000,
  });
  const backendSnapshot = backend.snapshot();
  const lockSnapshot = locks.snapshot();
  const activeLease = lockSnapshot.resources[0]?.activeLeases[0];
  assert.notEqual(activeLease, undefined);

  for (const tamperedActiveLeases of [
    [],
    [{ ...activeLease!, holderId: "run-altered-active-binding" }],
  ]) {
    const restoredLocks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
      restoreFrom: lockSnapshot,
    });
    const tamperedBackendSnapshot = {
      ...backendSnapshot,
      desktopActiveLeases: tamperedActiveLeases,
    } as unknown as typeof backendSnapshot;

    assert.throws(
      () =>
        new FakeComputerUseBackend({
          clock,
          locks: restoredLocks,
          authorizer: allowingAuthorizer(),
          readiness: { status: "ready", osFamily: "linux" },
          restoreFrom: tamperedBackendSnapshot,
        }),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal((error as ComputerUseError).code, "COMPUTER_USE_START_HISTORY_INVALID");
        return true;
      },
    );
  }
});

test("a second run is blocked until the first releases the Device-wide desktop session", () => {
  const clock = new FakeClock(20_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "windows" },
  });
  const firstRun = backend.startRun({
    commandId: "start-computer-use-windows-1",
    taskId: "task-windows",
    deviceId: "device-windows",
    runId: "run-windows-1",
    leaseDurationMs: 1_000,
  });

  assert.throws(
    () =>
      backend.startRun({
        commandId: "start-computer-use-windows-2-blocked",
        taskId: "task-windows",
        deviceId: "device-windows",
        runId: "run-windows-2",
        leaseDurationMs: 1_000,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "DESKTOP_SESSION_BUSY");
      return true;
    },
  );

  firstRun.release();

  const secondRun = backend.startRun({
    commandId: "start-computer-use-windows-2",
    taskId: "task-windows",
    deviceId: "device-windows",
    runId: "run-windows-2",
    leaseDurationMs: 1_000,
  });

  assert.equal(secondRun.observe().visibleRunId, "run-windows-2");
});

test("Computer Use rejects a missing or non-exclusive desktop-session resource", () => {
  const cases = [[], [{ name: "desktop-session", capacity: 2 }]] as const;

  for (const resources of cases) {
    const clock = new FakeClock(25_000);
    const locks = new ResourceLockKernel({
      clock,
      resources,
    });

    assert.throws(
      () =>
        new FakeComputerUseBackend({
          clock,
          locks,
          authorizer: allowingAuthorizer(),
          readiness: { status: "ready", osFamily: "windows" },
        }),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal((error as ComputerUseError).code, "COMPUTER_USE_DESKTOP_RESOURCE_INVALID");
        return true;
      },
    );
  }
});

test("readiness failures are actionable and prevent desktop lease acquisition", () => {
  const cases = [
    {
      status: "no-user-session",
      osFamily: "linux",
      message: "No interactive user session is available.",
      remediation: "Sign in to an interactive desktop session on this Device.",
    },
    {
      status: "locked-session",
      osFamily: "windows",
      message: "The interactive desktop session is locked.",
      remediation: "Unlock the desktop session before retrying Computer Use.",
    },
    {
      status: "permission-denied",
      osFamily: "macos",
      message: "Screen capture or input permission is not granted.",
      remediation: "Grant the required screen capture and accessibility/input permissions.",
    },
    {
      status: "helper-unavailable",
      osFamily: "linux",
      message: "The OpenDelegate user-session helper is unavailable.",
      remediation: "Start or reinstall the OpenDelegate user-session helper.",
    },
  ] as const;

  for (const readinessCase of cases) {
    const clock = new FakeClock(30_000);
    const locks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
    });
    const backend = new FakeComputerUseBackend({
      clock,
      locks,
      authorizer: allowingAuthorizer(),
      readiness: {
        status: readinessCase.status,
        osFamily: readinessCase.osFamily,
      },
    });
    const expectedReadiness = {
      status: readinessCase.status,
      osFamily: readinessCase.osFamily,
      message: readinessCase.message,
      remediation: readinessCase.remediation,
    };

    assert.deepEqual(backend.readiness(), expectedReadiness);
    assert.throws(
      () =>
        backend.startRun({
          commandId: `start-not-ready-${readinessCase.status}`,
          taskId: `task-not-ready-${readinessCase.status}`,
          deviceId: `device-not-ready-${readinessCase.status}`,
          runId: `run-not-ready-${readinessCase.status}`,
          leaseDurationMs: 1_000,
        }),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal((error as ComputerUseError).code, "COMPUTER_USE_NOT_READY");
        assert.deepEqual((error as ComputerUseError).readiness, expectedReadiness);
        return true;
      },
    );
    assert.deepEqual(locks.snapshot().resources[0]?.activeLeases, []);
  }
});

test("captureEvidence records deterministic screenshot metadata and visible success for every OS family", () => {
  const cases = [
    { osFamily: "macos", runId: "run-evidence-macos" },
    { osFamily: "windows", runId: "run-evidence-windows" },
    { osFamily: "linux", runId: "run-evidence-linux" },
  ] as const;

  for (const evidenceCase of cases) {
    const clock = new FakeClock(40_000);
    const locks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
    });
    const backend = new FakeComputerUseBackend({
      clock,
      locks,
      authorizer: allowingAuthorizer(),
      readiness: { status: "ready", osFamily: evidenceCase.osFamily },
    });
    const run = backend.startRun({
      commandId: `start-${evidenceCase.runId}`,
      taskId: `task-${evidenceCase.osFamily}`,
      deviceId: `device-${evidenceCase.osFamily}`,
      runId: evidenceCase.runId,
      leaseDurationMs: 1_000,
    });
    run.typeText({ controlId: "text-input", text: "Evidence" });
    run.click({ controlId: "option-alpha" });
    run.click({ controlId: "submit" });

    const evidence = run.captureEvidence();

    assert.deepEqual(
      {
        evidenceId: evidence.evidenceId,
        runId: evidence.runId,
        osFamily: evidence.osFamily,
        kind: evidence.kind,
        mediaType: evidence.mediaType,
        capturedAtMs: evidence.capturedAtMs,
        sequence: evidence.sequence,
        width: evidence.width,
        height: evidence.height,
        state: evidence.observation.state,
        visibleRunId: evidence.observation.visibleRunId,
        resultContent: evidence.observation.resultContent,
      },
      {
        evidenceId: `computer-use-evidence:${evidence.filename.slice(13, 29)}:1`,
        runId: evidenceCase.runId,
        osFamily: evidenceCase.osFamily,
        kind: "screenshot",
        mediaType: "image/png",
        capturedAtMs: 40_000,
        sequence: 1,
        width: 1280,
        height: 720,
        state: "success",
        visibleRunId: evidenceCase.runId,
        resultContent: `${evidenceCase.runId} | Alpha | Evidence`,
      },
    );
    assert.match(evidence.filename, /^computer-use-[a-f0-9]{16}-screenshot-1\.png$/);
    assert.equal(evidence.filename.includes(evidenceCase.runId), false);
  }
});

test("cancellation and emergency stop release the desktop while preventing further input", () => {
  const cases = [
    {
      terminalAction: "cancel",
      expectedCode: "COMPUTER_USE_RUN_CANCELLED",
    },
    {
      terminalAction: "emergencyStop",
      expectedCode: "COMPUTER_USE_EMERGENCY_STOPPED",
    },
  ] as const;

  for (const terminalCase of cases) {
    const clock = new FakeClock(50_000);
    const locks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
    });
    const backend = new FakeComputerUseBackend({
      clock,
      locks,
      authorizer: allowingAuthorizer(),
      readiness: { status: "ready", osFamily: "linux" },
    });
    const run = backend.startRun({
      commandId: `start-${terminalCase.terminalAction}`,
      taskId: `task-${terminalCase.terminalAction}`,
      deviceId: "device-linux",
      runId: `run-${terminalCase.terminalAction}`,
      leaseDurationMs: 1_000,
    });

    run[terminalCase.terminalAction]();

    for (const attemptInput of [
      () => run.typeText({ controlId: "text-input", text: "blocked" }),
      () => run.click({ controlId: "option-alpha" }),
    ]) {
      assert.throws(attemptInput, (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal((error as ComputerUseError).code, terminalCase.expectedCode);
        return true;
      });
    }

    const replacement = backend.startRun({
      commandId: `start-after-${terminalCase.terminalAction}`,
      taskId: `task-after-${terminalCase.terminalAction}`,
      deviceId: "device-linux",
      runId: `run-after-${terminalCase.terminalAction}`,
      leaseDurationMs: 1_000,
    });
    assert.equal(replacement.observe().visibleRunId, `run-after-${terminalCase.terminalAction}`);
  }
});

test("an expired desktop lease prevents further actions and can be reclaimed by another run", () => {
  const clock = new FakeClock(60_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "linux" },
  });
  const staleRun = backend.startRun({
    commandId: "start-expiring-run",
    taskId: "task-expiring",
    deviceId: "device-linux",
    runId: "run-expiring",
    leaseDurationMs: 10,
  });

  clock.advanceBy(10);

  assert.throws(
    () => staleRun.typeText({ controlId: "text-input", text: "blocked" }),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "DESKTOP_SESSION_LEASE_LOST");
      return true;
    },
  );

  const replacement = backend.startRun({
    commandId: "start-after-expiry",
    taskId: "task-after-expiry",
    deviceId: "device-linux",
    runId: "run-after-expiry",
    leaseDurationMs: 100,
  });
  assert.equal(replacement.observe().visibleRunId, "run-after-expiry");
});

test("every input action receives exact Task, Device, Run, and action authorization immediately before mutation", () => {
  const clock = new FakeClock(70_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const requests: ComputerUseInputAuthorizationRequest[] = [];
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(requests),
    readiness: { status: "ready", osFamily: "windows" },
  });
  const run = backend.startRun({
    commandId: "start-authorized-run",
    taskId: "task-authorized",
    deviceId: "device-authorized",
    runId: "run-authorized",
    leaseDurationMs: 1_000,
  });

  run.typeText({ controlId: "text-input", text: "Authorized text" });
  run.click({ controlId: "option-alpha" });

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => ({
      actionCategory: request.actionCategory,
      taskId: request.taskId,
      deviceId: request.deviceId,
      runId: request.runId,
      action: request.action,
      requestedAtMs: request.requestedAtMs,
      frozen: Object.isFrozen(request),
    })),
    [
      {
        actionCategory: "computer-use-input",
        taskId: "task-authorized",
        deviceId: "device-authorized",
        runId: "run-authorized",
        action: {
          kind: "type-text",
          controlId: "text-input",
          textSha256: "2469c0f14bef4a12feb1f1d53acf007923fb039c9709f07b10fc9fb1ce811881",
          textLength: 15,
        },
        requestedAtMs: 70_000,
        frozen: true,
      },
      {
        actionCategory: "computer-use-input",
        taskId: "task-authorized",
        deviceId: "device-authorized",
        runId: "run-authorized",
        action: {
          kind: "click",
          controlId: "option-alpha",
        },
        requestedAtMs: 70_000,
        frozen: true,
      },
    ],
  );
  assert.notEqual(requests[0]?.fingerprint, requests[1]?.fingerprint);
  assert.equal(JSON.stringify(requests).includes("Authorized text"), false);
  assert.equal(run.observe().textInput.value, "Authorized text");
  assert.equal(run.observe().options[0]?.selected, true);
});

test("text input fails closed when its desktop lease expires during authorization", () => {
  const clock = new FakeClock(75_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: {
      authorize(request) {
        clock.advanceBy(10);
        return {
          decision: "allow",
          authorizationId: "authorization-after-expiry",
          fingerprint: request.fingerprint,
        };
      },
    },
    readiness: { status: "ready", osFamily: "windows" },
  });
  const run = backend.startRun({
    commandId: "start-expiry-during-authorization",
    taskId: "task-expiry-during-authorization",
    deviceId: "device-windows",
    runId: "run-expiry-during-authorization",
    leaseDurationMs: 10,
  });

  assert.throws(
    () => run.typeText({ controlId: "text-input", text: "must-not-appear" }),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "DESKTOP_SESSION_LEASE_LOST");
      return true;
    },
  );
  assert.deepEqual(locks.snapshot().resources[0]?.activeLeases, []);
});

test("click input fails closed when authorization replaces its desktop lease fence", () => {
  const clock = new FakeClock(77_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: {
      authorize(request) {
        const activeLease = locks.snapshot().resources[0]?.activeLeases[0];
        assert.notEqual(activeLease, undefined);
        locks.release({
          resourceName: activeLease!.resourceName,
          holderId: activeLease!.holderId,
          fencingToken: activeLease!.fencingToken,
        });
        locks.acquire({
          commandId: "replace-desktop-during-authorization",
          resourceName: "desktop-session",
          holderId: "run-replacement",
          leaseDurationMs: 1_000,
        });

        return {
          decision: "allow",
          authorizationId: "authorization-after-replacement",
          fingerprint: request.fingerprint,
        };
      },
    },
    readiness: { status: "ready", osFamily: "linux" },
  });
  const run = backend.startRun({
    commandId: "start-replacement-during-authorization",
    taskId: "task-replacement-during-authorization",
    deviceId: "device-linux",
    runId: "run-stale-fence",
    leaseDurationMs: 1_000,
  });

  assert.throws(
    () => run.click({ controlId: "option-alpha" }),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "DESKTOP_SESSION_LEASE_LOST");
      return true;
    },
  );
  assert.deepEqual(
    locks.snapshot().resources[0]?.activeLeases.map((lease) => ({
      holderId: lease.holderId,
      fencingToken: lease.fencingToken,
    })),
    [{ holderId: "run-replacement", fencingToken: 2 }],
  );
});

test("denied, approval-pending, or mismatched authorization has zero desktop input side effects", () => {
  const cases = [
    {
      label: "denied",
      authorize(request: ComputerUseInputAuthorizationRequest) {
        return {
          decision: "deny" as const,
          authorizationId: "deny-proof",
          fingerprint: request.fingerprint,
        };
      },
    },
    {
      label: "approval-pending",
      authorize(request: ComputerUseInputAuthorizationRequest) {
        return {
          decision: "require-approval" as const,
          authorizationId: "approval-proof",
          fingerprint: request.fingerprint,
        };
      },
    },
    {
      label: "mismatched",
      authorize() {
        return {
          decision: "allow" as const,
          authorizationId: "wrong-proof",
          fingerprint:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const,
        };
      },
    },
  ] as const;

  for (const authorizationCase of cases) {
    const clock = new FakeClock(80_000);
    const locks = new ResourceLockKernel({
      clock,
      resources: [DESKTOP_SESSION_RESOURCE],
    });
    const backend = new FakeComputerUseBackend({
      clock,
      locks,
      authorizer: { authorize: authorizationCase.authorize },
      readiness: { status: "ready", osFamily: "linux" },
    });
    const run = backend.startRun({
      commandId: `start-${authorizationCase.label}`,
      taskId: `task-${authorizationCase.label}`,
      deviceId: "device-linux",
      runId: `run-${authorizationCase.label}`,
      leaseDurationMs: 1_000,
    });

    assert.throws(
      () => run.typeText({ controlId: "text-input", text: "must-not-appear" }),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        assert.equal(
          (error as ComputerUseError).code,
          authorizationCase.label === "mismatched"
            ? "COMPUTER_USE_AUTHORIZATION_INVALID"
            : "COMPUTER_USE_INPUT_NOT_AUTHORIZED",
        );
        return true;
      },
    );
    assert.throws(
      () => run.click({ controlId: "option-beta" }),
      (error: unknown) => {
        assert.equal(error instanceof ComputerUseError, true);
        return true;
      },
    );
    assert.equal(run.observe().textInput.value, "");
    assert.equal(run.observe().options[1]?.selected, false);
  }
});

test("rejects unsafe identifiers and invalid clocks before a desktop action or evidence write", () => {
  const clock = new FakeClock(90_000);
  const locks = new ResourceLockKernel({
    clock,
    resources: [DESKTOP_SESSION_RESOURCE],
  });
  const backend = new FakeComputerUseBackend({
    clock,
    locks,
    authorizer: allowingAuthorizer(),
    readiness: { status: "ready", osFamily: "macos" },
  });

  assert.throws(
    () =>
      backend.startRun({
        commandId: "start-unsafe-id",
        taskId: "task-safe",
        deviceId: "device-safe",
        runId: "../escape",
        leaseDurationMs: 1_000,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "COMPUTER_USE_ID_INVALID");
      return true;
    },
  );

  const run = backend.startRun({
    commandId: "start-invalid-clock",
    taskId: "task-clock",
    deviceId: "device-clock",
    runId: "run-clock",
    leaseDurationMs: 1_000,
  });
  clock.set(Number.NaN);

  for (const operation of [
    () => run.typeText({ controlId: "text-input", text: "blocked" }),
    () => run.captureEvidence(),
  ]) {
    assert.throws(operation, (error: unknown) => {
      assert.equal(error instanceof ComputerUseError, true);
      assert.equal((error as ComputerUseError).code, "COMPUTER_USE_CLOCK_INVALID");
      return true;
    });
  }
});
