import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentSession,
  AgentSessionId,
  DeviceId,
  DomainError,
  RunId,
  TaskId,
} from "../src/index.ts";

function createSession(): AgentSession {
  return AgentSession.create({
    id: AgentSessionId.from("agent-session-codex-001"),
    taskId: TaskId.from("task-launch-report"),
    deviceId: DeviceId.from("device-mac-studio"),
    provider: "codex",
    nativeSessionId: "native-thread-opaque-123",
    adapterVersion: "1.0.0",
    workspace: {
      workspaceId: "workspace-opendelegate",
      workingDirectory: "/worktrees/task-launch-report",
    },
  });
}

function writerLease(runId: RunId, fencingToken: number) {
  return {
    runId,
    leaseId: `lease-${runId.value}`,
    fencingToken,
    acquiredAtMs: 1_000,
    expiresAtMs: 2_000,
  };
}

test("an Agent Session preserves the Task, Device, provider, and Workspace resume binding", () => {
  const session = createSession();

  assert.deepEqual(session.resumeBinding, {
    taskId: "task-launch-report",
    deviceId: "device-mac-studio",
    provider: "codex",
    nativeSessionId: "native-thread-opaque-123",
    adapterVersion: "1.0.0",
    workspaceId: "workspace-opendelegate",
    workingDirectory: "/worktrees/task-launch-report",
  });
  assert.equal(Object.isFrozen(session.resumeBinding), true);
});

test("one native Agent Session permits only one active writer", () => {
  const session = createSession();
  const firstRun = RunId.from("run-worker-first");
  const firstLease = writerLease(firstRun, 1);

  session.acquireWriter(firstLease);
  session.acquireWriter(firstLease);

  assert.throws(
    () => session.acquireWriter(writerLease(RunId.from("run-worker-second"), 2)),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "AGENT_SESSION_WRITER_CONFLICT");
      return true;
    },
  );
  assert.equal(session.activeWriterRunId, "run-worker-first");
});

test("resume is rejected on another Device or working directory", () => {
  const session = createSession();

  assert.throws(
    () =>
      session.assertResumeBinding({
        deviceId: "device-windows-dev",
        workspaceId: "workspace-opendelegate",
        workingDirectory: "C:\\worktrees\\task-launch-report",
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "AGENT_SESSION_BINDING_MISMATCH");
      return true;
    },
  );
});

test("a lost native Agent Session refuses new writers and records continuation lineage", () => {
  const session = createSession();

  const continuation = session.markLost({
    checkpointId: "checkpoint-task-launch-04",
    reason: "native-session-unavailable",
  });

  assert.equal(session.state, "lost");
  assert.deepEqual(continuation, {
    parentSessionId: "agent-session-codex-001",
    taskId: "task-launch-report",
    deviceId: "device-mac-studio",
    checkpointId: "checkpoint-task-launch-04",
    reason: "native-session-unavailable",
  });
  assert.throws(
    () => session.acquireWriter(writerLease(RunId.from("run-too-late"), 1)),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "AGENT_SESSION_UNAVAILABLE");
      return true;
    },
  );
});

test("only the active writer can release a native Agent Session", () => {
  const session = createSession();
  const ownerLease = writerLease(RunId.from("run-owner"), 1);
  session.acquireWriter(ownerLease);

  assert.throws(
    () =>
      session.releaseWriter({
        runId: RunId.from("run-intruder"),
        leaseId: ownerLease.leaseId,
        fencingToken: ownerLease.fencingToken,
        observedAtMs: 1_100,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "AGENT_SESSION_WRITER_MISMATCH");
      return true;
    },
  );

  session.releaseWriter({
    runId: ownerLease.runId,
    leaseId: ownerLease.leaseId,
    fencingToken: ownerLease.fencingToken,
    observedAtMs: 1_100,
  });
  assert.equal(session.activeWriterRunId, undefined);
});

test("an expired writer lease can only be replaced by a higher fencing token", () => {
  const session = createSession();
  session.acquireWriter({
    runId: RunId.from("run-first"),
    leaseId: "lease-first",
    fencingToken: 7,
    acquiredAtMs: 1_000,
    expiresAtMs: 1_100,
  });

  assert.throws(
    () =>
      session.acquireWriter({
        runId: RunId.from("run-stale"),
        leaseId: "lease-stale",
        fencingToken: 7,
        acquiredAtMs: 1_100,
        expiresAtMs: 1_200,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "AGENT_SESSION_FENCE_STALE");
      return true;
    },
  );

  session.acquireWriter({
    runId: RunId.from("run-next"),
    leaseId: "lease-next",
    fencingToken: 8,
    acquiredAtMs: 1_100,
    expiresAtMs: 1_200,
  });
  assert.equal(session.activeWriterRunId, "run-next");
});

test("Agent Session writer fencing survives snapshot restoration", () => {
  const session = createSession();
  session.acquireWriter({
    runId: RunId.from("run-before-restart"),
    leaseId: "lease-before-restart",
    fencingToken: 22,
    acquiredAtMs: 2_000,
    expiresAtMs: 2_100,
  });

  const restored = AgentSession.restore(session.snapshot);

  assert.throws(
    () =>
      restored.acquireWriter({
        runId: RunId.from("run-stale-after-restart"),
        leaseId: "lease-stale-after-restart",
        fencingToken: 22,
        acquiredAtMs: 2_100,
        expiresAtMs: 2_200,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "AGENT_SESSION_FENCE_STALE");
      return true;
    },
  );
});
