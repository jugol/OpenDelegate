import assert from "node:assert/strict";
import test from "node:test";

import Value from "typebox/value";

import {
  AuditEventListResponseSchema,
  BrowserSessionSchema,
  ConfigurationAgentMessageRequestSchema,
  ConfigurationAgentMessageResponseSchema,
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

test("Configuration Agent messages are bounded and never carry raw configuration patches", () => {
  assert.equal(
    Value.Check(ConfigurationAgentMessageRequestSchema, {
      message: "Help me configure the selected Device.",
    }),
    true,
  );
  assert.equal(
    Value.Check(ConfigurationAgentMessageRequestSchema, {
      message: "Store this credential.",
      secretValue: "must-not-cross-the-browser-boundary",
    }),
    false,
  );

  const response = {
    messageId: "configuration_message_001",
    sessionId: "configuration_session_device_main",
    content: "I can inspect the Device and prepare a reviewable proposal.",
    occurredAt: NOW,
  };
  assert.equal(Value.Check(ConfigurationAgentMessageResponseSchema, response), true);
  assert.equal(
    Value.Check(ConfigurationAgentMessageResponseSchema, {
      ...response,
      configurationPatch: [{ operation: "set", key: "policy.network-change" }],
    }),
    false,
  );
});

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

test("Audit exposes only the bounded route-diagnosis presentation contract", () => {
  const routeIncident = {
    incidentId: `sha256:${"a".repeat(64)}`,
    fingerprint: `sha256:${"b".repeat(64)}`,
    profileRevision: `sha256:${"c".repeat(64)}`,
    recommendation: "Check whether the private route is reachable from this Device.",
    ownerQuestion: "Should OpenDelegate keep using the next configured route?",
    source: "agent",
    reasonCode: "AGENT_COMPLETED",
  };
  const response = {
    events: [
      {
        auditId: "route_diagnosis_1",
        source: "runtime",
        type: "transport.route-incident.diagnosis-completed.v1",
        occurredAt: NOW,
        outcome: "succeeded",
        subjectId: "device_worker",
        deviceId: "device_worker",
        routeIncident,
      },
    ],
  };

  assert.equal(Value.Check(AuditEventListResponseSchema, response), true);
  for (const leakedField of [
    { endpointUrl: "wss://private-main.example.test" },
    { credentialRef: "secret://device-certificate" },
    { attempts: [{ diagnostic: "private provider output" }] },
  ]) {
    assert.equal(
      Value.Check(AuditEventListResponseSchema, {
        events: [
          {
            ...response.events[0],
            routeIncident: { ...routeIncident, ...leakedField },
          },
        ],
      }),
      false,
    );
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
        lastObservation: {
          observedAtMs: 2_000,
          acceptedAtMs: 2_050,
          source: "authenticated-heartbeat",
        },
        roles: ["main-coordinator"],
        instructions: ["Keep release evidence immutable."],
        facts: [
          {
            kind: "os-family",
            value: "windows",
            source: "enrollment",
            observedAtMs: 1_000,
            verification: "verified",
          },
          {
            kind: "cpu-model",
            value: "Example CPU",
            source: "node-os",
            observedAtMs: 2_000,
            verification: "observed",
          },
          {
            kind: "gpu-model",
            value: "Example Vendor Example GPU",
            source: "platform-probe",
            observedAtMs: 2_000,
            verification: "verified",
          },
        ],
        capabilities: [
          {
            name: "codex",
            verification: "verified",
            observedAtMs: 2_000,
            evidenceSource: "agent-adapter",
            version: "0.145.0",
          },
        ],
        policies: [
          {
            policyId: "policy_network",
            actionCategory: "os-network-change",
            decision: "require-approval",
            source: "configuration",
            effectiveScope: "device",
          },
        ],
        agentAdapters: [
          {
            provider: "codex",
            adapterId: "codex_app_server",
            readiness: "ready",
            compatibility: "tested",
            version: "0.145.0",
            observedAtMs: 2_000,
          },
        ],
        routes: [
          {
            routeId: "main-local",
            label: "Main-local",
            priority: 0,
            kind: "wss",
            profileRevision: `sha256:${"a".repeat(64)}`,
            health: "healthy",
            lastAttempt: {
              probeSource: "live",
              outcome: "connected",
              observedAtMs: 2_000,
            },
          },
        ],
        resourceLocks: [
          {
            resourceName: "desktop-session",
            capacity: 1,
            holders: [
              {
                taskId: "task_1",
                runId: "run_1",
                expiresAtMs: 10_000,
              },
            ],
          },
        ],
        currentRuns: [
          {
            taskId: "task_1",
            workOrderId: "work_order_1",
            runId: "run_1",
            state: "running",
            acceptedAtMs: 2_000,
            leaseExpiresAtMs: 10_000,
          },
        ],
        capacity: {
          activeRuns: 1,
          maximumConcurrentRuns: 4,
          acceptingWork: true,
          maxOutboxEntries: 10_000,
          outboxDepth: 2,
        },
        knowledgeHealth: "healthy",
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
  assert.equal(
    Value.Check(DeviceListResponseSchema, {
      devices: [
        {
          ...response.devices[0],
          knowledgeFiles: ["private-note.md"],
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
    messages: [
      {
        messageId: "event_message_001",
        role: "agent",
        content: "The release is ready for review.",
        occurredAt: NOW,
      },
    ],
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
  assert.equal(
    Value.Check(TaskDetailSchema, {
      ...detail,
      messages: [{ ...detail.messages[0], token: "secret" }],
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
