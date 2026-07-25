import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  NativeDriverError,
  NodeMacOsNativeHelperChildTransportFactory,
  startMacOsNativeHelperChildProcess,
  type MacOsNativeHelperBinaryVerifier,
  type MacOsNativeHelperChildTransport,
  type MacOsNativeHelperChildTransportFactory,
  type MacOsNativeHelperWireRequest,
  type MacOsNativeHelperWireResponse,
} from "../src/index.ts";

const SESSION = Object.freeze({
  authentication: "adr-0011-ed25519-v2" as const,
  helperInstanceId: "helper-aqua-501",
  osSessionIdentity: "aqua:501",
  releaseVersion: "0.1.0-alpha.1",
  serviceEpoch: 17,
});
const EXPECTED_SHA256 = `sha256:${"a".repeat(64)}` as const;

describe("private macOS native helper child process", () => {
  it("starts only a verified target-native child bound to one authenticated helper session", async () => {
    const verified: string[] = [];
    const started: string[][] = [];
    const transport = fixtureTransport();
    const helper = await startMacOsNativeHelperChildProcess({
      authenticatedSession: SESSION,
      executablePath:
        "/Library/OpenDelegate/releases/0.1.0-alpha.1/libexec/opendelegate-macos-computer-use",
      expectedExecutableSha256: EXPECTED_SHA256,
      hostPlatform: "darwin",
      binaryVerifier: verifier(verified),
      transportFactory: factory(transport, started),
      parentProcessId: 4_321,
      requestIdSource: sequenceIds(),
    });

    const probe = await helper.probe();
    const observation = await helper.observe(executionContext());
    const capture = await helper.capture(executionContext());
    const receipt = await helper.act(executionContext(), {
      kind: "click",
      controlId: "submit",
    });

    assert.equal(probe.backendId, "macos-ax-screencapturekit-cgevent");
    assert.equal(observation.displayFingerprint, "display:macos-fixture");
    assert.deepEqual(Array.from(capture.bytes), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(receipt.sequence, 1);
    assert.deepEqual(verified, [
      "/Library/OpenDelegate/releases/0.1.0-alpha.1/libexec/opendelegate-macos-computer-use",
    ]);
    assert.deepEqual(started, [
      [
        "--stdio-child",
        "--helper-instance-id",
        SESSION.helperInstanceId,
        "--service-epoch",
        String(SESSION.serviceEpoch),
        "--os-session-identity",
        SESSION.osSessionIdentity,
        "--release-version",
        SESSION.releaseVersion,
        "--parent-pid",
        "4321",
      ],
    ]);
    assert.equal(
      transport.requests.every(
        (request) => JSON.stringify(request.binding) === JSON.stringify(SESSION),
      ),
      true,
    );
    assert.deepEqual(
      transport.requests.map((request) => request.operation),
      ["probe", "observe", "capture", "act"],
    );
    await helper.close();
    assert.equal(transport.closeCount, 1);
  });

  it("refuses a non-macOS host before filesystem inspection or child creation", async () => {
    let inspected = false;
    let spawned = false;

    await assert.rejects(
      startMacOsNativeHelperChildProcess({
        authenticatedSession: SESSION,
        executablePath: "C:\\untrusted\\helper.exe",
        expectedExecutableSha256: EXPECTED_SHA256,
        hostPlatform: "win32",
        binaryVerifier: {
          async verify() {
            inspected = true;
          },
        },
        transportFactory: {
          async start() {
            spawned = true;
            return fixtureTransport();
          },
        },
      }),
      hasNativeCode("UNAVAILABLE"),
    );
    assert.equal(inspected, false);
    assert.equal(spawned, false);
  });

  it("rejects helper replacement, sequence confusion, and oversized untrusted frames", async () => {
    for (const mutate of [
      (response: MacOsNativeHelperWireResponse) => ({
        ...response,
        binding: { ...SESSION, helperInstanceId: "replacement-helper" },
      }),
      (response: MacOsNativeHelperWireResponse) => ({ ...response, sequence: 99 }),
      (response: MacOsNativeHelperWireResponse) => ({
        ...response,
        wireBytes: 16 * 1024 * 1024 + 1,
      }),
    ]) {
      const transport = fixtureTransport(mutate);
      const helper = await startFixtureHelper(transport);
      await assert.rejects(helper.probe(), hasNativeCode("HELPER_CRASHED"));
      assert.equal(transport.closeCount, 1);
    }
  });

  it("never exposes native stderr or typed text in errors and terminates on an aborted request", async () => {
    const secret = "owner-private-password";
    const transport = fixtureTransport((response, request) =>
      request.operation === "act"
        ? {
            ...response,
            ok: false,
            result: undefined,
            error: {
              code: "PERMISSION_DENIED",
              message: `native stderr contained ${secret}`,
            },
          }
        : response,
    );
    const helper = await startFixtureHelper(transport);

    await assert.rejects(
      helper.act(executionContext(), {
        kind: "type-text",
        controlId: "task-text",
        text: secret,
      }),
      (error: unknown) => {
        assert.ok(error instanceof NativeDriverError);
        assert.equal(error.code, "PERMISSION_DENIED");
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    assert.equal(
      JSON.stringify(transport.requests.filter((request) => request.operation !== "act")).includes(
        secret,
      ),
      false,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      helper.observe({ ...executionContext(), signal: controller.signal }),
      hasNativeCode("CANCELLED"),
    );
    assert.equal(transport.closeCount, 1);
  });

  it("parses the untrusted observation payload and decodes fixture evidence bytes", async () => {
    const fixtureBytes = Buffer.from(
      JSON.stringify({
        runIdentifier: "run-macos",
        state: "success",
        textValue: "release proof",
        selectedOption: "Beta",
      }),
      "utf8",
    );
    const transport = fixtureTransport((response, request) =>
      request.operation === "observe"
        ? {
            ...response,
            result: {
              displayFingerprint: "display:macos-fixture",
              accessibilityTree: [
                {
                  controlId: "task-text",
                  role: "textbox",
                  label: "Task text",
                  value: "release proof",
                },
                {
                  controlId: "option-beta",
                  role: "radio",
                  label: "Beta",
                  selected: true,
                },
              ],
              fixture: {
                runIdentifier: "run-macos",
                state: "success",
                textValue: "release proof",
                selectedOption: "Beta",
                resultFile: {
                  filename: "fixture-result-run-macos.json",
                  mediaType: "application/json",
                  bytesBase64: fixtureBytes.toString("base64"),
                },
              },
            },
          }
        : response,
    );
    const helper = await startFixtureHelper(transport);

    const observation = await helper.observe(executionContext());

    assert.equal(observation.fixture?.resultFile?.filename, "fixture-result-run-macos.json");
    assert.deepEqual(
      Array.from(observation.fixture?.resultFile?.bytes ?? new Uint8Array()),
      Array.from(fixtureBytes),
    );
    await helper.close();
  });

  it("fails closed on malformed probe, observation, action, capture, and stop results", async () => {
    for (const operation of [
      "probe",
      "observe",
      "act",
      "capture",
      "cancel",
      "emergency-stop",
    ] as const) {
      const transport = fixtureTransport((response, request) =>
        request.operation === operation
          ? {
              ...response,
              result:
                operation === "probe"
                  ? { osFamily: "windows" }
                  : operation === "observe"
                    ? { displayFingerprint: "display:macos-fixture", accessibilityTree: "bad" }
                    : operation === "act"
                      ? { displayFingerprint: "display:macos-fixture", sequence: 0 }
                      : operation === "capture"
                        ? {
                            displayFingerprint: "display:macos-fixture",
                            mediaType: "image/png",
                            width: 1,
                            height: 1,
                            bytesBase64: "not base64",
                          }
                        : { stopped: false },
            }
          : response,
      );
      const helper = await startFixtureHelper(transport);
      const context = executionContext();
      const call =
        operation === "probe"
          ? helper.probe()
          : operation === "observe"
            ? helper.observe(context)
            : operation === "act"
              ? helper.act(context, { kind: "click", controlId: "submit" })
              : operation === "capture"
                ? helper.capture(context)
                : operation === "cancel"
                  ? helper.cancel(context)
                  : helper.emergencyStop(context);

      await assert.rejects(call, hasNativeCode("HELPER_CRASHED"));
      assert.equal(transport.closeCount, 1, `${operation} must terminate the private child`);
    }
  });

  it("reports an in-flight abort as cancellation before terminating the private child", async () => {
    const transport = await new NodeMacOsNativeHelperChildTransportFactory().start({
      executablePath: process.execPath,
      arguments: [
        fileURLToPath(new URL("../test-support/native-helper-hang.mjs", import.meta.url)),
      ],
      environment: {},
      exposeListener: false,
    });
    const controller = new AbortController();
    const pending = transport.request(
      {
        protocolVersion: 1,
        requestId: "abort-in-flight",
        sequence: 1,
        binding: SESSION,
        operation: "probe",
      },
      controller.signal,
    );

    controller.abort();

    await assert.rejects(pending, hasNativeCode("CANCELLED"));
    await transport.close();
  });

  it("fails closed instead of correlating two in-flight frames to one request ID", async () => {
    const transport = await new NodeMacOsNativeHelperChildTransportFactory().start({
      executablePath: process.execPath,
      arguments: [
        fileURLToPath(new URL("../test-support/native-helper-hang.mjs", import.meta.url)),
      ],
      environment: {},
      exposeListener: false,
    });
    const request = {
      protocolVersion: 1 as const,
      requestId: "duplicate-in-flight",
      sequence: 1,
      binding: SESSION,
      operation: "probe" as const,
    };

    const first = transport.request(request);
    const duplicate = transport.request(request);

    await assert.rejects(duplicate, hasNativeCode("HELPER_CRASHED"));
    await assert.rejects(first, hasNativeCode("HELPER_CRASHED"));
    await transport.close();
  });
});

function verifier(calls: string[]): MacOsNativeHelperBinaryVerifier {
  return {
    async verify(input) {
      calls.push(input.executablePath);
      assert.equal(input.expectedSha256, EXPECTED_SHA256);
      assert.equal(input.requireSignedCode, true);
    },
  };
}

function factory(
  transport: MacOsNativeHelperChildTransport,
  calls: string[][],
): MacOsNativeHelperChildTransportFactory {
  return {
    async start(input) {
      calls.push([...input.arguments]);
      assert.equal(input.executablePath.startsWith("/"), true);
      assert.deepEqual(input.environment, {});
      assert.equal(input.exposeListener, false);
      return transport;
    },
  };
}

function fixtureTransport(
  mutate: (
    response: MacOsNativeHelperWireResponse,
    request: MacOsNativeHelperWireRequest,
  ) => MacOsNativeHelperWireResponse = (response) => response,
): MacOsNativeHelperChildTransport & {
  readonly requests: MacOsNativeHelperWireRequest[];
  closeCount: number;
} {
  const transport = {
    requests: [] as MacOsNativeHelperWireRequest[],
    closeCount: 0,
    async request(request: MacOsNativeHelperWireRequest) {
      transport.requests.push(request);
      const result = resultFor(request);
      return mutate(
        {
          protocolVersion: 1,
          requestId: request.requestId,
          sequence: request.sequence,
          binding: request.binding,
          ok: true,
          result,
          wireBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
        },
        request,
      );
    },
    async close() {
      transport.closeCount += 1;
    },
  };
  return transport;
}

function resultFor(request: MacOsNativeHelperWireRequest): unknown {
  switch (request.operation) {
    case "probe":
      return {
        osFamily: "macos",
        backendId: "macos-ax-screencapturekit-cgevent",
        helperInstanceId: SESSION.helperInstanceId,
        serviceEpoch: SESSION.serviceEpoch,
        displayFingerprint: "display:macos-fixture",
        checks: [
          readiness("interactive-session"),
          readiness("unlocked-session"),
          readiness("screen-capture"),
          readiness("accessibility"),
          readiness("input"),
          readiness("helper-authentication"),
        ],
      };
    case "observe":
      return {
        displayFingerprint: "display:macos-fixture",
        accessibilityTree: [],
      };
    case "capture":
      return {
        displayFingerprint: "display:macos-fixture",
        mediaType: "image/png",
        width: 1,
        height: 1,
        bytesBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
      };
    case "act":
      return {
        displayFingerprint: "display:macos-fixture",
        sequence: 1,
      };
    case "cancel":
    case "emergency-stop":
      return { stopped: true };
  }
}

function readiness(name: string) {
  return {
    name,
    status: "pass",
    evidence: `${name} passed.`,
  };
}

async function startFixtureHelper(
  transport: MacOsNativeHelperChildTransport,
): ReturnType<typeof startMacOsNativeHelperChildProcess> {
  return startMacOsNativeHelperChildProcess({
    authenticatedSession: SESSION,
    executablePath:
      "/Library/OpenDelegate/releases/0.1.0-alpha.1/libexec/opendelegate-macos-computer-use",
    expectedExecutableSha256: EXPECTED_SHA256,
    hostPlatform: "darwin",
    binaryVerifier: { async verify() {} },
    transportFactory: {
      async start() {
        return transport;
      },
    },
    requestIdSource: sequenceIds(),
  });
}

function sequenceIds() {
  let next = 0;
  return {
    nextRequestId() {
      next += 1;
      return `macos-request-${next}`;
    },
  };
}

function executionContext() {
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

function hasNativeCode(code: NativeDriverError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof NativeDriverError && error.code === code;
}
