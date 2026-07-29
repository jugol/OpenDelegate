import Type from "typebox";

import { OpaqueIdSchema, Rfc3339InstantSchema } from "./common.ts";

export const ConfigurationAgentMessageParamsSchema = Type.Object(
  {
    deviceId: OpaqueIdSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateConfigurationAgentMessageParamsV1",
  },
);

export type ConfigurationAgentMessageParamsV1 = Type.Static<
  typeof ConfigurationAgentMessageParamsSchema
>;

export const ConfigurationAgentMessageRequestSchema = Type.Object(
  {
    message: Type.String({
      minLength: 1,
      maxLength: 8_192,
    }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateConfigurationAgentMessageRequestV1",
  },
);

export type ConfigurationAgentMessageRequestV1 = Type.Static<
  typeof ConfigurationAgentMessageRequestSchema
>;

export const ConfigurationAgentSuggestedActionSchema = Type.Union([
  Type.Literal("guide-discord"),
  Type.Literal("guide-external-postgresql"),
  Type.Literal("ingest-discord-bot-token"),
  Type.Literal("ingest-database-uri"),
]);

export type ConfigurationAgentSuggestedActionV1 = Type.Static<
  typeof ConfigurationAgentSuggestedActionSchema
>;

export const ConfigurationAgentMessageResponseSchema = Type.Object(
  {
    messageId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    content: Type.String({
      minLength: 1,
      maxLength: 32_768,
    }),
    suggestedActions: Type.Optional(
      Type.Array(ConfigurationAgentSuggestedActionSchema, {
        maxItems: 4,
        uniqueItems: true,
      }),
    ),
    pendingApprovalId: Type.Optional(OpaqueIdSchema),
    occurredAt: Rfc3339InstantSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateConfigurationAgentMessageResponseV1",
  },
);

export type ConfigurationAgentMessageResponseV1 = Type.Static<
  typeof ConfigurationAgentMessageResponseSchema
>;

export const ConfigurationAgentConversationMessageSchema = Type.Union(
  [
    Type.Object(
      {
        messageId: OpaqueIdSchema,
        role: Type.Literal("owner"),
        content: Type.String({
          minLength: 1,
          maxLength: 32_768,
        }),
        responseStatus: Type.Optional(
          Type.Union([
            Type.Literal("completed"),
            Type.Literal("interrupted"),
            Type.Literal("pending"),
          ]),
        ),
        occurredAt: Rfc3339InstantSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        messageId: OpaqueIdSchema,
        role: Type.Literal("agent"),
        content: Type.String({
          minLength: 1,
          maxLength: 32_768,
        }),
        suggestedActions: Type.Optional(
          Type.Array(ConfigurationAgentSuggestedActionSchema, {
            maxItems: 4,
            uniqueItems: true,
          }),
        ),
        pendingApprovalId: Type.Optional(OpaqueIdSchema),
        occurredAt: Rfc3339InstantSchema,
      },
      { additionalProperties: false },
    ),
  ],
  {
    $id: "OpenDelegateConfigurationAgentConversationMessageV1",
  },
);

export type ConfigurationAgentConversationMessageV1 = Type.Static<
  typeof ConfigurationAgentConversationMessageSchema
>;

export const ConfigurationAgentConversationResponseSchema = Type.Object(
  {
    messages: Type.Array(ConfigurationAgentConversationMessageSchema, {
      maxItems: 2_000,
    }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateConfigurationAgentConversationResponseV1",
  },
);

export type ConfigurationAgentConversationResponseV1 = Type.Static<
  typeof ConfigurationAgentConversationResponseSchema
>;
