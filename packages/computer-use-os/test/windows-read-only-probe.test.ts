import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { probeCurrentWindowsSessionReadOnly } from "../src/index.ts";

describe("current Windows read-only readiness probe", () => {
  it("reports only the session facts it can prove and never claims full readiness", async () => {
    let script = "";
    const report = await probeCurrentWindowsSessionReadOnly({
      platform: "win32",
      clock: { now: () => 12_345 },
      commands: {
        async runPowerShell(value) {
          script = value;
          return JSON.stringify({
            userInteractive: true,
            sessionId: 3,
            logonUiVisible: false,
          });
        },
      },
    });

    assert.equal(report.status, "unavailable");
    assert.equal(report.displayFingerprint, null);
    assert.equal(report.checks[0]?.status, "pass");
    assert.equal(report.checks[1]?.status, "unknown");
    assert.deepEqual(
      report.checks.slice(2).map((check) => check.status),
      ["unknown", "unknown", "unknown", "fail", "fail"],
    );
    assert.match(script, /Get-Process/u);
    assert.doesNotMatch(script, /\b(Set|Start|Stop|Remove|New)-/u);
  });

  it("fails conservatively when the session query is unavailable", async () => {
    const report = await probeCurrentWindowsSessionReadOnly({
      platform: "win32",
      commands: {
        async runPowerShell() {
          throw new Error("query failed");
        },
      },
    });

    assert.equal(report.status, "unavailable");
    assert.equal(report.checks[0]?.status, "unknown");
    assert.equal(report.checks[1]?.status, "unknown");
  });

  it(
    "collects conservative evidence from the current Windows process without injecting input",
    { skip: process.platform !== "win32" },
    async () => {
      const report = await probeCurrentWindowsSessionReadOnly();
      assert.equal(report.osFamily, "windows");
      assert.equal(report.status, "unavailable");
      assert.equal(report.checks.find((check) => check.name === "input")?.status, "unknown");
      assert.equal(report.checks.find((check) => check.name === "service-epoch")?.status, "fail");
    },
  );
});
