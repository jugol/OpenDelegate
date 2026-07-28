import { createHash } from "node:crypto";

import type {
  DiscordApiPort,
  DiscordInstallationProbe,
  DiscordIntent,
  DiscordMessage,
  DiscordMessagePayload,
  DiscordPermission,
  DiscordThread,
} from "./contracts.ts";
import type { DiscordBotCredentialProvider, DiscordInteractionTokenVault } from "./credentials.ts";
import { assertResponseReference } from "./credentials.ts";
import {
  discordThreadArchiveTimestamp,
  mapDiscordMessage,
  mapDiscordThread,
  requireArray,
  requireRecord,
  requireSafeInteger,
  requireSnowflake,
  requireSnowflakeArray,
} from "./discord-wire.ts";
import { DiscordApiError } from "./errors.ts";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const MAXIMUM_JSON_REQUEST_BYTES = 256 * 1024;
const INTERACTION_TOKEN_LIFETIME_MS = 15 * 60_000;
const MESSAGE_PAGE_LIMIT = 100;
const ARCHIVED_THREAD_PAGE_LIMIT = 100;
const APPLICATION_MESSAGE_CONTENT = 1n << 18n;
const APPLICATION_MESSAGE_CONTENT_LIMITED = 1n << 19n;
const ADMINISTRATOR = 1n << 3n;

const REQUIRED_PERMISSION_BITS: readonly {
  readonly name: DiscordPermission;
  readonly bit: bigint;
}[] = Object.freeze([
  Object.freeze({ name: "VIEW_CHANNEL", bit: 1n << 10n }),
  Object.freeze({ name: "READ_MESSAGE_HISTORY", bit: 1n << 16n }),
  Object.freeze({ name: "SEND_MESSAGES", bit: 1n << 11n }),
  Object.freeze({ name: "SEND_MESSAGES_IN_THREADS", bit: 1n << 38n }),
  Object.freeze({ name: "ATTACH_FILES", bit: 1n << 15n }),
  Object.freeze({ name: "MANAGE_THREADS", bit: 1n << 34n }),
]);

export type DiscordFetch = typeof fetch;

export interface DiscordGatewayDiscovery {
  getGatewayBotUrl(): Promise<string>;
}

export interface FetchDiscordApiPortOptions {
  readonly applicationId: string;
  readonly guildId?: string;
  readonly productVersion: string;
  readonly credentialProvider: DiscordBotCredentialProvider;
  readonly interactionTokenVault: DiscordInteractionTokenVault;
  readonly fetch?: DiscordFetch;
  readonly requestTimeoutMs?: number;
  readonly maximumResponseBytes?: number;
}

interface DiscordRequest {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: string;
  readonly body?: unknown;
  readonly authenticated: boolean;
}

export class FetchDiscordApiPort implements DiscordApiPort, DiscordGatewayDiscovery {
  readonly #applicationId: string;
  readonly #guildId: string | undefined;
  readonly #credentialProvider: DiscordBotCredentialProvider;
  readonly #interactionTokenVault: DiscordInteractionTokenVault;
  readonly #fetch: DiscordFetch;
  readonly #requestTimeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #userAgent: string;

  public constructor(options: FetchDiscordApiPortOptions) {
    assertSnowflake(options.applicationId, "Discord Application ID");
    if (options.guildId !== undefined) {
      assertSnowflake(options.guildId, "Discord Guild ID");
    }
    assertProductVersion(options.productVersion);
    assertBoundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      100,
      60_000,
      "Discord request timeout",
    );
    assertBoundedInteger(
      options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
      128,
      16 * 1024 * 1024,
      "Discord maximum response size",
    );
    this.#applicationId = options.applicationId;
    this.#guildId = options.guildId;
    this.#credentialProvider = options.credentialProvider;
    this.#interactionTokenVault = options.interactionTokenVault;
    this.#fetch = options.fetch ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
    this.#userAgent = `OpenDelegate (https://github.com/jugol/OpenDelegate, ${options.productVersion})`;
  }

  public async probeInstallation(input: {
    applicationId: string;
    guildId: string;
    forumChannelIds: readonly string[];
  }): Promise<DiscordInstallationProbe> {
    assertSnowflake(input.applicationId, "Discord Application ID");
    assertSnowflake(input.guildId, "Discord guild ID");
    assertDistinctSnowflakes(input.forumChannelIds, "Discord Forum channel IDs", 100);
    if (input.applicationId !== this.#applicationId) {
      throw invalidResponse(
        "The Discord installation probe does not match the configured Application.",
      );
    }

    const [applicationValue, botValue, guildValue, rolesValue, ...forumValues] = await Promise.all([
      this.#botJson("GET", "/oauth2/applications/@me"),
      this.#botJson("GET", "/users/@me"),
      this.#botJson("GET", `/guilds/${input.guildId}`),
      this.#botJson("GET", `/guilds/${input.guildId}/roles`),
      ...input.forumChannelIds.map((channelId) => this.#botJson("GET", `/channels/${channelId}`)),
    ]);

    const application = requireRecord(applicationValue, "Application");
    const bot = requireRecord(botValue, "bot user");
    const guild = requireRecord(guildValue, "guild");
    const botUserId = requireSnowflake(bot, "id");
    const memberValue = await this.#botJson("GET", `/guilds/${input.guildId}/members/${botUserId}`);
    const member = requireRecord(memberValue, "guild member");
    const roles = parseRoles(rolesValue);
    const applicationId = requireSnowflake(application, "id");
    const guildId = requireSnowflake(guild, "id");
    if (applicationId !== input.applicationId || guildId !== input.guildId) {
      throw invalidResponse("Discord returned a different installation than requested.");
    }
    if (bot["bot"] !== true) {
      throw invalidResponse("Discord returned a current user that is not a bot.");
    }
    const guildOwnerId = requireSnowflake(guild, "owner_id");
    const memberUser = requireRecord(member["user"], "guild member user");
    if (requireSnowflake(memberUser, "id") !== botUserId || memberUser["bot"] !== true) {
      throw invalidResponse("Discord returned a guild member for a different bot.");
    }
    const memberRoleIds = requireSnowflakeArray(member["roles"], "guild member role", 1_000);
    const basePermissions = computeBasePermissions({
      botUserId,
      guildId,
      guildOwnerId,
      memberRoleIds,
      roles,
    });
    const flags = applicationFlags(application);
    const enabledIntents: DiscordIntent[] = ["GUILDS", "GUILD_MESSAGES"];
    if (
      (flags & APPLICATION_MESSAGE_CONTENT) !== 0n ||
      (flags & APPLICATION_MESSAGE_CONTENT_LIMITED) !== 0n
    ) {
      enabledIntents.push("MESSAGE_CONTENT");
    }

    const featuresValue = requireArray(guild["features"], "guild features", 1_000);
    const guildFeatures = featuresValue.map((feature) => {
      if (typeof feature !== "string" || feature.length < 1 || feature.length > 100) {
        throw invalidResponse("Discord returned an invalid guild feature.");
      }
      return feature;
    });

    const forums = forumValues.map((forumValue, index) => {
      const channel = requireRecord(forumValue, "Forum channel");
      const expectedChannelId = input.forumChannelIds[index];
      if (
        expectedChannelId === undefined ||
        requireSnowflake(channel, "id") !== expectedChannelId
      ) {
        throw invalidResponse("Discord returned a different Forum channel than requested.");
      }
      if (requireSnowflake(channel, "guild_id") !== guildId) {
        throw invalidResponse("Discord returned a Forum from a different guild.");
      }
      const permissions = applyChannelOverwrites({
        basePermissions,
        botUserId,
        guildId,
        memberRoleIds,
        overwrites: parsePermissionOverwrites(channel["permission_overwrites"]),
      });
      const availableTags = requireArray(channel["available_tags"], "Forum tags", 20);
      return Object.freeze({
        channelId: expectedChannelId,
        channelType: requireSafeInteger(channel, "type"),
        permissions: Object.freeze(
          REQUIRED_PERMISSION_BITS.filter(({ bit }) => (permissions & bit) === bit).map(
            ({ name }) => name,
          ),
        ),
        availableTagIds: Object.freeze(
          availableTags.map((tag) => requireSnowflake(requireRecord(tag, "Forum tag"), "id")),
        ),
      });
    });

    return Object.freeze({
      applicationId,
      botUserId,
      guildId,
      guildFeatures: Object.freeze(guildFeatures),
      enabledIntents: Object.freeze(enabledIntents),
      forums: Object.freeze(forums),
    });
  }

  public async getGatewayBotUrl(): Promise<string> {
    const value = requireRecord(await this.#botJson("GET", "/gateway/bot"), "Gateway discovery");
    const url = value["url"];
    if (typeof url !== "string" || !isSecureGatewayUrl(url)) {
      throw invalidResponse("Discord returned an invalid Gateway URL.");
    }
    return url;
  }

  public async getThread(threadId: string): Promise<DiscordThread> {
    assertSnowflake(threadId, "Discord thread ID");
    const value = requireRecord(await this.#botJson("GET", `/channels/${threadId}`), "thread");
    if (requireSafeInteger(value, "type") !== 11) {
      throw new DiscordApiError(
        "NOT_FOUND",
        "The requested Discord channel is not a public thread.",
      );
    }
    return mapDiscordThread(value);
  }

  public async getMessage(threadId: string, messageId: string): Promise<DiscordMessage> {
    assertSnowflake(threadId, "Discord thread ID");
    assertSnowflake(messageId, "Discord message ID");
    return mapDiscordMessage(
      await this.#botJson("GET", `/channels/${threadId}/messages/${messageId}`),
      this.#guildId,
    );
  }

  public async listActiveThreads(guildId: string): Promise<readonly DiscordThread[]> {
    assertSnowflake(guildId, "Discord guild ID");
    const value = requireRecord(
      await this.#botJson("GET", `/guilds/${guildId}/threads/active`),
      "active thread page",
    );
    const threads: DiscordThread[] = [];
    for (const candidate of requireArray(value["threads"], "active threads", 10_000)) {
      const channel = requireRecord(candidate, "active thread");
      if (requireSafeInteger(channel, "type") === 11) {
        threads.push(mapDiscordThread(channel));
      }
    }
    return Object.freeze(threads);
  }

  public async listArchivedPublicThreads(
    forumChannelId: string,
    before?: string,
  ): Promise<{
    readonly threads: readonly DiscordThread[];
    readonly hasMore: boolean;
    readonly nextBefore?: string;
  }> {
    assertSnowflake(forumChannelId, "Discord Forum channel ID");
    if (
      before !== undefined &&
      (before.length > 64 || !Number.isFinite(Date.parse(before)) || before.includes("\u0000"))
    ) {
      throw invalidResponse("The archived-thread cursor is invalid.");
    }
    const query = new URLSearchParams({ limit: ARCHIVED_THREAD_PAGE_LIMIT.toString() });
    if (before !== undefined) {
      query.set("before", before);
    }
    const value = requireRecord(
      await this.#botJson(
        "GET",
        `/channels/${forumChannelId}/threads/archived/public?${query.toString()}`,
      ),
      "archived thread page",
    );
    const rawThreads = requireArray(value["threads"], "archived threads", 100);
    const hasMore = value["has_more"];
    if (typeof hasMore !== "boolean") {
      throw invalidResponse("Discord returned an invalid archived-thread page marker.");
    }
    const threads = rawThreads.map(mapDiscordThread);
    const nextBefore =
      rawThreads.length === 0
        ? undefined
        : discordThreadArchiveTimestamp(rawThreads[rawThreads.length - 1]);
    if (hasMore && nextBefore === undefined) {
      throw invalidResponse("Discord archived-thread pagination did not provide a cursor.");
    }
    return Object.freeze({
      threads: Object.freeze(threads),
      hasMore,
      ...(nextBefore === undefined ? {} : { nextBefore }),
    });
  }

  public async listMessages(
    threadId: string,
    after?: string,
  ): Promise<{
    readonly messages: readonly DiscordMessage[];
    readonly hasMore: boolean;
    readonly nextAfter?: string;
  }> {
    assertSnowflake(threadId, "Discord thread ID");
    if (after !== undefined) {
      assertSnowflake(after, "Discord message cursor");
    }
    const query = new URLSearchParams({ limit: MESSAGE_PAGE_LIMIT.toString() });
    if (after !== undefined) {
      query.set("after", after);
    }
    const rawMessages = requireArray(
      await this.#botJson("GET", `/channels/${threadId}/messages?${query.toString()}`),
      "message page",
      MESSAGE_PAGE_LIMIT,
    );
    const messages = rawMessages
      .map((message) => mapDiscordMessage(message, this.#guildId))
      .sort(compareSnowflakeMessage);
    const nextAfter = messages.at(-1)?.id;
    if (rawMessages.length === MESSAGE_PAGE_LIMIT && nextAfter === undefined) {
      throw invalidResponse("Discord message pagination did not provide a cursor.");
    }
    return Object.freeze({
      messages: Object.freeze(messages),
      hasMore: rawMessages.length === MESSAGE_PAGE_LIMIT,
      ...(nextAfter === undefined ? {} : { nextAfter }),
    });
  }

  public async createForumPost(input: {
    forumChannelId: string;
    requestKey: string;
    name: string;
    content: string;
    appliedTagIds: readonly string[];
  }): Promise<{
    readonly thread: DiscordThread;
    readonly starterMessage: DiscordMessage;
  }> {
    assertSnowflake(input.forumChannelId, "Discord Forum channel ID");
    assertRequestKey(input.requestKey);
    assertBoundedForumText(input.name, "Discord Forum post name", 1, 100);
    assertBoundedForumText(input.content, "Discord Forum starter content", 1, 2_000);
    assertDistinctSnowflakes(input.appliedTagIds, "Discord Forum applied tags", 5);
    const response = requireRecord(
      await this.#botJson("POST", `/channels/${input.forumChannelId}/threads`, {
        name: input.name,
        message: {
          content: input.content,
          allowed_mentions: { parse: [] },
        },
        applied_tags: [...input.appliedTagIds],
      }),
      "created Forum thread",
    );
    return Object.freeze({
      thread: mapDiscordThread(response),
      starterMessage: mapDiscordMessage(
        requireRecord(response["message"], "created Forum starter message"),
        this.#guildId,
      ),
    });
  }

  public async updateThreadTags(threadId: string, appliedTagIds: readonly string[]): Promise<void> {
    assertSnowflake(threadId, "Discord thread ID");
    assertDistinctSnowflakes(appliedTagIds, "Discord applied tag IDs", 5);
    await this.#botJson("PATCH", `/channels/${threadId}`, {
      applied_tags: appliedTagIds,
    });
  }

  public async upsertStatusPanel(input: {
    threadId: string;
    requestKey: string;
    payload: DiscordMessagePayload;
    messageId?: string;
  }): Promise<{ readonly messageId: string }> {
    assertSnowflake(input.threadId, "Discord thread ID");
    assertRequestKey(input.requestKey);
    const body = validateMessagePayload(input.payload);
    if (input.messageId !== undefined) {
      assertSnowflake(input.messageId, "Discord message ID");
      const response = requireRecord(
        await this.#botJson(
          "PATCH",
          `/channels/${input.threadId}/messages/${input.messageId}`,
          body,
        ),
        "edited message",
      );
      const messageId = requireSnowflake(response, "id");
      if (messageId !== input.messageId) {
        throw invalidResponse("Discord edited a different message than requested.");
      }
      return Object.freeze({ messageId });
    }
    return this.#createComponentsMessage(input.threadId, input.requestKey, body);
  }

  public async createMessage(input: {
    threadId: string;
    requestKey: string;
    payload: DiscordMessagePayload;
  }): Promise<{ readonly messageId: string }> {
    assertSnowflake(input.threadId, "Discord thread ID");
    assertRequestKey(input.requestKey);
    return this.#createComponentsMessage(
      input.threadId,
      input.requestKey,
      validateMessagePayload(input.payload),
    );
  }

  public async editMessage(input: {
    threadId: string;
    messageId: string;
    payload: DiscordMessagePayload;
  }): Promise<void> {
    assertSnowflake(input.threadId, "Discord thread ID");
    assertSnowflake(input.messageId, "Discord message ID");
    const response = requireRecord(
      await this.#botJson(
        "PATCH",
        `/channels/${input.threadId}/messages/${input.messageId}`,
        validateMessagePayload(input.payload),
      ),
      "edited message",
    );
    if (requireSnowflake(response, "id") !== input.messageId) {
      throw invalidResponse("Discord edited a different message than requested.");
    }
  }

  public async acknowledgeMessage(input: { threadId: string; messageId: string }): Promise<{
    readonly reactionVisible: boolean;
    readonly typingVisible: boolean;
  }> {
    assertSnowflake(input.threadId, "Discord thread ID");
    assertSnowflake(input.messageId, "Discord message ID");
    const [reactionVisible, typingVisible] = await Promise.all([
      this.#bestEffortAcknowledgementRequest(
        "PUT",
        `/channels/${input.threadId}/messages/${input.messageId}/reactions/${encodeURIComponent(
          "👀",
        )}/@me`,
      ),
      this.#bestEffortAcknowledgementRequest("POST", `/channels/${input.threadId}/typing`),
    ]);
    return Object.freeze({ reactionVisible, typingVisible });
  }

  public async refreshTyping(input: { threadId: string }): Promise<boolean> {
    assertSnowflake(input.threadId, "Discord thread ID");
    return this.#bestEffortAcknowledgementRequest("POST", `/channels/${input.threadId}/typing`);
  }

  public async completeMessageAcknowledgement(input: {
    threadId: string;
    messageId: string;
    outcome: "success" | "failure";
  }): Promise<{
    readonly acknowledgementRemoved: boolean;
    readonly outcomeVisible: boolean;
  }> {
    assertSnowflake(input.threadId, "Discord thread ID");
    assertSnowflake(input.messageId, "Discord message ID");
    const messagePath = `/channels/${input.threadId}/messages/${input.messageId}/reactions`;
    const [acknowledgementRemoved, outcomeVisible] = await Promise.all([
      this.#bestEffortAcknowledgementRequest(
        "DELETE",
        `${messagePath}/${encodeURIComponent("👀")}/@me`,
      ),
      this.#bestEffortAcknowledgementRequest(
        "PUT",
        `${messagePath}/${encodeURIComponent(input.outcome === "success" ? "✅" : "❌")}/@me`,
      ),
    ]);
    return Object.freeze({ acknowledgementRemoved, outcomeVisible });
  }

  public async deferInteraction(input: {
    interactionId: string;
    interactionToken: string;
    ephemeral: boolean;
  }): Promise<{ readonly responseRef: string }> {
    assertSnowflake(input.interactionId, "Discord interaction ID");
    assertTransientToken(input.interactionToken);
    await this.#json({
      method: "POST",
      path: `/interactions/${input.interactionId}/${encodeURIComponent(
        input.interactionToken,
      )}/callback`,
      body: {
        type: 5,
        data: input.ephemeral ? { flags: 64 } : {},
      },
      authenticated: false,
    });
    try {
      return await this.#interactionTokenVault.store({
        applicationId: this.#applicationId,
        interactionToken: input.interactionToken,
        lifetimeMs: INTERACTION_TOKEN_LIFETIME_MS,
      });
    } catch (error) {
      if (error instanceof DiscordApiError) {
        throw error;
      }
      throw invalidResponse("The interaction token vault could not store a follow-up reference.");
    }
  }

  public async editDeferredInteraction(input: {
    responseRef: string;
    payload: DiscordMessagePayload;
  }): Promise<void> {
    assertResponseReference(input.responseRef);
    const payload = validateMessagePayload(input.payload);
    let result: { readonly found: false } | { readonly found: true; readonly value: unknown };
    try {
      result = await this.#interactionTokenVault.use(input.responseRef, async (entry) => {
        await this.#json({
          method: "PATCH",
          path: `/webhooks/${entry.applicationId}/${encodeURIComponent(
            entry.interactionToken,
          )}/messages/@original`,
          body: payload,
          authenticated: false,
        });
      });
    } catch (error) {
      if (error instanceof DiscordApiError) {
        throw error;
      }
      throw invalidResponse("The interaction token vault could not resolve a follow-up reference.");
    }
    if (!result.found) {
      throw new DiscordApiError(
        "NOT_FOUND",
        "The deferred Discord interaction is no longer available.",
      );
    }
  }

  async #createComponentsMessage(
    threadId: string,
    requestKey: string,
    payload: DiscordMessagePayload,
  ): Promise<{ readonly messageId: string }> {
    const response = requireRecord(
      await this.#botJson("POST", `/channels/${threadId}/messages`, {
        ...payload,
        nonce: nonceForRequestKey(requestKey),
        enforce_nonce: true,
      }),
      "created message",
    );
    return Object.freeze({ messageId: requireSnowflake(response, "id") });
  }

  async #botJson(method: DiscordRequest["method"], path: string, body?: unknown): Promise<unknown> {
    try {
      return await this.#credentialProvider.withBotToken(async (botToken) => {
        assertTransientToken(botToken);
        return this.#json(
          {
            method,
            path,
            ...(body === undefined ? {} : { body }),
            authenticated: true,
          },
          botToken,
        );
      });
    } catch (error) {
      if (error instanceof DiscordApiError) {
        throw error;
      }
      throw new DiscordApiError("OFFLINE", "The Discord bot credential provider is unavailable.");
    }
  }

  async #bestEffortAcknowledgementRequest(
    method: "DELETE" | "POST" | "PUT",
    path: string,
  ): Promise<boolean> {
    try {
      await this.#botJson(method, path);
      return true;
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")
      ) {
        return false;
      }
      throw error;
    }
  }

  async #json(request: DiscordRequest, botToken?: string): Promise<unknown> {
    const bodyText = request.body === undefined ? undefined : encodeRequestJson(request.body);
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new DiscordApiError("OFFLINE", "The Discord HTTP API request timed out."));
      }, this.#requestTimeoutMs);
    });
    const requestPromise = (async (): Promise<unknown> => {
      const response = await this.#fetch(`${DISCORD_API_BASE_URL}${request.path}`, {
        method: request.method,
        headers: {
          Accept: "application/json",
          "User-Agent": this.#userAgent,
          ...(bodyText === undefined ? {} : { "Content-Type": "application/json" }),
          ...(request.authenticated
            ? { Authorization: `Bot ${botToken ?? unreachableCredential()}` }
            : {}),
        },
        ...(bodyText === undefined ? {} : { body: bodyText }),
        signal: controller.signal,
      });

      const body = await readBoundedBody(response, this.#maximumResponseBytes);
      if (response.status === 429) {
        throw new DiscordApiError(
          "RATE_LIMIT",
          "Discord rate limited the request.",
          retryAfterMs(response, body),
        );
      }
      if (response.status === 403) {
        throw new DiscordApiError("FORBIDDEN", "Discord denied the requested operation.");
      }
      if (response.status === 404) {
        throw new DiscordApiError("NOT_FOUND", "The requested Discord resource was not found.");
      }
      if (response.status < 200 || response.status >= 300) {
        throw new DiscordApiError(
          response.status >= 500 ? "OFFLINE" : "INVALID_RESPONSE",
          response.status >= 500
            ? "The Discord HTTP API is temporarily unavailable."
            : "Discord rejected the request.",
        );
      }
      if (body.byteLength === 0) {
        return undefined;
      }
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
      } catch {
        throw invalidResponse("Discord returned an invalid JSON response.");
      }
    })();
    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof DiscordApiError) {
        throw error;
      }
      throw new DiscordApiError("OFFLINE", "The Discord HTTP API is unavailable.");
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw invalidResponse("Discord returned a response larger than the configured bound.");
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is authoritative even if stream cancellation races.
        }
        throw invalidResponse("Discord returned a response larger than the configured bound.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DiscordApiError) {
      throw error;
    }
    throw new DiscordApiError("OFFLINE", "The Discord response stream was interrupted.");
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function retryAfterMs(response: Response, body: Uint8Array): number | undefined {
  const header = response.headers.get("Retry-After");
  const headerSeconds = header === null ? undefined : Number(header);
  if (
    headerSeconds !== undefined &&
    Number.isFinite(headerSeconds) &&
    headerSeconds >= 0 &&
    headerSeconds <= 86_400
  ) {
    return Math.ceil(headerSeconds * 1_000);
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(body)) as unknown;
    const record = requireRecord(decoded, "rate-limit response");
    const seconds = record["retry_after"];
    if (
      typeof seconds === "number" &&
      Number.isFinite(seconds) &&
      seconds >= 0 &&
      seconds <= 86_400
    ) {
      return Math.ceil(seconds * 1_000);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseRoles(value: unknown): ReadonlyMap<string, bigint> {
  const result = new Map<string, bigint>();
  for (const roleValue of requireArray(value, "guild roles", 1_000)) {
    const role = requireRecord(roleValue, "guild role");
    const id = requireSnowflake(role, "id");
    if (result.has(id)) {
      throw invalidResponse("Discord returned a duplicate guild role.");
    }
    result.set(id, parseBitfield(role["permissions"], "guild role permissions"));
  }
  return result;
}

function parsePermissionOverwrites(value: unknown): readonly PermissionOverwrite[] {
  return requireArray(value, "permission overwrites", 2_000).map((overwriteValue) => {
    const overwrite = requireRecord(overwriteValue, "permission overwrite");
    const type = requireSafeInteger(overwrite, "type");
    if (type !== 0 && type !== 1) {
      throw invalidResponse("Discord returned an invalid permission-overwrite type.");
    }
    return Object.freeze({
      id: requireSnowflake(overwrite, "id"),
      type,
      allow: parseBitfield(overwrite["allow"], "permission overwrite allow"),
      deny: parseBitfield(overwrite["deny"], "permission overwrite deny"),
    });
  });
}

interface PermissionOverwrite {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: bigint;
  readonly deny: bigint;
}

function computeBasePermissions(input: {
  readonly botUserId: string;
  readonly guildId: string;
  readonly guildOwnerId: string;
  readonly memberRoleIds: readonly string[];
  readonly roles: ReadonlyMap<string, bigint>;
}): bigint {
  if (input.guildOwnerId === input.botUserId) {
    return allPermissions();
  }
  const everyone = input.roles.get(input.guildId);
  if (everyone === undefined) {
    throw invalidResponse("Discord did not return the guild everyone role.");
  }
  let permissions = everyone;
  for (const roleId of input.memberRoleIds) {
    const role = input.roles.get(roleId);
    if (role === undefined) {
      throw invalidResponse("Discord did not return one of the bot's guild roles.");
    }
    permissions |= role;
  }
  return (permissions & ADMINISTRATOR) === ADMINISTRATOR ? allPermissions() : permissions;
}

function applyChannelOverwrites(input: {
  readonly basePermissions: bigint;
  readonly botUserId: string;
  readonly guildId: string;
  readonly memberRoleIds: readonly string[];
  readonly overwrites: readonly PermissionOverwrite[];
}): bigint {
  if ((input.basePermissions & ADMINISTRATOR) === ADMINISTRATOR) {
    return allPermissions();
  }
  let permissions = input.basePermissions;
  const everyone = input.overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === input.guildId,
  );
  if (everyone !== undefined) {
    permissions &= ~everyone.deny;
    permissions |= everyone.allow;
  }
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of input.overwrites) {
    if (overwrite.type === 0 && input.memberRoleIds.includes(overwrite.id)) {
      roleAllow |= overwrite.allow;
      roleDeny |= overwrite.deny;
    }
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;
  const member = input.overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === input.botUserId,
  );
  if (member !== undefined) {
    permissions &= ~member.deny;
    permissions |= member.allow;
  }
  return permissions;
}

function applicationFlags(application: Record<string, unknown>): bigint {
  if (application["flags_new"] !== undefined) {
    return parseBitfield(application["flags_new"], "Application flags");
  }
  return parseBitfield(application["flags"] ?? 0, "Application flags");
}

function parseBitfield(value: unknown, label: string): bigint {
  if (!(
    (typeof value === "string" && /^[0-9]{1,40}$/u.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  )) {
    throw invalidResponse(`Discord returned invalid ${label}.`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= 1n << 128n) {
    throw invalidResponse(`Discord returned out-of-range ${label}.`);
  }
  return parsed;
}

function validateMessagePayload(payload: DiscordMessagePayload): DiscordMessagePayload {
  if (
    payload.flags !== 1 << 15 ||
    !Array.isArray(payload.components) ||
    payload.components.length < 1 ||
    payload.components.length > 40 ||
    !Array.isArray(payload.allowed_mentions.parse) ||
    payload.allowed_mentions.parse.length !== 0
  ) {
    throw invalidResponse("The Discord Components v2 payload is invalid.");
  }
  encodeRequestJson(payload);
  return structuredClone(payload);
}

function encodeRequestJson(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalidResponse("The Discord request body is not JSON-serializable.");
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAXIMUM_JSON_REQUEST_BYTES) {
    throw invalidResponse("The Discord request body exceeds the configured bound.");
  }
  return encoded;
}

function nonceForRequestKey(requestKey: string): string {
  return `od${createHash("sha256").update(requestKey).digest("base64url").slice(0, 23)}`;
}

function compareSnowflakeMessage(left: DiscordMessage, right: DiscordMessage): number {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function assertDistinctSnowflakes(
  values: readonly string[],
  label: string,
  maximumLength: number,
): void {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximumLength) {
    throw invalidResponse(`${label} are invalid.`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    assertSnowflake(value, label);
    if (seen.has(value)) {
      throw invalidResponse(`${label} contain a duplicate.`);
    }
    seen.add(value);
  }
}

function assertRequestKey(value: string): void {
  if (value.length < 1 || value.length > 512 || value.includes("\u0000")) {
    throw invalidResponse("The Discord request idempotency key is invalid.");
  }
}

function assertBoundedForumText(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): void {
  const length = Array.from(value).length;
  if (length < minimum || length > maximum || value.includes("\u0000") || value.includes("\r")) {
    throw invalidResponse(`${label} is invalid.`);
  }
}

function assertProductVersion(value: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(value)) {
    throw invalidResponse("The OpenDelegate product version is invalid.");
  }
}

function assertSnowflake(value: string, label: string): void {
  if (!/^[0-9]{17,20}$/u.test(value)) {
    throw invalidResponse(`${label} is invalid.`);
  }
}

function assertTransientToken(value: string): void {
  if (
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw invalidResponse("The Discord credential is invalid.");
  }
}

function assertBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidResponse(`${label} is outside the supported bound.`);
  }
}

function allPermissions(): bigint {
  return (1n << 128n) - 1n;
}

function isSecureGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname.endsWith(".discord.gg") &&
      (url.port === "" || url.port === "443")
    );
  } catch {
    return false;
  }
}

function unreachableCredential(): never {
  throw invalidResponse("The Discord bot credential was unavailable.");
}

function invalidResponse(message: string): DiscordApiError {
  return new DiscordApiError("INVALID_RESPONSE", message);
}
