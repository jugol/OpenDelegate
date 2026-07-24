import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationError,
  ConfigurationService,
  InMemoryConfigurationRepository,
  STANDARD_CONFIGURATION_DEFINITIONS,
  type ConfigurationDefinition,
} from "../src/index.ts";

const definitions = [
  {
    key: "artifact.exposure",
    defaultValue: "private-network",
    scopes: ["instance", "device", "task-default", "artifact"],
    validate: (value: unknown) =>
      value === "private-network" ||
      value === "authenticated" ||
      value === "signed-link" ||
      value === "public",
  },
  {
    key: "autonomy.incident-recovery",
    defaultValue: "assisted",
    scopes: ["instance", "main", "device"],
    validate: (value: unknown) =>
      value === "reactive" || value === "assisted" || value === "autonomous",
  },
  {
    key: "discord.token-ref",
    defaultValue: null,
    scopes: ["main"],
    validate: (value: unknown) =>
      value === null ||
      (typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 1 &&
        typeof (value as { secretRef?: unknown }).secretRef === "string"),
  },
] as const satisfies readonly ConfigurationDefinition[];

test("effective values use each setting's explicit least-to-most-specific precedence", async () => {
  const service = fixture();

  await apply(service, [
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "instance", id: "instance" },
      value: "authenticated",
    },
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "device", id: "device-1" },
      value: "signed-link",
    },
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "artifact", id: "artifact-1" },
      value: "public",
    },
  ]);

  const resolved = await service.inspect({
    instanceId: "instance",
    deviceId: "device-1",
    artifactId: "artifact-1",
  });

  assert.deepEqual(resolved["artifact.exposure"], {
    key: "artifact.exposure",
    value: "public",
    source: { kind: "artifact", id: "artifact-1" },
    inherited: false,
    candidates: [
      {
        scope: { kind: "instance", id: "instance" },
        value: "authenticated",
      },
      {
        scope: { kind: "device", id: "device-1" },
        value: "signed-link",
      },
      {
        scope: { kind: "artifact", id: "artifact-1" },
        value: "public",
      },
    ],
  });
});

test("a proposal is immutable, revision-bound, diffable, and atomically applied", async () => {
  const service = fixture();
  const proposal = await service.propose({
    actor: "configuration-agent",
    reason: "Use the safer owner-authenticated viewer by default.",
    changes: [
      {
        operation: "set",
        key: "artifact.exposure",
        scope: { kind: "instance", id: "instance" },
        value: "authenticated",
      },
    ],
  });

  assert.equal(proposal.baseRevision, 0);
  assert.deepEqual(proposal.diff, [
    {
      key: "artifact.exposure",
      scope: { kind: "instance", id: "instance" },
      before: undefined,
      after: "authenticated",
    },
  ]);

  const applied = await service.apply({
    proposalId: proposal.id,
    expectedRevision: 0,
    actor: "owner",
  });
  assert.equal(applied.revision, 1);
  assert.equal(applied.audit.action, "configuration.applied");

  await assert.rejects(
    service.apply({
      proposalId: proposal.id,
      expectedRevision: 1,
      actor: "owner",
    }),
    isConfigurationError("proposal-consumed"),
  );
});

test("stale proposals fail closed without partially applying their changes", async () => {
  const service = fixture();
  const stale = await service.propose({
    actor: "configuration-agent",
    reason: "Stale change.",
    changes: [
      {
        operation: "set",
        key: "artifact.exposure",
        scope: { kind: "instance", id: "instance" },
        value: "public",
      },
    ],
  });

  await apply(service, [
    {
      operation: "set",
      key: "autonomy.incident-recovery",
      scope: { kind: "instance", id: "instance" },
      value: "reactive",
    },
  ]);

  await assert.rejects(
    service.apply({
      proposalId: stale.id,
      expectedRevision: 0,
      actor: "owner",
    }),
    isConfigurationError("revision-conflict"),
  );

  const effective = await service.inspect({ instanceId: "instance" });
  assert.equal(effective["artifact.exposure"]?.value, "private-network");
});

test("rollback is an explicit revision-bound transaction with an audit record", async () => {
  const service = fixture();
  const applied = await apply(service, [
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "instance", id: "instance" },
      value: "public",
    },
  ]);

  const rolledBack = await service.rollback({
    changeSetId: applied.changeSetId,
    expectedRevision: 1,
    actor: "owner",
    reason: "Public exposure was only a temporary test.",
  });

  assert.equal(rolledBack.revision, 2);
  assert.equal(rolledBack.audit.action, "configuration.rolled-back");
  const effective = await service.inspect({ instanceId: "instance" });
  assert.equal(effective["artifact.exposure"]?.value, "private-network");
  assert.equal(effective["artifact.exposure"]?.source, "default");
});

test("rollback cannot overwrite a newer change to the same target", async () => {
  const service = fixture();
  const first = await apply(service, [
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "instance", id: "instance" },
      value: "authenticated",
    },
  ]);
  await apply(service, [
    {
      operation: "set",
      key: "artifact.exposure",
      scope: { kind: "instance", id: "instance" },
      value: "signed-link",
    },
  ]);

  await assert.rejects(
    service.rollback({
      changeSetId: first.changeSetId,
      expectedRevision: 2,
      actor: "owner",
      reason: "This must not erase the newer setting.",
    }),
    isConfigurationError("rollback-conflict"),
  );

  const effective = await service.inspect({ instanceId: "instance" });
  assert.equal(effective["artifact.exposure"]?.value, "signed-link");
});

test("unknown keys, invalid values, illegal scopes, and raw secret-shaped values are rejected", async () => {
  const service = fixture();

  await assert.rejects(
    service.propose({
      actor: "configuration-agent",
      reason: "Unknown setting.",
      changes: [
        {
          operation: "set",
          key: "unknown.setting",
          scope: { kind: "instance", id: "instance" },
          value: true,
        },
      ],
    }),
    isConfigurationError("unknown-setting"),
  );

  await assert.rejects(
    service.propose({
      actor: "configuration-agent",
      reason: "Invalid value.",
      changes: [
        {
          operation: "set",
          key: "artifact.exposure",
          scope: { kind: "instance", id: "instance" },
          value: "wide-open",
        },
      ],
    }),
    isConfigurationError("invalid-value"),
  );

  await assert.rejects(
    service.propose({
      actor: "configuration-agent",
      reason: "Wrong scope.",
      changes: [
        {
          operation: "set",
          key: "discord.token-ref",
          scope: { kind: "device", id: "device-1" },
          value: { secretRef: "discord/main" },
        },
      ],
    }),
    isConfigurationError("scope-not-allowed"),
  );

  await assert.rejects(
    service.propose({
      actor: "configuration-agent",
      reason: "A raw token must never enter configuration.",
      changes: [
        {
          operation: "set",
          key: "discord.token-ref",
          scope: { kind: "main", id: "main" },
          value: "discord-token-value",
        },
      ],
    }),
    isConfigurationError("invalid-value"),
  );
});

test("duplicate targets, empty patches, and value-preserving patches are rejected", async () => {
  const service = fixture();
  const duplicate = {
    operation: "set" as const,
    key: "artifact.exposure",
    scope: { kind: "instance" as const, id: "instance" },
    value: "authenticated",
  };

  await assert.rejects(
    service.propose({
      actor: "configuration-agent",
      reason: "Duplicate.",
      changes: [duplicate, duplicate],
    }),
    isConfigurationError("duplicate-target"),
  );

  await assert.rejects(
    service.propose({
      actor: "configuration-agent",
      reason: "Empty.",
      changes: [],
    }),
    isConfigurationError("empty-patch"),
  );

  await apply(service, [duplicate]);
  await assert.rejects(
    service.propose({
      actor: "configuration-agent",
      reason: "No actual change.",
      changes: [duplicate],
    }),
    isConfigurationError("no-effective-change"),
  );
});

test("standard defaults preserve the owner's accepted automatic and safety decisions", async () => {
  const service = new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository: new InMemoryConfigurationRepository(),
    idSource: () => "unused",
    clock: () => "2026-07-24T12:00:00.000Z",
  });

  const effective = await service.inspect({
    instanceId: "instance",
    mainId: "main",
    deviceId: "device",
  });

  assert.equal(effective["task.default-mode"]?.value, "auto");
  assert.equal(effective["autonomy.profile"]?.value, "assisted");
  assert.equal(effective["database.adapter"]?.value, "sqlite");
  assert.equal(effective["artifact.exposure"]?.value, "private-network");
  assert.equal(effective["artifact.interactive-html"]?.value, false);
  assert.equal(effective["policy.official-package-install"]?.value, "allow");
  assert.equal(effective["policy.network-change"]?.value, "require-approval");
  assert.equal(effective["transport.agent-escalation"]?.value, "after-route-exhaustion");
});

function fixture(): ConfigurationService {
  let sequence = 0;
  return new ConfigurationService({
    definitions,
    repository: new InMemoryConfigurationRepository(),
    idSource: () => `configuration-${++sequence}`,
    clock: () => "2026-07-24T12:00:00.000Z",
  });
}

async function apply(
  service: ConfigurationService,
  changes: Parameters<ConfigurationService["propose"]>[0]["changes"],
) {
  const revision = await service.getRevision();
  const proposal = await service.propose({
    actor: "test",
    reason: "Test configuration change.",
    changes,
  });
  return service.apply({
    proposalId: proposal.id,
    expectedRevision: revision,
    actor: "owner",
  });
}

function isConfigurationError(code: string) {
  return (error: unknown): boolean => error instanceof ConfigurationError && error.code === code;
}
