import Type from "typebox";

import { OpaqueIdSchema, Rfc3339InstantSchema } from "./common.ts";

const Sha256Schema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[0-9a-f]{64}$",
});

export const ArtifactParamsSchema = Type.Object(
  { artifactId: OpaqueIdSchema },
  { additionalProperties: false },
);

const ArtifactRetentionPolicySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("temporary"),
      expiresAt: Rfc3339InstantSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("task") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("pinned") }, { additionalProperties: false }),
]);

const ArtifactExposurePolicySchema = Type.Union([
  Type.Object(
    {
      mode: Type.Union([
        Type.Literal("private-network"),
        Type.Literal("authenticated"),
        Type.Literal("signed-link"),
        Type.Literal("public"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal("custom"),
      customPolicyId: OpaqueIdSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ArtifactDetailSchema = Type.Object(
  {
    artifactId: OpaqueIdSchema,
    taskId: OpaqueIdSchema,
    producingRunId: OpaqueIdSchema,
    mediaType: Type.String({ minLength: 3, maxLength: 256 }),
    originalFilename: Type.String({ minLength: 1, maxLength: 253 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    checksum: Type.Object(
      {
        algorithm: Type.Literal("sha256"),
        value: Sha256Schema,
      },
      { additionalProperties: false },
    ),
    createdAt: Rfc3339InstantSchema,
    retentionPolicy: ArtifactRetentionPolicySchema,
    exposurePolicy: ArtifactExposurePolicySchema,
    provenance: Type.Object(
      {
        deviceId: OpaqueIdSchema,
        source: Type.String({ minLength: 1, maxLength: 256 }),
        workspaceId: Type.Optional(OpaqueIdSchema),
      },
      { additionalProperties: false },
    ),
    presentation: Type.Union([
      Type.Literal("inline"),
      Type.Literal("download"),
      Type.Literal("static-html"),
      Type.Literal("interactive-html"),
    ]),
    state: Type.Union([
      Type.Literal("available"),
      Type.Literal("expired"),
      Type.Literal("revoked"),
    ]),
    pinnedAt: Type.Optional(Rfc3339InstantSchema),
    revokedAt: Type.Optional(Rfc3339InstantSchema),
    expiredAt: Type.Optional(Rfc3339InstantSchema),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateArtifactDetailV1",
  },
);

export const ArtifactListResponseSchema = Type.Object(
  {
    artifacts: Type.Array(ArtifactDetailSchema, { maxItems: 100_000 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateArtifactListResponseV1",
  },
);

export const ArtifactOpenInstructionSchema = Type.Union(
  [
    Type.Object(
      {
        method: Type.Literal("GET"),
        href: Type.String({ minLength: 8, maxLength: 4_096 }),
        artifactId: OpaqueIdSchema,
        expiresAt: Type.Optional(Rfc3339InstantSchema),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        method: Type.Literal("POST"),
        actionUrl: Type.String({ minLength: 8, maxLength: 4_096 }),
        fieldName: Type.Literal("grant"),
        fieldValue: Type.String({
          minLength: 43,
          maxLength: 2_048,
          pattern: "^[A-Za-z0-9._~-]+$",
        }),
        artifactId: OpaqueIdSchema,
        expiresAt: Rfc3339InstantSchema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: "OpenDelegateArtifactOpenInstructionV1" },
);

export type ArtifactParamsV1 = Type.Static<typeof ArtifactParamsSchema>;
export type ArtifactDetailV1 = Type.Static<typeof ArtifactDetailSchema>;
export type ArtifactListResponseV1 = Type.Static<typeof ArtifactListResponseSchema>;
export type ArtifactOpenInstructionV1 = Type.Static<typeof ArtifactOpenInstructionSchema>;
