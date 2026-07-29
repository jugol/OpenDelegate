import {
  ArrowRight,
  Check,
  CircleAlert,
  FileDiff,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  X,
} from "lucide-react";
import { useMemo, useState, useEffect } from "react";

import type {
  AdminApi,
  ApprovalDecisionInput,
  ApprovalDetail,
  ApprovalExecutionStatus,
  ApprovalGrantScope,
  ApprovalRisk,
  ApprovalState,
  ApprovalValuePreview,
} from "./admin-api";
import {
  formatAdminDate,
  formatMessage,
  localizeApprovalActionCategory,
  useAdminI18n,
  type Messages,
} from "./i18n";

export type ApprovalSurfaceApi = Pick<AdminApi, "listApprovals" | "getApproval" | "decideApproval">;

type ApprovalFilter = "pending" | "all";

export function ApprovalSurface({
  api,
  initialApprovalId,
}: {
  readonly api: ApprovalSurfaceApi;
  readonly initialApprovalId?: string;
}): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const [approvals, setApprovals] = useState<readonly ApprovalDetail[]>([]);
  const [selected, setSelected] = useState<ApprovalDetail | null>(null);
  const [filter, setFilter] = useState<ApprovalFilter>("pending");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [decisionFailed, setDecisionFailed] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    setLoadFailed(false);
    try {
      const next = sortApprovals(await api.listApprovals());
      setApprovals(next);
      setSelected(firstVisible(next, filter));
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void api
      .listApprovals()
      .then((nextApprovals) => {
        if (!active) {
          return;
        }
        const next = sortApprovals(nextApprovals);
        setApprovals(next);
        setSelected(
          next.find((approval) => approval.approvalId === initialApprovalId) ??
            firstVisible(next, "pending"),
        );
      })
      .catch(() => {
        if (active) {
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, initialApprovalId]);

  const visibleApprovals = useMemo(
    () =>
      filter === "pending"
        ? approvals.filter((approval) => approval.state === "pending")
        : approvals,
    [approvals, filter],
  );

  async function selectApproval(approvalId: string): Promise<void> {
    setDetailLoading(true);
    setLoadFailed(false);
    try {
      const detail = await api.getApproval(approvalId);
      setSelected(detail);
      setApprovals((current) =>
        current.map((approval) => (approval.approvalId === detail.approvalId ? detail : approval)),
      );
    } catch {
      setLoadFailed(true);
    } finally {
      setDetailLoading(false);
    }
  }

  function changeFilter(nextFilter: ApprovalFilter): void {
    setFilter(nextFilter);
    const nextVisible = firstVisible(approvals, nextFilter);
    if (nextVisible !== null) {
      setSelected(nextVisible);
    } else if (selected?.state === "pending" || selected === null) {
      setSelected(null);
    }
  }

  async function decide(input: ApprovalDecisionInput): Promise<void> {
    if (selected === null || selected.state !== "pending") {
      return;
    }
    setDetailLoading(true);
    setDecisionFailed(false);
    try {
      const detail = await api.decideApproval(selected.approvalId, input);
      setSelected(detail);
      setApprovals((current) =>
        current.map((approval) => (approval.approvalId === detail.approvalId ? detail : approval)),
      );
    } catch {
      setDecisionFailed(true);
      try {
        const durable = await api.getApproval(selected.approvalId);
        setSelected(durable);
        setApprovals((current) =>
          current.map((approval) =>
            approval.approvalId === durable.approvalId ? durable : approval,
          ),
        );
        if (durable.state !== "pending") {
          setDecisionFailed(false);
        }
      } catch {
        // Keep the bounded decision error visible until the owner refreshes.
      }
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <main className={`approval-main ${selected === null ? "" : "approval-main--inspector"}`}>
      <section className="approval-workspace">
        <header className="approval-header">
          <div>
            <p className="approval-eyebrow">
              <ShieldCheck aria-hidden="true" />
              {messages.approval.ownerReview}
            </p>
            <h1>{messages.approval.title}</h1>
            <p>{messages.approval.intro}</p>
          </div>
          <div className="approval-toolbar">
            <label className="task-filter">
              <span className="sr-only">{messages.approval.filter}</span>
              <select
                aria-label={messages.approval.filter}
                onChange={(event) => changeFilter(event.currentTarget.value as ApprovalFilter)}
                value={filter}
              >
                <option value="pending">{messages.approval.pendingOnly}</option>
                <option value="all">{messages.approval.allRequests}</option>
              </select>
            </label>
            <button
              aria-label={messages.approval.refresh}
              className="icon-button"
              disabled={loading}
              onClick={() => void load()}
              type="button"
            >
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
        </header>

        <div aria-live="polite" className="task-error">
          {loadFailed ? (
            <>
              <span>{messages.approval.loadFailed}</span>
              <button className="text-button" onClick={() => void load()} type="button">
                {messages.common.tryAgain}
              </button>
            </>
          ) : null}
        </div>

        {loading ? (
          <div aria-label={messages.approval.loading} className="task-loading" role="status">
            {messages.approval.loadingProgress}
          </div>
        ) : visibleApprovals.length === 0 ? (
          <div className="task-empty">
            <ShieldCheck aria-hidden="true" />
            <h2>
              {filter === "pending" ? messages.approval.noPending : messages.approval.noApprovals}
            </h2>
            <p>
              {filter === "pending"
                ? messages.approval.noPendingDetail
                : messages.approval.noApprovalsDetail}
            </p>
          </div>
        ) : (
          <ol className="approval-list">
            {visibleApprovals.map((approval) => (
              <li key={approval.approvalId}>
                <button
                  aria-current={selected?.approvalId === approval.approvalId ? "true" : undefined}
                  className={`approval-card ${
                    selected?.approvalId === approval.approvalId ? "approval-card--selected" : ""
                  }`}
                  onClick={() => void selectApproval(approval.approvalId)}
                  type="button"
                >
                  <span className="approval-card__topline">
                    <ApprovalStateBadge state={approval.state} />
                    <RiskBadge risk={approval.risk} />
                  </span>
                  <strong>{approval.action.type}</strong>
                  <span>{localizeApprovalActionCategory(approval.action.category, messages)}</span>
                  <time dateTime={approval.requestedAt}>
                    {formatAdminDate(approval.requestedAt, locale)}
                  </time>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {selected !== null ? (
        <ApprovalInspector
          approval={selected}
          busy={detailLoading}
          decisionFailed={decisionFailed}
          onClose={() => setSelected(null)}
          onDecide={(decision) => void decide(decision)}
        />
      ) : null}
    </main>
  );
}

function ApprovalInspector({
  approval,
  busy,
  decisionFailed,
  onClose,
  onDecide,
}: {
  readonly approval: ApprovalDetail;
  readonly busy: boolean;
  readonly decisionFailed: boolean;
  readonly onClose: () => void;
  readonly onDecide: (decision: ApprovalDecisionInput) => void;
}): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const [scope, setScope] = useState<ApprovalGrantScope>("once");
  const [denialReason, setDenialReason] = useState("");

  useEffect(() => {
    setScope("once");
    setDenialReason("");
  }, [approval.approvalId]);

  const scopes = availableScopes(approval);

  return (
    <aside
      aria-busy={busy}
      aria-label={formatMessage(messages.approval.details, {
        action: approval.action.type,
      })}
      className="approval-inspector"
    >
      <header className="approval-inspector__header">
        <div>
          <div className="approval-inspector__badges">
            <ApprovalStateBadge state={approval.state} />
            <RiskBadge risk={approval.risk} />
          </div>
          <h2>{approval.action.type}</h2>
          <p>{localizeApprovalActionCategory(approval.action.category, messages)}</p>
        </div>
        <button
          aria-label={messages.approval.closeDetails}
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="approval-inspector__scroll" tabIndex={0}>
        <ApprovalFact title={messages.approval.reason}>
          <p>{approval.reason}</p>
        </ApprovalFact>

        <dl className="approval-facts">
          <div>
            <dt>{messages.approval.target}</dt>
            <dd>{approval.target}</dd>
          </div>
          <div>
            <dt>{messages.approval.requestedAt}</dt>
            <dd>
              <time dateTime={approval.requestedAt}>
                {formatAdminDate(approval.requestedAt, locale)}
              </time>
            </dd>
          </div>
          <div>
            <dt>{messages.approval.expiresAt}</dt>
            <dd>
              <time dateTime={approval.expiresAt}>
                {formatAdminDate(approval.expiresAt, locale)}
              </time>
            </dd>
          </div>
          <div>
            <dt>{messages.approval.execution}</dt>
            <dd>
              <ExecutionBadge status={approval.executionStatus} />
            </dd>
          </div>
        </dl>

        <ApprovalFact title={messages.approval.evidence}>
          {approval.evidence.length === 0 ? (
            <p>{messages.approval.noEvidence}</p>
          ) : (
            <ul className="approval-evidence">
              {approval.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </ApprovalFact>

        {approval.configuration === undefined ? null : (
          <ApprovalFact icon={FileDiff} title={messages.approval.configurationChanges}>
            <dl className="approval-proposal-facts">
              <div>
                <dt>{messages.approval.proposal}</dt>
                <dd>{approval.configuration.proposalId}</dd>
              </div>
              <div>
                <dt>{messages.approval.baseRevision}</dt>
                <dd>{approval.configuration.baseRevision}</dd>
              </div>
            </dl>
            <ol className="approval-diff">
              {approval.configuration.changes.map((change) => (
                <li key={`${change.scope.kind}:${change.scope.id}:${change.key}`}>
                  <header>
                    <strong>{change.key}</strong>
                    <span>
                      {change.scope.kind}:{change.scope.id}
                    </span>
                  </header>
                  <div className="approval-diff__values">
                    <div>
                      <span>{messages.approval.before}</span>
                      <ValuePreview value={change.before} />
                    </div>
                    <ArrowRight aria-hidden="true" />
                    <div>
                      <span>{messages.approval.after}</span>
                      <ValuePreview value={change.after} />
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </ApprovalFact>
        )}

        <ApprovalFact title={messages.approval.exactAction}>
          <dl className="approval-technical">
            <div>
              <dt>{messages.approval.resource}</dt>
              <dd>{approval.action.resource}</dd>
            </div>
            <div>
              <dt>{messages.approval.fingerprint}</dt>
              <dd>
                <code>{approval.action.fingerprint}</code>
              </dd>
            </div>
          </dl>
          <p className="approval-boundary-note">
            <ShieldCheck aria-hidden="true" />
            {messages.approval.fingerprintBoundary}
          </p>
        </ApprovalFact>

        {approval.executionErrorCode === undefined ? null : (
          <p className="approval-decision-error" role="status">
            <CircleAlert aria-hidden="true" />
            {formatMessage(messages.approval.executionError, {
              code: approval.executionErrorCode,
            })}
          </p>
        )}

        {approval.decision === undefined ? null : <ApprovalDecisionReceipt approval={approval} />}

        {decisionFailed ? (
          <p className="approval-decision-error" role="alert">
            <CircleAlert aria-hidden="true" />
            {messages.approval.decisionFailed}
          </p>
        ) : null}
      </div>

      {approval.state === "pending" ? (
        <div className="approval-actions">
          <div className="approval-approve">
            <label>
              <span>{messages.approval.scope}</span>
              <select
                aria-label={messages.approval.scope}
                disabled={busy}
                onChange={(event) => setScope(event.currentTarget.value as ApprovalGrantScope)}
                value={scope}
              >
                {scopes.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {scopeLabel(candidate, messages)}
                  </option>
                ))}
              </select>
            </label>
            <p>{messages.approval.scopeBoundary}</p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => onDecide({ decision: "approve", scope })}
              type="button"
            >
              <Check aria-hidden="true" />
              {approveLabel(scope, messages)}
            </button>
          </div>
          <div className="approval-deny">
            <label htmlFor={`approval-denial-${approval.approvalId}`}>
              {messages.approval.denialReason}
            </label>
            <textarea
              disabled={busy}
              id={`approval-denial-${approval.approvalId}`}
              maxLength={2_000}
              onChange={(event) => setDenialReason(event.currentTarget.value)}
              placeholder={messages.approval.denialPlaceholder}
              rows={3}
              value={denialReason}
            />
            <button
              className="danger-button"
              disabled={busy || denialReason.trim() === ""}
              onClick={() =>
                onDecide({
                  decision: "deny",
                  reason: denialReason.trim(),
                })
              }
              type="button"
            >
              <ShieldX aria-hidden="true" />
              {messages.approval.deny}
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function ApprovalDecisionReceipt({
  approval,
}: {
  readonly approval: ApprovalDetail;
}): React.JSX.Element | null {
  const { locale, messages } = useAdminI18n();
  const decision = approval.decision;
  if (decision === undefined) {
    return null;
  }
  return (
    <section className="approval-receipt">
      <h3>{messages.approval.ownerDecision}</h3>
      <p>
        {decision.decision === "approve"
          ? formatMessage(messages.approval.approvedWithScope, {
              scope: scopeLabel(decision.scope, messages),
            })
          : messages.approval.denied}
      </p>
      {decision.decision === "deny" ? <blockquote>{decision.reason}</blockquote> : null}
      <dl>
        <div>
          <dt>{messages.approval.decidedBy}</dt>
          <dd>{decision.decidedBy}</dd>
        </div>
        <div>
          <dt>{messages.approval.decidedAt}</dt>
          <dd>
            <time dateTime={decision.decidedAt}>{formatAdminDate(decision.decidedAt, locale)}</time>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ApprovalFact({
  children,
  icon: Icon,
  title,
}: {
  readonly children: React.ReactNode;
  readonly icon?: typeof FileDiff;
  readonly title: string;
}): React.JSX.Element {
  return (
    <section className="approval-fact">
      <h3>
        {Icon === undefined ? null : <Icon aria-hidden="true" />}
        {title}
      </h3>
      {children}
    </section>
  );
}

function ValuePreview({ value }: { readonly value: ApprovalValuePreview }): React.JSX.Element {
  const { messages } = useAdminI18n();
  if (!value.present || value.valueJson === undefined) {
    return <em>{messages.approval.notSet}</em>;
  }
  return <pre>{prettyJson(value.valueJson)}</pre>;
}

function ApprovalStateBadge({ state }: { readonly state: ApprovalState }): React.JSX.Element {
  const { messages } = useAdminI18n();
  return (
    <span className={`approval-badge approval-badge--state-${state}`}>
      {stateLabel(state, messages)}
    </span>
  );
}

function RiskBadge({ risk }: { readonly risk: ApprovalRisk }): React.JSX.Element {
  const { messages } = useAdminI18n();
  return (
    <span className={`approval-badge approval-badge--risk-${risk}`}>
      {riskLabel(risk, messages)}
    </span>
  );
}

function ExecutionBadge({
  status,
}: {
  readonly status: ApprovalExecutionStatus;
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  return (
    <span className={`approval-execution approval-execution--${status}`}>
      {executionLabel(status, messages)}
    </span>
  );
}

function availableScopes(approval: ApprovalDetail): readonly ApprovalGrantScope[] {
  return [
    "once",
    ...(approval.action.taskId === undefined ? [] : (["task"] as const)),
    ...(approval.action.targetDeviceId === undefined ? [] : (["device"] as const)),
    "policy",
  ];
}

function firstVisible(
  approvals: readonly ApprovalDetail[],
  filter: ApprovalFilter,
): ApprovalDetail | null {
  return approvals.find((approval) => filter === "all" || approval.state === "pending") ?? null;
}

function sortApprovals(approvals: readonly ApprovalDetail[]): readonly ApprovalDetail[] {
  return [...approvals].sort((left, right) => {
    if (left.state === "pending" && right.state !== "pending") {
      return -1;
    }
    if (left.state !== "pending" && right.state === "pending") {
      return 1;
    }
    return Date.parse(right.requestedAt) - Date.parse(left.requestedAt);
  });
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

function stateLabel(state: ApprovalState, messages: Messages): string {
  return {
    approved: messages.approval.stateApproved,
    denied: messages.approval.stateDenied,
    expired: messages.approval.stateExpired,
    pending: messages.approval.statePending,
  }[state];
}

function executionLabel(status: ApprovalExecutionStatus, messages: Messages): string {
  return {
    failed: messages.approval.executionFailed,
    running: messages.approval.executionRunning,
    skipped: messages.approval.executionSkipped,
    succeeded: messages.approval.executionSucceeded,
    waiting: messages.approval.executionWaiting,
  }[status];
}

function riskLabel(risk: ApprovalRisk, messages: Messages): string {
  return {
    critical: messages.approval.riskCritical,
    high: messages.approval.riskHigh,
    low: messages.approval.riskLow,
    medium: messages.approval.riskMedium,
  }[risk];
}

function scopeLabel(scope: ApprovalGrantScope, messages: Messages): string {
  return {
    device: messages.approval.scopeDevice,
    once: messages.approval.scopeOnce,
    policy: messages.approval.scopePolicy,
    task: messages.approval.scopeTask,
  }[scope];
}

function approveLabel(scope: ApprovalGrantScope, messages: Messages): string {
  return {
    device: messages.approval.approveDevice,
    once: messages.approval.approveOnce,
    policy: messages.approval.approvePolicy,
    task: messages.approval.approveTask,
  }[scope];
}
