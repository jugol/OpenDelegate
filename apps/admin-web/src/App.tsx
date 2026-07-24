import { MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AdminApi } from "./admin-api";
import { ConfigurationChat } from "./ConfigurationChat";
import { AdminRail, type AdminSection, DeviceSurface } from "./DeviceSurface";
import { useAdminI18n } from "./i18n";
import { TaskSurface } from "./TaskSurface";
import { useMediaQuery } from "./use-media-query";
import type { DeviceOverviewViewModel } from "./view-model";

const compactChatQuery = "(max-width: 819px)";

export interface AppProps {
  readonly api?: AdminApi;
  readonly configurationAgentAvailable?: boolean;
  readonly device: DeviceOverviewViewModel;
  readonly discordConfigured?: boolean;
  readonly executionAvailable?: boolean;
  readonly initialChatOpen?: boolean;
  readonly initialSection?: AdminSection;
  readonly onConfigurationMessage?: (message: string) => Promise<string>;
  readonly releaseChannel?: "development" | "internal-preview" | "release-candidate" | "released";
}

export function App({
  api,
  configurationAgentAvailable = false,
  device,
  discordConfigured = false,
  executionAvailable = false,
  initialChatOpen = false,
  initialSection = "devices",
  onConfigurationMessage,
  releaseChannel = "development",
}: AppProps): React.JSX.Element {
  const { messages } = useAdminI18n();
  const [activeSection, setActiveSection] = useState<AdminSection>(initialSection);
  const [chatOpen, setChatOpen] = useState(initialChatOpen && initialSection === "devices");
  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatFocusRequestId, setChatFocusRequestId] = useState(0);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const lastChatTriggerRef = useRef<HTMLButtonElement | null>(null);
  const compactChat = useMediaQuery(compactChatQuery);
  const chatModal = chatOpen && (chatExpanded || compactChat);
  const configurationChatAvailable =
    configurationAgentAvailable && onConfigurationMessage !== undefined;

  useEffect(() => {
    if (chatOpen) {
      return;
    }

    const previousTrigger = lastChatTriggerRef.current;
    const focusTarget =
      previousTrigger !== null && previousTrigger.isConnected
        ? previousTrigger
        : launcherRef.current;
    focusTarget?.focus();
  }, [chatOpen]);

  function openChat(trigger: HTMLButtonElement): void {
    lastChatTriggerRef.current = trigger;
    setActiveSection("devices");
    setChatOpen(true);
    setChatFocusRequestId((current) => current + 1);
  }

  function closeChat(): void {
    setChatOpen(false);
    setChatExpanded(false);
  }

  function selectSection(section: AdminSection): void {
    setActiveSection(section);
    if (section === "tasks") {
      setChatOpen(false);
      setChatExpanded(false);
    }
  }

  return (
    <div className="app-shell">
      <div
        className="runtime-boundary-notice"
        hidden={releaseChannel === "released" && executionAvailable && configurationChatAvailable}
        role="status"
      >
        <strong>
          {releaseChannel === "internal-preview"
            ? messages.runtime.internalPreview
            : releaseChannel === "release-candidate"
              ? messages.runtime.releaseCandidate
              : releaseChannel === "development"
                ? messages.runtime.development
                : messages.runtime.incomplete}
        </strong>
        <span>
          {releaseChannel === "released"
            ? messages.runtime.releasedDetail
            : messages.runtime.prereleaseDetail}
        </span>
      </div>
      <div
        aria-hidden={chatModal ? true : undefined}
        className="app-frame"
        inert={chatModal ? true : undefined}
      >
        <AdminRail
          activeSection={activeSection}
          device={device}
          onSelectSection={selectSection}
          tasksEnabled={api !== undefined}
        />
        {activeSection === "tasks" && api !== undefined ? (
          <TaskSurface
            api={api}
            discordConfigured={discordConfigured}
            executionAvailable={executionAvailable}
          />
        ) : (
          <DeviceSurface chatOpen={chatOpen} device={device} onConfigure={openChat} />
        )}
      </div>

      {activeSection === "devices" ? (
        <ConfigurationChat
          expanded={chatExpanded}
          focusRequestId={chatFocusRequestId}
          key={device.deviceId}
          modal={chatModal}
          onClose={closeChat}
          {...(configurationAgentAvailable && onConfigurationMessage !== undefined
            ? { onSendMessage: onConfigurationMessage }
            : {})}
          onToggleExpanded={() => setChatExpanded((current) => !current)}
          open={chatOpen}
          session={device.configurationSession}
        />
      ) : null}

      {!chatOpen ? (
        <button
          aria-controls="configuration-chat"
          aria-expanded="false"
          aria-label={messages.chat.open}
          className={`chat-launcher ${activeSection === "tasks" ? "chat-launcher--tasks" : ""}`}
          onClick={(event) => openChat(event.currentTarget)}
          ref={launcherRef}
          type="button"
        >
          <MessageCircle aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
