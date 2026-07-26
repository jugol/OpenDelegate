import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  assertPinnedReleaseGitFilesMatchCommit,
  pinReleaseGitProvenance,
  readPinnedReleaseSourceIdentity,
  revalidatePinnedReleaseGitProvenance,
  runPinnedReleaseGit,
} from "../release-git-provenance.mjs";
import { hashStableRegularFile } from "../release-tooling-io.mjs";

const execFile = promisify(execFileCallback);
const fullCommitPattern = /^[0-9a-f]{40}$/u;

test("pinned Git provenance ignores ambient repository and PATH overrides", async (t) => {
  const fixture = await createGitFixture(t);
  const other = await createRepository(fixture.root, "other", "other\n");
  const original = snapshotEnvironment([
    "GIT_CONFIG_GLOBAL",
    "GIT_DIR",
    "GIT_EXEC_PATH",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
    "PATH",
  ]);
  const fakeBin = join(fixture.root, "fake-bin");
  await mkdir(fakeBin);
  process.env.GIT_CONFIG_GLOBAL = join(fixture.root, "attacker.gitconfig");
  process.env.GIT_DIR = join(other.repositoryRoot, ".git");
  process.env.GIT_EXEC_PATH = fakeBin;
  process.env.GIT_OBJECT_DIRECTORY = join(other.repositoryRoot, ".git", "objects");
  process.env.GIT_WORK_TREE = other.repositoryRoot;
  process.env.PATH = fakeBin;
  t.after(() => restoreEnvironment(original));

  const handle = await pinReleaseGitProvenance({
    expectedExecutableSha256: fixture.gitSha256,
    executablePath: fixture.gitExecutable,
    repositoryRoot: fixture.repository.repositoryRoot,
  });

  assert.equal(handle.description.gitExecutableSha256, fixture.gitSha256);
  assert.equal(handle.description.source.commit, fixture.repository.commit);
  assert.equal(handle.description.source.dirty, false);
  assert.equal((await readPinnedReleaseSourceIdentity(handle)).commit, fixture.repository.commit);
});

test("pinned Git commands use one absolute executable, an explicit checkout, and a minimal environment", async (t) => {
  const fixture = await createGitFixture(t);
  const calls = [];
  const execute = async (input) => {
    calls.push(input);
    const commandIndex = input.arguments.findIndex((argument) =>
      ["rev-parse", "show", "status"].includes(argument),
    );
    const command = input.arguments[commandIndex];
    if (command === "rev-parse") {
      return { stdout: Buffer.from(`${fixture.repository.commit}\n`), stderr: Buffer.alloc(0) };
    }
    if (command === "status") {
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    return { stdout: Buffer.from("1700000000\n"), stderr: Buffer.alloc(0) };
  };

  const handle = await pinReleaseGitProvenance(
    {
      expectedExecutableSha256: fixture.gitSha256,
      executablePath: fixture.gitExecutable,
      repositoryRoot: fixture.repository.repositoryRoot,
    },
    { execute },
  );
  await revalidatePinnedReleaseGitProvenance(handle);

  assert.ok(calls.length >= 6);
  for (const call of calls) {
    assert.equal(call.executable, fixture.gitExecutable);
    assert.ok(
      call.arguments.includes(`--git-dir=${join(fixture.repository.repositoryRoot, ".git")}`),
    );
    assert.ok(call.arguments.includes(`--work-tree=${fixture.repository.repositoryRoot}`));
    assert.equal(call.environment.PATH, "");
    assert.equal(call.environment.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(call.environment.GIT_NO_REPLACE_OBJECTS, "1");
    assert.equal(call.environment.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(call.environment.GIT_TERMINAL_PROMPT, "0");
    for (const attackerControlledName of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_EXEC_PATH",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      assert.equal(Object.hasOwn(call.environment, attackerControlledName), false);
    }
    assert.deepEqual(Object.keys(call.environment).sort(), [
      "GIT_ATTR_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_SYSTEM",
      "GIT_FLUSH",
      "GIT_LITERAL_PATHSPECS",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OPTIONAL_LOCKS",
      "GIT_PAGER",
      "GIT_TERMINAL_PROMPT",
      "LANG",
      "LC_ALL",
      "PATH",
    ]);
  }
});

test("pinned Git provenance supports an explicitly bound linked worktree", async (t) => {
  const fixture = await createGitFixture(t);
  const worktree = join(fixture.root, "linked-worktree");
  await execFile(
    fixture.gitExecutable,
    ["-C", fixture.repository.repositoryRoot, "worktree", "add", "--detach", worktree, "HEAD"],
    { windowsHide: true },
  );

  const handle = await pinReleaseGitProvenance({
    expectedExecutableSha256: fixture.gitSha256,
    executablePath: fixture.gitExecutable,
    repositoryRoot: worktree,
  });

  assert.equal(handle.description.source.commit, fixture.repository.commit);
  assert.equal(handle.description.source.dirty, false);
  await revalidatePinnedReleaseGitProvenance(handle);
});

test("pinned Git provenance rejects linked executable and repository ancestors", async (t) => {
  const fixture = await createGitFixture(t);
  const executableDirectory = join(fixture.root, "git-real");
  const executableAliasDirectory = join(fixture.root, "git-alias");
  await mkdir(executableDirectory);
  const fakeExecutable = join(
    executableDirectory,
    process.platform === "win32" ? "git.exe" : "git",
  );
  await writeFile(fakeExecutable, "not executable\n", "utf8");
  await createDirectoryLink(executableDirectory, executableAliasDirectory);
  const executableAlias = join(
    executableAliasDirectory,
    process.platform === "win32" ? "git.exe" : "git",
  );
  const executableSha256 = (await hashStableRegularFile(fakeExecutable)).sha256;

  await assert.rejects(
    pinReleaseGitProvenance(
      {
        expectedExecutableSha256: executableSha256,
        executablePath: executableAlias,
        repositoryRoot: fixture.repository.repositoryRoot,
      },
      { execute: async () => assert.fail("linked executables must fail before invocation") },
    ),
    /linked|symbolic|junction/iu,
  );

  const repositoryAlias = join(fixture.root, "repository-alias");
  await createDirectoryLink(fixture.repository.repositoryRoot, repositoryAlias);
  await assert.rejects(
    pinReleaseGitProvenance({
      expectedExecutableSha256: fixture.gitSha256,
      executablePath: fixture.gitExecutable,
      repositoryRoot: repositoryAlias,
    }),
    /linked|symbolic|junction/iu,
  );
});

test("pinned Git provenance detects executable and checkout changes", async (t) => {
  const fixture = await createGitFixture(t);
  const copiedGit = join(
    fixture.root,
    process.platform === "win32" ? "pinned-git.exe" : "pinned-git",
  );
  await copyFile(fixture.gitExecutable, copiedGit);
  const copiedGitSha256 = (await hashStableRegularFile(copiedGit)).sha256;
  const execute = async (input) => {
    const command = input.arguments.find((argument) =>
      ["rev-parse", "show", "status"].includes(argument),
    );
    return command === "status"
      ? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      : {
          stdout: Buffer.from(
            command === "show" ? "1700000000\n" : `${fixture.repository.commit}\n`,
          ),
          stderr: Buffer.alloc(0),
        };
  };
  const handle = await pinReleaseGitProvenance(
    {
      expectedExecutableSha256: copiedGitSha256,
      executablePath: copiedGit,
      repositoryRoot: fixture.repository.repositoryRoot,
    },
    { execute },
  );
  await writeFile(copiedGit, "changed executable\n", "utf8");
  await assert.rejects(
    revalidatePinnedReleaseGitProvenance(handle),
    /Git executable.*SHA-256|changed/iu,
  );

  const fresh = await pinReleaseGitProvenance({
    expectedExecutableSha256: fixture.gitSha256,
    executablePath: fixture.gitExecutable,
    repositoryRoot: fixture.repository.repositoryRoot,
  });
  await writeFile(join(fixture.repository.repositoryRoot, "next.txt"), "next\n", "utf8");
  await commitAll(fixture.gitExecutable, fixture.repository.repositoryRoot, "next");
  await assert.rejects(
    revalidatePinnedReleaseGitProvenance(fresh),
    /source identity changed|checkout changed/iu,
  );
});

test("critical release files are compared to commit blobs even when Git status is fooled", async (t) => {
  const fixture = await createGitFixture(t);
  const criticalPath = join(fixture.repository.repositoryRoot, "critical.mjs");
  await writeFile(criticalPath, "export const trusted = true;\n", "utf8");
  await commitAll(fixture.gitExecutable, fixture.repository.repositoryRoot, "critical");
  const handle = await pinReleaseGitProvenance({
    expectedExecutableSha256: fixture.gitSha256,
    executablePath: fixture.gitExecutable,
    repositoryRoot: fixture.repository.repositoryRoot,
  });
  await assertPinnedReleaseGitFilesMatchCommit(handle, ["critical.mjs"]);

  await execFile(
    fixture.gitExecutable,
    ["-C", fixture.repository.repositoryRoot, "update-index", "--assume-unchanged", "critical.mjs"],
    { windowsHide: true },
  );
  await writeFile(criticalPath, "export const trusted = false;\n", "utf8");
  assert.equal((await readPinnedReleaseSourceIdentity(handle)).dirty, false);
  await assert.rejects(
    assertPinnedReleaseGitFilesMatchCommit(handle, ["critical.mjs"]),
    /does not match.*commit|critical\.mjs/iu,
  );
});

test("pinned Git drains a complete large binary blob before resolving", async (t) => {
  const fixture = await createGitFixture(t);
  const largeBytes = Buffer.alloc(4 * 1024 * 1024);
  for (let index = 0; index < largeBytes.byteLength; index += 1) {
    largeBytes[index] = index % 251;
  }
  await writeFile(join(fixture.repository.repositoryRoot, "large.bin"), largeBytes);
  await commitAll(fixture.gitExecutable, fixture.repository.repositoryRoot, "large blob");
  const handle = await pinReleaseGitProvenance({
    expectedExecutableSha256: fixture.gitSha256,
    executablePath: fixture.gitExecutable,
    repositoryRoot: fixture.repository.repositoryRoot,
  });

  const result = await runPinnedReleaseGit(
    handle,
    ["cat-file", "blob", `${handle.description.source.commit}:large.bin`],
    { encoding: null, maximumOutputBytes: 8 * 1024 * 1024 },
  );
  assert.equal(result.stdout.byteLength, largeBytes.byteLength);
  assert.equal(
    createHash("sha256").update(result.stdout).digest("hex"),
    createHash("sha256").update(largeBytes).digest("hex"),
  );
});

async function createGitFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-git-provenance-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const gitExecutable = await locateGitExecutable();
  const gitSha256 = (await hashStableRegularFile(gitExecutable)).sha256;
  const repository = await createRepository(root, "repository", "initial\n");
  return { gitExecutable, gitSha256, repository, root };
}

async function locateGitExecutable() {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const { stdout } = await execFile(locator, ["git"], { windowsHide: true });
  const candidate = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value !== "");
  assert.ok(candidate, "Git must be available for release-provenance tests.");
  return realpath(candidate);
}

async function createRepository(root, name, contents) {
  const repositoryRoot = join(root, name);
  await mkdir(repositoryRoot);
  const gitExecutable = await locateGitExecutable();
  await execFile(gitExecutable, ["init", "--quiet", repositoryRoot], { windowsHide: true });
  await writeFile(join(repositoryRoot, ".gitattributes"), "* text=auto eol=lf\n", "utf8");
  await writeFile(join(repositoryRoot, "tracked.txt"), contents, "utf8");
  await commitAll(gitExecutable, repositoryRoot, "initial");
  const { stdout } = await execFile(
    gitExecutable,
    ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD"],
    { windowsHide: true },
  );
  const commit = stdout.trim();
  assert.match(commit, fullCommitPattern);
  return { commit, repositoryRoot };
}

async function commitAll(gitExecutable, repositoryRoot, message) {
  await execFile(gitExecutable, ["-C", repositoryRoot, "add", "--all"], { windowsHide: true });
  await execFile(
    gitExecutable,
    [
      "-C",
      repositoryRoot,
      "-c",
      "user.name=OpenDelegate Test",
      "-c",
      "user.email=release-test@invalid.example",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      message,
    ],
    { windowsHide: true },
  );
}

async function createDirectoryLink(target, path) {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

function snapshotEnvironment(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
