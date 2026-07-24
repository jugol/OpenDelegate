import assert from "node:assert/strict";
import test from "node:test";

import { createServiceDiagnostic, evaluateSessionHelperReadiness } from "../src/index.ts";
import { linuxConfiguration } from "./fixtures.ts";

const GRANTED = {
  accessibility: "granted",
  input: "granted",
  screenCapture: "granted",
} as const;

test("logged-out and locked desktops remove Computer Use without degrading the core", () => {
  const loggedOut = evaluateSessionHelperReadiness({
    helperProcess: "stopped",
    loggedIn: false,
    desktopUnlocked: false,
    permissions: GRANTED,
  });
  assert.equal(loggedOut.session, "logged-out");
  assert.equal(loggedOut.computerUse, "unavailable");
  assert.equal(loggedOut.headlessWorkAvailable, true);

  const locked = evaluateSessionHelperReadiness({
    helperProcess: "running",
    loggedIn: true,
    desktopUnlocked: false,
    permissions: GRANTED,
  });
  assert.equal(locked.session, "locked");
  assert.equal(locked.computerUse, "unavailable");
  assert.equal(locked.headlessWorkAvailable, true);
});

test("permission denial and helper loss are separately diagnosable", () => {
  const denied = evaluateSessionHelperReadiness({
    helperProcess: "running",
    loggedIn: true,
    desktopUnlocked: true,
    permissions: {
      ...GRANTED,
      screenCapture: "denied",
    },
  });
  assert.equal(denied.session, "permission-denied");
  assert.deepEqual(denied.missingPermissions, ["screenCapture"]);

  const crashed = evaluateSessionHelperReadiness({
    helperProcess: "stopped",
    loggedIn: true,
    desktopUnlocked: true,
    permissions: GRANTED,
  });
  assert.equal(crashed.session, "helper-unavailable");
});

test("diagnostics expose log locations, versions, readiness, and rollback without Secret values", () => {
  const diagnostic = createServiceDiagnostic({
    configuration: linuxConfiguration(),
    activeVersion: "1.2.3",
    retainedVersions: ["1.2.2"],
    coreSupervisorState: "running",
    helperSupervisorState: "not-loaded",
    readiness: evaluateSessionHelperReadiness({
      helperProcess: "stopped",
      loggedIn: false,
      desktopUnlocked: false,
      permissions: GRANTED,
    }),
    lastRollback: {
      attemptedAt: "2026-07-24T10:00:00.000Z",
      fromVersion: "1.3.0",
      toVersion: "1.2.3",
      outcome: "succeeded",
      failedStepId: "health-core",
    },
  });

  assert.equal(diagnostic.core.status, "running");
  assert.equal(diagnostic.helper.status, "not-loaded");
  assert.equal(diagnostic.readiness.session, "logged-out");
  assert.equal(diagnostic.versions.active, "1.2.3");
  assert.equal(diagnostic.rollback?.outcome, "succeeded");
  assert.equal(diagnostic.logs.core.stdout, "/var/log/opendelegate/core.stdout.log");
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /secret:\/\//);
  assert.doesNotMatch(serialized, /device-identity/);
});
