import assert from "node:assert/strict";
import test from "node:test";

import type { StoredArtifactMetadata } from "@opendelegate/artifact-store";

import { DiscordArtifactPresentation } from "../src/discord-artifact-presentation.ts";

const BASE_METADATA: StoredArtifactMetadata = {
  artifactId: "artifact-report",
  taskId: "task-report",
  producingRunId: "run-report",
  mediaType: "text/html",
  originalFilename: "report.html",
  sizeBytes: 128,
  checksum: { algorithm: "sha256", value: "a".repeat(64) },
  createdAtMs: 1_000,
  retentionPolicy: { kind: "task" },
  exposurePolicy: { mode: "private-network" },
  provenance: { deviceId: "device-worker", source: "worker-run" },
  presentation: "static-html",
  state: "available",
};

function presentation(metadata: readonly StoredArtifactMetadata[]): DiscordArtifactPresentation {
  return new DiscordArtifactPresentation({
    adminOrigin: "https://admin.example.test",
    configuration: {
      listeners: {
        static: {
          host: "127.0.0.1",
          port: 4042,
          origin: "https://static.example.test",
        },
        interactive: {
          host: "127.0.0.1",
          port: 4043,
          origin: "https://interactive.example.test",
        },
      },
    },
    store: {
      listMetadata: () => Promise.resolve(metadata),
    },
  });
}

test("Discord projects the newest available private-network report to its isolated origin", async () => {
  const selected = {
    ...BASE_METADATA,
    artifactId: "artifact-new",
    createdAtMs: 2_000,
    presentation: "interactive-html" as const,
  };
  const projected = await presentation([
    BASE_METADATA,
    selected,
    { ...BASE_METADATA, artifactId: "artifact-revoked", createdAtMs: 3_000, state: "revoked" },
    { ...BASE_METADATA, artifactId: "artifact-other", taskId: "task-other", createdAtMs: 4_000 },
  ]).forTask("task-report");

  assert.deepEqual(projected, {
    label: "Open interactive result",
    url: "https://interactive.example.test/artifacts/artifact-new",
  });
});

test("credentialed Artifact modes use a stable credential-free Admin deep link", async () => {
  for (const mode of ["authenticated", "signed-link", "custom"] as const) {
    const exposurePolicy = mode === "custom" ? { mode, customPolicyId: "owner-policy" } : { mode };
    const projected = await presentation([{ ...BASE_METADATA, exposurePolicy }]).forTask(
      "task-report",
    );
    assert.deepEqual(projected, {
      label: "Open report",
      url: "https://admin.example.test/?section=artifacts&artifact=artifact-report",
    });
    assert.doesNotMatch(projected!.url, /token|credential|secret/iu);
  }
});

test("a small download Artifact carries a verified native Discord attachment reference", async () => {
  const download = {
    ...BASE_METADATA,
    artifactId: "artifact-text-result",
    mediaType: "text/plain",
    originalFilename: "result.txt",
    sizeBytes: 142,
    checksum: { algorithm: "sha256" as const, value: "b".repeat(64) },
    presentation: "download" as const,
  };

  assert.deepEqual(await presentation([download]).forTask("task-report"), {
    label: "Open report",
    url: "https://static.example.test/artifacts/artifact-text-result",
    nativeAttachment: {
      artifactId: "artifact-text-result",
      filename: "result.txt",
      mediaType: "text/plain",
      sizeBytes: 142,
      sha256: "b".repeat(64),
    },
  });
});

test("large or URL-unsafe download Artifacts keep their Gateway action without native upload", async () => {
  for (const candidate of [
    {
      ...BASE_METADATA,
      presentation: "download" as const,
      sizeBytes: 10 * 1024 * 1024 + 1,
      mediaType: "text/plain",
    },
    {
      ...BASE_METADATA,
      presentation: "download" as const,
      originalFilename: "결과.txt",
      mediaType: "text/plain",
    },
  ]) {
    assert.deepEqual(await presentation([candidate]).forTask("task-report"), {
      label: "Open report",
      url: "https://static.example.test/artifacts/artifact-report",
    });
  }
});

test("a Task without an available Artifact has no Discord report link", async () => {
  assert.equal(
    await presentation([{ ...BASE_METADATA, state: "expired" }]).forTask("task-report"),
    undefined,
  );
});
