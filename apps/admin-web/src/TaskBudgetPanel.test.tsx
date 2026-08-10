import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminApiError, type AdminApi, type TaskBudgetSnapshot } from "./admin-api";
import { AdminI18nProvider } from "./i18n";
import { TaskBudgetPanel } from "./TaskBudgetPanel";

const taskId = "task_budget_surface";
const limits = {
  wallTimeMs: { soft: 3_000_000, hard: 3_600_000 },
  idleTimeMs: { soft: 480_000, hard: 600_000 },
  retries: { soft: 2, hard: 3 },
  childWorkOrders: { soft: 6, hard: 8 },
  concurrentRuns: { soft: 1, hard: 2 },
  nativeTurns: { soft: 12, hard: 16 },
  tokens: { soft: 200_000, hard: 250_000 },
  costUsdMicros: { soft: 4_000_000, hard: 5_000_000 },
} as const;

const snapshot: TaskBudgetSnapshot = {
  schemaVersion: 1,
  taskId,
  kind: "requested",
  revision: 3,
  createdAt: "2026-07-24T01:30:00.000Z",
  lastActivityAt: "2026-07-24T01:33:00.000Z",
  limits,
  usage: {
    wallTimeMs: 1_200_000,
    idleTimeMs: 20_000,
    retries: 1,
    childWorkOrders: 4,
    concurrentRuns: 1,
    nativeTurns: 8,
    tokens: 210_000,
    costUsdMicros: 2_500_000,
  },
  workOrders: [],
  activeRunIds: ["run_budget_surface"],
  limitEvents: [
    {
      eventId: "budget_event_tokens_soft",
      metric: "tokens",
      state: "soft-limit",
      current: 210_000,
      attempted: 210_000,
      hard: 250_000,
      occurredAt: "2026-07-24T01:33:00.000Z",
    },
  ],
  extensions: [],
  omitted: {
    workOrders: 0,
    activeRunIds: 0,
    limitEvents: 0,
    extensions: 0,
  },
};

describe("Task Budget owner surface", () => {
  it("shows current usage, soft warnings, hard stops, and only bounded event fields", async () => {
    const privateSentinel = "RAW_EVENT_PAYLOAD_MUST_NOT_RENDER";
    const api = budgetApi({
      getTaskBudget: vi.fn().mockResolvedValue({
        ...snapshot,
        limitEvents: [
          {
            ...snapshot.limitEvents[0],
            source: privateSentinel,
            arbitraryPayload: { secret: privateSentinel },
          },
        ],
      }),
    });

    renderBudget(api);

    expect(await screen.findByRole("heading", { name: "Task Budget" })).toBeTruthy();
    expect(await screen.findByText("Soft Budget warning")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Usage" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Soft warning" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Hard stop" })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Task Budget usage and limits" }).getAttribute("tabindex"),
    ).toBe("0");
    expect(screen.getByText("Owner-requested")).toBeTruthy();
    expect(screen.getByText("Soft warning · Tokens")).toBeTruthy();
    expect(document.body.textContent).not.toContain(privateSentinel);
  });

  it("submits the current revision and one exact, complete limit set as an explicit Owner action", async () => {
    const extended: TaskBudgetSnapshot = {
      ...snapshot,
      revision: 4,
      limits: {
        ...snapshot.limits,
        tokens: { soft: 225_000, hard: 300_000 },
      },
      extensions: [
        {
          eventId: "budget_extension_4",
          baseRevision: 3,
          revision: 4,
          occurredAt: "2026-07-24T01:35:00.000Z",
          actorId: "owner_primary",
          limits: {
            ...snapshot.limits,
            tokens: { soft: 225_000, hard: 300_000 },
          },
        },
      ],
    };
    const extendTaskBudget = vi.fn<AdminApi["extendTaskBudget"]>().mockResolvedValue(extended);
    const api = budgetApi({
      getTaskBudget: vi.fn().mockResolvedValue(snapshot),
      extendTaskBudget,
    });
    const user = userEvent.setup();
    renderBudget(api);

    await screen.findByText("Owner-requested");
    await user.click(screen.getByRole("button", { name: "Extend Task Budget" }));

    const submit = screen.getByRole("button", { name: "Confirm exact extension" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    const softTokens = screen.getByLabelText("Tokens soft warning");
    await user.clear(softTokens);
    await user.type(softTokens, "225000");
    const hardTokens = screen.getByLabelText("Tokens hard stop");
    await user.clear(hardTokens);
    await user.type(hardTokens, "300000");
    await user.click(
      screen.getByLabelText(
        "I understand this changes only this Task and remains bounded by the Instance ceilings.",
      ),
    );
    await user.click(submit);

    await waitFor(() => expect(extendTaskBudget).toHaveBeenCalledTimes(1));
    const [submittedTaskId, baseRevision, submittedLimits] = extendTaskBudget.mock.calls[0] ?? [];
    expect(submittedTaskId).toBe(taskId);
    expect(baseRevision).toBe(3);
    expect(Object.keys(submittedLimits ?? {}).sort()).toEqual(Object.keys(limits).sort());
    expect(submittedLimits).toEqual({
      ...limits,
      tokens: { soft: 225_000, hard: 300_000 },
    });
    expect(await screen.findByText("Revision 4")).toBeTruthy();
    expect(screen.getByText("owner_primary extended this Budget from revision 3.")).toBeTruthy();
  });

  it("does not tell the Owner to extend an idle-only hard stop", async () => {
    const api = budgetApi({
      getTaskBudget: vi.fn().mockResolvedValue({
        ...snapshot,
        usage: {
          ...snapshot.usage,
          tokens: 100_000,
          idleTimeMs: snapshot.limits.idleTimeMs.hard,
        },
      }),
    });

    renderBudget(api);

    expect(await screen.findByText("Hard Budget stop")).toBeTruthy();
    expect(
      screen.getByText(/Send a new Owner message.*Continue.*restart the idle window/iu),
    ).toBeTruthy();
    expect(screen.getByText(/inactivity alone does not require/iu)).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "New work stays stopped until the Owner explicitly extends",
    );
  });

  it("keeps the form open and explains an enforced Instance ceiling rejection", async () => {
    const api = budgetApi({
      getTaskBudget: vi.fn().mockResolvedValue(snapshot),
      extendTaskBudget: vi
        .fn()
        .mockRejectedValue(
          new AdminApiError(
            409,
            "TASK_BUDGET_PARENT_LIMIT_EXCEEDED",
            "Internal ceiling detail is intentionally not rendered.",
          ),
        ),
    });
    const user = userEvent.setup();
    renderBudget(api);

    await screen.findByText("Owner-requested");
    await user.click(screen.getByRole("button", { name: "Extend Task Budget" }));
    const hardTokens = screen.getByLabelText("Tokens hard stop");
    await user.clear(hardTokens);
    await user.type(hardTokens, "300000");
    await user.click(
      screen.getByLabelText(
        "I understand this changes only this Task and remains bounded by the Instance ceilings.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Confirm exact extension" }));

    expect(
      await screen.findByText(
        "One or more hard stops exceed the configured Instance ceiling. No limit was changed.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

function renderBudget(api: AdminApi): void {
  render(
    <AdminI18nProvider>
      <TaskBudgetPanel api={api} taskId={taskId} />
    </AdminI18nProvider>,
  );
}

function budgetApi(
  overrides: Partial<Pick<AdminApi, "getTaskBudget" | "extendTaskBudget">> = {},
): AdminApi {
  return {
    getTaskBudget: vi.fn().mockResolvedValue(snapshot),
    extendTaskBudget: vi.fn().mockResolvedValue(snapshot),
    ...overrides,
  } as Pick<AdminApi, "getTaskBudget" | "extendTaskBudget"> as AdminApi;
}
