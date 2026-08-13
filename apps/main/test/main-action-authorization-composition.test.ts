import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type {
  AgentAdapter,
  AgentRunHandle,
  AgentStartRequest,
  NativeSessionReference,
  NormalizedAgentEvent,
} from "@opendelegate/agent-adapters";
import type {
  MainActionAuthorizationRequest,
  MainActionConsumptionRequest,
  WorkerHeartbeatV1,
} from "@opendelegate/device-channel";
import {
  InMemoryDeviceIdentitySecretStore,
  type PersistedDeviceIdentity,
} from "@opendelegate/device-identity";
import type { ActionTargetValue, ApprovalExecutionContext } from "@opendelegate/policy";
import type { WorkerRunAssignmentV1 } from "@opendelegate/protocol";
import Database from "better-sqlite3";

import {
  LateBoundApprovalExecutionPort,
  LateBoundMainActionRunAuthorityPort,
} from "../src/action-authorization-composition.ts";
import type {
  CreateProductionMainDeviceChannelRuntimeOptions,
  MainDeviceChannelConfiguration,
  ProductionMainDeviceChannelRuntime,
} from "../src/device-channel-runtime.ts";
import { createMainTestSecretContext } from "../test-fixtures/main-test-secrets.ts";
import { createMainRuntime, initializeMainHome } from "../test-fixtures/portable-main-runtime.ts";

const WORKER_DEVICE_ID = "device-worker-action";
const WORKER_ID = "worker-action";
const DEVELOPMENT_RELEASE_IDENTITY = {
  declaredReleaseChannel: "development",
  releaseChannel: "development",
  releaseVerification: { status: "not-applicable" },
} as const;
const AGENT_LIMITS = {
  wallTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  cancellationGraceMs: 100,
  leaseTtlMs: 1_000,
  leaseRenewIntervalMs: 250,
  maxBufferedEvents: 8,
  maxLineBytes: 64 * 1024,
  maxDiagnosticBytes: 64 * 1024,
};

test("late-bound action composition ports fail closed and bind exactly once", async () => {
  const approvals = new LateBoundApprovalExecutionPort();
  await assert.rejects(approvals.execute({} as ApprovalExecutionContext), /not available/u);
  const expected: ActionTargetValue = { state: "authorized" };
  approvals.bind({
    async execute() {
      return expected;
    },
  });
  assert.deepEqual(await approvals.execute({} as ApprovalExecutionContext), expected);
  assert.throws(() => approvals.bind({ execute: async () => undefined }), TypeError);

  const authority = new LateBoundMainActionRunAuthorityPort();
  assert.deepEqual(await authority.authorizeWorkerActionRun(WORKER_DEVICE_ID, runScope()), {
    authorized: false,
  });
  authority.bind({
    async authorizeWorkerActionRun() {
      return { authorized: true, leaseExpiresAtMs: 5_000 };
    },
  });
  assert.deepEqual(await authority.authorizeWorkerActionRun(WORKER_DEVICE_ID, runScope()), {
    authorized: true,
    leaseExpiresAtMs: 5_000,
  });
  assert.throws(
    () =>
      authority.bind({
        async authorizeWorkerActionRun() {
          return { authorized: false };
        },
      }),
    TypeError,
  );
});

test(
  "production Main routes one current Worker action through owner approval and durable consumption",
  { timeout: 20_000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "opendelegate-main-action-composition-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const adminRoot = await createAdminFixture(home);
    const deviceChannel = await deviceChannelConfiguration(home);
    const mainSecrets = createMainTestSecretContext(home);
    const initialized = await initializeMainHome({
      home,
      adminRoot,
      sourceCheckout: resolve("."),
      deviceChannel,
      secretBackend: mainSecrets.configuration,
      managedSecretStore: mainSecrets.store,
    });
    const assignments: WorkerRunAssignmentV1[] = [];
    let callbacks: CreateProductionMainDeviceChannelRuntimeOptions | undefined;
    let channelClosed = false;
    const runtimeFactory = async (
      input: CreateProductionMainDeviceChannelRuntimeOptions,
    ): Promise<ProductionMainDeviceChannelRuntime> => {
      callbacks = input;
      return fakeDeviceChannelRuntime(assignments, () => {
        channelClosed = true;
      });
    };

    const runtime = await createMainRuntime({
      configuration: initialized.configuration,
      home,
      build: { version: "0.1.0-test", buildId: "worker-action-composition" },
      releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
      sourceCheckout: resolve("."),
      managedSecretStore: mainSecrets.store,
      deviceChannel: {
        identitySecrets: new InMemoryDeviceIdentitySecretStore(),
        runtimeFactory,
      },
      agentExecution: {
        adapter: new PlanningAgentAdapter(),
        workspace: {
          workspaceId: "workspace-main-action-composition",
          cwd: await realpath("."),
          isolation: "none",
        },
        sandbox: "read-only",
        permissions: { mode: "deny" },
        limits: AGENT_LIMITS,
        retryDelayMs: 0,
      },
    });
    t.after(() => runtime.close());
    const activeCallbacks = callbacks;
    assert.ok(activeCallbacks?.onHeartbeat);
    assert.ok(activeCallbacks.onActionAuthorize);
    assert.ok(activeCallbacks.onActionConsume);
    await activeCallbacks.onHeartbeat(WORKER_DEVICE_ID, heartbeat());

    const claim = await runtime.ownerAuth.issueInitialClaim({ channel: "local-bootstrap" });
    const owner = await runtime.ownerAuth.claimOwner({
      channel: "local-bootstrap",
      claimToken: claim.claimToken,
      passphrase: "correct horse battery staple",
    });
    const login = await runtime.ownerAuth.login({
      passphrase: "correct horse battery staple",
      sourceKey: "127.0.0.1",
    });
    await runtime.tasks.create({
      principalId: owner.ownerId,
      idempotencyKey: "worker-action-task",
      objective: "Select the desktop fixture option.",
      completionCriteria: ["The exact approved option is selected."],
      constraints: [],
      selectedInputRefs: [],
      mode: "auto",
    });
    await waitUntil(() => assignments.length === 1, "Worker Run dispatch");
    const assignment = assignments[0]!;
    const authorization = authorizationInput(assignment);

    const pending = await activeCallbacks.onActionAuthorize(authorization);
    assert.equal(pending.decision, "require-approval");
    const cookie = `__Host-opendelegate_session=${login.sessionToken}`;
    const listed = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/approvals",
      headers: {
        host: "127.0.0.1:4380",
        cookie,
      },
    });
    assert.equal(listed.statusCode, 200);
    const approvals = listed.json().approvals as Array<{
      approvalId: string;
      action: { category: string };
    }>;
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.action.category, "computer-use-input");
    const approvalId = approvals[0]!.approvalId;
    const decided = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      headers: {
        host: "127.0.0.1:4380",
        origin: "http://127.0.0.1:4380",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        cookie,
        "x-opendelegate-csrf": login.csrfToken,
        "idempotency-key": "approve-worker-action",
      },
      payload: { decision: "approve", scope: "once" },
    });
    assert.equal(decided.statusCode, 200, decided.body);
    assert.equal(decided.json().executionStatus, "succeeded");

    const allowed = await activeCallbacks.onActionAuthorize({
      ...authorization,
      requestMessageId: "action-authorize-message-retry",
      idempotencyKey: "action-authorize-idempotency-retry",
    });
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.authorizationId, pending.authorizationId);
    const consumption = consumptionInput(assignment, allowed.authorizationId);
    assert.deepEqual(await activeCallbacks.onActionConsume(consumption), {
      decision: "consumed",
      reasonCode: "AUTHORIZATION_CONSUMED",
    });
    assert.deepEqual(
      await activeCallbacks.onActionConsume({
        ...consumption,
        requestMessageId: "action-consume-message-retry",
        idempotencyKey: "action-consume-idempotency-retry",
      }),
      {
        decision: "consumed",
        reasonCode: "CONSUMPTION_REPLAY",
      },
    );

    assert.equal((await lstat(initialized.paths.sqliteFile)).isFile(), true);
    const sharedDatabase = new Database(initialized.paths.sqliteFile, { readonly: true });
    try {
      const row = sharedDatabase
        .prepare(
          `SELECT authorization_request_id, state_json
           FROM od_action_authorizations
           WHERE authorization_request_id = ?`,
        )
        .get("authorization-request-composition") as
        { readonly authorization_request_id: string; readonly state_json: string } | undefined;
      assert.equal(row?.authorization_request_id, "authorization-request-composition");
      assert.equal(typeof row?.state_json, "string");
      const observation = sharedDatabase
        .prepare(
          `SELECT event.payload_json
           FROM od_device_observation_latest AS latest
           INNER JOIN od_device_observation_events AS event
             ON event.device_id = latest.device_id
            AND event.observation_sequence = latest.observation_sequence
           WHERE latest.device_id = ?`,
        )
        .get(WORKER_DEVICE_ID) as { readonly payload_json: string } | undefined;
      assert.equal(
        (JSON.parse(observation?.payload_json ?? "{}") as { readonly deviceId?: string }).deviceId,
        WORKER_DEVICE_ID,
      );
    } finally {
      sharedDatabase.close();
    }
    await runtime.close();
    assert.equal(channelClosed, true);
    await assert.rejects(
      activeCallbacks.onActionAuthorize({
        ...authorization,
        requestMessageId: "action-after-close",
        idempotencyKey: "action-after-close",
      }),
      /closed/u,
    );
  },
);

function authorizationInput(assignment: WorkerRunAssignmentV1): MainActionAuthorizationRequest {
  return {
    authenticatedDeviceId: assignment.deviceId,
    requestMessageId: "action-authorize-message",
    idempotencyKey: "action-authorize-idempotency",
    request: {
      authorizationRequestId: "authorization-request-composition",
      actionCategory: "computer-use-input",
      actionType: "computer-use.click",
      actionFingerprint: `sha256:${"a".repeat(64)}`,
      actionDescriptor: {
        kind: "click",
        controlId: "option-alpha",
      },
      requestedAtMs: Date.now(),
      taskId: assignment.taskId,
      workOrderId: assignment.workOrder.workOrderId,
      deviceId: assignment.deviceId,
      workerId: assignment.workerId,
      routeId: assignment.routeId,
      runId: assignment.runId,
      leaseId: assignment.leaseId,
      fencingToken: assignment.fencingToken,
      leaseExpiresAtMs: assignment.leaseExpiresAtMs,
    },
  };
}

function consumptionInput(
  assignment: WorkerRunAssignmentV1,
  authorizationId: string,
): MainActionConsumptionRequest {
  return {
    authenticatedDeviceId: assignment.deviceId,
    requestMessageId: "action-consume-message",
    idempotencyKey: "action-consume-idempotency",
    request: {
      authorizationRequestId: "authorization-request-composition",
      authorizationId,
      actionCategory: "computer-use-input",
      actionFingerprint: `sha256:${"a".repeat(64)}`,
      requestedAtMs: Date.now(),
      taskId: assignment.taskId,
      workOrderId: assignment.workOrder.workOrderId,
      deviceId: assignment.deviceId,
      workerId: assignment.workerId,
      routeId: assignment.routeId,
      runId: assignment.runId,
      leaseId: assignment.leaseId,
      fencingToken: assignment.fencingToken,
      leaseExpiresAtMs: assignment.leaseExpiresAtMs,
    },
  };
}

function runScope() {
  return {
    taskId: "task-action",
    workOrderId: "work-order-action",
    deviceId: WORKER_DEVICE_ID,
    workerId: WORKER_ID,
    routeId: "route-action",
    runId: "run-action",
    leaseId: "lease-action",
    fencingToken: 1,
  };
}

function heartbeat(): WorkerHeartbeatV1 {
  const observedAtMs = Date.now();
  return {
    protocolVersion: "v1",
    deviceId: WORKER_DEVICE_ID,
    workerId: WORKER_ID,
    observedAtMs,
    operationalState: "active",
    connectionState: "online",
    readiness: {
      daemon: "healthy",
      session: "ready",
      desktop: "available",
      permissions: {
        accessibility: "granted",
        input: "granted",
        screenCapture: "granted",
      },
    },
    capacity: {
      acceptingWork: true,
      activeRuns: 0,
      maxOutboxEntries: 100,
      outboxDepth: 0,
    },
    inventory: {
      deviceName: "Action Worker",
      osFamily: "windows",
      platformRelease: "11",
      architecture: "x64",
      serviceMode: "foreground",
      knowledgeHealth: "healthy",
      maximumConcurrentRuns: 1,
      capabilities: [{ name: "computer-use", verification: "verified" }],
      agentAdapters: [
        {
          provider: "codex",
          adapterId: "codex-app-server",
          readiness: "ready",
          compatibility: "tested",
          version: "0.146.0",
          observedAtMs,
          modelCatalogObservedAtMs: observedAtMs,
          models: [
            {
              modelId: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              isDefault: true,
            },
          ],
        },
      ],
      workspaceIds: [],
      availableSecretRefs: [],
    },
  };
}

function fakeDeviceChannelRuntime(
  assignments: WorkerRunAssignmentV1[],
  onClose: () => void,
): ProductionMainDeviceChannelRuntime {
  const identity: PersistedDeviceIdentity = {
    deviceId: WORKER_DEVICE_ID,
    status: "active",
    identityGeneration: 1,
    allowedBootstrapRoles: ["desktop-automation"],
    discovery: {
      osFamily: "windows",
      architecture: "x64",
      hostname: "action-worker",
    },
    createdAt: Date.now(),
  };
  return {
    authority: {} as ProductionMainDeviceChannelRuntime["authority"],
    certificateAuthorityPem: "test-certificate-authority",
    certificateAuthoritySpkiSha256: `sha256:${"b".repeat(64)}`,
    enrollmentAddress: {
      host: "127.0.0.1",
      port: 45_443,
      url: "https://127.0.0.1:45443/api/v1/device/enroll",
    },
    workerChannel: {
      address: () => ({
        host: "127.0.0.1",
        port: 45_444,
        url: "wss://127.0.0.1:45444/api/v1/device/channel",
      }),
      async dispatch(_deviceId, assignment) {
        assignments.push(structuredClone(assignment));
        return {} as never;
      },
      async control() {
        return {} as never;
      },
      async steerRun() {
        return {} as never;
      },
      isConnected() {
        return false;
      },
      async upgradeProvider() {
        return {} as never;
      },
      async close() {},
    },
    async listEnrollmentGrants() {
      return [];
    },
    async listIdentityAuditRecords() {
      return [];
    },
    async listDeviceIdentities() {
      return [identity];
    },
    async close() {
      onClose();
    },
  };
}

class PlanningAgentAdapter implements AgentAdapter {
  public readonly adapterId = "main-action-planner";
  public readonly provider = "generic" as const;

  public async probe() {
    return {
      contractVersion: 1 as const,
      adapterId: this.adapterId,
      provider: this.provider,
      installed: true,
      version: "1.0.0",
      compatibility: "tested" as const,
      auth: { state: "ready" as const },
      capabilities: {
        start: true,
        resume: true,
        streaming: true,
        cancellation: true,
        approvalBridge: true,
        steering: false,
        checkpointContinuation: true,
        workspaceIsolation: ["none" as const],
      },
      diagnostics: [],
    };
  }

  public async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    return handle(input, {
      schemaVersion: 1,
      state: "ready",
      plan: {
        protocolVersion: "v1",
        taskId: input.taskId,
        workOrders: [
          {
            protocolVersion: "v1",
            workOrderId: "work-order-action-composition",
            title: "Use the desktop fixture",
            brief: "Select the exact approved desktop fixture option.",
            completionCriteria: ["The requested option is selected."],
            constraints: [],
            selectedInputIds: [],
            dependsOn: [],
            schedulingHints: {
              preferredDeviceIds: [WORKER_DEVICE_ID],
              preferredRoles: ["desktop-automation"],
            },
            requiredCapabilities: ["computer-use"],
            requiredSecretRefs: [],
          },
        ],
      },
    });
  }

  public async resume(): Promise<AgentRunHandle> {
    throw new Error("Verification is not expected before the composition test shuts down.");
  }
}

function handle(input: AgentStartRequest, result: object): AgentRunHandle {
  const reference: NativeSessionReference = {
    schemaVersion: 1,
    provider: "generic",
    adapterId: "main-action-planner",
    adapterVersion: "1.0.0",
    nativeSessionId: "native-main-action-composition",
    sessionKey: input.sessionKey,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    deviceId: input.deviceId,
    workspaceId: input.workspace.workspaceId,
    cwd: input.workspace.cwd,
    lineage: { lineageId: "lineage-main-action-composition" },
    createdAt: new Date().toISOString(),
  };
  const events: readonly NormalizedAgentEvent[] = [
    {
      sequence: 1,
      observedAt: new Date().toISOString(),
      type: "session_started",
      session: reference,
    },
  ];
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    result: Promise.resolve({
      status: "succeeded" as const,
      session: reference,
      finalText: JSON.stringify(result),
    }),
    async cancel() {},
  };
}

async function deviceChannelConfiguration(home: string): Promise<MainDeviceChannelConfiguration> {
  const certificatePath = join(home, "device-channel-certificate.pem");
  const privateKeyPath = join(home, "device-channel-private-key.pem");
  await Promise.all([
    writeFile(certificatePath, "test certificate"),
    writeFile(privateKeyPath, "test private key"),
  ]);
  return {
    enrollment: {
      advertisedUrl: "https://127.0.0.1:45443/api/v1/device/enroll",
      host: "127.0.0.1",
      port: 45_443,
      tlsCertificatePath: certificatePath,
      tlsPrivateKeyPath: privateKeyPath,
    },
    workerChannel: {
      advertisedUrl: "wss://127.0.0.1:45444/api/v1/device/channel",
      host: "127.0.0.1",
      port: 45_444,
      tlsCertificatePath: certificatePath,
      tlsPrivateKeyPath: privateKeyPath,
    },
  };
}

async function createAdminFixture(parent: string): Promise<string> {
  const root = join(parent, "admin-dist");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><title>OpenDelegate test shell</title><div id="root"></div>',
  );
  return root;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((accept) => setTimeout(accept, 10));
  }
  throw new Error(`${label} timed out.`);
}
