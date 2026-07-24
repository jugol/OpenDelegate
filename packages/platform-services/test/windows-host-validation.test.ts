import assert from "node:assert/strict";
import test from "node:test";

import { validateWindowsHostSupervisor, type ReadOnlyCommandRunner } from "../src/index.ts";

test("Windows host validation runs only allowlisted read-only probes", async () => {
  const invocations: Array<{ executable: string; arguments: readonly string[] }> = [];
  const runner: ReadOnlyCommandRunner = {
    async run(executable, arguments_) {
      invocations.push({ executable, arguments: arguments_ });
      return { exitCode: 0 };
    },
  };

  const report = await validateWindowsHostSupervisor(runner);
  assert.equal(report.safeReadOnly, true);
  assert.equal(
    report.tools.every((tool) => tool.available),
    true,
  );
  assert.deepEqual(
    invocations.map((invocation) => invocation.executable),
    ["where.exe", "where.exe", "sc.exe", "schtasks.exe"],
  );
  assert.deepEqual(invocations[2]?.arguments, ["query", "type=", "service", "state=", "all"]);
  assert.deepEqual(invocations[3]?.arguments, ["/Query", "/FO", "CSV", "/NH"]);
  assert.equal(
    invocations.some((invocation) =>
      invocation.arguments.some((argument) =>
        /create|delete|change|run|start|stop/i.test(argument),
      ),
    ),
    false,
  );
});

test(
  "the real Windows host exposes SCM and Task Scheduler through read-only probes",
  { skip: process.platform !== "win32" },
  async () => {
    const report = await validateWindowsHostSupervisor();
    assert.equal(report.mutationsAttempted, false);
    assert.equal(
      report.tools.every((tool) => tool.available),
      true,
    );
  },
);
