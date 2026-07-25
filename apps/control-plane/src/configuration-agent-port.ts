import type { ConfigurationAgentMessageResponseV1 } from "@opendelegate/protocol";

export interface ConfigurationAgentMessageInput {
  readonly deviceId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly message: string;
}

export interface ConfigurationAgentPort {
  sendMessage(input: ConfigurationAgentMessageInput): Promise<ConfigurationAgentMessageResponseV1>;
}

export type ConfigurationAgentPortErrorCode =
  | "CONFIGURATION_AGENT_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "SECRET_MATERIAL_REQUIRES_SECURE_INGEST";

export class ConfigurationAgentPortError extends Error {
  readonly code: ConfigurationAgentPortErrorCode;

  constructor(code: ConfigurationAgentPortErrorCode, message: string) {
    super(message);
    this.name = "ConfigurationAgentPortError";
    this.code = code;
  }
}
