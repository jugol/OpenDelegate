import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  parseApplicationRequestEnvelope,
  parseArtifactReference,
  parseEventEnvelope,
  parseForumTaskIntake,
  parseSemanticPlanningRequest,
  parseSemanticPlanningResponse,
  parseSemanticDeviceSelectionRequest,
  parseSemanticDeviceSelectionResponse,
  parseWorkerReport,
  parseWorkOrder,
} from "../src/index.ts";

test("a Forum post parses into a raw v1 Task intake contract", () => {
  const intake = parseForumTaskIntake({
    protocolVersion: "v1",
    forumId: "forum-product",
    postId: "post-launch-report",
    authorId: "owner-001",
    title: "Verify launch readiness",
    body: "Research the checks and publish a report.",
  });

  assert.deepEqual(intake, {
    protocolVersion: PROTOCOL_VERSION,
    forumId: "forum-product",
    postId: "post-launch-report",
    authorId: "owner-001",
    title: "Verify launch readiness",
    body: "Research the checks and publish a report.",
  });
});

test("a Forum Task intake rejects an unknown protocol version with a stable error", () => {
  assert.throws(
    () =>
      parseForumTaskIntake({
        protocolVersion: "v2",
        forumId: "forum-product",
        postId: "post-launch-report",
        authorId: "owner-001",
        title: "Verify launch readiness",
        body: "Research the checks and publish a report.",
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "UNKNOWN_PROTOCOL_VERSION");
      assert.equal((error as ProtocolValidationError).path, "protocolVersion");
      return true;
    },
  );
});

test("a Forum Task intake rejects a blank Forum identifier with a stable error", () => {
  assert.throws(
    () =>
      parseForumTaskIntake({
        protocolVersion: "v1",
        forumId: "   ",
        postId: "post-launch-report",
        authorId: "owner-001",
        title: "Verify launch readiness",
        body: "Research the checks and publish a report.",
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "BLANK_IDENTIFIER");
      assert.equal((error as ProtocolValidationError).path, "forumId");
      return true;
    },
  );
});

test("a Forum Task intake rejects a caller-supplied authorization assertion", () => {
  assert.throws(
    () =>
      parseForumTaskIntake({
        protocolVersion: "v1",
        forumId: "forum-product",
        postId: "post-launch-report",
        authorId: "owner-001",
        title: "Verify launch readiness",
        body: "Research the checks and publish a report.",
        approved: true,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT");
      assert.equal((error as ProtocolValidationError).path, "approved");
      return true;
    },
  );
});

test("a semantic planning request parses a bounded provider-neutral Task brief and eligible Devices", () => {
  const request = parseSemanticPlanningRequest({
    protocolVersion: "v1",
    taskId: "task-launch-report",
    objective: "Verify launch readiness and publish a report.",
    completionCriteria: ["Return one verified report Artifact."],
    constraints: ["Do not change production systems."],
    selectedInputRefs: ["artifact-release-checklist"],
    decisions: ["Use the approved release checklist."],
    openQuestions: [],
    eligibleDevices: [
      {
        protocolVersion: "v1",
        deviceId: "device-mac-research",
        roles: ["release-research"],
        verifiedCapabilities: ["research", "artifact-rendering"],
      },
    ],
  });

  assert.deepEqual(request, {
    protocolVersion: PROTOCOL_VERSION,
    taskId: "task-launch-report",
    objective: "Verify launch readiness and publish a report.",
    completionCriteria: ["Return one verified report Artifact."],
    constraints: ["Do not change production systems."],
    selectedInputRefs: ["artifact-release-checklist"],
    decisions: ["Use the approved release checklist."],
    openQuestions: [],
    eligibleDevices: [
      {
        protocolVersion: PROTOCOL_VERSION,
        deviceId: "device-mac-research",
        roles: ["release-research"],
        verifiedCapabilities: ["research", "artifact-rendering"],
      },
    ],
  });
});

test("a semantic planning response parses provider-neutral Work Orders", () => {
  const response = parseSemanticPlanningResponse({
    protocolVersion: "v1",
    taskId: "task-launch-report",
    workOrders: [
      {
        protocolVersion: "v1",
        workOrderId: "work-order-research",
        title: "Research launch checks",
        brief: "Verify every launch-readiness check.",
        completionCriteria: ["Return a concise verified result."],
        constraints: ["Do not change production systems."],
        selectedInputIds: ["artifact-release-checklist"],
        dependsOn: [],
        schedulingHints: {
          preferredDeviceIds: ["device-mac-research"],
          preferredRoles: ["release-research"],
        },
        requiredCapabilities: ["research"],
        requiredSecretRefs: ["secret-release-api"],
        requiredOsFamily: "macos",
        workspaceId: "workspace-release",
      },
    ],
  });

  assert.deepEqual(response, {
    protocolVersion: PROTOCOL_VERSION,
    taskId: "task-launch-report",
    workOrders: [
      {
        protocolVersion: PROTOCOL_VERSION,
        workOrderId: "work-order-research",
        title: "Research launch checks",
        brief: "Verify every launch-readiness check.",
        completionCriteria: ["Return a concise verified result."],
        constraints: ["Do not change production systems."],
        selectedInputIds: ["artifact-release-checklist"],
        dependsOn: [],
        schedulingHints: {
          preferredDeviceIds: ["device-mac-research"],
          preferredRoles: ["release-research"],
        },
        requiredCapabilities: ["research"],
        requiredSecretRefs: ["secret-release-api"],
        requiredOsFamily: "macos",
        workspaceId: "workspace-release",
      },
    ],
  });
});

test("semantic Device selection accepts only an explicitly bounded eligible set", () => {
  const workOrder = {
    protocolVersion: "v1",
    workOrderId: "work-order-research",
    title: "Research launch checks",
    brief: "Verify every launch-readiness check.",
    completionCriteria: ["Return a concise verified result."],
    constraints: [],
    selectedInputIds: [],
    dependsOn: [],
    schedulingHints: { preferredDeviceIds: [], preferredRoles: [] },
    requiredCapabilities: ["research"],
    requiredSecretRefs: [],
  } as const;
  const eligibleDevices = ["device-a", "device-b"].map((deviceId) => ({
    protocolVersion: "v1" as const,
    deviceId,
    roles: [],
    verifiedCapabilities: ["research"],
  }));

  const request = parseSemanticDeviceSelectionRequest({
    protocolVersion: "v1",
    taskId: "task-launch-report",
    workOrder,
    eligibleDevices,
  });
  const response = parseSemanticDeviceSelectionResponse({
    protocolVersion: "v1",
    taskId: request.taskId,
    workOrderId: request.workOrder.workOrderId,
    preferredDeviceId: request.eligibleDevices[1]?.deviceId,
  });

  assert.equal(request.eligibleDevices.length, 2);
  assert.equal(response.preferredDeviceId, "device-b");
  assert.throws(
    () =>
      parseSemanticDeviceSelectionRequest({
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrder,
        eligibleDevices: eligibleDevices.slice(0, 1),
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.path === "eligibleDevices",
  );
});

test("a Work Order rejects a malformed capability array with a stable error", () => {
  assert.throws(
    () =>
      parseSemanticPlanningResponse({
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrders: [
          {
            protocolVersion: "v1",
            workOrderId: "work-order-research",
            title: "Research launch checks",
            brief: "Verify every launch-readiness check.",
            completionCriteria: ["Return a concise verified result."],
            requiredCapabilities: "research",
            constraints: [],
            dependsOn: [],
          },
        ],
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "MALFORMED_CAPABILITY_ARRAY");
      assert.equal((error as ProtocolValidationError).path, "workOrders[0].requiredCapabilities");
      return true;
    },
  );
});

test("a Work Order rejects blank capability names", () => {
  assert.throws(
    () =>
      parseSemanticPlanningResponse({
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrders: [
          {
            protocolVersion: "v1",
            workOrderId: "work-order-research",
            title: "Research launch checks",
            brief: "Verify every launch-readiness check.",
            completionCriteria: ["Return a concise verified result."],
            requiredCapabilities: ["research", "  "],
            constraints: [],
            dependsOn: [],
          },
        ],
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "MALFORMED_CAPABILITY_ARRAY");
      assert.equal(
        (error as ProtocolValidationError).path,
        "workOrders[0].requiredCapabilities[1]",
      );
      return true;
    },
  );
});

test("a standalone Work Order parses through its public contract", () => {
  const workOrder = parseWorkOrder({
    protocolVersion: "v1",
    workOrderId: "work-order-render",
    title: "Render the report",
    brief: "Create a static HTML launch report.",
    completionCriteria: ["Return one openable static HTML Artifact."],
    constraints: ["Scripts must remain disabled."],
    selectedInputIds: ["artifact-release-checklist"],
    dependsOn: ["work-order-research"],
    schedulingHints: {
      preferredDeviceIds: ["device-linux-render"],
      preferredRoles: ["artifact-rendering"],
    },
    requiredCapabilities: ["artifact-rendering"],
    requiredSecretRefs: [],
    requiredOsFamily: "linux",
    workspaceId: "workspace-release",
  });

  assert.deepEqual(workOrder, {
    protocolVersion: PROTOCOL_VERSION,
    workOrderId: "work-order-render",
    title: "Render the report",
    brief: "Create a static HTML launch report.",
    completionCriteria: ["Return one openable static HTML Artifact."],
    constraints: ["Scripts must remain disabled."],
    selectedInputIds: ["artifact-release-checklist"],
    dependsOn: ["work-order-research"],
    schedulingHints: {
      preferredDeviceIds: ["device-linux-render"],
      preferredRoles: ["artifact-rendering"],
    },
    requiredCapabilities: ["artifact-rendering"],
    requiredSecretRefs: [],
    requiredOsFamily: "linux",
    workspaceId: "workspace-release",
  });
});

test("an openable Artifact reference parses without storage details", () => {
  const artifact = parseArtifactReference({
    protocolVersion: "v1",
    artifactId: "artifact-launch-report",
    href: "https://reports.example.test/artifacts/launch-readiness",
  });

  assert.deepEqual(artifact, {
    protocolVersion: PROTOCOL_VERSION,
    artifactId: "artifact-launch-report",
    href: "https://reports.example.test/artifacts/launch-readiness",
  });
});

test("a Worker report parses Task-scoped results and Artifact references", () => {
  const report = parseWorkerReport({
    protocolVersion: "v1",
    taskId: "task-launch-report",
    workOrderId: "work-order-render",
    deviceId: "device-linux-render",
    workerId: "worker-linux-render",
    routeId: "route-linux-lan",
    runId: "run-render-001",
    leaseId: "lease-render-001",
    fencingToken: 7,
    status: "succeeded",
    report: "The static report is ready.",
    artifactRefs: [
      {
        protocolVersion: "v1",
        artifactId: "artifact-launch-report",
        href: "https://reports.example.test/artifacts/launch-readiness",
      },
    ],
  });

  assert.deepEqual(report, {
    protocolVersion: PROTOCOL_VERSION,
    taskId: "task-launch-report",
    workOrderId: "work-order-render",
    deviceId: "device-linux-render",
    workerId: "worker-linux-render",
    routeId: "route-linux-lan",
    runId: "run-render-001",
    leaseId: "lease-render-001",
    fencingToken: 7,
    status: "succeeded",
    report: "The static report is ready.",
    artifactRefs: [
      {
        protocolVersion: PROTOCOL_VERSION,
        artifactId: "artifact-launch-report",
        href: "https://reports.example.test/artifacts/launch-readiness",
      },
    ],
  });
});

test("a Worker report requires the exact Device, route, Run, lease, and fence identity", () => {
  assert.throws(
    () =>
      parseWorkerReport({
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrderId: "work-order-render",
        workerId: "worker-linux-render",
        status: "succeeded",
        report: "The static report is ready.",
        artifactRefs: [],
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).path, "deviceId");
      return true;
    },
  );
});

test("an event envelope preserves a runtime-validated generic payload", () => {
  const event = parseEventEnvelope(
    {
      protocolVersion: "v1",
      messageId: "message-worker-report-001",
      senderDeviceId: "device-linux-render",
      correlationId: "task-launch-report",
      createdAt: "2026-07-24T10:30:00.000Z",
      idempotencyKey: "run-render:worker-report:1",
      type: "worker.reported",
      payload: {
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrderId: "work-order-render",
        deviceId: "device-linux-render",
        workerId: "worker-linux-render",
        routeId: "route-linux-lan",
        runId: "run-render-001",
        leaseId: "lease-render-001",
        fencingToken: 7,
        status: "succeeded",
        report: "The static report is ready.",
        artifactRefs: [],
      },
    },
    parseWorkerReport,
  );

  assert.deepEqual(event, {
    protocolVersion: PROTOCOL_VERSION,
    messageId: "message-worker-report-001",
    senderDeviceId: "device-linux-render",
    correlationId: "task-launch-report",
    createdAt: "2026-07-24T10:30:00.000Z",
    idempotencyKey: "run-render:worker-report:1",
    type: "worker.reported",
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      taskId: "task-launch-report",
      workOrderId: "work-order-render",
      deviceId: "device-linux-render",
      workerId: "worker-linux-render",
      routeId: "route-linux-lan",
      runId: "run-render-001",
      leaseId: "lease-render-001",
      fencingToken: 7,
      status: "succeeded",
      report: "The static report is ready.",
      artifactRefs: [],
    },
  });
});

test("an application request envelope validates routing metadata and semantic planning payload", () => {
  const request = parseApplicationRequestEnvelope(
    {
      protocolVersion: "v1",
      messageId: "message-plan-task-001",
      senderDeviceId: "device-main",
      correlationId: "task-launch-report",
      createdAt: "2026-07-24T10:31:00.000Z",
      idempotencyKey: "task-launch-report:plan:1",
      type: "task.plan.requested",
      payload: {
        protocolVersion: "v1",
        taskId: "task-launch-report",
        objective: "Verify launch readiness.",
        completionCriteria: ["Return one verified report Artifact."],
        constraints: [],
        selectedInputRefs: [],
        decisions: [],
        openQuestions: [],
        eligibleDevices: [],
      },
    },
    parseSemanticPlanningRequest,
  );

  assert.equal(request.messageId, "message-plan-task-001");
  assert.equal(request.senderDeviceId, "device-main");
  assert.equal(request.correlationId, "task-launch-report");
  assert.equal(request.idempotencyKey, "task-launch-report:plan:1");
  assert.equal(request.payload.taskId, "task-launch-report");
});

test("every public contract parser rejects an unknown protocol version", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly parse: (input: unknown) => unknown;
    readonly input: Record<string, unknown>;
  }> = [
    {
      name: "Work Order",
      parse: parseWorkOrder,
      input: {
        protocolVersion: "v2",
        workOrderId: "work-order-research",
        title: "Research launch checks",
        brief: "Verify every launch-readiness check.",
        completionCriteria: ["Return a concise result."],
        requiredCapabilities: [],
        constraints: [],
        dependsOn: [],
      },
    },
    {
      name: "semantic planning request",
      parse: parseSemanticPlanningRequest,
      input: {
        protocolVersion: "v2",
        taskId: "task-launch-report",
        objective: "Verify launch readiness.",
        completionCriteria: [],
        constraints: [],
        selectedInputRefs: [],
        decisions: [],
        openQuestions: [],
        eligibleDevices: [],
      },
    },
    {
      name: "semantic planning response",
      parse: parseSemanticPlanningResponse,
      input: {
        protocolVersion: "v2",
        taskId: "task-launch-report",
        workOrders: [],
      },
    },
    {
      name: "semantic Device selection request",
      parse: parseSemanticDeviceSelectionRequest,
      input: {
        protocolVersion: "v2",
        taskId: "task-launch-report",
        workOrder: {},
        eligibleDevices: [],
      },
    },
    {
      name: "semantic Device selection response",
      parse: parseSemanticDeviceSelectionResponse,
      input: {
        protocolVersion: "v2",
        taskId: "task-launch-report",
        workOrderId: "work-order-research",
        preferredDeviceId: "device-mac-research",
      },
    },
    {
      name: "Worker report",
      parse: parseWorkerReport,
      input: {
        protocolVersion: "v2",
        taskId: "task-launch-report",
        workOrderId: "work-order-research",
        workerId: "worker-mac-research",
        status: "succeeded",
        report: "Checks passed.",
        artifactRefs: [],
      },
    },
    {
      name: "Artifact reference",
      parse: parseArtifactReference,
      input: {
        protocolVersion: "v2",
        artifactId: "artifact-launch-report",
        href: "https://reports.example.test/artifacts/launch-readiness",
      },
    },
    {
      name: "application request envelope",
      parse: parseApplicationRequestEnvelope,
      input: {
        protocolVersion: "v2",
        messageId: "message-001",
        senderDeviceId: "device-main",
        correlationId: "task-launch-report",
        createdAt: "2026-07-24T10:30:00.000Z",
        idempotencyKey: "task-plan:1",
        type: "task.plan.requested",
        payload: {},
      },
    },
    {
      name: "event envelope",
      parse: parseEventEnvelope,
      input: {
        protocolVersion: "v2",
        messageId: "message-001",
        senderDeviceId: "device-main",
        correlationId: "task-launch-report",
        createdAt: "2026-07-24T10:30:00.000Z",
        idempotencyKey: "task-created:1",
        type: "task.created",
        payload: {},
      },
    },
  ];

  for (const contract of cases) {
    assert.throws(
      () => contract.parse(contract.input),
      (error: unknown) => {
        assert.equal(error instanceof ProtocolValidationError, true, contract.name);
        assert.equal(
          (error as ProtocolValidationError).code,
          "UNKNOWN_PROTOCOL_VERSION",
          contract.name,
        );
        assert.equal((error as ProtocolValidationError).path, "protocolVersion", contract.name);
        return true;
      },
    );
  }
});

test("every public contract rejects blank aggregate and entity identifiers", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly parse: (input: unknown) => unknown;
    readonly path: string;
    readonly input: Record<string, unknown>;
  }> = [
    {
      name: "Forum Task intake",
      parse: parseForumTaskIntake,
      path: "postId",
      input: {
        protocolVersion: "v1",
        forumId: "forum-product",
        postId: " ",
        authorId: "owner-001",
        title: "Verify launch readiness",
        body: "Research the checks.",
      },
    },
    {
      name: "Work Order",
      parse: parseWorkOrder,
      path: "workOrderId",
      input: {
        protocolVersion: "v1",
        workOrderId: "\t",
        title: "Research launch checks",
        brief: "Verify every launch-readiness check.",
        completionCriteria: [],
        requiredCapabilities: [],
        constraints: [],
        dependsOn: [],
      },
    },
    {
      name: "semantic planning response",
      parse: parseSemanticPlanningResponse,
      path: "taskId",
      input: {
        protocolVersion: "v1",
        taskId: "",
        workOrders: [],
      },
    },
    {
      name: "Worker report",
      parse: parseWorkerReport,
      path: "workerId",
      input: {
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrderId: "work-order-research",
        deviceId: "device-mac-research",
        workerId: " ",
        routeId: "route-mac-lan",
        runId: "run-research-001",
        leaseId: "lease-research-001",
        fencingToken: 3,
        status: "succeeded",
        report: "Checks passed.",
        artifactRefs: [],
      },
    },
    {
      name: "Artifact reference",
      parse: parseArtifactReference,
      path: "artifactId",
      input: {
        protocolVersion: "v1",
        artifactId: "\n",
        href: "https://reports.example.test/artifacts/launch-readiness",
      },
    },
    {
      name: "event envelope message identity",
      parse: parseEventEnvelope,
      path: "messageId",
      input: {
        protocolVersion: "v1",
        messageId: " ",
        senderDeviceId: "device-main",
        correlationId: "task-launch-report",
        createdAt: "2026-07-24T10:30:00.000Z",
        idempotencyKey: "task-created:1",
        type: "task.created",
        payload: {},
      },
    },
    {
      name: "event envelope sender Device identity",
      parse: parseEventEnvelope,
      path: "senderDeviceId",
      input: {
        protocolVersion: "v1",
        messageId: "message-001",
        senderDeviceId: "",
        correlationId: "task-launch-report",
        createdAt: "2026-07-24T10:30:00.000Z",
        idempotencyKey: "task-created:1",
        type: "task.created",
        payload: {},
      },
    },
    {
      name: "event envelope correlation identity",
      parse: parseEventEnvelope,
      path: "correlationId",
      input: {
        protocolVersion: "v1",
        messageId: "message-001",
        senderDeviceId: "device-main",
        correlationId: " ",
        createdAt: "2026-07-24T10:30:00.000Z",
        idempotencyKey: "task-created:1",
        type: "task.created",
        payload: {},
      },
    },
    {
      name: "event envelope idempotency identity",
      parse: parseEventEnvelope,
      path: "idempotencyKey",
      input: {
        protocolVersion: "v1",
        messageId: "message-001",
        senderDeviceId: "device-main",
        correlationId: "task-launch-report",
        createdAt: "2026-07-24T10:30:00.000Z",
        idempotencyKey: "\t",
        type: "task.created",
        payload: {},
      },
    },
  ];

  for (const contract of cases) {
    assert.throws(
      () => contract.parse(contract.input),
      (error: unknown) => {
        assert.equal(error instanceof ProtocolValidationError, true, contract.name);
        assert.equal((error as ProtocolValidationError).code, "BLANK_IDENTIFIER", contract.name);
        assert.equal((error as ProtocolValidationError).path, contract.path, contract.name);
        return true;
      },
    );
  }
});

test("a semantic planning response rejects a malformed Work Order collection", () => {
  assert.throws(
    () =>
      parseSemanticPlanningResponse({
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrders: {},
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT");
      assert.equal((error as ProtocolValidationError).path, "workOrders");
      return true;
    },
  );
});

test("a semantic planning request validates nested eligible Device evidence", () => {
  assert.throws(
    () =>
      parseSemanticPlanningRequest({
        protocolVersion: "v1",
        taskId: "task-launch-report",
        objective: "Verify launch readiness.",
        completionCriteria: [],
        constraints: [],
        selectedInputRefs: [],
        decisions: [],
        openQuestions: [],
        eligibleDevices: [
          {
            protocolVersion: "v1",
            deviceId: "device-mac-research",
            roles: [],
            verifiedCapabilities: ["research", " "],
          },
        ],
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "MALFORMED_CAPABILITY_ARRAY");
      assert.equal(
        (error as ProtocolValidationError).path,
        "eligibleDevices[0].verifiedCapabilities[1]",
      );
      return true;
    },
  );
});

test("a standalone Work Order rejects malformed completion criteria", () => {
  assert.throws(
    () =>
      parseWorkOrder({
        protocolVersion: "v1",
        workOrderId: "work-order-research",
        title: "Research launch checks",
        brief: "Verify every launch-readiness check.",
        completionCriteria: "Return a concise result.",
        requiredCapabilities: ["research"],
        constraints: [],
        dependsOn: [],
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT");
      assert.equal((error as ProtocolValidationError).path, "completionCriteria");
      return true;
    },
  );
});

test("a standalone Work Order rejects a malformed capability array", () => {
  assert.throws(
    () =>
      parseWorkOrder({
        protocolVersion: "v1",
        workOrderId: "work-order-research",
        title: "Research launch checks",
        brief: "Verify every launch-readiness check.",
        completionCriteria: ["Return a concise result."],
        requiredCapabilities: { capability: "research" },
        constraints: [],
        dependsOn: [],
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "MALFORMED_CAPABILITY_ARRAY");
      assert.equal((error as ProtocolValidationError).path, "requiredCapabilities");
      return true;
    },
  );
});

test("a Worker report rejects an unknown status", () => {
  assert.throws(
    () =>
      parseWorkerReport({
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrderId: "work-order-research",
        deviceId: "device-mac-research",
        workerId: "worker-mac-research",
        routeId: "route-mac-lan",
        runId: "run-research-001",
        leaseId: "lease-research-001",
        fencingToken: 3,
        status: "completed",
        report: "Checks passed.",
        artifactRefs: [],
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT");
      assert.equal((error as ProtocolValidationError).path, "status");
      return true;
    },
  );
});

test("an Artifact reference rejects a blank link", () => {
  assert.throws(
    () =>
      parseArtifactReference({
        protocolVersion: "v1",
        artifactId: "artifact-launch-report",
        href: " ",
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT");
      assert.equal((error as ProtocolValidationError).path, "href");
      return true;
    },
  );
});

test("an Artifact reference accepts only credential-free HTTP(S) links", () => {
  for (const href of [
    "javascript:alert(1)",
    "file:///tmp/report.html",
    "https://owner:secret@reports.example.test/report",
    "not-a-url",
  ]) {
    assert.throws(
      () =>
        parseArtifactReference({
          protocolVersion: PROTOCOL_VERSION,
          artifactId: "artifact-launch-report",
          href,
        }),
      (error: unknown) => {
        assert.equal(error instanceof ProtocolValidationError, true);
        assert.equal((error as ProtocolValidationError).path, "href");
        return true;
      },
    );
  }
});

test("an Artifact reference rejects URL text altered by parser whitespace normalization", () => {
  assert.throws(
    () =>
      parseArtifactReference({
        protocolVersion: PROTOCOL_VERSION,
        artifactId: "artifact-launch-report",
        href: "https://reports.example.test/a\nb",
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).path, "href");
      return true;
    },
  );
});

test("a Worker report rejects a malformed Artifact reference collection", () => {
  assert.throws(
    () =>
      parseWorkerReport({
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrderId: "work-order-research",
        deviceId: "device-mac-research",
        workerId: "worker-mac-research",
        routeId: "route-mac-lan",
        runId: "run-research-001",
        leaseId: "lease-research-001",
        fencingToken: 3,
        status: "succeeded",
        report: "Checks passed.",
        artifactRefs: "artifact-launch-report",
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT");
      assert.equal((error as ProtocolValidationError).path, "artifactRefs");
      return true;
    },
  );
});

test("an event envelope accepts canonical RFC3339 creation times with UTC or explicit offsets", () => {
  const validCreationTimes = [
    "2026-07-24T10:30:00Z",
    "2026-07-24T19:30:00.123+09:00",
    "2024-02-29T06:00:00.123456-04:30",
  ];

  for (const createdAt of validCreationTimes) {
    const event = parseEventEnvelope({
      protocolVersion: "v1",
      messageId: "message-001",
      senderDeviceId: "device-main",
      correlationId: "task-launch-report",
      createdAt,
      idempotencyKey: "task-created:1",
      type: "task.created",
      payload: {},
    });

    assert.equal(event.createdAt, createdAt);
  }
});

test("an event envelope rejects creation times without the canonical instant shape", () => {
  const invalidCreationTimes = [
    "07/24/2026 10:30:00",
    "2026-07-24",
    "2026-07-24T10:30:00",
    "2026-07-24 10:30:00Z",
    "2026-07-24T10:30:00+24:00",
    "2026-07-24T10:30:00+09:60",
  ];

  for (const createdAt of invalidCreationTimes) {
    assert.throws(
      () =>
        parseEventEnvelope({
          protocolVersion: "v1",
          messageId: "message-001",
          senderDeviceId: "device-main",
          correlationId: "task-launch-report",
          createdAt,
          idempotencyKey: "task-created:1",
          type: "task.created",
          payload: {},
        }),
      (error: unknown) => {
        assert.equal(error instanceof ProtocolValidationError, true, createdAt);
        assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT", createdAt);
        assert.equal((error as ProtocolValidationError).path, "createdAt", createdAt);
        return true;
      },
    );
  }
});

test("an event envelope rejects calendar-normalized invalid creation times", () => {
  const invalidCreationTimes = [
    "2026-02-29T10:30:00Z",
    "2026-04-31T10:30:00+09:00",
    "2024-02-30T10:30:00-04:30",
  ];

  for (const createdAt of invalidCreationTimes) {
    assert.throws(
      () =>
        parseEventEnvelope({
          protocolVersion: "v1",
          messageId: "message-001",
          senderDeviceId: "device-main",
          correlationId: "task-launch-report",
          createdAt,
          idempotencyKey: "task-created:1",
          type: "task.created",
          payload: {},
        }),
      (error: unknown) => {
        assert.equal(error instanceof ProtocolValidationError, true, createdAt);
        assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT", createdAt);
        assert.equal((error as ProtocolValidationError).path, "createdAt", createdAt);
        return true;
      },
    );
  }
});

test("an event envelope rejects a malformed creation time", () => {
  assert.throws(
    () =>
      parseEventEnvelope({
        protocolVersion: "v1",
        messageId: "message-001",
        senderDeviceId: "device-main",
        correlationId: "task-launch-report",
        createdAt: "yesterday",
        idempotencyKey: "task-created:1",
        type: "task.created",
        payload: {},
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT");
      assert.equal((error as ProtocolValidationError).path, "createdAt");
      return true;
    },
  );
});

test("a semantic planning response validates each nested Work Order version", () => {
  assert.throws(
    () =>
      parseSemanticPlanningResponse({
        protocolVersion: "v1",
        taskId: "task-launch-report",
        workOrders: [
          {
            protocolVersion: "v2",
            workOrderId: "work-order-research",
            title: "Research launch checks",
            brief: "Verify every launch-readiness check.",
            completionCriteria: [],
            requiredCapabilities: [],
            constraints: [],
            dependsOn: [],
          },
        ],
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "UNKNOWN_PROTOCOL_VERSION");
      assert.equal((error as ProtocolValidationError).path, "workOrders[0].protocolVersion");
      return true;
    },
  );
});

test("an event envelope requires an explicit payload field", () => {
  assert.throws(
    () =>
      parseEventEnvelope({
        protocolVersion: "v1",
        messageId: "message-001",
        senderDeviceId: "device-main",
        correlationId: "task-launch-report",
        createdAt: "2026-07-24T10:30:00.000Z",
        idempotencyKey: "task-created:1",
        type: "task.created",
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProtocolValidationError, true);
      assert.equal((error as ProtocolValidationError).code, "INVALID_CONTRACT");
      assert.equal((error as ProtocolValidationError).path, "payload");
      return true;
    },
  );
});
