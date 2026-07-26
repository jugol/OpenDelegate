import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { runProjectTests } from "../run-project-tests.mjs";

test("project tests inherit one canonical physical temp root", async () => {
  for (const fixture of [
    {
      canonical: "/private/tmp",
      lexical: "/var/folders/opendelegate",
      platform: "darwin",
      selected: "/tmp",
    },
    {
      canonical: "C:\\Users\\runneradmin\\AppData\\Local\\Temp",
      lexical: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp",
      platform: "win32",
      selected: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp",
    },
  ]) {
    const invocations = [];
    const exitCode = await runProjectTests({
      environment: {
        PATH: "fixture-path",
        TEMP: fixture.lexical,
        TMP: fixture.lexical,
        TMPDIR: fixture.lexical,
      },
      executablePath: "/fixture/node",
      packageManagerPath: "/fixture/pnpm.cjs",
      platform: fixture.platform,
      realPath: async (path) => {
        assert.equal(path, fixture.selected);
        return fixture.canonical;
      },
      repositoryRoot: "/fixture/repository",
      spawnChild(executable, arguments_, options) {
        invocations.push({ arguments_, executable, options });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
      ...(fixture.platform === "win32" ? { temporaryDirectory: () => fixture.lexical } : {}),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(
      invocations.map(({ arguments_ }) => arguments_),
      fixture.platform === "win32"
        ? [
            ["/fixture/pnpm.cjs", "run", "test:tooling"],
            [
              "/fixture/pnpm.cjs",
              "--recursive",
              "--filter",
              "!@opendelegate/main",
              "--workspace-concurrency=2",
              "--if-present",
              "run",
              "test",
            ],
            ["/fixture/pnpm.cjs", "--filter", "@opendelegate/main", "run", "test:serial"],
          ]
        : [
            ["/fixture/pnpm.cjs", "run", "test:tooling"],
            ["/fixture/pnpm.cjs", "--recursive", "--if-present", "run", "test"],
          ],
    );
    for (const invocation of invocations) {
      assert.equal(invocation.executable, "/fixture/node");
      assert.equal(invocation.options.cwd, "/fixture/repository");
      assert.equal(invocation.options.env.PATH, "fixture-path");
      assert.equal(invocation.options.env.TEMP, fixture.canonical);
      assert.equal(invocation.options.env.TMP, fixture.canonical);
      assert.equal(invocation.options.env.TMPDIR, fixture.canonical);
    }
  }
});

test("project tests stop after the first failing command", async () => {
  let invocations = 0;
  const exitCode = await runProjectTests({
    environment: {},
    executablePath: "/fixture/node",
    packageManagerPath: "/fixture/pnpm.cjs",
    platform: "linux",
    realPath: async () => "/tmp",
    repositoryRoot: "/fixture/repository",
    spawnChild() {
      invocations += 1;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 7, null));
      return child;
    },
    temporaryDirectory: () => "/tmp",
  });

  assert.equal(exitCode, 7);
  assert.equal(invocations, 1);
});
