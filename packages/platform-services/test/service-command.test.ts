import assert from "node:assert/strict";
import test from "node:test";

import {
  ServiceCommandExecutionError,
  createServicePlan,
  createServicePlanRunner,
  executeIdempotentServicePlan,
  servicePlanFingerprint,
  type ServiceCommandClaim,
  type ServiceCommandJournal,
  type ServiceCommandJournalEntry,
  type ServicePlanExecutionReport,
  type ServicePlanRunner,
} from "../src/index.ts";
import { linuxConfiguration, windowsConfiguration } from "./fixtures.ts";

class MemoryJournal implements ServiceCommandJournal {
  readonly entries = new Map<string, ServiceCommandJournalEntry>();

  async claim(entry: ServiceCommandJournalEntry): Promise<ServiceCommandClaim> {
    const existing = this.entries.get(entry.commandId);
    if (existing !== undefined) {
      return existing.report === undefined
        ? {
            disposition: "in-progress",
            planFingerprint: existing.planFingerprint,
          }
        : {
            disposition: "completed",
            planFingerprint: existing.planFingerprint,
            report: existing.report,
          };
    }
    this.entries.set(entry.commandId, entry);
    return { disposition: "claimed" };
  }

  async complete(
    entry: ServiceCommandJournalEntry & {
      readonly report: ServicePlanExecutionReport;
    },
  ): Promise<void> {
    const existing = this.entries.get(entry.commandId);
    assert.equal(existing?.planFingerprint, entry.planFingerprint);
    this.entries.set(entry.commandId, entry);
  }
}

test("an exact completed service command replay returns its durable report without mutation", async () => {
  const plan = createServicePlan({
    operation: "start",
    configuration: windowsConfiguration(),
    activeVersion: "1.2.3",
  });
  const journal = new MemoryJournal();
  let executions = 0;
  const runner: ServicePlanRunner = {
    async execute(inputPlan) {
      executions += 1;
      return successfulReport(inputPlan);
    },
  };

  const first = await executeIdempotentServicePlan({
    commandId: "service-start-0001",
    plan,
    journal,
    runner,
  });
  const replay = await executeIdempotentServicePlan({
    commandId: "service-start-0001",
    plan,
    journal,
    runner,
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.report, first.report);
  assert.equal(executions, 1);
});

test("service plan fingerprints are independent of JavaScript property insertion order", () => {
  const plan = createServicePlan({
    operation: "stop",
    configuration: windowsConfiguration(),
    activeVersion: "1.2.3",
  });
  const reordered = {
    notes: plan.notes,
    steps: plan.steps,
    requiresElevation: plan.requiresElevation,
    toVersion: plan.toVersion,
    fromVersion: plan.fromVersion,
    instanceId: plan.instanceId,
    platform: plan.platform,
    operation: plan.operation,
    schemaVersion: plan.schemaVersion,
  } as typeof plan;

  assert.equal(servicePlanFingerprint(reordered), servicePlanFingerprint(plan));
});

test("a reused command ID with different intent and an in-progress command both fail closed", async () => {
  const start = createServicePlan({
    operation: "start",
    configuration: windowsConfiguration(),
    activeVersion: "1.2.3",
  });
  const stop = createServicePlan({
    operation: "stop",
    configuration: windowsConfiguration(),
    activeVersion: "1.2.3",
  });
  const journal = new MemoryJournal();
  journal.entries.set("service-conflict-0001", {
    commandId: "service-conflict-0001",
    planFingerprint: servicePlanFingerprint(start),
    operation: start.operation,
    platform: start.platform,
    instanceId: start.instanceId,
  });
  let executions = 0;
  const runner: ServicePlanRunner = {
    async execute(inputPlan) {
      executions += 1;
      return successfulReport(inputPlan);
    },
  };

  await assert.rejects(
    executeIdempotentServicePlan({
      commandId: "service-conflict-0001",
      plan: stop,
      journal,
      runner,
    }),
    (error: unknown) =>
      error instanceof ServiceCommandExecutionError &&
      error.code === "SERVICE_COMMAND_CONFLICT" &&
      error.mutationMayHaveOccurred === false,
  );
  await assert.rejects(
    executeIdempotentServicePlan({
      commandId: "service-conflict-0001",
      plan: start,
      journal,
      runner,
    }),
    (error: unknown) =>
      error instanceof ServiceCommandExecutionError &&
      error.code === "SERVICE_COMMAND_IN_PROGRESS" &&
      error.mutationMayHaveOccurred,
  );
  assert.equal(executions, 0);
});

test("the plan runner routes structured actions through injected filesystem and supervisor adapters", async () => {
  const plan = createServicePlan({
    operation: "install",
    configuration: linuxConfiguration(),
  });
  const filesystemKinds: string[] = [];
  const accountKinds: string[] = [];
  const supervisorPlanes: string[] = [];
  const healthPlanes: string[] = [];
  const actionIds = new Set<string>();
  const runner = createServicePlanRunner({
    filesystem: {
      async perform(action, context) {
        filesystemKinds.push(action.kind);
        actionIds.add(context.actionId);
      },
    },
    accounts: {
      async perform(action, context) {
        accountKinds.push(action.kind);
        actionIds.add(context.actionId);
      },
    },
    supervisor: {
      async perform(operation, context) {
        supervisorPlanes.push(operation.plane);
        actionIds.add(context.actionId);
      },
    },
    health: {
      async perform(action, context) {
        healthPlanes.push(action.plane);
        actionIds.add(context.actionId);
      },
    },
  });

  const report = await runner.execute(plan, {
    commandId: "service-install-0001",
    planFingerprint: servicePlanFingerprint(plan),
  });

  assert.equal(report.outcome, "succeeded");
  assert.ok(filesystemKinds.includes("release.stage"));
  assert.ok(filesystemKinds.includes("file.write"));
  assert.deepEqual(accountKinds, ["account.ensure"]);
  assert.ok(supervisorPlanes.includes("core"));
  assert.ok(supervisorPlanes.includes("session-helper"));
  assert.deepEqual(healthPlanes, ["core", "session-helper"]);
  assert.equal(actionIds.size, report.completedStepIds.length);
});

function successfulReport(
  plan: Parameters<ServicePlanRunner["execute"]>[0],
): ServicePlanExecutionReport {
  return {
    outcome: "succeeded",
    operation: plan.operation,
    platform: plan.platform,
    instanceId: plan.instanceId,
    completedStepIds: plan.steps.map((step) => step.id),
    unchangedStepIds: [],
    rollback: {
      attempted: false,
      completedStepIds: [],
      failures: [],
    },
    diagnostic: {
      eventName: "platform.service.operation.succeeded",
      summary: `${plan.operation} completed and all required health checks passed.`,
    },
  };
}
