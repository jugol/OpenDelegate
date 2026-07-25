import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildGitChildEnvironment,
  ManagedGitWorktreeError,
  ManagedGitWorktreeManager,
} from "../src/index.ts";

const run = promisify(execFile);

test("Git child environments preserve only platform essentials and fixed noninteractive settings", () => {
  const ambient = {
    PATH: "/safe/bin",
    Path: "C:\\safe\\bin",
    PATHEXT: ".COM;.EXE",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    TMPDIR: "/safe/tmpdir",
    TEMP: "C:\\safe\\temp",
    TMP: "C:\\safe\\tmp",
    HOME: "/secret/home",
    USERPROFILE: "C:\\Users\\secret",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: Bearer secret",
    GITHUB_TOKEN: "github-secret",
    DATABASE_URI: "postgresql://user:password@example.invalid/database",
  };

  assert.deepEqual(buildGitChildEnvironment("win32", ambient), {
    PATH: "/safe/bin",
    PATHEXT: ".COM;.EXE",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    TEMP: "C:\\safe\\temp",
    TMP: "C:\\safe\\tmp",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  });
  assert.deepEqual(buildGitChildEnvironment("linux", ambient), {
    PATH: "/safe/bin",
    TMPDIR: "/safe/tmpdir",
    TEMP: "C:\\safe\\temp",
    TMP: "C:\\safe\\tmp",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  });
  assert.deepEqual(buildGitChildEnvironment("darwin", ambient), {
    PATH: "/safe/bin",
    TMPDIR: "/safe/tmpdir",
    TEMP: "C:\\safe\\temp",
    TMP: "C:\\safe\\tmp",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  });
});

test("managed Git worktrees are isolated, durable, and based on the registered repository HEAD", async (t) => {
  const fixture = await gitFixture();
  const manager = createManager(fixture);
  const openManagers = [manager];
  t.after(async () => {
    for (const openManager of openManagers) {
      openManager.close();
    }
    await rm(fixture.root, { recursive: true, force: true });
  });

  const created = await manager.create({
    worktreeId: "task-one",
    workspaceId: "workspace-repository",
    repositoryRoot: fixture.repository,
  });

  assert.equal(created.state, "active");
  assert.equal(created.baseCommit, fixture.initialCommit);
  assert.equal(created.worktreePath, join(fixture.managedRoot, "task-one"));
  assert.equal(
    (await readFile(join(created.worktreePath, "README.md"), "utf8")).replaceAll("\r\n", "\n"),
    "initial\n",
  );
  assert.equal((await manager.inspect("task-one")).hasUncommittedChanges, false);
  assert.equal((await manager.inspect("task-one")).hasUntrackedFiles, false);
  assert.equal((await manager.inspect("task-one")).hasUnpushedCommits, false);
  manager.close();

  const reopened = createManager(fixture);
  openManagers.push(reopened);
  const recovered = await reopened.create({
    worktreeId: "task-one",
    workspaceId: "workspace-repository",
    repositoryRoot: fixture.repository,
  });
  assert.equal(recovered.worktreePath, created.worktreePath);
  assert.equal(recovered.revision, created.revision);
});

test("cleanup preserves dirty or committed work unless discard is explicitly approved", async (t) => {
  const fixture = await gitFixture();
  const manager = createManager(fixture);
  t.after(async () => {
    manager.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const dirty = await manager.create({
    worktreeId: "dirty-task",
    workspaceId: "workspace-repository",
    repositoryRoot: fixture.repository,
  });
  await writeFile(join(dirty.worktreePath, "untracked.txt"), "valuable\n", "utf8");

  await assert.rejects(
    manager.dispose({ worktreeId: dirty.worktreeId }),
    (error: unknown) =>
      error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_CLEANUP_UNSAFE",
  );
  const preserved = await manager.dispose({
    worktreeId: dirty.worktreeId,
    approvedDisposition: "preserve",
  });
  assert.equal(preserved.action, "preserved");
  assert.equal(preserved.inspection.hasUntrackedFiles, true);
  await access(dirty.worktreePath);

  const discarded = await manager.dispose({
    worktreeId: dirty.worktreeId,
    approvedDisposition: "discard",
  });
  assert.equal(discarded.action, "removed");
  await assert.rejects(access(dirty.worktreePath));

  const committed = await manager.create({
    worktreeId: "committed-task",
    workspaceId: "workspace-repository",
    repositoryRoot: fixture.repository,
  });
  await writeFile(join(committed.worktreePath, "README.md"), "changed\n", "utf8");
  await git(["-C", committed.worktreePath, "add", "--", "README.md"]);
  await git(["-C", committed.worktreePath, "commit", "-m", "task change"]);
  const inspection = await manager.inspect(committed.worktreeId);
  assert.equal(inspection.hasUncommittedChanges, false);
  assert.equal(inspection.hasUntrackedFiles, false);
  assert.equal(inspection.hasUnpushedCommits, true);
  await assert.rejects(
    manager.dispose({ worktreeId: committed.worktreeId }),
    (error: unknown) =>
      error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_CLEANUP_UNSAFE",
  );
});

test("worktree ownership, path identity, and managed-root boundaries fail closed", async (t) => {
  const fixture = await gitFixture();
  const manager = createManager(fixture);
  t.after(async () => {
    manager.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    manager.create({
      worktreeId: "../escape",
      workspaceId: "workspace-repository",
      repositoryRoot: fixture.repository,
    }),
    (error: unknown) =>
      error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_INPUT_INVALID",
  );

  const created = await manager.create({
    worktreeId: "replace-me",
    workspaceId: "workspace-repository",
    repositoryRoot: fixture.repository,
  });
  const displaced = join(fixture.root, "displaced-worktree");
  await rename(created.worktreePath, displaced);
  await mkdir(created.worktreePath);
  await assert.rejects(
    manager.inspect(created.worktreeId),
    (error: unknown) =>
      error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_PATH_CHANGED",
  );

  const rebound = await manager.create({
    worktreeId: "rebind-me",
    workspaceId: "workspace-repository",
    repositoryRoot: fixture.repository,
  });
  await rm(join(rebound.worktreePath, ".git"), { force: true });
  await git(["init", "--initial-branch=other", rebound.worktreePath]);
  await assert.rejects(
    manager.inspect(rebound.worktreeId),
    (error: unknown) =>
      error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_PATH_CHANGED",
  );

  assert.throws(
    () =>
      new ManagedGitWorktreeManager({
        filename: join(fixture.runtime, "unsafe.sqlite3"),
        managedRootDirectory: join(fixture.checkout, "worktrees"),
        sourceCheckoutDirectory: fixture.checkout,
      }),
    (error: unknown) =>
      error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_ROOT_UNSAFE",
  );
});

interface GitFixture {
  readonly root: string;
  readonly checkout: string;
  readonly runtime: string;
  readonly database: string;
  readonly repository: string;
  readonly managedRoot: string;
  readonly initialCommit: string;
}

function createManager(fixture: GitFixture): ManagedGitWorktreeManager {
  return new ManagedGitWorktreeManager({
    filename: fixture.database,
    managedRootDirectory: fixture.managedRoot,
    sourceCheckoutDirectory: fixture.checkout,
  });
}

async function gitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worktree-test-"));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  const repository = join(root, "repository");
  const managedRoot = join(runtime, "worktrees");
  await mkdir(checkout);
  await mkdir(runtime);
  await mkdir(repository);
  await git(["init", "--initial-branch=main", repository]);
  await git(["-C", repository, "config", "user.name", "OpenDelegate Test"]);
  await git(["-C", repository, "config", "user.email", "test@opendelegate.local"]);
  await writeFile(join(repository, "README.md"), "initial\n", "utf8");
  await git(["-C", repository, "add", "--", "README.md"]);
  await git(["-C", repository, "commit", "-m", "initial"]);
  const initialCommit = (await git(["-C", repository, "rev-parse", "HEAD"])).trim();
  return {
    root,
    checkout,
    runtime,
    database: join(runtime, "worktrees.sqlite3"),
    repository,
    managedRoot,
    initialCommit,
  };
}

async function git(arguments_: readonly string[]): Promise<string> {
  const result = await run("git", [...arguments_], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}
