import assert from "node:assert/strict";
import test from "node:test";

import {
  ComputerUseToolPortError,
  createComputerUseMcpServer,
  type ComputerUseRunAuthority,
  type ComputerUseToolPort,
} from "../src/index.ts";

const authority: ComputerUseRunAuthority = {
  taskId: "task-1",
  workOrderId: "work-order-1",
  runId: "run-1",
  deviceId: "device-1",
  executionHandleId: "computer-use-1",
  lease: {
    resourceName: "desktop-session",
    capacity: 1,
    leaseId: "lease-1",
    fencingToken: 7,
    expiresAtMs: 4_102_444_800_000,
  },
  desktopAuthority: {
    helperInstanceId: "helper-1",
    serviceEpoch: 3,
    persistenceGeneration: 9,
  },
};

const port: ComputerUseToolPort = {
  async readiness() {
    throw new Error("not used");
  },
  async observe() {
    throw new Error("not used");
  },
  async capture() {
    throw new Error("not used");
  },
  async click() {
    throw new Error("not used");
  },
  async typeText() {
    throw new Error("not used");
  },
  async key() {
    throw new Error("not used");
  },
  async scroll() {
    throw new Error("not used");
  },
  async stop() {
    throw new Error("not used");
  },
};

test("the MCP lifecycle negotiates each supported revision before exposing tools", async () => {
  for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18"]) {
    const server = createComputerUseMcpServer({ authority, port });
    const initialized = await request(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "contract-test", version: "1.0.0" },
      },
    });

    assert.deepEqual(initialized, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "@opendelegate/computer-use-mcp",
          version: "0.0.0",
        },
        instructions:
          "Computer Use tools are confined to one pre-authorized OpenDelegate Worker Run.",
      },
    });

    assert.equal(
      await server.handleLine(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ),
      undefined,
    );
    const listed = (await request(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as { result: { tools: { name: string }[] } };
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [
        "computer_use_readiness",
        "computer_use_observe",
        "computer_use_capture",
        "computer_use_click",
        "computer_use_type_text",
        "computer_use_key",
        "computer_use_scroll",
        "computer_use_stop",
      ],
    );
  }
});

test("a production composition advertises and accepts only its implemented tools", async () => {
  let keyCalls = 0;
  const server = createComputerUseMcpServer({
    authority,
    port: {
      ...port,
      async key() {
        keyCalls += 1;
        throw new Error("A disabled tool must not reach its port.");
      },
    },
    enabledTools: [
      "computer_use_readiness",
      "computer_use_observe",
      "computer_use_capture",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_stop",
    ],
  });
  await initialize(server);

  const listed = (await request(server, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })) as { result: { tools: { name: string }[] } };
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "computer_use_readiness",
      "computer_use_observe",
      "computer_use_capture",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_stop",
    ],
  );
  assert.deepEqual(await callTool(server, 3, "computer_use_key", { key: "Enter" }), {
    jsonrpc: "2.0",
    id: 3,
    error: { code: -32602, message: "Invalid Computer Use tool arguments." },
  });
  assert.equal(keyCalls, 0);
});

test("ping is the only request allowed before initialization completes", async () => {
  const server = createComputerUseMcpServer({ authority, port });

  assert.deepEqual(
    await request(server, {
      jsonrpc: "2.0",
      id: "ping-1",
      method: "ping",
      params: {},
    }),
    { jsonrpc: "2.0", id: "ping-1", result: {} },
  );
  assert.deepEqual(
    await request(server, {
      jsonrpc: "2.0",
      id: "list-early",
      method: "tools/list",
      params: {},
    }),
    {
      jsonrpc: "2.0",
      id: "list-early",
      error: {
        code: -32002,
        message: "The MCP server has not completed initialization.",
      },
    },
  );

  assert.equal(
    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ),
    undefined,
  );
  assert.deepEqual(
    await request(server, {
      jsonrpc: "2.0",
      id: "still-early",
      method: "tools/list",
      params: {},
    }),
    {
      jsonrpc: "2.0",
      id: "still-early",
      error: {
        code: -32002,
        message: "The MCP server has not completed initialization.",
      },
    },
  );
});

test("unsupported revisions and malformed lifecycle messages fail closed", async () => {
  const diagnostics: unknown[] = [];
  const server = createComputerUseMcpServer({
    authority,
    port,
    diagnostic: (event) => diagnostics.push(event),
  });

  assert.deepEqual(
    await request(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2099-01-01",
        capabilities: {},
        clientInfo: { name: "contract-test", version: "1.0.0" },
      },
    }),
    {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "Unsupported MCP protocol version.",
        data: {
          supported: ["2024-11-05", "2025-03-26", "2025-06-18"],
        },
      },
    },
  );
  assert.deepEqual(
    await request(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contract-test", version: "1.0.0" },
        unexpected: true,
      },
    }),
    {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602, message: "Invalid initialize parameters." },
    },
  );

  await initialize(server);
  assert.deepEqual(
    await request(server, {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contract-test", version: "1.0.0" },
      },
    }),
    {
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32600, message: "Invalid initialize request." },
    },
  );
  assert.ok(diagnostics.length >= 2);
});

test("JSON-RPC envelope, keys, batches, and line size are strict", async () => {
  const server = createComputerUseMcpServer({
    authority,
    port,
    limits: { maxInputLineBytes: 256 },
  });

  assert.deepEqual(JSON.parse((await server.handleLine("{")) ?? ""), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error." },
  });
  assert.deepEqual(JSON.parse((await server.handleLine("[]")) ?? ""), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid JSON-RPC request." },
  });
  assert.deepEqual(
    await request(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: {},
      injected: true,
    }),
    {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Invalid JSON-RPC request." },
    },
  );

  const oversized = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "ping",
    params: { padding: "界".repeat(256) },
  });
  assert.deepEqual(JSON.parse((await server.handleLine(oversized)) ?? ""), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Input line exceeds the configured byte limit." },
  });
});

test("tool list schemas reject undeclared arguments and describe mutations explicitly", async () => {
  const server = createComputerUseMcpServer({ authority, port });
  await initialize(server);
  const response = (await request(server, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  })) as {
    result: {
      tools: {
        name: string;
        inputSchema: {
          type: string;
          required?: string[];
          additionalProperties: boolean;
        };
        annotations?: { readOnlyHint: boolean; destructiveHint: boolean };
      }[];
    };
  };

  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const click = response.result.tools.find((tool) => tool.name === "computer_use_click");
  assert.deepEqual(click?.inputSchema.required, ["controlId"]);
  assert.deepEqual(click?.annotations, {
    title: "Click desktop control",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });

  assert.deepEqual(
    await request(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { cursor: "not-supported" },
    }),
    {
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: "Invalid tools/list parameters." },
    },
  );
});

test("all Computer Use tools receive the exact immutable Run authority", async () => {
  const calls: {
    name: string;
    authority: ComputerUseRunAuthority;
    input?: unknown;
  }[] = [];
  const toolPort: ComputerUseToolPort = {
    async readiness(context) {
      calls.push({ name: "readiness", authority: context.authority });
      return {
        status: "ready",
        osFamily: "windows",
        backendId: "windows-ui-automation",
        displayFingerprint: "display-1",
        checks: [
          {
            name: "screen-capture",
            status: "pass",
            evidence: "Capture permission is ready.",
          },
        ],
      };
    },
    async observe(context) {
      calls.push({ name: "observe", authority: context.authority });
      return {
        displayFingerprint: "display-1",
        summary: "One text box is visible.",
        controls: [
          {
            controlId: "name",
            role: "textbox",
            label: "Name",
            value: "",
          },
        ],
      };
    },
    async capture(context) {
      calls.push({ name: "capture", authority: context.authority });
      return {
        png: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
        width: 640,
        height: 480,
        capturedAtMs: 1_750_000_000_000,
        displayFingerprint: "display-1",
      };
    },
    async click(context, input) {
      calls.push({ name: "click", authority: context.authority, input });
      return actionReceipt(1);
    },
    async typeText(context, input) {
      calls.push({ name: "typeText", authority: context.authority, input });
      return actionReceipt(2);
    },
    async key(context, input) {
      calls.push({ name: "key", authority: context.authority, input });
      return actionReceipt(3);
    },
    async scroll(context, input) {
      calls.push({ name: "scroll", authority: context.authority, input });
      return actionReceipt(4);
    },
    async stop(context, input) {
      calls.push({ name: "stop", authority: context.authority, input });
      return { status: "stopped" };
    },
  };
  const server = createComputerUseMcpServer({ authority, port: toolPort });
  await initialize(server);

  const readiness = await callTool(server, 10, "computer_use_readiness", {});
  assert.deepEqual(readTextResult(readiness), {
    status: "ready",
    osFamily: "windows",
    backendId: "windows-ui-automation",
    displayFingerprint: "display-1",
    checks: [
      {
        name: "screen-capture",
        status: "pass",
        evidence: "Capture permission is ready.",
      },
    ],
  });

  const observation = await callTool(server, 11, "computer_use_observe", {});
  assert.deepEqual(readTextResult(observation), {
    displayFingerprint: "display-1",
    summary: "One text box is visible.",
    controls: [
      {
        controlId: "name",
        role: "textbox",
        label: "Name",
        value: "",
      },
    ],
  });

  const capture = (await callTool(server, 12, "computer_use_capture", {})) as {
    result: {
      content: [{ type: "image"; data: string; mimeType: string }, { type: "text"; text: string }];
      isError: boolean;
    };
  };
  assert.deepEqual(capture.result.content[0], {
    type: "image",
    data: "iVBORw0KGgo=",
    mimeType: "image/png",
  });
  assert.deepEqual(JSON.parse(capture.result.content[1].text), {
    width: 640,
    height: 480,
    sha256: "sha256:4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6",
    capturedAtMs: 1_750_000_000_000,
    displayFingerprint: "display-1",
  });
  assert.equal(capture.result.isError, false);

  await callTool(server, 13, "computer_use_click", { controlId: "submit" });
  await callTool(server, 14, "computer_use_type_text", {
    controlId: "name",
    text: "sensitive plaintext",
  });
  await callTool(server, 15, "computer_use_key", {
    key: "Enter",
    modifiers: ["control", "shift"],
  });
  await callTool(server, 16, "computer_use_scroll", {
    deltaX: 0,
    deltaY: 480,
  });
  await callTool(server, 17, "computer_use_stop", {
    mode: "emergency-stop",
  });

  assert.deepEqual(
    calls.map(({ name, input }) => ({ name, input })),
    [
      { name: "readiness", input: undefined },
      { name: "observe", input: undefined },
      { name: "capture", input: undefined },
      { name: "click", input: { controlId: "submit" } },
      {
        name: "typeText",
        input: { controlId: "name", text: "sensitive plaintext" },
      },
      {
        name: "key",
        input: { key: "Enter", modifiers: ["control", "shift"] },
      },
      { name: "scroll", input: { deltaX: 0, deltaY: 480 } },
      { name: "stop", input: { mode: "emergency-stop" } },
    ],
  );
  assert.ok(calls.every((call) => Object.isFrozen(call.authority)));
  assert.ok(calls.every((call) => Object.isFrozen(call.authority.lease)));
  assert.ok(calls.every((call) => Object.isFrozen(call.authority.desktopAuthority)));
  assert.ok(calls.every((call) => deepEqualAuthority(call.authority, authority)));
});

test("unknown tools and invalid arguments never reach the execution port", async () => {
  let calls = 0;
  const toolPort = countingPort(() => {
    calls += 1;
  });
  const server = createComputerUseMcpServer({ authority, port: toolPort });
  await initialize(server);

  for (const [id, name, argumentsValue] of [
    [10, "computer_use_missing", {}],
    [11, "computer_use_click", { controlId: "submit", extra: true }],
    [12, "computer_use_type_text", { controlId: "name" }],
    [13, "computer_use_key", { key: "Enter", modifiers: ["control", "control"] }],
    [14, "computer_use_scroll", { deltaX: 10_001, deltaY: 0 }],
    [15, "computer_use_stop", { mode: "finish" }],
    [16, "computer_use_type_text", { controlId: "name", text: "unsafe\u0000text" }],
  ] as const) {
    assert.deepEqual(await callTool(server, id, name, argumentsValue), {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Invalid Computer Use tool arguments." },
    });
  }
  assert.equal(calls, 0);
});

test("client cancellation aborts an active port call and suppresses its response", async () => {
  let signal: AbortSignal | undefined;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const toolPort = countingPort(() => undefined);
  toolPort.typeText = async (context) => {
    signal = context.signal;
    startedResolve?.();
    return new Promise((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => reject(new ComputerUseToolPortError("CANCELLED")),
        { once: true },
      );
    });
  };
  const diagnostics: unknown[] = [];
  const server = createComputerUseMcpServer({
    authority,
    port: toolPort,
    limits: { maxInFlightToolCalls: 1 },
    diagnostic: (event) => diagnostics.push(event),
  });
  await initialize(server);

  const pending = server.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "sensitive-call",
      method: "tools/call",
      params: {
        name: "computer_use_type_text",
        arguments: { controlId: "password", text: "never-log-this-password" },
      },
    }),
  );
  await started;
  assert.equal(signal?.aborted, false);
  assert.deepEqual(
    await request(server, {
      jsonrpc: "2.0",
      id: "sensitive-call",
      method: "ping",
    }),
    {
      jsonrpc: "2.0",
      id: "sensitive-call",
      error: {
        code: -32600,
        message: "Duplicate active request ID.",
      },
    },
  );
  assert.deepEqual(await callTool(server, 99, "computer_use_click", { controlId: "other" }), {
    jsonrpc: "2.0",
    id: 99,
    error: {
      code: -32000,
      message: "Computer Use tool capacity is exhausted.",
    },
  });
  assert.equal(
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {
          requestId: "sensitive-call",
          reason: "reason also contains never-log-this-password",
        },
      }),
    ),
    undefined,
  );

  assert.equal(await pending, undefined);
  assert.equal(signal?.aborted, true);
  assert.ok(diagnostics.some((event) => (event as { code?: string }).code === "request_cancelled"));
  assert.equal(JSON.stringify(diagnostics).includes("never-log-this-password"), false);
});

test("a hard tool timeout aborts the port without waiting for a misbehaving promise", async () => {
  let signal: AbortSignal | undefined;
  const diagnostics: unknown[] = [];
  const toolPort = countingPort(() => undefined);
  toolPort.observe = async (context) => {
    signal = context.signal;
    return new Promise(() => undefined);
  };
  const server = createComputerUseMcpServer({
    authority,
    port: toolPort,
    limits: { toolTimeoutMs: 10 },
    diagnostic: (event) => diagnostics.push(event),
  });
  await initialize(server);

  assert.deepEqual(await callTool(server, 19, "computer_use_observe", {}), {
    jsonrpc: "2.0",
    id: 19,
    result: {
      content: [
        {
          type: "text",
          text: "Computer Use tool execution exceeded its configured timeout.",
        },
      ],
      isError: true,
    },
  });
  assert.equal(signal?.aborted, true);
  assert.ok(diagnostics.some((event) => (event as { code?: string }).code === "request_timed_out"));
});

test("port failures are fixed tool errors and never repeat type_text plaintext", async () => {
  const diagnostics: unknown[] = [];
  const toolPort = countingPort(() => undefined);
  toolPort.typeText = async () => {
    throw new Error("provider leaked super-secret-input in its error");
  };
  toolPort.key = async () => {
    throw new ComputerUseToolPortError("UNSUPPORTED");
  };
  const server = createComputerUseMcpServer({
    authority,
    port: toolPort,
    diagnostic: (event) => diagnostics.push(event),
  });
  await initialize(server);

  const failed = await callTool(server, 20, "computer_use_type_text", {
    controlId: "password",
    text: "super-secret-input",
  });
  assert.deepEqual(failed, {
    jsonrpc: "2.0",
    id: 20,
    result: {
      content: [
        {
          type: "text",
          text: "Computer Use tool execution failed.",
        },
      ],
      isError: true,
    },
  });
  assert.equal(JSON.stringify(failed).includes("super-secret-input"), false);
  assert.equal(JSON.stringify(diagnostics).includes("super-secret-input"), false);

  const unsupported = await callTool(server, 21, "computer_use_key", {
    key: "Enter",
  });
  assert.deepEqual(unsupported, {
    jsonrpc: "2.0",
    id: 21,
    result: {
      content: [
        {
          type: "text",
          text: "This Computer Use operation is not supported by the active backend.",
        },
      ],
      isError: true,
    },
  });
});

test("invalid or oversized port results fail closed without forwarding bytes", async () => {
  const diagnostics: unknown[] = [];
  const toolPort = countingPort(() => undefined);
  toolPort.capture = async () => {
    const png = new Uint8Array(1_025);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    return {
      png,
      width: 1,
      height: 1,
      capturedAtMs: 1,
      displayFingerprint: "display-1",
    };
  };
  const server = createComputerUseMcpServer({
    authority,
    port: toolPort,
    limits: { maxCaptureBytes: 1_024 },
    diagnostic: (event) => diagnostics.push(event),
  });
  await initialize(server);

  assert.deepEqual(await callTool(server, 30, "computer_use_capture", {}), {
    jsonrpc: "2.0",
    id: 30,
    result: {
      content: [
        {
          type: "text",
          text: "Computer Use tool execution failed.",
        },
      ],
      isError: true,
    },
  });
  assert.ok(
    diagnostics.some((event) => (event as { code?: string }).code === "port_result_rejected"),
  );
});

async function request(
  server: ReturnType<typeof createComputerUseMcpServer>,
  message: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const line = await server.handleLine(JSON.stringify(message));
  assert.ok(line);
  return JSON.parse(line);
}

async function initialize(server: ReturnType<typeof createComputerUseMcpServer>): Promise<void> {
  await request(server, {
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "contract-test", version: "1.0.0" },
    },
  });
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
}

async function callTool(
  server: ReturnType<typeof createComputerUseMcpServer>,
  id: number,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return request(server, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: argumentsValue },
  });
}

function readTextResult(value: unknown): unknown {
  const response = value as {
    result: { content: [{ type: "text"; text: string }]; isError: boolean };
  };
  assert.equal(response.result.content[0].type, "text");
  assert.equal(response.result.isError, false);
  return JSON.parse(response.result.content[0].text);
}

function actionReceipt(sequence: number) {
  return {
    sequence,
    executedAtMs: 1_750_000_000_000 + sequence,
    displayFingerprint: "display-1",
  };
}

function deepEqualAuthority(
  actual: ComputerUseRunAuthority,
  expected: ComputerUseRunAuthority,
): boolean {
  assert.deepEqual(actual, expected);
  return true;
}

function countingPort(onCall: () => void): ComputerUseToolPort {
  return {
    async readiness() {
      onCall();
      return {
        status: "unavailable",
        osFamily: "linux",
        backendId: "unavailable",
        displayFingerprint: null,
        checks: [],
      };
    },
    async observe() {
      onCall();
      return { displayFingerprint: "display", summary: "", controls: [] };
    },
    async capture() {
      onCall();
      return {
        png: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
        width: 1,
        height: 1,
        capturedAtMs: 1,
        displayFingerprint: "display",
      };
    },
    async click() {
      onCall();
      return actionReceipt(1);
    },
    async typeText() {
      onCall();
      return actionReceipt(1);
    },
    async key() {
      onCall();
      return actionReceipt(1);
    },
    async scroll() {
      onCall();
      return actionReceipt(1);
    },
    async stop() {
      onCall();
      return { status: "stopped" };
    },
  };
}
