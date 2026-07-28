import { createHash } from "node:crypto";

import type { TaskDetailV1 } from "@opendelegate/protocol";
import type { CreateTaskInput } from "@opendelegate/task-service";

import type {
  MainProactiveDisposition,
  MainProactiveWorkKind,
} from "./configuration-runtime-policy.ts";

export interface MainProactiveTaskOriginatorInput {
  readonly signalId: string;
  readonly kind: MainProactiveWorkKind;
  readonly deviceId?: string;
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly selectedInputRefs: readonly string[];
  readonly source: {
    readonly kind: "deterministic-monitor" | "system-incident" | "scheduled-check";
    readonly reference: string;
  };
}

export type MainProactiveTaskOriginatorReceipt =
  | { readonly disposition: "disabled" }
  | {
      readonly disposition: "proposed" | "executing";
      readonly taskId: string;
      readonly mode: "manual" | "auto";
    };

export interface MainProactiveTaskOriginatorOptions {
  readonly policy: {
    proactiveDisposition(
      kind: MainProactiveWorkKind,
      options?: { readonly deviceId?: string },
    ): Promise<MainProactiveDisposition>;
  };
  readonly tasks: {
    create(input: CreateTaskInput): Promise<Pick<TaskDetailV1, "taskId" | "mode">>;
  };
  readonly presentation?: {
    present(taskId: string): Promise<void>;
  };
  readonly principalId?: string;
}

/**
 * Converts an already-bounded deterministic signal into an ordinary durable Task.
 *
 * The monitor itself never runs an LLM. `manual` Tasks become reviewable Forum
 * proposals; `auto` Tasks enter the normal coordinator, budget, approval, Action
 * Policy, Worker, Artifact, audit, and Discord projection paths.
 */
export class MainProactiveTaskOriginator {
  readonly #policy: MainProactiveTaskOriginatorOptions["policy"];
  readonly #tasks: MainProactiveTaskOriginatorOptions["tasks"];
  readonly #presentation: MainProactiveTaskOriginatorOptions["presentation"];
  readonly #principalId: string;

  public constructor(options: MainProactiveTaskOriginatorOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      options.policy === null ||
      typeof options.policy !== "object" ||
      typeof options.policy.proactiveDisposition !== "function" ||
      options.tasks === null ||
      typeof options.tasks !== "object" ||
      typeof options.tasks.create !== "function"
    ) {
      throw new TypeError("Proactive Task originator dependencies are invalid.");
    }
    this.#policy = options.policy;
    this.#tasks = options.tasks;
    this.#presentation = options.presentation;
    this.#principalId = boundedIdentifier(options.principalId ?? "system:proactive", 160);
  }

  public async originate(
    input: MainProactiveTaskOriginatorInput,
  ): Promise<MainProactiveTaskOriginatorReceipt> {
    const signal = validateInput(input);
    const disposition = await this.#policy.proactiveDisposition(
      signal.kind,
      signal.deviceId === undefined ? undefined : { deviceId: signal.deviceId },
    );
    if (disposition === "disabled") {
      return Object.freeze({ disposition: "disabled" });
    }
    const mode = disposition === "execute" ? ("auto" as const) : ("manual" as const);
    const idempotencyKey = `proactive:${digest(
      JSON.stringify({
        schemaVersion: 1,
        signalId: signal.signalId,
        kind: signal.kind,
        deviceId: signal.deviceId ?? null,
        source: signal.source,
      }),
    )}`;
    const task = await this.#tasks.create({
      principalId: this.#principalId,
      idempotencyKey,
      objective: signal.objective,
      completionCriteria: signal.completionCriteria,
      constraints: [
        ...signal.constraints,
        `Originated by ${signal.source.kind} ${signal.source.reference}; keep Action Policy, approvals, and budgets in force.`,
      ],
      selectedInputRefs: signal.selectedInputRefs,
      mode,
    });
    await this.#presentation?.present(task.taskId);
    return Object.freeze({
      disposition: disposition === "execute" ? ("executing" as const) : ("proposed" as const),
      taskId: task.taskId,
      mode,
    });
  }
}

function validateInput(input: MainProactiveTaskOriginatorInput): MainProactiveTaskOriginatorInput {
  if (input === null || typeof input !== "object") {
    throw new TypeError("A proactive monitor signal is required.");
  }
  boundedIdentifier(input.signalId, 160);
  if (
    input.kind !== "incident-recovery" &&
    input.kind !== "maintenance" &&
    input.kind !== "capability-expansion" &&
    input.kind !== "cleanup" &&
    input.kind !== "cost-incurring-work" &&
    input.kind !== "general-improvement"
  ) {
    throw new TypeError("The proactive monitor signal kind is invalid.");
  }
  if (input.deviceId !== undefined) {
    boundedIdentifier(input.deviceId, 160);
  }
  boundedText(input.objective, 8_192);
  boundedTextList(input.completionCriteria, 1, 64, 8_192);
  boundedTextList(input.constraints, 0, 127, 8_000);
  const selectedInputRefs = boundedTextList(input.selectedInputRefs, 0, 128, 160);
  for (const reference of selectedInputRefs) {
    boundedIdentifier(reference, 160);
  }
  if (
    input.source === null ||
    typeof input.source !== "object" ||
    (input.source.kind !== "deterministic-monitor" &&
      input.source.kind !== "system-incident" &&
      input.source.kind !== "scheduled-check")
  ) {
    throw new TypeError("The proactive monitor source is invalid.");
  }
  boundedText(input.source.reference, 512);
  return structuredClone(input);
}

function boundedTextList(
  input: readonly string[],
  minimum: number,
  maximum: number,
  maximumTextLength: number,
): readonly string[] {
  if (
    !Array.isArray(input) ||
    input.length < minimum ||
    input.length > maximum ||
    new Set(input).size !== input.length
  ) {
    throw new TypeError("A proactive monitor text list is invalid.");
  }
  for (const value of input) {
    boundedText(value, maximumTextLength);
  }
  return input;
}

function boundedIdentifier(value: string, maximum: number): string {
  boundedText(value, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new TypeError("A proactive monitor identifier is invalid.");
  }
  return value;
}

function boundedText(value: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new TypeError("Proactive monitor text is invalid.");
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
