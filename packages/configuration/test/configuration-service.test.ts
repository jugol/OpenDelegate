import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationError,
  ConfigurationService,
  InMemoryConfigurationRepository,
  STANDARD_CONFIGURATION_DEFINITIONS,
  type ConfigurationDefinition,
  type ConfigurationMutationAuthorization,
  type ConfigurationSecretReferenceAuthority,
  isAgentExecutionProfile,
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
    secretReference: {
      locality: "main",
    },
    validate: (value: unknown) =>
      value === null ||
      (typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 1 &&
        typeof (value as { secretRef?: unknown }).secretRef === "string"),
  },
] as const satisfies readonly ConfigurationDefinition[];

test("Agent execution profile validation rejects malformed or ambiguous bindings", () => {
  assert.equal(isAgentExecutionProfile({ schemaVersion: 1, mode: "auto" }), true);
  assert.equal(
    isAgentExecutionProfile({
      schemaVersion: 1,
      mode: "pinned",
      primary: {
        provider: "codex",
        adapterId: "codex-app-server",
        modelId: "gpt-5.6-sol",
      },
    }),
    true,
  );
  assert.equal(
    isAgentExecutionProfile({
      schemaVersion: 1,
      mode: "pinned",
      primary: { provider: "codex", adapterId: "codex-app-server" },
    }),
    false,
  );
  assert.equal(
    isAgentExecutionProfile({
      schemaVersion: 1,
      mode: "prefer",
      primary: {
        provider: "claude",
        adapterId: "claude-agent-sdk",
        modelId: "claude-opus",
      },
      fallbacks: [
        {
          provider: "claude",
          adapterId: "claude-agent-sdk",
          modelId: "claude-opus",
        },
      ],
    }),
    false,
  );
  assert.equal(
    isAgentExecutionProfile({
      schemaVersion: 1,
      mode: "auto",
      primary: {
        provider: "generic",
        adapterId: "unexpected",
      },
    }),
    false,
  );
});

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

test("Main-local Secret references are canonical, bounded, and require an availability authority", async () => {
  const repository = new InMemoryConfigurationRepository();
  const service = new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository,
    idSource: () => "unused",
    clock: () => "2026-07-24T12:00:00.000Z",
  });
  const invalidValues = [
    "postgresql://owner:raw-password@db.example.test/opendelegate",
    { secretRef: "database/main" },
    { secretRef: "secret://worker/database-uri" },
    { secretRef: "secret://main/" },
    { secretRef: "secret://main/database%2Furi" },
    { secretRef: `secret://main/${"a".repeat(10_000)}` },
    { secretRef: "secret://main/database-uri\nraw-sentinel" },
    { secretRef: "secret://main/database-uri", raw: "raw-sentinel" },
  ];

  for (const [index, value] of invalidValues.entries()) {
    const change = {
      operation: "set" as const,
      key: "database.uri-ref",
      scope: { kind: "main" as const, id: "main" },
      value,
    };
    await assert.rejects(
      service.propose({
        actor: "configuration-agent",
        reason: "Reject a non-canonical Secret reference.",
        changes: [change],
      }),
      isConfigurationError("invalid-value"),
      `invalid Secret reference fixture ${index}`,
    );
    await assert.rejects(
      service.executeTool({
        operationId: `invalid-secret:${index}`,
        actor: "owner",
        context: { instanceId: "instance", mainId: "main" },
        request: {
          tool: "propose",
          expectedRevision: 0,
          reason: "Reject before writing a Configuration tool receipt.",
          changes: [change],
        },
        authorizeMutation: allowConfigurationMutation,
      }),
      isConfigurationError("invalid-value"),
      `invalid Secret reference tool fixture ${index}`,
    );
  }

  await assert.rejects(
    service.propose({
      actor: "configuration-agent",
      reason: "A canonical reference still needs Main-local availability.",
      changes: [
        {
          operation: "set",
          key: "database.uri-ref",
          scope: { kind: "main", id: "main" },
          value: { secretRef: "secret://main/database-uri" },
        },
      ],
    }),
    isConfigurationError("secret-reference-unavailable"),
  );

  const definition = STANDARD_CONFIGURATION_DEFINITIONS.find(
    ({ key }) => key === "database.uri-ref",
  );
  assert.ok(definition && "secretReference" in definition);
  assert.deepEqual(definition?.secretReference, { locality: "main" });
  assert.deepEqual(
    await repository.read((state) => ({
      proposals: [...state.proposals],
      changeSets: [...state.changeSets],
      audits: state.audits,
      toolReceipts: [...state.toolReceipts],
    })),
    {
      proposals: [],
      changeSets: [],
      audits: [],
      toolReceipts: [],
    },
  );
});

test("Admin auto-open is an explicit persistent Main-scoped owner preference", async () => {
  const service = new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository: new InMemoryConfigurationRepository(),
    idSource: sequenceSource("admin-open"),
    clock: () => "2026-07-24T12:00:00.000Z",
  });
  const context = { instanceId: "instance", mainId: "main-personal" };

  assert.deepEqual((await service.inspect(context))["admin.open-on-login"], {
    key: "admin.open-on-login",
    value: false,
    source: "default",
    inherited: false,
    candidates: [],
  });

  await apply(service, [
    {
      operation: "set",
      key: "admin.open-on-login",
      scope: { kind: "main", id: "main-personal" },
      value: true,
    },
  ]);

  assert.deepEqual((await service.inspect(context))["admin.open-on-login"], {
    key: "admin.open-on-login",
    value: true,
    source: { kind: "main", id: "main-personal" },
    inherited: false,
    candidates: [
      {
        scope: { kind: "main", id: "main-personal" },
        value: true,
      },
    ],
  });
  await assert.rejects(
    service.propose({
      actor: "owner",
      reason: "A login preference cannot be delegated to a Worker Device scope.",
      changes: [
        {
          operation: "set",
          key: "admin.open-on-login",
          scope: { kind: "device", id: "device-worker" },
          value: true,
        },
      ],
    }),
    isConfigurationError("scope-not-allowed"),
  );
});

test("unknown or foreign Main Secret references never enter proposals, diffs, audits, or tool receipts", async () => {
  const repository = new InMemoryConfigurationRepository();
  const unknownReference = "secret://main/unknown-database-uri";
  const seen: Parameters<ConfigurationSecretReferenceAuthority["isAvailable"]>[0][] = [];
  const service = new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository,
    idSource: () => "must-not-be-used",
    clock: () => "2026-07-24T12:00:00.000Z",
    secretReferenceAuthority: {
      isAvailable(input) {
        seen.push(structuredClone(input));
        return false;
      },
    },
  });
  const change = {
    operation: "set" as const,
    key: "database.uri-ref",
    scope: { kind: "main" as const, id: "main-personal" },
    value: { secretRef: unknownReference },
  };

  await assert.rejects(
    service.propose({
      actor: "configuration-agent",
      reason: "Unknown references must fail before proposal persistence.",
      changes: [change],
    }),
    isConfigurationError("secret-reference-unavailable"),
  );
  await assert.rejects(
    service.executeTool({
      operationId: "unknown-secret:propose",
      actor: "owner",
      context: {
        instanceId: "instance-personal",
        mainId: "main-personal",
      },
      request: {
        tool: "propose",
        expectedRevision: 0,
        reason: "Unknown references must not produce a receipt.",
        changes: [change],
      },
      authorizeMutation: allowConfigurationMutation,
    }),
    isConfigurationError("secret-reference-unavailable"),
  );

  assert.deepEqual(seen, [
    {
      key: "database.uri-ref",
      locality: "main",
      scope: { kind: "main", id: "main-personal" },
      secretRef: unknownReference,
    },
    {
      key: "database.uri-ref",
      locality: "main",
      scope: { kind: "main", id: "main-personal" },
      secretRef: unknownReference,
    },
  ]);
  const persisted = await repository.read((state) => ({
    proposals: [...state.proposals],
    changeSets: [...state.changeSets],
    audits: state.audits,
    toolReceipts: [...state.toolReceipts],
  }));
  assert.deepEqual(persisted, {
    proposals: [],
    changeSets: [],
    audits: [],
    toolReceipts: [],
  });
  assert.equal(JSON.stringify(persisted).includes(unknownReference), false);
});

test("Secret reference availability is checked at proposal and again immediately before apply", async () => {
  const repository = new InMemoryConfigurationRepository();
  const reference = "secret://main/database-uri-primary";
  let available = true;
  let authorizationCalls = 0;
  const service = new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository,
    idSource: sequenceSource("secret-change"),
    clock: () => "2026-07-24T12:00:00.000Z",
    secretReferenceAuthority: {
      isAvailable(input) {
        return (
          available &&
          input.key === "database.uri-ref" &&
          input.locality === "main" &&
          input.scope.kind === "main" &&
          input.scope.id === "main-personal" &&
          input.secretRef === reference
        );
      },
    },
  });
  const context = {
    instanceId: "instance-personal",
    mainId: "main-personal",
  };
  const proposed = await service.executeTool({
    operationId: "secret-change:propose",
    actor: "owner",
    context,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "Use the Main-local PostgreSQL credential.",
      changes: [
        {
          operation: "set",
          key: "database.uri-ref",
          scope: { kind: "main", id: "main-personal" },
          value: { secretRef: reference },
        },
      ],
    },
    authorizeMutation: allowConfigurationMutation,
  });
  assert.equal(proposed.tool, "propose");

  available = false;
  await assert.rejects(
    service.executeTool({
      operationId: "secret-change:apply-unavailable",
      actor: "owner",
      context,
      request: {
        tool: "apply",
        proposalId: proposed.result.proposal.id,
        expectedRevision: 0,
      },
      authorizeMutation() {
        authorizationCalls += 1;
        return { decision: "allow", authority: "owner" };
      },
    }),
    isConfigurationError("secret-reference-unavailable"),
  );
  assert.equal(authorizationCalls, 0);
  assert.equal(await service.getRevision(), 0);
  assert.deepEqual(await service.listAudit(), []);
  const failedApplyReceipt = await repository.read((state) =>
    state.toolReceipts.get("secret-change:apply-unavailable"),
  );
  assert.equal(failedApplyReceipt, undefined);

  available = true;
  await assert.rejects(
    service.executeTool({
      operationId: "secret-change:apply-raced",
      actor: "owner",
      context,
      request: {
        tool: "apply",
        proposalId: proposed.result.proposal.id,
        expectedRevision: 0,
      },
      authorizeMutation() {
        available = false;
        return { decision: "allow", authority: "owner" };
      },
    }),
    isConfigurationError("secret-reference-unavailable"),
  );
  assert.equal(await service.getRevision(), 0);
  assert.deepEqual(await service.listAudit(), []);
  assert.equal(
    await repository.read((state) => state.toolReceipts.has("secret-change:apply-raced")),
    false,
  );

  available = true;
  const applied = await service.executeTool({
    operationId: "secret-change:apply",
    actor: "owner",
    context,
    request: {
      tool: "apply",
      proposalId: proposed.result.proposal.id,
      expectedRevision: 0,
    },
    authorizeMutation: allowConfigurationMutation,
  });
  assert.equal(applied.tool, "apply");
  assert.deepEqual((await service.inspect(context))["database.uri-ref"]?.value, {
    secretRef: reference,
  });
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
  assert.equal(effective["device.display-name"]?.value, null);
  assert.deepEqual(effective["device.roles"]?.value, []);
  assert.deepEqual(effective["device.instructions"]?.value, []);
  assert.deepEqual(effective["agent.worker-profile"]?.value, {
    schemaVersion: 1,
    mode: "auto",
  });
  assert.deepEqual(effective["agent.coordinator-profile"]?.value, {
    schemaVersion: 1,
    mode: "auto",
  });
  assert.equal(effective["database.adapter"]?.value, "sqlite");
  assert.equal(effective["artifact.exposure"]?.value, "private-network");
  assert.equal(effective["artifact.interactive-html"]?.value, false);
  assert.equal(effective["policy.official-package-install"]?.value, "allow");
  assert.equal(effective["policy.network-change"]?.value, "require-approval");
  assert.equal(effective["transport.agent-escalation"]?.value, "after-route-exhaustion");
});

test("typed Configuration Agent tools are revision-bound and replay one durable receipt", async () => {
  const repository = new InMemoryConfigurationRepository();
  let sequence = 0;
  const createService = () =>
    new ConfigurationService({
      definitions,
      repository,
      idSource: () => `tool-${++sequence}`,
      clock: () => "2026-07-24T12:00:00.000Z",
    });
  const service = createService();
  const context = {
    instanceId: "instance",
    mainId: "main",
    deviceId: "device-1",
  };

  const inspected = await service.executeTool({
    operationId: "request-1:inspect",
    actor: "owner",
    context,
    request: { tool: "inspect" },
    authorizeMutation: allowConfigurationMutation,
  });
  assert.equal(inspected.tool, "inspect");
  assert.equal(inspected.result.revision, 0);
  assert.equal(inspected.result.values["artifact.exposure"]?.value, "private-network");

  const validated = await service.executeTool({
    operationId: "request-1:validate",
    actor: "owner",
    context,
    request: {
      tool: "validate",
      expectedRevision: 0,
      changes: [
        {
          operation: "set",
          key: "artifact.exposure",
          scope: { kind: "device", id: "device-1" },
          value: "authenticated",
        },
      ],
    },
    authorizeMutation: allowConfigurationMutation,
  });
  assert.equal(validated.tool, "validate");
  assert.deepEqual(validated.result.diff, [
    {
      key: "artifact.exposure",
      scope: { kind: "device", id: "device-1" },
      before: undefined,
      after: "authenticated",
    },
  ]);

  const proposed = await service.executeTool({
    operationId: "request-1:propose",
    actor: "owner",
    context,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "Require an authenticated Artifact viewer on this Device.",
      changes: validated.result.changes,
    },
    authorizeMutation: allowConfigurationMutation,
  });
  assert.equal(proposed.tool, "propose");
  assert.equal(proposed.result.proposal.baseRevision, 0);

  const diffed = await service.executeTool({
    operationId: "request-1:diff",
    actor: "owner",
    context,
    request: {
      tool: "diff",
      proposalId: proposed.result.proposal.id,
      expectedRevision: 0,
    },
    authorizeMutation: allowConfigurationMutation,
  });
  assert.equal(diffed.tool, "diff");
  assert.deepEqual(diffed.result.diff, proposed.result.proposal.diff);

  const applyInput = {
    operationId: "request-1:apply",
    actor: "owner",
    context,
    request: {
      tool: "apply" as const,
      proposalId: proposed.result.proposal.id,
      expectedRevision: 0,
    },
    authorizeMutation: allowConfigurationMutation,
  };
  const applied = await service.executeTool(applyInput);
  assert.equal(applied.tool, "apply");
  assert.equal(applied.result.commit.revision, 1);
  assert.equal(applied.authorization.authority, "owner");

  const restarted = createService();
  const replayed = await restarted.executeTool(applyInput);
  assert.deepEqual(replayed, applied);
  assert.equal(await restarted.getRevision(), 1);

  await assert.rejects(
    restarted.executeTool({
      ...applyInput,
      request: {
        ...applyInput.request,
        expectedRevision: 1,
      },
    }),
    isConfigurationError("tool-idempotency-conflict"),
  );
});

test("typed mutation tools fail closed on policy, stale revisions, and cross-Device scopes", async () => {
  const service = fixture();
  const context = {
    instanceId: "instance",
    mainId: "main",
    deviceId: "device-1",
  };

  await assert.rejects(
    service.executeTool({
      operationId: "cross-device",
      actor: "owner",
      context,
      request: {
        tool: "validate",
        expectedRevision: 0,
        changes: [
          {
            operation: "set",
            key: "artifact.exposure",
            scope: { kind: "device", id: "device-2" },
            value: "public",
          },
        ],
      },
      authorizeMutation: allowConfigurationMutation,
    }),
    isConfigurationError("scope-outside-context"),
  );

  const proposed = await service.executeTool({
    operationId: "proposal",
    actor: "owner",
    context,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "Use authenticated Artifact access.",
      changes: [
        {
          operation: "set",
          key: "artifact.exposure",
          scope: { kind: "device", id: "device-1" },
          value: "authenticated",
        },
      ],
    },
    authorizeMutation: allowConfigurationMutation,
  });
  assert.equal(proposed.tool, "propose");

  await assert.rejects(
    service.executeTool({
      operationId: "denied-apply",
      actor: "owner",
      context,
      request: {
        tool: "apply",
        proposalId: proposed.result.proposal.id,
        expectedRevision: 0,
      },
      authorizeMutation: () => ({
        decision: "deny",
        code: "OWNER_POLICY_DENIED",
      }),
    }),
    isConfigurationError("mutation-denied"),
  );
  assert.equal(await service.getRevision(), 0);

  await assert.rejects(
    service.executeTool({
      operationId: "approval-apply",
      actor: "owner",
      context,
      request: {
        tool: "apply",
        proposalId: proposed.result.proposal.id,
        expectedRevision: 0,
      },
      authorizeMutation: () => ({
        decision: "require-approval",
        code: "OWNER_APPROVAL_REQUIRED",
      }),
    }),
    isConfigurationError("mutation-requires-approval"),
  );
  assert.equal(await service.getRevision(), 0);

  const applied = await service.executeTool({
    operationId: "allowed-apply",
    actor: "owner",
    context,
    request: {
      tool: "apply",
      proposalId: proposed.result.proposal.id,
      expectedRevision: 0,
    },
    authorizeMutation: allowConfigurationMutation,
  });
  assert.equal(applied.tool, "apply");

  const rolledBack = await service.executeTool({
    operationId: "rollback",
    actor: "owner",
    context,
    request: {
      tool: "rollback",
      changeSetId: applied.result.commit.changeSetId,
      expectedRevision: 1,
      reason: "Restore the prior Device setting.",
    },
    authorizeMutation: allowConfigurationMutation,
  });
  assert.equal(rolledBack.tool, "rollback");
  assert.equal(rolledBack.result.commit.revision, 2);
  assert.equal((await service.inspect(context))["artifact.exposure"]?.value, "private-network");
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

function allowConfigurationMutation(): ConfigurationMutationAuthorization {
  return {
    decision: "allow",
    authority: "owner",
  };
}

function sequenceSource(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}
