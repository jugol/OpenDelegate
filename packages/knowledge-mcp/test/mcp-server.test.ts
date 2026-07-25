import assert from "node:assert/strict";
import test from "node:test";

import {
  createKnowledgeMcpServer,
  type KnowledgeRunAuthority,
  type KnowledgeToolPort,
} from "../src/index.ts";

const authority: KnowledgeRunAuthority = Object.freeze({
  taskId: "task-1",
  workOrderId: "work-order-1",
  runId: "run-1",
  deviceId: "device-1",
  leaseId: "lease-1",
  fencingToken: 7,
  leaseExpiresAtMs: 4_102_444_800_000,
});

test("the MCP lifecycle exposes only bounded device-local Knowledge tools", async () => {
  for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18"]) {
    const server = createKnowledgeMcpServer({ authority, port: unusedPort() });
    const initialized = await request(server, initializeMessage(1, protocolVersion));

    assert.deepEqual(initialized, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "@opendelegate/knowledge-mcp", version: "0.0.0" },
        instructions:
          "Knowledge tools are device-local and confined to one pre-authorized OpenDelegate Worker Run.",
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
    })) as {
      result: { tools: { name: string; inputSchema: { additionalProperties: boolean } }[] };
    };

    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["knowledge_search", "knowledge_open", "knowledge_relationships", "knowledge_upsert"],
    );
    assert.ok(listed.result.tools.every((tool) => tool.inputSchema.additionalProperties === false));
  }
});

test("tool calls receive exact immutable Run authority and return bounded results", async () => {
  const calls: { name: string; authority: KnowledgeRunAuthority; input: unknown }[] = [];
  const port: KnowledgeToolPort = {
    async search(context, input) {
      calls.push({ name: "search", authority: context.authority, input });
      return [{ noteId: "build.md", title: "Build", preview: "Use the local runner." }];
    },
    async open(context, input) {
      calls.push({ name: "open", authority: context.authority, input });
      return {
        characterBudget: input.totalCharacterBudget,
        usedCharacters: 23,
        notes: [
          {
            noteId: "build.md",
            title: "Build",
            content: "# Build\nUse the runner.",
            truncated: false,
          },
        ],
        omittedNoteIds: [],
      };
    },
    async relationships(context, input) {
      calls.push({ name: "relationships", authority: context.authority, input });
      return { outgoing: ["runner.md"], backlinks: [] };
    },
    async upsert(context, input) {
      calls.push({ name: "upsert", authority: context.authority, input });
      return { noteId: input.noteId, operation: "created" };
    },
  };
  const server = createKnowledgeMcpServer({
    authority,
    port,
    limits: {
      maxCumulativeSearchCandidates: 2,
      maxCumulativeOpenCharacters: 64,
      maxCumulativeContextCharacters: 1_024,
    },
  });
  await initialize(server);

  const responses = [
    await call(server, 2, "knowledge_search", { query: "runner", limit: 1 }),
    await call(server, 3, "knowledge_open", {
      noteIds: ["build.md"],
      totalCharacterBudget: 32,
    }),
    await call(server, 4, "knowledge_relationships", { noteId: "build.md" }),
    await call(server, 5, "knowledge_upsert", {
      noteId: "new.md",
      contentKind: "durable-device-knowledge",
      content: "# New\nDurable local fact.",
      qualification: {
        deviceSpecific: true,
        repeatedlyUseful: true,
        expensiveToRediscover: true,
        actionable: true,
      },
    }),
  ];

  assert.ok(
    responses.every(
      (response) => (response as { result?: { isError?: boolean } }).result?.isError === false,
    ),
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    ["search", "open", "relationships", "upsert"],
  );
  assert.ok(calls.every((entry) => assert.deepEqual(entry.authority, authority) === undefined));
});

test("candidate, open, and total context budgets are cumulative per MCP connection", async () => {
  const port: KnowledgeToolPort = {
    async search() {
      return [
        { noteId: "a.md", title: "A", preview: "one" },
        { noteId: "b.md", title: "B", preview: "two" },
      ];
    },
    async open(_context, input) {
      return {
        characterBudget: input.totalCharacterBudget,
        usedCharacters: input.totalCharacterBudget,
        notes: [
          {
            noteId: "a.md",
            title: "A",
            content: "x".repeat(input.totalCharacterBudget),
            truncated: false,
          },
        ],
        omittedNoteIds: [],
      };
    },
    async relationships() {
      return { outgoing: [], backlinks: [] };
    },
    async upsert(_context, input) {
      return { noteId: input.noteId, operation: "updated" };
    },
  };
  const server = createKnowledgeMcpServer({
    authority,
    port,
    limits: {
      maxCumulativeSearchCandidates: 3,
      maxCumulativeOpenCharacters: 10,
      maxCumulativeContextCharacters: 4_096,
    },
  });
  await initialize(server);

  assert.equal(
    (
      (await call(server, 2, "knowledge_search", { query: "a", limit: 2 })) as {
        result: { isError: boolean };
      }
    ).result.isError,
    false,
  );
  assert.equal(
    (
      (await call(server, 3, "knowledge_search", { query: "b", limit: 2 })) as {
        result: { isError: boolean };
      }
    ).result.isError,
    true,
  );
  assert.equal(
    (
      (await call(server, 4, "knowledge_open", {
        noteIds: ["a.md"],
        totalCharacterBudget: 6,
      })) as { result: { isError: boolean } }
    ).result.isError,
    false,
  );
  assert.equal(
    (
      (await call(server, 5, "knowledge_open", {
        noteIds: ["a.md"],
        totalCharacterBudget: 5,
      })) as { result: { isError: boolean } }
    ).result.isError,
    true,
  );
});

test("malformed tool inputs and sensitive port failures fail closed without echoing data", async () => {
  const diagnostics: unknown[] = [];
  const port = unusedPort();
  port.search = async () => {
    throw new Error("secret-query-and-note.md");
  };
  const server = createKnowledgeMcpServer({
    authority,
    port,
    diagnostic: (event) => diagnostics.push(event),
  });
  await initialize(server);

  const malformed = await call(server, 2, "knowledge_open", {
    noteIds: ["../escape.md"],
    totalCharacterBudget: 10,
  });
  const failed = await call(server, 3, "knowledge_search", {
    query: "secret-query-and-note.md",
    limit: 1,
  });
  const serialized = JSON.stringify({ malformed, failed, diagnostics });

  assert.equal(serialized.includes("secret-query-and-note.md"), false);
  assert.equal(serialized.includes("../escape.md"), false);
  assert.deepEqual(diagnostics, [
    {
      level: "warning",
      event: "knowledge_mcp.input",
      code: "input_rejected",
    },
    {
      level: "error",
      event: "knowledge_mcp.tool",
      code: "port_failure",
      tool: "knowledge_search",
    },
  ]);
});

test("rejects port results that exceed the exact request or contradict its identity", async () => {
  const diagnostics: unknown[] = [];
  const port: KnowledgeToolPort = {
    async search() {
      return [
        { noteId: "allowed.md", title: "Allowed", preview: "" },
        { noteId: "overflow-secret.md", title: "Overflow secret", preview: "private" },
      ];
    },
    async open() {
      return {
        characterBudget: 2,
        usedCharacters: 2,
        notes: [
          {
            noteId: "different-secret.md",
            title: "Different secret",
            content: "xx",
            truncated: false,
          },
        ],
        omittedNoteIds: [],
      };
    },
    async relationships() {
      return {
        outgoing: ["duplicate-secret.md", "duplicate-secret.md"],
        backlinks: [],
      };
    },
    async upsert() {
      return { noteId: "different-secret.md", operation: "created" };
    },
  };
  const server = createKnowledgeMcpServer({
    authority,
    port,
    diagnostic: (event) => diagnostics.push(event),
  });
  await initialize(server);

  const responses = [
    await call(server, 2, "knowledge_search", { query: "allowed", limit: 1 }),
    await call(server, 3, "knowledge_open", {
      noteIds: ["allowed.md"],
      totalCharacterBudget: 1,
    }),
    await call(server, 4, "knowledge_relationships", { noteId: "allowed.md" }),
    await call(server, 5, "knowledge_upsert", {
      noteId: "allowed.md",
      contentKind: "durable-device-knowledge",
      content: "# Allowed\nDurable local fact.",
      qualification: {
        deviceSpecific: true,
        repeatedlyUseful: true,
        expensiveToRediscover: true,
        actionable: true,
      },
    }),
  ];

  assert.ok(
    responses.every(
      (response) => (response as { result?: { isError?: boolean } }).result?.isError === true,
    ),
  );
  const serialized = JSON.stringify({ responses, diagnostics });
  for (const privateValue of [
    "overflow-secret",
    "different-secret",
    "duplicate-secret",
    "Overflow secret",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.deepEqual(
    diagnostics.map((entry) => (entry as { code: string }).code),
    [
      "port_result_rejected",
      "port_result_rejected",
      "port_result_rejected",
      "port_result_rejected",
    ],
  );
});

test("cancellation and timeout abort the local port without exposing request data", async () => {
  const diagnostics: unknown[] = [];
  let started: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const port = unusedPort();
  port.search = async (context) => {
    started?.();
    return await new Promise<never>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("private-cancelled-query")), {
        once: true,
      });
    });
  };
  const server = createKnowledgeMcpServer({
    authority,
    port,
    limits: { toolTimeoutMs: 100 },
    diagnostic: (event) => diagnostics.push(event),
  });
  await initialize(server);

  const pending = server.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "cancel-me",
      method: "tools/call",
      params: {
        name: "knowledge_search",
        arguments: { query: "private-cancelled-query", limit: 1 },
      },
    }),
  );
  await entered;
  assert.equal(
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "cancel-me" },
      }),
    ),
    undefined,
  );
  assert.equal(await pending, undefined);
  assert.equal(JSON.stringify(diagnostics).includes("private-cancelled-query"), false);
  assert.deepEqual(diagnostics, [
    {
      level: "warning",
      event: "knowledge_mcp.tool",
      code: "request_cancelled",
      tool: "knowledge_search",
    },
  ]);

  const timedDiagnostics: unknown[] = [];
  const timed = createKnowledgeMcpServer({
    authority,
    port: {
      ...unusedPort(),
      search: async () => new Promise<never>(() => undefined),
    },
    limits: { toolTimeoutMs: 100 },
    diagnostic: (event) => timedDiagnostics.push(event),
  });
  await initialize(timed);
  const timeoutResponse = await call(timed, 2, "knowledge_search", {
    query: "private-timeout-query",
    limit: 1,
  });
  assert.equal(JSON.stringify(timeoutResponse).includes("private-timeout-query"), false);
  assert.deepEqual(timedDiagnostics, [
    {
      level: "error",
      event: "knowledge_mcp.tool",
      code: "request_timed_out",
      tool: "knowledge_search",
    },
  ]);
});

function initializeMessage(
  id: number,
  protocolVersion = "2025-06-18",
): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "knowledge-contract-test", version: "1.0.0" },
    },
  };
}

async function initialize(server: {
  handleLine(line: string): Promise<string | undefined>;
}): Promise<void> {
  await request(server, initializeMessage(1));
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
}

async function call(
  server: { handleLine(line: string): Promise<string | undefined> },
  id: number,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return request(server, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

async function request(
  server: { handleLine(line: string): Promise<string | undefined> },
  message: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const line = await server.handleLine(JSON.stringify(message));
  assert.notEqual(line, undefined);
  return JSON.parse(line ?? "");
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
