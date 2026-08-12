import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createWindowsNativeHelperSpawnOptions,
  createDeferredNativeComputerUseDriver,
  readReleaseOwnedStableJson,
} from "../src/native-helper-driver.ts";

describe("native Computer Use helper release files", () => {
  it("starts the Windows native helper without a persistent console window", () => {
    const options = createWindowsNativeHelperSpawnOptions(String.raw`C:\OpenDelegate\current`);

    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe", "pipe"]);
  });

  it("does not launch an interactive native helper until Computer Use is requested", async () => {
    let starts = 0;
    let probes = 0;
    let closes = 0;
    const driver = createDeferredNativeComputerUseDriver({
      osFamily: "windows",
      async start() {
        starts += 1;
        return {
          osFamily: "windows",
          async probe() {
            probes += 1;
            return {
              osFamily: "windows",
              backendId: "windows-test-helper",
              helperInstanceId: "helper-test",
              serviceEpoch: 1,
              displayFingerprint: "windows-display:test",
              checks: [],
            };
          },
          async observe() {
            throw new Error("not used");
          },
          async capture() {
            throw new Error("not used");
          },
          async act() {
            throw new Error("not used");
          },
          async cancel() {},
          async emergencyStop() {},
          async close() {
            closes += 1;
          },
        };
      },
    });

    assert.equal(starts, 0);
    await driver.cancel({
      executionHandleId: "execution-test",
      taskId: "task-test",
      deviceId: "device-test",
      runId: "run-test",
    });
    assert.equal(starts, 0);
    await driver.probe();
    await driver.probe();
    assert.equal(starts, 1);
    assert.equal(probes, 2);
    await (driver as typeof driver & { close(): Promise<void> }).close();
    assert.equal(closes, 1);
  });

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
