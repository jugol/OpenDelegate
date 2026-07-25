import Type from "typebox";

import { CorrelationIdSchema, OpaqueIdSchema, Rfc3339InstantSchema } from "./common.ts";

const Sha256DigestSchema = Type.String({
  minLength: 71,
  maxLength: 71,
  pattern: "^sha256:[a-f0-9]{64}$",
});

export const RouteIncidentAuditDetailSchema = Type.Object(
  {
    incidentId: Sha256DigestSchema,
    fingerprint: Sha256DigestSchema,
    profileRevision: Sha256DigestSchema,
    recommendation: Type.String({ minLength: 1, maxLength: 2_048 }),
    ownerQuestion: Type.String({ minLength: 1, maxLength: 1_024 }),
    source: Type.Union([Type.Literal("agent"), Type.Literal("deterministic-fallback")]),
    reasonCode: Type.Union([
      Type.Literal("AGENT_COMPLETED"),
      Type.Literal("AGENT_UNAVAILABLE"),
      Type.Literal("DIAGNOSIS_INTERRUPTED"),
    ]),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateRouteIncidentAuditDetailV1",
  },
);

export const AuditEventSummarySchema = Type.Object(
  {
    auditId: OpaqueIdSchema,
    source: Type.Union([
      Type.Literal("task"),
      Type.Literal("artifact"),
      Type.Literal("action-authorization"),
      Type.Literal("device-identity"),
      Type.Literal("owner-auth"),
      Type.Literal("configuration"),
      Type.Literal("approval"),
      Type.Literal("runtime"),
    ]),
    type: Type.String({
      minLength: 3,
      maxLength: 160,
      pattern: "^[a-z][a-z0-9.-]*$",
    }),
    occurredAt: Rfc3339InstantSchema,
    outcome: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("denied"),
      Type.Literal("failed"),
      Type.Literal("recorded"),
    ]),
    actorId: Type.Optional(OpaqueIdSchema),
    subjectId: Type.Optional(OpaqueIdSchema),
    correlationId: Type.Optional(CorrelationIdSchema),
    taskId: Type.Optional(OpaqueIdSchema),
    runId: Type.Optional(OpaqueIdSchema),
    deviceId: Type.Optional(OpaqueIdSchema),
    artifactId: Type.Optional(OpaqueIdSchema),
    reasonCode: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Z][A-Z0-9_]*$",
      }),
    ),
    routeIncident: Type.Optional(RouteIncidentAuditDetailSchema),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateAuditEventSummaryV1",
  },
);

export const AuditEventListResponseSchema = Type.Object(
  {
    events: Type.Array(AuditEventSummarySchema, { maxItems: 100_000 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateAuditEventListResponseV1",
  },
);

export type AuditEventSummaryV1 = Type.Static<typeof AuditEventSummarySchema>;
export type AuditEventListResponseV1 = Type.Static<typeof AuditEventListResponseSchema>;
export type RouteIncidentAuditDetailV1 = Type.Static<typeof RouteIncidentAuditDetailSchema>;
