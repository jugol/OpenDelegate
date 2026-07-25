import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MacOsNativeComputerUseDriver,
  NativeDriverError,
  type MacOsAuthenticatedHelperSession,
  type MacOsNativeHelperPort,
  type NativeComputerUseAction,
  type NativeDriverControlContext,
  type NativeDriverExecutionContext,
  type ReadinessCheckName,
} from "../src/index.ts";
import { authorizedContext } from "./authorized-context.ts";

const SESSION = Object.freeze({
  authentication: "adr-0011-ed25519-v2" as const,
  helperInstanceId: "helper-aqua-501",
  osSessionIdentity: "aqua:501",
  releaseVersion: "0.1.0-alpha.1",
  serviceEpoch: 17,
});

describe("macOS native Computer Use driver", () => {
  it("binds every native operation to the authenticated helper identity, epoch, and display", async () => {
    const calls: string[] = [];
    const helper = readyHelper(SESSION, calls);
    const driver = new MacOsNativeComputerUseDriver({ helper });
    const context = executionContext();

    const probe = await driver.probe();
    const observation = await driver.observe(context);
    const capture = await driver.capture(context);
    const action = { kind: "click", controlId: "submit" } as const;
    const receipt = await driver.act(authorizedContext(context, action), action);
    await driver.cancel(controlContext());
    await driver.emergencyStop(controlContext());

    assert.equal(probe.backendId, "macos-ax-screencapturekit-cgevent");
    assert.equal(probe.helperInstanceId, SESSION.helperInstanceId);
    assert.equal(probe.serviceEpoch, SESSION.serviceEpoch);
    assert.equal(observation.displayFingerprint, "display:macos-fixture");
    assert.equal(capture.displayFingerprint, "display:macos-fixture");
    assert.equal(receipt.displayFingerprint, "display:macos-fixture");
    assert.deepEqual(calls, ["probe", "observe", "capture", "act", "cancel", "emergency-stop"]);
  });

  it("refuses an unauthenticated helper or a context from another helper epoch before native input", async () => {
    const calls: string[] = [];
    const unauthenticated = {
      ...SESSION,
      authentication: "none",
    } as unknown as MacOsAuthenticatedHelperSession;

    assert.throws(
      () => new MacOsNativeComputerUseDriver({ helper: readyHelper(unauthenticated, calls) }),
      hasNativeCode("UNAVAILABLE"),
    );

    const driver = new MacOsNativeComputerUseDriver({ helper: readyHelper(SESSION, calls) });
    await assert.rejects(
      driver.act(
        authorizedContext(
          {
            ...executionContext(),
            serviceEpoch: SESSION.serviceEpoch + 1,
          },
          { kind: "click", controlId: "submit" },
        ),
        { kind: "click", controlId: "submit" },
      ),
      hasNativeCode("HELPER_CRASHED"),
    );
    assert.deepEqual(calls, []);
  });

  it("fails closed when the helper response changes display or authenticated session binding", async () => {
    const displayChanged = readyHelper(SESSION, []);
    displayChanged.observe = async () => ({
      accessibilityTree: [],
      displayFingerprint: "display:replacement",
    });
    const driver = new MacOsNativeComputerUseDriver({ helper: displayChanged });

    await assert.rejects(driver.observe(executionContext()), hasNativeCode("DISPLAY_CHANGED"));

    const replacedSession = { ...SESSION, helperInstanceId: "helper-replaced" };
    const helper = readyHelper(SESSION, []);
    helper.currentSession = () => replacedSession;
    await assert.rejects(
      new MacOsNativeComputerUseDriver({ helper }).capture(executionContext()),
      hasNativeCode("HELPER_CRASHED"),
    );
  });

  it("passes typed text only to the final native child call and never includes it in an error", async () => {
    const secret = "owner-secret-that-must-not-be-logged";
    let nativeAction: NativeComputerUseAction | undefined;
    const helper = readyHelper(SESSION, []);
    helper.act = async (_context, action) => {
      nativeAction = action;
      throw new Error(`native helper rejected a payload of ${secret.length} bytes`);
    };
    const driver = new MacOsNativeComputerUseDriver({ helper });

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

  it("maps the helper's bounded native failure codes without surfacing private diagnostics", async () => {
    for (const code of [
      "CANCELLED",
      "DISPLAY_CHANGED",
      "EMERGENCY_STOPPED",
      "HELPER_CRASHED",
      "PERMISSION_DENIED",
      "SESSION_LOCKED",
      "TIMEOUT",
      "UNAVAILABLE",
    ] as const) {
      const helper = readyHelper(SESSION, []);
      helper.observe = async () => {
        throw new NativeDriverError(code, "sanitized native boundary failure");
      };
      const driver = new MacOsNativeComputerUseDriver({ helper });

      await assert.rejects(driver.observe(executionContext()), hasNativeCode(code));
    }
  });
});

function readyHelper(
  session: MacOsAuthenticatedHelperSession,
  calls: string[],
): MacOsNativeHelperPort & { currentSession: () => MacOsAuthenticatedHelperSession } {
  return {
    currentSession: () => session,
    async probe() {
      calls.push("probe");
      return {
        osFamily: "macos",
        backendId: "macos-ax-screencapturekit-cgevent",
        helperInstanceId: session.helperInstanceId,
        serviceEpoch: session.serviceEpoch,
        displayFingerprint: "display:macos-fixture",
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
        displayFingerprint: "display:macos-fixture",
        accessibilityTree: [],
      };
    },
    async capture() {
      calls.push("capture");
      return {
        displayFingerprint: "display:macos-fixture",
        mediaType: "image/png",
        width: 1,
        height: 1,
        bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      };
    },
    async act() {
      calls.push("act");
      return {
        displayFingerprint: "display:macos-fixture",
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
    evidence: `${name} passed in the authenticated Aqua helper.`,
  };
}

function executionContext(): NativeDriverExecutionContext {
  return {
    executionHandleId: "handle-macos",
    taskId: "task-macos",
    deviceId: "device-macos",
    runId: "run-macos",
    helperInstanceId: SESSION.helperInstanceId,
    serviceEpoch: SESSION.serviceEpoch,
    persistenceGeneration: 23,
    leaseId: "lease-macos",
    fencingToken: 5,
    expectedDisplayFingerprint: "display:macos-fixture",
    signal: new AbortController().signal,
  };
}

function controlContext(): NativeDriverControlContext {
  return {
    executionHandleId: "handle-macos",
    taskId: "task-macos",
    deviceId: "device-macos",
    runId: "run-macos",
  };
}

function hasNativeCode(code: NativeDriverError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof NativeDriverError && error.code === code;
}
