import type { AdminSection } from "./DeviceSurface";

export interface AdminDeepLink {
  readonly section: AdminSection;
  readonly artifactId?: string;
}

export function parseAdminDeepLink(search: string): AdminDeepLink {
  const parameters = new URLSearchParams(search);
  const section = parameters.get("section");
  if (section !== "artifacts") {
    return Object.freeze({ section: "devices" });
  }
  const artifactIds = parameters.getAll("artifact");
  const artifactId = artifactIds.length === 1 ? artifactIds[0] : undefined;
  if (
    artifactId === undefined ||
    artifactId.length === 0 ||
    artifactId.length > 160 ||
    artifactId !== artifactId.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(artifactId)
  ) {
    return Object.freeze({ section: "artifacts" });
  }
  return Object.freeze({ section: "artifacts", artifactId });
}
