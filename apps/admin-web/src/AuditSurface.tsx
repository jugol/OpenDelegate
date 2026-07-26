import { Activity, RefreshCw, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AdminApi, AuditEventSummary, Readiness } from "./admin-api";
import { formatAdminDate, useAdminI18n } from "./i18n";

export type AuditSurfaceApi = Pick<AdminApi, "listAuditEvents" | "readiness">;

export function AuditSurface({ api }: { readonly api: AuditSurfaceApi }): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const [events, setEvents] = useState<readonly AuditEventSummary[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [nextEvents, nextReadiness] = await Promise.all([
        api.listAuditEvents(),
        api.readiness(),
      ]);
      setEvents(sortEvents(nextEvents));
      setReadiness(nextReadiness);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void Promise.all([api.listAuditEvents(), api.readiness()])
      .then(([nextEvents, nextReadiness]) => {
        if (!active) {
          return;
        }
        setEvents(sortEvents(nextEvents));
        setReadiness(nextReadiness);
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
  }, [api]);

  const visibleEvents = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    if (normalized === "") {
      return events;
    }
    return events.filter((event) =>
      auditSearchValue(event).toLocaleLowerCase(locale).includes(normalized),
    );
  }, [events, locale, query]);

  return (
    <main className="operations-main audit-surface">
      <header className="operations-header">
        <div>
          <p className="surface-eyebrow">{messages.audit.eyebrow}</p>
          <h1>{messages.audit.title}</h1>
          <p>{messages.audit.intro}</p>
        </div>
        <button
          aria-label={messages.audit.refresh}
          className="icon-button"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </header>

      <p className="isolated-origin-notice audit-boundary-notice">
        <ShieldCheck aria-hidden="true" />
        <span>{messages.audit.operationalNotice}</span>
      </p>

      {loadFailed ? (
        <div className="surface-alert surface-alert--error" role="alert">
          <p>{messages.audit.loadFailed}</p>
          <button className="secondary-button" onClick={() => void load()} type="button">
            {messages.common.tryAgain}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="surface-loading" role="status">
          <span aria-hidden="true" className="startup-spinner" />
          <span>{messages.audit.loading}</span>
        </div>
      ) : (
        <div className="audit-layout">
          <section className="operations-card readiness-card">
            <header>
              <div>
                <p className="surface-eyebrow">{messages.audit.readiness}</p>
                <h2>
                  {readiness?.status === "ready" ? messages.audit.ready : messages.audit.notReady}
                </h2>
              </div>
              <span
                className={`readiness-icon ${
                  readiness?.status === "ready"
                    ? "readiness-icon--ready"
                    : "readiness-icon--warning"
                }`}
              >
                {readiness?.status === "ready" ? (
                  <Activity aria-hidden="true" />
                ) : (
                  <TriangleAlert aria-hidden="true" />
                )}
              </span>
            </header>
            <h3>{messages.audit.checks}</h3>
            <ul className="readiness-checks">
              {readiness?.checks.map((check) => (
                <li key={check.code}>
                  <span
                    aria-hidden="true"
                    className={`status-dot ${
                      check.status === "ready" ? "status-dot--ready" : "status-dot--warning"
                    }`}
                  />
                  <code>{check.code}</code>
                  <span>
                    {check.status === "ready" ? messages.audit.ready : messages.audit.notReady}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="operations-card audit-events-card">
            <div className="audit-events-heading">
              <div>
                <p className="surface-eyebrow">{messages.audit.events}</p>
                <h2>{new Intl.NumberFormat(locale).format(events.length)}</h2>
              </div>
              <label className="search-field">
                <span className="sr-only">{messages.audit.search}</span>
                <Search aria-hidden="true" />
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={messages.audit.searchPlaceholder}
                  type="search"
                  value={query}
                />
              </label>
            </div>
            {events.length === 0 ? (
              <div className="surface-empty surface-empty--compact">
                <p>{messages.audit.noEvents}</p>
              </div>
            ) : visibleEvents.length === 0 ? (
              <div className="surface-empty surface-empty--compact">
                <p>{messages.audit.noMatches}</p>
              </div>
            ) : (
              <ol className="audit-event-list">
                {visibleEvents.map((event) => (
                  <li key={event.auditId}>
                    <div className="audit-event-marker" aria-hidden="true" />
                    <article>
                      <header>
                        <div>
                          <strong>{event.type}</strong>
                          <span>{formatAdminDate(event.occurredAt, locale)}</span>
                        </div>
                        <span className={`state-pill state-pill--${event.outcome}`}>
                          {outcomeLabel(event.outcome, messages.audit)}
                        </span>
                      </header>
                      <dl className="audit-event-facts">
                        <div>
                          <dt>{messages.audit.source}</dt>
                          <dd>{event.source}</dd>
                        </div>
                        {event.reasonCode === undefined ? null : (
                          <div>
                            <dt>{messages.audit.reason}</dt>
                            <dd className="code-value">{event.reasonCode}</dd>
                          </div>
                        )}
                        {boundedIdentifiers(event).map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd className="code-value">{value}</dd>
                          </div>
                        ))}
                      </dl>
                      {event.routeIncident === undefined ? null : (
                        <section
                          aria-label={messages.audit.routeIncidentTitle}
                          className="route-incident-diagnosis"
                        >
                          <div className="route-incident-diagnosis__heading">
                            <div>
                              <p className="surface-eyebrow">{messages.audit.routeIncidentTitle}</p>
                              <h3>{messages.audit.routeRecommendation}</h3>
                            </div>
                            <span className="state-pill state-pill--recorded">
                              {event.routeIncident.source === "agent"
                                ? messages.audit.routeSourceAgent
                                : messages.audit.routeSourceFallback}
                            </span>
                          </div>
                          <p>{event.routeIncident.recommendation}</p>
                          <div className="route-incident-question">
                            <strong>{messages.audit.routeOwnerQuestion}</strong>
                            <p>{event.routeIncident.ownerQuestion}</p>
                          </div>
                          <dl className="route-incident-identifiers">
                            <div>
                              <dt>{messages.audit.routeIncidentId}</dt>
                              <dd className="code-value">{event.routeIncident.incidentId}</dd>
                            </div>
                            <div>
                              <dt>{messages.audit.routeDiagnosticSource}</dt>
                              <dd className="code-value">{event.routeIncident.reasonCode}</dd>
                            </div>
                          </dl>
                        </section>
                      )}
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function sortEvents(events: readonly AuditEventSummary[]): readonly AuditEventSummary[] {
  return [...events].sort(
    (left, right) =>
      Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
      left.auditId.localeCompare(right.auditId),
  );
}

function auditSearchValue(event: AuditEventSummary): string {
  return [
    event.type,
    event.source,
    event.outcome,
    event.auditId,
    event.actorId,
    event.subjectId,
    event.correlationId,
    event.taskId,
    event.runId,
    event.deviceId,
    event.artifactId,
    event.reasonCode,
    event.routeIncident?.incidentId,
    event.routeIncident?.fingerprint,
    event.routeIncident?.profileRevision,
    event.routeIncident?.recommendation,
    event.routeIncident?.ownerQuestion,
    event.routeIncident?.source,
    event.routeIncident?.reasonCode,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function boundedIdentifiers(event: AuditEventSummary): readonly [string, string][] {
  return [
    ["correlation", event.correlationId],
    ["task", event.taskId],
    ["run", event.runId],
    ["device", event.deviceId],
    ["artifact", event.artifactId],
    ["actor", event.actorId],
    ["subject", event.subjectId],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
}

function outcomeLabel(
  outcome: AuditEventSummary["outcome"],
  messages: {
    readonly outcomeSucceeded: string;
    readonly outcomeDenied: string;
    readonly outcomeFailed: string;
    readonly outcomeRecorded: string;
  },
): string {
  return {
    succeeded: messages.outcomeSucceeded,
    denied: messages.outcomeDenied,
    failed: messages.outcomeFailed,
    recorded: messages.outcomeRecorded,
  }[outcome];
}
