import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AgentAdapter,
  type AgentAdapterProbe,
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentStartRequest,
} from "@opendelegate/agent-adapters";

import {
  MainAgentRuntimeError,
  probeMainAgentAdapters,
  resolveMainAgentComposition,
  type MainAgentRuntimePaths,
} from "../src/agent-runtime.ts";

test("auto selects the first ready provider and fixes it across restart", async (context) => {
  const paths = await runtimePaths(context);
  const first = await resolveMainAgentComposition({
    paths,
    createAdapter: factory({
      codex: probe("codex", "ready"),
      claude: probe("claude", "ready"),
    }),
  });

  assert.equal(first.status, "ready");
  assert.equal(first.provider, "codex");
  assert.deepEqual(JSON.parse(await readFile(join(paths.configDirectory, "agent.json"), "utf8")), {
    schemaVersion: 1,
    provider: "codex",
  });

  const restarted = await resolveMainAgentComposition({
    paths,
    createAdapter: factory({
      codex: probe("codex", "signed-out"),
      claude: probe("claude", "ready"),
    }),
  });
  assert.equal(restarted.status, "unavailable");
  assert.equal(restarted.provider, "codex");
  assert.equal(restarted.code, "AGENT_AUTH_NOT_READY");
});

test("an explicit provider is persisted and conflicting startup fails closed", async (context) => {
  const paths = await runtimePaths(context);
  const selected = await resolveMainAgentComposition({
    paths,
    requestedProvider: "claude",
    createAdapter: factory({
      codex: probe("codex", "ready"),
      claude: probe("claude", "ready"),
    }),
  });
  assert.equal(selected.status, "ready");
  assert.equal(selected.provider, "claude");

  await assert.rejects(
    resolveMainAgentComposition({
      paths,
      requestedProvider: "codex",
      createAdapter: factory({
        codex: probe("codex", "ready"),
        claude: probe("claude", "ready"),
      }),
    }),
    (error: unknown) =>
      error instanceof MainAgentRuntimeError && error.code === "AGENT_PROVIDER_CONFLICT",
  );
});

test("explicit shared provider homes upgrade one selection and survive restart", async (context) => {
  const paths = await runtimePaths(context);
  const sharedCodexHome = await mkdtemp(join(tmpdir(), "opendelegate-codex-ssot-"));
  const sharedClaudeHome = await mkdtemp(join(tmpdir(), "opendelegate-claude-ssot-"));
  context.after(async () => {
    await rm(sharedCodexHome, { force: true, recursive: true });
    await rm(sharedClaudeHome, { force: true, recursive: true });
  });
  const observedHomes: string[] = [];
  const createAdapter = (
    provider: "codex" | "claude",
    _leaseStore: unknown,
    providerHome: string,
  ): AgentAdapter => {
    observedHomes.push(providerHome);
    return new ProbeOnlyAdapter(probe(provider, "ready"));
  };

  await resolveMainAgentComposition({
    paths,
    requestedProvider: "codex",
    createAdapter,
  });
  const upgraded = await resolveMainAgentComposition({
    paths,
    requestedProvider: "codex",
    requestedCodexHome: sharedCodexHome,
    requestedClaudeHome: sharedClaudeHome,
    createAdapter,
  });
  await probeMainAgentAdapters({
    paths,
    createAdapter,
  });
  const restarted = await resolveMainAgentComposition({
    paths,
    createAdapter,
  });

  assert.equal(upgraded.status, "ready");
  assert.equal(restarted.status, "ready");
  assert.deepEqual(observedHomes, [
    join(paths.stateDirectory, "providers", "codex"),
    sharedCodexHome,
    sharedCodexHome,
    sharedClaudeHome,
    sharedCodexHome,
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(paths.configDirectory, "agent.json"), "utf8")), {
    schemaVersion: 3,
    provider: "codex",
    codexHome: sharedCodexHome,
    claudeHome: sharedClaudeHome,
  });
});

test("a shared Claude home survives signed-out setup for owner reconnect", async (context) => {
  const paths = await runtimePaths(context);
  const sharedClaudeHome = await mkdtemp(join(tmpdir(), "opendelegate-claude-ssot-"));
  context.after(async () => {
    await rm(sharedClaudeHome, { force: true, recursive: true });
  });
  const observedHomes: string[] = [];
  const createAdapter = (
    provider: "codex" | "claude",
    _leaseStore: unknown,
    providerHome: string,
  ): AgentAdapter => {
    observedHomes.push(providerHome);
    return new ProbeOnlyAdapter(
      probe(provider, provider === "claude" && observedHomes.length === 1 ? "signed-out" : "ready"),
    );
  };

  const signedOut = await resolveMainAgentComposition({
    paths,
    requestedProvider: "claude",
    requestedClaudeHome: sharedClaudeHome,
    createAdapter,
  });
  const recovered = await resolveMainAgentComposition({
    paths,
    createAdapter,
  });

  assert.equal(signedOut.status, "unavailable");
  assert.equal(signedOut.code, "AGENT_AUTH_NOT_READY");
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.provider, "claude");
  assert.deepEqual(observedHomes, [sharedClaudeHome, sharedClaudeHome]);
  assert.deepEqual(JSON.parse(await readFile(join(paths.configDirectory, "agent.json"), "utf8")), {
    schemaVersion: 3,
    provider: "claude",
    codexHome: null,
    claudeHome: sharedClaudeHome,
  });
});

test("auto leaves selection resumable when no provider is ready", async (context) => {
  const paths = await runtimePaths(context);
  const unavailable = await resolveMainAgentComposition({
    paths,
    createAdapter: factory({
      codex: probe("codex", "missing"),
      claude: probe("claude", "signed-out"),
    }),
  });

  assert.equal(unavailable.status, "unavailable");
  await assert.rejects(readFile(join(paths.configDirectory, "agent.json"), "utf8"), {
    code: "ENOENT",
  });

  const recovered = await resolveMainAgentComposition({
    paths,
    createAdapter: factory({
      codex: probe("codex", "missing"),
      claude: probe("claude", "ready"),
    }),
  });
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.provider, "claude");
});

test("an explicitly ready provider can re-enable a disabled Main", async (context) => {
  const paths = await runtimePaths(context);
  const disabled = await resolveMainAgentComposition({
    paths,
    requestedProvider: "disabled",
    createAdapter: factory({
      codex: probe("codex", "ready"),
      claude: probe("claude", "ready"),
    }),
  });
  assert.equal(disabled.status, "unavailable");
  assert.equal(disabled.code, "AGENT_DISABLED");

  const notReady = await resolveMainAgentComposition({
    paths,
    requestedProvider: "claude",
    createAdapter: factory({
      codex: probe("codex", "ready"),
      claude: probe("claude", "signed-out"),
    }),
  });
  assert.equal(notReady.status, "unavailable");
  assert.equal(notReady.provider, "claude");
  assert.equal(
    JSON.parse(await readFile(join(paths.configDirectory, "agent.json"), "utf8")).provider,
    "disabled",
  );

  const enabled = await resolveMainAgentComposition({
    paths,
    requestedProvider: "claude",
    createAdapter: factory({
      codex: probe("codex", "ready"),
      claude: probe("claude", "ready"),
    }),
  });
  assert.equal(enabled.status, "ready");
  assert.equal(enabled.provider, "claude");
  assert.equal(
    JSON.parse(await readFile(join(paths.configDirectory, "agent.json"), "utf8")).provider,
    "claude",
  );
});

async function runtimePaths(context: test.TestContext): Promise<MainAgentRuntimePaths> {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-agent-runtime-"));
  context.after(async () => {
    await rm(home, { force: true, recursive: true });
  });
  const configDirectory = join(home, "config");
  const stateDirectory = join(home, "state");
  await Promise.all([
    mkdir(configDirectory, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
  ]);
  return {
    home,
    configDirectory,
    sourceCheckoutRoot: join(home, "source-checkout"),
    stateDirectory,
  };
}

function factory(
  probes: Readonly<Record<"codex" | "claude", AgentAdapterProbe>>,
): (provider: "codex" | "claude") => AgentAdapter {
  return (provider) => new ProbeOnlyAdapter(probes[provider]);
}

class ProbeOnlyAdapter implements AgentAdapter {
  readonly adapterId: string;
  readonly provider: "codex" | "claude";
  readonly #probe: AgentAdapterProbe;

  constructor(probeResult: AgentAdapterProbe) {
    this.#probe = probeResult;
    this.adapterId = probeResult.adapterId;
    this.provider = probeResult.provider as "codex" | "claude";
  }

  async probe(): Promise<AgentAdapterProbe> {
    return structuredClone(this.#probe);
  }

  async start(_request: AgentStartRequest): Promise<AgentRunHandle> {
    throw new Error("not used");
  }

  async resume(_request: AgentResumeRequest): Promise<AgentRunHandle> {
    throw new Error("not used");
  }
}

function probe(
  provider: "codex" | "claude",
  state: "ready" | "missing" | "signed-out",
): AgentAdapterProbe {
  return {
    contractVersion: 1,
    adapterId: `${provider}-cli`,
    provider,
    installed: state !== "missing",
    ...(state === "missing" ? {} : { version: provider === "codex" ? "0.145.0" : "2.1.205" }),
    compatibility: state === "missing" ? "incompatible" : "tested",
    auth: { state: state === "signed-out" ? "not_ready" : state === "ready" ? "ready" : "unknown" },
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
    diagnostics:
      state === "ready"
        ? []
        : [
            {
              code: state === "missing" ? "EXECUTABLE_NOT_FOUND" : "AUTH_NOT_READY",
              message: `${provider} is not ready.`,
            },
          ],
  };
}
