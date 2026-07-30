import { MessageCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AdminApi,
  ConfigurationAgentConversationMessage,
  ConfigurationAgentReply,
  RuntimeReleaseIdentity,
  SecureSecretIngestPurpose,
  SecureSecretIngestReceipt,
} from "./admin-api";
import { ArtifactSurface } from "./ArtifactSurface";
import { ApprovalSurface } from "./ApprovalSurface";
import { AuditSurface } from "./AuditSurface";
import { ConfigurationChat } from "./ConfigurationChat";
import { AdminRail, type AdminSection, DeviceSurface } from "./DeviceSurface";
import { formatMessage, useAdminI18n } from "./i18n";
import { JoinSurface } from "./JoinSurface";
import { TaskSurface } from "./TaskSurface";
import { useMediaQuery } from "./use-media-query";
import type { DeviceFleetViewModel, DeviceOverviewViewModel } from "./view-model";

const compactChatQuery = "(max-width: 819px)";

export interface AppProps {
  readonly api?: AdminApi;
  readonly configurationAgentAvailable?: boolean;
  readonly deviceFleet: DeviceFleetViewModel;
  readonly discordConfigured?: boolean;
  readonly discordSetupRecommended?: boolean;
  readonly executionAvailable?: boolean;
  readonly initialArtifactId?: string;
  readonly initialChatOpen?: boolean;
  readonly initialSection?: AdminSection;
  readonly onApprovalDecided?: () => void;
  readonly onAssessDevice?: (deviceId: string) => Promise<void>;
  readonly onConfigurationMessage?: (
    deviceId: string,
    message: string,
  ) => Promise<ConfigurationAgentReply>;
  readonly onLoadConfigurationMessages?: (
    deviceId: string,
  ) => Promise<readonly ConfigurationAgentConversationMessage[]>;
  readonly onSecureSecretIngest?: (
    purpose: SecureSecretIngestPurpose,
    secret: Uint8Array,
  ) => Promise<SecureSecretIngestReceipt>;
  readonly releaseIdentity?: RuntimeReleaseIdentity;
}

export function App({
  api,
  configurationAgentAvailable = false,
  deviceFleet,
  discordConfigured = false,
  discordSetupRecommended = false,
  executionAvailable = false,
  initialArtifactId,
  initialChatOpen = false,
  initialSection = "devices",
  onApprovalDecided,
  onAssessDevice,
  onConfigurationMessage,
  onLoadConfigurationMessages,
  onSecureSecretIngest,
  releaseIdentity = {
    declaredReleaseChannel: "development",
    releaseChannel: "development",
    releaseVerification: { status: "not-applicable" },
  },
}: AppProps): React.JSX.Element {
  const { messages } = useAdminI18n();
  const [activeSection, setActiveSection] = useState<AdminSection>(initialSection);
  const [selectedDeviceId, setSelectedDeviceId] = useState(deviceFleet.mainDeviceId);
  const [chatOpen, setChatOpen] = useState(initialChatOpen && initialSection === "devices");
  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatFocusRequestId, setChatFocusRequestId] = useState(0);
  const [unreadChatMessages, setUnreadChatMessages] = useState(0);
  const [focusedApprovalId, setFocusedApprovalId] = useState<string>();
  const [chatDraftRequest, setChatDraftRequest] = useState<{
    readonly deviceId: string;
    readonly requestId: number;
    readonly message: string;
  }>();
  const chatWasOpenRef = useRef(chatOpen);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const lastChatTriggerRef = useRef<HTMLButtonElement | null>(null);
  const compactChat = useMediaQuery(compactChatQuery);
  const chatModal = chatOpen && (chatExpanded || compactChat);
  const configurationChatAvailable =
    configurationAgentAvailable && onConfigurationMessage !== undefined;
  const { releaseChannel, releaseVerification } = releaseIdentity;
  const releaseDetail =
    releaseVerification.status === "released"
      ? messages.runtime.releasedDetail
      : releaseVerification.status === "absent"
        ? messages.runtime.verificationAbsentDetail
        : releaseVerification.status === "publisher-verified"
          ? messages.runtime.publisherVerifiedDetail
          : releaseVerification.status === "promotion-invalid"
            ? messages.runtime.promotionInvalidDetail
            : releaseVerification.status === "revoked"
              ? messages.runtime.revokedDetail
              : releaseVerification.status === "invalid"
                ? messages.runtime.verificationInvalidDetail
                : messages.runtime.prereleaseDetail;
  const mainDevice = resolveMainDevice(deviceFleet);
  const device =
    deviceFleet.devices.find((candidate) => candidate.deviceId === selectedDeviceId) ?? mainDevice;
  const loadSelectedDeviceConfigurationMessages = useCallback(
    () => onLoadConfigurationMessages?.(device.deviceId) ?? Promise.resolve([]),
    [device.deviceId, onLoadConfigurationMessages],
  );

  useEffect(() => {
    if (!deviceFleet.devices.some((candidate) => candidate.deviceId === selectedDeviceId)) {
      setSelectedDeviceId(deviceFleet.mainDeviceId);
    }
  }, [deviceFleet, selectedDeviceId]);

  useEffect(() => {
    const chatWasOpen = chatWasOpenRef.current;
    chatWasOpenRef.current = chatOpen;
    if (chatOpen || !chatWasOpen) {
      return;
    }

    const previousTrigger = lastChatTriggerRef.current;
    const focusTarget =
      previousTrigger !== null && previousTrigger.isConnected
        ? previousTrigger
        : launcherRef.current;
    focusTarget?.focus();
  }, [chatOpen]);

  useEffect(() => {
    if (!chatOpen) {
      return;
    }

    const markVisibleChatAsRead = (): void => {
      if (document.visibilityState === "visible") {
        setUnreadChatMessages(0);
      }
    };
    document.addEventListener("visibilitychange", markVisibleChatAsRead);
    markVisibleChatAsRead();
    return () => document.removeEventListener("visibilitychange", markVisibleChatAsRead);
  }, [chatOpen]);

  const recordUnreadAgentMessage = useCallback(() => {
    setUnreadChatMessages((current) => Math.min(current + 1, 99));
  }, []);

  /**
   * Configuration Chat is rendered outside the section switch, so it stays open
   * across sections. Opening it must not move the owner away from the surface
   * they are working on — Join in particular offers its own way in, and sending
   * the owner back to Devices would discard the enrollment step in progress.
   */
  function openChat(trigger: HTMLButtonElement): void {
    lastChatTriggerRef.current = trigger;
    setChatOpen(true);
    setChatFocusRequestId((current) => current + 1);
    setUnreadChatMessages(0);
  }

  function configureAgentProfile(message: string, trigger: HTMLButtonElement): void {
    setChatDraftRequest((current) => ({
      deviceId: device.deviceId,
      requestId: (current?.requestId ?? 0) + 1,
      message,
    }));
    openChat(trigger);
  }

  function closeChat(): void {
    setChatOpen(false);
    setChatExpanded(false);
  }

  function selectSection(section: AdminSection): void {
    if (section === "approvals") {
      setFocusedApprovalId(undefined);
    }
    setActiveSection(section);
    dismissChatOverlay();
  }

  function selectDevice(deviceId: string): void {
    if (!deviceFleet.devices.some((candidate) => candidate.deviceId === deviceId)) {
      return;
    }
    setSelectedDeviceId(deviceId);
    setActiveSection("devices");
  }

  function reviewApproval(approvalId: string): void {
    setFocusedApprovalId(approvalId);
    dismissChatOverlay();
    setActiveSection("approvals");
  }

  /**
   * Frees the surface when the chat is covering it. Expanded chat and the
   * compact layout both render as a modal over an inert surface, so moving to
   * another surface has to give it back. A docked panel sits beside the surface
   * and stays open, which is what lets the owner read the chat while working.
   */
  function dismissChatOverlay(): void {
    if (chatExpanded) {
      setChatExpanded(false);
    }
    if (compactChat) {
      setChatOpen(false);
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
        <span>{releaseDetail}</span>
      </div>
      <div
        aria-hidden={chatModal ? true : undefined}
        className="app-frame"
        inert={chatModal ? true : undefined}
      >
        <AdminRail
          activeSection={activeSection}
          approvalsEnabled={api !== undefined}
          artifactsEnabled={api !== undefined}
          auditEnabled={api !== undefined}
          devices={deviceFleet.devices}
          onSelectDevice={selectDevice}
          onSelectSection={selectSection}
          selectedDeviceId={device.deviceId}
          joinEnabled={api !== undefined}
          tasksEnabled={api !== undefined}
        />
        {activeSection === "tasks" && api !== undefined ? (
          <TaskSurface
            api={api}
            discordConfigured={discordConfigured}
            executionAvailable={executionAvailable}
          />
        ) : activeSection === "approvals" && api !== undefined ? (
          <ApprovalSurface
            api={api}
            {...(focusedApprovalId === undefined ? {} : { initialApprovalId: focusedApprovalId })}
            {...(onApprovalDecided === undefined ? {} : { onApprovalDecided })}
          />
        ) : activeSection === "artifacts" && api !== undefined ? (
          <ArtifactSurface
            api={api}
            {...(initialArtifactId === undefined ? {} : { initialArtifactId })}
          />
        ) : activeSection === "audit" && api !== undefined ? (
          <AuditSurface api={api} />
        ) : activeSection === "join" && api !== undefined ? (
          <JoinSurface api={api} onOpenConfigurationChat={openChat} />
        ) : (
          <DeviceSurface
            chatOpen={chatOpen}
            device={device}
            onConfigure={openChat}
            onConfigureAgentProfile={configureAgentProfile}
            {...(device.role === "main" && onAssessDevice !== undefined
              ? { onAssess: () => onAssessDevice(device.deviceId) }
              : {})}
          />
        )}
      </div>

      <ConfigurationChat
        deviceId={device.deviceId}
        discordSetupRecommended={discordSetupRecommended}
        {...(chatDraftRequest?.deviceId === device.deviceId
          ? {
              draftRequest: {
                requestId: chatDraftRequest.requestId,
                message: chatDraftRequest.message,
              },
            }
          : {})}
        expanded={chatExpanded}
        focusRequestId={chatFocusRequestId}
        key={device.deviceId}
        mainDevice={device.role === "main"}
        modal={chatModal}
        onClose={closeChat}
        {...(api === undefined ? {} : { onReviewApproval: reviewApproval })}
        onUnreadAgentMessage={recordUnreadAgentMessage}
        {...(onLoadConfigurationMessages === undefined
          ? {}
          : { onLoadMessages: loadSelectedDeviceConfigurationMessages })}
        {...(configurationAgentAvailable && onConfigurationMessage !== undefined
          ? {
              ...(onSecureSecretIngest === undefined
                ? {}
                : { onIngestSecret: onSecureSecretIngest }),
              onSendMessage: (message: string) => onConfigurationMessage(device.deviceId, message),
            }
          : {})}
        onToggleExpanded={() => setChatExpanded((current) => !current)}
        open={chatOpen}
        session={device.configurationSession}
      />

      <span
        aria-label={messages.chat.notificationRegion}
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {unreadChatMessages > 0
          ? formatMessage(messages.chat.unreadAnnouncement, {
              count: unreadChatMessages,
            })
          : ""}
      </span>

      {!chatOpen ? (
        <button
          aria-controls="configuration-chat"
          aria-expanded="false"
          aria-label={unreadChatMessages > 0 ? messages.chat.openUnread : messages.chat.open}
          className={`chat-launcher${unreadChatMessages > 0 ? " chat-launcher--unread" : ""} ${
            activeSection === "tasks"
              ? "chat-launcher--tasks"
              : activeSection === "approvals"
                ? "chat-launcher--approvals"
                : ""
          }`}
          onClick={(event) => openChat(event.currentTarget)}
          ref={launcherRef}
          type="button"
        >
          <MessageCircle aria-hidden="true" />
          {unreadChatMessages > 0 ? (
            <>
              <span aria-hidden="true" className="chat-launcher-badge">
                {unreadChatMessages}
              </span>
              <span aria-hidden="true" className="chat-launcher-unread-copy">
                <strong>{messages.chat.unreadStatus}</strong>
                <small>
                  {formatMessage(messages.chat.unreadCount, {
                    count: unreadChatMessages,
                  })}
                </small>
              </span>
            </>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}

function resolveMainDevice(deviceFleet: DeviceFleetViewModel): DeviceOverviewViewModel {
  const mainDevices = deviceFleet.devices.filter((candidate) => candidate.role === "main");
  const mainDevice = mainDevices[0];
  if (
    mainDevices.length !== 1 ||
    mainDevice === undefined ||
    mainDevice.deviceId !== deviceFleet.mainDeviceId
  ) {
    throw new Error("The Admin Device fleet must contain exactly one fixed Main Device.");
  }
  return mainDevice;
}
