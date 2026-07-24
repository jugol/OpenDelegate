import { Check, Expand, Minimize2, Network, Send, ShieldCheck, UserRound, X } from "lucide-react";
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
  useAdminI18n,
} from "./i18n";
import type { ConfigurationSessionView } from "./view-model";

type ProposalState = "proposed" | "reviewing" | "dismissed";

type SystemChatMessageKey = "failedMessage" | "unavailableMessage";

type ChatMessage = {
  readonly id: string;
  readonly author: "agent" | "owner";
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
  readonly modal: boolean;
  readonly onClose: () => void;
  readonly onSendMessage?: (message: string) => Promise<string>;
  readonly onToggleExpanded: () => void;
  readonly open: boolean;
  readonly session: ConfigurationSessionView;
}

export function ConfigurationChat({
  expanded,
  focusRequestId,
  modal,
  onClose,
  onSendMessage,
  onToggleExpanded,
  open,
  session,
}: ConfigurationChatProps): React.JSX.Element {
  const { messages: copy } = useAdminI18n();
  const [proposalState, setProposalState] = useState<ProposalState>("proposed");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
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
          content: session.assistantMessage,
        },
  ]);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousMessageCountRef = useRef(conversationMessages.length);

  useEffect(() => {
    if (open && focusRequestId > 0) {
      (onSendMessage === undefined ? closeButtonRef.current : composerRef.current)?.focus();
    }
  }, [focusRequestId, onSendMessage, open]);

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

  async function submitChatMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (onSendMessage === undefined || pending) {
      return;
    }
    const message = draft.trim();

    if (message === "") {
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
    setDraft("");
    setPending(true);
    try {
      const response = await onSendMessage(message);
      setConversationMessages((current) => [
        ...current,
        {
          id: `message-agent-${sequence + 1}`,
          author: "agent",
          content: response,
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
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
                <p>
                  {message.systemMessageKey === undefined
                    ? message.content
                    : copy.chat[message.systemMessageKey]}
                </p>
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
