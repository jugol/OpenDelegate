import Type from "typebox";

import { OpaqueIdSchema, Rfc3339InstantSchema } from "./common.ts";

const HttpUrlSchema = Type.String({
  minLength: 8,
  maxLength: 2_048,
  pattern: "^https://",
});

const WebSocketUrlSchema = Type.String({
  minLength: 7,
  maxLength: 2_048,
  pattern: "^wss://",
});

const MainSpkiFingerprintSchema = Type.String({
  minLength: 50,
  maxLength: 50,
  pattern: "^sha256:[A-Za-z0-9_-]{43}$",
});

export const EnrollmentChannelEndpointSchema = Type.Union([
  Type.Object(
    {
      endpointId: OpaqueIdSchema,
      label: Type.String({ minLength: 1, maxLength: 256 }),
      kind: Type.Literal("https"),
      url: HttpUrlSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      endpointId: OpaqueIdSchema,
      label: Type.String({ minLength: 1, maxLength: 256 }),
      kind: Type.Literal("wss"),
      url: WebSocketUrlSchema,
    },
    { additionalProperties: false },
  ),
]);

export const EnrollmentGrantSummarySchema = Type.Object(
  {
    grantId: OpaqueIdSchema,
    deviceId: OpaqueIdSchema,
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("consumed"),
      Type.Literal("expired"),
      Type.Literal("revoked"),
    ]),
    allowedBootstrapRoles: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    createdAt: Rfc3339InstantSchema,
    expiresAt: Rfc3339InstantSchema,
    consumedAt: Type.Optional(Rfc3339InstantSchema),
  },
  { additionalProperties: false },
);

export const DeviceEnrollmentOverviewSchema = Type.Object(
  {
    available: Type.Boolean(),
    mainDeviceId: Type.Optional(OpaqueIdSchema),
    expectedMainSpkiSha256: Type.Optional(MainSpkiFingerprintSchema),
    enrollmentUrl: Type.Optional(HttpUrlSchema),
    channelEndpoints: Type.Optional(
      Type.Array(EnrollmentChannelEndpointSchema, { maxItems: 16, uniqueItems: true }),
    ),
    grants: Type.Array(EnrollmentGrantSummarySchema, { maxItems: 10_000 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateDeviceEnrollmentOverviewV1",
  },
);

export const IssueEnrollmentGrantRequestSchema = Type.Object(
  {
    deviceId: OpaqueIdSchema,
    expiresInSeconds: Type.Integer({ minimum: 30, maximum: 1_800 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateIssueEnrollmentGrantRequestV1",
  },
);

export const EnrollmentGrantDocumentSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    grantId: OpaqueIdSchema,
    token: Type.String({
      minLength: 43,
      maxLength: 256,
      pattern: "^[A-Za-z0-9_-]+$",
    }),
    deviceId: OpaqueIdSchema,
    mainDeviceId: OpaqueIdSchema,
    expectedMainSpkiSha256: MainSpkiFingerprintSchema,
    certificateAuthorityPem: Type.String({ minLength: 64, maxLength: 32_768 }),
    enrollmentUrl: HttpUrlSchema,
    channelEndpoints: Type.Array(EnrollmentChannelEndpointSchema, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    protocolRange: Type.Object(
      {
        minimum: Type.Integer({ minimum: 1, maximum: 65_535 }),
        maximum: Type.Integer({ minimum: 1, maximum: 65_535 }),
      },
      { additionalProperties: false },
    ),
    expiresAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const IssueEnrollmentGrantResponseSchema = Type.Object(
  {
    summary: EnrollmentGrantSummarySchema,
    suggestedFilename: Type.String({
      minLength: 1,
      maxLength: 253,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*\\.json$",
    }),
    document: EnrollmentGrantDocumentSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateIssueEnrollmentGrantResponseV1",
  },
);

export type EnrollmentChannelEndpointV1 = Type.Static<typeof EnrollmentChannelEndpointSchema>;
export type EnrollmentGrantSummaryV1 = Type.Static<typeof EnrollmentGrantSummarySchema>;
export type DeviceEnrollmentOverviewV1 = Type.Static<typeof DeviceEnrollmentOverviewSchema>;
export type IssueEnrollmentGrantRequestV1 = Type.Static<typeof IssueEnrollmentGrantRequestSchema>;
export type EnrollmentGrantDocumentV1 = Type.Static<typeof EnrollmentGrantDocumentSchema>;
export type IssueEnrollmentGrantResponseV1 = Type.Static<typeof IssueEnrollmentGrantResponseSchema>;
