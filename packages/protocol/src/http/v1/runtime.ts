import Type from "typebox";

const RuntimeFeatureSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready"), Type.Literal("unavailable")]),
    code: Type.String({
      minLength: 3,
      maxLength: 96,
      pattern: "^[A-Z][A-Z0-9_]*$",
    }),
  },
  { additionalProperties: false },
);

const ReleaseVerificationCodeSchema = Type.String({
  minLength: 3,
  maxLength: 96,
  pattern: "^[A-Z][A-Z0-9_]*$",
});

const NotApplicableReleaseVerificationSchema = Type.Object(
  {
    status: Type.Literal("not-applicable"),
  },
  { additionalProperties: false },
);

const CandidateReleaseVerificationSchema = Type.Union([
  Type.Object(
    {
      status: Type.Union([Type.Literal("absent"), Type.Literal("publisher-verified")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Union([
        Type.Literal("invalid"),
        Type.Literal("promotion-invalid"),
        Type.Literal("revoked"),
      ]),
      code: ReleaseVerificationCodeSchema,
    },
    { additionalProperties: false },
  ),
]);

const RuntimeFeatureProperties = {
  taskExecution: RuntimeFeatureSchema,
  configurationAgent: RuntimeFeatureSchema,
  discord: RuntimeFeatureSchema,
} as const;

export const RuntimeFeaturesResponseSchema = Type.Union(
  [
    Type.Object(
      {
        declaredReleaseChannel: Type.Literal("development"),
        releaseChannel: Type.Literal("development"),
        releaseVerification: NotApplicableReleaseVerificationSchema,
        ...RuntimeFeatureProperties,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        declaredReleaseChannel: Type.Literal("internal-preview"),
        releaseChannel: Type.Literal("internal-preview"),
        releaseVerification: NotApplicableReleaseVerificationSchema,
        ...RuntimeFeatureProperties,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        declaredReleaseChannel: Type.Literal("release-candidate"),
        releaseChannel: Type.Literal("release-candidate"),
        releaseVerification: CandidateReleaseVerificationSchema,
        ...RuntimeFeatureProperties,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        declaredReleaseChannel: Type.Literal("release-candidate"),
        releaseChannel: Type.Literal("released"),
        releaseVerification: Type.Object(
          {
            status: Type.Literal("released"),
          },
          { additionalProperties: false },
        ),
        ...RuntimeFeatureProperties,
      },
      { additionalProperties: false },
    ),
  ],
  {
    $id: "OpenDelegateRuntimeFeaturesResponseV1",
  },
);

export type RuntimeFeaturesResponseV1 = Type.Static<typeof RuntimeFeaturesResponseSchema>;
