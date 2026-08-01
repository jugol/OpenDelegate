import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { AgentAdapterProbe, AgentAdapterRemediation } from "@opendelegate/agent-adapters";

import { upgradeAgentProvider } from "../src/agent-provider-upgrade.ts";

const REMEDIATION: AgentAdapterRemediation = {
  kind: "upgrade-provider",
  packageManager: "npm",
  packageName: "@openai/codex",
  targetVersion: "0.146.0",
  installedVersion: "0.145.0",
};

function probeAt(version: string | undefined): AgentAdapterProbe {
  return {
    contractVersion: 1,
    adapterId: "codex-cli",
    provider: "codex",
    installed: true,
    ...(version === undefined ? {} : { version }),
    compatibility: version === "0.146.0" ? "tested" : "untested",
    auth: { state: "ready" },
    capabilities: {
      start: true,
      resume: true,
      streaming: true,
      cancellation: true,
      approvalBridge: true,
      steering: true,
      checkpointContinuation: true,
      workspaceIsolation: ["none"],
    },
    diagnostics: [],
  };
}

describe("Agent provider upgrade", () => {
  it("installs the exact pinned version and confirms it took effect", async () => {
    const runCommand = mock.fn(
      async (_command: { readonly executable: string; readonly args: readonly string[] }) => ({
        exitCode: 0,
        output: "",
      }),
    );

    const outcome = await upgradeAgentProvider({
      adapterId: "codex-cli",
      remediation: REMEDIATION,
      reprobe: async () => probeAt("0.146.0"),
      nodeExecutable: "/opt/opendelegate/node",
      npmCliPath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
      environment: { PATH: "" },
      runCommand,
    });

    assert.deepEqual(outcome, {
      status: "upgraded",
      adapterId: "codex-cli",
      packageName: "@openai/codex",
      fromVersion: "0.145.0",
      toVersion: "0.146.0",
    });
    // The Worker's own Node runs npm's entry script; no shell wrapper is spawned.
    const call = runCommand.mock.calls[0]?.arguments[0];
    assert.ok(call !== undefined, "the upgrade must reach a command");
    assert.equal(call.executable, "/opt/opendelegate/node");
    assert.ok(call.args[0]?.endsWith("npm-cli.js"), call.args[0]);
    assert.deepEqual(call.args.slice(1), [
      "install",
      "--global",
      "--no-fund",
      "--no-audit",
      "@openai/codex@0.146.0",
    ]);
  });

  it("reports failure when npm claims success but the version did not change", async () => {
    const outcome = await upgradeAgentProvider({
      adapterId: "codex-cli",
      remediation: REMEDIATION,
      reprobe: async () => probeAt("0.145.0"),
      npmCliPath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
      environment: { PATH: "" },
      runCommand: async () => ({ exitCode: 0, output: "" }),
    });

    assert.equal(outcome.status, "unavailable");
    assert.equal(
      (outcome as { readonly reasonCode: string }).reasonCode,
      "VERSION_NOT_APPLIED",
      "a successful exit code is not evidence that the Device changed",
    );
  });

  it("reports the failed command instead of re-probing after a non-zero exit", async () => {
    const reprobe = mock.fn(async () => probeAt("0.146.0"));

    const outcome = await upgradeAgentProvider({
      adapterId: "codex-cli",
      remediation: REMEDIATION,
      reprobe,
      npmCliPath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
      environment: { PATH: "" },
      runCommand: async () => ({ exitCode: 1, output: "EACCES" }),
    });

    assert.equal(outcome.status, "unavailable");
    assert.equal((outcome as { readonly reasonCode: string }).reasonCode, "UPGRADE_COMMAND_FAILED");
    assert.equal(reprobe.mock.callCount(), 0);
  });

  it("refuses a remedy whose package or version is not a plain pinned identifier", async () => {
    const runCommand = mock.fn(async () => ({ exitCode: 0, output: "" }));
    const refused: readonly AgentAdapterRemediation[] = [
      { ...REMEDIATION, packageName: "@openai/codex; rm -rf /" },
      { ...REMEDIATION, targetVersion: "latest" },
      { ...REMEDIATION, targetVersion: "0.146.0 --registry=http://evil.test" },
    ];

    for (const remediation of refused) {
      const outcome = await upgradeAgentProvider({
        adapterId: "codex-cli",
        remediation,
        reprobe: async () => probeAt("0.146.0"),
        npmCliPath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
        environment: { PATH: "" },
        runCommand,
      });
      assert.equal(outcome.status, "unavailable", JSON.stringify(remediation));
      assert.equal((outcome as { readonly reasonCode: string }).reasonCode, "REMEDIATION_INVALID");
    }
    assert.equal(runCommand.mock.callCount(), 0, "a refused remedy never reaches a command");
  });

  it("reports a Device without npm rather than guessing at an installer", async () => {
    const outcome = await upgradeAgentProvider({
      adapterId: "codex-cli",
      remediation: REMEDIATION,
      reprobe: async () => probeAt("0.146.0"),
      environment: { PATH: "" },
    });

    assert.equal(outcome.status, "unavailable");
    assert.equal(
      (outcome as { readonly reasonCode: string }).reasonCode,
      "PACKAGE_MANAGER_UNAVAILABLE",
    );
  });
});
