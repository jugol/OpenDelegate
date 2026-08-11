import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentAdapter,
  AgentAdapterProbe,
  AgentAdapterProbeInput,
  AgentResumeRequest,
  AgentRunHandle,
  AgentStartRequest,
} from "@opendelegate/agent-adapters";

import { selectAgentAdapter, type WorkerAgentConfiguration } from "../src/worker-app.ts";

const autoConfiguration: WorkerAgentConfiguration = {
  provider: "auto",
  allowUntestedVersion: false,
};

class ProbeOnlyAdapter implements AgentAdapter {
  public readonly adapterId: string;
  public readonly provider: "claude" | "codex";
  public readonly probeInputs: AgentAdapterProbeInput[] = [];
  public readonly modelInputs: AgentAdapterProbeInput[] = [];
  readonly #compatibility: AgentAdapterProbe["compatibility"];

  public constructor(
    adapterId: string,
    provider: "claude" | "codex",
    compatibility: AgentAdapterProbe["compatibility"] = "tested",
  ) {
    this.adapterId = adapterId;
    this.provider = provider;
    this.#compatibility = compatibility;
  }

  public probe(input: AgentAdapterProbeInput = {}): Promise<AgentAdapterProbe> {
    this.probeInputs.push(input);
    return Promise.resolve({
      contractVersion: 1,
      adapterId: this.adapterId,
      provider: this.provider,
      installed: true,
      version: "1.0.0",
      compatibility: this.#compatibility,
      auth: { state: "ready" },
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
      diagnostics: [],
    });
  }

  public listModels(input: AgentAdapterProbeInput = {}) {
    this.modelInputs.push(input);
    return Promise.resolve({
      observedAt: "2026-08-11T00:00:00.000Z",
      models: [{ modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" }],
    });
  }

  public start(_request: AgentStartRequest): Promise<AgentRunHandle> {
    return Promise.reject(new Error("The selection fixture never starts a provider."));
  }

  public resume(_request: AgentResumeRequest): Promise<AgentRunHandle> {
    return Promise.reject(new Error("The selection fixture never resumes a provider."));
  }
}

test("Device Auto applies only without an immutable assignment Agent requirement", async () => {
  const codex = new ProbeOnlyAdapter("codex-app-server", "codex");
  const claude = new ProbeOnlyAdapter("claude-agent-sdk", "claude");
  const adapters = [codex, claude];

  assert.equal((await selectAgentAdapter(adapters, autoConfiguration, undefined)).adapter, codex);
  assert.equal(
    (
      await selectAgentAdapter(adapters, autoConfiguration, {
        provider: "claude",
        adapterId: "claude-agent-sdk",
        allowedCompatibilities: ["tested"],
      })
    ).adapter,
    claude,
  );
  await assert.rejects(
    selectAgentAdapter(adapters, autoConfiguration, {
      provider: "claude",
      adapterId: "claude-cli",
      allowedCompatibilities: ["tested"],
    }),
    /immutable Run requirement/u,
  );
  await assert.rejects(
    selectAgentAdapter(adapters, autoConfiguration, {
      provider: "claude",
      allowedCompatibilities: ["untested"],
    }),
    /immutable Run requirement/u,
  );
});

test("a fixed Device provider cannot be widened by an assignment", async () => {
  const adapters = [
    new ProbeOnlyAdapter("codex-app-server", "codex"),
    new ProbeOnlyAdapter("claude-agent-sdk", "claude"),
  ];
  await assert.rejects(
    selectAgentAdapter(
      adapters,
      {
        provider: "codex",
        allowUntestedVersion: false,
      },
      {
        provider: "claude",
        allowedCompatibilities: ["tested"],
      },
    ),
    /immutable Run requirement/u,
  );
});

test("Run adapter selection uses the same bounded environment as service discovery", async () => {
  const codex = new ProbeOnlyAdapter("codex-app-server", "codex");
  const selected = await selectAgentAdapter(
    [codex],
    autoConfiguration,
    {
      provider: "codex",
      adapterId: "codex-app-server",
      modelId: "gpt-5.6-sol",
      allowedCompatibilities: ["tested"],
    },
    {
      PATH: "C:\\Users\\owner\\AppData\\Roaming\\npm;C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\owner",
      OPENAI_API_KEY: "must-not-reach-an-agent-process",
    },
  );

  assert.equal(selected.adapter, codex);
  assert.deepEqual(codex.probeInputs.at(-1)?.environment, {
    PATH: "C:\\Users\\owner\\AppData\\Roaming\\npm;C:\\Windows\\System32",
    USERPROFILE: "C:\\Users\\owner",
  });
  assert.deepEqual(codex.modelInputs.at(-1)?.environment, codex.probeInputs.at(-1)?.environment);
});
