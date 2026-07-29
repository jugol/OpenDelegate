import Type from "typebox";

export const SecureSecretIngestPurposeSchema = Type.Union(
  [
    Type.Literal("api-token"),
    Type.Literal("database-uri"),
    Type.Literal("discord-bot-token"),
    Type.Literal("private-key"),
    Type.Literal("service-credential"),
  ],
  {
    $id: "OpenDelegateSecureSecretIngestPurposeV1",
  },
);

export type SecureSecretIngestPurposeV1 = Type.Static<typeof SecureSecretIngestPurposeSchema>;

export const SecureSecretIngestRequestSchema = Type.Object(
  {
    purpose: SecureSecretIngestPurposeSchema,
    secretBase64: Type.String({
      minLength: 4,
      maxLength: 87_384,
      pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
    }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateSecureSecretIngestRequestV1",
  },
);

export type SecureSecretIngestRequestV1 = Type.Static<typeof SecureSecretIngestRequestSchema>;

export const SecureSecretIngestReceiptSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    secretRef: Type.String({
      minLength: 15,
      maxLength: 142,
      pattern: "^secret://main/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$",
    }),
    availability: Type.Literal("ready"),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateSecureSecretIngestReceiptV1",
  },
);

export type SecureSecretIngestReceiptV1 = Type.Static<typeof SecureSecretIngestReceiptSchema>;
