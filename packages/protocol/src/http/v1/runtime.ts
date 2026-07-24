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

export const RuntimeFeaturesResponseSchema = Type.Object(
  {
    releaseChannel: Type.Union([
      Type.Literal("development"),
      Type.Literal("internal-preview"),
      Type.Literal("release-candidate"),
      Type.Literal("released"),
    ]),
    taskExecution: RuntimeFeatureSchema,
    configurationAgent: RuntimeFeatureSchema,
    discord: RuntimeFeatureSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateRuntimeFeaturesResponseV1",
  },
);

export type RuntimeFeaturesResponseV1 = Type.Static<typeof RuntimeFeaturesResponseSchema>;
