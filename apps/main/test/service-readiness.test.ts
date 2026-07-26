import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMainServiceReadyMessage,
  isMainServiceReadyMessage,
} from "../src/service-readiness.ts";

const EXPECTED = Object.freeze({
  instanceId: "instance-personal",
  deviceId: "device-main",
  releaseVersion: "1.2.3",
  origin: "https://main.example.test",
});

describe("Main native-service readiness signal", () => {
  it("binds an all-ready composed result to the exact Main identity", () => {
    const message = createMainServiceReadyMessage({
      ...EXPECTED,
      buildId: "candidate-0123456789abcdef",
      readiness: {
        status: "ready",
        checks: [
          { status: "ready", code: "DATABASE_READY" },
          { status: "ready", code: "CONTROL_PLANE_READY" },
          { status: "ready", code: "DEVICE_CHANNEL_READY" },
        ],
      },
    });

    assert.equal(isMainServiceReadyMessage(message, EXPECTED), true);
    assert.equal(
      isMainServiceReadyMessage(message, {
        ...EXPECTED,
        deviceId: "device-other",
      }),
      false,
    );
    assert.equal(
      isMainServiceReadyMessage(message, {
        ...EXPECTED,
        releaseVersion: "1.2.4",
      }),
      false,
    );
  });

  it("does not create readiness from a partial or failed composed result", () => {
    assert.throws(
      () =>
        createMainServiceReadyMessage({
          ...EXPECTED,
          buildId: "candidate-0123456789abcdef",
          readiness: {
            status: "not-ready",
            checks: [{ status: "not-ready", code: "DATABASE_UNAVAILABLE" }],
          },
        }),
      /cannot advertise service readiness/u,
    );
    assert.equal(
      isMainServiceReadyMessage(
        {
          type: "opendelegate.main.ready.v1",
          protocolVersion: 1,
          ...EXPECTED,
          buildId: "candidate-0123456789abcdef",
          readiness: {
            status: "ready",
            checks: [{ status: "ready", code: "CONTROL_PLANE_READY" }],
          },
        },
        EXPECTED,
      ),
      false,
    );
    assert.equal(
      isMainServiceReadyMessage(
        {
          type: "opendelegate.main.ready.v1",
          protocolVersion: 1,
          ...EXPECTED,
          buildId: "candidate-0123456789abcdef",
          readiness: {
            status: "ready",
            checks: [{ status: "ready", code: "CONTROL\u0000PLANE_READY" }],
          },
        },
        EXPECTED,
      ),
      false,
    );
  });
});
