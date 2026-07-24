export class SecretRedactor {
  readonly #needles: readonly string[];

  constructor(values: readonly string[]) {
    const needles = new Set<string>();
    for (const value of values) {
      if (value.length === 0) {
        continue;
      }
      needles.add(value);
      needles.add(JSON.stringify(value).slice(1, -1));
      try {
        needles.add(encodeURIComponent(value));
      } catch {
        // The literal and JSON forms still remain protected.
      }
      needles.add(Buffer.from(value, "utf8").toString("base64"));
    }
    this.#needles = [...needles].sort((left, right) => right.length - left.length);
  }

  text(value: string): string {
    let result = value;
    for (const needle of this.#needles) {
      result = result.split(needle).join("[REDACTED]");
    }
    return result;
  }

  unknown(value: unknown): unknown {
    if (typeof value === "string") {
      return this.text(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.unknown(entry));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.unknown(entry)]),
      );
    }
    return value;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
