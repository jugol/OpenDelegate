import { CircleAlert, Gauge, History, Plus, RotateCcw, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  AdminApiError,
  type AdminApi,
  type TaskBudgetLimits,
  type TaskBudgetMetric,
  type TaskBudgetSnapshot,
} from "./admin-api";
import { formatAdminDate, formatMessage, type Messages, useAdminI18n } from "./i18n";

const budgetMetrics = [
  "wallTimeMs",
  "idleTimeMs",
  "retries",
  "childWorkOrders",
  "concurrentRuns",
  "nativeTurns",
  "tokens",
  "costUsdMicros",
] as const satisfies readonly TaskBudgetMetric[];

const metricMessageKeys = {
  wallTimeMs: "metricWallTime",
  idleTimeMs: "metricIdleTime",
  retries: "metricRetries",
  childWorkOrders: "metricChildWorkOrders",
  concurrentRuns: "metricConcurrentRuns",
  nativeTurns: "metricNativeTurns",
  tokens: "metricTokens",
  costUsdMicros: "metricCost",
} as const satisfies Readonly<Record<TaskBudgetMetric, keyof Messages["budget"]>>;

type BudgetState = "within" | "soft" | "hard";
type BudgetMessageKey = keyof Messages["budget"];

interface TaskBudgetPanelProps {
  readonly api: AdminApi;
  readonly taskId: string;
}

export function TaskBudgetPanel({ api, taskId }: TaskBudgetPanelProps): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const [snapshot, setSnapshot] = useState<TaskBudgetSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<BudgetMessageKey | null>(null);
  const [extending, setExtending] = useState(false);
  const refreshToken = useRef(0);

  async function load(): Promise<void> {
    const token = ++refreshToken.current;
    setLoading(true);
    setErrorKey(null);
    try {
      const next = await api.getTaskBudget(taskId);
      if (token === refreshToken.current) {
        setSnapshot(next);
      }
    } catch (cause) {
      if (token === refreshToken.current) {
        setSnapshot(null);
        setErrorKey(budgetErrorKey(cause, "loadFailed"));
      }
    } finally {
      if (token === refreshToken.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void load();
    return () => {
      refreshToken.current += 1;
    };
  }, [api, taskId]);

  const overallState = useMemo(
    () => (snapshot === null ? "within" : overallBudgetState(snapshot)),
    [snapshot],
  );

  return (
    <section className="task-detail-block task-budget-panel">
      <header className="task-budget-panel__header">
        <div>
          <span className="task-budget-panel__eyebrow">
            <Gauge aria-hidden="true" />
            {messages.budget.eyebrow}
          </span>
          <h3>{messages.budget.title}</h3>
        </div>
        <button
          aria-label={messages.budget.refresh}
          className="icon-button"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          <RotateCcw aria-hidden="true" />
        </button>
      </header>

      {loading ? (
        <p aria-live="polite" className="task-budget-panel__loading" role="status">
          {messages.budget.loading}
        </p>
      ) : errorKey !== null || snapshot === null ? (
        <div className="task-budget-panel__error" role="alert">
          <CircleAlert aria-hidden="true" />
          <div>
            <strong>{messages.budget.unavailableTitle}</strong>
            <p>{messages.budget[errorKey ?? "loadFailed"]}</p>
          </div>
          <button className="text-button" onClick={() => void load()} type="button">
            {messages.common.tryAgain}
          </button>
        </div>
      ) : (
        <>
          <BudgetAlert snapshot={snapshot} state={overallState} />

          <dl className="task-budget-summary">
            <div>
              <dt>{messages.budget.revision}</dt>
              <dd>{snapshot.revision}</dd>
            </div>
            <div>
              <dt>{messages.budget.taskClass}</dt>
              <dd>
                {snapshot.kind === "requested"
                  ? messages.budget.requestedTask
                  : messages.budget.autonomousTask}
              </dd>
            </div>
            <div>
              <dt>{messages.budget.activeRuns}</dt>
              <dd>{formatInteger(snapshot.activeRunIds.length, locale)}</dd>
            </div>
            <div>
              <dt>{messages.budget.workOrders}</dt>
              <dd>{formatInteger(snapshot.workOrders.length, locale)}</dd>
            </div>
          </dl>

          <div
            aria-label={messages.budget.tableCaption}
            className="task-budget-table-wrap"
            role="region"
            tabIndex={0}
          >
            <table className="task-budget-table">
              <caption className="sr-only">{messages.budget.tableCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{messages.budget.metric}</th>
                  <th scope="col">{messages.budget.usage}</th>
                  <th scope="col">{messages.budget.softLimit}</th>
                  <th scope="col">{messages.budget.hardLimit}</th>
                </tr>
              </thead>
              <tbody>
                {budgetMetrics.map((metric) => {
                  const limit = snapshot.limits[metric];
                  const usage = snapshot.usage[metric] ?? 0;
                  const state = metricState(usage, limit.soft, limit.hard);
                  return (
                    <tr className={`task-budget-row--${state}`} key={metric}>
                      <th scope="row">{messages.budget[metricMessageKeys[metric]]}</th>
                      <td>
                        <strong>{formatBudgetValue(metric, usage, locale)}</strong>
                        <progress
                          aria-label={formatMessage(messages.budget.progressLabel, {
                            metric: messages.budget[metricMessageKeys[metric]],
                          })}
                          max={100}
                          value={budgetPercent(usage, limit.hard)}
                        />
                      </td>
                      <td>
                        {limit.soft === undefined
                          ? messages.budget.notSet
                          : formatBudgetValue(metric, limit.soft, locale)}
                      </td>
                      <td>{formatBudgetValue(metric, limit.hard, locale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="task-budget-panel__activity">
            {formatMessage(messages.budget.lastActivity, {
              time: formatAdminDate(snapshot.lastActivityAt, locale),
            })}
          </p>

          <button
            className="secondary-button task-budget-panel__extend"
            onClick={() => setExtending(true)}
            type="button"
          >
            <Plus aria-hidden="true" />
            {messages.budget.extend}
          </button>

          <BudgetHistory snapshot={snapshot} />
        </>
      )}

      {extending && snapshot !== null ? (
        <BudgetExtensionDialog
          api={api}
          onClose={() => setExtending(false)}
          onExtended={(next) => {
            setSnapshot(next);
            setExtending(false);
          }}
          snapshot={snapshot}
        />
      ) : null}
    </section>
  );
}

function BudgetAlert({
  snapshot,
  state,
}: {
  readonly snapshot: TaskBudgetSnapshot;
  readonly state: BudgetState;
}): React.JSX.Element | null {
  const { messages } = useAdminI18n();
  if (state === "within") {
    return null;
  }
  const reachedMetrics = budgetMetrics.filter((metric) => {
    const limit = snapshot.limits[metric];
    const usage = snapshot.usage[metric] ?? 0;
    return metricState(usage, limit.soft, limit.hard) === state;
  });
  const metrics = reachedMetrics
    .map((metric) => messages.budget[metricMessageKeys[metric]])
    .join(", ");
  const hard = state === "hard";
  const idleOnly = hard && reachedMetrics.every((metric) => metric === "idleTimeMs");
  return (
    <div
      className={`task-budget-alert task-budget-alert--${state}`}
      role={hard ? "alert" : "status"}
    >
      <ShieldAlert aria-hidden="true" />
      <div>
        <strong>{hard ? messages.budget.hardTitle : messages.budget.softTitle}</strong>
        <p>
          {formatMessage(
            hard
              ? idleOnly
                ? messages.budget.hardIdleDetail
                : messages.budget.hardDetail
              : messages.budget.softDetail,
            { metrics },
          )}
        </p>
      </div>
    </div>
  );
}

function BudgetHistory({ snapshot }: { readonly snapshot: TaskBudgetSnapshot }): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const omittedTotal =
    snapshot.omitted.workOrders +
    snapshot.omitted.activeRunIds +
    snapshot.omitted.limitEvents +
    snapshot.omitted.extensions;
  return (
    <div className="task-budget-history">
      <section>
        <h4>
          <ShieldAlert aria-hidden="true" />
          {messages.budget.limitEvents}
        </h4>
        {snapshot.limitEvents.length === 0 ? (
          <p>{messages.budget.noLimitEvents}</p>
        ) : (
          <ol>
            {[...snapshot.limitEvents].reverse().map((event) => (
              <li key={event.eventId}>
                <div>
                  <strong>
                    {event.state === "hard-limit"
                      ? messages.budget.hardEvent
                      : messages.budget.softEvent}
                    {" · "}
                    {messages.budget[metricMessageKeys[event.metric]]}
                  </strong>
                  <time dateTime={event.occurredAt}>
                    {formatAdminDate(event.occurredAt, locale)}
                  </time>
                </div>
                <p>
                  {formatMessage(messages.budget.eventValues, {
                    current: formatBudgetValue(event.metric, event.current, locale),
                    attempted: formatBudgetValue(event.metric, event.attempted, locale),
                    hard: formatBudgetValue(event.metric, event.hard, locale),
                  })}
                </p>
                {event.workOrderId === undefined ? null : (
                  <code>
                    {formatMessage(messages.budget.workOrderReference, {
                      workOrderId: event.workOrderId,
                    })}
                  </code>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h4>
          <History aria-hidden="true" />
          {messages.budget.extensions}
        </h4>
        {snapshot.extensions.length === 0 ? (
          <p>{messages.budget.noExtensions}</p>
        ) : (
          <ol>
            {[...snapshot.extensions].reverse().map((extension) => (
              <li key={extension.eventId}>
                <div>
                  <strong>
                    {formatMessage(messages.budget.extensionRevision, {
                      revision: extension.revision,
                    })}
                  </strong>
                  <time dateTime={extension.occurredAt}>
                    {formatAdminDate(extension.occurredAt, locale)}
                  </time>
                </div>
                <p>
                  {formatMessage(messages.budget.extensionActor, {
                    actorId: extension.actorId,
                    baseRevision: extension.baseRevision,
                  })}
                </p>
                <details>
                  <summary>{messages.budget.extensionLimits}</summary>
                  <ul>
                    {budgetMetrics.map((metric) => (
                      <li key={metric}>
                        <span>{messages.budget[metricMessageKeys[metric]]}</span>
                        <strong>
                          {formatBudgetValue(metric, extension.limits[metric].hard, locale)}
                        </strong>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>

      {omittedTotal > 0 ? (
        <p className="task-budget-history__omitted">
          {formatMessage(messages.budget.omittedRecords, {
            count: formatInteger(omittedTotal, locale),
          })}
        </p>
      ) : null}
    </div>
  );
}

type BudgetDraft = Record<TaskBudgetMetric, { soft: string; hard: string }>;

function BudgetExtensionDialog({
  api,
  onClose,
  onExtended,
  snapshot,
}: {
  readonly api: AdminApi;
  readonly onClose: () => void;
  readonly onExtended: (snapshot: TaskBudgetSnapshot) => void;
  readonly snapshot: TaskBudgetSnapshot;
}): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [draft, setDraft] = useState<BudgetDraft>(() => budgetDraft(snapshot.limits));
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<BudgetMessageKey | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const limits = parseBudgetDraft(draft, snapshot.limits);
    if (limits === null) {
      setErrorKey("invalidLimits");
      return;
    }
    if (!budgetChanged(snapshot.limits, limits)) {
      setErrorKey("noChange");
      return;
    }
    if (!confirmed) {
      setErrorKey("confirmationRequired");
      return;
    }
    setPending(true);
    setErrorKey(null);
    try {
      onExtended(await api.extendTaskBudget(snapshot.taskId, snapshot.revision, limits));
    } catch (cause) {
      setErrorKey(budgetErrorKey(cause, "extendFailed"));
      setPending(false);
    }
  }

  return (
    <dialog
      aria-labelledby="budget-extension-heading"
      className="task-dialog budget-extension-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) {
          onClose();
        }
      }}
      ref={dialogRef}
    >
      <header>
        <div>
          <p>{messages.budget.ownerAction}</p>
          <h2 id="budget-extension-heading">{messages.budget.extensionTitle}</h2>
        </div>
        <button
          aria-label={messages.budget.closeExtension}
          className="icon-button"
          disabled={pending}
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <p className="budget-extension-dialog__intro">{messages.budget.extensionIntro}</p>
        <div className="budget-extension-dialog__boundary">
          <ShieldAlert aria-hidden="true" />
          <p>{messages.budget.extensionBoundary}</p>
        </div>
        <p className="budget-extension-dialog__revision">
          {formatMessage(messages.budget.extensionBaseRevision, {
            revision: snapshot.revision,
          })}
        </p>

        <div className="budget-extension-grid">
          <div aria-hidden="true" />
          <strong>{messages.budget.softLimit}</strong>
          <strong>{messages.budget.hardLimit}</strong>
          {budgetMetrics.map((metric) => (
            <div className="budget-extension-grid__row" key={metric}>
              <label>{messages.budget[metricMessageKeys[metric]]}</label>
              <input
                aria-label={formatMessage(messages.budget.softInput, {
                  metric: messages.budget[metricMessageKeys[metric]],
                })}
                inputMode="numeric"
                min={0}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setDraft((current) => ({
                    ...current,
                    [metric]: { ...current[metric], soft: value },
                  }));
                }}
                placeholder={messages.budget.notSet}
                step={1}
                type="number"
                value={draft[metric].soft}
              />
              <input
                aria-label={formatMessage(messages.budget.hardInput, {
                  metric: messages.budget[metricMessageKeys[metric]],
                })}
                inputMode="numeric"
                min={snapshot.limits[metric].hard}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setDraft((current) => ({
                    ...current,
                    [metric]: { ...current[metric], hard: value },
                  }));
                }}
                required
                step={1}
                type="number"
                value={draft[metric].hard}
              />
              <small>
                {formatMessage(messages.budget.currentHard, {
                  value: formatBudgetValue(metric, snapshot.limits[metric].hard, locale),
                })}
              </small>
            </div>
          ))}
        </div>

        <label className="budget-extension-dialog__confirm">
          <input
            checked={confirmed}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{messages.budget.confirmExtension}</span>
        </label>

        <p aria-live="polite" className="form-error" role={errorKey === null ? undefined : "alert"}>
          {errorKey === null ? "" : messages.budget[errorKey]}
        </p>
        <div className="task-dialog-actions">
          <button className="secondary-button" disabled={pending} onClick={onClose} type="button">
            {messages.common.cancel}
          </button>
          <button className="primary-button" disabled={pending || !confirmed} type="submit">
            {pending ? messages.budget.extending : messages.budget.submitExtension}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function budgetDraft(limits: TaskBudgetLimits): BudgetDraft {
  return Object.fromEntries(
    budgetMetrics.map((metric) => [
      metric,
      {
        soft: limits[metric].soft === undefined ? "" : String(limits[metric].soft),
        hard: String(limits[metric].hard),
      },
    ]),
  ) as BudgetDraft;
}

function parseBudgetDraft(draft: BudgetDraft, current: TaskBudgetLimits): TaskBudgetLimits | null {
  const limits: Partial<Record<TaskBudgetMetric, { soft?: number; hard: number }>> = {};
  for (const metric of budgetMetrics) {
    const hard = nonNegativeSafeInteger(draft[metric].hard);
    const soft =
      draft[metric].soft.trim() === "" ? undefined : nonNegativeSafeInteger(draft[metric].soft);
    if (
      hard === null ||
      hard < current[metric].hard ||
      soft === null ||
      (soft !== undefined && soft > hard)
    ) {
      return null;
    }
    limits[metric] = soft === undefined ? { hard } : { soft, hard };
  }
  return limits as TaskBudgetLimits;
}

function nonNegativeSafeInteger(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/u.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function budgetChanged(current: TaskBudgetLimits, next: TaskBudgetLimits): boolean {
  return budgetMetrics.some(
    (metric) =>
      current[metric].hard !== next[metric].hard || current[metric].soft !== next[metric].soft,
  );
}

function overallBudgetState(snapshot: TaskBudgetSnapshot): BudgetState {
  let result: BudgetState = "within";
  for (const metric of budgetMetrics) {
    const limit = snapshot.limits[metric];
    const state = metricState(snapshot.usage[metric] ?? 0, limit.soft, limit.hard);
    if (state === "hard") {
      return "hard";
    }
    if (state === "soft") {
      result = "soft";
    }
  }
  return result;
}

function metricState(usage: number, soft: number | undefined, hard: number): BudgetState {
  if (usage >= hard) {
    return "hard";
  }
  if (soft !== undefined && usage >= soft) {
    return "soft";
  }
  return "within";
}

function budgetPercent(usage: number, hard: number): number {
  if (hard === 0) {
    return 100;
  }
  return Math.min(100, (usage / hard) * 100);
}

function formatBudgetValue(metric: TaskBudgetMetric, value: number, locale: string): string {
  if (metric === "costUsdMicros") {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: value % 1_000_000 === 0 ? 0 : 2,
    }).format(value / 1_000_000);
  }
  if (metric === "wallTimeMs" || metric === "idleTimeMs") {
    return formatDuration(value, locale);
  }
  return formatInteger(value, locale);
}

function formatDuration(milliseconds: number, locale: string): string {
  if (milliseconds < 1_000) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "millisecond",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(milliseconds);
  }
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(seconds);
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "minute",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(minutes);
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "hour",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(milliseconds / 3_600_000);
}

function formatInteger(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

function budgetErrorKey(cause: unknown, fallback: BudgetMessageKey): BudgetMessageKey {
  if (!(cause instanceof AdminApiError)) {
    return fallback;
  }
  const codes: Readonly<Record<string, BudgetMessageKey>> = {
    AUTHENTICATION_REQUIRED: "sessionExpired",
    TASK_BUDGET_IDEMPOTENCY_CONFLICT: "idempotencyConflict",
    TASK_BUDGET_INVALID: "invalidLimits",
    TASK_BUDGET_LIMIT_INVALID: "invalidLimits",
    TASK_BUDGET_NOT_FOUND: "notFound",
    TASK_BUDGET_PARENT_LIMIT_EXCEEDED: "instanceCeiling",
    TASK_BUDGET_REVISION_CONFLICT: "revisionConflict",
    TASK_BUDGET_UNAVAILABLE: "loadFailed",
  };
  return codes[cause.code] ?? (cause.status === 401 ? "sessionExpired" : fallback);
}
