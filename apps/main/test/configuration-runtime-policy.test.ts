import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationService,
  InMemoryConfigurationRepository,
  STANDARD_CONFIGURATION_DEFINITIONS,
  type ConfigurationChange,
} from "@opendelegate/configuration";

import {
  MainConfigurationRuntimePolicy,
  createConfigurationControlledRouteDiagnosticAgent,
  createConfigurationMainActionPolicy,
  createConfigurationMainArtifactPreparePolicy,
} from "../src/configuration-runtime-policy.ts";

test("new Task mode uses current Configuration scope precedence", async () => {
  const service = configurationService();
  const policy = new MainConfigurationRuntimePolicy({
    service,
    instanceId: "instance-main",
    mainDeviceId: "device-main",
    taskDefaultId: "owner-default",
  });

  assert.equal(await policy.taskDefaultMode(), "auto");

  await apply(service, [
    {
      operation: "set",
      key: "task.default-mode",
      scope: { kind: "instance", id: "instance-main" },
      value: "manual",
    },
  ]);
  assert.equal(await policy.taskDefaultMode(), "manual");

  await apply(service, [
    {
      operation: "set",
      key: "task.default-mode",
      scope: { kind: "main", id: "device-main" },
      value: "auto",
    },
  ]);
  assert.equal(await policy.taskDefaultMode(), "auto");

  await apply(service, [
    {
      operation: "set",
      key: "task.default-mode",
      scope: { kind: "device", id: "device-main" },
      value: "manual",
    },
  ]);
  assert.equal(await policy.taskDefaultMode(), "manual");

  await apply(service, [
    {
      operation: "set",
      key: "task.default-mode",
      scope: { kind: "task-default", id: "owner-default" },
      value: "auto",
    },
  ]);
  assert.equal(await policy.taskDefaultMode(), "auto");
});

test("Autonomy Profile produces a current machine-readable proactive disposition", async () => {
  const service = configurationService();
  const policy = new MainConfigurationRuntimePolicy({
    service,
    instanceId: "instance-main",
    mainDeviceId: "device-main",
    taskDefaultId: "owner-default",
  });

  assert.equal(await policy.proactiveDisposition("incident-recovery"), "execute");
  assert.equal(await policy.proactiveDisposition("general-improvement"), "propose");

  await apply(service, [
    {
      operation: "set",
      key: "autonomy.general-improvement",
      scope: { kind: "main", id: "device-main" },
      value: "execute",
    },
  ]);
  assert.equal(await policy.proactiveDisposition("general-improvement"), "execute");

  await apply(service, [
    {
      operation: "set",
      key: "autonomy.general-improvement",
      scope: { kind: "main", id: "device-main" },
      value: "disabled",
    },
  ]);
  assert.equal(await policy.proactiveDisposition("general-improvement"), "disabled");

  await apply(service, [
    {
      operation: "set",
      key: "autonomy.general-improvement",
      scope: { kind: "main", id: "device-main" },
      value: "inherit",
    },
  ]);

  await apply(service, [
    {
      operation: "set",
      key: "autonomy.profile",
      scope: { kind: "device", id: "device-main" },
      value: "reactive",
    },
  ]);
  assert.equal(await policy.proactiveDisposition("general-improvement"), "disabled");

  await apply(service, [
    {
      operation: "set",
      key: "autonomy.profile",
      scope: { kind: "device", id: "device-worker" },
      value: "reactive",
    },
  ]);
  assert.equal(
    await policy.proactiveDisposition("incident-recovery", {
      deviceId: "device-worker",
    }),
    "propose",
  );
  assert.equal(
    await policy.proactiveDisposition("general-improvement", {
      deviceId: "device-worker",
    }),
    "disabled",
  );

  await apply(service, [
    {
      operation: "set",
      key: "autonomy.profile",
      scope: { kind: "device", id: "device-worker" },
      value: "autonomous",
    },
  ]);
  assert.equal(
    await policy.proactiveDisposition("general-improvement", {
      deviceId: "device-worker",
    }),
    "execute",
  );
});

test("Artifact preparation uses current exposure precedence and explicit interactive HTML enablement", async () => {
  const service = configurationService();
  const runtimePolicy = new MainConfigurationRuntimePolicy({
    service,
    instanceId: "instance-main",
    mainDeviceId: "device-main",
    taskDefaultId: "owner-default",
  });
  const policy = createConfigurationMainArtifactPreparePolicy(runtimePolicy);
  const input = artifactPolicyInput("interactive-html");

  assert.deepEqual(await policy.resolve(input), {
    status: "rejected",
    retryable: false,
  });

  await apply(service, [
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "instance", id: "instance-main" },
      value: "authenticated",
    },
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "device", id: "device-worker" },
      value: "signed-link",
    },
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "artifact", id: "artifact-report" },
      value: "public",
    },
    {
      operation: "set",
      key: "artifact.interactive-html",
      scope: { kind: "artifact", id: "artifact-report" },
      value: true,
    },
  ]);

  assert.deepEqual(await policy.resolve(input), {
    status: "allowed",
    retentionPolicy: { kind: "task" },
    exposurePolicy: { mode: "public" },
    presentation: "interactive-html",
  });

  await apply(service, [
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "artifact", id: "artifact-report" },
      value: "custom",
    },
  ]);
  assert.deepEqual(await policy.resolve(input), {
    status: "rejected",
    retryable: false,
  });
});

test("configured package and network decisions use current Device scope precedence", async () => {
  const service = configurationService();
  const runtimePolicy = new MainConfigurationRuntimePolicy({
    service,
    instanceId: "instance-main",
    mainDeviceId: "device-main",
    taskDefaultId: "owner-default",
  });
  const policy = createConfigurationMainActionPolicy(runtimePolicy);

  assert.equal(
    await policy.decide({
      deviceId: "device-worker",
      actionCategory: "configured-official-package-install",
    }),
    "allow",
  );
  assert.equal(
    await policy.decide({
      deviceId: "device-worker",
      actionCategory: "vpn-change",
    }),
    "require-approval",
  );
  assert.equal(
    await policy.decide({
      deviceId: "device-worker",
      actionCategory: "computer-use-input",
    }),
    undefined,
  );

  await apply(service, [
    {
      operation: "set",
      key: "policy.official-package-install",
      scope: { kind: "main", id: "device-main" },
      value: "deny",
    },
    {
      operation: "set",
      key: "policy.network-change",
      scope: { kind: "device", id: "device-worker" },
      value: "allow",
    },
  ]);

  assert.equal(
    await policy.decide({
      deviceId: "device-worker",
      actionCategory: "configured-official-package-install",
    }),
    "deny",
  );
  for (const actionCategory of ["os-network-change", "vpn-change", "firewall-change"] as const) {
    assert.equal(await policy.decide({ deviceId: "device-worker", actionCategory }), "allow");
  }
});

test("route Agent escalation is skipped when disabled and honors Transport precedence", async () => {
  const service = configurationService();
  const runtimePolicy = new MainConfigurationRuntimePolicy({
    service,
    instanceId: "instance-main",
    mainDeviceId: "device-main",
    taskDefaultId: "owner-default",
  });
  let calls = 0;
  const agent = createConfigurationControlledRouteDiagnosticAgent({
    runtime: runtimePolicy,
    agent: {
      async diagnose() {
        calls += 1;
        return {
          recommendation: "Review the private path.",
          ownerQuestion: "Is the private path expected to be available?",
        };
      },
    },
    transportIdForIncident: () => "transport-private",
  });
  const input = routeDiagnosticInput();

  await apply(service, [
    {
      operation: "set",
      key: "transport.agent-escalation",
      scope: { kind: "device", id: "device-worker" },
      value: "disabled",
    },
  ]);
  await assert.rejects(() => agent.diagnose(input), /disabled/u);
  assert.equal(calls, 0);

  await apply(service, [
    {
      operation: "set",
      key: "transport.agent-escalation",
      scope: { kind: "transport", id: "transport-private" },
      value: "after-route-exhaustion",
    },
  ]);
  assert.deepEqual(await agent.diagnose(input), {
    recommendation: "Review the private path.",
    ownerQuestion: "Is the private path expected to be available?",
  });
  assert.equal(calls, 1);

  await apply(service, [
    {
      operation: "set",
      key: "transport.agent-escalation",
      scope: { kind: "transport", id: "transport-private" },
      value: "disabled",
    },
  ]);
  await assert.rejects(() => agent.diagnose(input), /disabled/u);
  assert.equal(calls, 1);
});

function configurationService(): ConfigurationService {
  let id = 0;
  return new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository: new InMemoryConfigurationRepository(),
    idSource: () => `configuration-runtime-${String(++id)}`,
    clock: () => "2026-07-25T00:00:00.000Z",
  });
}

function artifactPolicyInput(
  requestedPresentation: "interactive-html" | "static-html",
): Parameters<ReturnType<typeof createConfigurationMainArtifactPreparePolicy>["resolve"]>[0] {
  return {
    authenticatedDeviceId: "device-worker",
    manifest: {
      artifactId: "artifact-report",
      taskId: "task-report",
      workOrderId: "work-order-report",
      deviceId: "device-worker",
      workerId: "worker-report",
      routeId: "route-main",
      runId: "run-report",
      leaseId: "lease-report",
      fencingToken: 1,
      mediaType: "text/html",
      originalFilename: "report.html",
      declaredSizeBytes: 128,
      expectedSha256: "1".repeat(64),
      requestedPresentation,
    },
    run: {
      authorized: true,
      leaseExpiresAtMs: 2_000,
    },
  };
}

function routeDiagnosticInput(): Parameters<
  ReturnType<typeof createConfigurationControlledRouteDiagnosticAgent>["diagnose"]
>[0] {
  return {
    authenticatedDeviceId: "device-worker",
    incident: {
      incidentId: `sha256:${"1".repeat(64)}`,
      profileRevision: `sha256:${"2".repeat(64)}`,
      fingerprint: `sha256:${"3".repeat(64)}`,
      attempts: [
        {
          attemptIndex: 0,
          kind: "wss",
          outcome: "connect-failed",
          code: "ETIMEDOUT",
        },
      ],
    },
    limits: {
      maximumTurns: 1,
      maximumOutputCharacters: 4_096,
    },
    authority: {
      tools: "denied",
      osMutation: "denied",
      networkMutation: "denied",
    },
  };
}

async function apply(
  service: ConfigurationService,
  changes: readonly ConfigurationChange[],
): Promise<void> {
  const proposal = await service.propose({
    actor: "owner",
    reason: "Exercise current runtime policy.",
    changes,
  });
  await service.apply({
    proposalId: proposal.id,
    expectedRevision: proposal.baseRevision,
    actor: "owner",
  });
}
