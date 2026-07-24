const DISCORD_WEBHOOK_PATTERN =
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/giu;
const AUTHORIZATION_PATTERN =
  /\b(?:authorization|bot[_ -]?token|interaction[_ -]?token|token)\s*[:=]\s*(?:bot\s+)?[^\s,;]+/giu;
const DISCORD_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{20,}\b/gu;

export function redactDiscordSecrets(value: string): string {
  return value
    .replace(DISCORD_WEBHOOK_PATTERN, "[REDACTED_DISCORD_WEBHOOK]")
    .replace(DISCORD_TOKEN_PATTERN, "[REDACTED_DISCORD_TOKEN]")
    .replace(AUTHORIZATION_PATTERN, "[REDACTED_CREDENTIAL]");
}
