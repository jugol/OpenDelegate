import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test } from "node:test";

import { createCommittedReleaseRunnerTempState } from "../build-release.mjs";
import { runToolingTests } from "../run-tooling-tests.mjs";

test("tooling test children receive the physical temp root on macOS and Windows aliases", async () => {
  for (const fixture of [
    {
      canonical: "/private/var/folders/opendelegate",
      lexical: "/var/folders/opendelegate",
      platform: "darwin",
    },
    {
      canonical: "C:\\Users\\runneradmin\\AppData\\Local\\Temp",
      lexical: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp",
      platform: "win32",
    },
  ]) {
    let invocation;
    const child = new EventEmitter();
    const exitCode = runToolingTests({
      environment: {
        PATH: "fixture-path",
        TEMP: fixture.lexical,
        Temp: "stale-case-variant",
        TMP: fixture.lexical,
        TMPDIR: fixture.lexical,
      },
      executablePath: "/fixture/node",
      platform: fixture.platform,
      realPath: async (path) => {
        assert.equal(path, fixture.lexical);
        return fixture.canonical;
      },
      repositoryRoot: "/fixture/repository",
      spawnChild(executable, arguments_, options) {
        invocation = { arguments_, executable, options };
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
      temporaryDirectory: () => fixture.lexical,
    });

    assert.equal(await exitCode, 0);
    assert.equal(invocation.executable, "/fixture/node");
    assert.deepEqual(invocation.arguments_, [
      "--experimental-strip-types",
      "--test",
      "tooling/test/*.test.mjs",
    ]);
    assert.equal(invocation.options.cwd, "/fixture/repository");
    assert.equal(invocation.options.env.PATH, "fixture-path");
    assert.equal(invocation.options.env.TEMP, fixture.canonical);
    assert.equal(invocation.options.env.TMP, fixture.canonical);
    assert.equal(invocation.options.env.TMPDIR, fixture.canonical);
    if (fixture.platform === "win32") {
      assert.equal(Object.hasOwn(invocation.options.env, "Temp"), false);
    }
  }
});

test("macOS tooling tests use the short physical system temp root by default", async () => {
  let invocation;
  const child = new EventEmitter();
  const exitCode = runToolingTests({
    environment: {
      PATH: "fixture-path",
      TMPDIR: "/var/folders/opendelegate",
    },
    executablePath: "/fixture/node",
    platform: "darwin",
    realPath: async (path) => {
      assert.equal(path, "/tmp");
      return "/private/tmp";
    },
    repositoryRoot: "/fixture/repository",
    spawnChild(executable, arguments_, options) {
      invocation = { arguments_, executable, options };
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  assert.equal(await exitCode, 0);
  assert.equal(invocation.options.env.TEMP, "/private/tmp");
  assert.equal(invocation.options.env.TMP, "/private/tmp");
  assert.equal(invocation.options.env.TMPDIR, "/private/tmp");
});

test("the committed release runner creates and propagates only a physical temp root", async () => {
  const lexical = "/var/folders/opendelegate";
  const canonical = "/private/var/folders/opendelegate";
  let temporaryPrefix;

  const state = await createCommittedReleaseRunnerTempState(
    {
      PATH: "fixture-path",
      TEMP: lexical,
      TMP: lexical,
      TMPDIR: lexical,
    },
    {
      makeTemporaryDirectory: async (prefix) => {
        temporaryPrefix = prefix;
        return `${canonical}/opendelegate-release-runner-fixture`;
      },
      platform: "darwin",
      realPath: async (path) => {
        assert.equal(path, lexical);
        return canonical;
      },
      temporaryDirectory: () => lexical,
    },
  );

  assert.equal(temporaryPrefix, join(canonical, "opendelegate-release-runner-"));
  assert.equal(state.runnerParent, `${canonical}/opendelegate-release-runner-fixture`);
  assert.equal(state.environment.PATH, "fixture-path");
  assert.equal(state.environment.TEMP, canonical);
  assert.equal(state.environment.TMP, canonical);
  assert.equal(state.environment.TMPDIR, canonical);
});
