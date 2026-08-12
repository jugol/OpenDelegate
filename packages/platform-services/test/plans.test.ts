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
    const manifestRootIndex = install.steps.findIndex((step) => step.id === "ensure-manifest-root");
    const firstRenderedFileIndex = install.steps.findIndex(
      (step) => step.action.kind === "file.write",
    );
    assert.ok(configRootIndex >= 0 && configRootIndex < firstRenderedFileIndex);
    assert.ok(manifestRootIndex >= 0 && manifestRootIndex < firstRenderedFileIndex);
    if (configuration.platform === "windows") {
      const promoteIndex = install.steps.findIndex((step) => step.id === "promote-release");
      const secureReleaseIndex = install.steps.findIndex(
        (step) => step.id === "secure-release-root",
      );
      const activateIndex = install.steps.findIndex((step) => step.id === "activate-release");
      assert.ok(promoteIndex < secureReleaseIndex && secureReleaseIndex < activateIndex);
    } else {
      assert.equal(
        install.steps.some((step) => step.id === "secure-release-root"),
        false,
      );
    }
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

test("Windows install grants the virtual service temporary full control of its DPAPI vault", () => {
  const configuration = windowsConfiguration({
    serviceSecretBinding: {
      backend: "windows-service-dpapi",
      handoffRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\handoff",
      serviceName: "OpenDelegate-personal",
      serviceSid: "S-1-5-80-1-2-3-4-5",
      vaultRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service",
    },
  });
  const install = createServicePlan({ operation: "install", configuration });
  const vault = install.steps.find((step) => step.id === "ensure-service-secret-vault");
  assert.ok(vault);
  assert.equal(vault.action.kind, "directory.ensure");
  assert.equal(vault.action.path, configuration.serviceSecretBinding?.vaultRoot);
  assert.equal(vault.action.access.owner, "NT SERVICE\\OpenDelegate-personal");
  assert.deepEqual(vault.action.access.grants, [
    { principal: "BUILTIN\\Administrators", permission: "full-control" },
    { principal: "NT SERVICE\\OpenDelegate-personal", permission: "full-control" },
  ]);
  assert.ok(
    install.steps.findIndex((step) => step.id === "ensure-service-secret-vault") <
      install.steps.findIndex((step) => step.id === "start-core"),
  );
});

test("Windows lifecycle plans prepare an isolated service Codex home before start", () => {
  const serviceHome = "C:\\ProgramData\\OpenDelegate\\state\\state\\providers\\codex";
  const sandboxDirectory = `${serviceHome}\\.sandbox-bin`;
  const configuration = windowsConfiguration({
    agentSandbox: { codexSandboxBinDirectory: sandboxDirectory },
  });
  for (const input of [
    { operation: "install" as const, configuration },
    { operation: "start" as const, configuration, activeVersion: "1.2.3" },
    { operation: "restart" as const, configuration, activeVersion: "1.2.3" },
    {
      operation: "upgrade" as const,
      configuration: windowsConfiguration({
        agentSandbox: { codexSandboxBinDirectory: sandboxDirectory },
        bundle: { ...configuration.bundle, version: "1.2.4" },
      }),
      activeVersion: "1.2.3",
    },
  ]) {
    const plan = createServicePlan(input);
    const sandbox = plan.steps.find((step) => step.id === "ensure-codex-sandbox-helper");
    assert.ok(sandbox);
    assert.equal(sandbox.action.kind, "directory.ensure");
    assert.equal(sandbox.action.path, sandboxDirectory);
    assert.equal(sandbox.action.requiredExistingParent, serviceHome);
    assert.equal(sandbox.action.access.owner, "NT SERVICE\\OpenDelegate-personal");
    assert.deepEqual(sandbox.action.access.grants, [
      { principal: "BUILTIN\\Administrators", permission: "full-control" },
      { principal: "S-1-5-18", permission: "full-control" },
      { principal: "S-1-5-21-1000", permission: "read-execute" },
      { principal: "NT SERVICE\\OpenDelegate-personal", permission: "full-control" },
    ]);
    const service = plan.steps.find((step) => step.id === "ensure-codex-service-home");
    assert.ok(service);
    assert.equal(service.action.kind, "directory.ensure");
    assert.equal(service.action.path, serviceHome);
    assert.equal(service.action.access.owner, "NT SERVICE\\OpenDelegate-personal");
    const auth = plan.steps.find((step) => step.id === "ensure-codex-auth-ssot-link");
    assert.ok(auth);
    assert.equal(auth.action.kind, "file.symbolic-link.ensure");
    assert.equal(auth.action.path, `${serviceHome}\\auth.json`);
    assert.equal(auth.action.target, "C:\\Users\\owner\\.codex\\auth.json");
    assert.ok(
      plan.steps.findIndex((step) => step.id === "ensure-codex-sandbox-helper") <
        plan.steps.findIndex((step) => step.id === "start-core"),
    );
  }
});

test("Windows lifecycle plans preserve provider ACLs while granting exact service access", () => {
  const ownerSession = {
    ...windowsConfiguration().ownerSession,
    homeDirectory: "C:\\Users\\owner",
  };
  const access = {
    codexHomeDirectory: "C:\\Users\\owner\\.codex",
    codexServiceHomeDirectory: "C:\\ProgramData\\OpenDelegate\\state\\state\\providers\\codex",
    claudeHomeDirectory: "C:\\Users\\owner\\.claude",
  };
  for (const input of [
    {
      operation: "install" as const,
      configuration: windowsConfiguration({
        ownerSession,
        agentProviderAccess: access,
        agentSandbox: {
          codexSandboxBinDirectory: `${access.codexServiceHomeDirectory}\\.sandbox-bin`,
        },
      }),
    },
    {
      operation: "start" as const,
      configuration: windowsConfiguration({
        ownerSession,
        agentProviderAccess: access,
        agentSandbox: {
          codexSandboxBinDirectory: `${access.codexServiceHomeDirectory}\\.sandbox-bin`,
        },
      }),
      activeVersion: "1.2.3",
    },
    {
      operation: "restart" as const,
      configuration: windowsConfiguration({
        ownerSession,
        agentProviderAccess: access,
        agentSandbox: {
          codexSandboxBinDirectory: `${access.codexServiceHomeDirectory}\\.sandbox-bin`,
        },
      }),
      activeVersion: "1.2.3",
    },
    {
      operation: "upgrade" as const,
      configuration: windowsConfiguration({
        ownerSession,
        agentProviderAccess: access,
        agentSandbox: {
          codexSandboxBinDirectory: `${access.codexServiceHomeDirectory}\\.sandbox-bin`,
        },
        bundle: { ...windowsConfiguration().bundle, version: "1.2.4" },
      }),
      activeVersion: "1.2.3",
    },
  ]) {
    const plan = createServicePlan(input);
    const grants = plan.steps.filter((step) => step.action.kind === "directory.access-grant");
    assert.deepEqual(
      grants.map((step) =>
        step.action.kind === "directory.access-grant"
          ? [step.action.path, step.action.permission]
          : [],
      ),
      [
        ["C:\\Users\\owner\\.codex", "read-write"],
        ["C:\\Users\\owner\\.claude", "read-write"],
        ["C:\\Users\\owner\\.local\\bin", "read-execute"],
        ["C:\\Users\\owner\\AppData\\Roaming\\npm", "read-execute"],
      ],
    );
    for (const grant of grants) {
      assert.equal(grant.action.kind, "directory.access-grant");
      assert.equal(grant.action.principal, "NT SERVICE\\OpenDelegate-personal");
      assert.equal(grant.action.preserveExistingAccess, true);
      assert.equal(grant.action.missingPathPolicy, "skip");
      assert.ok(
        plan.steps.indexOf(grant) < plan.steps.findIndex((step) => step.id === "start-core"),
      );
    }
    assert.ok(
      Math.max(...grants.map((grant) => plan.steps.indexOf(grant))) <
        plan.steps.findIndex((step) => step.id === "ensure-codex-sandbox-helper"),
    );
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
  const runtimeWrite = plan.steps.find((step) => step.id === "write-runtime-configuration");
  assert.equal(runtimeWrite?.rollback?.kind, "file.write");
  if (runtimeWrite?.rollback?.kind === "file.write") {
    assert.equal(runtimeWrite.rollback.restoreOriginalBytes, true);
  }
  assert.ok(activation);
  assert.equal(activation.action.kind, "activation.switch");
  assert.match(activation.action.targetReleaseDirectory, /1\.3\.0$/);
  assert.equal(activation.rollback?.kind, "activation.switch");
  if (activation.rollback?.kind === "activation.switch") {
    assert.match(activation.rollback.targetReleaseDirectory, /1\.2\.3$/);
  }
  const secureReleaseIndex = plan.steps.findIndex((step) => step.id === "secure-release-root");
  const stopCoreIndex = plan.steps.findIndex((step) => step.id === "stop-core");
  assert.ok(secureReleaseIndex > plan.steps.findIndex((step) => step.id === "promote-release"));
  assert.ok(secureReleaseIndex < stopCoreIndex);
  const secureRelease = plan.steps[secureReleaseIndex];
  assert.equal(secureRelease?.action.kind, "directory.ensure");
  if (secureRelease?.action.kind === "directory.ensure") {
    assert.ok(
      secureRelease.action.access.grants.some(
        (grant) =>
          grant.principal.startsWith("NT SERVICE\\") && grant.permission === "read-execute",
      ),
    );
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

test("Windows upgrade repairs the declared service SID definition before restarting core", () => {
  const configuration = windowsConfiguration({
    bundle: {
      ...windowsConfiguration().bundle,
      version: "1.3.0",
    },
  });
  const plan = createServicePlan({
    operation: "upgrade",
    configuration,
    activeVersion: "1.2.3",
  });

  const stopCoreIndex = plan.steps.findIndex((step) => step.id === "stop-core");
  const stopHelperIndex = plan.steps.findIndex((step) => step.id === "stop-helper");
  const helperManifestIndex = plan.steps.findIndex(
    (step) => step.id === "write-windows-helper-manifest",
  );
  const helperRegistrationIndex = plan.steps.findIndex(
    (step) => step.id === "refresh-windows-helper-registration",
  );
  const repairIndex = plan.steps.findIndex((step) => step.id === "repair-windows-service-sid");
  const manifestIndex = plan.steps.findIndex((step) => step.id === "write-windows-core-manifest");
  const startCoreIndex = plan.steps.findIndex((step) => step.id === "start-core");
  assert.ok(stopCoreIndex >= 0);
  assert.ok(stopHelperIndex < helperManifestIndex);
  assert.ok(helperManifestIndex < helperRegistrationIndex);
  assert.ok(helperRegistrationIndex < stopCoreIndex);
  assert.ok(stopCoreIndex < repairIndex);
  assert.ok(repairIndex < manifestIndex);
  assert.ok(manifestIndex < startCoreIndex);

  const repair = plan.steps[repairIndex];
  assert.equal(repair?.action.kind, "supervisor.invoke");
  if (repair?.action.kind === "supervisor.invoke") {
    assert.deepEqual(repair.action.command.invocations, [
      {
        executable: "sc.exe",
        arguments: ["sidtype", "OpenDelegate-personal", "unrestricted"],
        plane: "core",
        verb: "install",
        privilege: "elevated",
        availabilityPolicy: "required",
        timeoutMs: 30_000,
        expectedExitCodes: [0],
      },
    ]);
  }
  assert.equal(repair?.rollback, undefined);

  const manifest = plan.steps[manifestIndex];
  assert.equal(manifest?.action.kind, "file.write");
  if (manifest?.action.kind === "file.write") {
    assert.equal(manifest.action.file.purpose, "core-manifest");
    assert.match(manifest.action.file.content, /"serviceSidType": "unrestricted"/u);
  }
  assert.equal(manifest?.rollback, undefined);

  const helperManifest = plan.steps[helperManifestIndex];
  assert.equal(helperManifest?.action.kind, "file.write");
  if (helperManifest?.action.kind === "file.write") {
    assert.equal(helperManifest.action.file.purpose, "helper-manifest");
    assert.match(helperManifest.action.file.content, /<Hidden>true<\/Hidden>/u);
  }
  assert.equal(helperManifest?.rollback, undefined);

  const helperRegistration = plan.steps[helperRegistrationIndex];
  assert.equal(helperRegistration?.action.kind, "supervisor.invoke");
  if (helperRegistration?.action.kind === "supervisor.invoke") {
    assert.deepEqual(helperRegistration.action.command.invocations, [
      {
        executable: "schtasks.exe",
        arguments: [
          "/Create",
          "/TN",
          "\\OpenDelegate-personal-SessionHelper",
          "/XML",
          "C:\\ProgramData\\OpenDelegate\\state\\manifests\\OpenDelegate-personal.session-helper.task.xml",
          "/F",
        ],
        plane: "session-helper",
        verb: "install",
        privilege: "elevated",
        availabilityPolicy: "required",
        timeoutMs: 30_000,
        expectedExitCodes: [0],
      },
    ]);
  }
  assert.equal(helperRegistration?.rollback, undefined);
  assert.ok(plan.notes.some((note) => /not reverted to a visible console/u.test(note)));
});

test("macOS upgrade persists its bounded service PATH before restarting core", () => {
  const base = macOsConfiguration();
  const configuration = macOsConfiguration({
    bundle: {
      ...base.bundle,
      version: "1.3.0",
    },
  });
  const plan = createServicePlan({
    operation: "upgrade",
    configuration,
    activeVersion: "1.2.3",
  });
  const stopCoreIndex = plan.steps.findIndex((step) => step.id === "stop-core");
  const manifestIndex = plan.steps.findIndex((step) => step.id === "write-macos-core-manifest");
  const startCoreIndex = plan.steps.findIndex((step) => step.id === "start-core");
  assert.ok(stopCoreIndex >= 0);
  assert.ok(stopCoreIndex < manifestIndex);
  assert.ok(manifestIndex < startCoreIndex);
  const manifest = plan.steps[manifestIndex];
  assert.equal(manifest?.action.kind, "file.write");
  if (manifest?.action.kind === "file.write") {
    assert.equal(manifest.action.file.purpose, "core-manifest");
    assert.match(manifest.action.file.content, /<key>EnvironmentVariables<\/key>/u);
    assert.match(manifest.action.file.content, /\/opt\/homebrew\/bin/u);
  }
  assert.equal(manifest?.rollback?.kind, "file.write");
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
