import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_MUTATION_TOOL_NAME,
  PlatformMutationMcpServer,
  type PlatformMutationRunAuthority,
  type PlatformMutationToolInput,
} from "../src/index.ts";

const authority: PlatformMutationRunAuthority = {
  taskId: "task-1",
  workOrderId: "work-order-1",
  runId: "run-1",
  deviceId: "device-1",
  leaseId: "lease-1",
  fencingToken: 4,
  leaseExpiresAtMs: 4_000_000_000_000,
};

test("the internal MCP bridge exposes one typed mutation tool bound to the exact Run", async () => {
  const calls: PlatformMutationToolInput[] = [];
  const server = new PlatformMutationMcpServer({
    authority,
    platform: "linux",
    executableIds: ["apt-get", "ufw"],
    port: {
      async execute(context, input) {
        assert.deepEqual(context.authority, authority);
        assert.equal(context.signal.aborted, false);
        calls.push(input);
        return {
          commandId: "run-mutation:receipt",
          actionCategory: "configured-official-package-install",
          actionFingerprint: `sha256:${"a".repeat(64)}`,
          outcome: "succeeded",
          reasonCode: "POLICY_TRUSTED_PACKAGE_INSTALL",
          exitCode: 0,
          completedAtMs: 1_000,
        };
      },
    },
  });

  const initialized = JSON.parse(
    (await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    )) ?? "{}",
  ) as Record<string, unknown>;
  assert.equal(
    (initialized["result"] as { protocolVersion?: unknown }).protocolVersion,
    "2025-06-18",
  );
  assert.equal(
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ),
    undefined,
  );

  const listed = JSON.parse(
    (await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }))) ??
      "{}",
  ) as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(
    listed.result.tools.map(({ name }) => name),
    [PLATFORM_MUTATION_TOOL_NAME],
  );

  const result = JSON.parse(
    (await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: PLATFORM_MUTATION_TOOL_NAME,
          arguments: {
            kind: "package-install",
            commandId: "package-install-1001",
            manager: "apt-get",
            scope: "system",
            packages: ["ripgrep"],
          },
        },
      }),
    )) ?? "{}",
  ) as {
    result: { content: Array<{ type: string; text: string }>; isError?: boolean };
  };
  assert.equal(result.result.isError, undefined);
  assert.equal(
    (JSON.parse(result.result.content[0]?.text ?? "{}") as { outcome?: unknown }).outcome,
    "succeeded",
  );
  assert.deepEqual(calls, [
    {
      kind: "package-install",
      commandId: "package-install-1001",
      manager: "apt-get",
      scope: "system",
      packages: ["ripgrep"],
    },
  ]);
});

test("the MCP bridge rejects widened tool arguments before the mutation port", async () => {
  let calls = 0;
  const server = new PlatformMutationMcpServer({
    authority,
    platform: "linux",
    executableIds: ["ufw"],
    port: {
      async execute() {
        calls += 1;
        throw new Error("must not execute");
      },
    },
  });
  await server.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  );
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

  const response = JSON.parse(
    (await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: PLATFORM_MUTATION_TOOL_NAME,
          arguments: {
            kind: "protected-command",
            commandId: "firewall-change-1001",
            actionCategory: "firewall-change",
            executableId: "ufw",
            arguments: ["allow", "43190/tcp"],
            shell: true,
          },
        },
      }),
    )) ?? "{}",
  ) as { error?: { code?: unknown } };
  assert.equal(response.error?.code, -32602);
  assert.equal(calls, 0);

  const workspaceEscape = JSON.parse(
    (await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: PLATFORM_MUTATION_TOOL_NAME,
          arguments: {
            kind: "package-install",
            commandId: "package-install-sibling-1002",
            manager: "npm",
            scope: "project",
            packages: ["typescript"],
            workingDirectory: "../sibling-repository",
          },
        },
      }),
    )) ?? "{}",
  ) as { error?: { code?: unknown } };
  assert.equal(workspaceEscape.error?.code, -32602);
  assert.equal(calls, 0);
});
