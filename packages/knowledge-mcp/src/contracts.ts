export const KNOWLEDGE_MCP_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;

export type KnowledgeMcpProtocolVersion = (typeof KNOWLEDGE_MCP_PROTOCOL_VERSIONS)[number];

export const KNOWLEDGE_TOOL_NAMES = [
  "knowledge_search",
  "knowledge_open",
  "knowledge_relationships",
  "knowledge_upsert",
] as const;

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

export interface KnowledgeRunAuthority {
  readonly taskId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly deviceId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs: number;
}

export interface KnowledgeToolContext {
  /**
   * Exact immutable authority supplied by the Worker Run capability broker.
   * The MCP process cannot create, widen, renew, or replace it.
   */
  readonly authority: KnowledgeRunAuthority;
  readonly signal: AbortSignal;
}

export interface KnowledgeSearchInput {
  readonly query: string;
  readonly limit?: number;
}

export interface KnowledgeCandidate {
  readonly noteId: string;
  readonly title: string;
  readonly preview: string;
}

export interface KnowledgeOpenInput {
  readonly noteIds: readonly string[];
  readonly totalCharacterBudget: number;
}

export interface OpenedKnowledgeNote {
  readonly noteId: string;
  readonly title: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface OpenedKnowledge {
  readonly characterBudget: number;
  readonly usedCharacters: number;
  readonly notes: readonly OpenedKnowledgeNote[];
  readonly omittedNoteIds: readonly string[];
}

export interface KnowledgeRelationshipsInput {
  readonly noteId: string;
}

export interface KnowledgeRelationships {
  readonly outgoing: readonly string[];
  readonly backlinks: readonly string[];
}

export type KnowledgeContentKind =
  | "durable-device-knowledge"
  | "credential"
  | "raw-transcript"
  | "raw-log"
  | "temporary-task-state"
  | "common-fact";

export interface KnowledgeQualification {
  readonly deviceSpecific: boolean;
  readonly repeatedlyUseful: boolean;
  readonly expensiveToRediscover: boolean;
  readonly actionable: boolean;
}

export interface KnowledgeUpsertInput {
  readonly noteId: string;
  readonly contentKind: KnowledgeContentKind;
  readonly content: string;
  readonly qualification: KnowledgeQualification;
}

export interface KnowledgeUpsertResult {
  readonly noteId: string;
  readonly operation: "created" | "updated";
}

/**
 * Device-local execution seam owned by the Worker capability provider.
 *
 * Each method must revalidate the exact Task/Work Order/Run/Device/lease/fence
 * before touching LocalKnowledgeService. Tool inputs and results remain inside
 * this authenticated local connection.
 */
export interface KnowledgeToolPort {
  search(
    context: KnowledgeToolContext,
    input: KnowledgeSearchInput,
  ): Promise<readonly KnowledgeCandidate[]>;
  open(context: KnowledgeToolContext, input: KnowledgeOpenInput): Promise<OpenedKnowledge>;
  relationships(
    context: KnowledgeToolContext,
    input: KnowledgeRelationshipsInput,
  ): Promise<KnowledgeRelationships>;
  upsert(
    context: KnowledgeToolContext,
    input: KnowledgeUpsertInput,
  ): Promise<KnowledgeUpsertResult>;
}

export type KnowledgeToolPortErrorCode =
  | "BUDGET_EXHAUSTED"
  | "CANCELLED"
  | "FAILED"
  | "NOT_READY"
  | "STALE_AUTHORITY"
  | "STALE_LEASE"
  | "TIMEOUT";

export class KnowledgeToolPortError extends Error {
  public readonly code: KnowledgeToolPortErrorCode;

  public constructor(code: KnowledgeToolPortErrorCode) {
    super("The device-local Knowledge execution port rejected the operation.");
    this.name = "KnowledgeToolPortError";
    this.code = code;
  }
}

export interface KnowledgeMcpLimits {
  readonly maxInputLineBytes?: number;
  readonly maxOutputLineBytes?: number;
  readonly maxInFlightToolCalls?: number;
  readonly toolTimeoutMs?: number;
  readonly maxCumulativeSearchCandidates?: number;
  readonly maxCumulativeOpenCharacters?: number;
  readonly maxCumulativeContextCharacters?: number;
}

export interface KnowledgeMcpServerInfo {
  readonly name: string;
  readonly version: string;
}

export type KnowledgeMcpDiagnosticCode =
  | "budget_exhausted"
  | "input_rejected"
  | "port_failure"
  | "port_result_rejected"
  | "request_cancelled"
  | "request_timed_out";

export interface KnowledgeMcpDiagnostic {
  readonly level: "warning" | "error";
  readonly event: "knowledge_mcp.input" | "knowledge_mcp.tool";
  readonly code: KnowledgeMcpDiagnosticCode;
  readonly tool?: KnowledgeToolName;
}

export interface KnowledgeMcpServerOptions {
  readonly authority: KnowledgeRunAuthority;
  readonly port: KnowledgeToolPort;
  readonly limits?: KnowledgeMcpLimits;
  readonly serverInfo?: KnowledgeMcpServerInfo;
  readonly diagnostic?: (event: KnowledgeMcpDiagnostic) => void;
}
