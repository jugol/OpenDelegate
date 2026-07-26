import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  runComputerUseMcpStdioServer,
  type ComputerUseRunAuthority,
  type ComputerUseToolPort,
} from "../src/index.ts";

const authority: ComputerUseRunAuthority = {
  taskId: "task-stdio",
  workOrderId: "work-order-stdio",
  runId: "run-stdio",
  deviceId: "device-stdio",
  executionHandleId: "execution-stdio",
  lease: {
    resourceName: "desktop-session",
    capacity: 1,
    leaseId: "lease-stdio",
    fencingToken: 11,
    expiresAtMs: 4_102_444_800_000,
  },
  desktopAuthority: {
    helperInstanceId: "helper-stdio",
    serviceEpoch: 2,
    persistenceGeneration: 4,
  },
};

test("the stdio runner emits only JSONL responses on stdout", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputText = collect(output);
  const errorText = collect(stderr);
  const running = runComputerUseMcpStdioServer({
    authority,
    port: unusedPort(),
    input,
    output,
    stderr,
  });

  input.end(
    [
      JSON.stringify(initializeMessage(1)),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      "",
    ].join("\r\n"),
  );
  await running;

  const stdout = outputText();
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  const responses = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    responses.map((response) => response.id),
    [1, 2, 3],
  );
  assert.ok(lines.every((line) => line.startsWith("{") && line.endsWith("}")));
  assert.equal(stdout.includes("computer_use_mcp."), false);
  assert.equal(errorText(), "");
});

test("oversized JSONL is rejected by bytes and the next line still works", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputText = collect(output);
  const errorText = collect(stderr);
  const running = runComputerUseMcpStdioServer({
    authority,
    port: unusedPort(),
    input,
    output,
    stderr,
    limits: { maxInputLineBytes: 256 },
  });

  input.write(`${"界".repeat(256)}\n`);
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
  await running;

  const responses = outputText()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(responses, [
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Input line exceeds the configured byte limit.",
      },
    },
    { jsonrpc: "2.0", id: 2, result: {} },
  ]);
  assert.match(errorText(), /"code":"input_rejected"/);
});

test("stderr diagnostics redact port errors and type_text plaintext", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputText = collect(output);
  const errorText = collect(stderr);
  const port = unusedPort();
  port.typeText = async () => {
    throw new Error("raw failure contains stdio-super-secret");
  };
  const running = runComputerUseMcpStdioServer({
    authority,
    port,
    input,
    output,
    stderr,
  });

  input.end(
    [
      JSON.stringify(initializeMessage(1)),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "computer_use_type_text",
          arguments: {
            controlId: "password",
            text: "stdio-super-secret",
          },
        },
      }),
      "",
    ].join("\n"),
  );
  await running;

  assert.equal(outputText().includes("stdio-super-secret"), false);
  assert.equal(errorText().includes("stdio-super-secret"), false);
  const diagnostics = errorText()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(diagnostics, [
    {
      level: "error",
      event: "computer_use_mcp.tool",
      code: "port_failure",
      tool: "computer_use_type_text",
    },
  ]);
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

function unusedPort(): ComputerUseToolPort {
  const unused = async (): Promise<never> => {
    throw new Error("unexpected port call");
  };
  return {
    readiness: unused,
    observe: unused,
    capture: unused,
    click: unused,
    typeText: unused,
    key: unused,
    scroll: unused,
    stop: unused,
  };
}
