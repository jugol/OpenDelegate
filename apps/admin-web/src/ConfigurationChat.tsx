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
  readonly deviceName: string;
  readonly expanded: boolean;
  readonly focusRequestId: number;
  readonly modal: boolean;
  readonly onClose: () => void;
  readonly onToggleExpanded: () => void;
  readonly open: boolean;
  readonly session: ConfigurationSessionView;
}

export function ConfigurationChat({
  deviceName,
  expanded,
  focusRequestId,
  modal,
  onClose,
  onToggleExpanded,
  open,
  session,
}: ConfigurationChatProps): React.JSX.Element {
  const [proposalState, setProposalState] = useState<ProposalState>("proposed");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<readonly ChatMessage[]>(() => [
    {
      id: "message-agent-discovery",
      author: "agent",
      content: session.assistantMessage,
    },
  ]);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const previousMessageCountRef = useRef(messages.length);

  useEffect(() => {
    if (open && focusRequestId > 0) {
      composerRef.current?.focus();
    }
  }, [focusRequestId, open]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (open && modal && dialog !== null && !dialog.contains(document.activeElement)) {
      composerRef.current?.focus();
    }
  }, [modal, open]);

  useLayoutEffect(() => {
    const scrollRegion = scrollRegionRef.current;
    if (open && scrollRegion !== null && messages.length > previousMessageCountRef.current) {
      scrollRegion.scrollTop = scrollRegion.scrollHeight;
    }
    previousMessageCountRef.current = messages.length;
  }, [messages, open]);

  function submitChatMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const message = draft.trim();

    if (message === "") {
      return;
    }

    setMessages((current) => {
      const sequence = current.length;

      return [
        ...current,
        {
          id: `message-owner-${sequence}`,
          author: "owner",
          content: message,
        },
        {
          id: `message-agent-${sequence + 1}`,
          author: "agent",
          content: `Got it. This message stays in ${deviceName}'s Device setup session. No settings were changed.`,
        },
      ];
    });
    setDraft("");
    composerRef.current?.focus();
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
            <button aria-label="Close Configuration Chat" onClick={onClose} type="button">
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

        <form className="chat-composer" onSubmit={submitChatMessage}>
          <label className="sr-only" htmlFor="configuration-chat-message">
            Message Configuration Chat
          </label>
          <input
            autoComplete="off"
            id="configuration-chat-message"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about this Device…"
            ref={composerRef}
            value={draft}
          />
          <button aria-label="Send message" disabled={draft.trim() === ""} type="submit">
            <Send aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}
