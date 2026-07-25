import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LinuxNativeComputerUseDriver,
  NativeDriverError,
  type LinuxAuthenticatedHelperSession,
  type LinuxNativeHelperPort,
  type NativeComputerUseAction,
  type NativeDriverControlContext,
  type NativeDriverExecutionContext,
  type ReadinessCheckName,
} from "../src/index.ts";
import { authorizedContext } from "./authorized-context.ts";

const SESSION = Object.freeze({
  authentication: "adr-0011-ed25519-v2" as const,
  helperInstanceId: "helper-gnome-1000",
  osSessionIdentity: "wayland:1000:seat0",
  releaseVersion: "0.1.0-alpha.1",
  serviceEpoch: 19,
});

describe("Ubuntu GNOME Wayland native Computer Use driver", () => {
  it("binds native operations to the authenticated helper, portal display, and supported target", async () => {
    const calls: string[] = [];
    const driver = new LinuxNativeComputerUseDriver({ helper: readyHelper(SESSION, calls) });

    const probe = await driver.probe();
    const observation = await driver.observe(executionContext());
    const capture = await driver.capture(executionContext());
    const action = { kind: "click", controlId: "submit" } as const;
    const receipt = await driver.act(authorizedContext(executionContext(), action), action);
    await driver.cancel(controlContext());
    await driver.emergencyStop(controlContext());

    assert.equal(probe.backendId, "linux-atspi-xdg-portal-pipewire");
    assert.equal(probe.linuxTarget, "ubuntu-24.04-gnome-wayland");
    assert.equal(probe.helperInstanceId, SESSION.helperInstanceId);
    assert.equal(probe.serviceEpoch, SESSION.serviceEpoch);
    assert.equal(observation.displayFingerprint, "portal-stream:42:1920x1080");
    assert.equal(capture.displayFingerprint, "portal-stream:42:1920x1080");
    assert.equal(receipt.sequence, 1);
    assert.deepEqual(calls, ["probe", "observe", "capture", "act", "cancel", "emergency-stop"]);
  });

  it("rejects unauthenticated, headless, and non-GNOME helper claims before input", async () => {
    const unauthenticated = {
      ...SESSION,
      authentication: "none",
    } as unknown as LinuxAuthenticatedHelperSession;
    assert.throws(
      () => new LinuxNativeComputerUseDriver({ helper: readyHelper(unauthenticated, []) }),
      hasNativeCode("UNAVAILABLE"),
    );

    for (const linuxTarget of ["headless", "ubuntu-22.04-gnome-wayland"] as const) {
      const helper = readyHelper(SESSION, []);
      helper.probe = async () => ({
        ...(await readyHelper(SESSION, []).probe()),
        linuxTarget: linuxTarget as "headless",
      });
      const driver = new LinuxNativeComputerUseDriver({ helper });
      await assert.rejects(driver.probe(), hasNativeCode("UNAVAILABLE"));
    }
  });

  it("fails closed when display, authenticated session, or cancellation binding changes", async () => {
    const displayChanged = readyHelper(SESSION, []);
    displayChanged.observe = async () => ({
      accessibilityTree: [],
      displayFingerprint: "portal-stream:99:1280x720",
    });
    await assert.rejects(
      new LinuxNativeComputerUseDriver({ helper: displayChanged }).observe(executionContext()),
      hasNativeCode("DISPLAY_CHANGED"),
    );

    const helper = readyHelper(SESSION, []);
    helper.currentSession = () => ({ ...SESSION, serviceEpoch: SESSION.serviceEpoch + 1 });
    await assert.rejects(
      new LinuxNativeComputerUseDriver({ helper }).capture(executionContext()),
      hasNativeCode("HELPER_CRASHED"),
    );

    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(
      new LinuxNativeComputerUseDriver({ helper: readyHelper(SESSION, []) }).act(
        authorizedContext(
          { ...executionContext(), signal: cancellation.signal },
          { kind: "click", controlId: "submit" },
        ),
        { kind: "click", controlId: "submit" },
      ),
      hasNativeCode("CANCELLED"),
    );
  });

  it("keeps typed text at the final native boundary and redacts helper diagnostics", async () => {
    const secret = "owner-private-linux-password";
    let nativeAction: NativeComputerUseAction | undefined;
    const helper = readyHelper(SESSION, []);
    helper.act = async (_context, action) => {
      nativeAction = action;
      throw new Error(`portal rejected ${secret}`);
    };
    const driver = new LinuxNativeComputerUseDriver({ helper });

    await assert.rejects(
      driver.act(
        authorizedContext(executionContext(), {
          kind: "type-text",
          controlId: "task-text",
          text: secret,
        }),
        { kind: "type-text", controlId: "task-text", text: secret },
      ),
      (error: unknown) => {
        assert.ok(error instanceof NativeDriverError);
        assert.equal(error.code, "HELPER_CRASHED");
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    assert.deepEqual(nativeAction, {
      kind: "type-text",
      controlId: "task-text",
      text: secret,
    });
  });
});

function readyHelper(
  session: LinuxAuthenticatedHelperSession,
  calls: string[],
): LinuxNativeHelperPort & { currentSession: () => LinuxAuthenticatedHelperSession } {
  return {
    currentSession: () => session,
    async probe() {
      calls.push("probe");
      return {
        osFamily: "linux",
        backendId: "linux-atspi-xdg-portal-pipewire",
        helperInstanceId: session.helperInstanceId,
        serviceEpoch: session.serviceEpoch,
        displayFingerprint: "portal-stream:42:1920x1080",
        linuxTarget: "ubuntu-24.04-gnome-wayland",
        checks: [
          check("interactive-session"),
          check("unlocked-session"),
          check("screen-capture"),
          check("accessibility"),
          check("input"),
          check("helper-authentication"),
        ],
      };
    },
    async observe() {
      calls.push("observe");
      return {
        displayFingerprint: "portal-stream:42:1920x1080",
        accessibilityTree: [],
      };
    },
    async capture() {
      calls.push("capture");
      return {
        displayFingerprint: "portal-stream:42:1920x1080",
        mediaType: "image/png",
        width: 1,
        height: 1,
        bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      };
    },
    async act() {
      calls.push("act");
      return {
        displayFingerprint: "portal-stream:42:1920x1080",
        sequence: 1,
      };
    },
    async cancel() {
      calls.push("cancel");
    },
    async emergencyStop() {
      calls.push("emergency-stop");
    },
  };
}

function check(name: ReadinessCheckName) {
  return {
    name,
    status: "pass" as const,
    evidence: `${name} passed in the authenticated GNOME helper.`,
  };
}

function executionContext(): NativeDriverExecutionContext {
  return {
    executionHandleId: "handle-linux",
    taskId: "task-linux",
    deviceId: "device-linux",
    runId: "run-linux",
    helperInstanceId: SESSION.helperInstanceId,
    serviceEpoch: SESSION.serviceEpoch,
    persistenceGeneration: 29,
    leaseId: "lease-linux",
    fencingToken: 7,
    expectedDisplayFingerprint: "portal-stream:42:1920x1080",
    signal: new AbortController().signal,
  };
}

function controlContext(): NativeDriverControlContext {
  return {
    executionHandleId: "handle-linux",
    taskId: "task-linux",
    deviceId: "device-linux",
    runId: "run-linux",
  };
}

function hasNativeCode(code: NativeDriverError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof NativeDriverError && error.code === code;
}
