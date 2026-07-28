import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import {
  firstRunDevice,
  presentationTextFallback,
  type DeviceOverviewViewModel,
} from "./view-model";

function renderApp(device: DeviceOverviewViewModel = firstRunDevice) {
  const user = userEvent.setup();
  render(
    <App
      configurationAgentAvailable
      deviceFleet={
        device.role === "main"
          ? { devices: [device], mainDeviceId: device.deviceId }
          : {
              devices: [firstRunDevice, device],
              mainDeviceId: firstRunDevice.deviceId,
            }
      }
      executionAvailable
      initialChatOpen
      onConfigurationMessage={async (deviceId, message) => ({
        content: `Fixture response for ${deviceId}: ${message}`,
        suggestedActions: [],
      })}
    />,
  );
  if (device.role === "worker") {
    fireEvent.click(
      screen.getByRole("button", {
        name: `${device.name}, ${presentationTextFallback(device.roleLabel)}, ${presentationTextFallback(device.connection.label)}`,
      }),
    );
  }
  return user;
}

function installMatchMedia(initialMatches: boolean): {
  readonly restore: () => void;
  readonly setMatches: (matches: boolean) => void;
} {
  const original = window.matchMedia;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = initialMatches;
  const media = "(max-width: 819px)";

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      dispatchEvent: () => true,
      get matches() {
        return matches;
      },
      media,
      onchange: null,
      removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
    }),
    writable: true,
  });

  return {
    restore: () => {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: original,
        writable: true,
      });
    },
    setMatches: (nextMatches: boolean) => {
      matches = nextMatches;
      const event = { matches, media } as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

const windowsWorker = {
  deviceId: "device-windows-build-rig",
  name: "Build Rig",
  osFamily: "windows",
  role: "worker",
  roleLabel: "Worker",
  deviceTypeLabel: "Worker computer",
  operatingSystem: "Windows 11",
  connection: {
    label: "Offline",
    tone: "muted",
  },
  facts: [
    { label: "Operating system", value: "Windows 11" },
    { label: "Architecture", value: "x86-64" },
  ],
  runtimeStatuses: [
    { label: "Worker service", value: "Unavailable", tone: "muted" },
    { label: "User session", value: "Signed out", tone: "muted" },
  ],
  roles: ["Build automation"],
  instructions: ["Use the registered build workspace only."],
  policies: [],
  agentAdapters: [],
  capabilities: [
    {
      capabilityId: "claude-code",
      label: "Claude",
      state: "verified",
      tone: "success",
    },
  ],
  routes: [
    {
      order: 1,
      label: "Omada VPN",
      summary: "Unavailable · Priority 1",
      tone: "muted",
    },
  ],
  resourceLocks: [],
  currentRuns: [],
  currentWork: {
    activeRunCount: 0,
    summary: "No active runs",
  },
  knowledge: {
    label: "Local Knowledge",
    status: "Unavailable",
    tone: "muted",
  },
  configurationSession: {
    assistantMessage: "This Device is offline. Reconnect it to continue setup.",
    proposal: null,
  },
} satisfies DeviceOverviewViewModel;

describe("first-run Device overview", () => {
  it("renders the sole selected Device and separates observed facts from runtime status", () => {
    renderApp();

    const selectedDevice = screen.getByLabelText("Mac Studio, Main, Online");
    expect(selectedDevice.getAttribute("aria-current")).toBe("page");

    expect(screen.getByRole("heading", { level: 1, name: "Mac Studio" })).toBeTruthy();
    expect(screen.getByLabelText("Main computer · macOS · Online")).toBeTruthy();
    expect(screen.getByText("Apple silicon")).toBeTruthy();
    expect(screen.getByText("Healthy · Priority 1")).toBeTruthy();
    expect(screen.getByText("Not configured · Priority 2")).toBeTruthy();

    const facts = screen.getByRole("region", { name: "Device facts" });
    expect(facts.textContent).toBe("Device factsOperating systemmacOSArchitectureApple silicon");
    expect(within(facts).queryByText("Worker service")).toBeNull();

    const runtime = screen.getByRole("region", { name: "Runtime status" });
    expect(within(runtime).getByText("Worker service")).toBeTruthy();
    expect(within(runtime).getByText("User session")).toBeTruthy();

    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");

    const chat = screen.getByRole("dialog", { name: "Configuration Chat" });
    expect(
      within(chat).getByText(
        "Configure this Device and OpenDelegate services here. Task conversations stay separate.",
      ),
    ).toBeTruthy();
    expect(
      within(chat).getByText(
        "Codex and this desktop session are ready. I can verify Computer Use and propose it as a role for this Device.",
      ),
    ).toBeTruthy();
    expect(within(chat).getByText("Add role")).toBeTruthy();
    expect(within(chat).queryByText("Propose role")).toBeNull();
  });

  it("renders a supplied cross-platform Device without leaking first-run Mac state", () => {
    renderApp(windowsWorker);

    expect(screen.getByRole("heading", { level: 1, name: "Build Rig" })).toBeTruthy();
    expect(screen.getByLabelText("Worker computer · Windows 11 · Offline")).toBeTruthy();
    expect(screen.getByText("x86-64")).toBeTruthy();
    expect(screen.getByText("Build automation")).toBeTruthy();
    expect(screen.getByText("Omada VPN")).toBeTruthy();
    expect(screen.queryByText("macOS")).toBeNull();
    expect(screen.queryByText("Main Coordinator")).toBeNull();
  });

  it("never invents a ready setup proposal for an offline signed-out Device", () => {
    renderApp(windowsWorker);

    const chat = screen.getByRole("dialog", { name: "Configuration Chat" });
    expect(
      within(chat).getByText("This Device is offline. Reconnect it to continue setup."),
    ).toBeTruthy();
    expect(within(chat).queryByText(/Codex.*ready/i)).toBeNull();
    expect(within(chat).queryByText(/desktop session (?:is|are) ready/i)).toBeNull();
    expect(within(chat).queryByRole("region", { name: "Proposed change" })).toBeNull();
    expect(within(chat).queryByRole("button", { name: "Review change" })).toBeNull();
    expect(within(chat).queryByText("Computer Use")).toBeNull();
  });

  it("uses canonical capability identifiers in the first-run view model", () => {
    expect(firstRunDevice.capabilities.map(({ capabilityId }) => capabilityId)).toEqual([
      "codex",
      "claude-code",
      "computer-use",
      "browser-automation",
    ]);
  });

  it("keeps unfinished navigation honest while Device detail tabs are keyboard-operable", () => {
    renderApp();

    for (const label of ["Tasks", "Approvals", "Artifacts", "Audit", "Add Device"]) {
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    }

    for (const label of [
      "Capabilities",
      "Roles & Instructions",
      "Routes",
      "Authority & resources",
      "Runs",
    ]) {
      const tab = screen.getByRole("tab", { name: label });
      expect((tab as HTMLButtonElement).disabled).toBe(false);
      expect(tab.getAttribute("aria-disabled")).toBeNull();
    }

    const overview = screen.getByRole("tab", { name: "Overview" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    const capabilities = screen.getByRole("tab", { name: "Capabilities" });
    expect(document.activeElement).toBe(capabilities);
    expect(capabilities.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("id")).toBe("device-panel-capabilities");

    fireEvent.keyDown(capabilities, { key: "End" });
    const runs = screen.getByRole("tab", { name: "Runs" });
    expect(document.activeElement).toBe(runs);
    expect(runs.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Roles & Instructions" }));
    expect(screen.getByRole("heading", { name: "Instructions" })).toBeTruthy();
  });

  it("shows evidence-backed Facts, executable Policy, adapters, locks, load, and exact Runs", async () => {
    const user = renderApp({
      ...firstRunDevice,
      facts: [
        {
          label: "Hostname",
          value: "main-studio",
          evidence: {
            source: "Authenticated heartbeat",
            observedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
            verification: "verified",
          },
        },
      ],
      policies: [
        {
          policyId: "policy-network",
          actionCategory: "os-network-change",
          decision: "require-approval",
          source: "configuration",
          effectiveScope: "device",
        },
      ],
      agentAdapters: [
        {
          provider: "codex",
          adapterId: "codex-app-server",
          version: "0.145.0",
          readiness: "ready",
          compatibility: "tested",
          observedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
        },
      ],
      resourceLocks: [
        {
          resourceName: "desktop-session",
          capacity: 1,
          holders: [
            {
              taskId: "task-1",
              runId: "run-1",
              expiresAtMs: Date.parse("2026-07-25T00:05:00.000Z"),
            },
          ],
        },
      ],
      currentRuns: [
        {
          taskId: "task-1",
          workOrderId: "work-order-1",
          runId: "run-1",
          state: "running",
          acceptedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
          leaseExpiresAtMs: Date.parse("2026-07-25T00:05:00.000Z"),
        },
      ],
      currentWork: {
        activeRunCount: 1,
        summary: "1 active Run",
        maximumConcurrentRuns: 4,
        acceptingWork: true,
        outboxDepth: 2,
        maxOutboxEntries: 10_000,
      },
    });

    expect(screen.getByText(/Verified · Authenticated heartbeat/)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Authority & resources" }));
    expect(screen.getByText("Operating system network change")).toBeTruthy();
    expect(screen.getByText("Configured · Device")).toBeTruthy();
    expect(screen.getByText("Owner approval required")).toBeTruthy();
    expect(screen.getByText("codex-app-server · 0.145.0")).toBeTruthy();
    expect(screen.getByText("Ready · Tested")).toBeTruthy();
    expect(screen.getByText("desktop-session")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Runs" }));
    expect(screen.getByText("Run run-1")).toBeTruthy();
    expect(screen.getByText("Task task-1 · Work Order work-order-1")).toBeTruthy();
    expect(screen.getByText(/^Running · lease until/u)).toBeTruthy();
    expect(screen.getByText("1 of 4 Run slots active")).toBeTruthy();
    expect(screen.getByText("2 of 10000 buffered events")).toBeTruthy();
  });

  it("opens and closes Configuration Chat with an explicit accessible focus lifecycle", async () => {
    const user = renderApp();

    const chat = screen.getByRole("dialog", { name: "Configuration Chat" });
    expect(chat.getAttribute("id")).toBe("configuration-chat");
    expect(screen.queryByRole("button", { name: "Open Configuration Chat" })).toBeNull();

    const composer = within(chat).getByRole("textbox", {
      name: "Message Configuration Chat",
    });
    await user.type(composer, "Preserve this draft");
    await user.click(within(chat).getByRole("button", { name: "Close Configuration Chat" }));

    const launcher = screen.getByRole("button", { name: "Open Configuration Chat" });
    expect(document.activeElement).toBe(launcher);
    expect(launcher.getAttribute("aria-controls")).toBe("configuration-chat");
    expect(launcher.getAttribute("aria-expanded")).toBe("false");

    await user.click(launcher);
    expect(screen.getByRole("textbox", { name: "Message Configuration Chat" })).toBe(
      document.activeElement,
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Configuration Chat",
        }) as HTMLInputElement
      ).value,
    ).toBe("Preserve this draft");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Configuration Chat" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open Configuration Chat" }),
    );
  });

  it("preserves the current focus when Configuration Chat starts closed", () => {
    const priorFocus = document.createElement("button");
    priorFocus.type = "button";
    document.body.append(priorFocus);
    priorFocus.focus();

    try {
      render(
        <App
          configurationAgentAvailable
          deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
          executionAvailable
          onConfigurationMessage={async (deviceId, message) => ({
            content: `Fixture response for ${deviceId}: ${message}`,
            suggestedActions: [],
          })}
        />,
      );

      expect(document.activeElement).toBe(priorFocus);
    } finally {
      priorFocus.remove();
    }
  });

  it("moves focus into an already-open Configuration Chat from Configure", async () => {
    const user = renderApp();
    const configure = screen.getByRole("button", { name: "Configure" });

    expect(configure.getAttribute("aria-controls")).toBe("configuration-chat");
    expect(configure.getAttribute("aria-expanded")).toBe("true");

    await user.click(configure);

    expect(screen.getByRole("textbox", { name: "Message Configuration Chat" })).toBe(
      document.activeElement,
    );
  });

  it("updates ordinary chat modal mechanics when the viewport crosses the mobile boundary", async () => {
    const media = installMatchMedia(false);

    try {
      const user = renderApp();
      const chat = screen.getByRole("dialog", { name: "Configuration Chat" });
      const appFrame = document.querySelector(".app-frame");
      expect(chat.getAttribute("aria-modal")).toBe("false");
      expect(appFrame?.hasAttribute("inert")).toBe(false);

      act(() => media.setMatches(true));
      await waitFor(() => expect(chat.getAttribute("aria-modal")).toBe("true"));
      expect(appFrame?.hasAttribute("inert")).toBe(true);
      expect(appFrame?.getAttribute("aria-hidden")).toBe("true");
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Message Configuration Chat" }),
      );

      const expand = screen.getByRole("button", { name: "Expand Configuration Chat" });
      expand.focus();
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Message Configuration Chat" }),
      );
      await user.keyboard("{Tab}");
      expect(document.activeElement).toBe(expand);

      act(() => media.setMatches(false));
      await waitFor(() => expect(chat.getAttribute("aria-modal")).toBe("false"));
      expect(appFrame?.hasAttribute("inert")).toBe(false);
    } finally {
      media.restore();
    }
  });

  it("shows the exact Role and Capability diff when the proposal is reviewed", async () => {
    const user = renderApp();

    expect(firstRunDevice.roles.map(presentationTextFallback)).not.toContain("Computer Use");
    expect(
      firstRunDevice.capabilities.find((capability) => capability.capabilityId === "computer-use")
        ?.state,
    ).toBe("detected");

    await user.click(screen.getByRole("button", { name: "Review change" }));

    const proposal = screen.getByRole("region", { name: "Proposed change" });
    expect(within(proposal).getByTestId("role-diff").textContent).toBe("+Computer Use");
    expect(
      within(proposal).getByText("Change from Detected to Verified", {
        selector: ".sr-only",
      }),
    ).toBeTruthy();
    expect(
      within(proposal).getByTestId("capability-diff").querySelector("[aria-hidden='true']")
        ?.textContent,
    ).toBe("Detected→Verified");
    expect(
      (screen.getByRole("button", { name: "Change reviewed" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("dismisses the proposal without closing Configuration Chat", async () => {
    const user = renderApp();

    await user.click(screen.getByRole("button", { name: "Not now" }));

    expect(screen.queryByRole("region", { name: "Proposed change" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Configuration Chat" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message Configuration Chat" })).toBeTruthy();
  });

  it("keeps multiple messages in a labelled log and preserves the composer", async () => {
    const user = renderApp();
    const chat = screen.getByRole("dialog", { name: "Configuration Chat" });
    const composer = within(chat).getByRole("textbox", {
      name: "Message Configuration Chat",
    });

    await user.type(composer, "Keep Tailscale as fallback.");
    await user.click(within(chat).getByRole("button", { name: "Send message" }));
    await user.type(composer, "Do not change firewall settings.");
    await user.click(within(chat).getByRole("button", { name: "Send message" }));

    const log = within(chat).getByRole("log", { name: "Configuration conversation" });
    expect(within(log).getByText("Keep Tailscale as fallback.")).toBeTruthy();
    expect(within(log).getByText("Do not change firewall settings.")).toBeTruthy();
    expect(within(log).getAllByRole("article", { name: "You" })).toHaveLength(2);
    expect(within(log).getAllByRole("article", { name: "OpenDelegate" })).toHaveLength(3);
    expect((composer as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(composer);
  });

  it("restores the durable Device conversation when Configuration Chat mounts", async () => {
    render(
      <App
        configurationAgentAvailable
        deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
        executionAvailable
        initialChatOpen
        onConfigurationMessage={async () => ({
          content: "Current reply.",
          suggestedActions: [],
        })}
        onLoadConfigurationMessages={async () => [
          {
            messageId: "owner-history",
            role: "owner",
            content: "Keep this across restart.",
            suggestedActions: [],
            occurredAt: "2026-07-24T01:00:00.000Z",
          },
          {
            messageId: "agent-history",
            role: "agent",
            content: "This conversation is durable.",
            suggestedActions: [],
            occurredAt: "2026-07-24T01:00:01.000Z",
          },
        ]}
      />,
    );

    expect(await screen.findByText("Keep this across restart.")).toBeTruthy();
    expect(screen.getByText("This conversation is durable.")).toBeTruthy();
    expect(screen.queryByText(firstRunDevice.configurationSession.assistantMessage)).toBeNull();
  });

  it("keeps an accepted message visible and reconciles its response after reload", async () => {
    let historyReads = 0;
    render(
      <App
        configurationAgentAvailable
        deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
        executionAvailable
        initialChatOpen
        onConfigurationMessage={async () => ({
          content: "Unused direct response.",
          suggestedActions: [],
        })}
        onLoadConfigurationMessages={async () => {
          historyReads += 1;
          return (
            historyReads === 1
              ? [
                  {
                    messageId: "owner-pending",
                    role: "owner",
                    content: "Keep this visible during reload.",
                    suggestedActions: [],
                    occurredAt: "2026-07-24T01:00:00.000Z",
                    responseStatus: "pending",
                  },
                ]
              : [
                  {
                    messageId: "owner-pending",
                    role: "owner",
                    content: "Keep this visible during reload.",
                    suggestedActions: [],
                    occurredAt: "2026-07-24T01:00:00.000Z",
                    responseStatus: "completed",
                  },
                  {
                    messageId: "agent-completed",
                    role: "agent",
                    content: "The restored response completed.",
                    suggestedActions: [],
                    occurredAt: "2026-07-24T01:00:01.000Z",
                  },
                ]
          ) as never;
        }}
      />,
    );

    expect(await screen.findByText("Keep this visible during reload.")).toBeTruthy();
    expect(
      screen.getByRole("article", {
        name: "Waiting for Configuration Agent…",
      }),
    ).toBeTruthy();
    expect(
      await screen.findByText("The restored response completed.", {}, { timeout: 3_000 }),
    ).toBeTruthy();
    expect(historyReads).toBeGreaterThanOrEqual(2);
  });

  it("restores durable history while native Configuration Agent messaging is unavailable", async () => {
    render(
      <App
        deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
        initialChatOpen
        onLoadConfigurationMessages={async () => [
          {
            messageId: "agent-degraded-history",
            role: "agent",
            content: "Stored before the provider became unavailable.",
            suggestedActions: [],
            occurredAt: "2026-07-24T01:00:01.000Z",
          },
        ]}
      />,
    );

    expect(await screen.findByText("Stored before the provider became unavailable.")).toBeTruthy();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Configuration Chat",
        }) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true);
  });

  it("hydrates history before automatic Discord onboarding can append or send", async () => {
    const hydrationDevice = {
      ...firstRunDevice,
      deviceId: "device_main_hydration",
      name: "Hydration Main",
    };
    let resolveHistory!: (
      value: readonly {
        readonly messageId: string;
        readonly role: "owner" | "agent";
        readonly content: string;
        readonly suggestedActions: readonly [];
        readonly occurredAt: string;
      }[],
    ) => void;
    const history = new Promise<
      readonly {
        readonly messageId: string;
        readonly role: "owner" | "agent";
        readonly content: string;
        readonly suggestedActions: readonly [];
        readonly occurredAt: string;
      }[]
    >((resolve) => {
      resolveHistory = resolve;
    });
    const sent: string[] = [];

    render(
      <App
        configurationAgentAvailable
        deviceFleet={{ devices: [hydrationDevice], mainDeviceId: hydrationDevice.deviceId }}
        discordSetupRecommended
        initialChatOpen
        onConfigurationMessage={async (_deviceId, message) => {
          sent.push(message);
          return { content: "Discord setup guidance.", suggestedActions: [] };
        }}
        onLoadConfigurationMessages={() => history}
      />,
    );

    expect(sent).toEqual([]);
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Configuration Chat",
        }) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      resolveHistory([
        {
          messageId: "owner-before-onboarding",
          role: "owner",
          content: "Preserve this older setup context.",
          suggestedActions: [],
          occurredAt: "2026-07-24T01:00:00.000Z",
        },
      ]);
      await history;
    });

    expect(await screen.findByText("Preserve this older setup context.")).toBeTruthy();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.getByText("Discord setup guidance.")).toBeTruthy();
  });

  it("inserts a newline with Shift+Enter and sends multiline text with Enter", async () => {
    const sentMessages: { readonly deviceId: string; readonly message: string }[] = [];
    const onConfigurationMessage = async (deviceId: string, message: string) => {
      sentMessages.push({ deviceId, message });
      return { content: "Understood.", suggestedActions: [] as const };
    };
    const user = userEvent.setup();
    render(
      <App
        configurationAgentAvailable
        deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
        executionAvailable
        initialChatOpen
        onConfigurationMessage={onConfigurationMessage}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Message Configuration Chat" });

    await user.type(composer, "First line");
    await user.keyboard("{Shift>}{Enter}{/Shift}Second line");

    expect(sentMessages).toEqual([]);
    expect((composer as HTMLTextAreaElement).value).toBe("First line\nSecond line");

    await user.keyboard("{Enter}");

    expect(sentMessages).toEqual([
      { deviceId: firstRunDevice.deviceId, message: "First line\nSecond line" },
    ]);
  });

  it("shows an in-conversation Agent activity message while a response is pending", async () => {
    let resolveResponse!: (value: {
      readonly content: string;
      readonly suggestedActions: readonly [];
    }) => void;
    const response = new Promise<{
      readonly content: string;
      readonly suggestedActions: readonly [];
    }>((resolve) => {
      resolveResponse = resolve;
    });
    const user = userEvent.setup();
    render(
      <App
        configurationAgentAvailable
        deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
        executionAvailable
        initialChatOpen
        onConfigurationMessage={() => response}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Message Configuration Chat" }),
      "Inspect the current Discord binding.",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    const conversation = screen.getByRole("log", { name: "Configuration conversation" });
    expect(
      within(conversation).getByRole("article", {
        name: "Waiting for Configuration Agent…",
      }),
    ).toBeTruthy();

    await act(() => {
      resolveResponse({
        content: "The binding inspection is complete.",
        suggestedActions: [],
      });
    });

    expect(await screen.findByText("The binding inspection is complete.")).toBeTruthy();
    expect(
      within(conversation).queryByRole("article", {
        name: "Waiting for Configuration Agent…",
      }),
    ).toBeNull();
  });

  it("renders Agent paragraphs and numbered steps as readable message structure", async () => {
    const user = userEvent.setup();
    render(
      <App
        configurationAgentAvailable
        deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
        executionAvailable
        initialChatOpen
        onConfigurationMessage={async () => ({
          content:
            "Discord is not connected.\n\nComplete these steps:\n1. Create a bot.\n2. Enable Community.\n\nDo not paste the bot token into chat.",
          suggestedActions: [],
        })}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Message Configuration Chat" }),
      "Help me configure Discord.",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    const agentMessages = screen.getAllByRole("article", { name: "OpenDelegate" });
    const response = agentMessages.at(-1)!;
    expect(within(response).getAllByRole("paragraph")).toHaveLength(3);
    expect(
      within(response)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Create a bot.", "Enable Community."]);
  });

  it("announces an unread Agent response when Configuration Chat is closed", async () => {
    let resolveResponse!: (value: {
      readonly content: string;
      readonly suggestedActions: readonly [];
    }) => void;
    const response = new Promise<{
      readonly content: string;
      readonly suggestedActions: readonly [];
    }>((resolve) => {
      resolveResponse = resolve;
    });
    const user = userEvent.setup();
    render(
      <App
        configurationAgentAvailable
        deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
        executionAvailable
        initialChatOpen
        onConfigurationMessage={() => response}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Message Configuration Chat" }),
      "Inspect Discord.",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.click(screen.getByRole("button", { name: "Close Configuration Chat" }));

    await act(() => {
      resolveResponse({
        content: "Discord guidance is ready.",
        suggestedActions: [],
      });
    });

    const notification = await screen.findByRole("status", {
      name: "Configuration Chat notifications",
    });
    expect(notification.textContent).toBe("New Configuration Chat response. 1 unread.");
    const launcher = screen.getByRole("button", {
      name: "Open Configuration Chat — new response available",
    });
    expect(within(launcher).getByText("1")).toBeTruthy();

    await user.click(launcher);
    expect(notification.textContent).toBe("");
    expect(await screen.findByText("Discord guidance is ready.")).toBeTruthy();
  });

  it("exposes only aggregate local Knowledge health", () => {
    renderApp();

    const knowledge = screen.getByRole("region", { name: "Knowledge health" });
    expect(knowledge.textContent).toBe("Knowledge healthLocal KnowledgeReady");
    expect(knowledge.textContent).not.toMatch(/\d+\s+notes?/i);
    expect(knowledge.querySelectorAll("a")).toHaveLength(0);
  });

  it("expands and restores Configuration Chat without exposing its launcher", async () => {
    const user = renderApp();
    const composer = screen.getByRole("textbox", { name: "Message Configuration Chat" });

    await user.type(composer, "Keep this expanded draft");
    await user.click(screen.getByRole("button", { name: "Expand Configuration Chat" }));

    const expanded = screen.getByRole("dialog", { name: "Configuration Chat" });
    expect(expanded.classList.contains("configuration-chat--expanded")).toBe(true);
    expect(expanded.getAttribute("aria-modal")).toBe("true");
    const appFrame = document.querySelector(".app-frame");
    expect(appFrame?.hasAttribute("inert")).toBe(true);
    expect(appFrame?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "Restore Configuration Chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Configuration Chat" })).toBeNull();

    const restore = screen.getByRole("button", { name: "Restore Configuration Chat" });
    restore.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send message" }));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(restore);

    await user.click(restore);
    expect(expanded.classList.contains("configuration-chat--expanded")).toBe(false);
    expect(expanded.getAttribute("aria-modal")).toBe("false");
    expect(appFrame?.hasAttribute("inert")).toBe(false);
    expect((composer as HTMLInputElement).value).toBe("Keep this expanded draft");
  });
});
