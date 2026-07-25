import Type from "typebox";

import { OpaqueIdSchema, Rfc3339InstantSchema } from "./common.ts";

const ApprovalStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("denied"),
  Type.Literal("expired"),
]);

const ApprovalExecutionStatusSchema = Type.Union([
  Type.Literal("waiting"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
]);

const ApprovalRiskSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

const ApprovalGrantScopeSchema = Type.Union([
  Type.Literal("once"),
  Type.Literal("task"),
  Type.Literal("device"),
  Type.Literal("policy"),
]);

const ApprovalActionCategorySchema = Type.Union([
  Type.Literal("read-only-observation"),
  Type.Literal("opendelegate-process-retry"),
  Type.Literal("opendelegate-process-restart"),
  Type.Literal("project-dependency-install"),
  Type.Literal("configured-official-package-install"),
  Type.Literal("computer-use-input"),
  Type.Literal("sandbox-boundary-escalation"),
  Type.Literal("package-repository-addition"),
  Type.Literal("remote-installer-script"),
  Type.Literal("untrusted-installer"),
  Type.Literal("driver-installation"),
  Type.Literal("kernel-extension-installation"),
  Type.Literal("os-network-change"),
  Type.Literal("vpn-change"),
  Type.Literal("firewall-change"),
  Type.Literal("policy-relaxation"),
  Type.Literal("secret-export"),
  Type.Literal("cross-device-knowledge-transfer"),
  Type.Literal("policy-bypass-attempt"),
]);

const ConfigurationScopeKindSchema = Type.Union([
  Type.Literal("instance"),
  Type.Literal("main"),
  Type.Literal("device"),
  Type.Literal("agent-adapter"),
  Type.Literal("transport"),
  Type.Literal("channel-binding"),
  Type.Literal("task-default"),
  Type.Literal("artifact"),
]);

const ApprovalValuePreviewSchema = Type.Union([
  Type.Object(
    {
      present: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      present: Type.Literal(true),
      valueJson: Type.String({ minLength: 1, maxLength: 32_768 }),
    },
    { additionalProperties: false },
  ),
]);

const ApprovalConfigurationChangeSchema = Type.Object(
  {
    key: Type.String({
      minLength: 1,
      maxLength: 500,
      pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$",
    }),
    scope: Type.Object(
      {
        kind: ConfigurationScopeKindSchema,
        id: OpaqueIdSchema,
      },
      { additionalProperties: false },
    ),
    before: ApprovalValuePreviewSchema,
    after: ApprovalValuePreviewSchema,
  },
  { additionalProperties: false },
);

const ApprovalConfigurationPreviewSchema = Type.Object(
  {
    proposalId: OpaqueIdSchema,
    baseRevision: Type.Integer({ minimum: 0 }),
    changes: Type.Array(ApprovalConfigurationChangeSchema, {
      minItems: 1,
      maxItems: 256,
    }),
  },
  { additionalProperties: false },
);

const ApprovalActionSchema = Type.Object(
  {
    category: ApprovalActionCategorySchema,
    type: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    }),
    fingerprint: Type.String({
      pattern: "^sha256:[a-f0-9]{64}$",
    }),
    targetDeviceId: Type.Optional(OpaqueIdSchema),
    taskId: Type.Optional(OpaqueIdSchema),
    resource: Type.String({ minLength: 1, maxLength: 1_024 }),
  },
  { additionalProperties: false },
);

const ApprovalDecisionProjectionSchema = Type.Union([
  Type.Object(
    {
      decision: Type.Literal("approve"),
      scope: ApprovalGrantScopeSchema,
      decidedBy: OpaqueIdSchema,
      decidedAt: Rfc3339InstantSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      decision: Type.Literal("deny"),
      reason: Type.String({ minLength: 1, maxLength: 2_000 }),
      decidedBy: OpaqueIdSchema,
      decidedAt: Rfc3339InstantSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ApprovalDetailSchema = Type.Object(
  {
    approvalId: OpaqueIdSchema,
    state: ApprovalStateSchema,
    executionStatus: ApprovalExecutionStatusSchema,
    requestedAt: Rfc3339InstantSchema,
    expiresAt: Rfc3339InstantSchema,
    action: ApprovalActionSchema,
    reason: Type.String({ minLength: 1, maxLength: 4_096 }),
    target: Type.String({ minLength: 1, maxLength: 1_024 }),
    risk: ApprovalRiskSchema,
    evidence: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
      maxItems: 64,
    }),
    configuration: Type.Optional(ApprovalConfigurationPreviewSchema),
    decision: Type.Optional(ApprovalDecisionProjectionSchema),
    executionErrorCode: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 160,
        pattern: "^[A-Z][A-Z0-9_]*$",
      }),
    ),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateApprovalDetailV1",
  },
);

export type ApprovalDetailV1 = Type.Static<typeof ApprovalDetailSchema>;

export const ApprovalListResponseSchema = Type.Object(
  {
    approvals: Type.Array(ApprovalDetailSchema, { maxItems: 10_000 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateApprovalListResponseV1",
  },
);

export type ApprovalListResponseV1 = Type.Static<typeof ApprovalListResponseSchema>;

export const ApprovalParamsSchema = Type.Object(
  {
    approvalId: OpaqueIdSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateApprovalParamsV1",
  },
);

export type ApprovalParamsV1 = Type.Static<typeof ApprovalParamsSchema>;

export const ApprovalDecisionRequestSchema = Type.Union(
  [
    Type.Object(
      {
        decision: Type.Literal("approve"),
        scope: ApprovalGrantScopeSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        decision: Type.Literal("deny"),
        reason: Type.String({ minLength: 1, maxLength: 2_000 }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    $id: "OpenDelegateApprovalDecisionRequestV1",
  },
);

export type ApprovalDecisionRequestV1 = Type.Static<typeof ApprovalDecisionRequestSchema>;
