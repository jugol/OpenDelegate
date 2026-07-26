import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactMcpServer, type ArtifactMcpServerOptions } from "../src/artifact-mcp.ts";

function options(): ArtifactMcpServerOptions & {
  readonly calls: Array<{ readonly kind: string; readonly input: unknown }>;
} {
  const calls: Array<{ readonly kind: string; readonly input: unknown }> = [];
  return {
    authority: {
      taskId: "task-artifact",
      workOrderId: "work-order-artifact",
      runId: "run-artifact",
      deviceId: "device-worker",
      leaseId: "lease-artifact",
      fencingToken: 3,
      leaseExpiresAtMs: Date.now() + 60_000,
    },
    port: {
      writeChunk(_context, input) {
        calls.push({ kind: "write", input });
        return Promise.resolve({
          relativePath: input.relativePath,
          nextOffsetBytes:
            input.offsetBytes + Buffer.from(input.contentBase64, "base64").byteLength,
          replayed: false,
        });
      },
      commit(_context, input) {
        calls.push({ kind: "commit", input });
        return Promise.resolve({
          artifactCount: input.artifacts.length,
          manifestCommitted: true,
          replayed: false,
        });
      },
    },
    calls,
  };
}

test("Artifact MCP exposes only bounded write and commit schemas without host paths", async () => {
  const fixture = options();
  const server = new ArtifactMcpServer(fixture);
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
  ) as { readonly result: unknown };
  assert.ok(initialized.result);
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

  const listed =
    (await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    )) ?? "";
  const publicSchema = listed.toLowerCase();
  assert.equal(publicSchema.includes("sourcepath"), false);
  assert.equal(publicSchema.includes("outputroot"), false);
  assert.equal(publicSchema.includes("manifestpath"), false);
  assert.equal(publicSchema.includes("workingdirectory"), false);
  assert.match(listed, /artifact_write_chunk/u);
  assert.match(listed, /artifact_commit/u);

  const invalid = JSON.parse(
    (await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "artifact_write_chunk",
          arguments: {
            commandId: "write-invalid-0001",
            relativePath: "report.md",
            offsetBytes: 0,
            contentBase64: Buffer.from("safe", "utf8").toString("base64"),
            sourcePath: "C:\\private\\report.md",
          },
        },
      }),
    )) ?? "",
  ) as { readonly error?: unknown };
  assert.ok(invalid.error);
  assert.equal(fixture.calls.length, 0);

  for (const [id, arguments_] of [
    [
      31,
      {
        commandId: "write-traversal-0001",
        relativePath: "../private/report.md",
        offsetBytes: 0,
        contentBase64: Buffer.from("safe", "utf8").toString("base64"),
      },
    ],
    [
      32,
      {
        commandId: "write-oversize-0001",
        relativePath: "report.md",
        offsetBytes: 0,
        contentBase64: Buffer.alloc(256 * 1024 + 1, 0x61).toString("base64"),
      },
    ],
    [
      33,
      {
        commandId: "write-reserved-0001",
        relativePath: "reports/CON.txt",
        offsetBytes: 0,
        contentBase64: Buffer.from("safe", "utf8").toString("base64"),
      },
    ],
    [
      34,
      {
        commandId: "write-trailing-dot-0001",
        relativePath: "reports/final.",
        offsetBytes: 0,
        contentBase64: Buffer.from("safe", "utf8").toString("base64"),
      },
    ],
  ] as const) {
    const rejected = JSON.parse(
      (await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "artifact_write_chunk",
            arguments: arguments_,
          },
        }),
      )) ?? "",
    ) as { readonly error?: unknown };
    assert.ok(rejected.error);
    assert.equal(fixture.calls.length, 0);
  }

  const collidingCommit = JSON.parse(
    (await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 35,
        method: "tools/call",
        params: {
          name: "artifact_commit",
          arguments: {
            commandId: "commit-collision-0001",
            artifacts: [
              {
                relativePath: "Report.md",
                mediaType: "text/markdown",
                originalFilename: "Report.md",
              },
              {
                relativePath: "report.md",
                mediaType: "text/markdown",
                originalFilename: "report.md",
              },
            ],
          },
        },
      }),
    )) ?? "",
  ) as { readonly error?: unknown };
  assert.ok(collidingCommit.error);
  assert.equal(fixture.calls.length, 0);

  const written = JSON.parse(
    (await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "artifact_write_chunk",
          arguments: {
            commandId: "write-valid-0001",
            relativePath: "report.md",
            offsetBytes: 0,
            contentBase64: Buffer.from("safe", "utf8").toString("base64"),
          },
        },
      }),
    )) ?? "",
  ) as { readonly result?: unknown };
  assert.ok(written.result);
  assert.equal(fixture.calls.length, 1);
});
