import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildGitChildEnvironment,
  type GitCommandRunner,
  ManagedGitWorktreeError,
  ManagedGitWorktreeManager,
  SpawnGitCommandRunner,
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
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "NUL",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PAGER: "",
  });
  assert.deepEqual(buildGitChildEnvironment("linux", ambient), {
    PATH: "/safe/bin",
    TMPDIR: "/safe/tmpdir",
    TEMP: "C:\\safe\\temp",
    TMP: "C:\\safe\\tmp",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PAGER: "",
  });
  assert.deepEqual(buildGitChildEnvironment("darwin", ambient), {
    PATH: "/safe/bin",
    TMPDIR: "/safe/tmpdir",
    TEMP: "C:\\safe\\temp",
    TMP: "C:\\safe\\tmp",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PAGER: "",
  });
});

test("the production Git runner rejects commands outside the managed worktree grammar", async () => {
  const runner = new SpawnGitCommandRunner();
  await assert.rejects(
    runner.run({
      arguments: [
        "-C",
        process.cwd(),
        "ls-remote",
        "--upload-pack=malicious-helper",
        "https://example.invalid/repository.git",
      ],
      timeoutMs: 1_000,
    }),
    (error: unknown) =>
      error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_COMMAND_FAILED",
  );
});

test("managed Git disables repository fsmonitor and post-checkout executables", async (t) => {
  const fixture = await gitFixture();
  const marker = join(fixture.root, "git-execution-marker.txt");
  const fsmonitor = join(fixture.root, "hostile-fsmonitor");
  const hooks = join(fixture.root, "hostile-hooks");
  await mkdir(hooks);
  await Promise.all([
    writeMarkerExecutable(fsmonitor, marker, "fsmonitor"),
    writeMarkerExecutable(join(hooks, "post-checkout"), marker, "post-checkout"),
  ]);
  await git(["-C", fixture.repository, "config", "core.fsmonitor", portablePath(fsmonitor)]);
  await git(["-C", fixture.repository, "config", "core.hooksPath", portablePath(hooks)]);

  const manager = createManager(fixture);
  t.after(async () => {
    manager.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const created = await manager.create({
    worktreeId: "hostile-hooks",
    workspaceId: "workspace-repository",
    repositoryRoot: fixture.repository,
  });
  await manager.inspect(created.worktreeId);
  await assertMissing(marker);
});

test("managed Git rejects repository checkout filters before an external process can start", async (t) => {
  for (const filterKind of ["smudge", "process"] as const) {
    await t.test(filterKind, async () => {
      const fixture = await gitFixture();
      const marker = join(fixture.root, `${filterKind}-execution-marker.txt`);
      const executable = join(fixture.root, `hostile-${filterKind}`);
      await writeMarkerExecutable(executable, marker, filterKind);
      await writeFile(
        join(fixture.repository, ".gitattributes"),
        "README.md filter=opendelegate-hostile\n",
        "utf8",
      );
      await git(["-C", fixture.repository, "add", "--", ".gitattributes"]);
      await git(["-C", fixture.repository, "commit", "-m", `add ${filterKind} attributes`]);
      await git([
        "-C",
        fixture.repository,
        "config",
        `filter.opendelegate-hostile.${filterKind}`,
        portablePath(executable),
      ]);

      const manager = createManager(fixture);
      try {
        await assert.rejects(
          manager.create({
            worktreeId: `hostile-${filterKind}`,
            workspaceId: "workspace-repository",
            repositoryRoot: fixture.repository,
          }),
          (error: unknown) =>
            error instanceof ManagedGitWorktreeError &&
            error.code === "WORKTREE_REPOSITORY_INVALID",
        );
        await assertMissing(marker);
      } finally {
        manager.close();
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("managed Git rejects a filter enabled only for the future linked worktree", async (t) => {
  const fixture = await gitFixture();
  const worktreeId = "target-only-filter";
  const worktreePath = join(fixture.managedRoot, worktreeId);
  const marker = join(fixture.root, "target-only-filter-execution-marker.txt");
  const executable = join(fixture.root, "hostile-target-only-filter");
  const includedConfiguration = join(fixture.root, "target-only-filter.gitconfig");
  await writeMarkerExecutable(executable, marker, "target-only-filter");
  await writeFile(
    join(fixture.repository, ".gitattributes"),
    "README.md filter=opendelegate-target-only\n",
    "utf8",
  );
  await git(["-C", fixture.repository, "add", "--", ".gitattributes"]);
  await git(["-C", fixture.repository, "commit", "-m", "add target-only filter attributes"]);
  await writeFile(
    includedConfiguration,
    ['[filter "opendelegate-target-only"]', `\tsmudge = ${portablePath(executable)}`, ""].join(
      "\n",
    ),
    "utf8",
  );
  await git([
    "-C",
    fixture.repository,
    "config",
    `includeIf.gitdir:**/worktrees/${worktreeId}.path`,
    portablePath(includedConfiguration),
  ]);

  const manager = createManager(fixture);
  t.after(async () => {
    manager.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      manager.create({
        worktreeId,
        workspaceId: "workspace-repository",
        repositoryRoot: fixture.repository,
      }),
      (error: unknown) => error instanceof ManagedGitWorktreeError,
    );
    await access(worktreePath);
    await assertMissing(marker);
    await assert.rejects(
      manager.inspect(worktreeId),
      (error: unknown) =>
        error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_NOT_FOUND",
    );
  }
});

test("creating recovery materializes an existing no-checkout worktree before activation", async (t) => {
  const fixture = await gitFixture();
  const productionRunner = new SpawnGitCommandRunner();
  let failedBeforeMaterialization = false;
  const interruptingRunner: GitCommandRunner = {
    async run(request) {
      if (!failedBeforeMaterialization && request.arguments[2] === "reset") {
        failedBeforeMaterialization = true;
        throw new Error("Simulated interruption before materialization.");
      }
      return productionRunner.run(request);
    },
  };
  const interrupted = createManager(fixture, interruptingRunner);
  const openManagers = [interrupted];
  t.after(async () => {
    for (const manager of openManagers) {
      manager.close();
    }
    await rm(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    interrupted.create({
      worktreeId: "recover-no-checkout",
      workspaceId: "workspace-repository",
      repositoryRoot: fixture.repository,
    }),
    (error: unknown) =>
      error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_COMMAND_FAILED",
  );
  assert.equal(failedBeforeMaterialization, true);
  const worktreePath = join(fixture.managedRoot, "recover-no-checkout");
  await access(worktreePath);
  await assertMissing(join(worktreePath, "README.md"));
  await assert.rejects(
    interrupted.inspect("recover-no-checkout"),
    (error: unknown) =>
      error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_NOT_FOUND",
  );
  interrupted.close();

  const recoveredManager = createManager(fixture);
  openManagers.push(recoveredManager);
  const recovered = await recoveredManager.create({
    worktreeId: "recover-no-checkout",
    workspaceId: "workspace-repository",
    repositoryRoot: fixture.repository,
  });
  assert.equal(recovered.state, "active");
  assert.equal(recovered.revision, 2);
  assert.equal(await readFile(join(worktreePath, "README.md"), "utf8"), "initial\n");
  assert.equal((await recoveredManager.inspect(recovered.worktreeId)).hasUncommittedChanges, false);
});

test("managed Git ignores executable filters from ambient system and global configuration", async (t) => {
  const fixture = await gitFixture();
  const marker = join(fixture.root, "ambient-filter-execution-marker.txt");
  const executable = join(fixture.root, "hostile-ambient-filter");
  const ambientConfiguration = join(fixture.root, "hostile-ambient.gitconfig");
  await writeMarkerExecutable(executable, marker, "ambient-filter");
  await writeFile(
    join(fixture.repository, ".gitattributes"),
    "README.md filter=opendelegate-ambient-hostile\n",
    "utf8",
  );
  await git(["-C", fixture.repository, "add", "--", ".gitattributes"]);
  await git(["-C", fixture.repository, "commit", "-m", "add ambient filter attributes"]);
  await writeFile(
    ambientConfiguration,
    [
      '[filter "opendelegate-ambient-hostile"]',
      `\tsmudge = ${portablePath(executable)}`,
      `\tprocess = ${portablePath(executable)}`,
      "",
    ].join("\n"),
    "utf8",
  );

  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousSystem = process.env.GIT_CONFIG_SYSTEM;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = ambientConfiguration;
  process.env.GIT_CONFIG_SYSTEM = ambientConfiguration;
  process.env.GIT_CONFIG_NOSYSTEM = "0";

  const manager = createManager(fixture);
  t.after(async () => {
    manager.close();
    restoreEnvironmentVariable("GIT_CONFIG_GLOBAL", previousGlobal);
    restoreEnvironmentVariable("GIT_CONFIG_SYSTEM", previousSystem);
    restoreEnvironmentVariable("GIT_CONFIG_NOSYSTEM", previousNoSystem);
    await rm(fixture.root, { recursive: true, force: true });
  });

  const created = await manager.create({
    worktreeId: "ambient-filters",
    workspaceId: "workspace-repository",
    repositoryRoot: fixture.repository,
  });
  await manager.inspect(created.worktreeId);
  await assertMissing(marker);
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

function createManager(
  fixture: GitFixture,
  commandRunner?: GitCommandRunner,
): ManagedGitWorktreeManager {
  return new ManagedGitWorktreeManager({
    filename: fixture.database,
    managedRootDirectory: fixture.managedRoot,
    sourceCheckoutDirectory: fixture.checkout,
    ...(commandRunner === undefined ? {} : { commandRunner }),
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

async function writeMarkerExecutable(
  filename: string,
  marker: string,
  label: string,
): Promise<void> {
  await writeFile(
    filename,
    `#!/bin/sh\nprintf '%s\\n' ${shellQuote(label)} >> ${shellQuote(portablePath(marker))}\nexit 1\n`,
    {
      encoding: "utf8",
      mode: 0o755,
    },
  );
  await chmod(filename, 0o755);
}

function portablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(
    access(path),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
