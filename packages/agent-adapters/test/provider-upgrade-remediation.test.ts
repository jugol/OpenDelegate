import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { providerUpgradeRemediation } from "../src/cli-probe.ts";

describe("provider upgrade remediation", () => {
  it("names the package and the version that would clear an untested provider", () => {
    assert.deepEqual(providerUpgradeRemediation("@openai/codex", ["0.146.0"], "0.145.0"), {
      remediation: {
        kind: "upgrade-provider",
        packageManager: "npm",
        packageName: "@openai/codex",
        targetVersion: "0.146.0",
        installedVersion: "0.145.0",
      },
    });
  });

  it("targets the newest tested version when an adapter pins several", () => {
    const result = providerUpgradeRemediation("@openai/codex", ["0.145.0", "0.146.0"], "0.144.0");
    assert.equal(
      (result as { readonly remediation: { readonly targetVersion: string } }).remediation
        .targetVersion,
      "0.146.0",
    );
  });

  it("states no remedy rather than an unusable one when the adapter declares none", () => {
    // A remedy that cannot name its package or its target is worse than none: it
    // would render an owner-facing button that has nothing to install.
    assert.deepEqual(providerUpgradeRemediation(undefined, ["0.146.0"], "0.145.0"), {});
    assert.deepEqual(providerUpgradeRemediation("@openai/codex", [], "0.145.0"), {});
  });
});
