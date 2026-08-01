import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { runWorkerConnectionLoop, type WorkerConnectionDiagnostic } from "../src/worker-app.ts";

const notDue = async () => ({ status: "not-due" as const, renewAfter: Number.MAX_SAFE_INTEGER });

function attempt(overrides: {
  readonly outcome: "authentication-rejected" | "connect-failed";
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

  it("stays quiet for ordinary transport failures that retrying can still resolve", async () => {
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

    assert.equal(onConnectionDiagnostic.mock.callCount(), 0);
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
