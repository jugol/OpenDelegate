export type KnowledgeErrorCode =
  | "KNOWLEDGE_CREDENTIAL_REJECTED"
  | "KNOWLEDGE_RAW_TRANSCRIPT_REJECTED"
  | "KNOWLEDGE_RAW_LOG_REJECTED"
  | "KNOWLEDGE_TEMPORARY_TASK_STATE_REJECTED"
  | "KNOWLEDGE_COMMON_FACT_REJECTED"
  | "KNOWLEDGE_CONTENT_TOO_LARGE"
  | "KNOWLEDGE_NOT_DURABLE"
  | "KNOWLEDGE_PATH_INVALID"
  | "KNOWLEDGE_NOTE_NOT_FOUND";

export class KnowledgeError extends Error {
  public readonly code: KnowledgeErrorCode;

  public constructor(code: KnowledgeErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeError";
    this.code = code;
  }
}
