import assert from "node:assert/strict";
import test from "node:test";

import {
  ActiveRunSteeringController,
  AgentAdapterError,
  type AgentSteerRequest,
} from "../src/index.ts";

const expected = {
  provider: "codex" as const,
  adapterId: "codex-app-server",
  runId: "run-steering",
  taskId: "task-steering",
  workstreamId: "implementation",
  sessionKey: "task-steering/implementation",
  deviceId: "device-main",
  workspaceId: "workspace-repository",
};

function request(requestId: string, instruction: string): AgentSteerRequest {
  return {
    schemaVersion: 1,
    requestId,
    scope: {
      ...expected,
      nativeSessionId: "thread-steering",
    },
    instruction,
    requestedBy: "main-agent",
  };
}

test("steering serializes distinct instructions and exact replay never resends", async () => {
  const controller = new ActiveRunSteeringController(expected, () =>
    Date.parse("2026-07-25T02:00:00.000Z"),
  );
  const sent: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  controller.activate({
    nativeSessionId: "thread-steering",
    send: async (candidate) => {
      sent.push(candidate.requestId);
      if (candidate.requestId === "steer-1") {
        await firstBlocked;
      }
      return { providerTurnId: "turn-steering" };
    },
  });

  const first = controller.steer(request("steer-1", "First instruction."));
  const second = controller.steer(request("steer-2", "Second instruction."));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ["steer-1"]);
  releaseFirst();
  assert.equal((await first).status, "accepted");
  assert.equal((await second).status, "accepted");
  assert.deepEqual(sent, ["steer-1", "steer-2"]);

  assert.equal(
    (await controller.steer(request("steer-1", "First instruction."))).status,
    "already-accepted",
  );
  assert.deepEqual(sent, ["steer-1", "steer-2"]);
  await assert.rejects(
    controller.steer(request("steer-1", "Changed instruction.")),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "STEERING_REQUEST_REPLAY_CONFLICT",
  );
});

test("an uncertain provider failure poisons the live turn instead of retrying", async () => {
  const controller = new ActiveRunSteeringController(expected, Date.now);
  let sends = 0;
  controller.activate({
    nativeSessionId: "thread-steering",
    send: async () => {
      sends += 1;
      throw new AgentAdapterError(
        "PROVIDER_CONNECTION_CLOSED",
        "The provider response was lost.",
        true,
      );
    },
  });

  await assert.rejects(controller.steer(request("steer-failed", "Try once.")), {
    code: "PROVIDER_CONNECTION_CLOSED",
  });
  await assert.rejects(controller.steer(request("steer-next", "Do not retry.")), {
    code: "STEERING_TURN_COMPLETED",
  });
  await assert.rejects(controller.steer(request("steer-failed", "Try once.")), {
    code: "PROVIDER_CONNECTION_CLOSED",
  });
  assert.equal(sends, 1);
});
