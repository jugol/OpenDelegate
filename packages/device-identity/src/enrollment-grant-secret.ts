import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

export class EnrollmentGrantSecret {
  readonly #value: string;

  public constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  public reveal(): string {
    return this.#value;
  }

  public toString(): string {
    return REDACTED;
  }

  public toJSON(): string {
    return REDACTED;
  }

  public [inspect.custom](): string {
    return REDACTED;
  }
}
