import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { resolveOwnerProviderHome } from "../src/controlled-provider-home.ts";

const HOME = resolve("/home/owner");

describe("owner provider home", () => {
  it("uses the home the owner already authenticated rather than inventing one", () => {
    assert.equal(resolveOwnerProviderHome("codex", {}, HOME), join(HOME, ".codex"));
    assert.equal(resolveOwnerProviderHome("claude", {}, HOME), join(HOME, ".claude"));
  });

  it("honours the provider's own home variable when the owner has moved it", () => {
    const moved = resolve("/srv/codex-home");
    assert.equal(resolveOwnerProviderHome("codex", { CODEX_HOME: moved }, HOME), moved);
    assert.equal(
      resolveOwnerProviderHome("claude", { CLAUDE_CONFIG_DIR: resolve("/srv/claude") }, HOME),
      resolve("/srv/claude"),
    );
    // Each provider reads only its own variable, so one cannot redirect the other.
    assert.equal(
      resolveOwnerProviderHome("claude", { CODEX_HOME: moved }, HOME),
      join(HOME, ".claude"),
    );
  });

  it("ignores an unusable variable instead of handing a relative path to the provider", () => {
    for (const value of ["", "   ", "relative/.codex"]) {
      assert.equal(
        resolveOwnerProviderHome("codex", { CODEX_HOME: value }, HOME),
        join(HOME, ".codex"),
        `expected ${JSON.stringify(value)} to be ignored`,
      );
    }
  });

  it("reports no owner home when the Device exposes none, leaving a managed fallback", () => {
    assert.equal(resolveOwnerProviderHome("codex", {}, ""), undefined);
    assert.equal(resolveOwnerProviderHome("codex", {}, "not-absolute"), undefined);
  });
});
