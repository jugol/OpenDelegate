import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { runWorkerConnectionLoop } from "../src/worker-app.ts";

describe("Worker production readiness signal", () => {
  it("reports readiness once after the first authenticated connect result", async () => {
    const controller = new AbortController();
    let connectionCount = 0;
    const onReady = mock.fn(async () => undefined);
    const connect = mock.fn(async () => {
      connectionCount += 1;
      if (connectionCount === 2) {
        controller.abort();
      }
      return {
        connected: true as const,
        endpointId: "main-wss",
        replayedEvents: 0,
      };
    });

    await runWorkerConnectionLoop(
      {
        runtime: { connect } as never,
        pulse: async () => false,
      },
      {
        reconnectMinimumMs: 1,
        reconnectMaximumMs: 1,
        heartbeatIntervalMs: 1,
        signal: controller.signal,
        onReady,
      },
    );

    assert.equal(connect.mock.callCount(), 2);
    assert.equal(onReady.mock.callCount(), 1);
  });

  it("does not report readiness when authenticated connect fails", async () => {
    const failure = new Error("mTLS handshake rejected");
    const onReady = mock.fn(async () => undefined);

    await assert.rejects(
      runWorkerConnectionLoop(
        {
          runtime: {
            connect: async () => {
              throw failure;
            },
          } as never,
          pulse: async () => true,
        },
        {
          reconnectMinimumMs: 1,
          reconnectMaximumMs: 1,
          heartbeatIntervalMs: 1,
          onReady,
        },
      ),
      failure,
    );
    assert.equal(onReady.mock.callCount(), 0);
  });
});
