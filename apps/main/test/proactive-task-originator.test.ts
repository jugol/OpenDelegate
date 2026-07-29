import assert from "node:assert/strict";
import test from "node:test";

import {
  MainProactiveTaskOriginator,
  type MainProactiveTaskOriginatorInput,
} from "../src/proactive-task-originator.ts";

test("deterministic monitor signals become ordinary manual or automatic Tasks by authority", async () => {
  const created: unknown[] = [];
  const presented: string[] = [];
  const originator = new MainProactiveTaskOriginator({
    policy: {
      async proactiveDisposition(kind) {
        return kind === "cleanup"
          ? "disabled"
          : kind === "incident-recovery"
            ? "execute"
            : "propose";
      },
    },
    tasks: {
      async create(input) {
        created.push(input);
        return { taskId: `task_${created.length}`, mode: input.mode ?? "manual" };
      },
    },
    presentation: {
      async present(taskId) {
        presented.push(taskId);
      },
    },
  });

  const incident = await originator.originate(signal("incident-recovery", "route-incident-001"));
  const improvement = await originator.originate(
    signal("general-improvement", "repository-watch-001"),
  );
  const cleanup = await originator.originate(signal("cleanup", "cleanup-watch-001"));

  assert.deepEqual(incident, {
    disposition: "executing",
    taskId: "task_1",
    mode: "auto",
  });
  assert.deepEqual(improvement, {
    disposition: "proposed",
    taskId: "task_2",
    mode: "manual",
  });
  assert.deepEqual(cleanup, { disposition: "disabled" });
  assert.deepEqual(
    created.map((entry) => (entry as { readonly mode: string }).mode),
    ["auto", "manual"],
  );
  assert.deepEqual(presented, ["task_1", "task_2"]);
  assert.match(
    (created[0] as { readonly idempotencyKey: string }).idempotencyKey,
    /^proactive:[a-f0-9]{64}$/u,
  );
});

test("the same monitor occurrence reuses one stable Task idempotency key", async () => {
  const keys: string[] = [];
  const originator = new MainProactiveTaskOriginator({
    policy: {
      async proactiveDisposition() {
        return "execute";
      },
    },
    tasks: {
      async create(input) {
        keys.push(input.idempotencyKey);
        return { taskId: "task_stable", mode: input.mode ?? "manual" };
      },
    },
  });
  const input = signal("maintenance", "monitor-occurrence-001");

  await originator.originate(input);
  await originator.originate(input);

  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

function signal(
  kind: MainProactiveTaskOriginatorInput["kind"],
  signalId: string,
): MainProactiveTaskOriginatorInput {
  return {
    signalId,
    kind,
    deviceId: "device_worker",
    objective: `Handle ${kind}.`,
    completionCriteria: ["The monitored condition is resolved and verified."],
    constraints: ["Do not weaken Action Policy."],
    selectedInputRefs: [],
    source: {
      kind: "deterministic-monitor",
      reference: `monitor:${signalId}`,
    },
  };
}
