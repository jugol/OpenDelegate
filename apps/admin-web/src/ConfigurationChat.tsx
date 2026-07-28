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
  type ConfigurationAgentReply,
  type ConfigurationAgentSuggestedAction,
  mainSecretAlias,
  type SecureSecretIngestPurpose,
  type SecureSecretIngestReceipt,
} from "./admin-api";
import type { ConfigurationSessionView } from "./view-model";

type ProposalState = "proposed" | "reviewing" | "dismissed";
type GuidedSetupGoal = "discord" | "external-postgresql";

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
);

interface ConfigurationChatProps {
  readonly expanded: boolean;
  readonly focusRequestId: number;
  readonly mainDevice: boolean;
  readonly modal: boolean;
  readonly onClose: () => void;
  readonly onIngestSecret?: (
    purpose: SecureSecretIngestPurpose,
    secret: Uint8Array,
  ) => Promise<SecureSecretIngestReceipt>;
  readonly onSendMessage?: (message: string) => Promise<ConfigurationAgentReply>;
  readonly onToggleExpanded: () => void;
  readonly open: boolean;
  readonly session: ConfigurationSessionView;
}

export function ConfigurationChat({
  expanded,
  focusRequestId,
  mainDevice,
  modal,
  onClose,
  onIngestSecret,
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
  const composerRef = useRef<HTMLInputElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousMessageCountRef = useRef(conversationMessages.length);

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
    if (open && focusRequestId > 0) {
      (onSendMessage === undefined ? closeButtonRef.current : composerRef.current)?.focus();
    }
  }, [focusRequestId, onSendMessage, open]);

  useEffect(() => {
    if (!open) {
      setSetupGoal(null);
      setSetupMessageId(null);
      setSecureCredential("");
      setStoredReference(null);
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

  async function sendConversationMessage(message: string): Promise<void> {
    if (onSendMessage === undefined || pending) {
      return;
    }

    const sequence = conversationMessages.length;
    setConversationMessages((current) => [
      ...current,
      {
        id: `message-owner-${sequence}`,
        author: "owner",
        content: message,
      },
    ]);
    setPending(true);
    try {
      const response = await onSendMessage(message);
      setConversationMessages((current) => [
        ...current,
        {
          id: `message-agent-${sequence + 1}`,
          author: "agent",
          content: response.content,
          suggestedActions: response.suggestedActions,
        },
      ]);
    } catch {
      setConversationMessages((current) => [
        ...current,
        {
          id: `message-agent-${sequence + 1}`,
          author: "agent",
          systemMessageKey: "failedMessage",
        },
      ]);
    } finally {
      setPending(false);
    }
  }

  async function submitChatMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const message = draft.trim();
    if (message === "") {
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
        const response = await onSendMessage(referenceMessage);
        setConversationMessages((current) => [
          ...current,
          {
            id: `message-agent-secure-reference-${sequence + 1}`,
            author: "agent",
            content: response.content,
            suggestedActions: response.suggestedActions,
          },
        ]);
      } catch {
        setConversationMessages((current) => [
          ...current,
          {
            id: `message-agent-secure-reference-${sequence + 1}`,
            author: "agent",
            systemMessageKey: "failedMessage",
          },
        ]);
      }
    } catch {
      setConversationMessages((current) => [
        ...current,
        {
          id: `message-agent-secure-store-${sequence}`,
          author: "agent",
          systemMessageKey: "secureStoreFailed",
        },
      ]);
    } finally {
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
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
                  <p>
                    {message.systemMessageKey === undefined
                      ? message.content
                      : copy.chat[message.systemMessageKey]}
                  </p>
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
          <input
            autoComplete="off"
            disabled={onSendMessage === undefined || pending}
            id="configuration-chat-message"
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              onSendMessage === undefined
                ? copy.chat.unavailablePlaceholder
                : pending
                  ? copy.chat.waitingPlaceholder
                  : copy.chat.askPlaceholder
            }
            ref={composerRef}
            value={draft}
          />
          <button
            aria-label={copy.chat.send}
            disabled={onSendMessage === undefined || pending || draft.trim() === ""}
            type="submit"
          >
            <Send aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
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
