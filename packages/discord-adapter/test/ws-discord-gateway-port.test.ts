import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DISCORD_API_VERSION,
  DISCORD_GATEWAY_INTENTS,
  WsDiscordGatewayPort,
  type DiscordBotCredentialProvider,
  type DiscordGatewayDiagnostic,
  type DiscordGatewayDispatch,
  type DiscordGatewayScheduler,
  type DiscordGatewaySocket,
  type DiscordGatewaySocketFactory,
} from "../src/index.ts";

const SECRET = "gateway-bot-secret-never-diagnosed";
const SESSION_ID = "gateway-session-1";
const RESUME_URL = "wss://resume.discord.gg";
const GUILD_ID = "100000000000000001";
const THREAD_ID = "100000000000000003";
const BOT_ID = "100000000000000005";

test("the Gateway driver identifies, dispatches supported events, heartbeats with jitter, and resumes after a missing ACK", async () => {
  const fixture = gatewayFixture();
  const dispatches: DiscordGatewayDispatch[] = [];
  const sessions: unknown[] = [];
  let reconciliations = 0;

  const connection = await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: undefined,
    onDispatch: async (dispatch) => {
      dispatches.push(dispatch);
    },
    onSessionEstablished: async (session) => {
      sessions.push(session);
    },
    onReconcileRequired: async () => {
      reconciliations += 1;
    },
  });

  const first = fixture.factory.sockets[0];
  assert.ok(first);
  assert.equal(fixture.factory.urls[0], "wss://gateway.discord.gg/?v=10&encoding=json");
  first.emitOpen();
  first.emitJson({ op: 10, d: { heartbeat_interval: 1_000 } });
  await fixture.flush();

  assert.deepEqual(redactToken(first.sent[0]), {
    op: 2,
    d: {
      token: "[REDACTED]",
      intents: DISCORD_GATEWAY_INTENTS,
      properties: {
        os: process.platform,
        browser: "opendelegate",
        device: "opendelegate",
      },
    },
  });
  assert.deepEqual(fixture.scheduler.delays(), [500]);

  first.emitJson({
    op: 0,
    s: 1,
    t: "READY",
    d: {
      session_id: SESSION_ID,
      resume_gateway_url: RESUME_URL,
    },
  });
  first.emitJson({
    op: 0,
    s: 2,
    t: "MESSAGE_CREATE",
    d: rawMessage("100000000000000010", "Continue the Task"),
  });
  await fixture.flush();

  assert.deepEqual(sessions, [
    {
      sessionId: SESSION_ID,
      resumeGatewayUrl: RESUME_URL,
      sequence: 1,
    },
  ]);
  assert.equal(reconciliations, 1);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]?.type, "MESSAGE_CREATE");
  assert.equal(
    dispatches[0]?.type === "MESSAGE_CREATE" && dispatches[0].message.content,
    "Continue the Task",
  );

  await fixture.scheduler.runNext();
  assert.deepEqual(JSON.parse(first.sent.at(-1) ?? "{}"), { op: 1, d: 2 });
  await fixture.scheduler.runNext();
  assert.equal(first.terminated, true);

  await fixture.scheduler.runNext();
  const resumed = fixture.factory.sockets[1];
  assert.ok(resumed);
  assert.equal(fixture.factory.urls[1], `${RESUME_URL}/?v=10&encoding=json`);
  resumed.emitOpen();
  resumed.emitJson({ op: 10, d: { heartbeat_interval: 1_000 } });
  await fixture.flush();
  assert.deepEqual(redactToken(resumed.sent[0]), {
    op: 6,
    d: {
      token: "[REDACTED]",
      session_id: SESSION_ID,
      seq: 2,
    },
  });

  await connection.close();
  assert.equal(resumed.closedWith?.code, 1000);
  assert.equal(fixture.scheduler.size, 0);
});

test("Gateway shutdown waits for close acknowledgement and confirms bounded termination", async () => {
  const fixture = gatewayFixture();
  fixture.factory.autoConfirmClose = false;
  const connection = await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: undefined,
    onDispatch: async () => undefined,
    onSessionEstablished: async () => undefined,
    onReconcileRequired: async () => undefined,
  });
  const socket = fixture.factory.sockets[0];
  assert.ok(socket);
  let settled = false;
  const closing = connection.close().then(() => {
    settled = true;
  });
  await fixture.flush();

  assert.equal(settled, false);
  assert.equal(socket.closedWith?.code, 1000);
  await fixture.scheduler.runNext();
  await closing;
  assert.equal(socket.terminated, true);
  assert.equal(settled, true);
  assert.equal(fixture.scheduler.size, 0);
});

test("Gateway shutdown rejects when neither graceful close nor termination is acknowledged", async () => {
  const fixture = gatewayFixture();
  fixture.factory.autoConfirmClose = false;
  fixture.factory.confirmTerminate = false;
  const connection = await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: undefined,
    onDispatch: async () => undefined,
    onSessionEstablished: async () => undefined,
    onReconcileRequired: async () => undefined,
  });
  const closing = connection.close();
  await fixture.flush();
  await fixture.scheduler.runNext();
  await fixture.scheduler.runNext();

  await assert.rejects(closing, /shutdown could not be confirmed/u);
});

test("Gateway shutdown cancels an in-flight reconnect discovery before it can create a socket", async () => {
  let discoveryCalls = 0;
  let resolveReconnectDiscovery = (_url: string): void => undefined;
  const fixture = gatewayFixture({
    getGatewayBotUrl: async () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) {
        return "wss://gateway.discord.gg";
      }
      return new Promise<string>((resolve) => {
        resolveReconnectDiscovery = resolve;
      });
    },
  });
  const connection = await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: undefined,
    onDispatch: async () => undefined,
    onSessionEstablished: async () => undefined,
    onReconcileRequired: async () => undefined,
  });
  const socket = fixture.factory.sockets[0];
  assert.ok(socket);
  socket.emitClose(1000);
  await fixture.scheduler.runReconnect();
  assert.equal(discoveryCalls, 2);

  await connection.close();
  resolveReconnectDiscovery("wss://late-gateway.discord.gg");
  await fixture.flush();

  assert.equal(fixture.factory.sockets.length, 1);
  assert.equal(fixture.scheduler.size, 0);
});

test("a non-resumable Invalid Session clears the cursor, re-identifies, and requests HTTP reconciliation", async () => {
  const fixture = gatewayFixture();
  let reconciliations = 0;
  await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: {
      sessionId: "old-session",
      resumeGatewayUrl: RESUME_URL,
      sequence: 41,
      updatedAtMs: 1_000,
    },
    onDispatch: async () => undefined,
    onSessionEstablished: async () => undefined,
    onReconcileRequired: async () => {
      reconciliations += 1;
    },
  });

  const first = fixture.factory.sockets[0];
  assert.ok(first);
  first.emitOpen();
  first.emitJson({ op: 10, d: { heartbeat_interval: 1_000 } });
  await fixture.flush();
  assert.equal((JSON.parse(first.sent[0] ?? "{}") as { op?: number }).op, 6);

  first.emitJson({ op: 9, d: false });
  await fixture.flush();
  assert.equal(first.terminated, true);
  await fixture.scheduler.runReconnect();

  const second = fixture.factory.sockets[1];
  assert.ok(second);
  assert.equal(fixture.factory.urls[1], "wss://gateway.discord.gg/?v=10&encoding=json");
  second.emitOpen();
  second.emitJson({ op: 10, d: { heartbeat_interval: 1_000 } });
  await fixture.flush();
  assert.equal((JSON.parse(second.sent[0] ?? "{}") as { op?: number }).op, 2);

  second.emitJson({
    op: 0,
    s: 1,
    t: "READY",
    d: {
      session_id: "replacement-session",
      resume_gateway_url: "wss://replacement.discord.gg",
    },
  });
  await fixture.flush();
  assert.equal(reconciliations, 1);
});

test("unsupported dispatches are ignored, malformed supported dispatches reconnect without advancing durable delivery", async () => {
  const fixture = gatewayFixture();
  const dispatches: DiscordGatewayDispatch[] = [];
  await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: undefined,
    onDispatch: async (dispatch) => {
      dispatches.push(dispatch);
    },
    onSessionEstablished: async () => undefined,
    onReconcileRequired: async () => undefined,
  });
  const socket = fixture.factory.sockets[0];
  assert.ok(socket);
  socket.emitOpen();
  socket.emitJson({ op: 10, d: { heartbeat_interval: 1_000 } });
  socket.emitJson({
    op: 0,
    s: 1,
    t: "READY",
    d: { session_id: SESSION_ID, resume_gateway_url: RESUME_URL },
  });
  socket.emitJson({ op: 0, s: 2, t: "PRESENCE_UPDATE", d: { secret: "ignored" } });
  socket.emitJson({
    op: 0,
    s: 3,
    t: "THREAD_CREATE",
    d: { id: "100000000000000099", type: 12 },
  });
  await fixture.flush();
  assert.deepEqual(dispatches, []);
  assert.equal(socket.terminated, false);

  socket.emitJson({
    op: 0,
    s: 4,
    t: "MESSAGE_CREATE",
    d: { id: "not-a-complete-message" },
  });
  await fixture.flush();
  assert.equal(socket.terminated, true);
  assert.equal(
    fixture.diagnostics.some(
      (diagnostic) => diagnostic.event === "discord.gateway.invalid_payload",
    ),
    true,
  );
  assert.equal(JSON.stringify(fixture.diagnostics).includes("not-a-complete-message"), false);
});

test("the Gateway wire mapper accepts only reviewed thread and component-interaction dispatch shapes", async () => {
  const fixture = gatewayFixture();
  const dispatches: DiscordGatewayDispatch[] = [];
  const connection = await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: undefined,
    onDispatch: async (dispatch) => {
      dispatches.push(dispatch);
    },
    onSessionEstablished: async () => undefined,
    onReconcileRequired: async () => undefined,
  });
  const socket = fixture.factory.sockets[0];
  assert.ok(socket);
  socket.emitOpen();
  socket.emitJson({ op: 10, d: { heartbeat_interval: 1_000 } });
  socket.emitJson({
    op: 0,
    s: 1,
    t: "READY",
    d: { session_id: SESSION_ID, resume_gateway_url: RESUME_URL },
  });
  const taglessThread = rawThread(false) as Record<string, unknown>;
  delete taglessThread["applied_tags"];
  socket.emitJson({ op: 0, s: 2, t: "THREAD_CREATE", d: taglessThread });
  socket.emitJson({ op: 0, s: 3, t: "THREAD_UPDATE", d: rawThread(true) });
  socket.emitJson({
    op: 0,
    s: 4,
    t: "THREAD_DELETE",
    d: { id: THREAD_ID, guild_id: GUILD_ID, parent_id: "100000000000000002", type: 11 },
  });
  socket.emitJson({
    op: 0,
    s: 5,
    t: "INTERACTION_CREATE",
    d: {
      id: "100000000000000020",
      token: "transient-interaction-token",
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      type: 3,
      data: { custom_id: "task:pause" },
      message: {
        id: "100000000000000021",
        author: { id: BOT_ID, bot: true },
      },
      member: {
        user: { id: "100000000000000004", bot: false },
        roles: [],
      },
    },
  });
  await fixture.flush();

  assert.deepEqual(
    dispatches.map(({ type }) => type),
    ["THREAD_CREATE", "THREAD_UPDATE", "THREAD_DELETE", "INTERACTION_CREATE"],
  );
  assert.equal(
    dispatches[3]?.type === "INTERACTION_CREATE" && dispatches[3].interaction.receivedAtMs,
    1_000,
  );
  assert.equal(
    dispatches[3]?.type === "INTERACTION_CREATE" && dispatches[3].interaction.messageAuthorId,
    BOT_ID,
  );
  assert.deepEqual(
    dispatches[0]?.type === "THREAD_CREATE" ? dispatches[0].thread.appliedTagIds : undefined,
    [],
  );
  assert.equal(JSON.stringify(fixture.diagnostics).includes("transient-interaction-token"), false);
  await connection.close();
});

test("an interaction keeps its socket-receive clock while earlier dispatch work is blocked", async () => {
  const fixture = gatewayFixture();
  const dispatches: DiscordGatewayDispatch[] = [];
  let releaseMessage!: () => void;
  const messageBlocked = new Promise<void>((resolve) => {
    releaseMessage = resolve;
  });
  await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: undefined,
    onDispatch: async (dispatch) => {
      dispatches.push(dispatch);
      if (dispatch.type === "MESSAGE_CREATE") {
        await messageBlocked;
      }
    },
    onSessionEstablished: async () => undefined,
    onReconcileRequired: async () => undefined,
  });
  const socket = fixture.factory.sockets[0];
  assert.ok(socket);
  socket.emitOpen();
  socket.emitJson({ op: 10, d: { heartbeat_interval: 1_000 } });
  socket.emitJson({
    op: 0,
    s: 1,
    t: "READY",
    d: { session_id: SESSION_ID, resume_gateway_url: RESUME_URL },
  });
  await fixture.flush();

  socket.emitJson({
    op: 0,
    s: 2,
    t: "MESSAGE_CREATE",
    d: rawMessage("100000000000000030", "Block the ordered dispatch tail"),
  });
  await fixture.flush();
  fixture.scheduler.setNow(1_500);
  socket.emitJson({
    op: 0,
    s: 3,
    t: "INTERACTION_CREATE",
    d: {
      id: "100000000000000031",
      token: "transient-interaction-token",
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      type: 3,
      data: { custom_id: "od:v1:pause" },
      message: { id: "100000000000000032", author: { id: BOT_ID, bot: true } },
      member: { user: { id: "100000000000000004", bot: false }, roles: [] },
    },
  });
  fixture.scheduler.setNow(5_000);
  releaseMessage();
  await fixture.flush();

  const interaction = dispatches.find((dispatch) => dispatch.type === "INTERACTION_CREATE");
  assert.equal(
    interaction?.type === "INTERACTION_CREATE" && interaction.interaction.receivedAtMs,
    1_500,
  );
});

test("fatal Discord close codes stop reconnect loops and diagnostics never contain credentials", async () => {
  const fixture = gatewayFixture();
  await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: undefined,
    onDispatch: async () => undefined,
    onSessionEstablished: async () => undefined,
    onReconcileRequired: async () => undefined,
  });
  const socket = fixture.factory.sockets[0];
  assert.ok(socket);
  socket.emitOpen();
  socket.emitJson({ op: 10, d: { heartbeat_interval: 1_000 } });
  await fixture.flush();

  socket.emitClose(4014);
  await fixture.flush();
  assert.equal(fixture.scheduler.hasReconnect(), false);
  assert.equal(
    fixture.diagnostics.some(
      (diagnostic) =>
        diagnostic.event === "discord.gateway.closed_terminal" &&
        diagnostic.fields["closeCode"] === 4014,
    ),
    true,
  );
  assert.equal(JSON.stringify(fixture.diagnostics).includes(SECRET), false);
});

test("Gateway frames are bounded before JSON parsing", async () => {
  const fixture = gatewayFixture({ maximumFrameBytes: 128 });
  await fixture.gateway.connect({
    apiVersion: DISCORD_API_VERSION,
    intentBitfield: DISCORD_GATEWAY_INTENTS,
    resume: undefined,
    onDispatch: async () => undefined,
    onSessionEstablished: async () => undefined,
    onReconcileRequired: async () => undefined,
  });
  const socket = fixture.factory.sockets[0];
  assert.ok(socket);
  socket.emitOpen();
  socket.emitText("x".repeat(129));
  await fixture.flush();
  assert.equal(socket.terminated, true);
  assert.equal(
    fixture.diagnostics.some(
      (diagnostic) => diagnostic.event === "discord.gateway.frame_too_large",
    ),
    true,
  );
});

function gatewayFixture(overrides?: {
  maximumFrameBytes?: number;
  getGatewayBotUrl?: () => Promise<string>;
}) {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler(0.5);
  const diagnostics: DiscordGatewayDiagnostic[] = [];
  const credentialProvider: DiscordBotCredentialProvider = {
    withBotToken: async (operation) => operation(SECRET),
  };
  const gateway = new WsDiscordGatewayPort({
    credentialProvider,
    discovery: {
      getGatewayBotUrl: overrides?.getGatewayBotUrl ?? (async () => "wss://gateway.discord.gg"),
    },
    socketFactory: factory,
    scheduler,
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    ...(overrides?.maximumFrameBytes === undefined
      ? {}
      : { maximumFrameBytes: overrides.maximumFrameBytes }),
  });
  return {
    diagnostics,
    factory,
    gateway,
    scheduler,
    flush: async () => {
      for (let index = 0; index < 32; index += 1) {
        await Promise.resolve();
      }
    },
  };
}

class FakeSocketFactory implements DiscordGatewaySocketFactory {
  readonly sockets: FakeSocket[] = [];
  readonly urls: string[] = [];
  autoConfirmClose = true;
  confirmTerminate = true;

  connect(url: string): DiscordGatewaySocket {
    const socket = new FakeSocket(this.autoConfirmClose, this.confirmTerminate);
    this.urls.push(url);
    this.sockets.push(socket);
    return socket;
  }
}

class FakeSocket implements DiscordGatewaySocket {
  readonly sent: string[] = [];
  readonly autoConfirmClose: boolean;
  readonly confirmTerminate: boolean;
  terminated = false;
  closedWith: { code: number; reason: string } | undefined;
  #open: (() => void) | undefined;
  #message: ((data: string | Uint8Array, isBinary: boolean) => void) | undefined;
  #close: ((code: number) => void) | undefined;
  #error: (() => void) | undefined;

  constructor(autoConfirmClose = true, confirmTerminate = true) {
    this.autoConfirmClose = autoConfirmClose;
    this.confirmTerminate = confirmTerminate;
  }

  onOpen(listener: () => void): void {
    this.#open = listener;
  }

  onMessage(listener: (data: string | Uint8Array, isBinary: boolean) => void): void {
    this.#message = listener;
  }

  onClose(listener: (code: number) => void): void {
    this.#close = listener;
  }

  onError(listener: () => void): void {
    this.#error = listener;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    if (this.autoConfirmClose) {
      queueMicrotask(() => this.#close?.(code));
    }
  }

  terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    if (this.confirmTerminate) {
      this.#close?.(4000);
    }
  }

  emitOpen(): void {
    this.#open?.();
  }

  emitJson(value: unknown): void {
    this.emitText(JSON.stringify(value));
  }

  emitText(value: string): void {
    this.#message?.(value, false);
  }

  emitClose(code: number): void {
    this.#close?.(code);
  }

  emitError(): void {
    this.#error?.();
  }
}

interface Scheduled {
  readonly id: number;
  readonly delayMs: number;
  readonly callback: () => void;
  cancelled: boolean;
}

class ManualScheduler implements DiscordGatewayScheduler {
  readonly #randomValue: number;
  readonly #scheduled: Scheduled[] = [];
  #nextId = 1;
  #nowMs = 1_000;

  constructor(randomValue: number) {
    this.#randomValue = randomValue;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  setNow(value: number): void {
    this.#nowMs = value;
  }

  random(): number {
    return this.#randomValue;
  }

  setTimeout(callback: () => void, delayMs: number): object {
    const scheduled: Scheduled = {
      id: this.#nextId,
      delayMs,
      callback,
      cancelled: false,
    };
    this.#nextId += 1;
    this.#scheduled.push(scheduled);
    return scheduled;
  }

  clearTimeout(handle: object): void {
    (handle as Scheduled).cancelled = true;
  }

  delays(): number[] {
    return this.#scheduled
      .filter((scheduled) => !scheduled.cancelled)
      .map(({ delayMs }) => delayMs);
  }

  get size(): number {
    return this.#scheduled.filter((scheduled) => !scheduled.cancelled).length;
  }

  hasReconnect(): boolean {
    return this.#scheduled.some(
      (scheduled) =>
        !scheduled.cancelled && scheduled.delayMs !== 500 && scheduled.delayMs !== 1_000,
    );
  }

  async runNext(): Promise<void> {
    const next = this.#scheduled.find((scheduled) => !scheduled.cancelled);
    assert.ok(next, "Expected a scheduled Gateway action.");
    next.cancelled = true;
    next.callback();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  }

  async runReconnect(): Promise<void> {
    const next = this.#scheduled.find(
      (scheduled) =>
        !scheduled.cancelled && scheduled.delayMs !== 500 && scheduled.delayMs !== 1_000,
    );
    assert.ok(next, "Expected a scheduled Gateway reconnect.");
    next.cancelled = true;
    next.callback();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  }
}

function rawMessage(id: string, content: string): unknown {
  return {
    id,
    guild_id: GUILD_ID,
    channel_id: THREAD_ID,
    author: { id: "100000000000000004", bot: false },
    member: { roles: [] },
    content,
    attachments: [],
    timestamp: "2026-07-24T00:00:00.000Z",
  };
}

function rawThread(archived: boolean): unknown {
  return {
    id: THREAD_ID,
    guild_id: GUILD_ID,
    parent_id: "100000000000000002",
    type: 11,
    name: "Gateway Task",
    owner_id: "100000000000000004",
    applied_tags: [],
    thread_metadata: {
      archived,
      locked: false,
    },
  };
}

function redactToken(payload: string | undefined): unknown {
  assert.notEqual(payload, undefined);
  const decoded = JSON.parse(payload ?? "{}") as { d?: { token?: string } };
  if (decoded.d !== undefined && "token" in decoded.d) {
    decoded.d.token = "[REDACTED]";
  }
  return decoded;
}
