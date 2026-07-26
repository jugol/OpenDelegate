import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryComputerUseStartHistory,
  type ComputerUseInputAuthorizer,
  type MacOsAuthenticatedHelperSession,
  type MacOsNativeHelperPort,
  type NativeDriverExecutionContext,
  type NativeDriverProbe,
  type ReadinessCheckName,
  type WindowsAuthenticatedHelperCommand,
  type WindowsAuthenticatedHelperPort,
} from "@opendelegate/computer-use-os";

import {
  createMacOsWorkerComputerUseComposition,
  createWindowsWorkerComputerUseComposition,
} from "../src/index.ts";

const MAC_SESSION = Object.freeze({
  authentication: "adr-0011-ed25519-v2" as const,
  helperInstanceId: "helper-aqua-501",
  osSessionIdentity: "aqua:501:console",
  releaseVersion: "0.1.0-alpha.1",
  serviceEpoch: 41,
});

describe("cross-platform Worker Computer Use composition", () => {
  it("composes the authenticated Windows helper into a verified backend", async () => {
    const composition = createWindowsWorkerComputerUseComposition({
      deviceId: "device-windows",
      persistenceGeneration: 9,
      helper: readyWindowsHelper(),
      helperBinding: {
        helperInstanceId: "helper-windows-session-1",
        serviceEpoch: 12,
        sessionIdentity: "S-1-5-21-owner:console:1",
        releaseVersion: "0.1.0-alpha.1",
      },
      authority: currentAuthority("helper-windows-session-1", 12, 9),
      leases: currentLease(),
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: denyAuthorizer(),
      clock: { now: () => 1_000 },
      logger: { write() {} },
    });

    assert.equal((await composition.readiness()).status, "ready");
    assert.deepEqual(await composition.capabilityProbe.probe(), {
      verification: "verified",
    });
    await composition.close();
  });

  it("composes the authenticated macOS session helper into a verified backend", async () => {
    const composition = await createMacOsWorkerComputerUseComposition({
      authenticatedSession: MAC_SESSION,
      deviceId: "device-macos",
      persistenceGeneration: 17,
      helperConfiguration: {
        executablePath:
          "/Applications/OpenDelegate.app/Contents/Helpers/opendelegate-macos-computer-use",
        expectedExecutableSha256: `sha256:${"b".repeat(64)}`,
      },
      nativeHelper: readyMacHelper(MAC_SESSION),
      authority: currentAuthority(MAC_SESSION.helperInstanceId, MAC_SESSION.serviceEpoch, 17),
      leases: currentLease(),
      startHistory: new InMemoryComputerUseStartHistory(),
      authorizer: denyAuthorizer(),
      clock: { now: () => 1_000 },
      logger: { write() {} },
    });

    assert.equal((await composition.readiness()).status, "ready");
    assert.deepEqual(await composition.capabilityProbe.probe(), {
      verification: "verified",
    });
    await composition.close();
  });
});

function currentAuthority(
  helperInstanceId: string,
  serviceEpoch: number,
  persistenceGeneration: number,
) {
  return {
    async verify() {
      return {
        status: "current" as const,
        helperInstanceId,
        serviceEpoch,
        persistenceGeneration,
        verifiedAtMs: 1_000,
      };
    },
  };
}

function currentLease() {
  return {
    async verify(request: {
      readonly lease: { readonly leaseId: string; readonly fencingToken: number };
    }) {
      return {
        status: "current" as const,
        leaseId: request.lease.leaseId,
        fencingToken: request.lease.fencingToken,
        verifiedAtMs: 1_000,
      };
    },
  };
}

function denyAuthorizer(): ComputerUseInputAuthorizer {
  return {
    authorize(request) {
      return {
        decision: "deny" as const,
        authorizationId: "authorization-test",
        fingerprint: request.fingerprint,
      };
    },
    consume() {
      throw new Error("Readiness-only composition cannot consume input authorization.");
    },
  };
}

function readyWindowsHelper(): WindowsAuthenticatedHelperPort {
  return {
    async execute(command: WindowsAuthenticatedHelperCommand) {
      const response = {
        protocolVersion: 1 as const,
        authenticated: true,
        helperInstanceId: command.expectedHelperInstanceId,
        serviceEpoch: command.expectedServiceEpoch,
        sessionIdentity: command.expectedSessionIdentity,
        releaseVersion: command.expectedReleaseVersion,
        displayFingerprint: "windows-display:console:1",
        kind: command.kind,
      };
      return command.kind === "probe"
        ? {
            ...response,
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
              targetIntegrity: "same-or-lower" as const,
            },
          }
        : response;
    },
  };
}

function readyMacHelper(session: MacOsAuthenticatedHelperSession): MacOsNativeHelperPort {
  return {
    currentSession: () => session,
    async probe(): Promise<NativeDriverProbe> {
      return {
        osFamily: "macos",
        backendId: "macos-ax-screencapturekit-cgevent",
        helperInstanceId: session.helperInstanceId,
        serviceEpoch: session.serviceEpoch,
        displayFingerprint: "macos-display:main:1512x982",
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
      return {
        displayFingerprint: "macos-display:main:1512x982",
        accessibilityTree: [],
      };
    },
    async capture() {
      return {
        displayFingerprint: "macos-display:main:1512x982",
        mediaType: "image/png" as const,
        width: 1,
        height: 1,
        bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      };
    },
    async act(_context: NativeDriverExecutionContext) {
      return {
        displayFingerprint: "macos-display:main:1512x982",
        sequence: 1,
      };
    },
    async cancel() {},
    async emergencyStop() {},
  };
}

function check(name: ReadinessCheckName) {
  return {
    name,
    status: "pass" as const,
    evidence: `${name} passed.`,
  };
}
