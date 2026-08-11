import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { DeviceChannelClientError } from "@opendelegate/device-channel";
import { SecretError } from "@opendelegate/secrets";

import {
  classifyChannelConnectFailure,
  runWorkerConnectionLoop,
  type WorkerConnectionDiagnostic,
} from "../src/worker-app.ts";

const notDue = async () => ({ status: "not-due" as const, renewAfter: Number.MAX_SAFE_INTEGER });

function attempt(overrides: {
  readonly outcome: "authentication-rejected" | "connect-failed" | "identity-rejected";
  readonly code: string;
}) {
  return {
    endpointId: "main-wss",
    label: "Main over Tailscale",
    kind: "wss" as const,
    probeSource: "live" as const,
    outcome: overrides.outcome,
    diagnostic: { code: overrides.code },
  };
}

describe("Worker connection diagnostics", () => {
  it("distinguishes a local Secret Store read failure from Main rejecting the Device", () => {
    assert.deepEqual(
      classifyChannelConnectFailure(
        new SecretError("SECRET_STORE_ACCESS_FAILED", "The local Secret Store refused access."),
      ),
      {
        outcome: "identity-rejected",
        diagnostic: { code: "LOCAL_SECRET_UNAVAILABLE" },
      },
    );
  });

  it("treats an invalid Device identity key as blocking", async () => {
    assert.deepEqual(
      classifyChannelConnectFailure(
        new DeviceChannelClientError(
          "The Worker private-key lease is invalid.",
          "IDENTITY_KEY_INVALID",
        ),
      ),
      {
        outcome: "identity-rejected",
        diagnostic: { code: "IDENTITY_KEY_INVALID" },
      },
    );

    const controller = new AbortController();
    const diagnostics: WorkerConnectionDiagnostic[] = [];
    await runWorkerConnectionLoop(
      {
        runtime: {
          connect: async () => {
            controller.abort();
            return {
              connected: false as const,
              diagnostics: [
                attempt({ outcome: "identity-rejected", code: "IDENTITY_KEY_INVALID" }),
              ],
            };
          },
        } as never,
        pulse: async () => false,
        renewCertificate: notDue,
      },
      {
        reconnectMinimumMs: 1,
        reconnectMaximumMs: 1,
        heartbeatIntervalMs: 1,
        signal: controller.signal,
        onConnectionDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
    );
    assert.deepEqual(diagnostics, [{ code: "IDENTITY_KEY_INVALID", retryable: false }]);
  });

  it("reports a temporarily unavailable local Secret Store as retryable", async () => {
    const controller = new AbortController();
    const diagnostics: WorkerConnectionDiagnostic[] = [];
    await runWorkerConnectionLoop(
      {
        runtime: {
          connect: async () => {
            controller.abort();
            return {
              connected: false as const,
              diagnostics: [
                attempt({ outcome: "identity-rejected", code: "LOCAL_SECRET_UNAVAILABLE" }),
              ],
            };
          },
        } as never,
        pulse: async () => false,
        renewCertificate: notDue,
      },
      {
        reconnectMinimumMs: 1,
        reconnectMaximumMs: 1,
        heartbeatIntervalMs: 1,
        signal: controller.signal,
        onConnectionDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
    );
    assert.deepEqual(diagnostics, [{ code: "LOCAL_SECRET_UNAVAILABLE", retryable: true }]);
  });

  it("names an expired Device certificate instead of retrying it silently", async () => {
    const controller = new AbortController();
    let connectionCount = 0;
    const diagnostics: WorkerConnectionDiagnostic[] = [];
    const connect = mock.fn(async () => {
      connectionCount += 1;
      if (connectionCount === 3) {
        controller.abort();
      }
      return {
        connected: false as const,
        diagnostics: [attempt({ outcome: "authentication-rejected", code: "CERTIFICATE_EXPIRED" })],
      };
    });

    await runWorkerConnectionLoop(
      { runtime: { connect } as never, pulse: async () => false, renewCertificate: notDue },
      {
        reconnectMinimumMs: 1,
        reconnectMaximumMs: 1,
        heartbeatIntervalMs: 1,
        signal: controller.signal,
        onConnectionDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
    );

    assert.equal(connect.mock.callCount(), 3);
    assert.deepEqual(diagnostics, [{ code: "CERTIFICATE_EXPIRED", retryable: false }]);
  });

  it("reports an ordinary transport failure once while continuing to retry it", async () => {
    const controller = new AbortController();
    let connectionCount = 0;
    const onConnectionDiagnostic = mock.fn((_diagnostic: WorkerConnectionDiagnostic) => undefined);
    const connect = mock.fn(async () => {
      connectionCount += 1;
      if (connectionCount === 2) {
        controller.abort();
      }
      return {
        connected: false as const,
        diagnostics: [attempt({ outcome: "connect-failed", code: "TRANSPORT_BOUNDARY_ERROR" })],
      };
    });

    await runWorkerConnectionLoop(
      { runtime: { connect } as never, pulse: async () => false, renewCertificate: notDue },
      {
        reconnectMinimumMs: 1,
        reconnectMaximumMs: 1,
        heartbeatIntervalMs: 1,
        signal: controller.signal,
        onConnectionDiagnostic,
      },
    );

    assert.equal(onConnectionDiagnostic.mock.callCount(), 1);
    assert.deepEqual(onConnectionDiagnostic.mock.calls[0]?.arguments, [
      { code: "TRANSPORT_BOUNDARY_ERROR", retryable: true },
    ]);
  });

  it("reports a blocking cause again only after a successful connection cleared it", async () => {
    const controller = new AbortController();
    const results: Array<{ readonly connected: boolean }> = [];
    const diagnostics: WorkerConnectionDiagnostic[] = [];
    const outcomes = [
      { connected: false as const, diagnostics: [expiredAttempt()] },
      { connected: false as const, diagnostics: [expiredAttempt()] },
      { connected: true as const, endpointId: "main-wss", replayedEvents: 0 },
      { connected: false as const, diagnostics: [expiredAttempt()] },
    ];
    const connect = mock.fn(async () => {
      const next = outcomes[results.length] ?? outcomes[outcomes.length - 1]!;
      results.push(next);
      if (results.length >= outcomes.length) {
        controller.abort();
      }
      return next;
    });

    await runWorkerConnectionLoop(
      { runtime: { connect } as never, pulse: async () => false, renewCertificate: notDue },
      {
        reconnectMinimumMs: 1,
        reconnectMaximumMs: 1,
        heartbeatIntervalMs: 1,
        signal: controller.signal,
        onConnectionDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
    );

    assert.deepEqual(diagnostics, [
      { code: "CERTIFICATE_EXPIRED", retryable: false },
      { code: "CERTIFICATE_EXPIRED", retryable: false },
    ]);
  });
});

function expiredAttempt() {
  return attempt({ outcome: "authentication-rejected", code: "CERTIFICATE_EXPIRED" });
}
