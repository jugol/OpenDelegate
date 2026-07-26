import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentAdapter,
  AgentAdapterProbe,
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

  public probe(): Promise<AgentAdapterProbe> {
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
