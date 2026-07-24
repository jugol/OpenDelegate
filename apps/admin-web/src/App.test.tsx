import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { firstRunDevice } from "./view-model";

function renderApp() {
  const user = userEvent.setup();
  render(<App />);
  return user;
}

describe("first-run Device overview", () => {
  it("renders the sole selected Device and its operational profile", () => {
    renderApp();

    const selectedDevice = screen.getByRole("button", {
      name: "Mac Studio, Main, Online",
    });
    expect(selectedDevice.getAttribute("aria-current")).toBe("page");

    expect(screen.getByRole("heading", { level: 1, name: "Mac Studio" })).toBeTruthy();
    expect(screen.getByText("Main computer · macOS · Online")).toBeTruthy();
    expect(screen.getByText("Apple silicon")).toBeTruthy();
    expect(screen.getByText("Healthy · Priority 1")).toBeTruthy();
    expect(screen.getByText("Not configured · Priority 2")).toBeTruthy();

    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
  });

  it("supports automatic keyboard navigation across Device tabs", () => {
    renderApp();

    const overview = screen.getByRole("tab", { name: "Overview" });
    const capabilities = screen.getByRole("tab", { name: "Capabilities" });
    const runs = screen.getByRole("tab", { name: "Runs" });

    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(document.activeElement).toBe(capabilities);
    expect(capabilities.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(capabilities, { key: "End" });
    expect(document.activeElement).toBe(runs);
    expect(runs.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(runs, { key: "Home" });
    expect(document.activeElement).toBe(overview);
    expect(overview.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(overview, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(runs);
    expect(runs.getAttribute("aria-selected")).toBe("true");
  });

  it("uses Configure and the launcher to control a separate Configuration Chat", async () => {
    const user = renderApp();

    expect(screen.getByRole("dialog", { name: "Configuration Chat" })).toBeTruthy();
    expect(screen.getByText("Separate setup session")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message Configuration Chat" });
    await user.type(composer, "Preserve this draft");
    await user.click(screen.getByRole("button", { name: "Collapse Configuration Chat" }));
    expect(screen.queryByRole("dialog", { name: "Configuration Chat" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(
      (screen.getByRole("textbox", { name: "Message Configuration Chat" }) as HTMLInputElement)
        .value,
    ).toBe("Preserve this draft");

    await user.click(screen.getByRole("button", { name: "Collapse Configuration Chat" }));
    const launcher = screen.getByRole("button", { name: "Toggle Configuration Chat" });
    await user.click(launcher);
    expect(screen.getByRole("dialog", { name: "Configuration Chat" })).toBeTruthy();
    await user.click(launcher);
    expect(screen.queryByRole("dialog", { name: "Configuration Chat" })).toBeNull();
  });

  it("shows the exact Role and Capability diff when the proposal is reviewed", async () => {
    const user = renderApp();

    expect(firstRunDevice.roles).not.toContain("Computer Use");
    expect(
      firstRunDevice.capabilities.find((capability) => capability.capabilityId === "computer-use")
        ?.state,
    ).toBe("Detected");

    await user.click(screen.getByRole("button", { name: "Review change" }));

    const proposal = screen.getByRole("region", { name: "Proposed change" });
    expect(within(proposal).getByTestId("role-diff").textContent).toBe("+Computer Use");
    expect(within(proposal).getByTestId("capability-diff").textContent).toBe(
      "computer-useDetected→Verified",
    );
  });

  it("dismisses the proposal without closing Configuration Chat", async () => {
    const user = renderApp();

    await user.click(screen.getByRole("button", { name: "Not now" }));

    expect(screen.queryByRole("region", { name: "Proposed change" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Configuration Chat" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message Configuration Chat" })).toBeTruthy();
  });

  it("appends an owner message and deterministic local acknowledgement", async () => {
    const user = renderApp();
    const chat = screen.getByRole("dialog", { name: "Configuration Chat" });
    const composer = within(chat).getByRole("textbox", {
      name: "Message Configuration Chat",
    });

    await user.type(composer, "Keep Tailscale as fallback.");
    await user.click(within(chat).getByRole("button", { name: "Send message" }));

    expect(within(chat).getByText("Keep Tailscale as fallback.")).toBeTruthy();
    expect(
      within(chat).getByText(
        "I'll keep this request in the separate setup session for Mac Studio.",
      ),
    ).toBeTruthy();
    expect((composer as HTMLInputElement).value).toBe("");
  });

  it("exposes only aggregate local Knowledge health", () => {
    renderApp();

    const knowledge = screen.getByRole("region", { name: "Knowledge health" });
    expect(knowledge.textContent).toBe("Knowledge healthLocal KnowledgeReady");
    expect(knowledge.textContent).not.toMatch(/\d+\s+notes?/i);
    expect(knowledge.querySelectorAll("a")).toHaveLength(0);
  });

  it("expands and restores Configuration Chat without losing its draft", async () => {
    const user = renderApp();
    const composer = screen.getByRole("textbox", { name: "Message Configuration Chat" });

    await user.type(composer, "Keep this expanded draft");
    await user.click(screen.getByRole("button", { name: "Expand Configuration Chat" }));

    const expanded = screen.getByRole("dialog", { name: "Configuration Chat" });
    expect(expanded.classList.contains("configuration-chat--expanded")).toBe(true);
    expect(screen.getByRole("button", { name: "Restore Configuration Chat" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Restore Configuration Chat" }));
    expect(expanded.classList.contains("configuration-chat--expanded")).toBe(false);
    expect((composer as HTMLInputElement).value).toBe("Keep this expanded draft");
  });
});
