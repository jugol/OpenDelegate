import assert from "node:assert/strict";
import test from "node:test";

import {
  PlatformMutationError,
  createPlatformMutationExecutor,
  type PlatformMutationAuthorizationRequest,
  type PlatformMutationCommandJournal,
  type PlatformMutationCommandJournalClaim,
  type PlatformMutationCommandJournalEntry,
  type PlatformMutationProcessRequest,
  type PlatformMutationReceipt,
} from "../src/index.ts";

class MemoryMutationJournal implements PlatformMutationCommandJournal {
  readonly #entries = new Map<string, PlatformMutationCommandJournalEntry>();

  public async claim(
    entry: Omit<PlatformMutationCommandJournalEntry, "receipt" | "state">,
  ): Promise<PlatformMutationCommandJournalClaim> {
    const existing = this.#entries.get(entry.commandId);
    if (existing !== undefined) {
      if (existing.actionFingerprint !== entry.actionFingerprint) {
        return { disposition: "conflict" };
      }
      return existing.state === "completed"
        ? { disposition: "completed", receipt: existing.receipt }
        : { disposition: "in-progress" };
    }
    this.#entries.set(entry.commandId, { ...entry, state: "in-progress" });
    return { disposition: "claimed" };
  }

  public async complete(input: {
    readonly commandId: string;
    readonly actionFingerprint: `sha256:${string}`;
    readonly receipt: PlatformMutationReceipt;
  }): Promise<void> {
    const existing = this.#entries.get(input.commandId);
    assert.ok(existing);
    assert.equal(existing.actionFingerprint, input.actionFingerprint);
    this.#entries.set(input.commandId, {
      commandId: existing.commandId,
      actionCategory: existing.actionCategory,
      actionFingerprint: existing.actionFingerprint,
      state: "completed",
      receipt: input.receipt,
    });
  }

  public seed(entry: PlatformMutationCommandJournalEntry): void {
    this.#entries.set(entry.commandId, entry);
  }
}

function linuxExecutor(options: {
  readonly authorize?: (
    request: PlatformMutationAuthorizationRequest,
  ) => Promise<{ readonly decision: "allow" | "deny"; readonly reasonCode: string }>;
  readonly journal?: MemoryMutationJournal;
  readonly preflight?: (
    request: PlatformMutationProcessRequest,
    invocation: number,
  ) => Promise<void>;
  readonly run?: (
    request: PlatformMutationProcessRequest,
  ) => Promise<{ readonly exitCode: number; readonly signal: string | null }>;
}) {
  const authorizationRequests: PlatformMutationAuthorizationRequest[] = [];
  const preflightRequests: PlatformMutationProcessRequest[] = [];
  const processRequests: PlatformMutationProcessRequest[] = [];
  const journal = options.journal ?? new MemoryMutationJournal();
  const executor = createPlatformMutationExecutor({
    platform: "linux",
    executables: {
      "apt-get": "/usr/bin/apt-get",
      npm: "/usr/bin/npm",
      "add-apt-repository": "/usr/bin/add-apt-repository",
      ip: "/usr/sbin/ip",
      tailscale: "/usr/bin/tailscale",
      ufw: "/usr/sbin/ufw",
    },
    authorization: {
      async authorizeAndConsume(request) {
        authorizationRequests.push(request);
        return (
          options.authorize?.(request) ??
          Promise.resolve({ decision: "allow", reasonCode: "ALLOW" })
        );
      },
    },
    journal,
    processPreflight: {
      async assertSafe(request) {
        preflightRequests.push(request);
        await options.preflight?.(request, preflightRequests.length);
      },
    },
    processRunner: {
      async run(request) {
        processRequests.push(request);
        return options.run?.(request) ?? Promise.resolve({ exitCode: 0, signal: null });
      },
    },
    clock: { now: () => 10_000 },
  });
  return { executor, authorizationRequests, preflightRequests, processRequests, journal };
}

test("an existing-source system package install uses fixed argv and automatic Policy", async () => {
  const fixture = linuxExecutor({});
  const signal = new AbortController().signal;
  const receipt = await fixture.executor.execute({
    kind: "package-install",
    commandId: "command-package-0001",
    manager: "apt-get",
    scope: "system",
    packages: ["git", "ripgrep"],
    signal,
  });

  assert.equal(receipt.outcome, "succeeded");
  assert.equal(receipt.actionCategory, "configured-official-package-install");
  assert.deepEqual(fixture.processRequests, [
    {
      commandId: "command-package-0001",
      actionCategory: "configured-official-package-install",
      executableId: "apt-get",
      executable: "/usr/bin/apt-get",
      arguments: ["install", "-y", "--no-install-recommends", "git", "ripgrep"],
      signal,
    },
  ]);
  assert.equal(fixture.authorizationRequests.length, 1);
  assert.equal(
    fixture.authorizationRequests[0]?.actionCategory,
    "configured-official-package-install",
  );
  assert.equal(fixture.authorizationRequests[0]?.actionFingerprint, receipt.actionFingerprint);
});

test("project dependencies stay in the registered working directory and cannot inject options", async () => {
  const fixture = linuxExecutor({});
  await fixture.executor.execute({
    kind: "package-install",
    commandId: "command-package-0002",
    manager: "npm",
    scope: "project",
    packages: ["@types/node@24.10.0"],
    workingDirectory: "/worktrees/task-1",
    signal: new AbortController().signal,
  });
  assert.deepEqual(fixture.processRequests[0], {
    commandId: "command-package-0002",
    actionCategory: "project-dependency-install",
    executableId: "npm",
    executable: "/usr/bin/npm",
    arguments: [
      "install",
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      "@types/node@24.10.0",
    ],
    workingDirectory: "/worktrees/task-1",
    signal: fixture.processRequests[0]?.signal,
  });
  assert.equal(
    JSON.stringify(fixture.authorizationRequests[0]?.actionDescriptor).includes(
      "/worktrees/task-1",
    ),
    false,
  );
  assert.equal(fixture.authorizationRequests[0]?.actionDescriptor["workspace"], "run-workspace");

  await assert.rejects(
    fixture.executor.execute({
      kind: "package-install",
      commandId: "command-package-0003",
      manager: "npm",
      scope: "project",
      packages: ["--registry=https://attacker.invalid"],
      workingDirectory: "/worktrees/task-1",
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof PlatformMutationError && error.code === "MUTATION_REQUEST_INVALID",
  );
});

test("authorization descriptors withhold exact mutation arguments while fingerprints bind them", async () => {
  const privateSentinel = "device-local-knowledge-sentinel-package";
  const first = linuxExecutor({});
  const second = linuxExecutor({});

  await first.executor.execute({
    kind: "package-install",
    commandId: "command-private-descriptor-0001",
    manager: "npm",
    scope: "project",
    packages: [privateSentinel],
    workingDirectory: "/worktrees/private-sentinel",
    signal: new AbortController().signal,
  });
  await second.executor.execute({
    kind: "package-install",
    commandId: "command-private-descriptor-0001",
    manager: "npm",
    scope: "project",
    packages: ["different-package"],
    workingDirectory: "/worktrees/private-sentinel",
    signal: new AbortController().signal,
  });

  const firstRequest = first.authorizationRequests[0];
  const secondRequest = second.authorizationRequests[0];
  assert.ok(firstRequest);
  assert.ok(secondRequest);
  assert.deepEqual(firstRequest.actionDescriptor, {
    platform: "linux",
    executable: "npm",
    argumentCount: 7,
    privacy: "exact-arguments-committed-on-device",
    workspace: "run-workspace",
  });
  assert.equal(JSON.stringify(firstRequest.actionDescriptor).includes(privateSentinel), false);
  assert.notEqual(firstRequest.actionFingerprint, secondRequest.actionFingerprint);
});

test("repository additions and OS mutations require exact authorization before spawn", async () => {
  const fixture = linuxExecutor({
    authorize: async (request) => ({
      decision: request.actionCategory === "package-repository-addition" ? "deny" : "allow",
      reasonCode:
        request.actionCategory === "package-repository-addition" ? "OWNER_DENIED" : "OWNER_GRANTED",
    }),
  });

  const denied = await fixture.executor.execute({
    kind: "protected-command",
    commandId: "command-repository-0001",
    actionCategory: "package-repository-addition",
    executableId: "add-apt-repository",
    arguments: ["ppa:vendor/stable"],
    signal: new AbortController().signal,
  });
  assert.equal(denied.outcome, "denied");
  assert.equal(fixture.processRequests.length, 0);

  const allowed = await fixture.executor.execute({
    kind: "protected-command",
    commandId: "command-firewall-0001",
    actionCategory: "firewall-change",
    executableId: "ufw",
    arguments: ["allow", "43190/tcp"],
    signal: new AbortController().signal,
  });
  assert.equal(allowed.outcome, "succeeded");
  assert.deepEqual(fixture.processRequests[0]?.arguments, ["allow", "43190/tcp"]);
  assert.deepEqual(
    fixture.authorizationRequests.map(({ actionCategory }) => actionCategory),
    ["package-repository-addition", "firewall-change"],
  );
});

test("package preflight rejection and a post-authorization config race never spawn", async () => {
  const rejected = linuxExecutor({
    preflight: async () => {
      throw new Error("unsafe package configuration");
    },
  });
  const request = {
    kind: "package-install" as const,
    commandId: "command-package-preflight-0001",
    manager: "npm" as const,
    scope: "project" as const,
    packages: ["hono@4.10.0"],
    workingDirectory: "/worktrees/task-1",
    signal: new AbortController().signal,
  };
  const denied = await rejected.executor.execute(request);
  assert.equal(denied.outcome, "denied");
  assert.equal(denied.reasonCode, "MUTATION_PREFLIGHT_REJECTED");
  assert.equal(rejected.authorizationRequests.length, 0);
  assert.equal(rejected.processRequests.length, 0);
  assert.equal(rejected.preflightRequests.length, 1);
  assert.deepEqual(await rejected.executor.execute(request), denied);
  assert.equal(rejected.preflightRequests.length, 1);

  const raced = linuxExecutor({
    preflight: async (_request, invocation) => {
      if (invocation === 2) {
        throw new Error("workspace config changed after authorization");
      }
    },
  });
  const racedReceipt = await raced.executor.execute({
    ...request,
    commandId: "command-package-preflight-0002",
  });
  assert.equal(racedReceipt.outcome, "denied");
  assert.equal(racedReceipt.reasonCode, "MUTATION_PREFLIGHT_CHANGED");
  assert.equal(raced.authorizationRequests.length, 1);
  assert.equal(raced.preflightRequests.length, 2);
  assert.equal(raced.processRequests.length, 0);
});

test("category laundering and shell-bearing executable configuration fail closed", async () => {
  const fixture = linuxExecutor({});
  await assert.rejects(
    fixture.executor.execute({
      kind: "protected-command",
      commandId: "command-firewall-0002",
      actionCategory: "firewall-change",
      executableId: "ip",
      arguments: ["route", "add", "default", "via", "10.0.0.1"],
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof PlatformMutationError &&
      error.code === "MUTATION_CATEGORY_EXECUTABLE_MISMATCH",
  );
  assert.equal(fixture.authorizationRequests.length, 0);
  assert.equal(fixture.processRequests.length, 0);

  await assert.rejects(
    fixture.executor.execute({
      kind: "protected-command",
      commandId: "command-vpn-secret-0001",
      actionCategory: "vpn-change",
      executableId: "tailscale",
      arguments: ["up", "--auth-key=tskey-auth-private"],
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof PlatformMutationError && error.code === "MUTATION_REQUEST_INVALID",
  );
  assert.equal(fixture.authorizationRequests.length, 0);
  assert.equal(fixture.processRequests.length, 0);

  assert.throws(
    () =>
      createPlatformMutationExecutor({
        platform: "linux",
        executables: { ufw: "sh -c" },
        authorization: {
          authorizeAndConsume: async () => ({ decision: "allow", reasonCode: "ALLOW" }),
        },
        journal: new MemoryMutationJournal(),
        processPreflight: {
          async assertSafe() {},
        },
        processRunner: {
          run: async () => ({ exitCode: 0, signal: null }),
        },
      }),
    (error: unknown) =>
      error instanceof PlatformMutationError && error.code === "MUTATION_CONFIGURATION_INVALID",
  );
});

test("completed replay returns the durable receipt without a second approval or process", async () => {
  const fixture = linuxExecutor({});
  const request = {
    kind: "protected-command" as const,
    commandId: "command-network-0001",
    actionCategory: "os-network-change" as const,
    executableId: "ip" as const,
    arguments: ["link", "set", "dev", "eth0", "up"],
    signal: new AbortController().signal,
  };
  const first = await fixture.executor.execute(request);
  const replay = await fixture.executor.execute({
    ...request,
    signal: new AbortController().signal,
  });

  assert.deepEqual(replay, first);
  assert.equal(fixture.authorizationRequests.length, 1);
  assert.equal(fixture.processRequests.length, 1);
});

test("in-progress and conflicting durable commands never retry an uncertain mutation", async () => {
  const journal = new MemoryMutationJournal();
  journal.seed({
    commandId: "command-network-0002",
    actionCategory: "os-network-change",
    actionFingerprint: `sha256:${"a".repeat(64)}`,
    state: "in-progress",
  });
  const fixture = linuxExecutor({ journal });

  await assert.rejects(
    fixture.executor.execute({
      kind: "protected-command",
      commandId: "command-network-0002",
      actionCategory: "os-network-change",
      executableId: "ip",
      arguments: ["link", "set", "dev", "eth0", "down"],
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof PlatformMutationError &&
      (error.code === "MUTATION_COMMAND_CONFLICT" || error.code === "MUTATION_OUTCOME_UNKNOWN"),
  );
  assert.equal(fixture.authorizationRequests.length, 0);
  assert.equal(fixture.processRequests.length, 0);
});

test("a native process exception leaves the claimed command fail-closed as uncertain", async () => {
  const fixture = linuxExecutor({
    run: async () => {
      throw new Error("lost subprocess outcome");
    },
  });
  const request = {
    kind: "protected-command" as const,
    commandId: "command-vpn-0001",
    actionCategory: "vpn-change" as const,
    executableId: "ip" as const,
    arguments: ["link", "set", "dev", "wg0", "up"],
    signal: new AbortController().signal,
  };

  await assert.rejects(
    fixture.executor.execute(request),
    (error: unknown) =>
      error instanceof PlatformMutationError && error.code === "MUTATION_OUTCOME_UNKNOWN",
  );
  await assert.rejects(
    fixture.executor.execute({ ...request, signal: new AbortController().signal }),
    (error: unknown) =>
      error instanceof PlatformMutationError && error.code === "MUTATION_OUTCOME_UNKNOWN",
  );
  assert.equal(fixture.authorizationRequests.length, 1);
  assert.equal(fixture.processRequests.length, 1);
});
