import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readReleaseOwnedStableJson } from "../src/native-helper-driver.ts";

describe("native Computer Use helper release files", () => {
  it("accepts the supported current-release indirection without allowing path escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-native-helper-release-"));
    try {
      const releaseRoot = join(root, "releases", "0.1.0-alpha.test");
      const currentRoot = join(root, "current");
      const manifestPath = join(releaseRoot, "native-components.json");
      await mkdir(releaseRoot, { recursive: true });
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1 }), "utf8");
      await symlink(releaseRoot, currentRoot, process.platform === "win32" ? "junction" : "dir");

      assert.deepEqual(
        await readReleaseOwnedStableJson(
          currentRoot,
          join(currentRoot, "native-components.json"),
          1_024,
        ),
        { schemaVersion: 1 },
      );

      const escapedPath = join(root, "outside.json");
      await writeFile(escapedPath, JSON.stringify({ schemaVersion: 2 }), "utf8");
      await assert.rejects(
        readReleaseOwnedStableJson(currentRoot, escapedPath, 1_024),
        /unavailable/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
