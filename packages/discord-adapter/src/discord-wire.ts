import type {
  DiscordAttachmentReference,
  DiscordAuthor,
  DiscordInteraction,
  DiscordMessage,
  DiscordThread,
} from "./contracts.ts";
import { DiscordApiError } from "./errors.ts";

const MAX_MESSAGE_CONTENT_CHARACTERS = 16_384;
const MAX_ATTACHMENTS = 100;
const MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024 * 1024;

export function mapDiscordThread(value: unknown): DiscordThread {
  const record = requireRecord(value, "thread");
  const type = requireSafeInteger(record, "type");
  if (type !== 11) {
    throw invalid("Discord returned a channel that is not a public thread.");
  }
  const metadata = requireRecord(record["thread_metadata"], "thread metadata");
  const tags = requireSnowflakeArray(record["applied_tags"], "applied tags", 5);
  const name = requireString(record, "name", 1, 100);
  return Object.freeze({
    id: requireSnowflake(record, "id"),
    guildId: requireSnowflake(record, "guild_id"),
    parentId: requireSnowflake(record, "parent_id"),
    type: 11 as const,
    name,
    ownerId: requireSnowflake(record, "owner_id"),
    appliedTagIds: Object.freeze(tags),
    archived: requireBoolean(metadata, "archived"),
    locked: requireBoolean(metadata, "locked"),
  });
}

export function discordThreadArchiveTimestamp(value: unknown): string | undefined {
  const record = requireRecord(value, "thread");
  const metadata = requireRecord(record["thread_metadata"], "thread metadata");
  const timestamp = metadata["archive_timestamp"];
  if (timestamp === undefined) {
    return undefined;
  }
  if (typeof timestamp !== "string" || !isRfc3339(timestamp)) {
    throw invalid("Discord returned an invalid thread archive timestamp.");
  }
  return timestamp;
}

export function mapDiscordMessage(value: unknown): DiscordMessage {
  const record = requireRecord(value, "message");
  const authorRecord = requireRecord(record["author"], "message author");
  const member = optionalRecord(record["member"], "message member");
  const attachments = requireArray(record["attachments"], "message attachments", MAX_ATTACHMENTS);
  const timestamp = requireString(record, "timestamp", 1, 64);
  const createdAtMs = Date.parse(timestamp);
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || !isRfc3339(timestamp)) {
    throw invalid("Discord returned an invalid message timestamp.");
  }

  return Object.freeze({
    id: requireSnowflake(record, "id"),
    guildId: requireSnowflake(record, "guild_id"),
    channelId: requireSnowflake(record, "channel_id"),
    author: mapAuthor(authorRecord, member),
    content: requireString(record, "content", 0, MAX_MESSAGE_CONTENT_CHARACTERS),
    attachments: Object.freeze(attachments.map(mapAttachment)),
    createdAtMs,
  });
}

export function mapDiscordInteraction(value: unknown, receivedAtMs: number): DiscordInteraction {
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) {
    throw invalid("The Gateway interaction clock is invalid.");
  }
  const record = requireRecord(value, "interaction");
  if (requireSafeInteger(record, "type") !== 3) {
    throw invalid("Only Discord message-component interactions are supported.");
  }
  const data = requireRecord(record["data"], "interaction data");
  const message = requireRecord(record["message"], "interaction message");
  const member = optionalRecord(record["member"], "interaction member");
  const user =
    member === undefined
      ? requireRecord(record["user"], "interaction user")
      : requireRecord(member["user"], "interaction member user");

  return Object.freeze({
    id: requireSnowflake(record, "id"),
    token: requireSecretString(record, "token"),
    guildId: requireSnowflake(record, "guild_id"),
    channelId: requireSnowflake(record, "channel_id"),
    messageId: requireSnowflake(message, "id"),
    customId: requireString(data, "custom_id", 1, 100),
    author: mapAuthor(user, member),
    receivedAtMs,
  });
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`Discord returned invalid ${label} data.`);
  }
  return value as Record<string, unknown>;
}

export function requireArray(
  value: unknown,
  label: string,
  maximumLength: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw invalid(`Discord returned invalid ${label} data.`);
  }
  return value;
}

export function requireSnowflake(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !/^[0-9]{17,20}$/u.test(value)) {
    throw invalid(`Discord returned an invalid ${field} identifier.`);
  }
  return value;
}

export function requireString(
  record: Record<string, unknown>,
  field: string,
  minimumLength: number,
  maximumLength: number,
): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    value.includes("\u0000")
  ) {
    throw invalid(`Discord returned an invalid ${field} field.`);
  }
  return value;
}

export function requireBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw invalid(`Discord returned an invalid ${field} field.`);
  }
  return value;
}

export function requireSafeInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value)) {
    throw invalid(`Discord returned an invalid ${field} field.`);
  }
  return value as number;
}

export function requireSnowflakeArray(
  value: unknown,
  label: string,
  maximumLength: number,
): string[] {
  return requireArray(value, label, maximumLength).map((entry) => {
    if (typeof entry !== "string" || !/^[0-9]{17,20}$/u.test(entry)) {
      throw invalid(`Discord returned an invalid ${label} identifier.`);
    }
    return entry;
  });
}

function mapAuthor(
  authorRecord: Record<string, unknown>,
  member: Record<string, unknown> | undefined,
): DiscordAuthor {
  const bot = authorRecord["bot"] ?? false;
  if (typeof bot !== "boolean") {
    throw invalid("Discord returned an invalid bot-author flag.");
  }
  const roles =
    member === undefined ? [] : requireSnowflakeArray(member["roles"] ?? [], "member role", 1_000);
  return Object.freeze({
    id: requireSnowflake(authorRecord, "id"),
    bot,
    roleIds: Object.freeze(roles),
  });
}

function mapAttachment(value: unknown): DiscordAttachmentReference {
  const record = requireRecord(value, "attachment");
  const size = requireSafeInteger(record, "size");
  if (size < 0 || size > MAX_ATTACHMENT_SIZE_BYTES) {
    throw invalid("Discord returned an invalid attachment size.");
  }
  const mediaType = record["content_type"];
  if (
    mediaType !== undefined &&
    (typeof mediaType !== "string" || mediaType.length < 1 || mediaType.length > 255)
  ) {
    throw invalid("Discord returned an invalid attachment media type.");
  }
  return Object.freeze({
    id: requireSnowflake(record, "id"),
    filename: requireString(record, "filename", 1, 1_024),
    size,
    ...(mediaType === undefined ? {} : { mediaType }),
  });
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireRecord(value, label);
}

function requireSecretString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw invalid("Discord returned an invalid transient credential.");
  }
  return value;
}

function isRfc3339(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function invalid(message: string): DiscordApiError {
  return new DiscordApiError("INVALID_RESPONSE", message);
}
