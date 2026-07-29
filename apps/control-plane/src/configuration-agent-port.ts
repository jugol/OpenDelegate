import type {
  ConfigurationAgentConversationResponseV1,
  ConfigurationAgentMessageResponseV1,
  DeviceSummaryV1,
} from "@opendelegate/protocol";

export interface ConfigurationDeviceObservation {
  readonly name: string;
  readonly osFamily: DeviceSummaryV1["osFamily"];
  readonly platformRelease: string;
  readonly architecture: string;
  readonly role: DeviceSummaryV1["role"];
  readonly observedAtMs?: number;
  readonly capabilities: NonNullable<DeviceSummaryV1["capabilities"]>;
  readonly agentAdapters: NonNullable<DeviceSummaryV1["agentAdapters"]>;
  readonly agentExecutionProfile?: DeviceSummaryV1["agentExecutionProfile"];
  readonly coordinatorAgentExecutionProfile?: DeviceSummaryV1["coordinatorAgentExecutionProfile"];
  readonly knowledgeHealth: NonNullable<DeviceSummaryV1["knowledgeHealth"]>;
}

export interface ConfigurationAgentMessageInput {
  readonly deviceId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly message: string;
  readonly deviceObservation?: ConfigurationDeviceObservation;
}

export interface ConfigurationAgentPort {
  sendMessage(input: ConfigurationAgentMessageInput): Promise<ConfigurationAgentMessageResponseV1>;
  listMessages?(input: {
    readonly deviceId: string;
    readonly principalId: string;
  }): Promise<ConfigurationAgentConversationResponseV1>;
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
