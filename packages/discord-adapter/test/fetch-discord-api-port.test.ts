import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DISCORD_COMPONENTS_V2_FLAG,
  DiscordApiError,
  FetchDiscordApiPort,
  InMemoryDiscordInteractionTokenVault,
  type DiscordBotCredentialProvider,
  type DiscordFetch,
} from "../src/index.ts";

const APPLICATION_ID = "100000000000000001";
const BOT_USER_ID = "100000000000000002";
const GUILD_ID = "100000000000000003";
const FORUM_ID = "100000000000000004";
const THREAD_ID = "100000000000000005";
const PRODUCT_VERSION = "0.1.0-test";

test("the HTTP port verifies Application, Community Forum, intents, tags, and effective permissions", async () => {
  const secret = "bot-secret-must-never-escape";
  const requests: CapturedRequest[] = [];
  const fetch = routeFetch(requests, {
    "GET /api/v10/oauth2/applications/@me": json({
      id: APPLICATION_ID,
      flags: (1 << 19).toString(),
    }),
    "GET /api/v10/users/@me": json({ id: BOT_USER_ID, bot: true }),
    [`GET /api/v10/guilds/${GUILD_ID}`]: json({
      id: GUILD_ID,
      owner_id: "100000000000000099",
      features: ["COMMUNITY"],
    }),
    [`GET /api/v10/guilds/${GUILD_ID}/members/${BOT_USER_ID}`]: json({
      user: { id: BOT_USER_ID, bot: true },
      roles: ["100000000000000010"],
    }),
    [`GET /api/v10/guilds/${GUILD_ID}/roles`]: json([
      { id: GUILD_ID, permissions: "0" },
      {
        id: "100000000000000010",
        permissions: requiredPermissionBitfield().toString(),
      },
    ]),
    [`GET /api/v10/channels/${FORUM_ID}`]: json({
      id: FORUM_ID,
      guild_id: GUILD_ID,
      type: 15,
      available_tags: [
        { id: "100000000000000020", name: "Running", moderated: true },
        { id: "100000000000000021", name: "Done", moderated: true },
      ],
      permission_overwrites: [],
    }),
  });
  const credentialProvider = credentialProviderFor(secret);
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider,
    fetch,
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:probe",
      nowMs: () => 1_000,
    }),
  });

  const result = await api.probeInstallation({
    applicationId: APPLICATION_ID,
    guildId: GUILD_ID,
    forumChannelIds: [FORUM_ID],
  });

  assert.deepEqual(result, {
    applicationId: APPLICATION_ID,
    botUserId: BOT_USER_ID,
    guildId: GUILD_ID,
    guildFeatures: ["COMMUNITY"],
    enabledIntents: ["GUILDS", "GUILD_MESSAGES", "MESSAGE_CONTENT"],
    forums: [
      {
        channelId: FORUM_ID,
        channelType: 15,
        permissions: [
          "VIEW_CHANNEL",
          "READ_MESSAGE_HISTORY",
          "SEND_MESSAGES",
          "SEND_MESSAGES_IN_THREADS",
          "ATTACH_FILES",
          "MANAGE_THREADS",
        ],
        availableTagIds: ["100000000000000020", "100000000000000021"],
      },
    ],
  });
  assert.equal(
    requests.every((request) => request.authorization === `Bot ${secret}`),
    true,
  );
  assert.equal(
    requests.every(
      (request) =>
        request.userAgent ===
        `OpenDelegate (https://github.com/jugol/OpenDelegate, ${PRODUCT_VERSION})`,
    ),
    true,
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("the HTTP port paginates archived threads and messages with bounded oldest-first results", async () => {
  const requests: CapturedRequest[] = [];
  const messageResponses = [
    json(
      Array.from({ length: 100 }, (_, index) =>
        rawMessage((BigInt(THREAD_ID) + BigInt(index + 1)).toString(), `message-${index + 1}`),
      ).reverse(),
    ),
    json([rawMessage((BigInt(THREAD_ID) + 101n).toString(), "message-101")]),
  ];
  const fetch: DiscordFetch = async (input, init) => {
    const request = captureRequest(input, init);
    requests.push(request);
    if (request.pathname === `/api/v10/channels/${FORUM_ID}/threads/archived/public`) {
      return json({
        threads: [
          rawThread("100000000000000090", true, "2026-07-24T00:00:00.000Z"),
          rawThread("100000000000000080", true, "2026-07-23T00:00:00.000Z"),
        ],
        has_more: true,
      });
    }
    if (request.pathname === `/api/v10/channels/${THREAD_ID}/messages`) {
      const response = messageResponses.shift();
      assert.ok(response);
      return response;
    }
    throw new Error("Unexpected test route.");
  };
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("pagination-secret"),
    fetch,
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:pagination",
      nowMs: () => 1_000,
    }),
  });

  const archived = await api.listArchivedPublicThreads(FORUM_ID);
  assert.equal(archived.hasMore, true);
  assert.equal(archived.nextBefore, "2026-07-23T00:00:00.000Z");

  const firstMessages = await api.listMessages(THREAD_ID);
  assert.equal(firstMessages.messages.length, 100);
  assert.equal(firstMessages.messages[0]?.content, "message-1");
  assert.equal(firstMessages.messages.at(-1)?.content, "message-100");
  assert.equal(firstMessages.hasMore, true);
  assert.equal(firstMessages.nextAfter, (BigInt(THREAD_ID) + 100n).toString());

  const secondMessages = await api.listMessages(THREAD_ID, firstMessages.nextAfter);
  assert.equal(secondMessages.hasMore, false);
  assert.equal(secondMessages.messages[0]?.content, "message-101");
  assert.equal(
    requests.some(
      (request) =>
        request.pathname === `/api/v10/channels/${THREAD_ID}/messages` &&
        request.searchParams.get("after") === firstMessages.nextAfter,
    ),
    true,
  );
});

test("Components v2 writes use a deterministic enforced nonce no longer than 25 characters", async () => {
  const requests: CapturedRequest[] = [];
  const fetch = routeFetch(requests, {
    [`POST /api/v10/channels/${THREAD_ID}/messages`]: json({
      id: "100000000000000090",
    }),
    [`PATCH /api/v10/channels/${THREAD_ID}/messages/100000000000000090`]: json({
      id: "100000000000000090",
    }),
  });
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("component-secret"),
    fetch,
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:component",
      nowMs: () => 1_000,
    }),
  });
  const payload = componentsPayload();

  const created = await api.upsertStatusPanel({
    threadId: THREAD_ID,
    requestKey: "status-panel:task-with-a-request-key-much-longer-than-discord-allows",
    payload,
  });
  const edited = await api.upsertStatusPanel({
    threadId: THREAD_ID,
    requestKey: "status-panel:task-with-a-request-key-much-longer-than-discord-allows",
    payload,
    messageId: created.messageId,
  });

  assert.deepEqual(edited, created);
  const createBody = requests[0]?.body as Record<string, unknown>;
  const editBody = requests[1]?.body as Record<string, unknown>;
  assert.equal(typeof createBody["nonce"], "string");
  assert.equal((createBody["nonce"] as string).length <= 25, true);
  assert.equal(createBody["enforce_nonce"], true);
  assert.equal(createBody["flags"], DISCORD_COMPONENTS_V2_FLAG);
  assert.equal("nonce" in editBody, false);
  assert.equal("enforce_nonce" in editBody, false);
});

test("the HTTP port creates a Forum post with one starter message and workflow tag", async () => {
  const requests: CapturedRequest[] = [];
  const fetch = routeFetch(requests, {
    [`POST /api/v10/channels/${FORUM_ID}/threads`]: json({
      id: THREAD_ID,
      guild_id: GUILD_ID,
      parent_id: FORUM_ID,
      type: 11,
      name: "OD-route Recover the Worker route",
      owner_id: BOT_USER_ID,
      applied_tags: ["100000000000000020"],
      thread_metadata: { archived: false, locked: false },
      message: {
        id: THREAD_ID,
        guild_id: GUILD_ID,
        channel_id: THREAD_ID,
        author: { id: BOT_USER_ID, bot: true },
        content: "OpenDelegate Task task-route-001",
        attachments: [],
        timestamp: "2026-07-24T00:00:00.000Z",
      },
    }),
  });
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("forum-create-secret"),
    fetch,
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:forum-create",
      nowMs: () => 1_000,
    }),
  });

  const result = await api.createForumPost({
    forumChannelId: FORUM_ID,
    requestKey: "outbound-task:task-route-001",
    name: "OD-route Recover the Worker route",
    content: "OpenDelegate Task task-route-001",
    appliedTagIds: ["100000000000000020"],
  });

  assert.equal(result.thread.id, THREAD_ID);
  assert.equal(result.starterMessage.id, THREAD_ID);
  assert.deepEqual(requests[0]?.body, {
    name: "OD-route Recover the Worker route",
    message: {
      content: "OpenDelegate Task task-route-001",
      allowed_mentions: { parse: [] },
    },
    applied_tags: ["100000000000000020"],
  });
});

test("interaction deferral keeps the token only in the injected vault and persists an opaque reference", async () => {
  const rawInteractionToken = "raw-interaction-token-must-not-be-returned";
  const requests: CapturedRequest[] = [];
  let nowMs = 10_000;
  const vault = new InMemoryDiscordInteractionTokenVault({
    createReference: () => "discord-interaction-ref:opaque-only",
    nowMs: () => nowMs,
  });
  const fetch = routeFetch(requests, {
    "POST /api/v10/interactions/100000000000000070/raw-interaction-token-must-not-be-returned/callback":
      new Response(null, { status: 204 }),
    "PATCH /api/v10/webhooks/100000000000000001/raw-interaction-token-must-not-be-returned/messages/@original":
      json({ id: "100000000000000071" }),
  });
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("interaction-bot-secret"),
    fetch,
    interactionTokenVault: vault,
  });

  const deferred = await api.deferInteraction({
    interactionId: "100000000000000070",
    interactionToken: rawInteractionToken,
    ephemeral: true,
  });
  assert.deepEqual(deferred, { responseRef: "discord-interaction-ref:opaque-only" });
  assert.equal(JSON.stringify(deferred).includes(rawInteractionToken), false);

  await api.editDeferredInteraction({
    responseRef: deferred.responseRef,
    payload: componentsPayload(),
  });
  assert.equal(
    requests.some((request) => request.pathname.includes(rawInteractionToken)),
    true,
  );
  assert.equal(
    requests
      .filter((request) => request.pathname.includes("/interactions/"))
      .every((request) => request.authorization === undefined),
    true,
  );

  nowMs += 15 * 60_000 + 1;
  await assert.rejects(
    api.editDeferredInteraction({
      responseRef: deferred.responseRef,
      payload: componentsPayload(),
    }),
    hasDiscordApiCode("NOT_FOUND"),
  );
});

test("rate limits, oversized bodies, timeouts, and provider failures map to redacted bounded errors", async () => {
  const secret = "bot-secret-never-in-errors";
  const rateLimited = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor(secret),
    fetch: async () =>
      json(
        { message: `do not echo ${secret}`, retry_after: 1.25, global: false },
        { status: 429, headers: { "Retry-After": "1.25" } },
      ),
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:rate",
      nowMs: () => 1_000,
    }),
  });
  await assert.rejects(rateLimited.getThread(THREAD_ID), (error: unknown) => {
    assert.ok(error instanceof DiscordApiError);
    assert.equal(error.code, "RATE_LIMIT");
    assert.equal(error.retryAfterMs, 1_250);
    assert.equal(error.message.includes(secret), false);
    return true;
  });

  const oversized = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor(secret),
    fetch: async () => new Response(`"${"x".repeat(512)}"`),
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:oversized",
      nowMs: () => 1_000,
    }),
    maximumResponseBytes: 128,
  });
  await assert.rejects(oversized.getThread(THREAD_ID), hasDiscordApiCode("INVALID_RESPONSE"));

  const unsafeGateway = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor(secret),
    fetch: async () => json({ url: "wss://gateway.discord.gg.attacker.invalid" }),
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:gateway-host",
      nowMs: () => 1_000,
    }),
  });
  await assert.rejects(unsafeGateway.getGatewayBotUrl(), hasDiscordApiCode("INVALID_RESPONSE"));

  const timedOut = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor(secret),
    fetch: async () => new Promise<Response>(() => undefined),
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:timeout",
      nowMs: () => 1_000,
    }),
    requestTimeoutMs: 100,
  });
  await assert.rejects(timedOut.getThread(THREAD_ID), (error: unknown) => {
    assert.ok(error instanceof DiscordApiError);
    assert.equal(error.code, "OFFLINE");
    assert.equal(error.message.includes(secret), false);
    return true;
  });

  const providerFailure = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: {
      withBotToken: async () => {
        throw new Error(`vault failed with ${secret}`);
      },
    },
    fetch: async () => {
      throw new Error("must not be reached");
    },
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:provider",
      nowMs: () => 1_000,
    }),
  });
  await assert.rejects(providerFailure.getThread(THREAD_ID), (error: unknown) => {
    assert.ok(error instanceof DiscordApiError);
    assert.equal(error.code, "OFFLINE");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly authorization?: string;
  readonly userAgent?: string;
  readonly body?: unknown;
}

function routeFetch(
  requests: CapturedRequest[],
  routes: Readonly<Record<string, Response>>,
): DiscordFetch {
  return async (input, init) => {
    const request = captureRequest(input, init);
    requests.push(request);
    const response = routes[`${request.method} ${request.pathname}`];
    if (response === undefined) {
      throw new Error(`Unexpected test route: ${request.method} ${request.pathname}`);
    }
    return response.clone();
  };
}

function captureRequest(input: Parameters<DiscordFetch>[0], init?: RequestInit): CapturedRequest {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  const headers = new Headers(init?.headers);
  const authorization = headers.get("Authorization");
  const userAgent = headers.get("User-Agent");
  return {
    method: init?.method ?? "GET",
    pathname: url.pathname,
    searchParams: url.searchParams,
    ...(authorization === null ? {} : { authorization }),
    ...(userAgent === null ? {} : { userAgent }),
    ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
  };
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(init?.headers).entries()),
    },
  });
}

function credentialProviderFor(secret: string): DiscordBotCredentialProvider {
  return {
    withBotToken: async (operation) => operation(secret),
  };
}

function requiredPermissionBitfield(): bigint {
  return (1n << 10n) | (1n << 11n) | (1n << 15n) | (1n << 16n) | (1n << 34n) | (1n << 38n);
}

function rawThread(id: string, archived: boolean, archiveTimestamp: string): unknown {
  return {
    id,
    guild_id: GUILD_ID,
    parent_id: FORUM_ID,
    type: 11,
    name: `Thread ${id}`,
    owner_id: BOT_USER_ID,
    applied_tags: [],
    thread_metadata: {
      archived,
      locked: false,
      archive_timestamp: archiveTimestamp,
    },
  };
}

function rawMessage(id: string, content: string): unknown {
  return {
    id,
    guild_id: GUILD_ID,
    channel_id: THREAD_ID,
    author: { id: BOT_USER_ID, bot: false },
    member: { roles: [] },
    content,
    attachments: [],
    timestamp: "2026-07-24T00:00:00.000Z",
  };
}

function componentsPayload() {
  return {
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components: [
      {
        type: 10 as const,
        content: "OpenDelegate status",
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function hasDiscordApiCode(code: DiscordApiError["code"]) {
  return (error: unknown): boolean => error instanceof DiscordApiError && error.code === code;
}
