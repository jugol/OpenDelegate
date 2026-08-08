import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import {
  DeviceIdentityAuthority,
  InMemoryDeviceIdentityRepository,
  InMemoryDeviceIdentitySecretStore,
  WorkerDeviceIdentity,
  type DeviceIdentitySecretStore,
} from "@opendelegate/device-identity";
import { PROTOCOL_VERSION } from "@opendelegate/protocol";
import {
  createWorkerRouteIncident,
  type WorkerHeartbeatV1,
  type WorkerRunAssignmentV1,
  type WorkerRunSteeringCommandV1,
} from "@opendelegate/worker-runtime";

import {
  MainDeviceChannelServer,
  SqliteDeviceChannelRepository,
  SqliteWorkerChannelState,
  WorkerDeviceChannelClient,
  type MainDeviceChannelCallbacks,
  type MainPingFrameV1,
  type WorkerDeviceChannelCallbacks,
  type WorkerRunLeaseRenewFrameV1,
} from "../src/index.ts";

test(
  "Main retries a failed inbound handler after reconnect without repeating a completed handler",
  { timeout: 20_000 },
  async () => {
    const fixture = await createChannelFixture("main-effect");
    let callbackCount = 0;
    let closeAfterSuccess = true;
    let client: WorkerDeviceChannelClient | undefined;
    const server = await fixture.listen({
      onHeartbeat: async () => {
        callbackCount += 1;
        if (callbackCount === 1) {
          throw new Error("synthetic handler failure");
        }
        if (closeAfterSuccess) {
          closeAfterSuccess = false;
          await client?.close();
        }
      },
    });
    const state = await fixture.openWorkerState("worker.sqlite");

    try {
      client = await fixture.connect(server, state);
      await client.sendHeartbeat(heartbeat());
      await waitUntil(() => callbackCount === 1, "first failed Main handler");
      await client.close().catch(() => undefined);

      client = await connectEventually(() => fixture.connect(server, state));
      await waitUntil(() => callbackCount === 2, "retried Main handler");
      await client.close().catch(() => undefined);

      client = await connectEventually(() => fixture.connect(server, state));
      await waitUntil(
        async () =>
          (await fixture.mainState.resume(fixture.deviceId)).acknowledgedWorkerSequence >= 2,
        "Main handled prefix",
      );
      assert.equal(callbackCount, 2);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.cleanup();
    }
  },
);

test(
  "Worker reconnect drains durable replay through Main acknowledgments before becoming ready",
  { timeout: 20_000 },
  async () => {
    const fixture = await createChannelFixture("worker-replay-window");
    const replayCount = 96;
    let observedHeartbeats = 0;
    const server = await fixture.listen({
      onHeartbeat: async () => {
        observedHeartbeats += 1;
      },
    });
    const state = await fixture.openWorkerState("worker.sqlite");
    const observedAtBase = Date.now() - replayCount;
    let client: WorkerDeviceChannelClient | undefined;

    try {
      for (let index = 0; index < replayCount; index += 1) {
        const identity = `queued-heartbeat-${index.toString()}`;
        await state.enqueueOutbound((sequence) => ({
          protocolVersion: PROTOCOL_VERSION,
          messageId: identity,
          senderDeviceId: fixture.deviceId,
          correlationId: identity,
          createdAt: new Date(observedAtBase + index).toISOString(),
          idempotencyKey: identity,
          sequence,
          type: "worker.heartbeat",
          payload: heartbeat(observedAtBase + index),
        }));
      }

      client = await fixture.connect(server, state);

      assert.equal(observedHeartbeats, replayCount);
      assert.equal(
        (await state.resume()).pendingOutbound.some((frame) => frame.type === "worker.heartbeat"),
        false,
      );
      assert.equal(
        (await fixture.mainState.resume(fixture.deviceId)).acknowledgedWorkerSequence,
        replayCount,
      );
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.cleanup();
    }
  },
);

test(
  "Worker hello retires its handled Main prefix before Main replays the outbox",
  { timeout: 20_000 },
  async () => {
    const fixture = await createChannelFixture("worker-resume-cursor");
    const state = await fixture.openWorkerState("worker.sqlite");
    const safePrefixLength = 32;
    let client: WorkerDeviceChannelClient | undefined;

    try {
      await fixture.mainState.observeConnection({
        deviceId: fixture.deviceId,
        certificateGeneration: fixture.certificateGeneration,
      });
      for (let index = 0; index < safePrefixLength; index += 1) {
        const frame = await fixture.mainState.enqueueOutbound(fixture.deviceId, (sequence) =>
          mainPing(sequence, `resume-ping-${index.toString()}`),
        );
        const claimId = `resume-claim-${index.toString()}`;
        await state.commitInbound(frame);
        assert.equal((await state.claimInboundEffect(frame, claimId)).disposition, "claimed");
        await state.completeInboundEffect(frame, claimId);
      }
      assert.equal((await state.resume()).acknowledgedMainSequence, safePrefixLength);
      assert.equal((await fixture.mainState.resume(fixture.deviceId)).acknowledgedMainSequence, 0);

      const server = await fixture.listen({});
      client = await fixture.connect(server, state);

      const workerAcknowledgments = (await state.resume()).pendingOutbound.filter(
        (frame) => frame.type === "worker.ack",
      );
      assert.equal(workerAcknowledgments.length, 1);
      assert.equal(workerAcknowledgments[0]?.payload.acknowledgedMessageIds.length, 1);
      await waitUntil(
        async () =>
          (await fixture.mainState.resume(fixture.deviceId)).acknowledgedMainSequence >=
          safePrefixLength + 1,
        "hello resume cursor and current welcome acknowledgment",
      );
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.cleanup();
    }
  },
);

test(
  "a route incident replays over the authenticated sequenced outbox without repeating a completed effect",
  { timeout: 20_000 },
  async () => {
    const fixture = await createChannelFixture("route-incident-effect");
    const incident = createWorkerRouteIncident({
      profile: {
        deviceId: "main-effect-1",
        endpoints: [
          {
            endpointId: "route-private",
            label: "Private route",
            kind: "wss",
            url: "wss://private-main.example.test/device",
            credentialRef: "secret://device-certificate",
          },
        ],
      },
      attempts: [
        {
          endpointId: "route-private",
          label: "Private route",
          kind: "wss",
          probeSource: "live",
          outcome: "connect-failed",
          diagnostic: { code: "ETIMEDOUT" },
        },
      ],
      occurrenceSeed: "route-incident-occurrence-1",
    });
    let callbackCount = 0;
    let authenticatedDeviceId: string | undefined;
    const server = await fixture.listen({
      onRouteIncident: async (request) => {
        callbackCount += 1;
        authenticatedDeviceId = request.authenticatedDeviceId;
        assert.deepEqual(request.incident, incident);
        if (callbackCount === 1) {
          throw new Error("synthetic incident handler failure");
        }
      },
    });
    const state = await fixture.openWorkerState("worker.sqlite");
    let client: WorkerDeviceChannelClient | undefined;
    try {
      client = await fixture.connect(server, state);
      await client.sendRouteIncident(incident);
      await waitUntil(() => callbackCount === 1, "first failed incident handler");
      await client.close().catch(() => undefined);

      client = await connectEventually(() => fixture.connect(server, state));
      await waitUntil(() => callbackCount === 2, "retried incident handler");
      await client.close().catch(() => undefined);

      client = await connectEventually(() => fixture.connect(server, state));
      await waitUntil(
        async () =>
          (await fixture.mainState.resume(fixture.deviceId)).acknowledgedWorkerSequence >= 2,
        "incident handled prefix",
      );
      assert.equal(authenticatedDeviceId, fixture.deviceId);
      assert.equal(callbackCount, 2);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.cleanup();
    }
  },
);

test(
  "Worker retries a failed dispatch handler after reconnect without repeating a completed handler",
  { timeout: 20_000 },
  async () => {
    const fixture = await createChannelFixture("worker-effect");
    const server = await fixture.listen({});
    const state = await fixture.openWorkerState("worker.sqlite");
    let callbackCount = 0;
    let closeAfterSuccess = true;
    let client: WorkerDeviceChannelClient | undefined;
    const callbacks: WorkerDeviceChannelCallbacks = {
      onDispatch: async () => {
        callbackCount += 1;
        if (callbackCount === 1) {
          throw new Error("synthetic dispatch failure");
        }
        if (closeAfterSuccess) {
          closeAfterSuccess = false;
          await client?.close();
        }
      },
    };

    try {
      client = await fixture.connect(server, state, callbacks);
      const dispatch = await server.dispatch(fixture.deviceId, assignment());
      await waitUntil(() => callbackCount === 1, "first failed Worker handler");
      await client.close().catch(() => undefined);

      client = await connectEventually(() => fixture.connect(server, state, callbacks));
      await waitUntil(() => callbackCount === 2, "retried Worker handler");
      await client.close().catch(() => undefined);

      client = await connectEventually(() => fixture.connect(server, state, callbacks));
      await waitUntil(
        async () =>
          (await fixture.mainState.resume(fixture.deviceId)).acknowledgedMainSequence >=
          dispatch.sequence,
        "Worker handled prefix",
      );
      assert.equal(callbackCount, 2);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.cleanup();
    }
  },
);

test(
  "authenticated Run steering and its auditable fallback receipt each replay exactly at their durable effect seam",
  { timeout: 20_000 },
  async () => {
    const fixture = await createChannelFixture("run-steering-effect");
    let receiptCallbacks = 0;
    const observedReceipts: string[] = [];
    const server = await fixture.listen({
      onRunSteeringReceipt: async (observation) => {
        receiptCallbacks += 1;
        observedReceipts.push(observation.receipt.reasonCode);
        assert.equal(observation.authenticatedDeviceId, fixture.deviceId);
        if (receiptCallbacks === 1) {
          throw new Error("synthetic steering receipt audit failure");
        }
      },
    });
    const state = await fixture.openWorkerState("worker.sqlite");
    const command = steeringCommand(fixture.deviceId);
    let steeringCallbacks = 0;
    const callbacks: WorkerDeviceChannelCallbacks = {
      onRunSteer: async (frame) => {
        steeringCallbacks += 1;
        assert.deepEqual(frame.payload, command);
        if (steeringCallbacks === 1) {
          throw new Error("synthetic Worker steering failure");
        }
        return {
          requestId: command.requestId,
          requestMessageId: frame.messageId,
          taskId: command.taskId,
          workOrderId: command.workOrderId,
          deviceId: command.deviceId,
          workerId: command.workerId,
          routeId: command.routeId,
          runId: command.runId,
          leaseId: command.leaseId,
          fencingToken: command.fencingToken,
          agentSession: command.agentSession,
          delivery: "next-resume",
          status: "queued",
          reasonCode: "NEXT_RESUME_QUEUED",
          decidedAtMs: Date.now(),
        };
      },
    };
    let client: WorkerDeviceChannelClient | undefined;

    try {
      client = await fixture.connect(server, state, callbacks);
      const request = await server.steerRun(fixture.deviceId, command);
      await waitUntil(() => steeringCallbacks === 1, "first failed steering handler");
      await client.close().catch(() => undefined);

      client = await connectEventually(() => fixture.connect(server, state, callbacks));
      await waitUntil(
        () => steeringCallbacks === 2 && receiptCallbacks === 2,
        "durable steering receipt after retrying the failed Main audit",
      );
      await client.close().catch(() => undefined);

      client = await connectEventually(() => fixture.connect(server, state, callbacks));
      await waitUntil(
        async () =>
          (await fixture.mainState.resume(fixture.deviceId)).acknowledgedMainSequence >=
          request.sequence,
        "handled steering command prefix",
      );
      assert.equal(steeringCallbacks, 2);
      assert.deepEqual(observedReceipts, ["NEXT_RESUME_QUEUED", "NEXT_RESUME_QUEUED"]);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.cleanup();
    }
  },
);

for (const staleWelcomeState of ["unreceived", "handled-without-ack"] as const) {
  test(
    `reconnect ignores a ${staleWelcomeState} stale welcome and defers dispatch until fresh calibration`,
    { timeout: 20_000 },
    async () => {
      const fixture = await createChannelFixture(`stale-welcome-${staleWelcomeState}`);
      const server = await fixture.listen({});
      const state = await fixture.openWorkerState("worker.sqlite");
      let client: WorkerDeviceChannelClient | undefined;
      let dispatchCount = 0;
      let authorityCurrent = false;
      try {
        client = await fixture.connect(server, state);
        await waitUntil(
          async () =>
            (await fixture.mainState.resume(fixture.deviceId)).acknowledgedMainSequence >= 1,
          "initial welcome acknowledgment",
        );
        await client.close();
        client = undefined;

        const staleWelcome = await fixture.mainState.enqueueOutbound(
          fixture.deviceId,
          (sequence) => ({
            protocolVersion: PROTOCOL_VERSION,
            messageId: `stale-welcome-${staleWelcomeState}`,
            senderDeviceId: "main-effect-1",
            correlationId: `old-hello-${staleWelcomeState}`,
            createdAt: new Date().toISOString(),
            idempotencyKey: `stale-welcome-${staleWelcomeState}`,
            sequence,
            type: "main.welcome",
            payload: {
              deviceId: fixture.deviceId,
              acceptedProtocolVersion: PROTOCOL_VERSION,
              acknowledgedWorkerSequence: 1,
              nextMainSequence: sequence + 1,
              heartbeatIntervalMs: 10_000,
              maximumInFlightFrames: 128,
              workerWallSentAtMs: Date.now() - 1,
              mainReceivedAtMs: Date.now(),
              mainSentAtMs: Date.now(),
              maximumHandshakeRttMs: 5_000,
              maximumAbsoluteClockSkewMs: 60_000,
            },
          }),
        );
        if (staleWelcomeState === "handled-without-ack") {
          await state.commitInbound(staleWelcome);
          const claim = await state.claimInboundEffect(staleWelcome, "stale-welcome-test-claim");
          assert.equal(claim.disposition, "claimed");
          await state.completeInboundEffect(staleWelcome, "stale-welcome-test-claim");
        }
        await server.dispatch(fixture.deviceId, assignment());

        client = await connectEventually(() =>
          fixture.connect(server, state, {
            onDispatch: async (frame, channel) => {
              dispatchCount += 1;
              authorityCurrent = channel.createRunLeaseAuthority(frame.payload).isCurrent();
            },
          }),
        );
        await waitUntil(() => dispatchCount === 1, "deferred calibrated dispatch");
        assert.equal(authorityCurrent, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(dispatchCount, 1);
      } finally {
        await client?.close().catch(() => undefined);
        await fixture.cleanup();
      }
    },
  );
}

test(
  "reconnect applies a durable Run renewal response received before the fresh welcome",
  { timeout: 20_000 },
  async () => {
    const fixture = await createChannelFixture("renewal-response-replay");
    const server = await fixture.listen({});
    const state = await fixture.openWorkerState("worker.sqlite");
    let client: WorkerDeviceChannelClient | undefined;
    try {
      client = await fixture.connect(server, state);
      const assigned = {
        ...assignment(),
        leaseExpiresAtMs: Date.now() + 60_000,
      };
      const authority = client.createRunLeaseAuthority(assigned);
      await waitUntil(
        async () =>
          (await fixture.mainState.resume(fixture.deviceId)).acknowledgedMainSequence >= 1,
        "initial welcome acknowledgment",
      );
      await client.close();
      client = undefined;

      const renewal = (await state.enqueueOutbound((sequence) => ({
        protocolVersion: PROTOCOL_VERSION,
        messageId: "renewal-before-reconnect",
        senderDeviceId: fixture.deviceId,
        correlationId: assigned.runId,
        createdAt: new Date().toISOString(),
        idempotencyKey: "renewal-command-before-reconnect",
        sequence,
        type: "worker.run.renew",
        payload: {
          taskId: assigned.taskId,
          workOrderId: assigned.workOrder.workOrderId,
          deviceId: assigned.deviceId,
          workerId: assigned.workerId,
          routeId: assigned.routeId,
          runId: assigned.runId,
          leaseId: assigned.leaseId,
          fencingToken: assigned.fencingToken,
          renewalId: "renewal-command-before-reconnect",
          priorLeaseExpiresAtMs: assigned.leaseExpiresAtMs,
        },
      }))) as WorkerRunLeaseRenewFrameV1;
      await fixture.mainState.commitInbound(renewal);
      const mainClaim = await fixture.mainState.claimInboundEffect(renewal, "main-renewal-claim");
      assert.equal(mainClaim.disposition, "claimed");
      await fixture.mainState.completeInboundEffect(renewal, "main-renewal-claim");
      const renewedAtMs = Date.now();
      const renewedLeaseExpiresAtMs = renewedAtMs + 120_000;
      await fixture.mainState.enqueueOutbound(fixture.deviceId, (sequence) => ({
        protocolVersion: PROTOCOL_VERSION,
        messageId: "renewal-response-before-reconnect",
        senderDeviceId: "main-effect-1",
        correlationId: renewal.messageId,
        createdAt: new Date().toISOString(),
        idempotencyKey: "renewal-response-before-reconnect",
        sequence,
        type: "main.run.lease",
        payload: {
          requestMessageId: renewal.messageId,
          ...renewal.payload,
          status: "renewed",
          renewedAtMs,
          leaseExpiresAtMs: renewedLeaseExpiresAtMs,
        },
      }));

      client = await connectEventually(() =>
        fixture.connect(server, state, {
          onRunLeaseDecision: async (observation) => {
            authority.acceptDecision(observation);
          },
        }),
      );
      assert.equal(authority.attach(client), true);
      assert.equal(authority.snapshot().leaseExpiresAtMs, renewedLeaseExpiresAtMs);
      assert.equal(authority.isCurrent(), true);

      const observationMonotonicMs = client.monotonicNow();
      authority.acceptDecision({
        frame: {
          protocolVersion: PROTOCOL_VERSION,
          messageId: "stale-concurrent-rejection",
          senderDeviceId: "main-effect-1",
          correlationId: "stale-concurrent-request",
          createdAt: new Date().toISOString(),
          idempotencyKey: "stale-concurrent-rejection",
          sequence: 99,
          type: "main.run.lease",
          payload: {
            requestMessageId: "stale-concurrent-request",
            ...renewal.payload,
            renewalId: "stale-concurrent-command",
            status: "rejected",
            decidedAtMs: Date.now(),
            reasonCode: "RUN_LEASE_CHANGED",
          },
        },
        receivedAtMonotonicMs: observationMonotonicMs,
        responseRoundTripMs: 0,
        conservativeDeadlineMonotonicMs: observationMonotonicMs,
      });
      assert.equal(
        authority.isCurrent(),
        true,
        "a stale concurrent decision must not revoke the newer lease",
      );

      authority.acceptDecision({
        frame: {
          protocolVersion: PROTOCOL_VERSION,
          messageId: "future-prior-rejection",
          senderDeviceId: "main-effect-1",
          correlationId: "future-prior-request",
          createdAt: new Date().toISOString(),
          idempotencyKey: "future-prior-rejection",
          sequence: 100,
          type: "main.run.lease",
          payload: {
            requestMessageId: "future-prior-request",
            ...renewal.payload,
            renewalId: "future-prior-command",
            priorLeaseExpiresAtMs: renewedLeaseExpiresAtMs + 1,
            status: "rejected",
            decidedAtMs: Date.now(),
            reasonCode: "RUN_LEASE_CHANGED",
          },
        },
        receivedAtMonotonicMs: observationMonotonicMs,
        responseRoundTripMs: 0,
        conservativeDeadlineMonotonicMs: observationMonotonicMs,
      });
      assert.equal(
        authority.isCurrent(),
        false,
        "a decision claiming a future prior expiry must fail closed",
      );
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.cleanup();
    }
  },
);

interface ChannelFixture {
  readonly certificateGeneration: number;
  readonly deviceId: string;
  readonly mainState: SqliteDeviceChannelRepository;
  cleanup(): Promise<void>;
  connect(
    server: MainDeviceChannelServer,
    state: SqliteWorkerChannelState,
    callbacks?: WorkerDeviceChannelCallbacks,
  ): Promise<WorkerDeviceChannelClient>;
  listen(callbacks: MainDeviceChannelCallbacks): Promise<MainDeviceChannelServer>;
  openWorkerState(filename: string): Promise<SqliteWorkerChannelState>;
}

async function createChannelFixture(label: string): Promise<ChannelFixture> {
  const directory = await mkdtemp(join(tmpdir(), `opendelegate-${label}-`));
  const clock = { now: () => Date.now() };
  const identityRepository = new InMemoryDeviceIdentityRepository();
  const mainSecrets = new InMemoryDeviceIdentitySecretStore();
  const workerSecrets = new ExtractableTestIdentitySecretStore();
  const authority = new DeviceIdentityAuthority({
    clock,
    repository: identityRepository,
    secrets: mainSecrets,
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: `instance-${label}`,
  });
  const deviceId = "worker-effect-1";
  const grant = await authority.createEnrollmentGrant({
    deviceId,
    allowedBootstrapRoles: ["coding"],
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const workerIdentity = new WorkerDeviceIdentity({ clock, secrets: workerSecrets });
  const enrollment = await workerIdentity.createEnrollmentRequest({
    deviceId,
    expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
  });
  const issued = await authority.enrollDevice({
    grantId: grant.grantId,
    token: grant.secret.reveal(),
    deviceId,
    protocolVersion: 1,
    certificateRequestPem: enrollment.certificateRequestPem,
    discovery: {
      architecture: "x64",
      hostname: "worker-effect",
      osFamily: "linux",
    },
  });
  const verified = await workerIdentity.verifyIssuedDeviceIdentity({
    keyId: enrollment.keyId,
    deviceId,
    generation: issued.generation,
    certificatePem: issued.certificatePem,
    certificateAuthorityPem: issued.certificateAuthorityPem,
    certificateRequestPem: enrollment.certificateRequestPem,
    expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
  });
  const privateKey = await workerSecrets.getPrivateKey(enrollment.keyId);
  assert.notEqual(privateKey, null);
  const serverIdentity = await issueServerIdentity(
    certificateAuthority.certificatePem,
    await mainSecrets.getPrivateKey(certificateAuthority.keyId),
  );
  const mainState = await SqliteDeviceChannelRepository.open({
    filename: join(directory, "main.sqlite"),
    sourceCheckoutRoot: process.cwd(),
  });
  const workers: SqliteWorkerChannelState[] = [];
  const servers: MainDeviceChannelServer[] = [];

  return {
    certificateGeneration: verified.generation,
    deviceId,
    mainState,
    cleanup: async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
      await Promise.all(workers.map((state) => state.close().catch(() => undefined)));
      await mainState.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
    connect: (server, state, callbacks = {}) =>
      WorkerDeviceChannelClient.connect({
        ...callbacks,
        endpointUrl: server.address().url,
        deviceId,
        workerId: "worker-runtime-1",
        mainDeviceId: "main-effect-1",
        connectTimeoutMs: 3_000,
        identity: {
          certificatePem: verified.certificatePem,
          certificateAuthorityPem: verified.certificateAuthorityPem,
          certificateGeneration: verified.generation,
          executeWithPrivateKeyBytes: async (executor) => {
            const pkcs8 = new Uint8Array(
              await globalThis.crypto.subtle.exportKey("pkcs8", privateKey!),
            );
            try {
              await executor(pkcs8);
            } finally {
              pkcs8.fill(0);
            }
          },
        },
        state,
      }),
    listen: async (callbacks) => {
      const server = await MainDeviceChannelServer.listen({
        ...callbacks,
        mainDeviceId: "main-effect-1",
        authority,
        repository: mainState,
        tls: {
          certificateAuthorityPem: certificateAuthority.certificatePem,
          certificate: serverIdentity.certificatePem,
          privateKey: serverIdentity.privateKeyPem,
        },
      });
      servers.push(server);
      return server;
    },
    openWorkerState: async (filename) => {
      const state = await SqliteWorkerChannelState.open({
        filename: join(directory, filename),
        sourceCheckoutRoot: process.cwd(),
        deviceId,
        mainDeviceId: "main-effect-1",
        certificateGeneration: verified.generation,
      });
      workers.push(state);
      return state;
    },
  };
}

function heartbeat(observedAtMs = Date.now()): WorkerHeartbeatV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "worker-effect-1",
    workerId: "worker-runtime-1",
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
  };
}

function mainPing(sequence: number, pingId: string): MainPingFrameV1 {
  const identity = `main-${pingId}`;
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: identity,
    senderDeviceId: "main-effect-1",
    correlationId: identity,
    createdAt: new Date().toISOString(),
    idempotencyKey: identity,
    sequence,
    type: "main.ping",
    payload: {
      pingId,
      deadlineAtMs: Date.now() + 60_000,
    },
  };
}

function assignment(): WorkerRunAssignmentV1 {
  return {
    taskId: "task-effect-1",
    workOrder: {
      protocolVersion: PROTOCOL_VERSION,
      workOrderId: "work-order-effect-1",
      title: "Exercise durable delivery",
      brief: "Return one observable result.",
      completionCriteria: ["The result is reported once."],
      constraints: [],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: {
        preferredDeviceIds: ["worker-effect-1"],
        preferredRoles: ["coding"],
      },
      requiredCapabilities: ["coding"],
      requiredSecretRefs: [],
    },
    deviceId: "worker-effect-1",
    workerId: "worker-runtime-1",
    routeId: "route-effect-1",
    runId: "run-effect-1",
    leaseId: "lease-effect-1",
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 60_000,
  };
}

function steeringCommand(deviceId: string): WorkerRunSteeringCommandV1 {
  const run = assignment();
  return {
    requestId: "steer-effect-1",
    taskId: run.taskId,
    workOrderId: run.workOrder.workOrderId,
    deviceId,
    workerId: run.workerId,
    routeId: run.routeId,
    runId: run.runId,
    leaseId: run.leaseId,
    fencingToken: run.fencingToken,
    instruction: "Also verify the durable fallback audit.",
    requestedBy: "owner",
    agentSession: {
      provider: "codex",
      adapterId: "codex-app-server",
      adapterVersion: "0.145.0",
      nativeSessionId: "thread-effect-1",
      workstreamId: "implementation",
      workspaceId: "workspace-effect-1",
      lineage: {
        lineageId: "lineage-effect-1",
      },
    },
  };
}

async function connectEventually(
  connect: () => Promise<WorkerDeviceChannelClient>,
): Promise<WorkerDeviceChannelClient> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 25);
        timeout.unref();
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Device channel reconnect timed out.");
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 10);
      timeout.unref();
    });
  }
  throw new Error(`${label} timed out`);
}

async function issueServerIdentity(
  certificateAuthorityPem: string,
  certificateAuthorityPrivateKey: CryptoKey | null,
): Promise<{ readonly certificatePem: string; readonly privateKeyPem: string }> {
  assert.notEqual(certificateAuthorityPrivateKey, null);
  const now = Date.now();
  const certificateAuthority = new X509Certificate(certificateAuthorityPem);
  const keys = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const certificate = await X509CertificateGenerator.create({
    serialNumber: "22334455667788990011aabbccddeeff",
    subject: "CN=127.0.0.1",
    issuer: certificateAuthority.subject,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 60 * 60_000),
    publicKey: keys.publicKey,
    signingKey: certificateAuthorityPrivateKey ?? keys.privateKey,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], true),
      new SubjectAlternativeNameExtension([{ type: "ip", value: "127.0.0.1" }], false),
      await SubjectKeyIdentifierExtension.create(keys.publicKey),
      await AuthorityKeyIdentifierExtension.create(certificateAuthority.publicKey),
    ],
  });
  const pkcs8 = Buffer.from(await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey));
  return {
    certificatePem: certificate.toString("pem"),
    privateKeyPem: [
      "-----BEGIN PRIVATE KEY-----",
      pkcs8
        .toString("base64")
        .match(/.{1,64}/gu)
        ?.join("\n") ?? "",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n"),
  };
}

class ExtractableTestIdentitySecretStore implements DeviceIdentitySecretStore {
  readonly #keys = new Map<string, CryptoKeyPair>();

  async createP256KeyPair(keyId: string): Promise<CryptoKeyPair> {
    const keys = await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    this.#keys.set(keyId, keys);
    return keys;
  }

  async getPrivateKey(keyId: string): Promise<CryptoKey | null> {
    return this.#keys.get(keyId)?.privateKey ?? null;
  }

  async signP256(keyId: string, value: BufferSource): Promise<Uint8Array> {
    const key = this.#keys.get(keyId)?.privateKey;
    assert.notEqual(key, undefined);
    return new Uint8Array(
      await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key!, value),
    );
  }

  async has(keyId: string): Promise<boolean> {
    return this.#keys.has(keyId);
  }
}
