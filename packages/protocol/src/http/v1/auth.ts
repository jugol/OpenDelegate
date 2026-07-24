import Type from "typebox";

import { OpaqueIdSchema, Rfc3339InstantSchema } from "./common.ts";

const PassphraseSchema = Type.String({
  minLength: 12,
  maxLength: 1024,
});

const ClaimTokenSchema = Type.String({
  minLength: 43,
  maxLength: 43,
  pattern: "^[A-Za-z0-9_-]{43}$",
});

const SessionTokenDerivativeSchema = Type.String({
  minLength: 43,
  maxLength: 43,
  pattern: "^[A-Za-z0-9_-]{43}$",
});

const RecoveryCodeSchema = Type.String({
  minLength: 26,
  maxLength: 26,
  pattern: "^odr_[A-Za-z0-9_-]{22}$",
});

export const OwnerClaimRequestSchema = Type.Object(
  {
    claimToken: ClaimTokenSchema,
    passphrase: PassphraseSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateOwnerClaimRequestV1",
  },
);

export type OwnerClaimRequestV1 = Type.Static<typeof OwnerClaimRequestSchema>;

export const OwnerClaimResponseSchema = Type.Object(
  {
    ownerId: OpaqueIdSchema,
    recoveryCodes: Type.Array(RecoveryCodeSchema, {
      minItems: 10,
      maxItems: 10,
      uniqueItems: true,
    }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateOwnerClaimResponseV1",
  },
);

export type OwnerClaimResponseV1 = Type.Static<typeof OwnerClaimResponseSchema>;

export const OwnerLoginRequestSchema = Type.Object(
  {
    passphrase: PassphraseSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateOwnerLoginRequestV1",
  },
);

export type OwnerLoginRequestV1 = Type.Static<typeof OwnerLoginRequestSchema>;

const BrowserSessionProperties = {
  sessionId: OpaqueIdSchema,
  ownerId: OpaqueIdSchema,
  createdAt: Rfc3339InstantSchema,
  authenticatedAt: Rfc3339InstantSchema,
  lastUsedAt: Rfc3339InstantSchema,
  idleExpiresAt: Rfc3339InstantSchema,
  absoluteExpiresAt: Rfc3339InstantSchema,
} as const;

export const BrowserSessionSchema = Type.Object(BrowserSessionProperties, {
  additionalProperties: false,
  $id: "OpenDelegateBrowserSessionV1",
});

export type BrowserSessionV1 = Type.Static<typeof BrowserSessionSchema>;

export const OwnerSessionResponseSchema = Type.Object(
  {
    csrfToken: SessionTokenDerivativeSchema,
    session: BrowserSessionSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateOwnerSessionResponseV1",
  },
);

export type OwnerSessionResponseV1 = Type.Static<typeof OwnerSessionResponseSchema>;

export const BrowserSessionSummarySchema = Type.Object(
  {
    ...BrowserSessionProperties,
    current: Type.Boolean(),
    expired: Type.Boolean(),
    revokedAt: Type.Optional(Rfc3339InstantSchema),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateBrowserSessionSummaryV1",
  },
);

export const OwnerSessionListResponseSchema = Type.Object(
  {
    sessions: Type.Array(BrowserSessionSummarySchema, { maxItems: 256 }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateOwnerSessionListResponseV1",
  },
);

export type OwnerSessionListResponseV1 = Type.Static<typeof OwnerSessionListResponseSchema>;

export const RevokeSessionParamsSchema = Type.Object(
  {
    sessionId: OpaqueIdSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateRevokeSessionParamsV1",
  },
);

export type RevokeSessionParamsV1 = Type.Static<typeof RevokeSessionParamsSchema>;

export const RecoveryBeginRequestSchema = Type.Object(
  {
    recoveryCode: RecoveryCodeSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateRecoveryBeginRequestV1",
  },
);

export type RecoveryBeginRequestV1 = Type.Static<typeof RecoveryBeginRequestSchema>;

export const RecoveryBeginResponseSchema = Type.Object(
  {
    recoveryToken: SessionTokenDerivativeSchema,
    expiresAt: Rfc3339InstantSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateRecoveryBeginResponseV1",
  },
);

export type RecoveryBeginResponseV1 = Type.Static<typeof RecoveryBeginResponseSchema>;

export const RecoveryCompleteRequestSchema = Type.Object(
  {
    recoveryToken: SessionTokenDerivativeSchema,
    newPassphrase: PassphraseSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateRecoveryCompleteRequestV1",
  },
);

export type RecoveryCompleteRequestV1 = Type.Static<typeof RecoveryCompleteRequestSchema>;

export const RecoveryCompleteResponseSchema = OwnerClaimResponseSchema;

export type RecoveryCompleteResponseV1 = Type.Static<typeof RecoveryCompleteResponseSchema>;
