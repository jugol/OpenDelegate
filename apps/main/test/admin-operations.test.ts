import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdminOperationsPortError } from "@opendelegate/control-plane";
import type { StoredArtifactMetadata } from "@opendelegate/artifact-store";
import { createActionFingerprint } from "@opendelegate/policy";

import { createMainAdminOperations } from "../src/admin-operations.ts";

const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");
const CA_PEM = `-----BEGIN CERTIFICATE-----\n${"A".repeat(96)}\n-----END CERTIFICATE-----\n`;
const SPKI = `sha256:${"a".repeat(43)}`;

test("Admin enrollment issues one durable idempotent Worker grant without projecting its token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-admin-operations-"));
  let issueCalls = 0;
  const grants = [
    {
      grantId: "grant_existing",
      tokenDigest: "digest-must-not-cross-admin",
      deviceId: "device_existing",
      allowedBootstrapRoles: ["worker"],
      protocolRange: { minimum: 1, maximum: 1 },
      status: "active" as const,
      createdAt: NOW_MS - 1_000,
      expiresAt: NOW_MS + 60_000,
    },
  ];
  try {
    const operations = createMainAdminOperations({
      mainDeviceId: "device_main",
      idempotencyDirectory: directory,
      clock: { now: () => NOW_MS },
      deviceChannelConfiguration: {
        enrollment: {
          advertisedUrl: "https://main.example.test:9443/api/v1/device/enroll",
          host: "127.0.0.1",
          port: 9443,
          tlsCertificatePath: "unused",
          tlsPrivateKeyPath: "unused",
        },
        workerChannel: {
          advertisedUrl: "wss://main.example.test:9444/api/v1/device/channel",
          host: "127.0.0.1",
          port: 9444,
          tlsCertificatePath: "unused",
          tlsPrivateKeyPath: "unused",
        },
      },
      deviceChannel: {
        authority: {
          createEnrollmentGrant: async (input: {
            readonly deviceId: string;
            readonly expiresInMs: number;
          }) => {
            issueCalls += 1;
            return {
              grantId: "grant_abcdefghijklmnopqrstuv",
              deviceId: input.deviceId,
              allowedBootstrapRoles: ["worker"],
              protocolRange: { minimum: 1, maximum: 1 },
              createdAt: NOW_MS,
              expiresAt: NOW_MS + input.expiresInMs,
              expectedMainSpkiSha256: SPKI,
              secret: { reveal: () => "g".repeat(43) },
            };
          },
        },
        certificateAuthorityPem: CA_PEM,
        certificateAuthoritySpkiSha256: SPKI,
        enrollmentAddress: {
          host: "127.0.0.1",
          port: 9443,
          url: "https://127.0.0.1:9443/api/v1/device/enroll",
        },
        workerChannel: {
          address: () => ({
            host: "127.0.0.1",
            port: 9444,
            url: "wss://127.0.0.1:9444/api/v1/device/channel",
          }),
        },
        listEnrollmentGrants: async () => grants,
        listIdentityAuditRecords: async () => [],
      },
      eventStore: { readAll: async () => [] },
    });

    const overview = await operations.enrollment.overview();
    assert.equal(overview.available, true);
    assert.equal(overview.enrollmentUrl, "https://main.example.test:9443/api/v1/device/enroll");
    assert.equal(JSON.stringify(overview).includes("digest-must-not-cross-admin"), false);

    const request = {
      deviceId: "device_laptop",
      expiresInSeconds: 300,
      principalId: "owner_1",
      idempotencyKey: "join-device-laptop",
    };
    const first = await operations.enrollment.issue(request);
    const replay = await operations.enrollment.issue(request);
    assert.deepEqual(replay, first);
    assert.equal(issueCalls, 1);
    assert.equal(first.document.token, "g".repeat(43));
    assert.equal(first.document.expectedMainSpkiSha256, SPKI);
    assert.equal(first.document.enrollmentUrl, overview.enrollmentUrl);

    await assert.rejects(
      operations.enrollment.issue({ ...request, deviceId: "device_other" }),
      (error: unknown) =>
        error instanceof AdminOperationsPortError &&
        error.code === "ENROLLMENT_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Admin Artifact operations return metadata and isolated-origin open instructions, never bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-admin-operations-"));
  const metadata = artifactMetadata({ exposurePolicy: { mode: "authenticated" } });
  let grantCalls = 0;
  try {
    const operations = createMainAdminOperations({
      mainDeviceId: "device_main",
      idempotencyDirectory: directory,
      clock: { now: () => NOW_MS },
      artifacts: {
        configuration: {
          listeners: {
            static: { origin: "https://static.artifacts.example.test" },
            interactive: { origin: "https://interactive.artifacts.example.test" },
          },
        },
        store: {
          listMetadata: async () => [metadata],
          getMetadata: async () => metadata,
          getAvailableMetadata: async () => metadata,
          listAuditEvents: async () => [],
        },
        issueBrowserAccessGrant: async (input: { readonly artifactId: string }) => {
          grantCalls += 1;
          return {
            method: "POST" as const,
            actionUrl: "https://static.artifacts.example.test/owner-session/exchange",
            fieldName: "grant" as const,
            fieldValue: "b".repeat(43),
            artifactId: input.artifactId,
            expiresAtMs: NOW_MS + 60_000,
          };
        },
      },
      eventStore: { readAll: async () => [] },
    });

    const listed = await operations.artifacts.list();
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes("<html"), false);
    const input = {
      artifactId: metadata.artifactId,
      principalId: "owner_1",
      idempotencyKey: "open-report",
    };
    const first = await operations.artifacts.open(input);
    const replay = await operations.artifacts.open(input);
    assert.deepEqual(replay, first);
    assert.equal(first.method, "POST");
    assert.equal(grantCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Admin audit is a bounded redacted projection across runtime sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-admin-operations-"));
  const approvalFingerprint = createActionFingerprint({
    kind: "os-network-change",
    operation: "deny",
    target: "device_worker",
  });
  try {
    const operations = createMainAdminOperations({
      mainDeviceId: "device_main",
      idempotencyDirectory: directory,
      clock: { now: () => NOW_MS },
      deviceChannel: {
        listEnrollmentGrants: async () => [],
        listIdentityAuditRecords: async () => [
          {
            auditId: "identity-audit-1",
            event: "device.enrolled",
            occurredAt: NOW_MS - 2_000,
            deviceId: "device_worker",
          },
        ],
      },
      artifacts: {
        store: {
          listAuditEvents: async () => [
            {
              sequence: 1,
              eventType: "artifact.access-denied",
              occurredAtMs: NOW_MS - 1_000,
              artifactId: "artifact_report",
              actor: { type: "owner", id: "owner_1" },
              correlationId: "correlation_1",
              details: { secret: "must-not-cross-admin" },
            },
          ],
        },
      },
      configurationAudits: {
        listAudit: async () => [
          {
            id: "configuration-audit-1",
            action: "configuration.applied",
            actor: "owner_1",
            reason: "Enable the configured Device policy.",
            occurredAt: "2026-07-24T23:59:58.500Z",
            revision: 2,
            changeSetId: "configuration-change-1",
            proposalId: "configuration-proposal-1",
            diff: [
              {
                key: "policy.network-change",
                scope: { kind: "device", id: "device_worker" },
                before: "prompt",
                after: "deny",
              },
            ],
          },
        ],
      },
      approvalAudits: {
        audit: async () => [
          {
            auditId: "approval-audit-1",
            approvalId: "approval_network_1",
            event: "approval.denied",
            actor: "owner_1",
            occurredAtMs: NOW_MS - 2_500,
            actionFingerprint: approvalFingerprint,
          },
        ],
      },
      ownerAuthAudits: {
        listAuditRecords: async () => [
          {
            auditId: "owner-auth-audit-1",
            event: "owner.auth.session-revoked",
            occurredAt: NOW_MS - 1_250,
            ownerId: "owner_1",
            targetSessionId: "session_revoked",
          },
        ],
      },
      actionAuthorizationAudits: {
        listAudit: async () => [
          {
            auditId: "action-authorization-audit-1",
            event: "worker.action.os-network-change.denied",
            occurredAtMs: NOW_MS - 750,
            authorizationId: `authorization:${"a".repeat(64)}`,
            authorizationRequestId: "action-request-1",
            taskId: "task_release",
            runId: "run_worker",
            deviceId: "device_worker",
            decision: "deny",
            reasonCode: "OWNER_DENIED",
            consumed: false,
          },
        ],
      },
      eventStore: {
        readAll: async () => [
          {
            eventId: "event_route_diagnosis_1",
            streamId: `route_incident_${"d".repeat(24)}`,
            streamVersion: 2,
            globalPosition: 2,
            type: "transport.route-incident.diagnosis-completed.v1",
            occurredAt: "2026-07-24T23:59:59.500Z",
            payload: {
              schemaVersion: 1,
              incidentId: `sha256:${"a".repeat(64)}`,
              result: {
                incidentId: `sha256:${"a".repeat(64)}`,
                fingerprint: `sha256:${"b".repeat(64)}`,
                profileRevision: `sha256:${"c".repeat(64)}`,
                authenticatedDeviceId: "device_worker",
                recommendation: "Check the private route from this Device.",
                ownerQuestion: "Should OpenDelegate keep using the next configured route?",
                source: "agent",
                reasonCode: "AGENT_COMPLETED",
              },
            },
          },
          {
            eventId: "event_task_1",
            streamId: "task:task_release",
            streamVersion: 1,
            globalPosition: 1,
            type: "task.created",
            occurredAt: "2026-07-24T23:59:56.000Z",
            payload: {
              taskId: "task_release",
              knowledge: "device-local Knowledge must never cross Main",
            },
          },
        ],
      },
    });

    const events = await operations.audit.list();
    assert.deepEqual(
      events.map((event) => event.source),
      [
        "runtime",
        "action-authorization",
        "artifact",
        "owner-auth",
        "configuration",
        "device-identity",
        "approval",
        "task",
      ],
    );
    assert.deepEqual(events[0]?.routeIncident, {
      incidentId: `sha256:${"a".repeat(64)}`,
      fingerprint: `sha256:${"b".repeat(64)}`,
      profileRevision: `sha256:${"c".repeat(64)}`,
      recommendation: "Check the private route from this Device.",
      ownerQuestion: "Should OpenDelegate keep using the next configured route?",
      source: "agent",
      reasonCode: "AGENT_COMPLETED",
    });
    assert.equal(events[0]?.deviceId, "device_worker");
    assert.equal(events[1]?.reasonCode, "OWNER_DENIED");
    assert.deepEqual(events[3], {
      auditId: "owner-auth-audit-1",
      source: "owner-auth",
      type: "owner.auth.session-revoked",
      occurredAt: "2026-07-24T23:59:58.750Z",
      outcome: "denied",
      actorId: "owner_1",
      subjectId: "session_revoked",
    });
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("must-not-cross-admin"), false);
    assert.equal(serialized.includes("device-local Knowledge"), false);
    assert.equal(serialized.includes("Enable the configured Device policy."), false);
    assert.equal(serialized.includes(approvalFingerprint), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function artifactMetadata(overrides: Partial<StoredArtifactMetadata> = {}): StoredArtifactMetadata {
  return {
    artifactId: "artifact_report",
    taskId: "task_release",
    producingRunId: "run_worker",
    mediaType: "text/html",
    originalFilename: "report.html",
    sizeBytes: 128,
    checksum: { algorithm: "sha256", value: "c".repeat(64) },
    createdAtMs: NOW_MS - 10_000,
    retentionPolicy: { kind: "task" },
    exposurePolicy: { mode: "authenticated" },
    provenance: { deviceId: "device_worker", source: "worker-upload" },
    presentation: "static-html",
    state: "available",
    ...overrides,
  };
}
