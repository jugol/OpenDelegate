import type {
  ArtifactExposurePolicy,
  ArtifactRetentionPolicy,
  ArtifactState,
} from "@opendelegate/domain";

export type { ArtifactExposureMode } from "@opendelegate/domain";
export type { ArtifactExposurePolicy, ArtifactRetentionPolicy, ArtifactState };

export type ArtifactPresentation = "inline" | "download" | "static-html" | "interactive-html";

export interface ArtifactClock {
  nowMs(): number;
}

export interface ArtifactRandomSource {
  bytes(length: number): Uint8Array;
}

export interface ArtifactActor {
  readonly type: "owner" | "main-agent" | "worker-agent" | "system" | "device";
  readonly id: string;
}

export interface ArtifactMutationContext {
  readonly actor: ArtifactActor;
  readonly correlationId: string;
}

export interface ArtifactChecksum {
  readonly algorithm: "sha256";
  readonly value: string;
}

export interface StoredArtifactProvenance {
  readonly deviceId: string;
  readonly source: string;
  readonly workspaceId?: string;
}

export interface StoredArtifactMetadata {
  readonly artifactId: string;
  readonly taskId: string;
  readonly producingRunId: string;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly checksum: ArtifactChecksum;
  readonly createdAtMs: number;
  readonly retentionPolicy: ArtifactRetentionPolicy;
  readonly exposurePolicy: ArtifactExposurePolicy;
  readonly provenance: StoredArtifactProvenance;
  readonly presentation: ArtifactPresentation;
  readonly state: ArtifactState;
  readonly pinnedAtMs?: number;
  readonly revokedAtMs?: number;
  readonly expiredAtMs?: number;
}

export interface PutArtifact {
  readonly artifactId: string;
  readonly taskId: string;
  readonly producingRunId: string;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly bytes: Uint8Array;
  readonly expectedChecksum: ArtifactChecksum;
  readonly createdAtMs: number;
  readonly retentionPolicy: ArtifactRetentionPolicy;
  readonly exposurePolicy: ArtifactExposurePolicy;
  readonly provenance: StoredArtifactProvenance;
  readonly presentation?: ArtifactPresentation;
  readonly context: ArtifactMutationContext;
}

export interface StoredArtifactContent {
  readonly metadata: StoredArtifactMetadata;
  readonly bytes: Uint8Array;
}

export type ArtifactAuditEventType =
  | "artifact.stored"
  | "artifact.pinned"
  | "artifact.revoked"
  | "artifact.expired"
  | "artifact.signed-token-issued"
  | "artifact.signed-token-revoked"
  | "artifact.access-granted"
  | "artifact.access-denied";

export interface ArtifactAuditEvent {
  readonly sequence: number;
  readonly eventType: ArtifactAuditEventType;
  readonly occurredAtMs: number;
  readonly artifactId: string;
  readonly actor: ArtifactActor;
  readonly correlationId: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface IssueSignedArtifactToken {
  readonly artifactId: string;
  readonly expiresAtMs: number;
  readonly context: ArtifactMutationContext;
}

export interface IssuedSignedArtifactToken {
  readonly tokenId: string;
  readonly token: string;
  readonly artifactId: string;
  readonly expiresAtMs: number;
}

export interface VerifySignedArtifactToken {
  readonly artifactId: string;
  readonly token: string;
  readonly context: ArtifactMutationContext;
}

export interface RecordArtifactAccess {
  readonly artifactId: string;
  readonly granted: boolean;
  readonly mode: ArtifactExposurePolicy["mode"];
  readonly context: ArtifactMutationContext;
}

export interface ArtifactStore {
  put(input: PutArtifact): Promise<StoredArtifactMetadata>;
  getMetadata(artifactId: string): Promise<StoredArtifactMetadata>;
  getAvailableMetadata(artifactId: string): Promise<StoredArtifactMetadata>;
  read(artifactId: string): Promise<StoredArtifactContent>;
  pin(artifactId: string, context: ArtifactMutationContext): Promise<StoredArtifactMetadata>;
  revoke(artifactId: string, context: ArtifactMutationContext): Promise<StoredArtifactMetadata>;
  expireDue(context: ArtifactMutationContext): Promise<readonly string[]>;
  issueSignedToken(input: IssueSignedArtifactToken): Promise<IssuedSignedArtifactToken>;
  verifySignedToken(input: VerifySignedArtifactToken): Promise<void>;
  revokeSignedToken(tokenId: string, context: ArtifactMutationContext): Promise<void>;
  recordAccess(input: RecordArtifactAccess): Promise<void>;
  listAuditEvents(artifactId?: string): Promise<readonly ArtifactAuditEvent[]>;
  close(): Promise<void>;
}
