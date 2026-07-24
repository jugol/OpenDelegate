import assert from "node:assert/strict";
import test from "node:test";

import Value from "typebox/value";

import {
  BrowserSessionSchema,
  CreateTaskRequestSchema,
  DeviceListResponseSchema,
  LiveHealthSchema,
  OwnerClaimResponseSchema,
  OwnerSessionResponseSchema,
  ProblemDetailsSchema,
  RecoveryCompleteResponseSchema,
  RuntimeFeaturesResponseSchema,
  TaskDetailSchema,
} from "../src/index.ts";

const NOW = "2026-07-24T00:00:00.000Z";

test("owner response contracts expose only browser-safe fields", () => {
  const session = {
    sessionId: "session_001",
    ownerId: "owner_001",
    createdAt: NOW,
    authenticatedAt: NOW,
    lastUsedAt: NOW,
    idleExpiresAt: "2026-07-25T00:00:00.000Z",
    absoluteExpiresAt: "2026-08-23T00:00:00.000Z",
  };

  assert.equal(Value.Check(BrowserSessionSchema, session), true);
  assert.equal(
    Value.Check(OwnerSessionResponseSchema, {
      csrfToken: "a".repeat(43),
      session,
    }),
    true,
  );
  for (const leakedField of [
    { sessionToken: "raw-session" },
    { tokenDigest: "sha256:digest" },
    { passwordPhc: "$argon2id$secret" },
    { recoveryCodes: ["raw-code"] },
  ]) {
    assert.equal(Value.Check(BrowserSessionSchema, { ...session, ...leakedField }), false);
  }
});

test("claim and recovery responses require exactly ten unique recovery credentials", () => {
  const response = {
    ownerId: "owner_001",
    recoveryCodes: Array.from(
      { length: 10 },
      (_, index) => `odr_${String(index).padStart(22, "a")}`,
    ),
  };

  assert.equal(Value.Check(OwnerClaimResponseSchema, response), true);
  assert.equal(Value.Check(RecoveryCompleteResponseSchema, response), true);
  assert.equal(
    Value.Check(OwnerClaimResponseSchema, {
      ...response,
      recoveryCodes: response.recoveryCodes.slice(0, 9),
    }),
    false,
  );
  assert.equal(
    Value.Check(OwnerClaimResponseSchema, {
      ...response,
      recoveryCodes: Array.from({ length: 10 }, () => "odr_" + "a".repeat(22)),
    }),
    false,
  );
});

test("Task intake is bounded, explicit, and rejects route or Secret fields", () => {
  const request = {
    objective: "Prepare the release-readiness report.",
    completionCriteria: ["Publish one verified report."],
    constraints: ["Keep Device Knowledge local."],
    selectedInputRefs: ["artifact:input-001"],
    mode: "auto",
  };

  assert.equal(Value.Check(CreateTaskRequestSchema, request), true);
  assert.equal(
    Value.Check(CreateTaskRequestSchema, {
      ...request,
      route: "ssh://private-host",
    }),
    false,
  );
  assert.equal(
    Value.Check(CreateTaskRequestSchema, {
      ...request,
      secretValue: "must-not-cross-main",
    }),
    false,
  );
  assert.equal(
    Value.Check(CreateTaskRequestSchema, {
      ...request,
      completionCriteria: [],
    }),
    false,
  );
});

test("Device list exposes only explicit scheduling and runtime facts", () => {
  const response = {
    devices: [
      {
        deviceId: "device_main",
        name: "main-host",
        osFamily: "windows",
        platformRelease: "10.0.26100",
        architecture: "x64",
        role: "main",
        connection: "online",
        runtime: "healthy",
        serviceMode: "foreground",
      },
    ],
  };

  assert.equal(Value.Check(DeviceListResponseSchema, response), true);
  assert.equal(
    Value.Check(DeviceListResponseSchema, {
      devices: [
        {
          ...response.devices[0],
          tailscale: "connected",
        },
      ],
    }),
    false,
  );
  assert.equal(
    Value.Check(DeviceListResponseSchema, {
      devices: [
        {
          ...response.devices[0],
          capabilities: ["computer-use"],
        },
      ],
    }),
    false,
  );
});

test("runtime features distinguish available control surfaces from connected execution", () => {
  const response = {
    releaseChannel: "internal-preview",
    taskExecution: { status: "unavailable", code: "ORCHESTRATION_NOT_CONNECTED" },
    configurationAgent: {
      status: "unavailable",
      code: "CONFIGURATION_AGENT_NOT_CONNECTED",
    },
    discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
  };

  assert.equal(Value.Check(RuntimeFeaturesResponseSchema, response), true);
  assert.equal(
    Value.Check(RuntimeFeaturesResponseSchema, {
      ...response,
      releaseChannel: "released",
    }),
    true,
  );
  assert.equal(
    Value.Check(RuntimeFeaturesResponseSchema, {
      ...response,
      taskExecution: { status: "ready", code: "lowercase-code" },
    }),
    false,
  );
  assert.equal(
    Value.Check(RuntimeFeaturesResponseSchema, {
      ...response,
      agentApiKey: "must-not-cross-the-boundary",
    }),
    false,
  );
});

test("Task detail carries a bounded public timeline without event payloads", () => {
  const detail = {
    taskId: "task_001",
    state: "intake",
    mode: "auto",
    objective: "Verify the release.",
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    completionCriteria: ["Every gate passes."],
    constraints: [],
    selectedInputRefs: [],
    events: [
      {
        eventId: "event_001",
        type: "task.created",
        occurredAt: NOW,
        streamVersion: 1,
      },
    ],
  };

  assert.equal(Value.Check(TaskDetailSchema, detail), true);
  assert.equal(
    Value.Check(TaskDetailSchema, {
      ...detail,
      events: [{ ...detail.events[0], payload: { password: "secret" } }],
    }),
    false,
  );
});

test("health and problem contracts remain detail-bounded", () => {
  assert.equal(
    Value.Check(LiveHealthSchema, {
      status: "ok",
      service: "opendelegate-main",
      version: "0.1.0",
      buildId: "commit-404e432",
    }),
    true,
  );
  assert.equal(
    Value.Check(LiveHealthSchema, {
      status: "ok",
      service: "opendelegate-main",
      version: "0.1.0",
      buildId: "commit-404e432",
      databaseUri: "postgres://secret",
    }),
    false,
  );

  const problem = {
    type: "https://opendelegate.dev/problems/idempotency-conflict",
    title: "Idempotency conflict",
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    correlationId: "correlation_001",
  };
  assert.equal(Value.Check(ProblemDetailsSchema, problem), true);
  assert.equal(
    Value.Check(ProblemDetailsSchema, {
      ...problem,
      stack: "internal stack",
      sql: "select secret",
    }),
    false,
  );
});
