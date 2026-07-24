import assert from "node:assert/strict";
import test from "node:test";

import {
  SupervisorInvocationError,
  createServicePlan,
  executeSupervisorOperation,
  type CommandInvocation,
  type SupervisorSubprocessRunner,
} from "../src/index.ts";
import { macOsConfiguration, windowsConfiguration } from "./fixtures.ts";

test("an injected runner executes argv directly and honors declared exit codes", async () => {
  const plan = createServicePlan({
    operation: "install",
    configuration: windowsConfiguration(),
  });
  const operation = plan.steps.find(
    (step) =>
      step.action.kind === "supervisor.invoke" &&
      step.action.command.plane === "core" &&
      step.action.command.verb === "install",
  );
  assert.ok(operation);
  assert.equal(operation.action.kind, "supervisor.invoke");
  const seen: CommandInvocation[] = [];
  const runner: SupervisorSubprocessRunner = {
    async run(invocation) {
      seen.push(invocation);
      return {
        exitCode: invocation.arguments.includes("create") ? 1073 : 0,
      };
    },
  };
  const result = await executeSupervisorOperation(operation.action.command, runner, {
    async isLoggedIn() {
      return true;
    },
  });
  assert.equal(result.disposition, "completed");
  assert.equal(result.completedInvocations, operation.action.command.invocations.length);
  assert.equal(
    seen.every((invocation) => invocation.executable === "sc.exe"),
    true,
  );
});

test("a logged-out owner defers only the helper operation without spawning", async () => {
  const plan = createServicePlan({
    operation: "start",
    configuration: macOsConfiguration(),
    activeVersion: "1.2.3",
  });
  const helper = plan.steps.find(
    (step) =>
      step.action.kind === "supervisor.invoke" && step.action.command.plane === "session-helper",
  );
  assert.ok(helper);
  assert.equal(helper.action.kind, "supervisor.invoke");
  let spawned = 0;
  const result = await executeSupervisorOperation(
    helper.action.command,
    {
      async run() {
        spawned += 1;
        return { exitCode: 0 };
      },
    },
    {
      async isLoggedIn() {
        return false;
      },
    },
  );
  assert.equal(result.disposition, "deferred-logged-out");
  assert.equal(spawned, 0);
});

test("unexpected supervisor exit codes fail closed without command output", async () => {
  const plan = createServicePlan({
    operation: "stop",
    configuration: windowsConfiguration(),
    activeVersion: "1.2.3",
  });
  const core = plan.steps.find(
    (step) => step.action.kind === "supervisor.invoke" && step.action.command.plane === "core",
  );
  assert.ok(core);
  assert.equal(core.action.kind, "supervisor.invoke");
  await assert.rejects(
    executeSupervisorOperation(
      core.action.command,
      {
        async run() {
          return { exitCode: 999 };
        },
      },
      {
        async isLoggedIn() {
          return true;
        },
      },
    ),
    (error: unknown) =>
      error instanceof SupervisorInvocationError &&
      error.code === "SUPERVISOR_COMMAND_FAILED" &&
      error.exitCode === 999,
  );
});
