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
import type { WorkerHeartbeatV1, WorkerRunAssignmentV1 } from "@opendelegate/worker-runtime";

import {
  MainDeviceChannelServer,
  SqliteDeviceChannelRepository,
  SqliteWorkerChannelState,
  WorkerDeviceChannelClient,
} from "../src/index.ts";

test(
  "TLS 1.3 mTLS channel authenticates, durably acknowledges, dispatches, and closes on revocation",
  { timeout: 15_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opendelegate-mtls-channel-"));
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
      instanceId: "instance-mtls",
    });
    const grant = await authority.createEnrollmentGrant({
      deviceId: "worker-mtls-1",
      allowedBootstrapRoles: ["coding"],
      expiresInMs: 5 * 60_000,
      protocolRange: { minimum: 1, maximum: 1 },
    });
    const workerIdentity = new WorkerDeviceIdentity({ clock, secrets: workerSecrets });
    const enrollment = await workerIdentity.createEnrollmentRequest({
      deviceId: grant.deviceId,
      expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
    });
    const issued = await authority.enrollDevice({
      grantId: grant.grantId,
      token: grant.secret.reveal(),
      deviceId: grant.deviceId,
      protocolVersion: 1,
      certificateRequestPem: enrollment.certificateRequestPem,
      discovery: {
        architecture: "x64",
        hostname: "worker-mtls",
        osFamily: "linux",
      },
    });
    const verified = await workerIdentity.verifyIssuedDeviceIdentity({
      keyId: enrollment.keyId,
      deviceId: issued.deviceId,
      generation: issued.generation,
      certificatePem: issued.certificatePem,
      certificateAuthorityPem: issued.certificateAuthorityPem,
      certificateRequestPem: enrollment.certificateRequestPem,
      expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
    });
    const workerPrivateKey = await workerSecrets.getPrivateKey(enrollment.keyId);
    assert.notEqual(workerPrivateKey, null);
    const serverIdentity = await issueServerIdentity(
      certificateAuthority.certificatePem,
      await mainSecrets.getPrivateKey(certificateAuthority.keyId),
    );
    const mainState = await SqliteDeviceChannelRepository.open({
      filename: join(directory, "main-channel.sqlite"),
      sourceCheckoutRoot: process.cwd(),
    });
    const workerState = await SqliteWorkerChannelState.open({
      filename: join(directory, "worker-channel.sqlite"),
      sourceCheckoutRoot: process.cwd(),
      deviceId: issued.deviceId,
      mainDeviceId: "main-device-1",
      certificateGeneration: issued.generation,
    });
    let heartbeatResolve: (() => void) | undefined;
    const heartbeatObserved = new Promise<void>((resolve) => {
      heartbeatResolve = resolve;
    });
    let dispatchCount = 0;
    let dispatchResolve: (() => void) | undefined;
    const dispatchObserved = new Promise<void>((resolve) => {
      dispatchResolve = resolve;
    });
    let controlCount = 0;
    let controlResolve: (() => void) | undefined;
    const controlObserved = new Promise<void>((resolve) => {
      controlResolve = resolve;
    });
    let revokedResolve: (() => void) | undefined;
    const revokedObserved = new Promise<void>((resolve) => {
      revokedResolve = resolve;
    });
    let actionAuthorizationCount = 0;
    let actionConsumptionCount = 0;
    let runLeaseRenewalCount = 0;
    const server = await MainDeviceChannelServer.listen({
      mainDeviceId: "main-device-1",
      authority,
      repository: mainState,
      tls: {
        certificateAuthorityPem: certificateAuthority.certificatePem,
        certificate: serverIdentity.certificatePem,
        privateKey: serverIdentity.privateKeyPem,
      },
      onHeartbeat: async (deviceId, heartbeat) => {
        assert.equal(deviceId, issued.deviceId);
        assert.equal(heartbeat.workerId, "worker-runtime-1");
        heartbeatResolve?.();
      },
      onArtifactPrepare: async (input) => {
        assert.equal(input.authenticatedDeviceId, issued.deviceId);
        assert.equal(input.manifest.deviceId, issued.deviceId);
        assert.equal(input.manifest.runId, "run-1");
        if (input.manifest.artifactId === "artifact-stale") {
          return {
            status: "rejected",
            code: "RUN_NOT_CURRENT",
            retryable: false,
          };
        }
        return {
          status: "granted",
          grant: {
            protocolVersion: "v1",
            uploadId: "upload-run-1",
            artifactId: input.manifest.artifactId,
            uploadUrl: "https://main.example.test/worker-uploads/upload-run-1",
            credential: `u1.upload-run-1.${"a".repeat(43)}`,
            expiresAtMs: Date.now() + 60_000,
            maximumChunkBytes: 8_388_608,
            declaredSizeBytes: input.manifest.declaredSizeBytes,
            expectedSha256: input.manifest.expectedSha256,
          },
        };
      },
      onActionAuthorize: async (input) => {
        actionAuthorizationCount += 1;
        assert.equal(input.authenticatedDeviceId, issued.deviceId);
        assert.deepEqual(input.request.actionDescriptor, {
          kind: "type-text",
          privacy: "exact-input-withheld-on-device",
        });
        const serialized = JSON.stringify(input.request);
        assert.equal(serialized.includes("private-control-sentinel"), false);
        assert.equal(serialized.includes("private-text-sentinel"), false);
        assert.equal(serialized.includes("textSha256"), false);
        assert.equal(serialized.includes("textLength"), false);
        return {
          decision: "allow",
          authorizationId: "authorization-mtls-1",
          reasonCode: "POLICY_ALLOW",
        };
      },
      onActionConsume: async (input) => {
        actionConsumptionCount += 1;
        assert.equal(input.authenticatedDeviceId, issued.deviceId);
        assert.equal(input.request.authorizationId, "authorization-mtls-1");
        return {
          decision: "consumed",
          reasonCode: "CONSUMED",
        };
      },
      onRunLeaseRenew: async (input) => {
        runLeaseRenewalCount += 1;
        assert.equal(input.authenticatedDeviceId, issued.deviceId);
        return {
          status: "renewed",
          renewalId: input.request.renewalId,
          renewedAtMs: Date.now(),
          priorLeaseExpiresAtMs: input.request.priorLeaseExpiresAtMs,
          leaseExpiresAtMs: input.request.priorLeaseExpiresAtMs + 60_000,
        };
      },
    });
    let client: WorkerDeviceChannelClient | undefined;
    try {
      client = await WorkerDeviceChannelClient.connect({
        endpointUrl: server.address().url,
        deviceId: issued.deviceId,
        workerId: "worker-runtime-1",
        mainDeviceId: "main-device-1",
        connectTimeoutMs: 3_000,
        identity: {
          certificatePem: verified.certificatePem,
          certificateAuthorityPem: verified.certificateAuthorityPem,
          certificateGeneration: verified.generation,
          executeWithPrivateKeyBytes: async (executor) => {
            const pkcs8 = new Uint8Array(
              await globalThis.crypto.subtle.exportKey("pkcs8", workerPrivateKey!),
            );
            try {
              await executor(pkcs8);
            } finally {
              pkcs8.fill(0);
            }
          },
        },
        state: workerState,
        onDispatch: async (frame) => {
          assert.equal(frame.payload.runId, "run-1");
          dispatchCount += 1;
          dispatchResolve?.();
        },
        onControl: async (frame) => {
          assert.equal(frame.payload.runId, "run-1");
          controlCount += 1;
          controlResolve?.();
        },
        onRevoked: async () => {
          revokedResolve?.();
        },
      });
      await client.sendHeartbeat(heartbeat());
      await withTimeout(heartbeatObserved, "heartbeat");

      const artifactGrant = await client.prepareArtifact(artifactManifest(issued.deviceId));
      assert.equal(artifactGrant.artifactId, "artifact-run-1-report");
      assert.equal(artifactGrant.uploadId, "upload-run-1");
      await assert.rejects(
        client.prepareArtifact({
          ...artifactManifest(issued.deviceId),
          artifactId: "artifact-stale",
        }),
        { code: "RUN_NOT_CURRENT", retryable: false },
      );

      const assignedRun = assignment();
      const actionScope = {
        taskId: assignedRun.taskId,
        workOrderId: assignedRun.workOrder.workOrderId,
        deviceId: assignedRun.deviceId,
        workerId: assignedRun.workerId,
        routeId: assignedRun.routeId,
        runId: assignedRun.runId,
        leaseId: assignedRun.leaseId,
        fencingToken: assignedRun.fencingToken,
        leaseExpiresAtMs: assignedRun.leaseExpiresAtMs,
      };
      const actionFingerprint = `sha256:${"c".repeat(64)}` as const;
      const authorization = await client.authorizeAction({
        authorizationRequestId: "run-1:input:1",
        actionCategory: "computer-use-input",
        actionType: "type-text",
        actionFingerprint,
        actionDescriptor: {
          kind: "type-text",
          privacy: "exact-input-withheld-on-device",
        },
        requestedAtMs: Date.now(),
        ...actionScope,
      });
      assert.equal(authorization.decision, "allow");
      assert.equal(authorization.authorizationId, "authorization-mtls-1");
      assert.equal(actionAuthorizationCount, 1);
      const consumption = await client.consumeActionAuthorization({
        authorizationRequestId: "run-1:input:1",
        authorizationId: authorization.authorizationId,
        actionCategory: "computer-use-input",
        actionFingerprint,
        requestedAtMs: Date.now(),
        ...actionScope,
      });
      assert.equal(consumption.decision, "consumed");
      assert.equal(actionConsumptionCount, 1);

      const renewal = await client.renewRunLease(
        {
          taskId: assignedRun.taskId,
          workOrderId: assignedRun.workOrder.workOrderId,
          deviceId: assignedRun.deviceId,
          workerId: assignedRun.workerId,
          routeId: assignedRun.routeId,
          runId: assignedRun.runId,
          leaseId: assignedRun.leaseId,
          fencingToken: assignedRun.fencingToken,
          renewalId: "run-1:renewal:1",
          priorLeaseExpiresAtMs: assignedRun.leaseExpiresAtMs,
        },
        performance.now() + 20_000,
      );
      assert.equal(renewal.frame.payload.status, "renewed");
      assert.equal(
        renewal.frame.payload.status === "renewed" && renewal.frame.payload.leaseExpiresAtMs,
        assignedRun.leaseExpiresAtMs + 60_000,
      );
      assert.equal(runLeaseRenewalCount, 1);

      const firstDispatch = await server.dispatch(issued.deviceId, assignedRun);
      await withTimeout(dispatchObserved, "dispatch");
      const replayedDispatch = await server.dispatch(issued.deviceId, assignedRun);
      assert.deepEqual(replayedDispatch, firstDispatch);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(dispatchCount, 1);

      const cancel = {
        action: "cancel" as const,
        fencingToken: assignedRun.fencingToken,
        leaseId: assignedRun.leaseId,
        reason: "coordinator-closed",
        runId: assignedRun.runId,
      };
      const firstControl = await server.control(
        issued.deviceId,
        cancel,
        assignedRun.taskId,
        "cancel:run-1:1",
      );
      await withTimeout(controlObserved, "control");
      const replayedControl = await server.control(
        issued.deviceId,
        cancel,
        assignedRun.taskId,
        "cancel:run-1:1",
      );
      assert.deepEqual(replayedControl, firstControl);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(controlCount, 1);

      await authority.revokeDevice({ deviceId: issued.deviceId });
      await server.closeRevokedDevice(issued.deviceId);
      await withTimeout(revokedObserved, "revocation");
    } finally {
      await client?.close().catch(() => undefined);
      await server.close();
      await workerState.close();
      await mainState.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function heartbeat(): WorkerHeartbeatV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "worker-mtls-1",
    workerId: "worker-runtime-1",
    observedAtMs: Date.now(),
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

function artifactManifest(deviceId: string) {
  return {
    artifactId: "artifact-run-1-report",
    taskId: "task-1",
    workOrderId: "work-order-1",
    deviceId,
    workerId: "worker-runtime-1",
    routeId: "route-main",
    runId: "run-1",
    leaseId: "lease-1",
    fencingToken: 1,
    mediaType: "text/plain",
    originalFilename: "report.txt",
    declaredSizeBytes: 20,
    expectedSha256: "1".repeat(64),
    requestedPresentation: "inline" as const,
  };
}

function assignment(): WorkerRunAssignmentV1 {
  return {
    taskId: "task-1",
    workOrder: {
      protocolVersion: PROTOCOL_VERSION,
      workOrderId: "work-order-1",
      title: "Build",
      brief: "Build the project.",
      completionCriteria: ["The build succeeds."],
      constraints: [],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: {
        preferredDeviceIds: ["worker-mtls-1"],
        preferredRoles: ["coding"],
      },
      requiredCapabilities: ["coding"],
      requiredSecretRefs: [],
    },
    deviceId: "worker-mtls-1",
    workerId: "worker-runtime-1",
    routeId: "route-1",
    runId: "run-1",
    leaseId: "lease-1",
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 60_000,
  };
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
    serialNumber: "11223344556677889900aabbccddeeff",
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

async function withTimeout(promise: Promise<void>, label: string): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      timeout.unref();
    }),
  ]);
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
