import {
  Bot,
  Check,
  Database,
  Expand,
  LockKeyhole,
  Minimize2,
  Network,
  Send,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  formatMessage,
  localizeCapabilityState,
  localizePresentationText,
  type Messages,
  useAdminI18n,
} from "./i18n";
import {
  AdminApiError,
  type ConfigurationAgentReply,
  type ConfigurationAgentConversationMessage,
  type ConfigurationAgentSuggestedAction,
  mainSecretAlias,
  type SecureSecretIngestPurpose,
  type SecureSecretIngestReceipt,
} from "./admin-api";
import type { ConfigurationSessionView } from "./view-model";

type ProposalState = "proposed" | "reviewing" | "dismissed";
type GuidedSetupGoal = "discord" | "external-postgresql";
type ConversationEntryMode = "owner-visible" | "agent-initiated";

interface GuidedSetupDescriptor {
  readonly icon: "bot" | "database";
  readonly inputLabel: string;
  readonly inputPlaceholder: string;
  readonly purpose: "database-uri" | "discord-bot-token";
  readonly request: string;
  readonly secureIntro: string;
  readonly secureTitle: string;
  readonly toReferenceMessage: (receipt: SecureSecretIngestReceipt) => string;
}

interface SuggestedActionDescriptor {
  readonly description: string;
  readonly goal?: GuidedSetupGoal;
  readonly icon: "bot" | "database";
  readonly title: string;
}

type SystemChatMessageKey = "failedMessage" | "secureStoreFailed" | "unavailableMessage";

type ChatMessage = {
  readonly id: string;
  readonly author: "agent" | "owner";
  readonly suggestedActions?: readonly ConfigurationAgentSuggestedAction[];
} & (
  | {
      readonly content: string;
      readonly systemMessageKey?: never;
    }
  | {
      readonly content?: never;
      readonly systemMessageKey: SystemChatMessageKey;
    }
  | {
      readonly configurationFailure: {
        readonly correlationId?: string;
        readonly diagnosticCode?: string;
      };
      readonly content?: never;
      readonly systemMessageKey?: never;
    }
);

type ChatMessageBlock =
  | {
      readonly kind: "paragraph";
      readonly text: string;
    }
  | {
      readonly items: readonly string[];
      readonly kind: "ordered-list" | "unordered-list";
    };

interface ConfigurationChatProps {
  readonly deviceId: string;
  readonly discordSetupRecommended: boolean;
  readonly draftRequest?: {
    readonly requestId: number;
    readonly message: string;
  };
  readonly expanded: boolean;
  readonly focusRequestId: number;
  readonly mainDevice: boolean;
  readonly modal: boolean;
  readonly onClose: () => void;
  readonly onIngestSecret?: (
    purpose: SecureSecretIngestPurpose,
    secret: Uint8Array,
  ) => Promise<SecureSecretIngestReceipt>;
  readonly onUnreadAgentMessage?: () => void;
  readonly onLoadMessages?: () => Promise<readonly ConfigurationAgentConversationMessage[]>;
  readonly onSendMessage?: (message: string) => Promise<ConfigurationAgentReply>;
  readonly onToggleExpanded: () => void;
  readonly open: boolean;
  readonly session: ConfigurationSessionView;
}

export function ConfigurationChat({
  deviceId,
  discordSetupRecommended,
  draftRequest,
  expanded,
  focusRequestId,
  mainDevice,
  modal,
  onClose,
  onIngestSecret,
  onLoadMessages,
  onUnreadAgentMessage,
  onSendMessage,
  onToggleExpanded,
  open,
  session,
}: ConfigurationChatProps): React.JSX.Element {
  const { messages: copy } = useAdminI18n();
  const [proposalState, setProposalState] = useState<ProposalState>("proposed");
  const [draft, setDraft] = useState("");
  const [setupGoal, setSetupGoal] = useState<GuidedSetupGoal | null>(null);
  const [setupMessageId, setSetupMessageId] = useState<string | null>(null);
  const [secureCredential, setSecureCredential] = useState("");
  const [storedReference, setStoredReference] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [agentResponding, setAgentResponding] = useState(false);
  const [recoveredPending, setRecoveredPending] = useState(false);
  const [historyHydrated, setHistoryHydrated] = useState(onLoadMessages === undefined);
  const activeSetup = setupGoal === null ? null : guidedSetupDescriptor(setupGoal, copy);
  const [conversationMessages, setConversationMessages] = useState<readonly ChatMessage[]>(() => [
    onSendMessage === undefined
      ? {
          id: "message-agent-discovery",
          author: "agent",
          systemMessageKey: "unavailableMessage",
        }
      : {
          id: "message-agent-discovery",
          author: "agent",
          content: localizePresentationText(session.assistantMessage, copy),
        },
  ]);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openRef = useRef(open);
  const previousMessageCountRef = useRef(conversationMessages.length);
  const discordOnboardingAttemptedForOpenRef = useRef(false);
  const consumedDraftRequestIdRef = useRef<number | undefined>(undefined);

  const notifyIfUnread = useCallback(() => {
    if (!openRef.current || document.visibilityState !== "visible") {
      onUnreadAgentMessage?.();
    }
  }, [onUnreadAgentMessage]);

  const appendAgentMessage = useCallback(
    (message: ChatMessage): void => {
      setConversationMessages((current) => [...current, message]);
      notifyIfUnread();
    },
    [notifyIfUnread],
  );

  const restoreConversationMessages = useCallback(
    (messages: readonly ConfigurationAgentConversationMessage[]): boolean => {
      const restored = messages.flatMap((message): readonly ChatMessage[] => {
        const visible: ChatMessage = {
          id: `history-${message.messageId}`,
          author: message.role,
          content: message.content,
          ...(message.suggestedActions.length === 0
            ? {}
            : { suggestedActions: message.suggestedActions }),
        };
        return message.role === "owner" && message.responseStatus === "interrupted"
          ? [
              visible,
              {
                id: `history-interrupted-${message.messageId}`,
                author: "agent",
                systemMessageKey: "failedMessage",
              },
            ]
          : [visible];
      });
      const hasPending = messages.some(
        (message) => message.role === "owner" && message.responseStatus === "pending",
      );
      setConversationMessages(restored);
      setRecoveredPending(hasPending);
      setPending(hasPending);
      setAgentResponding(hasPending);
      return hasPending;
    },
    [],
  );

  const sendConversationMessage = useCallback(
    async (
      message: string,
      entryMode: ConversationEntryMode = "owner-visible",
    ): Promise<boolean> => {
      if (onSendMessage === undefined || pending || !historyHydrated) {
        return false;
      }

      const sequence = conversationMessages.length;
      if (entryMode === "owner-visible") {
        setConversationMessages((current) => [
          ...current,
          {
            id: `message-owner-${sequence}`,
            author: "owner",
            content: message,
          },
        ]);
      }
      setPending(true);
      setAgentResponding(true);
      try {
        const response = await onSendMessage(message);
        appendAgentMessage({
          id: `message-agent-${sequence + 1}`,
          author: "agent",
          content: response.content,
          suggestedActions: response.suggestedActions,
        });
        return true;
      } catch (error) {
        appendAgentMessage(configurationFailureMessage(`message-agent-${sequence + 1}`, error));
        return false;
      } finally {
        setAgentResponding(false);
        setPending(false);
      }
    },
    [appendAgentMessage, conversationMessages.length, historyHydrated, onSendMessage, pending],
  );

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const discoveryMessage: ChatMessage =
      onSendMessage === undefined
        ? {
            id: "message-agent-discovery",
            author: "agent",
            systemMessageKey: "unavailableMessage",
          }
        : {
            id: "message-agent-discovery",
            author: "agent",
            content: localizePresentationText(session.assistantMessage, copy),
          };
    setConversationMessages((current) =>
      current.length === 1 && current[0]?.id === "message-agent-discovery"
        ? [discoveryMessage]
        : current,
    );
  }, [copy, onSendMessage, session.assistantMessage]);

  useEffect(() => {
    if (onLoadMessages === undefined) {
      setHistoryHydrated(true);
      return;
    }
    let active = true;
    setHistoryHydrated(false);
    void onLoadMessages()
      .then((messages) => {
        if (!active) {
          return;
        }
        if (messages.length === 0) {
          return;
        }
        restoreConversationMessages(messages);
      })
      .catch(() => {
        // Chat remains usable when history recovery is temporarily unavailable.
      })
      .finally(() => {
        if (active) {
          setHistoryHydrated(true);
        }
      });
    return () => {
      active = false;
    };
  }, [onLoadMessages, restoreConversationMessages]);

  useEffect(() => {
    if (!historyHydrated || !recoveredPending || onLoadMessages === undefined) {
      return;
    }
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const messages = await onLoadMessages();
        if (!active) {
          return;
        }
        if (messages.length > 0 && !restoreConversationMessages(messages)) {
          return;
        }
      } catch {
        // A live pending response remains visible while a transient history read retries.
      }
      if (active) {
        timer = window.setTimeout(() => void poll(), 750);
      }
    };
    timer = window.setTimeout(() => void poll(), 750);
    return () => {
      active = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [historyHydrated, onLoadMessages, recoveredPending, restoreConversationMessages]);

  useEffect(() => {
    if (open && focusRequestId > 0) {
      (onSendMessage === undefined ? closeButtonRef.current : composerRef.current)?.focus();
    }
  }, [focusRequestId, onSendMessage, open]);

  useEffect(() => {
    if (
      draftRequest === undefined ||
      consumedDraftRequestIdRef.current === draftRequest.requestId
    ) {
      return;
    }
    consumedDraftRequestIdRef.current = draftRequest.requestId;
    setDraft(draftRequest.message);
    if (open && onSendMessage !== undefined) {
      composerRef.current?.focus();
    }
  }, [draftRequest, onSendMessage, open]);

  useEffect(() => {
    if (!open) {
      setSetupGoal(null);
      setSetupMessageId(null);
      setSecureCredential("");
      setStoredReference(null);
      discordOnboardingAttemptedForOpenRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (open && modal && dialog !== null && !dialog.contains(document.activeElement)) {
      (onSendMessage === undefined ? closeButtonRef.current : composerRef.current)?.focus();
    }
  }, [modal, onSendMessage, open]);

  useLayoutEffect(() => {
    const scrollRegion = scrollRegionRef.current;
    if (
      open &&
      scrollRegion !== null &&
      conversationMessages.length > previousMessageCountRef.current
    ) {
      scrollRegion.scrollTop = scrollRegion.scrollHeight;
    }
    previousMessageCountRef.current = conversationMessages.length;
  }, [conversationMessages, open]);

  useEffect(() => {
    if (!pending && open && onSendMessage !== undefined) {
      composerRef.current?.focus();
    }
  }, [onSendMessage, open, pending]);

  useEffect(() => {
    if (
      !open ||
      !mainDevice ||
      !discordSetupRecommended ||
      onSendMessage === undefined ||
      !historyHydrated ||
      pending ||
      discordOnboardingAttemptedForOpenRef.current ||
      discordOnboardingCompleted(deviceId)
    ) {
      return;
    }
    discordOnboardingAttemptedForOpenRef.current = true;
    setConversationMessages((current) => [
      ...current,
      {
        id: "message-agent-discord-onboarding",
        author: "agent",
        content: copy.chat.discordOnboardingMessage,
      },
    ]);
    void sendConversationMessage(copy.chat.discordSetupRequest, "agent-initiated").then(
      (succeeded) => {
        if (succeeded) {
          recordDiscordOnboardingCompleted(deviceId);
        }
      },
    );
  }, [
    copy.chat.discordOnboardingMessage,
    copy.chat.discordSetupRequest,
    deviceId,
    discordSetupRecommended,
    historyHydrated,
    mainDevice,
    onSendMessage,
    open,
    pending,
    sendConversationMessage,
  ]);

  async function submitChatMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const message = draft.trim();
    if (message === "" || !historyHydrated) {
      return;
    }
    setDraft("");
    await sendConversationMessage(message);
  }

  async function handleSuggestedAction(
    messageId: string,
    action: ConfigurationAgentSuggestedAction,
  ): Promise<void> {
    if (onSendMessage === undefined || pending) {
      return;
    }
    if (action === "guide-discord" || action === "guide-external-postgresql") {
      setSetupGoal(null);
      setSetupMessageId(null);
      setSecureCredential("");
      setStoredReference(null);
      const goal = action === "guide-discord" ? "discord" : "external-postgresql";
      await sendConversationMessage(guidedSetupDescriptor(goal, copy).request);
      return;
    }
    const goal = action === "ingest-discord-bot-token" ? "discord" : "external-postgresql";
    setSetupGoal(goal);
    setSetupMessageId(messageId);
    setSecureCredential("");
    setStoredReference(null);
  }

  async function submitSecureSecret(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      onIngestSecret === undefined ||
      onSendMessage === undefined ||
      pending ||
      activeSetup === null ||
      secureCredential.length === 0
    ) {
      return;
    }

    const selectedSetup = activeSetup;
    const material = new TextEncoder().encode(secureCredential);
    setSecureCredential("");
    setStoredReference(null);
    setPending(true);
    const sequence = conversationMessages.length;
    try {
      const receipt = await onIngestSecret(selectedSetup.purpose, material);
      const referenceMessage = selectedSetup.toReferenceMessage(receipt);
      setStoredReference(receipt.secretRef);
      setConversationMessages((current) => [
        ...current,
        {
          id: `message-owner-secure-reference-${sequence}`,
          author: "owner",
          content: referenceMessage,
        },
      ]);
      try {
        setAgentResponding(true);
        const response = await onSendMessage(referenceMessage);
        appendAgentMessage({
          id: `message-agent-secure-reference-${sequence + 1}`,
          author: "agent",
          content: response.content,
          suggestedActions: response.suggestedActions,
        });
      } catch (error) {
        appendAgentMessage(
          configurationFailureMessage(`message-agent-secure-reference-${sequence + 1}`, error),
        );
      }
    } catch {
      appendAgentMessage({
        id: `message-agent-secure-store-${sequence}`,
        author: "agent",
        systemMessageKey: "secureStoreFailed",
      });
    } finally {
      setAgentResponding(false);
      material.fill(0);
      setPending(false);
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (!modal || event.key !== "Tab") {
      return;
    }

    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable.at(0);
    const last = focusable.at(-1);

    if (first === undefined || last === undefined) {
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={`configuration-chat-layer${modal ? " configuration-chat-layer--modal" : ""}${
        expanded ? " configuration-chat-layer--expanded" : ""
      }`}
      hidden={!open}
    >
      <div
        aria-labelledby="configuration-chat-title"
        aria-modal={modal}
        className={`configuration-chat${expanded ? " configuration-chat--expanded" : ""}`}
        id="configuration-chat"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="chat-header">
          <div>
            <h2 id="configuration-chat-title">{copy.chat.title}</h2>
            <p>{copy.chat.subtitle}</p>
          </div>
          <div className="chat-header-actions">
            <button
              aria-label={expanded ? copy.chat.restore : copy.chat.expand}
              onClick={onToggleExpanded}
              type="button"
            >
              {expanded ? <Minimize2 aria-hidden="true" /> : <Expand aria-hidden="true" />}
            </button>
            <button
              aria-label={copy.chat.close}
              onClick={onClose}
              ref={closeButtonRef}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="chat-scroll-region" ref={scrollRegionRef}>
          <div
            aria-label={copy.chat.conversation}
            aria-live="polite"
            aria-relevant="additions"
            className="chat-messages"
            role="log"
          >
            {conversationMessages.map((message) => (
              <article
                aria-label={message.author === "agent" ? "OpenDelegate" : copy.chat.you}
                className={`chat-message chat-message--${message.author}`}
                key={message.id}
              >
                {message.author === "agent" ? (
                  <span className="agent-avatar">
                    <Network aria-hidden="true" />
                  </span>
                ) : null}
                <div className="chat-message-body">
                  <ChatMessageCopy content={chatMessageContent(message, copy)} />
                  {message.author === "agent" &&
                  mainDevice &&
                  onIngestSecret !== undefined &&
                  onSendMessage !== undefined &&
                  message.suggestedActions !== undefined &&
                  message.suggestedActions.length > 0 ? (
                    <div
                      aria-label={copy.chat.guidedSetupTitle}
                      className="guided-setup-options chat-message-actions"
                    >
                      {message.suggestedActions.map((action) => {
                        const descriptor = suggestedActionDescriptor(action, copy);
                        return (
                          <button
                            aria-label={descriptor.title}
                            aria-pressed={
                              setupMessageId === message.id &&
                              setupGoal !== null &&
                              descriptor.goal === setupGoal
                            }
                            className="guided-setup-option"
                            disabled={pending}
                            key={action}
                            onClick={() => void handleSuggestedAction(message.id, action)}
                            type="button"
                          >
                            <span aria-hidden="true">
                              {descriptor.icon === "database" ? <Database /> : <Bot />}
                            </span>
                            <span>
                              <strong>{descriptor.title}</strong>
                              <small>{descriptor.description}</small>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {message.author === "agent" &&
                  mainDevice &&
                  setupMessageId === message.id &&
                  activeSetup !== null &&
                  onIngestSecret !== undefined &&
                  onSendMessage !== undefined ? (
                    <section
                      aria-labelledby={`configuration-secret-title-${message.id}`}
                      className="secure-secret-panel"
                    >
                      <div className="secure-secret-heading">
                        <span aria-hidden="true">
                          {activeSetup.icon === "database" ? <Database /> : <Bot />}
                        </span>
                        <div>
                          <h3 id={`configuration-secret-title-${message.id}`}>
                            {activeSetup.secureTitle}
                          </h3>
                          <p>{activeSetup.secureIntro}</p>
                        </div>
                      </div>
                      <form
                        className="secure-secret-form"
                        onSubmit={(event) => void submitSecureSecret(event)}
                      >
                        <label htmlFor={`configuration-secret-value-${message.id}`}>
                          {activeSetup.inputLabel}
                        </label>
                        <div>
                          <input
                            aria-describedby={`configuration-secret-value-notice-${message.id}`}
                            autoCapitalize="none"
                            autoComplete="off"
                            data-1p-ignore="true"
                            disabled={pending}
                            id={`configuration-secret-value-${message.id}`}
                            onChange={(event) => setSecureCredential(event.target.value)}
                            placeholder={activeSetup.inputPlaceholder}
                            spellCheck={false}
                            type="password"
                            value={secureCredential}
                          />
                          <button
                            className="secondary-button"
                            disabled={pending || secureCredential.length === 0}
                            type="submit"
                          >
                            <LockKeyhole aria-hidden="true" />
                            {pending ? copy.chat.secureStoring : copy.chat.secureStore}
                          </button>
                        </div>
                        <p id={`configuration-secret-value-notice-${message.id}`}>
                          {copy.chat.secureNotice}
                        </p>
                        {storedReference === null ? null : (
                          <p className="secure-secret-receipt" role="status">
                            <Check aria-hidden="true" />
                            {formatMessage(copy.chat.secureStored, {
                              reference: storedReference,
                            })}
                          </p>
                        )}
                      </form>
                    </section>
                  ) : null}
                </div>
              </article>
            ))}
            {agentResponding ? (
              <article
                aria-label={copy.chat.waitingPlaceholder}
                className="chat-message chat-message--agent chat-message--activity"
              >
                <span className="agent-avatar">
                  <Network aria-hidden="true" />
                </span>
                <div className="chat-message-body">
                  <div className="chat-agent-activity">
                    <span aria-hidden="true" className="chat-agent-activity-dots">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span>{copy.chat.waitingPlaceholder}</span>
                  </div>
                </div>
              </article>
            ) : null}
          </div>

          {session.proposal !== null && proposalState !== "dismissed" ? (
            <div className="proposal-stack">
              <section aria-label={copy.chat.proposedChange} className="proposal-panel">
                <div className="proposal-heading">
                  <h3>{copy.chat.proposedChange}</h3>
                  <span>{copy.chat.reviewOnly}</span>
                </div>
                <p className="proposal-note">{copy.chat.previewNotice}</p>
                {proposalState === "reviewing" ? (
                  <div className="proposal-diff">
                    <div>
                      <UserRound aria-hidden="true" />
                      <span>
                        {localizePresentationText(session.proposal.role.actionLabel, copy)}
                      </span>
                      <strong data-testid="role-diff">
                        <span aria-hidden="true">+</span>
                        {localizePresentationText(session.proposal.role.label, copy)}
                      </strong>
                    </div>
                    <div>
                      <ShieldCheck aria-hidden="true" />
                      <span>
                        {localizePresentationText(session.proposal.capability.actionLabel, copy)}
                      </span>
                      <strong data-testid="capability-diff">
                        <span>
                          {localizePresentationText(session.proposal.capability.label, copy)}
                        </span>
                        <code>{session.proposal.capability.capabilityId}</code>
                        <span aria-hidden="true" className="proposal-transition">
                          {localizeCapabilityState(session.proposal.capability.fromState, copy)}
                          <span>→</span>
                          {localizeCapabilityState(session.proposal.capability.toState, copy)}
                        </span>
                        <span className="sr-only">
                          {formatMessage(copy.chat.transitionDescription, {
                            from: localizeCapabilityState(
                              session.proposal.capability.fromState,
                              copy,
                            ),
                            to: localizeCapabilityState(session.proposal.capability.toState, copy),
                          })}
                        </span>
                      </strong>
                    </div>
                  </div>
                ) : (
                  <div className="proposal-summary">
                    <div>
                      <UserRound aria-hidden="true" />
                      <span>
                        {localizePresentationText(session.proposal.role.actionLabel, copy)}
                      </span>
                      <strong>{localizePresentationText(session.proposal.role.label, copy)}</strong>
                    </div>
                    <div>
                      <ShieldCheck aria-hidden="true" />
                      <span>
                        {localizePresentationText(session.proposal.capability.actionLabel, copy)}
                      </span>
                      <strong>
                        {localizePresentationText(session.proposal.capability.label, copy)}
                        <code>{session.proposal.capability.capabilityId}</code>
                      </strong>
                    </div>
                  </div>
                )}
              </section>
              <div className="proposal-actions">
                <button
                  className="primary-button"
                  disabled={proposalState === "reviewing"}
                  onClick={() => setProposalState("reviewing")}
                  type="button"
                >
                  {proposalState === "reviewing" ? <Check aria-hidden="true" /> : null}
                  {proposalState === "reviewing" ? copy.chat.reviewed : copy.chat.review}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => setProposalState("dismissed")}
                  type="button"
                >
                  {copy.chat.notNow}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <form className="chat-composer" onSubmit={(event) => void submitChatMessage(event)}>
          <label className="sr-only" htmlFor="configuration-chat-message">
            {copy.chat.messageLabel}
          </label>
          <textarea
            autoComplete="off"
            disabled={onSendMessage === undefined || pending || !historyHydrated}
            id="configuration-chat-message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              onSendMessage === undefined
                ? copy.chat.unavailablePlaceholder
                : pending
                  ? copy.chat.waitingPlaceholder
                  : copy.chat.askPlaceholder
            }
            ref={composerRef}
            rows={1}
            value={draft}
          />
          <button
            aria-label={copy.chat.send}
            disabled={
              onSendMessage === undefined || pending || !historyHydrated || draft.trim() === ""
            }
            type="submit"
          >
            <Send aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}

function configurationFailureMessage(id: string, error: unknown): ChatMessage {
  if (error instanceof AdminApiError && error.code === "CONFIGURATION_AGENT_UNAVAILABLE") {
    return {
      id,
      author: "agent",
      configurationFailure: {
        ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId }),
        ...(error.diagnosticCode === undefined ? {} : { diagnosticCode: error.diagnosticCode }),
      },
    };
  }
  return {
    id,
    author: "agent",
    systemMessageKey: "failedMessage",
  };
}

function chatMessageContent(message: ChatMessage, copy: Messages): string {
  if (message.systemMessageKey !== undefined) {
    return copy.chat[message.systemMessageKey];
  }
  if ("configurationFailure" in message) {
    return [
      copy.chat.failedMessage,
      ...(message.configurationFailure.diagnosticCode === undefined
        ? []
        : [
            formatMessage(copy.chat.diagnosticCode, {
              code: message.configurationFailure.diagnosticCode,
            }),
          ]),
      ...(message.configurationFailure.correlationId === undefined
        ? []
        : [
            formatMessage(copy.chat.correlationId, {
              id: message.configurationFailure.correlationId,
            }),
          ]),
    ].join("\n\n");
  }
  return message.content;
}

function ChatMessageCopy({ content }: { readonly content: string }): React.JSX.Element {
  return (
    <div className="chat-message-copy">
      {parseChatMessageBlocks(content).map((block, index) => {
        if (block.kind === "paragraph") {
          return <p key={`paragraph-${index}`}>{block.text}</p>;
        }
        const items = block.items.map((item, itemIndex) => (
          <li key={`${itemIndex}-${item}`}>{item}</li>
        ));
        return block.kind === "ordered-list" ? (
          <ol key={`ordered-list-${index}`}>{items}</ol>
        ) : (
          <ul key={`unordered-list-${index}`}>{items}</ul>
        );
      })}
    </div>
  );
}

function parseChatMessageBlocks(content: string): readonly ChatMessageBlock[] {
  const blocks: ChatMessageBlock[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];
  let listKind: "ordered-list" | "unordered-list" | null = null;

  function flushParagraph(): void {
    if (paragraphLines.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
      paragraphLines = [];
    }
  }

  function flushList(): void {
    if (listKind !== null && listItems.length > 0) {
      blocks.push({ kind: listKind, items: listItems });
      listItems = [];
      listKind = null;
    }
  }

  for (const rawLine of content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const orderedItem = line.match(/^\d+[.)]\s+(.+)$/u);
    const unorderedItem = line.match(/^[-*•]\s+(.+)$/u);
    const nextListKind =
      orderedItem !== null
        ? ("ordered-list" as const)
        : unorderedItem !== null
          ? ("unordered-list" as const)
          : null;
    if (nextListKind !== null) {
      flushParagraph();
      if (listKind !== null && listKind !== nextListKind) {
        flushList();
      }
      listKind = nextListKind;
      listItems.push((orderedItem ?? unorderedItem)![1]!);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function guidedSetupDescriptor(goal: GuidedSetupGoal, copy: Messages): GuidedSetupDescriptor {
  if (goal === "discord") {
    return {
      icon: "bot",
      inputLabel: copy.chat.discordTokenLabel,
      inputPlaceholder: copy.chat.discordTokenPlaceholder,
      purpose: "discord-bot-token",
      request: copy.chat.discordSetupRequest,
      secureIntro: copy.chat.discordSecureIntro,
      secureTitle: copy.chat.discordSecureTitle,
      toReferenceMessage: (receipt) =>
        formatMessage(copy.chat.secureDiscordReferenceMessage, {
          reference: receipt.secretRef,
          alias: mainSecretAlias(receipt.secretRef),
        }),
    };
  }
  return {
    icon: "database",
    inputLabel: copy.chat.databaseUriLabel,
    inputPlaceholder: copy.chat.databaseUriPlaceholder,
    purpose: "database-uri",
    request: copy.chat.databaseSetupRequest,
    secureIntro: copy.chat.databaseSecureIntro,
    secureTitle: copy.chat.databaseSecureTitle,
    toReferenceMessage: (receipt) =>
      formatMessage(copy.chat.secureReferenceMessage, {
        reference: receipt.secretRef,
      }),
  };
}

function suggestedActionDescriptor(
  action: ConfigurationAgentSuggestedAction,
  copy: Messages,
): SuggestedActionDescriptor {
  switch (action) {
    case "guide-discord":
      return {
        icon: "bot",
        title: copy.chat.discordSetupTitle,
        description: copy.chat.discordSetupDescription,
      };
    case "guide-external-postgresql":
      return {
        icon: "database",
        title: copy.chat.databaseSetupTitle,
        description: copy.chat.databaseSetupDescription,
      };
    case "ingest-discord-bot-token":
      return {
        icon: "bot",
        goal: "discord",
        title: copy.chat.discordSecureTitle,
        description: copy.chat.discordSecureIntro,
      };
    case "ingest-database-uri":
      return {
        icon: "database",
        goal: "external-postgresql",
        title: copy.chat.databaseSecureTitle,
        description: copy.chat.databaseSecureIntro,
      };
  }
}

const DISCORD_ONBOARDING_SESSION_KEY_PREFIX = "opendelegate.configuration.discord-onboarding.v1:";

function discordOnboardingCompleted(deviceId: string): boolean {
  try {
    return (
      window.sessionStorage.getItem(`${DISCORD_ONBOARDING_SESSION_KEY_PREFIX}${deviceId}`) ===
      "completed"
    );
  } catch {
    return false;
  }
}

function recordDiscordOnboardingCompleted(deviceId: string): void {
  try {
    window.sessionStorage.setItem(
      `${DISCORD_ONBOARDING_SESSION_KEY_PREFIX}${deviceId}`,
      "completed",
    );
  } catch {
    // A blocked browser storage policy must not prevent Configuration Chat from working.
  }
}
