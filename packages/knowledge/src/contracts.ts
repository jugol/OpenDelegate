export interface LocalKnowledgeConfig {
  readonly root: string;
  readonly maxSearchCandidates?: number;
  readonly maxCandidatePreviewCharacters?: number;
  readonly maxOpenCharacters?: number;
  readonly maxNoteCharacters?: number;
  readonly knownSecretValues?: readonly string[];
}

export interface KnowledgeHealth {
  readonly status: "not-ready" | "ready";
}

export interface KnowledgeRelationships {
  readonly outgoing: readonly string[];
  readonly backlinks: readonly string[];
}

export interface KnowledgeSearchOptions {
  readonly limit?: number;
}

export interface KnowledgeCandidate {
  readonly noteId: string;
  readonly title: string;
  readonly preview: string;
}

export interface OpenKnowledgeOptions {
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

export interface UpsertKnowledgeNote {
  readonly noteId: string;
  readonly contentKind: KnowledgeContentKind;
  readonly content: string;
  readonly qualification: KnowledgeQualification;
}

export interface UpsertKnowledgeResult {
  readonly noteId: string;
  readonly operation: "created" | "updated";
}
