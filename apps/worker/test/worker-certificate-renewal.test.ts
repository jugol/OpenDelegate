import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  runWorkerConnectionLoop,
  type WorkerCertificateRenewalOutcome,
} from "../src/worker-app.ts";

const NOT_DUE: WorkerCertificateRenewalOutcome = {
  status: "not-due",
  renewAfter: Number.MAX_SAFE_INTEGER,
};

function connectedOnce(controller: AbortController) {
  let connections = 0;
  return mock.fn(async () => {
    connections += 1;
    if (connections >= 2) {
      controller.abort();
    }
    return { connected: true as const, endpointId: "main-wss", replayedEvents: 0 };
  });
}

describe("Worker certificate renewal", () => {
  it("renews on the beat that proves the channel can still carry the exchange", async () => {
    const controller = new AbortController();
    const renewCertificate = mock.fn(async () => NOT_DUE);
    const reported: WorkerCertificateRenewalOutcome[] = [];

    await runWorkerConnectionLoop(
      {
        runtime: { connect: connectedOnce(controller) } as never,
        pulse: async () => false,
        renewCertificate,
      },
      {
        reconnectMinimumMs: 1,
        reconnectMaximumMs: 1,
        heartbeatIntervalMs: 1,
        signal: controller.signal,
        onCertificateRenewal: (outcome) => {
          reported.push(outcome);
        },
      },
    );

    assert.ok(
      renewCertificate.mock.callCount() >= 1,
      "a connected Worker must check its certificate deadline",
    );
    assert.deepEqual(reported, [], "a certificate that is not due stays silent");
  });

  it("reports the new generation once the certificate has been replaced", async () => {
    const controller = new AbortController();
    let calls = 0;
    const renewCertificate = mock.fn(async (): Promise<WorkerCertificateRenewalOutcome> => {
      calls += 1;
      return calls === 1
        ? { status: "renewed", generation: 3, notAfter: Date.UTC(2026, 7, 2, 21, 40, 24) }
        : NOT_DUE;
    });
    const reported: WorkerCertificateRenewalOutcome[] = [];

    const loopOutcome = await runWorkerConnectionLoop(
      {
        runtime: { connect: connectedOnce(controller) } as never,
        pulse: async () => false,
        renewCertificate,
      },
      {
        reconnectMinimumMs: 1,
        reconnectMaximumMs: 1,
        heartbeatIntervalMs: 1,
        signal: controller.signal,
        onCertificateRenewal: (outcome) => {
          reported.push(outcome);
        },
      },
    );

    assert.deepEqual(reported, [
      { status: "renewed", generation: 3, notAfter: Date.UTC(2026, 7, 2, 21, 40, 24) },
    ]);
    assert.equal(loopOutcome, "configuration-reload");
  });

  it("keeps the connection loop alive without storming Main when renewal throws", async () => {
    const controller = new AbortController();
    let calls = 0;
    const renewCertificate = mock.fn(async (): Promise<WorkerCertificateRenewalOutcome> => {
      calls += 1;
      if (calls === 1) {
        throw new Error("Main refused the Device certificate rotation (SERVICE_UNAVAILABLE).");
      }
      return NOT_DUE;
    });
    const reported: WorkerCertificateRenewalOutcome[] = [];

    await runWorkerConnectionLoop(
      {
        runtime: { connect: connectedOnce(controller) } as never,
        pulse: async () => false,
        renewCertificate,
      },
      {
        reconnectMinimumMs: 1,
        reconnectMaximumMs: 1,
        heartbeatIntervalMs: 1,
        signal: controller.signal,
        onCertificateRenewal: (outcome) => {
          reported.push(outcome);
        },
      },
    );

    // The certificate is still usable, so a failed attempt is reported and the
    // loop keeps running rather than taking the Worker offline.
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.status, "unavailable");
    assert.match((reported[0] as { readonly reason: string }).reason, /SERVICE_UNAVAILABLE/u);
    assert.equal(
      renewCertificate.mock.callCount(),
      1,
      "the next reconnect stays inside the bounded renewal retry window",
    );
  });
});
