import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ComputerUseOsError,
  ComputerUseOsBackend,
  InMemoryComputerUseStartHistory,
  NativeDriverError,
  createFixtureNativeDriver,
  createHeadlessLinuxNativeDriver,
  type ComputerUseLogEvent,
  type ComputerUseInputAuthorizationRequest,
  type DesktopAuthorityPort,
  type DesktopLeasePort,
  type NativeComputerUseDriver,
} from "../src/index.ts";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("OS Computer Use public seam", () => {
  it("drives the cross-platform fixture through authorized input and returns real PNG evidence", async () => {
    for (const osFamily of ["windows", "macos", "linux"] as const) {
      const fixture = createFixtureNativeDriver({
        osFamily,
        runIdentifier: `fixture-${osFamily}`,
        ...(osFamily === "linux" ? { linuxTarget: "ubuntu-24.04-gnome-wayland" } : {}),
      });
      const requests: ComputerUseInputAuthorizationRequest[] = [];
      const backend = new ComputerUseOsBackend({
        osFamily,
        driver: fixture.driver,
        authority: currentAuthority(),
        leases: currentLease(),
        startHistory: new InMemoryComputerUseStartHistory(),
        authorizer: {
          authorize(request) {
            requests.push(request);
            return {
              decision: "allow",
              authorizationId: `authorization-${requests.length}`,
              fingerprint: request.fingerprint,
            };
          },
        },
        clock: { now: () => 10_000 },
        logger: { write() {} },
      });

      const readiness = await backend.readiness({
        deviceId: "device-1",
        helperInstanceId: "helper-1",
        serviceEpoch: 7,
        persistenceGeneration: 11,
      });
      assert.equal(readiness.status, "ready");
      assert.deepEqual(
        readiness.checks.map((check) => [check.name, check.status]),
        [
          ["interactive-session", "pass"],
          ["unlocked-session", "pass"],
          ["screen-capture", "pass"],
          ["accessibility", "pass"],
          ["input", "pass"],
          ["helper-authentication", "pass"],
          ["service-epoch", "pass"],
        ],
      );

      const session = await backend.start({
        commandId: `start-${osFamily}`,
        taskId: "task-1",
        deviceId: "device-1",
        runId: `run-${osFamily}`,
        helperInstanceId: "helper-1",
        serviceEpoch: 7,
        persistenceGeneration: 11,
        lease: {
          resourceName: "desktop-session",
          capacity: 1,
          leaseId: "lease-1",
          fencingToken: 4,
          expiresAtMs: 20_000,
        },
        timeoutMs: 5_000,
      });

      await session.typeText({ controlId: "task-text", text: "sensitive fixture text" });
      await session.click({ controlId: "option-beta" });
      await session.click({ controlId: "submit" });

      const observation = await session.observe();
      assert.equal(observation.fixture?.state, "success");
      assert.equal(observation.fixture?.selectedOption, "Beta");
      assert.equal(observation.fixture?.textValue, "sensitive fixture text");
      assert.match(observation.fixture?.resultFile?.filename ?? "", /^fixture-result-/);

      const evidence = await session.capture();
      assert.deepEqual(Buffer.from(evidence.bytes.subarray(0, 8)), PNG_SIGNATURE);
      assert.equal(evidence.mediaType, "image/png");
      assert.equal(evidence.width, 320);
      assert.equal(evidence.height, 180);
      assert.match(evidence.sha256, /^sha256:[a-f0-9]{64}$/);

      assert.equal(requests.length, 3);
      assert.equal(
        JSON.stringify(requests).includes("sensitive fixture text"),
        false,
        "authorization requests must contain only the text digest and length",
      );
    }
  });

  it("returns one live handle for concurrent exact start replay and rejects unrecoverable restart replay", async () => {
    const fixture = createFixtureNativeDriver({
      osFamily: "windows",
      runIdentifier: "idempotency-fixture",
    });
    const history = new InMemoryComputerUseStartHistory();
    const backend = createBackend(fixture.driver, history);
    const input = startInput();

    const [first, duplicate] = await Promise.all([backend.start(input), backend.start(input)]);
    assert.equal(first, duplicate);
    assert.equal(first.executionHandleId, duplicate.executionHandleId);

    await assert.rejects(
      backend.start({ ...input, runId: "different-run" }),
      hasCode("START_COMMAND_CONFLICT"),
    );

    const restarted = createBackend(fixture.driver, history);
    await assert.rejects(restarted.start(input), hasCode("START_HISTORY_UNRECOVERABLE"));
  });

  it("fails closed when service authority or the exact desktop lease becomes stale", async () => {
    for (const staleBoundary of ["authority", "lease"] as const) {
      const fixture = createFixtureNativeDriver({
        osFamily: "windows",
        runIdentifier: `stale-${staleBoundary}`,
      });
      let boundaryCurrent = true;
      const backend = new ComputerUseOsBackend({
        osFamily: "windows",
        driver: fixture.driver,
        authority: {
          async verify(request) {
            return boundaryCurrent || staleBoundary !== "authority"
              ? {
                  status: "current",
                  helperInstanceId: request.helperInstanceId,
                  serviceEpoch: request.serviceEpoch,
                  persistenceGeneration: request.persistenceGeneration,
                  verifiedAtMs: 10_000,
                }
              : {
                  status: "stale",
                  reason: "A newer exclusive service epoch exists.",
                  verifiedAtMs: 10_001,
                };
          },
        },
        leases: {
          async verify(request) {
            return boundaryCurrent || staleBoundary !== "lease"
              ? {
                  status: "current",
                  leaseId: request.lease.leaseId,
                  fencingToken: request.lease.fencingToken,
                  verifiedAtMs: 10_000,
                }
              : {
                  status: "stale",
                  reason: "A higher desktop fencing token exists.",
                  verifiedAtMs: 10_001,
                };
          },
        },
        startHistory: new InMemoryComputerUseStartHistory(),
        authorizer: allowAll(),
        clock: { now: () => 10_000 },
        logger: { write() {} },
      });
      const session = await backend.start({
        ...startInput(),
        commandId: `start-${staleBoundary}`,
        runId: `run-${staleBoundary}`,
      });
      boundaryCurrent = false;

      await assert.rejects(
        session.click({ controlId: "option-alpha" }),
        hasCode(staleBoundary === "authority" ? "EPOCH_STALE" : "LEASE_STALE"),
      );
      assert.equal(session.status(), "failed");
      assert.equal(fixture.activity().emergencyStopCount, 1);
      assert.equal(fixture.activity().actionCount, 0);
    }
  });

  it("treats unavailable authority and lease verification as stale instead of propagating adapter errors", async () => {
    for (const unavailableBoundary of ["authority", "lease"] as const) {
      const fixture = createFixtureNativeDriver({
        osFamily: "windows",
        runIdentifier: `unavailable-${unavailableBoundary}`,
      });
      let verificationAvailable = true;
      const backend = new ComputerUseOsBackend({
        osFamily: "windows",
        driver: fixture.driver,
        authority: {
          async verify(request) {
            if (!verificationAvailable && unavailableBoundary === "authority") {
              throw new Error("raw authority adapter detail");
            }
            return {
              status: "current",
              helperInstanceId: request.helperInstanceId,
              serviceEpoch: request.serviceEpoch,
              persistenceGeneration: request.persistenceGeneration,
              verifiedAtMs: 10_000,
            };
          },
        },
        leases: {
          async verify(request) {
            if (!verificationAvailable && unavailableBoundary === "lease") {
              throw new Error("raw lease adapter detail");
            }
            return {
              status: "current",
              leaseId: request.lease.leaseId,
              fencingToken: request.lease.fencingToken,
              verifiedAtMs: 10_000,
            };
          },
        },
        startHistory: new InMemoryComputerUseStartHistory(),
        authorizer: allowAll(),
        clock: { now: () => 10_000 },
        logger: { write() {} },
      });
      const session = await backend.start({
        ...startInput(),
        commandId: `start-unavailable-${unavailableBoundary}`,
        runId: `run-unavailable-${unavailableBoundary}`,
      });
      verificationAvailable = false;

      await assert.rejects(
        session.observe(),
        hasCode(unavailableBoundary === "authority" ? "EPOCH_STALE" : "LEASE_STALE"),
      );
      assert.equal(session.status(), "failed");
      assert.equal(fixture.activity().emergencyStopCount, 1);
    }
  });

  it("returns unavailable readiness when a read-only driver or authority probe fails or hangs", async () => {
    const fixture = createFixtureNativeDriver({
      osFamily: "windows",
      runIdentifier: "probe-unavailable",
    });
    const authorityFailure = new ComputerUseOsBackend({
      osFamily: "windows",
      driver: fixture.driver,
      authority: {
        async verify() {
          throw new Error("raw authority failure");
        },
      },
      leases: currentLease(),
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: allowAll(),
      clock: { now: () => 10_000 },
      logger: { write() {} },
      operationTimeoutMs: 5,
    });
    const authorityReport = await authorityFailure.readiness({
      deviceId: "device-1",
      helperInstanceId: "helper-1",
      serviceEpoch: 7,
      persistenceGeneration: 11,
    });
    assert.equal(authorityReport.status, "unavailable");
    assert.equal(
      authorityReport.checks.find((check) => check.name === "service-epoch")?.status,
      "fail",
    );

    const hangingDriver: NativeComputerUseDriver = {
      ...fixture.driver,
      probe: () => new Promise(() => {}),
    };
    const driverFailure = new ComputerUseOsBackend({
      osFamily: "windows",
      driver: hangingDriver,
      authority: currentAuthority(),
      leases: currentLease(),
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: allowAll(),
      clock: { now: () => 10_000 },
      logger: { write() {} },
      operationTimeoutMs: 5,
    });
    const driverReport = await driverFailure.readiness({
      deviceId: "device-1",
      helperInstanceId: "helper-1",
      serviceEpoch: 7,
      persistenceGeneration: 11,
    });
    assert.equal(driverReport.status, "unavailable");
    assert.deepEqual(
      driverReport.checks.map((check) => check.status),
      ["fail", "fail", "fail", "fail", "fail", "fail", "fail"],
    );
  });

  it("stops before input on display change, helper crash, lock, permission loss, and timeout", async () => {
    const scenarios = [
      {
        name: "display",
        mutate: (fixture: ReturnType<typeof createFixtureNativeDriver>) =>
          fixture.setDisplayFingerprint("display:changed"),
        code: "DISPLAY_CHANGED",
      },
      {
        name: "crash",
        mutate: (fixture: ReturnType<typeof createFixtureNativeDriver>) => fixture.crashHelper(),
        code: "HELPER_CRASHED",
      },
      {
        name: "locked",
        mutate: (fixture: ReturnType<typeof createFixtureNativeDriver>) => fixture.lockSession(),
        code: "SESSION_LOCKED",
      },
      {
        name: "permission",
        mutate: (fixture: ReturnType<typeof createFixtureNativeDriver>) =>
          fixture.denyPermission("input"),
        code: "PERMISSION_DENIED",
      },
    ] as const;

    for (const scenario of scenarios) {
      const fixture = createFixtureNativeDriver({
        osFamily: "windows",
        runIdentifier: scenario.name,
      });
      const session = await createBackend(fixture.driver).start({
        ...startInput(),
        commandId: `start-${scenario.name}`,
        runId: `run-${scenario.name}`,
      });
      scenario.mutate(fixture);
      await assert.rejects(session.click({ controlId: "submit" }), hasCode(scenario.code));
      assert.equal(fixture.activity().actionCount, 0);
      assert.equal(fixture.activity().emergencyStopCount, 1);
    }

    const fixture = createFixtureNativeDriver({
      osFamily: "windows",
      runIdentifier: "timeout",
    });
    let now = 10_000;
    const backend = new ComputerUseOsBackend({
      osFamily: "windows",
      driver: fixture.driver,
      authority: currentAuthority(),
      leases: currentLease(),
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: allowAll(),
      clock: { now: () => now },
      logger: { write() {} },
    });
    const session = await backend.start(startInput());
    now = 15_000;
    await assert.rejects(session.observe(), hasCode("SESSION_TIMEOUT"));
    assert.equal(session.status(), "timed-out");
    assert.equal(fixture.activity().emergencyStopCount, 1);
  });

  it("never puts sensitive text in authorization or structured logs", async () => {
    const secretText = "owner-password-like-value";
    const fixture = createFixtureNativeDriver({
      osFamily: "macos",
      runIdentifier: "redaction",
    });
    const requests: ComputerUseInputAuthorizationRequest[] = [];
    const logs: ComputerUseLogEvent[] = [];
    const backend = new ComputerUseOsBackend({
      osFamily: "macos",
      driver: fixture.driver,
      authority: currentAuthority(),
      leases: currentLease(),
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: {
        authorize(request) {
          requests.push(request);
          return {
            decision: "allow",
            authorizationId: "grant-task-1",
            fingerprint: request.fingerprint,
          };
        },
      },
      clock: { now: () => 10_000 },
      logger: { write: (event) => logs.push(event) },
    });
    const session = await backend.start({
      ...startInput(),
      commandId: "start-redaction",
      runId: "run-redaction",
    });
    await session.typeText({ controlId: "task-text", text: secretText });

    assert.equal(JSON.stringify(requests).includes(secretText), false);
    assert.equal(JSON.stringify(logs).includes(secretText), false);
    assert.equal(JSON.stringify(session.actionSummary()).includes(secretText), false);
    const summaryEvidence = session.captureActionSummary();
    assert.equal(Buffer.from(summaryEvidence.bytes).includes(Buffer.from(secretText)), false);
    assert.equal(summaryEvidence.mediaType, "application/json");
    assert.match(summaryEvidence.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(
      requests[0]?.action.kind === "type-text" ? requests[0].action.textSha256 : "",
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  it("revalidates authority and lease after authorization immediately before mutation", async () => {
    const fixture = createFixtureNativeDriver({
      osFamily: "windows",
      runIdentifier: "post-authorization-fence",
    });
    let leaseCurrent = true;
    const backend = new ComputerUseOsBackend({
      osFamily: "windows",
      driver: fixture.driver,
      authority: currentAuthority(),
      leases: {
        async verify(request) {
          return leaseCurrent
            ? {
                status: "current",
                leaseId: request.lease.leaseId,
                fencingToken: request.lease.fencingToken,
                verifiedAtMs: 10_000,
              }
            : {
                status: "stale",
                reason: "Authorization outlived the desktop lease.",
                verifiedAtMs: 10_001,
              };
        },
      },
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: {
        authorize(request) {
          leaseCurrent = false;
          return {
            decision: "allow",
            authorizationId: "grant-that-outlived-lease",
            fingerprint: request.fingerprint,
          };
        },
      },
      clock: { now: () => 10_000 },
      logger: { write() {} },
    });
    const session = await backend.start({
      ...startInput(),
      commandId: "start-post-auth",
      runId: "run-post-auth",
    });

    await assert.rejects(session.click({ controlId: "option-alpha" }), hasCode("LEASE_STALE"));
    assert.equal(fixture.activity().actionCount, 0);
    assert.equal(fixture.activity().emergencyStopCount, 1);
  });

  it("rejects denial, approval-required, and mismatched authorization without native input", async () => {
    const cases = [
      {
        name: "deny",
        code: "AUTHORIZATION_DENIED",
        proof: (request: ComputerUseInputAuthorizationRequest) => ({
          decision: "deny" as const,
          authorizationId: "denial-1",
          fingerprint: request.fingerprint,
        }),
      },
      {
        name: "approval",
        code: "AUTHORIZATION_REQUIRED",
        proof: (request: ComputerUseInputAuthorizationRequest) => ({
          decision: "require-approval" as const,
          authorizationId: "approval-request-1",
          fingerprint: request.fingerprint,
        }),
      },
      {
        name: "mismatch",
        code: "AUTHORIZATION_INVALID",
        proof: (_request: ComputerUseInputAuthorizationRequest) => ({
          decision: "allow" as const,
          authorizationId: "wrong-grant",
          fingerprint: `sha256:${"0".repeat(64)}` as const,
        }),
      },
    ] as const;

    for (const testCase of cases) {
      const fixture = createFixtureNativeDriver({
        osFamily: "windows",
        runIdentifier: `authorization-${testCase.name}`,
      });
      const backend = new ComputerUseOsBackend({
        osFamily: "windows",
        driver: fixture.driver,
        authority: currentAuthority(),
        leases: currentLease(),
        startHistory: new InMemoryComputerUseStartHistory(),
        authorizer: { authorize: testCase.proof },
        clock: { now: () => 10_000 },
        logger: { write() {} },
      });
      const session = await backend.start({
        ...startInput(),
        commandId: `start-authorization-${testCase.name}`,
        runId: `run-authorization-${testCase.name}`,
      });

      await assert.rejects(session.click({ controlId: "submit" }), hasCode(testCase.code));
      assert.equal(session.status(), "active");
      assert.equal(fixture.activity().actionCount, 0);
    }
  });

  it("makes cancel and emergency stop idempotent and prevents every later input", async () => {
    for (const stop of ["cancel", "emergencyStop"] as const) {
      const fixture = createFixtureNativeDriver({
        osFamily: "macos",
        runIdentifier: `stop-${stop}`,
      });
      const session = await createBackend(fixture.driver).start({
        ...startInput(),
        commandId: `start-${stop}`,
        runId: `run-${stop}`,
      });

      await session[stop]();
      await session[stop]();
      assert.equal(session.status(), stop === "cancel" ? "cancelled" : "emergency-stopped");
      await assert.rejects(
        session.click({ controlId: "submit" }),
        hasCode(stop === "cancel" ? "SESSION_CANCELLED" : "SESSION_EMERGENCY_STOPPED"),
      );
      assert.equal(fixture.activity().actionCount, 0);
      assert.equal(fixture.activity().cancelCount, stop === "cancel" ? 1 : 0);
      assert.equal(fixture.activity().emergencyStopCount, stop === "emergencyStop" ? 1 : 0);
    }
  });

  it("turns a hung native operation into a fail-closed timeout", async () => {
    const fixture = createFixtureNativeDriver({
      osFamily: "windows",
      runIdentifier: "hung-driver",
    });
    const hangingDriver: NativeComputerUseDriver = {
      ...fixture.driver,
      act(context) {
        return new Promise((_resolve, reject) => {
          const rejectTimeout = () =>
            reject(new NativeDriverError("TIMEOUT", "Fixture operation aborted."));
          if (context.signal.aborted) {
            rejectTimeout();
            return;
          }
          context.signal.addEventListener("abort", rejectTimeout, { once: true });
        });
      },
    };
    const backend = new ComputerUseOsBackend({
      osFamily: "windows",
      driver: hangingDriver,
      authority: currentAuthority(),
      leases: currentLease(),
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: allowAll(),
      clock: { now: () => 10_000 },
      logger: { write() {} },
      operationTimeoutMs: 5,
    });
    const session = await backend.start({
      ...startInput(),
      commandId: "start-hung-driver",
      runId: "run-hung-driver",
    });

    await assert.rejects(session.click({ controlId: "option-alpha" }), hasCode("SESSION_TIMEOUT"));
    assert.equal(session.status(), "timed-out");
    assert.equal(fixture.activity().emergencyStopCount, 1);
    assert.equal(fixture.activity().actionCount, 0);
  });

  it("keeps a headless Linux Device healthy while Computer Use is accurately unavailable", async () => {
    const driver = createHeadlessLinuxNativeDriver();
    const backend = new ComputerUseOsBackend({
      osFamily: "linux",
      driver,
      authority: currentAuthority(),
      leases: currentLease(),
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: allowAll(),
      clock: { now: () => 10_000 },
      logger: { write() {} },
    });
    const request = {
      deviceId: "nas-device",
      helperInstanceId: "headless-no-helper",
      serviceEpoch: 1,
      persistenceGeneration: 11,
    };
    const report = await backend.readiness(request);
    assert.equal(report.status, "unavailable");
    assert.equal(report.displayFingerprint, null);
    assert.equal(
      report.checks.find((check) => check.name === "interactive-session")?.status,
      "fail",
    );
    await assert.rejects(
      backend.start({
        ...startInput(),
        ...request,
        commandId: "headless-start",
        deviceId: "nas-device",
        runId: "nas-run",
      }),
      hasCode("NOT_READY"),
    );
  });
});

function createBackend(
  driver: ReturnType<typeof createFixtureNativeDriver>["driver"],
  history = new InMemoryComputerUseStartHistory(),
): ComputerUseOsBackend {
  return new ComputerUseOsBackend({
    osFamily: driver.osFamily,
    driver,
    authority: currentAuthority(),
    leases: currentLease(),
    startHistory: history,
    authorizer: {
      authorize(request) {
        return {
          decision: "allow",
          authorizationId: "authorization-1",
          fingerprint: request.fingerprint,
        };
      },
    },
    clock: { now: () => 10_000 },
    logger: { write() {} },
  });
}

function startInput() {
  return {
    commandId: "start-windows",
    taskId: "task-1",
    deviceId: "device-1",
    runId: "run-windows",
    helperInstanceId: "helper-1",
    serviceEpoch: 7,
    persistenceGeneration: 11,
    lease: {
      resourceName: "desktop-session" as const,
      capacity: 1 as const,
      leaseId: "lease-1",
      fencingToken: 4,
      expiresAtMs: 20_000,
    },
    timeoutMs: 5_000,
  };
}

function allowAll() {
  return {
    authorize(request: ComputerUseInputAuthorizationRequest) {
      return {
        decision: "allow" as const,
        authorizationId: "authorization-1",
        fingerprint: request.fingerprint,
      };
    },
  };
}

function hasCode(code: ComputerUseOsError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ComputerUseOsError && error.code === code;
}

function currentAuthority(): DesktopAuthorityPort {
  return {
    async verify(request) {
      return {
        status: "current",
        helperInstanceId: request.helperInstanceId,
        serviceEpoch: request.serviceEpoch,
        persistenceGeneration: request.persistenceGeneration,
        verifiedAtMs: 10_000,
      };
    },
  };
}

function currentLease(): DesktopLeasePort {
  return {
    async verify(request) {
      return {
        status: "current",
        leaseId: request.lease.leaseId,
        fencingToken: request.lease.fencingToken,
        verifiedAtMs: 10_000,
      };
    },
  };
}
