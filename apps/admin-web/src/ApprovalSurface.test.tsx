import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AdminApi, ApprovalDetail } from "./admin-api";
import { ApprovalSurface } from "./ApprovalSurface";

const pendingApproval: ApprovalDetail = {
  approvalId: "approval_configuration_001",
  state: "pending",
  executionStatus: "waiting",
  requestedAt: "2026-07-24T01:02:00.000Z",
  expiresAt: "2026-07-25T01:02:00.000Z",
  action: {
    category: "policy-relaxation",
    type: "configuration.apply",
    fingerprint: `sha256:${"a".repeat(64)}`,
    targetDeviceId: "device_main",
    resource: "configuration-proposal:proposal_001",
  },
  reason: "Enable Computer Use for this Device.",
  target: "Mac Studio",
  risk: "high",
  evidence: ["capability.computer-use at device:device_main", "Codex Desktop is installed."],
  configuration: {
    proposalId: "proposal_001",
    baseRevision: 7,
    changes: [
      {
        key: "capability.computer-use",
        scope: { kind: "device", id: "device_main" },
        before: { present: false },
        after: { present: true, valueJson: '{"enabled":true}' },
      },
    ],
  },
};

describe("ApprovalSurface", () => {
  it("focuses the exact Approval linked from Configuration Chat", async () => {
    const linkedApproval: ApprovalDetail = {
      ...pendingApproval,
      approvalId: "approval_configuration_linked",
      reason: "Apply the linked Worker profile.",
      configuration: {
        ...pendingApproval.configuration!,
        proposalId: "proposal_linked",
      },
    };
    const api = approvalApi({
      listApprovals: vi.fn().mockResolvedValue([pendingApproval, linkedApproval]),
    });

    render(<ApprovalSurface api={api} initialApprovalId={linkedApproval.approvalId} />);

    const inspector = await screen.findByRole("complementary", {
      name: "Approval details: configuration.apply",
    });
    expect(within(inspector).getByText("Apply the linked Worker profile.")).toBeTruthy();
  });

  it("shows exact review evidence and approves once by default", async () => {
    const user = userEvent.setup();
    const decidedApproval: ApprovalDetail = {
      ...pendingApproval,
      state: "approved",
      executionStatus: "succeeded",
      decision: {
        decision: "approve",
        scope: "once",
        decidedBy: "owner_primary",
        decidedAt: "2026-07-24T01:04:00.000Z",
      },
    };
    const api = approvalApi({
      listApprovals: vi.fn().mockResolvedValue([pendingApproval]),
      decideApproval: vi.fn().mockResolvedValue(decidedApproval),
    });

    render(<ApprovalSurface api={api} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Approvals" })).toBeTruthy();
    expect(await screen.findByText("Enable Computer Use for this Device.")).toBeTruthy();
    expect(screen.getByText("Mac Studio")).toBeTruthy();

    const inspector = screen.getByRole("complementary", {
      name: "Approval details: configuration.apply",
    });
    expect(within(inspector).getByText("High risk")).toBeTruthy();
    expect(within(inspector).getByText(pendingApproval.action.fingerprint)).toBeTruthy();
    expect(within(inspector).getByText("Codex Desktop is installed.")).toBeTruthy();
    expect(within(inspector).getByText("capability.computer-use")).toBeTruthy();
    expect(within(inspector).getByText("Not set")).toBeTruthy();
    expect(within(inspector).getByText(/"enabled": true/u)).toBeTruthy();
    expect(
      within(inspector).getByText(
        "Every scope below remains limited to this exact action fingerprint.",
      ),
    ).toBeTruthy();

    const scope = within(inspector).getByLabelText("Approval scope") as HTMLSelectElement;
    expect(scope.value).toBe("once");
    await user.click(within(inspector).getByRole("button", { name: "Approve once" }));

    await waitFor(() => {
      expect(api.decideApproval).toHaveBeenCalledWith(pendingApproval.approvalId, {
        decision: "approve",
        scope: "once",
      });
    });
    expect((await within(inspector).findAllByText("Approved")).length).toBeGreaterThan(0);
    expect(within(inspector).getByText("Execution succeeded")).toBeTruthy();
    expect(within(inspector).queryByRole("button", { name: "Approve once" })).toBeNull();
  });

  it("reports a landed decision so configuration surfaces can re-read durable state", async () => {
    const user = userEvent.setup();
    const decidedApproval: ApprovalDetail = {
      ...pendingApproval,
      state: "approved",
      executionStatus: "succeeded",
      decision: {
        decision: "approve",
        scope: "once",
        decidedBy: "owner_primary",
        decidedAt: "2026-07-24T01:04:00.000Z",
      },
    };
    const onApprovalDecided = vi.fn();
    const api = approvalApi({
      listApprovals: vi.fn().mockResolvedValue([pendingApproval]),
      decideApproval: vi.fn().mockResolvedValue(decidedApproval),
    });

    render(<ApprovalSurface api={api} onApprovalDecided={onApprovalDecided} />);
    const inspector = await screen.findByRole("complementary", {
      name: "Approval details: configuration.apply",
    });
    expect(onApprovalDecided).not.toHaveBeenCalled();

    await user.click(within(inspector).getByRole("button", { name: "Approve once" }));

    await waitFor(() => {
      expect(onApprovalDecided).toHaveBeenCalledTimes(1);
    });
  });

  it("reports a durable decision even when the decision response is lost", async () => {
    const user = userEvent.setup();
    const onApprovalDecided = vi.fn();
    const api = approvalApi({
      listApprovals: vi.fn().mockResolvedValue([pendingApproval]),
      decideApproval: vi.fn().mockRejectedValue(new Error("response lost in transit")),
      getApproval: vi.fn().mockResolvedValue({
        ...pendingApproval,
        state: "approved",
        executionStatus: "succeeded",
        decision: {
          decision: "approve",
          scope: "once",
          decidedBy: "owner_primary",
          decidedAt: "2026-07-24T01:04:00.000Z",
        },
      }),
    });

    render(<ApprovalSurface api={api} onApprovalDecided={onApprovalDecided} />);
    const inspector = await screen.findByRole("complementary", {
      name: "Approval details: configuration.apply",
    });
    await user.click(within(inspector).getByRole("button", { name: "Approve once" }));

    await waitFor(() => {
      expect(onApprovalDecided).toHaveBeenCalledTimes(1);
    });
  });

  it("requires a reason before a denial and submits it explicitly", async () => {
    const user = userEvent.setup();
    const deniedApproval: ApprovalDetail = {
      ...pendingApproval,
      state: "denied",
      executionStatus: "skipped",
      decision: {
        decision: "deny",
        reason: "The capability was detected but not verified.",
        decidedBy: "owner_primary",
        decidedAt: "2026-07-24T01:04:00.000Z",
      },
    };
    const api = approvalApi({
      listApprovals: vi.fn().mockResolvedValue([pendingApproval]),
      decideApproval: vi.fn().mockResolvedValue(deniedApproval),
    });

    render(<ApprovalSurface api={api} />);
    const inspector = await screen.findByRole("complementary", {
      name: "Approval details: configuration.apply",
    });
    const deny = within(inspector).getByRole("button", { name: "Deny request" });
    expect((deny as HTMLButtonElement).disabled).toBe(true);

    await user.type(
      within(inspector).getByLabelText("Reason for denial"),
      "The capability was detected but not verified.",
    );
    expect((deny as HTMLButtonElement).disabled).toBe(false);
    await user.click(deny);

    await waitFor(() => {
      expect(api.decideApproval).toHaveBeenCalledWith(pendingApproval.approvalId, {
        decision: "deny",
        reason: "The capability was detected but not verified.",
      });
    });
    expect((await within(inspector).findAllByText("Denied")).length).toBeGreaterThan(0);
    expect(
      within(inspector).getByText("The capability was detected but not verified."),
    ).toBeTruthy();
  });

  it("reloads the durable record when execution fails after the owner decision", async () => {
    const user = userEvent.setup();
    const failedApproval: ApprovalDetail = {
      ...pendingApproval,
      state: "approved",
      executionStatus: "failed",
      executionErrorCode: "APPROVAL_EXECUTION_FAILED",
      decision: {
        decision: "approve",
        scope: "once",
        decidedBy: "owner_primary",
        decidedAt: "2026-07-24T01:04:00.000Z",
      },
    };
    const api = approvalApi({
      listApprovals: vi.fn().mockResolvedValue([pendingApproval]),
      decideApproval: vi.fn().mockRejectedValue(new Error("private execution failure")),
      getApproval: vi.fn().mockResolvedValue(failedApproval),
    });

    render(<ApprovalSurface api={api} />);
    const inspector = await screen.findByRole("complementary", {
      name: "Approval details: configuration.apply",
    });
    await user.click(within(inspector).getByRole("button", { name: "Approve once" }));

    await waitFor(() => {
      expect(api.getApproval).toHaveBeenCalledWith(pendingApproval.approvalId);
    });
    expect(await within(inspector).findByText("Execution failed")).toBeTruthy();
    expect(
      within(inspector).getByText("Execution failed safely with code APPROVAL_EXECUTION_FAILED."),
    ).toBeTruthy();
    expect(within(inspector).queryByText("private execution failure")).toBeNull();
    expect(within(inspector).queryByRole("button", { name: "Approve once" })).toBeNull();
  });

  it("filters completed requests without treating an empty pending queue as an error", async () => {
    const user = userEvent.setup();
    const deniedApproval: ApprovalDetail = {
      ...pendingApproval,
      approvalId: "approval_denied_001",
      state: "denied",
      executionStatus: "skipped",
      decision: {
        decision: "deny",
        reason: "Not needed.",
        decidedBy: "owner_primary",
        decidedAt: "2026-07-24T01:04:00.000Z",
      },
    };
    const api = approvalApi({
      listApprovals: vi.fn().mockResolvedValue([deniedApproval]),
    });

    render(<ApprovalSurface api={api} />);

    expect(await screen.findByRole("heading", { name: "No pending approvals" })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Filter Approvals"), "all");
    expect(await screen.findByText("Enable Computer Use for this Device.")).toBeTruthy();
    expect(screen.getAllByText("Denied").length).toBeGreaterThan(0);
  });

  it("offers a safe retry without rendering server error details", async () => {
    const privateSentinel = "PRIVATE_APPROVAL_FAILURE";
    const listApprovals = vi
      .fn()
      .mockRejectedValueOnce(new Error(privateSentinel))
      .mockResolvedValueOnce([pendingApproval]);
    const api = approvalApi({ listApprovals });
    const user = userEvent.setup();

    render(<ApprovalSurface api={api} />);

    expect(await screen.findByText("Approvals could not be loaded.")).toBeTruthy();
    expect(screen.queryByText(privateSentinel)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Enable Computer Use for this Device.")).toBeTruthy();
  });
});

function approvalApi(
  overrides: Partial<Pick<AdminApi, "listApprovals" | "getApproval" | "decideApproval">> = {},
): Pick<AdminApi, "listApprovals" | "getApproval" | "decideApproval"> {
  return {
    listApprovals: vi.fn().mockResolvedValue([]),
    getApproval: vi.fn().mockResolvedValue(pendingApproval),
    decideApproval: vi.fn().mockResolvedValue(pendingApproval),
    ...overrides,
  };
}
