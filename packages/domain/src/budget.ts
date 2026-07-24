import { DomainError } from "./domain-error.ts";
import type { BudgetId } from "./identifiers.ts";

export type BudgetScope = "instance" | "task" | "work-order" | "autonomous-task";
export type BudgetMetric =
  | "wallTimeMs"
  | "idleTimeMs"
  | "retries"
  | "childWorkOrders"
  | "concurrentRuns"
  | "nativeTurns"
  | "tokens"
  | "costUsdMicros";
export type BudgetLimitState = "within-budget" | "soft-limit" | "hard-limit";

export interface BudgetLimit {
  readonly soft?: number;
  readonly hard: number;
}

export type BudgetLimits = Partial<Record<BudgetMetric, BudgetLimit>>;

export interface CreateBudget {
  readonly id: BudgetId;
  readonly scope: BudgetScope;
  readonly limits: BudgetLimits;
}

export interface BudgetAssessment {
  readonly metric: BudgetMetric;
  readonly previous: number;
  readonly current: number;
  readonly state: BudgetLimitState;
}

export interface BudgetAuthority {
  readonly kind: "owner" | "main-agent";
  readonly authorityId: string;
}

export interface ExtendBudget {
  readonly baseRevision: number;
  readonly authority: BudgetAuthority;
  readonly limits: BudgetLimits;
}

export interface DeriveChildBudget {
  readonly id: BudgetId;
  readonly limits: BudgetLimits;
}

export interface BudgetSnapshot {
  readonly id: string;
  readonly scope: BudgetScope;
  readonly revision: number;
  readonly limits: Readonly<BudgetLimits>;
  readonly usage: Readonly<Partial<Record<BudgetMetric, number>>>;
  readonly reservedForChildren: Readonly<Partial<Record<BudgetMetric, number>>>;
}

const budgetMetrics = [
  "wallTimeMs",
  "idleTimeMs",
  "retries",
  "childWorkOrders",
  "concurrentRuns",
  "nativeTurns",
  "tokens",
  "costUsdMicros",
] as const satisfies readonly BudgetMetric[];

export class Budget {
  public readonly id: BudgetId;
  public readonly scope: BudgetScope;
  private currentRevision = 1;
  private readonly currentLimits = new Map<BudgetMetric, BudgetLimit>();
  private readonly currentUsage = new Map<BudgetMetric, number>();
  private readonly childReservations = new Map<BudgetMetric, number>();

  private constructor(input: CreateBudget) {
    this.id = input.id;
    this.scope = input.scope;
    this.replaceLimits(input.limits);
    if (
      input.scope === "autonomous-task" &&
      budgetMetrics.some((metric) => !this.currentLimits.has(metric))
    ) {
      throw new DomainError(
        "BUDGET_LIMIT_INVALID",
        "An Autonomous Task Budget requires a finite hard limit for every budget metric.",
      );
    }
  }

  public static create(input: CreateBudget): Budget {
    return new Budget(input);
  }

  public get snapshot(): BudgetSnapshot {
    const limits: BudgetLimits = {};
    const usage: Partial<Record<BudgetMetric, number>> = {};
    const reservedForChildren: Partial<Record<BudgetMetric, number>> = {};

    for (const metric of budgetMetrics) {
      const limit = this.currentLimits.get(metric);
      if (limit !== undefined) {
        limits[metric] = freezeLimit(limit);
      }

      const consumed = this.currentUsage.get(metric);
      if (consumed !== undefined) {
        usage[metric] = consumed;
      }
      const reserved = this.childReservations.get(metric);
      if (reserved !== undefined) {
        reservedForChildren[metric] = reserved;
      }
    }

    return Object.freeze({
      id: this.id.value,
      scope: this.scope,
      revision: this.currentRevision,
      limits: Object.freeze(limits),
      usage: Object.freeze(usage),
      reservedForChildren: Object.freeze(reservedForChildren),
    });
  }

  public recordUsage(metric: BudgetMetric, amount: number): BudgetAssessment {
    assertNonNegativeFinite(amount);
    this.assertCanConsume(metric, amount);
    const previous = this.currentUsage.get(metric) ?? 0;
    const current = previous + amount;
    this.currentUsage.set(metric, current);

    return Object.freeze({
      metric,
      previous,
      current,
      state: this.limitState(metric, current),
    });
  }

  public assertCanConsume(metric: BudgetMetric, amount: number): void {
    assertNonNegativeFinite(amount);
    const limit = this.currentLimits.get(metric);
    const projected =
      (this.currentUsage.get(metric) ?? 0) + (this.childReservations.get(metric) ?? 0) + amount;

    if (limit !== undefined && projected > limit.hard) {
      throw new DomainError(
        "BUDGET_HARD_LIMIT_REACHED",
        `Budget metric ${metric} would exceed hard limit ${limit.hard}.`,
      );
    }
  }

  public deriveChild(input: DeriveChildBudget): Budget {
    for (const metric of budgetMetrics) {
      const childLimit = input.limits[metric];
      const parentLimit = this.currentLimits.get(metric);
      const remainingParentLimit =
        parentLimit === undefined
          ? undefined
          : Math.max(
              0,
              parentLimit.hard -
                (this.currentUsage.get(metric) ?? 0) -
                (this.childReservations.get(metric) ?? 0),
            );
      if (
        childLimit !== undefined &&
        remainingParentLimit !== undefined &&
        childLimit.hard > remainingParentLimit
      ) {
        throw new DomainError(
          "BUDGET_PARENT_LIMIT_EXCEEDED",
          `Child hard limit ${childLimit.hard} for ${metric} exceeds parent remaining limit ${remainingParentLimit}.`,
        );
      }
    }

    const child = Budget.create({
      id: input.id,
      scope: this.scope === "instance" ? "task" : "work-order",
      limits: input.limits,
    });
    for (const metric of budgetMetrics) {
      const childLimit = input.limits[metric];
      if (childLimit !== undefined) {
        this.childReservations.set(
          metric,
          (this.childReservations.get(metric) ?? 0) + childLimit.hard,
        );
      }
    }
    return child;
  }

  public extend(input: ExtendBudget): void {
    if (input.authority.kind !== "owner") {
      throw new DomainError(
        "BUDGET_EXTENSION_AUTHORITY_REQUIRED",
        "Only the Owner may extend a Budget hard limit.",
      );
    }

    if (input.baseRevision !== this.currentRevision) {
      throw new DomainError(
        "BUDGET_REVISION_CONFLICT",
        `Budget revision ${this.currentRevision} does not match extension base revision ${input.baseRevision}.`,
      );
    }

    for (const metric of budgetMetrics) {
      const extension = input.limits[metric];
      if (extension === undefined) {
        continue;
      }

      validateLimit(extension);
      const current = this.currentLimits.get(metric);
      if (current !== undefined && extension.hard < current.hard) {
        throw new DomainError(
          "BUDGET_LIMIT_INVALID",
          `Budget extension for ${metric} cannot reduce its hard limit.`,
        );
      }
      this.currentLimits.set(metric, freezeLimit(extension));
    }

    this.currentRevision += 1;
  }

  private limitState(metric: BudgetMetric, usage: number): BudgetLimitState {
    const limit = this.currentLimits.get(metric);
    if (limit === undefined) {
      return "within-budget";
    }
    if (usage >= limit.hard) {
      return "hard-limit";
    }
    if (limit.soft !== undefined && usage >= limit.soft) {
      return "soft-limit";
    }
    return "within-budget";
  }

  private replaceLimits(limits: BudgetLimits): void {
    for (const metric of budgetMetrics) {
      const limit = limits[metric];
      if (limit !== undefined) {
        validateLimit(limit);
        this.currentLimits.set(metric, freezeLimit(limit));
      }
    }
  }
}

function validateLimit(limit: BudgetLimit): void {
  assertNonNegativeFinite(limit.hard);
  if (limit.soft !== undefined) {
    assertNonNegativeFinite(limit.soft);
    if (limit.soft > limit.hard) {
      throw new DomainError(
        "BUDGET_LIMIT_INVALID",
        "A Budget soft limit cannot exceed its hard limit.",
      );
    }
  }
}

function assertNonNegativeFinite(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new DomainError(
      "BUDGET_LIMIT_INVALID",
      "Budget limits and usage must be finite non-negative numbers.",
    );
  }
}

function freezeLimit(limit: BudgetLimit): BudgetLimit {
  return Object.freeze(
    limit.soft === undefined ? { hard: limit.hard } : { soft: limit.soft, hard: limit.hard },
  );
}
