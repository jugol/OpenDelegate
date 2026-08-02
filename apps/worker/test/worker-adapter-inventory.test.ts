import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentAdapter, AgentAdapterProbe } from "@opendelegate/agent-adapters";

import { createWorkerSchedulingInventoryProvider } from "../src/index.ts";

const workspaceRegistry = { listSchedulingMetadata: async () => [] };

function stubAdapter(
  adapterId: string,
  probe: Omit<AgentAdapterProbe, "contractVersion" | "adapterId" | "provider" | "capabilities">,
): AgentAdapter {
  return {
    adapterId,
    provider: "claude",
    async probe() {
      return {
        contractVersion: 1,
        adapterId,
        provider: "claude",
        capabilities: {
          start: true,
          resume: true,
          streaming: true,
          cancellation: true,
          approvalBridge: false,
          steering: false,
          checkpointContinuation: true,
          workspaceIsolation: ["none"],
        },
        ...probe,
      } satisfies AgentAdapterProbe;
    },
    start() {
      throw new Error("The inventory must never start a Run.");
    },
    resume() {
      throw new Error("The inventory must never resume a Run.");
    },
  };
}

describe("Worker agent adapter inventory", () => {
  it("leaves out an adapter no owner action on this Device could make usable", async () => {
    // Advertising it would put a row on every surface whose only possible reading is
    // "incompatible", with no button that changes it.
    const inventory = createWorkerSchedulingInventoryProvider({
      adapters: [
        stubAdapter("claude-usable", {
          installed: true,
          version: "2.1.220",
          compatibility: "tested",
          auth: { state: "ready" },
          diagnostics: [],
        }),
        stubAdapter("claude-unsupported-here", {
          installed: true,
          version: "0.3.220",
          compatibility: "incompatible",
          auth: { state: "ready" },
          diagnostics: [{ code: "SANDBOX_UNAVAILABLE", message: "This host cannot sandbox it." }],
          unsupportedOnDevice: true,
        }),
      ],
      environment: {},
      workspaceRegistry,
      probeCacheMs: 0,
    });

    const snapshot = await inventory.snapshot();

    assert.deepEqual(
      (snapshot.agentAdapters ?? []).map((adapter) => adapter.adapterId),
      ["claude-usable"],
    );
  });

  it("keeps advertising an adapter whose failure has a remedy", async () => {
    // "Not installed" and "out of date" are states an owner can leave; hiding them
    // would hide the remedy along with the problem.
    const inventory = createWorkerSchedulingInventoryProvider({
      adapters: [
        stubAdapter("claude-missing", {
          installed: false,
          compatibility: "incompatible",
          auth: { state: "unknown" },
          diagnostics: [{ code: "EXECUTABLE_NOT_FOUND", message: "Not installed." }],
        }),
        stubAdapter("claude-untested", {
          installed: true,
          version: "2.0.0",
          compatibility: "untested",
          auth: { state: "ready" },
          diagnostics: [],
          remediation: {
            kind: "upgrade-provider",
            packageManager: "npm",
            packageName: "@anthropic-ai/claude-code",
            targetVersion: "2.1.220",
            installedVersion: "2.0.0",
          },
        }),
      ],
      environment: {},
      workspaceRegistry,
      probeCacheMs: 0,
    });

    const snapshot = await inventory.snapshot();

    assert.deepEqual((snapshot.agentAdapters ?? []).map((adapter) => adapter.adapterId).sort(), [
      "claude-missing",
      "claude-untested",
    ]);
    assert.deepEqual(
      (snapshot.agentAdapters ?? []).find((adapter) => adapter.adapterId === "claude-untested")
        ?.availableUpgrade,
      { packageName: "@anthropic-ai/claude-code", targetVersion: "2.1.220" },
    );
  });

  it("stops claiming a provider Capability that only an unsupported adapter backed", async () => {
    // The Capability is evidence that this Device can run the provider. An adapter it
    // can never run is not that evidence.
    const inventory = createWorkerSchedulingInventoryProvider({
      adapters: [
        stubAdapter("claude-unsupported-here", {
          installed: true,
          version: "0.3.220",
          compatibility: "incompatible",
          auth: { state: "ready" },
          diagnostics: [],
          unsupportedOnDevice: true,
        }),
      ],
      environment: {},
      workspaceRegistry,
      probeCacheMs: 0,
    });

    const snapshot = await inventory.snapshot();

    assert.equal(
      snapshot.capabilities.some((capability) => capability.name === "claude-code"),
      false,
    );
  });
});
