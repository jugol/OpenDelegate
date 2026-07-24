import { DomainError } from "./domain-error.ts";
import type { PolicyId } from "./identifiers.ts";

export type PolicyOutcome = "allow" | "require-approval" | "deny";

export interface PolicyRule {
  readonly id: string;
  readonly actionPattern: string;
  readonly targetDeviceId?: string;
  readonly outcome: PolicyOutcome;
}

export interface PolicyAction {
  readonly actionType: string;
  readonly targetDeviceId: string;
}

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly ruleId?: string;
}

export interface PolicyAuthority {
  readonly kind: "owner" | "main-agent" | "worker-agent";
  readonly authorityId: string;
}

export interface CreatePolicy {
  readonly id: PolicyId;
  readonly defaultOutcome: PolicyOutcome;
  readonly rules: readonly PolicyRule[];
}

export interface PolicyPatch {
  readonly baseRevision: number;
  readonly authority: PolicyAuthority;
  readonly defaultOutcome?: PolicyOutcome;
  readonly upsertRules?: readonly PolicyRule[];
  readonly removeRuleIds?: readonly string[];
}

export interface PolicySnapshot {
  readonly id: string;
  readonly revision: number;
  readonly defaultOutcome: PolicyOutcome;
  readonly rules: readonly PolicyRule[];
}

export class Policy {
  public readonly id: PolicyId;
  private currentRevision = 1;
  private currentDefaultOutcome: PolicyOutcome;
  private readonly rules = new Map<string, PolicyRule>();

  private constructor(input: CreatePolicy) {
    this.id = input.id;
    this.currentDefaultOutcome = input.defaultOutcome;
    for (const rule of input.rules) {
      if (this.rules.has(rule.id)) {
        throw new DomainError("POLICY_RULE_DUPLICATED", `Policy rule ${rule.id} is duplicated.`);
      }
      this.rules.set(rule.id, freezeRule(rule));
    }
  }

  public static create(input: CreatePolicy): Policy {
    return new Policy(input);
  }

  public get snapshot(): PolicySnapshot {
    return Object.freeze({
      id: this.id.value,
      revision: this.currentRevision,
      defaultOutcome: this.currentDefaultOutcome,
      rules: Object.freeze(
        [...this.rules.values()]
          .map(freezeRule)
          .sort((left, right) => left.id.localeCompare(right.id)),
      ),
    });
  }

  public evaluate(action: PolicyAction): PolicyDecision {
    const match = [...this.rules.values()]
      .filter((rule) => ruleMatches(rule, action))
      .map((rule) => ({ rule, score: specificityScore(rule) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          outcomeRank(left.rule.outcome) - outcomeRank(right.rule.outcome) ||
          left.rule.id.localeCompare(right.rule.id),
      )[0];

    if (match === undefined) {
      return Object.freeze({ outcome: this.currentDefaultOutcome });
    }

    return Object.freeze({
      outcome: match.rule.outcome,
      ruleId: match.rule.id,
    });
  }

  public applyPatch(patch: PolicyPatch): void {
    if (patch.authority.kind === "worker-agent") {
      throw new DomainError(
        "POLICY_AUTHORITY_REQUIRED",
        "A Worker Agent cannot persist executable Policy changes.",
      );
    }

    if (patch.baseRevision !== this.currentRevision) {
      throw new DomainError(
        "POLICY_REVISION_CONFLICT",
        `Policy revision ${this.currentRevision} does not match patch base revision ${patch.baseRevision}.`,
      );
    }

    if (patch.authority.kind !== "owner" && this.patchRelaxesPolicy(patch)) {
      throw new DomainError(
        "POLICY_RELAXATION_OWNER_REQUIRED",
        "Only the Owner may relax executable Policy.",
      );
    }

    if (patch.defaultOutcome !== undefined) {
      this.currentDefaultOutcome = patch.defaultOutcome;
    }
    for (const ruleId of patch.removeRuleIds ?? []) {
      this.rules.delete(ruleId);
    }
    for (const rule of patch.upsertRules ?? []) {
      this.rules.set(rule.id, freezeRule(rule));
    }
    this.currentRevision += 1;
  }

  private patchRelaxesPolicy(patch: PolicyPatch): boolean {
    if (
      patch.defaultOutcome !== undefined &&
      outcomeRank(patch.defaultOutcome) > outcomeRank(this.currentDefaultOutcome)
    ) {
      return true;
    }

    if ((patch.removeRuleIds?.length ?? 0) > 0) {
      return true;
    }

    return (patch.upsertRules ?? []).some((rule) => {
      const currentRule = this.rules.get(rule.id);
      if (currentRule === undefined) {
        // A new non-deny matcher can shadow an existing stricter wildcard rule.
        // Main may always add a deny rule; broader relaxations remain Owner-only.
        return rule.outcome !== "deny";
      }
      if (
        currentRule.actionPattern !== rule.actionPattern ||
        currentRule.targetDeviceId !== rule.targetDeviceId
      ) {
        return true;
      }
      return outcomeRank(rule.outcome) > outcomeRank(currentRule.outcome);
    });
  }
}

function freezeRule(rule: PolicyRule): PolicyRule {
  return Object.freeze(
    rule.targetDeviceId === undefined
      ? {
          id: rule.id,
          actionPattern: rule.actionPattern,
          outcome: rule.outcome,
        }
      : {
          id: rule.id,
          actionPattern: rule.actionPattern,
          targetDeviceId: rule.targetDeviceId,
          outcome: rule.outcome,
        },
  );
}

function ruleMatches(rule: PolicyRule, action: PolicyAction): boolean {
  if (rule.targetDeviceId !== undefined && rule.targetDeviceId !== action.targetDeviceId) {
    return false;
  }
  if (rule.actionPattern === "*") {
    return true;
  }
  if (rule.actionPattern.endsWith("*")) {
    return action.actionType.startsWith(rule.actionPattern.slice(0, -1));
  }
  return action.actionType === rule.actionPattern;
}

function specificityScore(rule: PolicyRule): number {
  const deviceScore = rule.targetDeviceId === undefined ? 0 : 10_000;
  const exactScore = rule.actionPattern.endsWith("*") ? 0 : 1_000;
  return deviceScore + exactScore + rule.actionPattern.length;
}

function outcomeRank(outcome: PolicyOutcome): number {
  switch (outcome) {
    case "deny":
      return 0;
    case "require-approval":
      return 1;
    case "allow":
      return 2;
  }
}
