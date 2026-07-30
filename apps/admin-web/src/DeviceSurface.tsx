import {
  BookOpen,
  Bot,
  CheckCircle2,
  CircleHelp,
  CirclePlus,
  ClipboardCheck,
  Code2,
  FileClock,
  Folder,
  Globe2,
  Inbox,
  LockKeyhole,
  MessagesSquare,
  Monitor,
  Network,
  Power,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";

import {
  formatAdminDate,
  formatMessage,
  localizeAdapterCompatibility,
  localizeAdapterReadiness,
  localizeApprovalActionCategory,
  localizeCapabilityState,
  localizeCurrentRunState,
  localizePolicyScope,
  localizePresentationText,
  type Messages,
  useAdminI18n,
} from "./i18n";
import { LanguageSelector } from "./LanguageSelector";
import {
  type AgentBindingView,
  type AgentExecutionProfileView,
  type CapabilityView,
  type DeviceOverviewViewModel,
  presentationTextFallback,
  type StatusTone,
} from "./view-model";

const tabKeys = [
  "overview",
  "capabilities",
  "rolesInstructions",
  "routes",
  "authority",
  "runs",
] as const;
type DeviceTabKey = (typeof tabKeys)[number];

export type AdminSection = "devices" | "tasks" | "approvals" | "artifacts" | "audit" | "join";

interface DeviceSurfaceProps {
  readonly chatOpen: boolean;
  readonly device: DeviceOverviewViewModel;
  readonly onAssess?: () => Promise<void>;
  readonly onConfigure: (trigger: HTMLButtonElement) => void;
  readonly onConfigureAgentProfile: (message: string, trigger: HTMLButtonElement) => void;
}

export function DeviceSurface({
  chatOpen,
  device,
  onAssess,
  onConfigure,
  onConfigureAgentProfile,
}: DeviceSurfaceProps): React.JSX.Element {
  const { messages } = useAdminI18n();
  const [activeTab, setActiveTab] = useState<DeviceTabKey>("overview");
  const [assessmentPending, setAssessmentPending] = useState(false);
  const [assessmentFailed, setAssessmentFailed] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  async function assessDevice(): Promise<void> {
    if (onAssess === undefined || assessmentPending) {
      return;
    }
    setAssessmentPending(true);
    setAssessmentFailed(false);
    try {
      await onAssess();
    } catch {
      setAssessmentFailed(true);
    } finally {
      setAssessmentPending(false);
    }
  }

  function selectTab(index: number): void {
    const normalizedIndex = (index + tabKeys.length) % tabKeys.length;
    const tab = tabKeys[normalizedIndex];
    if (tab === undefined) {
      return;
    }
    setActiveTab(tab);
    tabRefs.current[normalizedIndex]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = index - 1;
        break;
      case "ArrowRight":
        nextIndex = index + 1;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabKeys.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectTab(nextIndex);
  }

  return (
    <main className="device-main">
      <DeviceHeader chatOpen={chatOpen} device={device} onConfigure={onConfigure} />
      {onAssess === undefined ? null : (
        <LocalAgentSetup
          failed={assessmentFailed}
          onAssess={() => void assessDevice()}
          pending={assessmentPending}
        />
      )}

      <div className="device-tabs" role="tablist" aria-label={messages.device.sections}>
        {tabKeys.map((tabKey, index) => {
          const selected = tabKey === activeTab;

          return (
            <button
              aria-controls={`device-panel-${tabKey}`}
              aria-selected={selected}
              className="device-tab"
              onClick={() => setActiveTab(tabKey)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              id={`device-tab-${index}`}
              key={tabKey}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {messages.device[tabKey]}
            </button>
          );
        })}
      </div>

      <section
        aria-labelledby={`device-tab-${tabKeys.indexOf(activeTab)}`}
        className="tab-panel"
        id={`device-panel-${activeTab}`}
        role="tabpanel"
        tabIndex={0}
      >
        <DeviceTabPanel
          activeTab={activeTab}
          device={device}
          onConfigureAgentProfile={onConfigureAgentProfile}
        />
      </section>
    </main>
  );
}

export function AdminRail({
  activeSection,
  devices,
  onSelectDevice,
  onSelectSection,
  selectedDeviceId,
  tasksEnabled = true,
  approvalsEnabled = true,
  artifactsEnabled = true,
  auditEnabled = true,
  joinEnabled = true,
}: {
  readonly activeSection: AdminSection;
  readonly approvalsEnabled?: boolean;
  readonly artifactsEnabled?: boolean;
  readonly auditEnabled?: boolean;
  readonly devices: readonly DeviceOverviewViewModel[];
  readonly onSelectDevice: (deviceId: string) => void;
  readonly onSelectSection: (section: AdminSection) => void;
  readonly selectedDeviceId: string;
  readonly joinEnabled?: boolean;
  readonly tasksEnabled?: boolean;
}): React.JSX.Element {
  const { messages } = useAdminI18n();

  return (
    <aside className="device-rail">
      <div className="brand">
        <Network aria-hidden="true" className="brand-icon" />
        <span className="brand-word">OpenDelegate</span>
      </div>

      <p className="rail-heading" id="device-list-heading">
        {messages.navigation.devices}
      </p>
      <ul aria-labelledby="device-list-heading" className="device-list">
        {devices.map((device) => (
          <li key={device.deviceId}>
            <DeviceSelector
              active={activeSection === "devices" && selectedDeviceId === device.deviceId}
              device={device}
              onSelect={() => onSelectDevice(device.deviceId)}
            />
          </li>
        ))}
      </ul>

      <nav aria-label={messages.navigation.adminSections} className="primary-navigation">
        <NavigationItem
          active={activeSection === "tasks"}
          icon={ClipboardCheck}
          label={messages.navigation.tasks}
          {...(tasksEnabled ? { onClick: () => onSelectSection("tasks") } : {})}
        />
        <NavigationItem
          active={activeSection === "approvals"}
          icon={ShieldCheck}
          label={messages.navigation.approvals}
          {...(approvalsEnabled ? { onClick: () => onSelectSection("approvals") } : {})}
        />
        <NavigationItem
          active={activeSection === "artifacts"}
          icon={Folder}
          label={messages.navigation.artifacts}
          {...(artifactsEnabled ? { onClick: () => onSelectSection("artifacts") } : {})}
        />
        <NavigationItem
          active={activeSection === "audit"}
          icon={FileClock}
          label={messages.navigation.audit}
          {...(auditEnabled ? { onClick: () => onSelectSection("audit") } : {})}
        />
      </nav>

      <div className="rail-utilities">
        <LanguageSelector placement="rail" />
        <button
          aria-current={activeSection === "join" ? "page" : undefined}
          aria-label={messages.navigation.joinDevice}
          aria-description={joinEnabled ? undefined : messages.common.laterPhase}
          className={`join-device ${activeSection === "join" ? "join-device--active" : ""}`}
          disabled={!joinEnabled}
          onClick={joinEnabled ? () => onSelectSection("join") : undefined}
          title={joinEnabled ? undefined : messages.common.laterPhase}
          type="button"
        >
          <CirclePlus aria-hidden="true" />
          <span>{messages.navigation.joinDevice}</span>
        </button>
      </div>
    </aside>
  );
}

function DeviceSelector({
  active,
  device,
  onSelect,
}: {
  readonly active: boolean;
  readonly device: DeviceOverviewViewModel;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  const roleLabel = localizePresentationText(device.roleLabel, messages);
  const connectionLabel = localizePresentationText(device.connection.label, messages);
  const navigationLabel = `${device.name}, ${roleLabel}, ${connectionLabel}`;
  const Icon = device.role === "main" ? Network : device.osFamily === "linux" ? Server : Monitor;

  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={navigationLabel}
      className={`device-selector ${active ? "device-selector--selected" : ""}`}
      onClick={onSelect}
      title={navigationLabel}
      type="button"
    >
      <Icon aria-hidden="true" />
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

function LocalAgentSetup({
  failed,
  onAssess,
  pending,
}: {
  readonly failed: boolean;
  readonly onAssess: () => void;
  readonly pending: boolean;
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  return (
    <section aria-labelledby="local-agent-setup-title" className="local-agent-setup">
      <div className="local-agent-setup__icon">
        <Bot aria-hidden="true" />
      </div>
      <div className="local-agent-setup__copy">
        <h2 id="local-agent-setup-title">{messages.device.localAgentSetup}</h2>
        <p>{messages.device.localAgentSetupIntro}</p>
        <ul>
          <li>{messages.device.codexSetupGuide}</li>
          <li>{messages.device.claudeSetupGuide}</li>
        </ul>
        <p className="local-agent-setup__note">
          <LockKeyhole aria-hidden="true" />
          <span>{messages.device.agentCredentialNote}</span>
        </p>
        {failed ? (
          <p className="local-agent-setup__error" role="alert">
            {messages.device.assessmentFailed}
          </p>
        ) : null}
      </div>
      <div className="local-agent-setup__action">
        <p>{messages.device.assessmentScope}</p>
        <button className="secondary-button" disabled={pending} onClick={onAssess} type="button">
          <RefreshCw aria-hidden="true" className={pending ? "spin" : undefined} />
          {pending ? messages.device.assessingDevice : messages.device.assessDevice}
        </button>
      </div>
    </section>
  );
}

function DeviceHeader({
  chatOpen,
  device,
  onConfigure,
}: Pick<DeviceSurfaceProps, "chatOpen" | "device" | "onConfigure">): React.JSX.Element {
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

function DeviceTabPanel({
  activeTab,
  device,
  onConfigureAgentProfile,
}: {
  readonly activeTab: DeviceTabKey;
  readonly device: DeviceOverviewViewModel;
  readonly onConfigureAgentProfile: DeviceSurfaceProps["onConfigureAgentProfile"];
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  const wakeOnLan = wakeOnLanForDevice(device);
  switch (activeTab) {
    case "overview":
      return <DeviceOverview device={device} onConfigureAgentProfile={onConfigureAgentProfile} />;
    case "capabilities":
      return (
        <div className="focused-detail">
          <DetailSection area="capabilities" title={messages.device.capabilities}>
            <CapabilityList capabilities={device.capabilities} />
          </DetailSection>
        </div>
      );
    case "rolesInstructions":
      return (
        <div className="focused-detail focused-detail--split">
          <DetailSection area="roles" title={messages.device.roles}>
            <RoleList roles={device.roles} />
          </DetailSection>
          <DetailSection area="instructions" title={messages.device.instructions}>
            <InstructionList instructions={device.instructions} />
          </DetailSection>
        </div>
      );
    case "routes":
      return (
        <div
          className={`focused-detail${
            wakeOnLan === undefined ? "" : " focused-detail--split wake-on-lan-detail"
          }`}
        >
          <DetailSection area="routes" title={messages.device.transportRoutes}>
            <RouteList routes={device.routes} />
          </DetailSection>
          {wakeOnLan === undefined ? null : (
            <DetailSection area="wake-on-lan" title={messages.device.wakeOnLan}>
              <WakeOnLanPanel wakeOnLan={wakeOnLan} />
            </DetailSection>
          )}
        </div>
      );
    case "authority":
      return (
        <div className="focused-detail authority-detail">
          <DetailSection area="agent-profile" title={messages.device.agentExecution}>
            <AgentExecutionProfilePanel
              device={device}
              onConfigureAgentProfile={onConfigureAgentProfile}
            />
          </DetailSection>
          <DetailSection area="policies" title={messages.device.policies}>
            <PolicyList policies={device.policies} />
          </DetailSection>
          <DetailSection area="adapters" title={messages.device.agentAdapters}>
            <AgentAdapterList adapters={device.agentAdapters} />
          </DetailSection>
          <DetailSection area="locks" title={messages.device.resourceLocks}>
            <ResourceLockList locks={device.resourceLocks} />
          </DetailSection>
        </div>
      );
    case "runs":
      return (
        <div className="focused-detail">
          <DetailSection area="work" title={messages.device.currentWork}>
            <CurrentWork device={device} />
          </DetailSection>
        </div>
      );
  }
}

function DeviceOverview({
  device,
  onConfigureAgentProfile,
}: {
  readonly device: DeviceOverviewViewModel;
  readonly onConfigureAgentProfile: DeviceSurfaceProps["onConfigureAgentProfile"];
}): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const wakeOnLan = wakeOnLanForDevice(device);

  return (
    <div className="overview-grid">
      <DetailSection area="facts" title={messages.device.facts}>
        <dl className="key-value-list">
          {device.facts.map((fact) => (
            <div className="key-value-row" key={presentationTextFallback(fact.label)}>
              <dt>{localizePresentationText(fact.label, messages)}</dt>
              <dd>
                <span>{localizePresentationText(fact.value, messages)}</span>
                {fact.evidence === undefined ? null : (
                  <small className="fact-evidence">
                    {formatMessage(
                      fact.evidence.verification === "verified"
                        ? messages.device.verifiedEvidence
                        : messages.device.observedEvidence,
                      {
                        source: localizePresentationText(fact.evidence.source, messages),
                        time: formatAdminDate(
                          new Date(fact.evidence.observedAtMs).toISOString(),
                          locale,
                        ),
                      },
                    )}
                  </small>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </DetailSection>

      <DetailSection area="roles" title={messages.device.roles}>
        <RoleList roles={device.roles} />
        <h3 className="detail-subheading">{messages.device.instructions}</h3>
        <InstructionList instructions={device.instructions} />
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
          {device.lastObservation === undefined ? null : (
            <div className="key-value-row">
              <dt>{messages.device.lastDurableObservation}</dt>
              <dd>
                <span>
                  {formatAdminDate(
                    new Date(device.lastObservation.observedAtMs).toISOString(),
                    locale,
                  )}
                </span>
                <small className="fact-evidence">
                  {formatMessage(messages.device.acceptedByMainAt, {
                    time: formatAdminDate(
                      new Date(device.lastObservation.acceptedAtMs).toISOString(),
                      locale,
                    ),
                  })}
                </small>
              </dd>
            </div>
          )}
        </dl>
      </DetailSection>

      <DetailSection area="routes" title={messages.device.transportRoutes}>
        <RouteList routes={device.routes} />
      </DetailSection>

      {wakeOnLan === undefined ? null : (
        <DetailSection area="wake-on-lan" title={messages.device.wakeOnLan}>
          <WakeOnLanPanel wakeOnLan={wakeOnLan} />
        </DetailSection>
      )}

      <DetailSection area="capabilities" title={messages.device.capabilities}>
        <CapabilityList capabilities={device.capabilities} />
      </DetailSection>

      <DetailSection area="adapters" title={messages.device.agentAdapters}>
        <AgentAdapterList adapters={device.agentAdapters} />
      </DetailSection>

      <DetailSection area="agent-profile" title={messages.device.agentExecution}>
        <AgentExecutionProfilePanel
          device={device}
          onConfigureAgentProfile={onConfigureAgentProfile}
        />
      </DetailSection>

      <DetailSection area="policies" title={messages.device.policies}>
        <PolicyList policies={device.policies} />
      </DetailSection>

      <DetailSection area="locks" title={messages.device.resourceLocks}>
        <ResourceLockList locks={device.resourceLocks} />
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
        <CurrentWork device={device} />
      </DetailSection>
    </div>
  );
}

function RoleList({
  roles,
}: {
  readonly roles: DeviceOverviewViewModel["roles"];
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  if (roles.length === 0) {
    return <EmptyDetail text={messages.device.noRoles} />;
  }
  return (
    <ul className="role-list">
      {roles.map((role) => (
        <li key={presentationTextFallback(role)}>
          <UserRound aria-hidden="true" />
          {localizePresentationText(role, messages)}
        </li>
      ))}
    </ul>
  );
}

function InstructionList({
  instructions,
}: {
  readonly instructions: DeviceOverviewViewModel["instructions"];
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  if (instructions.length === 0) {
    return <EmptyDetail text={messages.device.noInstructions} />;
  }
  return (
    <ul className="instruction-list">
      {instructions.map((instruction) => (
        <li key={presentationTextFallback(instruction)}>
          <FileClock aria-hidden="true" />
          <span>{localizePresentationText(instruction, messages)}</span>
        </li>
      ))}
    </ul>
  );
}

function CapabilityList({
  capabilities,
}: {
  readonly capabilities: DeviceOverviewViewModel["capabilities"];
}): React.JSX.Element {
  return (
    <ul className="capability-list">
      {capabilities.map((capability) => (
        <CapabilityRow capability={capability} key={capability.capabilityId} />
      ))}
    </ul>
  );
}

function RouteList({
  routes,
}: {
  readonly routes: DeviceOverviewViewModel["routes"];
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  if (routes.length === 0) {
    return <EmptyDetail text={messages.device.noRoutes} />;
  }
  return (
    <ol className="route-list">
      {routes.map((route) => (
        <li key={`${route.order}:${presentationTextFallback(route.label)}`}>
          <span className="route-order">{route.order}</span>
          <span className="route-name">{localizePresentationText(route.label, messages)}</span>
          <span className={`route-summary status-${route.tone}`}>
            <StatusDot tone={route.tone} />
            {localizePresentationText(route.summary, messages)}
            {route.detail === undefined ? null : <small>{route.detail}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function WakeOnLanPanel({
  wakeOnLan,
}: {
  readonly wakeOnLan: NonNullable<DeviceOverviewViewModel["wakeOnLan"]>;
}): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const target =
    wakeOnLan.targetState === "enabled"
      ? { label: messages.device.wakeTargetEnabled, tone: "success" as const }
      : wakeOnLan.targetState === "disabled"
        ? { label: messages.device.wakeTargetDisabled, tone: "muted" as const }
        : wakeOnLan.targetState === "unsupported"
          ? { label: messages.device.wakeTargetUnsupported, tone: "muted" as const }
          : { label: messages.device.wakeTargetUnknown, tone: "warning" as const };
  const automatic =
    wakeOnLan.automaticWakeState === "relay-required"
      ? {
          label: messages.device.automaticWakeRelayRequired,
          tone: "warning" as const,
          description: messages.device.wakeRelayRequiredDescription,
        }
      : wakeOnLan.automaticWakeState === "unavailable"
        ? {
            label: messages.device.automaticWakeUnavailable,
            tone: "muted" as const,
            description: messages.device.wakeUnavailableDescription,
          }
        : {
            label: messages.device.automaticWakeUnknown,
            tone: "warning" as const,
            description: messages.device.wakeUnknownDescription,
          };

  return (
    <div className="wake-on-lan-panel">
      <div className={`wake-on-lan-icon status-${automatic.tone}`}>
        <Power aria-hidden="true" />
      </div>
      <dl className="key-value-list">
        <div className="key-value-row">
          <dt>{messages.device.wakeTargetSetting}</dt>
          <dd className={`status-${target.tone}`}>
            <StatusDot tone={target.tone} />
            {target.label}
          </dd>
        </div>
        <div className="key-value-row">
          <dt>{messages.device.automaticWake}</dt>
          <dd className={`status-${automatic.tone}`}>
            <StatusDot tone={automatic.tone} />
            {automatic.label}
          </dd>
        </div>
      </dl>
      <p>{automatic.description}</p>
      <small>
        {wakeOnLan.observedAtMs === undefined
          ? messages.device.wakeNeverObserved
          : formatMessage(
              wakeOnLan.historical
                ? messages.device.wakeLastObserved
                : messages.device.wakeObserved,
              {
                time: formatAdminDate(new Date(wakeOnLan.observedAtMs).toISOString(), locale),
              },
            )}
      </small>
    </div>
  );
}

function wakeOnLanForDevice(device: DeviceOverviewViewModel): DeviceOverviewViewModel["wakeOnLan"] {
  if (device.role === "main") {
    return undefined;
  }
  return (
    device.wakeOnLan ?? {
      targetState: "unknown",
      automaticWakeState: "unknown",
      historical: false,
    }
  );
}

function CurrentWork({ device }: { readonly device: DeviceOverviewViewModel }): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const capacity =
    device.currentWork.maximumConcurrentRuns === undefined
      ? undefined
      : formatMessage(messages.device.runCapacity, {
          active: device.currentWork.activeRunCount,
          maximum: device.currentWork.maximumConcurrentRuns,
        });
  const outbox =
    device.currentWork.outboxDepth === undefined ||
    device.currentWork.maxOutboxEntries === undefined
      ? undefined
      : formatMessage(messages.device.outboxLoad, {
          depth: device.currentWork.outboxDepth,
          maximum: device.currentWork.maxOutboxEntries,
        });
  return (
    <div className="current-work-detail">
      <div className="work-capacity">
        {device.currentWork.acceptingWork === undefined ? null : (
          <span>
            <StatusDot tone={device.currentWork.acceptingWork ? "success" : "warning"} />
            {device.currentWork.acceptingWork
              ? messages.device.acceptingWork
              : messages.device.notAcceptingWork}
          </span>
        )}
        {capacity === undefined ? null : <span>{capacity}</span>}
        {outbox === undefined ? null : <span>{outbox}</span>}
      </div>
      {device.currentRuns.length === 0 ? (
        <div className="empty-work">
          <Inbox aria-hidden="true" />
          <span>{localizePresentationText(device.currentWork.summary, messages)}</span>
        </div>
      ) : (
        <ul className="run-list">
          {device.currentRuns.map((run) => (
            <li key={run.runId}>
              <strong>{formatMessage(messages.device.runIdentity, { runId: run.runId })}</strong>
              <span>
                {formatMessage(messages.device.runScope, {
                  taskId: run.taskId,
                  workOrderId: run.workOrderId,
                })}
              </span>
              <span>
                {formatMessage(messages.device.runLease, {
                  state: localizeCurrentRunState(run.state, messages),
                  time: formatAdminDate(new Date(run.leaseExpiresAtMs).toISOString(), locale),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PolicyList({
  policies,
}: {
  readonly policies: DeviceOverviewViewModel["policies"];
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  if (policies.length === 0) {
    return <EmptyDetail text={messages.device.noPolicies} />;
  }
  return (
    <ul className="policy-list">
      {policies.map((policy) => (
        <li key={policy.policyId}>
          <ShieldCheck aria-hidden="true" />
          <span>
            <strong>{localizeApprovalActionCategory(policy.actionCategory, messages)}</strong>
            <small>
              {policy.source === "built-in"
                ? messages.device.builtInPolicy
                : messages.device.configuredPolicy}{" "}
              · {localizePolicyScope(policy.effectiveScope, messages)}
            </small>
          </span>
          <span
            className={`status-${
              policy.decision === "allow"
                ? "success"
                : policy.decision === "deny"
                  ? "danger"
                  : "warning"
            }`}
          >
            {policy.decision === "allow"
              ? messages.device.policyAllow
              : policy.decision === "deny"
                ? messages.device.policyDeny
                : messages.device.policyApproval}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AgentAdapterList({
  adapters,
}: {
  readonly adapters: DeviceOverviewViewModel["agentAdapters"];
}): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  if (adapters.length === 0) {
    return <EmptyDetail text={messages.device.noAgentAdapters} />;
  }
  return (
    <ul className="adapter-list">
      {adapters.map((adapter) => (
        <li key={adapter.adapterId}>
          <Bot aria-hidden="true" />
          <span className="adapter-copy">
            <strong>{adapter.provider}</strong>
            <small>
              {adapter.adapterId}
              {adapter.version === undefined ? "" : ` · ${adapter.version}`}
            </small>
            {adapter.models.length === 0 ? null : (
              <span className="adapter-model-list">
                <small>
                  {formatMessage(messages.device.modelCatalog, {
                    count: adapter.models.length,
                  })}
                </small>
                {adapter.models.slice(0, 4).map((model) => (
                  <small className="adapter-model" key={model.modelId}>
                    {model.displayName} <code>{model.modelId}</code>
                    {model.isDefault ? (
                      <span className="adapter-model__default">{messages.device.defaultModel}</span>
                    ) : null}
                  </small>
                ))}
                {adapter.models.length > 4 ? (
                  <small>
                    {formatMessage(messages.device.moreModels, {
                      count: adapter.models.length - 4,
                    })}
                  </small>
                ) : null}
              </span>
            )}
          </span>
          <span
            className={`status-${
              adapter.readiness === "ready"
                ? "success"
                : adapter.readiness === "degraded"
                  ? "warning"
                  : "danger"
            }`}
            title={formatAdminDate(new Date(adapter.observedAtMs).toISOString(), locale)}
          >
            {localizeAdapterReadiness(adapter.readiness, messages)} ·{" "}
            {localizeAdapterCompatibility(adapter.compatibility, messages)}
          </span>
        </li>
      ))}
    </ul>
  );
}

type AgentProfileTarget = "worker" | "coordinator";

interface SelectableAgentBinding {
  readonly binding: AgentBindingView;
  readonly key: string;
  readonly label: string;
  /** Efforts this exact model advertises; empty when it exposes none. */
  readonly supportedEfforts: readonly string[];
}

/**
 * A question-mark control that explains one term. It opens on hover and on
 * keyboard focus, and stays open on click so a touch device can read it too.
 */
function HelpHint({ text }: { readonly text: string }): React.JSX.Element {
  const { messages } = useAdminI18n();
  const descriptionId = useId();
  const [pinned, setPinned] = useState(false);

  return (
    <span className="help-hint">
      <button
        aria-describedby={descriptionId}
        aria-expanded={pinned}
        aria-label={messages.device.helpHint}
        className="help-hint-trigger"
        onBlur={() => setPinned(false)}
        onClick={(event) => {
          // Inside a <label> a click would otherwise activate the labelled control.
          event.preventDefault();
          event.stopPropagation();
          setPinned((current) => !current);
        }}
        type="button"
      >
        <CircleHelp aria-hidden="true" />
      </button>
      <span
        className={pinned ? "help-hint-text help-hint-text--pinned" : "help-hint-text"}
        id={descriptionId}
        role="tooltip"
      >
        {text}
      </span>
    </span>
  );
}

function AgentExecutionProfilePanel({
  device,
  onConfigureAgentProfile,
}: {
  readonly device: DeviceOverviewViewModel;
  readonly onConfigureAgentProfile: DeviceSurfaceProps["onConfigureAgentProfile"];
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  const [selectedTarget, setTarget] = useState<AgentProfileTarget>("worker");
  const target = device.role === "main" ? selectedTarget : "worker";
  const profile =
    target === "coordinator"
      ? (device.coordinatorAgentExecutionProfile ?? device.agentExecutionProfile)
      : device.agentExecutionProfile;

  return (
    <div className="agent-profile-panel">
      {device.role === "main" ? (
        <div className="agent-profile-target-row">
          <div
            aria-label={messages.device.agentProfileTarget}
            className="agent-profile-target"
            role="group"
          >
            <button
              aria-pressed={target === "worker"}
              className={target === "worker" ? "agent-profile-target--active" : undefined}
              onClick={() => setTarget("worker")}
              type="button"
            >
              {messages.device.workerAgent}
            </button>
            <button
              aria-pressed={target === "coordinator"}
              className={target === "coordinator" ? "agent-profile-target--active" : undefined}
              onClick={() => setTarget("coordinator")}
              type="button"
            >
              {messages.device.coordinatorAgent}
            </button>
          </div>
          <HelpHint
            text={
              target === "coordinator"
                ? messages.device.coordinatorAgentHelp
                : messages.device.workerAgentHelp
            }
          />
        </div>
      ) : null}
      <AgentProfileEditor
        device={device}
        key={`${device.deviceId}:${target}`}
        onConfigureAgentProfile={onConfigureAgentProfile}
        profile={profile}
        target={target}
      />
    </div>
  );
}

function AgentProfileEditor({
  device,
  onConfigureAgentProfile,
  profile,
  target,
}: {
  readonly device: DeviceOverviewViewModel;
  readonly onConfigureAgentProfile: DeviceSurfaceProps["onConfigureAgentProfile"];
  readonly profile: AgentExecutionProfileView;
  readonly target: AgentProfileTarget;
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  const options = selectableAgentBindings(device);
  const currentPrimaryKey = profile.mode === "auto" ? undefined : bindingKey(profile.primary);
  const currentFallbackKey =
    profile.mode === "prefer" ? bindingKey(profile.fallbacks[0] ?? profile.primary) : undefined;
  const [mode, setMode] = useState<AgentExecutionProfileView["mode"]>(profile.mode);
  const [primaryKey, setPrimaryKey] = useState(
    options.some((option) => option.key === currentPrimaryKey)
      ? (currentPrimaryKey ?? "")
      : (options[0]?.key ?? ""),
  );
  const [fallbackKey, setFallbackKey] = useState(
    options.some((option) => option.key === currentFallbackKey && option.key !== primaryKey)
      ? (currentFallbackKey ?? "")
      : "",
  );
  // Effort belongs to the selected model, so changing the model clears it.
  const [primaryEffort, setPrimaryEffort] = useState(
    profile.mode === "auto" ? "" : (profile.primary.effort ?? ""),
  );
  const [fallbackEffort, setFallbackEffort] = useState(
    profile.mode === "prefer" ? (profile.fallbacks[0]?.effort ?? "") : "",
  );
  const primaryOption = options.find((option) => option.key === primaryKey);
  const fallbackOption =
    fallbackKey === "" || fallbackKey === primaryKey
      ? undefined
      : options.find((option) => option.key === fallbackKey);
  const primary = withEffort(primaryOption, primaryEffort);
  const fallback = withEffort(fallbackOption, fallbackEffort);
  const proposedProfile: AgentExecutionProfileView | undefined =
    mode === "auto"
      ? { schemaVersion: 1, mode: "auto" }
      : primary === undefined
        ? undefined
        : mode === "pinned"
          ? { schemaVersion: 1, mode: "pinned", primary }
          : {
              schemaVersion: 1,
              mode: "prefer",
              primary,
              fallbacks: fallback === undefined ? [] : [fallback],
            };
  const modeDescription =
    mode === "auto"
      ? messages.device.profileAutoDescription
      : mode === "prefer"
        ? messages.device.profilePreferDescription
        : messages.device.profilePinnedDescription;

  return (
    <>
      <div className="agent-profile-current">
        <span>{messages.device.currentBinding}</span>
        <strong>{profileModeLabel(profile.mode, messages.device)}</strong>
        <small>{formatProfileBinding(profile, messages.device.automaticSelection)}</small>
      </div>
      <p className="agent-profile-hint">{messages.device.agentProfileHint}</p>
      <div className="agent-profile-editor">
        <label>
          <span>{messages.device.profileMode}</span>
          <select
            onChange={(event) =>
              setMode(event.currentTarget.value as AgentExecutionProfileView["mode"])
            }
            value={mode}
          >
            <option value="auto">{messages.device.profileAuto}</option>
            <option value="prefer">{messages.device.profilePrefer}</option>
            <option value="pinned">{messages.device.profilePinned}</option>
          </select>
        </label>
        <p>{modeDescription}</p>
        {mode === "auto" ? null : options.length === 0 ? (
          <div className="agent-profile-empty" role="status">
            {messages.device.noVerifiedModels}
          </div>
        ) : (
          <div className="agent-profile-bindings">
            <label>
              <span>
                {messages.device.primaryBinding}
                <HelpHint text={messages.device.primaryBindingHelp} />
              </span>
              <select
                onChange={(event) => {
                  setPrimaryKey(event.currentTarget.value);
                  setPrimaryEffort("");
                }}
                value={primaryKey}
              >
                {options.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
              <EffortSelect
                efforts={primaryOption?.supportedEfforts ?? []}
                onChange={setPrimaryEffort}
                value={primaryEffort}
              />
            </label>
            {mode === "prefer" ? (
              <label>
                <span>
                  {messages.device.fallbackBinding}
                  <HelpHint text={messages.device.fallbackBindingHelp} />
                </span>
                <select
                  onChange={(event) => {
                    setFallbackKey(event.currentTarget.value);
                    setFallbackEffort("");
                  }}
                  value={fallbackKey}
                >
                  <option value="">{messages.device.noFallback}</option>
                  {options
                    .filter((option) => option.key !== primaryKey)
                    .map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                </select>
                <EffortSelect
                  efforts={fallbackOption?.supportedEfforts ?? []}
                  onChange={setFallbackEffort}
                  value={fallbackEffort}
                />
              </label>
            ) : null}
          </div>
        )}
        <button
          className="primary-button agent-profile-review"
          disabled={proposedProfile === undefined}
          onClick={(event) => {
            if (proposedProfile !== undefined) {
              onConfigureAgentProfile(
                buildAgentProfileConfigurationRequest(
                  device,
                  target,
                  proposedProfile,
                  messages.device,
                ),
                event.currentTarget,
              );
            }
          }}
          type="button"
        >
          <MessagesSquare aria-hidden="true" />
          {messages.device.configureAgentProfile}
        </button>
      </div>
    </>
  );
}

function selectableAgentBindings(
  device: DeviceOverviewViewModel,
): readonly SelectableAgentBinding[] {
  return device.agentAdapters
    .filter(
      (adapter) =>
        adapter.readiness === "ready" &&
        adapter.compatibility === "tested" &&
        adapter.models.length > 0,
    )
    .flatMap((adapter) =>
      [...adapter.models]
        .sort(
          (left, right) =>
            Number(right.isDefault) - Number(left.isDefault) ||
            left.displayName.localeCompare(right.displayName, "en"),
        )
        .map((model) => {
          const binding: AgentBindingView = {
            provider: adapter.provider === "generic-command" ? "generic" : adapter.provider,
            adapterId: adapter.adapterId,
            modelId: model.modelId,
          };
          return Object.freeze({
            binding,
            key: bindingKey(binding),
            label: `${adapter.provider} · ${model.displayName} (${model.modelId}) · ${adapter.adapterId}`,
            supportedEfforts: Object.freeze([...model.supportedEfforts]),
          });
        }),
    );
}

function bindingKey(binding: AgentBindingView): string {
  return JSON.stringify([binding.provider, binding.adapterId, binding.modelId ?? null]);
}

/**
 * Reasoning effort for one binding. Rendered only when the selected model
 * advertises an effort catalog, so a provider that exposes none shows nothing
 * rather than an empty control.
 */
function EffortSelect({
  efforts,
  onChange,
  value,
}: {
  readonly efforts: readonly string[];
  readonly onChange: (effort: string) => void;
  readonly value: string;
}): React.JSX.Element | null {
  const { messages } = useAdminI18n();
  if (efforts.length === 0) {
    return null;
  }
  return (
    <span className="agent-profile-effort">
      <span>
        {messages.device.reasoningEffort}
        <HelpHint text={messages.device.reasoningEffortHelp} />
      </span>
      <select
        aria-label={messages.device.reasoningEffort}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      >
        <option value="">{messages.device.providerDefaultEffort}</option>
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * Attaches provider tuning to a selected binding. An effort the model no longer
 * advertises is dropped rather than proposed, so the request always names a
 * value the target Device can actually honour.
 */
function withEffort(
  option: SelectableAgentBinding | undefined,
  effort: string,
): AgentBindingView | undefined {
  if (option === undefined) {
    return undefined;
  }
  if (effort === "" || !option.supportedEfforts.includes(effort)) {
    return option.binding;
  }
  return { ...option.binding, effort };
}

function formatProfileBinding(
  profile: AgentExecutionProfileView,
  automaticSelection: string,
): string {
  if (profile.mode === "auto") {
    return automaticSelection;
  }
  const primary = describeBinding(profile.primary);
  if (profile.mode === "pinned" || profile.fallbacks.length === 0) {
    return primary;
  }
  return `${primary} → ${profile.fallbacks.map(describeBinding).join(" → ")}`;
}

function describeBinding(binding: AgentBindingView): string {
  const model = `${binding.provider} · ${binding.modelId ?? binding.adapterId}`;
  return binding.effort === undefined ? model : `${model} · ${binding.effort}`;
}

function profileModeLabel(
  mode: AgentExecutionProfileView["mode"],
  messages: {
    readonly profileAuto: string;
    readonly profilePrefer: string;
    readonly profilePinned: string;
  },
): string {
  return mode === "auto"
    ? messages.profileAuto
    : mode === "prefer"
      ? messages.profilePrefer
      : messages.profilePinned;
}

function buildAgentProfileConfigurationRequest(
  device: DeviceOverviewViewModel,
  target: AgentProfileTarget,
  profile: AgentExecutionProfileView,
  messages: Messages["device"],
): string {
  const key = target === "coordinator" ? "agent.coordinator-profile" : "agent.worker-profile";
  const scope = target === "coordinator" ? "Main" : "Device";
  return formatMessage(messages.agentProfileConfigurationRequest, {
    deviceId: JSON.stringify(device.deviceId),
    key: JSON.stringify(key),
    profile: JSON.stringify(profile),
    scope,
  });
}

function ResourceLockList({
  locks,
}: {
  readonly locks: DeviceOverviewViewModel["resourceLocks"];
}): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  if (locks.length === 0) {
    return <EmptyDetail text={messages.device.noResourceLocks} />;
  }
  return (
    <ul className="lock-list">
      {locks.map((lock) => (
        <li key={lock.resourceName}>
          <div>
            <LockKeyhole aria-hidden="true" />
            <strong>{lock.resourceName}</strong>
            <span>
              {formatMessage(messages.device.lockAvailable, {
                available: Math.max(0, lock.capacity - lock.holders.length),
                capacity: lock.capacity,
              })}
            </span>
          </div>
          {lock.holders.length === 0 ? null : (
            <ul>
              {lock.holders.map((holder) => (
                <li key={`${holder.runId}:${holder.expiresAtMs}`}>
                  {formatMessage(messages.device.lockHolder, {
                    runId: holder.runId,
                    taskId: holder.taskId,
                    time: formatAdminDate(new Date(holder.expiresAtMs).toISOString(), locale),
                  })}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function EmptyDetail({ text }: { readonly text: string }): React.JSX.Element {
  return (
    <div className="empty-detail">
      <Inbox aria-hidden="true" />
      <span>{text}</span>
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
