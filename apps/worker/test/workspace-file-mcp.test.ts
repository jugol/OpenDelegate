import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceFileMcpServer,
  type WorkspaceFileMcpServerOptions,
} from "../src/workspace-file-mcp.ts";

function options(): WorkspaceFileMcpServerOptions & {
  readonly calls: Array<{ readonly relativePath: string }>;
} {
  const calls: Array<{ readonly relativePath: string }> = [];
  return {
    authority: {
      taskId: "task-workspace-file",
      workOrderId: "work-order-workspace-file",
      runId: "run-workspace-file",
      deviceId: "device-worker",
      leaseId: "lease-workspace-file",
      fencingToken: 3,
      leaseExpiresAtMs: Date.now() + 60_000,
    },
    port: {
      inspect(_context, input) {
        calls.push(input);
        return Promise.resolve({
          relativePath: input.relativePath,
          sizeBytes: 5,
          sha256: "a".repeat(64),
          utf8Valid: true,
          bom: "none",
          finalLf: true,
          text: "safe\n",
        });
      },
    },
    calls,
  };
}

test("Workspace file MCP exposes only one read-only relative-path inspection tool", async () => {
  const fixture = options();
  const server = new WorkspaceFileMcpServer(fixture);
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
    )) ?? "",
  ) as { readonly result?: unknown };
  assert.ok(initialized.result);
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

  const listed =
    (await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    )) ?? "";
  assert.match(listed, /workspace_file_inspect/u);
  assert.match(listed, /"readOnlyHint":true/u);
  assert.equal(listed.includes("workspaceRoot"), false);
  assert.equal(listed.includes("absolutePath"), false);

  const response = JSON.parse(
    (await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "workspace_file_inspect",
          arguments: { relativePath: "result.txt" },
        },
      }),
    )) ?? "",
  ) as {
    readonly result?: {
      readonly content?: readonly { readonly text?: string }[];
    };
  };
  assert.deepEqual(fixture.calls, [{ relativePath: "result.txt" }]);
  assert.deepEqual(JSON.parse(response.result?.content?.[0]?.text ?? ""), {
    relativePath: "result.txt",
    sizeBytes: 5,
    sha256: "a".repeat(64),
    utf8Valid: true,
    bom: "none",
    finalLf: true,
    text: "safe\n",
  });

  const invalid = JSON.parse(
    (await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "workspace_file_inspect",
          arguments: { relativePath: "../private.txt" },
        },
      }),
    )) ?? "",
  ) as { readonly error?: unknown };
  assert.ok(invalid.error);
  assert.equal(fixture.calls.length, 1);
});
