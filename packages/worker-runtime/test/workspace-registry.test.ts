import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RegisteredWorkerWorkspaceResolver,
  SqliteWorkspaceRegistry,
  WorkspaceRegistryError,
} from "../src/index.ts";

test("registered Workspaces persist locally and resolve an exact canonical binding", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const registry = new SqliteWorkspaceRegistry({
    filename: fixture.database,
    sourceCheckoutDirectory: fixture.checkout,
  });
  const registered = await registry.register({
    workspaceId: "workspace-app",
    alias: "Application",
    type: "directory",
    rootPath: fixture.workspace,
    isolation: "none",
    capabilities: ["files", "tests"],
  });
  assert.equal(registered.revision, 1);
  assert.equal(registered.rootPath, await realpath(fixture.workspace));
  assert.deepEqual(await registry.listSchedulingMetadata(), [
    {
      workspaceId: "workspace-app",
      alias: "Application",
      type: "directory",
      isolation: "none",
      capabilities: ["files", "tests"],
      state: "active",
      revision: 1,
    },
  ]);
  registry.close();

  const reopened = new SqliteWorkspaceRegistry({
    filename: fixture.database,
    sourceCheckoutDirectory: fixture.checkout,
  });
  const resolver = new RegisteredWorkerWorkspaceResolver({ registry: reopened });
  const binding = await resolver.resolve({
    assignment: assignment("workspace-app"),
    workspaceId: "workspace-app",
  });
  assert.deepEqual(binding, {
    workspaceId: "workspace-app",
    cwd: await realpath(fixture.workspace),
    isolation: "none",
  });
  reopened.close();
});

test("Workspace registration is revisioned and immutable path identity cannot drift", async (t) => {
  const fixture = await workspaceFixture();
  const registry = new SqliteWorkspaceRegistry({
    filename: fixture.database,
    sourceCheckoutDirectory: fixture.checkout,
  });
  t.after(async () => {
    registry.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  await registry.register({
    workspaceId: "workspace-app",
    alias: "Application",
    type: "directory",
    rootPath: fixture.workspace,
    isolation: "none",
    capabilities: ["files"],
  });
  const updated = await registry.updateMetadata({
    workspaceId: "workspace-app",
    expectedRevision: 1,
    alias: "Primary application",
    isolation: "agent-native-worktree",
    capabilities: ["files", "git"],
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.alias, "Primary application");

  await assert.rejects(
    registry.updateMetadata({
      workspaceId: "workspace-app",
      expectedRevision: 1,
      alias: "Stale update",
      isolation: "none",
      capabilities: [],
    }),
    (error: unknown) =>
      error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_REVISION_CONFLICT",
  );

  const moved = join(fixture.root, "workspace-moved");
  await rename(fixture.workspace, moved);
  await mkdir(fixture.workspace);
  const resolver = new RegisteredWorkerWorkspaceResolver({ registry });
  await assert.rejects(
    resolver.resolve({
      assignment: assignment("workspace-app"),
      workspaceId: "workspace-app",
    }),
    (error: unknown) =>
      error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_PATH_CHANGED",
  );
});

test("OpenDelegate-managed worktree isolation remains Git-only during metadata updates", async (t) => {
  const fixture = await workspaceFixture();
  const registry = new SqliteWorkspaceRegistry({
    filename: fixture.database,
    sourceCheckoutDirectory: fixture.checkout,
  });
  t.after(async () => {
    registry.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const registered = await registry.register({
    workspaceId: "workspace-directory",
    alias: "Directory",
    type: "directory",
    rootPath: fixture.workspace,
    isolation: "none",
    capabilities: ["files"],
  });
  await assert.rejects(
    registry.updateMetadata({
      workspaceId: registered.workspaceId,
      expectedRevision: registered.revision,
      alias: registered.alias,
      isolation: "opendelegate-worktree",
      capabilities: registered.capabilities,
    }),
    (error: unknown) =>
      error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_INVALID",
  );
});

test("Workspace registry rejects checkout state, linked roots, duplicate aliases, and implicit selection", async (t) => {
  const fixture = await workspaceFixture();

  assert.throws(
    () =>
      new SqliteWorkspaceRegistry({
        filename: join(fixture.checkout, "workspace.sqlite3"),
        sourceCheckoutDirectory: fixture.checkout,
      }),
    (error: unknown) =>
      error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_STATE_PATH_UNSAFE",
  );

  const registry = new SqliteWorkspaceRegistry({
    filename: fixture.database,
    sourceCheckoutDirectory: fixture.checkout,
  });
  t.after(async () => {
    registry.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const linked = join(fixture.root, "linked-workspace");
  await symlink(fixture.workspace, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    registry.register({
      workspaceId: "workspace-link",
      alias: "Linked",
      type: "directory",
      rootPath: linked,
      isolation: "none",
      capabilities: [],
    }),
    (error: unknown) =>
      error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_PATH_UNSAFE",
  );

  await registry.register({
    workspaceId: "workspace-one",
    alias: "Shared alias",
    type: "mounted-storage",
    rootPath: fixture.workspace,
    isolation: "custom",
    capabilities: ["storage"],
  });
  const second = join(fixture.root, "workspace-two");
  await mkdir(second);
  await assert.rejects(
    registry.register({
      workspaceId: "workspace-two",
      alias: "Shared alias",
      type: "directory",
      rootPath: second,
      isolation: "none",
      capabilities: [],
    }),
    (error: unknown) =>
      error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_CONFLICT",
  );

  const resolver = new RegisteredWorkerWorkspaceResolver({ registry });
  await assert.rejects(
    resolver.resolve({ assignment: assignment(undefined) }),
    (error: unknown) =>
      error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_REQUIRED",
  );
});

test("OpenDelegate-managed isolation resolves a stable Task workstream Git worktree", async (t) => {
  const fixture = await workspaceFixture();
  const worktree = join(fixture.root, "managed-worktree");
  await mkdir(worktree);
  const registry = new SqliteWorkspaceRegistry({
    filename: fixture.database,
    sourceCheckoutDirectory: fixture.checkout,
  });
  t.after(async () => {
    registry.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  await registry.register({
    workspaceId: "workspace-git",
    alias: "Git application",
    type: "git",
    rootPath: fixture.workspace,
    isolation: "opendelegate-worktree",
    capabilities: ["git"],
  });
  const createCalls: unknown[] = [];
  const resolver = new RegisteredWorkerWorkspaceResolver({
    registry,
    managedWorktreeManager: {
      create: async (input) => {
        createCalls.push(input);
        return {
          schemaVersion: 1,
          ...input,
          worktreePath: worktree,
          baseCommit: "a".repeat(40),
          state: "active",
          revision: 2,
          createdAtMs: 1,
          updatedAtMs: 2,
        };
      },
    },
  });
  const binding = await resolver.resolve({
    assignment: assignment("workspace-git"),
    workspaceId: "workspace-git",
    workstreamId: "implementation",
  });
  assert.deepEqual(binding, {
    workspaceId: "workspace-git",
    cwd: worktree,
    worktreePath: worktree,
    isolation: "opendelegate-worktree",
  });
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], {
    worktreeId: (createCalls[0] as { readonly worktreeId: string }).worktreeId,
    workspaceId: "workspace-git",
    repositoryRoot: await realpath(fixture.workspace),
  });
  assert.match(
    (createCalls[0] as { readonly worktreeId: string }).worktreeId,
    /^od-[0-9a-f]{40}$/u,
  );
});

async function workspaceFixture(): Promise<{
  readonly root: string;
  readonly checkout: string;
  readonly runtime: string;
  readonly database: string;
  readonly workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-workspace-test-"));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  const workspace = join(root, "workspace");
  await mkdir(checkout);
  await mkdir(runtime);
  await mkdir(workspace);
  return {
    root,
    checkout,
    runtime,
    database: join(runtime, "workspaces.sqlite3"),
    workspace,
  };
}

function assignment(workspaceId: string | undefined) {
  return {
    taskId: "task-workspace",
    workOrder: {
      protocolVersion: "v1" as const,
      workOrderId: "work-order-workspace",
      title: "Workspace test",
      brief: "Exercise the registered Workspace.",
      completionCriteria: ["The Workspace is resolved."],
      constraints: [],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: {
        preferredDeviceIds: [],
        preferredRoles: [],
      },
      requiredCapabilities: [],
      requiredSecretRefs: [],
      ...(workspaceId === undefined ? {} : { workspaceId }),
    },
    deviceId: "device-worker",
    workerId: "worker-device",
    routeId: "route-main",
    runId: "run-workspace",
    leaseId: "lease-workspace",
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 60_000,
  };
}
