import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NativeDriverError,
  startLinuxNativeHelperChildProcess,
  type LinuxNativeHelperBinaryVerifier,
  type LinuxNativeHelperChildTransport,
  type LinuxNativeHelperChildTransportFactory,
  type LinuxNativeHelperWireRequest,
  type LinuxNativeHelperWireResponse,
} from "../src/index.ts";

const SESSION = Object.freeze({
  authentication: "adr-0011-ed25519-v2" as const,
  helperInstanceId: "helper-gnome-1000",
  osSessionIdentity: "wayland:1000:seat0",
  releaseVersion: "0.1.0-alpha.1",
  serviceEpoch: 19,
});
const EXPECTED_SHA256 = `sha256:${"b".repeat(64)}` as const;
const DESKTOP_ENVIRONMENT = Object.freeze({
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  WAYLAND_DISPLAY: "wayland-0",
  XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
  XDG_RUNTIME_DIR: "/run/user/1000",
  XDG_SESSION_TYPE: "wayland",
});

describe("private Linux native helper child process", () => {
  it("starts only a verified child with an exact desktop environment allowlist and no listener", async () => {
    const verified: string[] = [];
    const starts: Parameters<LinuxNativeHelperChildTransportFactory["start"]>[0][] = [];
    const transport = fixtureTransport();
    const helper = await startLinuxNativeHelperChildProcess({
      authenticatedSession: SESSION,
      executablePath:
        "/opt/opendelegate/releases/0.1.0-alpha.1/libexec/opendelegate-linux-computer-use",
      expectedExecutableSha256: EXPECTED_SHA256,
      desktopEnvironment: DESKTOP_ENVIRONMENT,
      hostPlatform: "linux",
      binaryVerifier: verifier(verified),
      transportFactory: {
        async start(input) {
          starts.push(input);
          return transport;
        },
      },
      parentProcessId: 5_432,
      requestIdSource: sequenceIds(),
    });

    const probe = await helper.probe();
    const observation = await helper.observe(executionContext());
    const capture = await helper.capture(executionContext());
    const receipt = await helper.act(executionContext(), {
      kind: "click",
      controlId: "submit",
    });

    assert.equal(probe.backendId, "linux-atspi-xdg-portal-pipewire");
    assert.equal(probe.linuxTarget, "ubuntu-24.04-gnome-wayland");
    assert.equal(observation.displayFingerprint, "portal-stream:42:1920x1080");
    assert.deepEqual(Array.from(capture.bytes), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(receipt.sequence, 1);
    assert.deepEqual(verified, [
      "/opt/opendelegate/releases/0.1.0-alpha.1/libexec/opendelegate-linux-computer-use",
    ]);
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.exposeListener, false);
    assert.deepEqual(starts[0]?.environment, DESKTOP_ENVIRONMENT);
    assert.deepEqual(starts[0]?.arguments, [
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
      "5432",
    ]);
    await helper.close();
    assert.equal(transport.closeCount, 1);
  });

  it("fails before inspection when the host or GNOME Wayland environment is unsupported", async () => {
    for (const input of [
      { hostPlatform: "win32" as const, desktopEnvironment: DESKTOP_ENVIRONMENT },
      {
        hostPlatform: "linux" as const,
        desktopEnvironment: { ...DESKTOP_ENVIRONMENT, XDG_SESSION_TYPE: "x11" },
      },
      {
        hostPlatform: "linux" as const,
        desktopEnvironment: { ...DESKTOP_ENVIRONMENT, XDG_CURRENT_DESKTOP: "KDE" },
      },
    ]) {
      let inspected = false;
      let spawned = false;
      await assert.rejects(
        startLinuxNativeHelperChildProcess({
          authenticatedSession: SESSION,
          executablePath: "/tmp/untrusted-helper",
          expectedExecutableSha256: EXPECTED_SHA256,
          ...input,
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
    }
  });

  it("terminates on response binding confusion, target downgrade, or oversized frames", async () => {
    for (const mutate of [
      (response: LinuxNativeHelperWireResponse) => ({
        ...response,
        binding: { ...SESSION, helperInstanceId: "replacement-helper" },
      }),
      (response: LinuxNativeHelperWireResponse) => ({
        ...response,
        result: {
          ...(response.result as Record<string, unknown>),
          linuxTarget: "headless",
        },
      }),
      (response: LinuxNativeHelperWireResponse) => ({
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

  it("redacts native errors and closes the child after cancellation", async () => {
    const secret = "owner-private-linux-password";
    const transport = fixtureTransport((response, request) =>
      request.operation === "act"
        ? {
            ...response,
            ok: false,
            result: undefined,
            error: {
              code: "PERMISSION_DENIED",
              message: `portal error included ${secret}`,
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
    assert.equal(transport.closeCount, 1);

    const cancellationTransport = fixtureTransport();
    const cancellationHelper = await startFixtureHelper(cancellationTransport);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      cancellationHelper.observe({ ...executionContext(), signal: controller.signal }),
      hasNativeCode("CANCELLED"),
    );
    assert.equal(cancellationTransport.closeCount, 1);
  });
});

function verifier(calls: string[]): LinuxNativeHelperBinaryVerifier {
  return {
    async verify(input) {
      calls.push(input.executablePath);
      assert.equal(input.expectedSha256, EXPECTED_SHA256);
      assert.equal(input.requireOwnerOnlyMutation, true);
    },
  };
}

function fixtureTransport(
  mutate: (
    response: LinuxNativeHelperWireResponse,
    request: LinuxNativeHelperWireRequest,
  ) => LinuxNativeHelperWireResponse = (response) => response,
): LinuxNativeHelperChildTransport & {
  readonly requests: LinuxNativeHelperWireRequest[];
  closeCount: number;
} {
  const transport = {
    requests: [] as LinuxNativeHelperWireRequest[],
    closeCount: 0,
    async request(request: LinuxNativeHelperWireRequest) {
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

function resultFor(request: LinuxNativeHelperWireRequest): unknown {
  switch (request.operation) {
    case "probe":
      return {
        osFamily: "linux",
        backendId: "linux-atspi-xdg-portal-pipewire",
        helperInstanceId: SESSION.helperInstanceId,
        serviceEpoch: SESSION.serviceEpoch,
        displayFingerprint: "portal-stream:42:1920x1080",
        linuxTarget: "ubuntu-24.04-gnome-wayland",
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
        displayFingerprint: "portal-stream:42:1920x1080",
        accessibilityTree: [],
      };
    case "capture":
      return {
        displayFingerprint: "portal-stream:42:1920x1080",
        mediaType: "image/png",
        width: 1,
        height: 1,
        bytesBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
      };
    case "act":
      return {
        displayFingerprint: "portal-stream:42:1920x1080",
        sequence: 1,
      };
    case "cancel":
    case "emergency-stop":
      return { stopped: true };
  }
}

function readiness(name: string) {
  return { name, status: "pass", evidence: `${name} passed.` };
}

async function startFixtureHelper(
  transport: LinuxNativeHelperChildTransport,
): ReturnType<typeof startLinuxNativeHelperChildProcess> {
  return startLinuxNativeHelperChildProcess({
    authenticatedSession: SESSION,
    executablePath:
      "/opt/opendelegate/releases/0.1.0-alpha.1/libexec/opendelegate-linux-computer-use",
    expectedExecutableSha256: EXPECTED_SHA256,
    desktopEnvironment: DESKTOP_ENVIRONMENT,
    hostPlatform: "linux",
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
      return `linux-request-${next}`;
    },
  };
}

function executionContext() {
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

function hasNativeCode(code: NativeDriverError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof NativeDriverError && error.code === code;
}
