import type { ArtifactDetailV1, ArtifactOpenInstructionV1 } from "@opendelegate/protocol";

export interface OpenArtifactInput {
  readonly artifactId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
}

export interface ArtifactAdminPort {
  list(): Promise<readonly ArtifactDetailV1[]>;
  get(artifactId: string): Promise<ArtifactDetailV1>;
  open(input: OpenArtifactInput): Promise<ArtifactOpenInstructionV1>;
}
