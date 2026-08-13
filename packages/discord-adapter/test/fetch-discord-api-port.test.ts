import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DISCORD_COMPONENTS_V2_FLAG,
  DiscordApiError,
  FetchDiscordApiPort,
  InMemoryDiscordInteractionTokenVault,
  type DiscordBotCredentialProvider,
  type DiscordFetch,
  type DiscordMessagePayload,
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

test("the HTTP port accepts Discord's omitted applied_tags field for a tagless Forum thread", async () => {
  const taglessThread = rawThread(THREAD_ID, false, "2026-07-24T00:00:00.000Z") as Record<
    string,
    unknown
  >;
  delete taglessThread["applied_tags"];
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("tagless-thread-secret"),
    fetch: routeFetch([], {
      [`GET /api/v10/guilds/${GUILD_ID}/threads/active`]: json({
        threads: [taglessThread],
      }),
    }),
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:tagless",
      nowMs: () => 1_000,
    }),
  });

  const threads = await api.listActiveThreads(GUILD_ID);

  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0]?.appliedTagIds, []);
});

test("the HTTP port still rejects a present null applied_tags field", async () => {
  const malformedThread = rawThread(THREAD_ID, false, "2026-07-24T00:00:00.000Z") as Record<
    string,
    unknown
  >;
  malformedThread["applied_tags"] = null;
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("malformed-tag-secret"),
    fetch: routeFetch([], {
      [`GET /api/v10/guilds/${GUILD_ID}/threads/active`]: json({
        threads: [malformedThread],
      }),
    }),
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:malformed-tag",
      nowMs: () => 1_000,
    }),
  });

  await assert.rejects(api.listActiveThreads(GUILD_ID), hasDiscordApiCode("INVALID_RESPONSE"));
});

test("the HTTP port restores its configured Guild ID when a REST message omits guild_id", async () => {
  const starter = rawMessage(THREAD_ID, "Tagless starter") as Record<string, unknown>;
  delete starter["guild_id"];
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    guildId: GUILD_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("message-guild-secret"),
    fetch: routeFetch([], {
      [`GET /api/v10/channels/${THREAD_ID}/messages/${THREAD_ID}`]: json(starter),
    }),
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:message-guild",
      nowMs: () => 1_000,
    }),
  });

  const message = await api.getMessage(THREAD_ID, THREAD_ID);

  assert.equal(message.guildId, GUILD_ID);
});

test("the HTTP port rejects a REST message that names another Guild", async () => {
  const starter = rawMessage(THREAD_ID, "Wrong Guild") as Record<string, unknown>;
  starter["guild_id"] = "100000000000000099";
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    guildId: GUILD_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("wrong-guild-secret"),
    fetch: routeFetch([], {
      [`GET /api/v10/channels/${THREAD_ID}/messages/${THREAD_ID}`]: json(starter),
    }),
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:wrong-guild",
      nowMs: () => 1_000,
    }),
  });

  await assert.rejects(api.getMessage(THREAD_ID, THREAD_ID), hasDiscordApiCode("INVALID_RESPONSE"));
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

test("Components v2 result messages upload one native file with an enforced nonce", async () => {
  const bytes = new TextEncoder().encode("OpenDelegate native attachment\n");
  let observed = false;
  const fetch: DiscordFetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    assert.equal(url.pathname, `/api/v10/channels/${THREAD_ID}/messages`);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Content-Type"), null);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bot attachment-secret");
    assert.ok(init?.body instanceof FormData);
    const payloadValue = init.body.get("payload_json");
    assert.equal(typeof payloadValue, "string");
    const payload = JSON.parse(payloadValue as string) as Record<string, unknown>;
    assert.equal(payload["flags"], DISCORD_COMPONENTS_V2_FLAG);
    assert.equal(payload["enforce_nonce"], true);
    assert.equal(typeof payload["nonce"], "string");
    assert.deepEqual(payload["attachments"], [{ id: 0, filename: "result.txt" }]);
    const file = init.body.get("files[0]");
    assert.ok(file instanceof Blob);
    assert.equal(file.type, "text/plain");
    assert.equal("name" in file ? file.name : undefined, "result.txt");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    observed = true;
    return json({ id: "100000000000000093" });
  };
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("attachment-secret"),
    fetch,
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:attachment",
      nowMs: () => 1_000,
    }),
  });
  const payload: DiscordMessagePayload = {
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components: [
      { type: 10, content: "Result ready" },
      { type: 13, file: { url: "attachment://result.txt" } },
    ],
    allowed_mentions: { parse: [] },
  };

  assert.deepEqual(
    await api.createMessage({
      threadId: THREAD_ID,
      requestKey: "task-result:attachment",
      payload,
      attachment: { filename: "result.txt", mediaType: "text/plain", bytes },
    }),
    { messageId: "100000000000000093" },
  );
  assert.equal(observed, true);
});

test("owner-message acknowledgement uses an in-place reaction and Discord typing", async () => {
  const messageId = "100000000000000090";
  const requests: CapturedRequest[] = [];
  const reactionPath = `/api/v10/channels/${THREAD_ID}/messages/${messageId}/reactions/${encodeURIComponent(
    "👀",
  )}/@me`;
  const typingPath = `/api/v10/channels/${THREAD_ID}/typing`;
  const fetch = routeFetch(requests, {
    [`PUT ${reactionPath}`]: new Response(null, { status: 204 }),
    [`POST ${typingPath}`]: new Response(null, { status: 204 }),
  });
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("acknowledgement-secret"),
    fetch,
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:acknowledgement",
      nowMs: () => 1_000,
    }),
  });

  const acknowledgement = await api.acknowledgeMessage({
    threadId: THREAD_ID,
    messageId,
  });

  assert.deepEqual(acknowledgement, { reactionVisible: true, typingVisible: true });
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.pathname}`).sort(),
    [`POST ${typingPath}`, `PUT ${reactionPath}`].sort(),
  );
});

test("owner-message activity refreshes and closes on the same message without posting chatter", async () => {
  const messageId = "100000000000000091";
  const requests: CapturedRequest[] = [];
  const typingPath = `/api/v10/channels/${THREAD_ID}/typing`;
  const reactionRoot = `/api/v10/channels/${THREAD_ID}/messages/${messageId}/reactions`;
  const fetch = routeFetch(requests, {
    [`POST ${typingPath}`]: new Response(null, { status: 204 }),
    [`DELETE ${reactionRoot}/${encodeURIComponent("👀")}/@me`]: new Response(null, {
      status: 204,
    }),
    [`PUT ${reactionRoot}/${encodeURIComponent("✅")}/@me`]: new Response(null, {
      status: 204,
    }),
    [`PATCH /api/v10/channels/${THREAD_ID}/messages/${messageId}`]: json({
      id: messageId,
    }),
  });
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("activity-lifecycle-secret"),
    fetch,
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:activity",
      nowMs: () => 1_000,
    }),
  });

  assert.equal(await api.refreshTyping({ threadId: THREAD_ID }), true);
  assert.deepEqual(
    await api.completeMessageAcknowledgement({
      threadId: THREAD_ID,
      messageId,
      outcome: "success",
    }),
    { acknowledgementRemoved: true, outcomeVisible: true },
  );
  await api.editMessage({
    threadId: THREAD_ID,
    messageId,
    payload: componentsPayload(),
  });

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.pathname}`).sort(),
    [
      `POST ${typingPath}`,
      `DELETE ${reactionRoot}/${encodeURIComponent("👀")}/@me`,
      `PUT ${reactionRoot}/${encodeURIComponent("✅")}/@me`,
      `PATCH /api/v10/channels/${THREAD_ID}/messages/${messageId}`,
    ].sort(),
  );
});

test("completion reactions are changed sequentially within Discord's message-reaction bucket", async () => {
  const messageId = "100000000000000092";
  const reactionRoot = `/api/v10/channels/${THREAD_ID}/messages/${messageId}/reactions`;
  let releaseDelete: (() => void) | undefined;
  let markDeleteStarted: (() => void) | undefined;
  const deleteStarted = new Promise<void>((resolve) => {
    markDeleteStarted = resolve;
  });
  const deleteReleased = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let outcomeRequested = false;
  const fetch: DiscordFetch = async (input, init) => {
    const request = captureRequest(input, init);
    if (
      request.method === "DELETE" &&
      request.pathname === `${reactionRoot}/${encodeURIComponent("👀")}/@me`
    ) {
      markDeleteStarted?.();
      await deleteReleased;
      return new Response(null, { status: 204 });
    }
    if (
      request.method === "PUT" &&
      request.pathname === `${reactionRoot}/${encodeURIComponent("✅")}/@me`
    ) {
      outcomeRequested = true;
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected test route.");
  };
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("sequential-reaction-secret"),
    fetch,
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:sequential-reaction",
      nowMs: () => 1_000,
    }),
  });

  const completion = api.completeMessageAcknowledgement({
    threadId: THREAD_ID,
    messageId,
    outcome: "success",
  });
  await deleteStarted;
  const outcomeRequestedBeforeDeleteCompleted = outcomeRequested;
  releaseDelete?.();

  assert.deepEqual(await completion, {
    acknowledgementRemoved: true,
    outcomeVisible: true,
  });
  assert.equal(outcomeRequestedBeforeDeleteCompleted, false);
  assert.equal(outcomeRequested, true);
});

test("a rate-limited outcome reaction retries only that individual request", async () => {
  const messageId = "100000000000000093";
  const reactionRoot = `/api/v10/channels/${THREAD_ID}/messages/${messageId}/reactions`;
  let deleteRequests = 0;
  let outcomeRequests = 0;
  const fetch: DiscordFetch = async (input, init) => {
    const request = captureRequest(input, init);
    if (
      request.method === "DELETE" &&
      request.pathname === `${reactionRoot}/${encodeURIComponent("👀")}/@me`
    ) {
      deleteRequests += 1;
      return new Response(null, { status: 204 });
    }
    if (
      request.method === "PUT" &&
      request.pathname === `${reactionRoot}/${encodeURIComponent("✅")}/@me`
    ) {
      outcomeRequests += 1;
      return outcomeRequests === 1
        ? json({ retry_after: 0 }, { status: 429 })
        : new Response(null, { status: 204 });
    }
    throw new Error("Unexpected test route.");
  };
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("rate-limit-reaction-secret"),
    fetch,
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:rate-limit-reaction",
      nowMs: () => 1_000,
    }),
  });

  assert.deepEqual(
    await api.completeMessageAcknowledgement({
      threadId: THREAD_ID,
      messageId,
      outcome: "success",
    }),
    { acknowledgementRemoved: true, outcomeVisible: true },
  );
  assert.equal(deleteRequests, 1);
  assert.equal(outcomeRequests, 2);
});

test("optional acknowledgement permission failures do not block Task processing", async () => {
  const messageId = "100000000000000090";
  const api = new FetchDiscordApiPort({
    applicationId: APPLICATION_ID,
    productVersion: PRODUCT_VERSION,
    credentialProvider: credentialProviderFor("acknowledgement-fallback-secret"),
    fetch: routeFetch([], {
      [`PUT /api/v10/channels/${THREAD_ID}/messages/${messageId}/reactions/${encodeURIComponent(
        "👀",
      )}/@me`]: json({ message: "Missing Permissions" }, { status: 403 }),
      [`POST /api/v10/channels/${THREAD_ID}/typing`]: new Response(null, { status: 204 }),
    }),
    interactionTokenVault: new InMemoryDiscordInteractionTokenVault({
      createReference: () => "discord-interaction-ref:acknowledgement-fallback",
      nowMs: () => 1_000,
    }),
  });

  assert.deepEqual(await api.acknowledgeMessage({ threadId: THREAD_ID, messageId }), {
    reactionVisible: false,
    typingVisible: true,
  });
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
    "DELETE /api/v10/webhooks/100000000000000001/raw-interaction-token-must-not-be-returned/messages/@original":
      new Response(null, { status: 204 }),
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
  await api.deleteDeferredInteraction({ responseRef: deferred.responseRef });
  assert.equal(
    requests.some(
      (request) => request.method === "DELETE" && request.pathname.endsWith("/messages/@original"),
    ),
    true,
  );
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
