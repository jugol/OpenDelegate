import { Check, Expand, Minimize2, Network, Send, ShieldCheck, UserRound, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { ConfigurationSessionView } from "./view-model";

type ProposalState = "proposed" | "reviewing" | "dismissed";

interface ChatMessage {
  readonly id: string;
  readonly author: "agent" | "owner";
  readonly content: string;
}

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
  const [proposalState, setProposalState] = useState<ProposalState>("proposed");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<readonly ChatMessage[]>(() => [
    {
      id: "message-agent-discovery",
      author: "agent",
      content:
        onSendMessage === undefined
          ? "Device assessment and Configuration Agent messaging are not connected in this build. The visible Device facts come only from Main's deterministic runtime report."
          : session.assistantMessage,
    },
  ]);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousMessageCountRef = useRef(messages.length);

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
    if (open && scrollRegion !== null && messages.length > previousMessageCountRef.current) {
      scrollRegion.scrollTop = scrollRegion.scrollHeight;
    }
    previousMessageCountRef.current = messages.length;
  }, [messages, open]);

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

    const sequence = messages.length;
    setMessages((current) => [
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
      setMessages((current) => [
        ...current,
        {
          id: `message-agent-${sequence + 1}`,
          author: "agent",
          content: response,
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: `message-agent-${sequence + 1}`,
          author: "agent",
          content: "The Configuration Agent could not respond. No settings were changed.",
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
            <h2 id="configuration-chat-title">Configuration Chat</h2>
            <p>Device setup stays separate from Task conversations.</p>
          </div>
          <div className="chat-header-actions">
            <button
              aria-label={expanded ? "Restore Configuration Chat" : "Expand Configuration Chat"}
              onClick={onToggleExpanded}
              type="button"
            >
              {expanded ? <Minimize2 aria-hidden="true" /> : <Expand aria-hidden="true" />}
            </button>
            <button
              aria-label="Close Configuration Chat"
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
            aria-label="Configuration conversation"
            aria-live="polite"
            aria-relevant="additions"
            className="chat-messages"
            role="log"
          >
            {messages.map((message) => (
              <article
                aria-label={message.author === "agent" ? "OpenDelegate" : "You"}
                className={`chat-message chat-message--${message.author}`}
                key={message.id}
              >
                {message.author === "agent" ? (
                  <span className="agent-avatar">
                    <Network aria-hidden="true" />
                  </span>
                ) : null}
                <p>{message.content}</p>
              </article>
            ))}
          </div>

          {session.proposal !== null && proposalState !== "dismissed" ? (
            <div className="proposal-stack">
              <section aria-label="Proposed change" className="proposal-panel">
                <div className="proposal-heading">
                  <h3>Proposed change</h3>
                  <span>Review only</span>
                </div>
                <p className="proposal-note">This preview does not apply settings.</p>
                {proposalState === "reviewing" ? (
                  <div className="proposal-diff">
                    <div>
                      <UserRound aria-hidden="true" />
                      <span>{session.proposal.role.actionLabel}</span>
                      <strong data-testid="role-diff">
                        <span aria-hidden="true">+</span>
                        {session.proposal.role.label}
                      </strong>
                    </div>
                    <div>
                      <ShieldCheck aria-hidden="true" />
                      <span>{session.proposal.capability.actionLabel}</span>
                      <strong data-testid="capability-diff">
                        <span>{session.proposal.capability.label}</span>
                        <code>{session.proposal.capability.capabilityId}</code>
                        <span aria-hidden="true" className="proposal-transition">
                          {session.proposal.capability.fromState}
                          <span>→</span>
                          {session.proposal.capability.toState}
                        </span>
                        <span className="sr-only">
                          {session.proposal.capability.fromState} to{" "}
                          {session.proposal.capability.toState}
                        </span>
                      </strong>
                    </div>
                  </div>
                ) : (
                  <div className="proposal-summary">
                    <div>
                      <UserRound aria-hidden="true" />
                      <span>{session.proposal.role.actionLabel}</span>
                      <strong>{session.proposal.role.label}</strong>
                    </div>
                    <div>
                      <ShieldCheck aria-hidden="true" />
                      <span>{session.proposal.capability.actionLabel}</span>
                      <strong>
                        {session.proposal.capability.label}
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
                  {proposalState === "reviewing" ? "Change reviewed" : "Review change"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => setProposalState("dismissed")}
                  type="button"
                >
                  Not now
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <form className="chat-composer" onSubmit={(event) => void submitChatMessage(event)}>
          <label className="sr-only" htmlFor="configuration-chat-message">
            Message Configuration Chat
          </label>
          <input
            autoComplete="off"
            disabled={onSendMessage === undefined || pending}
            id="configuration-chat-message"
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              onSendMessage === undefined
                ? "Configuration Agent is not connected in this build."
                : pending
                  ? "Waiting for Configuration Agent…"
                  : "Ask about this Device…"
            }
            ref={composerRef}
            value={draft}
          />
          <button
            aria-label="Send message"
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
