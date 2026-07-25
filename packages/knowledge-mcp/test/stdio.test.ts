import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  runKnowledgeMcpStdioServer,
  type KnowledgeRunAuthority,
  type KnowledgeToolPort,
} from "../src/index.ts";

const authority: KnowledgeRunAuthority = {
  taskId: "task-stdio",
  workOrderId: "work-order-stdio",
  runId: "run-stdio",
  deviceId: "device-stdio",
  leaseId: "lease-stdio",
  fencingToken: 11,
  leaseExpiresAtMs: 4_102_444_800_000,
};

test("stdio emits only JSONL protocol responses and redacted diagnostics", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputText = collect(output);
  const errorText = collect(stderr);
  const port = unusedPort();
  port.search = async () => {
    throw new Error("private-query private-note.md private-content");
  };
  const running = runKnowledgeMcpStdioServer({
    authority,
    port,
    input,
    output,
    stderr,
  });

  input.end(
    [
      JSON.stringify(initializeMessage(1)),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "knowledge_search",
          arguments: { query: "private-query", limit: 1 },
        },
      }),
      "",
    ].join("\n"),
  );
  await running;

  const stdout = outputText();
  const errors = errorText();
  assert.equal(stdout.includes("private-query"), false);
  assert.equal(stdout.includes("private-note.md"), false);
  assert.equal(stdout.includes("private-content"), false);
  assert.equal(errors.includes("private-query"), false);
  assert.equal(errors.includes("private-note.md"), false);
  assert.equal(errors.includes("private-content"), false);
  assert.deepEqual(
    errors
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      {
        level: "error",
        event: "knowledge_mcp.tool",
        code: "port_failure",
        tool: "knowledge_search",
      },
    ],
  );
  assert.ok(
    stdout
      .trim()
      .split("\n")
      .every((line) => line.startsWith("{")),
  );
});

test("oversized input is discarded by bytes and the next request still works", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputText = collect(output);
  const running = runKnowledgeMcpStdioServer({
    authority,
    port: unusedPort(),
    input,
    output,
    stderr,
    limits: { maxInputLineBytes: 1_024 },
  });

  input.write(`${"界".repeat(1_024)}\n`);
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
  await running;

  assert.deepEqual(
    outputText()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Input line exceeds the configured byte limit.",
        },
      },
      { jsonrpc: "2.0", id: 2, result: {} },
    ],
  );
});

function initializeMessage(id: number): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "1.0.0" },
    },
  };
}

function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks).toString("utf8");
}

function unusedPort(): KnowledgeToolPort {
  const unused = async (): Promise<never> => {
    throw new Error("unexpected Knowledge port call");
  };
  return {
    search: unused,
    open: unused,
    relationships: unused,
    upsert: unused,
  };
}
