import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createTaskContinuationCheckpoint } from "@opendelegate/protocol";
import { createWorkerRouteIncident } from "@opendelegate/worker-runtime";

import {
  DeviceChannelProtocolError,
  decodeDeviceChannelFrame,
  type DeviceChannelFrameV1,
} from "../src/index.ts";

const transportProfileRevision = `sha256:${"a".repeat(64)}` as const;

const heartbeat = {
  protocolVersion: "v1",
  messageId: "message-heartbeat-1",
  senderDeviceId: "worker-1",
  correlationId: "connection-1",
  createdAt: "2026-07-25T00:00:00.000Z",
  idempotencyKey: "heartbeat-worker-1-1",
  sequence: 1,
  type: "worker.heartbeat",
  payload: {
    protocolVersion: "v1",
    deviceId: "worker-1",
    workerId: "worker-runtime-1",
    observedAtMs: 1_753_401_600_000,
    operationalState: "active",
    connectionState: "online",
    readiness: {
      daemon: "healthy",
      session: "unavailable",
      desktop: "unavailable",
      permissions: {
        accessibility: "not-applicable",
        input: "not-applicable",
        screenCapture: "not-applicable",
      },
    },
    capacity: {
      acceptingWork: true,
      activeRuns: 0,
      maxOutboxEntries: 1_024,
      outboxDepth: 0,
    },
    inventory: {
      deviceName: "Build workstation",
      osFamily: "windows",
      platformRelease: "11",
      architecture: "x64",
      serviceMode: "foreground",
      knowledgeHealth: "healthy",
      hardware: {
        cpu: {
          model: "Example CPU",
          logicalCoreCount: 16,
          observedAtMs: 1_753_401_599_000,
          source: "node-os",
          verification: "observed",
        },
        memory: {
          totalBytes: 68_719_476_736,
          observedAtMs: 1_753_401_599_000,
          source: "node-os",
          verification: "observed",
        },
        gpu: {
          devices: [
            {
              model: "Example GPU",
              vendor: "Example Vendor",
              memoryBytes: 17_179_869_184,
            },
          ],
          observedAtMs: 1_753_401_599_000,
          source: "platform-probe",
          verification: "verified",
        },
      },
      maximumConcurrentRuns: 4,
      capabilities: [
        {
          name: "codex",
          verification: "verified",
          observedAtMs: 1_753_401_599_000,
          evidenceSource: "agent-adapter",
          version: "1.2.3",
        },
        { name: "computer-use", verification: "degraded" },
      ],
      agentAdapters: [
        {
          provider: "codex",
          adapterId: "codex-cli",
          readiness: "ready",
          compatibility: "tested",
          version: "1.2.3",
          observedAtMs: 1_753_401_599_000,
        },
      ],
      wakeOnLan: {
        state: "enabled",
        source: "windows-netadapter-power",
        observedAtMs: 1_753_401_599_000,
      },
      resourceLocks: [
        {
          resourceName: "desktop-session",
          capacity: 1,
          holders: [],
        },
      ],
      workspaceIds: ["workspace-product"],
      availableSecretRefs: ["package-registry"],
    },
    routes: [
      {
        routeId: `route:${"a".repeat(64)}:0`,
        label: "Route 1",
        priority: 0,
        kind: "wss",
        profileRevision: transportProfileRevision,
        health: "healthy",
        lastAttempt: {
          probeSource: "live",
          outcome: "connected",
          observedAtMs: 1_753_401_600_000,
        },
      },
    ],
    currentRuns: [],
  },
} as const satisfies DeviceChannelFrameV1;

describe("Device channel protocol", () => {
  test("accepts only exact bounded Run steering commands and receipts", () => {
    const agentSession = {
      provider: "codex" as const,
      adapterId: "codex-app-server",
      adapterVersion: "0.145.0",
      nativeSessionId: "thread-native-1",
      workstreamId: "implementation",
      workspaceId: "workspace-product",
      lineage: {
        lineageId: "lineage-1",
      },
    };
    const command = {
      protocolVersion: "v1",
      messageId: "steer-request-1",
      senderDeviceId: "main-device-1",
      correlationId: "task-1",
      createdAt: "2026-07-25T00:04:00.000Z",
      idempotencyKey: "steer-request-1",
      sequence: 4,
      type: "main.run.steer",
      payload: {
        requestId: "steer-request-1",
        taskId: "task-1",
        workOrderId: "work-order-1",
        deviceId: "worker-1",
        workerId: "worker-runtime-1",
        routeId: "route-1",
        runId: "run-1",
        leaseId: "lease-1",
        fencingToken: 3,
        instruction: "Also verify the release manifest.",
        requestedBy: "owner",
        agentSession,
      },
    };
    const receipt = {
      protocolVersion: "v1",
      messageId: "run-steering-receipt-1",
      senderDeviceId: "worker-1",
      correlationId: "steer-request-1",
      createdAt: "2026-07-25T00:04:00.100Z",
      idempotencyKey: "run-steering-receipt-1",
      sequence: 7,
      type: "worker.run.steering",
      payload: {
        requestId: "steer-request-1",
        requestMessageId: "steer-request-1",
        taskId: "task-1",
        workOrderId: "work-order-1",
        deviceId: "worker-1",
        workerId: "worker-runtime-1",
        routeId: "route-1",
        runId: "run-1",
        leaseId: "lease-1",
        fencingToken: 3,
        agentSession,
        delivery: "live",
        status: "accepted",
        reasonCode: "LIVE_STEERING_ACCEPTED",
        decidedAtMs: 1_753_401_840_100,
        providerTurnId: "turn-1",
      },
    };

    assert.equal(
      decodeDeviceChannelFrame(JSON.stringify(command), "main-device-1", "main-to-worker").type,
      "main.run.steer",
    );
    assert.equal(
      decodeDeviceChannelFrame(JSON.stringify(receipt), "worker-1", "worker-to-main").type,
      "worker.run.steering",
    );
    for (const invalid of [
      {
        ...command,
        payload: {
          ...command.payload,
          sessionKey: "device-local-session-key",
        },
      },
      {
        ...receipt,
        payload: {
          ...receipt.payload,
          status: "queued",
        },
      },
    ]) {
      assert.throws(
        () =>
          decodeDeviceChannelFrame(
            JSON.stringify(invalid),
            invalid.senderDeviceId,
            invalid.type === "main.run.steer" ? "main-to-worker" : "worker-to-main",
          ),
        (error: unknown) =>
          error instanceof DeviceChannelProtocolError && error.code === "FRAME_INVALID",
      );
    }
  });

  test("accepts exact clock-calibrated hello, welcome, and Run lease renewal frames", () => {
    const hello = {
      protocolVersion: "v1",
      messageId: "hello-message-1",
      senderDeviceId: "worker-1",
      correlationId: "connection-1",
      createdAt: "2026-07-25T00:00:00.000Z",
      idempotencyKey: "hello-message-1",
      sequence: 1,
      type: "worker.hello",
      payload: {
        deviceId: "worker-1",
        workerId: "worker-runtime-1",
        certificateGeneration: 1,
        minimumProtocolVersion: "v1",
        maximumProtocolVersion: "v1",
        acknowledgedMainSequence: 0,
        workerWallSentAtMs: 1_753_401_600_000,
      },
    };
    const welcome = {
      protocolVersion: "v1",
      messageId: "welcome-message-1",
      senderDeviceId: "main-device-1",
      correlationId: "connection-1",
      createdAt: "2026-07-25T00:00:00.100Z",
      idempotencyKey: "welcome-message-1",
      sequence: 1,
      type: "main.welcome",
      payload: {
        deviceId: "worker-1",
        acceptedProtocolVersion: "v1",
        acknowledgedWorkerSequence: 0,
        nextMainSequence: 2,
        heartbeatIntervalMs: 15_000,
        maximumInFlightFrames: 64,
        workerWallSentAtMs: 1_753_401_600_000,
        mainReceivedAtMs: 1_753_401_600_050,
        mainSentAtMs: 1_753_401_600_100,
        maximumHandshakeRttMs: 5_000,
        maximumAbsoluteClockSkewMs: 60_000,
      },
    };
    const renewal = {
      protocolVersion: "v1",
      messageId: "renewal-message-1",
      senderDeviceId: "worker-1",
      correlationId: "task-1",
      createdAt: "2026-07-25T00:04:00.000Z",
      idempotencyKey: "renewal-1",
      sequence: 2,
      type: "worker.run.renew",
      payload: {
        taskId: "task-1",
        workOrderId: "work-order-1",
        deviceId: "worker-1",
        workerId: "worker-runtime-1",
        routeId: "route-main",
        runId: "run-1",
        leaseId: "lease-1",
        fencingToken: 1,
        renewalId: "renewal-1",
        priorLeaseExpiresAtMs: 1_753_401_900_000,
      },
    };
    const renewed = {
      protocolVersion: "v1",
      messageId: "renewal-response-1",
      senderDeviceId: "main-device-1",
      correlationId: "renewal-message-1",
      createdAt: "2026-07-25T00:04:00.100Z",
      idempotencyKey: "renewal-response-1",
      sequence: 2,
      type: "main.run.lease",
      payload: {
        requestMessageId: "renewal-message-1",
        ...renewal.payload,
        status: "renewed",
        renewedAtMs: 1_753_401_840_050,
        leaseExpiresAtMs: 1_753_402_140_050,
      },
    };

    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(hello), "worker-1", "worker-to-main"),
      hello,
    );
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(welcome), "main-device-1", "main-to-worker"),
      welcome,
    );
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(renewal), "worker-1", "worker-to-main"),
      renewal,
    );
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(renewed), "main-device-1", "main-to-worker"),
      renewed,
    );
    assert.throws(
      () =>
        decodeDeviceChannelFrame(
          JSON.stringify({
            ...renewal,
            payload: { ...renewal.payload, priorLeaseExpiresAtMs: -1 },
          }),
          "worker-1",
          "worker-to-main",
        ),
      { code: "FRAME_INVALID" },
    );
  });

  test("accepts one exact bounded versioned Worker heartbeat", () => {
    const decoded = decodeDeviceChannelFrame(
      Buffer.from(JSON.stringify(heartbeat)),
      "worker-1",
      "worker-to-main",
    );

    assert.deepEqual(decoded, heartbeat);
    assert.equal(Object.isFrozen(decoded), true);
    assert.equal(Object.isFrozen(decoded.payload), true);

    const uncertain = {
      ...heartbeat,
      payload: {
        ...heartbeat.payload,
        inventory: {
          ...heartbeat.payload.inventory,
          wakeOnLan: {
            ...heartbeat.payload.inventory.wakeOnLan,
            state: "unknown",
          },
        },
      },
    } as const;
    const uncertainDecoded = decodeDeviceChannelFrame(
      JSON.stringify(uncertain),
      "worker-1",
      "worker-to-main",
    );
    assert.equal(uncertainDecoded.type, "worker.heartbeat");
    if (uncertainDecoded.type !== "worker.heartbeat") {
      throw new Error("Expected a Worker heartbeat.");
    }
    assert.equal(uncertainDecoded.payload.inventory?.wakeOnLan?.state, "unknown");
  });

  test("accepts only the dedicated fingerprint-bound route incident contract", () => {
    const incident = createWorkerRouteIncident({
      profile: {
        deviceId: "main-device-1",
        endpoints: [
          {
            endpointId: "private-route",
            label: "Private route",
            kind: "wss",
            url: "wss://private-main.example.test/device",
            credentialRef: "secret://device-certificate",
          },
        ],
      },
      attempts: [
        {
          endpointId: "private-route",
          label: "Private route",
          kind: "wss",
          probeSource: "live",
          outcome: "connect-failed",
          failureStage: "connect",
          diagnostic: {
            code: "ECONNREFUSED",
            token: "must-not-cross",
          },
        },
      ],
      occurrenceSeed: "occurrence-1",
    });
    const frame = {
      protocolVersion: "v1",
      messageId: "route-incident-message-1",
      senderDeviceId: "worker-1",
      correlationId: incident.fingerprint,
      createdAt: "2026-07-25T00:00:00.000Z",
      idempotencyKey: "route-incident-delivery-1",
      sequence: 2,
      type: "worker.route.incident",
      payload: incident,
    } as const;
    const decoded = decodeDeviceChannelFrame(JSON.stringify(frame), "worker-1", "worker-to-main");
    assert.deepEqual(decoded, frame);
    const serialized = JSON.stringify(decoded);
    assert.equal(serialized.includes("private-main"), false);
    assert.equal(serialized.includes("device-certificate"), false);
    assert.equal(serialized.includes("must-not-cross"), false);

    for (const payload of [
      { ...incident, endpointUrl: "wss://private-main.example.test/device" },
      { ...incident, attempts: [{ ...incident.attempts[0], label: "Private route" }] },
      {
        ...incident,
        attempts: [{ ...incident.attempts[0], code: "PRIVATE_PROVIDER_MESSAGE" }],
      },
      { ...incident, fingerprint: incident.incidentId },
    ]) {
      assert.throws(
        () =>
          decodeDeviceChannelFrame(
            JSON.stringify({ ...frame, payload }),
            "worker-1",
            "worker-to-main",
          ),
        { code: "FRAME_INVALID" },
      );
    }
  });

  test("rejects extra authority, unknown message types, sender mismatch, and oversized frames", () => {
    const attacks: readonly unknown[] = [
      { ...heartbeat, shell: "rm -rf /" },
      { ...heartbeat, type: "worker.shell", payload: { command: "whoami" } },
      { ...heartbeat, senderDeviceId: "worker-2" },
      { ...heartbeat, payload: { ...heartbeat.payload, databaseUri: "postgres://main" } },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          inventory: {
            ...heartbeat.payload.inventory,
            capabilities: [{ name: "codex", verification: "self-declared" }],
          },
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          inventory: {
            ...heartbeat.payload.inventory,
            wakeOnLan: {
              ...heartbeat.payload.inventory.wakeOnLan,
              observedAtMs: heartbeat.payload.observedAtMs + 1,
            },
          },
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          inventory: {
            ...heartbeat.payload.inventory,
            wakeOnLan: {
              ...heartbeat.payload.inventory.wakeOnLan,
              source: "macos-pmset",
            },
          },
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          inventory: {
            ...heartbeat.payload.inventory,
            wakeOnLan: {
              ...heartbeat.payload.inventory.wakeOnLan,
              source: "probe-unavailable",
            },
          },
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          inventory: {
            ...heartbeat.payload.inventory,
            wakeOnLan: {
              ...heartbeat.payload.inventory.wakeOnLan,
              macAddress: "00:11:22:33:44:55",
            },
          },
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          inventory: {
            ...heartbeat.payload.inventory,
            hardware: {
              ...heartbeat.payload.inventory.hardware,
              gpu: {
                ...heartbeat.payload.inventory.hardware.gpu,
                devices: [{ model: "/sys/class/drm/card0/device" }],
              },
            },
          },
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          inventory: {
            ...heartbeat.payload.inventory,
            hardware: {
              ...heartbeat.payload.inventory.hardware,
              cpu: {
                ...heartbeat.payload.inventory.hardware.cpu,
                observedAtMs: heartbeat.payload.observedAtMs + 1,
              },
            },
          },
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          inventory: {
            ...heartbeat.payload.inventory,
            hardware: {
              ...heartbeat.payload.inventory.hardware,
              gpu: {
                ...heartbeat.payload.inventory.hardware.gpu,
                devices: [
                  {
                    model: "Example GPU",
                    localPath: "C:\\Windows\\System32\\DriverStore\\secret",
                  },
                ],
              },
            },
          },
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          routes: [{ ...heartbeat.payload.routes[0], label: "Private Main route" }],
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          routes: [
            {
              ...heartbeat.payload.routes[0],
              endpointUrl: "wss://private-main.example.test/worker",
            },
          ],
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          inventory: {
            ...heartbeat.payload.inventory,
            agentAdapters: [
              {
                ...heartbeat.payload.inventory.agentAdapters[0],
                diagnostics: [{ message: "private provider output" }],
              },
            ],
          },
        },
      },
      {
        ...heartbeat,
        payload: {
          ...heartbeat.payload,
          currentRuns: [
            {
              taskId: "task-1",
              workOrderId: "work-order-1",
              runId: "run-1",
              state: "running",
              acceptedAtMs: 1_753_401_599_000,
              leaseExpiresAtMs: 1_753_401_700_000,
              leaseId: "must-not-cross",
            },
          ],
          capacity: { ...heartbeat.payload.capacity, activeRuns: 1 },
        },
      },
    ];

    for (const attack of attacks) {
      assert.throws(
        () =>
          decodeDeviceChannelFrame(
            Buffer.from(JSON.stringify(attack)),
            "worker-1",
            "worker-to-main",
          ),
        (error: unknown) =>
          error instanceof DeviceChannelProtocolError &&
          (error.code === "FRAME_INVALID" ||
            error.code === "MESSAGE_TYPE_FORBIDDEN" ||
            error.code === "SENDER_IDENTITY_MISMATCH"),
      );
    }

    assert.throws(
      () => decodeDeviceChannelFrame(Buffer.alloc(1_048_577, 0x20), "worker-1", "worker-to-main"),
      (error: unknown) =>
        error instanceof DeviceChannelProtocolError && error.code === "FRAME_TOO_LARGE",
    );
  });

  test("preserves bounded provider usage on a terminal Worker event", () => {
    const frame = {
      protocolVersion: "v1",
      messageId: "message-events-1",
      senderDeviceId: "worker-1",
      correlationId: "connection-1",
      createdAt: "2026-07-25T00:00:00.000Z",
      idempotencyKey: "events-worker-1-1",
      sequence: 2,
      type: "worker.events",
      payload: {
        events: [
          {
            protocolVersion: "v1",
            messageId: "run-1:succeeded",
            senderDeviceId: "worker-1",
            correlationId: "task-1",
            createdAt: "2026-07-25T00:00:01.000Z",
            idempotencyKey: "run-1:lease-1:1:succeeded",
            sequence: 2,
            type: "worker.run.succeeded",
            payload: {
              taskId: "task-1",
              workOrderId: "work-order-1",
              deviceId: "worker-1",
              workerId: "worker-runtime-1",
              routeId: "route-main",
              runId: "run-1",
              leaseId: "lease-1",
              fencingToken: 1,
              report: "Completed with provider accounting.",
              artifactIds: [],
              usage: {
                inputTokens: 120,
                outputTokens: 80,
                cachedInputTokens: 20,
                costUsdMicros: 4_200,
              },
            },
          },
        ],
      },
    };

    const decoded = decodeDeviceChannelFrame(
      Buffer.from(JSON.stringify(frame)),
      "worker-1",
      "worker-to-main",
    );
    assert.equal(decoded.type, "worker.events");
    assert.deepEqual(
      decoded.type === "worker.events" ? decoded.payload.events[0]?.payload.usage : undefined,
      {
        inputTokens: 120,
        outputTokens: 80,
        cachedInputTokens: 20,
        costUsdMicros: 4_200,
      },
    );
  });

  test("preserves an immutable Agent requirement and safe native-session lineage", () => {
    const continuationCheckpoint = createTaskContinuationCheckpoint({
      schemaVersion: 1,
      taskId: "task-provider-bound",
      taskVersion: 7,
      summary: {
        state: "running",
        mode: "auto",
        objective: "Complete the provider-bound Task.",
        rollingSummary: "The Task is ready for its required Worker provider.",
        completionCriteria: ["Return a provider-bound result."],
        constraints: [],
      },
      decisions: [],
      pendingWorkOrders: [
        {
          workOrderId: "work-order-provider-bound",
          title: "Run with Claude",
          brief: "Use the required native provider.",
          completionCriteria: ["Return a provider-bound result."],
          constraints: [],
          dependsOn: [],
          requiredCapabilities: ["claude-code"],
          omitted: {
            completionCriteria: 0,
            constraints: 0,
            dependsOn: 0,
            requiredCapabilities: 0,
          },
          requiredAgent: {
            provider: "claude",
            adapterId: "claude-agent-sdk",
            allowedCompatibilities: ["tested"],
          },
        },
      ],
      artifacts: [],
      messages: [],
      sessions: [],
      omitted: {
        completionCriteria: 0,
        constraints: 0,
        decisions: 0,
        pendingWorkOrders: 0,
        artifacts: 0,
        messages: 0,
        sessions: 0,
      },
    });
    const dispatch = {
      protocolVersion: "v1",
      messageId: "dispatch-provider-bound-1",
      senderDeviceId: "main-device-1",
      correlationId: "task-provider-bound",
      createdAt: "2026-07-25T00:00:00.000Z",
      idempotencyKey: "dispatch:run-provider-bound",
      sequence: 1,
      type: "main.dispatch",
      payload: {
        taskId: "task-provider-bound",
        workOrder: {
          protocolVersion: "v1",
          workOrderId: "work-order-provider-bound",
          title: "Run with Claude",
          brief: "Use the required native provider.",
          completionCriteria: ["Return a provider-bound result."],
          constraints: [],
          selectedInputIds: [],
          dependsOn: [],
          schedulingHints: { preferredDeviceIds: [], preferredRoles: [] },
          requiredCapabilities: ["claude-code"],
          requiredSecretRefs: [],
          requiredAgent: {
            provider: "claude",
            adapterId: "claude-agent-sdk",
            allowedCompatibilities: ["tested"],
          },
        },
        agentRequirement: {
          provider: "claude",
          adapterId: "claude-agent-sdk",
          allowedCompatibilities: ["tested"],
        },
        continuationCheckpoint,
        deviceId: "worker-1",
        workerId: "worker-runtime-1",
        routeId: "route-main",
        runId: "run-provider-bound",
        leaseId: "lease-provider-bound",
        fencingToken: 1,
        leaseExpiresAtMs: 1_753_401_900_000,
      },
    };
    const terminal = {
      protocolVersion: "v1",
      messageId: "message-provider-lineage-1",
      senderDeviceId: "worker-1",
      correlationId: "connection-1",
      createdAt: "2026-07-25T00:00:01.000Z",
      idempotencyKey: "events-provider-lineage-1",
      sequence: 2,
      type: "worker.events",
      payload: {
        events: [
          {
            protocolVersion: "v1",
            messageId: "run-provider-bound:succeeded",
            senderDeviceId: "worker-1",
            correlationId: "task-provider-bound",
            createdAt: "2026-07-25T00:00:01.000Z",
            idempotencyKey: "run-provider-bound:lease-provider-bound:1:succeeded",
            sequence: 2,
            type: "worker.run.succeeded",
            payload: {
              taskId: "task-provider-bound",
              workOrderId: "work-order-provider-bound",
              deviceId: "worker-1",
              workerId: "worker-runtime-1",
              routeId: "route-main",
              runId: "run-provider-bound",
              leaseId: "lease-provider-bound",
              fencingToken: 1,
              report: "Provider-bound work completed.",
              artifactIds: [],
              agentSession: {
                provider: "claude",
                adapterId: "claude-agent-sdk",
                adapterVersion: "0.2.1",
                nativeSessionId: "native-session-7",
                workstreamId: "work-order-provider-bound",
                workspaceId: "workspace-product",
                lineage: {
                  lineageId: "lineage-task-provider-bound",
                  parentNativeSessionId: "native-session-6",
                  continuationReason: "native-session-resume-unavailable",
                },
              },
            },
          },
        ],
      },
    };

    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(dispatch), "main-device-1", "main-to-worker"),
      dispatch,
    );
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(terminal), "worker-1", "worker-to-main"),
      terminal,
    );
    assert.equal(JSON.stringify(terminal).includes("sessionKey"), false);
    assert.equal(JSON.stringify(terminal).includes("cwd"), false);
    assert.equal(JSON.stringify(terminal).includes("worktreePath"), false);

    const checkpointWithMismatchedTask = createTaskContinuationCheckpoint({
      schemaVersion: continuationCheckpoint.schemaVersion,
      taskId: "task-other",
      taskVersion: continuationCheckpoint.taskVersion,
      summary: continuationCheckpoint.summary,
      decisions: continuationCheckpoint.decisions,
      pendingWorkOrders: continuationCheckpoint.pendingWorkOrders,
      artifacts: continuationCheckpoint.artifacts,
      messages: continuationCheckpoint.messages,
      sessions: continuationCheckpoint.sessions,
      omitted: continuationCheckpoint.omitted,
    });
    assert.throws(
      () =>
        decodeDeviceChannelFrame(
          JSON.stringify({
            ...dispatch,
            payload: {
              ...dispatch.payload,
              continuationCheckpoint: checkpointWithMismatchedTask,
            },
          }),
          "main-device-1",
          "main-to-worker",
        ),
      (error: unknown) =>
        error instanceof DeviceChannelProtocolError && error.code === "FRAME_INVALID",
    );
    assert.throws(
      () =>
        decodeDeviceChannelFrame(
          JSON.stringify({
            ...dispatch,
            payload: {
              ...dispatch.payload,
              workOrder: {
                ...dispatch.payload.workOrder,
                workOrderId: "work-order-other",
              },
            },
          }),
          "main-device-1",
          "main-to-worker",
        ),
      (error: unknown) =>
        error instanceof DeviceChannelProtocolError && error.code === "FRAME_INVALID",
    );
    assert.throws(
      () =>
        decodeDeviceChannelFrame(
          JSON.stringify({
            ...dispatch,
            payload: {
              ...dispatch.payload,
              continuationCheckpoint: {
                ...continuationCheckpoint,
                summary: {
                  ...continuationCheckpoint.summary,
                  objective: "Tampered after hashing.",
                },
              },
            },
          }),
          "main-device-1",
          "main-to-worker",
        ),
      (error: unknown) =>
        error instanceof DeviceChannelProtocolError && error.code === "FRAME_INVALID",
    );
    assert.throws(
      () =>
        decodeDeviceChannelFrame(
          JSON.stringify({
            ...dispatch,
            payload: {
              ...dispatch.payload,
              continuationCheckpoint: {
                ...continuationCheckpoint,
                cwd: "C:\\private\\workspace",
              },
            },
          }),
          "main-device-1",
          "main-to-worker",
        ),
      (error: unknown) =>
        error instanceof DeviceChannelProtocolError && error.code === "FRAME_INVALID",
    );
  });

  test("accepts only exact Artifact prepare, grant, and rejection frames", () => {
    const manifest = {
      artifactId: "artifact-run-1-report",
      taskId: "task-1",
      workOrderId: "work-order-1",
      deviceId: "worker-1",
      workerId: "worker-runtime-1",
      routeId: "route-main",
      runId: "run-1",
      leaseId: "lease-1",
      fencingToken: 1,
      mediaType: "text/plain",
      originalFilename: "report.txt",
      declaredSizeBytes: 20,
      expectedSha256: "1".repeat(64),
      requestedPresentation: "inline",
    };
    const prepare = {
      protocolVersion: "v1",
      messageId: "artifact-prepare-1",
      senderDeviceId: "worker-1",
      correlationId: "task-1",
      createdAt: "2026-07-25T00:00:00.000Z",
      idempotencyKey: "artifact-prepare-1",
      sequence: 3,
      type: "worker.artifact.prepare",
      payload: manifest,
    };
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(prepare), "worker-1", "worker-to-main"),
      prepare,
    );
    assert.throws(
      () =>
        decodeDeviceChannelFrame(
          JSON.stringify({
            ...prepare,
            payload: { ...manifest, deviceId: "worker-2" },
          }),
          "worker-1",
          "worker-to-main",
        ),
      { code: "SENDER_IDENTITY_MISMATCH" },
    );

    const grant = {
      protocolVersion: "v1",
      messageId: "artifact-response-1",
      senderDeviceId: "main-device-1",
      correlationId: "artifact-prepare-1",
      createdAt: "2026-07-25T00:00:01.000Z",
      idempotencyKey: "artifact-response-1",
      sequence: 4,
      type: "main.artifact.grant",
      payload: {
        requestMessageId: "artifact-prepare-1",
        deviceId: "worker-1",
        grant: {
          protocolVersion: "v1",
          uploadId: "upload-run-1",
          artifactId: "artifact-run-1-report",
          uploadUrl: "https://main.example.test/worker-uploads/upload-run-1",
          credential: `u1.upload-run-1.${"a".repeat(43)}`,
          expiresAtMs: 2_000,
          maximumChunkBytes: 8_388_608,
          declaredSizeBytes: 20,
          expectedSha256: "1".repeat(64),
        },
      },
    };
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(grant), "main-device-1", "main-to-worker"),
      grant,
    );

    const rejected = {
      ...grant,
      messageId: "artifact-response-2",
      idempotencyKey: "artifact-response-2",
      type: "main.artifact.rejected",
      payload: {
        requestMessageId: "artifact-prepare-1",
        deviceId: "worker-1",
        artifactId: "artifact-run-1-report",
        code: "RUN_NOT_CURRENT",
        retryable: false,
      },
    };
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(rejected), "main-device-1", "main-to-worker"),
      rejected,
    );
    assert.throws(
      () =>
        decodeDeviceChannelFrame(
          JSON.stringify({
            ...rejected,
            payload: { ...rejected.payload, reason: "leaks internal state" },
          }),
          "main-device-1",
          "main-to-worker",
        ),
      { code: "FRAME_INVALID" },
    );
  });

  test("accepts only exact redacted two-phase action authorization frames", () => {
    const authorize = {
      protocolVersion: "v1",
      messageId: "action-request-message-1",
      senderDeviceId: "worker-1",
      correlationId: "run-1",
      createdAt: "2026-07-25T00:00:00.000Z",
      idempotencyKey: "action-request-run-1-1",
      sequence: 5,
      type: "worker.action.authorize",
      payload: {
        authorizationRequestId: "run-1:input:1",
        actionCategory: "computer-use-input",
        actionType: "type-text",
        actionFingerprint: `sha256:${"a".repeat(64)}`,
        actionDescriptor: {
          kind: "type-text",
          privacy: "exact-input-withheld-on-device",
        },
        requestedAtMs: 1_000,
        taskId: "task-1",
        workOrderId: "work-order-1",
        deviceId: "worker-1",
        workerId: "worker-runtime-1",
        routeId: "route-main",
        runId: "run-1",
        leaseId: "lease-1",
        fencingToken: 1,
        leaseExpiresAtMs: 2_000,
      },
    };
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(authorize), "worker-1", "worker-to-main"),
      authorize,
    );
    for (const privateExtension of [
      { controlId: "private-control-id" },
      { textSha256: `sha256:${"b".repeat(64)}` },
      { textLength: 32 },
    ]) {
      assert.throws(
        () =>
          decodeDeviceChannelFrame(
            JSON.stringify({
              ...authorize,
              payload: {
                ...authorize.payload,
                actionDescriptor: {
                  ...authorize.payload.actionDescriptor,
                  ...privateExtension,
                },
              },
            }),
            "worker-1",
            "worker-to-main",
          ),
        { code: "FRAME_INVALID" },
      );
    }
    assert.throws(
      () =>
        decodeDeviceChannelFrame(
          JSON.stringify({
            ...authorize,
            payload: {
              ...authorize.payload,
              actionType: "key",
              actionDescriptor: {
                kind: "key",
                privacy: "exact-input-withheld-on-device",
              },
            },
          }),
          "worker-1",
          "worker-to-main",
        ),
      { code: "FRAME_INVALID" },
    );

    const authorization = {
      protocolVersion: "v1",
      messageId: "action-response-message-1",
      senderDeviceId: "main-device-1",
      correlationId: "action-request-message-1",
      createdAt: "2026-07-25T00:00:01.000Z",
      idempotencyKey: "action-response-message-1",
      sequence: 6,
      type: "main.action.authorization",
      payload: {
        requestMessageId: "action-request-message-1",
        authorizationRequestId: "run-1:input:1",
        authorizationId: "authorization-1",
        actionFingerprint: `sha256:${"a".repeat(64)}`,
        decision: "allow",
        reasonCode: "POLICY_ALLOW",
      },
    };
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(authorization), "main-device-1", "main-to-worker"),
      authorization,
    );

    const consume = {
      ...authorize,
      messageId: "action-consume-message-1",
      idempotencyKey: "action-consume-run-1-1",
      sequence: 7,
      type: "worker.action.consume",
      payload: {
        authorizationRequestId: "run-1:input:1",
        authorizationId: "authorization-1",
        actionCategory: "computer-use-input",
        actionFingerprint: `sha256:${"a".repeat(64)}`,
        requestedAtMs: 1_100,
        taskId: "task-1",
        workOrderId: "work-order-1",
        deviceId: "worker-1",
        workerId: "worker-runtime-1",
        routeId: "route-main",
        runId: "run-1",
        leaseId: "lease-1",
        fencingToken: 1,
        leaseExpiresAtMs: 2_000,
      },
    };
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(consume), "worker-1", "worker-to-main"),
      consume,
    );

    const consumption = {
      ...authorization,
      messageId: "action-consumption-message-1",
      correlationId: "action-consume-message-1",
      idempotencyKey: "action-consumption-message-1",
      sequence: 8,
      type: "main.action.consumption",
      payload: {
        requestMessageId: "action-consume-message-1",
        authorizationRequestId: "run-1:input:1",
        authorizationId: "authorization-1",
        actionFingerprint: `sha256:${"a".repeat(64)}`,
        decision: "consumed",
        reasonCode: "CONSUMED",
      },
    };
    assert.deepEqual(
      decodeDeviceChannelFrame(JSON.stringify(consumption), "main-device-1", "main-to-worker"),
      consumption,
    );
  });
});
