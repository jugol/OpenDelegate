import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NativeDriverError,
  createWindowsNativeComputerUseDriver,
  type NativeDriverExecutionContext,
  type WindowsAuthenticatedHelperCommand,
  type WindowsAuthenticatedHelperPort,
  type WindowsAuthenticatedHelperResponse,
} from "../src/index.ts";
import { authorizedContext } from "./authorized-context.ts";

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

describe("Windows native Computer Use driver", () => {
  it("maps one authenticated interactive helper into the shared native-driver contract", async () => {
    const helper = new RecordingWindowsHelper();
    const driver = createWindowsNativeComputerUseDriver({
      helper,
      expectedHelperInstanceId: "helper-windows-1",
      expectedServiceEpoch: 17,
      expectedSessionIdentity: "windows-session:2:owner-sid-digest",
      releaseVersion: "0.1.0-alpha.1",
    });

    const probe = await driver.probe();
    assert.equal(probe.osFamily, "windows");
    assert.equal(probe.backendId, "windows-uia-wgc-sendinput-v1");
    assert.equal(probe.displayFingerprint, "windows-display:test");
    assert.deepEqual(
      probe.checks.map((check) => [check.name, check.status]),
      [
        ["interactive-session", "pass"],
        ["unlocked-session", "pass"],
        ["screen-capture", "pass"],
        ["accessibility", "pass"],
        ["input", "pass"],
        ["helper-authentication", "pass"],
      ],
    );

    const context = executionContext();
    const observation = await driver.observe(context);
    assert.equal(observation.fixture?.runIdentifier, "windows-native-fixture");
    assert.deepEqual(
      observation.accessibilityTree.map((control) => control.controlId),
      ["task-text", "option-beta", "submit"],
    );

    const capture = await driver.capture(context);
    assert.equal(capture.displayFingerprint, "windows-display:test");
    assert.deepEqual(capture.bytes, PNG);

    const clickAction = { kind: "click", controlId: "submit" } as const;
    await driver.act(authorizedContext(context, clickAction), clickAction);
    const typeAction = {
      kind: "type-text",
      controlId: "task-text",
      text: "sensitive text only at the native boundary",
    } as const;
    await driver.act(authorizedContext(context, typeAction), typeAction);
    await driver.cancel(controlContext());
    await driver.emergencyStop(controlContext());

    assert.deepEqual(
      helper.commands.map((command) => command.kind),
      ["probe", "observe", "capture", "act", "act", "cancel", "emergency-stop"],
    );
    const typeCommand = helper.commands[4];
    assert.equal(typeCommand?.kind, "act");
    if (typeCommand?.kind === "act") {
      assert.equal(typeCommand.action.kind, "type-text");
      if (typeCommand.action.kind === "type-text") {
        assert.equal(typeCommand.action.text, "sensitive text only at the native boundary");
      }
    }
    assert.doesNotMatch(
      JSON.stringify(helper.commands.filter((command) => command.kind !== "act")),
      /sensitive text/u,
    );
  });

  it("fails closed when the helper authentication transcript or session binding changes", async () => {
    const driver = createWindowsNativeComputerUseDriver({
      helper: new RecordingWindowsHelper({
        helperInstanceId: "unexpected-helper",
      }),
      expectedHelperInstanceId: "helper-windows-1",
      expectedServiceEpoch: 17,
      expectedSessionIdentity: "windows-session:2:owner-sid-digest",
      releaseVersion: "0.1.0-alpha.1",
    });

    const probe = await driver.probe();
    assert.equal(probe.displayFingerprint, null);
    assert.equal(
      probe.checks.find((check) => check.name === "helper-authentication")?.status,
      "fail",
    );

    await assert.rejects(
      driver.observe(executionContext()),
      (error: unknown) =>
        error instanceof NativeDriverError &&
        error.code === "HELPER_CRASHED" &&
        !error.message.includes("unexpected-helper"),
    );
  });

  it("rejects a changed display and forwards cancellation without accepting later input", async () => {
    const helper = new RecordingWindowsHelper({
      displayFingerprint: "windows-display:changed",
    });
    const driver = createWindowsNativeComputerUseDriver({
      helper,
      expectedHelperInstanceId: "helper-windows-1",
      expectedServiceEpoch: 17,
      expectedSessionIdentity: "windows-session:2:owner-sid-digest",
      releaseVersion: "0.1.0-alpha.1",
    });
    const context = executionContext();

    await assert.rejects(
      driver.capture(context),
      (error: unknown) => error instanceof NativeDriverError && error.code === "DISPLAY_CHANGED",
    );

    await driver.cancel(controlContext());
    await assert.rejects(
      driver.act(authorizedContext(context, { kind: "click", controlId: "submit" }), {
        kind: "click",
        controlId: "submit",
      }),
      (error: unknown) => error instanceof NativeDriverError && error.code === "CANCELLED",
    );
  });

  it("accepts an empty textbox value before the owner enters fixture text", async () => {
    const helper = new RecordingWindowsHelper({
      observation: {
        accessibilityTree: [
          {
            controlId: "task-text",
            role: "textbox",
            label: "Task text",
            value: "",
          },
        ],
        fixture: {
          runIdentifier: "windows-native-fixture",
          state: "editing",
          textValue: "",
          selectedOption: null,
          resultFile: null,
        },
      },
    });
    const driver = createWindowsNativeComputerUseDriver({
      helper,
      expectedHelperInstanceId: "helper-windows-1",
      expectedServiceEpoch: 17,
      expectedSessionIdentity: "windows-session:2:owner-sid-digest",
      releaseVersion: "0.1.0-alpha.1",
    });

    const observation = await driver.observe(executionContext());

    assert.equal(observation.accessibilityTree[0]?.value, "");
    assert.equal(observation.fixture?.textValue, "");
  });

  it("reports cancellation when an in-flight helper request is aborted", async () => {
    const driver = createWindowsNativeComputerUseDriver({
      helper: {
        execute(_command, signal) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("The IPC transport closed.")),
              { once: true },
            );
          });
        },
      },
      expectedHelperInstanceId: "helper-windows-1",
      expectedServiceEpoch: 17,
      expectedSessionIdentity: "windows-session:2:owner-sid-digest",
      releaseVersion: "0.1.0-alpha.1",
    });
    const abort = new AbortController();
    const pending = driver.observe({
      ...executionContext(),
      signal: abort.signal,
    });

    abort.abort();

    await assert.rejects(
      pending,
      (error: unknown) => error instanceof NativeDriverError && error.code === "CANCELLED",
    );
  });
});

class RecordingWindowsHelper implements WindowsAuthenticatedHelperPort {
  public readonly commands: WindowsAuthenticatedHelperCommand[] = [];
  readonly #overrides: Partial<WindowsAuthenticatedHelperResponse>;
  #cancelled = false;

  public constructor(overrides: Partial<WindowsAuthenticatedHelperResponse> = {}) {
    this.#overrides = overrides;
  }

  public async execute(
    command: WindowsAuthenticatedHelperCommand,
  ): Promise<WindowsAuthenticatedHelperResponse> {
    this.commands.push(command);
    if (command.kind === "cancel") {
      this.#cancelled = true;
    }
    if (command.kind === "act" && this.#cancelled) {
      throw new NativeDriverError("CANCELLED", "The native input operation was cancelled.");
    }

    return {
      protocolVersion: 1,
      authenticated: true,
      helperInstanceId: "helper-windows-1",
      serviceEpoch: 17,
      sessionIdentity: "windows-session:2:owner-sid-digest",
      releaseVersion: "0.1.0-alpha.1",
      displayFingerprint: "windows-display:test",
      kind: command.kind,
      sequence: command.kind === "act" ? 1 : 0,
      readiness: {
        interactiveSession: true,
        unlockedSession: true,
        captureSupported: true,
        captureTargetSelected: true,
        frameReady: true,
        accessibilityAvailable: true,
        fixtureControlsVisible: true,
        inputAvailable: true,
        emergencyStopAvailable: true,
        targetIntegrity: "same-or-lower",
      },
      observation: {
        accessibilityTree: [
          {
            controlId: "task-text",
            role: "textbox",
            label: "Task text",
            value: "fixture value",
          },
          {
            controlId: "option-beta",
            role: "radio",
            label: "Beta",
            selected: true,
          },
          {
            controlId: "submit",
            role: "button",
            label: "Complete",
          },
        ],
        fixture: {
          runIdentifier: "windows-native-fixture",
          state: "editing",
          textValue: "fixture value",
          selectedOption: "Beta",
          resultFile: null,
        },
      },
      capture: {
        mediaType: "image/png",
        width: 640,
        height: 480,
        bytes: PNG,
      },
      ...this.#overrides,
    };
  }
}

function executionContext(): NativeDriverExecutionContext {
  return {
    executionHandleId: "handle-windows-native",
    taskId: "task-windows-native",
    deviceId: "device-windows-native",
    runId: "run-windows-native",
    helperInstanceId: "helper-windows-1",
    serviceEpoch: 17,
    persistenceGeneration: 23,
    leaseId: "lease-windows-native",
    fencingToken: 9,
    expectedDisplayFingerprint: "windows-display:test",
    signal: new AbortController().signal,
  };
}

function controlContext() {
  return {
    executionHandleId: "handle-windows-native",
    taskId: "task-windows-native",
    deviceId: "device-windows-native",
    runId: "run-windows-native",
  };
}
