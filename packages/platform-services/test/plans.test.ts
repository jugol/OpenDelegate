import assert from "node:assert/strict";
import test from "node:test";

import {
  createServicePlan,
  executeServicePlan,
  type PlanAction,
  type PlanExecutionAdapter,
} from "../src/index.ts";
import { linuxConfiguration, macOsConfiguration, windowsConfiguration } from "./fixtures.ts";

class RecordingAdapter implements PlanExecutionAdapter {
  public readonly performed: PlanAction[] = [];
  public readonly rollbackActions: PlanAction[] = [];
  private readonly failingStepKind: PlanAction["kind"] | undefined;

  public constructor(failingStepKind?: PlanAction["kind"]) {
    this.failingStepKind = failingStepKind;
  }

  public async perform(action: PlanAction, phase: "forward" | "rollback"): Promise<void> {
    if (phase === "forward") {
      this.performed.push(action);
      if (action.kind === this.failingStepKind) {
        throw new Error(`Injected ${action.kind} failure`);
      }
      return;
    }
    this.rollbackActions.push(action);
  }
}

test("install/start/stop/restart plans are deterministic and supervise both planes", () => {
  for (const configuration of [
    windowsConfiguration(),
    macOsConfiguration(),
    linuxConfiguration(),
  ]) {
    const install = createServicePlan({
      operation: "install",
      configuration,
    });
    assert.equal(install.operation, "install");
    assert.ok(install.steps.some((step) => step.action.kind === "directory.ensure"));
    const stateDirectory = install.steps.find(
      (step) =>
        step.action.kind === "directory.ensure" &&
        step.action.path === configuration.paths.stateRoot,
    );
    assert.ok(stateDirectory);
    assert.equal(stateDirectory.action.kind, "directory.ensure");
    assert.equal(stateDirectory.action.access.denyUnlisted, true);
    assert.equal(
      stateDirectory.action.access.grants.some(
        (grant) =>
          grant.permission === "full-control" &&
          /Administrators|platform-installer/.test(grant.principal),
      ),
      true,
    );
    const configRootIndex = install.steps.findIndex((step) => step.id === "ensure-config-root");
    const manifestRootIndex = install.steps.findIndex(
      (step) => step.id === "ensure-manifest-root",
    );
    const firstRenderedFileIndex = install.steps.findIndex(
      (step) => step.action.kind === "file.write",
    );
    assert.ok(configRootIndex >= 0 && configRootIndex < firstRenderedFileIndex);
    assert.ok(manifestRootIndex >= 0 && manifestRootIndex < firstRenderedFileIndex);
    assert.ok(install.steps.some((step) => step.action.kind === "release.stage"));
    assert.ok(install.steps.some((step) => step.action.kind === "health.check"));
    assert.ok(
      install.steps.some(
        (step) =>
          step.action.kind === "supervisor.invoke" &&
          step.action.command.plane === "session-helper",
      ),
    );

    const restart = createServicePlan({
      operation: "restart",
      configuration,
      activeVersion: "1.2.3",
    });
    const supervisorVerbs = restart.steps.flatMap((step) =>
      step.action.kind === "supervisor.invoke" ? [step.action.command.verb] : [],
    );
    assert.deepEqual(supervisorVerbs, ["stop", "stop", "start", "start"]);
  }
});

test("Admin preference reconfiguration atomically rewrites runtime state and restarts only the owner helper", async () => {
  const previousConfiguration = linuxConfiguration({ role: "main" });
  const configuration = linuxConfiguration({
    role: "main",
    ownerSession: {
      ...previousConfiguration.ownerSession,
      adminAutoOpen: {
        enabled: true,
        url: "http://127.0.0.1:4380/",
      },
    },
  });
  const plan = createServicePlan({
    operation: "reconfigure",
    configuration,
    previousConfiguration,
    activeVersion: "1.2.3",
  });

  assert.equal(plan.operation, "reconfigure");
  assert.deepEqual(
    plan.steps.flatMap((step) =>
      step.action.kind === "supervisor.invoke"
        ? [`${step.action.command.plane}:${step.action.command.verb}`]
        : [],
    ),
    ["session-helper:stop", "session-helper:start"],
  );
  const update = plan.steps.find((step) => step.id === "update-runtime-configuration");
  assert.equal(update?.action.kind, "file.write");
  assert.equal(update?.rollback?.kind, "file.write");
  if (update?.action.kind === "file.write" && update.rollback?.kind === "file.write") {
    assert.match(update.action.file.content, /"enabled": true/u);
    assert.match(update.action.file.content, /"url": "http:\/\/127\.0\.0\.1:4380\/"/u);
    assert.match(update.rollback.file.content, /"enabled": false/u);
    assert.doesNotMatch(update.rollback.file.content, /"url"/u);
  }

  const rollbackActions: PlanAction[] = [];
  const report = await executeServicePlan(plan, {
    async perform(action, phase) {
      if (phase === "rollback") {
        rollbackActions.push(action);
        return { disposition: "changed" };
      }
      if (action.kind === "health.check") {
        throw new Error("Injected helper health failure");
      }
      return { disposition: "changed" };
    },
  });
  assert.equal(report.outcome, "rolled-back");
  assert.ok(
    rollbackActions.some(
      (action) =>
        action.kind === "file.write" &&
        action.file.purpose === "runtime-configuration" &&
        action.file.content.includes('"enabled": false'),
    ),
  );
});

test("Admin preference reconfiguration rejects every unrelated topology change", () => {
  const previousConfiguration = windowsConfiguration();
  const configuration = windowsConfiguration({
    ownerSession: {
      ...previousConfiguration.ownerSession,
      adminAutoOpen: {
        enabled: true,
        url: "http://127.0.0.1:4380/",
      },
    },
  });
  assert.throws(
    () =>
      createServicePlan({
        operation: "reconfigure",
        configuration,
        previousConfiguration: {
          ...previousConfiguration,
          health: {
            ...previousConfiguration.health,
            timeoutMs: previousConfiguration.health.timeoutMs + 1,
          },
        },
        activeVersion: "1.2.3",
      }),
    /only.*Admin auto-open/i,
  );
});

test("upgrade atomically activates a staged release and rolls back after failed health", async () => {
  const plan = createServicePlan({
    operation: "upgrade",
    configuration: windowsConfiguration({
      bundle: {
        ...windowsConfiguration().bundle,
        version: "1.3.0",
      },
    }),
    activeVersion: "1.2.3",
  });

  const activation = plan.steps.find((step) => step.action.kind === "activation.switch");
  assert.ok(activation);
  assert.equal(activation.action.kind, "activation.switch");
  assert.match(activation.action.targetReleaseDirectory, /1\.3\.0$/);
  assert.equal(activation.rollback?.kind, "activation.switch");
  if (activation.rollback?.kind === "activation.switch") {
    assert.match(activation.rollback.targetReleaseDirectory, /1\.2\.3$/);
  }

  const adapter = new RecordingAdapter("health.check");
  const report = await executeServicePlan(plan, adapter);
  assert.equal(report.outcome, "rolled-back");
  assert.equal(report.failedStepId, "health-core");
  assert.equal(report.rollback.attempted, true);
  assert.ok(
    adapter.rollbackActions.some(
      (action) =>
        action.kind === "activation.switch" && action.targetReleaseDirectory.endsWith("1.2.3"),
    ),
  );
  assert.ok(
    adapter.rollbackActions.some(
      (action) => action.kind === "release.remove" && action.releaseDirectory.endsWith("1.3.0"),
    ),
  );
  assert.match(report.diagnostic.summary, /rolled back/i);
});

test("failed install health removes newly registered supervisor planes", async () => {
  const plan = createServicePlan({
    operation: "install",
    configuration: windowsConfiguration(),
  });
  const adapter = new RecordingAdapter("health.check");

  const report = await executeServicePlan(plan, adapter);

  assert.equal(report.outcome, "rolled-back");
  const removedPlanes = adapter.rollbackActions.flatMap((action) =>
    action.kind === "supervisor.invoke" && action.command.verb === "remove"
      ? [action.command.plane]
      : [],
  );
  assert.deepEqual(removedPlanes, ["session-helper", "core"]);
});

test("rollback never removes supervisor registrations reported as pre-existing", async () => {
  const plan = createServicePlan({
    operation: "install",
    configuration: windowsConfiguration(),
  });
  const rollbackActions: PlanAction[] = [];
  const report = await executeServicePlan(plan, {
    async perform(action, phase) {
      if (phase === "rollback") {
        rollbackActions.push(action);
        return { disposition: "changed" };
      }
      if (action.kind === "health.check") {
        throw new Error("Injected health failure");
      }
      if (action.kind === "supervisor.invoke" && action.command.verb === "install") {
        return { disposition: "unchanged" };
      }
      return { disposition: "changed" };
    },
  });

  assert.equal(report.outcome, "rolled-back");
  assert.ok(report.unchangedStepIds.includes("install-core"));
  assert.ok(report.unchangedStepIds.includes("install-helper"));
  assert.equal(
    rollbackActions.some(
      (action) => action.kind === "supervisor.invoke" && action.command.verb === "remove",
    ),
    false,
  );
});

test("a rollback failure remains explicit and never reports success", async () => {
  const plan = createServicePlan({
    operation: "upgrade",
    configuration: linuxConfiguration({
      bundle: {
        ...linuxConfiguration().bundle,
        version: "2.0.0",
      },
    }),
    activeVersion: "1.2.3",
  });

  class BrokenRollbackAdapter extends RecordingAdapter {
    public override async perform(
      action: PlanAction,
      phase: "forward" | "rollback",
    ): Promise<void> {
      await super.perform(action, phase);
      if (phase === "rollback" && action.kind === "activation.switch") {
        throw new Error("Injected rollback switch failure");
      }
    }
  }

  const report = await executeServicePlan(plan, new BrokenRollbackAdapter("health.check"));
  assert.equal(report.outcome, "failed");
  assert.ok(report.rollback.failures.some((failure) => failure.stepId === "activate-release"));
  assert.match(report.diagnostic.summary, /rollback incomplete/i);
});

test("uninstall preserves state and logs unless purge is explicit", () => {
  const configuration = macOsConfiguration();
  const safe = createServicePlan({
    operation: "uninstall",
    configuration,
    activeVersion: "1.2.3",
  });
  const safeRemoved = safe.steps.flatMap((step) =>
    step.action.kind === "path.remove" ? [step.action.path] : [],
  );
  assert.equal(safeRemoved.includes(configuration.paths.stateRoot), false);
  assert.equal(safeRemoved.includes(configuration.paths.logRoot), false);
  assert.ok(safe.notes.some((note) => /preserved/i.test(note)));

  const purge = createServicePlan({
    operation: "uninstall",
    configuration,
    activeVersion: "1.2.3",
    purgeState: true,
  });
  const purged = purge.steps.flatMap((step) =>
    step.action.kind === "path.remove" ? [step.action.path] : [],
  );
  assert.ok(purged.includes(configuration.paths.stateRoot));
  assert.ok(purged.includes(configuration.paths.logRoot));
});

test("non-upgrade lifecycle commands reject a configuration that does not match the active release", () => {
  assert.throws(
    () =>
      createServicePlan({
        operation: "restart",
        configuration: linuxConfiguration(),
        activeVersion: "1.2.2",
      }),
    /configured bundle version.*active version/i,
  );
});
