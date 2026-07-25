import { describe, expect, it } from "vitest";

import { parseAdminDeepLink } from "./admin-deep-link";

describe("Admin deep links", () => {
  it("selects one bounded Artifact without accepting a credential-like arbitrary value", () => {
    expect(parseAdminDeepLink("?section=artifacts&artifact=artifact_report")).toEqual({
      section: "artifacts",
      artifactId: "artifact_report",
    });
    expect(parseAdminDeepLink("?section=artifacts&artifact=one&artifact=two")).toEqual({
      section: "artifacts",
    });
    expect(parseAdminDeepLink("?section=artifacts&artifact=%2Fetc%2Fpasswd")).toEqual({
      section: "artifacts",
    });
  });

  it("defaults unknown destinations to Devices", () => {
    expect(parseAdminDeepLink("?section=unknown")).toEqual({ section: "devices" });
  });
});
