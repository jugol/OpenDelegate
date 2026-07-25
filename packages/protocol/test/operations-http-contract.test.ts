import assert from "node:assert/strict";
import test from "node:test";

import Value from "typebox/value";

import {
  ArtifactDetailSchema,
  ArtifactListResponseSchema,
  ArtifactOpenInstructionSchema,
  AuditEventListResponseSchema,
  DeviceEnrollmentOverviewSchema,
  IssueEnrollmentGrantRequestSchema,
  IssueEnrollmentGrantResponseSchema,
} from "../src/index.ts";

const NOW = "2026-07-25T00:00:00.000Z";

test("Device enrollment contracts expose a one-time grant document without accepting arbitrary Roles", () => {
  assert.equal(
    Value.Check(IssueEnrollmentGrantRequestSchema, {
      deviceId: "device_laptop",
      expiresInSeconds: 300,
    }),
    true,
  );
  assert.equal(
    Value.Check(IssueEnrollmentGrantRequestSchema, {
      deviceId: "device_laptop",
      expiresInSeconds: 300,
      allowedBootstrapRoles: ["main"],
    }),
    false,
  );

  const summary = {
    grantId: "grant_001",
    deviceId: "device_laptop",
    status: "active",
    allowedBootstrapRoles: ["worker"],
    createdAt: NOW,
    expiresAt: "2026-07-25T00:05:00.000Z",
  };
  const document = {
    schemaVersion: 1,
    grantId: summary.grantId,
    token: "g".repeat(43),
    deviceId: summary.deviceId,
    mainDeviceId: "device_main",
    expectedMainSpkiSha256: `sha256:${"a".repeat(43)}`,
    certificateAuthorityPem: `-----BEGIN CERTIFICATE-----\n${"A".repeat(96)}\n-----END CERTIFICATE-----\n`,
    enrollmentUrl: "https://main.example.test:9443/api/v1/device/enroll",
    channelEndpoints: [
      {
        endpointId: "main-worker-channel",
        label: "Main Worker channel",
        kind: "wss",
        url: "wss://main.example.test:9444/api/v1/device/channel",
      },
    ],
    protocolRange: { minimum: 1, maximum: 1 },
    expiresAt: Date.parse(summary.expiresAt),
  };

  assert.equal(
    Value.Check(DeviceEnrollmentOverviewSchema, {
      available: true,
      mainDeviceId: "device_main",
      expectedMainSpkiSha256: document.expectedMainSpkiSha256,
      enrollmentUrl: document.enrollmentUrl,
      channelEndpoints: document.channelEndpoints,
      grants: [summary],
    }),
    true,
  );
  assert.equal(
    Value.Check(IssueEnrollmentGrantResponseSchema, {
      summary,
      suggestedFilename: "opendelegate-device_laptop-grant.json",
      document,
    }),
    true,
  );
  assert.equal(
    Value.Check(IssueEnrollmentGrantResponseSchema, {
      summary,
      suggestedFilename: "grant.json",
      document,
      tokenDigest: "must-not-cross-admin",
    }),
    false,
  );
});

test("Artifact contracts expose metadata and an explicit isolated-origin open instruction", () => {
  const artifact = {
    artifactId: "artifact_report",
    taskId: "task_release",
    producingRunId: "run_worker",
    mediaType: "text/html",
    originalFilename: "release-report.html",
    sizeBytes: 4096,
    checksum: { algorithm: "sha256", value: "b".repeat(64) },
    createdAt: NOW,
    retentionPolicy: {
      kind: "temporary",
      expiresAt: "2026-07-26T00:00:00.000Z",
    },
    exposurePolicy: { mode: "authenticated" },
    provenance: {
      deviceId: "device_worker",
      source: "worker-upload",
      workspaceId: "workspace_repo",
    },
    presentation: "static-html",
    state: "available",
  };

  assert.equal(Value.Check(ArtifactDetailSchema, artifact), true);
  assert.equal(Value.Check(ArtifactListResponseSchema, { artifacts: [artifact] }), true);
  assert.equal(
    Value.Check(ArtifactOpenInstructionSchema, {
      method: "POST",
      actionUrl: "https://static.artifacts.example.test/artifacts/artifact_report",
      fieldName: "grant",
      fieldValue: "x".repeat(43),
      artifactId: artifact.artifactId,
      expiresAt: "2026-07-25T00:01:00.000Z",
    }),
    true,
  );
  assert.equal(
    Value.Check(ArtifactDetailSchema, {
      ...artifact,
      bytes: "<script>never cross Admin</script>",
    }),
    false,
  );
});

test("Audit contracts are bounded projections and reject raw payloads", () => {
  const event = {
    auditId: "audit_001",
    source: "device-identity",
    type: "device.enrolled",
    occurredAt: NOW,
    outcome: "succeeded",
    actorId: "system",
    subjectId: "device_worker",
    correlationId: "correlation_001",
    deviceId: "device_worker",
  };
  assert.equal(Value.Check(AuditEventListResponseSchema, { events: [event] }), true);
  assert.equal(
    Value.Check(AuditEventListResponseSchema, {
      events: [{ ...event, payload: { knowledge: "must stay local" } }],
    }),
    false,
  );
});
