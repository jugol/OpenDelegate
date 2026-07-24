import { MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ConfigurationChat } from "./ConfigurationChat";
import { DeviceSurface } from "./DeviceSurface";
import { useMediaQuery } from "./use-media-query";
import { firstRunDevice, type DeviceOverviewViewModel } from "./view-model";

const compactChatQuery = "(max-width: 819px)";

export interface AppProps {
  readonly device?: DeviceOverviewViewModel;
}

export function App({ device = firstRunDevice }: AppProps): React.JSX.Element {
  const [chatOpen, setChatOpen] = useState(true);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatFocusRequestId, setChatFocusRequestId] = useState(0);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const lastChatTriggerRef = useRef<HTMLButtonElement | null>(null);
  const compactChat = useMediaQuery(compactChatQuery);
  const chatModal = chatOpen && (chatExpanded || compactChat);

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
    setChatOpen(true);
    setChatFocusRequestId((current) => current + 1);
  }

  function closeChat(): void {
    setChatOpen(false);
    setChatExpanded(false);
  }

  return (
    <div className="app-shell">
      <div
        aria-hidden={chatModal ? true : undefined}
        className="app-frame"
        inert={chatModal ? true : undefined}
      >
        <DeviceSurface chatOpen={chatOpen} device={device} onConfigure={openChat} />
      </div>

      <ConfigurationChat
        deviceName={device.name}
        expanded={chatExpanded}
        focusRequestId={chatFocusRequestId}
        key={device.deviceId}
        modal={chatModal}
        onClose={closeChat}
        onToggleExpanded={() => setChatExpanded((current) => !current)}
        open={chatOpen}
        session={device.configurationSession}
      />

      {!chatOpen ? (
        <button
          aria-controls="configuration-chat"
          aria-expanded="false"
          aria-label="Open Configuration Chat"
          className="chat-launcher"
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
