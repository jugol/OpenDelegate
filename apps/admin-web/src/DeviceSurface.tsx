import {
  BookOpen,
  CheckCircle2,
  CirclePlus,
  ClipboardCheck,
  Code2,
  FileClock,
  Folder,
  Globe2,
  Inbox,
  MessagesSquare,
  Monitor,
  Network,
  Settings,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { localizeCapabilityState, localizePresentationText, useAdminI18n } from "./i18n";
import { LanguageSelector } from "./LanguageSelector";
import {
  type CapabilityView,
  type DeviceOverviewViewModel,
  presentationTextFallback,
  type StatusTone,
} from "./view-model";

const tabKeys = ["overview", "capabilities", "rolesInstructions", "routes", "runs"] as const;

export type AdminSection = "devices" | "tasks";

interface DeviceSurfaceProps {
  readonly chatOpen: boolean;
  readonly device: DeviceOverviewViewModel;
  readonly onConfigure: (trigger: HTMLButtonElement) => void;
}

export function DeviceSurface({
  chatOpen,
  device,
  onConfigure,
}: DeviceSurfaceProps): React.JSX.Element {
  const { messages } = useAdminI18n();

  return (
    <main className="device-main">
      <DeviceHeader chatOpen={chatOpen} device={device} onConfigure={onConfigure} />

      <div className="device-tabs" role="tablist" aria-label={messages.device.sections}>
        {tabKeys.map((tabKey, index) => {
          const selected = index === 0;

          return (
            <button
              aria-controls={selected ? "device-panel-overview" : undefined}
              aria-description={selected ? undefined : messages.common.laterPhase}
              aria-disabled={!selected}
              aria-selected={selected}
              className="device-tab"
              disabled={!selected}
              id={`device-tab-${index}`}
              key={tabKey}
              role="tab"
              tabIndex={selected ? 0 : -1}
              title={selected ? undefined : messages.common.laterPhase}
              type="button"
            >
              {messages.device[tabKey]}
            </button>
          );
        })}
      </div>

      <section
        aria-labelledby="device-tab-0"
        className="tab-panel"
        id="device-panel-overview"
        role="tabpanel"
        tabIndex={0}
      >
        <DeviceOverview device={device} />
      </section>
    </main>
  );
}

export function AdminRail({
  activeSection,
  device,
  onSelectSection,
  tasksEnabled = true,
}: {
  readonly activeSection: AdminSection;
  readonly device: DeviceOverviewViewModel;
  readonly onSelectSection: (section: AdminSection) => void;
  readonly tasksEnabled?: boolean;
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  const roleLabel = localizePresentationText(device.roleLabel, messages);
  const connectionLabel = localizePresentationText(device.connection.label, messages);
  const navigationLabel = `${device.name}, ${roleLabel}, ${connectionLabel}`;

  return (
    <aside className="device-rail">
      <div className="brand">
        <Network aria-hidden="true" className="brand-icon" />
        <span className="brand-word">OpenDelegate</span>
      </div>

      <p className="rail-heading">{messages.navigation.devices}</p>
      <button
        aria-current={activeSection === "devices" ? "page" : undefined}
        aria-label={navigationLabel}
        className={`device-selector ${
          activeSection === "devices" ? "device-selector--selected" : ""
        }`}
        onClick={() => onSelectSection("devices")}
        type="button"
      >
        <Network aria-hidden="true" />
        <span className="device-selector-copy">
          <strong>{device.name}</strong>
          <span>
            {roleLabel} <span aria-hidden="true">·</span>{" "}
            <span className={`inline-status status-${device.connection.tone}`}>
              <StatusDot tone={device.connection.tone} />
              {connectionLabel}
            </span>
          </span>
        </span>
      </button>

      <nav aria-label={messages.navigation.adminSections} className="primary-navigation">
        <NavigationItem
          active={activeSection === "tasks"}
          icon={ClipboardCheck}
          label={messages.navigation.tasks}
          {...(tasksEnabled ? { onClick: () => onSelectSection("tasks") } : {})}
        />
        <NavigationItem icon={ShieldCheck} label={messages.navigation.approvals} />
        <NavigationItem icon={Folder} label={messages.navigation.artifacts} />
        <NavigationItem icon={FileClock} label={messages.navigation.audit} />
      </nav>

      <div className="rail-utilities">
        <LanguageSelector placement="rail" />
        <button
          aria-label={messages.navigation.joinDevice}
          aria-description={messages.common.laterPhase}
          className="join-device"
          disabled
          title={messages.common.laterPhase}
          type="button"
        >
          <CirclePlus aria-hidden="true" />
          <span>{messages.navigation.joinDevice}</span>
        </button>
      </div>
    </aside>
  );
}

function NavigationItem({
  active = false,
  icon: Icon,
  label,
  onClick,
}: {
  readonly active?: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onClick?: () => void;
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-description={onClick === undefined ? messages.common.laterPhase : undefined}
      aria-label={label}
      className={`navigation-item ${active ? "navigation-item--active" : ""}`}
      disabled={onClick === undefined}
      onClick={onClick}
      title={onClick === undefined ? messages.common.laterPhase : undefined}
      type="button"
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function DeviceHeader({ chatOpen, device, onConfigure }: DeviceSurfaceProps): React.JSX.Element {
  const { messages } = useAdminI18n();
  const deviceTypeLabel = localizePresentationText(device.deviceTypeLabel, messages);
  const connectionLabel = localizePresentationText(device.connection.label, messages);
  const headerSummary = `${deviceTypeLabel} · ${device.operatingSystem} · ${connectionLabel}`;

  return (
    <header className="device-header">
      <div>
        <h1>{device.name}</h1>
        <p aria-label={headerSummary}>
          {deviceTypeLabel} <span aria-hidden="true">·</span> {device.operatingSystem}{" "}
          <span aria-hidden="true">·</span>{" "}
          <span className={`inline-status status-${device.connection.tone}`}>
            <StatusDot tone={device.connection.tone} />
            {connectionLabel}
          </span>
        </p>
      </div>
      <button
        aria-controls="configuration-chat"
        aria-expanded={chatOpen}
        className="primary-button"
        onClick={(event) => onConfigure(event.currentTarget)}
        type="button"
      >
        <Settings aria-hidden="true" />
        {messages.device.configure}
      </button>
    </header>
  );
}

function DeviceOverview({
  device,
}: {
  readonly device: DeviceOverviewViewModel;
}): React.JSX.Element {
  const { messages } = useAdminI18n();

  return (
    <div className="overview-grid">
      <DetailSection area="facts" title={messages.device.facts}>
        <dl className="key-value-list">
          {device.facts.map((fact) => (
            <div className="key-value-row" key={presentationTextFallback(fact.label)}>
              <dt>{localizePresentationText(fact.label, messages)}</dt>
              <dd>{localizePresentationText(fact.value, messages)}</dd>
            </div>
          ))}
        </dl>
      </DetailSection>

      <DetailSection area="roles" title={messages.device.roles}>
        <ul className="role-list">
          {device.roles.map((role) => (
            <li key={presentationTextFallback(role)}>
              <UserRound aria-hidden="true" />
              {localizePresentationText(role, messages)}
            </li>
          ))}
        </ul>
      </DetailSection>

      <DetailSection area="runtime" title={messages.device.runtimeStatus}>
        <dl className="key-value-list">
          {device.runtimeStatuses.map((status) => (
            <div className="key-value-row" key={presentationTextFallback(status.label)}>
              <dt>{localizePresentationText(status.label, messages)}</dt>
              <dd className={`status-${status.tone}`}>
                <StatusDot tone={status.tone} />
                {localizePresentationText(status.value, messages)}
              </dd>
            </div>
          ))}
        </dl>
      </DetailSection>

      <DetailSection area="routes" title={messages.device.transportRoutes}>
        <ol className="route-list">
          {device.routes.map((route) => (
            <li key={route.order}>
              <span className="route-order">{route.order}</span>
              <span className="route-name">{localizePresentationText(route.label, messages)}</span>
              <span className={`route-summary status-${route.tone}`}>
                <StatusDot tone={route.tone} />
                {localizePresentationText(route.summary, messages)}
              </span>
            </li>
          ))}
        </ol>
      </DetailSection>

      <DetailSection area="capabilities" title={messages.device.capabilities}>
        <ul className="capability-list">
          {device.capabilities.map((capability) => (
            <CapabilityRow capability={capability} key={capability.capabilityId} />
          ))}
        </ul>
      </DetailSection>

      <DetailSection area="knowledge" title={messages.device.knowledgeHealth}>
        <div className="knowledge-health">
          <BookOpen aria-hidden="true" />
          <span>{localizePresentationText(device.knowledge.label, messages)}</span>
          <span className={`status-${device.knowledge.tone}`}>
            <StatusDot tone={device.knowledge.tone} />
            {localizePresentationText(device.knowledge.status, messages)}
          </span>
        </div>
      </DetailSection>

      <DetailSection area="work" title={messages.device.currentWork}>
        <div className="empty-work">
          <Inbox aria-hidden="true" />
          <span>{localizePresentationText(device.currentWork.summary, messages)}</span>
        </div>
      </DetailSection>
    </div>
  );
}

function DetailSection({
  area,
  children,
  title,
}: {
  readonly area: string;
  readonly children: React.ReactNode;
  readonly title: string;
}): React.JSX.Element {
  const sectionId = `device-section-${area}`;

  return (
    <section aria-labelledby={sectionId} className={`detail-section detail-section--${area}`}>
      <h2 id={sectionId}>{title}</h2>
      {children}
    </section>
  );
}

function CapabilityRow({ capability }: { readonly capability: CapabilityView }): React.JSX.Element {
  const { messages } = useAdminI18n();
  const Icon =
    capability.capabilityId === "codex"
      ? Code2
      : capability.capabilityId === "claude-code"
        ? MessagesSquare
        : capability.capabilityId === "computer-use"
          ? Monitor
          : Globe2;

  return (
    <li>
      <Icon aria-hidden="true" />
      <span>{localizePresentationText(capability.label, messages)}</span>
      <span className={`capability-state status-${capability.tone}`}>
        {capability.tone === "success" ? (
          <CheckCircle2 aria-hidden="true" />
        ) : (
          <StatusDot tone={capability.tone} />
        )}
        {localizeCapabilityState(capability.state, messages)}
      </span>
    </li>
  );
}

export function StatusDot({ tone = "success" }: { readonly tone?: StatusTone }): React.JSX.Element {
  return <span aria-hidden="true" className={`status-dot status-dot--${tone}`} />;
}
