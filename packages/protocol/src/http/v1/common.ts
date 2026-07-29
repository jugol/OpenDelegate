import Type from "typebox";

export const CorrelationIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const Rfc3339InstantSchema = Type.String({
  minLength: 20,
  maxLength: 35,
  format: "date-time",
});

export const OpaqueIdSchema = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const ProblemDetailsSchema = Type.Object(
  {
    type: Type.String({ minLength: 1, maxLength: 512 }),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    code: Type.String({
      minLength: 3,
      maxLength: 96,
      pattern: "^[A-Z][A-Z0-9_]*$",
    }),
    correlationId: CorrelationIdSchema,
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    diagnosticCode: Type.Optional(
      Type.String({
        minLength: 2,
        maxLength: 128,
        pattern: "^[A-Z][A-Z0-9_]*$",
      }),
    ),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateProblemDetailsV1",
  },
);

export type ProblemDetailsV1 = Type.Static<typeof ProblemDetailsSchema>;

export const LiveHealthSchema = Type.Object(
  {
    status: Type.Literal("ok"),
    service: Type.Literal("opendelegate-main"),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    buildId: Type.String({ minLength: 7, maxLength: 128 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateLiveHealthV1",
  },
);

export type LiveHealthV1 = Type.Static<typeof LiveHealthSchema>;

export const ReadinessCheckSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready"), Type.Literal("not-ready")]),
    code: Type.String({
      minLength: 3,
      maxLength: 96,
      pattern: "^[A-Z][A-Z0-9_]*$",
    }),
  },
  { additionalProperties: false },
);

export const ReadinessSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready"), Type.Literal("not-ready")]),
    checks: Type.Array(ReadinessCheckSchema, { maxItems: 32 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateReadinessV1",
  },
);

export type ReadinessV1 = Type.Static<typeof ReadinessSchema>;
