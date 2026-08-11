import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AgentAdapter,
  AgentAdapterProbe,
  AgentAdapterProbeInput,
} from "@opendelegate/agent-adapters";

import { createWorkerSchedulingInventoryProvider } from "../src/index.ts";

const workspaceRegistry = { listSchedulingMetadata: async () => [] };

function stubAdapter(
  adapterId: string,
  probe: Omit<AgentAdapterProbe, "contractVersion" | "adapterId" | "provider" | "capabilities">,
  capabilityOverrides: Partial<AgentAdapterProbe["capabilities"]> = {},
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
          ...capabilityOverrides,
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
  it("uses the bounded service environment for provider discovery and model inspection", async () => {
    const base = stubAdapter("claude-service", {
      installed: true,
      version: "2.1.220",
      compatibility: "tested",
      auth: { state: "ready" },
      diagnostics: [],
    });
    let probeInput: AgentAdapterProbeInput | undefined;
    let catalogInput: AgentAdapterProbeInput | undefined;
    const adapter: AgentAdapter = {
      ...base,
      async probe(input) {
        probeInput = input;
        return await base.probe(input);
      },
      async listModels(input) {
        catalogInput = input;
        return {
          observedAt: "2026-08-11T00:00:00.000Z",
          models: [{ modelId: "claude-opus-5", displayName: "Claude Opus 5" }],
        };
      },
    };
    const inventory = createWorkerSchedulingInventoryProvider({
      adapters: [adapter],
      environment: {
        PATH: "C:\\Users\\owner\\.local\\bin;C:\\Windows\\System32",
        USERPROFILE: "C:\\Users\\owner",
        OPENDELEGATE_SERVICE_MODE: "system-service",
        DATABASE_URI: "must-not-reach-an-agent-process",
      },
      workspaceRegistry,
      probeCacheMs: 0,
    });

    const snapshot = await inventory.snapshot();

    assert.deepEqual(probeInput?.environment, {
      PATH: "C:\\Users\\owner\\.local\\bin;C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\owner",
    });
    assert.deepEqual(catalogInput?.environment, probeInput?.environment);
    assert.equal(Object.hasOwn(probeInput?.environment ?? {}, "DATABASE_URI"), false);
    assert.equal(Object.hasOwn(probeInput?.environment ?? {}, "OPENDELEGATE_SERVICE_MODE"), false);
    assert.equal(snapshot.serviceMode, "system-service");
  });

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
        stubAdapter("claude-sandbox-dependency", {
          installed: true,
          version: "0.3.220",
          compatibility: "incompatible",
          auth: { state: "ready" },
          diagnostics: [
            {
              code: "CLAUDE_SANDBOX_DEPENDENCY_UNAVAILABLE",
              message: "A Device-local sandbox executable is missing.",
            },
          ],
        }),
        stubAdapter("claude-sandbox-runtime", {
          installed: true,
          version: "0.3.220",
          compatibility: "incompatible",
          auth: { state: "ready" },
          diagnostics: [
            {
              code: "CLAUDE_SANDBOX_RUNTIME_UNAVAILABLE",
              message: "A Device policy blocks nested sandbox creation.",
            },
          ],
        }),
      ],
      environment: {},
      workspaceRegistry,
      probeCacheMs: 0,
    });

    const snapshot = await inventory.snapshot();

    assert.deepEqual((snapshot.agentAdapters ?? []).map((adapter) => adapter.adapterId).sort(), [
      "claude-missing",
      "claude-sandbox-dependency",
      "claude-sandbox-runtime",
      "claude-untested",
    ]);
    assert.deepEqual(
      (snapshot.agentAdapters ?? []).find((adapter) => adapter.adapterId === "claude-untested")
        ?.availableUpgrade,
      { packageName: "@anthropic-ai/claude-code", targetVersion: "2.1.220" },
    );
    assert.equal(
      (snapshot.agentAdapters ?? []).find((adapter) => adapter.adapterId === "claude-missing")
        ?.blockedBy,
      "executable-unavailable",
    );
    assert.equal(
      (snapshot.agentAdapters ?? []).find((adapter) => adapter.adapterId === "claude-untested")
        ?.blockedBy,
      "version-unsupported",
    );
    assert.equal(
      (snapshot.agentAdapters ?? []).find(
        (adapter) => adapter.adapterId === "claude-sandbox-dependency",
      )?.blockedBy,
      "executable-unavailable",
    );
    assert.equal(
      (snapshot.agentAdapters ?? []).find(
        (adapter) => adapter.adapterId === "claude-sandbox-runtime",
      )?.blockedBy,
      "platform-incompatible",
    );
  });

  it("projects an actionable authentication blocker without provider diagnostics", async () => {
    const inventory = createWorkerSchedulingInventoryProvider({
      adapters: [
        stubAdapter("claude-signed-out", {
          installed: true,
          version: "2.1.220",
          compatibility: "tested",
          auth: { state: "not_ready" },
          diagnostics: [
            {
              code: "AUTH_NOT_READY",
              message: "Sensitive provider output and a local path stay on this Device.",
            },
          ],
        }),
      ],
      environment: {},
      workspaceRegistry,
      probeCacheMs: 0,
    });

    const adapter = (await inventory.snapshot()).agentAdapters?.[0];
    assert.equal(adapter?.blockedBy, "authentication-required");
    assert.equal(JSON.stringify(adapter).includes("Sensitive provider output"), false);
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

  it("advertises native child Agents only from a ready bridged SDK adapter", async () => {
    const inventory = createWorkerSchedulingInventoryProvider({
      adapters: [
        stubAdapter(
          "claude-agent-sdk",
          {
            installed: true,
            version: "0.3.220",
            compatibility: "tested",
            auth: { state: "ready" },
            diagnostics: [],
          },
          { approvalBridge: true },
        ),
        stubAdapter("claude-cli", {
          installed: true,
          version: "2.1.220",
          compatibility: "tested",
          auth: { state: "ready" },
          diagnostics: [],
        }),
      ],
      environment: {},
      workspaceRegistry,
      probeCacheMs: 0,
    });

    const snapshot = await inventory.snapshot();
    assert.deepEqual(
      snapshot.capabilities.find((capability) => capability.name === "native-subagents"),
      {
        name: "native-subagents",
        verification: "verified",
        observedAtMs: snapshot.capabilities.find(
          (capability) => capability.name === "native-subagents",
        )?.observedAtMs,
        evidenceSource: "agent-adapter",
      },
    );
  });
});
