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

import { type CapabilityView, type DeviceOverviewViewModel, type StatusTone } from "./view-model";

const tabs = ["Overview", "Capabilities", "Roles & Instructions", "Routes", "Runs"] as const;

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
  return (
    <main className="device-main">
      <DeviceHeader chatOpen={chatOpen} device={device} onConfigure={onConfigure} />

      <div className="device-tabs" role="tablist" aria-label="Device sections">
        {tabs.map((tab, index) => {
          const selected = index === 0;

          return (
            <button
              aria-controls={selected ? "device-panel-overview" : undefined}
              aria-disabled={!selected}
              aria-selected={selected}
              className="device-tab"
              disabled={!selected}
              id={`device-tab-${index}`}
              key={tab}
              role="tab"
              tabIndex={selected ? 0 : -1}
              title={selected ? undefined : "Available in a later implementation phase"}
              type="button"
            >
              {tab}
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
  const navigationLabel = `${device.name}, ${device.roleLabel}, ${device.connection.label}`;

  return (
    <aside className="device-rail">
      <div className="brand">
        <Network aria-hidden="true" className="brand-icon" />
        <span className="brand-word">OpenDelegate</span>
      </div>

      <p className="rail-heading">Devices</p>
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
            {device.roleLabel} <span aria-hidden="true">·</span>{" "}
            <span className={`inline-status status-${device.connection.tone}`}>
              <StatusDot tone={device.connection.tone} />
              {device.connection.label}
            </span>
          </span>
        </span>
      </button>

      <nav aria-label="Admin sections" className="primary-navigation">
        <NavigationItem
          active={activeSection === "tasks"}
          icon={ClipboardCheck}
          label="Tasks"
          {...(tasksEnabled ? { onClick: () => onSelectSection("tasks") } : {})}
        />
        <NavigationItem icon={ShieldCheck} label="Approvals" />
        <NavigationItem icon={Folder} label="Artifacts" />
        <NavigationItem icon={FileClock} label="Audit" />
      </nav>

      <button
        aria-label="Join a device"
        className="join-device"
        disabled
        title="Available in a later implementation phase"
        type="button"
      >
        <CirclePlus aria-hidden="true" />
        <span>Join a device</span>
      </button>
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
  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className={`navigation-item ${active ? "navigation-item--active" : ""}`}
      disabled={onClick === undefined}
      onClick={onClick}
      title={onClick === undefined ? "Available in a later implementation phase" : undefined}
      type="button"
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function DeviceHeader({ chatOpen, device, onConfigure }: DeviceSurfaceProps): React.JSX.Element {
  const headerSummary = `${device.deviceTypeLabel} · ${device.operatingSystem} · ${device.connection.label}`;

  return (
    <header className="device-header">
      <div>
        <h1>{device.name}</h1>
        <p aria-label={headerSummary}>
          {device.deviceTypeLabel} <span aria-hidden="true">·</span> {device.operatingSystem}{" "}
          <span aria-hidden="true">·</span>{" "}
          <span className={`inline-status status-${device.connection.tone}`}>
            <StatusDot tone={device.connection.tone} />
            {device.connection.label}
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
      <DetailSection area="facts" title="Device facts">
        <dl className="key-value-list">
          {device.facts.map((fact) => (
            <div className="key-value-row" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </DetailSection>

      <DetailSection area="roles" title="Roles">
        <ul className="role-list">
          {device.roles.map((role) => (
            <li key={role}>
              <UserRound aria-hidden="true" />
              {role}
            </li>
          ))}
        </ul>
      </DetailSection>

      <DetailSection area="runtime" title="Runtime status">
        <dl className="key-value-list">
          {device.runtimeStatuses.map((status) => (
            <div className="key-value-row" key={status.label}>
              <dt>{status.label}</dt>
              <dd className={`status-${status.tone}`}>
                <StatusDot tone={status.tone} />
                {status.value}
              </dd>
            </div>
          ))}
        </dl>
      </DetailSection>

      <DetailSection area="routes" title="Transport routes">
        <ol className="route-list">
          {device.routes.map((route) => (
            <li key={route.order}>
              <span className="route-order">{route.order}</span>
              <span className="route-name">{route.label}</span>
              <span className={`route-summary status-${route.tone}`}>
                <StatusDot tone={route.tone} />
                {route.summary}
              </span>
            </li>
          ))}
        </ol>
      </DetailSection>

      <DetailSection area="capabilities" title="Capabilities">
        <ul className="capability-list">
          {device.capabilities.map((capability) => (
            <CapabilityRow capability={capability} key={capability.capabilityId} />
          ))}
        </ul>
      </DetailSection>

      <DetailSection area="knowledge" title="Knowledge health">
        <div className="knowledge-health">
          <BookOpen aria-hidden="true" />
          <span>{device.knowledge.label}</span>
          <span className={`status-${device.knowledge.tone}`}>
            <StatusDot tone={device.knowledge.tone} />
            {device.knowledge.status}
          </span>
        </div>
      </DetailSection>

      <DetailSection area="work" title="Current work">
        <div className="empty-work">
          <Inbox aria-hidden="true" />
          <span>{device.currentWork.summary}</span>
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
      <span>{capability.label}</span>
      <span className={`capability-state status-${capability.tone}`}>
        {capability.tone === "success" ? (
          <CheckCircle2 aria-hidden="true" />
        ) : (
          <StatusDot tone={capability.tone} />
        )}
        {capability.state}
      </span>
    </li>
  );
}

export function StatusDot({ tone = "success" }: { readonly tone?: StatusTone }): React.JSX.Element {
  return <span aria-hidden="true" className={`status-dot status-dot--${tone}`} />;
}
