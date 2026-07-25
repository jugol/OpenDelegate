import type { ArtifactStore, StoredArtifactMetadata } from "@opendelegate/artifact-store";
import type { TaskChannelProjection } from "@opendelegate/discord-adapter";

import type { MainArtifactConfiguration } from "./artifact-runtime.ts";
import type { DiscordArtifactPresentationPort } from "./discord-runtime.ts";

export interface DiscordArtifactPresentationOptions {
  readonly adminOrigin: string;
  readonly configuration: Pick<MainArtifactConfiguration, "listeners">;
  readonly store: Pick<ArtifactStore, "listMetadata">;
}

/**
 * Projects the newest available Task Artifact to one stable Discord link.
 *
 * Public and private-network Artifacts can use the isolated Gateway directly.
 * Modes that require a credential use a stable, credential-free Admin deep link;
 * Admin then applies the current exposure policy when the owner opens the report.
 * This avoids putting bearer/session material in Discord and avoids rotating
 * signed URLs creating a new Discord result message on every reconciliation.
 */
export class DiscordArtifactPresentation implements DiscordArtifactPresentationPort {
  readonly #adminOrigin: URL;
  readonly #configuration: DiscordArtifactPresentationOptions["configuration"];
  readonly #store: DiscordArtifactPresentationOptions["store"];

  public constructor(options: DiscordArtifactPresentationOptions) {
    this.#adminOrigin = safeOrigin(options.adminOrigin, "Admin origin");
    safeOrigin(options.configuration.listeners.static.origin, "static Artifact origin");
    safeOrigin(options.configuration.listeners.interactive.origin, "interactive Artifact origin");
    if (
      options.store === null ||
      typeof options.store !== "object" ||
      typeof options.store.listMetadata !== "function"
    ) {
      throw new TypeError("An Artifact metadata source is required.");
    }
    this.#configuration = options.configuration;
    this.#store = options.store;
  }

  public async forTask(
    taskId: string,
  ): Promise<NonNullable<TaskChannelProjection["artifact"]> | undefined> {
    assertIdentifier(taskId, "Task ID");
    const metadata = newestAvailableArtifact(await this.#store.listMetadata(), taskId);
    if (metadata === undefined) {
      return undefined;
    }
    return Object.freeze({
      label: "Open report",
      url:
        metadata.exposurePolicy.mode === "public" ||
        metadata.exposurePolicy.mode === "private-network"
          ? directArtifactUrl(this.#configuration, metadata)
          : adminArtifactUrl(this.#adminOrigin, metadata.artifactId),
    });
  }
}

function newestAvailableArtifact(
  candidates: readonly StoredArtifactMetadata[],
  taskId: string,
): StoredArtifactMetadata | undefined {
  return candidates
    .filter((candidate) => candidate.taskId === taskId && candidate.state === "available")
    .sort(
      (left, right) =>
        right.createdAtMs - left.createdAtMs || right.artifactId.localeCompare(left.artifactId),
    )[0];
}

function directArtifactUrl(
  configuration: DiscordArtifactPresentationOptions["configuration"],
  metadata: StoredArtifactMetadata,
): string {
  const origin =
    metadata.presentation === "interactive-html"
      ? configuration.listeners.interactive.origin
      : configuration.listeners.static.origin;
  return new URL(`/artifacts/${encodeURIComponent(metadata.artifactId)}`, origin).href;
}

function adminArtifactUrl(adminOrigin: URL, artifactId: string): string {
  const url = new URL(adminOrigin.href);
  url.searchParams.set("section", "artifacts");
  url.searchParams.set("artifact", artifactId);
  return url.href;
}

function safeOrigin(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} is invalid.`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return parsed;
}

function assertIdentifier(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 160 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}
