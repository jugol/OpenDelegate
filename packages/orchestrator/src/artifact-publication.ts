import { parseArtifactReference } from "./contract-validation.ts";
import type { ArtifactContent, ArtifactGateway, ArtifactReference } from "./contracts.ts";
import type { OrchestrationJournal } from "./orchestration-journal.ts";

export async function publishArtifactResult(input: {
  readonly taskId: string;
  readonly artifact: ArtifactContent;
  readonly artifacts: ArtifactGateway;
  readonly journal: OrchestrationJournal;
}): Promise<ArtifactReference> {
  const cachedArtifact = input.journal.artifactResult(input.taskId);
  if (cachedArtifact !== undefined) {
    return cachedArtifact.reference;
  }

  const artifactReference = parseArtifactReference(
    await input.artifacts.publish({
      taskId: input.taskId,
      idempotencyKey: artifactPublicationKey(input.taskId),
      ...input.artifact,
    }),
  );
  input.journal.recordArtifactResult(input.taskId, {
    reference: artifactReference,
  });
  return artifactReference;
}

function artifactPublicationKey(taskId: string): string {
  return `${taskId}:result-artifact`;
}
