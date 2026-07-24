import { SecretError } from "./secret-error.ts";

const MAX_IDENTIFIER_LENGTH = 256;

export function assertSecretIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new SecretError(
      "SECRET_IDENTIFIER_INVALID",
      `${label} must be a trimmed, non-empty identifier without control characters.`,
    );
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}
