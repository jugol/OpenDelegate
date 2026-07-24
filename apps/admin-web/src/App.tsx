import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CirclePlus,
  ClipboardCheck,
  Code2,
  Expand,
  FileClock,
  Folder,
  Globe2,
  Inbox,
  MessageCircle,
  MessagesSquare,
  Monitor,
  Network,
  Send,
  Settings,
  ShieldCheck,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";

import { firstRunDevice, type CapabilityView, type DeviceOverviewViewModel } from "./view-model";

const tabs = ["Overview", "Capabilities", "Roles & Instructions", "Routes", "Runs"] as const;

type DeviceTab = (typeof tabs)[number];
type ProposalState = "proposed" | "reviewing" | "dismissed";

interface ChatMessage {
  readonly id: string;
  readonly author: "agent" | "owner";
  readonly content: string;
}

const initialChatMessage: ChatMessage = {
  id: "message-agent-discovery",
  author: "agent",
  content:
    "I found Codex and a ready desktop session. I can verify Computer Use and add it to this Device profile.",
};

export function App(): React.JSX.Element {
  const [selectedTab, setSelectedTab] = useState<DeviceTab>("Overview");
  const [chatOpen, setChatOpen] = useState(true);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [proposalState, setProposalState] = useState<ProposalState>("proposed");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<readonly ChatMessage[]>([initialChatMessage]);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectTab(index: number): void {
    const tab = tabs[index];

    if (tab === undefined) {
      return;
    }

    setSelectedTab(tab);
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;

    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    selectTab(nextIndex);
  }

  function submitChatMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const message = draft.trim();

    if (message === "") {
      return;
    }

    setMessages((current) => [
      ...current,
      {
        id: `message-owner-${current.length}`,
        author: "owner",
        content: message,
      },
      {
        id: `message-agent-${current.length + 1}`,
        author: "agent",
        content: "I'll keep this request in the separate setup session for Mac Studio.",
      },
    ]);
    setDraft("");
  }

  return (
    <div className="app-shell">
      <DeviceRail device={firstRunDevice} />

      <main className="device-main">
        <DeviceHeader device={firstRunDevice} onConfigure={() => setChatOpen(true)} />

        <div className="device-tabs" role="tablist" aria-label="Device sections">
          {tabs.map((tab, index) => {
            const selected = selectedTab === tab;

            return (
              <button
                aria-controls={`device-panel-${index}`}
                aria-selected={selected}
                className="device-tab"
                id={`device-tab-${index}`}
                key={tab}
                onClick={() => setSelectedTab(tab)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {tab}
              </button>
            );
          })}
        </div>

        <section
          aria-labelledby={`device-tab-${tabs.indexOf(selectedTab)}`}
          className="tab-panel"
          id={`device-panel-${tabs.indexOf(selectedTab)}`}
          role="tabpanel"
        >
          {selectedTab === "Overview" ? (
            <DeviceOverview device={firstRunDevice} />
          ) : (
            <div className="deferred-tab" aria-live="polite">
              <span className="sr-only">{selectedTab} view selected.</span>
            </div>
          )}
        </section>
      </main>

      {chatOpen ? (
        <ConfigurationChat
          draft={draft}
          expanded={chatExpanded}
          messages={messages}
          onChangeDraft={setDraft}
          onClose={() => setChatOpen(false)}
          onDismissProposal={() => setProposalState("dismissed")}
          onReviewProposal={() => setProposalState("reviewing")}
          onSubmit={submitChatMessage}
          onToggleExpanded={() => setChatExpanded((current) => !current)}
          proposalState={proposalState}
        />
      ) : null}

      <button
        aria-label="Toggle Configuration Chat"
        className={`chat-launcher${chatOpen ? " chat-launcher--open" : ""}`}
        onClick={() => setChatOpen((current) => !current)}
        type="button"
      >
        <MessageCircle aria-hidden="true" />
      </button>
    </div>
  );
}

function DeviceRail({ device }: { readonly device: DeviceOverviewViewModel }): React.JSX.Element {
  return (
    <aside className="device-rail">
      <div className="brand">
        <Network aria-hidden="true" className="brand-icon" />
        <span className="brand-word">OpenDelegate</span>
      </div>

      <p className="rail-heading">Devices</p>
      <button
        aria-current="page"
        aria-label={`${device.name}, Main, Online`}
        className="device-selector"
        type="button"
      >
        <Network aria-hidden="true" />
        <span className="device-selector-copy">
          <strong>{device.name}</strong>
          <span>
            Main <span aria-hidden="true">·</span>{" "}
            <span className="inline-status">
              <StatusDot />
              Online
            </span>
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="device-chevron" />
      </button>

      <nav aria-label="Admin sections" className="primary-navigation">
        <NavigationItem icon={ClipboardCheck} label="Tasks" />
        <NavigationItem icon={ShieldCheck} label="Approvals" />
        <NavigationItem icon={Folder} label="Artifacts" />
        <NavigationItem icon={FileClock} label="Audit" />
      </nav>

      <button aria-label="Join a device" className="join-device" type="button">
        <CirclePlus aria-hidden="true" />
        <span>Join a device</span>
      </button>
    </aside>
  );
}

function NavigationItem({
  icon: Icon,
  label,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
}): React.JSX.Element {
  return (
    <button aria-label={label} className="navigation-item" type="button">
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function DeviceHeader({
  device,
  onConfigure,
}: {
  readonly device: DeviceOverviewViewModel;
  readonly onConfigure: () => void;
}): React.JSX.Element {
  return (
    <header className="device-header">
      <div>
        <h1>{device.name}</h1>
        <p>
          Main computer <span aria-hidden="true">·</span> macOS <span aria-hidden="true">·</span>{" "}
          <span className="inline-status">
            <StatusDot />
            Online
          </span>
        </p>
        <span className="sr-only">{device.headerSummary}</span>
      </div>
      <button className="primary-button" onClick={onConfigure} type="button">
        <Settings aria-hidden="true" />
        Configure
      </button>
    </header>
  );
}

function DeviceOverview({
  device,
}: {
  readonly device: DeviceOverviewViewModel;
}): React.JSX.Element {
  return (
    <div className="overview-grid">
      <DetailSection title="Device facts">
        <dl className="key-value-list">
          {device.facts.map((fact) => (
            <div className="key-value-row" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd className={fact.state === "success" ? "status-success" : ""}>
                {fact.state === "success" ? <StatusDot /> : null}
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </DetailSection>

      <DetailSection title="Roles">
        <ul className="role-list">
          {device.roles.map((role) => (
            <li key={role}>
              <UserRound aria-hidden="true" />
              {role}
            </li>
          ))}
        </ul>
      </DetailSection>

      <DetailSection title="Capabilities">
        <ul className="capability-list">
          {device.capabilities.map((capability) => (
            <CapabilityRow capability={capability} key={capability.capabilityId} />
          ))}
        </ul>
      </DetailSection>

      <DetailSection title="Transport routes">
        <ol className="route-list">
          {device.routes.map((route) => (
            <li key={route.order}>
              <span className="route-order">{route.order}</span>
              <span className="route-name">{route.label}</span>
              <span className={`route-summary route-summary--${route.tone}`}>
                <StatusDot tone={route.tone} />
                {route.summary}
              </span>
            </li>
          ))}
        </ol>
      </DetailSection>

      <DetailSection title="Current work">
        <div className="empty-work">
          <Inbox aria-hidden="true" />
          <span>No active runs</span>
        </div>
      </DetailSection>

      <section aria-label="Knowledge health" className="detail-section">
        <h2>Knowledge health</h2>
        <div className="knowledge-health">
          <BookOpen aria-hidden="true" />
          <span>Local Knowledge</span>
          <span className="status-success">
            <StatusDot />
            {device.knowledge.status}
          </span>
        </div>
      </section>
    </div>
  );
}

function DetailSection({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}): React.JSX.Element {
  return (
    <section className="detail-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function CapabilityRow({ capability }: { readonly capability: CapabilityView }): React.JSX.Element {
  const Icon =
    capability.capabilityId === "codex"
      ? Code2
      : capability.capabilityId === "claude"
        ? MessagesSquare
        : capability.capabilityId === "computer-use"
          ? Monitor
          : Globe2;

  return (
    <li>
      <Icon aria-hidden="true" />
      <span>{capability.label}</span>
      <span className={`capability-state capability-state--${capability.tone}`}>
        {capability.tone === "success" ? (
          <CheckCircle2 aria-hidden="true" />
        ) : (
          <StatusDot tone="accent" />
        )}
        {capability.state}
      </span>
    </li>
  );
}

function ConfigurationChat({
  draft,
  expanded,
  messages,
  onChangeDraft,
  onClose,
  onDismissProposal,
  onReviewProposal,
  onSubmit,
  onToggleExpanded,
  proposalState,
}: {
  readonly draft: string;
  readonly expanded: boolean;
  readonly messages: readonly ChatMessage[];
  readonly onChangeDraft: (value: string) => void;
  readonly onClose: () => void;
  readonly onDismissProposal: () => void;
  readonly onReviewProposal: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onToggleExpanded: () => void;
  readonly proposalState: ProposalState;
}): React.JSX.Element {
  return (
    <aside
      aria-labelledby="configuration-chat-title"
      aria-modal="false"
      className={`configuration-chat${expanded ? " configuration-chat--expanded" : ""}`}
      role="dialog"
    >
      <header className="chat-header">
        <div>
          <h2 id="configuration-chat-title">Configuration Chat</h2>
          <p>Separate setup session</p>
        </div>
        <div className="chat-header-actions">
          <button
            aria-label={expanded ? "Restore Configuration Chat" : "Expand Configuration Chat"}
            onClick={onToggleExpanded}
            type="button"
          >
            <Expand aria-hidden="true" />
          </button>
          <button aria-label="Collapse Configuration Chat" onClick={onClose} type="button">
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <div aria-live="polite" className="chat-messages">
        {messages.map((message) => (
          <div className={`chat-message chat-message--${message.author}`} key={message.id}>
            {message.author === "agent" ? (
              <span className="agent-avatar">
                <Network aria-hidden="true" />
              </span>
            ) : null}
            <p>{message.content}</p>
          </div>
        ))}
      </div>

      {proposalState !== "dismissed" ? (
        <>
          <section aria-label="Proposed change" className="proposal-panel">
            <h3>Proposed change</h3>
            {proposalState === "reviewing" ? (
              <div className="proposal-diff">
                <div>
                  <UserRound aria-hidden="true" />
                  <span>Add role</span>
                  <strong data-testid="role-diff">
                    <span aria-hidden="true">+</span>Computer Use
                  </strong>
                </div>
                <div>
                  <ShieldCheck aria-hidden="true" />
                  <span>Verify capability</span>
                  <strong data-testid="capability-diff">
                    computer-use
                    <span>Detected</span>
                    <span aria-hidden="true">→</span>
                    <span>Verified</span>
                  </strong>
                </div>
              </div>
            ) : (
              <div className="proposal-summary">
                <div>
                  <UserRound aria-hidden="true" />
                  <span>Add role</span>
                  <strong>Computer Use</strong>
                </div>
                <div>
                  <ShieldCheck aria-hidden="true" />
                  <span>Verify capability</span>
                  <strong>computer-use</strong>
                </div>
              </div>
            )}
          </section>
          <div className="proposal-actions">
            <button className="primary-button" onClick={onReviewProposal} type="button">
              {proposalState === "reviewing" ? <Check aria-hidden="true" /> : null}
              Review change
            </button>
            <button className="secondary-button" onClick={onDismissProposal} type="button">
              Not now
            </button>
          </div>
        </>
      ) : null}

      <form className="chat-composer" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="configuration-chat-message">
          Message Configuration Chat
        </label>
        <input
          id="configuration-chat-message"
          onChange={(event) => onChangeDraft(event.target.value)}
          placeholder="Ask about this Device…"
          value={draft}
        />
        <button aria-label="Send message" disabled={draft.trim() === ""} type="submit">
          <Send aria-hidden="true" />
        </button>
      </form>
    </aside>
  );
}

function StatusDot({
  tone = "success",
}: {
  readonly tone?: "success" | "accent" | "muted";
}): React.JSX.Element {
  return <span aria-hidden="true" className={`status-dot status-dot--${tone}`} />;
}
