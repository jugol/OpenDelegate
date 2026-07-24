import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFixtureNativeDriver, runNativeDriverConformanceLab } from "../src/index.ts";

describe("native driver conformance laboratory", () => {
  it("proves the fixture interaction, PNG bytes, cancellation, and emergency stop on each OS contract", async () => {
    for (const osFamily of ["windows", "macos", "linux"] as const) {
      const report = await runNativeDriverConformanceLab({
        osFamily,
        createDriver: () =>
          createFixtureNativeDriver({
            osFamily,
            runIdentifier: `native-conformance-${osFamily}`,
            ...(osFamily === "linux" ? { linuxTarget: "ubuntu-24.04-gnome-wayland" as const } : {}),
          }).driver,
      });

      assert.equal(report.passed, true);
      assert.equal(report.osFamily, osFamily);
      assert.equal(report.pngEvidence.mediaType, "image/png");
      assert.ok(report.pngEvidence.bytes.length > 1_000);
      assert.match(report.pngEvidence.sha256, /^sha256:[a-f0-9]{64}$/);
      assert.match(report.resultFile.filename, /^fixture-result-/);
      assert.ok(report.resultFile.bytes.length > 0);
      assert.equal(report.cancellationStoppedInput, true);
      assert.equal(report.emergencyStopStoppedInput, true);
    }
  });
});
