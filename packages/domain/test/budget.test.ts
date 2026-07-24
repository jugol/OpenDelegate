import assert from "node:assert/strict";
import test from "node:test";

import { Budget, BudgetId, DomainError } from "../src/index.ts";

test("a Budget reports soft and hard limits and blocks new work after exhaustion", () => {
  const budget = Budget.create({
    id: BudgetId.from("budget-task-report"),
    scope: "task",
    limits: {
      childWorkOrders: { soft: 1, hard: 2 },
      tokens: { soft: 8_000, hard: 10_000 },
    },
  });

  assert.deepEqual(budget.recordUsage("childWorkOrders", 1), {
    metric: "childWorkOrders",
    previous: 0,
    current: 1,
    state: "soft-limit",
  });
  budget.assertCanConsume("childWorkOrders", 1);
  assert.equal(budget.recordUsage("childWorkOrders", 1).state, "hard-limit");

  assert.throws(
    () => budget.assertCanConsume("childWorkOrders", 1),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "BUDGET_HARD_LIMIT_REACHED");
      return true;
    },
  );
  assert.throws(
    () => budget.recordUsage("childWorkOrders", 1),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "BUDGET_HARD_LIMIT_REACHED");
      return true;
    },
  );
  assert.equal(budget.snapshot.usage.childWorkOrders, 2);
  assert.equal(Object.isFrozen(budget.snapshot), true);
  assert.equal(Object.isFrozen(budget.snapshot.limits), true);
  assert.equal(Object.isFrozen(budget.snapshot.limits.childWorkOrders), true);
  assert.equal(Object.isFrozen(budget.snapshot.usage), true);
});

test("a Work Order Budget cannot silently exceed its parent Task Budget", () => {
  const taskBudget = Budget.create({
    id: BudgetId.from("budget-task"),
    scope: "task",
    limits: {
      retries: { hard: 2 },
      tokens: { hard: 10_000 },
    },
  });

  assert.throws(
    () =>
      taskBudget.deriveChild({
        id: BudgetId.from("budget-work-order"),
        limits: {
          retries: { hard: 3 },
          tokens: { hard: 5_000 },
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "BUDGET_PARENT_LIMIT_EXCEEDED");
      return true;
    },
  );

  taskBudget.recordUsage("tokens", 6_000);
  assert.throws(
    () =>
      taskBudget.deriveChild({
        id: BudgetId.from("budget-work-order-remaining"),
        limits: {
          tokens: { hard: 5_000 },
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "BUDGET_PARENT_LIMIT_EXCEEDED");
      return true;
    },
  );
});

test("only the Owner can extend a Budget hard limit", () => {
  const budget = Budget.create({
    id: BudgetId.from("budget-extend"),
    scope: "task",
    limits: {
      wallTimeMs: { hard: 60_000 },
    },
  });

  assert.throws(
    () =>
      budget.extend({
        baseRevision: 1,
        authority: { kind: "main-agent", authorityId: "main-agent" },
        limits: { wallTimeMs: { hard: 120_000 } },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "BUDGET_EXTENSION_AUTHORITY_REQUIRED");
      return true;
    },
  );

  budget.extend({
    baseRevision: 1,
    authority: { kind: "owner", authorityId: "owner-personal" },
    limits: { wallTimeMs: { soft: 100_000, hard: 120_000 } },
  });
  assert.equal(budget.snapshot.revision, 2);
  assert.deepEqual(budget.snapshot.limits.wallTimeMs, {
    soft: 100_000,
    hard: 120_000,
  });
});

test("an Autonomous Task Budget must define finite hard limits for every runaway dimension", () => {
  assert.throws(
    () =>
      Budget.create({
        id: BudgetId.from("budget-autonomous"),
        scope: "autonomous-task",
        limits: {
          wallTimeMs: { hard: 60_000 },
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "BUDGET_LIMIT_INVALID");
      return true;
    },
  );
});

test("derived child Budgets reserve parent capacity and cannot oversubscribe it", () => {
  const parent = Budget.create({
    id: BudgetId.from("budget-parent-reservation"),
    scope: "task",
    limits: {
      tokens: { hard: 10_000 },
    },
  });
  parent.deriveChild({
    id: BudgetId.from("budget-child-one"),
    limits: {
      tokens: { hard: 6_000 },
    },
  });

  assert.throws(
    () =>
      parent.deriveChild({
        id: BudgetId.from("budget-child-two"),
        limits: {
          tokens: { hard: 5_000 },
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "BUDGET_PARENT_LIMIT_EXCEEDED");
      return true;
    },
  );
  assert.equal(parent.snapshot.reservedForChildren.tokens, 6_000);
});
