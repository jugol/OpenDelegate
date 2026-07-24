import assert from "node:assert/strict";
import test from "node:test";

import { DeviceId, DomainError, Workspace, WorkspaceId } from "../src/index.ts";

function createWorkspace(): Workspace {
  return Workspace.create({
    id: WorkspaceId.from("workspace-opendelegate"),
    deviceId: DeviceId.from("device-windows"),
    alias: "OpenDelegate",
    type: "git-repository",
    localPath: "C:\\CodexProjects\\OpenDelegate",
    capabilityIds: ["git", "worktree"],
    isolation: "agent-native-worktree",
  });
}

test("a Workspace keeps Main-safe metadata while resolving its path only on its Device", () => {
  const workspace = createWorkspace();

  assert.equal(
    workspace.resolveLocalPath(DeviceId.from("device-windows")),
    "C:\\CodexProjects\\OpenDelegate",
  );
  assert.deepEqual(workspace.schedulingSnapshot, {
    id: "workspace-opendelegate",
    deviceId: "device-windows",
    alias: "OpenDelegate",
    type: "git-repository",
    capabilityIds: ["git", "worktree"],
    isolation: "agent-native-worktree",
  });
  assert.equal(Object.isFrozen(workspace.schedulingSnapshot), true);
  assert.equal(Object.isFrozen(workspace.schedulingSnapshot.capabilityIds), true);

  assert.throws(
    () => workspace.resolveLocalPath(DeviceId.from("device-mac")),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "WORKSPACE_DEVICE_MISMATCH");
      return true;
    },
  );
});

test("Workspace cleanup requires an approved disposition for dirty work", () => {
  const workspace = createWorkspace();

  assert.throws(
    () =>
      workspace.assertCleanupAllowed({
        hasUncommittedChanges: true,
        hasUntrackedFiles: false,
        hasUnpushedCommits: true,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "WORKSPACE_CLEANUP_UNSAFE");
      return true;
    },
  );

  assert.throws(
    () =>
      workspace.assertCleanupAllowed({
        hasUncommittedChanges: true,
        hasUntrackedFiles: false,
        hasUnpushedCommits: true,
        approvedDisposition: "preserve",
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "WORKSPACE_CLEANUP_UNSAFE");
      return true;
    },
  );

  workspace.assertCleanupAllowed({
    hasUncommittedChanges: true,
    hasUntrackedFiles: false,
    hasUnpushedCommits: true,
    approvedDisposition: "discard",
  });
});
