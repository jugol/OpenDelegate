import assert from "node:assert/strict";
import test from "node:test";

import {
  Artifact,
  ArtifactId,
  AuditEvent,
  AuditEventId,
  DeviceId,
  DomainError,
  RunId,
  TaskId,
  resolveArtifactExposure,
} from "../src/index.ts";

test("Artifact metadata preserves ownership, integrity, retention, exposure, and provenance", () => {
  const artifact = Artifact.create({
    id: ArtifactId.from("artifact-report"),
    taskId: TaskId.from("task-report"),
    producingRunId: RunId.from("run-render"),
    mediaType: "text/html",
    sizeBytes: 4_096,
    checksum: {
      algorithm: "sha256",
      value: "abc123",
    },
    createdAtMs: 1_000,
    retentionPolicy: {
      kind: "temporary",
      expiresAtMs: 10_000,
    },
    exposurePolicy: {
      mode: "authenticated",
    },
    provenance: {
      deviceId: DeviceId.from("device-main"),
      source: "worker-upload",
      workspaceId: "workspace-opendelegate",
    },
  });

  assert.deepEqual(artifact.metadata, {
    id: "artifact-report",
    taskId: "task-report",
    producingRunId: "run-render",
    mediaType: "text/html",
    sizeBytes: 4_096,
    checksum: {
      algorithm: "sha256",
      value: "abc123",
    },
    createdAtMs: 1_000,
    retentionPolicy: {
      kind: "temporary",
      expiresAtMs: 10_000,
    },
    exposurePolicy: {
      mode: "authenticated",
    },
    provenance: {
      deviceId: "device-main",
      source: "worker-upload",
      workspaceId: "workspace-opendelegate",
    },
    state: "available",
  });
  assert.equal(Object.isFrozen(artifact.metadata), true);
  assert.equal(Object.isFrozen(artifact.metadata.checksum), true);
  assert.equal(Object.isFrozen(artifact.metadata.retentionPolicy), true);
  assert.equal(Object.isFrozen(artifact.metadata.provenance), true);

  assert.throws(
    () => artifact.expire(9_999),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "ARTIFACT_RETENTION_ACTIVE");
      return true;
    },
  );
  artifact.expire(10_000);
  assert.equal(artifact.state, "expired");
});

test("Audit events defensively copy and freeze structured details", () => {
  const details: {
    reason: string;
    evidence: { route: string; attempts: number[] };
  } = {
    reason: "route exhausted",
    evidence: {
      route: "tailscale",
      attempts: [1, 2],
    },
  };
  const event = AuditEvent.create({
    id: AuditEventId.from("audit-route-failed"),
    eventType: "transport.route.exhausted",
    occurredAtMs: 5_000,
    actor: { type: "system", id: "control-plane" },
    subject: { type: "device", id: "device-worker" },
    correlationId: "correlation-task-report",
    taskId: TaskId.from("task-report"),
    deviceId: DeviceId.from("device-worker"),
    outcome: "failure",
    details,
  });

  details.reason = "mutated";
  details.evidence.attempts.push(3);

  assert.deepEqual(event.snapshot.details, {
    reason: "route exhausted",
    evidence: {
      route: "tailscale",
      attempts: [1, 2],
    },
  });
  assert.equal(Object.isFrozen(event.snapshot), true);
  assert.equal(Object.isFrozen(event.snapshot.details), true);
  const evidence = event.snapshot.details["evidence"];
  assert.equal(
    typeof evidence === "object" && evidence !== null && Object.isFrozen(evidence),
    true,
  );
});

test("Artifact exposure resolves from Instance to Device to Task to Artifact", () => {
  const instance = { mode: "private-network" } as const;
  const device = { mode: "authenticated" } as const;
  const task = { mode: "signed-link" } as const;
  const artifact = { mode: "custom", customPolicyId: "exposure-owner-preview" } as const;

  assert.deepEqual(resolveArtifactExposure({ instance }), {
    source: "instance",
    policy: instance,
  });
  assert.deepEqual(resolveArtifactExposure({ instance, device }), {
    source: "device",
    policy: device,
  });
  assert.deepEqual(resolveArtifactExposure({ instance, device, task }), {
    source: "task",
    policy: task,
  });
  const resolved = resolveArtifactExposure({ instance, device, task, artifact });
  assert.deepEqual(resolved, {
    source: "artifact",
    policy: artifact,
  });
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.policy), true);
});

test("Artifact timestamps must be safe and temporary retention must follow creation", () => {
  const createArtifact = (createdAtMs: number, expiresAtMs: number) =>
    Artifact.create({
      id: ArtifactId.from("artifact-invalid-clock"),
      taskId: TaskId.from("task-invalid-clock"),
      producingRunId: RunId.from("run-invalid-clock"),
      mediaType: "text/html",
      sizeBytes: 1,
      checksum: { algorithm: "sha256", value: "abc123" },
      createdAtMs,
      retentionPolicy: { kind: "temporary", expiresAtMs },
      exposurePolicy: { mode: "authenticated" },
      provenance: {
        deviceId: DeviceId.from("device-main"),
        source: "worker-upload",
      },
    });

  assert.throws(
    () => createArtifact(Number.NaN, 2_000),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "ARTIFACT_RETENTION_INVALID");
      return true;
    },
  );
  assert.throws(
    () => createArtifact(2_000, 2_000),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "ARTIFACT_RETENTION_INVALID");
      return true;
    },
  );

  const artifact = createArtifact(1_000, 2_000);
  assert.throws(
    () => artifact.expire(Number.NaN),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "ARTIFACT_RETENTION_INVALID");
      return true;
    },
  );
  assert.equal(artifact.state, "available");
});
