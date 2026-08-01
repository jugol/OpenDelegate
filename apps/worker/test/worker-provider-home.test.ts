import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { defaultProviderHome, resolveWorkerPaths } from "../src/worker-app.ts";

const paths = resolveWorkerPaths({
  home: resolve("/var/opendelegate/worker"),
  sourceCheckoutRoot: resolve("/srv/opendelegate-checkout"),
});
const managedCodex = join(paths.stateDirectory, "providers", "codex");

describe("Worker provider home default", () => {
  it("points at the home the owner already authenticated", () => {
    const owned = resolve("/home/owner/.codex");
    assert.equal(
      defaultProviderHome("codex", paths, { CODEX_HOME: owned }),
      owned,
      "an owner who is already signed in must not be asked to sign in again",
    );
  });

  it("keeps the managed home when the resolved owner home is inside the source checkout", () => {
    // Provider state inside the checkout would be committed or wiped by a rebuild.
    const unsafe = join(paths.sourceCheckoutRoot, ".codex");
    assert.equal(defaultProviderHome("codex", paths, { CODEX_HOME: unsafe }), managedCodex);
  });

  it("resolves each provider independently so one home cannot capture the other", () => {
    const codexElsewhere = resolve("/srv/codex-home");
    const environment = { CODEX_HOME: codexElsewhere };
    assert.equal(defaultProviderHome("codex", paths, environment), codexElsewhere);
    assert.notEqual(defaultProviderHome("claude", paths, environment), codexElsewhere);
    assert.notEqual(
      defaultProviderHome("claude", paths, environment),
      join(paths.stateDirectory, "providers", "claude"),
      "a Device with a home directory resolves the owner's Claude home, not the managed one",
    );
  });
});
